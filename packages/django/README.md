## magic-link-sso-django

Reusable Django integration package for the Magic Link SSO server.

## Install

```sh
pip install magic-link-sso-django
```

## Required settings

At minimum, configure:

```python
MAGICSSO_SERVER_URL = 'http://localhost:3000'
MAGICSSO_JWT_SECRET = 'replace-me-with-a-long-random-jwt-secret'
MAGICSSO_PREVIEW_SECRET = 'replace-me-with-a-different-long-random-preview-secret'
MAGICSSO_COOKIE_NAME = 'magic-sso'
```

Other supported settings:

```python
MAGICSSO_AUTH_EVERYWHERE = False
MAGICSSO_COOKIE_DOMAIN = None
MAGICSSO_COOKIE_MAX_AGE = None
MAGICSSO_COOKIE_PATH = '/'
MAGICSSO_COOKIE_SAMESITE = 'Lax'
MAGICSSO_COOKIE_SECURE = True
MAGICSSO_DIRECT_USE = False
MAGICSSO_PUBLIC_ORIGIN = 'https://app.example.com'
MAGICSSO_PUBLIC_URLS = ['login']
MAGICSSO_REQUEST_TIMEOUT = 5
MAGICSSO_TRUST_PROXY = False
MAGICSSO_ALLOWED_ORIGINS = ['https://app.example.com']
```

The integration's own login, magic-link callback, and OTP callback always remain
public, including when `MAGICSSO_AUTH_EVERYWHERE=True` and the public URL list
is empty. `MAGICSSO_PUBLIC_URLS` adds application routes; routes in other apps
do not become public merely by sharing a callback name.

| Setting                    | Required | Default     | Notes                                                                                                                                                        |
| -------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAGICSSO_ALLOWED_ORIGINS` | No       | `[]`        | Optional allowlist of absolute origins accepted when deriving the current site origin dynamically, especially behind trusted proxies.                        |
| `MAGICSSO_AUTH_EVERYWHERE` | Yes      | None        | When `True`, unauthenticated requests to non-public routes redirect to login.                                                                                |
| `MAGICSSO_COOKIE_DOMAIN`   | No       | `None`      | Optional cookie domain used when the Django app stores the returned JWT.                                                                                     |
| `MAGICSSO_COOKIE_MAX_AGE`  | No       | `None`      | Optional persistent cookie lifetime in seconds for the Django-managed auth cookie. Set it to match or stay below the server JWT expiration.                  |
| `MAGICSSO_COOKIE_NAME`     | Yes      | None        | Required at app startup. Should match the server cookie name.                                                                                                |
| `MAGICSSO_COOKIE_PATH`     | No       | `/`         | Optional path scope for the Django-managed auth cookie. Narrowing it can make auth unavailable outside that subtree.                                         |
| `MAGICSSO_COOKIE_SAMESITE` | No       | `Lax`       | Explicit `SameSite` policy for the Django-managed auth cookie. Must be one of `Lax`, `Strict`, or `None`.                                                    |
| `MAGICSSO_COOKIE_SECURE`   | No       | `True`      | Controls the `Secure` flag on the Django-managed auth cookie.                                                                                                |
| `MAGICSSO_DIRECT_USE`      | Yes      | None        | When `True`, the login view redirects straight to the SSO server instead of rendering the local form.                                                        |
| `MAGICSSO_JWT_SECRET`      | Yes      | None        | Required at app startup. Must match the server JWT secret.                                                                                                   |
| `MAGICSSO_PREVIEW_SECRET`  | Yes      | None        | Required at app startup. Used by `/sso/verify-email/` to preview the email token before exchange. Must match the server preview secret.                      |
| `MAGICSSO_PUBLIC_ORIGIN`   | No       | `None`      | Explicit origin used for site-bound JWT audience checks. Recommended unless you intentionally rely on trusted proxy headers.                                 |
| `MAGICSSO_PUBLIC_URLS`     | No       | `['login']` | Public Django URL names that bypass auth middleware.                                                                                                         |
| `MAGICSSO_REQUEST_TIMEOUT` | No       | `5`         | Timeout in seconds for requests from Django to the SSO server.                                                                                               |
| `MAGICSSO_SERVER_URL`      | Yes      | None        | Required at app startup. Base URL of the SSO server and expected issuer for site-bound auth tokens.                                                          |
| `MAGICSSO_TRUST_PROXY`     | No       | `False`     | Only enable this with a reverse proxy that sanitizes forwarded headers. When enabled without `MAGICSSO_PUBLIC_ORIGIN`, configure `MAGICSSO_ALLOWED_ORIGINS`. |

The package validates `MAGICSSO_JWT_SECRET`, `MAGICSSO_PREVIEW_SECRET`,
`MAGICSSO_SERVER_URL`, `MAGICSSO_COOKIE_NAME`, `MAGICSSO_COOKIE_SAMESITE`,
`MAGICSSO_COOKIE_PATH`, and the proxy/origin trust settings during app startup
so configuration mistakes fail fast.

Auth tokens are site-bound. The middleware and built-in `/sso/verify-email/`
view verify the returned token against the current Django origin and the SSO
server issuer. Upgrading to this release invalidates older session cookies that
were issued without `siteId`/`aud`/`iss`, so users need to sign in again after
deployment.

Keep `USE_X_FORWARDED_HOST = False` unless Django is only reachable through a
trusted proxy that overwrites forwarded headers. If you do enable
`USE_X_FORWARDED_HOST`, set `MAGICSSO_TRUST_PROXY = True` and configure either
`MAGICSSO_PUBLIC_ORIGIN` or a strict `MAGICSSO_ALLOWED_ORIGINS` allowlist so
site-bound JWT audience checks stay anchored to trusted origins.

## Basic integration

1. Add `'magic_sso_django'` to `INSTALLED_APPS`.
2. Add `'magic_sso_django.middleware.MagicSsoMiddleware'` to `MIDDLEWARE`.
3. Include `path('sso/', include('magic_sso_django.urls'))` in `urls.py`.
4. Configure the required `MAGICSSO_*` settings.

Keep Django's `CsrfViewMiddleware` enabled and submit logout through a POST form
with `{% csrf_token %}`. The built-in `/sso/logout/` view is POST-only.

Verified requests expose both `request.magic_sso_user_email` and
`request.magic_sso_user_scope`, and the decoded JWT payload now includes
`siteId` for site-bound authorization checks. The built-in `/sso/login/` view
also accepts an optional `scope` query or form field and forwards it to the SSO
server.

If the server enables `[auth.otp]`, the packaged login form renders a single OTP
field after sign-in. Its CSRF-protected `/sso/verify-email/otp/` view exchanges
the code server-side, validates the returned JWT, and sets the normal HTTP-only
cookie.

### Local development

```sh
uv sync --all-groups
uv run pytest
```

## Shared browser SSO (opt-in)

Hosted browser SSO reuses the issuer's identity while this application keeps its
own JWT and permissions. The default mode is `off`. Set
`MAGICSSO_BROWSER_SSO_MODE=auto` for capability-controlled legacy fallback, or
`required` to reject an issuer that does not support this protocol. Set
`MAGICSSO_PUBLIC_ORIGIN` to the exact externally visible app origin and keep
`MAGICSSO_SERVER_URL` and `MAGICSSO_JWT_SECRET` on the backend. A distinct
issuer hostname and HTTPS are required. Local HTTP is available only with the
explicit `MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST=true` test/development
exception. `MAGICSSO_BROWSER_SSO_TIMEOUT_MS` defaults to 5000 (100–30000).

Register the app's exact start, callback and signed-out URLs in the issuer's
`[[sites.sso]]` configuration. These routes stay public even when whole-app auth
is enabled. Start/callback must use top-level document navigation; prefetch and
client-side data requests must not create or consume transactions. Three tabs
can sign in independently. Callback failures leave existing app sessions intact.
Local logout clears this app's cookie and shows a public page with separate
sign-in and central sign-out controls. Ending central SSO leaves other issued
app JWTs subject to their existing expiry policy.

See the [browser session contract](../../docs/browser-sso-contract.md) for
registration, rollout and protocol details. Application-owned forms keep their
existing behavior until the separate bootstrap continuation is enabled.

Use the equivalent Django settings (the environment variables in the example
populate these): `MAGICSSO_BROWSER_SSO_MODE`, `MAGICSSO_PUBLIC_ORIGIN`,
`MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST` and
`MAGICSSO_BROWSER_SSO_TIMEOUT_MS`. With the URLconf mounted at `/sso/`, register
`/sso/start/`, `/sso/callback/` and `/sso/signed-out/` including their trailing
slashes. URL names are `magic_sso:sso_start`, `magic_sso:sso_callback` and
`magic_sso:sso_signed_out`. The middleware reserves them as infrastructure
routes. SSO transaction and new app cookies are host-only; cookie Domain is not
used for this flow. The Python AES-GCM/HKDF implementation is checked against
the shared TypeScript wire fixture.

### Application-owned sign-in forms

With issuer `[auth.sso].bootstrapEnabled = true`, set
`MAGICSSO_BROWSER_SSO_LOGIN_UI = "app-owned"` alongside the browser SSO mode.
The existing `/sso/start/` route accepts GET and POST and serves email and OTP
forms on the application's own origin. Keep `MAGICSSO_PREVIEW_SECRET` on the
backend for the explicit magic-link identity confirmation. The default remains
`"hosted"`. No third-party cookie or browser fetch to the issuer is needed.

Local verification sets the normal verified JWT before a top-level issuer visit.
The completion callback requires that exact existing JWT and a verified issuer
receipt; it never sets another authentication cookie. Failed shared setup keeps
valid local sessions and offers explicit fresh hosted sign-in. The app cookie
path must cover the callback. See the
[bootstrap contract](../../docs/browser-sso-bootstrap-contract.md) for the
shared wire format and backend continuation requirements.
