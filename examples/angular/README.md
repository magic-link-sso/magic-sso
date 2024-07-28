# Integrating Angular 21 SSR with Magic Link SSO

[Magic Link SSO](../../README.md)

This is an Angular 21 SSR example app that uses the reusable
[`@magic-link-sso/angular`](../../packages/angular) helpers.

## Getting Started

Install workspace dependencies from the repository root:

```bash
pnpm install
```

Copy [`examples/angular/.env.example`](./.env.example) to `.env` if you want a
dedicated env file for the Angular example. The Angular SSR server loads this
file automatically during local development and production startup. The env file
acts as a default, and exported shell variables still override it.

For the repository's local dev server config, the Angular example expects:

```env
MAGICSSO_COOKIE_NAME=magic-sso
MAGICSSO_COOKIE_PATH=/
MAGICSSO_COOKIE_MAX_AGE=3600
MAGICSSO_DIRECT_USE=false
MAGICSSO_JWT_SECRET=VERY-VERY-LONG-RANDOM-JWT-SECRET
MAGICSSO_PREVIEW_SECRET=VERY-VERY-LONG-RANDOM-PREVIEW-SECRET
MAGICSSO_SERVER_URL=http://localhost:3000
```

Then run the example app from the repository root:

```bash
pnpm --filter example-app-angular dev
```

To flip direct use for a run without editing `.env`, use:

```bash
MAGICSSO_DIRECT_USE=true pnpm --filter example-app-angular dev
```

`MAGICSSO_DIRECT_USE=1` is also supported.

Open [http://localhost:3004](http://localhost:3004) with your browser to see the
Angular SSR flow.

Set `MAGICSSO_COOKIE_MAX_AGE` if you want the Angular-managed auth cookie to
persist across browser restarts. `MAGICSSO_COOKIE_PATH` defaults to `/`;
narrowing it can make auth unavailable outside that subtree. See
[packages/angular/README.md](../../packages/angular/README.md) for the full
environment variable reference. The app-owned `/verify-email` callback also
needs `MAGICSSO_PREVIEW_SECRET` to match the server `[auth].previewSecret`. If
you edit `.env` while the Angular dev server is running, restart the process so
`dotenv/config` reloads it.

## Integration

The example includes:

- an SSR-aware `magicSsoAuthGuard`
- a local `/api/signin` endpoint for requesting magic links
- `/verify-email` and POST-only `/logout` handlers in the Node SSR server
- a same-origin `/api/session` endpoint used for client-side guard checks

Protect a route with the reusable guard:

```ts
import { Routes } from '@angular/router';
import { magicSsoAuthGuard } from '@magic-link-sso/angular';

export const routes: Routes = [
    {
        path: 'protected',
        canActivate: [magicSsoAuthGuard],
        loadComponent: () =>
            import('./protected-page.component').then(
                (value) => value.ProtectedPageComponent,
            ),
    },
];
```
