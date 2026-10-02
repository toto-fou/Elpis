# SPDX-License-Identifier: MIT
"""
llm_core — façade du cœur LLM.

``llm_core.<nom>`` donne accès à tout symbole défini au premier niveau des
sous-modules listés dans ``_SUBMODULES``, y compris les noms préfixés par
``_`` : c'est la surface d'import historique des appelants (routes, routines,
outils). Le code neuf importe plutôt depuis le module propriétaire, qui est
aussi l'endroit où les tests substituent un nom. Exception :
``_llama_chat_with_tools_stream`` et ``_record_tool_call_metric_safe`` se
substituent dans ``llm_core._chat_with_tools``, qui les lit au début du run et
les injecte dans la boucle (``LoopDeps``).

Carte des sous-modules
======================

  ``_constants.py``      → constantes partagées (LLAMA_*, TOOL_CATEGORIES,
                           _VISION_*, _RAG_TOOL_DEFS).
  ``_mcp_categories.py`` → catégories d'outils découvertes.
  ``_llama_http.py``     → appels HTTP simples à llama-server.
  ``_client.py``         → client httpx partagé et son cycle de vie.
  ``_target.py``         → cible LLM du tour (connecteur résolu).
  ``_mcp_pool.py``       → pool de connexions MCP.
  ``_llm_params.py``     → paramètres d'échantillonnage, cache ``/props``.
  ``_capabilities.py``   → sonde des capacités du moteur, mode d'ordonnancement.
  ``_model_info.py``     → n_ctx et nombre de slots, en cache.
  ``_model_lifecycle.py``→ chargement, déchargement, attente d'inactivité.
  ``_scheduling/``       → concurrence, verrous, garde d'ordonnancement.
  ``_queue.py``          → estimation de la file (widget du chat).
  ``_health.py``         → santé du moteur, modèles distants, cache.
  ``_infill.py``         → complétion FIM (``llm_infill``).
  ``_metrics.py``        → ``calculate_metrics``.
  ``_pw_session.py``     → propriété des sessions Playwright.
  ``_rag.py``            → helpers RAG et outils intégrés.
  ``_vision.py``         → suivi des captures d'écran par utilisateur.
  ``_mcp_wrappers.py``   → adaptateurs MCP stdio/SSE.
  ``_tool_parsing.py``   → appels d'outils écrits en texte.
  ``_chat_classic.py``   → chat sans outils, en flux.
  ``engine/``            → sous-routines de la boucle agentique :
                           ``result_contract`` (classement des échecs),
                           ``tool_catalog`` (catalogue d'outils du tour),
                           ``llm_stream`` (un appel LLM avec outils),
                           ``tool_dispatch`` (exécution des appels d'outils,
                           noyau commun aux canaux natif et texte),
                           ``tool_exec`` (ordonnancement d'un lot),
                           ``live_text`` (émission directe du contenu),
                           ``run`` (état d'un run), ``resume`` (reprises),
                           ``llm_turn`` (un tour LLM), ``run_exit`` (sorties).
  ``_chat_with_tools.py``→ la boucle agentique (orchestrateur).
  ``context/``           → budget, élagage, assemblage, compaction.
  ``conversation_compressor.py`` → compaction des vieux tours.
"""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Ordre de chargement des sous-modules.
#
#    ``_constants`` d'abord : presque tous le lisent. Puis les modules dans
#    l'ordre de leurs dépendances ; ``_chat_with_tools`` en dernier : ses noms
#    priment dans la façade.
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
from llm_core.engine import result_contract as _engine_result_contract  # noqa: F401 — échecs d'outil
from llm_core.engine import tool_catalog as _engine_tool_catalog        # noqa: F401 — catalogue d'outils
from llm_core.engine import llm_stream as _engine_llm_stream            # noqa: F401 — appel LLM avec outils
from llm_core.engine import tool_dispatch as _engine_tool_dispatch      # noqa: F401 — appel d'outil
from llm_core.engine import live_text as _engine_live_text              # noqa: F401 — émission directe
from llm_core.engine import run as _engine_run                          # noqa: F401 — état d'un run
from llm_core.engine import resume as _engine_resume                    # noqa: F401 — reprises automatiques
from llm_core.engine import llm_turn as _engine_llm_turn                # noqa: F401 — un tour LLM
from llm_core.engine import run_exit as _engine_run_exit                # noqa: F401 — sorties d'un run
from llm_core import _chat_with_tools  # noqa: F401 — agentic tool-calling loop

_SUBMODULES = (_constants, _mcp_categories, _llama_http, _client, _target, _mcp_pool, _llm_params,
               _capabilities, _model_info, _model_lifecycle, _scheduling,
               _queue, _health, _infill, _metrics, _pw_session,
               _rag, _vision, _mcp_wrappers, _tool_parsing,
               _chat_classic, _engine_result_contract, _engine_tool_catalog,
               _engine_llm_stream, _engine_tool_dispatch, _engine_live_text,
               _engine_run, _engine_resume, _engine_llm_turn, _engine_run_exit,
               _chat_with_tools)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Réexport fidèle.
#
#    Chaque symbole de premier niveau de chaque sous-module devient
#    ``llm_core.<nom>``, y compris les noms préfixés par ``_`` que
#    ``from X import *`` ignorerait : aucune liste tenue à la main.
# ─────────────────────────────────────────────────────────────────────────────
# Un symbole HOMONYME d'un sous-module (``_health._client``, fonction) ne
# doit jamais écraser ``llm_core.<sous-module>`` : ``import llm_core._client``
# rendrait une FONCTION.
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
