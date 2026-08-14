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
import { exchangeEmailOtp } from '@magic-link-sso/core';
import {
    getCookieName,
    getJwtSecret,
    getMagicSsoConfig,
    hasSameOriginMutationSource,
    readFirstHeaderValue,
} from '../utils/auth';

interface OtpVerifyBody {
    challengeId?: string;
    code?: string;
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
    if (
        body === null ||
        typeof body.challengeId !== 'string' ||
        typeof body.code !== 'string' ||
        config.serverUrl.length === 0 ||
        jwtSecret === null
    ) {
        throw invalidOtpError();
    }

    try {
        const result = await exchangeEmailOtp({
            challengeId: body.challengeId,
            code: body.code,
            expectedAudience: getRequestURL(event).origin,
            expectedIssuer: new URL(config.serverUrl).origin,
            fetcher: fetch,
            secret: jwtSecret,
            serverUrl: config.serverUrl,
        });
        if (result.kind !== 'success') {
            throw invalidOtpError();
        }
        setCookie(event, getCookieName(event), result.accessToken, {
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
