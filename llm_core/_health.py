# SPDX-License-Identifier: MIT
"""
backend.services._health — llama-server health checks and model snapshots.

Two-tier API
------------
- **Async functions** (``get_llm_health``, ``get_remote_models_with_status``,
  ``get_remote_models_with_status``, ``get_currently_loaded_model``,
  ``verify_llm_availability``) — preferred in async code paths. Use the
  shared ``httpx.AsyncClient`` from ``_legacy`` to reuse the connection
  pool.
- **Sync mirror** (``get_llm_health_sync``, ``get_currently_loaded_model_sync``,
  ``_llama_base_url_sync``, ``_parse_prometheus_metrics``) — used by
  ``backend.metrics_engine`` which runs probes in a ``ThreadPoolExecutor``.
  These each open a short-lived ``httpx.Client``; the cost is acceptable
  for the metrics path which polls slowly.

Loaded-model cache
------------------
``get_currently_loaded_model`` caches the answer for ``_LOADED_MODEL_TTL_S``
(5s) seconds in the module-level ``_loaded_model_cache``. The chat handler
reads this to resolve ``model="auto"`` to the actually-loaded model rather
than ``LLAMA_MODEL`` (which may be stale config). Three classes of bugs
were fixed by this cache:
  1. Pipelines requesting LLAMA_MODEL when llama has another model loaded
     → forced unload+reload, sometimes silently failing.
  2. Team members with ``model="auto"`` preempting a coordinator's run.
  3. UI showing ``"auto"`` instead of the real model id.

Public re-export
----------------
Names live here, but are imported back into ``backend.services._legacy``
and into the package façade ``backend.services`` for backward compat.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

from shared_infra.config import LLAMA_URL

logger = logging.getLogger("uvicorn.error")


# Late imports — kept for historical symmetry. ``_get_llm_client`` now lives
# in ``backend.services._client``; we import it directly to avoid the
# circular import that previously appeared when this module was loaded
# before ``_legacy`` finished its own re-export pass.
from llm_core._client import _get_llm_client
from llm_core._llama_http import (
    _llama_base_url, _llama_get, _llama_get_text,
)
# ``get_model_total_slots`` lives in ``_model_info`` which depends on
# ``_health`` for ``_parse_prometheus_metrics``. To break that cycle we
# import it lazily inside the one function that uses it.

# ─────────────────────────────────────────────────────────────────────────────
# LLM – utilitaires
# ─────────────────────────────────────────────────────────────────────────────

# AUDIT 2026-08-31 — le préflight faisait un GET réseau complet à CHAQUE tour,
# sans cache : ~1 ms en local, mais un RTT fournisseur entier sur un connecteur
# distant, ajouté au TTFT de chaque message. La sonde ne prouve de toute façon
# que la joignabilité TCP/HTTP (un 401/404 rapide passe) : un succès reste
# représentatif pendant quelques secondes. Cache par base_url, TTL court ;
# l'échec n'est jamais caché (chaque tour re-sonde tant que c'est cassé).
_PREFLIGHT_OK_TTL_S = 10.0
_preflight_ok_at: Dict[str, float] = {}


async def verify_llm_availability():
    """Préflight de joignabilité du moteur d'inférence de LA requête courante.

    ⚠ AUDIT 2026-08-08 — cette fonction sondait ``LLAMA_URL`` EN DUR, c'est-à-dire
    le llama-server local, quelle que soit la cible réellement résolue. Or elle
    est appelée en tête de CHAQUE tour (``_chat_with_tools``, ``_chat_classic``).
    Conséquence : sur un déploiement dont le moteur local est arrêté — ou qui n'en
    a tout simplement pas — un utilisateur basculé sur un connecteur EXTERNE
    (Moonshot, Anthropic, OpenAI…) voyait chacun de ses messages échouer
    immédiatement sur « Serveur LLM injoignable », alors que son connecteur
    répondait parfaitement. Le message désignait en plus le mauvais serveur, ce
    qui envoyait diagnostiquer un composant hors sujet.

    On sonde donc la cible COURANTE : le moteur local seulement quand c'est lui
    qui va servir la requête, sinon la base_url du connecteur. Le message d'erreur
    nomme le serveur réellement injoignable.
    """
    try:
        from llm_core._target import current_target
        target = current_target()
    except Exception:                                           # pragma: no cover
        target = None

    url = LLAMA_URL
    label = "Serveur LLM injoignable."
    if target is not None and not getattr(target, "is_default", True):
        base = (getattr(target, "base_url", "") or "").strip()
        if not base:
            # Connecteur externe sans base_url : rien à sonder ici, l'adaptateur
            # du provider remontera une erreur bien plus précise que nous.
            return
        url = base
        label = (f"Connecteur LLM injoignable ({urlparse(base).netloc}). "
                 f"Vérifiez l'URL du connecteur et le réseau.")

    try:
        p = urlparse(url)
        base_url = f"{p.scheme}://{p.netloc}"
        import time
        if (time.monotonic() - _preflight_ok_at.get(base_url, float("-inf"))
                < _PREFLIGHT_OK_TTL_S):
            return
        # AUDIT 2026-08-23 — deux défauts sur une seule ligne.
        #
        # (1) ``_get_llm_client()`` SANS base_url rend le client partagé du
        #     llama-server LOCAL (pool de 6), y compris quand ``url`` vient
        #     d'être remplacé par la base d'un connecteur externe. Les clients
        #     par base existent justement pour qu'« un fournisseur lent ne
        #     sature pas les keepalives réservés au local » : cette sonde, qui
        #     tourne à CHAQUE tour, contournait exactement cette protection.
        # (2) Aucun timeout ⇒ celui du client, ``LLAMA_TIMEOUT_SEC`` = 600 s.
        #     Toutes les autres sondes du module bornent à 3 s, et le
        #     commentaire de ``get_remote_models_with_status`` dit pourquoi.
        #     Sur un llama-server qui accepte le TCP sans répondre (état
        #     mesuré le 2026-08-22), six tours suffisaient à vider le pool :
        #     les POST de complétion eux-mêmes ne trouvaient plus de connexion.
        _externe = bool(target is not None
                        and not getattr(target, "is_local_llamacpp", True))
        client = _get_llm_client(base_url if _externe else None)
        # En-tête d'auth du connecteur (AUDIT 2026-09-16) : sans lui, toute
        # sonde d'un serveur protégé rendait 401 — « joignable » quand même,
        # mais journalisé comme un refus côté serveur à chaque tour.
        _hdrs = None
        if target is not None and not getattr(target, "is_default", True):
            # Anthropic s'authentifie par ``x-api-key`` : le Bearer OpenAI
            # valait un 401 journalisé à chaque tour (passe robustesse).
            if getattr(target, "wire", "") == "anthropic":
                from llm_core.providers.anthropic import build_headers as _auth_headers
            else:
                from llm_core.providers.openai_compat import headers as _auth_headers
            _hdrs = _auth_headers(target) or None
        await client.get(base_url, timeout=3.0, **({"headers": _hdrs} if _hdrs else {}))
        _preflight_ok_at[base_url] = time.monotonic()
    except Exception as e:
        # Erreur de TRANSPORT typée (classée « injoignable » par la
        # taxonomie) et cause chaînée : l'``Exception`` nue était classée
        # UNKNOWN et perdait la cause (PoolTimeout, ConnectError…).
        raise httpx.ConnectError(label) from e


# ─────────────────────────────────────────────────────────────────────────────
# Cache du modèle "loaded" courant — partagé par les agents et le scheduler.
#
# Utilisé pour résoudre data["model"]="auto" vers le modèle réellement chargé
# en VRAM côté llama-server, plutôt que LLAMA_MODEL (config statique qui peut
# pointer vers un modèle déchargé depuis).
#
# Évite TROIS classes de bugs :
#   1. Pipeline lance une requête sur LLAMA_MODEL alors que llama a un autre
#      modèle chargé → llama doit unload+reload (lent, parfois échoue
#      silencieusement, requête perdue côté logs).
#   2. Membre d'équipe avec model="auto" qui force un switch alors que le
#      coordinateur travaille avec un autre modèle → préemption non voulue.
#   3. UI affichant "auto" comme modèle effectif alors que llama tourne
#      autre chose → confusion utilisateur.
# ─────────────────────────────────────────────────────────────────────────────
_loaded_model_cache: Dict[str, Any] = {"id": None, "ts": 0.0}
_LOADED_MODEL_TTL_S = 5.0  # rafraîchi toutes les 5s max — léger sur llama


async def get_currently_loaded_model() -> Optional[str]:
    """Retourne l'id du modèle actuellement chargé en VRAM côté llama-server.

    Stratégie :
        1. Cache 5 secondes pour ne pas hammerer llama
        2. Query /v1/models, filter status="loaded"
        3. Si aucun loaded ou timeout, retourne None

    Le caller doit faire ``model or LLAMA_MODEL`` ou ``model or 'auto'`` pour
    le fallback final selon le contexte.
    """
    import time
    now = time.monotonic()
    if now - _loaded_model_cache["ts"] < _LOADED_MODEL_TTL_S:
        return _loaded_model_cache["id"]

    # AUDIT 2026-08-23 — distinguer « le serveur a répondu » de « le serveur
    # n'a pas répondu ». ``get_remote_models_with_status`` enferme TOUT son
    # corps dans un try/except et rend ``[]`` sur n'importe quelle panne
    # (injoignable, timeout 3 s, PoolTimeout, JSON invalide) : la branche
    # ``except`` ci-dessous, dont le commentaire annonçait « fallback au
    # dernier connu », ne pouvait donc JAMAIS s'exécuter. Résultat inverse de
    # l'intention : un hoquet d'une seconde écrivait ``None`` dans le cache
    # AVEC UN HORODATAGE FRAIS — le dernier modèle connu était effacé et None
    # verrouillé pour tout le TTL. Symptôme mesuré : « Compacter » pendant un
    # pré-remplissage retombait sur ``LLAMA_MODEL`` (« RAG » ici), POSTait sur
    # un modèle inexistant, et chaque nouvelle tentative re-poisonnait le cache.
    try:
        models, _joignable = await _remote_models_probe()
        if not _joignable:
            # Panne : on rend le dernier connu SANS toucher l'horodatage, pour
            # que la prochaine sonde reparte tout de suite.
            return _loaded_model_cache["id"]
        loaded = [m["id"] for m in models if m.get("status") == "loaded"]
        chosen = loaded[0] if loaded else None
        _loaded_model_cache["id"] = chosen
        _loaded_model_cache["ts"] = now
        return chosen
    except Exception:
        return _loaded_model_cache["id"]  # filet : dernier connu


def get_currently_loaded_model_sync() -> Optional[str]:
    """Version sync : retourne juste la valeur du cache, sans rafraîchir.

    Utilisée par le scheduler à chaque acquire — un cache stale de quelques
    secondes est largement OK pour décider du modèle par défaut, mais on
    ne veut PAS faire d'await asyncio dans le chemin critique des locks.
    """
    return _loaded_model_cache["id"]


def _set_loaded_model_cache(model_id: Optional[str]) -> None:
    """Mis à jour explicitement par les routes admin (load/unload).

    Évite d'attendre le poller pour refléter un changement immédiat.
    """
    import time
    _loaded_model_cache["id"] = model_id
    _loaded_model_cache["ts"] = time.monotonic()


async def _remote_models_probe() -> Tuple[List[Dict[str, Any]], bool]:
    """``(modèles, serveur_joignable)``.

    ``get_remote_models_with_status`` confond depuis toujours « le serveur
    répond une liste vide » et « le serveur ne répond pas » — les deux rendent
    ``[]``. Cette variante sépare les deux, pour que le cache du modèle chargé
    cesse d'être empoisonné par un hoquet (cf. ``get_currently_loaded_model``).
    """
    try:
        p = urlparse(LLAMA_URL)
        base_url = f"{p.scheme}://{p.netloc}/v1/models"
        client = _get_llm_client()
        resp = await client.get(base_url, timeout=3.0)
        if resp.status_code != 200:
            return [], False
        data = resp.json()
        if "data" not in data or not isinstance(data["data"], list):
            return [], True          # le serveur a répondu, mais sans liste
        result = []
        for m in data["data"]:
            if "id" not in m:
                continue
            status_obj = m.get("status") or {}
            status_val = (status_obj.get("value", "unknown")
                          if isinstance(status_obj, dict) else "unknown")
            result.append({"id": m["id"], "status": status_val})
        return result, True
    except Exception as e:                                      # noqa: BLE001
        logger.debug(f"[models] llama-server injoignable ou timeout : {e}")
        return [], False


async def get_remote_models_with_status() -> List[Dict[str, Any]]:
    """Return list of model dicts with id and status from llama-server /v1/models.

    Each dict: {"id": "...", "status": "loaded"|"unloaded"}
    The status comes from the llama-server ``status.value`` field.

    Timeout : 3 secondes maximum. Si llama-server est injoignable, on
    retourne une liste vide rapidement plutôt que de bloquer 10 minutes
    sur le timeout du client httpx partagé (LLAMA_TIMEOUT_SEC=600).
    Sans cette borne, /api/llm/models bloque tous les boots front
    quand llama est down — y compris l'init du canvas Drawflow qui
    n'a aucune dépendance fonctionnelle vers llama.
    """
    try:
        p = urlparse(LLAMA_URL)
        base_url = f"{p.scheme}://{p.netloc}/v1/models"
        client = _get_llm_client()
        # Timeout COURT explicite — override le timeout long du client partagé.
        resp = await client.get(base_url, timeout=3.0)
        if resp.status_code == 200:
            data = resp.json()
            if "data" in data and isinstance(data["data"], list):
                # (passe 6, B8) — le flag vision est dérivé ICI, de l'entrée
                # déjà téléchargée : les consommateurs (cache modèles du bus
                # d'events) n'ont plus à refaire une requête par modèle.
                from llm_core._vision import vision_flag_from_entry
                result = []
                for m in data["data"]:
                    if "id" not in m:
                        continue
                    status_obj = m.get("status") or {}
                    status_val = status_obj.get("value", "unknown") if isinstance(status_obj, dict) else "unknown"
                    result.append({"id": m["id"], "status": status_val,
                                   "vision": vision_flag_from_entry(m)})
                return result
    except Exception as e:
        logger.debug(f"[models] llama-server injoignable ou timeout : {e}")
    return []


def _parse_prometheus_metrics(text: str) -> Dict[str, float]:
    """Texte ``/metrics`` (Prometheus) → ``{nom: valeur}``.

    llama-server publie ``llamacpp:requests_processing`` (deux-points) ; les
    lectures cherchaient ``llamacpp_requests_processing`` et ne trouvaient
    jamais rien : jauge KV absente, créneaux toujours « au repos »
    (2026-09-29). Les noms sont donc normalisés — ``:`` → ``_``, étiquettes
    ``{…}`` retirées."""
    result = {}
    if not text:
        return result
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            name = parts[0].split("{", 1)[0].replace(":", "_")
            try:
                result[name] = float(parts[1])
            except (ValueError, IndexError):
                pass
    return result


def _llama_base_url_sync() -> str:
    p = urlparse(LLAMA_URL)
    return f"{p.scheme}://{p.netloc}"


def get_llm_health_sync() -> Dict[str, Any]:
    """
    Synchronous version of health check (for metrics_engine ThreadPoolExecutor).
    Queries llama-server /health, /v1/models, /metrics via HTTP.
    """
    import httpx as _hx
    base = _llama_base_url_sync()
    result: Dict[str, Any] = {
        "server_reachable": False, "status": "unreachable",
        "models_loaded": [], "metrics": {},
        "kv_cache": {"used": 0, "total": 0, "pct": 0},
    }
    try:
        with _hx.Client(timeout=4.0) as c:
            # /health
            try:
                r = c.get(f"{base}/health")
                if r.status_code == 200:
                    result["server_reachable"] = True
                    h = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                    result["status"] = h.get("status", "ok")
            except Exception:
                pass

            if not result["server_reachable"]:
                return result

            # /v1/models
            try:
                r = c.get(f"{base}/v1/models")
                if r.status_code == 200:
                    data = r.json()
                    result["models_loaded"] = [
                        {"id": m.get("id", "?"), "meta": m.get("meta", {})}
                        for m in data.get("data", [])
                    ]
            except Exception:
                pass

            # /metrics (prometheus)
            try:
                r = c.get(f"{base}/metrics")
                if r.status_code == 200:
                    result["metrics"] = _parse_prometheus_metrics(r.text)
                    m = result["metrics"]
                    kv_used = m.get("llamacpp_kv_cache_tokens", 0)
                    n_ctx = m.get("llamacpp_n_ctx_total", 0)
                    if n_ctx > 0:
                        result["kv_cache"] = {
                            "used": int(kv_used), "total": int(n_ctx),
                            "pct": round(kv_used / n_ctx * 100, 1),
                        }
            except Exception:
                pass

    except Exception:
        pass
    return result


async def get_llm_health() -> Dict[str, Any]:
    """
    Unified LLM health — all via remote HTTP to llama-server.
    Returns: server_reachable, status, models_loaded, kv_cache, metrics.
    """
    result: Dict[str, Any] = {
        "server_reachable": False, "status": "unreachable",
        "models_loaded": [],
        "kv_cache": {"used": 0, "total": 0, "pct": 0},
        "metrics": {},
    }

    # /health
    health = await _llama_get("/health", timeout=3.0)
    if health is not None:
        result["server_reachable"] = True
        result["status"] = health.get("status", "ok")
    else:
        try:
            async with httpx.AsyncClient(timeout=3.0) as c:
                r = await c.get(_llama_base_url())
                result["server_reachable"] = r.status_code < 500
                result["status"] = "ok" if r.status_code < 500 else "error"
        except Exception:
            return result

    # (passe 6, B9) — /v1/models, /metrics et /props (total_slots) sont
    # indépendants les uns des autres : fan-out en parallèle après /health.
    # Avant : 4 aller-retours HTTP EN SÉRIE (jusqu'à 4×3 s sur serveur lent),
    # toutes les 10 s par worker + à chaque GET /api/llm/health.
    async def _slots_probe() -> int:
        try:
            from llm_core._model_info import get_model_total_slots
            return int(await get_model_total_slots() or 0)
        except Exception:
            return 0
    models_data, metrics_text, _total_slots = await asyncio.gather(
        _llama_get("/v1/models", timeout=3.0),
        _llama_get_text("/metrics", timeout=3.0),
        _slots_probe())

    if models_data and "data" in models_data:
        result["models_loaded"] = [
            {"id": m.get("id", "?"), "object": m.get("object", "model"),
             "owned_by": m.get("owned_by", ""), "meta": m.get("meta", {})}
            for m in models_data["data"]
        ]

    # /metrics (prometheus format — has KV cache info, request counts, etc.)
    if metrics_text:
        pm = _parse_prometheus_metrics(metrics_text)
        result["metrics"] = pm
        kv_used = pm.get("llamacpp_kv_cache_tokens", 0)
        n_ctx = pm.get("llamacpp_n_ctx_total", 0)
        if n_ctx > 0:
            result["kv_cache"] = {
                "used": int(kv_used), "total": int(n_ctx),
                "pct": round(kv_used / n_ctx * 100, 1),
            }

    # n_ctx from prometheus metrics (lightweight, already fetched above)
    if result.get("metrics"):
        pm_n_ctx = result["metrics"].get("llamacpp_n_ctx_total", 0)
        if pm_n_ctx > 0:
            result["props"] = result.get("props", {})
            result["props"]["n_ctx"] = int(pm_n_ctx)

    # total_slots from /props (expose au frontend pour l'UI admin read-only) —
    # récupéré dans le fan-out ci-dessus (cache _model_info s'il est peuplé).
    if _total_slots > 0:
        result["props"] = result.get("props", {})
        result["props"]["total_slots"] = _total_slots

    return result
