// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { buildAuthCookieOptions, getJwtSecret, verifyAuthToken } from '@magic-link-sso/nextjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

interface VerifyEmailResponse {
    accessToken: string;
}

interface VerifyEmailPreviewResponse {
    email: string;
}

const verifyCsrfCookieName = 'magic-sso-verify-csrf';
const verifyTokenCookieName = 'magic-sso-verify-token';

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

function buildLoginRedirect(request: NextRequest, returnUrl: string, error?: string): NextResponse {
    const loginUrl = new URL('/login', request.nextUrl.origin);
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
    const submittedBuffer = Buffer.from(submittedToken);
    const cookieBuffer = Buffer.from(cookieToken);
    if (submittedBuffer.length !== cookieBuffer.length) {
        return false;
    }

    return timingSafeEqual(submittedBuffer, cookieBuffer);
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

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderConfirmationPage(email: string, returnUrl: string, csrfToken: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Confirm Sign In | Magic Link SSO Next.js</title>
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

export async function GET(request: NextRequest): Promise<NextResponse> {
    const token = request.nextUrl.searchParams.get('token');
    const returnUrl = normaliseReturnUrl(
        request.nextUrl.searchParams.get('returnUrl'),
        request.nextUrl.origin,
    );
    if (typeof token !== 'string' || token.length === 0) {
        return buildLoginRedirect(request, returnUrl, 'missing-verification-token');
    }

    const payload = await previewVerificationEmail(token);
    if (payload === 'misconfigured') {
        return buildLoginRedirect(request, returnUrl, 'verify-email-misconfigured');
    }
    if (payload === null) {
        return buildLoginRedirect(request, returnUrl, 'verify-email-failed');
    }

    const csrfToken = createVerifyCsrfToken();
    const response = new NextResponse(renderConfirmationPage(payload.email, returnUrl, csrfToken), {
        headers: {
            'cache-control': 'no-store',
            'content-type': 'text/html; charset=utf-8',
        },
    });
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

export async function POST(request: NextRequest): Promise<NextResponse> {
    const formData = await request.formData();
    const submittedToken = formData.get('token');
    const returnUrlValue = formData.get('returnUrl');
    const returnUrl = normaliseReturnUrl(
        typeof returnUrlValue === 'string' ? returnUrlValue : null,
        request.nextUrl.origin,
    );
    const submittedCsrfToken = formData.get('csrfToken');
    const cookieCsrfToken = request.cookies.get(verifyCsrfCookieName)?.value;
    const cookieToken = request.cookies.get(verifyTokenCookieName)?.value;
    const token =
        typeof submittedToken === 'string'
            ? typeof cookieToken === 'string' && submittedToken !== cookieToken
                ? null
                : submittedToken
            : cookieToken;

    if (
        typeof token !== 'string' ||
        token.length === 0 ||
        typeof submittedCsrfToken !== 'string' ||
        typeof cookieCsrfToken !== 'string' ||
        !hasValidVerifyCsrfToken(submittedCsrfToken, cookieCsrfToken)
    ) {
        const response = buildLoginRedirect(request, returnUrl, 'verify-email-failed');
        clearVerifyCookie(response, request);
        return response;
    }

    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
        console.error('Verify-email route is missing MAGICSSO_SERVER_URL.');
        const response = buildLoginRedirect(request, returnUrl, 'verify-email-misconfigured');
        clearVerifyCookie(response, request);
        return response;
    }

    const verifyUrl = new URL('/verify-email', serverUrl);

    try {
        const response = await fetch(verifyUrl, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ token }),
            cache: 'no-store',
        });
        if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as unknown;
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
            const redirectResponse = buildLoginRedirect(request, returnUrl, 'verify-email-failed');
            clearVerifyCookie(redirectResponse, request);
            return redirectResponse;
        }

        const payload: unknown = await response.json();
        if (!isVerifyEmailResponse(payload)) {
            console.error(
                'Verify-email route received an invalid response payload from the SSO server.',
            );
            const redirectResponse = buildLoginRedirect(request, returnUrl, 'verify-email-failed');
            clearVerifyCookie(redirectResponse, request);
            return redirectResponse;
        }

        const jwtSecret = getJwtSecret();
        if (jwtSecret === null) {
            console.error(
                'Verify-email route cannot validate the auth token because MAGICSSO_JWT_SECRET is missing.',
            );
            const redirectResponse = buildLoginRedirect(
                request,
                returnUrl,
                'verify-email-misconfigured',
            );
            clearVerifyCookie(redirectResponse, request);
            return redirectResponse;
        }

        const verifiedAccessToken = await verifyAuthToken(payload.accessToken, jwtSecret, {
            expectedAudience: request.nextUrl.origin,
            expectedIssuer: new URL(serverUrl).origin,
        });
        if (verifiedAccessToken === null) {
            console.error(
                'Verify-email route rejected the auth token returned by the SSO server. Check that MAGICSSO_JWT_SECRET matches the server JWT secret.',
            );
            const redirectResponse = buildLoginRedirect(
                request,
                returnUrl,
                'session-verification-failed',
            );
            clearVerifyCookie(redirectResponse, request);
            return redirectResponse;
        }

        const redirectUrl = new URL(returnUrl, request.nextUrl.origin);
        const redirectResponse = NextResponse.redirect(redirectUrl);
        clearVerifyCookie(redirectResponse, request);
        redirectResponse.cookies.set(buildAuthCookieOptions(payload.accessToken));
        return redirectResponse;
    } catch (error) {
        console.error('Verify-email route failed unexpectedly.', error);
        const redirectResponse = buildLoginRedirect(request, returnUrl, 'verify-email-failed');
        clearVerifyCookie(redirectResponse, request);
        return redirectResponse;
    }
}
