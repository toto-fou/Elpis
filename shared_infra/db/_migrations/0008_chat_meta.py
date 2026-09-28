# SPDX-License-Identifier: MIT
"""
0008_chat_meta — Colonne ``meta_json`` sur ``chats`` (réglages par-chat).

Évolution « toggles d'outils mémorisés par chat » : les catégories d'outils
locales activées (panneau Outils) étaient globales à la session — en switchant
de chat il fallait tout réactiver. On range désormais les préférences PAR CHAT
dans un JSON extensible (``{"tools": ["fs", "shell"]}`` aujourd'hui ; d'autres
réglages par-chat pourront s'y loger).

CRUD : ``shared_infra/chat/store.py`` (``get_chat`` expose ``tools``,
``set_chat_tools`` écrit). Idempotent via inspection de ``pragma table_info``.
Ne commit PAS : le runner de migrations commit en fin d'application.
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(chats)").fetchall()}
    if "meta_json" not in cols:
        cur.execute("ALTER TABLE chats ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'")
