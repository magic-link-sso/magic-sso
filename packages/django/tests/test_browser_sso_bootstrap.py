# SPDX-License-Identifier: MIT
import json
import time
from collections.abc import Iterator
from urllib.parse import parse_qs, urlencode, urlsplit

import jwt
import pytest
import requests
from django.http import HttpResponse
from django.test import RequestFactory, override_settings
from pytest import MonkeyPatch

from magic_sso_django import browser_sso as sso
from magic_sso_django import browser_sso_bootstrap as bootstrap

APP = 'https://app.example.com'
ISSUER = 'https://sso.example.com'
SECRET = 'synthetic-django-bootstrap-secret-0123456789'
RF = RequestFactory()


@pytest.fixture(autouse=True)
def configuration() -> Iterator[None]:
    with override_settings(
        MAGICSSO_BROWSER_SSO_MODE='required',
        MAGICSSO_BROWSER_SSO_LOGIN_UI='app-owned',
        MAGICSSO_PUBLIC_ORIGIN=APP,
        MAGICSSO_SERVER_URL=ISSUER,
        MAGICSSO_JWT_SECRET=SECRET,
        MAGICSSO_COOKIE_PATH='/',
        MAGICSSO_COOKIE_NAME='app-session',
        MAGICSSO_PREVIEW_SECRET='synthetic-preview-secret',
    ):
        sso.cached_client.cache_clear()
        yield
        sso.cached_client.cache_clear()


def response(value: object) -> requests.Response:
    result = requests.Response()
    result.status_code = 200
    result._content = json.dumps(value).encode()
    return result


def capability(extension: object = 1) -> dict[str, object]:
    return {
        'browserSso': {
            'version': 1,
            'enabled': True,
            'loginUi': 'hosted',
            'codeChallengeMethods': ['S256'],
            'requestLifetimeSeconds': 900,
            'codeLifetimeSeconds': 60,
            'transactionLifetimeSeconds': 990,
            'appOwnedBootstrapVersion': extension,
        }
    }


def access_token() -> str:
    now = int(time.time())
    return jwt.encode(
        {
            'email': 'owner@example.com',
            'scope': '*',
            'siteId': 'app',
            'iss': ISSUER,
            'aud': APP,
            'iat': now,
            'exp': now + 600,
            'jti': 'synthetic-local-session',
        },
        SECRET,
        algorithm='HS256',
    )


class Browser:
    cookies: dict[str, str]

    def __init__(self) -> None:
        self.cookies = {}

    def call(
        self, path: str, form: dict[str, str] | None = None, source: str = 'null'
    ) -> HttpResponse:
        cookie = '; '.join(f'{key}={value}' for key, value in self.cookies.items())
        request = (
            RF.get(path, HTTP_COOKIE=cookie)
            if form is None
            else RF.post(
                path,
                data=urlencode(form),
                content_type='application/x-www-form-urlencoded',
                HTTP_COOKIE=cookie,
                HTTP_ORIGIN=source,
            )
        )
        result = (
            sso.callback(request)
            if urlsplit(path).path.endswith('/callback/')
            else sso.start(request)
        )
        for name, value in result.cookies.items():
            if value['max-age'] == 0 or not value.value:
                self.cookies.pop(name, None)
            else:
                self.cookies[name] = value.value
        return result


def test_capability_is_checked_before_state_and_hosted_recovery_is_explicit(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(sso.requests, 'get', lambda *args, **kwargs: response(capability(2)))
    browser = Browser()
    assert browser.call('/sso/start/').status_code == 400
    assert not browser.cookies
    with override_settings(MAGICSSO_BROWSER_SSO_MODE='auto'):
        assert browser.call('/sso/start/').status_code == 302
        assert not browser.cookies
    result = browser.call('/sso/start/?loginUi=hosted')
    assert result.status_code == 303
    assert 'loginUi=' not in result['Location']


@pytest.mark.parametrize('method', ['link', 'otp'])
def test_local_forms_recover_backend_context_and_preserve_the_local_session(
    monkeypatch: MonkeyPatch, method: str
) -> None:
    monkeypatch.setattr(sso.requests, 'get', lambda *args, **kwargs: response(capability()))
    browser = Browser()
    started = browser.call('/sso/start/?returnUrl=%2Fprotected%3Ftag%3Da%26tag%3Db')
    params = parse_qs(urlsplit(started['Location']).query)
    assert params['loginUi'] == ['app-owned']
    state = params['state'][0]
    calls: list[tuple[str, object]] = []
    token = access_token()

    def request(method: str, url: str, **kwargs: object) -> requests.Response:
        body = json.loads(str(kwargs['data'])) if kwargs.get('data') is not None else None
        calls.append((urlsplit(url).path, body))
        if url.endswith('/sso/bootstrap/inspect'):
            return response(
                {
                    'requestId': 'R' * 43,
                    'state': state,
                    'scope': '*',
                    'expiresAt': int(time.time() * 1000) + 900_000,
                }
            )
        if url.endswith('/signin'):
            return response({'otpChallengeId': 'synthetic-challenge'})
        if method == 'GET':
            return response({'email': 'owner@example.com'})
        return response({'accessToken': token, 'browserSso': {'bootstrapTicket': 'T' * 43}})

    monkeypatch.setattr(bootstrap.requests, 'request', request)
    prepared = browser.call(
        '/sso/start/?' + urlencode({'ssoPrepared': '1', 'state': state, 'requestId': 'R' * 43})
    )
    assert b'Send magic link' in prepared.content
    before = len(calls)
    assert (
        browser.call(
            '/sso/start/', {'action': 'send', 'state': state}, 'https://attacker.example'
        ).status_code
        == 400
    )
    assert len(calls) == before
    sent = browser.call(
        '/sso/start/',
        {
            'action': 'send',
            'state': state,
            'email': 'owner@example.com',
            'scope': '*',
            'returnUrl': '/protected?tag=a&tag=b',
        },
    )
    assert b'Check your email' in sent.content
    if method == 'otp':
        verified = browser.call(
            '/sso/start/',
            {
                'action': 'otp',
                'state': state,
                'challengeId': 'synthetic-challenge',
                'code': '123456',
            },
        )
    else:
        confirm = browser.call(
            '/sso/start/?' + urlencode({'action': 'verify', 'state': state, 'token': 'email-proof'})
        )
        assert b'owner@example.com' in confirm.content
        csrf = browser.cookies['__Host-magic-sso-confirm-' + state]
        verified = browser.call(
            '/sso/start/',
            {'action': 'verify', 'state': state, 'token': 'email-proof', 'csrfToken': csrf},
        )
    assert verified.status_code == 303
    assert verified['Location'].startswith(ISSUER + '/sso/bootstrap/redeem?')
    assert browser.cookies['app-session'] == token
    assert browser.cookies['__Host-magic-sso-continuation-' + state]
    browser.cookies.pop('app-session')
    failed_finish = browser.call(
        '/sso/callback/?'
        + urlencode({'state': state, 'browserSso': 'complete', 'receipt': 'Z' * 43})
    )
    assert b'Shared sign-in was not completed' in failed_finish.content
    assert 'app-session' not in failed_finish.cookies
    assert not browser.cookies
    assert not any(path == '/sso/exchange' for path, _body in calls)


def test_rejects_unsafe_cookie_path_before_creating_state() -> None:
    with override_settings(MAGICSSO_COOKIE_PATH='/private'):
        assert Browser().call('/sso/start/').status_code == 400


@pytest.mark.parametrize('extension', [0, True, '1'])
def test_rejects_malformed_bootstrap_capability_without_cookies(
    monkeypatch: MonkeyPatch, extension: object
) -> None:
    monkeypatch.setattr(
        sso.requests, 'get', lambda *args, **kwargs: response(capability(extension))
    )
    browser = Browser()
    assert browser.call('/sso/start/').status_code == 400
    assert not browser.cookies


def test_explicit_confirmation_in_another_browser_establishes_only_a_local_session(
    monkeypatch: MonkeyPatch,
) -> None:
    browser = Browser()
    state, token = 'S' * 43, access_token()
    bodies: list[object] = []

    def request(method: str, url: str, **kwargs: object) -> requests.Response:
        if method == 'GET':
            return response({'email': 'owner@example.com'})
        bodies.append(json.loads(str(kwargs['data'])))
        return response({'accessToken': token})

    monkeypatch.setattr(bootstrap.requests, 'request', request)
    confirm = browser.call(
        '/sso/start/?' + urlencode({'action': 'verify', 'state': state, 'token': 'email-proof'})
    )
    assert b'owner@example.com' in confirm.content
    csrf = browser.cookies['__Host-magic-sso-confirm-' + state]
    verified = browser.call(
        '/sso/start/',
        {'action': 'verify', 'state': state, 'token': 'email-proof', 'csrfToken': csrf},
    )
    assert b'Shared sign-in was not completed' in verified.content
    assert browser.cookies['app-session'] == token
    assert bodies == [{'token': 'email-proof'}]
