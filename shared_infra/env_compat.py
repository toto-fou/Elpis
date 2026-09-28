# SPDX-License-Identifier: MIT
"""shared_infra.env_compat — lecture des variables d'environnement ``ELPIS_*``
et de l'en-tête du jeton elpis-remote.

Module SANS dépendance (ni ``shared_infra.config`` ni rien d'autre) : il est
importé très tôt, y compris par des modules que ``config`` importe lui-même.
"""
from __future__ import annotations

import os
from typing import Optional


def env(name: str, default: Optional[str] = None) -> Optional[str]:
    """``os.environ.get(name, default)``."""
    return os.environ.get(name, default)


# En-tête du jeton envoyé par le greffon opencode et l'installeur.
TOKEN_HEADER = "x-elpis-token"


def token_header(headers) -> str:
    """Jeton porté par ``x-elpis-token``, ou ""."""
    return (headers.get(TOKEN_HEADER) or "").strip()
