# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

import json
from pathlib import Path
from typing import NotRequired, TypedDict, cast
from unittest.mock import patch

import jwt
import pytest
from django.test import RequestFactory, override_settings

from magic_sso_django.auth_utils import verify_access_token


class TokenCase(TypedDict):
    name: str
    accepted: bool
    claims: NotRequired[dict[str, object]]
    omit: NotRequired[list[str]]
    algorithm: NotRequired[str]
    signingSecret: NotRequired[str]


class TokenFixture(TypedDict):
    now: int
    secret: str
    payload: dict[str, object]
    cases: list[TokenCase]


# The same versioned fixture drives Core, Gate, Angular, Next.js, Nuxt and Fastify.
FIXTURE = cast(
    TokenFixture,
    json.loads((Path(__file__).parents[2] / 'core/test/fixtures/access-token-v1.json').read_text()),
)


@pytest.mark.parametrize('case', FIXTURE['cases'], ids=lambda case: case['name'])
def test_access_token_contract(case: TokenCase) -> None:
    payload = {**FIXTURE['payload'], **case.get('claims', {})}
    for claim in case.get('omit', []):
        payload.pop(claim, None)
    token = jwt.encode(
        payload,
        case.get('signingSecret', FIXTURE['secret']),
        algorithm=case.get('algorithm', 'HS256'),
    )
    with (
        patch('magic_sso_django.tokens.time', return_value=FIXTURE['now']),
        override_settings(
            MAGICSSO_SERVER_URL=FIXTURE['payload']['iss'],
            MAGICSSO_PUBLIC_ORIGIN=FIXTURE['payload']['aud'],
            MAGICSSO_JWT_SECRET=FIXTURE['secret'],
        ),
    ):
        result = verify_access_token(token, RequestFactory().get('/protected/'))

    if case['accepted']:
        assert result == payload
    else:
        assert result is None


@pytest.mark.parametrize('token', ['', 'not-a-jwt'])
def test_access_token_contract_rejects_malformed_tokens(token: str) -> None:
    assert verify_access_token(token, RequestFactory().get('/protected/')) is None
