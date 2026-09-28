# SPDX-License-Identifier: MIT
"""llm_core.engine — orchestration de la boucle agentique (tool-calling).

Phase 4 du refactor : la god-function ``run_chat_multi_mcp`` (~1800 lignes)
avait deux branches d'exécution d'outils — le canal NATIF (tool_calls
structurés OpenAI) et le canal LEGACY (appels tag-parsés en texte pour les
modèles sans tool-calls natifs) — à ~85-90 % verbatim identiques. Toute
correction de pairing/résultat devait se faire deux fois.

Ce package extrait les sous-routines cohésives et testables de la boucle,
sans en faire une classe (qui ne ferait que relocaliser les ~20 variables
d'état sans réduire la complexité) :

- ``tool_exec``   — ``execute_tool_batch`` : l'ordonnancement série/parallèle
                    + exécution + métriques, PARTAGÉ par les deux canaux (le
                    legacy gagne les callbacks progress/log au passage).

Note : les compteurs effective/hard restent inline dans la boucle — les
extraire dans un objet ne ferait que relocaliser des entiers simples à
travers ~8 sites de mutation, sans réduire la complexité et en risquant leur
sémantique subtile. La couverture de terminaison est assurée par des tests
d'intégration sur ``run_chat_multi_mcp`` (outils en échec en cascade).
"""
from __future__ import annotations

from llm_core.engine.tool_exec import execute_tool_batch  # noqa: F401
