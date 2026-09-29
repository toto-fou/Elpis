# SPDX-License-Identifier: MIT
"""llm_core.memory._migrate — Relocalisation best-effort de l'ancien store.

Avant 2026-06-30 le store per-user vivait dans ``{sandbox}/{username}/.memory``.
Ce dossier avait été chowné en UID 10001 par l'ancien mont (P entier monté sur
``/work`` AVANT la migration work-subdir) → le serveur MCP hôte (UID 1000) ne
pouvait plus y créer le fichier de lock (« PermissionError … USER.md.lock »).

On bascule vers ``{sandbox}/{username}/memory`` (créé frais par l'hôte → lui
appartient, plus de mismatch). Cette migration copie le contenu existant une
seule fois. Idempotente et best-effort : ne lève JAMAIS.
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

from llm_core.memory._scope import (
    LEGACY_MEMORY_SUBDIR,
    MEMORY_SUBDIR,
    safe_username,
)

logger = logging.getLogger("uvicorn.error")


def migrate_legacy_memory(sandbox_dir: "str | Path", username: "str | None") -> Path:
    """Assure ``{sandbox}/{username}/memory`` et migre l'ancien ``.memory`` une
    fois. Renvoie le chemin du nouveau dossier (best-effort, ne lève jamais).

    L'hôte (UID 1000) peut LIRE l'ancien dossier (``.memory`` est 0775, o+r) et
    ÉCRIRE le neuf (qu'il crée → il en est propriétaire), donc ``copytree``
    recrée le contenu en ownership hôte sans avoir besoin de root.
    """
    base = Path(sandbox_dir) / safe_username(username)
    new = base / MEMORY_SUBDIR
    old = base / LEGACY_MEMORY_SUBDIR
    if new.exists():
        return new
    try:
        has_legacy = old.is_dir() and any(old.iterdir())
    except OSError:
        has_legacy = False
    try:
        if has_legacy:
            shutil.copytree(old, new)        # dest absent (vérifié ci-dessus)
            logger.info("[memory] store migré %s → %s", old, new)
        else:
            new.mkdir(parents=True, exist_ok=True)
    except Exception as e:                    # pragma: no cover - best-effort
        logger.warning("[memory] migration legacy KO (%s) : %s", old, e)
        try:
            new.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
    return new
