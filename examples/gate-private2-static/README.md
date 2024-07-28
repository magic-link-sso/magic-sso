# Magic Link SSO private2 Static Site Example

This example is a plain static site protected by Magic Link SSO Gate. The
upstream is just the `public/` directory with `index.html` and assets. It has no
app runtime, no SSR, and no auth integration.

Run it locally:

```sh
pnpm --filter example-app-gate-private2-static dev
```

Optional env vars:

```env
PORT=3008
```

Local `dev` and `start` use [`serve`](https://www.npmjs.com/package/serve) with
SPA fallback enabled, so the same example can stand in for a simple static page
or a client-side routed SPA bundle.
