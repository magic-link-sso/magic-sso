# Your first Magic Link SSO deployment

Choose the path that matches your application:

| You have…                                              | Start here                                 | What handles authentication                                               |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| An existing app, static site, or unsupported framework | [Gate](#protect-an-existing-app-with-gate) | Gate protects a private upstream; your app needs no auth code.            |
| An app you are developing                              | [SDK](#build-an-app-with-an-sdk)           | Your app owns its callback and session. The minimal starter uses Next.js. |

Both paths start in classic mode with one server config and one allowed email.
Add the optional manager when you need everyday access administration. Each app
has its own session; signing into one app does not sign you into another app.

## Before you start

Install Node.js 24.15.0 or newer and the pnpm version listed in `package.json`.
Clone this repository and install its dependencies:

```sh
git clone https://github.com/magic-link-sso/magic-sso.git
cd magic-sso
pnpm install
```

Run subsequent commands from that repository root unless stated otherwise. You
do not need to start the other examples or install Python for these two
starters.

The commands below run on one machine, using localhost and a local mailbox.
Docker is used only for the mailbox. Messages stay in that mailbox rather than
being sent to your real inbox. You can use any email address you control as the
allowed identity during this local proof.

Start Mailpit in a separate terminal and leave it running:

```sh
docker run --rm --name magic-sso-starter-mail \
  -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 \
  -e MP_SMTP_AUTH_ACCEPT_ANY=true -e MP_SMTP_AUTH_ALLOW_INSECURE=true \
  axllent/mailpit:latest
```

Open [the local mailbox](http://localhost:8025). These local authentication
settings follow the
[Mailpit Docker guide](https://mailpit.axllent.org/docs/install/docker/). For
real email delivery, use the
[HTTPS deployment settings](#deploy-with-https-and-real-email).

## Protect an existing app with Gate

1. Generate matching server and Gate config. Replace the email with your own:

    ```sh
    pnpm setup:app gate --email you@example.com
    ```

    The generator creates `.magic-sso/starter-gate/` with distinct random
    secrets, a matching site, callback, cookie name, and absolute state paths.
    It refuses to overwrite an existing directory. No live deployment is
    changed. `pnpm setup:app` without arguments asks which path and email to
    use.

2. Check the generated config and SMTP connection:

    ```sh
    pnpm doctor server --config .magic-sso/starter-gate/magic-sso.toml
    pnpm doctor server --config .magic-sso/starter-gate/magic-sso.toml --online
    ```

    Resolve any `FAIL` first. `--online` checks SMTP without sending a message.
    An explicit delivery test is available with
    `--send-test-email you@example.com`. Doctor currently checks the server;
    Gate is verified by the sign-in below.

3. Start the server in another terminal, from the repository root:

    ```sh
    MAGICSSO_CONFIG_FILE="$PWD/.magic-sso/starter-gate/magic-sso.toml" pnpm --filter magic-sso-server dev
    ```

4. Start a private upstream. For the smallest working proof, use the supplied
   loopback-only stand-in in another terminal:

    ```sh
    node starters/gate/upstream.mjs
    ```

    It listens on `127.0.0.1:3007`. To protect your actual application instead,
    pass `--upstream-url http://127.0.0.1:8080` when generating config and keep
    that upstream reachable only through Gate.

5. Start Gate in another terminal:

    ```sh
    MAGIC_GATE_CONFIG_FILE="$PWD/.magic-sso/starter-gate/magic-gate.toml" pnpm --filter magic-sso-gate dev
    ```

6. Open [your protected application](http://localhost:4000/). You should see the
   hosted sign-in page. Enter the allowed email, open its message in Mailpit,
   follow the magic link, and confirm sign-in. You should now see **Your private
   application**, or your own upstream's page. Refresh: the page should still
   open. Choose **Sign out**: the next visit should require sign-in.

Your existing application does not need the Next.js SDK or a callback route.
Gate owns `/_magicgate/verify-email` and its authentication cookie.

## Build an app with an SDK

Stop the previous local starter if you ran it: both paths use server port 3000.
Leave Mailpit running.

1. Generate the minimal Next.js app and its matching server config:

    ```sh
    pnpm setup:app sdk --email you@example.com
    ```

    The output is `.magic-sso/starter-sdk/`. `app/` is an ordinary standalone
    Next.js project using the published `@magic-link-sso/nextjs` package. It has
    a public home page, a private page, the SDK proxy, verification callback,
    and POST logout. The server's JWT and preview secrets are already aligned
    with `app/.env.local`; they are never public browser environment variables.

2. Check the configuration:

    ```sh
    pnpm doctor server --config .magic-sso/starter-sdk/magic-sso.toml
    pnpm doctor server --config .magic-sso/starter-sdk/magic-sso.toml --online
    ```

3. Start the server in another terminal:

    ```sh
    MAGICSSO_CONFIG_FILE="$PWD/.magic-sso/starter-sdk/magic-sso.toml" pnpm --filter magic-sso-server dev
    ```

4. Install and start the generated app in another terminal:

    ```sh
    npm --prefix .magic-sso/starter-sdk/app install
    npm --prefix .magic-sso/starter-sdk/app run dev
    ```

5. Open [the private page](http://localhost:3001/private). Enter the allowed
   email on the hosted sign-in page. Open the email in Mailpit, follow the link,
   and confirm. The app should show **You are signed in** and your email.
   Refresh, then sign out and verify that `/private` requires sign-in again.

The generated `NEXT-STEPS.md` contains commands for a custom output directory.
Keep the generated app as your starting point, or copy its few auth routes into
your own Next.js app. For other frameworks, follow the
[Angular](../packages/angular/README.md), [Nuxt](../packages/nuxt/README.md),
[Django](../packages/django/README.md), or
[Fastify](../examples/fastify/README.md) integration. Keep one matching server
site per app origin.

## Add another person

1. In the generated `magic-sso.toml`, add their email to the site's
   `allowedEmails` array. Keep the existing secrets:

    ```toml
    allowedEmails = ["you@example.com", "friend@example.com"]
    ```

2. Run `pnpm doctor server --config <your-config-path>` again, then stop and
   restart only the server process with the same config path. Classic mode reads
   config at startup.
3. Have that person open the application and request their own sign-in email.
   For the local proof, use a separate browser profile and Mailpit. In an HTTPS
   deployment, the message arrives at their real inbox.

To remove access, remove the email and restart the server. That prevents new
sign-ins. An existing app session can remain valid until its JWT expires (one
hour in these starters).

When editing email lists becomes inconvenient, move to
[managed mode](./managed-mode.md). The manager keeps grants separately, offers
preview and apply, and can reload access configuration. Introduce it after the
first login works; keep its bootstrap admin access in operator-owned config.

## Deploy with HTTPS and real email

Keep the same Gate or SDK choice. Generate into a new, private directory, using
your actual origins and SMTP provider. For example:

```sh
# Set this through your shell's secret input or deployment secret store.
export MAGICSSO_SETUP_SMTP_PASSWORD
pnpm setup:app gate --email you@example.com --output /srv/magic-link-sso/first-app \
  --server-origin https://sso.example.com --app-origin https://private.example.com \
  --upstream-url http://127.0.0.1:8080 \
  --smtp-host smtp.example.com --smtp-port 587 --smtp-user smtp-user \
  --email-from signin@example.com
unset MAGICSSO_SETUP_SMTP_PASSWORD
```

Use `sdk` instead of `gate` for the generated Next.js app. `--smtp-secure` means
implicit TLS, normally port 465; omit it for SMTP with STARTTLS, normally
port 587. HTTPS generation requires explicit SMTP credentials and sender so the
local mailbox defaults cannot silently carry into a real deployment.

Terminate TLS at your reverse proxy. Route the server public origin to its local
listener on port 3000; route the app public origin to Gate on port 4000 or
Next.js on port 3001. Override listeners with `--server-port` and `--app-port`.
Use `--trust-proxy` only when that proxy sanitizes forwarded headers and the
backend cannot be reached directly. Keep Gate's upstream private and restrict
backend listeners with host firewall or container network rules.

Run doctor from the host where the server runs, including `--online`, then
perform the same browser sign-in and logout proof. For the SDK app, use
`npm run build` and `npm start` from its directory for deployment, keeping its
environment loaded. For server/Gate images and service management, continue with
[server deployment](../README.md#getting-started) and
[Gate deployment](../gate/README.md#standalone-production-gate). If using
containers, mount the config read-only, make the generated state directory
durable and writable by the server user, and change absolute state paths to the
container's mounted paths. The configured public origins must also resolve and
be reachable from each service.

Setup creates its output directory with mode `0700` and secret files with mode
`0600`. Give the service account ownership of the files it needs before starting
it; the published server and Gate images run as UID 1001. Keep these private
permissions when transferring config to a host or container.

## Update an existing deployment

Do not rerun setup over your deployment or replace its secrets. Back up the
TOML, app environment, and state directories. Update the repository or pinned
images; for an SDK app, keep and update its dependency lockfile. Build, run
doctor with the existing config, restart the affected services, and repeat
sign-in and logout in a fresh browser profile. Check a second allowed person and
an address without a grant. Keep the previous build or image available for
rollback.

If sign-in fails, use [operator diagnostics](./doctor.md): check the public
origins and callback, SMTP, and whether the email has a grant. A healthy
`/healthz` endpoint alone does not prove the complete login flow.
