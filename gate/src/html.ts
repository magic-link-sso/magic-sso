// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { escapeHtml } from '@magic-link-sso/config-core/runtime';

export interface LoginPageMessage {
    kind: 'error' | 'success';
    text: string;
}

export interface LoginPageOptions {
    backUrl: string;
    loginAction: string;
    isConfirmation: boolean;
    message: LoginPageMessage | undefined;
    otpChallengeId: string | undefined;
    otpLength: number | undefined;
    otpSubmitAction: string;
    returnUrl: string;
    signinBadgePath: string;
    stylesPath: string;
    title: string;
    useDifferentEmailUrl: string;
}

export interface VerifyEmailConfirmationPageOptions {
    csrfToken: string;
    email: string;
    returnUrl: string;
    scriptPath: string;
    signinBadgePath: string;
    stylesPath: string;
    submitAction: string;
}

function buildDocument(title: string, stylesPath: string, body: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${escapeHtml(stylesPath)}" />
  </head>
  <body>${body}</body>
</html>`;
}

function renderMessage(message: LoginPageMessage | undefined): string {
    if (typeof message === 'undefined' || message.kind === 'success') {
        return '';
    }

    return `<p id="signin-feedback" class="message message-error" role="alert">${escapeHtml(message.text)}</p>`;
}

export function renderLoginPage(options: LoginPageOptions): string {
    const hasOtpChallenge = typeof options.otpChallengeId === 'string';
    const helpText = options.isConfirmation
        ? 'If your email can sign in, you will receive a link shortly. Open the email and click the link to continue.'
        : 'We&apos;ll email you a sign-in link before the upstream app is ever reached.';
    const form = options.isConfirmation
        ? `<div class="confirmation-panel" role="status" aria-live="polite">
      ${
          hasOtpChallenge
              ? `<form class="login-form" aria-describedby="otp-help" action="${escapeHtml(options.otpSubmitAction)}" method="post" referrerpolicy="same-origin">
      <label class="field-label" for="otp-code">One-time code</label>
      <input id="otp-code" class="field-input" type="text" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" minlength="${options.otpLength}" maxlength="${options.otpLength}" ${options.otpLength === 6 ? 'placeholder="123456"' : ''} aria-describedby="otp-help" required />
      <p id="otp-help" class="login-copy">You can also enter the one-time code from the email here.</p>
      <div class="login-actions">
        <button class="button button-primary button-submit button-block" type="submit">Sign in with code</button>
      </div>
    </form>`
              : ''
      }
      <div class="login-actions">
        <a href="${escapeHtml(options.useDifferentEmailUrl)}" class="button button-secondary">Use a different email</a>
      </div>
    </div>`
        : `<form class="login-form" aria-describedby="signin-help" action="${escapeHtml(options.loginAction)}" method="post" referrerpolicy="same-origin">
      <label class="field-label" for="email">Email</label>
      <input
        id="email"
        class="field-input"
        type="email"
        name="email"
        autocomplete="email"
        inputmode="email"
        placeholder="you@example.com"
        spellcheck="false"
        required
      />
      <input type="hidden" name="returnUrl" value="${escapeHtml(options.returnUrl)}" />
      <div class="login-actions">
        <button class="button button-primary button-submit button-block" type="submit">Send magic link</button>
        <a href="${escapeHtml(options.backUrl)}" class="button button-secondary">Back</a>
      </div>
    </form>`;

    return buildDocument(
        options.title,
        options.stylesPath,
        `<main class="login-shell">
  <a class="skip-link" href="#login-panel">Skip to sign-in form</a>
  <section id="login-panel" class="login-panel" aria-labelledby="login-title">
    <img src="${escapeHtml(options.signinBadgePath)}" alt="Sign-in flow badge" class="badge login-badge" width="144" height="144" />
    <p class="eyebrow">Magic Link SSO Gate</p>
    <h1 id="login-title" class="login-title">${options.isConfirmation ? 'Check your email' : 'Sign in'}</h1>
    <p id="signin-help" class="login-copy">${helpText}</p>
    ${renderMessage(options.message)}
    ${form}
  </section>
</main>`,
    );
}

export function renderVerifyEmailConfirmationPage(
    options: VerifyEmailConfirmationPageOptions,
): string {
    return buildDocument(
        'Confirm Sign In | Magic Link SSO Gate',
        options.stylesPath,
        `<main class="login-shell">
  <section id="verify-email-panel" class="login-panel" aria-labelledby="verify-email-title">
    <img src="${escapeHtml(options.signinBadgePath)}" alt="Sign-in flow badge" class="badge login-badge" width="144" height="144" />
    <p class="eyebrow">Verify Email</p>
    <h1 id="verify-email-title" class="login-title">Continue sign-in</h1>
    <p class="login-copy">Review the email address below, then continue to finish signing in.</p>
    <form class="login-form" method="post" action="${escapeHtml(options.submitAction)}" referrerpolicy="same-origin">
      <p id="email-label" class="field-label">Email</p>
      <p id="email-value" class="field-value" aria-labelledby="email-label">${escapeHtml(options.email)}</p>
      <input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}" />
      <input type="hidden" name="returnUrl" value="${escapeHtml(options.returnUrl)}" />
      <div class="login-actions">
        <button class="button button-primary button-submit button-block" type="submit">Continue</button>
      </div>
    </form>
  </section>
</main>
<script src="${escapeHtml(options.scriptPath)}"></script>`,
    );
}
