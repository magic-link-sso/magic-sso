# Release Checklist

Use this checklist before the first public release and before any later tagged
release.

## GitHub repository

- The canonical public repository is
  `https://github.com/magic-link-sso/magic-sso`.
- The default branch is `main`.
- `README.md`, package metadata, and workflow links all resolve against `main`.
- Community files are present and current: `LICENSE-MIT`, `LICENSE-GPL`,
  `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, and
  `.github/CODEOWNERS`.

## Release automation prerequisites

- GitHub Actions is enabled for the repository.
- The `pypi` GitHub environment is configured for trusted publishing and allows
  the `Publish` workflow to request an OIDC token.
- GitHub Packages permissions are enabled so the Docker workflow can publish to
  GHCR with `packages: write`.
- Release tags follow the `v*` pattern used by both the publish and Docker
  workflows.

## Changelog and version prep

Preview the unreleased notes that `git-cliff` will turn into the next release:

```sh
pnpm changelog:preview
```

When you are ready to cut a release, prepare the changelog entry and bump the
managed release versions together:

```sh
pnpm version:bump -- minor
pnpm version:bump -- minor --apply
pnpm release:prepare -- minor

pnpm release:prepare -- 0.9.0
```

- `major`, `minor`, and `patch` resolve from the current shared release version
  used by the published packages, similar to `npm version`.
- `pnpm changelog:release -- 0.9.0` only updates `CHANGELOG.md`.
- `pnpm version:bump -- 0.9.0 --apply` remains the source of truth for package
  and Python release version updates.
- `pnpm release:prepare -- 0.9.0` runs both steps, then verifies that
  `CHANGELOG.md` contains `## [0.9.0] - YYYY-MM-DD`.
- Release prep keeps the versioned JS workspaces, the Django package, and the
  Django example aligned with the shared release version.

## Verification commands

`pnpm run audit` runs the full `pnpm audit` check, including development
dependencies, followed by the Python runtime dependency audit.

To update dependencies, preview with `pnpm deps:upgrade` and apply with
`pnpm deps:upgrade -- --apply`. Applying also refreshes transitive JavaScript
dependencies within their declared ranges, even when no manifest versions
change. Run `pnpm install` afterwards to sync installed packages with the new
lockfile. The upgrade helper keeps peer compatibility ranges unchanged unless
`--include-peer` is passed; a dependency also used for development still gets
updated in `devDependencies`.

An upgrade is not a guarantee of a clean audit: upstream exact pins, workspace
overrides, and the 24-hour release cooldown can still prevent a fixed version
from being selected. Review the reported dependency paths and add a targeted
workspace override when necessary, then install and rerun the audit.

Run these from the repository root:

```sh
pnpm run audit
pnpm check
pnpm test:e2e
pnpm --filter @magic-link-sso/angular pack --dry-run
pnpm --filter @magic-link-sso/nextjs pack --dry-run
pnpm --filter @magic-link-sso/nuxt pack --dry-run
cd packages/django && uv build
```

The complete `pnpm test:e2e` command includes legacy and shared SSO profiles and
requires Playwright Chromium, Firefox and WebKit. Follow
[the opt-in deployment walkthrough](browser-sso-deployment.md) for exact
callback registration, pilot acceptance and rollback. When enabling the optional
launcher, verify explicit names/destinations, a scoped user's list, account
change and central sign-out following the
[launcher guide](browser-sso-deployment.md#my-applications-launcher).

## Manual checks

- Review the `CHANGELOG.md` diff before committing the release prep.
- Commit the release prep, then create and push the release tag:

```sh
git tag v0.9.0 && git push origin v0.9.0
```

- The publish workflow runs on the pushed tag, verifies that managed release
  versions match the tag, publishes artifacts, and creates or updates the GitHub
  Release from the matching `CHANGELOG.md` section.
- If a publish job fails partway through, rerunning the workflow will skip npm
  packages and the PyPI release that already exist for the tagged version, then
  continue with the remaining publish steps.
- npm tarballs contain only intended build output, docs, and licenses.
- The Django sdist and wheel build cleanly without packaging warnings.
- GHCR image tags and labels match the intended release for both published
  images: `ghcr.io/magic-link-sso/magic-sso/server` and
  `ghcr.io/magic-link-sso/magic-sso/gate`.
- All public documentation uses the `Magic Link SSO` name in user-facing copy.
