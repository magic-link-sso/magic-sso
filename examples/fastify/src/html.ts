// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Wojciech Polak

import type { AuthPayload } from './auth.js';

export interface RenderPageOptions {
    body: string;
    title: string;
}

export interface LoginPageMessage {
    kind: 'error' | 'success';
    text: string;
}

export interface HomePageOptions {
    auth: AuthPayload | null;
    loginTarget: string;
    signinBadgePath: string;
}

export interface LoginPageOptions {
    appOrigin: string;
    loginTarget: string;
    message: LoginPageMessage | undefined;
    returnUrl: string;
    signinBadgePath: string;
    verifyUrl: string;
}

export interface ProtectedPageOptions {
    auth: AuthPayload;
    protectedBadgePath: string;
}

export interface VerifyEmailConfirmationPageOptions {
    csrfToken: string;
    email: string;
    returnUrl: string;
    signinBadgePath: string;
}

const stylesheetPath = '/shared/styles.css';

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function buildDocument(options: RenderPageOptions): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)}</title>
    <link rel="stylesheet" href="${stylesheetPath}" />
  </head>
  <body>
    ${options.body}
  </body>
</html>`;
}

function renderMessage(message: LoginPageMessage | undefined): string {
    if (typeof message === 'undefined') {
        return '';
    }

    if (message.kind === 'success') {
        return `<p id="signin-feedback" class="message message-success" role="status" aria-live="polite">${escapeHtml(message.text)}</p>`;
    }

    return `<p id="signin-feedback" class="message message-error" role="alert">${escapeHtml(message.text)}</p>`;
}

function renderLoginEnhancements(): string {
    return `<script type="module">
const form = document.querySelector('[data-login-form]');
const submitButton = document.querySelector('[data-submit-button]');
const spinner = document.querySelector('[data-submit-spinner]');
const label = document.querySelector('[data-submit-label]');

if (
  form instanceof HTMLFormElement &&
  submitButton instanceof HTMLButtonElement &&
  spinner instanceof HTMLElement &&
  label instanceof HTMLElement
) {
  form.addEventListener('submit', () => {
    submitButton.disabled = true;
    submitButton.setAttribute('aria-disabled', 'true');
    spinner.classList.add('button-spinner-visible');
    label.textContent = 'Sending magic link...';
  });
}
</script>`;
}

export function renderHomePage(options: HomePageOptions): string {
    const sessionCopy =
        options.auth === null
            ? 'You are not signed in yet. Start with the login page, then come back here to see the authenticated state.'
            : `Signed in as <strong>${escapeHtml(options.auth.email)}</strong>. Your token is already active for protected routes.`;

    const quickActions =
        options.auth === null
            ? `<a href="${escapeHtml(options.loginTarget)}" class="button button-light">Login</a>
               <a href="/protected" class="button button-secondary">Try Protected Page</a>`
            : `<a href="/protected" class="button button-light">Open Protected Page</a>
               <form action="/logout" method="post">
                 <button class="button button-secondary" type="submit">Logout</button>
               </form>`;

    return buildDocument({
        title: 'Magic Link SSO Fastify',
        body: `<main class="shell">
  <div class="card hero">
    <div class="hero-top">
      <img src="${escapeHtml(options.signinBadgePath)}" alt="Sign-in flow badge" class="badge" width="144" height="144" />
      <div>
        <p class="eyebrow">Magic Link SSO</p>
        <h1 class="title">Fastify demo app for Magic Link sign-in.</h1>
        <p class="copy">Start the sign-in flow here, then open a protected route once your session cookie is active.</p>
      </div>
    </div>

    <div class="grid">
      <section class="panel">
        <p class="panel-title">Session Status</p>
        <p class="panel-copy">${sessionCopy}</p>
      </section>

      <section class="panel panel-dark">
        <p class="panel-title">Quick Actions</p>
        <div class="actions">
          ${quickActions}
        </div>
      </section>
    </div>
  </div>
</main>`,
    });
}

export function renderLoginPage(options: LoginPageOptions): string {
    const hasError = options.message?.kind === 'error';
    const emailDescription = hasError ? 'signin-help signin-feedback' : 'signin-help';

    return buildDocument({
        title: 'Sign In | Magic Link SSO Fastify',
        body: `<main class="login-shell">
  <a class="skip-link" href="#login-panel">Skip to sign-in form</a>
  <section id="login-panel" class="login-panel" aria-labelledby="login-title">
    <img src="${escapeHtml(options.signinBadgePath)}" alt="Sign-in flow badge" class="badge login-badge" width="144" height="144" />
    <p class="eyebrow">Sign In</p>
    <h1 id="login-title" class="login-title">Sign in</h1>
    <p id="signin-help" class="login-copy">We&apos;ll email you a sign-in link.</p>

    <form class="login-form" aria-describedby="signin-help" action="/api/signin" method="post" data-login-form>
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
        aria-describedby="${emailDescription}"
        ${hasError ? 'aria-invalid="true"' : ''}
        required
      />
      <input type="hidden" name="returnUrl" value="${escapeHtml(options.returnUrl)}" />
      <input type="hidden" name="verifyUrl" value="${escapeHtml(options.verifyUrl)}" />
      <div class="login-actions">
        <button class="button button-primary button-submit" type="submit" data-submit-button>
          <span class="button-spinner" aria-hidden="true" data-submit-spinner></span>
          <span data-submit-label>Send magic link</span>
        </button>
        <a href="/" class="button button-secondary">Back Home</a>
      </div>
      ${renderMessage(options.message)}
    </form>
  </section>
</main>
${renderLoginEnhancements()}`,
    });
}

export function renderProtectedPage(options: ProtectedPageOptions): string {
    return buildDocument({
        title: 'Protected | Magic Link SSO Fastify',
        body: `<main class="shell">
  <div class="card hero">
    <div class="hero-top">
      <img src="${escapeHtml(options.protectedBadgePath)}" alt="Protected session badge" class="badge" width="144" height="144" />
      <div>
        <p class="eyebrow">Protected</p>
        <h1 class="title">Your Fastify session is locked in and verified.</h1>
        <p class="copy">This page only renders after the Fastify app verifies the auth cookie on the server.</p>
      </div>
    </div>

    <div class="meta-row">
      <section class="panel">
        <p class="panel-title">Signed In As</p>
        <p class="panel-copy"><strong>${escapeHtml(options.auth.email)}</strong></p>
      </section>

      <section class="panel panel-dark">
        <p class="panel-title">Next Step</p>
        <div class="actions">
          <a href="/" class="button button-light">Back Home</a>
          <form action="/logout" method="post">
            <button class="button button-secondary" type="submit">Logout</button>
          </form>
        </div>
      </section>
    </div>
  </div>
</main>`,
    });
}

export function renderVerifyEmailConfirmationPage(
    options: VerifyEmailConfirmationPageOptions,
): string {
    return buildDocument({
        title: 'Confirm Sign In | Magic Link SSO Fastify',
        body: `<main class="login-shell">
  <section id="verify-email-panel" class="login-panel" aria-labelledby="verify-email-title">
    <img src="${escapeHtml(options.signinBadgePath)}" alt="Sign-in flow badge" class="badge login-badge" width="144" height="144" />
    <p class="eyebrow">Verify Email</p>
    <h1 id="verify-email-title" class="login-title">Continue sign-in</h1>
    <p class="login-copy">Review the email address below, then continue to finish signing in.</p>

    <form class="login-form" method="post" action="/verify-email">
      <p id="email-label" class="field-label">Email</p>
      <p id="email-value" class="field-value" aria-labelledby="email-label">${escapeHtml(options.email)}</p>
      <input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}" />
      <input type="hidden" name="returnUrl" value="${escapeHtml(options.returnUrl)}" />
      <div class="login-actions">
        <button class="button button-primary button-submit button-block" type="submit">Continue</button>
      </div>
    </form>
  </section>
</main>`,
    });
}
