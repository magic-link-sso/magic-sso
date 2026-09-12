/**
 * packages/nextjs/src/components/verifyEmail/route.ts
 *
 * @license MIT
 *
 * MIT License
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
    escapeHtml,
    isVerifyEmailPreviewResponse,
    isVerifyEmailResponse,
    type VerifyEmailPreviewResponse,
} from '@magic-link-sso/core';
import { buildAuthCookieOptions, getJwtSecret, verifyAuthToken } from '../../lib/auth';

export interface VerifyEmailRouteOptions {
    /** Document title for the confirmation page this route renders. */
    pageTitle?: string;
    /**
     * Resolve the public origin the app answers on. Defaults to the request
     * URL's own origin; pass a resolver when the app sits behind a proxy.
     */
    resolveAppOrigin?: (request: NextRequest) => string;
}

const DEFAULT_PAGE_TITLE = 'Confirm Sign In';

/** Constant-time comparison of the double-submit CSRF token pair. */
function safeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

const verifyCsrfCookieName = 'magic-sso-verify-csrf';
const verifyTokenCookieName = 'magic-sso-verify-token';

function normaliseReturnUrl(returnUrl: string | null, origin: string): string {
    if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
        return '/';
    }
    if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
        return returnUrl;
    }

    try {
        const parsedUrl = new URL(returnUrl);
        return parsedUrl.origin === origin ? parsedUrl.toString() : '/';
    } catch {
        return '/';
    }
}

function buildLoginRedirect(appOrigin: string, returnUrl: string, error?: string): NextResponse {
    const loginUrl = new URL('/login', appOrigin);
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (typeof error === 'string') {
        loginUrl.searchParams.set('error', error);
    }
    return NextResponse.redirect(loginUrl);
}

function createVerifyCsrfToken(): string {
    return randomBytes(32).toString('base64url');
}

function hasValidVerifyCsrfToken(submittedToken: string, cookieToken: string): boolean {
    return safeCompare(submittedToken, cookieToken);
}

function buildVerifyCookieOptions(request: NextRequest): {
    httpOnly: true;
    path: '/verify-email';
    sameSite: 'strict';
    secure: boolean;
} {
    return {
        httpOnly: true,
        path: '/verify-email',
        sameSite: 'strict',
        secure: request.nextUrl.protocol === 'https:',
    };
}

function getPreviewSecret(): string | null {
    const previewSecret = process.env.MAGICSSO_PREVIEW_SECRET;
    return typeof previewSecret === 'string' && previewSecret.length > 0 ? previewSecret : null;
}

function clearVerifyCookie(response: NextResponse, request: NextRequest): void {
    response.cookies.set({
        ...buildVerifyCookieOptions(request),
        name: verifyCsrfCookieName,
        value: '',
        maxAge: 0,
    });
    response.cookies.set({
        ...buildVerifyCookieOptions(request),
        name: verifyTokenCookieName,
        value: '',
        maxAge: 0,
    });
}

function renderConfirmationPage(
    email: string,
    returnUrl: string,
    csrfToken: string,
    pageTitle: string,
): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(pageTitle)}</title>
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

async function previewVerificationEmail(
    token: string,
): Promise<VerifyEmailPreviewResponse | 'misconfigured' | null> {
    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
        console.error('Verify-email route is missing MAGICSSO_SERVER_URL.');
        return 'misconfigured';
    }

    const verifyUrl = new URL('/verify-email', serverUrl);
    verifyUrl.searchParams.set('token', token);
    const previewSecret = getPreviewSecret();
    if (previewSecret === null) {
        console.error('Verify-email route is missing MAGICSSO_PREVIEW_SECRET.');
        return 'misconfigured';
    }

    try {
        const response = await fetch(verifyUrl, {
            headers: {
                accept: 'application/json',
                'x-magic-sso-preview-secret': previewSecret,
            },
            cache: 'no-store',
        });
        if (!response.ok) {
            return null;
        }

        const payload: unknown = await response.json();
        return isVerifyEmailPreviewResponse(payload) ? payload : null;
    } catch (error) {
        console.error('Verify-email preview failed unexpectedly.', error);
        return null;
    }
}

async function renderVerifyEmailPage(
    request: NextRequest,
    appOrigin: string,
    pageTitle: string,
): Promise<NextResponse> {
    const token = request.nextUrl.searchParams.get('token');
    const returnUrl = normaliseReturnUrl(request.nextUrl.searchParams.get('returnUrl'), appOrigin);
    if (typeof token !== 'string' || token.length === 0) {
        return buildLoginRedirect(appOrigin, returnUrl, 'missing-verification-token');
    }

    const payload = await previewVerificationEmail(token);
    if (payload === 'misconfigured') {
        return buildLoginRedirect(appOrigin, returnUrl, 'verify-email-misconfigured');
    }
    if (payload === null) {
        return buildLoginRedirect(appOrigin, returnUrl, 'verify-email-failed');
    }

    const csrfToken = createVerifyCsrfToken();
    const response = new NextResponse(
        renderConfirmationPage(payload.email, returnUrl, csrfToken, pageTitle),
        {
            headers: {
                'cache-control': 'no-store',
                'content-type': 'text/html; charset=utf-8',
            },
        },
    );
    response.cookies.set({
        ...buildVerifyCookieOptions(request),
        name: verifyCsrfCookieName,
        value: csrfToken,
    });
    response.cookies.set({
        ...buildVerifyCookieOptions(request),
        name: verifyTokenCookieName,
        value: token,
    });
    return response;
}

type VerificationOutcome =
    | { accessToken: string; kind: 'success' }
    | {
          error:
              | 'session-verification-failed'
              | 'verify-email-failed'
              | 'verify-email-misconfigured';
          kind: 'error';
      };

/**
 * Read the submitted verification token, rejecting the submission when the
 * double-submit CSRF pair does not match or the posted token disagrees with the
 * one this app handed out.
 */
function readVerifiedSubmissionToken(request: NextRequest, formData: FormData): string | null {
    const submittedCsrfToken = formData.get('csrfToken');
    const cookieCsrfToken = request.cookies.get(verifyCsrfCookieName)?.value;
    if (
        typeof submittedCsrfToken !== 'string' ||
        typeof cookieCsrfToken !== 'string' ||
        !hasValidVerifyCsrfToken(submittedCsrfToken, cookieCsrfToken)
    ) {
        return null;
    }

    const submittedToken = formData.get('token');
    const cookieToken = request.cookies.get(verifyTokenCookieName)?.value;
    const token =
        typeof submittedToken === 'string'
            ? typeof cookieToken === 'string' && submittedToken !== cookieToken
                ? null
                : submittedToken
            : cookieToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
}

/** Read the access token out of a successful `/verify-email` response. */
async function readVerifiedAccessToken(response: Response): Promise<string | null> {
    const payload: unknown = await response.json();
    if (!isVerifyEmailResponse(payload)) {
        console.error(
            'Verify-email route received an invalid response payload from the SSO server.',
        );
        return null;
    }

    return payload.accessToken;
}

/** Report why the SSO server refused the verification token. */
async function logVerificationRejection(response: Response): Promise<void> {
    const payload: unknown = await response.json().catch(() => null);
    const serverMessage =
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload &&
        typeof payload.message === 'string'
            ? payload.message
            : undefined;
    console.error('Verify-email request to SSO server failed.', {
        serverMessage,
        status: response.status,
    });
}

/** Exchange a one-time verification token for a verified session token. */
async function completeVerification(
    token: string,
    appOrigin: string,
): Promise<VerificationOutcome> {
    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
        console.error('Verify-email route is missing MAGICSSO_SERVER_URL.');
        return { error: 'verify-email-misconfigured', kind: 'error' };
    }

    const jwtSecret = getJwtSecret();
    if (jwtSecret === null) {
        console.error(
            'Verify-email route cannot validate the auth token because MAGICSSO_JWT_SECRET is missing.',
        );
        return { error: 'verify-email-misconfigured', kind: 'error' };
    }

    try {
        const response = await fetch(new URL('/verify-email', serverUrl), {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ token }),
            cache: 'no-store',
        });
        if (!response.ok) {
            await logVerificationRejection(response);
            return { error: 'verify-email-failed', kind: 'error' };
        }

        const accessToken = await readVerifiedAccessToken(response);
        if (accessToken === null) {
            return { error: 'verify-email-failed', kind: 'error' };
        }

        const verifiedAccessToken = await verifyAuthToken(accessToken, jwtSecret, {
            expectedAudience: appOrigin,
            expectedIssuer: new URL(serverUrl).origin,
        });
        if (verifiedAccessToken === null) {
            console.error(
                'Verify-email route rejected the auth token returned by the SSO server. Check that MAGICSSO_JWT_SECRET matches the server JWT secret.',
            );
            return { error: 'session-verification-failed', kind: 'error' };
        }

        return { accessToken, kind: 'success' };
    } catch (error) {
        console.error('Verify-email route failed unexpectedly.', error);
        return { error: 'verify-email-failed', kind: 'error' };
    }
}

/** Send the visitor back to the login page and drop the one-time verify cookies. */
function failVerification(
    request: NextRequest,
    appOrigin: string,
    returnUrl: string,
    error: string,
): NextResponse {
    const response = buildLoginRedirect(appOrigin, returnUrl, error);
    clearVerifyCookie(response, request);
    return response;
}

async function submitVerifyEmailPage(
    request: NextRequest,
    appOrigin: string,
): Promise<NextResponse> {
    const formData = await request.formData();
    const returnUrlValue = formData.get('returnUrl');
    const returnUrl = normaliseReturnUrl(
        typeof returnUrlValue === 'string' ? returnUrlValue : null,
        appOrigin,
    );

    const token = readVerifiedSubmissionToken(request, formData);
    if (token === null) {
        return failVerification(request, appOrigin, returnUrl, 'verify-email-failed');
    }

    const outcome = await completeVerification(token, appOrigin);
    if (outcome.kind === 'error') {
        return failVerification(request, appOrigin, returnUrl, outcome.error);
    }

    const redirectResponse = NextResponse.redirect(new URL(returnUrl, appOrigin));
    clearVerifyCookie(redirectResponse, request);
    redirectResponse.cookies.set(buildAuthCookieOptions(outcome.accessToken));
    return redirectResponse;
}

/**
 * Drop-in App Router handler for the client-side `/verify-email` callback.
 *
 * `GET` renders a confirmation page for the one-time token in the magic link,
 * and `POST` exchanges the confirmed token for a session cookie. Export it from
 * `app/verify-email/route.ts` as both `GET` and `POST`.
 */
export async function VerifyEmailRoute(
    request: NextRequest,
    options: VerifyEmailRouteOptions = {},
): Promise<NextResponse> {
    const appOrigin = options.resolveAppOrigin?.(request) ?? request.nextUrl.origin;
    return request.method === 'POST'
        ? submitVerifyEmailPage(request, appOrigin)
        : renderVerifyEmailPage(request, appOrigin, options.pageTitle ?? DEFAULT_PAGE_TITLE);
}
