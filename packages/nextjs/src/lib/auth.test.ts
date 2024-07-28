// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redirectMock = vi.fn();

interface MockRequestCookie {
    name: string;
    value: string;
}

interface MockCookieStore {
    get(name: string): MockRequestCookie | undefined;
}

interface MockHeaderStore {
    get(name: string): string | null;
}

const cookiesMock = vi.fn<() => Promise<MockCookieStore>>();
const headersMock = vi.fn<() => Promise<MockHeaderStore>>();

vi.mock('next/headers', () => ({
    cookies: cookiesMock,
    headers: headersMock,
}));

vi.mock('next/navigation', () => ({
    redirect: redirectMock,
}));

async function importAuthModule() {
    return import('./auth');
}

async function signToken(
    email: string,
    secret: string,
    options: {
        audience: string;
        issuer: string;
        siteId?: string;
    },
): Promise<string> {
    return new SignJWT({ email, scope: '*', siteId: options.siteId ?? 'site-a' })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(options.audience)
        .setExpirationTime('1h')
        .setIssuer(options.issuer)
        .sign(new TextEncoder().encode(secret));
}

describe('lib/auth', () => {
    beforeEach(() => {
        cookiesMock.mockReset();
        headersMock.mockReset();
        redirectMock.mockReset();
        delete process.env.MAGICSSO_COOKIE_NAME;
        delete process.env.MAGICSSO_COOKIE_PATH;
        delete process.env.MAGICSSO_COOKIE_MAX_AGE;
        delete process.env.MAGICSSO_JWT_SECRET;
        delete process.env.MAGICSSO_PUBLIC_ORIGIN;
        delete process.env.MAGICSSO_SERVER_URL;
        delete process.env.MAGICSSO_TRUST_PROXY;
    });

    it('verifies tokens with jose and returns the auth payload', async () => {
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'http://app.example.com';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        const token = await signToken('user@example.com', 'test-secret', {
            audience: 'http://app.example.com',
            issuer: 'http://sso.example.com',
        });
        cookiesMock.mockResolvedValue({
            get(name: string) {
                return name === 'token' ? { name, value: token } : undefined;
            },
        });
        headersMock.mockResolvedValue({
            get(name: string) {
                switch (name) {
                    case 'host':
                        return 'app.example.com';
                    case 'x-forwarded-proto':
                        return 'http';
                    default:
                        return null;
                }
            },
        });

        const { verifyToken } = await importAuthModule();
        const payload = await verifyToken();

        expect(payload?.email).toBe('user@example.com');
        expect(payload?.scope).toBe('*');
        expect(payload?.siteId).toBe('site-a');
    });

    it('returns null when the secret is missing', async () => {
        cookiesMock.mockResolvedValue({
            get() {
                return { name: 'token', value: 'token' };
            },
        });
        headersMock.mockResolvedValue({
            get() {
                return null;
            },
        });

        const { verifyToken } = await importAuthModule();
        const payload = await verifyToken();

        expect(payload).toBeNull();
    });

    it('uses the configured cookie name', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'magic-sso';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'http://app.example.com';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        const token = await signToken('user@example.com', 'test-secret', {
            audience: 'http://app.example.com',
            issuer: 'http://sso.example.com',
        });
        cookiesMock.mockResolvedValue({
            get(name: string) {
                return name === 'magic-sso' ? { name, value: token } : undefined;
            },
        });
        headersMock.mockResolvedValue({
            get(name: string) {
                switch (name) {
                    case 'host':
                        return 'app.example.com';
                    case 'x-forwarded-proto':
                        return 'http';
                    default:
                        return null;
                }
            },
        });

        const { verifyToken } = await importAuthModule();
        const payload = await verifyToken();

        expect(payload?.email).toBe('user@example.com');
        expect(payload?.scope).toBe('*');
    });

    it('rejects verification when no public origin is configured and trust proxy is disabled', async () => {
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        const token = await signToken('user@example.com', 'test-secret', {
            audience: 'http://app.example.com',
            issuer: 'http://sso.example.com',
        });
        cookiesMock.mockResolvedValue({
            get(name: string) {
                return name === 'token' ? { name, value: token } : undefined;
            },
        });
        headersMock.mockResolvedValue({
            get(name: string) {
                switch (name) {
                    case 'host':
                        return 'app.example.com';
                    case 'x-forwarded-proto':
                        return 'http';
                    default:
                        return null;
                }
            },
        });

        const { verifyToken } = await importAuthModule();
        const payload = await verifyToken();

        expect(payload).toBeNull();
    });

    it('uses forwarded headers only when trust proxy is explicitly enabled', async () => {
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        process.env.MAGICSSO_TRUST_PROXY = 'true';
        const token = await signToken('user@example.com', 'test-secret', {
            audience: 'https://app.example.com',
            issuer: 'http://sso.example.com',
        });
        cookiesMock.mockResolvedValue({
            get(name: string) {
                return name === 'token' ? { name, value: token } : undefined;
            },
        });
        headersMock.mockResolvedValue({
            get(name: string) {
                switch (name) {
                    case 'host':
                        return 'internal.example.local';
                    case 'x-forwarded-host':
                        return 'app.example.com';
                    case 'x-forwarded-proto':
                        return 'https';
                    default:
                        return null;
                }
            },
        });

        const { verifyToken } = await importAuthModule();
        const payload = await verifyToken();

        expect(payload?.email).toBe('user@example.com');
    });

    it('verifies a token directly only when the expected site binding matches', async () => {
        const token = await signToken('user@example.com', 'test-secret', {
            audience: 'http://app.example.com',
            issuer: 'http://sso.example.com',
        });

        const { verifyAuthToken } = await importAuthModule();
        const payload = await verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
            expectedAudience: 'http://app.example.com',
            expectedIssuer: 'http://sso.example.com',
        });

        expect(payload?.email).toBe('user@example.com');
        expect(payload?.siteId).toBe('site-a');
    });

    it('rejects a token when the expected audience does not match', async () => {
        const token = await signToken('user@example.com', 'test-secret', {
            audience: 'http://app.example.com',
            issuer: 'http://sso.example.com',
        });

        const { verifyAuthToken } = await importAuthModule();
        const payload = await verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
            expectedAudience: 'http://admin.example.com',
            expectedIssuer: 'http://sso.example.com',
        });

        expect(payload).toBeNull();
    });

    it('rejects a token signed with an algorithm other than HS256', async () => {
        const { privateKey } = await generateKeyPair('RS256');
        const token = await new SignJWT({ email: 'user@example.com', scope: '*', siteId: 'site-a' })
            .setProtectedHeader({ alg: 'RS256' })
            .setAudience('http://app.example.com')
            .setExpirationTime('1h')
            .setIssuer('http://sso.example.com')
            .sign(privateKey);

        const { verifyAuthToken } = await importAuthModule();
        const payload = await verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
            expectedAudience: 'http://app.example.com',
            expectedIssuer: 'http://sso.example.com',
        });

        expect(payload).toBeNull();
    });

    it('delegates login redirects to next navigation', async () => {
        const { redirectToLogin } = await importAuthModule();

        expect(() => redirectToLogin('http://app.example.com/protected')).not.toThrow();
        expect(redirectMock).toHaveBeenCalledWith(
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
    });

    it('includes scope when redirecting to login', async () => {
        const { redirectToLogin } = await importAuthModule();

        expect(() => redirectToLogin('http://app.example.com/protected', 'album-A')).not.toThrow();
        expect(redirectMock).toHaveBeenCalledWith(
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected&scope=album-A',
        );
    });

    it('builds persistent auth cookie options when max age is configured', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'magic-sso';
        process.env.MAGICSSO_COOKIE_MAX_AGE = '3600';

        const { buildAuthCookieOptions } = await importAuthModule();
        const options = buildAuthCookieOptions('access-token');

        expect(options).toEqual({
            name: 'magic-sso',
            value: 'access-token',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 3600,
        });
    });

    it('omits max age when no persistent cookie lifetime is configured', async () => {
        const { buildAuthCookieOptions } = await importAuthModule();
        const options = buildAuthCookieOptions('access-token');

        expect(options.maxAge).toBeUndefined();
    });

    it('uses the configured cookie path', async () => {
        process.env.MAGICSSO_COOKIE_PATH = '/auth';

        const { buildAuthCookieOptions } = await importAuthModule();
        const options = buildAuthCookieOptions('access-token');

        expect(options.path).toBe('/auth');
    });

    it('fails fast for an invalid cookie max age', async () => {
        process.env.MAGICSSO_COOKIE_MAX_AGE = '0';

        const { getCookieMaxAge } = await importAuthModule();

        expect(() => getCookieMaxAge()).toThrowError(
            'MAGICSSO_COOKIE_MAX_AGE must be a positive integer.',
        );
    });

    it('fails fast for an invalid cookie path', async () => {
        process.env.MAGICSSO_COOKIE_PATH = 'auth';

        const { getCookiePath } = await importAuthModule();

        expect(() => getCookiePath()).toThrowError('MAGICSSO_COOKIE_PATH must start with "/".');
    });
});
