# SPDX-License-Identifier: MIT
"""
shared_infra.git.askpass — Injection SÛRE de credentials HTTPS via GIT_ASKPASS.

Extrait de ``shared_infra.routes._helpers._git_run_with_creds`` pour être partagé
par le chemin MCP (``git_tools``) ET les routes. Le token transite UNIQUEMENT par
une variable d'environnement lue par un script askpass STATIQUE — jamais par
``argv``, ni ``.git/config``, ni une URL ``user:token@host`` (qui fuiraient dans
``ps``/les logs). ``subprocess`` tourne ``shell=False`` → zéro expansion shell.
"""
from __future__ import annotations

import os
import tempfile
from contextlib import contextmanager
from typing import Dict, Iterator

_CTRL = ("\x00", "\n", "\r")

# Corps STATIQUE : il LIT $GIT_ASKPASS_USER/$GIT_ASKPASS_PASS, ne les évalue pas.
_ASKPASS_BODY = (
    '#!/bin/sh\n'
    'case "$1" in\n'
    '  *[Uu]ser*) printf %s "$GIT_ASKPASS_USER" ;;\n'
    '  *[Pp]ass*) printf %s "$GIT_ASKPASS_PASS" ;;\n'
    'esac\n'
)


class AskpassError(ValueError):
    """username/token contient un caractère de contrôle (casse le protocole askpass)."""


@contextmanager
def git_askpass_env(username: str, token: str) -> Iterator[Dict[str, str]]:
    """Yield un ``env_extra`` portant les credentials (ou ``{}`` si absents),
    nettoie le script temporaire en sortie.

    Lève ``AskpassError`` si username/token contient ``\\x00``/``\\n``/``\\r``.
    """
    env_extra: Dict[str, str] = {}
    askpass_file = None
    # Le TOKEN suffit à déclencher l'injection : un PAT (GitHub/Gitea…) fonctionne
    # avec n'importe quel username. Si le login est vide, on met le token comme
    # username (forme portable ``<token>:<token>`` acceptée par GitHub/Gitea…).
    if token:
        user = username or token
        if any(c in user for c in _CTRL):
            raise AskpassError("control character in username")
        if any(c in token for c in _CTRL):
            raise AskpassError("control character in token")
        fd, askpass_file = tempfile.mkstemp(prefix="git_askpass_", suffix=".sh")
        with os.fdopen(fd, "w") as f:
            f.write(_ASKPASS_BODY)
        os.chmod(askpass_file, 0o700)
        env_extra = {
            "GIT_ASKPASS": askpass_file,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS_USER": user,
            "GIT_ASKPASS_PASS": token,
        }
    try:
        yield env_extra
    finally:
        if askpass_file:
            try:
                os.unlink(askpass_file)
            except Exception:
                pass
