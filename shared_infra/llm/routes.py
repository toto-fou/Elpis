# SPDX-License-Identifier: MIT
"""
backend.routes.llm — LLM server interaction (model listing, props, sampling
diagnostics, slots, health, load/unload, infill).

Endpoints
---------
Discovery (any authenticated user)
- GET  /api/llm/models                                — cached list of models +
                                                          status; first call
                                                          falls back to a 3 s
                                                          probe so the page boot
                                                          never hangs on a slow
                                                          llama-server
- GET  /api/llm/models/{model_id:path}/props          — /props passthrough with
                                                          fallback to /v1/models
- GET  /api/llm/models/{model_id:path}/effective-params
                                                       — diagnostic: shows the
                                                          merged sampling
                                                          (props + task profile
                                                          + user override)
- GET  /api/llm/health                                — VRAM / GPU / models /
                                                          slots snapshot

Lifecycle (any authenticated user — but log who did it)
- POST /api/llm/models/load                           — load a model. Broadcasts
                                                          INFO/ERROR over the
                                                          system_events bus and
                                                          updates the cache
                                                          immediately
- POST /api/llm/models/unload                         — unload a model. Waits
                                                          up to 5 minutes for
                                                          in-flight requests to
                                                          drain before forcing
- POST /api/llm/infill                                — code-completion infill
                                                          (prefix/suffix). Goes
                                                          through the LLM
                                                          concurrency semaphore.

Module-level state shared with ``_legacy``
------------------------------------------
The model cache and its background refresher live in ``_legacy`` because
``app.py`` lifespan + several other endpoints poke at them. We import them
read-only here:
  - ``_model_cache``, ``_refresh_model_cache``, ``_ensure_model_poller``
  - ``system_events`` — global SSE bus
  - ``CURRENT_LOADED_MODELS`` — used by the load/unload endpoints to keep
    the in-memory mirror in sync (``global`` declaration replaced by a
    direct write to the ``_legacy`` module attribute via setattr).
"""
from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Any, Dict

import httpx

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from shared_infra.security.deps import require_user_id
from shared_infra.db import log_metric
from shared_infra.accounts.users import get_user_by_id
from llm_core import (
    LLM_SEMAPHORE,
    _llama_base_url,
    _set_loaded_model_cache,
    get_llm_health,
    llm_infill,
    load_llm_model,
    unload_llm_model,
    wait_for_slots_idle,
)
from llm_core._scheduling._locks import MODEL_EXCLUSIVITY
from shared_infra.routes._state import router

# Shared state still owned by ``_legacy``. Importing the module (not the
# names) lets us read the *current* value of mutables like ``_model_cache``
# without snapshotting at import time.
from shared_infra.observability.events_bus import CURRENT_LOADED_MODELS, _ensure_model_poller, _model_cache, _refresh_model_cache, refresh_models_everywhere, system_events

import logging
logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
#  SERVEUR VISÉ (AUDIT 2026-09-16)
# ─────────────────────────────────────────────────────────────────────────────
# Ces routes ne pilotaient que le serveur INTÉGRÉ. Elles acceptent désormais
# ``engine`` (query ou corps JSON) : ``builtin`` (défaut, contrat historique
# inchangé) ou ``conn:<id>`` — un connecteur llama.cpp reçoit les mêmes gestes
# (états des modèles, propriétés, charger, décharger, progression). Chaque
# appel contrôle la politique d'accès (lot B4) : serveur visible pour
# l'utilisateur, et droit de gérer les modèles pour charger / décharger.
def _engine_for(request: Request, uid, key: str = ""):
    """``EngineRef`` demandé, pour CET utilisateur — 404 si introuvable,
    403 si la politique d'accès le refuse."""
    from llm_core.engines import BUILTIN_KEY, resolve_engine_for_user
    from shared_infra.llm import engine_access as _ea
    _qp = getattr(request, "query_params", None) or {}
    k = (key or _qp.get("engine") or BUILTIN_KEY).strip()
    eng = resolve_engine_for_user(uid, k)
    if eng is None:
        raise HTTPException(404, "Serveur introuvable")
    if not _ea.can_use_engine(uid, eng.key):
        raise HTTPException(403, "Serveur non autorisé")
    return eng


def _require_manage(uid) -> None:
    from shared_infra.llm import engine_access as _ea
    if not _ea.can_manage_models(uid):
        raise HTTPException(403, "Gestion des modèles non autorisée")


# ─────────────────────────────────────────────────────────────────────────────
#  DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/llm/models")
async def api_list_llm_models(request: Request):
    uid = require_user_id(request)
    if (request.query_params.get("engine") or "builtin") != "builtin":
        return await _connector_models_payload(request, uid)
    from shared_infra.llm import engine_access as _ea
    if not _ea.can_use_engine(uid, _ea.BUILTIN_KEY):
        # Serveur intégré non ouvert à ce compte : catalogue vide, explicite.
        return JSONResponse({
            "models": [], "models_with_status": [], "models_loaded": [],
            "kv_cache": {}, "server_reachable": False, "status": "forbidden",
            "props": {}, "allowed": False, "can_manage": False,
        }, headers={"Cache-Control": "no-cache"})
    _ensure_model_poller()
    # Return cached data (refreshed by background task every 10s)
    if _model_cache:
        return JSONResponse(_model_cache, headers={"Cache-Control": "no-cache"})

    # First call before cache is populated.
    # IMPORTANT : on borne strictement à 3 secondes pour ne JAMAIS bloquer
    # le boot du frontend. Si llama-server est down ou lent, on retourne
    # une réponse vide rapide plutôt que de bloquer 10 minutes (timeout
    # par défaut du client httpx partagé = LLAMA_TIMEOUT_SEC=600).
    #
    # Ce endpoint est appelé au boot de la page agentic, et un blocage
    # long ici fige toute l'init Vue, y compris l'init Drawflow qui n'a
    # AUCUNE dépendance fonctionnelle vers llama. Le canvas doit pouvoir
    # tourner sans llama disponible (édition de pipelines hors-ligne).
    try:
        await asyncio.wait_for(_refresh_model_cache(), timeout=3.0)
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"[models] refresh timeout au premier appel : {e}")
        # On retourne quand même une réponse cohérente (même vide) pour
        # que le frontend puisse continuer son init sans bloquer.
        if not _model_cache:
            return JSONResponse({
                "models": [],
                "models_with_status": [],
                "models_loaded": [],
                "kv_cache": {},
                "server_reachable": False,
                "status": "unreachable",
                "props": {},
            }, headers={"Cache-Control": "no-cache"})
    return JSONResponse(_model_cache, headers={"Cache-Control": "no-cache"})


async def _connector_models_payload(request: Request, uid) -> JSONResponse:
    """Même forme que ``/api/llm/models`` pour un connecteur llama.cpp : le
    sélecteur applique le même code aux deux serveurs."""
    eng = _engine_for(request, uid)
    empty = {"engine": eng.key, "models": [], "models_with_status": [],
             "models_loaded": [], "kv_cache": {}, "props": {},
             "server_reachable": False, "status": "unreachable",
             "router": False, "can_manage": False}
    if not eng.is_llamacpp:
        empty["status"] = "unsupported"
        return JSONResponse(empty, headers={"Cache-Control": "no-cache"})
    from llm_core.providers.llama_caps import engine_caps
    from llm_core.providers.llama_models import model_statuses
    fresh = request.query_params.get("fresh") in ("1", "true")
    caps = await engine_caps(engine=eng, force=fresh)
    if not caps.known:
        return JSONResponse(empty, headers={"Cache-Control": "no-cache"})
    st = await model_statuses(engine=eng, force=fresh) if caps.models_api else {}
    from shared_infra.llm import engine_access as _ea
    out = dict(empty, server_reachable=True, status="ok",
               router=bool(caps.models_api),
               can_manage=bool(caps.models_api and _ea.can_manage_models(uid)))
    if st:
        out["models"] = list(st.keys())
        out["models_with_status"] = [{"id": m, "status": v} for m, v in st.items()]
        out["models_loaded"] = [m for m, v in st.items() if v == "loaded"]
    return JSONResponse(out, headers={"Cache-Control": "no-cache"})


def _is_local_model(model_id: str) -> bool:
    """True si ``model_id`` est servi par le llama-server LOCAL.

    Garde-fou : empêche d'envoyer un nom de modèle CLOUD (d'un connecteur) à
    ``/props`` du routeur local — ce qui le CHARGERAIT (cf. model-select-no-autoload).
    Fail-open tant que le cache n'est pas peuplé (fenêtre de boot), pour ne pas
    bloquer un vrai modèle local ; bloque seulement si on a une liste locale connue
    qui ne le contient pas."""
    if not model_id:
        return False
    try:
        if model_id in CURRENT_LOADED_MODELS:
            return True
        local = _model_cache.get("models")
    except Exception:
        return True
    if not local:
        return True
    return model_id in local


@router.get("/api/llm/models/{model_id:path}/props")
async def api_model_props(model_id: str, request: Request):
    """Get detailed properties for a specific loaded model."""
    uid = require_user_id(request)
    _eng = _engine_for(request, uid)
    if not _eng.is_builtin:
        # Connecteur llama.cpp : SON /props, sans jamais charger le modèle.
        if not _eng.is_llamacpp:
            raise HTTPException(404, "Propriétés indisponibles pour ce serveur")
        from urllib.parse import quote
        from llm_core._llama_http import _llama_get
        props = await _llama_get(
            f"/props?model={quote(model_id, safe='')}&autoload=false",
            timeout=5.0, engine=_eng)
        if not props:
            raise HTTPException(404, "Could not retrieve model properties")
        return JSONResponse(props, headers={"Cache-Control": "no-cache"})
    if not _is_local_model(model_id):
        # Modèle d'un connecteur (cloud/distant) : ne JAMAIS interroger le /props
        # local (le chargerait sur le routeur). Le front ne doit pas appeler ici.
        raise HTTPException(404, "Modèle non local (connecteur) — /props indisponible")

    base = _llama_base_url()
    result = None

    # Method 1: llama-server /props?model=xxx
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{base}/props", params={"model": model_id})
            if r.status_code == 200:
                result = r.json()
    except Exception:
        pass

    # Method 1b: /props without model param (single-model servers)
    if not result:
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{base}/props")
                if r.status_code == 200:
                    result = r.json()
        except Exception:
            pass

    # Method 2: OpenAI-compatible /v1/models
    if not result:
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{base}/v1/models")
                if r.status_code == 200:
                    data = r.json()
                    models = data.get("data", [])
                    for m in models:
                        if m.get("id") == model_id:
                            result = {"openai_compat": True, **m}
                            break
                    if not result and models:
                        result = {"openai_compat": True, **models[0]}
        except Exception:
            pass

    if not result:
        raise HTTPException(404, "Could not retrieve model properties")

    return JSONResponse(result, headers={"Cache-Control": "no-cache"})


@router.get("/api/llm/models/{model_id:path}/effective-params")
async def api_model_effective_params(model_id: str, request: Request):
    """
    Diagnostic : retourne les paramètres de sampling effectifs pour un modèle
    et une tâche donnée, avec la provenance de chaque clé.

    Query params :
      - task : "chat" (défaut) | "tools" | "thinking" | "infill" | "debug"

    Exemple de retour :
        {
          "model_id": "qwen2.5-coder-7b",
          "task": "chat",
          "sources": {
            "props":         {"temperature": 0.7, "top_p": 0.8, ...},
            "task_profile":  {},
            "user_override": {}
          },
          "effective":     {"temperature": 0.7, "top_p": 0.8, ...},
          "param_sources": {"temperature": "props", "top_p": "props", ...}
        }

    Utile pour vérifier d'un coup d'œil quelle config un modèle va appliquer,
    sans avoir à chercher dans les logs ou lancer une vraie requête de chat.
    """
    uid = require_user_id(request)
    task = request.query_params.get("task", "chat")
    if task not in ("chat", "tools", "thinking", "infill", "debug"):
        raise HTTPException(400, f"task invalide : {task}")
    _eng = _engine_for(request, uid)

    # Mode DÉGRADÉ (config seule, AUCUN accès /props ni détection thinking) :
    # demandé explicitement par le front (?degraded=1 — modèle local non
    # chargé : lire /props le CHARGERAIT), ou forcé pour un modèle de
    # connecteur (cloud). Avant : 404 pour les connecteurs → le panneau
    # sampling était entièrement mort alors que les overrides par chat
    # (max_tool_iterations, temperature…) s'appliquent sans /props.
    degraded_q = request.query_params.get("degraded") in ("1", "true")
    if not _eng.is_builtin:
        # Connecteur : mode complet s'il parle llama.cpp (SON /props, via le
        # serveur de la surcharge), dégradé sinon.
        if degraded_q or not _eng.is_llamacpp:
            from llm_core._llm_params import describe_effective_params_degraded
            return JSONResponse(
                describe_effective_params_degraded(model_id=model_id, task=task),
                headers={"Cache-Control": "no-cache"})
        from llm_core.engines import use_engine
        from llm_core._llm_params import describe_effective_params
        try:
            with use_engine(_eng):
                result = await describe_effective_params(model_id=model_id, task=task)
        except Exception as e:
            raise HTTPException(500, f"Erreur résolution params : {e}")
        return JSONResponse(result, headers={"Cache-Control": "no-cache"})
    if degraded_q or not _is_local_model(model_id):
        from llm_core._llm_params import describe_effective_params_degraded
        return JSONResponse(
            describe_effective_params_degraded(model_id=model_id, task=task),
            headers={"Cache-Control": "no-cache"},
        )

    try:
        from llm_core._llm_params import describe_effective_params
        result = await describe_effective_params(model_id=model_id, task=task)
    except Exception as e:
        raise HTTPException(500, f"Erreur résolution params : {e}")

    return JSONResponse(result, headers={"Cache-Control": "no-cache"})


@router.get("/api/llm/health")
async def api_llm_health(request: Request):
    """Full server health: VRAM, models, slots, GPU info."""
    require_user_id(request)
    health = await get_llm_health()
    return JSONResponse(health, headers={"Cache-Control": "no-cache"})


# ─────────────────────────────────────────────────────────────────────────────
#  LIFECYCLE
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/llm/models/load")
async def api_llm_load_model(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    username = me["username"] if me else "?"
    data = await request.json()
    model_path = (data.get("model_path") or "").strip()
    if not model_path:
        raise HTTPException(400, "model_path requis")
    _eng = _engine_for(request, uid, str(data.get("engine") or ""))
    _require_manage(uid)
    if not _eng.is_builtin:
        return JSONResponse(await _connector_load(_eng, model_path, username))

    await system_events.broadcast({
        "type": "log",
        "message": f"[LLM] Chargement modèle: {model_path} (par {username})",
        "level": "INFO",
    })

    # CRITICAL : load doit attendre les slots idle ET tenir MODEL_EXCLUSIVITY
    # pendant tout le switch — sinon un load admin déclenché en plein stream
    # user décharge llama-server au milieu et coupe le token.
    # AUDIT 2026-08-23 — la phrase « la route unload le fait déjà » était
    # FAUSSE : unload n'a jamais pris ce verrou. Elle refuse désormais quand une
    # génération le tient (voir ci-dessous). priority="high" : un load admin
    # explicite passe devant la file. ``use_mcp_path=False`` ne s'applique pas ici (on n'utilise pas
    # ``llm_scheduling_guard``, juste le verrou modèle de niveau 1).
    async with MODEL_EXCLUSIVITY.acquire_for(model_path, priority="high"):
        idle = await wait_for_slots_idle(max_wait_sec=300.0, poll_interval=2.0)
        if not idle:
            await system_events.broadcast({
                "type": "log",
                "message": f"[LLM] Timeout attente slots avant chargement de {model_path} — chargement forcé",
                "level": "WARNING",
            })
        result = await load_llm_model(model_path)

        if result.get("ok"):
            # ``CURRENT_LOADED_MODELS`` is a module-level ``set`` in ``_legacy``.
            # We mutate it in place — set.add() is safe across threads here
            # because all callers run inside the asyncio event loop.
            CURRENT_LOADED_MODELS.add(model_path)
            # Met à jour le cache ``_loaded_model_cache`` côté ``_health.py``
            # immédiatement : sans ça, les résolutions ``model="auto"`` qui
            # suivent (TTL=5s) renverraient l'ancien modèle et déclencheraient
            # un switch forcé à la requête suivante.
            _set_loaded_model_cache(model_path)
            await refresh_models_everywhere()  # ce worker + les autres (bus fichier)
            log_metric("model_load", 1, {"model": model_path, "user": username})
            msg = f"[LLM] Modèle chargé: {model_path}"
            level = "INFO"
        else:
            msg = f"[LLM] Échec: {result.get('error', '?')}"
            level = "ERROR"

    await system_events.broadcast({"type": "log", "message": msg, "level": level})
    return JSONResponse(result)


async def _connector_load(eng, model_path: str, username: str) -> Dict[str, Any]:
    """Chargement sur un connecteur llama.cpp : mêmes garanties que l'intégré
    (exclusivité de modèle DE CE SERVEUR tenue pendant le switch, attente des
    slots inactifs), sans toucher aux miroirs de l'intégré."""
    if not eng.is_llamacpp:
        return {"ok": False, "error": "Serveur sans gestion de modèles."}
    from llm_core._scheduling._engines import scheduling_for
    from llm_core.engines import use_engine
    from llm_core.providers.llama_models import invalidate_statuses
    excl, _sem = scheduling_for(eng)
    async with excl.acquire_for(model_path, priority="high"):
        with use_engine(eng):
            await wait_for_slots_idle(max_wait_sec=300.0, poll_interval=2.0)
            result = await load_llm_model(model_path)
    invalidate_statuses(eng)
    logger.info("[LLM] chargement %s sur %s (par %s) → %s", model_path, eng.key,
                username, "ok" if result.get("ok") else result.get("error"))
    if result.get("ok"):
        log_metric("model_load", 1, {"model": model_path, "user": username,
                                     "engine": eng.key})
    return result


@router.get("/api/llm/models/load-progress")
async def api_llm_load_progress(request: Request):
    """Progression RÉELLE d'un chargement de modèle, en SSE.

    Le sélecteur de modèles affichait une roue : elle tourne aussi bien pour
    trois secondes que pour trois minutes, et ne dit ni où on en est, ni si
    quelque chose avance encore. Le moteur, lui, connaît le pourcentage exact
    (llama.cpp branche le vrai callback de chargement) et l'émet toutes les
    200 ms.

    Contrat volontairement MINCE : ce flux est DÉCORATIF. La fin du
    chargement reste établie par le sondage de statut du client, qui
    fonctionne sur tous les moteurs. Ici, un moteur trop ancien répond
    ``{"supported": false}`` et referme — le client garde sa roue.

    Événements : ``{"pct": 0-100|null, "stage": "text_model", "stages": [...]}``
    puis ``{"done": true, "loaded": true|false|null}``.
    """
    uid = require_user_id(request)
    model_id = (request.query_params.get("model_id") or "").strip()
    if not model_id:
        raise HTTPException(400, "model_id requis")
    _eng = _engine_for(request, uid)

    import json as _json
    from llm_core.engines import use_engine
    from llm_core.providers.llama_caps import engine_caps
    from llm_core.providers.llama_models import watch_load

    caps = await engine_caps() if _eng.is_builtin else await engine_caps(engine=_eng)

    async def _gen():
        if not caps.models_sse:
            # Rétrocompatibilité : on le DIT, plutôt que de laisser le client
            # attendre un flux qui ne viendra jamais.
            yield 'data: {"supported": false}\n\n'
            return

        file: asyncio.Queue = asyncio.Queue(maxsize=64)
        issue: Dict[str, Any] = {}

        async def _on_prog(stage, pct, stages):
            with contextlib.suppress(asyncio.QueueFull):
                file.put_nowait({"pct": pct, "stage": stage or "",
                                 "stages": stages or []})

        async def _suivi():
            try:
                issue["loaded"] = await watch_load(model_id, "", _on_prog,
                                                   timeout_s=600.0)
            finally:
                with contextlib.suppress(asyncio.QueueFull):
                    file.put_nowait(None)          # sentinelle de fin

        # Serveur visé porté par le contexte de la tâche (copié à la création).
        with use_engine(None if _eng.is_builtin else _eng):
            tache = asyncio.create_task(_suivi())
        # AUDIT moteur d'événements 2026-09-25 (B11) — la fin est lue sur la
        # TÂCHE, plus seulement sur la sentinelle : une file pleine (64
        # progressions non lues) avalait le ``None`` final et le flux attendait
        # 620 s avant son ``done``. Et un commentaire SSE toutes les 15 s tient
        # la connexion ouverte à travers les proxies pendant les phases muettes
        # (moteur qui n'a pas encore commencé, le client ouvre le flux AVANT
        # le POST de chargement).
        debut = time.monotonic()
        try:
            while True:
                if tache.done() and file.empty():
                    break
                try:
                    item = await asyncio.wait_for(file.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        return
                    if time.monotonic() - debut > 620.0:
                        break
                    yield ": ping\n\n"
                    continue
                if item is None:
                    break
                yield "data: " + _json.dumps(item) + "\n\n"
                if await request.is_disconnected():
                    return
            yield ("data: " + _json.dumps(
                {"done": True, "loaded": issue.get("loaded")}) + "\n\n")
        finally:
            if not tache.done():
                tache.cancel()

    return StreamingResponse(_gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",      # pas de tampon proxy : c'est du direct
    })


@router.post("/api/llm/models/unload")
async def api_llm_unload_model(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    username = me["username"] if me else "?"
    data = await request.json()
    model_id = (data.get("model_id") or "").strip()
    if not model_id:
        raise HTTPException(400, "model_id requis")
    _eng = _engine_for(request, uid, str(data.get("engine") or ""))
    _require_manage(uid)
    if not _eng.is_builtin:
        return JSONResponse(await _connector_unload(_eng, model_id, username,
                                                   force=bool(data.get("force"))))

    # AUDIT 2026-08-23 — le déchargement était la SEULE opération de cycle de
    # vie sans protection : n'importe quel utilisateur authentifié pouvait
    # arracher le modèle sous une génération en cours.
    #
    # ``wait_for_slots_idle`` ne suffit pas — et en mode routeur ne fait
    # RIEN : le routeur répond `{"status":"ok"}` sans champ ``slots_processing``,
    # et l'absence vaut « inactif » (choix délibéré, cf.
    # tests/llm_core/test_slots_idle_moteur_muet_2026_08_23.py). La sonde rend
    # donc True à la première itération. Par ailleurs un run agentique tient
    # ``MODEL_EXCLUSIVITY`` pendant TOUTE sa durée, exécutions d'outils
    # comprises, sans occuper le moindre slot : même hors routeur, les slots
    # peuvent être vides alors qu'un run de plusieurs heures est en cours.
    #
    # On lit donc l'état du verrou — ``snapshot_async`` voit le CLUSTER quand
    # Redis est actif, pas seulement ce worker — et on refuse. On ne PREND pas
    # le verrou : l'attendre bloquerait la route pendant toute la durée du run
    # alors que le client abandonne à 120 s.
    if not bool(data.get("force")):
        etat = await MODEL_EXCLUSIVITY.snapshot_async()
        if int(etat.get("active_count") or 0) > 0:
            occupe = etat.get("current_model") or "?"
            logger.warning(
                "[LLM] déchargement de %s refusé (par %s) : %d génération(s) "
                "en cours sur %s", model_id, username,
                int(etat.get("active_count") or 0), occupe)
            return JSONResponse({
                "ok": False,
                "error": f"Génération en cours sur « {occupe} » — déchargement refusé",
                "busy_model": occupe,
                "active_count": int(etat.get("active_count") or 0),
            })

    # Attendre que toutes les requêtes en cours soient terminées
    await system_events.broadcast({
        "type": "log",
        "message": f"[LLM] Attente fin des requêtes avant déchargement de {model_id} (par {username})…",
        "level": "INFO",
    })

    idle = await wait_for_slots_idle(max_wait_sec=300.0, poll_interval=2.0)
    if not idle:
        await system_events.broadcast({
            "type": "log",
            "message": f"[LLM] Timeout attente slots pour {model_id} — déchargement forcé",
            "level": "WARNING",
        })

    result = await unload_llm_model(model_id)

    if result.get("ok"):
        CURRENT_LOADED_MODELS.discard(model_id)
        # Invalide le cache ``_loaded_model_cache`` côté ``_health.py``.
        # Sans ça, les résolutions ``model="auto"`` continueraient à renvoyer
        # le modèle qu'on vient de décharger jusqu'à expiration du TTL.
        _set_loaded_model_cache(None)
        await refresh_models_everywhere()  # ce worker + les autres (bus fichier)
        log_metric("model_unload", 1, {"model": model_id, "user": username})
        await system_events.broadcast({
            "type": "log",
            "message": f"[LLM] Modèle déchargé: {model_id}",
            "level": "WARNING",
        })

    return JSONResponse(result)


async def _connector_unload(eng, model_id: str, username: str, *,
                            force: bool) -> Dict[str, Any]:
    """Déchargement sur un connecteur llama.cpp : refusé tant qu'une génération
    tient l'exclusivité de modèle DE CE SERVEUR (même règle que l'intégré)."""
    if not eng.is_llamacpp:
        return {"ok": False, "error": "Serveur sans gestion de modèles."}
    from llm_core._scheduling._engines import scheduling_for
    from llm_core.engines import use_engine
    from llm_core.providers.llama_models import invalidate_statuses
    excl, _sem = scheduling_for(eng)
    if not force:
        etat = await excl.snapshot_async()
        if int(etat.get("active_count") or 0) > 0:
            occupe = etat.get("current_model") or "?"
            return {"ok": False,
                    "error": f"Génération en cours sur « {occupe} » — déchargement refusé",
                    "busy_model": occupe,
                    "active_count": int(etat.get("active_count") or 0)}
    with use_engine(eng):
        await wait_for_slots_idle(max_wait_sec=300.0, poll_interval=2.0)
        result = await unload_llm_model(model_id)
    invalidate_statuses(eng)
    logger.info("[LLM] déchargement %s sur %s (par %s) → %s", model_id, eng.key,
                username, "ok" if result.get("ok") else result.get("error"))
    if result.get("ok"):
        log_metric("model_unload", 1, {"model": model_id, "user": username,
                                       "engine": eng.key})
    return result


@router.post("/api/llm/infill")
async def api_llm_infill(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    username = me["username"] if me else "?"  # noqa: F841 — kept for parity / future log
    _engine_for(request, uid, "builtin")       # infill = serveur intégré seul
    data = await request.json()
    prefix = data.get("input_prefix", "")
    suffix = data.get("input_suffix", "")
    model = (data.get("model") or "").strip() or None

    if not prefix and not suffix:
        raise HTTPException(400, "input_prefix ou input_suffix requis")

    async with LLM_SEMAPHORE.acquire_for(model):
        result = await llm_infill(prefix, suffix, model=model)

    return JSONResponse(result)
