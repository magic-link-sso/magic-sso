# SPDX-License-Identifier: MIT
import logging
import re


class SsoAccessLogFilter(logging.Filter):
    """Omit auth query values from Django's development HTTP access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = re.sub(
            r'((?:GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH) [^?\s]+)\?[^\s]+',
            r'\1?[redacted]',
            record.getMessage(),
        )
        record.args = ()
        return True
