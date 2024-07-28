/**
 * server/src/auth.test.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { SignJWT, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import {
    type AccessTokenPayload,
    generateEmailToken,
    signAccessToken,
    verifyAccessToken,
    verifyEmailToken,
} from './auth.js';

function readAudience(payload: AccessTokenPayload | null): readonly string[] {
    if (payload === null) {
        return [];
    }

    if (Array.isArray(payload.aud)) {
        return payload.aud;
    }

    return typeof payload.aud === 'string' ? [payload.aud] : [];
}

function encodeSecret(secret: string): Uint8Array {
    return new TextEncoder().encode(secret);
}

async function signInvalidToken(
    payload: Record<string, unknown>,
    secret: string,
    algorithm: 'HS256' | 'HS384',
    expiresInSeconds: number,
    issuer?: string,
    audience?: string,
): Promise<string> {
    let token = new SignJWT(payload)
        .setProtectedHeader({ alg: algorithm })
        .setIssuedAt()
        .setExpirationTime(expiresInSeconds);

    if (typeof issuer === 'string') {
        token = token.setIssuer(issuer);
    }

    if (typeof audience === 'string') {
        token = token.setAudience(audience);
    }

    return token.sign(encodeSecret(secret));
}

describe('generateEmailToken', () => {
    it('includes a unique token identifier in the verification payload', async () => {
        const token = await generateEmailToken(
            'user@example.com',
            'http://client.example.com/protected',
            'site-a',
            'album-A',
            'http://sso.example.com',
            'email-secret',
            300,
        );

        const payload = await verifyEmailToken(token, 'email-secret');
        expect(payload?.email).toBe('user@example.com');
        expect(payload?.returnUrl).toBe('http://client.example.com/protected');
        expect(payload?.scope).toBe('album-A');
        expect(payload?.siteId).toBe('site-a');
        expect(payload?.aud).toBe('site-a');
        expect(payload?.iss).toBe('http://sso.example.com');
        expect(typeof payload?.jti).toBe('string');
        expect(payload?.jti.length).toBeGreaterThan(0);
    });

    it('generates distinct tokens for repeated requests with the same input', async () => {
        const firstToken = await generateEmailToken(
            'user@example.com',
            'http://client.example.com/protected',
            'site-a',
            'album-A',
            'http://sso.example.com',
            'email-secret',
            300,
        );
        const secondToken = await generateEmailToken(
            'user@example.com',
            'http://client.example.com/protected',
            'site-a',
            'album-A',
            'http://sso.example.com',
            'email-secret',
            300,
        );

        expect(firstToken).not.toBe(secondToken);
    });

    it('signs verification tokens with an explicit HS256 header', async () => {
        const token = await generateEmailToken(
            'user@example.com',
            'http://client.example.com/protected',
            'site-a',
            'album-A',
            'http://sso.example.com',
            'email-secret',
            300,
        );

        const decodedToken = decodeProtectedHeader(token);
        expect(decodedToken.alg).toBe('HS256');
    });

    it('rejects verification tokens signed with a different algorithm', async () => {
        const token = await signInvalidToken(
            {
                email: 'user@example.com',
                jti: 'verification-jti',
                returnUrl: 'http://client.example.com/protected',
                scope: 'album-A',
                siteId: 'site-a',
            },
            'email-secret',
            'HS384',
            300,
        );

        await expect(verifyEmailToken(token, 'email-secret')).resolves.toBeNull();
    });

    it('reports verification token failures without exposing the token value', async () => {
        let failureName: string | undefined;

        const payload = await verifyEmailToken('invalid-token', 'email-secret', {
            onError: (failure) => {
                failureName = failure.errorName;
            },
        });

        expect(payload).toBeNull();
        expect(failureName).toBe('JsonWebTokenError');
    });

    it('silently returns null when options is provided without an onError callback', async () => {
        const payload = await verifyEmailToken('invalid-token', 'email-secret', {});
        expect(payload).toBeNull();
    });
});

describe('signAccessToken', () => {
    it('includes site binding claims in access tokens', async () => {
        const token = await signAccessToken(
            'user@example.com',
            'album-A',
            'site-a',
            ['http://client.example.com'],
            'http://sso.example.com',
            'jwt-secret',
            300,
        );

        const payload = await verifyAccessToken(token, 'jwt-secret', {
            expectedAudience: 'http://client.example.com',
            expectedIssuer: 'http://sso.example.com',
        });

        expect(payload?.email).toBe('user@example.com');
        expect(typeof payload?.jti).toBe('string');
        expect(payload?.jti.length).toBeGreaterThan(0);
        expect(payload?.scope).toBe('album-A');
        expect(payload?.siteId).toBe('site-a');
        expect(readAudience(payload)).toEqual(['http://client.example.com']);
        expect(payload?.iss).toBe('http://sso.example.com');
    });

    it('signs access tokens with an explicit HS256 header', async () => {
        const token = await signAccessToken(
            'user@example.com',
            'album-A',
            'site-a',
            ['http://client.example.com'],
            'http://sso.example.com',
            'jwt-secret',
            300,
        );

        const decodedToken = decodeProtectedHeader(token);
        expect(decodedToken.alg).toBe('HS256');
    });

    it('rejects access tokens signed with a different algorithm', async () => {
        const token = await signInvalidToken(
            {
                email: 'user@example.com',
                jti: 'access-jti',
                scope: 'album-A',
                siteId: 'site-a',
            },
            'jwt-secret',
            'HS384',
            300,
            'http://sso.example.com',
            'http://client.example.com',
        );

        await expect(
            verifyAccessToken(token, 'jwt-secret', {
                expectedAudience: 'http://client.example.com',
                expectedIssuer: 'http://sso.example.com',
            }),
        ).resolves.toBeNull();
    });

    it('rejects access tokens without the required site-binding claims', async () => {
        const token = await signInvalidToken(
            {
                email: 'user@example.com',
                jti: 'access-jti',
                scope: 'album-A',
            },
            'jwt-secret',
            'HS256',
            300,
        );

        await expect(verifyAccessToken(token, 'jwt-secret')).resolves.toBeNull();
    });

    it('rejects access tokens when the audience does not match the current site', async () => {
        const token = await signAccessToken(
            'user@example.com',
            'album-A',
            'site-a',
            ['http://client.example.com'],
            'http://sso.example.com',
            'jwt-secret',
            300,
        );

        await expect(
            verifyAccessToken(token, 'jwt-secret', {
                expectedAudience: 'http://admin.example.com',
                expectedIssuer: 'http://sso.example.com',
            }),
        ).resolves.toBeNull();
    });

    it('reports access token verification failures', async () => {
        let failureName: string | undefined;

        const payload = await verifyAccessToken('invalid-token', 'jwt-secret', {
            expectedAudience: 'http://client.example.com',
            expectedIssuer: 'http://sso.example.com',
            onError: (failure) => {
                failureName = failure.errorName;
            },
        });

        expect(payload).toBeNull();
        expect(failureName).toBe('JsonWebTokenError');
    });

    it('silently returns null when options is provided without an onError callback', async () => {
        const payload = await verifyAccessToken('invalid-token', 'jwt-secret', {});
        expect(payload).toBeNull();
    });
});
