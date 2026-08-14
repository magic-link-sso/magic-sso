// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
    buildAuthCookieOptions,
    buildLoginTarget,
    exchangeEmailOtp,
    normaliseReturnUrl,
    readCookieValue,
    toSecretKey,
    verifyAuthToken,
} from '../src/index.js';
import { authFixture, unsafeReturnUrlFixtures } from './fixtures.js';

const secret = toSecretKey(authFixture.secret);
const { audience, issuer } = authFixture;

async function signToken(options: {
    alg?: 'HS256' | 'HS384';
    audience?: string;
    claims?: Record<string, unknown>;
    exp?: string;
    issuer?: string;
    nbf?: string;
}): Promise<string> {
    return new SignJWT({
        email: authFixture.email,
        jti: authFixture.jti,
        scope: authFixture.scope,
        siteId: authFixture.siteId,
        ...options.claims,
    })
        .setProtectedHeader({ alg: options.alg ?? 'HS256' })
        .setAudience(options.audience ?? audience)
        .setIssuedAt()
        .setExpirationTime(options.exp ?? '1h')
        .setIssuer(options.issuer ?? issuer)
        .setNotBefore(options.nbf ?? '0s')
        .sign(secret);
}

describe('@magic-link-sso/core', () => {
    it('verifies only complete HS256 tokens for the configured issuer and audience', async () => {
        const token = await signToken({});
        await expect(
            verifyAuthToken(token, secret, { expectedAudience: audience, expectedIssuer: issuer }),
        ).resolves.toMatchObject({
            email: 'person@example.test',
            jti: 'token-id',
        });
        await expect(
            verifyAuthToken(token, secret, {
                expectedAudience: 'https://other.example.test',
                expectedIssuer: issuer,
            }),
        ).resolves.toBeNull();
        await expect(
            verifyAuthToken(token, secret, {
                expectedAudience: audience,
                expectedIssuer: 'https://other.example.test',
            }),
        ).resolves.toBeNull();
    });

    it('rejects bad signatures, other algorithms, time failures, and missing claims', async () => {
        const token = await signToken({});
        await expect(
            verifyAuthToken(token, toSecretKey('other-secret'), {
                expectedAudience: audience,
                expectedIssuer: issuer,
            }),
        ).resolves.toBeNull();
        await expect(
            verifyAuthToken(await signToken({ alg: 'HS384' }), secret, {
                expectedAudience: audience,
                expectedIssuer: issuer,
            }),
        ).resolves.toBeNull();
        await expect(
            verifyAuthToken(await signToken({ exp: '-1s' }), secret, {
                expectedAudience: audience,
                expectedIssuer: issuer,
            }),
        ).resolves.toBeNull();
        await expect(
            verifyAuthToken(await signToken({ nbf: '1h' }), secret, {
                expectedAudience: audience,
                expectedIssuer: issuer,
            }),
        ).resolves.toBeNull();
        await expect(
            verifyAuthToken(await signToken({ claims: { jti: undefined } }), secret, {
                expectedAudience: audience,
                expectedIssuer: issuer,
            }),
        ).resolves.toBeNull();
    });

    it('accepts an audience array when it contains the expected audience', async () => {
        const token = await new SignJWT({
            email: authFixture.email,
            jti: authFixture.jti,
            scope: authFixture.scope,
            siteId: authFixture.siteId,
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setAudience(['https://other.example.test', audience])
            .setIssuedAt()
            .setExpirationTime('1h')
            .setIssuer(issuer)
            .sign(secret);
        await expect(
            verifyAuthToken(token, secret, { expectedAudience: audience, expectedIssuer: issuer }),
        ).resolves.not.toBeNull();
    });

    it('reads the first matching cookie without failing malformed percent-encoding', () => {
        expect(readCookieValue('token=first; token=second', 'token')).toBe('first');
        expect(readCookieValue('token=first; token=second', 'token', { lastMatch: true })).toBe(
            'second',
        );
        expect(readCookieValue('token=%E0%A4%A', 'token')).toBe('%E0%A4%A');
    });

    it('normalises return URLs to one trusted origin', () => {
        expect(normaliseReturnUrl({ appOrigin: audience, returnUrl: '/protected?x=1' })).toBe(
            'https://app.example.test/protected?x=1',
        );
        for (const returnUrl of unsafeReturnUrlFixtures) {
            expect(normaliseReturnUrl({ appOrigin: audience, returnUrl })).toBe(
                'https://app.example.test/',
            );
        }
        expect(
            normaliseReturnUrl({
                appOrigin: audience,
                returnUrl: 'https://app.example.test:443/port',
            }),
        ).toBe('https://app.example.test/port');
        expect(
            normaliseReturnUrl({ appOrigin: audience, returnUrl: 'https://sub.app.example.test/' }),
        ).toBe('https://app.example.test/');
        expect(() =>
            normaliseReturnUrl({ appOrigin: 'ftp://app.example.test', returnUrl: '/' }),
        ).toThrow();
    });

    it('builds neutral cookies and local or hosted login targets', () => {
        expect(
            buildAuthCookieOptions({ name: 'token', value: 'access', secure: true, maxAge: 3600 }),
        ).toEqual({
            httpOnly: true,
            maxAge: 3600,
            name: 'token',
            path: '/',
            sameSite: 'lax',
            secure: true,
            value: 'access',
        });
        expect(
            buildLoginTarget({ appOrigin: audience, returnUrl: '/private', scope: ' album-a ' }),
        ).toBe('/login?returnUrl=https%3A%2F%2Fapp.example.test%2Fprivate&scope=album-a');
        expect(
            buildLoginTarget({
                appOrigin: audience,
                directUse: true,
                returnUrl: '/',
                serverUrl: issuer,
            }),
        ).toContain('https://sso.example.test/signin?');
    });

    it('distinguishes rejected, malformed, network, aborted, and unverified OTP exchanges', async () => {
        const base = {
            challengeId: 'challenge',
            code: '012345',
            expectedAudience: audience,
            expectedIssuer: issuer,
            secret,
            serverUrl: issuer,
        };
        await expect(
            exchangeEmailOtp({ ...base, fetcher: async () => new Response('no', { status: 400 }) }),
        ).resolves.toEqual({ kind: 'rejected', status: 400 });
        await expect(
            exchangeEmailOtp({ ...base, fetcher: async () => new Response('no', { status: 200 }) }),
        ).resolves.toEqual({ kind: 'response-error', reason: 'invalid-json', status: 200 });
        await expect(
            exchangeEmailOtp({ ...base, fetcher: async () => new Response('{}') }),
        ).resolves.toEqual({ kind: 'response-error', reason: 'missing-access-token', status: 200 });
        await expect(
            exchangeEmailOtp({
                ...base,
                fetcher: async () => {
                    throw new TypeError('network unavailable');
                },
            }),
        ).resolves.toEqual({ kind: 'network-error' });
        await expect(
            exchangeEmailOtp({
                ...base,
                fetcher: async () => {
                    throw new DOMException('aborted', 'AbortError');
                },
            }),
        ).resolves.toEqual({ kind: 'aborted' });
        await expect(
            exchangeEmailOtp({
                ...base,
                fetcher: async () =>
                    new Response(JSON.stringify({ accessToken: await signToken({}) })),
            }),
        ).resolves.toMatchObject({ kind: 'success' });
        await expect(
            exchangeEmailOtp({
                ...base,
                fetcher: async () =>
                    new Response(
                        JSON.stringify({
                            accessToken: await signToken({ issuer: 'https://other.example.test' }),
                        }),
                    ),
            }),
        ).resolves.toEqual({ kind: 'verification-error' });
        await expect(
            exchangeEmailOtp({
                ...base,
                fetcher: async () =>
                    new Response(
                        JSON.stringify({
                            accessToken: await signToken({
                                audience: 'https://other.example.test',
                            }),
                        }),
                    ),
            }),
        ).resolves.toEqual({ kind: 'verification-error' });
    });
});
