# Magic Link SSO private1 Dynamic Upstream Example

This is a tiny Fastify app that acts as the private upstream behind Magic Link
SSO Gate for `private1`.

It exposes:

- `/` HTML page that reads forwarded identity headers
- `/assets/app.js` static asset
- `/api/whoami` JSON endpoint
- `/events` Server-Sent Events stream
- `/ws` websocket endpoint

Run it locally:

```sh
pnpm --filter example-app-gate-private1 dev
```

Optional env vars:

```env
PORT=3007
APP_BASE_PATH=
```
