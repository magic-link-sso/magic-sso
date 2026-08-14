// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { MagicSsoConfigurationError } from './errors.js';
import type { BuildLoginTargetOptions, NormaliseReturnUrlOptions } from './types.js';

function canonicalOrigin(value: string): string {
    try {
        const url = new URL(value);
        if (
            (url.protocol !== 'http:' && url.protocol !== 'https:') ||
            url.origin === 'null' ||
            url.username.length > 0 ||
            url.password.length > 0
        ) {
            throw new Error('unsafe origin');
        }
        return url.origin;
    } catch {
        throw new MagicSsoConfigurationError(
            'appOrigin must be an absolute HTTP(S) origin without credentials.',
        );
    }
}

function normaliseFallback(fallback: string | undefined, appOrigin: string): string {
    if (typeof fallback === 'undefined') {
        return `${appOrigin}/`;
    }
    try {
        const url = new URL(fallback, appOrigin);
        return url.origin === appOrigin && url.username.length === 0 && url.password.length === 0
            ? url.toString()
            : `${appOrigin}/`;
    } catch {
        return `${appOrigin}/`;
    }
}

function hasEncodedAuthorityPrefix(url: URL): boolean {
    return /^\/(?:%2f|%5c)/iu.test(url.pathname);
}

export function normaliseReturnUrl(options: NormaliseReturnUrlOptions): string {
    const appOrigin = canonicalOrigin(options.appOrigin);
    const fallback = normaliseFallback(options.fallback, appOrigin);
    const value = options.returnUrl;
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('\\')) {
        return fallback;
    }

    try {
        const url = new URL(value, appOrigin);
        return url.origin === appOrigin &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            !hasEncodedAuthorityPrefix(url)
            ? url.toString()
            : fallback;
    } catch {
        return fallback;
    }
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    const origin = canonicalOrigin(appOrigin);
    const url = new URL('/verify-email', origin);
    url.searchParams.set('returnUrl', normaliseReturnUrl({ appOrigin: origin, returnUrl }));
    return url.toString();
}

function normaliseScope(scope: string | undefined): string | undefined {
    if (typeof scope !== 'string') {
        return undefined;
    }
    const normalised = scope.trim();
    return normalised.length > 0 ? normalised : undefined;
}

export function buildLoginTarget(options: BuildLoginTargetOptions): string {
    const appOrigin = canonicalOrigin(options.appOrigin);
    const returnUrl = normaliseReturnUrl({ appOrigin, returnUrl: options.returnUrl });
    const scope = normaliseScope(options.scope);
    const localLoginUrl = new URL(options.loginPath ?? '/login', appOrigin);

    if (
        options.directUse === true &&
        typeof options.serverUrl === 'string' &&
        options.serverUrl.length > 0
    ) {
        const serverOrigin = canonicalOrigin(options.serverUrl);
        const hostedLoginUrl = new URL('/signin', serverOrigin);
        hostedLoginUrl.searchParams.set('returnUrl', returnUrl);
        if (typeof scope === 'string') {
            hostedLoginUrl.searchParams.set('scope', scope);
        }
        hostedLoginUrl.searchParams.set('verifyUrl', buildVerifyUrl(appOrigin, returnUrl));
        return hostedLoginUrl.toString();
    }

    localLoginUrl.searchParams.set('returnUrl', returnUrl);
    if (typeof scope === 'string') {
        localLoginUrl.searchParams.set('scope', scope);
    }
    return `${localLoginUrl.pathname}${localLoginUrl.search}`;
}
