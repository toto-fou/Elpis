# SPDX-License-Identifier: MIT
"""Ressources du moteur PowerPoint : déléguées à ``office.paquet.charger`` (sandbox seule)."""
from __future__ import annotations

from ..paquet import charger


def load_bytes(source: str, what: str = "file", **_ignore) -> bytes:
    return charger(source, what)
