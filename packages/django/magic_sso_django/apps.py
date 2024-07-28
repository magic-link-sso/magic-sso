"""
# MIT License
#
# Magic Link SSO Copyright (C) 2026 Wojciech Polak
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
"""

from django.apps import AppConfig
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from .auth_utils import get_allowed_origins, get_configured_public_origin


def validate_magic_sso_settings() -> None:
    required_settings = [
        'MAGICSSO_JWT_SECRET',
        'MAGICSSO_PREVIEW_SECRET',
        'MAGICSSO_SERVER_URL',
        'MAGICSSO_COOKIE_NAME',
    ]

    missing_settings = [
        setting_name
        for setting_name in required_settings
        if not isinstance(getattr(settings, setting_name, None), str)
        or getattr(settings, setting_name).strip() == ''
    ]

    if missing_settings:
        missing = ', '.join(missing_settings)
        raise ImproperlyConfigured(f'Missing required Magic Link SSO settings: {missing}')

    cookie_samesite = getattr(settings, 'MAGICSSO_COOKIE_SAMESITE', 'Lax')
    if not isinstance(cookie_samesite, str) or cookie_samesite.strip().lower() not in {
        'lax',
        'strict',
        'none',
    }:
        raise ImproperlyConfigured(
            "MAGICSSO_COOKIE_SAMESITE must be one of: 'Lax', 'Strict', 'None'."
        )

    cookie_path = getattr(settings, 'MAGICSSO_COOKIE_PATH', '/')
    if (
        not isinstance(cookie_path, str)
        or cookie_path.strip() == ''
        or not cookie_path.startswith('/')
    ):
        raise ImproperlyConfigured('MAGICSSO_COOKIE_PATH must start with "/".')

    try:
        get_configured_public_origin()
        allowed_origins = get_allowed_origins()
    except ValueError as error:
        raise ImproperlyConfigured(str(error)) from error

    trust_proxy = getattr(settings, 'MAGICSSO_TRUST_PROXY', False)
    if trust_proxy and not isinstance(trust_proxy, bool):
        raise ImproperlyConfigured('MAGICSSO_TRUST_PROXY must be a boolean.')

    if (
        getattr(settings, 'USE_X_FORWARDED_HOST', False)
        and not trust_proxy
        and get_configured_public_origin() is None
    ):
        raise ImproperlyConfigured(
            'MAGICSSO_PUBLIC_ORIGIN must be configured when USE_X_FORWARDED_HOST is enabled without MAGICSSO_TRUST_PROXY.'
        )

    if trust_proxy and get_configured_public_origin() is None and len(allowed_origins) == 0:
        raise ImproperlyConfigured(
            'Configure MAGICSSO_PUBLIC_ORIGIN or MAGICSSO_ALLOWED_ORIGINS when MAGICSSO_TRUST_PROXY is enabled.'
        )


class MagicSsoConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'magic_sso_django'
    verbose_name = 'Django Magic Link SSO'

    def ready(self) -> None:
        validate_magic_sso_settings()
