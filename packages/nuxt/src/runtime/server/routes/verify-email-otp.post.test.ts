// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, describe, expect, it, vi } from 'vitest';

const readBodyMock = vi.fn();
const getRequestURLMock = vi.fn();
const setCookieMock = vi.fn();
const getCookieNameMock = vi.fn();
const getJwtSecretMock = vi.fn();
const getMagicSsoConfigMock = vi.fn();
const hasSameOriginMutationSourceMock = vi.fn();
const verifyAuthTokenMock = vi.fn();

vi.mock('h3', () => ({
    createError: (value: unknown) => value,
    defineEventHandler: (handler: unknown) => handler,
    getRequestURL: getRequestURLMock,
    readBody: readBodyMock,
    setCookie: setCookieMock,
}));

vi.mock('../utils/auth', () => ({
    getCookieName: getCookieNameMock,
    getJwtSecret: getJwtSecretMock,
    getMagicSsoConfig: getMagicSsoConfigMock,
    hasSameOriginMutationSource: hasSameOriginMutationSourceMock,
    readFirstHeaderValue: (value: string | string[] | undefined) =>
        Array.isArray(value)
            ? typeof value[0] === 'string'
                ? value[0]
                : null
            : typeof value === 'string' && value.length > 0
              ? value
              : null,
    verifyAuthToken: verifyAuthTokenMock,
}));

describe('verify-email OTP POST route', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        readBodyMock.mockReset();
        getRequestURLMock.mockReset();
        setCookieMock.mockReset();
        getCookieNameMock.mockReset();
        getJwtSecretMock.mockReset();
        getMagicSsoConfigMock.mockReset();
        hasSameOriginMutationSourceMock.mockReset();
        verifyAuthTokenMock.mockReset();
    });

    it('verifies the returned token before setting the auth cookie', async () => {
        const event = {
            node: {
                req: {
                    headers: { 'content-type': 'application/json' },
                },
            },
        };
        hasSameOriginMutationSourceMock.mockReturnValue(true);
        readBodyMock.mockResolvedValue({
            challengeId: 'c4bc2a37-0190-4bd6-8dc6-bcf3186b0e74',
            code: '012345',
        });
        getRequestURLMock.mockReturnValue(new URL('http://app.example.com/verify-email/otp'));
        getCookieNameMock.mockReturnValue('magic-sso');
        getJwtSecretMock.mockReturnValue(new TextEncoder().encode('jwt-secret'));
        getMagicSsoConfigMock.mockReturnValue({
            cookieMaxAge: 3600,
            cookiePath: '/auth',
            serverUrl: 'http://sso.example.com',
        });
        verifyAuthTokenMock.mockResolvedValue({ email: 'nuxt@example.com' });
        const fetchMock = vi.fn().mockResolvedValue({
            json: async () => ({ accessToken: 'access-token' }),
            ok: true,
        });
        vi.stubGlobal('fetch', fetchMock);

        const { default: route } = await import('./verify-email-otp.post');
        await expect(route(event)).resolves.toEqual({ ok: true });

        expect(fetchMock).toHaveBeenCalledWith(new URL('http://sso.example.com/verify-email/otp'), {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({
                challengeId: 'c4bc2a37-0190-4bd6-8dc6-bcf3186b0e74',
                code: '012345',
            }),
            cache: 'no-store',
        });
        expect(verifyAuthTokenMock).toHaveBeenCalledWith('access-token', expect.any(Uint8Array), {
            expectedAudience: 'http://app.example.com',
            expectedIssuer: 'http://sso.example.com',
        });
        expect(setCookieMock).toHaveBeenCalledWith(event, 'magic-sso', 'access-token', {
            path: '/auth',
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 3600,
        });
    });

    it('rejects a cross-origin request before reading or exchanging the OTP', async () => {
        const event = {
            node: {
                req: {
                    headers: { 'content-type': 'application/json' },
                },
            },
        };
        hasSameOriginMutationSourceMock.mockReturnValue(false);

        const { default: route } = await import('./verify-email-otp.post');
        await expect(route(event)).rejects.toMatchObject({ statusCode: 403 });

        expect(readBodyMock).not.toHaveBeenCalled();
        expect(setCookieMock).not.toHaveBeenCalled();
    });

    it('rejects cross-site form content types before reading the OTP', async () => {
        const event = {
            node: {
                req: {
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                },
            },
        };
        hasSameOriginMutationSourceMock.mockReturnValue(true);

        const { default: route } = await import('./verify-email-otp.post');
        await expect(route(event)).rejects.toMatchObject({ statusCode: 403 });

        expect(readBodyMock).not.toHaveBeenCalled();
        expect(setCookieMock).not.toHaveBeenCalled();
    });
});
