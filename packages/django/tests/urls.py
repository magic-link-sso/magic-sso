# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from django.http import HttpRequest, HttpResponse
from django.urls import include, path


def home_view(_request: HttpRequest) -> HttpResponse:
    return HttpResponse('home')


def protected_view(_request: HttpRequest) -> HttpResponse:
    return HttpResponse('protected')


urlpatterns = [
    path('', home_view, name='home'),
    path('protected/', protected_view, name='protected'),
    path('sso/', include('magic_sso_django.urls')),
]
