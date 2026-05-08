// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

function isDirectUseEnabled(value: string | undefined): boolean {
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

export function getAppOrigin(host: string, forwardedProtocol?: string | null): string {
    const protocol = forwardedProtocol ?? (host.startsWith('localhost') ? 'http' : 'https');
    return `${protocol}://${host}`;
}

function normalizeForwardedHost(host: string | null | undefined): string | null {
    if (typeof host !== 'string') {
        return null;
    }

    const normalizedHost = host.split(',')[0]?.trim();
    return typeof normalizedHost === 'string' && normalizedHost.length > 0 ? normalizedHost : null;
}

export function resolveAppOrigin(options: {
    explicitPublicOrigin?: string;
    fallbackOrigin?: string;
    forwardedHost?: string | null;
    forwardedProtocol?: string | null;
    host?: string | null;
}): string {
    if (
        typeof options.explicitPublicOrigin === 'string' &&
        options.explicitPublicOrigin.length > 0
    ) {
        try {
            return new URL(options.explicitPublicOrigin).origin;
        } catch {
            return options.explicitPublicOrigin;
        }
    }

    const forwardedHost = normalizeForwardedHost(options.forwardedHost);
    if (typeof forwardedHost === 'string') {
        return getAppOrigin(forwardedHost, options.forwardedProtocol);
    }

    const host = normalizeForwardedHost(options.host);
    if (typeof host === 'string') {
        return getAppOrigin(host, options.forwardedProtocol);
    }

    if (typeof options.fallbackOrigin === 'string' && options.fallbackOrigin.length > 0) {
        try {
            return new URL(options.fallbackOrigin).origin;
        } catch {
            return options.fallbackOrigin;
        }
    }

    return 'http://localhost:5001';
}

export function buildLoginTarget(appOrigin: string, scope?: string): string {
    const returnUrl = new URL('/', appOrigin).toString();
    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';

    if (isDirectUseEnabled(process.env.MAGICSSO_DIRECT_USE)) {
        const serverUrl = process.env.MAGICSSO_SERVER_URL;
        if (typeof serverUrl === 'string' && serverUrl.length > 0) {
            const loginUrl = new URL('/signin', serverUrl);
            loginUrl.searchParams.set('returnUrl', returnUrl);
            if (normalizedScope.length > 0) {
                loginUrl.searchParams.set('scope', normalizedScope);
            }
            const verifyUrl = new URL('/verify-email', appOrigin);
            verifyUrl.searchParams.set('returnUrl', returnUrl);
            loginUrl.searchParams.set('verifyUrl', verifyUrl.toString());
            return loginUrl.toString();
        }
    }

    const loginUrl = new URL('/login', appOrigin);
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (normalizedScope.length > 0) {
        loginUrl.searchParams.set('scope', normalizedScope);
    }
    return `${loginUrl.pathname}${loginUrl.search}`;
}
