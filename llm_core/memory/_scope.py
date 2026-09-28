# SPDX-License-Identifier: MIT
"""
llm_core.memory._scope — Résolution des scope-keys et des chemins fichiers.

Un *scope* identifie le périmètre logique d'une mémoire. Deux apps l'utilisent :

  - chat     : scope implicite ``"user"`` → fichiers per-user à la racine de
               ``{sandbox}/{username}/memory/``.
  - agentic  : scope explicite, p.ex. ``"pipeline:42:node:7"`` ou
               ``"team:5:role:reviewer"`` → ``MEMORY.md`` rangé sous
               ``memory/scopes/<sha1(scope)[:12]>/``.

INVARIANT sémantique : ``USER.md`` (profil humain) est TOUJOURS per-user et
global à tous les scopes ; seul ``MEMORY.md`` (notes env/projet) est scope-local.

Primitive pure : aucun import config/DB. ``sandbox_dir`` est injecté.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Tuple

from llm_core.memory._markdown_store import MarkdownStore

# Limites par défaut (façon Hermes). Surchargées par la config si fournie.
DEFAULT_MEMORY_LIMIT = 2200
DEFAULT_USER_LIMIT = 1375

# Sous-dossier per-user du store mémoire, sous ``{sandbox}/{username}/``.
# ``memory`` (et NON l'ancien ``.memory``) : ce dossier est créé par le process
# HÔTE (le serveur MCP, UID 1000) et doit lui appartenir. L'ancien ``.memory``
# avait été chowné en UID 10001 par l'ancien mont (P entier monté sur /work
# AVANT la migration work-subdir) → le hôte ne pouvait plus y créer le fichier
# de lock (« PermissionError … USER.md.lock »). Un dossier frais créé par le
# hôte sous ``P`` (0777) lui appartient → plus de mismatch. Reste hors du mont
# (réservé dans ``shared_infra.sandbox.paths._WORK_RESERVED``) donc invisible au
# container et non supprimable par l'agent.
MEMORY_SUBDIR = "memory"
LEGACY_MEMORY_SUBDIR = ".memory"

# Scope-keys traités comme "per-user racine" (pas de sous-dossier scopes/).
_ROOT_SCOPES = {"", "user", "chat", "default"}


def safe_username(username: "str | None") -> str:
    """Composant de nom de dossier sûr. Même sémantique 'delete' que le sandbox
    (cf. shared_infra.config.safe_sandbox_name) pour pointer le MÊME dossier."""
    if not username:
        return "guest"
    return re.sub(r"[^A-Za-z0-9_-]", "", str(username)) or "guest"


def scope_hash(scope_key: str) -> str:
    return hashlib.sha1(scope_key.encode("utf-8")).hexdigest()[:12]


def resolve_paths(username: "str | None", scope_key: "str | None",
                  sandbox_dir: "str | Path") -> Tuple[Path, Path]:
    """Renvoie ``(memory_md_path, user_md_path)`` pour ce (user, scope).

    ``USER.md`` est per-user (racine) quel que soit le scope. ``MEMORY.md`` est
    à la racine pour le scope chat, sinon sous ``scopes/<hash>/``.
    """
    base = Path(sandbox_dir) / safe_username(username) / MEMORY_SUBDIR
    user_md = base / "USER.md"
    sk = (scope_key or "").strip()
    if sk in _ROOT_SCOPES:
        memory_md = base / "MEMORY.md"
    else:
        memory_md = base / "scopes" / scope_hash(sk) / "MEMORY.md"
    return memory_md, user_md


def store_for(kind: str, username: "str | None", scope_key: "str | None",
              sandbox_dir: "str | Path", *,
              memory_limit: int = DEFAULT_MEMORY_LIMIT,
              user_limit: int = DEFAULT_USER_LIMIT) -> MarkdownStore:
    """Construit le ``MarkdownStore`` pour ``kind`` in ('memory', 'user')."""
    memory_md, user_md = resolve_paths(username, scope_key, sandbox_dir)
    if kind == "user":
        return MarkdownStore(user_md, user_limit, label="USER.md")
    return MarkdownStore(memory_md, memory_limit, label="MEMORY.md")
