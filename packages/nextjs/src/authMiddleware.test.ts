// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
    authMiddleware,
    buildLoginUrl,
    getExcludedPaths,
    isPublicPath,
    type AuthMiddlewareOptions,
} from './authMiddleware';

function restoreEnv(name: string, value: string | undefined): void {
    if (typeof value === 'string') {
        process.env[name] = value;
        return;
    }

    delete process.env[name];
}

async function signToken(email: string, secret: string, audience: string): Promise<string> {
    return new SignJWT({ email, scope: '*', siteId: 'site-a' })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(audience)
        .setExpirationTime('1h')
        .setIssuer('http://sso.example.com')
        .sign(new TextEncoder().encode(secret));
}

function createRequest(pathname: string, token?: string): NextRequest {
    const headers = new Headers();
    if (typeof token === 'string') {
        headers.set('cookie', `token=${token}`);
    }

    return new NextRequest(`http://app.example.com${pathname}`, {
        headers,
    });
}

describe('isPublicPath', () => {
    it('allows explicitly public routes', () => {
        expect(isPublicPath('/')).toBe(true);
        expect(isPublicPath('/login')).toBe(true);
        expect(isPublicPath('/verify-email')).toBe(true);
        expect(isPublicPath('/public/docs')).toBe(true);
        expect(isPublicPath('/_next/static/chunk.js')).toBe(true);
        expect(isPublicPath('/favicon.ico')).toBe(true);
    });

    it('does not bypass api routes', () => {
        expect(isPublicPath('/api')).toBe(false);
        expect(isPublicPath('/api/private')).toBe(false);
    });

    it('allows caller-configured excluded paths', () => {
        const options: AuthMiddlewareOptions = {
            excludedPaths: ['/healthz', '/docs'],
        };

        expect(getExcludedPaths(options)).toEqual(['/healthz', '/docs']);
        expect(isPublicPath('/healthz', options)).toBe(true);
        expect(isPublicPath('/docs/getting-started', options)).toBe(true);
        expect(isPublicPath('/protected', options)).toBe(false);
    });
});

describe('buildLoginUrl', () => {
    const originalDirectUse = process.env.MAGICSSO_DIRECT_USE;
    const originalPublicOrigin = process.env.MAGICSSO_PUBLIC_ORIGIN;
    const originalServerUrl = process.env.MAGICSSO_SERVER_URL;
    const originalTrustProxy = process.env.MAGICSSO_TRUST_PROXY;

    afterEach(() => {
        restoreEnv('MAGICSSO_DIRECT_USE', originalDirectUse);
        restoreEnv('MAGICSSO_PUBLIC_ORIGIN', originalPublicOrigin);
        restoreEnv('MAGICSSO_SERVER_URL', originalServerUrl);
        restoreEnv('MAGICSSO_TRUST_PROXY', originalTrustProxy);
    });

    it('builds an internal login URL by default', () => {
        process.env.MAGICSSO_DIRECT_USE = 'false';
        const request = createRequest('/protected');

        const loginUrl = buildLoginUrl(request, '/protected');

        expect(loginUrl.toString()).toBe(
            'http://app.example.com/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
    });

    it('includes scope in an internal login URL when provided', () => {
        process.env.MAGICSSO_DIRECT_USE = '0';
        const request = createRequest('/protected');

        const loginUrl = buildLoginUrl(request, '/protected', 'album-A');

        expect(loginUrl.toString()).toBe(
            'http://app.example.com/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected&scope=album-A',
        );
    });

    it('builds a direct SSO URL when configured', () => {
        process.env.MAGICSSO_DIRECT_USE = 'true';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        const request = createRequest('/protected');

        const loginUrl = buildLoginUrl(request, '/protected');

        expect(loginUrl.origin).toBe('http://sso.example.com');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://app.example.com/protected');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://app.example.com/verify-email?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
    });

    it('treats 1 as enabling direct SSO redirects', () => {
        process.env.MAGICSSO_DIRECT_USE = '1';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        const request = createRequest('/protected');

        const loginUrl = buildLoginUrl(request, '/protected');

        expect(loginUrl.origin).toBe('http://sso.example.com');
        expect(loginUrl.pathname).toBe('/signin');
    });

    it('includes scope in a direct SSO URL when provided', () => {
        process.env.MAGICSSO_DIRECT_USE = 'true';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        const request = createRequest('/protected');

        const loginUrl = buildLoginUrl(request, '/protected', 'album-A');

        expect(loginUrl.origin).toBe('http://sso.example.com');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://app.example.com/protected');
        expect(loginUrl.searchParams.get('scope')).toBe('album-A');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://app.example.com/verify-email?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
    });
});

describe('authMiddleware', () => {
    const originalCookieName = process.env.MAGICSSO_COOKIE_NAME;
    const originalCookiePath = process.env.MAGICSSO_COOKIE_PATH;
    const originalJwtSecret = process.env.MAGICSSO_JWT_SECRET;
    const originalDirectUse = process.env.MAGICSSO_DIRECT_USE;
    const originalPublicOrigin = process.env.MAGICSSO_PUBLIC_ORIGIN;
    const originalServerUrl = process.env.MAGICSSO_SERVER_URL;
    const originalTrustProxy = process.env.MAGICSSO_TRUST_PROXY;

    afterEach(() => {
        restoreEnv('MAGICSSO_COOKIE_NAME', originalCookieName);
        restoreEnv('MAGICSSO_COOKIE_PATH', originalCookiePath);
        restoreEnv('MAGICSSO_JWT_SECRET', originalJwtSecret);
        restoreEnv('MAGICSSO_DIRECT_USE', originalDirectUse);
        restoreEnv('MAGICSSO_PUBLIC_ORIGIN', originalPublicOrigin);
        restoreEnv('MAGICSSO_SERVER_URL', originalServerUrl);
        restoreEnv('MAGICSSO_TRUST_PROXY', originalTrustProxy);
    });

    it('redirects unauthenticated api requests instead of bypassing them', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_DIRECT_USE = 'false';
        const request = createRequest('/api/private');

        const response = await authMiddleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
            'http://app.example.com/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fapi%2Fprivate',
        );
    });

    it('allows requests with a valid jose-signed token', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'http://app.example.com';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        process.env.MAGICSSO_DIRECT_USE = '0';
        const token = await signToken('user@example.com', 'test-secret', 'http://app.example.com');
        const request = createRequest('/protected', token);

        const response = await authMiddleware(request);

        expect(response.status).toBe(200);
    });

    it('redirects with a misconfiguration error when no public origin is configured and trust proxy is disabled', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        process.env.MAGICSSO_DIRECT_USE = '0';
        const token = await signToken('user@example.com', 'test-secret', 'http://app.example.com');
        const request = createRequest('/protected', token);

        const response = await authMiddleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
            'http://app.example.com/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected&error=session-verification-misconfigured',
        );
    });

    it('allows trusted proxy deployments to derive the audience from forwarded headers', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        process.env.MAGICSSO_DIRECT_USE = '0';
        process.env.MAGICSSO_TRUST_PROXY = 'true';
        const token = await signToken('user@example.com', 'test-secret', 'https://app.example.com');
        const request = new NextRequest('http://internal.example.local/protected', {
            headers: {
                cookie: `token=${token}`,
                host: 'internal.example.local',
                'x-forwarded-host': 'app.example.com',
                'x-forwarded-proto': 'https',
            },
        });

        const response = await authMiddleware(request);

        expect(response.status).toBe(200);
    });

    it('allows requests to caller-configured excluded paths', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_DIRECT_USE = 'false';
        const request = createRequest('/healthz');

        const response = await authMiddleware(request, {
            excludedPaths: ['/healthz'],
        });

        expect(response.status).toBe(200);
    });

    it('redirects requests with an invalid token', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_COOKIE_PATH = '/auth';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_PUBLIC_ORIGIN = 'http://app.example.com';
        process.env.MAGICSSO_SERVER_URL = 'http://sso.example.com';
        process.env.MAGICSSO_DIRECT_USE = '0';
        const request = createRequest('/protected', 'bad-token');

        const response = await authMiddleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
            'http://app.example.com/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected&error=invalid-session',
        );
        expect(response.cookies.get('token')?.maxAge).toBe(0);
        expect(response.cookies.get('token')?.path).toBe('/auth');
    });

    it('redirects with an explicit misconfiguration error when the JWT secret is missing', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_DIRECT_USE = 'false';
        const request = createRequest('/protected', 'bad-token');

        const response = await authMiddleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
            'http://app.example.com/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected&error=session-verification-misconfigured',
        );
    });

    it('redirects with an explicit misconfiguration error when the server URL is missing', async () => {
        process.env.MAGICSSO_COOKIE_NAME = 'token';
        process.env.MAGICSSO_JWT_SECRET = 'test-secret';
        process.env.MAGICSSO_DIRECT_USE = 'false';
        const request = createRequest('/protected', 'bad-token');

        const response = await authMiddleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
            'http://app.example.com/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected&error=session-verification-misconfigured',
        );
    });
});
