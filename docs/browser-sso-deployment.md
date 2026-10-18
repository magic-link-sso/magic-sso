# Deploy shared browser sign-in

Browser SSO is opt-in. One hosted email verification establishes an issuer
identity; each application still checks its own current grants and receives its
own JWT. Start with two applications and keep their existing local sign-in
available during rollout. Application-owned forms use the existing protocol
until the separate bootstrap extension is enabled.

## Configure the issuer

Use a dedicated HTTPS hostname, for example `https://login.identity.example`. An
application must use a different hostname, including when ports differ. Do not
configure a shared cookie Domain for central SSO. The issuer uses its own
host-only HttpOnly, Secure, SameSite=Lax cookies.

Add this to an otherwise working issuer configuration, replacing the sample
origins and address with your deployment values:

```toml
[auth.sso]
enabled = true
sessionLifetimeSeconds = 28800
requestLifetimeSeconds = 900
codeLifetimeSeconds = 60

[[sites]]
id = "portal"
origins = ["https://portal.alpha.example"]
allowedRedirectUris = ["https://portal.alpha.example/*"]
allowedEmails = ["person@example.com"]
[[sites.sso]]
redirectUri = "https://portal.alpha.example/sso/callback"
startUri = "https://portal.alpha.example/sso/start"
signedOutUri = "https://portal.alpha.example/sso/signed-out"

[[sites]]
id = "reports"
origins = ["https://reports.beta.example"]
allowedRedirectUris = ["https://reports.beta.example/*"]
allowedEmails = ["person@example.com"]
[[sites.sso]]
redirectUri = "https://reports.beta.example/_magicgate/sso/callback"
startUri = "https://reports.beta.example/_magicgate/sso/start"
signedOutUri = "https://reports.beta.example/_magicgate/signed-out"
```

The first site uses SDK routes; the second uses Gate's default namespace.
Callback registrations are exact URLs without query strings, fragments or
wildcards. Django's default mount uses trailing slashes: `/sso/start/`,
`/sso/callback/`, `/sso/signed-out/`. A prefixed Gate must register its full
public prefix and namespace. Add one registration triple per origin.
Access-grant reloads remain supported. Policy, hostname or registration changes
require an issuer restart.

Use Redis for multiple issuer replicas. The file adapter supports one issuer
process with durable private storage. Both adapters atomically validate and
consume a code; a wrong verifier cannot burn a valid code. Keep clocks in sync
and preserve the existing JWT secret configuration for participating apps.

## Enable the applications

For SDK examples, configure the backend environment:

```dotenv
MAGICSSO_BROWSER_SSO_MODE=auto
MAGICSSO_SERVER_URL=https://login.identity.example
MAGICSSO_PUBLIC_ORIGIN=https://portal.alpha.example
MAGICSSO_JWT_SECRET=<existing-shared-JWT-secret-at-least-32-characters>
MAGICSSO_BROWSER_SSO_TIMEOUT_MS=5000
```

Django uses the corresponding settings; its example reads these variables.
Nuxt's equivalent runtime options are `browserSsoMode`, `serverUrl`,
`publicOrigin`, `jwtSecret` and `browserSsoTimeoutMs`. Keep secrets in private
server configuration. Angular TransferState must contain public fields only.

Next.js needs public GET route files re-exporting `BrowserSsoStartRoute`,
`BrowserSsoCallbackRoute` and `BrowserSsoSignedOutRoute` as `GET`. The Nuxt
module and Django URLconf register their routes. Angular SSR and the Fastify
example mount the shared server handler before application routing. Protect
Angular SSR documents in the HTTP server before rendering; keep backend API
authorization.

Gate uses its existing server/public-origin/JWT configuration plus:

```toml
[auth.sso]
mode = "auto"
```

`auto` falls back before creating a transaction only for HTTP 404, explicitly
disabled SSO, or an unsupported version. Timeouts, redirects, malformed replies
and 5xx fail visibly. After the pilot passes, use `required` to reject legacy
issuers. `off` retains existing sign-in behavior. HTTP loopback development
requires the explicit `allowInsecureLocalhost` Gate option or
`MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST=true`; omit it in production.

Use full document links for sign-in. Do not put the issuer in an iframe or use
cross-origin browser fetch for discovery/exchange. SDK backends perform those
requests. Preserve Cookie, Set-Cookie and Location through trusted proxies;
avoid caching auth responses or logging their query strings. Configure trusted
proxy HTTPS handling explicitly, including `MAGICSSO_TRUST_PROXY` in the Django
example. The fixed public origin remains the source of callback URLs.

## Verify a pilot

1. Run `pnpm doctor server --config /absolute/path/to/config.toml --json`. It
   validates policy/registrations without contacting the network or creating
   stores. Add `--online` to check the deployed capabilities and SMTP
   connection; email is sent only with the separate explicit test-email option.
2. Open application A in a fresh browser, sign in through the hosted page and
   confirm the email (or enter its OTP). Open an allowed B on another domain. B
   must open without another email and show its own permissions.
3. Remove B's grant, clear only B's local app session, and enter B again. Access
   must be denied without another email or an automatic redirect loop. Restoring
   the grant permits a fresh sign-in attempt.
4. Sign out locally from B. Its public signed-out page must remain visible; A
   stays signed in. B's explicit sign-in link can reuse central SSO.
5. From B's signed-out page choose **End browser SSO session** and confirm on
   the issuer. Existing A JWTs retain their normal expiry policy. A new B
   session requires verification again.
6. Verify a different account explicitly. Applications with valid existing
   sessions keep their current identity until their local session is cleared or
   expires. A new application session uses the new central identity.

The automated acceptance profile uses reserved `.test` domains with different
registrable domains, ephemeral TLS, actual production application builds,
Chromium/Firefox/WebKit and blocked third-party cookies. It checks the full Gate
→ Next.js → Nuxt → Django → Angular SSR → Fastify → Gate ring for link and OTP,
plus live grants, browser changes, independent tabs, account changes, logout,
replay and a consumed-code response failure. It asserts that issuer SSO requests
are top-level navigations, and verifies third-party cookie blocking with a
separate control probe. Run:

```sh
pnpm --filter magic-sso-e2e exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e:sso:https
```

The harness changes DNS and CA trust only inside its processes. It leaves OS
resolver/trust configuration untouched and removes its temporary certificates.
Storage expiry and race cases use deterministic unit/store tests, including a
real Redis-compatible profile; they are not simulated by browser time travel.

## Diagnose a failed attempt

| Visible result                            | Check                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSO required / unavailable                | Doctor capabilities result, deployed version, exact issuer URL, TLS trust and backend connectivity. A discovery error must not silently downgrade.   |
| Access denied                             | Current target-site email/scope grants. A's JWT grants no authority in B.                                                                            |
| No matching sign-in tab                   | Host-only transaction cookie, callback origin/path, duplicate cookie names, browser change or copied callback. Start a fresh app transaction.        |
| Sign-in expired                           | App/issuer clocks and absolute request/code deadlines. Resending does not extend the request.                                                        |
| Too many sign-in tabs                     | Finish one of the three app transactions or wait for expiry. Existing transactions are retained.                                                     |
| Callback failed after exchange            | Do not retry the old code. The issuer may already have consumed it. Return to the app and start a fresh transaction; keep an existing valid app JWT. |
| App immediately signs in after logout     | Logout must land on the public signed-out route, not a protected home route.                                                                         |
| New central identity but old app identity | Expected while that app JWT remains valid. End that local session before switching it.                                                               |

Never attach codes, state, sealed cookies, OTPs or email proofs to diagnostics.
Record route names, protocol version, status and a non-secret correlation ID.

## Roll back

Set participating adapters to `off`, keep their start/callback/signed-out routes
mounted, and restart them. Pending callbacks fail explicitly and preserve valid
app sessions; they never fall back to email proof. Then disable `[auth.sso]` on
the issuer and restart it. Already issued app JWTs keep their existing policy.
Central sign-out alone does not revoke them.

For a gradual rollback, allow outstanding transactions to finish before turning
off the issuer: default transaction lifetime is 990 seconds, with a capability
cache bounded to another 60 seconds. Policy/registration changes need a restart.
Keep durable issuer state for recovery and restore compatible configuration
before opting applications back in.

## Enable application-owned forms

First enable `[auth.sso].bootstrapEnabled = true` on the issuer and restart it.
Doctor then expects `appOwnedBootstrapVersion: 1` in capabilities. Select
`MAGICSSO_BROWSER_SSO_LOGIN_UI=app-owned` on each participating application
(`browserSsoLoginUi` in Angular/Nuxt configuration; Django uses the
corresponding setting). Gate selects `loginUi = "app-owned"` in its `[auth.sso]`
table. Both flags are opt-in; default sign-in remains hosted.

Keep the existing backend-only preview secret configured for explicit magic-link
identity confirmation. Mount POST as well as GET on the start route; for Next.js
export `BrowserSsoStartRoute` as both methods. Nuxt and Django mount these
methods themselves; Angular/Fastify server examples show the bridge. The
application's host-only JWT cookie path must include the callback.

Entry through the SSO start route first establishes issuer browser binding.
Without an existing central session it returns to a local application form.
Local email/OTP verification establishes the app JWT first, then a document
visit redeems a short-lived, one-use bootstrap ticket at the issuer. A signed
receipt confirms completion against that exact existing JWT. The callback sets
no authentication cookie and does not exchange another JWT.

An email opened without its original app state can still establish the normal
local session after explicit confirmation, but reports that shared setup was not
completed. A ticket opened in another browser requires explicit issuer
confirmation and then a fresh transaction from the registered start URI. A
different active central account also requires confirmation. Existing app
identities retain their normal lifetime.

An expired ticket, revoked current grant or lost result preserves a valid app
JWT. Recovery offers entry to the app and explicit fresh hosted sign-in; do not
retry old tickets or consumed email/OTP grants. Central logout cancels
outstanding bootstrap tickets and delayed bootstrap session cookies through the
browser binding's revocation epoch.

Use `pnpm test:e2e:sso:app-owned` for the separate three-browser HTTPS
acceptance profile. It exercises local link/OTP forms across both Gate modes and
every SDK, exact return queries, actual cookie ordering, cross-site reuse and
failure behavior. The existing hosted and legacy browser suites remain required.
For custom forms and JSON OTP continuations, use the backend-only primitives in
[the bootstrap contract](browser-sso-bootstrap-contract.md).

To roll back the UI extension, allow outstanding transactions to finish first,
then choose `hosted` on applications and Gate. Disable issuer `bootstrapEnabled`
and restart. If immediate rollback is necessary, pending callbacks fail
explicitly while valid local JWTs are retained. Keep ordinary browser SSO
enabled if it is still needed. For a full rollback follow the `off` procedure
above.
