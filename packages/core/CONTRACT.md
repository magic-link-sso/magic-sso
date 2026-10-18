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

| Consumer        | Migration mode  | Compatibility façade retained                                         |
| --------------- | --------------- | --------------------------------------------------------------------- |
| Angular SSR     | wrapper         | config resolution, `maxAgeSeconds`, request origin and public exports |
| Next.js         | wrapper         | `cookies()`, `headers()`, redirects, proxy trust and route handlers   |
| Nuxt            | wrapper         | Nitro runtime config, H3 events, middleware and composables           |
| Fastify example | direct core use | application-specific environment and response mapping only            |

The shared adapter contract suite verifies that Angular, Next.js, Nuxt and the
Fastify example all accept the same complete token and fail closed for a wrong
issuer, a wrong audience, or an omitted expected issuer.

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
