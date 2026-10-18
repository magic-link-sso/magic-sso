# SPDX-License-Identifier: MIT
"""Version 1 continuation envelopes and completion receipts shared with the TS SDK."""

import hashlib
import hmac
import json
import secrets
from dataclasses import asdict, dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .browser_sso import OPAQUE, BrowserSsoClient, Transaction, decode, encode


@dataclass(frozen=True)
class Continuation:
    v: int
    phase: str
    state: str
    requestId: str
    expiresAt: int
    bootstrapTicket: str | None = None
    accessTokenHash: str | None = None


def document(payload: Continuation) -> dict[str, object]:
    return {key: value for key, value in asdict(payload).items() if value is not None}


def parse(value: object) -> Continuation | None:
    if not isinstance(value, dict):
        return None
    phase = value.get('phase')
    fields = {'v', 'phase', 'state', 'requestId', 'expiresAt'}
    if phase == 'finish':
        fields |= {'bootstrapTicket', 'accessTokenHash'}
    if set(value) != fields or phase not in ('prepared', 'finish'):
        return None
    if type(value['v']) is not int or value['v'] != 1:
        return None
    if type(value['expiresAt']) is not int or not 0 < value['expiresAt'] <= 2**53 - 1:
        return None
    opaque_fields = ['state', 'requestId'] + (
        ['bootstrapTicket', 'accessTokenHash'] if phase == 'finish' else []
    )
    if any(
        not isinstance(value[key], str) or not OPAQUE.fullmatch(value[key]) for key in opaque_fields
    ):
        return None
    return Continuation(**value)


def continuation_key(client: BrowserSsoClient) -> bytes:
    if len(client.secret) < 32:
        raise ValueError('Invalid continuation key')
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=client.issuer.encode(),
        info=f'magic-link-sso/browser-sso/v1/continuation\n{client.audience}\n{client.redirect_uri}'.encode(),
    ).derive(client.secret.encode())


def seal(client: BrowserSsoClient, name: str, payload: Continuation) -> str:
    if parse(document(payload)) is None:
        raise ValueError('Invalid continuation')
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(continuation_key(client)).encrypt(
        nonce, json.dumps(document(payload), separators=(',', ':')).encode(), name.encode()
    )
    result = 'v1.' + encode(nonce + ciphertext)
    if len(result) > 1536:
        raise ValueError('Continuation too large')
    return result


def unseal(
    client: BrowserSsoClient, name: str, value: str, transaction: Transaction, now: int
) -> Continuation | None:
    try:
        if not value.startswith('v1.') or len(value) > 1536:
            return None
        blob = decode(value[3:])
        plaintext = AESGCM(continuation_key(client)).decrypt(blob[:12], blob[12:], name.encode())
        json_value: object = json.loads(plaintext)
        result = parse(json_value)
        return (
            result
            if result
            and result.state == transaction.state
            and now < result.expiresAt <= transaction.expiresAt
            and (transaction.issuer, transaction.audience, transaction.redirectUri)
            == (client.issuer, client.audience, client.redirect_uri)
            else None
        )
    except (ValueError, TypeError, InvalidTag, UnicodeError):
        return None


def token_hash(value: str) -> str:
    return encode(hashlib.sha256(value.encode()).digest())


def receipt_matches(
    client: BrowserSsoClient, continuation: Continuation, access_token: str, receipt: str
) -> bool:
    if (
        continuation.phase != 'finish'
        or continuation.bootstrapTicket is None
        or continuation.accessTokenHash != token_hash(access_token)
        or not OPAQUE.fullmatch(receipt)
    ):
        return False
    try:
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=client.issuer.encode(),
            info=f'magic-link-sso/browser-sso/v1/bootstrap-receipt\n{client.audience}'.encode(),
        ).derive(client.secret.encode())
        message = {
            'v': 1,
            'issuer': client.issuer,
            'audience': client.audience,
            'redirectUri': client.redirect_uri,
            'state': continuation.state,
            'ticketHash': token_hash(continuation.bootstrapTicket),
            'accessTokenHash': continuation.accessTokenHash,
        }
        expected = hmac.digest(key, json.dumps(message, separators=(',', ':')).encode(), 'sha256')
        return hmac.compare_digest(expected, decode(receipt))
    except (ValueError, TypeError, UnicodeError):
        return False
