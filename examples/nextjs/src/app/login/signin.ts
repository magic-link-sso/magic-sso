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

/** Keep the OTP challenge details only when the server returned both of them. */
export function readOtpMetadata(result: {
    otpChallengeId?: string;
    otpLength?: number;
}): Pick<SignInResult, 'otpChallengeId' | 'otpLength'> {
    return typeof result.otpChallengeId === 'string' && typeof result.otpLength === 'number'
        ? { otpChallengeId: result.otpChallengeId, otpLength: result.otpLength }
        : {};
}

export async function sendMagicLink(
    email: string,
    returnUrl: string,
    verifyUrl: string,
    scope?: string,
): Promise<SignInResult> {
    if (!process.env.MAGICSSO_SERVER_URL) {
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

    return { success: true, ...readOtpMetadata(result) };
}
