// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    addImportsDir,
    addRouteMiddleware,
    addServerHandler,
    createResolver,
    defineNuxtModule,
} from '@nuxt/kit';
import type { NuxtModule } from '@nuxt/schema';
import { DEFAULT_EXCLUDED_PATHS } from './constants';
import type { MagicSsoModuleOptions } from './types';

export type { MagicSsoModuleOptions } from './types';

/** Read a nested runtime-config table, treating anything else as absent. */
function readConfigTable(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Apply the module defaults once, so the server and public tables stay in step. */
function resolveModuleOptions(options: MagicSsoModuleOptions) {
    return {
        authEverywhere: options.authEverywhere ?? false,
        cookieMaxAge: options.cookieMaxAge,
        cookieName: options.cookieName ?? 'token',
        cookiePath: options.cookiePath ?? '/',
        directUse: options.directUse ?? false,
        excludedPaths: options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS,
        jwtSecret: options.jwtSecret ?? '',
        publicOrigin: options.publicOrigin ?? '',
        serverUrl: options.serverUrl ?? '',
        trustProxy: options.trustProxy ?? false,
    };
}

const serverHandlers: ReadonlyArray<{
    handler: string;
    method: 'get' | 'post';
    route: string;
}> = [
    { handler: './runtime/server/routes/logout.post', method: 'post', route: '/logout' },
    { handler: './runtime/server/routes/verify-email.get', method: 'get', route: '/verify-email' },
    {
        handler: './runtime/server/routes/verify-email.post',
        method: 'post',
        route: '/verify-email',
    },
    {
        handler: './runtime/server/routes/verify-email-otp.post',
        method: 'post',
        route: '/verify-email/otp',
    },
];

const magicSsoModule: NuxtModule<MagicSsoModuleOptions, MagicSsoModuleOptions> =
    defineNuxtModule<MagicSsoModuleOptions>({
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
            const configuredPublicRuntimeConfig = readConfigTable(runtimeConfig.public);
            const configuredMagicSso = readConfigTable(runtimeConfig.magicSso);
            const configuredPublicMagicSso = readConfigTable(
                configuredPublicRuntimeConfig['magicSso'],
            );
            const { jwtSecret, ...publicOptions } = resolveModuleOptions(options);

            runtimeConfig.magicSso = { ...publicOptions, jwtSecret, ...configuredMagicSso };
            runtimeConfig.public = {
                ...configuredPublicRuntimeConfig,
                magicSso: { ...publicOptions, ...configuredPublicMagicSso },
            };

            addImportsDir(resolver.resolve('./runtime/app/composables'));
            addRouteMiddleware({
                name: 'magic-sso-auth',
                path: resolver.resolve('./runtime/app/middleware/auth'),
                global: options.authEverywhere === true,
            });
            for (const { handler, method, route } of serverHandlers) {
                addServerHandler({ handler: resolver.resolve(handler), method, route });
            }
        },
    });

export default magicSsoModule;
