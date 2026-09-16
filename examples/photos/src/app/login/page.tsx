// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { normaliseReturnUrl } from '@magic-link-sso/nextjs';
import React from 'react';
import { getDemoEmailsFromEnv } from './demo-emails';
import { resolveAppOrigin } from './url';
import { firstSearchParam, lookupMessage } from './form-state';
import LoginForm from './LoginForm';

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string | string[];
    returnUrl?: string | string[];
    success?: string | string[];
    scope?: string | string[];
  }>;
};

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
  'invalid-signin-request': 'The sign-in form was incomplete. Please try again.',
  'signin-request-failed': 'We could not send the sign-in email. Please try again.',
};

const loginSuccessMessages: Record<string, string> = {
  'verification-email-sent': 'Verification email sent',
};

export const metadata: Metadata = {
  title: 'Sign In | Magic Link SSO Photos Demo',
};

export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.JSX.Element> {
  const headerStore = await headers();
  const appOrigin = resolveAppOrigin({
    explicitPublicOrigin: process.env.MAGICSSO_PUBLIC_ORIGIN,
    forwardedHost: headerStore.get('x-forwarded-host'),
    forwardedProtocol: headerStore.get('x-forwarded-proto'),
    host: headerStore.get('host'),
  });
  const params = (await searchParams) ?? {};
  const returnUrl = normaliseReturnUrl(firstSearchParam(params.returnUrl), appOrigin, appOrigin);
  const initialError = lookupMessage(loginErrorMessages, firstSearchParam(params.error));
  const initialSuccess = lookupMessage(loginSuccessMessages, firstSearchParam(params.success));
  const requestedScope = firstSearchParam(params.scope);
  const demoEmails = getDemoEmailsFromEnv();

  return (
    <LoginForm
      returnUrl={returnUrl}
      appOrigin={appOrigin}
      demoEmails={demoEmails}
      initialError={initialError}
      initialSuccess={initialSuccess}
      scope={requestedScope}
    />
  );
}
