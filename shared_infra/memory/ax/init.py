# SPDX-License-Identifier: MIT
"""shared_infra/memory/ax/init.py — mise à niveau des anciennes tables de la mémoire AX, appelée par ``init_db`` sur une base SQLite existante."""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def upgrade_legacy_sqlite(c) -> None:
    """Met à niveau les anciennes formes des tables AX (SQLite seulement : une
    base PostgreSQL naît toujours du schéma de référence).

    * v1 -> v2 : une vieille ``ax_nodes`` (colonne ``selector_json``) est
      renommée ``ax_nodes_v1_backup`` ; la v2 est créée à côté et l'arbre
      repart vierge.
    * ``ax_credentials`` sans propriétaire (clé ``site`` seul) : supprimée,
      ses lignes n'étaient plus lues par personne.
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
        # Lignes sans propriétaire : déjà inertes (jamais réattribuées) ; le coffre du core remplace la table.
        _n = c.execute("SELECT COUNT(*) AS n FROM ax_credentials").fetchone()["n"]
        c.execute("DROP TABLE ax_credentials")
        if _n:
            log.warning("[ax] %d identifiant(s) sans proprietaire supprime(s).", _n)
