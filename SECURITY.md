# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |

Only the latest release in the 1.x line receives security fixes.

## Reporting a vulnerability

Magic Link SSO issues the session tokens every app behind it trusts, so a bug
here is a bug in all of them.

**Please do not open a public GitHub issue for security vulnerabilities.**

Use the [Report a vulnerability](../../security/advisories/new) button on the
GitHub Security tab in the public `magic-link-sso/magic-sso` repository to open
a private advisory. That keeps the disclosure confidential until a fix is ready.

## What to include

A useful report contains:

- A clear description of the vulnerability and its potential impact
- The affected component (SSO server, a client package, or both)
- Steps to reproduce or a minimal proof-of-concept
- The version or commit hash where you observed the issue
- Any suggested mitigations if you have them

## Response timeline

This is an open-source project maintained in spare time. There are no guaranteed
SLAs, but the goal is:

| Stage             | Target                           |
| ----------------- | -------------------------------- |
| Acknowledgement   | Best effort, typically ≤ 7 days  |
| Fix or workaround | Best effort, typically ≤ 90 days |

Holidays and busy stretches push those numbers out. You will hear back once
someone picks the report up.

## In scope

These count as valid security issues:

- JWT forgery, bypass, or secret-handling mistakes in the server or client
  packages
- Token replay vulnerabilities (the one-time token store)
- CSRF protection bypass on the sign-in or verify-email endpoints
- SMTP injection or header injection in the email delivery path
- Auth cookie mishandling, such as incorrect flags, over-broad scope, or
  insecure transmission
- Open redirects introduced by the server or a client package
- Dependency CVEs that affect the published packages at runtime

## Out of scope

These are not reportable:

- Vulnerabilities that require social engineering of the end user
- Issues in example apps that do not affect the reusable packages or server
- Self-inflicted misconfiguration, such as a weak `jwtSecret` chosen by the
  operator
- Rate-limiting bypass that requires the operator to have disabled or
  misconfigured the built-in limits
- Missing security headers in a consumer application that does not use the
  hosted auth pages

## Operator responsibilities for secrets

Operators must protect these values in `magic-sso.toml`:

| Secret           | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `jwtSecret`      | Signs and verifies all session JWTs      |
| `csrfSecret`     | Signs CSRF tokens on hosted auth pages   |
| `emailSecret`    | Signs one-time email verification tokens |
| SMTP credentials | Sends magic-link emails                  |

Rotating any of these secrets immediately invalidates all outstanding tokens or
sessions derived from the old value.

## Disclosure policy

This project follows coordinated disclosure:

1. Reporter submits a private advisory.
2. Maintainer acknowledges and investigates.
3. Maintainer prepares a fix in a private branch.
4. Maintainer publishes a patched release.
5. The advisory goes public after users have had reasonable time to upgrade
   (typically 7 days after the release).

Confirmed, responsibly disclosed vulnerabilities get credit in the release
notes. Say in the advisory whether you want to be named.
