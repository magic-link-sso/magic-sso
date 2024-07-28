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

import jwt
from urllib.parse import urlencode, urlsplit
from typing import Any
from django.conf import settings
from django.core.exceptions import DisallowedHost
from django.http import HttpRequest, HttpResponseRedirect
from django.urls import reverse
from django.shortcuts import redirect


def normalize_origin(origin: str, setting_name: str) -> str:
    parsed_origin = urlsplit(origin)
    if parsed_origin.scheme not in {'http', 'https'} or parsed_origin.netloc == '':
        raise ValueError(f'{setting_name} must be an absolute http(s) origin.')

    return f'{parsed_origin.scheme}://{parsed_origin.netloc}'


def get_configured_public_origin() -> str | None:
    public_origin = getattr(settings, 'MAGICSSO_PUBLIC_ORIGIN', None)
    if not isinstance(public_origin, str) or public_origin.strip() == '':
        return None

    return normalize_origin(public_origin, 'MAGICSSO_PUBLIC_ORIGIN')


def get_allowed_origins() -> set[str]:
    configured_origins = getattr(settings, 'MAGICSSO_ALLOWED_ORIGINS', None)
    if configured_origins is None:
        public_origin = get_configured_public_origin()
        return {public_origin} if isinstance(public_origin, str) else set()

    if not isinstance(configured_origins, (list, tuple, set)):
        raise ValueError('MAGICSSO_ALLOWED_ORIGINS must be a list of absolute http(s) origins.')

    return {
        normalize_origin(str(origin), 'MAGICSSO_ALLOWED_ORIGINS')
        for origin in configured_origins
        if isinstance(origin, str) and origin.strip() != ''
    }


def get_request_origin(request: HttpRequest) -> str | None:
    public_origin = get_configured_public_origin()
    if isinstance(public_origin, str):
        return public_origin

    if getattr(settings, 'USE_X_FORWARDED_HOST', False) and not getattr(
        settings, 'MAGICSSO_TRUST_PROXY', False
    ):
        return None

    try:
        request_origin = request.build_absolute_uri('/')
    except DisallowedHost:
        return None
    normalized_origin = request_origin[:-1] if request_origin.endswith('/') else request_origin
    allowed_origins = get_allowed_origins()

    if len(allowed_origins) > 0 and normalized_origin not in allowed_origins:
        return None

    return normalized_origin


def get_expected_issuer() -> str | None:
    server_url = getattr(settings, 'MAGICSSO_SERVER_URL', None)
    if not isinstance(server_url, str) or server_url.strip() == '':
        return None

    parsed_url = urlsplit(server_url)
    if parsed_url.scheme == '' or parsed_url.netloc == '':
        return None

    return f'{parsed_url.scheme}://{parsed_url.netloc}'


def verify_access_token(token: str, request: HttpRequest) -> dict[str, Any] | None:
    expected_issuer = get_expected_issuer()
    expected_audience = get_request_origin(request)
    if expected_issuer is None or expected_audience is None:
        return None

    try:
        payload = jwt.decode(
            token,
            settings.MAGICSSO_JWT_SECRET,
            algorithms=['HS256'],
            audience=expected_audience,
            issuer=expected_issuer,
        )
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None

    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get('email'), str)
        or not isinstance(payload.get('scope'), str)
        or not isinstance(payload.get('siteId'), str)
    ):
        return None

    return payload


def is_authenticated(request: HttpRequest) -> tuple[bool, dict[str, Any]]:
    token = request.COOKIES.get(settings.MAGICSSO_COOKIE_NAME)
    if not token:
        return False, {}

    payload = verify_access_token(token, request)
    if payload is None:
        return False, {}

    return True, payload


def redirect_to_login(request: HttpRequest, scope: str | None = None) -> HttpResponseRedirect:
    return_url = request.build_absolute_uri(request.path)
    params = {'returnUrl': return_url}
    if isinstance(scope, str) and scope.strip():
        params['scope'] = scope.strip()
    params = urlencode(params)
    return redirect(reverse('magic_sso:login') + '?' + params)
