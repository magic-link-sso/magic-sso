// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildAuthCookieOptions,
    buildLoginTarget,
    buildVerifyUrl,
    getJwtSecret,
    normaliseReturnUrl,
    verifyAuthToken,
} from '../src/auth.js';

const originalEnv = { ...process.env };

afterEach(() => {
    process.env = { ...originalEnv };
});

describe('fastify auth helpers', () => {
    it('normalises relative and same-origin return URLs', () => {
        expect(normaliseReturnUrl(undefined, 'http://localhost:3005')).toBe(
            'http://localhost:3005',
        );
        expect(normaliseReturnUrl('/protected', 'http://localhost:3005')).toBe(
            'http://localhost:3005/protected',
        );
        expect(normaliseReturnUrl('http://localhost:3005/protected', 'http://localhost:3005')).toBe(
            'http://localhost:3005/protected',
        );
        expect(normaliseReturnUrl('http://evil.example.com', 'http://localhost:3005')).toBe(
            'http://localhost:3005',
        );
    });

    it('builds a local verify URL', () => {
        expect(buildVerifyUrl('http://localhost:3005', 'http://localhost:3005/protected')).toBe(
            'http://localhost:3005/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected',
        );
    });

    it('builds a local login target by default', () => {
        process.env['MAGICSSO_DIRECT_USE'] = 'false';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';

        expect(buildLoginTarget('http://localhost:3005', 'http://localhost:3005/protected')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected',
        );
    });

    it('builds a direct hosted login target when direct use is enabled', () => {
        process.env['MAGICSSO_DIRECT_USE'] = 'true';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';

        const loginUrl = new URL(
            buildLoginTarget('http://localhost:3005', 'http://localhost:3005/protected'),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://localhost:3005/protected');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://localhost:3005/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected',
        );
    });

    it('treats 1 as enabling direct use', () => {
        process.env['MAGICSSO_DIRECT_USE'] = '1';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';

        const loginUrl = new URL(
            buildLoginTarget('http://localhost:3005', 'http://localhost:3005/protected'),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
    });

    it('treats 0 as disabling direct use', () => {
        process.env['MAGICSSO_DIRECT_USE'] = '0';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';

        expect(buildLoginTarget('http://localhost:3005', 'http://localhost:3005/protected')).toBe(
            '/login?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected',
        );
    });

    it('adds scope to local and direct login targets when provided', () => {
        process.env['MAGICSSO_DIRECT_USE'] = 'false';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';
        expect(
            buildLoginTarget('http://localhost:3005', 'http://localhost:3005/protected', 'album-A'),
        ).toBe('/login?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected&scope=album-A');

        process.env['MAGICSSO_DIRECT_USE'] = 'true';
        const loginUrl = new URL(
            buildLoginTarget('http://localhost:3005', 'http://localhost:3005/protected', 'album-A'),
        );

        expect(loginUrl.origin).toBe('http://localhost:3000');
        expect(loginUrl.pathname).toBe('/signin');
        expect(loginUrl.searchParams.get('returnUrl')).toBe('http://localhost:3005/protected');
        expect(loginUrl.searchParams.get('scope')).toBe('album-A');
        expect(loginUrl.searchParams.get('verifyUrl')).toBe(
            'http://localhost:3005/verify-email?returnUrl=http%3A%2F%2Flocalhost%3A3005%2Fprotected',
        );
    });

    it('verifies returned auth tokens', async () => {
        process.env['MAGICSSO_JWT_SECRET'] = 'test-jwt-secret-for-example-fastify-123456';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';
        const secret = getJwtSecret();

        if (secret === null) {
            throw new Error('Expected MAGICSSO_JWT_SECRET to be available.');
        }

        const token = await new SignJWT({
            email: 'fastify@example.com',
            scope: '*',
            siteId: 'site-a',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setAudience('http://localhost:3005')
            .setIssuer('http://localhost:3000')
            .sign(secret);

        await expect(
            verifyAuthToken(token, secret, {
                expectedAudience: 'http://localhost:3005',
                expectedIssuer: 'http://localhost:3000',
            }),
        ).resolves.toMatchObject({
            email: 'fastify@example.com',
            scope: '*',
            siteId: 'site-a',
        });
    });

    it('rejects returned auth tokens when the audience does not match', async () => {
        process.env['MAGICSSO_JWT_SECRET'] = 'test-jwt-secret-for-example-fastify-123456';
        process.env['MAGICSSO_SERVER_URL'] = 'http://localhost:3000';
        const secret = getJwtSecret();

        if (secret === null) {
            throw new Error('Expected MAGICSSO_JWT_SECRET to be available.');
        }

        const token = await new SignJWT({
            email: 'fastify@example.com',
            scope: '*',
            siteId: 'site-a',
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setAudience('http://localhost:3005')
            .setIssuer('http://localhost:3000')
            .sign(secret);

        await expect(
            verifyAuthToken(token, secret, {
                expectedAudience: 'http://admin.example.com',
                expectedIssuer: 'http://localhost:3000',
            }),
        ).resolves.toBeNull();
    });

    it('builds auth cookie options from the configured env vars', () => {
        process.env['MAGICSSO_COOKIE_MAX_AGE'] = '3600';
        process.env['MAGICSSO_COOKIE_PATH'] = '/';
        process.env['NODE_ENV'] = 'test';

        expect(buildAuthCookieOptions()).toEqual({
            httpOnly: true,
            maxAge: 3600,
            path: '/',
            sameSite: 'lax',
            secure: false,
        });
    });
});
