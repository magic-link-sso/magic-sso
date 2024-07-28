"""
# MIT License
#
# Magic Link SSO Copyright (C) 2026 Wojciech Polak
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
"""

from typing import Callable, cast

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.urls import resolve
from .auth_utils import redirect_to_login, is_authenticated
from .request_types import MagicSsoHttpRequest


def get_public_url_names() -> set[str]:
    configured_names = getattr(settings, 'MAGICSSO_PUBLIC_URLS', ['login'])
    return {name for name in configured_names if isinstance(name, str) and name}


class MagicSsoMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        magic_request = cast(MagicSsoHttpRequest, request)
        magic_request.is_magic_sso_authenticated = False
        magic_request.magic_sso_user_email = None
        magic_request.magic_sso_user_scope = None

        # Get the current URL name
        current_url_name = resolve(magic_request.path_info).url_name

        if current_url_name in get_public_url_names():
            return self.get_response(magic_request)

        is_authed, payload = is_authenticated(magic_request)

        if not is_authed and settings.MAGICSSO_AUTH_EVERYWHERE:
            return redirect_to_login(magic_request)

        if is_authed:
            magic_request.magic_sso_user_email = payload.get('email')
            magic_request.magic_sso_user_scope = payload.get('scope')
            magic_request.is_magic_sso_authenticated = True

        return self.get_response(magic_request)
