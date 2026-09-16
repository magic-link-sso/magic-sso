// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { timingSafeEqual } from 'node:crypto';
import {
    defineEventHandler,
    getCookie,
    getRequestURL,
    readBody,
    sendRedirect,
    setCookie,
    type H3Event,
} from 'h3';
import {
    buildLoginUrl,
    getCookieName,
    getJwtSecret,
    getMagicSsoConfig,
    normaliseReturnUrl,
    verifyAuthToken,
} from '../utils/auth';

interface VerifyEmailResponse {
    accessToken: string;
}

interface VerifyEmailBody {
    csrfToken?: string;
    returnUrl?: string;
    token?: string;
}

const verifyCsrfCookieName = 'magic-sso-verify-csrf';

function asVerifyEmailBody(value: unknown): VerifyEmailBody | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }

    const csrfTokenValue = Reflect.get(value, 'csrfToken');
    const returnUrlValue = Reflect.get(value, 'returnUrl');
    const tokenValue = Reflect.get(value, 'token');
    return {
        csrfToken: typeof csrfTokenValue === 'string' ? csrfTokenValue : undefined,
        returnUrl: typeof returnUrlValue === 'string' ? returnUrlValue : undefined,
        token: typeof tokenValue === 'string' ? tokenValue : undefined,
    };
}

function isVerifyEmailResponse(value: unknown): value is VerifyEmailResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'accessToken' in value &&
        typeof value.accessToken === 'string' &&
        value.accessToken.length > 0
    );
}

async function redirectToLogin(event: H3Event, pathname: string): Promise<void> {
    await sendRedirect(event, buildLoginUrl(event, pathname), 303);
}

function clearVerifyCookie(event: H3Event): void {
    setCookie(event, verifyCsrfCookieName, '', {
        path: '/verify-email',
        httpOnly: true,
        maxAge: 0,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
    });
}

function hasValidVerifyCsrfToken(submittedToken: string, cookieToken: string): boolean {
    const submittedBuffer = Buffer.from(submittedToken);
    const cookieBuffer = Buffer.from(cookieToken);
    if (submittedBuffer.length !== cookieBuffer.length) {
        return false;
    }

    return timingSafeEqual(submittedBuffer, cookieBuffer);
}

/** Return the posted verification token when the double-submit CSRF pair matches. */
function readConfirmedToken(event: H3Event, body: VerifyEmailBody | undefined): string | null {
    const token = body?.token;
    const submittedCsrfToken = body?.csrfToken;
    const cookieCsrfToken = getCookie(event, verifyCsrfCookieName);
    if (
        typeof token !== 'string' ||
        token.length === 0 ||
        typeof submittedCsrfToken !== 'string' ||
        typeof cookieCsrfToken !== 'string'
    ) {
        return null;
    }

    return hasValidVerifyCsrfToken(submittedCsrfToken, cookieCsrfToken) ? token : null;
}

/** Exchange a verification token for an access token this app can verify. */
async function exchangeVerificationToken(
    event: H3Event,
    token: string,
    serverUrl: string,
    appOrigin: string,
): Promise<string | null> {
    try {
        const response = await fetch(new URL('/verify-email', serverUrl), {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ token }),
            cache: 'no-store',
        });
        const payload: unknown = response.ok ? await response.json() : null;
        const jwtSecret = getJwtSecret(event);
        if (!isVerifyEmailResponse(payload) || jwtSecret === null) {
            return null;
        }

        const verifiedAccessToken = await verifyAuthToken(payload.accessToken, jwtSecret, {
            expectedAudience: appOrigin,
            expectedIssuer: new URL(serverUrl).origin,
        });
        return verifiedAccessToken === null ? null : payload.accessToken;
    } catch {
        return null;
    }
}

export default defineEventHandler(async (event): Promise<void> => {
    const parsedBody = asVerifyEmailBody(await readBody(event));
    const requestUrl = getRequestURL(event);
    const returnUrl = normaliseReturnUrl(parsedBody?.returnUrl, requestUrl.origin);
    const token = readConfirmedToken(event, parsedBody);
    const config = getMagicSsoConfig(event);
    const accessToken =
        token === null || config.serverUrl.length === 0
            ? null
            : await exchangeVerificationToken(event, token, config.serverUrl, requestUrl.origin);

    clearVerifyCookie(event);
    if (accessToken === null) {
        await redirectToLogin(event, returnUrl);
        return;
    }

    setCookie(event, getCookieName(event), accessToken, {
        path: config.cookiePath,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        ...(typeof config.cookieMaxAge === 'number' ? { maxAge: config.cookieMaxAge } : {}),
    });
    await sendRedirect(event, new URL(returnUrl, requestUrl.origin).toString(), 303);
});
