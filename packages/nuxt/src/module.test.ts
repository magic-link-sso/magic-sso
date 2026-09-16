// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Nuxt } from '@nuxt/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXCLUDED_PATHS } from './constants';
import magicSsoModule from './module';

const { addImportsDirMock, addRouteMiddlewareMock, addServerHandlerMock } = vi.hoisted(() => ({
    addImportsDirMock: vi.fn(),
    addRouteMiddlewareMock: vi.fn(),
    addServerHandlerMock: vi.fn(),
}));

vi.mock('@nuxt/kit', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@nuxt/kit')>()),
    addImportsDir: addImportsDirMock,
    addRouteMiddleware: addRouteMiddlewareMock,
    addServerHandler: addServerHandlerMock,
    createResolver: () => ({ resolve: (path: string): string => path }),
}));

function createNuxt(runtimeConfig: Record<string, unknown>): Nuxt {
    // The module only reads `options.runtimeConfig`; the rest of Nuxt is irrelevant here.
    return {
        hook: vi.fn(),
        options: { _requiredModules: {}, runtimeConfig },
    } as unknown as Nuxt;
}

describe('Magic Link SSO Nuxt module', () => {
    beforeEach(() => {
        addImportsDirMock.mockReset();
        addRouteMiddlewareMock.mockReset();
        addServerHandlerMock.mockReset();
    });

    it('exposes its package metadata', async (): Promise<void> => {
        await expect(magicSsoModule.getMeta?.()).resolves.toMatchObject({
            name: '@magic-link-sso/nuxt',
            configKey: 'magicSso',
        });
    });

    it('applies defaults and keeps the JWT secret out of public runtime config', async () => {
        const nuxt = createNuxt({ public: { siteName: 'Example' } });

        await magicSsoModule(
            { jwtSecret: 'jwt-secret', serverUrl: 'http://sso.example.com' },
            nuxt,
        );

        const { runtimeConfig } = nuxt.options;
        expect(runtimeConfig.magicSso).toMatchObject({
            authEverywhere: false,
            cookieName: 'token',
            cookiePath: '/',
            directUse: false,
            excludedPaths: DEFAULT_EXCLUDED_PATHS,
            jwtSecret: 'jwt-secret',
            publicOrigin: '',
            serverUrl: 'http://sso.example.com',
            trustProxy: false,
        });
        expect(runtimeConfig.public).toMatchObject({ siteName: 'Example' });
        expect(runtimeConfig.public.magicSso).toMatchObject({
            serverUrl: 'http://sso.example.com',
        });
        expect(runtimeConfig.public.magicSso).not.toHaveProperty('jwtSecret');
        expect(addServerHandlerMock).toHaveBeenCalledTimes(4);
        expect(addRouteMiddlewareMock).toHaveBeenCalledWith(
            expect.objectContaining({ global: false, name: 'magic-sso-auth' }),
        );
    });

    it('lets explicit runtime config override module options', async () => {
        const nuxt = createNuxt({
            magicSso: { cookieName: 'runtime-cookie' },
            public: { magicSso: { directUse: true } },
        });

        await magicSsoModule({ authEverywhere: true, cookieName: 'module-cookie' }, nuxt);

        expect(nuxt.options.runtimeConfig.magicSso).toMatchObject({
            cookieName: 'runtime-cookie',
        });
        expect(nuxt.options.runtimeConfig.public.magicSso).toMatchObject({
            cookieName: 'module-cookie',
            directUse: true,
        });
        expect(addRouteMiddlewareMock).toHaveBeenCalledWith(
            expect.objectContaining({ global: true }),
        );
    });
});
