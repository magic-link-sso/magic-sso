# Choosing an Auth Option

This guide compares Magic Link SSO with two common self-hostable alternatives:
[Better Auth](https://better-auth.com/) and
[Keycloak](https://www.keycloak.org/).

The short version: choose Magic Link SSO when you want a small, email-based SSO
service for private self-hosted apps. Choose Better Auth when your TypeScript
application should own a broad set of authentication features in code. Choose
Keycloak when you need a full identity provider with standard protocols,
federation, and centralized identity administration.

## Quick Recommendation

| Need                                                                            | Best fit       | Why                                                                                                                                                            |
| ------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protect a few private apps with email magic links and little infrastructure     | Magic Link SSO | It is purpose-built for small self-hosted deployments, can run without a database, and includes Magic Link SSO Gate for static, CSR, or unknown upstream apps. |
| Add auth directly inside a TypeScript app                                       | Better Auth    | It is a framework-agnostic TypeScript auth framework with built-in methods, database adapters, and a large plugin ecosystem.                                   |
| Run a central identity provider for many apps, teams, protocols, or directories | Keycloak       | It provides OpenID Connect, OAuth 2.0, SAML, user federation, identity brokering, admin consoles, and authorization services.                                  |

## Choose Magic Link SSO When

- You want passwordless email sign-in for a small private deployment.
- You want one TOML-driven server that issues site-bound JWT session tokens.
- You want the option to run without a database in classic mode.
- You need framework integrations for Angular SSR, Django, Fastify, Next.js, or
  Nuxt.
- You need to protect a static site, CSR app, or unknown upstream through Magic
  Link SSO Gate instead of embedding auth code in the app.
- Your access model is mostly allowlists, per-site grants, and optional scopes
  rather than a broad identity-management program.

Magic Link SSO is not the right fit when you need a general-purpose user
database, social login, passkeys, organization membership, SAML, SCIM, or OIDC
provider behavior. It is intentionally narrower than a full IAM platform.

## Choose Better Auth When

- Your application is TypeScript-first and should own auth routes, sessions, and
  user data.
- You want built-in email/password or social sign-on, with optional plugins for
  features such as magic links, passkeys, two-factor auth, organizations, API
  keys, JWTs, SSO, SCIM, and OIDC provider behavior.
- You already have, or are comfortable adding, a database or ORM integration for
  auth state.
- You prefer auth configuration in application code and migrations over a
  separate SSO server with TOML site definitions.
- You may later connect to Better Auth's managed infrastructure for dashboard,
  audit-log, security-detection, or enterprise features.

Better Auth is not the right fit when the main goal is to put a small auth-gate
in front of private apps without making each app own user/session state. It is
broader and more application-centered than Magic Link SSO.

## Choose Keycloak When

- You need a central identity provider for multiple applications or teams.
- You need standard protocols such as OpenID Connect, OAuth 2.0, or SAML.
- You need identity brokering, social login, LDAP or Active Directory
  federation, admin consoles, account management, fine-grained authorization, or
  theming.
- You are ready to operate a larger identity service with its own database,
  configuration model, upgrade process, and administrative lifecycle.
- You need mature IAM capabilities more than a minimal private-app magic-link
  flow.

Keycloak is not the right fit when you mainly want a tiny email-link service for
a handful of private apps. It is much more capable, but that capability comes
with a larger operational surface.

## Comparison Matrix

| Area                        | Magic Link SSO                                                                                                        | Better Auth                                                                                                      | Keycloak                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Primary shape               | Separate self-hosted email SSO server plus optional Gate and framework packages.                                      | Auth framework embedded in a TypeScript app, or run as a self-hosted auth server.                                | Standalone identity and access management server.                                                                 |
| Best audience               | Operators protecting small private deployments.                                                                       | TypeScript product teams building app-owned auth.                                                                | Teams that need centralized IAM, standards, federation, and admin workflows.                                      |
| Main login model            | Email magic links.                                                                                                    | Email/password and social sign-on built in, with magic links and many other methods through plugins.             | Configurable login flows, federation, social login, MFA, and standard protocol clients.                           |
| Database needs              | Classic mode can run without a database; file or Redis state can back replay protection and throttling.               | A database is required for normal user data; stateless session mode exists, but most plugins require a database. | Production deployments should plan for a database-backed identity service.                                        |
| Protocols                   | Site-bound JWT sessions for integrated apps and Gate.                                                                 | App/session APIs plus plugins for JWT, SSO, SCIM, OAuth/OIDC provider, and related features.                     | OpenID Connect, OAuth 2.0, SAML, and federation/brokering features.                                               |
| App integration             | Framework packages for supported stacks, or Magic Link SSO Gate in front of upstreams.                                | Route handlers and clients for many TypeScript/web frameworks.                                                   | Client adapters, standard protocols, and app configuration against a central IdP.                                 |
| Reverse-proxy protection    | First-class through Magic Link SSO Gate.                                                                              | Not the core product shape; use app handlers or build a gateway around it.                                       | Usually protects apps through protocol integration; reverse-proxy patterns need separate infrastructure.          |
| User and admin management   | TOML access rules in classic mode; optional manager for selected access administration.                               | App-owned user management, sessions, organizations, and admin features through core APIs and plugins.            | Central admin console, account console, users, sessions, realms, clients, federation, and authorization services. |
| Extensibility               | Keep the server small; extend through framework packages, Gate, managed mode, and deployment config.                  | Plugin ecosystem and code-level customization.                                                                   | Themes, providers, admin APIs, protocol configuration, and server extensions.                                     |
| Operational complexity      | Low for classic mode; moderate with Gate or managed mode.                                                             | Moderate, tied to the hosting app, database, migrations, and selected plugins.                                   | Highest of the three; operate an IAM service and its lifecycle.                                                   |
| Licensing in these projects | Mixed: server and manager are GPLv3-or-later; Gate, examples, docs/tooling, and published framework packages are MIT. | MIT for the open-source framework; paid pricing applies only to Better Auth managed infrastructure.              | Apache-2.0.                                                                                                       |

## Sources

- [Magic Link SSO README](../README.md)
- [Magic Link SSO Gate](./gate.md)
- [Magic Link SSO managed mode](./managed-mode.md)
- [Better Auth introduction](https://better-auth.com/docs/introduction)
- [Better Auth installation](https://better-auth.com/docs/installation)
- [Better Auth plugins](https://better-auth.com/docs/plugins)
- [Better Auth infrastructure pricing](https://better-auth.com/pricing)
- [Better Auth GitHub repository](https://github.com/better-auth/better-auth)
- [Keycloak project site](https://www.keycloak.org/)
- [Keycloak documentation](https://www.keycloak.org/documentation)
