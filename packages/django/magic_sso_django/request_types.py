# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from django.http import HttpRequest


class MagicSsoHttpRequest(HttpRequest):
    is_magic_sso_authenticated: bool
    magic_sso_user_email: str | None
    magic_sso_user_scope: str | None
