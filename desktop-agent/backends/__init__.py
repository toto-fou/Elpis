# SPDX-License-Identifier: MIT
"""Backend selection by platform."""
from __future__ import annotations

import platform

from .base import DesktopBackend, NotSupported  # noqa: F401 (re-exported)


def get_backend() -> DesktopBackend:
    sysname = platform.system().lower()
    if sysname.startswith("win"):
        from .windows import WindowsBackend
        return WindowsBackend()
    from .linux import LinuxBackend
    return LinuxBackend()
