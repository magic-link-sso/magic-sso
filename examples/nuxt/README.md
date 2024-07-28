# Integrating Nuxt 4 SSR with Magic Link SSO

[Magic Link SSO](../../README.md)

This is a Nuxt 4 SSR example app that uses the reusable
[`@magic-link-sso/nuxt`](../../packages/nuxt) module.

## Getting Started

Install workspace dependencies from the repository root:

```bash
pnpm install
```

The example can reuse the shared [`server/.env`](../../server/.env) file when
you start it with the provided pnpm scripts. The first `pnpm dev`, `pnpm build`,
or `pnpm start` run bootstraps `.env` from [`.env.example`](./.env.example) if
it is missing and fills in any missing defaults on later runs. Those env files
act as defaults, and exported shell variables still override them.

Then run the example app from the repository root:

```bash
pnpm --filter example-app-nuxt dev
```

To flip direct use for a run without editing an env file, use:

```bash
MAGICSSO_DIRECT_USE=true pnpm --filter example-app-nuxt dev
```

`MAGICSSO_DIRECT_USE=1` is also supported.

Open [http://localhost:3002](http://localhost:3002) with your browser to see the
Nuxt SSR flow.

Set `MAGICSSO_COOKIE_MAX_AGE` if you want the Nuxt-managed auth cookie to
persist across browser restarts. `MAGICSSO_COOKIE_PATH` defaults to `/`;
narrowing it can make auth unavailable outside that subtree.
`MAGICSSO_PUBLIC_ORIGIN` defaults to `http://localhost:3002` so the Nuxt SSR
middleware can verify site-bound auth tokens without relying on forwarded
headers. See [packages/nuxt/README.md](../../packages/nuxt/README.md) for the
full runtime config and environment variable reference. The built-in
`/verify-email` callback also needs `MAGICSSO_PREVIEW_SECRET` to match the
server `[auth].previewSecret`.

## Integration

The Nuxt module registers:

- a named `magic-sso-auth` route middleware
- a `/verify-email` callback route
- a POST-only `/logout` route
- auto-imported `useMagicSsoAuth()` and `useMagicSsoConfig()` helpers

Protect a page with server-side auth gating:

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

To customize public routes, override `runtimeConfig.magicSso.excludedPaths` in
`nuxt.config.ts`.
