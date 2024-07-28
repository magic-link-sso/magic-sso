# Magic SSO — TODO

## 🟢 Improvements & Ideas

### Laravel library (`packages/laravel/`)

- [ ] **Create `magic-link-sso/laravel` Composer package** — scaffold a reusable
      Laravel integration package under `packages/laravel/` with Composer
      metadata, PSR-4 autoloading, package auto-discovery, and Packagist-ready
      naming as `magic-link-sso/laravel`.
- [ ] **Add env-backed config + boot validation** — provide Laravel config for
      `MAGICSSO_SERVER_URL`, `MAGICSSO_JWT_SECRET`, and `MAGICSSO_COOKIE_NAME`,
      plus optional `MAGICSSO_COOKIE_DOMAIN`, `MAGICSSO_COOKIE_PATH`,
      `MAGICSSO_COOKIE_MAX_AGE`, `MAGICSSO_COOKIE_SECURE`,
      `MAGICSSO_COOKIE_SAMESITE`, `MAGICSSO_DIRECT_USE`,
      `MAGICSSO_AUTH_EVERYWHERE`, `MAGICSSO_PUBLIC_PATHS`,
      `MAGICSSO_REQUEST_TIMEOUT`, and `MAGICSSO_ROUTE_PREFIX`; fail fast for
      invalid or missing required values.
- [ ] **Provide service provider + middleware alias** — register a
      `MagicSsoServiceProvider` and a `magic-sso` middleware alias that
      validates the JWT cookie on each request and exposes
      `is_magic_sso_authenticated`, `magic_sso_user_email`, and
      `magic_sso_user_scope` on the request.
- [ ] **Ship package-managed auth routes** — include package routes for
      `GET|POST /login`, `GET /verify-email`, and `POST /logout` under `/sso` by
      default, with route names such as `magic-sso.login`,
      `magic-sso.verify-email`, and `magic-sso.logout`.
- [ ] **Support hosted and local login flows** — when
      `MAGICSSO_DIRECT_USE=true`, redirect straight to the Magic Link SSO server
      `/signin`; otherwise render a packaged Blade login page and submit
      `{ email, returnUrl, verifyUrl, scope? }` to the SSO server.
- [ ] **Handle verify callback + cookie lifecycle** — normalize same-origin
      return URLs, exchange verification tokens with the SSO server, set the
      Laravel-managed auth cookie with the configured flags, and clear the same
      cookie on logout.
- [ ] **Add `examples/laravel/`** — create a minimal Laravel example app with a
      public page, a protected page, package route wiring, and UI that shows the
      authenticated email and scope after sign-in.
- [ ] **Add package and example tests** — cover config validation, middleware
      auth checks, direct-use redirect flow, local login POST flow, verify-email
      success/failure, logout, scope forwarding, return-url normalization, and
      cookie option overrides.
- [ ] **Add Laravel to the shared e2e smoke suite** — extend the example-app
      browser tests with Laravel happy-path, tampered-token, and blocked-email
      coverage alongside the existing framework examples.
- [ ] **Document Laravel integration** — add `packages/laravel/README.md`,
      document install/config/route wiring, update the root README framework
      list, and clearly state that Laravel uses scoped PHP/Composer workflows
      rather than the default root `pnpm dev`, `pnpm test`, or `pnpm check`
      commands.
- [ ] **Keep Laravel out of default root workflows** — do not require
      system-wide PHP or Composer for the repo’s default Node/Python contributor
      path; use dedicated Laravel docs and, if needed later, dedicated CI/jobs
      only for Laravel-touched paths.
- [ ] **Publish to Packagist** — once metadata, docs, tests, and example
      coverage are in place, publish the package so consumers can run
      `composer require magic-link-sso/laravel`.

### Future framework targets

- [ ] **Research Go `chi` integration** — evaluate a first-party Go integration
      built on `net/http` + `chi`, with reusable middleware/helpers for JWT
      cookie verification, protected-route redirects, local login flow, verify
      callback handling, and example-app coverage. Treat this as the preferred
      first Go target.
- [ ] **Research Rust `axum` integration** — evaluate a first-party Rust
      integration built on `axum` + `tower`, with reusable auth
      layers/extractors for JWT cookie verification, protected-route redirects,
      local login flow, verify callback handling, and example-app coverage.
      Treat this as the preferred first Rust target.
- [ ] **Research Go `Gin` integration** — evaluate whether a more
      batteries-included Go package/example should follow `chi`, especially if
      `Gin` proves materially easier for adoption than a lower-level
      `net/http` + `chi` integration.
- [ ] **Research Rust `actix-web` integration** — evaluate whether an
      `actix-web` package/example should follow `axum`, especially if its
      middleware/extractor model or ecosystem fit proves better for Magic Link
      SSO consumers.

### Next.js library (`packages/nextjs/`)

- [ ] **Publish to npm** — publish prep is now in place (`prepublishOnly`,
      package README, clean tarball boundaries, `publishConfig`), but the
      library still needs an actual npm release so consumers can
      `npm install @magic-link-sso/nextjs` without depending on the repo
      workspace.
- [ ] **Publish Nuxt package to npm** — publish prep is now in place
      (`prepublishOnly`, package README, clean tarball boundaries,
      `publishConfig`), but the library still needs an actual npm release so
      consumers can `npm install @magic-link-sso/nuxt` without depending on the
      repo workspace.

### Django library (`packages/django/`)

- [ ] **Publish to PyPI** — publish prep is now in place (package README, richer
      `pyproject.toml` metadata, metadata coverage), but the library still needs
      an actual PyPI release so consumers can
      `pip install magic-link-sso-django`.

### Optional Web UI for Data Management (`manager/`)

- [ ] **Design Manager architecture** — Define a standalone service architecture
      (`manager/`) that provides a web-based dashboard specifically for managing
      dynamic data: `sites`, `emails`, and their authorized `scopes`. The base
      server configuration (JWT, SMTP, etc.) will remain in the static
      `magic-sso.toml` file.
- [ ] **Implement Hybrid Data Adapters in core** — Introduce an abstraction
      layer in the core `server/` to read core settings from TOML, while
      resolving users and site provisioning from a relational database (e.g.,
      PostgreSQL, SQLite), sharing the DB schema with the `manager/` service.
- [ ] **Create `manager/` service** — Initialize a structured backend and
      frontend dedicated solely to the CRUD operations of sites, emails, and
      scopes.
- [ ] **Secure the Web UI with `gate/`** — Dogfood the Magic Link SSO `gate/` to
      protect this internal UI from unauthorized personnel, requiring a specific
      high-privilege scope (e.g. `role:admin`) to access the interface.
- [ ] **Build Docker Compose flow** — Add a sample deployment configuration
      showing how to run the `server/` with external DB for dynamic data
      alongside the `manager/` UI and the `gate/` to secure it, offering a
      plug-and-play complete setup.

### Documentation

- [ ] **Add SvelteKit package/example** — cover another popular SSR-friendly
      framework with first-class cookie-based auth and protected-page handling.

### Security

### DevEx

- [ ] **Deployment/env presets** — provide copy-paste configuration recipes for
      localhost, reverse-proxy, and Docker deployments to reduce setup friction
      and misconfiguration.
