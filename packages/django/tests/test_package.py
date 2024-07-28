#
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from pathlib import Path
import tomllib
from typing import TypedDict

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import override_settings

from magic_sso_django.apps import MagicSsoConfig, validate_magic_sso_settings


class ProjectUrls(TypedDict):
    Repository: str
    Issues: str


class ProjectMetadata(TypedDict):
    readme: str
    keywords: list[str]
    classifiers: list[str]
    urls: ProjectUrls


def expect_string(value: object, field_name: str) -> str:
    assert isinstance(value, str), f'{field_name} must be a string'
    return value


def expect_string_list(value: object, field_name: str) -> list[str]:
    assert isinstance(value, list), f'{field_name} must be a list'
    assert all(isinstance(item, str) for item in value), f'{field_name} must contain strings'
    return [item for item in value if isinstance(item, str)]


def read_project_metadata() -> ProjectMetadata:
    pyproject_path = Path(__file__).resolve().parents[1] / 'pyproject.toml'
    with pyproject_path.open('rb') as pyproject_file:
        pyproject = tomllib.load(pyproject_file)

    project = pyproject.get('project')
    assert isinstance(project, dict), 'pyproject.toml must contain a [project] table'

    urls = project.get('urls')
    assert isinstance(urls, dict), 'pyproject.toml must contain a [project.urls] table'

    return {
        'readme': expect_string(project.get('readme'), 'project.readme'),
        'keywords': expect_string_list(project.get('keywords'), 'project.keywords'),
        'classifiers': expect_string_list(project.get('classifiers'), 'project.classifiers'),
        'urls': {
            'Repository': expect_string(urls.get('Repository'), 'project.urls.Repository'),
            'Issues': expect_string(urls.get('Issues'), 'project.urls.Issues'),
        },
    }


def test_app_config_name() -> None:
    assert MagicSsoConfig.name == 'magic_sso_django'


def test_validate_magic_sso_settings_accepts_valid_configuration() -> None:
    validate_magic_sso_settings()


def test_pyproject_includes_publish_metadata() -> None:
    project = read_project_metadata()

    assert project['readme'] == 'README.md'
    assert project['keywords'] == ['auth', 'django', 'jwt', 'magic-link', 'sso']

    classifiers = project['classifiers']
    assert 'Framework :: Django' in classifiers
    assert 'License :: OSI Approved :: MIT License' not in classifiers

    urls = project['urls']
    assert urls['Repository'] == 'https://github.com/magic-link-sso/magic-sso'
    assert urls['Issues'] == 'https://github.com/magic-link-sso/magic-sso/issues'


@override_settings(MAGICSSO_JWT_SECRET='')
def test_validate_magic_sso_settings_rejects_blank_jwt_secret() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_JWT_SECRET'):
        validate_magic_sso_settings()


@override_settings(MAGICSSO_PREVIEW_SECRET='')
def test_validate_magic_sso_settings_rejects_blank_preview_secret() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_PREVIEW_SECRET'):
        validate_magic_sso_settings()


@override_settings(MAGICSSO_SERVER_URL='')
def test_validate_magic_sso_settings_rejects_blank_server_url() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_SERVER_URL'):
        validate_magic_sso_settings()


@override_settings(MAGICSSO_COOKIE_NAME='')
def test_validate_magic_sso_settings_rejects_blank_cookie_name() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_COOKIE_NAME'):
        validate_magic_sso_settings()


@override_settings(MAGICSSO_COOKIE_SAMESITE='sideways')
def test_validate_magic_sso_settings_rejects_invalid_cookie_samesite() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_COOKIE_SAMESITE'):
        validate_magic_sso_settings()


@override_settings(MAGICSSO_COOKIE_PATH='auth')
def test_validate_magic_sso_settings_rejects_invalid_cookie_path() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_COOKIE_PATH'):
        validate_magic_sso_settings()


@override_settings(MAGICSSO_PUBLIC_ORIGIN='not-a-url')
def test_validate_magic_sso_settings_rejects_invalid_public_origin() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_PUBLIC_ORIGIN'):
        validate_magic_sso_settings()


@override_settings(
    USE_X_FORWARDED_HOST=True, MAGICSSO_TRUST_PROXY=False, MAGICSSO_PUBLIC_ORIGIN=None
)
def test_validate_magic_sso_settings_requires_public_origin_for_untrusted_forwarded_host() -> None:
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_PUBLIC_ORIGIN'):
        validate_magic_sso_settings()


@override_settings(
    MAGICSSO_TRUST_PROXY=True, MAGICSSO_PUBLIC_ORIGIN=None, MAGICSSO_ALLOWED_ORIGINS=[]
)
def test_validate_magic_sso_settings_requires_allowlist_or_public_origin_for_trusted_proxy() -> (
    None
):
    with pytest.raises(ImproperlyConfigured, match='MAGICSSO_ALLOWED_ORIGINS'):
        validate_magic_sso_settings()
