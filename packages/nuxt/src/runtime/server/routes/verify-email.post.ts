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

export default defineEventHandler(async (event): Promise<void> => {
    const body = (await readBody(event)) as unknown;
    const requestUrl = getRequestURL(event);
    const parsedBody = asVerifyEmailBody(body);
    const token = typeof parsedBody?.token === 'string' ? parsedBody.token : undefined;
    const submittedCsrfToken =
        typeof parsedBody?.csrfToken === 'string' ? parsedBody.csrfToken : undefined;
    const returnUrl = normaliseReturnUrl(
        typeof parsedBody?.returnUrl === 'string' ? parsedBody.returnUrl : undefined,
        requestUrl.origin,
    );
    const cookieCsrfToken = getCookie(event, verifyCsrfCookieName);

    if (
        typeof token !== 'string' ||
        token.length === 0 ||
        typeof submittedCsrfToken !== 'string' ||
        typeof cookieCsrfToken !== 'string' ||
        !hasValidVerifyCsrfToken(submittedCsrfToken, cookieCsrfToken)
    ) {
        clearVerifyCookie(event);
        await redirectToLogin(event, returnUrl);
        return;
    }

    const config = getMagicSsoConfig(event);
    if (config.serverUrl.length === 0) {
        clearVerifyCookie(event);
        await redirectToLogin(event, returnUrl);
        return;
    }

    const verifyUrl = new URL('/verify-email', config.serverUrl);

    try {
        const response = await fetch(verifyUrl, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ token }),
            cache: 'no-store',
        });
        if (!response.ok) {
            clearVerifyCookie(event);
            await redirectToLogin(event, returnUrl);
            return;
        }

        const payload: unknown = await response.json();
        if (!isVerifyEmailResponse(payload)) {
            clearVerifyCookie(event);
            await redirectToLogin(event, returnUrl);
            return;
        }

        const jwtSecret = getJwtSecret(event);
        if (jwtSecret === null) {
            clearVerifyCookie(event);
            await redirectToLogin(event, returnUrl);
            return;
        }

        const verifiedAccessToken = await verifyAuthToken(payload.accessToken, jwtSecret, {
            expectedAudience: requestUrl.origin,
            expectedIssuer: new URL(config.serverUrl).origin,
        });
        if (verifiedAccessToken === null) {
            clearVerifyCookie(event);
            await redirectToLogin(event, returnUrl);
            return;
        }

        clearVerifyCookie(event);
        setCookie(event, getCookieName(event), payload.accessToken, {
            path: config.cookiePath,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            ...(typeof config.cookieMaxAge === 'number' ? { maxAge: config.cookieMaxAge } : {}),
        });
        await sendRedirect(event, new URL(returnUrl, requestUrl.origin).toString(), 303);
    } catch {
        clearVerifyCookie(event);
        await redirectToLogin(event, returnUrl);
    }
});
