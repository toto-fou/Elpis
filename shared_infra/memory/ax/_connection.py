# SPDX-License-Identifier: MIT
"""
AX-memory SQLite plumbing — connection, path resolution, lock.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Depuis le 2026-09-26, ``_conn()`` passe par le pool commun de
``shared_infra.db`` (sauf chemin imposé vers un autre fichier).
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# ───────────────────────────────────────────────────────────────────────────
# Module-level state — owned by this module, mutated by ``set_db_path()``.
# Every other ax_memory submodule that needs to open a connection imports
# ``_conn`` from here, NOT the globals directly.
# ───────────────────────────────────────────────────────────────────────────
_DB_LOCK = threading.Lock()
_DB_PATH: Optional[Path] = None
_RESOLVED_PATH_LOGGED = False  # one-time log guard (per process)


def set_db_path(path: str | Path) -> None:
    global _DB_PATH
    _DB_PATH = Path(path)


def _resolve_db_path() -> Path:
    """Resolve the AX-memory SQLite file to an ABSOLUTE path, identically
    in EVERY process — the FastAPI workers *and* the MCP server subprocess.

    The historical bug this fixes
    -----------------------------
    This used to return a *relative* ``user_db/app.db``, resolved against
    each process's current working directory. The FastAPI process runs
    from PROJECT_ROOT (→ correct file), but the MCP server subprocess —
    which is where ``tools/firefox_tools.py`` and therefore
    ``record_action`` actually run — is launched with a different CWD.
    Result: the recorder wrote AX memory into one file, the renderer read
    from another. AX memory looked "no longer fed" while it was simply
    being written somewhere nobody reads.

    Resolution order (first hit wins); relative paths are anchored on
    PROJECT_ROOT, never on the CWD:
      1. explicit ``set_db_path()`` override
      2. ``AX_MEMORY_DB_PATH`` env var
      3. ``backend.config.DB_PATH`` — the canonical app DB path, already
         PROJECT_ROOT-anchored. Using it guarantees recorder and renderer
         resolve to the very same file.
      4. ``PROJECT_ROOT/user_db/app.db`` as a last-resort fallback
    """
    global _RESOLVED_PATH_LOGGED

    if _DB_PATH is not None:
        resolved = Path(_DB_PATH)
    else:
        # PROJECT_ROOT anchor — cwd-independent. backend/config.py defines
        # PROJECT_ROOT = Path(__file__).resolve().parent.parent ; we mirror
        # that as a fallback if the import itself fails.
        try:
            from shared_infra.config import PROJECT_ROOT as _PROOT
            root = Path(_PROOT)
        except Exception:
            # ``memory/ax/_connection.py`` → trois crans sous la racine.
            root = Path(__file__).resolve().parents[3]

        def _anchor(p) -> Path:
            pp = Path(p)
            return pp if pp.is_absolute() else (root / pp)

        resolved = None

        # 2. explicit env override
        env_p = os.environ.get("AX_MEMORY_DB_PATH")
        if env_p:
            resolved = _anchor(env_p)

        # 3. canonical app DB from backend.config (already absolute)
        if resolved is None:
            try:
                from shared_infra.config import DB_PATH as _CFG_DB_PATH
                if _CFG_DB_PATH:
                    resolved = _anchor(_CFG_DB_PATH)
            except Exception:
                pass

        # 4. last-resort fallback
        if resolved is None:
            resolved = root / "user_db" / "app.db"

    resolved = resolved.resolve()

    if not _RESOLVED_PATH_LOGGED:
        _RESOLVED_PATH_LOGGED = True
        log.info("[ax] SQLite DB resolved to %s (pid=%s)", resolved, os.getpid())

    return resolved


def _forced_path() -> Optional[Path]:
    """Chemin imposé à la mémoire AX (``set_db_path()`` ou
    ``AX_MEMORY_DB_PATH``) quand il désigne un AUTRE fichier que la base de
    l'application ; ``None`` sinon."""
    forced = None
    if _DB_PATH is not None or os.environ.get("AX_MEMORY_DB_PATH"):
        forced = _resolve_db_path()
    if forced is None:
        return None
    try:
        from shared_infra.db import _connection as _dbc
        if Path(_dbc.DB_PATH).resolve() == forced:
            return None
    except Exception:
        pass
    return forced


@contextmanager
def _conn():
    """Connexion de la mémoire AX, en autocommit (chaque écriture est validée
    aussitôt).

    (2026-09-26) Par défaut, la base commune par le pool de l'application
    (``db_autocommit()``) au lieu d'une connexion SQLite ouverte à chaque
    appel avec ses propres réglages : condition pour pouvoir changer de moteur
    de base. Un chemin IMPOSÉ vers un autre fichier (``set_db_path()``,
    ``AX_MEMORY_DB_PATH`` — usage des tests isolés) garde une connexion
    SQLite dédiée.
    """
    forced = _forced_path()
    if forced is None:
        from shared_infra.db._connection import db_autocommit
        with db_autocommit() as con:
            yield con
        return
    forced.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(forced), timeout=10.0, isolation_level=None)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.execute("PRAGMA foreign_keys=ON")
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()
