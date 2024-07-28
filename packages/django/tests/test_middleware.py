# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

import jwt
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.test import RequestFactory, override_settings

from magic_sso_django.middleware import MagicSsoMiddleware, get_public_url_names


def ok_response(_request: HttpRequest) -> HttpResponse:
    return HttpResponse('ok')


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


def test_middleware_bypasses_login_route() -> None:
    middleware = MagicSsoMiddleware(ok_response)
    request = RequestFactory().get('/sso/login/')

    response = middleware(request)

    assert response.status_code == 200
    assert request.is_magic_sso_authenticated is False
    assert request.magic_sso_user_email is None
    assert request.magic_sso_user_scope is None


def test_get_public_url_names_defaults_to_login() -> None:
    assert get_public_url_names() == {'login'}


def test_middleware_bypasses_configured_public_routes() -> None:
    middleware = MagicSsoMiddleware(ok_response)
    request = RequestFactory().get('/protected/')

    with override_settings(
        MAGICSSO_AUTH_EVERYWHERE=True, MAGICSSO_PUBLIC_URLS=['login', 'protected']
    ):
        response = middleware(request)

    assert response.status_code == 200
    assert request.is_magic_sso_authenticated is False
    assert request.magic_sso_user_email is None
    assert request.magic_sso_user_scope is None


def test_middleware_redirects_unauthenticated_requests_when_enabled() -> None:
    middleware = MagicSsoMiddleware(ok_response)
    request = RequestFactory().get('/protected/')

    with override_settings(MAGICSSO_AUTH_EVERYWHERE=True):
        response = middleware(request)

    assert response.status_code == 302
    assert response['Location'].startswith('/sso/login/?returnUrl=')


def test_middleware_sets_authentication_flags_for_valid_cookie() -> None:
    middleware = MagicSsoMiddleware(ok_response)
    request = RequestFactory().get('/protected/')
    request.COOKIES[settings.MAGICSSO_COOKIE_NAME] = sign_access_token()

    response = middleware(request)

    assert response.status_code == 200
    assert request.is_magic_sso_authenticated is True
    assert request.magic_sso_user_email == 'user@example.com'
    assert request.magic_sso_user_scope == 'album-A'
