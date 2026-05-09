// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextRequest, NextResponse } from 'next/server';
import { getDemoScopeForEmail } from '../../login/demo-emails';
import { sendMagicLink } from '../../login/signin';
import { resolveAppOrigin } from '../../login/url';

function acceptsJson(request: NextRequest): boolean {
    const accept = request.headers.get('accept');
    return typeof accept === 'string' && accept.includes('application/json');
}

function getErrorMessage(errorCode: string): string {
    switch (errorCode) {
        case 'invalid-signin-request':
            return 'The sign-in form was incomplete. Please try again.';
        case 'verify-email-misconfigured':
            return 'This app is missing required SSO verify-email configuration.';
        case 'signin-request-failed':
        default:
            return 'We could not send the sign-in email. Please try again.';
    }
}

function normaliseReturnUrl(returnUrl: string | null, origin: string): string {
    if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
        return origin;
    }
    if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
        return new URL(returnUrl, origin).toString();
    }

    try {
        const parsedUrl = new URL(returnUrl);
        return parsedUrl.origin === origin ? parsedUrl.toString() : origin;
    } catch {
        return origin;
    }
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
    const appOrigin = resolveAppOrigin({
        explicitPublicOrigin: process.env.MAGICSSO_PUBLIC_ORIGIN,
        fallbackOrigin: request.nextUrl.origin,
        forwardedHost: request.headers.get('x-forwarded-host'),
        forwardedProtocol: request.headers.get('x-forwarded-proto'),
        host: request.headers.get('host'),
    });
    const email = formData.get('email');
    const verifyUrl = formData.get('verifyUrl');
    const scopeValue = formData.get('scope');
    const returnUrlValue = formData.get('returnUrl');
    const explicitScope =
        typeof scopeValue === 'string' && scopeValue.trim().length > 0
            ? scopeValue.trim()
            : undefined;
    const returnUrl = normaliseReturnUrl(
        typeof returnUrlValue === 'string' ? returnUrlValue : null,
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
            return NextResponse.json({ message: 'Verification email sent', success: true });
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
