// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyEmailRoute } from './route';

const serverUrl = 'https://sso.example.com';

const jwtSecret = 'jwt-secret-0123456789-0123456789';

function createConfirmedPost(): NextRequest {
    const formData = new FormData();
    formData.set('csrfToken', 'csrf-pair');
    formData.set('returnUrl', '/albums');
    const request = new NextRequest('https://app.example.com/verify-email', {
        method: 'POST',
        body: formData,
    });
    request.cookies.set('magic-sso-verify-csrf', 'csrf-pair');
    request.cookies.set('magic-sso-verify-token', 'abc');
    return request;
}

async function signAccessToken(secret: string): Promise<string> {
    return new SignJWT({ email: 'user@example.com', scope: '*', siteId: 'app' })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('https://app.example.com')
        .setIssuer(serverUrl)
        .setIssuedAt()
        .setExpirationTime('1h')
        .setJti('session-1')
        .sign(new TextEncoder().encode(secret));
}

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
    describe('confirmed POST', () => {
        beforeEach(() => {
            process.env.MAGICSSO_JWT_SECRET = jwtSecret;
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
        });

        afterEach(() => {
            delete process.env.MAGICSSO_JWT_SECRET;
        });

        it('exchanges the token and sets the session cookie', async () => {
            const accessToken = await signAccessToken(jwtSecret);
            const fetchMock = vi
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(Response.json({ accessToken }));

            const response = await VerifyEmailRoute(createConfirmedPost());

            expect(response.headers.get('location')).toBe('https://app.example.com/albums');
            expect(response.cookies.get('token')?.value).toBe(accessToken);
            expect(response.cookies.get('magic-sso-verify-token')?.value).toBe('');
            const [requestUrl, init] = fetchMock.mock.calls[0] ?? [];
            expect(String(requestUrl)).toBe(`${serverUrl}/verify-email`);
            expect(init?.body).toBe(JSON.stringify({ token: 'abc' }));
        });

        it.each([
            {
                expectedError: 'verify-email-misconfigured',
                name: 'the JWT secret is missing',
                prepare: (): void => {
                    delete process.env.MAGICSSO_JWT_SECRET;
                },
            },
            {
                expectedError: 'verify-email-misconfigured',
                name: 'the server URL is missing',
                prepare: (): void => {
                    delete process.env.MAGICSSO_SERVER_URL;
                },
            },
            {
                expectedError: 'verify-email-failed',
                name: 'the server rejects the token',
                prepare: (): void => {
                    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                        Response.json({ message: 'Token already used' }, { status: 400 }),
                    );
                },
            },
            {
                expectedError: 'verify-email-failed',
                name: 'the server response has no access token',
                prepare: (): void => {
                    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
                },
            },
            {
                expectedError: 'verify-email-failed',
                name: 'the server is unreachable',
                prepare: (): void => {
                    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
                },
            },
        ])('redirects to login when $name', async ({ expectedError, prepare }) => {
            prepare();

            const response = await VerifyEmailRoute(createConfirmedPost());

            expect(response.headers.get('location')).toContain(`error=${expectedError}`);
            expect(response.cookies.get('token')).toBeUndefined();
        });

        it('rejects access tokens signed with a different secret', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                Response.json({
                    accessToken: await signAccessToken('other-secret-0123456789-012345678'),
                }),
            );

            const response = await VerifyEmailRoute(createConfirmedPost());

            expect(response.headers.get('location')).toContain('error=session-verification-failed');
        });
    });
});
