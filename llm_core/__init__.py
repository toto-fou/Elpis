# SPDX-License-Identifier: MIT
"""
backend.services — Package façade.

This package replaces the former monolithic ``backend/services.py``. The
public import surface is preserved EXACTLY: every name that was previously
importable from ``backend.services`` (public *and* private/underscore-prefixed)
is still importable from here.

Layout
======

  ``_constants.py``      → orphan constants (LLAMA_*, TOOL_CATEGORIES,
                           _VISION_*, _RAG_TOOL_DEFS, rag_query handle).
  ``_legacy.py``         → thin compat shim — re-exports every name from
                           the modules below for callers that still write
                           ``from backend.services._legacy import …``.
  ``_llama_http.py``     → thin HTTP wrappers over llama-server.
  ``_client.py``         → shared httpx.AsyncClient + lifecycle.
  ``_mcp_pool.py``       → MCP connection pool.
  ``_llm_params.py``     → sampling params + /props cache.
  ``_capabilities.py``   → llama-server capability probe + scheduling-mode.
  ``_model_info.py``     → cached n_ctx + total_slots.
  ``_model_lifecycle.py``→ load / unload / wait-idle.
  ``_scheduling/``       → concurrency + locks + guard.
  ``_queue.py``          → queue-status estimator (chat widget).
  ``_health.py``         → health checks + remote-models snapshot + cache.
  ``_infill.py``         → llm_infill() FIM completion.
  ``_metrics.py``        → calculate_metrics().
  ``_pw_session.py``     → Playwright session ownership registry.
  ``_rag.py``            → RAG helpers + built-in tools.
  ``_vision.py``         → per-user screenshot tracking.
  ``_mcp_wrappers.py``   → MCP stdio/SSE adapters.
  ``_tool_parsing.py``   → extract_tool_calls.
  ``_chat_classic.py``   → plain chat streaming.
  ``_chat_with_tools.py``→ agentic tool-calling loop.
  ``_stream_tag_parser.py``  → <think> tag splitter (used by chat paths).
  ``conversation_compressor.py`` → background message-window compaction.

Public import contract (must stay stable)
-----------------------------------------
Known external callers:

- ``agentic/orchestrator.py``: LLM_SEMAPHORE, TOOL_CATEGORIES, apply_rag,
  build_rag_builtin_tools, get_model_context_size, llama_chat_stream_tokens,
  pick_tool_payload, run_chat_classic, run_chat_multi_mcp, _resolve_mcp_client
- ``backend/metrics/engine.py``: get_llm_health_sync
- ``backend/routes/_legacy.py`` + other routes submodules: many more
  (llama_chat, load_llm_model, etc.).
"""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Submodule loading order.
#
#    ``_constants`` FIRST because almost everyone reads from it.
#    Then domain modules in dependency order. ``_legacy`` LAST because it
#    re-exports symbols from every other module above.
# ─────────────────────────────────────────────────────────────────────────────
from llm_core import _constants        # noqa: F401 — orphan constants
from llm_core import _mcp_categories   # noqa: F401 — auto-discovered tool categories
from llm_core import _llama_http       # noqa: F401 — thin HTTP wrappers
from llm_core import _client           # noqa: F401 — shared httpx.AsyncClient
from llm_core import _target            # noqa: F401 — LlmTarget + résolution connecteur
from llm_core import _mcp_pool         # noqa: F401 — MCP connection pool
from llm_core import _llm_params       # noqa: F401 — sampling params + /props cache
from llm_core import _capabilities     # noqa: F401 — llama-server probe + scheduling-mode
from llm_core import _model_info       # noqa: F401 — n_ctx + total_slots caches
from llm_core import _model_lifecycle  # noqa: F401 — load / unload / wait-idle
from llm_core import _scheduling       # noqa: F401 — concurrency + locks + guard
from llm_core import _queue            # noqa: F401 — queue-status estimator
from llm_core import _health           # noqa: F401 — health checks + cache
from llm_core import _infill           # noqa: F401 — llm_infill() FIM completion
from llm_core import _metrics          # noqa: F401 — calculate_metrics()
from llm_core import _pw_session       # noqa: F401 — Playwright ownership
from llm_core import _rag              # noqa: F401 — RAG helpers + built-in tools
from llm_core import _vision           # noqa: F401 — per-user screenshot tracking
from llm_core import _mcp_wrappers     # noqa: F401 — MCP stdio/SSE adapters
from llm_core import _tool_parsing     # noqa: F401 — extract_tool_calls
from llm_core import _chat_classic     # noqa: F401 — plain chat streaming
from llm_core import _chat_with_tools  # noqa: F401 — agentic tool-calling loop

# NOTE (Phase 7) — ``_legacy.py`` SUPPRIMÉ : il ne ré-exportait que des noms
# déjà atteignables via la boucle de façade ci-dessous (chaque symbole de son
# module d'origine devient ``llm_core.<name>``). Aucun ``from llm_core._legacy
# import`` n'existait. Le cache vision, sa seule dépendance, vit dans _constants.
_SUBMODULES = (_constants, _mcp_categories, _llama_http, _client, _target, _mcp_pool, _llm_params,
               _capabilities, _model_info, _model_lifecycle, _scheduling,
               _queue, _health, _infill, _metrics, _pw_session,
               _rag, _vision, _mcp_wrappers, _tool_parsing,
               _chat_classic, _chat_with_tools)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Full-fidelity re-export.
#
#    Re-expose every symbol defined at module-level in each submodule,
#    including underscore-prefixed names that ``from X import *`` would skip.
#    This keeps the façade bullet-proof against regressions during the
#    extraction — no hand-maintained list to drift.
# ─────────────────────────────────────────────────────────────────────────────
# Un symbole HOMONYME d'un sous-module (``_health._client``, fonction) ne
# doit jamais écraser ``llm_core.<sous-module>`` : ``import llm_core._client``
# rendait une FONCTION (2026-09-24, passe robustesse).
_SUBMODULE_NAMES = {m.__name__.rsplit(".", 1)[-1] for m in _SUBMODULES}
for _mod in _SUBMODULES:
    for _name in dir(_mod):
        if _name.startswith("__") or _name in _SUBMODULE_NAMES:
            continue
        globals()[_name] = getattr(_mod, _name)

# Clean up loop variables so they don't leak into the module surface.
try:
    del _mod, _name
except NameError:
    pass
