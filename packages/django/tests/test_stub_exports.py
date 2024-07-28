# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from pathlib import Path


def _get_declared_functions(path: Path) -> set[str]:
    declared_functions: set[str] = set()

    for line in path.read_text().splitlines():
        stripped_line = line.strip()
        if stripped_line.startswith('def '):
            function_name = stripped_line.removeprefix('def ').split('(', maxsplit=1)[0]
            declared_functions.add(function_name)

    return declared_functions


def test_auth_utils_stub_declares_public_helpers() -> None:
    stub_path = Path(__file__).resolve().parent.parent / 'magic_sso_django' / 'auth_utils.pyi'

    declared_functions = _get_declared_functions(stub_path)

    assert {'is_authenticated', 'redirect_to_login'} <= declared_functions


def test_views_stub_declares_public_view_helpers() -> None:
    stub_path = Path(__file__).resolve().parent.parent / 'magic_sso_django' / 'views.pyi'

    declared_functions = _get_declared_functions(stub_path)

    assert {
        'get_magic_sso_cookie_samesite',
        'get_magic_sso_cookie_options',
        'get_default_return_url',
        'normalise_return_url',
        'build_verify_url',
        'normalise_scope',
        'login',
        'logout',
        'verify_token',
    } <= declared_functions
