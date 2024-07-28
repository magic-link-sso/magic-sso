# @magic-link-sso/nuxt

Reusable Nuxt 4 helpers and module wiring for integrating with the Magic Link
SSO server.

## Install

```sh
npm install @magic-link-sso/nuxt
```

Peer dependencies:

- `nuxt`

## What It Provides

- the default Nuxt module export
- a named `magic-sso-auth` route middleware
- `/verify-email` and POST-only `/logout` server routes
- app composables such as `useMagicSsoAuth()` and `useMagicSsoConfig()`
- server utilities exposed from `@magic-link-sso/nuxt/server`

Server helpers such as `buildLoginUrl(event, pathname, scope?)` can forward an
optional requested scope, verified auth payloads expose `email`, `scope`, and
`siteId`, and direct `verifyAuthToken()` calls now require explicit
`expectedAudience` and `expectedIssuer` values.

## Required Runtime Config / Environment

At minimum, configure:

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

| Variable                  | Required                 | Default                    | Notes                                                                                                                                                            |
| ------------------------- | ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAGICSSO_COOKIE_NAME`    | Effectively yes          | `token` in module defaults | Set this explicitly to match the server cookie name. The Nuxt `/logout` route uses it too.                                                                       |
| `MAGICSSO_COOKIE_PATH`    | No                       | `/`                        | Optional path scope for the Nuxt-managed auth cookie. Narrowing it can make auth unavailable outside that subtree.                                               |
| `MAGICSSO_COOKIE_MAX_AGE` | No                       | Session cookie             | Optional persistent cookie lifetime in seconds for the Nuxt-managed auth cookie. Set it to match or stay below the server JWT expiration.                        |
| `MAGICSSO_DIRECT_USE`     | No                       | `false`                    | When `true`, the Nuxt auth middleware redirects straight to the SSO server instead of the local `/login` page. `1`, `yes`, and `on` are also treated as enabled. |
| `MAGICSSO_JWT_SECRET`     | Yes for protected routes | None                       | Used by SSR route middleware and server helpers to verify the auth JWT. Must match the server JWT secret.                                                        |
| `MAGICSSO_PREVIEW_SECRET` | Yes for local callback   | None                       | Used by the built-in `/verify-email` route to preview the email token before exchange. Must match the server preview secret.                                     |
| `MAGICSSO_PUBLIC_ORIGIN`  | Recommended              | None                       | Explicit app origin used for site-bound JWT audience checks. Set this in direct deployments so auth verification does not depend on request headers.             |
| `MAGICSSO_SERVER_URL`     | Yes                      | None                       | Base URL of the SSO server used by the local sign-in API route, `/verify-email` callback, and issuer validation for site-bound auth tokens.                      |
| `MAGICSSO_TRUST_PROXY`    | No                       | `false`                    | Only enable this behind a trusted proxy that sanitizes `X-Forwarded-*` headers. When `false`, auth verification requires `MAGICSSO_PUBLIC_ORIGIN`.               |

Auth tokens are site-bound. Upgrading to this release invalidates older session
cookies that were issued without `siteId`/`aud`/`iss`, so users need to sign in
again after deployment.

## Basic Usage

### Register the module

```ts
export default defineNuxtConfig({
    modules: ['@magic-link-sso/nuxt'],
});
```

### Protect a page

```vue
<script setup lang="ts">
definePageMeta({
    middleware: ['magic-sso-auth'],
});

const auth = useState('auth', () => null);

if (import.meta.server) {
    auth.value = await useMagicSsoAuth();
}
</script>
```

### Customize excluded public paths

```ts
export default defineNuxtConfig({
    modules: ['@magic-link-sso/nuxt'],
    runtimeConfig: {
        magicSso: {
            excludedPaths: ['/healthz', '/docs'],
        },
    },
});
```

### Use server utilities directly

```ts
import {
    getMagicSsoConfig,
    verifyRequestAuth,
} from '@magic-link-sso/nuxt/server';

export default defineEventHandler(async (event) => {
    const auth = await verifyRequestAuth(event);
    return {
        auth,
        config: getMagicSsoConfig(event),
    };
});
```

### Verify a token directly

```ts
import { verifyAuthToken } from '@magic-link-sso/nuxt/server';

const auth = await verifyAuthToken(token, secret, {
    expectedAudience: 'https://app.example.com',
    expectedIssuer: 'https://sso.example.com',
});
```

## Example App

See the bundled Nuxt example in [`examples/nuxt/`](../../examples/nuxt/) for a
full integration using the same module.

Submit logout with a same-origin `<form method="post" action="/logout">` so the
built-in route can reject cross-site requests.
