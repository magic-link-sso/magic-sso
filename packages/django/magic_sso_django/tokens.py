# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from math import floor, isfinite
from time import time
from typing import TypeGuard

import jwt


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and len(value) > 0


def _numeric_date(value: object) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)


def _valid_dates(payload: dict[str, object]) -> bool:
    now = floor(time())
    expiry = payload.get('exp')
    not_before = payload.get('nbf')
    return (
        _numeric_date(payload.get('iat'))
        and _numeric_date(expiry)
        and expiry > now
        and ('nbf' not in payload or (_numeric_date(not_before) and not_before <= now))
    )


def _valid_claims(payload: dict[str, object]) -> bool:
    audience = payload.get('aud')
    valid_audience = _nonempty_string(audience) or (
        isinstance(audience, list)
        and len(audience) > 0
        and all(_nonempty_string(entry) for entry in audience)
    )
    return (
        all(_nonempty_string(payload.get(key)) for key in ('email', 'jti', 'siteId', 'iss'))
        and ('sub' not in payload or isinstance(payload['sub'], str))
        and isinstance(payload.get('scope'), str)
        and valid_audience
        and _valid_dates(payload)
    )


def verify_auth_token(
    token: str, secret: str, *, expected_audience: str, expected_issuer: str
) -> dict[str, object] | None:
    """Independent Python implementation of the shared access-token contract."""
    if not token or not secret or not expected_audience or not expected_issuer:
        return None
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=['HS256'],
            audience=expected_audience,
            issuer=expected_issuer,
            # Validate NumericDates below: PyJWT coerces strings/bools and truncates fractions.
            # Match core/jose's integer-second clock while preserving fractional claim values.
            options={'verify_iat': False, 'verify_exp': False, 'verify_nbf': False},
        )
        return payload if _valid_claims(payload) else None
    except (jwt.InvalidTokenError, TypeError, ValueError, OverflowError):
        return None
