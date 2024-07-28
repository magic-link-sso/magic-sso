# Magic Link SSO Security Controls

This document inventories security and counter-threat measures currently
implemented in `server/`, `gate/`, and `packages/`. It is based on the current
source code.

## General

- Magic Link SSO uses signed JWTs for email verification tokens and access
  tokens. Tokens are signed with `jose`, restricted to `HS256`, and verified
  with explicit algorithm checks.

- Verification tokens and access tokens carry random `jti` values. These
  identifiers make replay detection and session revocation possible without
  relying on predictable public ids.

- Verification links expire. The email token expiry is configurable and included
  in the signed token, so stale links are rejected even if the URL is retained.

- Access tokens expire. The JWT session lifetime is configurable and is also
  used as the cookie max age on server-issued session cookies.

- Magic Link SSO requires strong configured secrets. `jwtSecret`, `emailSecret`,
  `csrfSecret`, and `previewSecret` must be at least 32 characters long.

- Magic Link SSO rejects example placeholder secrets. The server and gate fail
  fast when known sample values are still present in TOML configuration.

- The verify-email token is not reflected into confirmation-page HTML. The
  server and gate move it into a short-lived `HttpOnly` cookie before rendering
  the browser confirmation step.

- Verify-email pages remove the token from the browser URL. The hosted server
  page and gate page use `history.replaceState` so the token is less likely to
  remain in history, screenshots, referrers, or copied URLs.

- Verify-email pages use `Referrer-Policy: no-referrer`. The token-bearing entry
  request is handled with a no-referrer policy before the confirmation step.

- Server and gate set baseline security headers on normal responses. They remove
  `Server`, set `Permissions-Policy`, `Referrer-Policy`,
  `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`.

- Server and gate set HSTS only on HTTPS requests. This avoids breaking local
  HTTP development while enabling transport hardening when TLS is actually in
  use.

- Full-access scope is handled explicitly. A full-access grant can satisfy
  narrower scopes, while a narrower grant does not silently become full access.

- Configuration parsing is strict. Server and gate TOML schemas reject unknown
  keys and invalid types instead of silently accepting misspelled security
  settings.

- Duration parsing accepts only seconds, minutes, hours, and days. Unknown units
  are rejected, avoiding accidental long or short token lifetimes from typos.

- Server and gate have global error handlers. Unexpected exceptions are logged
  and converted to generic client responses instead of framework defaults or
  stack traces.

- Auth and session responses use no-store caching. Sign-in pages, verify-email
  pages, token exchange JSON, sessions, logout, and error paths set
  `Cache-Control: no-store` where credentials or auth state may appear.

- Container images run as non-root users. The server and gate Dockerfiles create
  dedicated users and switch away from root before starting Node.

- Production compose examples run with read-only filesystems. Writable state is
  limited to tmpfs mounts or explicitly mounted configuration.

- Production compose examples drop Linux capabilities and set
  `no-new-privileges`. This reduces the blast radius of a container escape or
  compromised Node process.

- Runtime dependencies are installed with `--ignore-scripts` and frozen
  lockfiles in Docker builds. This reduces install-time script risk and keeps
  dependency resolution reproducible.

- Workspace dependency advisories are tracked with audit scripts.
  `pnpm audit -P`, the Python audit helper, and root `pnpm` overrides are part
  of the repository's current dependency-security posture.

- Known vulnerable dependency ranges are overridden at the workspace root.
  Recent fixes include forcing patched versions for packages such as PostCSS,
  Vite, Hono, Nodemailer, and other advisory-affected dependencies.

## Server

- Verification tokens are issuer-bound. The server rejects tokens that were not
  issued by the configured Magic Link SSO origin.

- Verification tokens carry a site id and are checked against that site's
  configured audience. The server accepts both string and array JWT audiences,
  but still requires the expected site audience to be present.

- Email verification tokens are one-time use. The server consumes each
  verification-token `jti` through a replay store before issuing an access
  token.

- Redis-backed verification replay protection is atomic across server replicas.
  It uses `SET ... NX` with an absolute expiry so only one instance can consume
  a token.

- File-backed verification replay protection is atomic on one host. It writes
  token markers with exclusive create mode, so a second use of the same token
  fails.

- Server logout revokes the current access-token `jti`. Revocation entries live
  until the JWT expiry, limiting damage from a copied cookie after logout.

- Redis-backed session revocation works across server replicas. This lets
  horizontally scaled deployments share logout state instead of relying only on
  short JWT lifetimes.

- The server exposes revocation lookups only behind the shared preview secret.
  `POST /session-revocations/check` returns revocation state only when
  `x-magic-sso-preview-secret` matches, so Gate can enforce logout state without
  making revocation status public.

- The server requires distinct secrets for JWTs, email tokens, CSRF tokens, and
  preview-token access. Reusing one secret for another purpose is rejected at
  startup.

- Server session cookies cannot disable `HttpOnly`. Configuration with
  `cookie.httpOnly = false` is rejected because the cookie contains a bearer
  JWT.

- HTTPS server deployments must use `Secure` cookies. If `server.appUrl` is
  HTTPS and `cookie.secure` is false, config loading fails.

- Non-local HTTP deployments that disable `Secure` cookies emit a warning. This
  keeps local development usable while calling out dangerous production-like
  configuration.

- `SameSite=None` requires HTTPS. The server rejects `cookie.sameSite = "none"`
  unless `server.appUrl` uses HTTPS.

- CSRF cookies and temporary verification-token cookies use `SameSite=Strict`.
  They are also `HttpOnly`, scoped to the relevant path, and marked `Secure`
  when the deployment origin is HTTPS.

- Hosted sign-in and verify-email form submissions use signed CSRF tokens. The
  server stores the token in an `HttpOnly` cookie, submits a matching form
  value, verifies the HMAC signature, and compares values with
  `timingSafeEqual`.

- JSON mutations require same-origin signals. The server accepts JSON sign-in,
  verify-email, and logout mutations only when `Origin` and `Sec-Fetch-Site` are
  compatible with the configured app origin.

- Redirect destinations are allowlisted per site. The server only accepts
  configured exact URLs or strict subpath rules under the site's own origins.

- Redirect allowlist entries cannot include query strings or fragments.
  Operators configure only the trusted origin and path, reducing accidental
  open-redirect and parameter-smuggling mistakes.

- Redirect paths reject encoded traversal and suspicious path segments. Encoded
  `.` `/` `\` sequences and raw `..` segments are blocked in configured redirect
  rules and incoming return URLs.

- Unauthorized sign-in attempts do not reveal whether an email is allowed. The
  server returns the same "verification email sent" user-facing response for
  forbidden emails after logging the rejection.

- Rejected sign-in logs hash emails instead of writing raw addresses. The server
  records a keyed email hash and domain so operators can investigate abuse
  without routinely storing full rejected addresses.

- The per-email sign-in limiter keys by normalized email rather than by IP.
  Rotating source addresses cannot bypass the cap for a single target inbox.

- File-backed per-email sign-in limits hash the email into filesystem keys. The
  limiter avoids placing raw email addresses into directory names.

- Server routes have rate limits for sign-in pages, sign-in submissions,
  verification, and health checks. Responses include `Retry-After` when the
  request is rejected for rate limiting.

- File-backed security state uses restrictive permissions where token and
  limiter data are stored. Verification replay and per-email limiter directories
  are forced to `0700`, and marker files are written as `0600`.

- In-memory security state emits warnings. Test-only or development-only stores
  warn that they do not survive process restarts.

- Hosted auth pages use CSP with per-response nonces. Scripts and styles are
  restricted to `self` plus the generated nonce, with `base-uri 'none'`,
  `form-action 'self'`, `object-src 'none'`, and `frame-ancestors 'none'`.

- Server site origins must be unique. A single origin cannot be assigned to
  multiple site ids, which prevents ambiguous audience and redirect ownership.

- Server access rules are explicit per email and scope. A user must be
  configured through `allowedEmails` or `accessRules`, and requested scopes are
  normalized before authorization.

- Hosted auth branding CSS variables are constrained. Values must not include
  declarations, blocks, escapes, control characters, quotes, or `url(...)`,
  reducing CSS-injection risk.

- Hosted auth branding links are protocol-checked. Logo URLs and support links
  must be site-relative, http(s), or `mailto:` where explicitly allowed.

- Hosted server pages rely on escaped EJS output. User-facing values such as
  emails, feedback, links, and CSRF tokens are rendered with escaped output.

- Verification emails escape HTML content. Site title, verification link,
  expiration text, and signature are escaped in the HTML email body.

- Verification email construction uses `URLSearchParams`. The token is inserted
  into the configured verification URL through URL APIs rather than string
  concatenation.

- Server error responses are normalized. Client-facing 500 responses say
  "Internal Server Error" while details stay in server logs.

- `robots.txt` disallows indexing on the hosted server. This is a small
  defense-in-depth measure for auth pages and deployment roots.

- The server verifies loopback `appUrl` ownership at startup. For
  localhost-style origins, it probes `/healthz` with a random header token and
  exits if another process is answering.

## Gate

- Access tokens are issuer-bound and audience-bound. Gate verifies returned
  access tokens against both `auth.serverUrl` and `gate.publicOrigin`, so a
  token minted for one site cannot be replayed into another gate.

- Gate verifies the returned access token locally before setting its auth
  cookie. A successful SSO response is not enough unless the JWT signature,
  issuer, audience, and payload shape all pass.

- Gate enforces server-side session revocation during request auth. After local
  JWT verification, Gate checks the token `jti` against the server's revocation
  store and treats lookup failures as unauthenticated rather than allowing a
  potentially revoked session through.

- Gate auth cookies are always `HttpOnly`. Browser JavaScript cannot read the
  gate's access token cookie.

- Gate auth cookies use `SameSite=Lax`. This supports normal top-level
  navigation while reducing ambient cross-site cookie sending.

- Gate path-prefix mode constrains the cookie path to the configured public path
  prefix. This prevents a path-prefix gate from setting cookies outside its
  protected area.

- Gate verify-email confirmation uses a separate signed CSRF token. The secret
  is derived from the JWT secret with HKDF and is checked before the gate
  exchanges the email token.

- Gate mutations require same-origin signals. Sign-in, verify-email, and logout
  posts must pass `Sec-Fetch-Site`, `Origin`, or `Referer` checks against
  `gate.publicOrigin`.

- WebSocket upgrades require the expected origin. Gate rejects cross-origin
  WebSocket attempts before proxying to the protected upstream.

- Gate normalizes return URLs to its own public origin. Invalid, cross-origin,
  namespace-internal, and path-prefix-escape values fall back to the protected
  root.

- Gate direct-use sign-in targets are generated from normalized return URLs. The
  gate does not forward arbitrary user-provided redirects to the Magic Link SSO
  server.

- Gate logout propagates revocation back to the server before clearing the local
  cookie. This keeps logout semantics consistent across hosted and
  gate-protected flows, so replaying a copied Gate token after logout no longer
  succeeds until JWT expiry.

- Gate's token preview call is protected by a shared preview secret. The server
  returns the email preview for JSON `GET /verify-email` only when
  `x-magic-sso-preview-secret` matches.

- Gate validates the SSO server's verify-email responses before trusting them.
  It requires the expected JSON shape for preview, sign-in, and token-exchange
  responses.

- Gate applies rate limiting before auth and proxying. The limiter protects
  login, verification, proxied HTTP requests, and WebSocket upgrades.

- Gate rate limiting uses the actual socket peer address. Spoofed
  `X-Forwarded-*` headers cannot change the limiter identity.

- Gate can use Redis-backed rate limiting. The Redis implementation shares
  counters across gate replicas and hashes rate-limit keys before storing them.

- Gate pages use a restrictive CSP. Gate allows its own assets, blocks object
  embedding, restricts form posts to self, and denies framing.

- Gate also enforces security headers on proxied responses. Upstream responses
  cannot override gate-owned proxy security headers such as frame, sniffing,
  referrer, permissions, HSTS, and server headers.

- Gate filters hop-by-hop proxy response headers. Connection-specific headers
  are not copied from upstream responses to the browser.

- Gate strips its auth cookie before proxying upstream. The protected
  application receives non-gate cookies, but not the bearer token that
  authenticates the browser to Gate.

- Gate filters upstream `Set-Cookie` collisions with its own namespace.
  Upstreams cannot set or shadow the gate auth cookie or the temporary
  verify-email cookies.

- Gate strips spoofable identity and proxy headers before forwarding. Incoming
  `x-magic-sso-*`, `Forwarded`, `X-Forwarded-*`, and `X-Real-IP` values are
  removed before trusted values are injected.

- Gate injects authenticated identity headers only after JWT validation. The
  upstream receives `x-magic-sso-user-email`, `x-magic-sso-user-scope`, and
  `x-magic-sso-site-id` from the verified token, not from the client request.

- Gate reserves a private namespace for its own routes. Requests under
  `/_magicgate` are handled by Gate and are not accidentally proxied to the
  upstream application.

- Gate rejects namespace WebSocket upgrades. WebSocket traffic to Gate-owned
  paths receives a 404 instead of reaching the upstream.

- Gate proxy requests have a timeout. Slow or unreachable upstreams are cut off
  and converted into controlled proxy errors.

- Gate proxy errors return generic 502 responses. Detailed proxy failures are
  logged server-side without exposing internals to the browser.

- Gate replaced `http-proxy` with a smaller in-repo proxy implementation. The
  current proxy path explicitly controls forwarded headers, response headers,
  timeouts, errors, and WebSocket behavior.

- Gate validates target URLs at startup. `auth.serverUrl`, `gate.publicOrigin`,
  and `gate.upstreamUrl` must be absolute http(s) or ws(s) origins without
  paths, search params, or fragments.

- Gate warns on private, loopback, link-local, and metadata-adjacent targets.
  This catches SSRF-adjacent or accidental exposure foot-guns while still
  allowing intentional internal upstreams.

- Gate detects the common misconfiguration where `auth.serverUrl` points back to
  the gate. That flow is rejected as temporarily unavailable rather than
  recursing or leaking confusing behavior.

- HTML rendered by Gate escapes user-controlled values. Email addresses, return
  URLs, paths, titles, and messages are escaped before insertion into custom
  HTML.

- Fetch calls from Gate to the SSO server use `redirect: "error"` and
  `cache: "no-store"`. Gate does not silently follow unexpected redirects and
  does not cache auth handoff responses.

## Packages

- Framework packages also verify access-token issuer and audience. Angular,
  Next.js, Nuxt, and Django helpers reject tokens that were not issued by the
  configured Magic Link SSO server for the current application origin.

- Framework package token validators require the site-bound payload shape.
  Package helpers reject decoded JWTs that do not contain string `email`,
  `scope`, and `siteId` claims.

- Framework package auth-cookie helpers set `HttpOnly`. Angular, Next.js, Nuxt,
  and Django-managed application cookies keep the access token out of browser
  JavaScript.

- Framework package auth cookies use `SameSite=Lax` by default. Django validates
  the configured SameSite value and accepts only `Lax`, `Strict`, or `None`.

- Framework package auth-cookie helpers scope cookies by a configured path. This
  lets apps narrow where the browser sends the auth cookie when they are mounted
  below a subpath.

- Package logout routes are mutation-protected. Next.js and Nuxt require POST
  plus same-origin `Origin` or `Referer`, while Django uses `@require_POST` and
  Django's CSRF protection.

- Framework packages normalize return URLs to the application origin. Angular,
  Nuxt, and Django helpers reject cross-origin return targets, and Next.js
  middleware builds return URLs from `request.nextUrl.origin`.

- Framework package direct-use login targets are generated with URL APIs. Scope
  values are trimmed, `verifyUrl` is built from the app origin, and query
  parameters are encoded rather than concatenated by hand.

- Nuxt and Django verify-email routes validate preview responses before
  rendering confirmation pages. They require a non-empty `email` field from the
  Magic Link SSO server before showing the account preview.

- Nuxt and Django verify-email routes verify returned access tokens before
  setting application cookies. The exchanged token must validate against the app
  origin and Magic Link SSO issuer.

- Package middleware clears or ignores invalid sessions. Next.js clears the auth
  cookie when redirecting because of an invalid session, while the other package
  helpers treat invalid or unverifiable tokens as unauthenticated.

- Package route guards use explicit public-route bypass lists. Next.js and Nuxt
  middleware skip only configured public paths, while Django middleware skips
  configured URL names.

- Nuxt avoids client-side auth decisions for protected routes. Because the auth
  cookie is `HttpOnly`, the global route middleware lets the server verify the
  request instead of trusting browser-side state.

- Framework packages derive trusted origins defensively. Next.js and Nuxt prefer
  configured public origins and only use proxy-derived request origins when
  trust-proxy behavior is enabled.

- Django can allowlist trusted application origins. If configured, the Django
  package rejects request origins outside `MAGICSSO_ALLOWED_ORIGINS` before
  accepting a JWT audience.

- Framework packages preserve requested scopes deliberately. Login builders trim
  optional scopes before adding them to sign-in URLs or API requests.

- Framework package templates rely on framework escaping or explicit escaping.
  Django templates use escaped template variables, and Nuxt's built-in
  confirmation page escapes email, token, return URL, and CSRF values before
  inserting them into HTML.

- Package calls to the Magic Link SSO server avoid caching auth handoffs or use
  bounded network calls. Next.js sign-in calls and Nuxt verify calls use
  `cache: "no-store"`, and Django uses explicit request timeouts for SSO server
  calls.
