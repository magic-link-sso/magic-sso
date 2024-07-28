# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from typing import Any

import django
from django.conf import settings


def pytest_configure() -> None:
    if settings.configured:
        return

    settings.configure(
        ALLOWED_HOSTS=['testserver', 'localhost'],
        INSTALLED_APPS=[
            'django.contrib.contenttypes',
            'django.contrib.staticfiles',
            'magic_sso_django',
        ],
        MAGICSSO_AUTH_EVERYWHERE=False,
        MAGICSSO_COOKIE_DOMAIN=None,
        MAGICSSO_COOKIE_MAX_AGE=None,
        MAGICSSO_COOKIE_NAME='magic-sso',
        MAGICSSO_COOKIE_SAMESITE='Lax',
        MAGICSSO_COOKIE_SECURE=True,
        MAGICSSO_DIRECT_USE=False,
        MAGICSSO_REQUEST_TIMEOUT=5,
        MAGICSSO_JWT_SECRET='jwt-secret-for-tests-only-32-bytes',
        MAGICSSO_PREVIEW_SECRET='preview-secret-for-tests-only-32',
        MAGICSSO_SERVER_URL='http://sso.example.com',
        ROOT_URLCONF='tests.urls',
        SECRET_KEY='test-secret',
        TEMPLATES=[
            {
                'BACKEND': 'django.template.backends.django.DjangoTemplates',
                'APP_DIRS': True,
                'DIRS': [],
                'OPTIONS': {
                    'context_processors': ['django.template.context_processors.request'],
                },
            }
        ],
        USE_TZ=True,
    )
    django.setup()


def pytest_report_header(config: Any) -> str:
    return 'Configured Django test settings for magic_sso_django'
