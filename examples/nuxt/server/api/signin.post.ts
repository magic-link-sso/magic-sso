// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { createError, getRequestURL, readBody } from 'h3';
import { buildFailureResult, readMessage, readServerUrlConfigError } from './signin';

interface SignInRequestBody {
    email?: string;
    returnUrl?: string;
    scope?: string;
    verifyUrl?: string;
}

interface SignInResult {
    success: boolean;
    message: string;
}

function getServerUrl(magicSsoConfig: unknown): string {
    if (
        typeof magicSsoConfig === 'object' &&
        magicSsoConfig !== null &&
        'serverUrl' in magicSsoConfig &&
        typeof magicSsoConfig.serverUrl === 'string' &&
        magicSsoConfig.serverUrl.length > 0
    ) {
        return magicSsoConfig.serverUrl;
    }

    const fallbackServerUrl = process.env.MAGICSSO_SERVER_URL ?? process.env.APP_URL;
    return typeof fallbackServerUrl === 'string' ? fallbackServerUrl : '';
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export default defineEventHandler(async (event): Promise<SignInResult> => {
    const body = await readBody<SignInRequestBody>(event);
    if (
        !isNonEmptyString(body.email) ||
        !isNonEmptyString(body.returnUrl) ||
        !isNonEmptyString(body.verifyUrl)
    ) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Invalid sign-in request payload.',
        });
    }

    const runtimeConfig = useRuntimeConfig(event);
    const serverUrl = getServerUrl(runtimeConfig.magicSso);
    if (serverUrl.length === 0) {
        return {
            success: false,
            message: 'MAGICSSO_SERVER_URL is not configured.',
        };
    }

    const serverUrlConfigError = readServerUrlConfigError(serverUrl, getRequestURL(event).origin);
    if (typeof serverUrlConfigError === 'string') {
        return {
            success: false,
            message: serverUrlConfigError,
        };
    }

    try {
        const response = await fetch(`${serverUrl}/signin`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                email: body.email,
                returnUrl: body.returnUrl,
                verifyUrl: body.verifyUrl,
                ...(typeof body.scope === 'string' && body.scope.trim().length > 0
                    ? { scope: body.scope.trim() }
                    : {}),
            }),
        });

        if (!response.ok) {
            const payload: unknown = await response.json().catch(async () => ({
                message: await response.text().catch(() => ''),
            }));
            return {
                success: false,
                message: buildFailureResult(payload).message,
            };
        }

        return {
            success: true,
            message: 'Verification email sent.',
        };
    } catch (error: unknown) {
        const message = readMessage(error);

        return {
            success: false,
            message: message ?? 'Failed to send verification email.',
        };
    }
});
