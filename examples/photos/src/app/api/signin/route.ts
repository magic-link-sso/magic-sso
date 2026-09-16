// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { NextRequest, NextResponse } from 'next/server';
import { normaliseReturnUrl } from '@magic-link-sso/nextjs';
import { getDemoScopeForEmail } from '../../login/demo-emails';
import { readOtpMetadata, sendMagicLink, type SignInResult } from '../../login/signin';
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
    for (const [name, value] of Object.entries({ scope, ...result })) {
        if (typeof value === 'string' && value.length > 0) {
            loginUrl.searchParams.set(name, value);
        }
    }
    return NextResponse.redirect(loginUrl, 303);
}

interface SignInOutcome {
    body: Record<string, unknown>;
    redirect: { error?: string; success?: string };
    status: number;
}

function readFormText(formData: FormData, name: string): string | undefined {
    const value = formData.get(name);
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function failedSignIn(code: string): SignInOutcome {
    return {
        body: { message: getErrorMessage(code), success: false },
        redirect: { error: code },
        status: 400,
    };
}

function signInOutcomeFor(result: SignInResult): SignInOutcome {
    if (!result.success) {
        return failedSignIn(result.code ?? 'signin-request-failed');
    }

    return {
        body: { message: 'Verification email sent', ...readOtpMetadata(result), success: true },
        redirect: { success: 'verification-email-sent' },
        status: 200,
    };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    const appOrigin = resolveRequestAppOrigin(request);
    const formData = await request.formData();
    const email = readFormText(formData, 'email');
    const verifyUrl = readFormText(formData, 'verifyUrl');
    const explicitScope = readFormText(formData, 'scope')?.trim();
    const returnUrl = normaliseReturnUrl(readFormText(formData, 'returnUrl'), appOrigin, appOrigin);
    const respond = (outcome: SignInOutcome, scope: string | undefined): NextResponse =>
        acceptsJson(request)
            ? NextResponse.json(outcome.body, { status: outcome.status })
            : buildLoginRedirect(appOrigin, returnUrl, scope, outcome.redirect);

    if (typeof email !== 'string' || typeof verifyUrl !== 'string') {
        return respond(failedSignIn('invalid-signin-request'), explicitScope);
    }

    const scope = explicitScope ?? getDemoScopeForEmail(email);
    const result = await sendMagicLink(email, returnUrl, verifyUrl, scope);
    return respond(signInOutcomeFor(result), scope);
}
