/**
 * packages/nextjs/src/lib/auth.ts
 *
 * @license MIT
 *
 * MIT License
 *
 * Magic Link SSO Copyright (C) 2026 Wojciech Polak
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { jwtVerify, type JWTPayload } from 'jose';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

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
    name: string;
    path: string;
    sameSite: 'lax';
    secure: boolean;
    value: string;
}

export function getCookieName(): string {
    return process.env.MAGICSSO_COOKIE_NAME || 'token';
}

export function getCookieMaxAge(): number | undefined {
    const value = process.env.MAGICSSO_COOKIE_MAX_AGE;
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }

    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error('MAGICSSO_COOKIE_MAX_AGE must be a positive integer.');
    }

    return parsedValue;
}

export function getCookiePath(): string {
    const value = process.env.MAGICSSO_COOKIE_PATH;
    if (typeof value !== 'string' || value.trim().length === 0) {
        return '/';
    }

    const normalisedValue = value.trim();
    if (!normalisedValue.startsWith('/')) {
        throw new Error('MAGICSSO_COOKIE_PATH must start with "/".');
    }

    return normalisedValue;
}

export function getJwtSecret(): Uint8Array | null {
    const jwtSecret = process.env.MAGICSSO_JWT_SECRET;
    if (typeof jwtSecret !== 'string' || jwtSecret.length === 0) {
        return null;
    }

    return new TextEncoder().encode(jwtSecret);
}

export function getServerIssuer(): string | null {
    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
        return null;
    }

    try {
        return new URL(serverUrl).origin;
    } catch {
        return null;
    }
}

function readBooleanEnv(value: string | undefined): boolean {
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

export function getPublicOrigin(): string | null {
    const value = process.env.MAGICSSO_PUBLIC_ORIGIN;
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }

    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

export function isTrustProxyEnabled(): boolean {
    return readBooleanEnv(process.env.MAGICSSO_TRUST_PROXY);
}

function readFirstHeaderValue(value: string | null): string | null {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }

    const [firstValue] = value.split(',', 1);
    return typeof firstValue === 'string' && firstValue.length > 0 ? firstValue.trim() : null;
}

async function getRequestOrigin(): Promise<string | null> {
    const publicOrigin = getPublicOrigin();
    if (publicOrigin !== null) {
        return publicOrigin;
    }

    if (!isTrustProxyEnabled()) {
        return null;
    }

    const headerStore = await headers();
    const host =
        readFirstHeaderValue(headerStore.get('x-forwarded-host')) ??
        readFirstHeaderValue(headerStore.get('host'));
    if (host === null) {
        return null;
    }

    const forwardedProtocol = readFirstHeaderValue(headerStore.get('x-forwarded-proto'));
    const protocol =
        forwardedProtocol ??
        (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
    return `${protocol}://${host}`;
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

export async function verifyAuthToken(
    token: string,
    secret: Uint8Array,
    options: VerifyAuthTokenOptions,
): Promise<AuthPayload | null> {
    try {
        const { payload } = await jwtVerify(token, secret, {
            algorithms: ['HS256'],
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

export async function verifyToken(): Promise<AuthPayload | null> {
    const cookieStore = await cookies();
    const token = cookieStore.get(getCookieName())?.value;

    if (!token) {
        return null;
    }

    const secret = getJwtSecret();
    if (secret === null) {
        return null;
    }

    const appOrigin = await getRequestOrigin();
    const issuer = getServerIssuer();
    if (appOrigin === null || issuer === null) {
        return null;
    }

    return verifyAuthToken(token, secret, {
        expectedAudience: appOrigin,
        expectedIssuer: issuer,
    });
}

export function buildAuthCookieOptions(value: string): AuthCookieOptions {
    const maxAge = getCookieMaxAge();

    return {
        name: getCookieName(),
        value,
        path: getCookiePath(),
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        ...(typeof maxAge === 'number' ? { maxAge } : {}),
    };
}

export function redirectToLogin(returnUrl: string, scope?: string): never {
    const loginUrl = new URL('/login', 'http://magic-sso.local');
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (typeof scope === 'string' && scope.trim().length > 0) {
        loginUrl.searchParams.set('scope', scope.trim());
    }
    redirect(`${loginUrl.pathname}${loginUrl.search}`);
}
