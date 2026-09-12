// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { jwtVerify, type JWTPayload } from 'jose';
import { MagicSsoConfigurationError } from './errors.js';
import type { AuthPayload, VerifyAuthTokenOptions, VerifyOptionalIssuerOptions } from './types.js';

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function hasAudience(value: unknown): value is string | string[] {
    return (
        isNonEmptyString(value) ||
        (Array.isArray(value) &&
            value.length > 0 &&
            value.every((entry) => isNonEmptyString(entry)))
    );
}

function isAuthPayload(payload: JWTPayload): payload is AuthPayload {
    return (
        isNonEmptyString(payload.email) &&
        isNonEmptyString(payload.jti) &&
        typeof payload.scope === 'string' &&
        isNonEmptyString(payload.siteId) &&
        hasAudience(payload.aud) &&
        isNonEmptyString(payload.iss) &&
        Number.isFinite(payload.iat) &&
        Number.isFinite(payload.exp)
    );
}

function validateVerificationOptions(options: VerifyAuthTokenOptions): void {
    if (!isNonEmptyString(options.expectedAudience)) {
        throw new MagicSsoConfigurationError('expectedAudience must be a non-empty string.');
    }
    if (!isNonEmptyString(options.expectedIssuer)) {
        throw new MagicSsoConfigurationError('expectedIssuer must be a non-empty string.');
    }
}

export function toSecretKey(secret: string): Uint8Array {
    if (!isNonEmptyString(secret)) {
        throw new MagicSsoConfigurationError('JWT secret must be a non-empty string.');
    }
    return new TextEncoder().encode(secret);
}

export async function verifyAuthToken(
    token: string,
    secret: Uint8Array,
    options: VerifyAuthTokenOptions,
): Promise<AuthPayload | null> {
    validateVerificationOptions(options);
    if (!isNonEmptyString(token) || secret.byteLength === 0) {
        return null;
    }

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

/**
 * Verify a session token only when the caller could resolve an expected issuer.
 *
 * Framework adapters derive the issuer from configuration that may be missing,
 * and a token must never be accepted without one, so an absent issuer rejects
 * instead of verifying against whatever the token claims.
 */
export async function verifyAuthTokenWithOptionalIssuer(
    token: string,
    secret: Uint8Array,
    options: VerifyOptionalIssuerOptions,
): Promise<AuthPayload | null> {
    return typeof options.expectedIssuer === 'string'
        ? verifyAuthToken(token, secret, {
              expectedAudience: options.expectedAudience,
              expectedIssuer: options.expectedIssuer,
          })
        : null;
}
