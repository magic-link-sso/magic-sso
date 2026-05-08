<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Magic Link SSO Manager

`magic-sso-manager` is the managed-mode control plane package for Magic Link
SSO.

Core capabilities:

- manager runtime settings loaded from `MAGICSSO_MANAGER_CONFIG_FILE`
- manager-owned file paths for base, state, runtime, audit, and lock files
- managed site ID selection
- optional server reload target settings
- startup validation that rejects placeholder reload secrets

Use [manager.example.toml](./manager.example.toml) for source-based or local
stacks, and [manager.prod.example.toml](./manager.prod.example.toml) for the
published-image production compose path referenced by
`MAGICSSO_MANAGER_CONFIG_FILE`.

Service capabilities:

- optional Fastify service settings under `[service]`
- a service auth block that can run in legacy bearer-token mode or Gate-backed
  forwarded-header mode
- explicit `service.trustProxy` support so Gate or reverse-proxy deployments can
  trust forwarded origin data without accepting spoofed headers on direct
  connections
- a service entrypoint via `pnpm --filter magic-sso-manager dev` or
  `pnpm --filter magic-sso-manager start`
- authenticated read endpoints for sites, access, scopes, diff previews, and
  audit history
- authenticated write endpoints for grants, scope catalogs, validation, apply,
  and reload workflows

UI capabilities:

- a temporary browser unlock at `/login` for legacy bearer-token deployments
- a dashboard at `/` with managed-site counts, pending-change visibility, and
  recent audit entries
- read-only site detail pages at `/sites/:siteId`
- read-only diff and audit pages at `/diff` and `/audit`

Preferred auth model:

- `[service.auth] mode = "gate"` trusts only Gate-forwarded manager identity
  headers
- the manager enforces a dedicated static site ID plus required scope for both
  UI and API requests
- legacy bearer-token mode remains available as a fallback for emergency or
  direct local access

API protections:

- Gate-protected read and write API flows now have direct manager test coverage
- Gate site and scope checks are enforced consistently across the admin API
- the Gate bootstrap admin site cannot be listed in `managedSiteIds`, which
  keeps its bootstrap allowlist operator-managed in the base config

Audit behavior:

- grant and scope mutations now append audit events alongside apply results
- Gate-backed writes capture the acting admin email plus the `manager-admin`
  site identity in audit data
- audit entries now carry chained HMAC integrity metadata and rotate through a
  bounded archive set
- the audit UI now shows both access-mutation history and apply outcomes from
  the same manager-owned event log

## Managed Deployment Example

The manager-owned managed-mode compose example at
[`manager/docker-compose.yml`](./docker-compose.yml) keeps the current
architecture intact:

- the manager stays a Fastify app
- Magic Link SSO Gate remains the preferred browser-facing auth boundary
- runtime config and manager state stay file-backed and locally inspectable

Deployment boundary:

- the manager remains an access-only control plane for existing managed sites
- site provisioning, origins, redirect URIs, secrets, SMTP, cookie settings, and
  global hosted auth config stay operator-managed over SSH
- the bootstrap `manager-admin` site remains outside `managedSiteIds` and
  outside manager-owned mutable state
- the only intended core-server integration remains the optional authenticated
  reload hook
- a full-stack Gate-backed browser test now covers manager sign-in, scoped grant
  save, apply, immediate downstream sign-in, and bootstrap-admin continuity

Recovery tooling:

- portable export and import for manager-owned access state
- reconciliation previews and apply-metadata resets from either
  `magic-sso.base.toml` or `magic-sso.runtime.toml`
- dedicated CLI, API, UI, and audit flows for drift recovery that still never
  auto-apply the generated runtime file

The manager remains strictly optional:

- classic deployments can keep using a single `magic-sso.toml`
- the server does not require manager state unless you point
  `MAGICSSO_CONFIG_FILE` at `magic-sso.runtime.toml`
- rollback is a deployment change, not a migration: stop using the generated
  runtime file, point the server back at the classic TOML, and reload or restart
  it

Managed file ownership stays explicit:

- `magic-sso.base.toml` stays operator-authored and read-only to the manager
- `manager-state.json` stores manager-owned mutable access data and apply
  metadata
- `magic-sso.runtime.toml` is regenerated output, not a hand-edited source file
- `magic-sso.runtime.last-good.toml` stays available as the local rollback copy
- `manager-audit.ndjson` rotates through bounded manager-owned archives and
  `manager.lock` remains a manager-owned operational file

The manager never edits `magic-sso.base.toml` in place. If an operator changes
the base config, the manager reacts by rebuilding `magic-sso.runtime.toml` from
the base file and manager state.

For setup, volume ownership, and permissions guidance, see
[Managed mode setup and operations](../docs/managed-mode.md).

For apply-failure, reload rollback, and drift-recovery playbooks, see
[Manager operations](../docs/manager-operations.md).

## Standalone Production Manager

The repository also ships a production-oriented managed-mode compose example for
the common setup where your Magic Link SSO server already runs elsewhere and you
want the manager UI behind Magic Link SSO Gate.

That compose file assumes:

- your SSO server already runs at a public origin such as
  `https://sso.example.com`
- the manager UI will be exposed through Gate at a public origin such as
  `https://manager.example.com`
- the manager service itself stays private on the compose network
- Gate is the only browser-facing container in the stack
- the server reload hook is optional and can stay disabled if you prefer
  restart-based applies

What must already exist:

- a public Magic Link SSO server origin such as `https://sso.example.com`
- a `[[sites]]` entry on that server for `https://manager.example.com`
- a shared runtime directory that both the server deployment and the manager
  deployment can access on the same host
- the manager-owned files and operator-owned base config in that shared runtime
  directory

Bootstrap it like this:

```sh
mkdir -p manager/runtime
cp manager/manager.prod.example.toml manager/runtime/manager.toml
cp manager/magic-gate.prod.example.toml manager/magic-gate.toml
cp manager/.env.prod.example manager/.env.prod
docker compose --env-file manager/.env.prod -f manager/docker-compose.prod.yml up -d
```

Before starting the stack, also provide:

- `manager/runtime/magic-sso.base.toml` with your operator-owned base server
  config
- `manager/runtime/manager-state.json` with the initial manager-owned access
  state for the `managedSiteIds` listed in `manager.toml`

Minimal starting `manager-state.json`:

```json
{
    "version": 1,
    "managedSites": {
        "private-app": {
            "grants": [],
            "scopeCatalog": []
        }
    },
    "metadata": {}
}
```

The production example pulls the published GHCR images:

- `ghcr.io/magic-link-sso/magic-sso/manager:latest`
- `ghcr.io/magic-link-sso/magic-sso/gate:latest`

The bundled files are split by role:

- `manager/docker-compose.prod.yml` runs the private manager service plus the
  public Gate entrypoint
- `manager/manager.prod.example.toml` is the manager settings file that lives
  inside the mounted runtime directory
- `manager/magic-gate.prod.example.toml` is the Gate runtime config for the
  admin surface
- `manager/.env.prod.example` selects the published images and mounted config
  paths

### Same-Host Linking Example

If you run the server and manager as separate Docker Compose projects on the
same machine, the simplest wiring is one shared host directory, for example:

```text
/srv/magic-link-sso/managed/
  magic-sso.base.toml
  manager.toml
  manager-state.json
  magic-sso.runtime.toml
  magic-sso.runtime.last-good.toml
  manager-audit.ndjson
  manager.lock
```

Then point both deployments at that same host directory:

- manager deployment:
    - mount `/srv/magic-link-sso/managed` to `/app/runtime`
    - set `MAGICSSO_MANAGER_CONFIG_FILE=/app/runtime/manager.toml`
- server deployment:
    - mount `/srv/magic-link-sso/managed/magic-sso.runtime.toml` read-only
    - set `MAGICSSO_CONFIG_FILE=/app/server/magic-sso.runtime.toml`

In that setup:

- the manager reads `/app/runtime/magic-sso.base.toml`
- the manager writes `/app/runtime/magic-sso.runtime.toml`
- the server reads that generated runtime TOML from its own read-only mount
- the optional reload hook only tells the server to re-read the file; it does
  not transfer config contents over the network

If the deployments are in separate compose projects, you have two valid apply
options:

- simplest: leave `[reload]` disabled and restart the server container after
  `manager apply`
- optional hot reload: expose the server reload endpoint on private networking
  only and point `[reload].url` in `manager.toml` at that internal server URL
  reachable from the manager host or container

The key linkage is shared file access to `magic-sso.runtime.toml`. The network
reload call is optional and only accelerates adoption of the already-written
file.

Because the production example is intentionally standalone, it does not start:

- a Magic Link SSO server
- Mailpit
- the Photos demo
- a public TLS terminator

You provide those pieces in your own environment, and the manager stays focused
on managed access administration for existing site IDs.

## Local stack workflow

For the easiest end-to-end managed-mode demo, start the full stack from the
repository root with:

```sh
pnpm dev:manager:stack
```

That gives you the manager UI, Magic Link SSO Gate, the core server, the SSR
Photos demo, and supporting services together with the managed-mode wiring
already in place.

For day-to-day manager UI work, use the workspace-level hot-reload stack:

```sh
pnpm dev:manager
```

That command:

- renders a local managed-mode runtime under [`manager/runtime`](./runtime)
- starts Mailpit in Docker only, so local Magic Link SSO email flows still work
- runs `magic-sso-server`, the SSR Photos demo, `magic-sso-manager`, and
  `magic-sso-gate` directly on the host in watch mode
- keeps the existing full container stack available through
  `pnpm dev:manager:stack` when you want container parity instead of fast
  iteration

By default the container stack exposes a shared Caddy front door at
`http://{manager,photos,sso}.localhost:${MANAGER_PUBLIC_PORT:-4306}`. The
upstream manager service still stays private on
`http://127.0.0.1:${MANAGER_UPSTREAM_PORT:-4311}` inside the compose network.

## CLI workflow

Point `MAGICSSO_MANAGER_CONFIG_FILE` at your manager settings TOML and then use
the `manager` binary for local access administration:

```sh
manager sites list
manager sites show photos
manager access list photos
manager scopes add photos photo:red-kite-at-dusk
manager access grant photos collector@example.com --scope photo:red-kite-at-dusk
manager export
manager reconcile status
manager reconcile base --yes
manager import ./portable-manager-state.json --yes
manager diff
manager validate
manager apply --yes
```

Read-only commands also accept `--json`. Destructive commands such as
`access revoke`, `scopes remove`, and `apply` require confirmation unless
`--yes` is provided.

## API workflow

With `[service]` configured, start the manager service and use one of these auth
modes for `/api/*` routes:

- Preferred Gate mode: place the manager behind Magic Link SSO Gate and let Gate
  forward `x-magic-sso-user-email`, `x-magic-sso-user-scope`, and
  `x-magic-sso-site-id`.
- When the manager sits behind Gate or another trusted reverse proxy, set
  `service.trustProxy = true` so same-origin checks and secure cookie detection
  use the forwarded host and protocol.
- Legacy bearer mode: configure `[service.auth]` with `mode = "bearer-token"`
  and `bearerToken = "..."`, then send that token in the `Authorization` header.
- In Gate mode, keep `service.auth.requiredSiteId` out of `managedSiteIds` so
  the manager never takes ownership of its own bootstrap access path.

Legacy bearer-mode examples:

```sh
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/sites
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/sites/photos
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/sites/photos/access
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/sites/photos/scopes
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/diff
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/state/export
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/reconcile
curl -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/audit?limit=20
curl -X POST -H "Authorization: Bearer $MANAGER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"state":{"version":1,"managedSites":{"photos":{"grants":[],"scopeCatalog":[]}}}}' \
  http://127.0.0.1:4311/api/state/import
curl -X POST -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/reconcile/base
curl -X POST -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/validate
curl -X POST -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/apply
curl -X POST -H "Authorization: Bearer $MANAGER_API_TOKEN" http://127.0.0.1:4311/api/reload
```

`GET /healthz` remains unauthenticated for infrastructure probes.

Write failures return JSON with `message` plus optional `code` and `details`
fields so the future UI can surface actionable admin feedback without re-parsing
free-form strings.

## UI workflow

With `[service]` configured, use the matching auth flow for the web UI:

- Preferred Gate mode: browse to the Gate-protected manager host and let Gate
  forward the authenticated `manager-admin` identity on each request.
- In proxied deployments, keep `service.trustProxy = true`; for direct local
  access with no trusted proxy in front of the manager, leave it `false`.
- Legacy bearer mode: open `/login`, submit the configured manager token, and
  then review the server-rendered pages.

```sh
open http://127.0.0.1:4311/login
```

The server-rendered pages focus on access administration, recovery, and apply
safety:

- `/` shows the managed site list, pending-change counts, and recent audit
  events
- `/sites/:siteId` now includes grant add/edit/revoke forms plus scope catalog
  add/remove controls with in-use guardrails, and it freezes those write actions
  if the base config drifts out of sync
- `/sites/:siteId` does not expose site creation, deletion, origin edits,
  redirect URI edits, or global server settings
- `/diff` previews the next generated runtime config changes and now validates
  or applies them through the same runtime pipeline used by the API and CLI
- `/reconcile` previews base/runtime recovery, exposes portable export JSON, and
  accepts portable imports that reset the next apply baseline without
  auto-applying
- `/audit` now summarizes recent apply outcomes with actor identity, reload or
  rollback status, and hash previews for each recorded event

## License

Magic Link SSO Manager is licensed under the
[GNU General Public License v3.0 or later](./LICENSE).
