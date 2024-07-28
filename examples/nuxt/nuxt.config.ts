// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

function readBooleanEnv(value: string | undefined): boolean {
    if (typeof value !== 'string') {
        return false;
    }

    switch (value.trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        case '0':
        case 'false':
        case 'no':
        case 'off':
            return false;
        default:
            return false;
    }
}

export default defineNuxtConfig({
    compatibilityDate: '2026-03-26',
    css: ['magic-sso-example-ui/styles.css'],
    modules: ['@magic-link-sso/nuxt'],
    runtimeConfig: {
        magicSso: {
            previewSecret: process.env.MAGICSSO_PREVIEW_SECRET ?? '',
            serverUrl: process.env.MAGICSSO_SERVER_URL ?? process.env.APP_URL ?? '',
            jwtSecret: process.env.MAGICSSO_JWT_SECRET ?? process.env.JWT_SECRET ?? '',
            publicOrigin: process.env.MAGICSSO_PUBLIC_ORIGIN ?? process.env.APP_URL ?? '',
            cookieName: process.env.MAGICSSO_COOKIE_NAME ?? process.env.COOKIE_NAME ?? 'magic-sso',
            cookiePath: process.env.MAGICSSO_COOKIE_PATH ?? '/',
            cookieMaxAge:
                process.env.MAGICSSO_COOKIE_MAX_AGE !== undefined
                    ? Number.parseInt(process.env.MAGICSSO_COOKIE_MAX_AGE, 10)
                    : undefined,
            directUse: readBooleanEnv(process.env.MAGICSSO_DIRECT_USE),
            excludedPaths: [
                '/',
                '/login',
                '/logout',
                '/verify-email',
                '/api',
                '/assets',
                '/_nuxt',
                '/favicon.ico',
            ],
            authEverywhere: false,
        },
        public: {
            magicSso: {
                serverUrl: process.env.MAGICSSO_SERVER_URL ?? process.env.APP_URL ?? '',
                publicOrigin: process.env.MAGICSSO_PUBLIC_ORIGIN ?? process.env.APP_URL ?? '',
                cookieName:
                    process.env.MAGICSSO_COOKIE_NAME ?? process.env.COOKIE_NAME ?? 'magic-sso',
                cookiePath: process.env.MAGICSSO_COOKIE_PATH ?? '/',
                cookieMaxAge:
                    process.env.MAGICSSO_COOKIE_MAX_AGE !== undefined
                        ? Number.parseInt(process.env.MAGICSSO_COOKIE_MAX_AGE, 10)
                        : undefined,
                directUse: readBooleanEnv(process.env.MAGICSSO_DIRECT_USE),
                excludedPaths: [
                    '/',
                    '/login',
                    '/logout',
                    '/verify-email',
                    '/api',
                    '/assets',
                    '/_nuxt',
                    '/favicon.ico',
                ],
                authEverywhere: false,
            },
        },
    },
});
