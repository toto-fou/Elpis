# SPDX-License-Identifier: MIT
"""
0004_drop_agents_routines_tables — Supprime les tables de la feature « Superviseur ».

Le menu Agents / Superviseur (orchestration de sous-agents via ``spawn_agent``) et
ses Routines planifiées (cronjobs) ont été retirés. Cette migration DROP les tables
qui ne servaient qu'à cette feature. Destructive et irréversible : faire une
sauvegarde du fichier SQLite avant le premier boot post-migration.

Tables CONSERVÉES (NE PAS dropper) :
  - ``tool_call_metrics`` (``shared_infra/observability/tool_metrics_store.py``) : observabilité admin,
    sans rapport avec la feature agents malgré le nom du module.
  - toute l'infrastructure partagée du chatbot (users, chats, prompts, memory…).
"""
from __future__ import annotations

import sqlite3

# Tables propres au moteur d'agents (shared_infra/db/agents.py) et aux routines
# (shared_infra/scheduling/routines_store.py). Ordre enfant → parent (les FK sont de toute
# façon désactivées le temps des DROP, cf. migration 0003).
_AGENTS_ROUTINES_TABLES = (
    # shared_infra/db/agents.py
    "agent_events",
    "agent_tasks",
    "agent_runs",
    "agent_definitions",
    # shared_infra/scheduling/routines_store.py
    "routine_runs",
    "scheduled_routines",
)


def migrate(conn: sqlite3.Connection) -> None:
    # Ces tables ont des FK entre elles (runs→definitions, tasks/events→runs,
    # routine_runs→scheduled_routines). Comme les connexions de l'app ont
    # ``foreign_keys=ON``, un ``DROP TABLE`` d'une parente encore référencée
    # lèverait une IntegrityError. On désactive donc l'enforcement FK le temps
    # des DROP (no-op dans une transaction → on commit d'abord), puis on rétablit.
    cur = conn.cursor()
    conn.commit()
    cur.execute("PRAGMA foreign_keys=OFF")
    try:
        for table in _AGENTS_ROUTINES_TABLES:
            cur.execute(f"DROP TABLE IF EXISTS {table}")
        conn.commit()
    finally:
        cur.execute("PRAGMA foreign_keys=ON")
