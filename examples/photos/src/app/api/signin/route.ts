// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextRequest, NextResponse } from 'next/server';
import { normaliseReturnUrl } from '@magic-link-sso/nextjs';
import { getDemoScopeForEmail } from '../../login/demo-emails';
import { sendMagicLink } from '../../login/signin';
import { resolveRequestAppOrigin } from '../../login/url';

function acceptsJson(request: NextRequest): boolean {
    const accept = request.headers.get('accept');
    return typeof accept === 'string' && accept.includes('application/json');
}

const signInErrorMessages: Record<string, string> = {
    'invalid-signin-request': 'The sign-in form was incomplete. Please try again.',
    'verify-email-misconfigured': 'This app is missing required SSO verify-email configuration.',
};

function getErrorMessage(errorCode: string): string {
    return (
        signInErrorMessages[errorCode] ?? 'We could not send the sign-in email. Please try again.'
    );
}

function buildLoginRedirect(
    appOrigin: string,
    returnUrl: string,
    scope: string | undefined,
    result: { error?: string; success?: string },
): NextResponse {
    const loginUrl = new URL('/login', appOrigin);
    loginUrl.searchParams.set('returnUrl', returnUrl);
    if (typeof scope === 'string' && scope.length > 0) {
        loginUrl.searchParams.set('scope', scope);
    }
    if (typeof result.error === 'string') {
        loginUrl.searchParams.set('error', result.error);
    }
    if (typeof result.success === 'string') {
        loginUrl.searchParams.set('success', result.success);
    }
    return NextResponse.redirect(loginUrl, 303);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    const formData = await request.formData();
    const appOrigin = resolveRequestAppOrigin(request);
    const email = formData.get('email');
    const verifyUrl = formData.get('verifyUrl');
    const scopeValue = formData.get('scope');
    const returnUrlValue = formData.get('returnUrl');
    const explicitScope =
        typeof scopeValue === 'string' && scopeValue.trim().length > 0
            ? scopeValue.trim()
            : undefined;
    const returnUrl = normaliseReturnUrl(
        typeof returnUrlValue === 'string' ? returnUrlValue : undefined,
        appOrigin,
        appOrigin,
    );

    if (
        typeof email !== 'string' ||
        email.length === 0 ||
        typeof verifyUrl !== 'string' ||
        verifyUrl.length === 0
    ) {
        if (acceptsJson(request)) {
            return NextResponse.json(
                { message: getErrorMessage('invalid-signin-request'), success: false },
                { status: 400 },
            );
        }
        return buildLoginRedirect(appOrigin, returnUrl, explicitScope, {
            error: 'invalid-signin-request',
        });
    }

    const scope = explicitScope ?? getDemoScopeForEmail(email);

    const result = await sendMagicLink(email, returnUrl, verifyUrl, scope);
    if (result.success) {
        if (acceptsJson(request)) {
            return NextResponse.json({
                message: 'Verification email sent',
                ...(typeof result.otpChallengeId === 'string' &&
                typeof result.otpLength === 'number'
                    ? { otpChallengeId: result.otpChallengeId, otpLength: result.otpLength }
                    : {}),
                success: true,
            });
        }
        return buildLoginRedirect(appOrigin, returnUrl, scope, {
            success: 'verification-email-sent',
        });
    }

    if (acceptsJson(request)) {
        return NextResponse.json(
            {
                message: getErrorMessage(result.code ?? 'signin-request-failed'),
                success: false,
            },
            { status: 400 },
        );
    }

    return buildLoginRedirect(appOrigin, returnUrl, scope, {
        error: result.code ?? 'signin-request-failed',
    });
}
