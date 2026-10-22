# SPDX-License-Identifier: MIT
import json
from dataclasses import replace
from pathlib import Path

from pytest import MonkeyPatch

from magic_sso_django import browser_sso_continuation as continuation
from magic_sso_django.browser_sso import BrowserSsoClient, Transaction

FIXTURE = json.loads(
    (Path(__file__).parents[2] / 'core/test/fixtures/browser-sso-bootstrap-v1.json').read_text()
)
CONTEXT = FIXTURE['context']
CLIENT = BrowserSsoClient(
    CONTEXT['issuer'],
    CONTEXT['audience'],
    CONTEXT['redirectUri'],
    FIXTURE['keyMaterial'],
    'required',
    False,
    5000,
)
PAYLOAD = continuation.parse(FIXTURE['continuation']['payload'])
TRANSACTION = Transaction(
    1,
    CONTEXT['state'],
    'V' * 43,
    CONTEXT['audience'] + '/protected',
    CONTEXT['issuer'],
    CONTEXT['audience'],
    CONTEXT['redirectUri'],
    1800000000000,
    1800000990000,
    0,
)


def test_shared_independent_envelope_and_receipt(monkeypatch: MonkeyPatch) -> None:
    assert PAYLOAD is not None
    name = FIXTURE['continuation']['cookieName']
    monkeypatch.setattr(continuation.secrets, 'token_bytes', lambda count: bytes([5]) * count)
    assert continuation.seal(CLIENT, name, PAYLOAD) == FIXTURE['continuation']['sealed']
    assert (
        continuation.unseal(
            CLIENT, name, FIXTURE['continuation']['sealed'], TRANSACTION, TRANSACTION.createdAt
        )
        == PAYLOAD
    )
    assert continuation.receipt_matches(CLIENT, PAYLOAD, FIXTURE['accessToken'], FIXTURE['receipt'])
    assert not continuation.receipt_matches(CLIENT, PAYLOAD, 'different-token', FIXTURE['receipt'])
    assert not continuation.receipt_matches(CLIENT, PAYLOAD, FIXTURE['accessToken'], 'Z' * 43)


def test_context_substitution_expiry_and_strict_payload() -> None:
    assert PAYLOAD is not None
    name, value = FIXTURE['continuation']['cookieName'], FIXTURE['continuation']['sealed']
    for client in [
        replace(CLIENT, issuer='https://other.example.com'),
        replace(
            CLIENT,
            audience='https://other.example.com',
            redirect_uri='https://other.example.com/sso/callback',
        ),
        replace(CLIENT, redirect_uri=CLIENT.audience + '/other'),
    ]:
        assert continuation.unseal(client, name, value, TRANSACTION, TRANSACTION.createdAt) is None
        assert not continuation.receipt_matches(
            client, PAYLOAD, FIXTURE['accessToken'], FIXTURE['receipt']
        )
    assert (
        continuation.unseal(CLIENT, name + 'x', value, TRANSACTION, TRANSACTION.createdAt) is None
    )
    assert continuation.unseal(CLIENT, name, value, TRANSACTION, PAYLOAD.expiresAt) is None
    assert (
        continuation.unseal(
            CLIENT,
            name,
            value,
            replace(TRANSACTION, expiresAt=PAYLOAD.expiresAt - 1),
            TRANSACTION.createdAt,
        )
        is None
    )
    assert continuation.parse({**continuation.document(PAYLOAD), 'extra': 'field'}) is None
    assert continuation.parse({**continuation.document(PAYLOAD), 'expiresAt': True}) is None
    assert (
        continuation.parse({**continuation.document(PAYLOAD), 'bootstrapTicket': 'short'}) is None
    )
