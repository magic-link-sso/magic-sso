// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import {
    buildLoginTarget as buildMagicSsoLoginTarget,
    buildVerifyUrl as buildMagicSsoVerifyUrl,
    normaliseReturnUrl as normaliseMagicSsoReturnUrl,
} from '@magic-link-sso/angular';

export interface SignInResult {
    message: string;
    success: boolean;
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

export function getLoginErrorMessage(errorCode: string | undefined): string | undefined {
    switch (errorCode) {
        case 'invalid-session':
            return 'Your session could not be verified. Please sign in again.';
        case 'missing-verification-token':
            return 'The sign-in link is incomplete. Please request a new email.';
        case 'session-verification-failed':
            return 'The app could not verify the returned sign-in token. Check that MAGICSSO_JWT_SECRET matches the SSO server.';
        case 'session-verification-misconfigured':
            return 'This app is missing MAGICSSO_JWT_SECRET, so it cannot verify sign-in tokens.';
        case 'verify-email-failed':
            return 'We could not complete sign-in from that email link. Please request a new one.';
        case 'verify-email-misconfigured':
            return 'This app is missing required SSO verify-email configuration.';
        default:
            return undefined;
    }
}

export function normaliseReturnUrl(returnUrl: string | undefined, appOrigin: string): string {
    return normaliseMagicSsoReturnUrl(returnUrl, appOrigin, appOrigin);
}

export function buildVerifyUrl(appOrigin: string, returnUrl: string): string {
    return buildMagicSsoVerifyUrl(appOrigin, returnUrl);
}

function isReturnTarget(value: string): boolean {
    return value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://');
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
