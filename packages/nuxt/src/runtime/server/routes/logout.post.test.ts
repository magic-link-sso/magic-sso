// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, describe, expect, it, vi } from 'vitest';

const deleteCookieMock = vi.fn();
const sendRedirectMock = vi.fn();
const getCookieNameMock = vi.fn();
const getMagicSsoConfigMock = vi.fn();
const getRequestOriginMock = vi.fn();

vi.mock('h3', () => ({
    defineEventHandler: (handler: unknown) => handler,
    deleteCookie: deleteCookieMock,
    sendRedirect: sendRedirectMock,
}));

vi.mock('../utils/auth', () => ({
    getCookieName: getCookieNameMock,
    getMagicSsoConfig: getMagicSsoConfigMock,
    getRequestOrigin: getRequestOriginMock,
    readFirstHeaderValue: (value: string | string[] | undefined) =>
        Array.isArray(value)
            ? typeof value[0] === 'string'
                ? value[0]
                : null
            : typeof value === 'string' && value.length > 0
              ? value
              : null,
}));

describe('logout route', () => {
    afterEach(() => {
        deleteCookieMock.mockReset();
        sendRedirectMock.mockReset();
        getCookieNameMock.mockReset();
        getMagicSsoConfigMock.mockReset();
        getRequestOriginMock.mockReset();
    });

    it('deletes the cookie with the configured path', async () => {
        const event = {
            node: {
                req: {
                    headers: {
                        origin: 'http://app.example.com',
                    },
                    method: 'POST',
                },
            },
        };
        getCookieNameMock.mockReturnValue('magic-sso');
        getMagicSsoConfigMock.mockReturnValue({ cookiePath: '/auth' });
        getRequestOriginMock.mockReturnValue('http://app.example.com');

        const { default: logoutRoute } = await import('./logout.post');
        await logoutRoute(event);

        expect(deleteCookieMock).toHaveBeenCalledWith(event, 'magic-sso', {
            path: '/auth',
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
        });
        expect(sendRedirectMock).toHaveBeenCalledWith(event, '/', 303);
    });

    it('rejects non-POST requests', async () => {
        const event = {
            node: {
                req: {
                    headers: {
                        origin: 'http://app.example.com',
                    },
                    method: 'GET',
                },
            },
        };

        const { default: logoutRoute } = await import('./logout.post');
        const response = await logoutRoute(event);

        expect(response?.status).toBe(405);
        expect(response?.headers.get('Allow')).toBe('POST');
        expect(deleteCookieMock).not.toHaveBeenCalled();
    });

    it('rejects cross-origin POST requests', async () => {
        const event = {
            node: {
                req: {
                    headers: {
                        origin: 'https://evil.example.com',
                    },
                    method: 'POST',
                },
            },
        };
        getRequestOriginMock.mockReturnValue('http://app.example.com');

        const { default: logoutRoute } = await import('./logout.post');
        const response = await logoutRoute(event);

        expect(response?.status).toBe(403);
        expect(deleteCookieMock).not.toHaveBeenCalled();
    });

    it('accepts proxied same-origin POST requests when a public origin is configured', async () => {
        const event = {
            node: {
                req: {
                    headers: {
                        origin: 'http://photos.localhost:4306',
                        host: '0.0.0.0:5001',
                    },
                    method: 'POST',
                },
            },
        };
        getCookieNameMock.mockReturnValue('magic-sso');
        getMagicSsoConfigMock.mockReturnValue({ cookiePath: '/' });
        getRequestOriginMock.mockReturnValue('http://photos.localhost:4306');

        const { default: logoutRoute } = await import('./logout.post');
        const response = await logoutRoute(event);

        expect(response).toBeUndefined();
        expect(deleteCookieMock).toHaveBeenCalledOnce();
        expect(sendRedirectMock).toHaveBeenCalledWith(event, '/', 303);
    });

    it('accepts proxied same-origin POST requests when trust proxy is enabled', async () => {
        const event = {
            node: {
                req: {
                    headers: {
                        referer: 'http://photos.localhost:4306/account',
                        host: '0.0.0.0:5001',
                        'x-forwarded-host': 'photos.localhost:4306',
                        'x-forwarded-proto': 'http',
                    },
                    method: 'POST',
                },
            },
        };
        getCookieNameMock.mockReturnValue('magic-sso');
        getMagicSsoConfigMock.mockReturnValue({ cookiePath: '/' });
        getRequestOriginMock.mockReturnValue('http://photos.localhost:4306');

        const { default: logoutRoute } = await import('./logout.post');
        const response = await logoutRoute(event);

        expect(response).toBeUndefined();
        expect(deleteCookieMock).toHaveBeenCalledOnce();
        expect(sendRedirectMock).toHaveBeenCalledWith(event, '/', 303);
    });
});
