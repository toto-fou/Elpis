# SPDX-License-Identifier: MIT
"""
0026_usage_tool_tokens — Part « outils » de l'entrée, par tour et par exécution.

``usage_events.tool_tokens`` et ``runs.tool_tokens`` : tokens d'entrée occupés
par les outils — définitions, appels et résultats re-soumis à chaque appel du
modèle (convention OpenAI / Anthropic : tout cela est de l'entrée). Sous-
ensemble de ``input_tokens``, estimé au ratio mesuré
(``llm_core.context.tokens.tool_prompt_tokens``). Pas de reprise : 0 sur
l'historique.

Le DDL est celui du schéma de référence : ``create_all`` a déjà posé les
colonnes au démarrage, la migration n'est qu'un filet idempotent. Ne commit
PAS (le runner commit à la fin).
"""
from __future__ import annotations

from typing import Any


def migrate(conn: Any) -> None:
    from shared_infra.db._schema import ensure_tables
    ensure_tables(conn, ("usage_events", "runs"))
