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
