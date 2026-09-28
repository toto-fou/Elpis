# SPDX-License-Identifier: MIT
"""
0003_drop_agentic_tables — Supprime les tables de l'ancien moteur agentique.

Le moteur de pipelines/équipes maison (``agentic_app``) a été retiré au profit
de Flowise (service externe). Cette migration DROP les tables qui ne servaient
qu'à ce moteur. Destructive et irréversible : faire une sauvegarde du fichier
SQLite avant le premier boot post-migration.

Tables CONSERVÉES (NE PAS dropper) :
  - ``tool_call_metrics`` : lue par les dashboards d'observabilité admin.
  - ``users``, ``chats``, ``session_messages``, ``groups``, ``user_groups``,
    ``saved_prompts``, ``shared_prompts``, ``metric_events`` et les tables de
    ``llm_core.memory`` — infrastructure partagée du chatbot.
"""
from __future__ import annotations

import sqlite3

# Tables propres à l'agentic (pipelines, runs, triggers, équipes, blackboard…).
_AGENTIC_TABLES = (
    # shared_infra/db/_legacy.py
    "agent_pipelines",
    "shared_pipelines",
    "pipeline_runs",
    "pipeline_versions",
    "pipeline_schedules",
    "pipeline_triggers",
    "pipeline_reports",
    # shared_infra/db/run_store.py (RunStore event-sourced moteur v2)
    "pipeline_run_events",
    "pipeline_run_snapshots",
    # shared_infra/db/team_artifacts.py
    "team_artifacts",
    # migration 0002
    "pipeline_health",
    # shared_infra/observability/tool_metrics_store.py (run_metrics/blackboard/webhooks agentic)
    "blackboard_persistent",
    "run_metrics",
    "webhook_deliveries",
)


def migrate(conn: sqlite3.Connection) -> None:
    # Les connexions de l'app ont ``foreign_keys=ON``. Or ces tables ont des FK
    # entre elles : ``DROP TABLE`` d'une parente déclenche un implicit DELETE qui
    # viole la FK d'une enfant encore présente → ``IntegrityError`` (et, comme une
    # migration qui échoue BLOQUE toutes les suivantes, c'est ce qui empêchait
    # 0004+ de tourner). On désactive donc temporairement l'enforcement FK le temps
    # des DROP. ``PRAGMA foreign_keys`` est un no-op DANS une transaction → on commit
    # d'abord pour sortir de la transaction courante, puis on rétablit à la fin.
    cur = conn.cursor()
    conn.commit()
    cur.execute("PRAGMA foreign_keys=OFF")
    try:
        for table in _AGENTIC_TABLES:
            cur.execute(f"DROP TABLE IF EXISTS {table}")
        conn.commit()
    finally:
        cur.execute("PRAGMA foreign_keys=ON")
