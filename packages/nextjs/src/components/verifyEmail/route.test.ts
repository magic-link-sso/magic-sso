// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyEmailRoute } from './route';

const serverUrl = 'https://sso.example.com';

function createGetRequest(url: string): NextRequest {
    return new NextRequest(url, { method: 'GET' });
}

describe('VerifyEmailRoute', () => {
    beforeEach(() => {
        process.env.MAGICSSO_SERVER_URL = serverUrl;
        process.env.MAGICSSO_PREVIEW_SECRET = 'preview-secret';
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.MAGICSSO_SERVER_URL;
        delete process.env.MAGICSSO_PREVIEW_SECRET;
    });

    it('redirects to the login page when the magic link carries no token', async () => {
        const response = await VerifyEmailRoute(
            createGetRequest('https://app.example.com/verify-email?returnUrl=/albums'),
        );

        expect(response.status).toBe(307);
        const location = new URL(response.headers.get('location') ?? '');
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('error')).toBe('missing-verification-token');
        expect(location.searchParams.get('returnUrl')).toBe('/albums');
    });

    it('renders a confirmation page that posts the token back from a cookie', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json({ email: 'user@example.com' }),
        );

        const response = await VerifyEmailRoute(
            createGetRequest('https://app.example.com/verify-email?token=abc&returnUrl=/albums'),
            { pageTitle: 'Confirm Sign In | Example' },
        );
        const html = await response.text();

        expect(response.headers.get('content-type')).toContain('text/html');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(html).toContain('<title>Confirm Sign In | Example</title>');
        expect(html).toContain('Continue sign-in');
        expect(html).toContain('id="email-value"');
        expect(html).toContain('user@example.com');
        expect(html).toContain('@media (prefers-color-scheme: dark)');
        // The one-time token travels in an HttpOnly cookie, never in the form.
        expect(html).not.toContain('name="token"');
        expect(response.cookies.get('magic-sso-verify-token')?.value).toBe('abc');
        expect(response.cookies.get('magic-sso-verify-csrf')?.value).toBeTruthy();
    });

    it('reads the preview secret header when previewing the email address', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(Response.json({ email: 'user@example.com' }));

        await VerifyEmailRoute(createGetRequest('https://app.example.com/verify-email?token=abc'));

        const [requestUrl, init] = fetchMock.mock.calls[0] ?? [];
        expect(String(requestUrl)).toBe(`${serverUrl}/verify-email?token=abc`);
        expect(new Headers(init?.headers).get('x-magic-sso-preview-secret')).toBe('preview-secret');
    });

    it('uses the configured origin resolver for the login redirect', async () => {
        const response = await VerifyEmailRoute(
            createGetRequest('http://127.0.0.1:5001/verify-email'),
            { resolveAppOrigin: () => 'https://photos.example.com' },
        );

        expect(response.headers.get('location')).toContain('https://photos.example.com/login');
    });

    it('rejects a POST whose CSRF token does not match the cookie', async () => {
        const formData = new FormData();
        formData.set('csrfToken', 'submitted');
        formData.set('returnUrl', '/albums');
        const request = new NextRequest('https://app.example.com/verify-email', {
            method: 'POST',
            body: formData,
        });
        request.cookies.set('magic-sso-verify-csrf', 'cookie');
        request.cookies.set('magic-sso-verify-token', 'abc');

        const response = await VerifyEmailRoute(request);

        expect(response.headers.get('location')).toContain('error=verify-email-failed');
        expect(response.cookies.get('magic-sso-verify-token')?.value).toBe('');
    });
});
