# Managed Mode for Magic Link SSO

Managed mode is an optional deployment shape for operators who want a CLI-driven
workflow for site access administration without giving up the original TOML
deployment model.

Classic mode remains fully supported. If you do nothing, Magic Link SSO keeps
working with a single manually edited `magic-sso.toml`.

## Manager-Owned Compose Example

The repository now ships a manager-focused managed-mode stack at
[`manager/docker-compose.yml`](../manager/docker-compose.yml). It is narrower
than the broader Gate demo stack and exists to demonstrate how to run:

- Magic Link SSO server on the generated runtime TOML
- the SSR Photos demo
- the Fastify-based manager service
- Magic Link SSO Gate in front of the manager
- a Caddy public proxy that gives each surface its own localhost hostname
- Mailpit for local email visibility

Bootstrap it like this:

```sh
cp manager/.env.example manager/.env
mkdir -p manager/runtime
docker compose --env-file manager/.env -f manager/docker-compose.yml up --build
```

The stack exposes:

- Photos demo at `http://photos.localhost:4306`
- manager UI through Gate at `http://manager.localhost:4306`
- hosted sign-in origin at `http://sso.localhost:4306`
- Mailpit at `http://localhost:8025`

The compose example keeps the runtime directory on a bind mount so operators can
inspect the generated files directly under `manager/runtime/`.

For failure handling and drift recovery playbooks, see
[Manager operations](./manager-operations.md).

## Standalone Production Compose

For a production-style manager deployment that uses published GHCR images, the
repository also ships
[`manager/docker-compose.prod.yml`](../manager/docker-compose.prod.yml).

That example intentionally starts only:

- the private manager service
- Magic Link SSO Gate as the public admin entrypoint

It assumes your Magic Link SSO server already exists elsewhere and that the
manager UI should stay Gate-protected rather than exposed directly in legacy
bearer-token mode.

Bootstrap it like this:

```sh
mkdir -p manager/runtime
cp manager/manager.prod.example.toml manager/runtime/manager.toml
cp manager/magic-gate.prod.example.toml manager/magic-gate.toml
cp manager/.env.prod.example manager/.env.prod
docker compose --env-file manager/.env.prod -f manager/docker-compose.prod.yml up -d
```

Before the first start, provide:

- `manager/runtime/magic-sso.base.toml`
- `manager/runtime/manager-state.json`

The production example uses these published images:

- `ghcr.io/magic-link-sso/magic-sso/manager:latest`
- `ghcr.io/magic-link-sso/magic-sso/gate:latest`

Keep the reload hook optional in `manager/runtime/manager.toml`. If you leave it
disabled, applies stay restart-based instead of hot-reloaded.

### Same-Host Wiring Checklist

When the server and manager are separate deployments on the same machine, wire
them together like this:

1. Create one shared host directory for managed-mode files, for example
   `/srv/magic-link-sso/managed/`.
2. Put these files in that directory: `magic-sso.base.toml`, `manager.toml`,
   `manager-state.json`, `magic-sso.runtime.toml`,
   `magic-sso.runtime.last-good.toml`, `manager-audit.ndjson`, and
   `manager.lock`.
3. Mount that directory read-write into the manager container at `/app/runtime`.
4. Mount `magic-sso.runtime.toml` read-only into the server container and point
   `MAGICSSO_CONFIG_FILE` at the mounted path.
5. Keep the SSO server public at an origin such as `https://sso.example.com`.
6. Keep the manager service private, and expose only Gate publicly at an origin
   such as `https://manager.example.com`.
7. Optionally configure the server reload endpoint on private networking only if
   you want restart-free applies.

The manager does not send the new TOML contents to the server over HTTP. It
writes the runtime file to shared storage, and the server either reloads or
restarts to pick up that already-written file.

## Files and Permissions

Managed mode uses these files with explicit ownership boundaries:

- `magic-sso.base.toml`: operator-authored base config. The manager reads it,
  hashes it for drift detection, and never rewrites it in place.
- `manager-state.json`: manager-owned mutable state. It stores managed site IDs,
  scope catalogs, grants, and apply metadata.
- `magic-sso.runtime.toml`: generated runtime config. The manager rewrites it
  atomically from the base file plus manager state, and the server reads it.
- `magic-sso.runtime.last-good.toml`: last known good generated runtime file.
  The manager updates it before and after apply so reload failures have a local
  rollback target.
- `manager-audit.ndjson`: signed manager audit history for grant edits, scope
  edits, and apply operations, with bounded archive rotation.
- `manager.lock`: manager-owned single-writer lock file used during apply.

Recommended ownership model:

- Keep the base config under your normal deployment or SSH workflow.
- Give the manager write access only to the manager-owned files.
- Give the server read access to the generated runtime TOML.
- Keep Gate unaware of manager state files; it only fronts the Fastify manager
  and forwards authenticated identity headers.
- Avoid direct in-place editing of `magic-sso.base.toml` from the manager. Base
  config edits stay operator-managed, and the manager responds by generating a
  fresh runtime file.

## Volume Layout

The `manager/docker-compose.yml` example uses these mounts:

- `manager/runtime/` -> `/app/runtime` on the manager container as read-write.
  This is where the bootstrap step writes `magic-sso.base.toml`, `manager.toml`,
  `manager-state.json`, `magic-sso.runtime.toml`,
  `magic-sso.runtime.last-good.toml`, `manager-audit.ndjson`, and
  `manager.lock`.
- `manager/runtime/` -> `/app/runtime` on the server container as read-only. The
  server consumes `magic-sso.runtime.toml` but does not need write access to
  manager-owned state.
- `manager/dev/*.template` mounts are read-only into the manager or Gate
  containers so the local example can render runtime config without copying
  tracked templates into the images.
- `manager/dev/Caddyfile` mounts read-only into the public proxy so the local
  stack can expose `manager.localhost`, `photos.localhost`, and `sso.localhost`
  on the same port.

Recommended container permissions:

- manager: read-write to manager-owned runtime files; treat
  `magic-sso.base.toml` as operator-authored input and never rewrite it.
- server: read-only access to generated runtime config.
- Gate: no runtime-state mount; only read-only config-template mounts.

Recommended host ownership:

- operator-owned: `magic-sso.base.toml`
- manager-owned mutable files: `manager-state.json`, `magic-sso.runtime.toml`,
  `magic-sso.runtime.last-good.toml`, `manager-audit.ndjson`, `manager.lock`

For stricter production isolation, you can split the bind mount into separate
read-only and read-write file mounts. The bundled compose example keeps one
shared runtime directory to make the generated files easy to inspect locally.

## Classic vs Managed

### Classic mode

- `MAGICSSO_CONFIG_FILE=./magic-sso.toml`
- You edit `magic-sso.toml` directly.
- The server starts with no manager package, no manager settings file, and no
  manager state file.
- Restart or reload the server through your usual workflow.

### Managed mode

- `MAGICSSO_CONFIG_FILE=./magic-sso.runtime.toml`
- `MAGICSSO_MANAGER_CONFIG_FILE=./manager/manager.toml`
- You keep a static base TOML plus manager state.
- The manager renders, validates, diffs, and applies runtime access changes.
- Managed mode is opt-in. Nothing changes until you point the server at the
  generated runtime TOML and run the manager alongside it.

The server never requires `manager-state.json` for startup on its own. It only
needs whichever TOML file `MAGICSSO_CONFIG_FILE` references in the deployment
you choose.

## Step-by-Step Setup

1. Create `magic-sso.base.toml` from your current working server config.
2. Remove any access rules for sites you want the manager to own from your
   manual operating workflow. The base file still keeps the site definitions,
   origins, redirect URIs, and any unmanaged sites.
3. Create an initial `manager-state.json` with empty grants and empty scope
   catalogs for the managed site IDs.
4. Create a manager settings TOML referenced by `MAGICSSO_MANAGER_CONFIG_FILE`.
   It defines the base file path, runtime file path, state file path, audit file
   path, lock file path, last-known-good file path, the list of managed site
   IDs, optional reload target settings, and the manager service auth mode.
5. Point the server's `MAGICSSO_CONFIG_FILE` at the generated
   `magic-sso.runtime.toml`.
6. Add a dedicated static `manager-admin` site for the Gate-protected web
   manager. Keep its bootstrap allowlist in the base config instead of
   manager-owned state.
7. If you want zero-restart applies, configure the server's optional reload
   endpoint with a dedicated secret and private-network-only exposure.
8. Run `manager validate` and `manager diff` before the first apply.
9. Run `manager apply --yes` to write the runtime TOML and trigger reload when
   reload is configured.

If you never switch `MAGICSSO_CONFIG_FILE` away from `magic-sso.toml`, you stay
in classic mode and can ignore the manager entirely.

Managed mode deliberately separates how files change:

- Operators edit `magic-sso.base.toml` when global or unmanaged site settings
  need to change.
- The manager edits `manager-state.json` when grants, scopes, or apply metadata
  change.
- The manager regenerates `magic-sso.runtime.toml` instead of editing the base
  TOML directly.

Example Gate-backed manager site:

```toml
[[sites]]
id = "manager-admin"
origins = ["https://manager.example.com"]
allowedRedirectUris = [
  "https://manager.example.com/_magicgate/verify-email",
  "https://manager.example.com/*",
]
allowedEmails = ["ops@example.com"]
```

Example manager service auth:

```toml
[service.auth]
mode = "gate"
requiredSiteId = "manager-admin"
requiredScope = "*"
```

## Scope Semantics

The manager intentionally reuses the server's current access semantics:

- A grant with `["*"]` means full access for that email on that site.
- A grant with named scopes means scoped access for that email on that site.
- Mixing `*` with named scopes in the same grant is invalid.

Render mapping:

- Full access grants render into `allowedEmails`.
- Named scopes render into `[[sites.accessRules]]`.

## Drift and Safety

The manager checks for operational drift:

- Base config drift means `magic-sso.base.toml` changed since the last manager
  sync or apply.
- Runtime drift means `magic-sso.runtime.toml` no longer matches what the
  manager expects from the current base file and manager state.

When drift is detected, the manager should stop destructive writes until the
operator reconciles the files.

The manager also protects against:

- Editing unmanaged sites.
- Removing its bootstrap access path by rejecting Gate configs that try to make
  the dedicated `manager-admin` site manager-managed.
- Running concurrent apply operations by using a lock file.
- Losing actor traceability for admin writes by recording access mutations and
  apply actions in the signed audit log and its rotated archives.

## Reload Hook

The optional server reload endpoint exists to avoid a full process restart after
writing a new runtime TOML:

- Endpoint: `POST /internal/access-config/reload`
- Auth: dedicated reload secret
- Exposure: private networking only

Reload is intentionally narrow:

- The server re-reads the TOML file already configured in
  `MAGICSSO_CONFIG_FILE`.
- The candidate config must validate with the normal startup rules.
- Only site access data is hot-swapped.
- If reload fails, the server keeps the current live config.

Example static server config:

```toml
[server.reload]
secret = "replace-me-with-a-dedicated-long-random-reload-secret"
```

Leave `[server.reload]` out entirely if you prefer restart-based applies.

## Rollback to Classic Mode

Rollback is operationally simple:

1. Stop running `manager apply`.
2. Stop the manager service if you no longer need managed-mode UI, API, or CLI
   access on that host.
3. Point `MAGICSSO_CONFIG_FILE` back to your manually maintained classic TOML.
4. Reload or restart the server.
5. Confirm the server is reading the classic TOML again, then keep or archive
   `manager-state.json`, `manager-audit.ndjson`, and the generated runtime files
   as operational history.

Managed mode does not require a database, so there is no data migration to undo.

For deeper apply-failure, rollback, and drift-recovery procedures, see
[Manager operations](./manager-operations.md).

## Security Assumptions

- The manager is an internal admin tool.
- The reload endpoint is an internal admin endpoint.
- Neither surface should be exposed as a public self-service API.
- The web manager should sit behind Magic Link SSO Gate with a dedicated
  `manager-admin` site and bootstrap allowlist defined in static config.
- The manager should trust only the `x-magic-sso-user-email`,
  `x-magic-sso-user-scope`, and `x-magic-sso-site-id` headers forwarded by Gate
  for that dedicated site.
