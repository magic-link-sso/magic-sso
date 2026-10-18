# SPDX-License-Identifier: MIT
import json
import time
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import jwt
import pytest
import requests
from django.http import HttpResponse
from django.test import RequestFactory, override_settings
from pytest import MonkeyPatch

from magic_sso_django import browser_sso as sso

FIXTURE = json.loads(
    (Path(__file__).parents[2] / 'core/test/fixtures/browser-sso-v1.json').read_text()
)
ISSUER = 'https://sso.example.com'
APP = 'https://app.example.com'
SECRET = 'test-browser-sso-django-secret-0123456789'
RF = RequestFactory()


@pytest.fixture(autouse=True)
def configuration() -> Iterator[None]:
    with override_settings(
        MAGICSSO_BROWSER_SSO_MODE='required',
        MAGICSSO_PUBLIC_ORIGIN=APP,
        MAGICSSO_SERVER_URL=ISSUER,
        MAGICSSO_JWT_SECRET=SECRET,
    ):
        sso.cached_client.cache_clear()
        yield
        sso.cached_client.cache_clear()


def http_response(document: object, status: int = 200) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(document).encode()
    return response


def request(path: str, cookie: str = '', **headers: str) -> HttpResponse:
    # Every request uses the normal middleware-independent, mounted Django views.
    req = RF.get(path, HTTP_COOKIE=cookie, **headers)
    return sso.callback(req) if path.startswith('/sso/callback/') else sso.start(req)


def pending(monkeypatch: MonkeyPatch) -> tuple[str, str, str]:
    monkeypatch.setattr(
        sso.requests, 'get', lambda *args, **kwargs: http_response(FIXTURE['enabled'])
    )
    response = request('/sso/start/?' + urlencode({'returnUrl': '/private?x=a%2Bb&tag=1&tag=2'}))
    assert response.status_code == 303
    state = parse_qs(urlsplit(response['Location']).query)['state'][0]
    name = '__Host-magic-sso-tx-' + state
    cookie = name + '=' + response.cookies[name].value
    return state, name, cookie


def token() -> str:
    now = int(time.time())
    return jwt.encode(
        {
            'email': 'owner@example.com',
            'scope': '*',
            'siteId': 'app',
            'iss': ISSUER,
            'aud': APP,
            'iat': now,
            'exp': now + 90,
            'jti': 'test',
        },
        SECRET,
        algorithm='HS256',
    )


def test_cross_language_fixture_and_exact_encryption(monkeypatch: MonkeyPatch) -> None:
    fixture = FIXTURE['transaction']
    payload = sso.parse_transaction(fixture['payload'])
    assert payload is not None
    monkeypatch.setattr(sso.secrets, 'token_bytes', lambda count: bytes([3]) * count)
    assert sso.seal(fixture['keyMaterial'], fixture['cookieName'], payload) == fixture['sealed']
    assert (
        sso.unseal(
            fixture['keyMaterial'],
            fixture['cookieName'],
            fixture['sealed'],
            payload.issuer,
            payload.audience,
            payload.redirectUri,
            payload.state,
            payload.createdAt,
        )
        == payload
    )
    assert (
        sso.unseal(
            SECRET,
            fixture['cookieName'],
            fixture['sealed'],
            payload.issuer,
            payload.audience,
            payload.redirectUri,
            payload.state,
            payload.createdAt,
        )
        is None
    )
    assert (
        sso.unseal(
            fixture['keyMaterial'],
            fixture['cookieName'] + 'x',
            fixture['sealed'],
            payload.issuer,
            payload.audience,
            payload.redirectUri,
            payload.state,
            payload.createdAt,
        )
        is None
    )
    assert sso.parse_transaction({**fixture['payload'], 'createdAt': True}) is None
    assert sso.parse_transaction({**fixture['payload'], 'unexpected': 1}) is None


def test_browser_session_is_set_only_after_matching_transaction(monkeypatch: MonkeyPatch) -> None:
    state, name, cookie = pending(monkeypatch)
    calls: list[dict[str, object]] = []

    def exchange(url: str, **kwargs: object) -> requests.Response:
        assert url == ISSUER + '/sso/exchange'
        assert kwargs['allow_redirects'] is False
        calls.append(kwargs)
        return http_response({'accessToken': token()})

    monkeypatch.setattr(sso.requests, 'post', exchange)
    response = request(f'/sso/callback/?state={state}&code={sso.secrets.token_urlsafe(32)}', cookie)
    assert response.status_code == 303
    assert response['Location'] == APP + '/private?x=a%2Bb&tag=1&tag=2'
    assert response.cookies[name]['max-age'] == 0
    app_cookie = response.cookies['magic-sso']
    assert app_cookie['httponly'] and app_cookie['secure']
    assert app_cookie['samesite'] == 'Lax' and not app_cookie['domain']
    assert 0 < app_cookie['max-age'] <= 90
    assert response['Cache-Control'] == 'no-store'
    assert len(calls) == 1


@pytest.mark.parametrize('kind', ['missing', 'duplicate', 'tampered', 'wrong-state', 'wrong-app'])
def test_invalid_transaction_never_exchanges_or_clears_other_cookies(
    monkeypatch: MonkeyPatch, kind: str
) -> None:
    state, _name, cookie = pending(monkeypatch)
    if kind == 'missing':
        cookie = ''
    elif kind == 'duplicate':
        cookie += ';' + cookie
    elif kind == 'tampered':
        cookie = cookie[:-8] + 'AAAAAAAA'
    elif kind == 'wrong-state':
        state = sso.secrets.token_urlsafe(32)
    elif kind == 'wrong-app':
        cookie = cookie.replace('__Host-magic-sso-tx-', 'magic-sso-tx-')

    def exchange(*args: object, **kwargs: object) -> requests.Response:
        pytest.fail('Invalid transaction reached the issuer')

    monkeypatch.setattr(sso.requests, 'post', exchange)
    response = request(f'/sso/callback/?state={state}&code={sso.secrets.token_urlsafe(32)}', cookie)
    assert response.status_code == 400
    assert not response.cookies


@pytest.mark.parametrize('outcome', ['timeout', 'redirect', 'invalid-jwt', 'denied', 'expired'])
def test_terminal_failure_clears_only_matching_transaction(
    monkeypatch: MonkeyPatch, outcome: str
) -> None:
    state, name, cookie = pending(monkeypatch)
    calls = 0

    def exchange(*args: object, **kwargs: object) -> requests.Response:
        nonlocal calls
        calls += 1
        if outcome == 'timeout':
            raise requests.Timeout()
        if outcome == 'redirect':
            return http_response({}, 303)
        return http_response({'accessToken': 'bad-token'})

    monkeypatch.setattr(sso.requests, 'post', exchange)
    error = '&error=access_denied' if outcome == 'denied' else ''
    if outcome == 'expired':
        original = sso.BrowserSsoClient.open

        def expired(
            self: sso.BrowserSsoClient, key: str, value: str, now: int
        ) -> sso.Transaction | None:
            payload = original(self, key, value, now)
            return replace(payload, expiresAt=now - 1) if payload else None

        monkeypatch.setattr(sso.BrowserSsoClient, 'open', expired)
    response = request(
        f'/sso/callback/?state={state}&code={sso.secrets.token_urlsafe(32)}{error}',
        cookie + ';magic-sso=old-session',
    )
    assert response.status_code == 400
    assert list(response.cookies) == [name]
    assert response.cookies[name]['max-age'] == 0
    assert calls == (0 if outcome in ('expired', 'denied') else 1)


@pytest.mark.parametrize('mode', ['auto', 'required'])
@pytest.mark.parametrize(
    'document,status',
    [
        (None, 404),
        ({'browserSso': {'version': 1, 'enabled': False}}, 200),
        ({'browserSso': {'version': 2, 'enabled': True}}, 200),
        ({}, 200),
        (None, 500),
        (None, 302),
    ],
)
def test_discovery_fallback_is_narrow(
    monkeypatch: MonkeyPatch, mode: str, document: object, status: int
) -> None:
    monkeypatch.setattr(
        sso.requests, 'get', lambda *args, **kwargs: http_response(document, status)
    )
    with override_settings(MAGICSSO_BROWSER_SSO_MODE=mode):
        response = request('/sso/start/?returnUrl=%2Fprivate')
    fallback = mode == 'auto' and (
        status == 404 or isinstance(document, dict) and 'browserSso' in document
    )
    assert (response.status_code == 302) == fallback
    assert not response.cookies
    if fallback:
        assert response['Location'].startswith('/sso/login/?')


def test_three_tabs_are_independent_and_fourth_is_bounded(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(
        sso.requests, 'get', lambda *args, **kwargs: http_response(FIXTURE['enabled'])
    )
    cookies: list[str] = []
    for _ in range(3):
        response = request('/sso/start/', ';'.join(cookies))
        assert response.status_code == 303
        cookie = next(iter(response.cookies.values()))
        cookies.append(cookie.key + '=' + cookie.value)
    response = request('/sso/start/', ';'.join(cookies))
    assert response.status_code == 400 and not response.cookies
    assert b'another tab' in response.content


def test_prefetch_and_disabled_callback_leave_sessions_untouched(monkeypatch: MonkeyPatch) -> None:
    def discovery(*args: object, **kwargs: object) -> requests.Response:
        pytest.fail('Prefetch reached discovery')

    monkeypatch.setattr(sso.requests, 'get', discovery)
    assert request('/sso/start/', HTTP_SEC_FETCH_MODE='cors').status_code == 200
    assert request('/sso/start/', HTTP_SEC_FETCH_DEST='iframe').status_code == 200
    with override_settings(MAGICSSO_BROWSER_SSO_MODE='off'):
        result = request('/sso/callback/?state=bad', 'magic-sso=old')
        assert result.status_code == 400 and not result.cookies


def test_unsafe_configuration_and_return_targets() -> None:
    with pytest.raises(ValueError):
        sso.BrowserSsoClient(
            'http://sso.example.com', APP, APP + '/sso/callback/', SECRET, 'required', False, 5000
        )
    with (
        override_settings(MAGICSSO_COOKIE_NAME='__Host-magic-sso-browser'),
        pytest.raises(ValueError),
    ):
        sso.client_for(RF.get('/'))
    assert sso.same_origin_url('//evil.test/path', APP) == APP + '/'
    assert sso.same_origin_url('/private?x=1&x=2', APP) == APP + '/private?x=1&x=2'


def test_default_status_page_escapes_content_and_forbids_scripts() -> None:
    response = sso.response_page(
        '<script>alert(1)</script>', 'message', '/safe?x="quoted"', 'Continue'
    )
    assert b'<script>' not in response.content
    assert b'&lt;script&gt;' in response.content
    assert b'&quot;quoted&quot;' in response.content
    assert "script-src 'none'" in response['Content-Security-Policy']
    assert response['X-Frame-Options'] == 'DENY'
