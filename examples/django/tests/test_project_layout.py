# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Wojciech Polak

from pathlib import Path


def test_manage_py_exists() -> None:
    assert Path('manage.py').exists()


def test_dotenv_example_exists() -> None:
    assert Path('.env.example').exists()
