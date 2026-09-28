# SPDX-License-Identifier: MIT
"""
0014_usage_thinking_tokens — La réflexion sort du total « sortie ».

Problème résolu
===============
``usage_events`` ne connaissait que ``input_tokens`` / ``output_tokens``. Or
aucun backend ne sépare le raisonnement du reste : ``completion_tokens`` de
llama.cpp additionne le thinking, les appels d'outils et la réponse visible.
Sur un modèle « thinking », la majorité d'un tour peut donc partir en
raisonnement sans qu'aucune vue — ni l'onglet Utilisation, ni la zone Métriques
— ne puisse le dire. « Pourquoi ce tour a-t-il coûté 8 000 tokens de sortie ? »
n'avait pas de réponse.

Cette colonne porte la part de raisonnement du tour, mesurée dans la boucle
(``llm_core._think_tokens`` : déclarée par le backend quand il le fait, sinon
``/tokenize`` exact en local, sinon estimée au ratio mesuré).

Invariant
=========
``thinking_tokens`` est un SOUS-ENSEMBLE de ``output_tokens`` — jamais un
troisième terme à additionner. « Réponse » se dérive :
``output_tokens - thinking_tokens``. Les vues qui somment ``input + output``
restent donc justes sans modification.

Pas de backfill : l'historique n'a jamais porté l'information, et l'inventer
depuis un texte de raisonnement qui n'est pas persisté (``save_chat`` strippe
``thinking``) serait de la fiction. Les lignes antérieures gardent 0 —
c'est-à-dire « non mesuré », visuellement indistinct de « n'a pas raisonné »,
ce qui est acceptable : la colonne démarre avec le registre qui l'alimente.

Idempotent. Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

import sqlite3


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return False
    return any((r[1] if not isinstance(r, sqlite3.Row) else r["name"]) == column
               for r in rows)


def migrate(conn: sqlite3.Connection) -> None:
    if not _has_column(conn, "usage_events", "thinking_tokens"):
        conn.execute(
            "ALTER TABLE usage_events "
            "ADD COLUMN thinking_tokens INTEGER NOT NULL DEFAULT 0"
        )
