// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import 'dotenv/config';
import { escapeHtml, readCookieValue } from '@magic-link-sso/config-core/runtime';
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
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildAuthCookieOptions,
    normaliseReturnUrl,
    verifyRequestAuth,
} from '@magic-link-sso/angular';
import {
    exchangeOtpCode,
    exchangeVerificationToken,
    hasValidCsrfPair,
    isSameOriginMutation,
    previewVerificationToken,
    readBodyString,
    readSignInRequestBody,
    readVerifyOtpRequestBody,
    requestSignIn,
    selectVerifyToken,
    toWebHeaders,
    type SignInResult,
} from './server-flows';
export { AngularAppEngine } from '@angular/ssr';

type AsyncExpressHandler = (
    request: ExpressRequest,
    response: ExpressResponse,
    next: ExpressNextFunction,
) => Promise<void>;

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
    return isSameOriginMutation(
        getRequestOrigin(request),
        request.get('origin'),
        request.get('referer'),
    );
}

function buildRequestUrl(request: ExpressRequest): string {
    return `${getRequestOrigin(request)}${request.originalUrl}`;
}

function buildWebRequest(request: ExpressRequest): Request {
    return new Request(buildRequestUrl(request), {
        headers: toWebHeaders(request.headers),
        method: request.method,
    });
}

function readQueryString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
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

const invalidOtpResult: SignInResult = {
    success: false,
    message: 'Invalid or expired code.',
};

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
            const { result, status } = await requestSignIn(
                readSignInRequestBody(request.body),
                getRequestOrigin(request),
                process.env['MAGICSSO_SERVER_URL'],
            );
            response.status(status).json(result);
        }),
    );

    app.post(
        '/api/verify-email/otp',
        handleAsync(async (request, response) => {
            if (!hasSameOriginMutationSource(request)) {
                response.status(403).json(invalidOtpResult);
                return;
            }

            const accessToken = await exchangeOtpCode(
                readVerifyOtpRequestBody(request.body),
                getRequestOrigin(request),
                process.env['MAGICSSO_SERVER_URL'],
            );
            if (accessToken === null) {
                response.status(400).json(invalidOtpResult);
                return;
            }

            setAuthCookie(response, accessToken);
            response.json({ success: true, message: 'Signed in.' } satisfies SignInResult);
        }),
    );

    app.get(
        '/verify-email',
        handleAsync(async (request, response) => {
            const returnUrl = normaliseReturnUrl(
                readQueryString(request.query['returnUrl']),
                getRequestOrigin(request),
                '/',
            );
            const preview = await previewVerificationToken({
                previewSecret: process.env['MAGICSSO_PREVIEW_SECRET'],
                serverUrl: process.env['MAGICSSO_SERVER_URL'],
                token: readQueryString(request.query['token']),
            });
            if ('error' in preview) {
                response.redirect(buildLoginRedirectUrl(request, returnUrl, preview.error));
                return;
            }

            const csrfToken = createVerifyCsrfToken();
            response.cookie(verifyCsrfCookieName, csrfToken, buildVerifyCsrfCookieOptions(request));
            response.cookie(
                verifyTokenCookieName,
                preview.token,
                buildVerifyTokenCookieOptions(request),
            );
            response.type('text/html; charset=utf-8');
            response.send(renderVerifyEmailConfirmationPage(preview.email, returnUrl, csrfToken));
        }),
    );

    app.post(
        '/verify-email',
        handleAsync(async (request, response) => {
            const appOrigin = getRequestOrigin(request);
            const returnUrl = normaliseReturnUrl(
                readBodyString(request.body['returnUrl']),
                appOrigin,
                '/',
            );
            const token = selectVerifyToken(
                readBodyString(request.body['token']),
                readCookieValue(request.headers.cookie, verifyTokenCookieName),
            );
            const csrfIsValid = hasValidCsrfPair(
                readBodyString(request.body['csrfToken']),
                readCookieValue(request.headers.cookie, verifyCsrfCookieName),
            );
            const outcome =
                typeof token === 'string' && csrfIsValid
                    ? await exchangeVerificationToken({
                          appOrigin,
                          serverUrl: process.env['MAGICSSO_SERVER_URL'],
                          token,
                      })
                    : { error: 'verify-email-failed' };

            clearVerifyCookies(response, request);
            if ('error' in outcome) {
                response.redirect(buildLoginRedirectUrl(request, returnUrl, outcome.error));
                return;
            }

            setAuthCookie(response, outcome.accessToken);
            response.redirect(returnUrl);
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
