// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import { Fragment, type JSX } from 'react';
import Image from 'next/image';
import Script from 'next/script';
import { getScopeDisplayName } from '@/lib/access';

type LoginFormProps = {
  appOrigin: string;
  demoEmails: readonly string[];
  initialError?: string;
  initialSuccess?: string;
  returnUrl: string;
  scope?: string;
};

export default function LoginForm({
  appOrigin,
  demoEmails,
  initialError,
  initialSuccess,
  returnUrl,
  scope,
}: LoginFormProps): JSX.Element {
  const verifyUrl = `${appOrigin}/verify-email?returnUrl=${encodeURIComponent(returnUrl)}`;
  const errorMessage = initialError;
  const hasError = typeof errorMessage === 'string' && errorMessage.length > 0;
  const hasSuccess = typeof initialSuccess === 'string' && initialSuccess.length > 0;
  const feedbackId = hasSuccess || hasError ? 'login-feedback' : undefined;
  const emailDescribedBy = hasError ? 'login-help login-feedback' : 'login-help';
  const scopeSummary =
    typeof scope === 'string' && scope.length > 0 ? getScopeDisplayName(scope) : undefined;

  return (
    <main className="login-shell">
      <a href="#login-panel" className="skip-link">
        Skip to sign-in form
      </a>
      <section id="login-panel" aria-labelledby="login-title" className="login-panel">
        <Image
          src="/art/signin-constellation.svg"
          alt="Abstract constellation artwork"
          className="login-crest"
          width={480}
          height={480}
          unoptimized
        />
        <p className="eyebrow">Sign In</p>
        <h1 id="login-title" className="login-title" data-login-title>
          {hasSuccess ? 'Check your email' : 'Unlock the next album with Magic Link SSO.'}
        </h1>
        <p id="login-help" className="login-copy" data-login-help>
          {hasSuccess
            ? 'If your email can sign in, you will receive a link shortly. Open the email and click the link to continue.'
            : "We'll email a sign-in link and return you to the exact page you asked for."}
        </p>
        <p className="login-tip">
          Demo tip: try{' '}
          {demoEmails.map((email, index) => (
            <Fragment key={email}>
              <strong>{email}</strong>
              {index < demoEmails.length - 2
                ? ', '
                : index === demoEmails.length - 2
                  ? ', or '
                  : ''}
            </Fragment>
          ))}
          . On this generic sign-in page, the demo will automatically map the seeded friend and
          family emails to their matching access levels.
        </p>
        {typeof scopeSummary === 'string' && (
          <p className="scope-hint">Requested access level: {scopeSummary}</p>
        )}

        <form
          action="/api/signin"
          method="post"
          aria-describedby="login-help"
          className="login-form"
          data-login-form
          hidden={hasSuccess}
        >
          <label htmlFor="email" className="field-label">
            Email
          </label>
          <input
            id="email"
            type="email"
            name="email"
            placeholder="you@example.com"
            autoFocus
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            aria-describedby={emailDescribedBy}
            aria-invalid={hasError}
            required
            className="field-input"
          />
          <input type="hidden" name="returnUrl" value={returnUrl} />
          <input type="hidden" name="verifyUrl" value={verifyUrl} />
          {typeof scope === 'string' && scope.length > 0 && (
            <input type="hidden" name="scope" value={scope} />
          )}
          <div className="login-actions">
            <button
              type="submit"
              className="button button-primary button-submit button-block"
              data-submit-button
            >
              <span aria-hidden="true" className="button-spinner" data-submit-spinner />
              <span data-submit-label>Send magic link</span>
            </button>
          </div>
        </form>
        <form
          action="/api/verify-email/otp"
          method="post"
          aria-describedby="otp-help"
          className="login-form"
          data-otp-form
          hidden
        >
          <label htmlFor="otp-code" className="field-label">
            One-time code
          </label>
          <p id="otp-help" className="login-copy">
            Enter the code from your email to finish signing in.
          </p>
          <input
            id="otp-code"
            type="text"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-describedby="otp-help"
            required
            className="field-input"
            data-otp-code
          />
          <input type="hidden" name="challengeId" data-otp-challenge />
          <input type="hidden" name="returnUrl" value={returnUrl} />
          <div className="login-actions">
            <button type="submit" className="button button-primary button-submit button-block">
              Sign in with code
            </button>
            <button type="button" className="button button-secondary" data-use-different-email>
              Use a different email
            </button>
          </div>
        </form>
        <div data-confirmation role="status" aria-live="polite" hidden={!hasSuccess}>
          <div className="login-actions">
            <button
              type="button"
              className="button button-secondary"
              data-use-different-email-no-otp
            >
              Use a different email
            </button>
          </div>
        </div>
        {hasError && (
          <p id={feedbackId} role="alert" className="message message-error">
            {errorMessage}
          </p>
        )}
        <Script id="login-form-enhancements" strategy="afterInteractive">
          {`
const form = document.querySelector('[data-login-form]');
const submitButton = document.querySelector('[data-submit-button]');
const spinner = document.querySelector('[data-submit-spinner]');
const label = document.querySelector('[data-submit-label]');
const otpForm = document.querySelector('[data-otp-form]');
const otpChallenge = document.querySelector('[data-otp-challenge]');
const otpCode = document.querySelector('[data-otp-code]');
const useDifferentEmailButton = document.querySelector('[data-use-different-email]');
const useDifferentEmailNoOtpButton = document.querySelector('[data-use-different-email-no-otp]');
const confirmation = document.querySelector('[data-confirmation]');
const title = document.querySelector('[data-login-title]');
const help = document.querySelector('[data-login-help]');
const feedbackId = 'login-feedback';

function showEmailForm() {
  if (form instanceof HTMLFormElement) form.hidden = false;
  if (otpForm instanceof HTMLFormElement) otpForm.hidden = true;
  if (confirmation instanceof HTMLElement) confirmation.hidden = true;
  if (title instanceof HTMLElement) title.textContent = 'Unlock the next album with Magic Link SSO.';
  if (help instanceof HTMLElement) {
    help.textContent = "We'll email a sign-in link and return you to the exact page you asked for.";
  }
  const emailInput = form?.querySelector('#email');
  if (emailInput instanceof HTMLInputElement) emailInput.focus();
}

function showConfirmation(challengeId, otpLength) {
  if (form instanceof HTMLFormElement) form.hidden = true;
  if (title instanceof HTMLElement) title.textContent = 'Check your email';
  if (help instanceof HTMLElement) {
    help.textContent = 'If your email can sign in, you will receive a link shortly. Open the email and click the link to continue.';
  }
  if (challengeId !== null && otpForm instanceof HTMLFormElement && otpChallenge instanceof HTMLInputElement) {
    otpChallenge.value = challengeId;
    otpForm.hidden = false;
    if (confirmation instanceof HTMLElement) confirmation.hidden = true;
    if (otpCode instanceof HTMLInputElement) {
      otpCode.minLength = otpLength;
      otpCode.maxLength = otpLength;
      otpCode.placeholder = otpLength === 6 ? '123456' : '';
      otpCode.focus();
    }
    return;
  }
  if (otpForm instanceof HTMLFormElement) otpForm.hidden = true;
  if (confirmation instanceof HTMLElement) confirmation.hidden = false;
}

function ensureFeedbackElement() {
  const existing = document.getElementById(feedbackId);
  if (existing instanceof HTMLParagraphElement) {
    return existing;
  }

  const panel = form?.parentElement;
  if (!(panel instanceof HTMLElement)) {
    return null;
  }

  const message = document.createElement('p');
  message.id = feedbackId;
  message.hidden = true;
  panel.append(message);
  return message;
}

if (
  form instanceof HTMLFormElement &&
  submitButton instanceof HTMLButtonElement &&
  spinner instanceof HTMLElement &&
  label instanceof HTMLElement
) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    submitButton.setAttribute('aria-disabled', 'true');
    spinner.classList.add('button-spinner-visible');
    label.textContent = 'Sending magic link...';
    const feedback = ensureFeedbackElement();

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: {
          accept: 'application/json',
        },
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && feedback instanceof HTMLParagraphElement) {
        feedback.hidden = true;
      }
      if (!response.ok && feedback instanceof HTMLParagraphElement) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'message' in payload &&
          typeof payload.message === 'string'
            ? payload.message
            : 'We could not send the sign-in email. Please try again.';
        feedback.hidden = false;
        feedback.textContent = message;
        feedback.setAttribute('role', 'alert');
        feedback.setAttribute('aria-live', 'assertive');
        feedback.className = 'message message-error';
      }

      if (response.ok) {
        const emailInput = form.querySelector('#email');
        if (emailInput instanceof HTMLInputElement) {
          emailInput.value = '';
        }
        const challengeId =
          typeof payload === 'object' && payload !== null &&
          'otpChallengeId' in payload && typeof payload.otpChallengeId === 'string'
            ? payload.otpChallengeId
            : null;
        const otpLength =
          typeof payload === 'object' && payload !== null &&
          'otpLength' in payload && Number.isInteger(payload.otpLength) && payload.otpLength > 0
            ? payload.otpLength
            : 6;
        showConfirmation(challengeId, otpLength);
      }
    } catch {
      if (feedback instanceof HTMLParagraphElement) {
        feedback.hidden = false;
        feedback.textContent = 'We could not send the sign-in email. Please try again.';
        feedback.setAttribute('role', 'alert');
        feedback.setAttribute('aria-live', 'assertive');
        feedback.className = 'message message-error';
      }
    } finally {
      submitButton.disabled = false;
      submitButton.setAttribute('aria-disabled', 'false');
      spinner.classList.remove('button-spinner-visible');
      label.textContent = 'Send magic link';
    }
  });
}

if (
  form instanceof HTMLFormElement &&
  otpForm instanceof HTMLFormElement &&
  otpChallenge instanceof HTMLInputElement &&
  useDifferentEmailButton instanceof HTMLButtonElement
) {
  useDifferentEmailButton.addEventListener('click', () => {
    otpChallenge.value = '';
    if (otpCode instanceof HTMLInputElement) otpCode.value = '';
    const feedback = document.getElementById(feedbackId);
    if (feedback instanceof HTMLParagraphElement) feedback.hidden = true;
    showEmailForm();
  });
}

if (useDifferentEmailNoOtpButton instanceof HTMLButtonElement) {
  useDifferentEmailNoOtpButton.addEventListener('click', () => {
    const feedback = document.getElementById(feedbackId);
    if (feedback instanceof HTMLParagraphElement) feedback.hidden = true;
    showEmailForm();
  });
}

if (otpForm instanceof HTMLFormElement) {
  otpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch(otpForm.action, {
      method: 'POST',
      body: new FormData(otpForm),
      headers: { accept: 'application/json' },
    });
    if (response.ok) {
      const returnUrl = otpForm.querySelector('input[name="returnUrl"]');
      if (returnUrl instanceof HTMLInputElement) window.location.assign(returnUrl.value);
      return;
    }
    const feedback = ensureFeedbackElement();
    if (feedback instanceof HTMLParagraphElement) {
      feedback.hidden = false;
      feedback.textContent = 'Invalid or expired code.';
      feedback.setAttribute('role', 'alert');
      feedback.className = 'message message-error';
    }
  });
}
`}
        </Script>
      </section>
    </main>
  );
}
