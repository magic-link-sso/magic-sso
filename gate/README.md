# Magic Link SSO Gate

`magic-sso-gate` is a thin reverse-proxy layer for protecting arbitrary
upstreams with Magic Link SSO, including CSR apps, static sites, or services in
unknown stacks.

Gate reads its runtime settings from a single TOML file. Point
`MAGIC_GATE_CONFIG_FILE` at that file and the process uses the values from it
for everything except the bootstrap path itself.

The repository keeps `gate/.env.example` only for Docker Compose bootstrap
values. It is not the Gate runtime config. Those bootstrap values cover the SSO
server and the Gate renderer, but they stay separate from TOML runtime config.

The gate keeps all infrastructure routes under `/_magicgate/*` by default:

- `GET /_magicgate/login`
- `POST /_magicgate/signin`
- `GET /_magicgate/verify-email`
- `POST /_magicgate/verify-email`
- `POST /_magicgate/logout`
- `GET /_magicgate/session`
- `GET /_magicgate/healthz`

Everything outside that namespace is treated as protected upstream traffic.

Security note: the token-bearing `GET /_magicgate/verify-email` confirmation
page uses `Referrer-Policy: no-referrer`, and websocket upgrade throttling keys
off the socket peer address instead of forwarded client IP headers. The normal
HTTP request rate limiter does the same, so spoofed `X-Forwarded-For` values
cannot bypass sign-in, verify-email, or logout throttling. That keeps the
one-time verification token out of referer-based telemetry and prevents
forwarded-header spoofing from bypassing rate limits. The gate also strips its
own auth cookie before proxying requests upstream, so the protected app does not
receive the gate bearer token. For multi-replica deployments, configure
`rateLimitRedisUrl` so each gate process shares the same rate-limit counters
instead of enforcing limits per process.

## Gate TOML

Copy [`magic-gate.example.toml`](./magic-gate.example.toml) to
`gate/magic-gate.toml` and set `MAGIC_GATE_CONFIG_FILE` to the copied file path
for a local run. The file is split into:

- `[gate]` for `port`, `mode`, `namespace`, `publicOrigin`, `upstreamUrl`,
  `directUse`, rate limits, and timeouts
- `[auth]` for `serverUrl`, `jwtSecret`, and `previewSecret`
- `[cookie]` for the auth cookie name, path, and optional max age

For path-prefix deployments, set `mode = "path-prefix"` and add
`publicPathPrefix` and any matching cookie path value in the TOML file.

The repository also ships `gate/dev/magic-gate.toml.template` for the local
Docker stack. That template is rendered before Gate starts so Compose can keep
its bootstrap values separate from the runtime TOML. The template placeholders
use the `MAGIC_GATE_RENDER_*` prefix, including the auth fields, so they do not
look like runtime config.

## Local Development

Run the three services for `private1` separately:

```sh
pnpm dev:server
pnpm --filter example-app-gate-private1 dev
MAGIC_GATE_CONFIG_FILE="$PWD/gate/magic-gate.toml" pnpm dev:gate
```

Before starting Gate locally, copy `magic-gate.example.toml` to
`gate/magic-gate.toml` and update the SSO server URL, JWT secret, preview
secret, public origin, and upstream URL.

Then open:

- local gate for `private1`: `http://localhost:4000`
- local upstream direct access for `private1`: `http://localhost:3007`

## Dev Docker Stack

The bundled stack starts:

- Magic Link SSO server
- Magic Link SSO Gate for `private1`
- Magic Link SSO Gate for `private2`
- `private1` dynamic upstream example
- `private2` static site example
- Caddy public proxy
- Mailpit for viewing emails

Run it:

```sh
cp gate/.env.example gate/.env
docker compose --env-file gate/.env -f gate/docker-compose.yml up --build
```

Then open:

- protected entrypoint `private1`: `http://private1.localhost:4306`
- protected entrypoint `private2`: `http://private2.localhost:4306`
- hosted sign-in origin: `http://sso.localhost:4306`
- Mailpit inbox: `http://localhost:8025`

In the dev stack, `private2` mounts `examples/gate-private2-static/public` into
the container, so static asset edits show up on refresh without rebuilding the
image. The compose file reads `gate/.env` only as bootstrap input to render the
per-container TOML templates before starting the server and gate processes, so
you can override hosts, upstream ports, allowed emails, and shared dev secrets
there without editing `docker-compose.yml`. The Gate renderer uses only
`MAGIC_GATE_RENDER_*` values, including `MAGIC_GATE_RENDER_SERVER_URL`,
`MAGIC_GATE_RENDER_JWT_SECRET`, `MAGIC_GATE_RENDER_COOKIE_NAME`, and
`MAGIC_GATE_RENDER_COOKIE_MAX_AGE`. The `pnpm dev:gate:stack` shortcut still
works with defaults or exported shell env vars, but `--env-file gate/.env` is
the explicit path when you want Compose to read the checked-in example-derived
env file.

The compose stack is designed as a local mirror of the production topology
documented in [`docs/gate.md`](../docs/gate.md).

## Standalone Production Gate

The repository also ships a production-oriented Gate compose example for the
common setup where your Magic Link SSO server is already deployed elsewhere.

That compose file assumes:

- your SSO server already runs at `https://sso.example.com`
- Gate is the public entrypoint for `https://private.example.com`
- the protected upstream is private and reachable from Gate
- TLS termination happens outside the container, for example on your ingress,
  reverse proxy, or load balancer

Run it:

```sh
cp gate/magic-gate.example.toml gate/magic-gate.toml
cp gate/.env.prod.example gate/.env.prod
docker compose --env-file gate/.env.prod -f gate/docker-compose.prod.yml up -d
```

The production example pulls the published Gate image from GHCR:

- `ghcr.io/magic-link-sso/magic-sso/gate:latest`

The server image is published separately:

- `ghcr.io/magic-link-sso/magic-sso/server:latest`

Because the production example is intentionally standalone, it does not start:

- a Magic Link SSO server
- Mailpit
- the demo private upstreams
- a public TLS terminator

You provide those pieces in your own environment, and Gate only needs the TOML
file mounted at `/app/gate/magic-gate.toml`. The compose example points
`MAGIC_GATE_CONFIG_FILE` at that file and leaves the rest of the runtime
settings inside the TOML itself. The production `.env.prod.example` therefore
only needs the image name and config-file path.
