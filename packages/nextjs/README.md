# @magic-link-sso/nextjs

Reusable Next.js helpers for integrating with the Magic Link SSO server.

For a minimal app and matching server config, start with the
[SDK starter](../../docs/first-deployment.md#build-an-app-with-an-sdk).

## Install

```sh
npm install @magic-link-sso/nextjs
```

Peer dependencies:

- `next`
- `react`
- `react-dom`

## What It Provides

- `authMiddleware(request, options?)` Protects routes in `proxy.ts` or
  middleware-style entrypoints.
- `buildLoginUrl(request, pathname, scope?)` Builds either a local `/login` URL
  or a direct SSO redirect URL.
- `verifyToken()` Reads and verifies the site-bound auth JWT from the configured
  cookie.
- `verifyAuthToken(token, secret, { expectedAudience, expectedIssuer? })`
  Verifies a token directly when you already have the cookie value.
- `redirectToLogin(returnUrl, scope?)` Redirect helper for server components and
  route handlers.
- `buildAuthCookieOptions(value)` Shared cookie settings for storing the auth
  JWT.
- `sendMagicLink(email, returnUrl, scope?)` Small server-action helper that
  posts to the SSO server.
- `verifyEmailOtp(challengeId, code)` Exchanges an email code server-side and
  sets the normal HTTP-only auth cookie.
- `LogoutRoute(request)` Route-handler helper for clearing the auth cookie and
  redirecting home.

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
MAGICSSO_PUBLIC_ORIGIN=https://app.example.com
MAGICSSO_TRUST_PROXY=false
```

| Variable                  | Required                 | Default                 | Notes                                                                                                                                                |
| ------------------------- | ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAGICSSO_COOKIE_NAME`    | Effectively yes          | `token` in auth helpers | Set this explicitly to match the server cookie name. The logout helper also expects it.                                                              |
| `MAGICSSO_COOKIE_PATH`    | No                       | `/`                     | Optional path scope for the client-managed auth cookie. Narrowing it can make auth unavailable outside that subtree.                                 |
| `MAGICSSO_COOKIE_MAX_AGE` | No                       | Session cookie          | Optional persistent cookie lifetime in seconds for client-managed auth cookies. Set it to match or stay below the server JWT expiration.             |
| `MAGICSSO_DIRECT_USE`     | No                       | `false`                 | When `true`, middleware redirects straight to the SSO server instead of the local `/login` page. `1`, `yes`, and `on` are also treated as enabled.   |
| `MAGICSSO_JWT_SECRET`     | Yes for protected routes | None                    | Used by middleware and server components to verify the auth JWT. Must match the server JWT secret.                                                   |
| `MAGICSSO_PREVIEW_SECRET` | For app-owned callbacks  | None                    | Required when the app owns `/verify-email` and previews the email token before exchanging it. Must match the server preview secret.                  |
| `MAGICSSO_PUBLIC_ORIGIN`  | Recommended              | None                    | Explicit app origin used for site-bound JWT audience checks. Set this in direct deployments so auth verification does not depend on request headers. |
| `MAGICSSO_SERVER_URL`     | Yes                      | None                    | Base URL of the SSO server used by login actions, direct middleware redirects, and issuer validation for site-bound auth tokens.                     |
| `MAGICSSO_TRUST_PROXY`    | No                       | `false`                 | Only enable this behind a trusted proxy that sanitizes `X-Forwarded-*` headers. When `false`, auth verification requires `MAGICSSO_PUBLIC_ORIGIN`.   |

Auth tokens are site-bound. This release invalidates older session cookies that
were issued without `siteId`/`aud`/`iss`, so users need to sign in again after
deployment.

Middleware redirects, the default `VerifyEmailRoute` callback and OTP exchange
use the same public origin policy: `MAGICSSO_PUBLIC_ORIGIN` takes precedence;
forwarded headers are used only with `MAGICSSO_TRUST_PROXY=true`. A custom
`VerifyEmailRoute` `resolveAppOrigin` resolver still takes precedence over the
default callback policy. Keep form and callback URLs on that public origin when
the backend listens on a different host or port.

## Basic Usage

### Protect routes in `proxy.ts`

```ts
import { authMiddleware } from '@magic-link-sso/nextjs';
import type { NextRequest } from 'next/server';

export default function proxy(request: NextRequest) {
    return authMiddleware(request, {
        excludedPaths: ['/healthz', '/docs'],
    });
}
```

### Verify auth in a server component

```ts
import { redirectToLogin, verifyToken } from '@magic-link-sso/nextjs';

export default async function ProtectedPage() {
    const auth = await verifyToken();
    if (auth === null) {
        redirectToLogin('/protected');
    }

    return <main>Signed in as {auth.email} with scope {auth.scope}</main>;
}
```

### Build a logout route

```ts
import { LogoutRoute } from '@magic-link-sso/nextjs';
import type { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
    return LogoutRoute(request);
}
```

Submit logout through a same-origin `<form method="post" action="/logout">`
rather than a link so the route can enforce POST-only CSRF protections.

### Verify a token directly

```ts
import { verifyAuthToken } from '@magic-link-sso/nextjs';

const payload = await verifyAuthToken(token, secret, {
    expectedAudience: 'https://app.example.com',
    expectedIssuer: 'https://sso.example.com',
});
```

### Exchange an email OTP

When the server enables `[auth.otp]`, `sendMagicLink()` returns public OTP
metadata. Submit the code through the server action
`verifyEmailOtp(challengeId, code)`: it calls the SSO server server-side,
validates issuer/audience, and sets the same HTTP-only auth cookie. Do not keep
codes or returned tokens in client storage.

## Shared browser SSO (opt-in)

Set `MAGICSSO_BROWSER_SSO_MODE=required` to use hosted browser SSO for new
sign-ins. The default is `off`; `auto` supports compatibility with an older or
explicitly disabled issuer. Set the existing public origin, issuer URL and JWT
secret. Issuer and app must use different HTTPS hostnames, including when their
ports differ.

```env
MAGICSSO_BROWSER_SSO_MODE=required
MAGICSSO_PUBLIC_ORIGIN=https://app.example.com
MAGICSSO_SERVER_URL=https://sso.example.com
MAGICSSO_BROWSER_SSO_TIMEOUT_MS=5000
```

Register these exact endpoints under the issuer's matching `[[sites]]` entry and
enable its `[auth.sso]` policy:

```toml
[[sites.sso]]
redirectUri = "https://app.example.com/sso/callback"
startUri = "https://app.example.com/sso/start"
signedOutUri = "https://app.example.com/sso/signed-out"
```

Add three route handlers:

```ts
// app/sso/start/route.ts
export { BrowserSsoStartRoute as GET } from '@magic-link-sso/nextjs';

// app/sso/callback/route.ts
export { BrowserSsoCallbackRoute as GET } from '@magic-link-sso/nextjs';

// app/sso/signed-out/route.ts
export { BrowserSsoSignedOutRoute as GET } from '@magic-link-sso/nextjs';
```

Keep `authMiddleware` in `proxy.ts` and verify JWTs again in protected server
components/handlers, as in the example. Its login redirect and
`redirectToLogin()` now select `/sso/start` regardless of `MAGICSSO_DIRECT_USE`.
These three reserved routes remain public even with custom excluded paths or
after SSO is disabled, so an existing callback reports an explicit error rather
than entering a legacy flow. A valid existing app JWT keeps its current identity
until its normal expiry or local logout.

Framework prefetch/RSC fetches receive a same-origin HTML continuation without
creating cookies or calling the issuer. Next's router then uses a document
navigation for an actual click. This prevents speculative loading from using the
transaction limit or consuming a callback code. Plain anchors also work.

Callbacks exchange codes once on the backend, validate issuer/audience, clear
only their own transaction, and set the existing application cookie. Its
configured maxAge is capped at JWT expiry; Secure follows the trusted public
origin. Full return URL query values, order and repeated parameters survive
framework URL normalization. Three concurrent transactions are supported;
additional or oversized starts retain existing tabs and show an error.

`LogoutRoute` remains POST-only and clears the existing app cookie. In SSO mode
it lands on the public signed-out page with explicit sign-in and central
sign-out actions. Ending browser SSO prevents new sessions; other apps' existing
JWTs retain their normal expiry/revocation policy. The existing app-owned
magic-link/OTP endpoints remain available for legacy clients. To establish
browser SSO from local forms, enable the
[application-owned sign-in flow](#application-owned-sign-in-forms).

`auto` falls back before creating state only for 404 or explicit disabled or
unsupported capabilities. Malformed replies, redirects, timeouts and 5xx errors
do not fall back. Timeout is configurable from 100 to 30000 ms. A failed or
ambiguous exchange clears its own transaction and offers a fresh start; it never
retries a code or exchanges an email grant through another protocol.

Keep protocol query strings and authentication arguments out of development,
custom and ingress logs. For Next.js development logging use:

```js
export default {
    logging: {
        serverFunctions: false,
        incomingRequests: { ignore: [/^\/sso\//, /^\/verify-email(?:\?|$)/] },
    },
};
```

See
[Next.js logging](https://nextjs.org/docs/app/api-reference/config/next-config-js/logging).
For local HTTP only, set `MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST=true` on
the app and enable the issuer's corresponding local exception. Use distinct
loopback hostnames, such as issuer `127.0.0.1` and app `next.localhost`;
different ports on `localhost` are insufficient. `pnpm test:e2e:sso` covers Gate
↔ Next.js after one hosted link or OTP in both directions. Run
`pnpm test:e2e:sso:https` to verify cross-site HTTPS behavior across Chromium,
Firefox, and WebKit. See the
[version 1 contract](../../docs/browser-sso-contract.md) for the protocol and
verification coverage.

## Example App

See the bundled Next.js example in [`examples/nextjs/`](../../examples/nextjs/)
for a full integration using the same package.

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

```ts
export {
    BrowserSsoStartRoute as GET,
    BrowserSsoStartRoute as POST,
} from '@magic-link-sso/nextjs';
```
