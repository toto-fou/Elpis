# SPDX-License-Identifier: MIT
"""
backend.services._model_lifecycle — Load / unload / wait-idle on llama-server.

Three coroutines that drive the runtime model state by hitting the
llama-server admin endpoints (``/v1/models/load``, ``/v1/models/unload``,
``/slots``):

  - ``load_llm_model(model_path)``   — POST /v1/models/load. Invalidates
                                        the cached n_ctx / total_slots
                                        on success so the next request
                                        re-probes the freshly-loaded model.
  - ``unload_llm_model(model_id)``   — DELETE /v1/models/{id}. Same cache
                                        invalidation on success.
  - ``wait_for_slots_idle(...)``     — Polls /slots until every slot
                                        reports idle or the deadline hits.
                                        Used before unload to give in-flight
                                        requests time to finish gracefully.

These all live together because they share the same admin-API conventions
and the same cache-invalidation contract with ``_model_info``.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict

from llm_core._llama_http import _llama_get, _llama_get_text, _llama_post
from llm_core._health import _parse_prometheus_metrics
from llm_core._model_info import (
    invalidate_context_size_cache,
    invalidate_total_slots_cache,
)

# Ce module n'avait aucun logger : ses avertissements passaient par les
# broadcasts d'événements de la route appelante, donc jamais dans le journal.
# ``__name__`` suffit désormais — les racines applicatives sont réglées à INFO
# (cf. ``shared_infra.observability.access_logging._apply_app_log_level``).
logger = logging.getLogger(__name__)


async def load_llm_model(model_path: str) -> Dict[str, Any]:
    """Try to load/switch a model on the remote llama-server."""
    if not model_path.strip():
        return {"ok": False, "error": "Chemin requis."}

    r = await _llama_post(
        "/models/load",
        {"model": model_path.strip()},
        timeout=180.0,
    )
    if r and r.get("_status") in (200, 201) and not r.get("error"):
        invalidate_context_size_cache()   # le nouveau modèle peut avoir un n_ctx différent
        invalidate_total_slots_cache()    # ET potentiellement un total_slots différent
        # Les paramètres de sampling recommandés changent aussi avec le modèle :
        # on vide le cache llm_params pour forcer un refetch de /props au
        # prochain appel. Même stratégie que invalidate_context_size_cache.
        try:
            from llm_core._llm_params import invalidate_params_cache
            invalidate_params_cache()  # global : on ne connaît pas encore l'ancien model_id
        except ImportError:
            pass
        # Cache /tokenize : le tokenizer peut être différent (modèle ≠ → BPE ≠).
        try:
            from llm_core._llama_http import invalidate_tokenize_cache
            invalidate_tokenize_cache()
        except ImportError:
            pass
        return {"ok": True, "method": "models_load", "detail": r}

    return {
        "ok": False,
        "error": (r or {}).get("error", "Endpoint non disponible."),
        "hint": "Assurez-vous que llama-server est lancé en mode routeur (sans spécifier de modèle initial)."
    }

#: Sondes CONSÉCUTIVES sans réponse au-delà desquelles on cesse d'attendre.
#: Attendre qu'un moteur injoignable devienne « inactif » n'a aucun sens : il
#: ne traite rien, et rien ne viendra le confirmer. Mesuré en production le
#: 2026-08-22 : ``POST /api/llm/models/unload`` a mis **334 s** à répondre
#: (300 s d'attente ici + le déchargement) parce que llama-server ne
#: répondait plus. Le client, lui, abandonne son sondage à 120 s et affiche
#: « Timeout — vérifiez le serveur » : l'interface ment pendant trois minutes
#: alors que la route travaille encore.
SLOTS_PROBE_MAX_UNREACHABLE = 3


async def wait_for_slots_idle(max_wait_sec: float = 300.0, poll_interval: float = 2.0) -> bool:
    """Attend que llama-server n'ait plus de requête en vol.

    ``True`` = inactif (on peut charger/décharger sans couper un flux).
    ``False`` = délai dépassé, OU moteur injoignable — l'appelant force alors
    l'opération, ce qui est le bon choix dans les deux cas.

    ⚠ Un moteur INJOIGNABLE fait renoncer tout de suite
    (``SLOTS_PROBE_MAX_UNREACHABLE`` sondes) au lieu d'épuiser ``max_wait_sec``.
    """
    # AUDIT 2026-08-30 (S8) — monotonic : un recalage NTP pendant l'attente du
    # chargement d'un modèle (jusqu'à ``max_wait_sec``, soit des dizaines de
    # secondes) faisait expirer l'échéance d'un coup, ou la repoussait d'autant.
    deadline = time.monotonic() + max_wait_sec
    muet = 0
    while time.monotonic() < deadline:
        joignable = False
        try:
            health = await _llama_get("/health", timeout=3.0)
            if health is not None:
                joignable = True
                # ⚠ Un llama-server en mode ROUTEUR répond ``{"status":"ok"}``
                # sans ``slots_processing`` : le défaut à 0 vaut alors
                # « inactif ». C'est délibéré — le routeur n'expose pas ses
                # slots sans nom de modèle, et l'exclusivité de modèle protège
                # déjà les flux en cours.
                if health.get("slots_processing", 0) == 0:
                    return True
                await asyncio.sleep(poll_interval)
                muet = 0
                continue
        except Exception:
            pass
        try:
            metrics_text = await _llama_get_text("/metrics", timeout=3.0)
            if metrics_text:
                joignable = True
                pm = _parse_prometheus_metrics(metrics_text)
                if pm.get("llamacpp_requests_processing", 0) == 0:
                    return True
        except Exception:
            pass

        if joignable:
            muet = 0
        else:
            muet += 1
            if muet >= SLOTS_PROBE_MAX_UNREACHABLE:
                logger.warning(
                    "[model_lifecycle] llama-server muet sur %d sondes — on "
                    "cesse d'attendre l'inactivité des slots (il ne traite "
                    "rien de toute façon)", muet)
                return False
        await asyncio.sleep(poll_interval)
    return False

async def unload_llm_model(model_id: str) -> Dict[str, Any]:
    """Try to unload a model from the remote llama-server."""
    if not model_id.strip():
        return {"ok": False, "error": "model_id requis."}

    r = await _llama_post(
        "/models/unload",
        {"model": model_id.strip()},
        timeout=30.0,
    )
    if r and r.get("_status") in (200, 204):
        # Modèle déchargé → vider les caches (au prochain load, un modèle
        # potentiellement différent sera chargé avec n_ctx/total_slots autres)
        invalidate_context_size_cache()
        invalidate_total_slots_cache()
        try:
            from llm_core._llm_params import invalidate_params_cache
            invalidate_params_cache()
        except ImportError:
            pass
        try:
            from llm_core._llama_http import invalidate_tokenize_cache
            invalidate_tokenize_cache()
        except ImportError:
            pass
        return {"ok": True, "method": "models_unload"}

    return {
        "ok": False,
        "error": (r or {}).get("error", "Non supporté par ce build ou modèle introuvable."),
        "hint": "Vérifiez que llama-server est en mode routeur et que le modèle est bien chargé."
    }
