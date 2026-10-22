// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import {
    createBrowserSsoClient,
    isBrowserSsoDocumentNavigation,
    parseBrowserSsoCookies,
    type BrowserSsoClientOptions,
    type BrowserSsoCookieValue,
    type BrowserSsoCallbackResult,
} from './browser-sso-client.js';
import { createBrowserSsoLocalHttpHandler } from './browser-sso-local-http.js';
import { buildAuthCookieOptions } from './cookie.js';
import {
    getBrowserSsoErrorMessage,
    getBrowserSsoPageHeaders,
    renderBrowserSsoStatusPage,
} from './browser-sso-page.js';
import { buildLoginTarget, normaliseReturnUrl } from './return-url.js';

export const browserSsoPaths = Object.freeze({
    start: '/sso/start',
    callback: '/sso/callback',
    signedOut: '/sso/signed-out',
});

export interface BrowserSsoHttpOptions extends BrowserSsoClientOptions {
    cookieName: string;
    /** Backend-only secret used to preview an email identity before confirmation. */
    previewSecret?: string;
    cookiePath?: string;
    cookieMaxAge?: number;
    legacyLoginPath?: string;
    legacyDirectUse?: boolean;
    paths?: { start: string; callback: string; signedOut: string };
}

interface ResponseCookie extends BrowserSsoCookieValue {
    path: string;
    secure: boolean;
    maxAge?: number;
}

function serializeCookie(cookie: ResponseCookie): string {
    // Validate the complete header, including configurable app cookie attributes.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(cookie.name) || /[;\r\n]/u.test(cookie.path)) {
        throw new Error('Invalid browser SSO cookie configuration');
    }
    return `${cookie.name}=${encodeURIComponent(cookie.value)}; Path=${cookie.path}; HttpOnly; SameSite=Lax${cookie.secure ? '; Secure' : ''}${cookie.maxAge === undefined ? '' : `; Max-Age=${cookie.maxAge}`}`;
}

/** Fetch-compatible server routes. The audience must come from trusted app configuration. */
export function createBrowserSsoHttpHandler(
    configuration: BrowserSsoHttpOptions,
): (request: Request) => Promise<Response> {
    const options = { ...configuration };
    const paths = options.paths ?? browserSsoPaths;
    const client = createBrowserSsoClient(options);
    const secure = options.audience.startsWith('https:');
    const appCookie = buildAuthCookieOptions({
        name: options.cookieName,
        path: options.cookiePath,
        value: '',
        secure,
        maxAge: options.cookieMaxAge,
    });
    if (/^(?:__Host-)?magic-sso-(?:tx-|continuation-|confirm-|browser)/u.test(appCookie.name)) {
        throw new Error('The app cookie name is reserved for browser SSO');
    }
    serializeCookie(appCookie);
    if (
        options.loginUi === 'app-owned' &&
        options.mode !== 'off' &&
        !(
            new URL(options.redirectUri).pathname === appCookie.path ||
            new URL(options.redirectUri).pathname.startsWith(
                appCookie.path.endsWith('/') ? appCookie.path : appCookie.path + '/',
            )
        )
    ) {
        throw new Error('The app cookie path must cover the SSO callback.');
    }

    function response(
        body: string | null,
        status: number,
        cookies: ResponseCookie[] = [],
        location?: string,
    ): Response {
        const headers = new Headers(getBrowserSsoPageHeaders());
        if (location !== undefined) {
            headers.set('location', location);
        }
        for (const cookie of cookies) {
            headers.append('set-cookie', serializeCookie(cookie));
        }
        return new Response(body, { status, headers });
    }
    function startUrl(returnUrl: string): string {
        const url = new URL(paths.start, options.audience);
        url.searchParams.set('returnUrl', returnUrl);
        return url.href;
    }
    function statusPage(
        message: string,
        status: number,
        cookies: ResponseCookie[] = [],
        returnUrl = '/',
    ): Response {
        return response(
            renderBrowserSsoStatusPage({
                title: 'Sign-in could not be completed',
                message,
                nextHref: startUrl(returnUrl),
                nextText: 'Start sign-in again',
                isError: true,
            }),
            status,
            cookies,
        );
    }
    const localHandler = createBrowserSsoLocalHttpHandler(options, response);
    async function start(url: URL, cookies: BrowserSsoCookieValue[]): Promise<Response> {
        const returnUrl = normaliseReturnUrl({
            appOrigin: options.audience,
            returnUrl: url.searchParams.get('returnUrl') ?? undefined,
        });
        const result = await client.start({
            returnUrl,
            cookies,
            ...(url.searchParams.has('scope')
                ? { scope: url.searchParams.get('scope') ?? '' }
                : {}),
            ...(url.searchParams.get('prompt') === 'login' ? { prompt: 'login' } : {}),
            ...(url.searchParams.get('loginUi') === 'hosted' ? { loginUi: 'hosted' } : {}),
        });
        if (result.kind === 'legacy') {
            return response(
                null,
                303,
                [],
                buildLoginTarget({
                    appOrigin: options.audience,
                    returnUrl,
                    serverUrl: options.issuer,
                    loginPath: options.legacyLoginPath,
                    directUse: options.legacyDirectUse,
                    ...(url.searchParams.has('scope')
                        ? { scope: url.searchParams.get('scope') ?? '' }
                        : {}),
                }),
            );
        }
        if (result.kind === 'redirect') {
            return response(null, 303, result.cookies, result.location);
        }
        return statusPage(getBrowserSsoErrorMessage(result.error), 503, result.cookies, returnUrl);
    }
    function callbackResponse(result: BrowserSsoCallbackResult): Response {
        const terminalCookies = result.cookies;
        if (result.kind === 'error') {
            return statusPage(
                getBrowserSsoErrorMessage(result.error),
                400,
                result.cookies,
                result.returnUrl,
            );
        }
        const remaining = Math.floor((result.auth.exp ?? 0) - Date.now() / 1000);
        if (remaining <= 0) {
            return statusPage(getBrowserSsoErrorMessage('invalid_token'), 400, terminalCookies);
        }
        return response(
            null,
            303,
            [
                ...terminalCookies,
                {
                    ...appCookie,
                    value: result.accessToken,
                    maxAge: Math.min(options.cookieMaxAge ?? remaining, remaining),
                },
            ],
            result.returnUrl,
        );
    }
    return async (request): Promise<Response> => {
        const url = new URL(request.url);
        if (!Object.values(paths).some((path) => path === url.pathname)) {
            return response('Not found', 404);
        }
        if (
            request.method !== 'GET' &&
            !(
                request.method === 'POST' &&
                url.pathname === paths.start &&
                options.mode !== 'off' &&
                options.loginUi === 'app-owned'
            )
        ) {
            const result = response('Method not allowed', 405);
            result.headers.set('allow', 'GET');
            return result;
        }
        if (!isBrowserSsoDocumentNavigation(request.headers)) {
            return response(
                renderBrowserSsoStatusPage({
                    title: 'Continue sign-in',
                    message: 'Continue in this browser tab.',
                    nextHref: `${options.audience}${url.pathname}${url.search}`,
                    nextText: 'Continue',
                }),
                200,
            );
        }
        if (url.pathname === paths.signedOut) {
            const signOut = new URL('/sso/signout', options.issuer);
            signOut.searchParams.set('returnUri', new URL(paths.signedOut, options.audience).href);
            return response(
                renderBrowserSsoStatusPage({
                    title: 'Signed out of this application',
                    message:
                        'Other application sessions remain active. You can sign in here again or end the browser SSO session.',
                    nextHref: startUrl('/'),
                    nextText: 'Sign in',
                    ...(options.mode === 'off' ? {} : { centralSignOutHref: signOut.href }),
                }),
                200,
            );
        }
        let terminalCookies: ResponseCookie[] = [];
        try {
            const localResponse = await localHandler(request);
            if (localResponse) {
                return localResponse;
            }
            const cookies = parseBrowserSsoCookies(request.headers.get('cookie'));
            if (url.pathname === paths.start) {
                return await start(url, cookies);
            }
            const result = await client.callback({ query: url.searchParams, cookies });
            terminalCookies = result.cookies;
            return callbackResponse(result);
        } catch {
            return statusPage(
                getBrowserSsoErrorMessage('temporarily_unavailable'),
                503,
                terminalCookies,
            );
        }
    };
}
