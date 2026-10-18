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

from django.http import HttpResponse
from django.shortcuts import render
from magic_sso_django.auth_utils import is_authenticated, redirect_to_login
from magic_sso_django.browser_sso import get_mode
from magic_sso_django.decorators import sso_login_required
from magic_sso_django.request_types import MagicSsoHttpRequest


def index(request: MagicSsoHttpRequest) -> HttpResponse:
    email = request.magic_sso_user_email
    return render(request, 'home.html', {'email': email, 'browser_sso': get_mode() != 'off'})


@sso_login_required
def protected_by_decorator(request: MagicSsoHttpRequest) -> HttpResponse:
    email = request.magic_sso_user_email
    return render(request, 'protected.html', {'email': email, 'browser_sso': get_mode() != 'off'})


def protected_manually(request: MagicSsoHttpRequest) -> HttpResponse:
    is_auth, _payload = is_authenticated(request)
    if not is_auth:
        return redirect_to_login(request)
    email = request.magic_sso_user_email
    return render(request, 'protected.html', {'email': email, 'browser_sso': get_mode() != 'off'})
