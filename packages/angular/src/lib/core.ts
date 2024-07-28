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
    maxAgeSeconds?: number;
    name: string;
    path: string;
    sameSite: 'lax';
    secure: boolean;
    value: string;
}

export interface MagicSsoConfig {
    cookieMaxAge?: number;
    cookieName?: string;
    cookiePath?: string;
    directUse?: boolean;
    jwtSecret?: string;
    loginPath?: string;
    serverUrl?: string;
    sessionEndpoint?: string;
}

export interface MagicSsoResolvedConfig {
    cookieMaxAge?: number;
    cookieName: string;
    cookiePath: string;
    directUse: boolean;
    jwtSecret: string;
    loginPath: string;
    serverUrl: string;
    sessionEndpoint: string;
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

function readEnvString(name: string): string | undefined {
    const processValue = Reflect.get(globalThis, 'process');
    if (typeof processValue !== 'object' || processValue === null) {
        return undefined;
    }

    const envValue = Reflect.get(processValue, 'env');
    if (typeof envValue !== 'object' || envValue === null) {
        return undefined;
    }

    const value = Reflect.get(envValue, name);
    return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
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
                return fallback;
        }
    }

    return fallback;
}

function readPositiveInteger(value: number | string | undefined): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return undefined;
        }

        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return undefined;
}

function readCookiePath(value: string | undefined): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return '/';
    }

    const normalisedValue = value.trim();
    if (!normalisedValue.startsWith('/')) {
        throw new Error('MAGICSSO_COOKIE_PATH must start with "/".');
    }

    return normalisedValue;
}

function isAuthPayload(payload: JWTPayload): payload is AuthPayload {
    return (
        typeof payload.email === 'string' &&
        typeof payload.scope === 'string' &&
        typeof payload.siteId === 'string' &&
        (typeof payload.aud === 'string' ||
            (Array.isArray(payload.aud) &&
                payload.aud.every((entry) => typeof entry === 'string'))) &&
        typeof payload.iss === 'string'
    );
}

export function resolveMagicSsoConfig(config: MagicSsoConfig = {}): MagicSsoResolvedConfig {
    return {
        cookieMaxAge: readPositiveInteger(
            config.cookieMaxAge ?? readEnvString('MAGICSSO_COOKIE_MAX_AGE'),
        ),
        cookieName: config.cookieName ?? readEnvString('MAGICSSO_COOKIE_NAME') ?? 'token',
        cookiePath: readCookiePath(config.cookiePath ?? readEnvString('MAGICSSO_COOKIE_PATH')),
        directUse: readBoolean(config.directUse ?? readEnvString('MAGICSSO_DIRECT_USE'), false),
        jwtSecret: config.jwtSecret ?? readEnvString('MAGICSSO_JWT_SECRET') ?? '',
        loginPath: config.loginPath ?? '/login',
        serverUrl: config.serverUrl ?? readEnvString('MAGICSSO_SERVER_URL') ?? '',
        sessionEndpoint: config.sessionEndpoint ?? '/api/session',
    };
}

export function getMagicSsoConfig(config?: MagicSsoConfig): MagicSsoResolvedConfig {
    return resolveMagicSsoConfig(config);
}

export function getCookieName(config?: MagicSsoConfig): string {
    return resolveMagicSsoConfig(config).cookieName;
}

export function getCookiePath(config?: MagicSsoConfig): string {
    return resolveMagicSsoConfig(config).cookiePath;
}

export function getCookieMaxAge(config?: MagicSsoConfig): number | undefined {
    return resolveMagicSsoConfig(config).cookieMaxAge;
}

export function getJwtSecret(config?: MagicSsoConfig): Uint8Array | null {
    const jwtSecret = resolveMagicSsoConfig(config).jwtSecret;
    if (jwtSecret.length === 0) {
        return null;
    }

    return new TextEncoder().encode(jwtSecret);
}

export function readCookieValue(
    cookieHeader: string | null | undefined,
    name: string,
): string | undefined {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    const prefix = `${name}=`;
    for (const cookie of cookieHeader.split(';')) {
        const trimmedCookie = cookie.trim();
        if (!trimmedCookie.startsWith(prefix)) {
            continue;
        }

        const value = trimmedCookie.slice(prefix.length);
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
    request: Request,
    config?: MagicSsoConfig,
): Promise<AuthPayload | null> {
    const resolvedConfig = resolveMagicSsoConfig(config);
    const token = readCookieValue(request.headers.get('cookie'), resolvedConfig.cookieName);
    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }

    const secret = getJwtSecret(resolvedConfig);
    if (secret === null) {
        return null;
    }

    const issuer = readJwtIssuer(resolvedConfig.serverUrl);
    if (issuer === null) {
        return null;
    }

    return verifyAuthToken(token, secret, {
        expectedAudience: new URL(request.url).origin,
        expectedIssuer: issuer,
    });
}

export function buildAuthCookieOptions(value: string, config?: MagicSsoConfig): AuthCookieOptions {
    const resolvedConfig = resolveMagicSsoConfig(config);

    return {
        httpOnly: true,
        ...(typeof resolvedConfig.cookieMaxAge === 'number'
            ? { maxAgeSeconds: resolvedConfig.cookieMaxAge }
            : {}),
        name: resolvedConfig.cookieName,
        path: resolvedConfig.cookiePath,
        sameSite: 'lax',
        secure: readEnvString('NODE_ENV') === 'production',
        value,
    };
}

export function normaliseReturnUrl(
    returnUrl: string | undefined,
    appOrigin: string,
    fallback: string = '/',
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

export function buildLoginPath(
    appOrigin: string,
    returnTarget: string,
    config?: MagicSsoConfig,
    scope?: string,
): string {
    const resolvedConfig = resolveMagicSsoConfig(config);
    const returnUrl = normaliseReturnUrl(returnTarget, appOrigin, appOrigin);
    const loginUrl = new URL(resolvedConfig.loginPath, appOrigin);
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (typeof scope === 'string' && scope.trim().length > 0) {
        loginUrl.searchParams.set('scope', scope.trim());
    }
    return `${loginUrl.pathname}${loginUrl.search}`;
}

export function buildLoginTarget(
    appOrigin: string,
    returnTarget: string,
    config?: MagicSsoConfig,
    scope?: string,
): string {
    const resolvedConfig = resolveMagicSsoConfig(config);
    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';
    if (resolvedConfig.directUse && resolvedConfig.serverUrl.length > 0) {
        const returnUrl = normaliseReturnUrl(returnTarget, appOrigin, appOrigin);
        const verifyUrl = buildVerifyUrl(appOrigin, returnUrl);
        const loginUrl = new URL('/signin', resolvedConfig.serverUrl);
        loginUrl.searchParams.set('returnUrl', returnUrl);
        if (normalizedScope.length > 0) {
            loginUrl.searchParams.set('scope', normalizedScope);
        }
        loginUrl.searchParams.set('verifyUrl', verifyUrl);
        return loginUrl.toString();
    }

    return buildLoginPath(appOrigin, returnTarget, resolvedConfig, normalizedScope);
}
