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
