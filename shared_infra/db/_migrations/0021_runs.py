# SPDX-License-Identifier: MIT
"""
0021_runs — Exécutions et compteurs d'observabilité fiables (L5, 2026-09-29).

Ajoute :

* la table ``runs`` : une ligne par exécution (tour de chat, run de routine,
  sous-agent, compaction manuelle) — jetons, temps LLM, appels d'outils,
  fichiers modifiés, pics CPU/RAM de la sandbox, statut final
  (``shared_infra/observability/runs.py``) ;
* ``usage_events.run_id`` : l'exécution à laquelle rattacher un tour ;
* ``tool_call_metrics`` : ``call_id``, ``started_at``, ``category``,
  ``exit_code``, ``args_bytes``, ``result_bytes`` (NULL = non mesuré, lignes
  antérieures).

Le DDL est celui du schéma de référence (``shared_infra/db/_schema.py``) :
``create_all`` l'a déjà posé au démarrage, la migration n'est donc qu'un
filet idempotent. Pas de backfill : l'historique ne porte pas ces mesures.
Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

from typing import Any


def migrate(conn: Any) -> None:
    from shared_infra.db._schema import ensure_tables
    ensure_tables(conn, ("runs", "tool_call_metrics", "usage_events"))
