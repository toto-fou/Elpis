# SPDX-License-Identifier: MIT
"""
0005_notifications_table — Crée la table ``notifications`` (centre de notifications).

Feature « Notifications & Inbox » : une notification par utilisateur, produite par
une source backend (v1 : fin de run de routine, succès/échec) et poussée en temps
réel via le bus SSE. Schéma générique (``kind`` + ``ref_type``/``ref_id``) pour
accueillir d'autres sources plus tard.

CRUD : ``shared_infra/notifications/store.py``. Idempotent (``IF NOT EXISTS``).
Ne commit PAS : le runner de migrations commit en fin d'application.
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS notifications (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER NOT NULL,
            kind          TEXT NOT NULL,
            title         TEXT NOT NULL,
            body          TEXT DEFAULT '',
            ref_type      TEXT DEFAULT '',
            ref_id        INTEGER,
            read_at       REAL,
            created_at    REAL NOT NULL,
            FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    # Sert le listing (owner + tri created_at) et le comptage des non-lus
    # (owner + read_at IS NULL).
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_notif_user_unread "
        "ON notifications(owner_user_id, read_at, created_at)"
    )
