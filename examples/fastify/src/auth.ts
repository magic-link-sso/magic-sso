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
} from '@magic-link-sso/core';

export type AuthPayload = CoreAuthPayload;

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
    return parseBooleanFlag(value);
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

export async function verifyAuthToken(
    token: string,
    secret: Uint8Array,
    options: VerifyAuthTokenOptions,
): Promise<AuthPayload | null> {
    return verifyCoreAuthTokenWithOptionalIssuer(token, secret, options);
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
    const cookie = buildCoreAuthCookieOptions({
        ...(typeof resolvedConfig.cookieMaxAge === 'number'
            ? { maxAge: resolvedConfig.cookieMaxAge }
            : {}),
        name: resolvedConfig.cookieName,
        path: resolvedConfig.cookiePath,
        secure: process.env['NODE_ENV'] === 'production',
        value: '',
    });
    return {
        httpOnly: cookie.httpOnly,
        ...(typeof cookie.maxAge === 'number' ? { maxAge: cookie.maxAge } : {}),
        path: cookie.path,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
    };
}

export function normaliseReturnUrl(
    returnUrl: string | undefined,
    appOrigin: string,
    fallback: string = appOrigin,
): string {
    const normalised = normaliseCoreReturnUrl({ appOrigin, fallback, returnUrl });
    return normalised === new URL('/', appOrigin).toString() && fallback === appOrigin
        ? fallback
        : normalised;
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    return buildCoreVerifyUrl(appOrigin, returnUrl);
}

export function buildLoginTarget(appOrigin: string, returnTarget: string, scope?: string): string {
    const resolvedConfig = resolveMagicSsoConfig();
    return buildCoreLoginTarget({
        appOrigin,
        directUse: resolvedConfig.directUse,
        returnUrl: returnTarget,
        ...(typeof scope === 'string' ? { scope } : {}),
        serverUrl: resolvedConfig.serverUrl,
    });
}

const loginErrorMessages: Record<string, string> = {
    'missing-verification-token': 'The sign-in link is incomplete. Please request a new email.',
    'session-verification-failed':
        'The app could not verify the returned sign-in token. Check that MAGICSSO_JWT_SECRET matches the SSO server.',
    'session-verification-misconfigured':
        'This app is missing MAGICSSO_JWT_SECRET, so it cannot verify sign-in tokens.',
    'verify-email-failed':
        'We could not complete sign-in from that email link. Please request a new one.',
    'verify-email-misconfigured': 'This app is missing required SSO verify-email configuration.',
};

export function getLoginErrorMessage(errorCode: string | undefined): string | undefined {
    return typeof errorCode === 'string' ? loginErrorMessages[errorCode] : undefined;
}
