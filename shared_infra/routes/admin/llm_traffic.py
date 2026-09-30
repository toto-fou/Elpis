# SPDX-License-Identifier: MIT
"""
shared_infra/routes/admin/llm_traffic.py — Viewer admin "Trafic LLM".

Expose les échanges app ↔ llama.cpp capturés dans la table ``llm_calls``
(cf. ``shared_infra.llm.debug``). Outil de DEBUG des conversations :
on voit, par appel, la requête envoyée à llama.cpp (messages/tools/sampling)
et la réponse (contenu visible + tool_calls + métriques) — le "thinking" n'est
pas capturé.

RÉSERVÉ ADMIN STRICT (``is_admin == 1``) : ces données contiennent les messages
de TOUS les utilisateurs.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from shared_infra.accounts.users import get_user_by_id
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


def _require_strict_admin(request: Request) -> int:
    """Gate admin STRICT (is_admin == 1). Les modérateurs (2) sont refusés."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    return uid


def _maybe_json(s: Optional[str]) -> Any:
    """Parse une colonne JSON ; retombe sur la string brute si non parsable."""
    if not s:
        return None
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return s


@admin_router.get("/api/admin/llm-traffic")
def api_admin_llm_traffic(request: Request, limit: int = 100,
                          user_id: Optional[int] = None,
                          model: Optional[str] = None,
                          status: Optional[str] = None,
                          chat_id: Optional[str] = None):
    """Liste les échanges llama.cpp récents (résumés, sans les payloads).

    Query : ``limit`` (≤1000), ``user_id``, ``model``, ``status`` (ok|error),
    ``chat_id`` — tous optionnels.
    """
    _require_strict_admin(request)
    from shared_infra.config import LLM_DEBUG_ENABLED, LLM_DEBUG_MAX_ENTRIES
    from shared_infra.llm.debug import list_llm_calls
    calls = list_llm_calls(limit=limit, user_id=user_id, model=model,
                           status=status, chat_id=chat_id)
    return JSONResponse({
        "calls": calls,
        "count": len(calls),
        "enabled": bool(LLM_DEBUG_ENABLED),
        "max_entries": int(LLM_DEBUG_MAX_ENTRIES),
    }, headers={"Cache-Control": "no-cache"})


@admin_router.get("/api/admin/llm-traffic/{call_id:int}")
def api_admin_llm_traffic_detail(call_id: int, request: Request):
    """Détail complet d'un échange : requête + réponse (JSON parsés). 404 si absent.

    ``{call_id:int}`` (converter int) : garantit que ce chemin ne capture pas
    d'éventuels sous-chemins littéraux.
    """
    _require_strict_admin(request)
    from shared_infra.llm.debug import get_llm_call
    row = get_llm_call(call_id)
    if row is None:
        raise HTTPException(404, "échange introuvable")
    row["request"] = _maybe_json(row.pop("request_json", None))
    row["response"] = _maybe_json(row.pop("response_json", None))
    return JSONResponse(row, headers={"Cache-Control": "no-cache"})


@admin_router.delete("/api/admin/llm-traffic")
def api_admin_llm_traffic_clear(request: Request):
    """Vide le ring d'échanges capturés."""
    _require_strict_admin(request)
    from shared_infra.llm.debug import clear_llm_calls
    n = clear_llm_calls()
    return JSONResponse({"ok": True, "deleted": n})
