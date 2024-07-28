// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    addImportsDir,
    addRouteMiddleware,
    addServerHandler,
    createResolver,
    defineNuxtModule,
} from '@nuxt/kit';
import { DEFAULT_EXCLUDED_PATHS } from './constants';
import type { MagicSsoModuleOptions } from './types';

export type { MagicSsoModuleOptions } from './types';

export default defineNuxtModule<MagicSsoModuleOptions>({
    meta: {
        name: '@magic-link-sso/nuxt',
        configKey: 'magicSso',
    },
    defaults: {
        serverUrl: '',
        jwtSecret: '',
        cookieName: 'token',
        cookiePath: '/',
        cookieMaxAge: undefined,
        directUse: false,
        publicOrigin: '',
        trustProxy: false,
        excludedPaths: DEFAULT_EXCLUDED_PATHS,
        authEverywhere: false,
    },
    setup(options, nuxt) {
        const resolver = createResolver(import.meta.url);
        const runtimeConfig = nuxt.options.runtimeConfig;
        const configuredPublicRuntimeConfig =
            typeof runtimeConfig.public === 'object' && runtimeConfig.public !== null
                ? runtimeConfig.public
                : {};
        const configuredMagicSso =
            typeof runtimeConfig.magicSso === 'object' && runtimeConfig.magicSso !== null
                ? runtimeConfig.magicSso
                : {};
        const configuredPublicMagicSso =
            typeof configuredPublicRuntimeConfig.magicSso === 'object' &&
            configuredPublicRuntimeConfig.magicSso !== null
                ? configuredPublicRuntimeConfig.magicSso
                : {};

        runtimeConfig.magicSso = {
            serverUrl: options.serverUrl ?? '',
            jwtSecret: options.jwtSecret ?? '',
            cookieName: options.cookieName ?? 'token',
            cookiePath: options.cookiePath ?? '/',
            cookieMaxAge: options.cookieMaxAge,
            directUse: options.directUse ?? false,
            publicOrigin: options.publicOrigin ?? '',
            trustProxy: options.trustProxy ?? false,
            excludedPaths: options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS,
            authEverywhere: options.authEverywhere ?? false,
            ...configuredMagicSso,
        };
        runtimeConfig.public = {
            ...configuredPublicRuntimeConfig,
            magicSso: {
                serverUrl: options.serverUrl ?? '',
                cookieName: options.cookieName ?? 'token',
                cookiePath: options.cookiePath ?? '/',
                cookieMaxAge: options.cookieMaxAge,
                directUse: options.directUse ?? false,
                publicOrigin: options.publicOrigin ?? '',
                trustProxy: options.trustProxy ?? false,
                excludedPaths: options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS,
                authEverywhere: options.authEverywhere ?? false,
                ...configuredPublicMagicSso,
            },
        };

        addImportsDir(resolver.resolve('./runtime/app/composables'));
        addRouteMiddleware({
            name: 'magic-sso-auth',
            path: resolver.resolve('./runtime/app/middleware/auth'),
            global: options.authEverywhere === true,
        });
        addServerHandler({
            route: '/logout',
            handler: resolver.resolve('./runtime/server/routes/logout.post'),
            method: 'post',
        });
        addServerHandler({
            route: '/verify-email',
            handler: resolver.resolve('./runtime/server/routes/verify-email.get'),
            method: 'get',
        });
        addServerHandler({
            route: '/verify-email',
            handler: resolver.resolve('./runtime/server/routes/verify-email.post'),
            method: 'post',
        });
    },
});
