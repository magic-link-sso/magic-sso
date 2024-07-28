// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { JSX } from 'react';
import Image from 'next/image';
import Script from 'next/script';
import { signinBadgeUrl } from 'magic-sso-example-ui';

type LoginFormProps = {
  returnUrl: string;
  appOrigin: string;
  initialError?: string;
  initialSuccess?: string;
  scope?: string;
};

export default function LoginForm({
  returnUrl,
  appOrigin,
  initialError,
  initialSuccess,
  scope,
}: LoginFormProps): JSX.Element {
  const verifyUrl = `${appOrigin}/verify-email?returnUrl=${encodeURIComponent(returnUrl)}`;
  const errorMessage = initialError;
  const hasError = typeof errorMessage === 'string' && errorMessage.length > 0;
  const hasSuccess = typeof initialSuccess === 'string' && initialSuccess.length > 0;
  const feedbackId = hasSuccess || hasError ? 'login-feedback' : undefined;
  const emailDescribedBy = hasError ? 'login-help login-feedback' : 'login-help';

  return (
    <main className="login-shell">
      <a href="#login-panel" className="skip-link">
        Skip to sign-in form
      </a>
      <section id="login-panel" aria-labelledby="login-title" className="login-panel">
        <Image
          src={signinBadgeUrl}
          alt="Sign-in flow badge"
          className="badge login-badge"
          width={80}
          height={80}
          loading="eager"
          unoptimized
        />
        <p className="eyebrow">Sign In</p>
        <h1 id="login-title" className="login-title">
          Sign in
        </h1>
        <p id="login-help" className="login-copy">
          We&apos;ll email you a sign-in link.
        </p>

        <form
          action="/api/signin"
          method="post"
          aria-describedby="login-help"
          className="login-form"
          data-login-form
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
          {hasSuccess && (
            <p id={feedbackId} role="status" aria-live="polite" className="message message-success">
              {initialSuccess}
            </p>
          )}
          {hasError && (
            <p id={feedbackId} role="alert" className="message message-error">
              {errorMessage}
            </p>
          )}
        </form>
        <Script id="login-form-enhancements" strategy="afterInteractive">
          {`
const form = document.querySelector('[data-login-form]');
const submitButton = document.querySelector('[data-submit-button]');
const spinner = document.querySelector('[data-submit-spinner]');
const label = document.querySelector('[data-submit-label]');
const feedbackId = 'login-feedback';

function ensureFeedbackElement() {
  const existing = document.getElementById(feedbackId);
  if (existing instanceof HTMLParagraphElement) {
    return existing;
  }

  if (!(form instanceof HTMLFormElement)) {
    return null;
  }

  const message = document.createElement('p');
  message.id = feedbackId;
  message.hidden = true;
  form.append(message);
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
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload &&
        typeof payload.message === 'string'
          ? payload.message
          : response.ok
            ? 'Verification email sent'
            : 'We could not send the sign-in email. Please try again.';

      if (feedback instanceof HTMLParagraphElement) {
        feedback.hidden = false;
        feedback.textContent = message;
        feedback.setAttribute('role', response.ok ? 'status' : 'alert');
        feedback.setAttribute('aria-live', response.ok ? 'polite' : 'assertive');
        feedback.className = response.ok
          ? 'message message-success'
          : 'message message-error';
      }

      if (response.ok) {
        const emailInput = form.querySelector('#email');
        if (emailInput instanceof HTMLInputElement) {
          emailInput.value = '';
        }
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
`}
        </Script>
      </section>
    </main>
  );
}
