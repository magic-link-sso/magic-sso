# Magic Link SSO browser session contract, version 1

This contract defines hosted sign-in, shared browser sessions, configuration,
wire formats, lifetimes, browser binding, and logout for Magic Link SSO. Gate,
Next.js, Angular SSR, Nuxt, and Fastify use the portable core client; Django
implements the same wire and crypto contract independently. Participation is
opt-in; follow the [deployment and rollback guide](browser-sso-deployment.md) to
enable it. Application-owned sign-in forms use the separate
[bootstrap extension contract](browser-sso-bootstrap-contract.md), with its own
opt-in flag.

## Ownership and compatibility

The issuer owns an opaque, server-side email identity session. Every application
owns a separate existing site-bound JWT and application cookie. The central
session stores no grant snapshot. Authorization and exchange both consult the
current site's access rules, including the requested scope. Never reuse an A JWT
as a B JWT or send the central cookie handle to an application.

Hosted sign-in uses the issuer's magic-link or OTP UI. Existing local forms and
JSON responses remain unchanged when they do not participate in the bootstrap
extension. Backend verification alone establishes no central session;
participating forms use the explicit browser continuation defined by the
bootstrap extension. This protocol is not an OAuth/OIDC interoperability claim.

Adapters default to `off`; `auto` and `required` explicitly opt into hosted SSO.
Gate uses `[auth.sso].mode`; SDKs use `MAGICSSO_BROWSER_SSO_MODE`. Existing
`directUse` selects the legacy experience when SSO is off or explicitly
unsupported. Capability discovery precedes creation of an app transaction.

## Configuration

The existing server issuer URL and file/Redis security-state selection are
reused. Prepare policy and a tuple for each participating public origin:

```toml
[auth.sso]
enabled = false
allowInsecureLocalhost = false
sessionLifetimeSeconds = 28800
requestLifetimeSeconds = 900
codeLifetimeSeconds = 60

# Under the existing [[sites]] entry for app.example.com:
[[sites.sso]]
redirectUri = "https://app.example.com/sso/callback"
startUri = "https://app.example.com/sso/start"
signedOutUri = "https://app.example.com/signed-out"
```

The parent site supplies `siteId`; clients do not need a new site ID environment
variable. Each tuple has three distinct, exact canonical URLs on one configured
site origin. Query strings, fragments, credentials, wildcards, ambiguous encoded
separators, and noncanonical spellings are rejected. There is one tuple per
public origin. Wildcard `allowedRedirectUris` never register SSO callbacks. The
fixed start URI is the recovery entrypoint, not an arbitrary return URL.

The issuer must have a dedicated hostname, different from every application,
including nonparticipating applications. Different ports do not isolate cookies;
see [RFC 6265 section 8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5).
Use HTTPS. Explicit `allowInsecureLocalhost=true` permits HTTP only on
localhost, its `.localhost` subdomains, `127.0.0.1`, or `::1`; the hostname
separation still applies. A disabled policy with no registrations imposes no new
deployment constraints on legacy configuration.

Policy and registration remain operator-owned in managed mode. Manager changes
only grants/scopes and preserves these fields. Server reload accepts grant-only
changes; changing policy or any registration requires a restart, without
partially adopting the candidate grants.

| Lifetime              | Default                     | Inclusive configurable bounds     |
| --------------------- | --------------------------- | --------------------------------- |
| Central session       | 28800 seconds               | 300–86400 seconds                 |
| Authorization request | 900 seconds                 | 60–1800 seconds                   |
| Authorization code    | 60 seconds                  | 15–120 seconds                    |
| App transaction       | request + code + 30 seconds | Derived from advertised lifetimes |

All timestamps are integer Unix seconds. At `now >= expiresAt` the record is
expired. The 30-second app allowance retains local state during a callback; it
never extends an issuer request, code, central session, or JWT. A new JWT
expires at the earlier of normal JWT expiry and central expiry. Resends never
extend a request deadline or central session, and each grant expires no later
than its request. Legacy JWTs retain their existing expiry policy.

## Wire protocol

The synthetic
[JSON fixtures](../packages/core/test/fixtures/browser-sso-v1.json) are shared
with the independent Python adapter, including a sealed transaction vector
verified with an independent crypto implementation. Fixture key material and
fixed nonces are public test data, never deployment values. The PKCE pair is the
public example from
[RFC 7636 Appendix B](https://www.rfc-editor.org/rfc/rfc7636#appendix-B).

| Endpoint                | Request                                                                                               | Response                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /sso/capabilities` | No browser identity required                                                                          | `browserSso` object below                                                                                        |
| `GET /sso/authorize`    | `redirectUri`, `state`, `codeChallenge`, `codeChallengeMethod=S256`; optional `scope`, `prompt=login` | Hosted verification, denial, or exact callback with `code` and `state`                                           |
| `POST /sso/exchange`    | JSON `{ code, codeVerifier, redirectUri }`, backend only                                              | Existing `{ accessToken }` JSON shape                                                                            |
| `GET /sso/signout`      | Optional exact registered `returnUri`                                                                 | Confirmation form; no state mutation                                                                             |
| `POST /sso/signout`     | Same-origin request and CSRF proof                                                                    | Revoke current central session, clear central cookie, 303 to registered signed-out URI or issuer completion page |

Enabled capabilities have this shape:

```json
{
    "browserSso": {
        "version": 1,
        "enabled": true,
        "loginUi": "hosted",
        "codeChallengeMethods": ["S256"],
        "requestLifetimeSeconds": 900,
        "codeLifetimeSeconds": 60,
        "transactionLifetimeSeconds": 990
    }
}
```

Disabled capabilities are
`{ "browserSso": { "version": 1, "enabled": false } }`. An unknown positive
integer version is explicitly unsupported. Missing fields, invalid types/bounds,
inconsistent transaction lifetimes, and invalid methods or login UI in a
version-1 enabled document are malformed, not disabled.

`auto` may select legacy login only on HTTP 404, explicit disabled support, or
an explicit unsupported version. `required` reports a configuration/version
error instead. Timeouts, 5xx, redirects, and malformed responses are
availability or protocol errors; none silently select legacy login. Capabilities
cache for at most 60 seconds, keyed by exact trusted issuer. Backend requests
use a five-second timeout and reject redirects; callers may explicitly configure
100–30000 ms.

App/Gate start routes are `/_magicgate/sso/start` and `/sso/start`; callbacks
are `/_magicgate/sso/callback` and `/sso/callback`; signed-out pages are
`/_magicgate/signed-out` and `/signed-out`. Gate applies its configured
namespace and public path prefix. Adapters register these as public
infrastructure routes. They normalize and retain the full original same-origin
return URL locally. Navigation between origins uses top-level GET; form success
uses 303.

States, codes, central handles, and browser binding handles use 32 random bytes,
base64url without padding (43 characters). PKCE verifiers follow RFC 7636's
43–128 unreserved-character syntax; adapters generate 32 random bytes as
base64url. The S256 challenge is base64url(SHA-256(ASCII(verifier))), without
padding. Only S256 is supported. `scope` defaults to the existing full-access
request; a named scope retains current server semantics, with a 256-byte input
limit. The issuer validates the exact registration before echoing state to a
callback. Malformed or unknown callbacks render an issuer error page.

Errors have JSON `{ "error": "<code>" }` and optional human-readable `message`.
A validated authorization context may redirect with `error` and original
`state`, without a token. Use `Cache-Control: no-store` and
`Referrer-Policy: no-referrer` on protocol, callback, error, and sign-out
responses. Never log code, verifier, opaque cookies, email proof, or an
unredacted protocol query string.

| Issuer code               | Status | Meaning                                                        |
| ------------------------- | ------ | -------------------------------------------------------------- |
| `invalid_request`         | 400    | Malformed fields, unsupported proof method, or request binding |
| `invalid_callback`        | 400    | Unknown or invalid registration; no callback redirect          |
| `access_denied`           | 403    | Current site/scope grant is absent                             |
| `request_expired`         | 400    | Verification cannot finish the original request                |
| `code_expired`            | 400    | Exchange deadline passed                                       |
| `code_rejected`           | 400    | Unknown/consumed code or mismatched proof/callback binding     |
| `session_expired`         | 401    | Central session expired or was revoked                         |
| `sso_disabled`            | 409    | Feature was disabled during an existing transaction            |
| `temporarily_unavailable` | 503    | Store or issuer dependency unavailable                         |

Wrong proof or binding does not consume a valid code. An unavailable store does
not masquerade as a missing session. Atomic validation/consumption allows
exactly one valid concurrent exchange. The consumed code carries immutable site,
callback, scope, challenge, and central session ID; current session and grants
are checked before issuing the JWT.

After expiry cleanup, an expired code is indistinguishable from an unknown or
consumed code and returns `code_rejected`. A retained code referring to a
revoked central session returns `session_expired`.

## Browser state and concurrent tabs

Central cookie: `__Host-magic-sso-browser` on HTTPS, `magic-sso-browser` for
explicit local HTTP. Issuer request binding cookie:
`__Host-magic-sso-browser-binding`, or `magic-sso-browser-binding` locally. All
are `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only; HTTPS cookies are Secure.
They never inherit the application's `cookieDomain`. Reserved names cannot be
selected as the legacy app cookie name. The
[cookie prefix rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes)
apply independently of port numbers.

The issuer retains one stable unauthenticated browser binding across outstanding
requests and keeps it usable through the longest pending request. Each request
has its own ID and immutable state, challenge, registration, and scope. Bind the
email grant and OTP rotation key to this request ID, so resending in one tab
does not invalidate another tab. Use existing page/request rate limits, allow at
most 32 outstanding issuer requests per binding, and expire abandoned records.

Apps use one encrypted transaction cookie per state, not one mutable global
cookie. Cookie names are `__Host-magic-sso-tx-<state>` on HTTPS and
`magic-sso-tx-<state>` locally, with the same HttpOnly/Lax/host-only/root
policy. Retain at most three pending transactions; remove expired cookies and
reject a fourth start with `transaction_limit` instead of overwriting an earlier
tab. The return URL is at most 512 UTF-8 bytes and a sealed value at most 1536
ASCII bytes. Oversized starts return `transaction_too_large`, retaining existing
state.

Freeze the sealed representation for replica and Python compatibility:

- Payload is UTF-8 JSON, with fields `v=1`, `state`, `codeVerifier`,
  `returnUrl`, `issuer`, `audience`, `redirectUri`, integer `createdAt`, integer
  `expiresAt`, and integer `restarts` (0 or 1). Reject unknown versions and
  invalid fields.
- Derive an AES-256-GCM key from the existing app JWT secret bytes using
  HKDF-SHA-256, salt UTF-8(issuer origin), and info
  UTF-8(`magic-link-sso/browser-sso/v1/transaction\n` + app origin).
- Use a fresh 12-byte nonce, a 128-bit authentication tag, and UTF-8(cookie
  name) as additional authenticated data. The value is `v1.` followed by
  unpadded base64url(nonce || ciphertext || tag). Reject invalid/tampered
  envelopes before reading transaction fields. These operations use
  [Web Crypto primitives](https://www.w3.org/TR/webcrypto/).

All replicas use the same configured secret; process memory is insufficient. The
callback requires the matching state and cookie, then exchanges the code from
the backend. An invalid state cannot clear another transaction or existing app
session. A terminal callback clears only its own transaction. A repeated
callback is rejected through one-time code redemption even if the cookie was
copied. Do not claim the sealed cookie itself is globally consumed.

If an exchange response is lost, clear that transaction and offer a fresh app
start. At most one automatic restart is permitted, carrying `restarts=1` in the
new sealed transaction; it can reuse the central session without another email.
A second failure shows an actionable error. Do not retry a code or consume an
email grant through another protocol.

## Identity changes, another browser, and logout

Only explicit successful email/OTP confirmation creates a central session; GET
email previews and scanners create no session or consumed proof. Confirming a
different email explicitly replaces the current central handle/session ID and
revokes the previous current-browser central session. Its pending codes can no
longer be redeemed. Existing JWTs in other applications may still show the
previous identity until they expire or are revoked under their existing policy.
An unrelated legacy email link never silently replaces central identity.

`prompt=login` forces fresh verification. A verified account without target
access sees a denial and an explicit account-switch action; it does not receive
another automatic email or enter a redirect loop.

A link opened in another browser lacks the original app and issuer transaction
binding. After explicit account confirmation, establish central identity there
and offer the registered fixed `startUri` to create fresh app state. Never
bypass PKCE/state to complete the original callback. Retain the deep link only
where the original app transaction remains available. The original tab is not
silently authenticated. Original-tab OTP is an alternative only while its shared
grant is still redeemable; a proof consumed elsewhere requires a fresh start.

Local sign-out clears/revokes the current app session according to its existing
adapter behavior and lands on a public signed-out page with an explicit sign-in
button. It retains central identity, so an explicit subsequent sign-in can reuse
it. Central sign-out is a confirmed, same-origin CSRF-protected POST that
revokes the central session and outstanding codes. Combined sign-out clears the
local app session first, then navigates to the issuer. A failed central step
says the local session ended while central sign-out remains pending.

UI wording is “Sign out of this application” and “End browser SSO session”. Do
not promise “log out everywhere”: other apps' valid JWTs retain their existing
expiry/revocation policy. Ending central SSO prevents new sessions; it does not
retroactively invalidate all JWTs or other devices.

Hosted mutations require the binding-derived CSRF proof and a matching Origin.
With `no-referrer`, a browser can send `Origin: null` for an ordinary form POST.
In that case (or with Origin absent), accept only `Sec-Fetch-Site: same-origin`
together with the same CSRF proof. Cross-site, same-site, or absent metadata is
insufficient; an explicit foreign Origin always rejects. Keep the response's
`Referrer-Policy: no-referrer`. Its CSP `form-action` permits the issuer and
only registered app origins, because browsers also apply it to the 303 callback
redirect after confirmation. See the browser behavior documented in
[Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy).

## My applications launcher

The optional issuer-owned launcher is available at `/sso/apps`. Explicit
`sites.launcher` metadata supplies a display name, application destination and
scope; it never adds access. The entry list is computed from current grants
after reading the central session, and its links use the matching registered
application SSO start endpoint. Sites without this metadata are omitted.

Launcher sign-in starts with a same-origin, CSRF-protected POST. A stored
authorization request marked `flow: "launcher"` uses the existing bounded
request store, grant rotation, hosted email/OTP verification and account
confirmation. The issuer consumes the current request/grant atomically before
establishing the session. It rechecks current launcher access after awaited
session creation. These internal requests cannot be created by `/sso/authorize`,
cannot issue application authorization codes and never mint application JWTs.
Confirmation returns directly to `/sso/apps`. The launcher does not register an
application callback on the issuer hostname.

Anonymous responses contain no application list. Authenticated responses show
the central email, permitted entries or a helpful empty state, account change
and central sign-out controls. Pages retain no-store, no-referrer and CSP
protections. Account changes require a new explicit email confirmation and
preserve the old identity until successful confirmation. Central sign-out uses
the existing CSRF-protected confirmation and permits the exact issuer launcher
URL as an additional fixed return target. Local application sessions retain
their existing identity and expiry.

Launcher configuration is restart-invariant and preserved through managed grant
rendering. See
[deployment and rollback](browser-sso-deployment.md#my-applications-launcher).

## Storage and verification

The issuer stores only SHA-256 digests of opaque handles, request IDs, browser
bindings, email grant IDs, and authorization codes. The file adapter serializes
operations within one issuer process and replaces one private, fsynced JSON
snapshot atomically. It prunes expired records during operations, including
explicit pruning. Do not share this directory between issuer processes; use
Redis for replicas or larger session populations.

Redis records have individual absolute TTLs. A bounded compare-and-set Lua
transaction validates every read, including an active central session, before
applying any changes. Conflicts repeat validation; unavailable storage and
exhausted contention retries fail instead of impersonating a missing session.
All transaction keys use the same hash slot. Revocation removes a session, so
codes referencing it stop working without a scan of pending codes. Wrong proof,
callback, site, scope, or email does not consume the code.

The same store suite covers files and a real Redis-compatible server:

```sh
MAGICSSO_TEST_REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter magic-sso-server exec vitest run src/browserSsoStore.test.ts
```

Use an isolated test instance. Tests use unique key prefixes and expiring
records; they never flush the database. Without the environment variable the
Redis integration suite is explicitly skipped, while file and dependency-error
tests still run. Run the Redis suite explicitly when verifying a deployment that
uses Redis.

Configuration tests cover wire fixtures, capability classification, strict
policy and registration validation, managed rendering, and restart invariants.
The issuer's HTTP suite covers hosted link/OTP confirmation, central reuse,
current grants, account replacement, safe sign-out, absolute deadlines, protocol
logging, and grant separation from legacy endpoints. OTP stores validate the
browser request context before counting attempts or consuming a challenge. Run
both issuer and storage suites with the Redis environment variable to exercise
their real Lua paths. Portable client tests cover narrow compatibility fallback,
unknown exchange outcomes, duplicate cookies, expiry, state and PKCE context.
Browser acceptance uses actual production application builds on dedicated HTTPS
`.test` hostnames with distinct registrable domains. `pnpm test:e2e:sso:https`
runs these cases across Chromium, Firefox and WebKit, including an independent
third-party cookie-blocking control probe. Every issuer SSO request made by the
browser is a top-level navigation.

The ring Gate → Next.js → Nuxt → Django → Angular SSR → Fastify → Gate passes
with one hosted link or OTP, preserved return queries, isolated host-only
cookies and local sign-out. Gate ↔ Gate and Gate ↔ Next.js cover both
directions. Representative cases cover live grant removal at authorization and
exchange, central account replacement with an older valid app JWT, central
logout, confirmation in another browser, independent OTP tabs, callback replay
and a consumed code whose successful result is lost. No code retry or silent
fallback is permitted. Prefetch/RSC/iframe requests create no state and consume
no codes.

Django reproduces the shared encryption vector exactly and redacts access-log
queries. Angular TransferState excludes the JWT secret and protects SSR
documents in the HTTP server before rendering. The HTTP loopback profile
`pnpm test:e2e:sso` remains useful for quick local checks. Run the existing
`pnpm test:e2e` matrix for legacy, proxy and whole-app protection regressions;
SSO remains disabled by default. CI runs the HTTPS profile separately.
