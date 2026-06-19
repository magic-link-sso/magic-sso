# Changelog

All notable changes to Magic Link SSO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for public releases.

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
