# SPDX-License-Identifier: MIT
"""
0019_llm_connector_engine_limits — Fenêtre et capacité d'un serveur connecteur.

AUDIT 2026-09-16 — un connecteur llama.cpp reçoit désormais les mécanismes du
serveur intégré (file et ordonnancement, fenêtre de contexte, épinglage de
slot). Il lui faut les réglages que l'intégré lit dans ``config.json``
(``llama.max_models``, ``llama.max_concurrency``) et une fenêtre de contexte
déclarable (``_ctx_window._from_connector`` la cherchait sans qu'aucune
colonne n'existe) :

  - ``context_window``  : tokens par requête ; NULL = découverte (``/props``
                          du serveur, sinon famille connue / défaut fournisseur) ;
  - ``max_models``      : modèles simultanés en mémoire ; NULL = découverte
                          (``max_instances`` du routeur), sinon 1 ;
  - ``max_concurrency`` : requêtes simultanées par modèle ; NULL = découverte
                          (``total_slots``), sinon 1.

Idempotent (colonnes ajoutées seulement si absentes). Ne commit PAS.
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(llm_connectors)").fetchall()}
    if not cols:
        return                          # table absente : rien à migrer (base partielle de test)
    for name in ("context_window", "max_models", "max_concurrency"):
        if name not in cols:
            conn.execute(f"ALTER TABLE llm_connectors ADD COLUMN {name} INTEGER")
