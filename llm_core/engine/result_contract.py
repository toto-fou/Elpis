# SPDX-License-Identifier: MIT
"""llm_core.engine.result_contract — classifieur d'échec des résultats d'outils.

Source UNIQUE des deux questions posées à un ``tool_result`` :
  * ``result_is_error`` — le résultat dénote-t-il un échec ? Consommée par la
    boucle outils (via ``result_is_tool_failure``), par le ledger d'artefacts
    de la compression (``context.compression.serializer._result_ok``), et
    alignée avec le frontend (``frontend/js/chat/_tool_segments.js::resultIsError``) ;
  * ``result_is_tool_failure`` — l'échec vient-il de L'OUTIL lui-même ?
    Consommée par la boucle (métriques d'échec, budget d'itérations
    productives ``effective_iter``) et par les sous-agents (``task_tool``).

L'heuristique « une seule clé ``error`` » reste volontairement CONSERVATRICE
pour les outils MCP externes : un payload de données qui contient par hasard
une clé ``error`` ne doit pas passer pour un échec. Les builtins rendent
l'enveloppe ``ok: false``.
"""
from __future__ import annotations

import json
from typing import Any

__all__ = ["result_is_error", "result_is_tool_failure"]


def result_is_error(result_content: Any) -> bool:
    """True si le résultat JSON d'un tool dénote un échec.

      * ``{"ok": false, ...}``     → erreur (enveloppe ``_err()``, builtins
        RAG compris) ;
      * ``{"error": "..."}`` SEUL  → erreur (filet de sécurité 1-clé) ;
      * tout le reste              → succès.

    Tout contenu non-str / non-JSON / non-dict est traité comme un succès
    (le tool a produit une sortie libre).
    """
    if not isinstance(result_content, str):
        return False
    try:
        parsed = json.loads(result_content)
    except (json.JSONDecodeError, TypeError, ValueError):
        return False
    if not isinstance(parsed, dict):
        return False
    if "ok" in parsed and parsed.get("ok") is False:
        return True
    if "error" in parsed and len(parsed) == 1:
        return True
    return False


def result_is_tool_failure(result_content: Any) -> bool:
    """True si le résultat dénote un échec de L'OUTIL lui-même — par
    opposition à une COMMANDE utilisateur qui s'est exécutée puis a rendu un
    code de sortie ≠ 0 (pytest rouge, grep sans match, build cassé…).

    ``execute_shell`` renvoie ``{"ok": false, "returncode": N, stdout,
    stderr}`` SANS champ ``error`` quand la commande a tourné : l'outil a
    parfaitement fonctionné et la sortie est exactement l'information
    demandée. Le compter en « erreur d'outil » (36 % de faux échecs mesurés
    sur execute_shell) fausserait le taux d'erreur d'observabilité et
    brûlerait le budget d'itérations « productives » sur du travail légitime.
    Un vrai échec d'outil (timeout, sandbox, args invalides) porte toujours
    un code ``error`` — il reste classé échec.
    """
    if not result_is_error(result_content):
        return False
    try:
        parsed = json.loads(result_content)
    except (json.JSONDecodeError, TypeError, ValueError):
        return True
    if not isinstance(parsed, dict):
        return True
    if parsed.get("ok") is False and "returncode" in parsed and "error" not in parsed:
        return False   # commande exécutée, exit ≠ 0 : l'outil a fait son travail
    return True
