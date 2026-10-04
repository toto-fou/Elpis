# SPDX-License-Identifier: MIT
"""Modèles : un fichier de la sandbox (.docx/.dotx/macro), normalisé par ``office.paquet``."""
from __future__ import annotations

from typing import List, Optional, Tuple

from ..paquet import charger, normaliser


def load(source: str) -> Tuple[bytes, List[str], Optional[str]]:
    blob, notes = normaliser(charger(source, "template"), "docx", "template")
    return blob, notes, None
