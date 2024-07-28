// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { jwtVerify, type JWTPayload } from 'jose';

export interface AuthPayload extends JWTPayload {
    email: string;
    scope: string;
    siteId: string;
}

export interface VerifyAuthTokenOptions {
    expectedAudience: string;
    expectedIssuer?: string;
}

export interface AuthCookieOptions {
    httpOnly: boolean;
    maxAge?: number;
    path: string;
    sameSite: 'lax';
    secure: boolean;
}

export interface MagicSsoConfig {
    cookieMaxAge?: number;
    cookieName?: string;
    cookiePath?: string;
    directUse?: boolean;
    jwtSecret?: string;
    serverUrl?: string;
}

export interface MagicSsoResolvedConfig {
    cookieMaxAge?: number;
    cookieName: string;
    cookiePath: string;
    directUse: boolean;
    jwtSecret: string;
    serverUrl: string;
}

function readJwtIssuer(serverUrl: string): string | null {
    if (serverUrl.length === 0) {
        return null;
    }

    try {
        return new URL(serverUrl).origin;
    } catch {
        return null;
    }
}

function readPositiveInteger(value: string | undefined): number | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }

    const parsedValue = Number.parseInt(value, 10);
    return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
}

function readBoolean(value: string | undefined): boolean {
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

function readCookiePath(value: string | undefined): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return '/';
    }

    const path = value.trim();
    if (!path.startsWith('/')) {
        throw new Error('MAGICSSO_COOKIE_PATH must start with "/".');
    }

    return path;
}

function isAuthPayload(payload: JWTPayload): payload is AuthPayload {
    return (
        typeof payload.email === 'string' &&
        payload.email.length > 0 &&
        typeof payload.scope === 'string' &&
        typeof payload.siteId === 'string' &&
        (typeof payload.aud === 'string' ||
            (Array.isArray(payload.aud) &&
                payload.aud.every((entry) => typeof entry === 'string'))) &&
        typeof payload.iss === 'string'
    );
}

export function resolveMagicSsoConfig(config: MagicSsoConfig = {}): MagicSsoResolvedConfig {
    const cookieMaxAge =
        config.cookieMaxAge ?? readPositiveInteger(process.env['MAGICSSO_COOKIE_MAX_AGE']);

    return {
        ...(typeof cookieMaxAge === 'number' ? { cookieMaxAge } : {}),
        cookieName: config.cookieName ?? process.env['MAGICSSO_COOKIE_NAME'] ?? 'token',
        cookiePath: readCookiePath(config.cookiePath ?? process.env['MAGICSSO_COOKIE_PATH']),
        directUse: config.directUse ?? readBoolean(process.env['MAGICSSO_DIRECT_USE']),
        jwtSecret: config.jwtSecret ?? process.env['MAGICSSO_JWT_SECRET'] ?? '',
        serverUrl: config.serverUrl ?? process.env['MAGICSSO_SERVER_URL'] ?? '',
    };
}

export function getJwtSecret(config?: MagicSsoConfig): Uint8Array | null {
    const jwtSecret = resolveMagicSsoConfig(config).jwtSecret;
    return jwtSecret.length > 0 ? new TextEncoder().encode(jwtSecret) : null;
}

export function readCookieValue(
    cookieHeader: string | undefined,
    name: string,
): string | undefined {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    const prefix = `${name}=`;
    for (const item of cookieHeader.split(';')) {
        const trimmedItem = item.trim();
        if (!trimmedItem.startsWith(prefix)) {
            continue;
        }

        const value = trimmedItem.slice(prefix.length);
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    return undefined;
}

export async function verifyAuthToken(
    token: string,
    secret: Uint8Array,
    options: VerifyAuthTokenOptions,
): Promise<AuthPayload | null> {
    try {
        const { payload } = await jwtVerify(token, secret, {
            audience: options.expectedAudience,
            ...(typeof options.expectedIssuer === 'string'
                ? { issuer: options.expectedIssuer }
                : {}),
        });
        return isAuthPayload(payload) ? payload : null;
    } catch {
        return null;
    }
}

export async function verifyRequestAuth(
    cookieHeader: string | undefined,
    requestOrigin: string,
    config?: MagicSsoConfig,
): Promise<AuthPayload | null> {
    const resolvedConfig = resolveMagicSsoConfig(config);
    const token = readCookieValue(cookieHeader, resolvedConfig.cookieName);

    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }

    const secret = getJwtSecret(resolvedConfig);
    const issuer = readJwtIssuer(resolvedConfig.serverUrl);
    return secret === null || issuer === null
        ? null
        : verifyAuthToken(token, secret, {
              expectedAudience: requestOrigin,
              expectedIssuer: issuer,
          });
}

export function buildAuthCookieOptions(config?: MagicSsoConfig): AuthCookieOptions {
    const resolvedConfig = resolveMagicSsoConfig(config);

    return {
        httpOnly: true,
        ...(typeof resolvedConfig.cookieMaxAge === 'number'
            ? { maxAge: resolvedConfig.cookieMaxAge }
            : {}),
        path: resolvedConfig.cookiePath,
        sameSite: 'lax',
        secure: process.env['NODE_ENV'] === 'production',
    };
}

export function normaliseReturnUrl(
    returnUrl: string | undefined,
    appOrigin: string,
    fallback: string = appOrigin,
): string {
    if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
        return fallback;
    }

    if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
        return new URL(returnUrl, appOrigin).toString();
    }

    try {
        const parsedUrl = new URL(returnUrl);
        return parsedUrl.origin === appOrigin ? parsedUrl.toString() : fallback;
    } catch {
        return fallback;
    }
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    const verifyUrl = new URL('/verify-email', appOrigin);
    verifyUrl.searchParams.set('returnUrl', returnUrl);
    return verifyUrl.toString();
}

export function buildLoginTarget(appOrigin: string, returnTarget: string, scope?: string): string {
    const resolvedConfig = resolveMagicSsoConfig();
    const returnUrl = normaliseReturnUrl(returnTarget, appOrigin, appOrigin);
    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';

    if (resolvedConfig.directUse && resolvedConfig.serverUrl.length > 0) {
        const loginUrl = new URL('/signin', resolvedConfig.serverUrl);
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

export function getLoginErrorMessage(errorCode: string | undefined): string | undefined {
    switch (errorCode) {
        case 'missing-verification-token':
            return 'The sign-in link is incomplete. Please request a new email.';
        case 'session-verification-failed':
            return 'The app could not verify the returned sign-in token. Check that MAGICSSO_JWT_SECRET matches the SSO server.';
        case 'session-verification-misconfigured':
            return 'This app is missing MAGICSSO_JWT_SECRET, so it cannot verify sign-in tokens.';
        case 'verify-email-failed':
            return 'We could not complete sign-in from that email link. Please request a new one.';
        case 'verify-email-misconfigured':
            return 'This app is missing required SSO verify-email configuration.';
        default:
            return undefined;
    }
}
