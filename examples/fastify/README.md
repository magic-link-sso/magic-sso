# Integrating Fastify with Magic Link SSO

[Magic Link SSO](../../README.md)

This is a plain Fastify example app that demonstrates a minimal server-rendered
Node integration without a meta-framework. It reuses the shared
[`magic-sso-example-ui`](../../packages/example-ui) package for the common
layout, badge assets, and form styles used across the other examples.

## Getting Started

Install workspace dependencies from the repository root:

```bash
pnpm install
```

Copy [`examples/fastify/.env.example`](./.env.example) to `.env` if you want a
dedicated env file for the Fastify example during local development. The env
file acts as a default, and exported shell variables still override it.

Then run the example app from the repository root:

```bash
pnpm --filter example-app-fastify dev
```

To flip direct use for a run without editing `.env`, use:

```bash
MAGICSSO_DIRECT_USE=true pnpm --filter example-app-fastify dev
```

`MAGICSSO_DIRECT_USE=1` is also supported.

Open [http://localhost:3005](http://localhost:3005) with your browser to see the
Fastify flow.

## Environment Variables

At minimum, configure:

```env
MAGICSSO_SERVER_URL=http://localhost:3000
MAGICSSO_JWT_SECRET=VERY-VERY-LONG-RANDOM-JWT-SECRET
MAGICSSO_PREVIEW_SECRET=VERY-VERY-LONG-RANDOM-PREVIEW-SECRET
MAGICSSO_COOKIE_NAME=magic-sso
```

Optional:

```env
MAGICSSO_COOKIE_PATH=/
MAGICSSO_COOKIE_MAX_AGE=3600
MAGICSSO_DIRECT_USE=false
PORT=3005
```

| Variable                  | Required                 | Default                | Notes                                                                                                                                                                            |
| ------------------------- | ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAGICSSO_COOKIE_NAME`    | Effectively yes          | `token` in helper code | Set this explicitly to match the server cookie name. The Fastify logout route clears the same cookie.                                                                            |
| `MAGICSSO_COOKIE_PATH`    | No                       | `/`                    | Optional path scope for the Fastify-managed auth cookie. Narrowing it can make auth unavailable outside that subtree.                                                            |
| `MAGICSSO_COOKIE_MAX_AGE` | No                       | Session cookie         | Optional persistent cookie lifetime in seconds for the Fastify-managed auth cookie. Set it to match or stay below the server JWT expiration.                                     |
| `MAGICSSO_DIRECT_USE`     | No                       | `false`                | When `true`, protected-route redirects can point straight to the hosted SSO `/signin` page instead of the local `/login` page. `1`, `yes`, and `on` are also treated as enabled. |
| `MAGICSSO_JWT_SECRET`     | Yes for protected routes | None                   | Used by the Fastify app to verify the auth JWT returned by the SSO server. Must match the server JWT secret.                                                                     |
| `MAGICSSO_PREVIEW_SECRET` | Yes for local callback   | None                   | Used by the Fastify app to preview the email token before exchanging it. Must match the server preview secret.                                                                   |
| `MAGICSSO_SERVER_URL`     | Yes                      | None                   | Base URL of the SSO server used by the local sign-in route and `/verify-email` callback.                                                                                         |
| `PORT`                    | No                       | `3005`                 | Local port used by the Fastify example server.                                                                                                                                   |

## Integration

The example includes:

- a public home page that reads the auth cookie on the server
- a local `/login` page rendered with the shared example UI layout
- a local `/api/signin` route that forwards to the Magic Link SSO server
- a local `/verify-email` callback that exchanges the email token for the auth
  cookie
- a local `/verify-email/otp` route for code entry when the server enables OTP
- a `/protected` route gated by the auth cookie
- a POST-only `/logout` route that clears the cookie and redirects home

The sign-in form posts the app's own `verifyUrl`, so the email link returns to
the Fastify app first. That callback previews the email token with
`MAGICSSO_PREVIEW_SECRET`, verifies the access token against
`MAGICSSO_JWT_SECRET`, sets the auth cookie, and only then redirects to the
normalized `returnUrl`.

For OTP, the Fastify app stores only a signed HTTP-only challenge cookie, sends
the code to Magic Link SSO from the server, verifies the returned JWT, and then
sets the same auth cookie. It never stores the code or access token in browser
storage.

This example is the recommended plain Node integration reference in this
repository. The Angular example remains the in-repo Express-style SSR reference.

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

`createBrowserSsoHandler` wraps the portable core HTTP handler. The example
registers `/sso/start`, `/sso/callback` and `/sso/signed-out`, converts the
Fastify request/reply at the boundary, and retains duplicate raw cookie names
for callback validation. The configured public origin takes precedence over
request/proxy headers. Access logs omit query strings.

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
