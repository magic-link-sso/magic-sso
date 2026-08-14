# @magic-link-sso/core

Framework-agnostic authentication primitives for Magic Link SSO. The package
remains private until its public API and package contents have passed a release
review.

## Trust model

Pass secrets, the expected audience, and the expected issuer from trusted server
configuration. Do not expose `MAGICSSO_JWT_SECRET` to browser code or derive an
audience from an untrusted `Host` or forwarding header. An adapter may use proxy
headers only after it has explicitly enabled and configured that trust boundary.

`verifyAuthToken` accepts only HS256 tokens, verifies the issuer and audience,
and checks the complete access-token shape: `email`, `jti`, `scope`, `siteId`,
`aud`, `iss`, `iat`, and `exp`. Failed credential verification returns `null`;
invalid programmatic configuration throws `MagicSsoConfigurationError`.

The package reads no environment variables and has no hidden client state. Keep
token verification and OTP exchange in server code: they require trusted
secrets. URL and cookie helpers can also be bundled by framework integrations.
The portable implementation uses standard Web APIs and `jose`.

## Server integrations

Each example receives a trusted application origin from deployment
configuration. It never infers that origin from request headers.

### Fastify

```ts
import {
    readCookieValue,
    toSecretKey,
    verifyAuthToken,
} from '@magic-link-sso/core';

const jwtSecret = readServerSecret(); // server-only deployment configuration

fastify.get('/private', async (request, reply) => {
    const token = readCookieValue(request.headers.cookie, 'magic-sso');
    const auth = token
        ? await verifyAuthToken(token, toSecretKey(jwtSecret), {
              expectedAudience: 'https://app.example.test',
              expectedIssuer: 'https://sso.example.test',
          })
        : null;

    return auth ? { email: auth.email } : reply.code(401).send();
});
```

### Express

```ts
app.get('/private', async (request, response) => {
    const token = readCookieValue(request.header('cookie'), 'magic-sso');
    const auth = token
        ? await verifyAuthToken(token, toSecretKey(jwtSecret), {
              expectedAudience: trustedAppOrigin,
              expectedIssuer: trustedSsoOrigin,
          })
        : null;

    return auth
        ? response.json({ email: auth.email })
        : response.sendStatus(401);
});
```

### Hono

```ts
app.get('/private', async (context) => {
    const token = readCookieValue(context.req.header('cookie'), 'magic-sso');
    const auth = token
        ? await verifyAuthToken(token, toSecretKey(jwtSecret), {
              expectedAudience: trustedAppOrigin,
              expectedIssuer: trustedSsoOrigin,
          })
        : null;

    return auth
        ? context.json({ email: auth.email })
        : context.text('Unauthorized', 401);
});
```

## Standard Request integration

```ts
import {
    readCookieValue,
    toSecretKey,
    verifyAuthToken,
} from '@magic-link-sso/core';

const token = readCookieValue(request.headers.get('cookie'), 'magic-sso');
const auth =
    token === undefined
        ? null
        : await verifyAuthToken(token, toSecretKey(jwtSecret), {
              expectedAudience: trustedAppOrigin,
              expectedIssuer: trustedSsoOrigin,
          });
```

Fastify and Express adapters pass `request.headers.cookie`; Hono passes
`c.req.header('cookie')`. In every case, `trustedAppOrigin` must come from a
fixed deployment setting such as `MAGICSSO_PUBLIC_ORIGIN`, or from a separately
reviewed proxy-trust policy.

## OTP and cookies

`exchangeEmailOtp` receives `fetch`, an optional `AbortSignal`, all trusted
token inputs, and the OTP data. Its discriminated result distinguishes a
rejected code from malformed responses, network failure, cancellation, and a
returned token that failed verification. `buildAuthCookieOptions` always emits
`httpOnly: true` and `sameSite: 'lax'`; the adapter makes the explicit `secure`
decision and maps the neutral `maxAge` field to its framework.
