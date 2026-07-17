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

import logging
from urllib.parse import urlencode, urlsplit
from typing import Literal, TypedDict

import requests

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils.html import format_html
from django.utils.safestring import SafeString
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_POST
from .auth_utils import verify_access_token

logger = logging.getLogger(__name__)
REQUEST_TIMEOUT_SECONDS = 5
VERIFY_EMAIL_PREVIEW_SECRET_HEADER = 'x-magic-sso-preview-secret'


class MagicSsoCookieOptions(TypedDict):
    domain: str | None
    httponly: bool
    max_age: int | None
    path: str
    samesite: Literal['Lax', 'Strict', 'None']
    secure: bool


def get_magic_sso_cookie_samesite() -> Literal['Lax', 'Strict', 'None']:
    configured_value = getattr(settings, 'MAGICSSO_COOKIE_SAMESITE', 'Lax')
    if not isinstance(configured_value, str):
        raise ValueError('MAGICSSO_COOKIE_SAMESITE must be a string.')

    normalised_value = configured_value.strip().lower()
    if normalised_value == 'lax':
        return 'Lax'
    if normalised_value == 'strict':
        return 'Strict'
    if normalised_value == 'none':
        return 'None'

    raise ValueError("MAGICSSO_COOKIE_SAMESITE must be one of: 'Lax', 'Strict', 'None'.")


def get_magic_sso_cookie_options() -> MagicSsoCookieOptions:
    return {
        'domain': getattr(settings, 'MAGICSSO_COOKIE_DOMAIN', None) or None,
        'httponly': True,
        'max_age': getattr(settings, 'MAGICSSO_COOKIE_MAX_AGE', None),
        'path': getattr(settings, 'MAGICSSO_COOKIE_PATH', '/') or '/',
        'samesite': get_magic_sso_cookie_samesite(),
        'secure': getattr(settings, 'MAGICSSO_COOKIE_SECURE', True),
    }


def get_default_return_url(request: HttpRequest) -> str:
    return request.build_absolute_uri('/')


def normalise_return_url(request: HttpRequest, return_url: str | None) -> str:
    fallback = get_default_return_url(request)
    if not isinstance(return_url, str) or return_url == '':
        return fallback
    if return_url.startswith('/') and not return_url.startswith('//'):
        return return_url

    parsed_url = urlsplit(return_url)
    if parsed_url.scheme == '' or parsed_url.netloc == '':
        return fallback

    request_origin = urlsplit(request.build_absolute_uri('/'))
    if parsed_url.scheme == request_origin.scheme and parsed_url.netloc == request_origin.netloc:
        return return_url

    return fallback


def build_verify_url(request: HttpRequest, return_url: str) -> str:
    verify_url = request.build_absolute_uri(reverse('magic_sso:verify_email'))
    params = urlencode({'returnUrl': return_url})
    return f'{verify_url}?{params}'


def get_preview_secret() -> str:
    preview_secret = getattr(settings, 'MAGICSSO_PREVIEW_SECRET', '')
    return preview_secret if isinstance(preview_secret, str) else ''


def normalise_scope(scope: str | None) -> str | None:
    if not isinstance(scope, str):
        return None

    normalised_scope = scope.strip()
    return normalised_scope if normalised_scope else None


def build_otp_input_attributes(otp_length: int | None) -> SafeString:
    if not isinstance(otp_length, int) or otp_length < 1:
        return SafeString('')
    if otp_length == 6:
        return format_html(
            'minlength="{}" maxlength="{}" placeholder="123456"',
            otp_length,
            otp_length,
        )
    return format_html('minlength="{}" maxlength="{}"', otp_length, otp_length)


def build_otp_code_input(otp_length: int | None) -> SafeString:
    return format_html(
        '<input id="otp-code" type="text" name="code" autocomplete="one-time-code" '
        'inputmode="numeric" pattern="[0-9]*" {} aria-describedby="otp-help" required autofocus />',
        build_otp_input_attributes(otp_length),
    )


@csrf_protect
def login(request: HttpRequest) -> HttpResponse:
    if request.method == 'POST':
        email = request.POST.get('email', '')
        return_url = normalise_return_url(request, request.POST.get('returnUrl'))
        scope = normalise_scope(request.POST.get('scope'))
        verify_url = build_verify_url(request, return_url)
        sso_url = f'{settings.MAGICSSO_SERVER_URL}/signin'
        payload = {'email': email, 'verifyUrl': verify_url, 'returnUrl': return_url}
        if isinstance(scope, str):
            payload['scope'] = scope
        logger.info('Sending Magic Link SSO sign-in request')
        try:
            response = requests.post(
                sso_url,
                json=payload,
                timeout=getattr(settings, 'MAGICSSO_REQUEST_TIMEOUT', REQUEST_TIMEOUT_SECONDS),
            )
        except requests.RequestException:
            logger.exception('Failed to contact Magic Link SSO server during login')
            return render(
                request,
                'login.html',
                {
                    'error': 'Failed to send verification email',
                    'return_url': return_url,
                    'scope': scope,
                },
            )
        if response.status_code == 200:
            try:
                response_data = response.json()
            except ValueError:
                response_data = {}
            data = {
                'confirmation': True,
                'return_url': return_url,
                'scope': scope,
            }
            challenge_id = response_data.get('otpChallengeId')
            otp_length = response_data.get('otpLength')
            if (
                isinstance(challenge_id, str)
                and challenge_id != ''
                and isinstance(otp_length, int)
                and otp_length > 0
            ):
                data['otp_challenge_id'] = challenge_id
                data['otp_length'] = otp_length
                data['otp_code_input'] = build_otp_code_input(otp_length)
        elif response.status_code == 403:
            data = {'error': 'Forbidden', 'return_url': return_url, 'scope': scope}
        else:
            data = {
                'error': 'Failed to send verification email',
                'return_url': return_url,
                'scope': scope,
            }
        return render(request, 'login.html', data)

    elif settings.MAGICSSO_DIRECT_USE:
        return_url = request.GET.get('returnUrl') or get_default_return_url(request)
        params: dict[str, str] = {'returnUrl': return_url}
        params['verifyUrl'] = build_verify_url(request, return_url)
        scope = normalise_scope(request.GET.get('scope'))
        if isinstance(scope, str):
            params['scope'] = scope
        encoded_params = urlencode(params)
        return redirect(settings.MAGICSSO_SERVER_URL + '/signin?' + encoded_params)

    return render(
        request,
        'login.html',
        {
            'return_url': normalise_return_url(request, request.GET.get('returnUrl')),
            'scope': normalise_scope(request.GET.get('scope')),
        },
    )


@csrf_protect
@require_POST
def logout(request: HttpRequest) -> HttpResponse:
    response = redirect('/')
    cookie_options = get_magic_sso_cookie_options()
    response.delete_cookie(
        settings.MAGICSSO_COOKIE_NAME,
        domain=cookie_options['domain'],
        path=cookie_options['path'],
        samesite=cookie_options['samesite'],
    )
    return response


@csrf_protect
def verify_token(request: HttpRequest) -> HttpResponse:
    if request.method == 'POST':
        token = request.POST.get('token')
        return_url = normalise_return_url(request, request.POST.get('returnUrl'))
        if not token:
            logger.warning('Rejected verify_token POST request without a token')
            return render(
                request,
                'login.html',
                {'error': 'Invalid or expired token', 'return_url': return_url},
            )

        try:
            response = requests.post(
                f'{settings.MAGICSSO_SERVER_URL}/verify-email',
                json={'token': token},
                timeout=getattr(settings, 'MAGICSSO_REQUEST_TIMEOUT', REQUEST_TIMEOUT_SECONDS),
            )
        except requests.RequestException:
            logger.exception('Failed to contact Magic Link SSO server during token verification')
            return render(
                request,
                'login.html',
                {'error': 'Invalid or expired token', 'return_url': return_url},
            )

        if response.status_code == 200:
            response_data = response.json()
            access_token = response_data.get('accessToken')
            if (
                isinstance(access_token, str)
                and verify_access_token(access_token, request) is not None
            ):
                cookie_options = get_magic_sso_cookie_options()
                redirect_response = redirect(return_url)
                redirect_response.set_cookie(
                    settings.MAGICSSO_COOKIE_NAME,
                    access_token,
                    **cookie_options,
                )
                return redirect_response

        return render(
            request,
            'login.html',
            {'error': 'Invalid or expired token', 'return_url': return_url},
        )

    token = request.GET.get('token')
    return_url = normalise_return_url(request, request.GET.get('returnUrl'))
    if not token:
        logger.warning('Rejected verify_token request without a token')
        return render(
            request,
            'login.html',
            {'error': 'Invalid or expired token', 'return_url': return_url},
        )

    params = urlencode({'token': token})
    preview_secret = get_preview_secret()
    if preview_secret == '':
        logger.warning('Rejected verify_token request without a preview secret')
        return render(
            request,
            'login.html',
            {'error': 'Invalid or expired token', 'return_url': return_url},
        )

    try:
        response = requests.get(
            f'{settings.MAGICSSO_SERVER_URL}/verify-email?{params}',
            headers={VERIFY_EMAIL_PREVIEW_SECRET_HEADER: preview_secret},
            timeout=getattr(settings, 'MAGICSSO_REQUEST_TIMEOUT', REQUEST_TIMEOUT_SECONDS),
        )
    except requests.RequestException:
        logger.exception('Failed to contact Magic Link SSO server during token preview')
        return render(
            request,
            'login.html',
            {'error': 'Invalid or expired token', 'return_url': return_url},
        )

    if response.status_code != 200:
        return render(
            request,
            'login.html',
            {'error': 'Invalid or expired token', 'return_url': return_url},
        )

    response_data = response.json()
    email = response_data.get('email')
    if not isinstance(email, str) or email == '':
        return render(
            request,
            'login.html',
            {'error': 'Invalid or expired token', 'return_url': return_url},
        )

    return render(
        request,
        'verify_email.html',
        {'email': email, 'return_url': return_url, 'token': token},
    )


@csrf_protect
@require_POST
def verify_otp(request: HttpRequest) -> HttpResponse:
    challenge_id = request.POST.get('challengeId')
    code = request.POST.get('code')
    return_url = normalise_return_url(request, request.POST.get('returnUrl'))
    otp_length_value = request.POST.get('otpLength')
    otp_length = (
        int(otp_length_value)
        if otp_length_value and otp_length_value.isdigit() and int(otp_length_value) > 0
        else None
    )
    otp_context = {
        'confirmation': True,
        'otp_challenge_id': challenge_id,
        'otp_code_input': build_otp_code_input(otp_length),
        'otp_length': otp_length,
        'return_url': return_url,
    }
    if (
        not isinstance(challenge_id, str)
        or challenge_id == ''
        or not isinstance(code, str)
        or code == ''
    ):
        return render(
            request,
            'login.html',
            {**otp_context, 'error': 'Invalid or expired code.'},
        )

    try:
        response = requests.post(
            f'{settings.MAGICSSO_SERVER_URL}/verify-email/otp',
            json={'challengeId': challenge_id, 'code': code},
            timeout=getattr(settings, 'MAGICSSO_REQUEST_TIMEOUT', REQUEST_TIMEOUT_SECONDS),
        )
        response_data = response.json() if response.status_code == 200 else {}
    except (requests.RequestException, ValueError):
        response_data = {}

    access_token = response_data.get('accessToken')
    if isinstance(access_token, str) and verify_access_token(access_token, request) is not None:
        cookie_options = get_magic_sso_cookie_options()
        redirect_response = redirect(return_url)
        redirect_response.set_cookie(settings.MAGICSSO_COOKIE_NAME, access_token, **cookie_options)
        return redirect_response

    return render(
        request,
        'login.html',
        {**otp_context, 'error': 'Invalid or expired code.'},
    )
