// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    buildAuthCookieOptions,
    buildLoginPath,
    buildLoginTarget,
    buildVerifyUrl,
    getCookieMaxAge,
    getCookiePath,
    normaliseReturnUrl,
    readCookieValue,
    verifyAuthToken,
    verifyRequestAuth,
} from './core';

async function signToken(
    email: string,
    secret: string,
    audience: string,
    issuer: string,
): Promise<string> {
    return new SignJWT({ email, scope: '*', siteId: 'site-a' })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(audience)
        .setExpirationTime('1h')
        .setIssuer(issuer)
        .sign(new TextEncoder().encode(secret));
}

describe('@magic-link-sso/angular auth helpers', () => {
    beforeEach(() => {
        delete process.env.MAGICSSO_COOKIE_MAX_AGE;
        delete process.env.MAGICSSO_COOKIE_NAME;
        delete process.env.MAGICSSO_COOKIE_PATH;
        delete process.env.MAGICSSO_DIRECT_USE;
        delete process.env.MAGICSSO_JWT_SECRET;
        delete process.env.MAGICSSO_SERVER_URL;
    });

    it('verifies jose-signed tokens', async () => {
        const token = await signToken(
            'angular@example.com',
            'test-secret',
            'http://localhost:3004',
            'http://localhost:3000',
        );

        const payload = await verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
            expectedAudience: 'http://localhost:3004',
            expectedIssuer: 'http://localhost:3000',
        });

        expect(payload?.email).toBe('angular@example.com');
        expect(payload?.scope).toBe('*');
        expect(payload?.siteId).toBe('site-a');
    });

    it('reads and verifies the auth cookie from a request', async () => {
        const token = await signToken(
            'angular@example.com',
            'test-secret',
            'http://localhost:3004',
            'http://localhost:3000',
        );
        const request = new Request('http://localhost:3004/protected', {
            headers: {
                cookie: `magic-sso=${token}`,
            },
        });

        const payload = await verifyRequestAuth(request, {
            cookieName: 'magic-sso',
            jwtSecret: 'test-secret',
            serverUrl: 'http://localhost:3000',
        });

        expect(payload?.email).toBe('angular@example.com');
        expect(payload?.scope).toBe('*');
    });

    it('rejects tokens that are bound to a different site origin', async () => {
        const token = await signToken(
            'angular@example.com',
            'test-secret',
            'http://localhost:3004',
            'http://localhost:3000',
        );

        const payload = await verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
            expectedAudience: 'http://localhost:4000',
            expectedIssuer: 'http://localhost:3000',
        });

        expect(payload).toBeNull();
    });

    it('builds local login and verify targets', () => {
        expect(buildLoginPath('http://localhost:3004', '/protected')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected',
        );
        expect(buildVerifyUrl('http://localhost:3004', 'http://localhost:3004/protected')).toBe(
            'http://localhost:3004/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected',
        );
    });

    it('builds direct hosted-auth targets when configured', () => {
        const loginUrl = new URL(
            buildLoginTarget('http://localhost:3004', '/', {
                directUse: true,
                serverUrl: 'http://localhost:3000',
            }),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://localhost:3004/');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://localhost:3004/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3004%2F',
        );
    });

    it('treats MAGICSSO_DIRECT_USE=true as enabling direct use', () => {
        process.env.MAGICSSO_DIRECT_USE = 'true';
        process.env.MAGICSSO_SERVER_URL = 'http://localhost:3000';

        const loginUrl = new URL(buildLoginTarget('http://localhost:3004', '/protected'));

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
    });

    it('treats MAGICSSO_DIRECT_USE=1 as enabling direct use', () => {
        process.env.MAGICSSO_DIRECT_USE = '1';
        process.env.MAGICSSO_SERVER_URL = 'http://localhost:3000';

        const loginUrl = new URL(buildLoginTarget('http://localhost:3004', '/protected'));

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
    });

    it('treats MAGICSSO_DIRECT_USE=false as disabling direct use', () => {
        process.env.MAGICSSO_DIRECT_USE = 'false';
        process.env.MAGICSSO_SERVER_URL = 'http://localhost:3000';

        expect(buildLoginTarget('http://localhost:3004', '/protected')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected',
        );
    });

    it('treats MAGICSSO_DIRECT_USE=0 as disabling direct use', () => {
        process.env.MAGICSSO_DIRECT_USE = '0';
        process.env.MAGICSSO_SERVER_URL = 'http://localhost:3000';

        expect(buildLoginTarget('http://localhost:3004', '/protected')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected',
        );
    });

    it('adds scope to local and direct login targets when provided', () => {
        expect(buildLoginPath('http://localhost:3004', '/protected', undefined, 'album-A')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3004%2Fprotected&scope=album-A',
        );
        const loginUrl = new URL(
            buildLoginTarget(
                'http://localhost:3004',
                '/',
                {
                    directUse: true,
                    serverUrl: 'http://localhost:3000',
                },
                'album-A',
            ),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://localhost:3004/');
        expect(loginUrl.searchParams.get('scope')).toBe('album-A');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://localhost:3004/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3004%2F',
        );
    });

    it('normalises same-origin return urls and rejects cross-origin values', () => {
        expect(
            normaliseReturnUrl('/protected', 'http://localhost:3004', 'http://localhost:3004'),
        ).toBe('http://localhost:3004/protected');
        expect(
            normaliseReturnUrl(
                'http://localhost:3001/protected',
                'http://localhost:3004',
                'http://localhost:3004',
            ),
        ).toBe('http://localhost:3004');
    });

    it('builds persistent cookie options and reads cookie headers', () => {
        process.env.MAGICSSO_COOKIE_MAX_AGE = '3600';
        process.env.MAGICSSO_COOKIE_NAME = 'magic-sso';
        process.env.MAGICSSO_COOKIE_PATH = '/auth';

        expect(getCookieMaxAge()).toBe(3600);
        expect(getCookiePath()).toBe('/auth');
        expect(readCookieValue('magic-sso=token; other=value', 'magic-sso')).toBe('token');
        expect(buildAuthCookieOptions('access-token')).toEqual({
            httpOnly: true,
            maxAgeSeconds: 3600,
            name: 'magic-sso',
            path: '/auth',
            sameSite: 'lax',
            secure: false,
            value: 'access-token',
        });
    });

    it('fails fast for invalid cookie path values', () => {
        process.env.MAGICSSO_COOKIE_PATH = 'auth';

        expect(() => getCookiePath()).toThrowError('MAGICSSO_COOKIE_PATH must start with "/".');
    });
});
