# Magic Link SSO Manager Architecture

The Magic Link SSO manager is an optional, file-backed administration layer for
site access data. It is designed for operators who want a safer workflow than
editing live access rules by hand over SSH, while keeping the original Magic
Link SSO deployment model fully intact.

## Goals

- Keep classic Magic Link SSO unchanged for operators who prefer one manually
  maintained `magic-sso.toml`.
- Add a managed mode that generates a runtime TOML file from static config plus
  manager-owned access data.
- Limit the manager scope to access administration for already defined sites.
- Reuse the server's config validation rules so managed mode and classic mode
  behave identically.
- Stay self-hostable with local files only. No database, queue, or object store
  is required.

## Non-goals

- Creating or deleting site IDs.
- Editing SMTP, cookie, hosted-auth branding, redirect URIs, or other global
  server settings from the manager.
- Editing the bootstrap admin access path for the manager itself.
- Replacing Gate, hosted auth, or the existing TOML-driven server workflow.

## Deployment Modes

Magic Link SSO supports two operator-facing modes:

### Classic mode

- The server reads `MAGICSSO_CONFIG_FILE=./magic-sso.toml`.
- Operators edit that TOML file directly over SSH or through their normal
  deployment workflow.
- No manager package, state file, or generated runtime file is involved.

### Managed mode

- The server reads `MAGICSSO_CONFIG_FILE=./magic-sso.runtime.toml`.
- Operators keep a static `magic-sso.base.toml` as the source of truth for
  non-managed configuration.
- The manager stores mutable access data in `manager-state.json`.
- The manager renders `magic-sso.runtime.toml`, validates it with the same rules
  as classic mode, and then asks the server to reload it when configured to do
  so.
- Rollback is just an operator decision to stop the manager and point the server
  back to the original manually maintained TOML file.

## Ownership Boundaries

Managed mode uses separate files with explicit responsibilities:

- `magic-sso.base.toml`: operator-authored, read-only to the manager. Owns
  secrets, SMTP settings, cookie settings, app URL, hosted auth copy and
  branding, redirect URIs, site origins, bootstrap admin site configuration, and
  any unmanaged sites.
- `manager-state.json`: manager-owned mutable state. Owns which site IDs are
  manager-managed, per-site scope catalogs, per-site grants, and apply metadata.
- `magic-sso.runtime.toml`: generated runtime config consumed by the server.
  This is the merged output of the base config and manager state.
- `magic-sso.runtime.last-good.toml`: last known good generated runtime file
  kept for rollback.
- `manager-audit.ndjson`: signed audit log for manager grant edits, scope edits,
  and apply results, with bounded archive rotation.
- `manager.lock`: lock file used to keep apply operations single-writer.

The manager never rewrites `magic-sso.base.toml` in place. Operators keep
editing the base config through their normal deployment workflow, and the
manager answers those changes by regenerating a runtime TOML instead of patching
the base file directly.

The managed-mode file lifecycle is intentionally simple:

1. The operator updates `magic-sso.base.toml` when global settings or unmanaged
   site definitions change.
2. The manager updates `manager-state.json` when grants, scope catalogs, or
   apply metadata change.
3. The manager renders `magic-sso.runtime.toml` from those two inputs and keeps
   `magic-sso.runtime.last-good.toml` as the local rollback target.

## Access Data Model

The manager owns only access-related dynamic data:

- Known scope catalog per managed site.
- Access grants per managed site as `{ email, scopes[] }`.
- Apply metadata such as hashes and timestamps.

Normalization rules are shared across surfaces:

- Emails are trimmed and lowercased before comparison and storage.
- Scopes are trimmed and empty scopes are rejected.
- `["*"]` means full access for a grant.
- A grant may not mix `*` with named scopes.

These rules map to current server semantics:

- `["*"]` renders to `allowedEmails`.
- Named scopes render to `[[sites.accessRules]]`.

## Manager Surfaces

The manager provides these operator-facing surfaces:

- Shared domain modules handle loading, normalization, validation, diffing,
  rendering, atomic apply, and audit logging.
- The `manager` CLI uses that shared layer directly for local inspection and
  operations.
- REST API endpoints on a dedicated manager service.
- Server-rendered admin pages.
- Gate-protected admin access using a dedicated manager site in static config.

## Reload Model

The core server change is intentionally narrow:

- The server can expose an optional authenticated
  `POST /internal/access-config/reload` endpoint.
- Reload re-reads the TOML file already pointed to by `MAGICSSO_CONFIG_FILE`.
- The server validates the candidate config with the normal startup loader.
- Live reload only adopts site access data. If non-reloadable settings differ,
  reload fails and the current in-memory config stays active.

This keeps the server manager-agnostic. The server does not need to understand
manager state files or managed-mode-specific file formats.

## Security Assumptions

- The manager and reload endpoint are operator/admin surfaces, not public
  multi-tenant APIs.
- The reload endpoint should only be exposed on private networking and must be
  protected by a dedicated static secret that is not manager-managed.
- The web manager sits behind Magic Link SSO Gate and requires a dedicated
  manager-admin site with bootstrap access defined in static config.
- Bootstrap access must remain outside manager-managed state so the UI cannot
  lock operators out of the system.

## Rollback Story

Managed mode is intentionally reversible:

1. Stop using the manager for apply operations.
2. Point `MAGICSSO_CONFIG_FILE` back to the original operator-maintained TOML.
3. Reload or restart the server with that classic config.
4. Keep or archive manager-owned files separately as operational history.

No database migration or schema teardown is required.
