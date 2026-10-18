# SPDX-License-Identifier: MIT
import logging

from magic_sso_django.logging import SsoAccessLogFilter


def test_access_log_never_contains_callback_or_email_proof_query() -> None:
    for path in ['/sso/callback/?code=opaque&state=private', '/sso/verify?token=secret']:
        record = logging.LogRecord(
            'django.server',
            logging.INFO,
            '',
            0,
            '"%s" %s',
            ('GET ' + path + ' HTTP/1.1', 303),
            None,
        )
        assert SsoAccessLogFilter().filter(record)
        assert record.getMessage() == f'"GET {path.split("?")[0]}?[redacted] HTTP/1.1" 303'
