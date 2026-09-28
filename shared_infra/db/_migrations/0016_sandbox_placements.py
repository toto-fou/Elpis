# SPDX-License-Identifier: MIT
"""
0016_sandbox_placements — placement des comptes sur les hôtes d'outils (P5).

Quand ``mcp.json › placement.strategy`` vaut ``by_user``, chaque compte est
AFFECTÉ à un hôte de ``sandboxHosts`` (toutes ses familles d'outils, son
sandbox, son terminal sur le même hôte). L'affectation doit SURVIVRE : c'est
elle qui dit où vivent les fichiers de l'utilisateur.

    sandbox_placements(user_id PK, host_id, created_at, updated_at)

Pas de clé étrangère (la table ``users`` est purgée par ailleurs ; une ligne
orpheline est inerte). Idempotent. Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sandbox_placements (
            user_id    INTEGER PRIMARY KEY,
            host_id    TEXT    NOT NULL,
            created_at REAL    NOT NULL,
            updated_at REAL    NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sandbox_placements_host ON sandbox_placements(host_id)"
    )
