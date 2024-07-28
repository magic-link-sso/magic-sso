// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { randomBytes } from 'node:crypto';
import {
    defineEventHandler,
    getQuery,
    getRequestURL,
    sendRedirect,
    setCookie,
    setHeader,
    type H3Event,
} from 'h3';
import { buildLoginUrl, getMagicSsoConfig, normaliseReturnUrl } from '../utils/auth';

interface VerifyEmailPreviewResponse {
    email: string;
}

const verifyCsrfCookieName = 'magic-sso-verify-csrf';

function isVerifyEmailPreviewResponse(value: unknown): value is VerifyEmailPreviewResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'email' in value &&
        typeof value.email === 'string' &&
        value.email.length > 0
    );
}

async function redirectToLogin(event: H3Event, pathname: string): Promise<void> {
    await sendRedirect(event, buildLoginUrl(event, pathname), 303);
}

function getPreviewSecret(event: H3Event): string | null {
    const config = getMagicSsoConfig(event);
    return config.previewSecret.length > 0 ? config.previewSecret : null;
}

function createVerifyCsrfToken(): string {
    return randomBytes(32).toString('base64url');
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderConfirmationPage(
    email: string,
    token: string,
    returnUrl: string,
    csrfToken: string,
): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Confirm Sign In | Magic Link SSO Nuxt</title>
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
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <button type="submit">Continue</button>
      </form>
    </main>
  </body>
</html>`;
}

export default defineEventHandler(async (event): Promise<string | void> => {
    const query = getQuery(event);
    const requestUrl = getRequestURL(event);
    const token = typeof query.token === 'string' ? query.token : undefined;
    const returnUrl = normaliseReturnUrl(
        typeof query.returnUrl === 'string' ? query.returnUrl : undefined,
        requestUrl.origin,
    );

    if (typeof token !== 'string' || token.length === 0) {
        await redirectToLogin(event, returnUrl);
        return;
    }

    const config = getMagicSsoConfig(event);
    if (config.serverUrl.length === 0) {
        await redirectToLogin(event, returnUrl);
        return;
    }
    const previewSecret = getPreviewSecret(event);
    if (previewSecret === null) {
        await redirectToLogin(event, returnUrl);
        return;
    }

    const verifyUrl = new URL('/verify-email', config.serverUrl);
    verifyUrl.searchParams.set('token', token);

    try {
        const response = await fetch(verifyUrl, {
            headers: {
                accept: 'application/json',
                'x-magic-sso-preview-secret': previewSecret,
            },
            cache: 'no-store',
        });
        if (!response.ok) {
            await redirectToLogin(event, returnUrl);
            return;
        }

        const payload: unknown = await response.json();
        if (!isVerifyEmailPreviewResponse(payload)) {
            await redirectToLogin(event, returnUrl);
            return;
        }

        const csrfToken = createVerifyCsrfToken();
        setCookie(event, verifyCsrfCookieName, csrfToken, {
            path: '/verify-email',
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
        });
        setHeader(event, 'cache-control', 'no-store');
        setHeader(event, 'content-type', 'text/html; charset=utf-8');
        return renderConfirmationPage(payload.email, token, returnUrl, csrfToken);
    } catch {
        await redirectToLogin(event, returnUrl);
    }
});
