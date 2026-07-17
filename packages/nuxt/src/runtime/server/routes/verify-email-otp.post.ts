// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    createError,
    defineEventHandler,
    getRequestURL,
    readBody,
    setCookie,
    type H3Event,
} from 'h3';
import {
    getCookieName,
    getJwtSecret,
    getMagicSsoConfig,
    hasSameOriginMutationSource,
    readFirstHeaderValue,
    verifyAuthToken,
} from '../utils/auth';

interface OtpVerifyBody {
    challengeId?: string;
    code?: string;
}

interface AccessTokenResponse {
    accessToken: string;
}

function readOtpVerifyBody(value: unknown): OtpVerifyBody | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const challengeId = Reflect.get(value, 'challengeId');
    const code = Reflect.get(value, 'code');
    return typeof challengeId === 'string' && typeof code === 'string'
        ? { challengeId, code }
        : null;
}

function isAccessTokenResponse(value: unknown): value is AccessTokenResponse {
    const accessToken =
        typeof value === 'object' && value !== null ? Reflect.get(value, 'accessToken') : undefined;
    return typeof accessToken === 'string' && accessToken.length > 0;
}

function invalidOtpError(): ReturnType<typeof createError> {
    return createError({ statusCode: 400, statusMessage: 'Invalid or expired code.' });
}

function forbiddenError(): ReturnType<typeof createError> {
    return createError({ statusCode: 403, statusMessage: 'Forbidden' });
}

function hasJsonContentType(event: H3Event): boolean {
    const contentType = readFirstHeaderValue(event.node.req.headers['content-type']);
    return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

export default defineEventHandler(async (event: H3Event): Promise<{ ok: true }> => {
    // This route issues an auth cookie and is only called by same-origin $fetch.
    if (!hasSameOriginMutationSource(event) || !hasJsonContentType(event)) {
        throw forbiddenError();
    }

    const body = readOtpVerifyBody(await readBody(event));
    const config = getMagicSsoConfig(event);
    const jwtSecret = getJwtSecret(event);
    if (body === null || config.serverUrl.length === 0 || jwtSecret === null) {
        throw invalidOtpError();
    }

    try {
        const response = await fetch(new URL('/verify-email/otp', config.serverUrl), {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body),
            cache: 'no-store',
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !isAccessTokenResponse(payload)) {
            throw invalidOtpError();
        }
        const verified = await verifyAuthToken(payload.accessToken, jwtSecret, {
            expectedAudience: getRequestURL(event).origin,
            expectedIssuer: new URL(config.serverUrl).origin,
        });
        if (verified === null) {
            throw invalidOtpError();
        }
        setCookie(event, getCookieName(event), payload.accessToken, {
            path: config.cookiePath,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            ...(typeof config.cookieMaxAge === 'number' ? { maxAge: config.cookieMaxAge } : {}),
        });
        return { ok: true };
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            Reflect.get(error, 'statusCode') === 400
        ) {
            throw error;
        }
        throw invalidOtpError();
    }
});
