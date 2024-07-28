// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const originalEnv = { ...process.env };
const testJwtSecret = 'test-jwt-secret-for-example-fastify-123456';
const testPreviewSecret = 'test-preview-secret-for-example-fastify-123456';

beforeEach(() => {
    process.env = {
        ...originalEnv,
        MAGICSSO_COOKIE_MAX_AGE: '3600',
        MAGICSSO_COOKIE_NAME: 'magic-sso',
        MAGICSSO_COOKIE_PATH: '/',
        MAGICSSO_DIRECT_USE: 'false',
        MAGICSSO_JWT_SECRET: testJwtSecret,
        MAGICSSO_PREVIEW_SECRET: testPreviewSecret,
        MAGICSSO_SERVER_URL: 'http://localhost:3000',
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
});

describe('fastify example routes', () => {
    it('renders the login page with the shared layout', async () => {
        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'GET',
                url: '/login?returnUrl=http://localhost:3005/protected',
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Sign In | Magic Link SSO Fastify');
            expect(response.body).toContain('login-panel');
            expect(response.body).toContain('/shared/styles.css');
            expect(response.body).toContain('/shared/assets/signin-page-badge.svg');
            expect(response.body).toContain('Send magic link');
        } finally {
            await app.close();
        }
    });

    it('redirects anonymous protected requests to the local login page', async () => {
        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'GET',
                url: '/protected',
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe(
                '/login?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected',
            );
        } finally {
            await app.close();
        }
    });

    it('redirects invalid signin payloads back to the login page with an error', async () => {
        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'POST',
                url: '/api/signin',
                payload: {
                    returnUrl: 'http://localhost:3005/protected',
                },
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toContain('/login?returnUrl=');
            expect(response.headers.location).toContain('Invalid+sign-in+request+payload.');
        } finally {
            await app.close();
        }
    });

    it('does not report success when the upstream sign-in endpoint returns an invalid 200 payload', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('<html>not the SSO server</html>', {
                headers: {
                    'content-type': 'text/html; charset=utf-8',
                },
                status: 200,
            }),
        );

        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'POST',
                url: '/api/signin',
                payload: {
                    email: 'fastify@example.com',
                    returnUrl: 'http://localhost:3005/protected',
                    verifyUrl:
                        'http://localhost:3005/verify-email?returnUrl=http://localhost:3005/protected',
                },
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toContain('/login?returnUrl=');
            expect(response.headers.location).toContain(
                'No+Magic+Link+SSO+JSON+endpoint+responded+at+http%3A%2F%2Flocalhost%3A3000%2Fsignin.',
            );
            expect(response.headers.location).not.toContain('Verification+email+sent.');
        } finally {
            await app.close();
        }
    });

    it('renders a confirmation page before exchanging the verify-email token', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ email: 'fastify@example.com' }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 200,
            }),
        );

        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'GET',
                url: '/verify-email?token=test-token&returnUrl=http://localhost:3005/protected',
            });

            expect(response.statusCode).toBe(200);
            expect(response.body).toContain('Continue sign-in');
            expect(response.body).toContain('fastify@example.com');
            expect(response.body).toContain('id="email-value"');
            expect(response.body).toContain('name="csrfToken"');
            expect(response.body).not.toContain('name="token"');
            expect(response.body).toContain(
                '<button class="button button-primary button-submit button-block" type="submit">Continue</button>',
            );
            expect(response.cookies).toHaveLength(2);
            const tokenCookie = response.cookies.find(
                (cookie) => cookie.name === 'magic-sso-verify-token',
            );
            expect(response.cookies[0]?.name).toBe('magic-sso-verify-csrf');
            expect(tokenCookie?.value).toBe('test-token');
            expect(tokenCookie?.httpOnly).toBe(true);
            expect(tokenCookie?.path).toBe('/verify-email');
            expect(fetchMock).toHaveBeenNthCalledWith(
                1,
                new URL('http://localhost:3000/verify-email?token=test-token'),
                {
                    headers: {
                        accept: 'application/json',
                        'x-magic-sso-preview-secret': testPreviewSecret,
                    },
                    cache: 'no-store',
                },
            );
        } finally {
            await app.close();
        }
    });

    it('stores the auth cookie after a successful verify-email confirmation POST', async () => {
        const secret = new TextEncoder().encode(testJwtSecret);
        const accessToken = await new SignJWT({
            email: 'fastify@example.com',
            scope: '*',
            siteId: 'site-a',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setAudience('http://localhost:3005')
            .setIssuer('http://localhost:3000')
            .sign(secret);

        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ email: 'fastify@example.com' }), {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ accessToken }), {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                }),
            );

        const app = await createApp({ logger: false });

        try {
            const pageResponse = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'GET',
                url: '/verify-email?token=test-token&returnUrl=http://localhost:3005/protected',
            });
            const csrfCookie = pageResponse.cookies.find(
                (cookie) => cookie.name === 'magic-sso-verify-csrf',
            );
            const tokenCookie = pageResponse.cookies.find(
                (cookie) => cookie.name === 'magic-sso-verify-token',
            );
            const csrfTokenMatch = pageResponse.body.match(/name="csrfToken" value="([^"]+)"/u);

            if (!csrfCookie?.value || !csrfTokenMatch?.[1]) {
                throw new Error('Expected verify-email confirmation page to include a CSRF token.');
            }
            if (!tokenCookie?.value) {
                throw new Error(
                    'Expected verify-email confirmation page to store the token cookie.',
                );
            }

            const response = await app.inject({
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    cookie: `magic-sso-verify-csrf=${csrfCookie.value}; magic-sso-verify-token=${tokenCookie.value}`,
                    host: 'localhost:3005',
                },
                method: 'POST',
                payload: `csrfToken=${encodeURIComponent(csrfTokenMatch[1])}&returnUrl=${encodeURIComponent('http://localhost:3005/protected')}`,
                url: '/verify-email',
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe('http://localhost:3005/protected');
            const authCookie = response.cookies.find((cookie) => cookie.name === 'magic-sso');
            expect(authCookie?.httpOnly).toBe(true);
            expect(fetchMock).toHaveBeenNthCalledWith(
                1,
                new URL('http://localhost:3000/verify-email?token=test-token'),
                {
                    headers: {
                        accept: 'application/json',
                        'x-magic-sso-preview-secret': testPreviewSecret,
                    },
                    cache: 'no-store',
                },
            );
            expect(fetchMock).toHaveBeenNthCalledWith(
                2,
                new URL('http://localhost:3000/verify-email'),
                {
                    method: 'POST',
                    headers: {
                        accept: 'application/json',
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({ token: 'test-token' }),
                    cache: 'no-store',
                },
            );
        } finally {
            await app.close();
        }
    });

    it('rejects returned verify-email tokens that are bound to a different site origin', async () => {
        const secret = new TextEncoder().encode(testJwtSecret);
        const accessToken = await new SignJWT({
            email: 'fastify@example.com',
            scope: '*',
            siteId: 'site-a',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setAudience('http://admin.example.com')
            .setIssuer('http://localhost:3000')
            .sign(secret);

        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ email: 'fastify@example.com' }), {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ accessToken }), {
                    headers: {
                        'content-type': 'application/json',
                    },
                    status: 200,
                }),
            );

        const app = await createApp({ logger: false });

        try {
            const pageResponse = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'GET',
                url: '/verify-email?token=test-token&returnUrl=http://localhost:3005/protected',
            });
            const csrfCookie = pageResponse.cookies.find(
                (cookie) => cookie.name === 'magic-sso-verify-csrf',
            );
            const tokenCookie = pageResponse.cookies.find(
                (cookie) => cookie.name === 'magic-sso-verify-token',
            );
            const csrfTokenMatch = pageResponse.body.match(/name="csrfToken" value="([^"]+)"/u);

            if (!csrfCookie?.value || !csrfTokenMatch?.[1]) {
                throw new Error('Expected verify-email confirmation page to include a CSRF token.');
            }
            if (!tokenCookie?.value) {
                throw new Error(
                    'Expected verify-email confirmation page to store the token cookie.',
                );
            }

            const response = await app.inject({
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    cookie: `magic-sso-verify-csrf=${csrfCookie.value}; magic-sso-verify-token=${tokenCookie.value}`,
                    host: 'localhost:3005',
                },
                method: 'POST',
                payload: `csrfToken=${encodeURIComponent(csrfTokenMatch[1])}&returnUrl=${encodeURIComponent('http://localhost:3005/protected')}`,
                url: '/verify-email',
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe(
                '/login?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected&error=session-verification-failed',
            );
            expect(fetchMock).toHaveBeenNthCalledWith(
                1,
                new URL('http://localhost:3000/verify-email?token=test-token'),
                {
                    headers: {
                        accept: 'application/json',
                        'x-magic-sso-preview-secret': testPreviewSecret,
                    },
                    cache: 'no-store',
                },
            );
        } finally {
            await app.close();
        }
    });

    it('redirects back to login when verify-email receives an invalid token response', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ message: 'Invalid token' }), {
                headers: {
                    'content-type': 'application/json',
                },
                status: 400,
            }),
        );

        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                },
                method: 'GET',
                url: '/verify-email?token=test-token&returnUrl=http://localhost:3005/protected',
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe(
                '/login?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected&error=verify-email-failed',
            );
            expect(fetchMock).toHaveBeenNthCalledWith(
                1,
                new URL('http://localhost:3000/verify-email?token=test-token'),
                {
                    headers: {
                        accept: 'application/json',
                        'x-magic-sso-preview-secret': testPreviewSecret,
                    },
                    cache: 'no-store',
                },
            );
        } finally {
            await app.close();
        }
    });

    it('clears the auth cookie on same-origin POST /logout', async () => {
        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                    origin: 'http://localhost:3005',
                },
                method: 'POST',
                url: '/logout',
            });

            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe('/');
            const authCookie = response.cookies.find((cookie) => cookie.name === 'magic-sso');
            expect(authCookie?.value).toBe('');
        } finally {
            await app.close();
        }
    });

    it('rejects cross-origin POST /logout requests', async () => {
        const app = await createApp({ logger: false });

        try {
            const response = await app.inject({
                headers: {
                    host: 'localhost:3005',
                    origin: 'https://evil.example.com',
                },
                method: 'POST',
                url: '/logout',
            });

            expect(response.statusCode).toBe(403);
            expect(response.body).toBe('Forbidden');
        } finally {
            await app.close();
        }
    });
});
