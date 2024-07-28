/**
 * packages/nextjs/src/authMiddleware.ts
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

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
    getCookieName,
    getCookiePath,
    getJwtSecret,
    getPublicOrigin,
    getServerIssuer,
    isTrustProxyEnabled,
    verifyAuthToken,
} from './lib/auth';

const DEFAULT_EXCLUDED_PATHS = [
    '/',
    '/login',
    '/logout',
    '/verify-email',
    '/public',
    '/_next',
    '/favicon.ico',
];

export interface AuthMiddlewareOptions {
    excludedPaths?: readonly string[];
}

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

function readFirstHeaderValue(value: string | null): string | null {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }

    const [firstValue] = value.split(',', 1);
    return typeof firstValue === 'string' && firstValue.length > 0 ? firstValue.trim() : null;
}

export function getExcludedPaths(options?: AuthMiddlewareOptions): readonly string[] {
    const configuredPaths = options?.excludedPaths;
    if (typeof configuredPaths === 'undefined') {
        return DEFAULT_EXCLUDED_PATHS;
    }

    return configuredPaths;
}

export function isPublicPath(pathname: string, options?: AuthMiddlewareOptions): boolean {
    return getExcludedPaths(options).some(
        (path) => pathname === path || pathname.startsWith(`${path}/`),
    );
}

export function buildLoginUrl(request: NextRequest, pathname: string, scope?: string): URL {
    return buildLoginUrlWithError(request, pathname, undefined, scope);
}

function getExpectedAudience(request: NextRequest): string | null {
    const publicOrigin = getPublicOrigin();
    if (publicOrigin !== null) {
        return publicOrigin;
    }

    if (!isTrustProxyEnabled()) {
        return null;
    }

    const forwardedHost = readFirstHeaderValue(request.headers.get('x-forwarded-host'));
    const host =
        forwardedHost ?? readFirstHeaderValue(request.headers.get('host')) ?? request.nextUrl.host;
    if (host.length === 0) {
        return null;
    }

    const forwardedProtocol = readFirstHeaderValue(request.headers.get('x-forwarded-proto'));
    const protocol = forwardedProtocol ?? request.nextUrl.protocol.slice(0, -1);
    return `${protocol}://${host}`;
}

function buildLoginUrlWithError(
    request: NextRequest,
    pathname: string,
    error?: string,
    scope?: string,
): URL {
    const returnUrl = `${request.nextUrl.origin}${pathname}`;
    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';
    if (isDirectUseEnabled(process.env.MAGICSSO_DIRECT_USE)) {
        const loginUrl = new URL('/signin', process.env.MAGICSSO_SERVER_URL);
        loginUrl.searchParams.set('returnUrl', returnUrl);
        if (normalizedScope.length > 0) {
            loginUrl.searchParams.set('scope', normalizedScope);
        }
        const verifyUrl = new URL('/verify-email', request.nextUrl.origin);
        verifyUrl.searchParams.set('returnUrl', returnUrl);
        loginUrl.searchParams.set('verifyUrl', verifyUrl.toString());
        if (typeof error === 'string') {
            loginUrl.searchParams.set('error', error);
        }
        return loginUrl;
    }

    const loginUrl = new URL('/login', request.nextUrl.origin);
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (normalizedScope.length > 0) {
        loginUrl.searchParams.set('scope', normalizedScope);
    }
    if (typeof error === 'string') {
        loginUrl.searchParams.set('error', error);
    }
    return loginUrl;
}

export async function authMiddleware(
    request: NextRequest,
    options?: AuthMiddlewareOptions,
): Promise<NextResponse> {
    const { pathname } = request.nextUrl;

    if (isPublicPath(pathname, options)) {
        return NextResponse.next();
    }

    const token = request.cookies.get(getCookieName())?.value;

    if (!token) {
        return redirectToLogin(request, pathname);
    }

    const secret = getJwtSecret();
    if (secret === null) {
        return redirectToLogin(request, pathname, 'session-verification-misconfigured');
    }

    const issuer = getServerIssuer();
    if (issuer === null) {
        return redirectToLogin(request, pathname, 'session-verification-misconfigured');
    }

    const expectedAudience = getExpectedAudience(request);
    if (expectedAudience === null) {
        return redirectToLogin(request, pathname, 'session-verification-misconfigured');
    }

    const payload = await verifyAuthToken(token, secret, {
        expectedAudience,
        expectedIssuer: issuer,
    });
    return payload === null
        ? redirectToLogin(request, pathname, 'invalid-session')
        : NextResponse.next();
}

function redirectToLogin(request: NextRequest, pathname: string, error?: string): NextResponse {
    const response = NextResponse.redirect(buildLoginUrlWithError(request, pathname, error));
    if (typeof error === 'string') {
        response.cookies.set({
            name: getCookieName(),
            value: '',
            path: getCookiePath(),
            maxAge: 0,
        });
    }
    return response;
}
