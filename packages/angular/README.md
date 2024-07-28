# @magic-link-sso/angular

Reusable helpers for integrating Angular 21 SSR apps with the Magic Link SSO
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

## Example App

See the bundled Angular SSR example in
[`examples/angular/`](../../examples/angular/) for a full integration using the
same package.
