// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { afterEach, describe, expect, it, vi } from 'vitest';

const deleteCookieMock = vi.fn();
const getRequestURLMock = vi.fn();
const sendRedirectMock = vi.fn();
const getCookieNameMock = vi.fn();
const getMagicSsoConfigMock = vi.fn();

vi.mock('h3', () => ({
    defineEventHandler: (handler: unknown) => handler,
    deleteCookie: deleteCookieMock,
    getRequestURL: getRequestURLMock,
    sendRedirect: sendRedirectMock,
}));

vi.mock('../utils/auth', () => ({
    getCookieName: getCookieNameMock,
    getMagicSsoConfig: getMagicSsoConfigMock,
}));

describe('logout route', () => {
    afterEach(() => {
        deleteCookieMock.mockReset();
        getRequestURLMock.mockReset();
        sendRedirectMock.mockReset();
        getCookieNameMock.mockReset();
        getMagicSsoConfigMock.mockReset();
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
        getRequestURLMock.mockReturnValue(new URL('http://app.example.com/logout'));

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
        getRequestURLMock.mockReturnValue(new URL('http://app.example.com/logout'));

        const { default: logoutRoute } = await import('./logout.post');
        const response = await logoutRoute(event);

        expect(response?.status).toBe(403);
        expect(deleteCookieMock).not.toHaveBeenCalled();
    });
});
