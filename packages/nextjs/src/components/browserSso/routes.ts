// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import { NextResponse } from 'next/server';
import {
    buildLoginTarget,
    createBrowserSsoClient,
    createBrowserSsoHttpHandler,
    getBrowserSsoErrorMessage,
    getBrowserSsoPageHeaders,
    parseBooleanFlag,
    parseBrowserSsoCookies,
    renderBrowserSsoStatusPage,
    isBrowserSsoDocumentNavigation,
    type BrowserSsoClient,
    type BrowserSsoClientError,
    type BrowserSsoCookie,
} from '@magic-link-sso/core';
import {
    buildAuthCookieOptions,
    getExpectedMutationOrigin,
    getPublicOrigin,
    getServerIssuer,
    isTrustProxyEnabled,
    normaliseReturnUrl,
} from '../../lib/auth';
import {
    browserSsoPaths,
    getBrowserSsoMode,
    getBrowserSsoLoginUi,
} from '../../lib/browserSsoConfig';

function client(request: Request): { sso: BrowserSsoClient; origin: string } {
    const mode = getBrowserSsoMode();
    if (mode !== 'off' && getPublicOrigin() === null && !isTrustProxyEnabled()) {
        throw new Error('Browser SSO needs an explicit or trusted public origin');
    }
    const origin = getExpectedMutationOrigin(request);
    return {
        origin,
        sso: createBrowserSsoClient({
            mode,
            loginUi: getBrowserSsoLoginUi(),
            audience: origin,
            issuer: getServerIssuer() ?? '',
            redirectUri: new URL(browserSsoPaths.callback, origin).href,
            secret: process.env.MAGICSSO_JWT_SECRET ?? '',
            allowInsecureLocalhost: parseBooleanFlag(
                process.env.MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST,
            ),
            timeoutMs:
                process.env.MAGICSSO_BROWSER_SSO_TIMEOUT_MS === undefined
                    ? 5000
                    : Number(process.env.MAGICSSO_BROWSER_SSO_TIMEOUT_MS),
        }),
    };
}
function apply(response: NextResponse, cookies: readonly BrowserSsoCookie[]): void {
    for (const cookie of cookies) {
        response.cookies.set(cookie);
    }
    response.headers.set('cache-control', 'no-store');
    response.headers.set('referrer-policy', 'no-referrer');
}
function errorPage(
    request: Request,
    error: BrowserSsoClientError,
    cookies: readonly BrowserSsoCookie[] = [],
    returnUrl?: string,
): NextResponse {
    const origin = getExpectedMutationOrigin(request);
    const response = new NextResponse(
        renderBrowserSsoStatusPage({
            title: 'Sign-in could not be completed',
            message: getBrowserSsoErrorMessage(error),
            nextHref: normaliseReturnUrl(returnUrl, origin),
            nextText: 'Return to application',
            isError: true,
        }),
        {
            status:
                error === 'access_denied'
                    ? 403
                    : error === 'transaction_limit'
                      ? 429
                      : error === 'temporarily_unavailable' ||
                          error === 'sso_required' ||
                          error === 'exchange_failed' ||
                          error === 'invalid_token'
                        ? 503
                        : error === 'sso_disabled'
                          ? 409
                          : 400,
            headers: getBrowserSsoPageHeaders(),
        },
    );
    apply(response, cookies);
    return response;
}
function methodError(): NextResponse {
    return new NextResponse('Method Not Allowed', {
        status: 405,
        headers: { allow: 'GET', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
}

export async function BrowserSsoStartRoute(request: Request): Promise<NextResponse> {
    const local = await appOwnedRoute(request);
    if (local) {
        return local;
    }
    if (request.method !== 'GET') {
        return methodError();
    }
    const navigation = documentNavigation(request);
    if (navigation) {
        return navigation;
    }
    try {
        const { sso, origin } = client(request);
        const query = new URL(request.url).searchParams;
        const returnUrl = normaliseReturnUrl(query.get('returnUrl') ?? undefined, origin);
        const scope = query.get('scope');
        const result = await sso.start({
            returnUrl,
            cookies: parseBrowserSsoCookies(request.headers.get('cookie')),
            ...(scope === null ? {} : { scope }),
            ...(query.get('prompt') === 'login' ? { prompt: 'login' } : {}),
        });
        if (result.kind === 'legacy') {
            const target = buildLoginTarget({
                appOrigin: origin,
                returnUrl,
                directUse: parseBooleanFlag(process.env.MAGICSSO_DIRECT_USE),
                ...(scope === null ? {} : { scope }),
                ...(getServerIssuer() === null
                    ? {}
                    : { serverUrl: getServerIssuer() ?? undefined }),
            });
            const response = NextResponse.redirect(new URL(target, origin), 302);
            apply(response, []);
            return response;
        }
        if (result.kind === 'error') {
            return errorPage(request, result.error, result.cookies, returnUrl);
        }
        const response = NextResponse.redirect(result.location, 302);
        apply(response, result.cookies);
        return response;
    } catch {
        return errorPage(request, 'temporarily_unavailable');
    }
}

export async function BrowserSsoCallbackRoute(request: Request): Promise<NextResponse> {
    const local = await appOwnedRoute(request);
    if (local) {
        return local;
    }
    if (request.method !== 'GET') {
        return methodError();
    }
    const navigation = documentNavigation(request);
    if (navigation) {
        return navigation;
    }
    let terminalCookies: readonly BrowserSsoCookie[] = [];
    let returnUrl: string | undefined;
    try {
        const { sso } = client(request);
        const result = await sso.callback({
            query: new URL(request.url).searchParams,
            cookies: parseBrowserSsoCookies(request.headers.get('cookie')),
        });
        terminalCookies = result.cookies;
        returnUrl = result.returnUrl;
        if (result.kind === 'error') {
            return errorPage(request, result.error, result.cookies, result.returnUrl);
        }
        const remaining = Math.floor(result.auth.exp - Date.now() / 1000);
        if (remaining < 1) {
            return errorPage(request, 'transaction_expired', result.cookies, result.returnUrl);
        }
        const response = NextResponse.redirect(result.returnUrl, 302);
        apply(response, result.cookies);
        const cookie = buildAuthCookieOptions(result.accessToken);
        cookie.secure = new URL(result.returnUrl).protocol === 'https:';
        if (cookie.maxAge !== undefined) {
            cookie.maxAge = Math.min(cookie.maxAge, remaining);
        }
        response.cookies.set(cookie);
        return response;
    } catch {
        return errorPage(request, 'temporarily_unavailable', terminalCookies, returnUrl);
    }
}

function documentNavigation(request: Request): NextResponse | null {
    if (isBrowserSsoDocumentNavigation(request.headers)) {
        return null;
    }
    const url = new URL(request.url);
    url.searchParams.delete('_rsc');
    const target = new URL(url.pathname + url.search, getExpectedMutationOrigin(request));
    // Next's router treats a non-RSC HTML reply as document navigation.
    // Prefetching this reply creates no cookies or issuer request.
    return new NextResponse(
        renderBrowserSsoStatusPage({
            title: 'Continue sign-in',
            message: 'Continue in this tab to complete sign-in.',
            nextHref: target.href,
            nextText: 'Continue sign-in',
        }),
        { headers: getBrowserSsoPageHeaders() },
    );
}

export async function BrowserSsoSignedOutRoute(request: Request): Promise<NextResponse> {
    if (request.method !== 'GET') {
        return methodError();
    }
    const origin = getExpectedMutationOrigin(request);
    const issuer = getServerIssuer();
    const central = issuer === null ? null : new URL('/sso/signout', issuer);
    central?.searchParams.set('returnUri', new URL(browserSsoPaths.signedOut, origin).href);
    return new NextResponse(
        renderBrowserSsoStatusPage({
            title: 'Signed out of this application',
            message:
                'Other application sessions keep their normal expiry. You can also end the browser SSO session to prevent new sign-ins without email verification.',
            nextHref: new URL(browserSsoPaths.start, origin).href,
            nextText: 'Sign in',
            ...(getBrowserSsoMode() !== 'off' && central !== null
                ? { centralSignOutHref: central.href }
                : {}),
        }),
        { headers: getBrowserSsoPageHeaders() },
    );
}

async function appOwnedRoute(request: Request): Promise<NextResponse | null> {
    if (getBrowserSsoMode() === 'off' || getBrowserSsoLoginUi() !== 'app-owned') {
        return null;
    }
    try {
        const { origin } = client(request);
        const cookie = buildAuthCookieOptions('');
        const handler = createBrowserSsoHttpHandler({
            mode: getBrowserSsoMode(),
            loginUi: 'app-owned',
            audience: origin,
            issuer: getServerIssuer() ?? '',
            redirectUri: new URL(browserSsoPaths.callback, origin).href,
            secret: process.env.MAGICSSO_JWT_SECRET ?? '',
            cookieName: cookie.name,
            cookiePath: cookie.path,
            cookieMaxAge: cookie.maxAge,
            previewSecret: process.env.MAGICSSO_PREVIEW_SECRET,
            allowInsecureLocalhost: parseBooleanFlag(
                process.env.MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST,
            ),
            timeoutMs: Number(process.env.MAGICSSO_BROWSER_SSO_TIMEOUT_MS ?? 5000),
            legacyDirectUse: parseBooleanFlag(process.env.MAGICSSO_DIRECT_USE),
        });
        const response = await handler(request);
        return new NextResponse(response.body, {
            status: response.status,
            headers: response.headers,
        });
    } catch {
        return errorPage(request, 'temporarily_unavailable');
    }
}
