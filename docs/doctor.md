# Operator diagnostics for Magic Link SSO

Run `doctor` before starting a deployment or when a sign-in or managed apply
fails. It checks the current server or manager configuration without starting
services, changing grants, creating storage directories, acquiring manager
locks, or writing state and audit records.

From the repository root:

```sh
pnpm doctor server --config /srv/magic-link-sso/magic-sso.toml
pnpm doctor manager --config /srv/magic-link-sso/manager.toml
pnpm doctor server --config /srv/magic-link-sso/magic-sso.toml --online --json
pnpm doctor manager --config /srv/magic-link-sso/manager.toml --online
```

The root command builds the selected component before running it; build output
goes to stderr so `--json` stdout contains just the report. `--config` takes
precedence over `MAGICSSO_CONFIG_FILE` or `MAGICSSO_MANAGER_CONFIG_FILE`.
Without the flag, the component uses its existing configuration environment
variable. The server also loads its usual `.env` file.

The root wrapper resolves explicit config paths and existing config environment
paths relative to the calling directory. It runs each component in its own
workspace directory. Relative server storage paths use that component's working
directory, as during normal startup; manager paths remain relative to the
manager settings file. Use absolute production paths to avoid ambiguity.

## What is checked

- Server: TOML parsing and configuration validation, site IDs, origins and
  allowed callback consistency, insecure cookies outside local development, and
  permissions for configured file storage and its session/OTP directories.
- Manager: settings, base configuration, managed site selection, saved state,
  candidate and existing runtime configuration, reload secret consistency, saved
  changes and drift, and permissions for state, audit, lock and runtime paths,
  including directories needed for atomic replacement.
- A missing generated manager file is a bootstrap warning. Missing initial state
  skips candidate rendering until grants have been saved or reconciled. An
  existing malformed state or runtime file is an error.

The report describes local files and permissions for the current user. It cannot
establish which configuration is active in a running server, verify a Docker
bind mount from another container, or validate application-owned callback
handlers. Gate, SDK configuration, Redis connectivity, and shared browser SSO
sessions are outside this version's scope. Redis connectivity is explicitly
reported as skipped, including with `--online`.

## Network checks and test email

By default no dependency is contacted. `--online` verifies all configured SMTP
transports for the server, or performs an authenticated read-only reload probe
for the manager. Each operation has a 5000 ms deadline; override it with
`--timeout-ms <100..30000>`. Multiple transports have separate deadlines. All
configured SMTP transports failing is an error; a functioning fallback with an
unavailable primary is a warning.

SMTP verification checks the connection and authentication when advertised by
the server, using the same settings as sign-in email; it sends no message and
does not prove delivery. To explicitly send a diagnostic message:

```sh
pnpm doctor server --config /srv/magic-link-sso/magic-sso.toml \
  --send-test-email operator@example.com
```

This server-only flag enables SMTP checks even without `--online`, then tries
delivery using the configured transport order until one accepts the message. The
message contains no sign-in token, magic link, or OTP. Acceptance by SMTP does
not guarantee inbox delivery.

The manager's probe uses `GET /internal/access-config/reload` with the existing
`x-magic-sso-reload-secret` header. The server responds with
`{ "status": "ok", "reloadEnabled": true }` and `Cache-Control: no-store`. It
does not read a candidate or reload grants. The existing POST apply endpoint
keeps its behavior. Redirects are rejected; 403, unavailable services, malformed
responses and timeouts fail the check. HTTP 404/405 is a warning: check the URL,
reload configuration and whether the server version supports this probe.

## Run inside a production container

Run in the corresponding service container to check its network, mounts and
production user's permissions. Substitute the container name and mounted path:

```sh
docker exec magic-sso-server node dist/doctor.js \
  --config /app/runtime/magic-sso.runtime.toml --online
docker exec magic-sso-manager node dist/cli.js doctor \
  --config /app/config/manager.toml --online --json
```

The compiled commands are included in the server and manager images and do not
need pnpm, TypeScript or development dependencies to run.

## Reports and exit codes

Each check contains `id`, `status`, `setting`, `message`, and `correction`.
Statuses are `pass`, `warn`, `fail`, and `skip`. Independent checks continue
after errors; dependent checks explain why they were skipped. Reports avoid
configuration secrets, raw parser excerpts and raw dependency responses.

- Exit `0`: no failed checks; warnings and skipped checks may remain.
- Exit `1`: at least one failed check.
- Exit `2`: invalid command arguments.

Use `--help` for options and `--json` for machine-readable results. Successful
diagnostics support deployment troubleshooting; they do not replace an actual
sign-in test.
