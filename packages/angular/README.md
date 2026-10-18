# @magic-link-sso/angular

Reusable helpers for integrating Angular 21+ SSR apps with the Magic Link SSO
server.

## Install

```sh
npm install @magic-link-sso/angular
```

Peer dependencies:

- none beyond your Angular app's own runtime dependencies

## What It Provides

- token and cookie helpers such as `verifyAuthToken()`, `verifyRequestAuth()`,
  `buildAuthCookieOptions()`, and `buildLoginTarget()`
- return-url helpers such as `normaliseReturnUrl()` and `buildVerifyUrl()`
- config helpers such as `resolveMagicSsoConfig()` and `getJwtSecret()`
- `exchangeEmailOtp()` for server-side code exchange and site-bound token
  validation

`buildLoginPath()` and `buildLoginTarget()` both accept an optional final
`scope` argument, verified auth payloads expose `email`, `scope`, and `siteId`,
and direct `verifyAuthToken()` calls now require explicit `expectedAudience` and
`expectedIssuer` values.

## Required Environment Variables

```env
MAGICSSO_SERVER_URL=http://localhost:3000
MAGICSSO_JWT_SECRET=replace-me-with-a-long-random-jwt-secret
MAGICSSO_PREVIEW_SECRET=replace-me-with-a-different-long-random-preview-secret
MAGICSSO_COOKIE_NAME=magic-sso
```

Optional:

```env
MAGICSSO_COOKIE_PATH=/
MAGICSSO_COOKIE_MAX_AGE=3600
MAGICSSO_DIRECT_USE=false
```

| Variable                  | Required                 | Default                    | Notes                                                                                                                                                       |
| ------------------------- | ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAGICSSO_COOKIE_NAME`    | Effectively yes          | `token` in helper defaults | Set this explicitly to match the server cookie name. The Angular `/logout` route expects it too.                                                            |
| `MAGICSSO_COOKIE_PATH`    | No                       | `/`                        | Optional path scope for the Angular-managed auth cookie. Narrowing it can make auth unavailable outside that subtree.                                       |
| `MAGICSSO_COOKIE_MAX_AGE` | No                       | Session cookie             | Optional persistent cookie lifetime in seconds for the Angular-managed auth cookie. Set it to match or stay below the server JWT expiration.                |
| `MAGICSSO_DIRECT_USE`     | No                       | `false`                    | Used by helper functions that build a hosted `/signin` target when you want to skip the local login page. `1`, `yes`, and `on` are also treated as enabled. |
| `MAGICSSO_JWT_SECRET`     | Yes for protected routes | None                       | Used by the Angular SSR server and session helpers to verify the auth JWT. Must match the server JWT secret.                                                |
| `MAGICSSO_PREVIEW_SECRET` | For app-owned callbacks  | None                       | Required when the Angular SSR app owns `/verify-email` and previews the email token before exchanging it. Must match the server preview secret.             |
| `MAGICSSO_SERVER_URL`     | Yes                      | None                       | Base URL of the SSO server used by the local sign-in endpoint, `/verify-email` callback, and issuer validation for site-bound auth tokens.                  |

Auth tokens are site-bound. Upgrading to this release invalidates older session
cookies that were issued without `siteId`/`aud`/`iss`, so users need to sign in
again after deployment.

## Basic Usage

### Use the helpers in your Angular app

```ts
import { buildLoginPath, verifyRequestAuth } from '@magic-link-sso/angular';

const loginPath = buildLoginPath('http://localhost:3004', '/protected');
const auth = await verifyRequestAuth(
    new Request('http://localhost:3004/protected', {
        headers: {
            cookie: request.headers.cookie ?? '',
        },
    }),
    {
        serverUrl: 'http://localhost:3000',
    },
);

if (auth === null) {
    return redirect(loginPath);
}
```

### Verify a token directly

```ts
import { verifyAuthToken } from '@magic-link-sso/angular';

const auth = await verifyAuthToken(token, secret, {
    expectedAudience: 'http://localhost:3004',
    expectedIssuer: 'http://localhost:3000',
});
```

### Exchange an email OTP

`exchangeEmailOtp()` is for an Angular SSR/Node handler. It submits a challenge
and code to the SSO server, validates issuer and audience, and returns the
verified token for that handler to place in its HTTP-only cookie. Never invoke
it from browser-only code or store the returned token client-side.

## Example App

See the bundled Angular SSR example in
[`examples/angular/`](../../examples/angular/) for a full integration using the
same package.

## Shared browser SSO (opt-in)

Hosted browser SSO reuses the issuer's identity while this application keeps its
own JWT and permissions. The default mode is `off`. Set
`MAGICSSO_BROWSER_SSO_MODE=auto` for capability-controlled legacy fallback, or
`required` to reject an issuer that does not support this protocol. Set
`MAGICSSO_PUBLIC_ORIGIN` to the exact externally visible app origin and keep
`MAGICSSO_SERVER_URL` and `MAGICSSO_JWT_SECRET` on the backend. A distinct
issuer hostname and HTTPS are required. Local HTTP is available only with the
explicit `MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST=true` test/development
exception. `MAGICSSO_BROWSER_SSO_TIMEOUT_MS` defaults to 5000 (100–30000).

Register the app's exact start, callback and signed-out URLs in the issuer's
`[[sites.sso]]` configuration. These routes stay public even when whole-app auth
is enabled. Start/callback must use top-level document navigation; prefetch and
client-side data requests must not create or consume transactions. Three tabs
can sign in independently. Callback failures leave existing app sessions intact.
Local logout clears this app's cookie and shows a public page with separate
sign-in and central sign-out controls. Ending central SSO leaves other issued
app JWTs subject to their existing expiry policy.

See the [browser session contract](../../docs/browser-sso-contract.md) for
registration, rollout and protocol details. Application-owned forms keep their
existing behavior until the separate bootstrap continuation is enabled.

The Angular helper exports `createBrowserSsoHandler(config)`, a server-only
Fetch `Request` → `Response` handler for `/sso/start`, `/sso/callback` and
`/sso/signed-out`. Create it once in the SSR server, before the Angular
catch-all handler. `buildLoginPath` and `buildLoginTarget` select `/sso/start`
when opted in; CSR guards must use a full document navigation for that target.
Only public configuration belongs in Angular TransferState; never serialize
`jwtSecret`. The Express example wires these routes and excludes the secret from
HTML.

Protect SSR document routes in the HTTP server before calling
`AngularNodeAppEngine.handle`: verify with `verifyRequestAuth`, then issue a 307
to `buildLoginTarget` when missing. The example does this for `/protected`.
Angular router guards cannot navigate to a backend-only route in the Angular
route tree, and they do not replace authorization on backend APIs.

### Application-owned sign-in forms

With issuer `[auth.sso].bootstrapEnabled = true`, set
`MAGICSSO_BROWSER_SSO_LOGIN_UI=app-owned` alongside the browser SSO mode. The
start route renders email and OTP forms on this application's own origin. Keep
`MAGICSSO_PREVIEW_SECRET` on the backend for magic-link identity confirmation.
The local JWT is verified and set before the browser visits the issuer to
complete shared sign-in. A failed shared setup keeps any valid local session and
offers an explicit fresh hosted sign-in. The default remains `hosted`.

Custom forms can use the backend-only continuation operations documented in
[the bootstrap contract](../../docs/browser-sso-bootstrap-contract.md). Mount
POST as well as GET at `/sso/start`; the callback remains GET. The session
cookie path must cover the callback. The app form uses full document navigation
and requires neither third-party cookies nor a browser fetch to the issuer.

The corresponding SSR config option is `browserSsoLoginUi: "app-owned"`. Keep
the existing server handler mounted for both request methods.
