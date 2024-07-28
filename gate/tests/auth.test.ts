// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { deriveVerifyCsrfSecret, readCookieValue, verifyAuthToken } from '../src/auth.js';

describe('verifyAuthToken', () => {
    it('rejects tokens signed with an algorithm other than HS256', async () => {
        const { privateKey } = await generateKeyPair('RS256');
        const token = await new SignJWT({
            email: 'user@example.com',
            jti: 'test-session-jti',
            scope: '*',
            siteId: 'site-a',
        })
            .setProtectedHeader({ alg: 'RS256' })
            .setAudience('http://app.example.com')
            .setIssuer('http://sso.example.com')
            .setExpirationTime('1h')
            .sign(privateKey);

        await expect(
            verifyAuthToken(token, new TextEncoder().encode('test-secret'), {
                expectedAudience: 'http://app.example.com',
                expectedIssuer: 'http://sso.example.com',
            }),
        ).resolves.toBeNull();
    });
});

describe('deriveVerifyCsrfSecret', () => {
    it('derives a stable secret that differs from the raw jwt secret', () => {
        const jwtSecret = 'test-jwt-secret-for-magic-gate-123456';
        const derivedA = deriveVerifyCsrfSecret(jwtSecret);
        const derivedB = deriveVerifyCsrfSecret(jwtSecret);

        expect(derivedA.equals(derivedB)).toBe(true);
        expect(derivedA.equals(Buffer.from(jwtSecret, 'utf8'))).toBe(false);
        expect(derivedA.equals(deriveVerifyCsrfSecret('another-test-jwt-secret-1234567890'))).toBe(
            false,
        );
    });
});

describe('readCookieValue', () => {
    it('prefers the last duplicate cookie value to match Fastify cookie parsing', () => {
        expect(readCookieValue('magic-sso=stale; theme=light; magic-sso=fresh', 'magic-sso')).toBe(
            'fresh',
        );
    });

    it('returns decoded cookie values', () => {
        expect(readCookieValue('magic-sso=hello%20world', 'magic-sso')).toBe('hello world');
    });
});
