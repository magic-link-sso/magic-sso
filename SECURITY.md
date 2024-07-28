# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

Only the latest release in the 1.x line receives security fixes.

## Reporting a Vulnerability

Magic Link SSO is an authentication system. Security issues are taken seriously.

**Please do not open a public GitHub issue for security vulnerabilities.**

Use the **[Report a vulnerability](../../security/advisories/new)** button on
the GitHub Security tab in the public `magic-link-sso/magic-sso` repository to
open a private advisory. This keeps the disclosure confidential until a fix is
ready.

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

Response may be slower during holidays or periods of reduced availability. You
will be kept informed of progress once the report is picked up.

## Scope — in scope

The following are considered valid security issues:

- JWT forgery, bypass, or secret-handling mistakes in the server or client
  packages
- Token replay vulnerabilities (the one-time token store)
- CSRF protection bypass on the sign-in or verify-email endpoints
- SMTP injection or header injection in the email delivery path
- Auth cookie mishandling: incorrect flags, over-broad scope, or insecure
  transmission
- Open redirects introduced by the server or a client package
- Dependency CVEs that affect the published packages at runtime

## Scope — out of scope

The following are not considered reportable:

- Vulnerabilities that require social engineering of the end user
- Issues in example apps that do not affect the reusable packages or server
- Self-inflicted misconfiguration (e.g. a weak `jwtSecret` chosen by the
  operator)
- Rate-limiting bypass that requires the operator to have disabled or
  misconfigured the built-in limits
- Missing security headers in a consumer application that does not use the
  hosted auth pages

## Sensitive secrets — operator responsibilities

Operators are responsible for protecting the following values in
`magic-sso.toml`:

| Secret           | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `jwtSecret`      | Signs and verifies all session JWTs      |
| `csrfSecret`     | Signs CSRF tokens on hosted auth pages   |
| `emailSecret`    | Signs one-time email verification tokens |
| SMTP credentials | Sends magic-link emails                  |

Rotating any of these secrets immediately invalidates all outstanding tokens or
sessions derived from the old value.

## Disclosure policy

We follow **coordinated disclosure**:

1. Reporter submits a private advisory.
2. Maintainer acknowledges and investigates.
3. A fix is prepared in a private branch.
4. A patched release is published.
5. The advisory is made public after users have had reasonable time to upgrade
   (typically 7 days after the release).

Credit is offered in the release notes for confirmed, responsibly disclosed
vulnerabilities. Please let us know whether you would like to be named.
