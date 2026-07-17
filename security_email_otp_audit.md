# Email OTP Security Audit — Follow-up Pass

## Executive summary

The three findings from the first pass are resolved. This follow-up found **no
open Critical, High, Medium, or Low security findings** in the email OTP branch.

The Next.js and Nuxt cookie-issuing routes now reject cross-origin and
source-less mutations before reading or exchanging a code. The configured
`rotate` policy now leaves only one active OTP challenge for the same normalized
email, site, scope, return URL, and verify URL, with atomic enforcement in the
file, Redis, and in-memory stores.

From the reviewed application-code perspective, the branch is **ready to push**.
The production deployment must still preserve the origin/proxy and edge-limit
assumptions listed below.

## Scope

- Branch delta: `main...otp`, through commit `67ea3ff`
- Follow-up delta: `566ab9c...67ea3ff`
- Core server OTP creation, hashing, storage, rotation, verification, attempt
  limits, expiry, replay handling, redirects, and email construction
- Redis, file-backed, and in-memory OTP challenge stores
- Gate, Angular, Django, Fastify, Next.js, and Nuxt integration paths that
  exchange an OTP or set an authentication cookie
- OTP-related tests, configuration, examples, and documentation

## Open findings

None.

## Resolution of previous findings

### OTP-001: Nuxt login CSRF — resolved

- The route requires both a same-origin mutation source and `application/json`
  before reading the body:
  `packages/nuxt/src/runtime/server/routes/verify-email-otp.post.ts:55-66`.
- Origin resolution prefers the configured public origin, only consumes
  forwarded headers when proxy trust is explicitly enabled, and rejects a
  request with neither a valid `Origin` nor same-origin `Referer`:
  `packages/nuxt/src/runtime/server/utils/auth.ts:281-329`.
- Regression tests cover cross-origin rejection, form-content rejection, and the
  allowed same-origin flow.

### OTP-002: Next.js login CSRF — resolved

- The package now provides a request-aware `VerifyEmailOtpRoute()` that is
  POST-only and rejects a request without an exact same-origin source before
  invoking the cookie-setting exchange:
  `packages/nextjs/src/components/login/otpRoute.ts:12-34`.
- Expected-origin resolution prefers `MAGICSSO_PUBLIC_ORIGIN`, gates forwarded
  headers behind `MAGICSSO_TRUST_PROXY`, and fails closed when both `Origin` and
  `Referer` are absent: `packages/nextjs/src/lib/auth.ts:155-193`.
- Both Next.js examples now delegate to this protected route helper instead of
  calling `verifyEmailOtp()` from an unprotected custom Route Handler.
- Regression tests cover a hostile origin, a source-less request, and a valid
  same-origin referer.

### OTP-003: `rotate` did not revoke older challenges — resolved

- Challenge creation derives a keyed rotation identifier from the normalized
  email plus the site, scope, return URL, and verify URL binding, then invokes
  the configured `rotate` strategy: `server/src/app.ts:1747-1798` and
  `server/src/otp.ts:42-65`.
- The file store serializes create/verify operations by rotation key, atomically
  replaces the active pointer, deletes the superseded challenge, and checks the
  pointer during verification: `server/src/otpChallengeStore.ts:253-363`.
- The Redis adapter rotates and verifies with atomic Lua scripts:
  `server/src/redisSecurityState.ts:55-111`.
- The in-memory adapter maintains the same single-active-challenge invariant:
  `server/src/otpChallengeStore.ts:367-421`.
- Store-level and end-to-end server tests prove that the earlier challenge no
  longer verifies after a resend and that the replacement still succeeds.

## Security controls reconfirmed

- Codes are generated with `crypto.randomInt`; configured length is bounded to
  6–10 numeric digits.
- Stored codes are HMAC-SHA-256 digests bound to challenge ID, site ID, and the
  verification grant `jti`; comparisons use `timingSafeEqual`.
- The dedicated OTP secret is required when OTP is enabled, is validated for
  minimum strength, and is also used to keep email addresses out of rotation
  filenames and Redis keys.
- Challenges expire no later than the underlying email verification grant.
- Wrong guesses are bounded per challenge; the final failed attempt removes the
  challenge.
- Successful verification is single-use and atomic under concurrent requests.
- OTP and magic-link exchange share verification-grant replay protection, so
  consuming one prevents replay of the corresponding grant through the other.
- Authentication tokens are checked for expected issuer and audience before an
  integration writes its authentication cookie.
- Browser-facing cookie mutations are same-origin/CSRF protected; the core JSON
  exchange does not itself set a browser cookie.
- Redirect, site, scope, and email values used after a successful OTP exchange
  come from the stored, previously validated challenge rather than the verify
  request.
- Error responses remain generic and OTP responses are marked no-store.
- The forbidden-email response preserves the public OTP response shape without
  creating a usable challenge.
- The file store retains `0700` directory and `0600` file permissions.

## Production assumptions and residual operational risk

These are deployment requirements, not open code findings:

- Prefer a fixed `MAGICSSO_PUBLIC_ORIGIN`. Enable `MAGICSSO_TRUST_PROXY` only
  behind a proxy that overwrites untrusted `Forwarded`/`X-Forwarded-*` headers.
- Enforce request-body and request-rate limits at the public reverse proxy or
  hosting edge for the framework integration routes, in addition to the core
  server's OTP attempt and endpoint limits.
- Use Redis for multi-instance deployments. The in-memory store is explicitly a
  development option; the file store requires shared/local process semantics
  appropriate to the deployment topology.
- Email OTP is an alternate possession proof for the emailed grant, not a second
  authentication factor.

## Verification performed

- Focused Next.js OTP/origin tests — 44 tests passed.
- Focused Nuxt OTP/origin tests — 41 tests passed.
- Focused server OTP/store/application tests — 226 tests passed.
- `pnpm check` — passed, including formatting, linting, builds, TypeScript type
  checks, JavaScript/TypeScript tests, Python formatting/lint/type checks, and
  Python tests.
- `pnpm audit --prod` — no known production dependency vulnerabilities.
- `git diff --check main...HEAD` — passed.

## Release recommendation

The previous release blockers are closed. The email OTP implementation can be
pushed from a security-review standpoint, provided the production proxy/origin
configuration follows the assumptions above.
