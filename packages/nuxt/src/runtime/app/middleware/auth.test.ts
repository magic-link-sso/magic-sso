// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToMock = vi.fn();
const useRequestEventMock = vi.fn();
const isPublicPathMock = vi.fn();
const buildLoginUrlMock = vi.fn();
const verifyRequestAuthMock = vi.fn();

vi.mock('nuxt/app', () => ({
    defineNuxtRouteMiddleware: (middleware: unknown) => middleware,
    navigateTo: navigateToMock,
    useRequestEvent: useRequestEventMock,
}));

vi.mock('../composables/useMagicSso', () => ({
    useMagicSsoConfig: () => ({ directUse: true }),
}));

vi.mock('../../server/utils/auth', () => ({
    buildLoginUrl: buildLoginUrlMock,
    isPublicPath: isPublicPathMock,
    verifyRequestAuth: verifyRequestAuthMock,
}));

const route = { fullPath: '/protected?tab=1', path: '/protected' };

async function runMiddleware(): Promise<unknown> {
    const { default: middleware } = await import('./auth');
    // `defineNuxtRouteMiddleware` is mocked as identity, so the default export is the handler.
    const handler = middleware as unknown as (to: typeof route) => Promise<unknown>;
    return handler(route);
}

describe('magic-sso-auth route middleware', () => {
    beforeEach(() => {
        navigateToMock.mockReset();
        useRequestEventMock.mockReset();
        isPublicPathMock.mockReset().mockReturnValue(false);
        buildLoginUrlMock.mockReset().mockReturnValue('http://sso.example.com/signin');
        verifyRequestAuthMock.mockReset();
    });

    it('skips public paths', async () => {
        isPublicPathMock.mockReturnValue(true);

        await expect(runMiddleware()).resolves.toBeUndefined();
        expect(useRequestEventMock).not.toHaveBeenCalled();
    });

    it('skips requests without a server event', async () => {
        useRequestEventMock.mockReturnValue(undefined);

        await expect(runMiddleware()).resolves.toBeUndefined();
        expect(verifyRequestAuthMock).not.toHaveBeenCalled();
    });

    it('lets authenticated requests through', async () => {
        useRequestEventMock.mockReturnValue({});
        verifyRequestAuthMock.mockResolvedValue({ email: 'user@example.com' });

        await expect(runMiddleware()).resolves.toBeUndefined();
        expect(navigateToMock).not.toHaveBeenCalled();
    });

    it('redirects unauthenticated requests to the login URL', async () => {
        const event = {};
        useRequestEventMock.mockReturnValue(event);
        verifyRequestAuthMock.mockResolvedValue(null);
        navigateToMock.mockReturnValue('redirected');

        await expect(runMiddleware()).resolves.toBe('redirected');
        expect(buildLoginUrlMock).toHaveBeenCalledWith(event, '/protected?tab=1');
        expect(navigateToMock).toHaveBeenCalledWith('http://sso.example.com/signin', {
            external: true,
            redirectCode: 307,
        });
    });
});
