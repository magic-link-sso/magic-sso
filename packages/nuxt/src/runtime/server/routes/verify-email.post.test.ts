// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, describe, expect, it, vi } from 'vitest';

const getCookieMock = vi.fn();
const getRequestURLMock = vi.fn();
const readBodyMock = vi.fn();
const sendRedirectMock = vi.fn();
const setCookieMock = vi.fn();
const getCookieNameMock = vi.fn();
const getJwtSecretMock = vi.fn();
const getMagicSsoConfigMock = vi.fn();
const normaliseReturnUrlMock = vi.fn();
const verifyAuthTokenMock = vi.fn();
const buildLoginUrlMock = vi.fn();

vi.mock('h3', () => ({
    defineEventHandler: (handler: unknown) => handler,
    getCookie: getCookieMock,
    getRequestURL: getRequestURLMock,
    readBody: readBodyMock,
    sendRedirect: sendRedirectMock,
    setCookie: setCookieMock,
}));

vi.mock('../utils/auth', () => ({
    buildLoginUrl: buildLoginUrlMock,
    getCookieName: getCookieNameMock,
    getJwtSecret: getJwtSecretMock,
    getMagicSsoConfig: getMagicSsoConfigMock,
    normaliseReturnUrl: normaliseReturnUrlMock,
    verifyAuthToken: verifyAuthTokenMock,
}));

describe('verify-email POST route', () => {
    afterEach(() => {
        getCookieMock.mockReset();
        getRequestURLMock.mockReset();
        readBodyMock.mockReset();
        sendRedirectMock.mockReset();
        setCookieMock.mockReset();
        getCookieNameMock.mockReset();
        getJwtSecretMock.mockReset();
        getMagicSsoConfigMock.mockReset();
        normaliseReturnUrlMock.mockReset();
        verifyAuthTokenMock.mockReset();
        buildLoginUrlMock.mockReset();
        vi.unstubAllGlobals();
    });

    it('sets the auth cookie with the configured path after confirmation POST', async () => {
        const event = {};
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ accessToken: 'access-token' }),
        });
        readBodyMock.mockResolvedValue({
            csrfToken: 'csrf-token',
            token: 'email-token',
            returnUrl: 'http://app.example.com/protected',
        });
        getCookieMock.mockReturnValue('csrf-token');
        getRequestURLMock.mockReturnValue(new URL('http://app.example.com/verify-email'));
        getCookieNameMock.mockReturnValue('magic-sso');
        getJwtSecretMock.mockReturnValue(new TextEncoder().encode('jwt-secret'));
        getMagicSsoConfigMock.mockReturnValue({
            serverUrl: 'http://sso.example.com',
            cookiePath: '/auth',
            cookieMaxAge: 3600,
        });
        normaliseReturnUrlMock.mockReturnValue('http://app.example.com/protected');
        verifyAuthTokenMock.mockResolvedValue({ email: 'nuxt@example.com', scope: '*' });
        vi.stubGlobal('fetch', fetchMock);

        const { default: verifyEmailRoute } = await import('./verify-email.post');
        await verifyEmailRoute(event);

        expect(fetchMock).toHaveBeenCalledWith(new URL('http://sso.example.com/verify-email'), {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ token: 'email-token' }),
            cache: 'no-store',
        });
        expect(setCookieMock).toHaveBeenNthCalledWith(1, event, 'magic-sso-verify-csrf', '', {
            path: '/verify-email',
            httpOnly: true,
            maxAge: 0,
            secure: false,
            sameSite: 'strict',
        });
        expect(setCookieMock).toHaveBeenNthCalledWith(2, event, 'magic-sso', 'access-token', {
            path: '/auth',
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 3600,
        });
        expect(sendRedirectMock).toHaveBeenCalledWith(
            event,
            'http://app.example.com/protected',
            303,
        );
    });

    it('redirects failed verification POSTs to login with See Other semantics', async () => {
        const event = {};
        readBodyMock.mockResolvedValue({
            csrfToken: 'csrf-token',
            token: 'email-token',
            returnUrl: 'http://app.example.com/protected',
        });
        getCookieMock.mockReturnValue('csrf-token');
        getRequestURLMock.mockReturnValue(new URL('http://app.example.com/verify-email'));
        getMagicSsoConfigMock.mockReturnValue({
            serverUrl: 'http://sso.example.com',
            cookiePath: '/auth',
        });
        normaliseReturnUrlMock.mockReturnValue('http://app.example.com/protected');
        buildLoginUrlMock.mockReturnValue(
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
            }),
        );

        const { default: verifyEmailRoute } = await import('./verify-email.post');
        await verifyEmailRoute(event);

        expect(sendRedirectMock).toHaveBeenCalledWith(
            event,
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
            303,
        );
    });
});
