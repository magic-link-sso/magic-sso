# @magic-link-sso/nextjs

Reusable Next.js helpers for integrating with the Magic Link SSO server.

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

## Example App

See the bundled Next.js example in [`examples/nextjs/`](../../examples/nextjs/)
for a full integration using the same package.
