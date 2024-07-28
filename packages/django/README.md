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

### Local development

```sh
uv sync --all-groups
uv run pytest
```
