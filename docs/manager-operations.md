# Manager Operations for Magic Link SSO

This guide covers the practical recovery paths for managed mode. It assumes the
server is reading `magic-sso.runtime.toml`, the manager owns
`manager-state.json`, and operators still own `magic-sso.base.toml`.

## File Roles During Recovery

Keep these responsibilities in mind during any incident:

- `magic-sso.base.toml`: operator-authored source for global settings, site
  definitions, bootstrap admin access, and unmanaged sites.
- `manager-state.json`: manager-owned source for managed grants, scope catalogs,
  and apply metadata.
- `magic-sso.runtime.toml`: generated runtime file read by the server.
- `magic-sso.runtime.last-good.toml`: rollback copy of the most recent good
  runtime config.
- `manager-audit.ndjson`: signed history of grant edits, scope edits, and apply
  outcomes, with bounded archive rotation.
- `manager.lock`: single-writer lock file used during apply.

## Portable State Transfer

The manager supports a portable snapshot format for manager-owned access state:

- `manager export` or `GET /api/state/export` returns
  `{ version, managedSites }` only.
- exported snapshots intentionally exclude `lastAppliedAt` plus all
  `lastApplied*Hash` values.
- `manager import <file>`, `POST /api/state/import`, or the `/reconcile` page
  fully replace manager-owned state and reset that apply metadata so the next
  `validate` or `apply` establishes a fresh baseline.

Use portable export/import when you need to:

- move manager-owned access state between environments
- recover from an accidentally deleted `manager-state.json`
- stage a reviewed access snapshot before regenerating runtime output

Import does not regenerate `magic-sso.runtime.toml` on its own. Always review
`manager diff` and run `manager validate` before the next apply.

## Apply Failure Triage

When `manager apply` fails, sort the failure into one of these buckets first:

1. Base config drift: `magic-sso.base.toml` changed after the last managed
   apply, so the manager blocks further writes until the operator reconciles the
   base file.
2. Runtime validation failure: the generated runtime TOML is invalid under the
   shared server validation rules, so the manager refuses to hand it to the
   server.
3. Reload failure: the manager wrote a candidate runtime file, but the server
   rejected the reload request or could not be reached.
4. Operational failure: file permissions, missing paths, or a stale lock file
   prevented the apply from finishing.

Useful first checks:

- Run `manager validate` to confirm whether the current base file and manager
  state still render a valid runtime config.
- Run `manager diff` to see which managed sites would change.
- Inspect `manager-audit.ndjson` for the latest `apply-failed` event and actor
  metadata.
- Confirm ownership and permissions on `manager-state.json`,
  `magic-sso.runtime.toml`, `magic-sso.runtime.last-good.toml`,
  `manager-audit.ndjson`, and `manager.lock`.

## Reload Failure and Rollback

The manager protects reload-based applies like this:

1. It acquires `manager.lock`.
2. It remembers the existing runtime TOML or the previous last-known-good copy.
3. It writes the new `magic-sso.runtime.toml` atomically.
4. It calls the server reload endpoint if `[reload]` is configured.
5. If reload fails, it restores the rollback runtime TOML and records an
   `apply-failed` audit event with `rolledBack = true`.

Operator response:

1. Read the failure message from the CLI, UI, or API response.
2. Check the latest audit event to confirm whether rollback happened.
3. Compare `magic-sso.runtime.toml` and `magic-sso.runtime.last-good.toml` if
   you want to verify the restored file contents.
4. Fix the underlying issue:
    - wrong reload secret
    - reload endpoint not reachable
    - server rejected the candidate TOML
    - file permission problem on the runtime directory
5. Re-run `manager validate`, then `manager apply --yes` after the cause is
   resolved.

If you do not need hot reload, remove `[reload]` from the manager settings and
fall back to restart-based applies.

## Base Config Drift Recovery

Base drift means the operator changed `magic-sso.base.toml` out of band after
the manager last applied state. The manager blocks apply in this case on
purpose.

Recovery flow:

1. Review the operator edits in `magic-sso.base.toml`.
2. Confirm the changes belong in the base file rather than in manager-owned
   grants or scope catalogs.
3. Run `manager reconcile status` or open `/reconcile` to preview what would be
   imported from the base file.
4. If the base file is now authoritative for managed access, run
   `manager reconcile base --yes`.
5. Run `manager validate` to ensure the reconciled state still combines cleanly
   with the base file.
6. Run `manager diff` to inspect the new managed-site output.
7. Apply again only after the base file reflects the intended source of truth.

Do not copy managed access data back into the base file just to bypass drift
protection. If access should remain manager-owned, keep it in
`manager-state.json` and let the manager regenerate the runtime file.

## Runtime Drift Recovery

Runtime drift means the current `magic-sso.runtime.toml` no longer matches what
the manager expects from the base file plus manager state.

Typical causes:

- someone edited the runtime TOML manually
- an older runtime file was copied into place
- a failed operational step left the runtime file out of sync with state

Recovery flow:

1. Treat `magic-sso.runtime.toml` as disposable output, not as a source file.
2. Run `manager reconcile status` or open `/reconcile` to see whether the
   runtime file contains managed access changes you want to preserve.
3. If the runtime file should become the new manager-owned source of truth, run
   `manager reconcile runtime --yes`.
4. Run `manager validate` to confirm the base file and reconciled manager state
   are still coherent.
5. Run `manager diff` to preview the runtime the manager wants to restore.
6. Run `manager apply --yes` to regenerate `magic-sso.runtime.toml`.
7. If the current live server behavior looks suspicious, compare the regenerated
   runtime file with `magic-sso.runtime.last-good.toml` before or after apply.

If runtime drift keeps recurring, stop editing `magic-sso.runtime.toml` by hand
and tighten file ownership on the runtime directory.

## Lock File Recovery

`manager.lock` should disappear when apply exits cleanly. If apply fails because
the lock already exists:

1. Make sure another manager apply is not still running.
2. Inspect the lock file timestamp and process context if needed.
3. Remove the stale lock only after you are confident no active apply is in
   progress.
4. Re-run `manager validate` and then `manager apply --yes`.

Treat lock removal as an operator recovery step, not part of normal workflow.

## When to Revert to Classic Mode

Managed mode is optional. Revert to classic mode when:

- you need the simplest possible recovery path during an incident
- you no longer want the manager UI, API, or CLI on that deployment
- your team prefers manual TOML-only operations for that environment

Classic rollback steps:

1. Stop running `manager apply`.
2. Stop the manager service if you no longer need managed-mode access.
3. Point `MAGICSSO_CONFIG_FILE` back to your operator-maintained classic TOML.
4. Reload or restart the server.
5. Keep `manager-state.json`, `manager-audit.ndjson`, and generated runtime
   files only as historical artifacts if you no longer need managed mode.

No database migration or teardown is required.
