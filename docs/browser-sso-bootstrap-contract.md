# Application-owned browser SSO bootstrap, version 1

The hosted sign-in contract remains the default. This extension is advertised
only with `[auth.sso].bootstrapEnabled = true`. Applications must also select
`browserSsoLoginUi = "app-owned"`; existing clients ignore the optional
capability and continue using hosted sign-in.

## Sequence and authority

1. The app starts its existing sealed state/PKCE transaction. With bootstrap
   capability support it requests `loginUi=app-owned` at `/sso/authorize`. An
   allowed existing central identity still returns a normal authorization code.
   Otherwise the issuer creates a browser-bound request with flow `app-owned`,
   sets its own binding cookie, and redirects to the registered app start URI
   with `ssoPrepared=1`, state and request ID. The app validates its original
   transaction and the request's PKCE binding before showing its form.
2. The app stores a small, separate encrypted continuation cookie for that
   state. The form carries the public state value. The backend alone recovers
   the request ID and PKCE verifier from HttpOnly cookies. Email sign-in sends
   optional `browserSso: { requestId, codeVerifier, redirectUri }` to `/signin`.
   The issuer binds the current email grant to this request without extending
   its absolute deadline. Resending rotates the grant used for bootstrap.
3. Local email/OTP verification uses the existing replay guard exactly once. Its
   optional browserSso context must match the same pending request and current
   grant before a ticket can be issued. The normal accessToken remains present.
   Participating JSON responses may additionally contain
   `browserSso: { bootstrapTicket }`, or a typed bootstrap failure. A bootstrap
   failure after local verification must still return the valid local JWT.
   Legacy requests and responses remain unchanged when not participating.
4. The app sets its existing local JWT cookie and updates the continuation
   cookie to bind the exact JWT hash and ticket. It navigates the document to
   `/sso/bootstrap/redeem?ticket=...&redirectUri=...&state=...`. JSON OTP
   returns an optional continuationUrl to the frontend, which uses a full
   document navigation. Following a redirect inside fetch does not establish
   browser SSO.
5. A matching issuer browser binding permits silent ticket redemption after the
   user's explicit local email/OTP verification. A missing/different binding
   requires a page naming the verified identity and an explicit, CSRF-protected
   POST confirmation. A different active central identity also requires
   confirmation before replacement, regardless of its creation time. Redeeming a
   ticket atomically consumes it, revokes the previous central handle and
   creates a new immutable central session. Current target-site grants are
   checked again around awaits.
6. In the original browser the issuer redirects to the registered app callback
   with state, `browserSso=complete` and an HMAC completion receipt. In another
   browser it links to the registered start URI to create fresh app state. The
   finish callback requires the original sealed transaction, the encrypted
   finish context, a locally verified existing JWT with the exact expected hash,
   and the issuer receipt. It sets no authentication cookie and performs no
   second JWT exchange. It clears only that transaction and returns to the saved
   destination. Later entry to B uses normal state/PKCE authorization.

## Deadlines and single use

The request keeps the existing absolute request deadline. A ticket lives no
longer than the issuer code lifetime (default 60 seconds) or its request's
remaining lifetime. Wrong PKCE, callback, site, flow or grant must not consume a
request or ticket. Concurrent redemption succeeds once in file and Redis modes.
The local verification grant is consumed through its existing replay guard;
bootstrap cannot independently redeem that grant again. Expired or unknown
outcomes never trigger an old-code or old-grant retry.

The first app JWT is capped to the configured SSO session lifetime for a
participating verification. Central identity expiry still follows issuer policy.
Existing valid app sessions are preserved on every bootstrap failure. Central
and local logout keep their hosted-first meanings. Central logout advances a
browser binding epoch, invalidating outstanding bootstrap tickets and sessions
whose delayed cookie response belongs to the old epoch. Hosted-only bindings
retain their original representation. New requests after logout use the new
epoch; a stale session handle cannot revoke a newer identity in another browser.

## Cookies and cryptography

Keep the existing transaction cookie until bootstrap finishes so the shared
three-transaction limit continues to apply. Each state has at most one extra
host-only root HttpOnly, Secure, SameSite=Lax cookie:
`__Host-magic-sso-continuation-STATE` (the explicit local HTTP exception omits
`__Host-`). It contains only the additional continuation data; the original
transaction retains the trusted destination and PKCE proof.

Continuation envelopes use `v1.` followed by unpadded canonical base64url of a
fresh 12-byte nonce and AES-256-GCM ciphertext with a 128-bit tag. The cookie
name is authenticated data. HKDF-SHA256 uses the UTF-8 JWT secret as material,
issuer origin as salt and this exact info string:

```text
magic-link-sso/browser-sso/v1/continuation\nAUDIENCE\nREDIRECT_URI
```

The strictly validated payload has v=1, phase, state, requestId and expiresAt
(milliseconds). Prepared phase has exactly these five fields. Finish phase
additionally has bootstrapTicket and accessTokenHash, both canonical 43-byte
base64url text values. The token hash is SHA-256 of the complete JWT, not a
claim selected from it. Local-only failure state may bind the same token hash
without a ticket. Every continuation expires no later than its original
transaction, and each cookie stays within the existing 1536 ASCII-byte budget.

The completion receipt is a base64url HMAC-SHA256 under a separate HKDF key. Its
info is `magic-link-sso/browser-sso/v1/bootstrap-receipt\nAUDIENCE`. The
authenticated message is the UTF-8 JSON object, in this order:

```json
{
    "v": 1,
    "issuer": "ISSUER",
    "audience": "AUDIENCE",
    "redirectUri": "REDIRECT_URI",
    "state": "STATE",
    "ticketHash": "SHA256_BASE64URL_TICKET",
    "accessTokenHash": "SHA256_BASE64URL_JWT"
}
```

Verify the MAC with the platform's constant-time cryptographic primitive. The
receipt proves that shared setup completed; it is never an authentication
credential by itself. All callback/continuation responses are no-store with
no-referrer, escaped status copy and no scripts. Auth queries must not be
logged.

## Failure and compatibility behavior

Issuer recovery redirects use the exact registered callback with
`browserSso=failed` and state; these callbacks never establish authentication.

A missing app transaction, a changed local identity, an expired ticket or a lost
bootstrap result never clears a valid app JWT. Explain that local sign-in is
complete while shared sign-in was not completed. Offer entry to the app and an
explicit fresh hosted sign-in. Do not reuse the consumed email/OTP grant or
retry the same ticket after an unknown result. With missing browser state, use
fresh registered app state; never accept a bare ticket as account selection.

A hosted-only or older issuer must not receive a partially started bootstrap
transaction. Required mode fails clearly when this capability is absent; auto
mode may select the existing local protocol before creating state. This does not
claim that legacy verification created a central session. Bootstrap policy
changes are restart-required, as are the existing issuer registrations.

## Acceptance before completion

Verify independent file/Redis ticket operations, cross-language continuation and
receipt fixtures, wrong proof/nonconsumption, concurrent single use, absolute
expiry, resend grant rotation, and rollback invariants. Extend the HTTPS ring
with local magic-link and in-place OTP forms across the adapters. Include first
login/reuse in both directions, exact return queries, new-browser confirmation,
changed local/central accounts, lost outcomes with a retained local JWT, and a
finish callback with no valid local session. Keep hosted and legacy suites
green.

## Portable TypeScript integration

`createBrowserSsoClient({ ...trustedOptions, loginUi: 'app-owned' })` requires
`appOwnedBootstrapVersion: 1` before creating a transaction. Hosted clients
continue accepting the original capability document. Auto mode can choose the
legacy protocol only before state is created.

`createBrowserSsoBootstrapClient` provides backend-only `prepare`, `context`,
`complete` and `finish` operations for custom application forms. Pass raw parsed
cookies with duplicate names preserved. Forms carry the public state; recover
the request ID and PKCE proof with `context` on the backend. Forward that
context as `browserSso` in the existing sign-in and local verification JSON
requests. Verify the returned JWT and set the application's existing session
cookie before navigating to `complete`'s issuer URL. A JSON OTP handler may
return that URL as `continuationUrl` for a full document navigation. A `local`
result means shared setup was not completed; keep the local session and offer a
fresh transaction.

`createBrowserSsoHttpHandler` includes script-free reference application forms
at its existing start route when `loginUi: 'app-owned'` is selected. Mount GET
and POST for that route. Supply the backend-only existing `previewSecret` to
show the verified email identity before a magic-link confirmation. Email and OTP
verification remain ordinary backend calls to the issuer's local APIs. All
reference form responses are private and permit form navigation only to the
application and its configured issuer. The app cookie path must include the
callback, because finish requires the actual existing local JWT cookie.

The application-owned HTTPS acceptance profile passes 81 cases across Chromium,
Firefox and WebKit, including both Gate modes and all five framework examples.
It verifies local-cookie creation before the issuer session, independent reuse,
exact query/scope handling, missing local JWT at finish, revoked grants, email
and ticket browser changes, explicit account replacement, outstanding-ticket
cancellation on logout, and a consumed ticket whose successful result is lost.
File/Valkey issuer and store regression passes 126 cases. Python and TypeScript
independently verify the same encrypted continuation and HMAC receipt vectors.
