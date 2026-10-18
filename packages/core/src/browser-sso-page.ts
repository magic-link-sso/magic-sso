// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak
import { escapeHtml } from './html.js';
import type { BrowserSsoClientError } from './browser-sso-client.js';

const messages: Record<BrowserSsoClientError, string> = {
    invalid_request: 'This sign-in request is invalid. Start again from your application.',
    invalid_transaction:
        'This sign-in does not match an open sign-in tab. Start again from your application.',
    transaction_expired: 'This sign-in has expired. Start again from your application.',
    transaction_limit:
        'Finish a sign-in in another tab, or wait for it to expire before trying again.',
    transaction_too_large:
        'This address is too long for sign-in. Open a shorter link in your application.',
    sso_required:
        'This application requires browser SSO. Contact its administrator to check the sign-in service.',
    temporarily_unavailable:
        'Magic Link SSO is temporarily unavailable. Start again from your application.',
    exchange_failed: 'Sign-in could not be completed. Start again from your application.',
    invalid_token: 'The application could not verify this session. Contact its administrator.',
    sso_disabled: 'Browser SSO is disabled. Start again from your application.',
    access_denied: 'This account does not have access to the application.',
};

export function getBrowserSsoErrorMessage(error: BrowserSsoClientError): string {
    return messages[error];
}

/** Optional default page for server adapters; no scripts or automatic navigation. */
export function renderBrowserSsoStatusPage(options: {
    title: string;
    message: string;
    nextHref: string;
    nextText: string;
    centralSignOutHref?: string;
    restartHref?: string;
    isError?: boolean;
}): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)} | Magic Link SSO</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:#eef4ff;color:#172554;font-family:Arial,sans-serif;line-height:1.6}
    main{width:min(100%,36rem);padding:clamp(1.5rem,5vw,3rem);background:#fff;border-radius:1rem}h1{font-size:clamp(1.6rem,5vw,2rem);line-height:1.25;margin:0 0 1rem}p{color:#334155;margin:0 0 1.5rem}
    nav{display:flex;flex-wrap:wrap;gap:.75rem}a{display:inline-block;padding:.75rem 1rem;border:2px solid #1d4ed8;border-radius:.5rem;color:#1d4ed8;font-weight:700;text-decoration:none}a:first-child{color:#fff;background:#1d4ed8}a:focus-visible{outline:3px solid #172554;outline-offset:4px}a:hover{text-decoration:underline}
    </style></head><body><main><h1>${escapeHtml(options.title)}</h1><p${options.isError ? ' role="alert"' : ''}>${escapeHtml(options.message)}</p>
    <nav aria-label="Sign-in options"><a href="${escapeHtml(options.nextHref)}" referrerpolicy="no-referrer">${escapeHtml(options.nextText)}</a>
    ${options.restartHref ? `<a href="${escapeHtml(options.restartHref)}" referrerpolicy="no-referrer">Start a fresh sign-in</a>` : ''}
    ${options.centralSignOutHref ? `<a href="${escapeHtml(options.centralSignOutHref)}" referrerpolicy="no-referrer">End browser SSO session</a>` : ''}</nav></main></body></html>`;
}

export function getBrowserSsoPageHeaders(): Record<string, string> {
    return {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
    };
}
