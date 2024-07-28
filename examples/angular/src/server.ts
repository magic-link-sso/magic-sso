// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import 'dotenv/config';
import express, {
    type NextFunction as ExpressNextFunction,
    type Request as ExpressRequest,
    type RequestHandler as ExpressRequestHandler,
    type Response as ExpressResponse,
} from 'express';
import {
    AngularNodeAppEngine,
    createNodeRequestHandler,
    isMainModule,
    writeResponseToNodeResponse,
} from '@angular/ssr/node';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildAuthCookieOptions,
    getJwtSecret,
    normaliseReturnUrl,
    verifyAuthToken,
    verifyRequestAuth,
} from '@magic-link-sso/angular';
import { buildFailureResult, readMessage, readServerUrlConfigError } from './signin-utils';
export { AngularAppEngine } from '@angular/ssr';

interface SignInRequestBody {
    email?: string;
    returnUrl?: string;
    scope?: string;
    verifyUrl?: string;
}

interface SignInResult {
    message: string;
    success: boolean;
}

interface VerifyEmailResponse {
    accessToken: string;
}

interface VerifyEmailPreviewResponse {
    email: string;
}

type AsyncExpressHandler = (
    request: ExpressRequest,
    response: ExpressResponse,
    next: ExpressNextFunction,
) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');
const angularNodeAppEngine = new AngularNodeAppEngine({
    allowedHosts: ['127.0.0.1', 'localhost'],
});
const verifyCsrfCookieName = 'magic-sso-verify-csrf';
const verifyTokenCookieName = 'magic-sso-verify-token';

function getRequestOrigin(request: ExpressRequest): string {
    return `${request.protocol}://${request.get('host') ?? 'localhost:3004'}`;
}

function hasSameOriginMutationSource(request: ExpressRequest): boolean {
    const expectedOrigin = getRequestOrigin(request);
    const originHeader = request.get('origin');
    if (typeof originHeader === 'string' && originHeader.length > 0) {
        return originHeader === expectedOrigin;
    }

    const refererHeader = request.get('referer');
    if (typeof refererHeader !== 'string' || refererHeader.length === 0) {
        return false;
    }

    try {
        return new URL(refererHeader).origin === expectedOrigin;
    } catch {
        return false;
    }
}

function buildRequestUrl(request: ExpressRequest): string {
    return `${getRequestOrigin(request)}${request.originalUrl}`;
}

function buildWebRequest(request: ExpressRequest): Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
            for (const entry of value) {
                headers.append(name, entry);
            }
            continue;
        }

        if (typeof value === 'string') {
            headers.set(name, value);
        }
    }

    return new Request(buildRequestUrl(request), {
        headers,
        method: request.method,
    });
}

function readBodyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readQueryString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPreviewSecret(): string | null {
    const previewSecret = process.env['MAGICSSO_PREVIEW_SECRET'];
    return typeof previewSecret === 'string' && previewSecret.length > 0 ? previewSecret : null;
}

function readSignInRequestBody(value: unknown): SignInRequestBody {
    const record = isRecord(value) ? value : null;

    return {
        email: readBodyString(record?.['email']),
        returnUrl: readBodyString(record?.['returnUrl']),
        scope: readBodyString(record?.['scope']),
        verifyUrl: readBodyString(record?.['verifyUrl']),
    };
}

function isVerifyEmailResponse(value: unknown): value is VerifyEmailResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'accessToken' in value &&
        typeof value.accessToken === 'string' &&
        value.accessToken.length > 0
    );
}

function isVerifyEmailPreviewResponse(value: unknown): value is VerifyEmailPreviewResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'email' in value &&
        typeof value.email === 'string' &&
        value.email.length > 0
    );
}

function buildLoginRedirectUrl(request: ExpressRequest, returnUrl: string, error?: string): string {
    const loginUrl = new URL('/login', getRequestOrigin(request));
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (typeof error === 'string') {
        loginUrl.searchParams.set('error', error);
    }
    return `${loginUrl.pathname}${loginUrl.search}`;
}

function setAuthCookie(response: ExpressResponse, accessToken: string): void {
    const cookieOptions = buildAuthCookieOptions(accessToken);

    response.cookie(cookieOptions.name, accessToken, {
        httpOnly: cookieOptions.httpOnly,
        maxAge:
            typeof cookieOptions.maxAgeSeconds === 'number'
                ? cookieOptions.maxAgeSeconds * 1000
                : undefined,
        path: cookieOptions.path,
        sameSite: cookieOptions.sameSite,
        secure: cookieOptions.secure,
    });
}

function buildVerifyCsrfCookieOptions(request: ExpressRequest): {
    httpOnly: true;
    path: '/verify-email';
    sameSite: 'strict';
    secure: boolean;
} {
    return {
        httpOnly: true,
        path: '/verify-email',
        sameSite: 'strict',
        secure: request.protocol === 'https',
    };
}

function buildVerifyTokenCookieOptions(request: ExpressRequest): {
    httpOnly: true;
    path: '/verify-email';
    sameSite: 'strict';
    secure: boolean;
} {
    return buildVerifyCsrfCookieOptions(request);
}

function clearVerifyCookies(response: ExpressResponse, request: ExpressRequest): void {
    response.clearCookie(verifyCsrfCookieName, buildVerifyCsrfCookieOptions(request));
    response.clearCookie(verifyTokenCookieName, buildVerifyTokenCookieOptions(request));
}

function createVerifyCsrfToken(): string {
    return randomBytes(32).toString('base64url');
}

function readCookie(request: ExpressRequest, cookieName: string): string | undefined {
    const cookieHeader = request.headers.cookie;
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    for (const entry of cookieHeader.split(';')) {
        const [name, ...valueParts] = entry.trim().split('=');
        if (name === cookieName) {
            const value = valueParts.join('=');
            return value.length > 0 ? decodeURIComponent(value) : undefined;
        }
    }

    return undefined;
}

function hasValidVerifyCsrfToken(submittedToken: string, cookieToken: string): boolean {
    const submittedBuffer = Buffer.from(submittedToken);
    const cookieBuffer = Buffer.from(cookieToken);
    if (submittedBuffer.length !== cookieBuffer.length) {
        return false;
    }

    return timingSafeEqual(submittedBuffer, cookieBuffer);
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderVerifyEmailConfirmationPage(
    email: string,
    returnUrl: string,
    csrfToken: string,
): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Confirm Sign In | Magic Link SSO Angular</title>
    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #eef4ff;
        color: #172554;
        font-family: Arial, sans-serif;
      }

      main {
        width: min(92vw, 28rem);
        padding: 2rem;
        border: 1px solid #cbd5e1;
        border-radius: 1.5rem;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 24px 64px rgba(37, 99, 235, 0.16);
      }

      .eyebrow {
        margin: 0 0 0.75rem;
        color: #334155;
        font-size: 0.85rem;
        font-weight: 700;
        letter-spacing: 0.22em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: 2rem;
      }

      p {
        line-height: 1.6;
      }

      .field-label {
        display: block;
        margin: 1.5rem 0 0.5rem;
        font-weight: 700;
      }

      .email-value {
        display: block;
        margin: 0;
        padding: 1rem 1.1rem;
        border: 1px solid #cbd5e1;
        border-radius: 1rem;
        font: inherit;
        color: #0f172a;
        font-weight: 700;
        letter-spacing: 0.01em;
        background: linear-gradient(180deg, #f8fbff 0%, #eef4ff 100%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92);
        overflow-wrap: anywhere;
      }

      button {
        width: 100%;
        margin-top: 1rem;
        padding: 0.9rem 1rem;
        border: 0;
        border-radius: 999px;
        font: inherit;
        font-weight: 700;
        color: #ffffff;
        background: #1d4ed8;
        cursor: pointer;
      }

      @media (prefers-color-scheme: dark) {
        body {
          background:
            radial-gradient(circle at top, rgba(45, 212, 191, 0.18), transparent 34%),
            linear-gradient(180deg, #020617 0%, #0f172a 100%);
          color: #e2f6f4;
        }

        main {
          border-color: rgba(148, 163, 184, 0.14);
          background: rgba(2, 6, 23, 0.8);
          box-shadow: 0 32px 100px rgba(2, 6, 23, 0.58);
        }

        .eyebrow {
          color: #99f6e4;
        }

        .field-label {
          color: #dbeafe;
        }

        .email-value {
          border-color: rgba(148, 163, 184, 0.42);
          color: #f8fafc;
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.9), rgba(8, 18, 29, 0.96));
          box-shadow: inset 0 1px 0 rgba(148, 163, 184, 0.08);
        }

        button {
          color: #04131f;
          background: #67e8f9;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Verify Email</p>
      <h1>Continue sign-in</h1>
      <p>Review the email address below, then continue to finish signing in.</p>
      <form method="post" action="/verify-email">
        <p id="email-label" class="field-label">Email</p>
        <p id="email-value" class="email-value" aria-labelledby="email-label">${escapeHtml(email)}</p>
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
        <input type="hidden" name="returnUrl" value="${escapeHtml(returnUrl)}" />
        <button type="submit">Continue</button>
      </form>
    </main>
  </body>
</html>`;
}

function clearAuthCookie(response: ExpressResponse): void {
    const cookieOptions = buildAuthCookieOptions('');

    response.clearCookie(cookieOptions.name, {
        httpOnly: cookieOptions.httpOnly,
        path: cookieOptions.path,
        sameSite: cookieOptions.sameSite,
        secure: cookieOptions.secure,
    });
}

async function readResponsePayload(response: Response): Promise<unknown> {
    return response.json().catch(async () => ({
        message: await response.text().catch(() => ''),
    }));
}

function handleAsync(handler: AsyncExpressHandler): ExpressRequestHandler {
    return (request, response, next) => {
        void handler(request, response, next).catch(next);
    };
}

function createApp(): express.Express {
    const app = express();

    app.disable('x-powered-by');
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    app.get(
        '/api/session',
        handleAsync(async (request, response) => {
            const auth = await verifyRequestAuth(buildWebRequest(request));
            response.setHeader('cache-control', 'no-store');
            response.json(auth);
        }),
    );

    app.post(
        '/api/signin',
        handleAsync(async (request, response) => {
            const body = readSignInRequestBody(request.body);
            if (
                typeof body.email !== 'string' ||
                typeof body.returnUrl !== 'string' ||
                typeof body.verifyUrl !== 'string'
            ) {
                response.status(400).json({
                    success: false,
                    message: 'Invalid sign-in request payload.',
                } satisfies SignInResult);
                return;
            }

            const serverUrl = process.env['MAGICSSO_SERVER_URL'];
            if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
                response.status(500).json({
                    success: false,
                    message: 'MAGICSSO_SERVER_URL is not configured.',
                } satisfies SignInResult);
                return;
            }

            const serverUrlConfigError = readServerUrlConfigError(
                serverUrl,
                getRequestOrigin(request),
            );
            if (typeof serverUrlConfigError === 'string') {
                response.status(500).json({
                    success: false,
                    message: serverUrlConfigError,
                } satisfies SignInResult);
                return;
            }

            try {
                const ssoResponse = await fetch(new URL('/signin', serverUrl), {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        email: body.email,
                        returnUrl: body.returnUrl,
                        verifyUrl: body.verifyUrl,
                        ...(typeof body.scope === 'string' && body.scope.trim().length > 0
                            ? { scope: body.scope.trim() }
                            : {}),
                    }),
                    cache: 'no-store',
                });

                if (!ssoResponse.ok) {
                    const payload = await readResponsePayload(ssoResponse);
                    response.status(ssoResponse.status).json({
                        success: false,
                        message: buildFailureResult(payload).message,
                    } satisfies SignInResult);
                    return;
                }

                response.json({
                    success: true,
                    message: 'Verification email sent.',
                } satisfies SignInResult);
            } catch (error: unknown) {
                response.status(502).json({
                    success: false,
                    message: readMessage(error) ?? 'Failed to send verification email.',
                } satisfies SignInResult);
            }
        }),
    );

    app.get(
        '/verify-email',
        handleAsync(async (request, response) => {
            const appOrigin = getRequestOrigin(request);
            const token = readQueryString(request.query['token']);
            const returnUrl = normaliseReturnUrl(
                readQueryString(request.query['returnUrl']),
                appOrigin,
                '/',
            );

            if (typeof token !== 'string') {
                response.redirect(
                    buildLoginRedirectUrl(request, returnUrl, 'missing-verification-token'),
                );
                return;
            }

            const serverUrl = process.env['MAGICSSO_SERVER_URL'];
            if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
                response.redirect(
                    buildLoginRedirectUrl(request, returnUrl, 'verify-email-misconfigured'),
                );
                return;
            }
            const previewSecret = readPreviewSecret();
            if (previewSecret === null) {
                response.redirect(
                    buildLoginRedirectUrl(request, returnUrl, 'verify-email-misconfigured'),
                );
                return;
            }

            try {
                const previewUrl = new URL('/verify-email', serverUrl);
                previewUrl.searchParams.set('token', token);

                const verifyResponse = await fetch(previewUrl, {
                    headers: {
                        accept: 'application/json',
                        'x-magic-sso-preview-secret': previewSecret,
                    },
                    cache: 'no-store',
                });

                if (!verifyResponse.ok) {
                    response.redirect(
                        buildLoginRedirectUrl(request, returnUrl, 'verify-email-failed'),
                    );
                    return;
                }

                const payload: unknown = await verifyResponse.json();
                if (!isVerifyEmailPreviewResponse(payload)) {
                    response.redirect(
                        buildLoginRedirectUrl(request, returnUrl, 'verify-email-failed'),
                    );
                    return;
                }

                const csrfToken = createVerifyCsrfToken();
                response.cookie(
                    verifyCsrfCookieName,
                    csrfToken,
                    buildVerifyCsrfCookieOptions(request),
                );
                response.cookie(
                    verifyTokenCookieName,
                    token,
                    buildVerifyTokenCookieOptions(request),
                );
                response.type('text/html; charset=utf-8');
                response.send(
                    renderVerifyEmailConfirmationPage(payload.email, returnUrl, csrfToken),
                );
            } catch {
                response.redirect(buildLoginRedirectUrl(request, returnUrl, 'verify-email-failed'));
            }
        }),
    );

    app.post(
        '/verify-email',
        handleAsync(async (request, response) => {
            const appOrigin = getRequestOrigin(request);
            const submittedToken = readBodyString(request.body['token']);
            const cookieToken = readCookie(request, verifyTokenCookieName);
            const submittedCsrfToken = readBodyString(request.body['csrfToken']);
            const returnUrl = normaliseReturnUrl(
                readBodyString(request.body['returnUrl']),
                appOrigin,
                '/',
            );
            const cookieCsrfToken = readCookie(request, verifyCsrfCookieName);
            const token =
                typeof submittedToken === 'string'
                    ? typeof cookieToken === 'string' && submittedToken !== cookieToken
                        ? undefined
                        : submittedToken
                    : cookieToken;

            if (
                typeof token !== 'string' ||
                typeof submittedCsrfToken !== 'string' ||
                typeof cookieCsrfToken !== 'string' ||
                !hasValidVerifyCsrfToken(submittedCsrfToken, cookieCsrfToken)
            ) {
                clearVerifyCookies(response, request);
                response.redirect(buildLoginRedirectUrl(request, returnUrl, 'verify-email-failed'));
                return;
            }

            const serverUrl = process.env['MAGICSSO_SERVER_URL'];
            if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
                clearVerifyCookies(response, request);
                response.redirect(
                    buildLoginRedirectUrl(request, returnUrl, 'verify-email-misconfigured'),
                );
                return;
            }

            try {
                const verifyUrl = new URL('/verify-email', serverUrl);

                const verifyResponse = await fetch(verifyUrl, {
                    method: 'POST',
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({ token }),
                    cache: 'no-store',
                });

                if (!verifyResponse.ok) {
                    clearVerifyCookies(response, request);
                    response.redirect(
                        buildLoginRedirectUrl(request, returnUrl, 'verify-email-failed'),
                    );
                    return;
                }

                const payload: unknown = await verifyResponse.json();
                if (!isVerifyEmailResponse(payload)) {
                    clearVerifyCookies(response, request);
                    response.redirect(
                        buildLoginRedirectUrl(request, returnUrl, 'verify-email-failed'),
                    );
                    return;
                }

                const jwtSecret = getJwtSecret();
                if (jwtSecret === null) {
                    clearVerifyCookies(response, request);
                    response.redirect(
                        buildLoginRedirectUrl(
                            request,
                            returnUrl,
                            'session-verification-misconfigured',
                        ),
                    );
                    return;
                }

                const auth = await verifyAuthToken(payload.accessToken, jwtSecret, {
                    expectedAudience: getRequestOrigin(request),
                    expectedIssuer: new URL(serverUrl).origin,
                });
                if (auth === null) {
                    clearVerifyCookies(response, request);
                    response.redirect(
                        buildLoginRedirectUrl(request, returnUrl, 'session-verification-failed'),
                    );
                    return;
                }

                clearVerifyCookies(response, request);
                setAuthCookie(response, payload.accessToken);
                response.redirect(returnUrl);
            } catch {
                clearVerifyCookies(response, request);
                response.redirect(buildLoginRedirectUrl(request, returnUrl, 'verify-email-failed'));
            }
        }),
    );

    app.post('/logout', (request, response) => {
        if (!hasSameOriginMutationSource(request)) {
            response.status(403).send('Forbidden');
            return;
        }

        clearAuthCookie(response);
        response.redirect('/');
    });

    if (existsSync(browserDistFolder)) {
        app.use(
            express.static(browserDistFolder, {
                index: false,
                maxAge: '1y',
                redirect: false,
            }),
        );
    }

    app.get(
        /.*/,
        handleAsync(async (request, response, next) => {
            const webResponse = await angularNodeAppEngine.handle(buildWebRequest(request));
            if (webResponse === null) {
                next();
                return;
            }

            await writeResponseToNodeResponse(webResponse, response);
        }),
    );

    return app;
}

const app = createApp();
export const reqHandler = createNodeRequestHandler(app);

if (isMainModule(import.meta.url)) {
    const host = process.env['HOST'] ?? '0.0.0.0';
    const port = Number.parseInt(process.env['PORT'] ?? '3004', 10);
    app.listen(port, host, () => {
        console.log(`Angular SSR example listening on http://localhost:${port}`);
    });
}

export default reqHandler;
