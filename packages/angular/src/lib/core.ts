// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    parseBooleanFlag,
    type AuthPayload as CoreAuthPayload,
    buildAuthCookieOptions as buildCoreAuthCookieOptions,
    buildLoginTarget as buildCoreLoginTarget,
    buildVerifyUrl as buildCoreVerifyUrl,
    normaliseReturnUrl as normaliseCoreReturnUrl,
    readCookieValue,
    verifyAuthTokenWithOptionalIssuer as verifyCoreAuthTokenWithOptionalIssuer,
    exchangeEmailOtp as exchangeCoreEmailOtp,
} from '@magic-link-sso/core';

export type AuthPayload = CoreAuthPayload;

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

export interface EmailOtpExchangeOptions {
    challengeId: string;
    code: string;
    config?: MagicSsoConfig;
    expectedAudience: string;
    fetcher?: typeof fetch;
}

export interface EmailOtpExchangeResult {
    accessToken: string;
    auth: AuthPayload;
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
    return parseBooleanFlag(value, fallback);
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

export { readCookieValue };

export async function verifyAuthToken(
    token: string,
    secret: Uint8Array,
    options: VerifyAuthTokenOptions,
): Promise<AuthPayload | null> {
    return verifyCoreAuthTokenWithOptionalIssuer(token, secret, options);
}

export async function exchangeEmailOtp(
    options: EmailOtpExchangeOptions,
): Promise<EmailOtpExchangeResult | null> {
    const config = resolveMagicSsoConfig(options.config);
    const secret = getJwtSecret(config);
    const issuer = readJwtIssuer(config.serverUrl);
    if (config.serverUrl.length === 0 || secret === null || issuer === null) {
        return null;
    }
    try {
        const result = await exchangeCoreEmailOtp({
            challengeId: options.challengeId,
            code: options.code,
            expectedAudience: options.expectedAudience,
            expectedIssuer: issuer,
            fetcher: options.fetcher ?? fetch,
            secret,
            serverUrl: config.serverUrl,
        });
        return result.kind === 'success'
            ? { accessToken: result.accessToken, auth: result.auth }
            : null;
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
    const cookie = buildCoreAuthCookieOptions({
        ...(typeof resolvedConfig.cookieMaxAge === 'number'
            ? { maxAge: resolvedConfig.cookieMaxAge }
            : {}),
        name: resolvedConfig.cookieName,
        path: resolvedConfig.cookiePath,
        secure: readEnvString('NODE_ENV') === 'production',
        value,
    });
    const { maxAge: _maxAge, ...cookieWithoutMaxAge } = cookie;
    return {
        ...cookieWithoutMaxAge,
        ...(typeof cookie.maxAge === 'number' ? { maxAgeSeconds: cookie.maxAge } : {}),
    };
}

export function normaliseReturnUrl(
    returnUrl: string | undefined,
    appOrigin: string,
    fallback: string = '/',
): string {
    const normalised = normaliseCoreReturnUrl({ appOrigin, fallback, returnUrl });
    return normalised === new URL('/', appOrigin).toString() && fallback === appOrigin
        ? fallback
        : normalised;
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    return buildCoreVerifyUrl(appOrigin, returnUrl);
}

export function buildLoginPath(
    appOrigin: string,
    returnTarget: string,
    config?: MagicSsoConfig,
    scope?: string,
): string {
    const resolvedConfig = resolveMagicSsoConfig(config);
    return buildCoreLoginTarget({
        appOrigin,
        loginPath: resolvedConfig.loginPath,
        returnUrl: returnTarget,
        ...(typeof scope === 'string' ? { scope } : {}),
    });
}

export function buildLoginTarget(
    appOrigin: string,
    returnTarget: string,
    config?: MagicSsoConfig,
    scope?: string,
): string {
    const resolvedConfig = resolveMagicSsoConfig(config);
    return buildCoreLoginTarget({
        appOrigin,
        directUse: resolvedConfig.directUse,
        loginPath: resolvedConfig.loginPath,
        returnUrl: returnTarget,
        ...(typeof scope === 'string' ? { scope } : {}),
        serverUrl: resolvedConfig.serverUrl,
    });
}
