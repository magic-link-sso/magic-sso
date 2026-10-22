# SPDX-License-Identifier: MIT
"""Only the HTTPS fixture processes resolve the reserved test names locally."""

import os
import socket
import sys
from pathlib import Path
from typing import Literal
from unittest.mock import patch

from django.core.management import execute_from_command_line

# Running a script outside the example otherwise removes its project from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'examples/django'))
original_getaddrinfo = socket.getaddrinfo
hosts: set[str] = {
    'sso.identity.test',
    'app.alpha.test',
    'app.beta.test',
    'app.next.test',
    'app.nuxt.test',
    'app.django.test',
    'app.angular.test',
    'app.fastify.test',
    'app.compat.test',
}


type AddressInfo = (
    tuple[
        Literal[socket.AddressFamily.AF_INET],
        socket.SocketKind,
        int,
        str,
        tuple[str, int],
    ]
    | tuple[
        Literal[socket.AddressFamily.AF_INET6],
        socket.SocketKind,
        int,
        str,
        tuple[str, int, int, int] | tuple[int, bytes],
    ]
)


def lookup(
    host: str | bytes | None,
    port: str | bytes | int | None,
    family: int = 0,
    type: int = 0,
    proto: int = 0,
    flags: int = 0,
) -> list[AddressInfo]:
    return original_getaddrinfo(
        '127.0.0.1' if host in hosts else host, port, family, type, proto, flags
    )


with patch('socket.getaddrinfo', side_effect=lookup):
    execute_from_command_line(
        ['django', 'runserver', f'127.0.0.1:{os.environ["PORT"]}', '--noreload']
    )
