# SPDX-License-Identifier: MIT
"""llm_core.engine — sous-routines de la boucle agentique (tool-calling).

La boucle elle-même (l'orchestrateur) vit dans ``llm_core._chat_with_tools`` ;
ce paquet en porte les sous-routines cohésives et testables, sans en faire une
classe (qui ne ferait que relocaliser les variables d'état sans réduire la
complexité) :

- ``run``             — état d'un run : constantes (``RunContext``), trace
                        (``RunRecord``), dépendances injectées (``LoopDeps``),
                        slot LLM du mode « optimized » ;
- ``tool_catalog``    — catalogue d'outils d'un tour (MCP + intégrés, filtres) ;
- ``llm_turn``        — UN tour LLM (``call_llm``) : porte de compaction,
                        élagage, ajustement au budget, appel, récupération des
                        échecs, usage et jauge, décodage ; issue explicite
                        (``LLMTurn``) et état privé (``LLMTurnState``) ;
- ``llm_stream``      — transport d'UN appel LLM en flux avec ``tools[]`` ;
- ``live_text``       — émission directe du contenu, avec fenêtre de retenue
                        et portail anti-balisage (``LiveText``) ;
- ``resume``          — reprises automatiques d'une génération coupée
                        (raisonnement, rédaction) : ``ResumeState`` ;
- ``run_exit``        — les trois sorties d'un run : réponse finale, sortie sur
                        limite (tour de synthèse), sortie d'erreur ;
- ``tool_dispatch``   — exécution des appels d'outils d'un tour : noyau
                        commun aux deux canaux (``run_tool_batch``), ce qui
                        diffère entre eux (``ChannelSpec`` : ``NATIF``,
                        ``TEXTE``), préparation du lot, appels écrits en texte
                        et leurs relances, anti-boucle (``CycleGuard``), appels
                        coupés par la limite de génération
                        (``TruncationGuard``), UN appel isolé ;
- ``tool_exec``       — ``execute_tool_batch`` : ordonnancement série/parallèle
                        d'un lot + exécution + métriques, PARTAGÉ par le canal
                        natif (``tool_calls`` structurés) et le canal texte
                        (appels écrits par le modèle dans sa réponse) ;
- ``result_contract`` — classement des échecs de résultat d'outil ;
- ``stream_events``   — registre des types d'événements du flux NDJSON.

Aucun de ces modules n'importe ``_chat_with_tools`` (l'orchestrateur les
importe). Ce ``__init__`` n'importe que ``tool_exec`` ; chaque module importe
lui-même ceux dont il dépend, et la façade ``llm_core``
(``llm_core/__init__.py``) charge, elle, tous les sous-modules du paquet.

Les compteurs effective/hard restent des entiers de l'orchestrateur : les
sous-routines lui rendent une DÉCISION (issue d'un ``LLMTurn``, reprise
programmée, ``BatchOutcome`` d'un lot, arrêt sur coupes en série), il
l'applique. Les extraire dans un objet ne ferait que
relocaliser des entiers simples à travers ~8 sites de mutation, en risquant
leur sémantique. La terminaison est couverte par des tests d'intégration sur
``run_chat_multi_mcp`` (outils en échec en cascade) et par les goldens de
scénarios de la boucle.
"""
from __future__ import annotations

from llm_core.engine.tool_exec import execute_tool_batch  # noqa: F401
