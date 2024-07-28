// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import React from 'react';
import { getAppOrigin } from './url';
import LoginForm from './LoginForm';

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string | string[];
    returnUrl?: string | string[];
    success?: string | string[];
    scope?: string | string[];
  }>;
};

function getLoginErrorMessage(errorCode: string | undefined): string | undefined {
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
    case 'invalid-signin-request':
      return 'The sign-in form was incomplete. Please try again.';
    case 'signin-request-failed':
      return 'We could not send the sign-in email. Please try again.';
    default:
      return undefined;
  }
}

function getLoginSuccessMessage(successCode: string | undefined): string | undefined {
  switch (successCode) {
    case 'verification-email-sent':
      return 'Verification email sent';
    default:
      return undefined;
  }
}

function normaliseReturnUrl(returnUrl: string | undefined, appOrigin: string): string {
  if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
    return appOrigin;
  }
  if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
    return new URL(returnUrl, appOrigin).toString();
  }

  try {
    const parsedUrl = new URL(returnUrl);
    return parsedUrl.origin === appOrigin ? parsedUrl.toString() : appOrigin;
  } catch {
    return appOrigin;
  }
}

export const metadata: Metadata = {
  title: 'Sign In | Magic Link SSO Next.js',
};

export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.JSX.Element> {
  const headerStore = await headers();
  const host = headerStore.get('x-forwarded-host') ?? headerStore.get('host') ?? 'localhost:3001';
  const appOrigin = getAppOrigin(host, headerStore.get('x-forwarded-proto'));
  const resolvedSearchParams = await searchParams;
  const errorValue = resolvedSearchParams?.error;
  const returnUrlValue = resolvedSearchParams?.returnUrl;
  const successValue = resolvedSearchParams?.success;
  const scopeValue = resolvedSearchParams?.scope;
  const requestedError = Array.isArray(errorValue) ? errorValue[0] : errorValue;
  const requestedReturnUrl = Array.isArray(returnUrlValue) ? returnUrlValue[0] : returnUrlValue;
  const requestedSuccess = Array.isArray(successValue) ? successValue[0] : successValue;
  const requestedScope = Array.isArray(scopeValue) ? scopeValue[0] : scopeValue;
  const returnUrl = normaliseReturnUrl(requestedReturnUrl, appOrigin);
  const initialError = getLoginErrorMessage(requestedError);
  const initialSuccess = getLoginSuccessMessage(requestedSuccess);

  return (
    <LoginForm
      returnUrl={returnUrl}
      appOrigin={appOrigin}
      initialError={initialError}
      initialSuccess={initialSuccess}
      scope={requestedScope}
    />
  );
}
