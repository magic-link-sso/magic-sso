# SPDX-License-Identifier: MIT
"""Application-origin reference forms and backend-only bootstrap continuation."""

import json
import secrets
import time
from dataclasses import replace
from urllib.parse import urlencode

import requests
from django.conf import settings
from django.http import HttpRequest, HttpResponse, HttpResponseRedirect
from django.urls import reverse
from django.utils.html import escape

from . import browser_sso as sso
from . import browser_sso_continuation as wire
from .auth_utils import verify_access_token


def prefix(client: sso.BrowserSsoClient) -> str:
    return ('__Host-' if client.audience.startswith('https:') else '') + 'magic-sso-continuation-'


def one(request: HttpRequest, name: str) -> str | None:
    values = [value for key, value in sso.read_cookies(request) if key == name]
    return values[0] if len(values) == 1 else None


def transaction(
    request: HttpRequest, client: sso.BrowserSsoClient, state: str
) -> sso.Transaction | None:
    value = one(request, client.prefix + state)
    if not sso.OPAQUE.fullmatch(state) or not value:
        return None
    now = int(time.time() * 1000)
    result = client.open(client.prefix + state, value, now)
    return result if result and result.expiresAt > now else None


def read(
    request: HttpRequest, client: sso.BrowserSsoClient, state: str
) -> tuple[sso.Transaction, wire.Continuation] | None:
    tx = transaction(request, client, state)
    value = one(request, prefix(client) + state)
    continuation = (
        wire.unseal(client, prefix(client) + state, value, tx, int(time.time() * 1000))
        if tx and value
        else None
    )
    return (tx, continuation) if tx and continuation else None


def context(
    request: HttpRequest, client: sso.BrowserSsoClient, state: str
) -> dict[str, str] | None:
    result = read(request, client, state)
    if not result or result[1].phase != 'prepared':
        return None
    tx, continuation = result
    return {
        'requestId': continuation.requestId,
        'codeVerifier': tx.codeVerifier,
        'redirectUri': client.redirect_uri,
    }


def api(
    client: sso.BrowserSsoClient,
    path: str,
    body: dict[str, object] | None = None,
    preview: str | None = None,
) -> object:
    headers = {'accept': 'application/json'}
    if body is not None:
        headers['content-type'] = 'application/json'
    if preview:
        headers['x-magic-sso-preview-secret'] = preview
    response = requests.request(
        'GET' if body is None else 'POST',
        client.issuer + path,
        data=json.dumps(body) if body is not None else None,
        headers=headers,
        timeout=client.timeout_ms / 1000,
        allow_redirects=False,
    )
    if response.status_code != 200 or len(response.content) > 16_384:
        raise ValueError('Local verification failed')
    value: object = response.json()
    return value


def string(value: object, key: str) -> str | None:
    field = value.get(key) if isinstance(value, dict) else None
    return field if isinstance(field, str) else None


def hidden(name: str, value: str) -> str:
    return f'<input type="hidden" name="{escape(name)}" value="{escape(value)}">'


def form_page(client: sso.BrowserSsoClient, title: str, copy: str, form: str) -> HttpResponse:
    response = sso.private(
        HttpResponse(
            '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{escape(title)} | Magic Link SSO</title><style>'
            '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:#eef4ff;color:#172554;font:1rem/1.6 Arial,sans-serif}'
            'main{width:min(100%,36rem);padding:2rem;background:white;border-radius:1rem}h1{font-size:2rem;line-height:1.2}p{color:#334155}'
            'label{display:block;font-weight:bold;margin-top:1rem}input{width:100%;padding:.75rem;border:2px solid #64748b;border-radius:.5rem;font:inherit}input[type=hidden]{display:none}'
            'button{padding:.75rem 1rem;margin-top:1rem;border:2px solid #1d4ed8;border-radius:.5rem;background:#1d4ed8;color:white;font:inherit;font-weight:bold;cursor:pointer}:focus-visible{outline:3px solid #172554;outline-offset:4px}</style>'
            f'<main><h1>{escape(title)}</h1><p>{escape(copy)}</p>{form}</main></html>'
        )
    )
    response['Content-Security-Policy'] = response['Content-Security-Policy'].replace(
        "form-action 'none'", f"form-action 'self' {client.issuer}"
    )
    return response


def form_start() -> str:
    return f'<form method="post" action="{escape(reverse("magic_sso:sso_start"))}">'


def local_only(client: sso.BrowserSsoClient, destination: str) -> HttpResponse:
    restart = (
        reverse('magic_sso:sso_start')
        + '?'
        + urlencode({'loginUi': 'hosted', 'returnUrl': destination})
    )
    return sso.response_page(
        'Shared sign-in was not completed',
        'Your application session is kept if it is valid. Continue here or start a fresh sign-in to enable browser SSO.',
        destination,
        'Continue to application',
        restart=restart,
    )


def clear(response: HttpResponse, client: sso.BrowserSsoClient, state: str) -> None:
    for name in (client.prefix + state, prefix(client) + state):
        sso.set_transaction_cookie(response, client, name, '', 0)


def finish(request: HttpRequest, client: sso.BrowserSsoClient) -> HttpResponse:
    state = request.GET.get('state', '')
    if len(request.GET.getlist('state')) != 1 or len(request.GET.getlist('browserSso')) != 1:
        return sso.error_page()
    result = read(request, client, state)
    if not result or result[1].phase != 'finish':
        return sso.error_page()
    tx, continuation = result
    response = local_only(client, tx.returnUrl)
    token = one(request, settings.MAGICSSO_COOKIE_NAME)
    if (
        request.GET.get('browserSso') == 'complete'
        and len(request.GET.getlist('receipt')) == 1
        and token
        and verify_access_token(token, request)
        and wire.receipt_matches(client, continuation, token, request.GET.get('receipt', ''))
    ):
        response = sso.private(HttpResponseRedirect(tx.returnUrl))
        response.status_code = 303
    clear(response, client, state)
    return response


def complete_local(
    request: HttpRequest,
    client: sso.BrowserSsoClient,
    state: str,
    payload: object,
    destination: str,
) -> HttpResponse:
    token = string(payload, 'accessToken')
    auth = verify_access_token(token, request) if token else None
    if (
        not auth
        or not token
        or not isinstance(auth.get('exp'), (int, float))
        or auth['exp'] <= time.time()
    ):
        return sso.error_page()
    response = local_only(client, destination)
    result = read(request, client, state)
    if result:
        tx, continuation = result
        response = local_only(client, tx.returnUrl)
        extension = payload.get('browserSso') if isinstance(payload, dict) else None
        ticket = string(extension, 'bootstrapTicket')
        if continuation.phase == 'prepared' and ticket and sso.OPAQUE.fullmatch(ticket):
            try:
                updated = replace(
                    continuation,
                    phase='finish',
                    bootstrapTicket=ticket,
                    accessTokenHash=wire.token_hash(token),
                )
                value = wire.seal(client, prefix(client) + state, updated)
                response = sso.private(
                    HttpResponseRedirect(
                        client.issuer
                        + '/sso/bootstrap/redeem?'
                        + urlencode(
                            {'ticket': ticket, 'redirectUri': client.redirect_uri, 'state': state}
                        )
                    )
                )
                response.status_code = 303
                sso.set_transaction_cookie(
                    response,
                    client,
                    prefix(client) + state,
                    value,
                    max(1, (updated.expiresAt - int(time.time() * 1000) + 999) // 1000),
                )
            except (ValueError, TypeError):
                clear(response, client, state)
        else:
            clear(response, client, state)
    remaining = int(auth['exp'] - time.time())
    if remaining < 1:
        return sso.error_page()
    response.set_cookie(
        settings.MAGICSSO_COOKIE_NAME,
        token,
        max_age=min(getattr(settings, 'MAGICSSO_COOKIE_MAX_AGE', None) or remaining, remaining),
        path=getattr(settings, 'MAGICSSO_COOKIE_PATH', '/'),
        httponly=True,
        secure=client.audience.startswith('https:'),
        samesite='Lax',
    )
    return response


def handle_start(request: HttpRequest, client: sso.BrowserSsoClient) -> HttpResponse | None:
    csrf_prefix = ('__Host-' if client.audience.startswith('https:') else '') + 'magic-sso-confirm-'
    if request.method == 'GET' and 'ssoPrepared' in request.GET:
        state, request_id = request.GET.get('state', ''), request.GET.get('requestId', '')
        if (
            request.GET.get('ssoPrepared') != '1'
            or any(
                len(request.GET.getlist(key)) != 1 for key in ('state', 'requestId', 'ssoPrepared')
            )
            or not sso.OPAQUE.fullmatch(request_id)
        ):
            return sso.error_page()
        tx = transaction(request, client, state)
        if not tx:
            return sso.error_page()
        prepared = api(
            client,
            '/sso/bootstrap/inspect',
            {
                'requestId': request_id,
                'codeVerifier': tx.codeVerifier,
                'redirectUri': client.redirect_uri,
            },
        )
        if (
            not isinstance(prepared, dict)
            or prepared.get('state') != state
            or prepared.get('requestId') != request_id
            or not isinstance(prepared.get('scope'), str)
            or len(prepared['scope'].encode()) > 256
            or type(prepared.get('expiresAt')) is not int
            or prepared['expiresAt'] <= time.time() * 1000
        ):
            return sso.error_page()
        continuation = wire.Continuation(
            1, 'prepared', state, request_id, min(tx.expiresAt, prepared['expiresAt'])
        )
        response = form_page(
            client,
            'Sign in',
            'Enter your email address to sign in to this application and enable browser SSO.',
            form_start()
            + hidden('action', 'send')
            + hidden('state', state)
            + hidden('scope', prepared['scope'])
            + hidden('returnUrl', tx.returnUrl)
            + '<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"><button type="submit">Send magic link</button></form>',
        )
        sso.set_transaction_cookie(
            response,
            client,
            prefix(client) + state,
            wire.seal(client, prefix(client) + state, continuation),
            max(1, (continuation.expiresAt - int(time.time() * 1000) + 999) // 1000),
        )
        return response
    if request.method == 'GET' and request.GET.get('action') == 'verify':
        state, token = request.GET.get('state', ''), request.GET.get('token', '')
        if (
            not sso.OPAQUE.fullmatch(state)
            or len(token) > 8192
            or any(len(request.GET.getlist(key)) != 1 for key in ('state', 'token', 'action'))
        ):
            return sso.error_page()
        preview_secret = getattr(settings, 'MAGICSSO_PREVIEW_SECRET', '')
        if not preview_secret:
            return sso.error_page()
        preview = api(
            client, '/verify-email?' + urlencode({'token': token}), preview=preview_secret
        )
        email = string(preview, 'email')
        if not email:
            return sso.error_page()
        csrf = secrets.token_urlsafe(32)
        destination = sso.same_origin_url(request.GET.get('returnUrl', '/'), client.audience)
        response = form_page(
            client,
            'Confirm sign-in',
            f'Continue as {email}. This confirmation signs you in to this application.',
            form_start()
            + hidden('action', 'verify')
            + hidden('state', state)
            + hidden('token', token)
            + hidden('csrfToken', csrf)
            + hidden('returnUrl', destination)
            + '<button type="submit">Continue</button></form>',
        )
        sso.set_transaction_cookie(response, client, csrf_prefix + state, csrf, 600)
        return response
    if request.method != 'POST':
        return None
    # no-referrer document forms can send Origin: null; cookie-bound state/CSRF remains mandatory.
    if (
        request.headers.get('Origin') not in (client.audience, 'null')
        or request.content_type != 'application/x-www-form-urlencoded'
        or len(request.body) > 16_384
        or any(len(request.POST.getlist(key)) != 1 for key in request.POST)
    ):
        return sso.error_page()
    state, action = request.POST.get('state', ''), request.POST.get('action', '')
    proof = context(request, client, state)
    destination = sso.same_origin_url(request.POST.get('returnUrl', '/'), client.audience)
    if action == 'send':
        if not proof:
            return sso.error_page()
        verify_url = (
            client.audience
            + reverse('magic_sso:sso_start')
            + '?'
            + urlencode({'action': 'verify', 'state': state, 'returnUrl': destination})
        )
        payload = api(
            client,
            '/signin',
            {
                'email': request.POST.get('email'),
                'returnUrl': destination,
                'verifyUrl': verify_url,
                'scope': request.POST.get('scope', ''),
                'browserSso': proof,
            },
        )
        challenge = string(payload, 'otpChallengeId')
        otp = (
            form_start()
            + hidden('action', 'otp')
            + hidden('state', state)
            + hidden('challengeId', challenge)
            + hidden('returnUrl', destination)
            + '<label for="code">Email code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]+" required maxlength="12"><button type="submit">Verify code</button></form>'
            if challenge
            else ''
        )
        return form_page(
            client,
            'Check your email',
            'Open the magic link in your email. Keep this tab open.',
            otp,
        )
    if action not in ('verify', 'otp'):
        return sso.error_page()
    if action == 'verify':
        csrf = one(request, csrf_prefix + state)
        if (
            not sso.OPAQUE.fullmatch(state)
            or not csrf
            or not secrets.compare_digest(csrf, request.POST.get('csrfToken', ''))
        ):
            return sso.error_page()
    elif not proof:
        return sso.error_page()
    body: dict[str, object] = (
        {'token': request.POST.get('token')}
        if action == 'verify'
        else {'challengeId': request.POST.get('challengeId'), 'code': request.POST.get('code')}
    )
    if proof:
        body['browserSso'] = proof
    payload = api(client, '/verify-email' if action == 'verify' else '/verify-email/otp', body)
    response = complete_local(request, client, state, payload, destination)
    if action == 'verify':
        sso.set_transaction_cookie(response, client, csrf_prefix + state, '', 0)
    return response
