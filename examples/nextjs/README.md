# Integrating Next.js Project with Magic Link SSO

[Magic Link SSO](../../README.md)

This is a [Next.js](https://nextjs.org) project bootstrapped with
[`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Integration

## Getting Started

Install workspace dependencies from the repository root:

```bash
pnpm install
```

The first `pnpm dev`, `pnpm build`, or `pnpm start` run fills in missing
defaults in `.env.local` from [`.env.local.example`](./.env.local.example). Edit
`.env.local` if you want different local values. If you want the browser auth
cookie to persist across restarts, set `MAGICSSO_COOKIE_MAX_AGE` to a lifetime
in seconds that matches your JWT policy. `MAGICSSO_COOKIE_PATH` defaults to `/`;
narrowing it can make auth unavailable outside that subtree.
`MAGICSSO_PUBLIC_ORIGIN` defaults to `http://localhost:3001` so the auth helpers
can verify site-bound tokens without depending on proxy headers. See
[packages/nextjs/README.md](../../packages/nextjs/README.md) for the full
environment variable reference. The local `/verify-email` callback also needs
`MAGICSSO_PREVIEW_SECRET` to match the server `[auth].previewSecret`.
`.env.local` acts as a default, and exported shell variables still override it.

Then run the example app from the repository root:

```bash
pnpm --filter example-app-nextjs dev
```

To flip direct use for a run without editing `.env.local`, use:

```bash
MAGICSSO_DIRECT_USE=true pnpm --filter example-app-nextjs dev
```

`MAGICSSO_DIRECT_USE=1` is also supported.

Open [http://localhost:3001](http://localhost:3001) with your browser to see the
result.

To customize public routes, wrap the package middleware in your own
`src/proxy.ts`:

```ts
import { authMiddleware } from '@magic-link-sso/nextjs';
import type { NextRequest } from 'next/server';

export default function proxy(request: NextRequest) {
    return authMiddleware(request, {
        excludedPaths: ['/healthz', '/docs'],
    });
}
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
