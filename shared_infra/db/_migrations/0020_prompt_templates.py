# SPDX-License-Identifier: MIT
"""
0020_prompt_templates — Templates de prompt par utilisateur (2026-09-21).

Un template = un raccourci (``name``, appelé par ``/template <name>`` dans le
chat), un titre et un contenu à variables ``{{…}}`` (syntaxe Open WebUI /
LibreChat, cf. docs/templates-prompt-design-2026-09-21.md). Distinct de
``saved_prompts`` (extraits de conversation sans raccourci ni variables).

``name`` unique PAR compte ; la ligne part avec le compte (cascade).
CRUD : ``shared_infra/chat/prompt_templates_store.py``. Idempotent. Ne commit PAS.
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS prompt_templates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            name        TEXT NOT NULL,
            title       TEXT NOT NULL,
            content     TEXT NOT NULL,
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL,
            UNIQUE(user_id, name),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_prompt_templates_user "
                "ON prompt_templates(user_id)")
