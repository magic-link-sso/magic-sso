// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { sendMagicLink as requestMagicLink } from '@magic-link-sso/nextjs';

export interface SignInResult {
    code?: string;
    message?: string;
    otpChallengeId?: string;
    otpLength?: number;
    success: boolean;
}

export async function sendMagicLink(
    email: string,
    returnUrl: string,
    verifyUrl: string,
    scope?: string,
): Promise<SignInResult> {
    const serverUrl = process.env.MAGICSSO_SERVER_URL;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
        return {
            success: false,
            code: 'verify-email-misconfigured',
            message: 'MAGICSSO_SERVER_URL is not configured.',
        };
    }

    const result = await requestMagicLink(email, returnUrl, scope, { verifyUrl });
    if (!result.success) {
        console.error('Error sending magic link:', { message: result.message });
        return {
            success: false,
            code: 'signin-request-failed',
            message: result.message,
        };
    }

    return {
        success: true,
        ...(typeof result.otpChallengeId === 'string' && typeof result.otpLength === 'number'
            ? { otpChallengeId: result.otpChallengeId, otpLength: result.otpLength }
            : {}),
    };
}
