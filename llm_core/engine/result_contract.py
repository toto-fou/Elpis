# SPDX-License-Identifier: MIT
"""Contrat de résultat d'outil — classifieur d'échec PARTAGÉ.

Source UNIQUE de la question « ce tool_result dénote-t-il un échec ? »,
consommée par :
  * la boucle outils (``_chat_with_tools._result_is_error`` — métriques
    d'échec + budget d'itérations productives ``effective_iter``) ;
  * le ledger d'artefacts de la compression
    (``context.compression.serializer._result_ok``) ;
  * alignée avec le frontend (``app-chat.js::_isErrorResult``).

Avant ce module, la même heuristique vivait en DOUBLE (boucle + ledger) —
avec le même angle mort chacun : un dict d'erreur multi-clés sans ``ok``
(``{"error": …, "hint": …}``, l'ancienne forme des builtins RAG) comptait
comme un SUCCÈS des deux côtés. La forme RAG est corrigée à la source
(enveloppe ``ok: false``) ; l'heuristique 1-clé reste volontairement
CONSERVATRICE pour les outils MCP externes (un payload de données qui
contient par hasard une clé ``error`` ne doit pas passer pour un échec).
"""
from __future__ import annotations

import json
from typing import Any

__all__ = ["result_is_error"]


def result_is_error(result_content: Any) -> bool:
    """True si le résultat JSON d'un tool dénote un échec.

      * ``{"ok": false, ...}``     → erreur (enveloppe ``_err()`` v19+,
        builtins RAG inclus depuis 2026-07-13) ;
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
