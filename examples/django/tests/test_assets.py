# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

import importlib.util
from pathlib import Path

from types import ModuleType


SETTINGS_PATH = Path(__file__).resolve().parents[1] / 'app' / 'settings.py'


def load_settings_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location('test_app_settings_assets', SETTINGS_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError('Failed to load example Django settings module')

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_home_template_references_shared_badge() -> None:
    home_template = Path('hello/templates/home.html').read_text()

    assert 'signin-page-badge.svg' in home_template
    assert "{% url 'protected1' %}" in home_template
    assert "{% url 'protected2' %}" in home_template
    assert 'max-width: 1024px;' in home_template
    assert 'grid-template-columns: 144px minmax(0, 1fr);' in home_template
    assert 'Signed in as <b>{{ email }}</b>.' in home_template


def test_protected_template_references_shared_badge() -> None:
    protected_template = Path('hello/templates/protected.html').read_text()

    assert 'protected-page-badge.svg' in protected_template
    assert "{% url 'protected1' %}" in protected_template
    assert "{% url 'protected2' %}" in protected_template
    assert 'max-width: 1024px;' in protected_template
    assert 'grid-template-columns: 144px minmax(0, 1fr);' in protected_template
    assert 'Your Django session is locked in and verified.' in protected_template
    assert 'Next Steps' in protected_template


def test_django_shared_protected_badge_matches_nextjs_example() -> None:
    django_badge = Path('hello/static/protected-page-badge.svg').read_text()
    next_badge = Path('../nextjs/public/protected-page-badge.svg').read_text()

    assert django_badge == next_badge


def test_django_shared_signin_badge_matches_nextjs_example() -> None:
    django_badge = Path('hello/static/signin-page-badge.svg').read_text()
    next_badge = Path('../nextjs/public/signin-page-badge.svg').read_text()

    assert django_badge == next_badge


def test_static_configuration_serves_example_assets() -> None:
    settings_module = load_settings_module()

    assert 'hello' in settings_module.INSTALLED_APPS
    assert settings_module.STATIC_URL == '/static/'
