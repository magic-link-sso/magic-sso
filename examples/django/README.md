# Integrating Django Project with Magic Link SSO

[Magic Link SSO](../../README.md)

## Integration

1. Add the `magic_sso_django` app to your `INSTALLED_APPS`:

    ```python
    INSTALLED_APPS = [
        #...
        'magic_sso_django',
        #...
    ]
    ```

2. Add the middleware to your `MIDDLEWARE`:

    ```python
    MIDDLEWARE = [
        #...
        'magic_sso_django.middleware.MagicSsoMiddleware',
        #...
    ]
    ```

3. Include the `magic_sso_django` URLs in your `urls.py`:

    ```python
    from django.urls import path, include

    urlpatterns = [
        #...
        path('sso/', include('magic_sso_django.urls')),
        #...
    ]
    ```

4. Configure your `settings.py`:

    ```python
    # These helpers already exist in the bundled example settings module.
    SECRET_KEY = os.getenv('DJANGO_SECRET_KEY', DEVELOPMENT_SECRET_KEY)
    DEBUG = env_bool('DJANGO_DEBUG', True)
    ALLOWED_HOSTS = env_list(
        'DJANGO_ALLOWED_HOSTS',
        ['localhost', '127.0.0.1'] if DEBUG else [],
    )

    MAGICSSO_SERVER_URL = os.getenv('MAGICSSO_SERVER_URL', 'http://localhost:3000')
    MAGICSSO_DIRECT_USE = True
    MAGICSSO_COOKIE_NAME = 'magic-sso'
    MAGICSSO_COOKIE_DOMAIN = None
    MAGICSSO_COOKIE_PATH = '/'
    MAGICSSO_COOKIE_MAX_AGE = 3600
    MAGICSSO_COOKIE_SAMESITE = 'Lax'
    MAGICSSO_COOKIE_SECURE = env_bool('MAGICSSO_COOKIE_SECURE', not DEBUG)
    MAGICSSO_JWT_SECRET = 'VERY-VERY-LONG-RANDOM-JWT-SECRET'
    MAGICSSO_PREVIEW_SECRET = 'VERY-VERY-LONG-RANDOM-PREVIEW-SECRET'
    MAGICSSO_AUTH_EVERYWHERE = False
    MAGICSSO_PUBLIC_URLS = ['login']
    MAGICSSO_REQUEST_TIMEOUT = 5
    ```

    The checked-in fallback values are for localhost development only. For any
    shared or production-like environment, set `DJANGO_DEBUG=false`,
    `DJANGO_SECRET_KEY` to a unique secret, and `DJANGO_ALLOWED_HOSTS` to the
    real hostnames before starting Django. The example raises at startup if you
    disable debug mode without those values.

    These settings must align with the Magic Link SSO server:
    - `MAGICSSO_JWT_SECRET`
    - `MAGICSSO_PREVIEW_SECRET`
    - `MAGICSSO_SERVER_URL`
    - `MAGICSSO_COOKIE_NAME`

    Set `MAGICSSO_COOKIE_MAX_AGE` if you want the Django-managed auth cookie to
    persist across browser restarts. `MAGICSSO_COOKIE_SAMESITE` defaults to
    `'Lax'` and can be set to `'Strict'` or `'None'` when needed.
    `MAGICSSO_COOKIE_PATH` defaults to `'/'`; narrowing it can make auth
    unavailable outside that subtree. See
    [packages/django/README.md](../../packages/django/README.md) for the full
    settings reference.

    The bundled example also reads matching `MAGICSSO_*`, `DJANGO_DEBUG`,
    `DJANGO_SECRET_KEY`, and `DJANGO_ALLOWED_HOSTS` environment variables. Use
    [`.env.example`](./.env.example) as the template for localhost-only shell
    exports or your preferred env loader.

5. Sync the environment with uv:

    ```sh
    uv sync --all-groups
    ```

6. Run the Django server:
    ```sh
    uv run python manage.py runserver
    ```

## Usage

1. Open the Django client in your browser at `http://localhost:8000`.
2. Click the login button to be redirected to the SSO server.
3. Enter your email address to receive a magic link.
4. Click the magic link in your email to be redirected back to the Django
   client, now authenticated.
