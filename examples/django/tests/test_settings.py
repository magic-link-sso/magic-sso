# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

SETTINGS_PATH = Path(__file__).resolve().parents[1] / 'app' / 'settings.py'


def load_settings_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location('test_app_settings', SETTINGS_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError('Failed to load example Django settings module')

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_example_settings_use_localhost_demo_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv('DJANGO_ALLOWED_HOSTS', raising=False)
    monkeypatch.delenv('DJANGO_DEBUG', raising=False)
    monkeypatch.delenv('DJANGO_SECRET_KEY', raising=False)
    monkeypatch.delenv('MAGICSSO_COOKIE_SECURE', raising=False)
    monkeypatch.delenv('MAGICSSO_PREVIEW_SECRET', raising=False)

    reloaded_settings = load_settings_module()

    assert reloaded_settings.DEBUG is True
    assert reloaded_settings.SECRET_KEY == reloaded_settings.DEVELOPMENT_SECRET_KEY
    assert reloaded_settings.ALLOWED_HOSTS == ['localhost', '127.0.0.1']
    assert reloaded_settings.MAGICSSO_COOKIE_SECURE is False
    assert reloaded_settings.MAGICSSO_JWT_SECRET == 'VERY-VERY-LONG-RANDOM-JWT-SECRET'
    assert reloaded_settings.MAGICSSO_PREVIEW_SECRET == 'VERY-VERY-LONG-RANDOM-PREVIEW-SECRET'


def test_magic_sso_settings_support_environment_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('DJANGO_ALLOWED_HOSTS', 'app.example.com')
    monkeypatch.setenv('DJANGO_DEBUG', 'false')
    monkeypatch.setenv('DJANGO_SECRET_KEY', 'example-secret')
    monkeypatch.setenv('MAGICSSO_AUTH_EVERYWHERE', 'true')
    monkeypatch.setenv('MAGICSSO_COOKIE_DOMAIN', '.example.com')
    monkeypatch.setenv('MAGICSSO_COOKIE_MAX_AGE', '3600')
    monkeypatch.setenv('MAGICSSO_COOKIE_NAME', 'custom-cookie')
    monkeypatch.setenv('MAGICSSO_COOKIE_PATH', '/auth')
    monkeypatch.setenv('MAGICSSO_COOKIE_SAMESITE', 'Strict')
    monkeypatch.setenv('MAGICSSO_COOKIE_SECURE', 'true')
    monkeypatch.setenv('MAGICSSO_DIRECT_USE', 'false')
    monkeypatch.setenv('MAGICSSO_JWT_SECRET', 'env-secret')
    monkeypatch.setenv('MAGICSSO_PREVIEW_SECRET', 'preview-env-secret')
    monkeypatch.setenv('MAGICSSO_PUBLIC_URLS', 'login,healthz')
    monkeypatch.setenv('MAGICSSO_REQUEST_TIMEOUT', '12')
    monkeypatch.setenv('MAGICSSO_SERVER_URL', 'https://sso.example.com')

    reloaded_settings = load_settings_module()

    assert reloaded_settings.ALLOWED_HOSTS == ['app.example.com']
    assert reloaded_settings.DEBUG is False
    assert reloaded_settings.SECRET_KEY == 'example-secret'
    assert reloaded_settings.MAGICSSO_AUTH_EVERYWHERE is True
    assert reloaded_settings.MAGICSSO_COOKIE_DOMAIN == '.example.com'
    assert reloaded_settings.MAGICSSO_COOKIE_MAX_AGE == 3600
    assert reloaded_settings.MAGICSSO_COOKIE_NAME == 'custom-cookie'
    assert reloaded_settings.MAGICSSO_COOKIE_PATH == '/auth'
    assert reloaded_settings.MAGICSSO_COOKIE_SAMESITE == 'Strict'
    assert reloaded_settings.MAGICSSO_COOKIE_SECURE is True
    assert reloaded_settings.MAGICSSO_DIRECT_USE is False
    assert reloaded_settings.MAGICSSO_JWT_SECRET == 'env-secret'
    assert reloaded_settings.MAGICSSO_PREVIEW_SECRET == 'preview-env-secret'
    assert reloaded_settings.MAGICSSO_PUBLIC_URLS == ['login', 'healthz']
    assert reloaded_settings.MAGICSSO_REQUEST_TIMEOUT == 12
    assert reloaded_settings.MAGICSSO_SERVER_URL == 'https://sso.example.com'


def test_magic_sso_settings_load_values_from_dotenv_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    dotenv_path = tmp_path / '.env'
    dotenv_path.write_text(
        '\n'.join(
            [
                'MAGICSSO_DIRECT_USE=false',
                'MAGICSSO_SERVER_URL=https://dotenv.example.com',
                'MAGICSSO_PREVIEW_SECRET=dotenv-preview-secret',
                'MAGICSSO_COOKIE_NAME=dotenv-cookie',
            ]
        ),
        encoding='utf-8',
    )
    monkeypatch.setenv('MAGICSSO_DOTENV_PATH', str(dotenv_path))
    monkeypatch.delenv('MAGICSSO_DIRECT_USE', raising=False)
    monkeypatch.delenv('MAGICSSO_SERVER_URL', raising=False)
    monkeypatch.delenv('MAGICSSO_COOKIE_NAME', raising=False)
    monkeypatch.delenv('MAGICSSO_PREVIEW_SECRET', raising=False)

    reloaded_settings = load_settings_module()

    assert reloaded_settings.MAGICSSO_DIRECT_USE is False
    assert reloaded_settings.MAGICSSO_SERVER_URL == 'https://dotenv.example.com'
    assert reloaded_settings.MAGICSSO_PREVIEW_SECRET == 'dotenv-preview-secret'
    assert reloaded_settings.MAGICSSO_COOKIE_NAME == 'dotenv-cookie'


def test_magic_sso_settings_prefer_environment_over_dotenv_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    dotenv_path = tmp_path / '.env'
    dotenv_path.write_text('MAGICSSO_DIRECT_USE=false\n', encoding='utf-8')
    monkeypatch.setenv('MAGICSSO_DOTENV_PATH', str(dotenv_path))
    monkeypatch.setenv('MAGICSSO_DIRECT_USE', 'true')

    reloaded_settings = load_settings_module()

    assert reloaded_settings.MAGICSSO_DIRECT_USE is True


def test_magic_sso_settings_reject_invalid_boolean_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('MAGICSSO_COOKIE_SECURE', 'maybe')

    with pytest.raises(ValueError, match='MAGICSSO_COOKIE_SECURE'):
        load_settings_module()


def test_magic_sso_settings_reject_invalid_cookie_samesite_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('MAGICSSO_COOKIE_SAMESITE', 'Invalid')

    with pytest.raises(ValueError, match='MAGICSSO_COOKIE_SAMESITE'):
        load_settings_module()


def test_magic_sso_settings_reject_invalid_cookie_path_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('MAGICSSO_COOKIE_PATH', 'auth')

    with pytest.raises(ValueError, match='MAGICSSO_COOKIE_PATH'):
        load_settings_module()


def test_example_settings_require_a_secret_key_when_debug_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('DJANGO_DEBUG', 'false')
    monkeypatch.setenv('DJANGO_ALLOWED_HOSTS', 'app.example.com')
    monkeypatch.setenv('DJANGO_SECRET_KEY', '   ')

    with pytest.raises(ValueError, match='DJANGO_SECRET_KEY'):
        load_settings_module()


def test_example_settings_require_allowed_hosts_when_debug_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('DJANGO_DEBUG', 'false')
    monkeypatch.setenv('DJANGO_SECRET_KEY', 'example-secret')
    monkeypatch.delenv('DJANGO_ALLOWED_HOSTS', raising=False)

    with pytest.raises(ValueError, match='DJANGO_ALLOWED_HOSTS'):
        load_settings_module()
