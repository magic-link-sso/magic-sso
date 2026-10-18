// SPDX-License-Identifier: MIT
import { createBrowserSsoBootstrapClient } from './browser-sso-bootstrap-client.js';
import { parseBrowserSsoCookies, type BrowserSsoCookieValue } from './browser-sso-client.js';
import { createBrowserSsoRandomValue } from './browser-sso-transaction.js';
import { getBrowserSsoPageHeaders, renderBrowserSsoStatusPage } from './browser-sso-page.js';
import { escapeHtml } from './html.js';
import { normaliseReturnUrl } from './return-url.js';
import { verifyAuthToken, toSecretKey } from './token.js';
import type { BrowserSsoHttpOptions } from './browser-sso-http.js';

interface Cookie extends BrowserSsoCookieValue {
    path: string;
    secure: boolean;
    maxAge?: number;
}
type Respond = (
    body: string | null,
    status: number,
    cookies?: Cookie[],
    location?: string,
) => Response;
function field(name: string, value: string): string {
    return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}
function read(value: unknown, key: string): string | undefined {
    const result: unknown =
        typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
    return typeof result === 'string' ? result : undefined;
}
function page(title: string, copy: string, form: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | Magic Link SSO</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:#eef4ff;color:#172554;font:1rem/1.6 Arial,sans-serif}main{width:min(100%,36rem);padding:2rem;border-radius:1rem;background:white}h1{font-size:2rem;line-height:1.2}p{color:#334155}label{display:block;font-weight:bold;margin-top:1rem}input{width:100%;padding:.75rem;border:2px solid #64748b;border-radius:.5rem;font:inherit}input[type=hidden]{display:none}button,a{display:inline-block;padding:.75rem 1rem;margin-top:1rem;border:2px solid #1d4ed8;border-radius:.5rem;background:#1d4ed8;color:white;font:inherit;font-weight:bold}button{cursor:pointer}:focus-visible{outline:3px solid #172554;outline-offset:4px}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(copy)}</p>${form}</main></body></html>`;
}
/** Reference forms served by the application backend. No browser-to-issuer fetch or script is used. */
export function createBrowserSsoLocalHttpHandler(
    options: BrowserSsoHttpOptions,
    respond: Respond,
): (request: Request) => Promise<Response | null> {
    const bootstrap = createBrowserSsoBootstrapClient(options);
    const paths = options.paths ?? {
        start: '/sso/start',
        callback: '/sso/callback',
        signedOut: '/sso/signed-out',
    };
    const secure = options.audience.startsWith('https:');
    const csrfPrefix = `${secure ? '__Host-' : ''}magic-sso-confirm-`;
    function formPage(title: string, copy: string, form: string, cookies: Cookie[] = []): Response {
        const response = respond(page(title, copy, form), 200, cookies);
        // A successful local verification POST navigates through the issuer to its callback.
        response.headers.set(
            'content-security-policy',
            getBrowserSsoPageHeaders()['content-security-policy'].replace(
                "form-action 'none'",
                `form-action 'self' ${options.issuer}`,
            ),
        );
        return response;
    }
    function failure(): Response {
        return respond(
            renderBrowserSsoStatusPage({
                title: 'Sign-in could not be completed',
                message:
                    'This sign-in expired or could not be verified. Start a fresh sign-in from the application.',
                nextHref: new URL(paths.start, options.audience).href,
                nextText: 'Start sign-in again',
                isError: true,
            }),
            400,
        );
    }
    function localOnly(destination: string, cookies: Cookie[] = []): Response {
        return respond(
            renderBrowserSsoStatusPage({
                title: 'Shared sign-in was not completed',
                message:
                    'Your application session is kept if it is valid. You can continue here or start a fresh sign-in to enable browser SSO.',
                nextHref: destination,
                nextText: 'Continue to application',
                restartHref: new URL(
                    paths.start +
                        '?' +
                        new URLSearchParams({ loginUi: 'hosted', returnUrl: destination }),
                    options.audience,
                ).href,
            }),
            200,
            cookies,
        );
    }
    async function issuer(path: string, body?: unknown, preview?: string): Promise<unknown> {
        const response = await (options.fetcher ?? fetch)(new URL(path, options.issuer), {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                accept: 'application/json',
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(preview ? { 'x-magic-sso-preview-secret': preview } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
        const text = await response.text();
        if (!response.ok || response.redirected || text.length > 16_384) {
            throw new Error('Local verification failed');
        }
        const result: unknown = JSON.parse(text);
        return result;
    }
    async function finishCallback(url: URL, cookies: BrowserSsoCookieValue[]): Promise<Response> {
        const tokens = cookies.filter((cookie) => cookie.name === options.cookieName);
        const result = await bootstrap.finish({
            query: url.searchParams,
            cookies,
            accessToken: tokens.length === 1 ? tokens[0]?.value : undefined,
        });
        if (!result) {
            return failure();
        }
        return result.kind === 'redirect'
            ? respond(null, 303, result.cookies, result.location)
            : localOnly(result.location, result.cookies);
    }
    async function preparedForm(url: URL, cookies: BrowserSsoCookieValue[]): Promise<Response> {
        const prepared = await bootstrap.prepare({ query: url.searchParams, cookies });
        if (!prepared) {
            return failure();
        }
        return formPage(
            'Sign in',
            'Enter your email address to sign in to this application and enable browser SSO.',
            `<form method="post" action="${escapeHtml(paths.start)}">${field('action', 'send')}${field('state', prepared.state)}${field('scope', prepared.scope)}${field('returnUrl', prepared.returnUrl)}<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"><button type="submit">Send magic link</button></form>`,
            prepared.cookies,
        );
    }
    async function confirmationForm(url: URL): Promise<Response> {
        const token = url.searchParams.get('token') ?? '',
            state = url.searchParams.get('state') ?? '';
        if (
            url.searchParams.getAll('state').length !== 1 ||
            url.searchParams.getAll('token').length !== 1 ||
            url.searchParams.getAll('action').length !== 1 ||
            !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
            token.length > 8192 ||
            !options.previewSecret
        ) {
            return failure();
        }
        const preview = await issuer(
            '/verify-email?' + new URLSearchParams({ token }),
            undefined,
            options.previewSecret,
        );
        const email = read(preview, 'email');
        if (!email) {
            return failure();
        }
        const csrf = createBrowserSsoRandomValue();
        return formPage(
            'Confirm sign-in',
            `Continue as ${email}. This confirmation signs you in to this application.`,
            `<form method="post" action="${escapeHtml(paths.start)}">${field('action', 'verify')}${field('state', state)}${field('token', token)}${field('csrfToken', csrf)}${field('returnUrl', normaliseReturnUrl({ appOrigin: options.audience, returnUrl: url.searchParams.get('returnUrl') ?? '/' }))}<button type="submit">Continue</button></form>`,
            [{ name: csrfPrefix + state, value: csrf, path: '/', secure, maxAge: 600 }],
        );
    }
    type Context = Awaited<ReturnType<typeof bootstrap.context>>;
    async function sendForm(
        form: URLSearchParams,
        state: string,
        context: Context,
        destination: string,
    ): Promise<Response> {
        if (!context) {
            return failure();
        }
        const verifyUrl = new URL(paths.start, options.audience);
        verifyUrl.search = new URLSearchParams({
            action: 'verify',
            state,
            returnUrl: destination,
        }).toString();
        const payload = await issuer('/signin', {
            email: form.get('email'),
            returnUrl: destination,
            verifyUrl: verifyUrl.href,
            scope: form.get('scope') ?? '',
            browserSso: context,
        });
        const challengeId = read(payload, 'otpChallengeId');
        const otp = challengeId
            ? `<form method="post" action="${escapeHtml(paths.start)}">${field('action', 'otp')}${field('state', state)}${field('challengeId', challengeId)}${field('returnUrl', destination)}<label for="code">Email code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]+" required maxlength="12"><button type="submit">Verify code</button></form>`
            : '';
        return formPage(
            'Check your email',
            challengeId
                ? 'Open the magic link in your email, or enter its code below. Keep this tab open.'
                : 'Open the magic link in your email. Keep this tab open.',
            otp,
        );
    }
    async function verifyForm(
        form: URLSearchParams,
        input: {
            state: string;
            context: Context;
            destination: string;
            cookies: BrowserSsoCookieValue[];
        },
    ): Promise<Response> {
        const { state, context, destination, cookies } = input;
        const action = form.get('action');
        if (action !== 'verify' && action !== 'otp') {
            return failure();
        }
        if (!validVerificationForm(form, state, cookies, context)) {
            return failure();
        }
        const payload = await issuer(action === 'verify' ? '/verify-email' : '/verify-email/otp', {
            ...(action === 'verify'
                ? { token: form.get('token') }
                : { challengeId: form.get('challengeId'), code: form.get('code') }),
            ...(context ? { browserSso: context } : {}),
        });
        const accessToken = read(payload, 'accessToken');
        const auth = accessToken
            ? await verifyAuthToken(accessToken, toSecretKey(options.secret), {
                  expectedAudience: options.audience,
                  expectedIssuer: options.issuer,
              })
            : null;
        if (!auth || !accessToken) {
            return failure();
        }
        const remaining = Math.floor(auth.exp - Date.now() / 1000);
        if (remaining < 1) {
            return failure();
        }
        const authCookie: Cookie = {
            name: options.cookieName,
            value: accessToken,
            path: options.cookiePath ?? '/',
            secure,
            maxAge: Math.min(options.cookieMaxAge ?? remaining, remaining),
        };
        return completeSession(
            { state, cookies, destination, action },
            payload,
            accessToken,
            authCookie,
        );
    }
    function validVerificationForm(
        form: URLSearchParams,
        state: string,
        cookies: BrowserSsoCookieValue[],
        context: Context,
    ): boolean {
        if (form.get('action') !== 'verify') {
            return context !== null;
        }
        const confirmations = cookies.filter((cookie) => cookie.name === csrfPrefix + state);
        return (
            /^[A-Za-z0-9_-]{43}$/u.test(state) &&
            confirmations.length === 1 &&
            confirmations[0]?.value === form.get('csrfToken')
        );
    }
    async function completeSession(
        input: {
            state: string;
            cookies: BrowserSsoCookieValue[];
            destination: string;
            action: string;
        },
        payload: unknown,
        accessToken: string,
        authCookie: Cookie,
    ): Promise<Response> {
        const { state, cookies, destination, action } = input;
        const clears: Cookie[] =
            action === 'verify'
                ? [{ name: csrfPrefix + state, value: '', path: '/', secure, maxAge: 0 }]
                : [];
        // Set the valid local JWT even if continuation encryption or the shared setup fails.
        try {
            const result = await bootstrap.complete({
                state,
                cookies,
                accessToken,
                response: payload,
            });
            const changed = [authCookie, ...clears, ...(result?.cookies ?? [])];
            return result?.kind === 'redirect'
                ? respond(null, 303, changed, result.location)
                : localOnly(result?.location ?? destination, changed);
        } catch {
            return localOnly(destination, [authCookie, ...clears]);
        }
    }
    async function readForm(request: Request): Promise<URLSearchParams | null> {
        if (
            // no-referrer document forms can legitimately serialize Origin as null.
            // Every accepted action still requires its unpredictable cookie-bound state or confirmation CSRF token.
            (request.headers.get('origin') !== options.audience &&
                request.headers.get('origin') !== 'null') ||
            !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')
        ) {
            return null;
        }
        const raw = await request.text();
        if (raw.length > 16_384) {
            return null;
        }
        const form = new URLSearchParams(raw);
        if ([...form.keys()].some((key) => form.getAll(key).length !== 1)) {
            return null;
        }
        return form;
    }
    return async (request): Promise<Response | null> => {
        if (options.mode === 'off' || options.loginUi !== 'app-owned') {
            return null;
        }
        const url = new URL(request.url),
            cookies = parseBrowserSsoCookies(request.headers.get('cookie'));
        if (url.pathname === paths.callback && url.searchParams.has('browserSso')) {
            return finishCallback(url, cookies);
        }
        if (url.pathname !== paths.start) {
            return null;
        }
        if (request.method === 'GET' && url.searchParams.has('ssoPrepared')) {
            return preparedForm(url, cookies);
        }
        if (request.method === 'GET' && url.searchParams.get('action') === 'verify') {
            return confirmationForm(url);
        }
        if (request.method !== 'POST') {
            return null;
        }
        const form = await readForm(request);
        if (!form) {
            return failure();
        }
        const state = form.get('state') ?? '',
            action = form.get('action'),
            context = await bootstrap.context(state, cookies);
        const destination = normaliseReturnUrl({
            appOrigin: options.audience,
            returnUrl: form.get('returnUrl') ?? '/',
        });
        if (action === 'send') {
            return sendForm(form, state, context, destination);
        }
        return verifyForm(form, { state, context, destination, cookies });
    };
}
