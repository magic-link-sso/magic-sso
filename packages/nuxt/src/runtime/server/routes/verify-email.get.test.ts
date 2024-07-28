// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, describe, expect, it, vi } from 'vitest';

const getQueryMock = vi.fn();
const getRequestURLMock = vi.fn();
const sendRedirectMock = vi.fn();
const setCookieMock = vi.fn();
const setHeaderMock = vi.fn();
const getMagicSsoConfigMock = vi.fn();
const normaliseReturnUrlMock = vi.fn();
const buildLoginUrlMock = vi.fn();

vi.mock('h3', () => ({
    defineEventHandler: (handler: unknown) => handler,
    getQuery: getQueryMock,
    getRequestURL: getRequestURLMock,
    sendRedirect: sendRedirectMock,
    setCookie: setCookieMock,
    setHeader: setHeaderMock,
}));

vi.mock('../utils/auth', () => ({
    buildLoginUrl: buildLoginUrlMock,
    getMagicSsoConfig: getMagicSsoConfigMock,
    normaliseReturnUrl: normaliseReturnUrlMock,
}));

describe('verify-email GET route', () => {
    afterEach(() => {
        getQueryMock.mockReset();
        getRequestURLMock.mockReset();
        sendRedirectMock.mockReset();
        setCookieMock.mockReset();
        setHeaderMock.mockReset();
        getMagicSsoConfigMock.mockReset();
        normaliseReturnUrlMock.mockReset();
        buildLoginUrlMock.mockReset();
        vi.unstubAllGlobals();
    });

    it('renders a confirmation page and stores a strict CSRF cookie', async () => {
        const event = {};
        getQueryMock.mockReturnValue({
            token: 'email-token',
            returnUrl: 'http://app.example.com/protected',
        });
        getRequestURLMock.mockReturnValue(new URL('http://app.example.com/verify-email'));
        getMagicSsoConfigMock.mockReturnValue({
            previewSecret: 'preview-secret',
            serverUrl: 'http://sso.example.com',
            jwtSecret: '',
            cookieName: 'token',
            cookiePath: '/',
            cookieMaxAge: undefined,
            directUse: false,
            publicOrigin: '',
            trustProxy: false,
            excludedPaths: [],
            authEverywhere: false,
        });
        normaliseReturnUrlMock.mockReturnValue('http://app.example.com/protected');
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ email: 'nuxt@example.com' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const { default: verifyEmailRoute } = await import('./verify-email.get');
        const response = await verifyEmailRoute(event);

        expect(setCookieMock).toHaveBeenCalledWith(
            event,
            'magic-sso-verify-csrf',
            expect.any(String),
            {
                path: '/verify-email',
                httpOnly: true,
                secure: false,
                sameSite: 'strict',
            },
        );
        expect(setHeaderMock).toHaveBeenCalledWith(event, 'cache-control', 'no-store');
        expect(setHeaderMock).toHaveBeenCalledWith(
            event,
            'content-type',
            'text/html; charset=utf-8',
        );
        expect(fetchMock).toHaveBeenCalledWith(
            new URL('http://sso.example.com/verify-email?token=email-token'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    accept: 'application/json',
                    'x-magic-sso-preview-secret': 'preview-secret',
                }),
            }),
        );
        expect(response).toContain('Continue sign-in');
        expect(response).toContain('nuxt@example.com');
        expect(response).toContain('id="email-value"');
    });

    it('redirects missing-token requests to login with See Other semantics', async () => {
        const event = {};
        getQueryMock.mockReturnValue({
            returnUrl: 'http://app.example.com/protected',
        });
        getRequestURLMock.mockReturnValue(new URL('http://app.example.com/verify-email'));
        normaliseReturnUrlMock.mockReturnValue('http://app.example.com/protected');
        buildLoginUrlMock.mockReturnValue(
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
        );

        const { default: verifyEmailRoute } = await import('./verify-email.get');
        await verifyEmailRoute(event);

        expect(sendRedirectMock).toHaveBeenCalledWith(
            event,
            '/login?returnUrl=http%3A%2F%2Fapp.example.com%2Fprotected',
            303,
        );
        expect(setCookieMock).not.toHaveBeenCalled();
    });
});
