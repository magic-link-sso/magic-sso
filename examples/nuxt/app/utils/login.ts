// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

export function normaliseReturnUrl(
    value: string | string[] | undefined,
    appOrigin: string,
): string {
    const returnUrl = Array.isArray(value) ? value[0] : value;
    if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
        return appOrigin;
    }
    if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
        return new URL(returnUrl, appOrigin).toString();
    }

    try {
        const parsedUrl = new URL(returnUrl);
        return parsedUrl.origin === appOrigin ? parsedUrl.toString() : appOrigin;
    } catch {
        return appOrigin;
    }
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    const verifyUrl = new URL('/verify-email', appOrigin);
    verifyUrl.searchParams.set('returnUrl', returnUrl);
    return verifyUrl.toString();
}

export function buildLoginTarget(
    appOrigin: string,
    returnPath: string,
    directUse: boolean,
    serverUrl: string,
    scope?: string,
): string {
    const returnUrl = new URL(returnPath, appOrigin).toString();
    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';

    if (directUse && serverUrl.length > 0) {
        const loginUrl = new URL('/signin', serverUrl);
        loginUrl.searchParams.set('returnUrl', returnUrl);
        if (normalizedScope.length > 0) {
            loginUrl.searchParams.set('scope', normalizedScope);
        }
        loginUrl.searchParams.set('verifyUrl', buildVerifyUrl(appOrigin, returnUrl));
        return loginUrl.toString();
    }

    const loginUrl = new URL('/login', appOrigin);
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (normalizedScope.length > 0) {
        loginUrl.searchParams.set('scope', normalizedScope);
    }
    return `${loginUrl.pathname}${loginUrl.search}`;
}
