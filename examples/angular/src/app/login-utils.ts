// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    buildLoginTarget as buildMagicSsoLoginTarget,
    buildVerifyUrl as buildMagicSsoVerifyUrl,
    normaliseReturnUrl as normaliseMagicSsoReturnUrl,
} from '@magic-link-sso/angular';

export interface SignInResult {
    message: string;
    otpChallengeId?: string;
    otpLength?: number;
    success: boolean;
}

export interface SignInOutcome {
    otpChallengeId: string | null;
    otpLength: number;
    result: SignInResult;
}

function readPayloadField(payload: unknown, field: string): unknown {
    return typeof payload === 'object' && payload !== null
        ? Reflect.get(payload, field)
        : undefined;
}

/** Interpret the `/api/signin` response, including any OTP challenge it started. */
export function readSignInOutcome(ok: boolean, payload: unknown): SignInOutcome {
    const message = readPayloadField(payload, 'message');
    const serverMessage = typeof message === 'string' ? message : undefined;
    const otpChallengeId = readPayloadField(payload, 'otpChallengeId');
    const otpLength = readPayloadField(payload, 'otpLength');

    return {
        otpChallengeId: ok && typeof otpChallengeId === 'string' ? otpChallengeId : null,
        otpLength: typeof otpLength === 'number' ? otpLength : 6,
        result: ok
            ? { success: true, message: serverMessage ?? 'Verification email sent.' }
            : { success: false, message: serverMessage ?? 'Failed to send verification email.' },
    };
}

export function isAbsoluteHttpUrl(value: string): boolean {
    return value.startsWith('http://') || value.startsWith('https://');
}

export function getAppOrigin(request: Request | null | undefined): string {
    if (request instanceof Request) {
        return new URL(request.url).origin;
    }
    if (typeof location === 'object' && typeof location.origin === 'string') {
        return location.origin;
    }

    return 'http://localhost:3004';
}

const loginErrorMessages: Record<string, string> = {
    'invalid-session': 'Your session could not be verified. Please sign in again.',
    'missing-verification-token': 'The sign-in link is incomplete. Please request a new email.',
    'session-verification-failed':
        'The app could not verify the returned sign-in token. Check that MAGICSSO_JWT_SECRET matches the SSO server.',
    'session-verification-misconfigured':
        'This app is missing MAGICSSO_JWT_SECRET, so it cannot verify sign-in tokens.',
    'verify-email-failed':
        'We could not complete sign-in from that email link. Please request a new one.',
    'verify-email-misconfigured': 'This app is missing required SSO verify-email configuration.',
};

export function getLoginErrorMessage(errorCode: string | undefined): string | undefined {
    return typeof errorCode === 'string' ? loginErrorMessages[errorCode] : undefined;
}

export function normaliseReturnUrl(returnUrl: string | undefined, appOrigin: string): string {
    return normaliseMagicSsoReturnUrl(returnUrl, appOrigin, appOrigin);
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    return buildMagicSsoVerifyUrl(appOrigin, returnUrl);
}

function isReturnTarget(value: string): boolean {
    return value.startsWith('/') || isAbsoluteHttpUrl(value);
}

export function buildLoginTarget(
    appOrigin: string,
    returnTargetOrScope?: string,
    scope?: string,
): string {
    const hasExplicitReturnTarget =
        typeof scope === 'string' ||
        (typeof returnTargetOrScope === 'string' && isReturnTarget(returnTargetOrScope));
    const returnTarget =
        hasExplicitReturnTarget && typeof returnTargetOrScope === 'string'
            ? returnTargetOrScope
            : '/';
    const resolvedScope =
        typeof scope === 'string'
            ? scope
            : hasExplicitReturnTarget
              ? undefined
              : returnTargetOrScope;

    return buildMagicSsoLoginTarget(
        appOrigin,
        returnTarget,
        {
            loginPath: '/login',
        },
        resolvedScope,
    );
}
