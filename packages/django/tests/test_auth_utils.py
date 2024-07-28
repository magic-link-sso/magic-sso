# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from urllib.parse import parse_qs, urlparse

import jwt
from django.conf import settings
from django.test import RequestFactory, override_settings

from magic_sso_django.auth_utils import (
    get_request_origin,
    is_authenticated,
    redirect_to_login,
)


def sign_access_token(audience: str = 'http://testserver') -> str:
    return jwt.encode(
        {
            'email': 'user@example.com',
            'scope': 'album-A',
            'siteId': 'site-a',
            'aud': audience,
            'iss': 'http://sso.example.com',
        },
        settings.MAGICSSO_JWT_SECRET,
        algorithm='HS256',
    )


def test_is_authenticated_returns_payload_for_valid_cookie() -> None:
    request = RequestFactory().get('/protected/')
    request.COOKIES[settings.MAGICSSO_COOKIE_NAME] = sign_access_token()

    authenticated, payload = is_authenticated(request)

    assert authenticated is True
    assert payload['email'] == 'user@example.com'
    assert payload['scope'] == 'album-A'
    assert payload['siteId'] == 'site-a'


def test_is_authenticated_returns_false_for_invalid_cookie() -> None:
    request = RequestFactory().get('/protected/')
    request.COOKIES[settings.MAGICSSO_COOKIE_NAME] = 'invalid-token'

    authenticated, payload = is_authenticated(request)

    assert authenticated is False
    assert payload == {}


def test_is_authenticated_rejects_tokens_for_a_different_origin() -> None:
    request = RequestFactory().get('/protected/')
    request.COOKIES[settings.MAGICSSO_COOKIE_NAME] = sign_access_token(
        audience='http://admin.example.com'
    )

    authenticated, payload = is_authenticated(request)

    assert authenticated is False
    assert payload == {}


@override_settings(MAGICSSO_PUBLIC_ORIGIN='https://app.example.com/path?q=1')
def test_is_authenticated_uses_magic_sso_public_origin_for_site_binding() -> None:
    request = RequestFactory().get('/protected/', HTTP_HOST='internal.example.local')
    request.COOKIES[settings.MAGICSSO_COOKIE_NAME] = sign_access_token(
        audience='https://app.example.com'
    )

    authenticated, payload = is_authenticated(request)

    assert authenticated is True
    assert payload['email'] == 'user@example.com'


@override_settings(
    USE_X_FORWARDED_HOST=True, MAGICSSO_TRUST_PROXY=False, MAGICSSO_PUBLIC_ORIGIN=None
)
def test_get_request_origin_returns_none_when_forwarded_host_is_untrusted() -> None:
    request = RequestFactory().get('/', HTTP_X_FORWARDED_HOST='app.example.com')

    assert get_request_origin(request) is None


@override_settings(
    ALLOWED_HOSTS=['testserver', 'localhost', 'app.example.com'],
    USE_X_FORWARDED_HOST=True,
    MAGICSSO_TRUST_PROXY=True,
    MAGICSSO_ALLOWED_ORIGINS=['https://app.example.com'],
)
def test_get_request_origin_accepts_trusted_proxy_origins_from_allowlist() -> None:
    request = RequestFactory().get(
        '/',
        secure=True,
        HTTP_HOST='internal.example.local',
        HTTP_X_FORWARDED_HOST='app.example.com',
    )

    assert get_request_origin(request) == 'https://app.example.com'


@override_settings(
    ALLOWED_HOSTS=['testserver', 'localhost', 'admin.example.com'],
    USE_X_FORWARDED_HOST=True,
    MAGICSSO_TRUST_PROXY=True,
    MAGICSSO_ALLOWED_ORIGINS=['https://app.example.com'],
)
def test_get_request_origin_rejects_trusted_proxy_origins_outside_allowlist() -> None:
    request = RequestFactory().get(
        '/',
        secure=True,
        HTTP_HOST='internal.example.local',
        HTTP_X_FORWARDED_HOST='admin.example.com',
    )

    assert get_request_origin(request) is None


def test_redirect_to_login_preserves_return_url() -> None:
    request = RequestFactory().get('/protected/')

    response = redirect_to_login(request)
    parsed = urlparse(response.url)

    assert response.status_code == 302
    assert parsed.path == '/sso/login/'
    assert parse_qs(parsed.query) == {'returnUrl': ['http://testserver/protected/']}


def test_redirect_to_login_preserves_scope_when_provided() -> None:
    request = RequestFactory().get('/protected/')

    response = redirect_to_login(request, 'album-A')
    parsed = urlparse(response.url)

    assert response.status_code == 302
    assert parsed.path == '/sso/login/'
    assert parse_qs(parsed.query) == {
        'returnUrl': ['http://testserver/protected/'],
        'scope': ['album-A'],
    }
