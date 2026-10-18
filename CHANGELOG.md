# Changelog

All notable changes to Magic Link SSO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for public releases.

## [Unreleased]

### Added

- (sso) Add an optional My applications launcher with explicit names and
  destinations, current-grant filtering, hosted link/OTP sign-in, account change
  and central sign-out. Launch through registered SSO start routes while
  preserving independent application sessions and permissions.

- (sso) Extend shared browser sign-in to application-owned email and OTP forms
  across Gate and every SDK. Add opt-in browser-bound bootstrap tickets,
  completion receipts, explicit account/browser confirmation, logout
  cancellation and cross-language continuation fixtures. Preserve valid local
  sessions on shared-setup failures and verify the full flow over cross-site
  HTTPS in Chromium, Firefox and WebKit.

- (sso) Add opt-in shared browser identity with hosted magic-link/OTP, atomic
  one-time PKCE codes, host-only central cookies and independent application
  JWTs across Gate, Next.js, Angular SSR, Nuxt, Django and Fastify. Include
  bounded concurrent sign-in tabs, explicit account changes, distinct local and
  central logout, deployment diagnostics and a cross-site HTTPS browser suite.

- (tests) Extend the shared adapter contract to complete magic-link and OTP
  sign-in, full return URLs, session reuse and logout across all integrations;
  include reverse-proxy and whole-application protection in standard E2E checks

- (tooling) Add server and manager `doctor` commands with read-only deployment
  diagnostics, optional bounded SMTP and reload probes, explicit test email, and
  JSON reports; include the commands in production images

### Fixed

- (fastify) Retain query parameters when protected requests redirect to sign-in
- (nuxt) Keep named page middleware available with whole-application protection
- (adapters) Use configured or explicitly trusted forwarded origins for Next.js
  and Nuxt sign-in redirects; align the examples' form and submission URLs

- (manager) Serialize state changes with apply to prevent concurrent writes from
  losing updates
- (gate) Preserve WebSocket upgrade response headers
- (gate) Stream upstream request bodies without parsing to preserve uploads and
  exact payload contents
- (django) Keep sign-in callbacks public when global authentication is enabled
- (adapters) Preserve query strings across Next.js and Django sign-in redirects
- (e2e) Include the manager flow in standard verification and fix its runtime
  configuration
- (tooling) Propagate failures from every Python project in shared checks

### Documentation

- Mount managed runtime directories instead of individual files so atomic
  configuration updates remain visible inside Docker containers

## [1.4.4] - 2026-10-11

### Documentation

- Split root license files for GitHub license detection

### Fixed

- (deps) Clear security audit and restore Nuxt compatibility

## [1.4.3] - 2026-09-17

### Changed

- Pass fallow health with real coverage data

### Chore

- Upgrade dependencies

## [1.4.2] - 2026-09-14

### Changed

- Share duplicated auth helpers and cut complexity

### Chore

- Remove fallow dependency
- (examples) Upgrade Angular to v22
- Upgrade dependencies

### Fixed

- Stop e2e web server process groups

## [1.4.1] - 2026-08-14

### Fixed

- Publish workspace dependencies with pnpm

## [1.4.0] - 2026-08-14

### Added

- (core) Extract shared auth primitives and migrate adapters
- (core) Publish package to npm

### Chore

- Upgrade dependencies

## [1.3.0] - 2026-07-19

### Added

- Add email OTP security

### Chore

- Upgrade dependencies

## [1.2.0] - 2026-06-19

### Changed

- Reduce fallow dead-code noise
- Reduce duplicated runtime helpers

### Chore

- Upgrade pnpm to v11
- Upgrade dependencies

### Documentation

- Compare auth options

### Fixed

- Refresh all Python locks during dependency upgrades
- Respect pnpm release age in dependency upgrades

## [1.1.1] - 2026-05-10

### Fixed

- Include workspace deps in docker builds

## [1.1.0] - 2026-05-10

### Added

- Add manager

### Chore

- Upgrade dependencies

### Documentation

- Update README.md about dev:direct

### Fixed

- Update pnpm overrides during deps upgrade
- Make python audit sandbox-safe
- Expand release prep version coverage

## [1.0.0] - 2026-05-01

### Chore

- Upgrade dependencies

### Documentation

- Cleanups

### Fixed

- Improve dev shutdown behavior
- Improve gate startup validation

## [0.9.0] - 2026-04-26

### Added

- Initial public release
