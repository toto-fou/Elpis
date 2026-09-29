# SPDX-License-Identifier: MIT
"""
backend.services._rag — Auto-RAG injection + tool factory wrapper.

Decoupled architecture (since v3)
---------------------------------
Both ``apply_rag`` (auto-injection of context into the user's last
message) and ``build_rag_builtin_tools`` (LLM tool factory) now talk to
the standalone ``rag_app`` HTTP service. No symbol from ``rag_app.*`` is
imported anywhere in the chatbot codebase.

* ``apply_rag``                 → POST ``/api/tools/rag_inline`` (SSE)
* ``build_rag_builtin_tools``   → delegates to ``tools.rag_tools`` (which
                                  itself uses ``backend.services._rag_client``)

If the service URL is missing, both paths gracefully degrade: tools
return ``{}`` (chat continues without RAG), apply_rag returns the
messages untouched with ``{"enabled": False}`` metadata.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from llm_core._rag_client import (
    RagServiceError,
    RagToolError,
    call_tool,
    is_configured,
)
from shared_infra.db import log_metric

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────
# Auto-RAG: insert retrieved context after the leading system block
# ─────────────────────────────────────────────────────────────────────

def apply_rag(
    messages: List[Dict[str, str]],
    collection: Optional[str] = None,
    search_mode: str = "classic",
) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    """
    Insert a system message with retrieved context AFTER the leading
    system block, sourced from ``rag_app`` via SSE. Returns
    ``(messages, meta)`` where ``meta`` explains what happened (used for
    telemetry + UI banners).

    Failure modes (each returns the original messages unchanged):
      * service not configured  → meta.enabled=False, error="not configured"
      * empty user question     → meta.used=False
      * service error           → meta.used=False, error=<reason>
      * service answered "used":False → meta.used=False
    """
    if not is_configured():
        return messages, {"enabled": False, "used": False,
                          "error": "RAG service URL non configurée"}

    # Find the last user message — that's our query.
    # F12 — ``content`` peut être MULTIMODAL (liste image_url+text) : un
    # ``.strip()`` direct dessus levait AttributeError → 500 sur toute la
    # requête (apply_rag n'est pas gardé côté caller). On extrait le texte.
    def _text_of(content) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and isinstance(b.get("text"), str)
            )
        return ""
    q = ""
    for m in reversed(messages or []):
        if m.get("role") == "user":
            _q = _text_of(m.get("content")).strip()
            if _q:
                q = _q
                break
    if not q:
        return messages, {"enabled": True, "used": False}

    payload = {"question": q, "search_mode": search_mode}
    if collection:
        payload["collection"] = collection

    try:
        result = call_tool("rag_inline", payload)
    except RagServiceError as e:
        logger.warning("[rag] service unreachable for apply_rag: %s", e)
        return messages, {"enabled": True, "used": False, "error": str(e)}
    except RagToolError as e:
        return messages, {"enabled": True, "used": False, "error": str(e)}
    except Exception as e:
        logger.exception("[rag] unexpected error in apply_rag")
        return messages, {"enabled": True, "used": False, "error": str(e)}

    if not result or not result.get("used"):
        return messages, {"enabled": True, "used": False,
                          **({"error": str(result["error"])} if result and result.get("error") else {})}

    rag_context_text = result.get("context_text") or ""
    sources = result.get("sources") or []
    if not rag_context_text:
        return messages, {"enabled": True, "used": False}

    # Insertion APRÈS le run system de tête (socle identité [+ résumé de
    # compression]) — même boucle que apply_persisted_state. Avant : préfixé
    # en position 0 → l'identité passait APRÈS le contexte documentaire au
    # coalesce d'envoi, et le texte RAG (re-requêté à chaque tour, donc
    # volatil) invalidait le prefix-cache de TOUT le bloc système. Ordre
    # voulu : socle (stable) → résumé (stable par round) → RAG (volatil).
    insert_at = 0
    for i, m in enumerate(messages):
        if isinstance(m, dict) and m.get("role") == "system":
            insert_at = i + 1
        else:
            break
    new_messages = list(messages)
    new_messages.insert(insert_at, {"role": "system", "content": rag_context_text})
    log_metric("rag_hit", 1,
               {"query_len": len(q), "sources_count": len(sources), "mode": search_mode})
    return new_messages, {"enabled": True, "used": True, "sources": sources}


# ─────────────────────────────────────────────────────────────────────
# Tool factory — thin re-export of tools.rag_tools.build_rag_builtin_tools
# ─────────────────────────────────────────────────────────────────────
#
# Why re-export instead of importing directly everywhere?
# -------------------------------------------------------
# Several modules (agentic/_node_handlers, agentic/team, agentic/orchestrator,
# routes/chats) historically imported ``build_rag_builtin_tools`` from
# ``backend.services``. Keeping that import path stable lets us swap the
# implementation (tools.rag_tools) without touching every caller.
#
# The implementation lives in ``tools.rag_tools`` because that module also
# carries the v2 features (filters, multi-collection, score_threshold,
# rag_cite, rag_list_sources) — re-implementing them here would just
# duplicate ~300 lines.
def build_rag_builtin_tools(
    collection: str = "",
    search_mode: str = "classic",
    top_k: int = 8,
    use_mmr: bool = True,
    ctx_size: int = 0,
) -> Dict[str, Any]:
    """Thin proxy to :func:`tools.rag_tools.build_rag_builtin_tools`."""
    try:
        from llm_core.tools.rag_tools import build_rag_builtin_tools as _build
    except Exception as e:
        logger.exception("[rag] cannot import tools.rag_tools: %s", e)
        return {}
    return _build(
        collection=collection,
        search_mode=search_mode,
        top_k=top_k,
        use_mmr=use_mmr,
        ctx_size=ctx_size,
    )
