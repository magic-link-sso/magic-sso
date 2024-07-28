# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

import logging
from urllib.parse import parse_qs, urlparse
import requests
from typing import Any
from unittest.mock import Mock, patch

import jwt
import pytest
from django.conf import settings
from django.test import Client, override_settings


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


def test_login_get_redirects_to_server_when_direct_mode_is_enabled() -> None:
    client = Client()

    with override_settings(MAGICSSO_DIRECT_USE=True):
        response = client.get('/sso/login/', {'returnUrl': 'http://client.example.com/protected'})

    assert response.status_code == 302
    parsed_url = urlparse(response.url)
    query = parse_qs(parsed_url.query)
    assert f'{parsed_url.scheme}://{parsed_url.netloc}{parsed_url.path}' == (
        'http://sso.example.com/signin'
    )
    assert query['returnUrl'] == ['http://client.example.com/protected']
    assert query['verifyUrl'] == [
        'http://testserver/sso/verify-email/?returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected'
    ]


def test_login_get_redirects_scope_to_server_when_direct_mode_is_enabled() -> None:
    client = Client()

    with override_settings(MAGICSSO_DIRECT_USE=True):
        response = client.get(
            '/sso/login/',
            {'returnUrl': 'http://client.example.com/protected', 'scope': 'album-A'},
        )

    assert response.status_code == 302
    parsed_url = urlparse(response.url)
    query = parse_qs(parsed_url.query)
    assert f'{parsed_url.scheme}://{parsed_url.netloc}{parsed_url.path}' == (
        'http://sso.example.com/signin'
    )
    assert query['returnUrl'] == ['http://client.example.com/protected']
    assert query['scope'] == ['album-A']
    assert query['verifyUrl'] == [
        'http://testserver/sso/verify-email/?returnUrl=http%3A%2F%2Fclient.example.com%2Fprotected'
    ]


def test_login_post_sends_magic_link_request() -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 200

    with patch('magic_sso_django.views.requests.post', return_value=mock_response) as post_mock:
        response = client.post(
            '/sso/login/',
            {'email': 'user@example.com', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 200
    assert b'Email sent, check your inbox' in response.content
    assert b'role="status"' in response.content
    assert b'user@example.com' not in response.content
    assert b'value="user@example.com"' not in response.content
    post_mock.assert_called_once()

    payload: dict[str, Any] = post_mock.call_args.kwargs['json']
    assert payload['email'] == 'user@example.com'
    assert payload['returnUrl'] == 'http://testserver/protected/'
    assert (
        payload['verifyUrl']
        == 'http://testserver/sso/verify-email/?returnUrl=http%3A%2F%2Ftestserver%2Fprotected%2F'
    )
    assert post_mock.call_args.kwargs['timeout'] == 5


def test_login_post_sends_scope_when_provided() -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 200

    with patch('magic_sso_django.views.requests.post', return_value=mock_response) as post_mock:
        response = client.post(
            '/sso/login/',
            {
                'email': 'user@example.com',
                'returnUrl': 'http://testserver/protected/',
                'scope': 'album-A',
            },
        )

    assert response.status_code == 200
    payload: dict[str, Any] = post_mock.call_args.kwargs['json']
    assert payload['scope'] == 'album-A'


def test_login_post_does_not_log_raw_email_addresses(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 200

    with (
        caplog.at_level(logging.INFO, logger='magic_sso_django.views'),
        patch('magic_sso_django.views.requests.post', return_value=mock_response),
    ):
        response = client.post('/sso/login/', {'email': 'user@example.com'})

    assert response.status_code == 200
    assert 'Sending Magic Link SSO sign-in request' in caplog.text
    assert 'user@example.com' not in caplog.text
    assert all(getattr(record, 'email', None) is None for record in caplog.records)


def test_login_post_renders_error_when_sso_server_call_fails() -> None:
    client = Client()

    with patch(
        'magic_sso_django.views.requests.post',
        side_effect=requests.RequestException('network failure'),
    ):
        response = client.post('/sso/login/', {'email': 'user@example.com'})

    assert response.status_code == 200
    assert b'Failed to send verification email' in response.content
    assert b'role="alert"' in response.content
    assert b'user@example.com' not in response.content
    assert b'value="user@example.com"' not in response.content


def test_login_post_renders_forbidden_without_echoing_submitted_email() -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 403

    with patch('magic_sso_django.views.requests.post', return_value=mock_response):
        response = client.post(
            '/sso/login/',
            {'email': 'user@example.com', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 200
    assert b'Forbidden' in response.content
    assert b'role="alert"' in response.content
    assert b'user@example.com' not in response.content
    assert b'value="user@example.com"' not in response.content
    assert (
        b'<input type="hidden" name="returnUrl" value="http://testserver/protected/" />'
        in response.content
    )


def test_login_get_renders_accessible_form_controls() -> None:
    client = Client()

    response = client.get('/sso/login/', {'returnUrl': 'http://testserver/protected/'})

    assert response.status_code == 200
    assert b'Skip to sign-in form' in response.content
    assert b'<main class="page-shell" id="main-content">' in response.content
    assert b'<label class="field-label" for="email">Email</label>' in response.content
    assert (
        b'<input type="hidden" name="returnUrl" value="http://testserver/protected/" />'
        in response.content
    )
    assert b'id="submit-spinner"' in response.content
    assert b'margin-right 150ms ease' in response.content
    assert b'aria-describedby="signin-help"' in response.content
    assert b'@media (prefers-color-scheme: dark)' in response.content
    assert b'linear-gradient(180deg, #020617 0%, #0f172a 100%)' in response.content


def test_login_get_preserves_scope_in_hidden_field() -> None:
    client = Client()

    response = client.get(
        '/sso/login/',
        {'returnUrl': 'http://testserver/protected/', 'scope': 'album-A'},
    )

    assert response.status_code == 200
    assert b'<input type="hidden" name="scope" value="album-A" />' in response.content


def test_verify_token_renders_a_confirmation_page_on_get() -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {'email': 'user@example.com'}

    with patch('magic_sso_django.views.requests.get', return_value=mock_response) as get_mock:
        response = client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 200
    assert b'Continue sign-in' in response.content
    assert b'user@example.com' in response.content
    assert b'name="token" value="email-token"' in response.content
    assert b'@media (prefers-color-scheme: dark)' in response.content
    assert get_mock.call_args.kwargs['headers'] == {
        'x-magic-sso-preview-secret': 'preview-secret-for-tests-only-32'
    }


def test_verify_token_post_sets_cookie_and_redirects_on_success() -> None:
    client = Client()
    preview_response = Mock()
    preview_response.status_code = 200
    preview_response.json.return_value = {'email': 'user@example.com'}
    verify_response = Mock()
    verify_response.status_code = 200
    verify_response.json.return_value = {'accessToken': sign_access_token()}

    with (
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
        patch('magic_sso_django.views.requests.post', return_value=verify_response) as post_mock,
    ):
        client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 302
    assert response.url == 'http://testserver/protected/'
    assert response.cookies['magic-sso'].value == verify_response.json.return_value['accessToken']
    assert post_mock.call_args.kwargs['json'] == {'token': 'email-token'}
    assert post_mock.call_args.kwargs['timeout'] == 5
    assert response.cookies['magic-sso']['httponly'] is True
    assert response.cookies['magic-sso']['path'] == '/'
    assert response.cookies['magic-sso']['samesite'] == 'Lax'
    assert response.cookies['magic-sso']['secure'] is True
    assert response.cookies['magic-sso']['max-age'] == ''


def test_verify_token_respects_cookie_domain_and_samesite_setting_overrides() -> None:
    client = Client()
    preview_response = Mock()
    preview_response.status_code = 200
    preview_response.json.return_value = {'email': 'user@example.com'}
    verify_response = Mock()
    verify_response.status_code = 200
    verify_response.json.return_value = {'accessToken': sign_access_token()}

    with (
        override_settings(MAGICSSO_COOKIE_DOMAIN='.example.com', MAGICSSO_COOKIE_SAMESITE='Strict'),
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
        patch('magic_sso_django.views.requests.post', return_value=verify_response),
    ):
        client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 302
    assert response.cookies['magic-sso']['domain'] == '.example.com'
    assert response.cookies['magic-sso']['samesite'] == 'Strict'


def test_verify_token_respects_cookie_path_setting_override() -> None:
    client = Client()
    preview_response = Mock()
    preview_response.status_code = 200
    preview_response.json.return_value = {'email': 'user@example.com'}
    verify_response = Mock()
    verify_response.status_code = 200
    verify_response.json.return_value = {'accessToken': sign_access_token()}

    with (
        override_settings(MAGICSSO_COOKIE_PATH='/auth'),
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
        patch('magic_sso_django.views.requests.post', return_value=verify_response),
    ):
        client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 302
    assert response.cookies['magic-sso']['path'] == '/auth'


def test_verify_token_respects_cookie_secure_setting_override() -> None:
    client = Client()
    preview_response = Mock()
    preview_response.status_code = 200
    preview_response.json.return_value = {'email': 'user@example.com'}
    verify_response = Mock()
    verify_response.status_code = 200
    verify_response.json.return_value = {'accessToken': sign_access_token()}

    with (
        override_settings(MAGICSSO_COOKIE_SECURE=False),
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
        patch('magic_sso_django.views.requests.post', return_value=verify_response),
    ):
        client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 302
    assert response.cookies['magic-sso']['secure'] == ''


def test_verify_token_sets_cookie_max_age_when_configured() -> None:
    client = Client()
    preview_response = Mock()
    preview_response.status_code = 200
    preview_response.json.return_value = {'email': 'user@example.com'}
    verify_response = Mock()
    verify_response.status_code = 200
    verify_response.json.return_value = {'accessToken': sign_access_token()}

    with (
        override_settings(MAGICSSO_COOKIE_MAX_AGE=3600),
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
        patch('magic_sso_django.views.requests.post', return_value=verify_response),
    ):
        client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 302
    assert response.cookies['magic-sso']['max-age'] == 3600


def test_logout_deletes_cookie_with_matching_domain_and_samesite_options() -> None:
    client = Client()

    with override_settings(MAGICSSO_COOKIE_DOMAIN='.example.com', MAGICSSO_COOKIE_SAMESITE='None'):
        response = client.post('/sso/logout/')

    assert response.status_code == 302
    assert response.url == '/'
    assert response.cookies['magic-sso'].value == ''
    assert response.cookies['magic-sso']['domain'] == '.example.com'
    assert response.cookies['magic-sso']['path'] == '/'
    assert response.cookies['magic-sso']['samesite'] == 'None'


def test_logout_deletes_cookie_with_matching_path_option() -> None:
    client = Client()

    with override_settings(MAGICSSO_COOKIE_PATH='/auth'):
        response = client.post('/sso/logout/')

    assert response.status_code == 302
    assert response.cookies['magic-sso']['path'] == '/auth'


def test_logout_rejects_get_requests() -> None:
    client = Client()

    response = client.get('/sso/logout/')

    assert response.status_code == 405


def test_logout_rejects_post_without_csrf_token_when_csrf_checks_are_enabled() -> None:
    client = Client(enforce_csrf_checks=True)

    with override_settings(MIDDLEWARE=['django.middleware.csrf.CsrfViewMiddleware']):
        response = client.post('/sso/logout/')

    assert response.status_code == 403


def test_login_post_rejects_missing_csrf_token_without_global_middleware() -> None:
    client = Client(enforce_csrf_checks=True)

    with override_settings(MIDDLEWARE=[]):
        response = client.post('/sso/login/', {'email': 'user@example.com'})

    assert response.status_code == 403


def test_verify_token_post_rejects_missing_csrf_token_without_global_middleware() -> None:
    client = Client(enforce_csrf_checks=True)

    with override_settings(MIDDLEWARE=[]):
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 403


def test_verify_token_renders_error_when_server_rejects_token() -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 400

    with patch('magic_sso_django.views.requests.get', return_value=mock_response):
        response = client.get(
            '/sso/verify-email/',
            {'token': 'bad-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 200
    assert b'Invalid or expired token' in response.content
    assert (
        b'<input type="hidden" name="returnUrl" value="http://testserver/protected/" />'
        in response.content
    )


def test_verify_token_rejects_missing_token_without_outbound_request() -> None:
    client = Client()

    with patch('magic_sso_django.views.requests.get') as get_mock:
        response = client.get('/sso/verify-email/', {'returnUrl': 'http://testserver/protected/'})

    assert response.status_code == 200
    assert b'Invalid or expired token' in response.content
    get_mock.assert_not_called()


def test_verify_token_uses_timeout_when_contacting_sso_server() -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 400

    with patch('magic_sso_django.views.requests.get', return_value=mock_response) as get_mock:
        response = client.get(
            '/sso/verify-email/',
            {'token': 'bad-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 200
    assert get_mock.call_args.kwargs['timeout'] == 5


def test_login_post_rejects_external_return_url() -> None:
    client = Client()
    mock_response = Mock()
    mock_response.status_code = 200

    with patch('magic_sso_django.views.requests.post', return_value=mock_response) as post_mock:
        client.post('/sso/login/', {'email': 'user@example.com', 'returnUrl': 'https://evil.test/'})

    payload: dict[str, Any] = post_mock.call_args.kwargs['json']
    assert payload['returnUrl'] == 'http://testserver/'


def test_verify_token_falls_back_to_home_for_external_return_url() -> None:
    client = Client()
    preview_response = Mock()
    preview_response.status_code = 200
    preview_response.json.return_value = {'email': 'user@example.com'}
    verify_response = Mock()
    verify_response.status_code = 200
    verify_response.json.return_value = {'accessToken': sign_access_token()}

    with (
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
        patch('magic_sso_django.views.requests.post', return_value=verify_response),
    ):
        client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'https://evil.test/'},
        )
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'https://evil.test/'},
        )

    assert response.status_code == 302
    assert response.url == 'http://testserver/'


def test_verify_token_rejects_returned_access_tokens_bound_to_a_different_origin() -> None:
    client = Client()
    preview_response = Mock()
    preview_response.status_code = 200
    preview_response.json.return_value = {'email': 'user@example.com'}
    verify_response = Mock()
    verify_response.status_code = 200
    verify_response.json.return_value = {
        'accessToken': sign_access_token(audience='http://admin.example.com')
    }

    with (
        patch('magic_sso_django.views.requests.get', return_value=preview_response),
        patch('magic_sso_django.views.requests.post', return_value=verify_response),
    ):
        client.get(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )
        response = client.post(
            '/sso/verify-email/',
            {'token': 'email-token', 'returnUrl': 'http://testserver/protected/'},
        )

    assert response.status_code == 200
    assert b'Invalid or expired token' in response.content
