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
- a `/protected` route gated by the auth cookie
- a POST-only `/logout` route that clears the cookie and redirects home

The sign-in form posts the app's own `verifyUrl`, so the email link returns to
the Fastify app first. That callback previews the email token with
`MAGICSSO_PREVIEW_SECRET`, verifies the access token against
`MAGICSSO_JWT_SECRET`, sets the auth cookie, and only then redirects to the
normalized `returnUrl`.

This example is the recommended plain Node integration reference in this
repository. The Angular example remains the in-repo Express-style SSR reference.
