# Hosted auth pages

Magic Link SSO ships these built-in HTML pages:

- `GET /` optional landing page
- `GET /signin`
- `GET /verify-email?token=...`

If you do not want Magic Link SSO to answer `GET /`, set
`[server].serveRootLandingPage = false`. In that mode the server returns a
normal 404 for `/`, which is a good fit when a reverse proxy, ingress, or a
separate frontend should handle the site root instead.

By default they use built-in English text and the default Magic Link SSO visual
treatment. If you want those pages to match your product a bit better without
forking the EJS templates, configure these optional TOML tables:

- `[hostedAuth.copy]`
- `[hostedAuth.branding]`

For multi-site setups, you can override the shared defaults per site with:

- `[sites.hostedAuth.copy]`
- `[sites.hostedAuth.branding]`

## Built-in security behavior

The hosted HTML flow ships with these protections on by default:

- all hosted HTML responses send `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, and a restrictive permissions policy
- hosted pages use a nonce-based Content Security Policy (CSP), so the bundled
  inline `<style>` and `<script>` tags are allowed without opening up
  `unsafe-inline`
- browser form posts to `POST /signin`, `POST /verify-email`, and
  `POST /verify-email/otp` require a CSRF token that is minted by the preceding
  hosted page response
- `GET /verify-email` is preview-only and never consumes the one-time token;
  trusted preview callers send the shared `X-Magic-SSO-Preview-Secret` /
  `MAGICSSO_PREVIEW_SECRET`, and only an explicit `POST /verify-email` exchange
  can mint an auth cookie or JSON access token
- JSON API clients should exchange verification tokens with `POST /verify-email`
  and do not need to send a CSRF token

When `[auth.otp].enabled = true`, a successful hosted sign-in also shows a
single accessible code field in place of the email form.
`POST /verify-email/otp` has the same CSRF and no-store protections, and the
email contains both the regular magic link and the short code. An invalid code
returns to that code-only view while attempts remain. An expired, exhausted, or
already consumed challenge returns to the email form so the user can request a
new message. The code is an alternative for an already-open mobile/PWA session,
not a separate sign-in method or a second factor.

If you terminate TLS at a reverse proxy, set `trustProxy` correctly so the
server can recognize HTTPS requests and add HSTS on those responses.

If you fork the EJS templates, keep passing the generated nonce into any inline
`<style>` or `<script>` tags, or move that code into external assets served from
the same origin.

## Cross-origin deployment guidance

The built-in hosted `/verify-email` flow is strongest when the SSO server can
set a cookie that the target application can actually use, such as same-origin,
same-site, or shared-cookie-domain deployments.

For disparate domains, prefer an application-owned `/verify-email` callback that
receives the email token, exchanges it with the SSO server, and sets the final
auth cookie on the application origin. That is the pattern used by the framework
packages and example apps in this repository.

Avoid treating `SameSite=None` as a durable cross-browser compatibility plan for
unrelated domains. Browser privacy features block or partition third-party
cookie state. For the supporting browser guidance and the reason CHIPS and the
Storage Access API are not the primary recommendation here, see
[Cross-origin cookies](./cross-origin-cookie-audit.md).

Throughout this guide, `[hostedAuth.copy]` means the UI text shown on the hosted
pages:

- page titles
- labels
- help text
- confirmation and error messages

## Quick start

Use `[hostedAuth.copy]` for text and browser-only feedback:

```toml
[hostedAuth.copy]
lang = "pl"

[hostedAuth.copy.signin]
pageTitle = "Logowanie"
title = "Zaloguj się"
helpText = "Wyślemy Ci link do logowania."
confirmationPageTitle = "Sprawdź pocztę"
confirmationTitle = "Sprawdź pocztę"
confirmationHelpText = "Jeśli ten adres e-mail może się zalogować, wkrótce otrzymasz link. Otwórz wiadomość i kliknij link, aby kontynuować."
emailLabel = "Adres e-mail"
emailPlaceholder = "ty@example.com"
submitButton = "Wyślij link"
skipLink = "Przejdź do formularza logowania"
useDifferentEmailButton = "Użyj innego adresu e-mail"

[hostedAuth.copy.verifyEmail]
pageTitle = "Potwierdz adres e-mail"
title = "Magia logowania"
helpText = "Kończymy logowanie. Jeśli nic się nie stanie, kliknij przycisk."
continueButton = "Kontynuuj"

[hostedAuth.copy.feedback]
invalidRequest = "Nieprawidłowe żądanie"
invalidOrExpiredToken = "Nieprawidłowy lub wygasły token"
```

Use `[hostedAuth.branding]` for brand identity and light theming:

```toml
[hostedAuth.branding]
title = "Acme Cloud"
logoText = "AC"
supportText = "Need help?"
supportLinkText = "Contact support"
supportLinkUrl = "mailto:support@example.com"

[hostedAuth.branding.signinCssVariables]
"--color-button-background" = "#112233"
"--color-button-background-hover" = "#0b1a2a"

[hostedAuth.branding.verifyEmailCssVariables]
"--color-card-background" = "#101820"
"--color-button-background" = "#112233"
```

You can use either variable on its own, or both together.

## What `[hostedAuth.copy]` controls

Top-level fields:

- `lang`
- `signin`
- `verifyEmail`
- `feedback`

### `signin`

- `pageTitle`
- `title`
- `helpText`
- `confirmationPageTitle`
- `confirmationTitle`
- `confirmationHelpText`
- `emailLabel`
- `emailPlaceholder`
- `submitButton`
- `skipLink`
- `useDifferentEmailButton`
- `otpLabel`
- `otpPlaceholder`
- `otpSubmitButton`
- `otpHelpText`

### `verifyEmail`

- `pageTitle`
- `title`
- `helpText`
- `continueButton`

### `feedback`

These cover the server-rendered HTML error states. JSON API responses keep their
existing default-English messages.

- `invalidRequest`
- `invalidOrUntrustedReturnUrl`
- `invalidOrUntrustedVerifyUrl`
- `forbidden`
- `failedToSendEmail`
- `verificationEmailSent`
- `invalidOrExpiredToken`
- `invalidOrExpiredOtp`

Any missing field falls back to the built-in default text.

`verificationEmailSent` stays for compatibility with older configurations. The
hosted sign-in success screen uses the dedicated `signin.confirmation*` fields
instead.

## What `[hostedAuth.branding]` controls

Supported fields:

- `title` The brand eyebrow on both hosted pages.
- `logoText` A short text badge, used when `logoImageUrl` is not set.
- `logoImageUrl` Replaces `logoText` with an image.
- `logoAlt` Alt text for `logoImageUrl`.
- `supportText` Optional help/support sentence shown near the bottom of the
  page.
- `supportLinkText` Optional support link label.
- `supportLinkUrl` Optional support link target.
- `signinCssVariables` Optional CSS variable overrides for `GET /signin`.
- `verifyEmailCssVariables` Optional CSS variable overrides for
  `GET /verify-email`.

### URL rules

- `logoImageUrl` must be either:
    - an absolute `http://` or `https://` URL
    - a site-relative path like `/brand/logo.svg`
- `supportLinkUrl` must be either:
    - an absolute `http://` or `https://` URL
    - a site-relative path like `/support`
    - a `mailto:` link
- `supportLinkText` and `supportLinkUrl` must be set together

If the TOML shape is invalid, the server fails fast during startup.

## Supported CSS variables

### `signinCssVariables`

- `--color-background`
- `--color-surface`
- `--color-text`
- `--color-muted`
- `--color-border`
- `--color-border-soft`
- `--color-field-background`
- `--color-button-background`
- `--color-button-background-hover`
- `--color-button-text`
- `--color-focus`
- `--color-success-background`
- `--color-success-text`
- `--color-error-background`
- `--color-error-text`
- `--shadow-panel`

### `verifyEmailCssVariables`

- `--color-background`
- `--color-text`
- `--color-card-background`
- `--color-card-shadow`
- `--color-border`
- `--color-error-background`
- `--color-error-text`
- `--color-button-background`
- `--color-button-text`

## Recommended approach

1. Start with `[hostedAuth.copy]` only.
2. Add `[hostedAuth.branding]` title, logo text, and support details next.
3. Use CSS variable overrides sparingly, only for the values that really need to
   match your product.
4. Prefer site-relative asset paths such as `/brand/logo.svg` when the logo is
   served by the same deployment.

## Example: a small white-label setup

```toml
[hostedAuth.copy.signin]
title = "Sign in to Acme Cloud"
helpText = "Use your work email and we will send a secure sign-in link."
confirmationTitle = "Check your email"
confirmationHelpText = "If your email can sign in, you will receive a link shortly. Open the email and click the link to continue."

[hostedAuth.copy.verifyEmail]
title = "Check your email"
helpText = "We are completing sign-in securely. If the redirect stalls, continue manually."

[hostedAuth.branding]
title = "Acme Cloud"
logoImageUrl = "/brand/acme-logo.svg"
logoAlt = "Acme Cloud logo"
supportText = "Questions about access?"
supportLinkText = "Open support"
supportLinkUrl = "/support"

[hostedAuth.branding.signinCssVariables]
"--color-button-background" = "#0f2d52"
"--color-button-background-hover" = "#0a213c"
"--color-focus" = "#c2410c"
```

## Where this applies

These settings affect only the server-hosted HTML pages:

- `GET /` when `server.serveRootLandingPage = true`
- `GET /signin`
- `GET /verify-email?token=...`
- `POST /signin` HTML responses
- `POST /verify-email` HTML responses
- `POST /verify-email/otp` HTML responses

They do not change:

- the email template content
- JSON API response payloads
- Next.js, Nuxt, or Django client-side UI

For manual browser integrations that submit directly to the hosted HTML
endpoints, preserve both the CSRF cookie and the hidden `csrfToken` field from
the rendered page when posting the form back to the server.
