/**
 * server/src/auth.ts
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const JWT_ALGORITHM = 'HS256';

export interface JwtVerificationFailure {
    errorName: string;
}

interface VerifyTokenOptions {
    onError?: (failure: JwtVerificationFailure) => void;
    expectedIssuer?: string;
}

export interface AccessTokenVerificationOptions extends VerifyTokenOptions {
    expectedAudience?: string | string[];
    expectedIssuer?: string;
}

export interface VerificationTokenPayload extends JWTPayload {
    email: string;
    jti: string;
    returnUrl?: string;
    scope: string;
    siteId: string;
}

export interface AccessTokenPayload extends JWTPayload {
    email: string;
    jti: string;
    scope: string;
    siteId: string;
}

function toSecretKey(secret: string): Uint8Array {
    return new TextEncoder().encode(secret);
}

function isVerificationTokenPayload(value: string | JWTPayload): value is VerificationTokenPayload {
    return (
        typeof value !== 'string' &&
        typeof value.email === 'string' &&
        typeof value.jti === 'string' &&
        typeof value.scope === 'string' &&
        typeof value.siteId === 'string' &&
        (typeof value.aud === 'string' ||
            (Array.isArray(value.aud) && value.aud.every((entry) => typeof entry === 'string'))) &&
        typeof value.iss === 'string' &&
        (typeof value.returnUrl === 'string' || typeof value.returnUrl === 'undefined')
    );
}

function isAccessTokenPayload(value: string | JWTPayload): value is AccessTokenPayload {
    return (
        typeof value !== 'string' &&
        typeof value.email === 'string' &&
        typeof value.jti === 'string' &&
        typeof value.scope === 'string' &&
        typeof value.siteId === 'string' &&
        (typeof value.aud === 'string' ||
            (Array.isArray(value.aud) && value.aud.every((entry) => typeof entry === 'string'))) &&
        typeof value.iss === 'string'
    );
}

async function signToken(
    payload: JWTPayload,
    secret: string,
    audience: string | string[],
    issuer: string,
    expiresInSeconds: number,
): Promise<string> {
    return new SignJWT(payload)
        .setProtectedHeader({ alg: JWT_ALGORITHM })
        .setIssuedAt()
        .setAudience(audience)
        .setExpirationTime(`${expiresInSeconds}s`)
        .setIssuer(issuer)
        .sign(toSecretKey(secret));
}

export async function generateEmailToken(
    email: string,
    returnUrl: string | undefined,
    siteId: string,
    scope: string,
    issuer: string,
    secret: string,
    expiresInSeconds: number,
): Promise<string> {
    const payload: JWTPayload = {
        email,
        jti: randomUUID(),
        scope,
        siteId,
        ...(typeof returnUrl === 'string' ? { returnUrl } : {}),
    };

    return signToken(payload, secret, siteId, issuer, expiresInSeconds);
}

function handleVerificationError<TPayload>(
    error: unknown,
    options: VerifyTokenOptions | undefined,
): TPayload | null {
    options?.onError?.({
        errorName:
            error instanceof Error && error.name === 'JWTExpired'
                ? 'TokenExpiredError'
                : error instanceof Error
                  ? 'JsonWebTokenError'
                  : 'UnknownJwtError',
    });

    return null;
}

function normaliseExpectedAudience(
    audience: string | string[] | undefined,
): string | [string, ...string[]] | undefined {
    if (typeof audience === 'string') {
        return audience;
    }

    if (!Array.isArray(audience) || audience.length === 0) {
        return undefined;
    }

    const [firstAudience, ...remainingAudience] = audience;
    if (typeof firstAudience !== 'string') {
        return undefined;
    }

    return remainingAudience.length === 0 ? firstAudience : [firstAudience, ...remainingAudience];
}

export async function verifyEmailToken(
    token: string,
    secret: string,
    options?: VerifyTokenOptions,
): Promise<VerificationTokenPayload | null> {
    try {
        const verifyOptions = {
            algorithms: [JWT_ALGORITHM],
            ...(typeof options?.expectedIssuer === 'string'
                ? { issuer: options.expectedIssuer }
                : {}),
        };
        const { payload } = await jwtVerify(token, toSecretKey(secret), verifyOptions);
        return isVerificationTokenPayload(payload) ? payload : null;
    } catch (error) {
        return handleVerificationError(error, options);
    }
}

export async function signAccessToken(
    email: string,
    scope: string,
    siteId: string,
    audience: readonly string[],
    issuer: string,
    secret: string,
    expiresInSeconds: number,
): Promise<string> {
    return signToken(
        { email, jti: randomUUID(), scope, siteId },
        secret,
        [...audience],
        issuer,
        expiresInSeconds,
    );
}

export async function verifyAccessToken(
    token: string,
    secret: string,
    options?: AccessTokenVerificationOptions,
): Promise<AccessTokenPayload | null> {
    try {
        const audience = normaliseExpectedAudience(options?.expectedAudience);
        const verifyOptions = {
            algorithms: [JWT_ALGORITHM],
            ...(typeof audience !== 'undefined' ? { audience } : {}),
            ...(typeof options?.expectedIssuer === 'string'
                ? { issuer: options.expectedIssuer }
                : {}),
        };
        const { payload } = await jwtVerify(token, toSecretKey(secret), verifyOptions);
        return isAccessTokenPayload(payload) ? payload : null;
    } catch (error) {
        return handleVerificationError(error, options);
    }
}
