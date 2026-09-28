# SPDX-License-Identifier: MIT
"""
0017_drop_scenarios — retrait des scénarios rejouables du Studio (2026-09-12).

Les onglets Scénario / Bibliothèque n'ont jamais servi ; le Studio devient un
environnement de code d'automatisation dont les scripts vivent en FICHIERS dans
la sandbox (``automations/``), pas en base. Les quatre tables partent avec leur
contenu (jamais rempli en usage réel). ``editor_action_cache`` RESTE : c'est la
mémoire des ancres du ciblage live (``shared_infra/desktop/anchors.py``).
Idempotent. Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    for table in ("editor_scenario_step_results", "editor_scenario_runs",
                  "editor_test_scenarios", "editor_scenario_folders"):
        conn.execute(f"DROP TABLE IF EXISTS {table}")
