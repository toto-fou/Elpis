# SPDX-License-Identifier: MIT
"""
llm_core._llm_debug — tap de capture des échanges app ↔ llama.cpp.

Point d'entrée unique appelé en fin de CHAQUE appel llama.cpp (chemin classic
et chaque itération du chemin tools) pour journaliser l'échange dans la table
``llm_calls`` (cf. ``shared_infra.llm.debug``), consultable via le viewer
admin "Trafic LLM".

Garanties :
  - 100 % best-effort : toute exception est avalée (jamais de régression chat).
  - Gated par ``LLM_DEBUG_ENABLED`` (config) — no-op si désactivé.
  - Le "thinking"/raisonnement N'EST PAS capturé (décision produit) : seuls la
    requête (messages/tools/sampling), le contenu visible, les tool_calls et les
    métriques (usage/timings) sont stockés.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")


def _duration_ms_from_timings(timings: Any) -> Optional[int]:
    if not isinstance(timings, dict):
        return None
    try:
        total = float(timings.get("prompt_ms") or 0) + float(timings.get("predicted_ms") or 0)
        return int(total) if total > 0 else None
    except (TypeError, ValueError):
        return None


def capture_llm_exchange(
    *,
    req_id: Optional[str] = None,
    user_id: Any = None,
    chat_id: Optional[str] = None,
    model: Optional[str] = None,
    path: str = "classic",
    request_payload: Optional[Dict[str, Any]] = None,
    content: Optional[str] = None,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
    usage: Optional[Dict[str, Any]] = None,
    timings: Optional[Dict[str, Any]] = None,
    finish_reason: Optional[str] = None,
    status: str = "ok",
    error: Optional[str] = None,
) -> None:
    """Journalise un échange llama.cpp (best-effort, no-op si debug désactivé)."""
    try:
        from shared_infra import config as _cfg
        if not getattr(_cfg, "LLM_DEBUG_ENABLED", False):
            return
        max_entries = getattr(_cfg, "LLM_DEBUG_MAX_ENTRIES", 500)
        max_body = getattr(_cfg, "LLM_DEBUG_MAX_BODY_CHARS", 100000)

        # Requête : le payload envoyé tel quel (messages/tools/sampling). Ne
        # contient PAS de "thinking" (c'est une sortie modèle). Borné en taille.
        req_json = None
        n_messages = None
        if isinstance(request_payload, dict):
            try:
                msgs = request_payload.get("messages")
                if isinstance(msgs, list):
                    n_messages = len(msgs)
            except Exception:
                pass
            req_json = json.dumps(request_payload, ensure_ascii=False, default=str)[:max_body]

        # Réponse : contenu visible + tool_calls + métriques. PAS de thinking.
        response_obj: Dict[str, Any] = {
            "content": content or "",
            "tool_calls": tool_calls or [],
            "usage": usage or {},
            "timings": timings or {},
            "finish_reason": finish_reason,
        }
        resp_json = json.dumps(response_obj, ensure_ascii=False, default=str)[:max_body]

        u = usage if isinstance(usage, dict) else {}
        # ``user_id`` arrive ici sous forme de NOM d'utilisateur (les couches
        # LLM ne manipulent que ça) : ``int("alice")`` levait, et la colonne
        # restait NULL pour TOUS les appels — le filtre par utilisateur du
        # viewer « Trafic LLM » ne pouvait donc jamais rien remonter. On
        # résout le nom, avec le contexte d'usage en second recours.
        uid = None
        try:
            uid = int(user_id) if user_id is not None and str(user_id).strip() != "" else None
        except (TypeError, ValueError):
            try:
                from shared_infra.db._connection import _uid_for_username
                uid = _uid_for_username(str(user_id))
            except Exception:
                uid = None
        if uid is None:
            try:
                from shared_infra.observability.usage_ctx import current_usage_ctx
                uid = current_usage_ctx().user_id
            except Exception:
                uid = None

        from shared_infra.llm.debug import record_llm_call
        record_llm_call(
            req_id=req_id,
            user_id=uid,
            chat_id=chat_id,
            model=model,
            path=path,
            status=status,
            finish_reason=finish_reason,
            prompt_tokens=u.get("prompt_tokens"),
            completion_tokens=u.get("completion_tokens"),
            duration_ms=_duration_ms_from_timings(timings),
            n_messages=n_messages,
            n_tool_calls=len(tool_calls) if tool_calls else 0,
            request_json=req_json,
            response_json=resp_json,
            error=error,
            max_entries=max_entries,
        )
    except Exception:
        logger.debug("[llm_debug] capture failed (non-fatal)", exc_info=True)


async def capture_llm_exchange_async(**kwargs) -> None:
    """Variante NON BLOQUANTE de ``capture_llm_exchange``.

    AUDIT long-run 2026-08-21 — la capture sérialise le payload complet
    (jusqu'à ``LLM_DEBUG_MAX_BODY_CHARS``, 100 000 caractères par défaut) puis
    l'INSÈRE en SQLite, avec la purge du ring dans la même transaction. Tout
    cela est synchrone et s'exécutait sur l'event loop du worker, à CHAQUE
    itération LLM : sur une mission de plusieurs heures, c'est des centaines de
    gels du worker — donc de tous les flux SSE qu'il sert, pas seulement le
    run en cours — dont chacun peut durer jusqu'au ``busy_timeout`` de 10 s si
    un autre worker tient le verrou d'écriture WAL.

    Le pool de connexions étant thread-local (clé ``(pid, DB_PATH)``), le
    thread d'exécuteur ouvre proprement la sienne.

    La version SYNCHRONE reste le point d'entrée public : les appelants
    synchrones et les tests (qui lisent la base juste après) ne changent pas
    de comportement. Le gate ``LLM_DEBUG_ENABLED`` est ré-évalué dans le
    thread — un no-op ne coûte alors que le saut de thread ; on l'évite quand
    même ci-dessous pour ne pas payer ça sur une instance qui n'a jamais
    activé la capture."""
    try:
        from shared_infra import config as _cfg
        if not getattr(_cfg, "LLM_DEBUG_ENABLED", False):
            return
    except Exception:
        return
    try:
        await asyncio.to_thread(lambda: capture_llm_exchange(**kwargs))
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.debug("[llm_debug] capture async failed (non-fatal)", exc_info=True)
