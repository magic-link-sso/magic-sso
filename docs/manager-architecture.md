# Magic Link SSO manager architecture

The Magic Link SSO manager is an optional, file-backed administration layer for
site access data. It exists for operators who want something safer than editing
live access rules by hand over SSH, without giving up the original Magic Link
SSO deployment model.

## Goals

- Keep classic Magic Link SSO unchanged for operators who prefer one manually
  maintained `magic-sso.toml`.
- Add a managed mode that generates a runtime TOML file from static config plus
  manager-owned access data.
- Limit the manager scope to access administration for already defined sites.
- Reuse the server's config validation rules so managed mode and classic mode
  behave identically.
- Stay self-hostable with local files only. No database, queue, or object store.

## Non-goals

- Creating or deleting site IDs.
- Editing SMTP, cookie, hosted-auth branding, redirect URIs, or other global
  server settings from the manager.
- Editing the bootstrap admin access path for the manager itself.
- Replacing Gate, hosted auth, or the existing TOML-driven server workflow.

## Deployment modes

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
- To roll back, stop the manager and point the server back at the original
  manually maintained TOML file.

## Ownership boundaries

Managed mode uses separate files with explicit responsibilities:

- `magic-sso.base.toml`: operator-authored, read-only to the manager. Owns
  secrets, SMTP settings, cookie settings, app URL, hosted auth copy and
  branding, email OTP policy and secret, redirect URIs, site origins, bootstrap
  admin site configuration, and any unmanaged sites.
- `manager-state.json`: manager-owned mutable state. Owns which site IDs are
  manager-managed, per-site scope catalogs, per-site grants, and apply metadata.
- `magic-sso.runtime.toml`: generated runtime config consumed by the server.
  This is the merged output of the base config and manager state.
- `magic-sso.runtime.last-good.toml`: last known good generated runtime file
  kept for rollback.
- `manager-audit.ndjson`: signed audit log for manager grant edits, scope edits,
  and apply results, with bounded archive rotation.
- `manager.lock`: lock file shared by CLI, API, and UI state writes, including
  apply.

The manager never rewrites `magic-sso.base.toml` in place. Operators keep
editing the base config through their normal deployment workflow, and the
manager answers those changes by regenerating a runtime TOML instead of patching
the base file. `[auth.otp]` in particular stays operator-owned; no manager
grant, scope, API call, or UI action can change it.

The managed-mode file lifecycle has three steps:

1. The operator updates `magic-sso.base.toml` when global settings or unmanaged
   site definitions change.
2. The manager updates `manager-state.json` when grants, scope catalogs, or
   apply metadata change.
3. The manager renders `magic-sso.runtime.toml` from those two inputs and keeps
   `magic-sso.runtime.last-good.toml` as the local rollback target.

## Access data model

The manager owns only access-related dynamic data:

- Known scope catalog per managed site.
- Access grants per managed site as `{ email, scopes[] }`.
- Apply metadata such as hashes and timestamps.

The CLI, API, and UI share these normalization rules:

- Emails are trimmed and lowercased before comparison and storage.
- Scopes are trimmed and empty scopes are rejected.
- `["*"]` means full access for a grant.
- A grant may not mix `*` with named scopes.

These rules map to current server semantics:

- `["*"]` renders to `allowedEmails`.
- Named scopes render to `[[sites.accessRules]]`.
- Empty grant lists render explicit empty access lists, denying all sign-ins for
  that site. A site with no access declaration at all is still rejected as
  incomplete configuration.

## Person-oriented administration

The person view derives effective scopes from the same `buildSiteAccessRules`
normalization used by the issuer. It shows all configured applications and the
source of each applicable rule. Managed applications use manager state;
unmanaged applications use the operator base configuration and stay read-only.
The people list is the union of identities in saved and published access rules,
not an account database. Any valid email can be looked up before its first
grant.

`people.ts` applies a person's changes to a cloned state and validates the whole
candidate before saving anything. Preview and save are separate form actions. A
domain-separated HMAC using the existing audit integrity key binds the reviewed
changes, email, ten-minute expiry, and a baseline of manager state, managed site
IDs, base file and runtime file. Save verifies that baseline under
`manager.lock`, then persists the entire batch with one `access-replaced` audit
event. Concurrent or repeated saves cannot overwrite a later state. Preview does
not persist drafts or change the runtime file. Publication continues through the
shared diff/apply pipeline. Its UI form carries a digest of the current and
candidate configuration; apply compares that digest after acquiring the state
lock and requires another review if either input changed. CLI and API apply keep
their existing contracts.

Saved rules and published runtime rules are shown separately. The latest apply
attempt must have succeeded and acknowledged a reload of the exact current
runtime hash before its contents are labelled last confirmed active. A failed
attempt makes activation unconfirmed even after file rollback, since the server
may have loaded the candidate before its response was lost. Applications present
only in the runtime remain visible and read-only until publication removes them.
This is historical evidence from the signed audit log, not a live server-state
probe. The manager does not claim to observe external reloads, restarts, or
existing app session expiry times. Access removal affects new sign-ins after
reload and subsequent SSO authorizations; each application owns the lifetime of
its existing session. The UI shows the current issuer JWT lifetime without
treating it as the expiry of previously issued sessions.

## What the manager exposes

Operators reach the manager through:

- Shared domain modules handle loading, normalization, validation, diffing,
  rendering, atomic apply, and audit logging.
- The `manager` CLI uses that shared layer directly for local inspection and
  operations.
- REST API endpoints on a dedicated manager service.
- Server-rendered admin pages.
- Gate-protected admin access using a dedicated manager site in static config.

## HTTP module boundaries

[`app.ts`](../manager/src/app.ts) validates service settings and composes the
Fastify application. Route registration lives in
[`routes/`](../manager/src/routes): session routes, site access API and forms,
and configuration pipeline API and pages. [`ui.ts`](../manager/src/ui.ts)
remains responsible for HTML templates;
[`http/ui.ts`](../manager/src/http/ui.ts) prepares page data and form drafts.

All route groups register on the same Fastify instance. Shared authentication,
same-origin checks, rate limits, HTML security headers, and error responses live
in [`http/security.ts`](../manager/src/http/security.ts) and
[`http/errors.ts`](../manager/src/http/errors.ts).

[`http/mutations.ts`](../manager/src/http/mutations.ts) installs the shared
write boundary before routes are registered. It holds `manager.lock` across each
mutation handler, including state loading, drift checks, persistence, and audit
recording. Concurrent requests use independent lock ownership even when invoked
from inside another transaction. Read routes and validation remain available
during writes. Apply owns its transaction in `applyManagerState`; login and
logout do not write manager state. CLI and domain persistence continue to use
the same lock implementation in [`lock.ts`](../manager/src/lock.ts).

## Reload model

The core server change is deliberately small:

- The server can expose an optional authenticated
  `POST /internal/access-config/reload` endpoint.
- Reload re-reads the TOML file already pointed to by `MAGICSSO_CONFIG_FILE`.
- The server validates the candidate config with the normal startup loader.
- Live reload only adopts site access data. If non-reloadable settings differ,
  reload fails and the current in-memory config stays active.

This keeps the server manager-agnostic. The server does not need to understand
manager state files or managed-mode-specific file formats.

## Security assumptions

- The manager and reload endpoint are operator/admin tools, not public
  multi-tenant APIs.
- The reload endpoint should only be exposed on private networking and must be
  protected by a dedicated static secret that is not manager-managed.
- The web manager sits behind Magic Link SSO Gate and requires a dedicated
  manager-admin site with bootstrap access defined in static config.
- Bootstrap access must remain outside manager-managed state so the UI cannot
  lock operators out of the system.

## Rollback

Managed mode is reversible by design:

1. Stop using the manager for apply operations.
2. Point `MAGICSSO_CONFIG_FILE` back to the original operator-maintained TOML.
3. Reload or restart the server with that classic config.
4. Keep or archive manager-owned files separately as operational history.

No database migration or schema teardown is required.
