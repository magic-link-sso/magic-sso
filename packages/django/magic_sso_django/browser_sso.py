# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak
"""Portable v1 PKCE client; the wire envelope is shared with the TypeScript SDKs."""

import base64
import hashlib
import json
import re
import secrets
import time
from dataclasses import asdict, dataclass
from functools import lru_cache
from urllib.parse import unquote, urlencode, urljoin, urlsplit

import requests
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.http import HttpRequest, HttpResponse, HttpResponseNotAllowed, HttpResponseRedirect
from django.urls import reverse
from django.utils.html import escape
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from .auth_utils import get_configured_public_origin, get_expected_issuer, verify_access_token

OPAQUE = re.compile(r'[A-Za-z0-9_-]{43}\Z')
VERIFIER = re.compile(r'[A-Za-z0-9._~-]{43,128}\Z')


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode('ascii').rstrip('=')


def decode(value: str) -> bytes:
    if not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('Invalid envelope')
    result = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    if encode(result) != value:
        raise ValueError('Noncanonical envelope')
    return result


def origin(value: str) -> str:
    url = urlsplit(value)
    return f'{url.scheme}://{url.netloc}'


def same_origin_url(value: str, audience: str) -> str:
    if '\\' in value or any(ord(c) < 32 for c in value):
        return audience + '/'
    result = urljoin(audience + '/', value)
    url = urlsplit(result)
    return result if origin(result) == audience and not url.username else audience + '/'


@dataclass(frozen=True)
class Transaction:
    v: int
    state: str
    codeVerifier: str
    returnUrl: str
    issuer: str
    audience: str
    redirectUri: str
    createdAt: int
    expiresAt: int
    restarts: int


def parse_transaction(value: object) -> Transaction | None:
    if not isinstance(value, dict) or set(value) != set(Transaction.__annotations__):
        return None
    strings = ['state', 'codeVerifier', 'returnUrl', 'issuer', 'audience', 'redirectUri']
    numbers = ['v', 'createdAt', 'expiresAt', 'restarts']
    if any(not isinstance(value[key], str) for key in strings) or any(
        type(value[key]) is not int for key in numbers
    ):
        return None
    result = Transaction(**value)
    if (
        result.v != 1
        or not OPAQUE.fullmatch(result.state)
        or not VERIFIER.fullmatch(result.codeVerifier)
        or len(result.returnUrl.encode()) > 512
        or result.createdAt < 0
        or not result.createdAt < result.expiresAt <= result.createdAt + 1_950_000
        or result.expiresAt > 2**53 - 1
        or result.restarts not in (0, 1)
        or urlsplit(result.audience).scheme not in {'http', 'https'}
        or urlsplit(result.issuer).scheme not in {'http', 'https'}
        or origin(result.audience) != result.audience
        or origin(result.issuer) != result.issuer
        or urlsplit(result.audience).hostname == urlsplit(result.issuer).hostname
        or same_origin_url(result.returnUrl, result.audience) != result.returnUrl
        or origin(result.redirectUri) != result.audience
        or urlsplit(result.redirectUri).query
        or urlsplit(result.redirectUri).fragment
        or urlsplit(result.redirectUri).username
    ):
        return None
    return result


def transaction_key(secret: str, issuer: str, audience: str) -> bytes:
    if len(secret) < 32:
        raise ValueError('Browser SSO requires a JWT secret of at least 32 characters')
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=issuer.encode(),
        info=f'magic-link-sso/browser-sso/v1/transaction\n{audience}'.encode(),
    ).derive(secret.encode())


def seal(secret: str, name: str, payload: Transaction) -> str:
    if parse_transaction(asdict(payload)) is None:
        raise ValueError('Invalid transaction')
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(transaction_key(secret, payload.issuer, payload.audience)).encrypt(
        nonce,
        json.dumps(asdict(payload), separators=(',', ':')).encode(),
        name.encode(),
    )
    result = 'v1.' + encode(nonce + ciphertext)
    if len(result) > 1536:
        raise ValueError('Transaction too large')
    return result


def unseal(
    secret: str,
    name: str,
    value: str,
    issuer: str,
    audience: str,
    redirect_uri: str,
    state: str,
    now: int,
) -> Transaction | None:
    try:
        if not value.startswith('v1.') or len(value) > 1536:
            return None
        blob = decode(value[3:])
        plaintext = AESGCM(transaction_key(secret, issuer, audience)).decrypt(
            blob[:12],
            blob[12:],
            name.encode(),
        )
        document: object = json.loads(plaintext)
        payload = parse_transaction(document)
        if (
            payload is None
            or (payload.issuer, payload.audience, payload.redirectUri, payload.state)
            != (issuer, audience, redirect_uri, state)
            or payload.createdAt > now + 30_000
        ):
            return None
        return payload
    except (ValueError, TypeError, InvalidTag, UnicodeError):
        return None


def read_cookies(request: HttpRequest) -> list[tuple[str, str]]:
    # Django's cookie mapping hides duplicate names, which callbacks must reject.
    return [
        (name.strip(), unquote(value.strip()))
        for item in request.headers.get('Cookie', '').split(';')
        if '=' in item
        for name, value in [item.split('=', 1)]
    ]


def get_mode() -> str:
    mode = getattr(settings, 'MAGICSSO_BROWSER_SSO_MODE', 'off')
    if mode not in ('off', 'auto', 'required'):
        raise ValueError('Browser SSO mode must be off, auto, or required')
    return mode


def get_login_ui() -> str:
    value = getattr(settings, 'MAGICSSO_BROWSER_SSO_LOGIN_UI', 'hosted')
    if value not in ('hosted', 'app-owned'):
        raise ValueError('Browser SSO login UI must be hosted or app-owned')
    return value


@dataclass
class BrowserSsoClient:
    issuer: str
    audience: str
    redirect_uri: str
    secret: str
    mode: str
    allow_local: bool
    timeout_ms: int
    login_ui: str = 'hosted'
    cached_ui: str | None = None
    cached_lifetime: int | None = None
    cache_until: float = 0

    def __post_init__(self) -> None:
        if self.login_ui not in ('hosted', 'app-owned'):
            raise ValueError('Invalid browser SSO login UI')
        for value in (self.issuer, self.audience, self.redirect_uri):
            url = urlsplit(value)
            local = url.hostname in ('localhost', '127.0.0.1', '::1') or (
                url.hostname is not None and url.hostname.endswith('.localhost')
            )
            if (
                url.username
                or url.password
                or url.query
                or url.fragment
                or (url.hostname or '').endswith('.')
                or not (
                    url.scheme == 'https' or (url.scheme == 'http' and local and self.allow_local)
                )
            ):
                raise ValueError('Browser SSO requires exact HTTPS URLs')
        if (
            origin(self.issuer) != self.issuer
            or origin(self.audience) != self.audience
            or origin(self.redirect_uri) != self.audience
            or urlsplit(self.issuer).hostname == urlsplit(self.audience).hostname
            or len(self.secret) < 32
            or not 100 <= self.timeout_ms <= 30_000
        ):
            raise ValueError('Invalid browser SSO configuration')

    @property
    def prefix(self) -> str:
        return ('__Host-' if self.audience.startswith('https:') else '') + 'magic-sso-tx-'

    def discover(self, login_ui: str | None = None) -> int | None:
        selected_ui = login_ui or self.login_ui
        if self.cache_until > time.monotonic() and self.cached_ui == selected_ui:
            return self.cached_lifetime
        response = requests.get(
            self.issuer + '/sso/capabilities',
            timeout=self.timeout_ms / 1000,
            allow_redirects=False,
            headers={'accept': 'application/json'},
        )
        if response.status_code == 404:
            lifetime = None
        else:
            if response.status_code != 200 or len(response.content) > 16_384:
                raise ValueError('Capability discovery failed')
            document: object = response.json()
            capability: object = document.get('browserSso') if isinstance(document, dict) else None
            if not isinstance(capability, dict):
                raise ValueError('Invalid capabilities')
            version, enabled = capability.get('version'), capability.get('enabled')
            if type(version) is not int or version < 1 or type(enabled) is not bool:
                raise ValueError('Invalid capabilities')
            if version != 1 or not enabled:
                lifetime = None
            else:
                bootstrap = capability.get('appOwnedBootstrapVersion')
                if bootstrap is not None and (type(bootstrap) is not int or bootstrap < 1):
                    raise ValueError('Invalid bootstrap capabilities')
                request, code, lifetime = (
                    capability.get(key)
                    for key in (
                        'requestLifetimeSeconds',
                        'codeLifetimeSeconds',
                        'transactionLifetimeSeconds',
                    )
                )
                if (
                    type(request) is not int
                    or not 60 <= request <= 1800
                    or type(code) is not int
                    or not 15 <= code <= 120
                    or type(lifetime) is not int
                    or lifetime != request + code + 30
                    or capability.get('loginUi') != 'hosted'
                    or capability.get('codeChallengeMethods') != ['S256']
                ):
                    raise ValueError('Invalid capabilities')
                if selected_ui == 'app-owned' and bootstrap != 1:
                    lifetime = None
        self.cached_ui = selected_ui
        self.cached_lifetime, self.cache_until = lifetime, time.monotonic() + 60
        return lifetime

    def open(self, name: str, value: str, now: int) -> Transaction | None:
        return unseal(
            self.secret,
            name,
            value,
            self.issuer,
            self.audience,
            self.redirect_uri,
            name.removeprefix(self.prefix),
            now,
        )


@lru_cache(maxsize=8)
def cached_client(
    issuer: str,
    audience: str,
    callback: str,
    secret: str,
    mode: str,
    allow_local: bool,
    timeout_ms: int,
    login_ui: str = 'hosted',
) -> BrowserSsoClient:
    return BrowserSsoClient(
        issuer, audience, callback, secret, mode, allow_local, timeout_ms, login_ui=login_ui
    )


def client_for(request: HttpRequest) -> BrowserSsoClient:
    audience, issuer = get_configured_public_origin(), get_expected_issuer()
    if not audience or not issuer:
        raise ValueError('Browser SSO requires MAGICSSO_PUBLIC_ORIGIN and MAGICSSO_SERVER_URL')
    name = settings.MAGICSSO_COOKIE_NAME
    path = getattr(settings, 'MAGICSSO_COOKIE_PATH', '/')
    age = getattr(settings, 'MAGICSSO_COOKIE_MAX_AGE', None)
    if (
        not isinstance(name, str)
        or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name)
        or re.match(r'^(?:__Host-)?magic-sso-(?:tx-|continuation-|confirm-|browser)', name)
        or not isinstance(path, str)
        or not path.startswith('/')
        or re.search(r'[;\r\n]', path)
        or (age is not None and (type(age) is not int or age <= 0))
        or (name.startswith('__Host-') and (path != '/' or not audience.startswith('https:')))
    ):
        raise ValueError('Invalid browser SSO app cookie configuration')
    callback_path = reverse('magic_sso:sso_callback')
    if get_login_ui() == 'app-owned' and not (
        callback_path == path
        or callback_path.startswith(path if path.endswith('/') else path + '/')
    ):
        raise ValueError('The app cookie path must cover the SSO callback')
    return cached_client(
        issuer,
        audience,
        audience + reverse('magic_sso:sso_callback'),
        settings.MAGICSSO_JWT_SECRET,
        get_mode(),
        getattr(settings, 'MAGICSSO_BROWSER_SSO_ALLOW_INSECURE_LOCALHOST', False),
        getattr(settings, 'MAGICSSO_BROWSER_SSO_TIMEOUT_MS', 5000),
        get_login_ui(),
    )


def response_page(
    title: str,
    message: str,
    href: str,
    label: str,
    status: int = 200,
    central: str | None = None,
    restart: str | None = None,
) -> HttpResponse:
    central_link = f'<a href="{escape(central)}">End browser SSO session</a>' if central else ''
    restart_link = f'<a href="{escape(restart)}">Start a fresh sign-in</a>' if restart else ''
    response = HttpResponse(
        f'<!doctype html><html lang="en"><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{escape(title)} | Magic Link SSO</title>'
        '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef4ff;color:#172554;font:1rem/1.6 Arial,sans-serif}'
        'main{width:min(86vw,36rem);padding:2rem;background:white;border-radius:1rem}nav{display:flex;flex-wrap:wrap;gap:.75rem}'
        'a{padding:.75rem 1rem;border:2px solid #1d4ed8;border-radius:.5rem;color:#1d4ed8;font-weight:bold;text-decoration:none}'
        'a:first-child{background:#1d4ed8;color:white}a:focus-visible{outline:3px solid #172554;outline-offset:4px}</style>'
        f'<main><h1>{escape(title)}</h1>'
        f'<p>{escape(message)}</p><nav><a href="{escape(href)}">{escape(label)}</a>'
        f'{central_link}{restart_link}</nav></main></html>',
        status=status,
    )
    return private(response)


def private(response: HttpResponse) -> HttpResponse:
    response['Cache-Control'] = 'no-store'
    response['Referrer-Policy'] = 'no-referrer'
    response['X-Content-Type-Options'] = 'nosniff'
    response['X-Frame-Options'] = 'DENY'
    response['Content-Security-Policy'] = (
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    )
    return response


def error_page(
    message: str = 'Sign-in could not be completed. Start again from your application.',
) -> HttpResponse:
    return response_page(
        'Sign-in could not be completed',
        message,
        reverse('magic_sso:sso_start'),
        'Start sign-in again',
        400,
    )


def set_transaction_cookie(
    response: HttpResponse, client: BrowserSsoClient, name: str, value: str, age: int
) -> None:
    response.set_cookie(
        name,
        value,
        max_age=age,
        # Use the same past expiry as Django's delete_cookie; "now" can linger in Firefox.
        expires='Thu, 01 Jan 1970 00:00:00 GMT' if age == 0 else None,
        path='/',
        httponly=True,
        secure=client.audience.startswith('https:'),
        samesite='Lax',
    )


def is_document(request: HttpRequest) -> bool:
    purpose = request.headers.get('Purpose', '') + request.headers.get('Sec-Purpose', '')
    return (
        request.headers.get('Sec-Fetch-Mode', 'navigate') == 'navigate'
        and request.headers.get('Sec-Fetch-Dest', 'document') == 'document'
        and not re.search('prefetch|prerender', purpose, re.IGNORECASE)
        and not request.headers.get('RSC')
    )


def continuation(request: HttpRequest) -> HttpResponse:
    # Use a local path so even a malicious Host header cannot become a continuation target.
    return response_page(
        'Continue sign-in', 'Continue in this browser tab.', request.get_full_path(), 'Continue'
    )


# POST uses cookie-bound state/confirmation CSRF and exact or null document Origin.
@csrf_exempt
@require_http_methods(['GET', 'POST'])
def start(request: HttpRequest) -> HttpResponse:
    if not is_document(request):
        return continuation(request)
    if get_mode() == 'off':
        if request.method != 'GET':
            return HttpResponseNotAllowed(['GET'])
        return private(
            HttpResponseRedirect(reverse('magic_sso:login') + '?' + request.GET.urlencode())
        )
    expired: list[str] = []
    client: BrowserSsoClient | None = None
    try:
        client = client_for(request)
        if client.login_ui == 'app-owned':
            from .browser_sso_bootstrap import handle_start

            local = handle_start(request, client)
            if local is not None:
                return local
        if request.method != 'GET':
            return HttpResponseNotAllowed(['GET'])
        selected_ui = 'hosted' if request.GET.get('loginUi') == 'hosted' else client.login_ui
        lifetime = client.discover(selected_ui)
        if lifetime is None:
            if client.mode == 'auto':
                return private(
                    HttpResponseRedirect(reverse('magic_sso:login') + '?' + request.GET.urlencode())
                )
            return error_page('This application requires browser SSO. Contact its administrator.')
        destination = same_origin_url(request.GET.get('returnUrl', '/'), client.audience)
        if len(destination.encode()) > 512:
            return error_page(
                'This address is too long for sign-in. Open a shorter application link.'
            )
        now = int(time.time() * 1000)
        pending: set[str] = set()
        for name, value in read_cookies(request):
            if name.startswith(client.prefix):
                payload = client.open(name, value, now)
                if payload and payload.expiresAt <= now:
                    expired.append(name)
                elif payload:
                    pending.add(name)
        if len(pending) >= 3:
            response = error_page('Finish a sign-in in another tab, or wait for it to expire.')
        else:
            state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            name = client.prefix + state
            value = seal(
                client.secret,
                name,
                Transaction(
                    1,
                    state,
                    verifier,
                    destination,
                    client.issuer,
                    client.audience,
                    client.redirect_uri,
                    now,
                    now + lifetime * 1000,
                    0,
                ),
            )
            params = {
                'redirectUri': client.redirect_uri,
                'state': state,
                'codeChallenge': encode(hashlib.sha256(verifier.encode()).digest()),
                'codeChallengeMethod': 'S256',
            }
            scope = request.GET.get('scope', '').strip()
            if len(scope.encode()) > 256:
                return error_page('Invalid sign-in scope.')
            if selected_ui == 'app-owned':
                params['loginUi'] = 'app-owned'
            if scope:
                params['scope'] = scope
            if request.GET.get('prompt') == 'login':
                params['prompt'] = 'login'
            response = private(
                HttpResponseRedirect(client.issuer + '/sso/authorize?' + urlencode(params))
            )
            response.status_code = 303
            set_transaction_cookie(response, client, name, value, lifetime)
    except (ValueError, requests.RequestException):
        response = error_page(
            'Magic Link SSO is temporarily unavailable. Start again from your application.'
        )
    if client:
        for name in expired:
            set_transaction_cookie(response, client, name, '', 0)
    return response


@require_GET
def callback(request: HttpRequest) -> HttpResponse:
    if not is_document(request):
        return continuation(request)
    if get_mode() == 'off':
        return error_page('Browser SSO is disabled.')
    try:
        client = client_for(request)
        if client.login_ui == 'app-owned' and 'browserSso' in request.GET:
            from .browser_sso_bootstrap import finish

            return finish(request, client)
        state = request.GET.get('state', '')
        if not OPAQUE.fullmatch(state) or len(request.GET.getlist('state')) != 1:
            return error_page()
        name = client.prefix + state
        values = [value for key, value in read_cookies(request) if key == name]
        now = int(time.time() * 1000)
        payload = client.open(name, values[0], now) if len(values) == 1 else None
        if not payload:
            return error_page()
        response = error_page()
        if payload.expiresAt > now and 'error' not in request.GET:
            code = request.GET.get('code', '')
            if OPAQUE.fullmatch(code) and len(request.GET.getlist('code')) == 1:
                try:
                    exchange = requests.post(
                        client.issuer + '/sso/exchange',
                        json={
                            'code': code,
                            'codeVerifier': payload.codeVerifier,
                            'redirectUri': client.redirect_uri,
                        },
                        timeout=client.timeout_ms / 1000,
                        allow_redirects=False,
                        headers={'accept': 'application/json'},
                    )
                    document: object = (
                        exchange.json()
                        if exchange.status_code == 200 and len(exchange.content) <= 16_384
                        else None
                    )
                    token = document.get('accessToken') if isinstance(document, dict) else None
                    auth = verify_access_token(token, request) if isinstance(token, str) else None
                    if (
                        auth
                        and isinstance(auth.get('exp'), (int, float))
                        and auth['exp'] > time.time()
                    ):
                        response = private(HttpResponseRedirect(payload.returnUrl))
                        response.status_code = 303
                        remaining = int(auth['exp'] - time.time())
                        age = getattr(settings, 'MAGICSSO_COOKIE_MAX_AGE', None)
                        response.set_cookie(
                            settings.MAGICSSO_COOKIE_NAME,
                            token,
                            max_age=min(age or remaining, remaining),
                            path=getattr(settings, 'MAGICSSO_COOKIE_PATH', '/'),
                            httponly=True,
                            samesite='Lax',
                            secure=client.audience.startswith('https:'),
                        )
                except (ValueError, requests.RequestException):
                    pass  # Unknown exchange outcomes are never retried.
        if client.login_ui == 'app-owned':
            from .browser_sso_bootstrap import prefix, read

            if read(request, client, state):
                set_transaction_cookie(response, client, prefix(client) + state, '', 0)
        set_transaction_cookie(response, client, name, '', 0)
        return response
    except (ValueError, requests.RequestException):
        return error_page()


@require_GET
def signed_out(request: HttpRequest) -> HttpResponse:
    central: str | None = None
    if get_mode() != 'off':
        try:
            client = client_for(request)
            central = (
                client.issuer
                + '/sso/signout?'
                + urlencode({'returnUri': client.audience + reverse('magic_sso:sso_signed_out')})
            )
        except ValueError:
            pass
    return response_page(
        'Signed out of this application',
        'Other application sessions remain active. You can sign in here again or end the browser SSO session.',
        reverse('magic_sso:sso_start'),
        'Sign in',
        central=central,
    )
