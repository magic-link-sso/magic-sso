// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { hkdfSync } from 'node:crypto';
import { jwtVerify, type JWTPayload } from 'jose';
import type { GateConfig } from './config.js';
import { buildGatePath, buildPublicUrl, normaliseReturnUrl } from './config.js';

export interface AuthPayload extends JWTPayload {
    email: string;
    jti: string;
    scope: string;
    siteId: string;
}

export interface VerifyAuthTokenOptions {
    expectedAudience: string;
    expectedIssuer: string;
}

export interface AuthCookieOptions {
    httpOnly: boolean;
    maxAge?: number;
    path: string;
    sameSite: 'lax';
    secure: boolean;
}

const VERIFY_CSRF_INFO = Buffer.from('magic-sso gate verify csrf', 'utf8');
const sessionRevocationCheckPath = '/session-revocations/check';
const verifyEmailPreviewSecretHeaderName = 'x-magic-sso-preview-secret';

interface SessionRevocationCheckResponse {
    revoked: boolean;
}

function isAuthPayload(payload: JWTPayload): payload is AuthPayload {
    return (
        typeof payload.email === 'string' &&
        payload.email.length > 0 &&
        typeof payload.jti === 'string' &&
        payload.jti.length > 0 &&
        typeof payload.scope === 'string' &&
        typeof payload.siteId === 'string' &&
        (typeof payload.aud === 'string' ||
            (Array.isArray(payload.aud) &&
                payload.aud.every((entry) => typeof entry === 'string'))) &&
        typeof payload.iss === 'string'
    );
}

function isSessionRevocationCheckResponse(value: unknown): value is SessionRevocationCheckResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'revoked') === 'boolean'
    );
}

export function getJwtSecret(config: GateConfig): Uint8Array | null {
    return config.jwtSecret.length > 0 ? new TextEncoder().encode(config.jwtSecret) : null;
}

export function deriveVerifyCsrfSecret(jwtSecret: string): Buffer {
    return Buffer.from(
        hkdfSync('sha256', Buffer.from(jwtSecret, 'utf8'), Buffer.alloc(0), VERIFY_CSRF_INFO, 32),
    );
}

export function readCookieValue(
    cookieHeader: string | undefined,
    name: string,
): string | undefined {
    if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
        return undefined;
    }

    const prefix = `${name}=`;
    let matchedValue: string | undefined;
    for (const item of cookieHeader.split(';')) {
        const trimmedItem = item.trim();
        if (!trimmedItem.startsWith(prefix)) {
            continue;
        }

        const value = trimmedItem.slice(prefix.length);
        try {
            matchedValue = decodeURIComponent(value);
        } catch {
            matchedValue = value;
        }
    }

    return matchedValue;
}

export async function verifyAuthToken(
    token: string,
    secret: Uint8Array,
    options: VerifyAuthTokenOptions,
): Promise<AuthPayload | null> {
    try {
        const { payload } = await jwtVerify(token, secret, {
            algorithms: ['HS256'],
            audience: options.expectedAudience,
            issuer: options.expectedIssuer,
        });
        return isAuthPayload(payload) ? payload : null;
    } catch {
        return null;
    }
}

async function isSessionRevoked(jti: string, config: GateConfig): Promise<boolean> {
    try {
        const response = await fetch(new URL(sessionRevocationCheckPath, config.serverUrl), {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                [verifyEmailPreviewSecretHeaderName]: config.previewSecret,
            },
            body: JSON.stringify({ jti }),
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(config.requestTimeoutMs),
        });

        if (!response.ok) {
            return true;
        }

        const payload: unknown = await response.json();
        return isSessionRevocationCheckResponse(payload) ? payload.revoked : true;
    } catch {
        return true;
    }
}

export async function verifyRequestAuth(
    cookieHeader: string | undefined,
    config: GateConfig,
): Promise<AuthPayload | null> {
    const token = readCookieValue(cookieHeader, config.cookieName);

    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }

    const secret = getJwtSecret(config);
    if (secret === null) {
        return null;
    }

    const payload = await verifyAuthToken(token, secret, {
        expectedAudience: config.publicOrigin,
        expectedIssuer: config.serverUrl,
    });
    if (payload === null) {
        return null;
    }

    return (await isSessionRevoked(payload.jti, config)) ? null : payload;
}

export function buildAuthCookieOptions(config: GateConfig): AuthCookieOptions {
    return {
        httpOnly: true,
        ...(typeof config.cookieMaxAge === 'number' ? { maxAge: config.cookieMaxAge } : {}),
        path: config.cookiePath,
        sameSite: 'lax',
        secure: config.publicOrigin.startsWith('https://'),
    };
}

export function buildVerifyUrl(config: GateConfig, returnUrl: string): string {
    const verifyUrl = new URL(buildPublicUrl(config, buildGatePath(config, '/verify-email')));
    verifyUrl.searchParams.set('returnUrl', returnUrl);
    return verifyUrl.toString();
}

export function buildLoginPath(config: GateConfig, returnUrl: string, scope?: string): string {
    const loginPath = new URL(buildPublicUrl(config, buildGatePath(config, '/login')));
    loginPath.searchParams.set('returnUrl', normaliseReturnUrl(returnUrl, config));

    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';
    if (normalizedScope.length > 0) {
        loginPath.searchParams.set('scope', normalizedScope);
    }

    return `${loginPath.pathname}${loginPath.search}`;
}

export function buildLoginTarget(config: GateConfig, returnUrl: string, scope?: string): string {
    const normalisedReturnUrl = normaliseReturnUrl(returnUrl, config);
    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';

    if (config.directUse) {
        const loginUrl = new URL('/signin', config.serverUrl);
        loginUrl.searchParams.set('returnUrl', normalisedReturnUrl);
        loginUrl.searchParams.set('verifyUrl', buildVerifyUrl(config, normalisedReturnUrl));
        if (normalizedScope.length > 0) {
            loginUrl.searchParams.set('scope', normalizedScope);
        }
        return loginUrl.toString();
    }

    return buildLoginPath(config, normalisedReturnUrl, scope);
}

export function getLoginErrorMessage(errorCode: string | undefined): string | undefined {
    switch (errorCode) {
        case 'missing-verification-token':
            return 'The sign-in link is incomplete. Please request a new email.';
        case 'session-verification-failed':
            return 'The gate could not verify the returned sign-in token. Check that auth.jwtSecret matches the Magic Link SSO server.';
        case 'session-verification-misconfigured':
            return 'This gate is missing auth.jwtSecret, so it cannot verify sign-in tokens.';
        case 'verify-email-failed':
            return 'We could not complete sign-in from that email link. Please request a new one.';
        case 'verify-email-misconfigured':
            return 'This gate is missing required verify-email configuration.';
        default:
            return undefined;
    }
}
