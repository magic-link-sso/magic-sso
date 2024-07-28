# Contributing to Magic Link SSO

Thanks for helping improve Magic Link SSO.

## Ground rules

- The public GitHub repository is the canonical home for source, issues, and
  releases.
- The default branch is `main`.
- Use `Magic Link SSO` in user-facing copy and keep existing machine-facing
  identifiers such as `magic-sso`, `@magic-link-sso/*`, `magic-link-sso-django`,
  and `MAGICSSO_*`.
- Security reports should go through the private advisory flow in
  [`SECURITY.md`](./SECURITY.md), not public issues.

## Development setup

1. Install Node.js `24.15.0` or later and `pnpm 10.30.3` or later.
2. Install Python `3.12` or later and `uv 0.10` or later.
3. Install dependencies:

    ```sh
    pnpm install
    pnpm python:sync
    ```

4. Run the full local quality gate before opening a PR:

    ```sh
    pnpm check
    pnpm test:e2e
    ```

## Formatting and tests

- TypeScript is strict-mode only. Avoid `any` and undocumented type assertions.
- Python code must be fully typed.
- Add tests for every feature and bug fix.
- Keep commits focused and use Conventional Commits.

Repository commands:

```sh
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm check
```

Python-only commands:

```sh
pnpm python:check
pnpm python:test
```

## Header policy

Use a copyright and SPDX header on authored source files and scripts:

- MIT-covered files:

    ```text
    // SPDX-License-Identifier: MIT
    // Copyright (C) 2026 Wojciech Polak
    ```

- GPL-covered server files:

    ```text
    // SPDX-License-Identifier: GPL-3.0-or-later
    // Copyright (C) 2026 Wojciech Polak
    ```

Match the comment style of the file type. Existing legacy full-license headers
may remain until those files are otherwise touched.

## Releases

Use the checklist in [`docs/release-checklist.md`](./docs/release-checklist.md)
before publishing npm, PyPI, or GHCR artifacts.
