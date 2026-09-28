# SPDX-License-Identifier: MIT
"""
AX-memory database initialisation (idempotent table creation).

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Depuis le 2026-09-26, le DDL vient du schéma de référence de ``shared_infra.db``.
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

from shared_infra.memory.ax._connection import _conn, _resolve_db_path
from shared_infra.db._dialect import SQLITE, dialect_of
from shared_infra.db._schema import TABLES_BY_NAME, create_table_sql, ensure_tables


_AX_TABLES = ("ax_nodes", "ax_selectors", "ax_transitions", "ax_credentials")


def upgrade_legacy_sqlite(c) -> None:
    """Met à niveau les anciennes formes des tables AX (SQLite seulement : une
    base PostgreSQL ou MySQL naît toujours du schéma de référence).

    * v1 -> v2 : une vieille ``ax_nodes`` (colonne ``selector_json``) est
      renommée ``ax_nodes_v1_backup`` ; la v2 est créée à côté et l'arbre
      repart vierge.
    * AUDIT 2026-08-23 — ``ax_credentials`` sans propriétaire : la clé était
      ``site`` SEUL, un couple enregistré par un compte était réinjecté dans
      la session d'un autre. Les lignes existantes sont CONSERVÉES avec
      ``owner=''`` — donc invisibles à tout le monde (fail-closed) : les
      réattribuer serait exactement la fuite qu'on corrige.
    """
    row = c.execute("""
        SELECT sql FROM sqlite_master WHERE type='table' AND name='ax_nodes'
    """).fetchone()
    if row and "selector_json" in (row["sql"] or ""):
        log.warning("[ax] v1 schema detected, backing up to ax_nodes_v1_backup")
        c.execute("ALTER TABLE ax_nodes RENAME TO ax_nodes_v1_backup")

    _cred_row = c.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' "
        "AND name='ax_credentials'").fetchone()
    _cred_sql = (_cred_row["sql"] if _cred_row else "") or ""
    if _cred_sql and "owner" not in _cred_sql:
        _n = c.execute("SELECT COUNT(*) AS n FROM ax_credentials").fetchone()["n"]
        c.execute("ALTER TABLE ax_credentials RENAME TO ax_credentials_preowner")
        c.execute(create_table_sql(TABLES_BY_NAME["ax_credentials"], SQLITE))
        c.execute("""
            INSERT INTO ax_credentials
                (owner, site, username, password, last_ok, use_count)
            SELECT '', site, username, password, last_ok, use_count
              FROM ax_credentials_preowner
        """)
        c.execute("DROP TABLE ax_credentials_preowner")
        if _n:
            log.warning(
                "[ax] %d identifiant(s) herite(s) sans proprietaire : plus "
                "reinjecte(s) (on ignore a qui ils appartenaient). "
                "A re-enregistrer via pw_session(action='start', "
                "username=..., password=...).", _n)


def init_db() -> None:
    """Crée les tables AX (nœuds, sélecteurs, transitions, identifiants) si
    elles manquent. Idempotent.

    (2026-09-26) Le DDL vient du schéma de référence
    (``shared_infra/db/_schema.py``) ; seules les mises à niveau d'anciennes
    formes SQLite restent ici (``upgrade_legacy_sqlite``).
    """
    with _conn() as c:
        if dialect_of(c) == SQLITE:
            upgrade_legacy_sqlite(c)
        ensure_tables(c, _AX_TABLES)
    log.info("[ax] init_db OK at %s", _resolve_db_path())
