# `@magic-link-sso/core` contract

This document is the compatibility reference for the first public SDK release.
The package has no ambient configuration: adapters resolve environment and proxy
policy, then pass trusted values into core.

## Public API and naming

The first public API consists of `verifyAuthToken`, `toSecretKey`,
`exchangeEmailOtp`, `readCookieValue`, `buildAuthCookieOptions`,
`normaliseReturnUrl`, `buildLoginTarget`, `buildVerifyUrl`, and the associated
types. The canonical option names are `expectedAudience`, `expectedIssuer`,
`appOrigin`, and cookie `maxAge` (in seconds). Core does not read environment
variables or infer these values from a request.

## Authentication contract

| Concern                   | Core behaviour                                                                                                        | Server issuer                                                                          | Adapter responsibility                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Algorithm                 | accepts only signed `HS256` JWTs                                                                                      | signs with `HS256`                                                                     | none                                                                        |
| Identity claims           | requires non-empty `email`, `jti`, `siteId`, `aud`, `iss`; accepts a string `scope`; requires numeric `iat` and `exp` | writes `email`, UUID `jti`, `scope`, `siteId`, `aud`, `iss`, `iat`, `exp`              | none                                                                        |
| Audience and issuer       | both `expectedAudience` and `expectedIssuer` are required                                                             | access tokens use a configured site origin as `aud` and configured SSO origin as `iss` | resolve trusted origins; never derive them from an untrusted request header |
| Verification failure      | returns `null`                                                                                                        | n/a                                                                                    | map to the framework response                                               |
| Invalid API configuration | throws `MagicSsoConfigurationError`                                                                                   | n/a                                                                                    | validate environment before calling core                                    |
| OTP                       | POSTs `challengeId` and `code`, rejects redirects and verifies returned token                                         | returns `accessToken` after successful code exchange                                   | pass `fetch`, optional cancellation, secret, issuer and audience            |

The server implementation in `server/src/auth.ts` writes `jti` with
`randomUUID()` and lets `SignJWT` emit `iat` and `exp`; the complete claim set
is therefore an invariant of issued access tokens, not only a consumer type.

## Cookie and redirect contract

| Concern        | Canonical result                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie lookup  | first matching cookie by default; `lastMatch: true` is retained for `config-core/runtime` compatibility; malformed percent encoding returns the raw value                 |
| Session cookie | `httpOnly: true`, `sameSite: 'lax'`, explicit adapter-controlled `secure`, neutral `maxAge` in seconds                                                                    |
| Return URL     | absolute HTTP(S) URL on the supplied `appOrigin`; cross-origin values, credentials, backslashes, encoded authority prefixes and invalid URLs use the same-origin fallback |
| Login target   | local `loginPath` by default; hosted `/signin` only when the adapter enables direct use and supplies `serverUrl`                                                          |

## Existing adapter compatibility

| Consumer        | Migration mode                    | Compatibility façade retained                                         |
| --------------- | --------------------------------- | --------------------------------------------------------------------- |
| Angular SSR     | wrapper                           | config resolution, `maxAgeSeconds`, request origin and public exports |
| Next.js         | wrapper                           | `cookies()`, `headers()`, redirects, proxy trust and route handlers   |
| Nuxt            | wrapper                           | Nitro runtime config, H3 events, middleware and composables           |
| Fastify example | direct core use                   | application-specific environment and response mapping only            |
| Gate            | wrapper                           | Fastify cookies, proxy policy, CSRF and online session revocation     |
| Django          | independent Python implementation | request origin, settings, views, middleware and cookies               |

`test/fixtures/access-token-v1.json` is the common acceptance matrix for core,
Angular, Next.js, Nuxt, the Fastify example, Gate and Django. TypeScript
consumers register `registerVerifyAuthTokenContract`; Django signs the same
payload cases with PyJWT and verifies them through its public request adapter.
The fixture covers required claims and their types, empty identities, audience
lists, wrong issuer/audience/signing secret/algorithm, expiration and `nbf`. An
empty scope is valid. `iat` is finite numeric issuance metadata; `nbf` controls
activation, so a future `iat` alone does not reject an otherwise valid token.
Optional `nbf` must be finite numeric data and optional `sub` must be a string.
Other application claims are retained without interpreting them as identity or
authorization. Verification uses an integer-second clock without truncating
fractional claim values: `exp <= now` expires and `nbf > now` rejects. Both test
runtimes freeze time to the fixture's `now`, including exact-boundary and
fractional-second cases, so the matrix does not depend on the execution date.

Gate delegates JWT verification to core. Django keeps its independent Python
implementation in `magic_sso_django/tokens.py`, which takes explicit trusted
values and has no Django imports. Its request adapter resolves settings and
origins before calling it. Both now reject incomplete session JWTs, including
tokens without `jti`, `iat` or `exp`; issuer-produced tokens already carry these
claims.

## Core and adapter boundary

Core owns portable protocol decisions: token claims and signatures, safe return
URLs, neutral cookie options, OTP exchange, browser SSO transactions, PKCE and
standard Web `Request`/`Response` handlers. It accepts trusted configuration and
Web API dependencies explicitly. Framework request objects, response APIs,
environment/settings resolution, proxy trust, UI, route registration and cookie
installation stay in adapters. Gate's online revocation check remains a Gate
policy rather than a requirement for locally verified SDK sessions.

The package test bundles the complete public entrypoint and checks that its
dependency graph contains only core and `jose`, with no Node imports or ambient
`process` configuration. The existing Node, browser-global and workerd tests
exercise that boundary at runtime. New portable dependencies require an explicit
review of this guard and the supported runtimes.

Add framework support when a real deployment needs it. Before expanding the
portfolio, record the deployment requirement and check whether Gate or an
existing integration already fits. A new adapter should:

1. Resolve trusted issuer, application origin and secret, then reuse core for
   TypeScript or implement the same versioned protocol fixtures in its language.
   Register the shared verifier contract without copying its cases.
2. Keep framework I/O in small adapter modules and test origin/proxy trust,
   response mapping and cookie options there.
3. Add a running example to the existing E2E stack and its issuer site fixture,
   then provide an `ExampleAppDefinition` from
   `tests/e2e/tests/helpers/apps.ts`. Its `name` is the issuer's site
   identifier; no central framework-name union needs updating.
4. Add the definition to `exampleApps`, or pass a dedicated list as the third
   argument to `registerSignInFlowSuites(mode, method, apps)`. The same existing
   magic-link/OTP driver and return-URL cases run for that list. The harness's
   `adapter-registration.test.ts` checks registration for an additional adapter
   outside the built-in catalog. Frameworks with different UI can instead
   implement `SignInFlowDriver` and call the same runner directly.
5. Run `pnpm check`, plus the relevant indirect, direct and proxy browser
   profiles. For browser SSO, also run the shared-session, HTTPS and app-owned
   profiles; keep the protocol fixtures and lifecycle assertions unchanged.

No additional framework is introduced solely to demonstrate registration.

## Complete sign-in flow contract

`test/sign-in-contract.ts` extends the verifier contract with a
runner-independent browser lifecycle. It is test infrastructure, not a new SDK
export. The Vitest adapter contract re-exports its driver, scenarios and runner;
Playwright imports the runner-independent module directly and supplies
framework-specific UI and cookie operations through the existing E2E helpers.

Every adapter, Django, Fastify and both Gate upstreams run the same checks:

1. Request magic-link or OTP verification for a protected URL. No application
   session may exist before the email proof is consumed.
2. Complete verification and its callback, then verify the resulting cookie's
   JWT signature, issuer and audience. Assert the expected email, site and
   session identifier, plus `HttpOnly` and `SameSite=Lax` cookie attributes.
3. Return to the original origin and path, retaining filters, pagination,
   encoded values and repeated query parameters. Equivalent encodings of spaces
   (`%20` and `+`) are accepted; literal plus signs remain distinct.
4. Reload the protected URL and reuse the same application session.
5. Submit the application's actual logout form, remove the application cookie,
   and require sign-in again for the original protected URL.

The browser driver also submits an invalid OTP before accepting the correct
code, asserting that the failed attempt creates no session. Existing blocked
identity, tampered-token and Gate revocation scenarios remain in the same suite.
Logout requires cookie removal and renewed protection; it does not impose Gate's
online revocation guarantee on adapters that validate application JWTs locally.

The standard `pnpm test:e2e` aggregate runs application-owned forms, hosted
login, a real HTTP reverse proxy, then the manager browser scenario. All
profiles reuse `tests/e2e/playwright.base.ts`, the app catalog and the SMTP
sink. Django and Nuxt enable whole-application protection while preserving their
public login and callback routes. In the proxy profile all seven clients have
separate public and backend ports; Next.js and Nuxt replace the backend Host and
resolve the public origin from explicitly trusted forwarded headers. Gate
retains an explicit public origin with proxy trust enabled. This local fixture
uses HTTP; framework-specific tests cover HTTPS origin and cookie decisions,
proxy trust, and cross-origin mutation checks.

## Browser SSO

`browser-sso.ts` defines the version-1 lifetimes, limits, request types, and
capability parser for the opt-in shared browser session feature. The
[browser SSO contract](../../docs/browser-sso-contract.md) and public protocol
fixtures under `test/fixtures/` are the cross-language reference. A malformed
capability response is distinct from explicit disabled or unsupported support.
`createBrowserSsoClient` implements hosted-first starts and backend callbacks.
It discovers capabilities before creating state, seals independent transaction
cookies using Web Crypto HKDF/AES-GCM, binds codes with S256 PKCE, and verifies
the returned JWT against the trusted issuer and app audience. Use it only on the
backend: its secret is the app's existing JWT secret. Gate participates through
an explicit opt-in policy; SDK integrations follow separately.

`parseBrowserSsoCookies` preserves duplicate names so callbacks can reject
ambiguous headers. A wrong state or tampered cookie clears nothing. A valid
terminal callback clears only its matching transaction and never an existing app
session. Callers apply returned cookie changes and set their existing app cookie
only for `kind: 'authenticated'`. App cookie settings retain their existing
meaning; configured maxAge must be capped at the verified JWT expiry.

Three outstanding transactions are allowed. A fourth start or an oversized
address rejects without replacing existing transactions. Expired, valid own
cookies are pruned. The client attempts exchange once; it offers an explicit
fresh start after an uncertain outcome and performs no automatic retries.
`restarts` remains bounded to 0 or 1 in the shared envelope for adapters that
later choose to implement a single automatic fresh-transaction restart.

Adapters use `isBrowserSsoDocumentNavigation` before starting or completing a
transaction. RSC, router prefetch, browser prefetch/prerender and non-navigation
fetches receive a same-origin continuation instead of state changes or an issuer
redirect. A speculative request must not spend the transaction limit or consume
a code. Caller headers stay outside the portable client's cookie/PKCE logic so
frameworks can respond using their normal document-navigation rules.

## Cookie migration compatibility

Moving an adapter to core does not change the default session-cookie identity:
the name remains `token`, the path remains `/`, and session cookies retain
`HttpOnly` and `SameSite=Lax`. A configured `MAGICSSO_COOKIE_NAME`,
`MAGICSSO_COOKIE_PATH`, and `MAGICSSO_COOKIE_MAX_AGE` keep their existing
meaning; Angular continues to expose its public `maxAgeSeconds` shape while core
uses neutral `maxAge` in seconds internally.

The adapter remains responsible for its existing deployment-specific `secure`
choice. Consequently, a correctly issued existing cookie remains readable and
verifiable after this migration; no forced sign-out is introduced. Any future
change to cookie name, path, domain, or `secure` policy must be called out as a
breaking migration in release notes.

## Supported runtimes

The main entrypoint uses Web APIs and `jose`, and is tested in Node.js and in a
Cloudflare Worker runtime through Miniflare/workerd. The Worker test bundles the
entrypoint with esbuild for a browser platform, then verifies a cookie session,
JWT signature and same-origin login target inside workerd. The package does not
inspect runtime globals or use a `browser` export condition, so framework
bundlers can decide where individual helpers belong.
