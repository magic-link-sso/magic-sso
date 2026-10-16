# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from unittest.mock import Mock, patch

import jwt
import pytest
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.test import Client, RequestFactory, override_settings

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


@pytest.mark.parametrize('flow', ['link', 'otp'])
@pytest.mark.parametrize('public_urls', [[], ['login']])
def test_whole_application_protection_allows_complete_sign_in(
    flow: str, public_urls: list[str]
) -> None:
    middleware = ['magic_sso_django.middleware.MagicSsoMiddleware']
    login_response = Mock(status_code=200)
    login_response.json.return_value = {'otpChallengeId': 'challenge-123', 'otpLength': 6}
    exchange_response = Mock(status_code=200)
    exchange_response.json.return_value = {'accessToken': sign_access_token()}
    preview_response = Mock(status_code=200)
    preview_response.json.return_value = {'email': 'user@example.com'}
    with (
        override_settings(
            MIDDLEWARE=middleware,
            MAGICSSO_AUTH_EVERYWHERE=True,
            MAGICSSO_PUBLIC_URLS=public_urls,
            MAGICSSO_COOKIE_SECURE=False,
        ),
        patch(
            'magic_sso_django.views.requests.post', side_effect=[login_response, exchange_response]
        ),
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
    ):
        client = Client()
        assert client.get('/protected/').status_code == 302
        assert client.get('/sso/login/').status_code == 200
        sent = client.post('/sso/login/', {'email': 'user@example.com', 'returnUrl': '/protected/'})
        assert sent.status_code == 200
        if flow == 'link':
            preview = client.get(
                '/sso/verify-email/', {'token': 'email-token', 'returnUrl': '/protected/'}
            )
            assert preview.status_code == 200
            assert b'user@example.com' in preview.content
            verified = client.post(
                '/sso/verify-email/', {'token': 'email-token', 'returnUrl': '/protected/'}
            )
        else:
            verified = client.post(
                '/sso/verify-email/otp/',
                {'challengeId': 'challenge-123', 'code': '123456', 'returnUrl': '/protected/'},
            )
        assert verified.status_code == 302
        assert verified['Location'] == '/protected/'
        assert settings.MAGICSSO_COOKIE_NAME in verified.cookies
        assert client.get('/protected/').status_code == 200


def test_callback_names_in_other_apps_remain_protected() -> None:
    with override_settings(MAGICSSO_AUTH_EVERYWHERE=True):
        request = RequestFactory().get('/other/verify-email/')
        assert MagicSsoMiddleware(ok_response)(request).status_code == 302
