# SPDX-License-Identifier: MIT
"""
chatbot_app.routes.chat_control — pilotage d'un tour en cours et de
ses exécutions.

Routes
------
- POST /api/chat/reasoning-end          — « Répondre maintenant » : coupe le
                                          raisonnement en cours ;
- POST /api/chat/cancel                 — arrêt immédiat du tour (drapeau,
                                          tâche annulée, connexion au moteur
                                          coupée) ;
- POST /api/chat/task-cancel            — arrêt d'un sous-agent, sans le tour ;
- POST /api/chat/compress               — obsolète, sans effet (anciens
                                          clients) ;
- GET  /api/chat/{id}/generation-status — génération en cours ou non ;
- GET  /api/chats/active-runs           — conversations dont un tour tourne,
                                          tous workers confondus ;
- GET  /api/chat/{id}/run/events        — rejeu puis suite en direct d'une
                                          exécution (NDJSON).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from chatbot_app.turn.events import _cancel_engine_stream
from shared_infra.accounts.users import get_username_by_id
from shared_infra.chat.store import get_chat
from shared_infra.observability.tracing import swallow
from shared_infra.routes._helpers import _ndjson_line
from shared_infra.routes._state import (
    _active_chat_tasks,
    is_generation_active,
    mark_chat_cancelled,
    router,
)
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


@router.post("/api/chat/reasoning-end")
async def api_chat_reasoning_end(request: Request):
    """« Répondre maintenant » — coupe le RAISONNEMENT en cours, sans relancer.

    Le geste de repli — annuler la génération et repartir pour un tour
    complet, avec le raisonnement déjà produit en préfixe — ré-évalue tout le
    prompt (des dizaines de secondes sur un contexte long) pour obtenir une
    réponse que le modèle est sur le point d'écrire.

    llama-server sait le faire nativement depuis b10545 : on demande la
    fermeture du bloc de raisonnement et le modèle enchaîne sur sa réponse
    DANS LE FLUX EN COURS. Rien n'est ré-évalué, rien n'est perdu.

    Répond ``{"ok": false, "reason": …}`` quand ce n'est pas possible (moteur
    trop ancien, raisonnement déjà terminé, fonctionnalité coupée) : le client
    retombe alors sur le geste de repli, qui reste correct.
    """
    user_id = require_user_id(request)
    chat_id = ""
    with swallow("chat.api_chat_reasoning_end"):
        body = await request.json()
        if isinstance(body, dict) and body.get("chat_id"):
            chat_id = str(body["chat_id"])
    if not chat_id:
        return {"ok": False, "reason": "no_chat"}
    # Autorisation : la conversation doit appartenir à l'appelant. C'est ICI
    # que ça se vérifie — le magasin, lui, est indexé par conversation seule.
    if not await asyncio.to_thread(get_chat, user_id, chat_id):
        raise HTTPException(status_code=404, detail="chat_not_found")

    from shared_infra.config import LLAMA_REASONING_CONTROL, LLAMA_URL
    if not LLAMA_REASONING_CONTROL:
        return {"ok": False, "reason": "disabled"}
    from shared_infra.llm.reasoning_control import get_completion
    entry = get_completion(chat_id)
    if not entry:
        return {"ok": False, "reason": "no_active_completion"}
    # Le SERVEUR qui porte la complétion (intégré ou
    # connecteur llama.cpp), re-résolu pour CET utilisateur : la clé stockée
    # n'est jamais crue sur parole (connecteur supprimé, retiré à l'appelant).
    from llm_core.engines import BUILTIN_KEY, resolve_engine_for_user
    _ekey = str(entry.get("engine_key") or BUILTIN_KEY)
    _engine = resolve_engine_for_user(user_id, _ekey)
    if _engine is None or not _engine.is_llamacpp:
        return {"ok": False, "reason": "unsupported"}
    # Moteur trop ancien : la route de contrôle n'existe pas. On le dit au
    # lieu de dépenser un aller-retour qui rendra 404 — le client retombe sur
    # le geste de repli, qui reste correct.
    from llm_core.providers.llama_caps import engine_caps
    if not (await engine_caps(engine=_engine)).reasoning_control:
        return {"ok": False, "reason": "unsupported"}

    from llm_core._client import _get_llm_client
    from llm_core.providers.llama_stream import end_reasoning
    if _engine.is_builtin:
        base = (LLAMA_URL or "").rstrip("/")
        for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        _client_rc = _get_llm_client()
    else:
        base = _engine.base_root
        _client_rc = _get_llm_client(base)
    _auth = _engine.header_dict()
    ok = await end_reasoning(_client_rc, base,
                             entry.get("completion_id") or "",
                             entry.get("model") or "",
                             **({"headers": _auth} if _auth else {}))
    logger.info("[reasoning_end] user=%s chat=%s → %s",
                user_id, chat_id[:12], "ok" if ok else "refusé")
    return {"ok": bool(ok), "reason": "" if ok else "engine_refused"}


@router.post("/api/chat/cancel")
async def api_chat_cancel(request: Request):
    """Endpoint appelé par le frontend lors d'un stopGeneration.
    Action TRIPLE pour garantir un cancel immédiat:
      1. Set _cancelled_chats[(uid, chat_id)] → drapeau lu par la boucle
         (rappel ``is_cancelled``)
      2. task.cancel() sur la task worker active → unwind immédiat
      3. Le worker ferme alors la socket llama-server (via httpx.client.aclose())
         ce qui force llama.cpp à arrêter le decoding au prochain token

    Multi-onglets : le ``chat_id`` du body cible l'annulation. Un flag
    indexé par user_id seulement ferait s'annuler mutuellement deux onglets
    de chats différents.
    """
    user_id = require_user_id(request)

    chat_id = None
    with swallow("chat.api_chat_cancel"):
        body = await request.json()
        if isinstance(body, dict):
            cid = body.get("chat_id")
            if cid:
                chat_id = str(cid)

    if chat_id:
        mark_chat_cancelled(user_id, chat_id)
        from shared_infra.routes._state import get_active_chat_task
        task = get_active_chat_task(user_id, chat_id)
        if task and not task.done():
            task.cancel()
            logger.info("[chat_cancel] User %s chat=%s : task.cancel() émis",
                        user_id, chat_id[:12])
        else:
            # Cas NOMINAL en multi-worker : la génération vit dans un autre
            # process. mark_chat_cancelled a diffusé la demande sur le bus
            # (``shared_infra.runtime.cancel_bus``) — le worker qui streame l'applique
            # chez lui sous ~100 ms.
            logger.info("[chat_cancel] User %s chat=%s : pas de task ICI — "
                        "demande diffusée aux autres workers",
                        user_id, chat_id[:12])
        # 4. Arrêt AU NIVEAU DU MOTEUR (llama-server b10545+). Les trois
        #    étapes ci-dessus supposent qu'un worker vivant relaie la demande.
        #    Si le worker qui streamait est mort — ou si le run est adossé à
        #    une session reprenable, où fermer la socket n'arrête plus rien —
        #    seule cette route arrête vraiment la génération, et elle marche
        #    depuis N'IMPORTE QUEL worker : le routeur retrouve la session par
        #    son seul identifiant. Best-effort, jamais bloquant.
        await _cancel_engine_stream(user_id, chat_id)
    else:
        # Mode historique (sans chat_id) : on ne ratisse PAS toutes
        # les tasks de l'user (multi-tabs : annulerait des onglets indépendants).
        # Seules les tasks enregistrées sans chat_id explicite ("__none__")
        # sont concernées. Les clients modernes passent toujours chat_id.
        mark_chat_cancelled(user_id, "__none__")
        cancelled = 0
        for (uid, _cid), task in list(_active_chat_tasks.items()):
            if uid == user_id and _cid == "__none__" and task and not task.done():
                task.cancel()
                cancelled += 1
        logger.warning(
            "[chat_cancel] User %s : appel SANS chat_id (legacy) — "
            "%d task(s) legacy cancellée(s). Le client devrait passer chat_id.",
            user_id, cancelled,
        )
    return {"status": "cancelled"}


@router.post("/api/chat/task-cancel")
async def api_task_cancel(request: Request):
    """Annule UN sous-agent (outil ``task``) SANS tuer le tour parent.

    Pose un flag ciblé (username, child_id) lu par le ``is_cancelled``
    composite de l'enfant (llm_core/tools/task_tool.py) : la boucle enfant
    lève CancelledError, le handler la discrimine et rend au modèle une
    enveloppe ``task_cancelled`` — le tour parent CONTINUE.

    La demande est DIFFUSÉE sur le bus (``shared_infra.runtime.cancel_bus``, canal
    ``kind="child"``) : l'enfant tourne dans le worker qui tient le stream,
    jamais forcément celui qui reçoit ce POST. ``active`` ne décrit donc que
    CE worker — les autres appliquent sous ~100 ms."""
    user_id = require_user_id(request)
    child_id = None
    with swallow("chat.api_task_cancel"):
        body = await request.json()
        if isinstance(body, dict):
            cid = body.get("child_id")
            if cid:
                child_id = str(cid)
    if not child_id:
        raise HTTPException(400, "child_id requis")
    username = get_username_by_id(user_id) or f"user_{user_id}"
    from llm_core.tools.task_tool import cancel_child
    # La diffusion écrit sur le bus fichier sous flock
    # bloquant : hors boucle (l'application locale est du dict/set GIL-safe).
    active = await asyncio.to_thread(cancel_child, username, child_id)
    logger.info("[task_cancel] user=%s child=%s active=%s", username, child_id, active)
    return {"status": "cancelled", "active": active}


@router.post("/api/chat/compress")
async def api_chat_compress(request: Request):
    """[DEPRECATED] Endpoint conservé en no-op pour compatibilité.

    La compression est UNIQUEMENT côté serveur, pendant le flux, déclenchée
    par les seuils de ``/api/admin/compression-config``
    (``llm_core/conversation_compressor.py``). Une seconde compression pilotée
    par le client ferait concurrence à celle-ci (déclenchements décalés,
    résumés écrasés). Ce endpoint retourne simplement ``{compressed: false}``
    pour que les anciens clients ne plantent pas — le serveur fera son
    travail au prochain message envoyé sur le chat.
    """
    user_id = require_user_id(request)
    try:
        data = await request.json()
    except Exception:  # noqa: BLE001 — route sans effet : corps illisible = vide
        data = {}
    messages = data.get("messages", [])
    logger.info(
        "[/api/chat/compress DEPRECATED] call ignored — user=%s, %d msgs — "
        "compression is now backend-only and automatic.",
        user_id, len(messages) if isinstance(messages, list) else 0,
    )
    return JSONResponse({
        "ok":         True,
        "compressed": False,
        "messages":   messages,
        "deprecated": True,
        "reason":     "Server-side compression now runs automatically during chat streaming.",
    })

@router.get("/api/chat/{chat_id}/generation-status")
async def api_chat_generation_status(chat_id: str, request: Request):
    """État « génération en cours » consultable.

    Sans cette route, ``chat_locks.is_held("gen")`` ne serait visible
    qu'au travers de la garde 409 : un utilisateur qui recharge la page
    pendant une génération lancée d'un autre onglet ne verrait RIEN, puis
    recevrait un 409 déroutant en renvoyant un message. Le front interroge
    cet endpoint au chargement d'un chat (soft) et affiche une notice si une
    génération tourne ailleurs.
    """
    user_id = require_user_id(request)
    running = bool(is_generation_active(user_id, chat_id))
    out: Dict[str, Any] = {"generation_running": running, "run_id": None,
                           "resumable": False}
    # De quoi SE RATTACHER au run, pas seulement
    # savoir qu'il existe : identifiant, et la réconciliation du fil (nombre de
    # messages du tour, dernier message utilisateur). Un journal terminé
    # (``final`` émis) vaut « fini » même si le worker tient encore le verrou
    # le temps de sa télémétrie post-final (pas de faux « en cours »).
    with swallow("chat.generation_status.journal"):
        from shared_infra.runtime.run_journal import current_run
        cur = await asyncio.to_thread(current_run, user_id, chat_id)
        if cur and cur.get("ended"):
            out["generation_running"] = running = False
        if cur and running:
            out.update({
                "run_id": cur.get("run_id"), "resumable": True,
                "started_at": cur.get("started_at"),
                "base_count": cur.get("base_count"),
                "is_continue": bool(cur.get("is_continue")),
                "user_message": cur.get("user_message") or "",
                "engine_key": cur.get("engine_key") or "builtin",
            })
            # Tour « Images » : le message rattaché garde sa demande (Régénérer).
            if isinstance(cur.get("image_request"), dict):
                out["image_request"] = cur["image_request"]
    return out


@router.get("/api/chats/active-runs")
async def api_chat_active_runs(request: Request):
    """Conversations de l'utilisateur dont un run tourne (tous workers) —
    alimente la pastille « génération en cours » de la barre latérale, y
    compris après un rechargement ou depuis un autre appareil."""
    user_id = require_user_id(request)
    from shared_infra.runtime.run_journal import list_active_chat_ids
    ids = await asyncio.to_thread(list_active_chat_ids, user_id)
    return {"chat_ids": ids}


@router.get("/api/chat/{chat_id}/run/events")
async def api_chat_run_events(chat_id: str, request: Request):
    """Rejoue puis suit en direct les événements d'un run (NDJSON).

    Même format que ``/api/chat-saved-stream3`` : le client passe chaque ligne
    au MÊME gestionnaire d'événements. Marqueurs propres à ce flux :
    ``replay_done`` (fin du rejeu, passage au direct), ``run_end`` (fin du run),
    ``run_lost`` (le run a disparu sans se terminer : worker tué). Lisible
    depuis n'importe quel worker (journal fichier, cf. ``run_journal``) ;
    le dossier est indexé par l'utilisateur de la SESSION : impossible de lire
    le run d'un autre compte."""
    user_id = require_user_id(request)
    from shared_infra.runtime import chat_locks as _cl, run_journal as _rj
    cur = await asyncio.to_thread(_rj.current_run, user_id, chat_id)
    run_id = (request.query_params.get("run_id") or "").strip() or (cur or {}).get("run_id")
    if not cur or not run_id or cur.get("run_id") != run_id:
        raise HTTPException(404, "run_not_found")
    path = _rj.journal_path(user_id, chat_id, run_id)
    try:
        from_seq = max(0, int(request.query_params.get("from") or 0))
    except (TypeError, ValueError):
        from_seq = 0
    # Scope brut : ``request.session`` lève sans SessionMiddleware (tests).
    _sess = request.scope.get("session") or {}
    _login_ts = _sess.get("_login_ts")
    _sid = _sess.get("_sid")

    async def _events():
        offset = 0
        replay_done = False
        lost_since = None
        last_ping = last_check = time.monotonic()
        last_held_probe = 0.0
        while True:
            # Chaque onglet qui suit un run
            # tourne ici à ~7 Hz. Un ``stat`` sur la boucle (µs) écarte les tours
            # sans nouvelles lignes AVANT de payer le passage en thread de
            # ``read_lines`` (open + seek + read).
            try:
                grew = path.stat().st_size > offset
            except FileNotFoundError:
                yield _ndjson_line({"type": "run_lost", "reason": "journal"})
                return
            except OSError:
                grew = True
            items = []
            if grew:
                try:
                    items, offset = await asyncio.to_thread(_rj.read_lines, path, offset)
                except FileNotFoundError:
                    yield _ndjson_line({"type": "run_lost", "reason": "journal"})
                    return
            for it in items:
                if int(it.get("s") or 0) < from_seq:
                    continue
                ev = dict(it["e"])
                ev["_s"] = int(it.get("s") or 0)
                yield _ndjson_line(ev)
                if ev.get("type") == "run_end":
                    return
            now = time.monotonic()
            # Revalidation de session, ping et déconnexion AVANT le
            # ``continue`` du rejeu : un run qui produit sans pause (tokens,
            # outils) enchaîne des lots non vides et ne passerait JAMAIS par
            # ces contrôles — une session révoquée continuerait de suivre le
            # run jusqu'à la première accalmie.
            if now - last_check > 60.0:
                last_check = now
                try:
                    from shared_infra.security.deps import stream_session_still_valid
                    if not await asyncio.to_thread(stream_session_still_valid,
                                                   int(user_id), _login_ts, _sid):
                        yield _ndjson_line({"type": "session_expired"})
                        return
                except Exception:  # noqa: BLE001 — revalidation best-effort, retentée dans 60 s
                    pass
            if now - last_ping > 20.0:
                last_ping = now
                yield _ndjson_line({"type": "ping"})
            if await request.is_disconnected():
                return
            if items:
                lost_since = None
                continue                 # rejeu : enchaîner sans attendre
            if not replay_done:
                replay_done = True
                yield _ndjson_line({"type": "replay_done"})
            # Un simple ``exists`` : pas de thread pour si peu.
            if _rj.is_ended(user_id, chat_id, run_id):
                # Marque de fin posée : relire une dernière fois (run_end écrit
                # juste avant), sinon clore explicitement.
                items, offset = await asyncio.to_thread(_rj.read_lines, path, offset)
                for it in items:
                    if int(it.get("s") or 0) < from_seq:
                        continue
                    ev = dict(it["e"]); ev["_s"] = int(it.get("s") or 0)
                    yield _ndjson_line(ev)
                    if ev.get("type") == "run_end":
                        return
                yield _ndjson_line({"type": "run_end", "status": "unknown"})
                return
            # Sonde du verrou : une fois par seconde suffit à un délai de grâce
            # de 3 s — et chaque sonde PREND brièvement le flock (cf.
            # chat_locks), autant ne pas le disputer 7 fois par seconde et
            # par onglet à un ``acquire`` concurrent.
            if now - last_held_probe >= 1.0:
                last_held_probe = now
                if not _cl.is_held("gen", user_id, chat_id):
                    # Plus aucun worker ne porte ce run et il ne s'est pas
                    # terminé : délai de grâce (le verrou est rendu juste après
                    # la marque de fin).
                    lost_since = lost_since or now
                    if now - lost_since > 3.0:
                        yield _ndjson_line({"type": "run_lost", "reason": "worker"})
                        return
                else:
                    lost_since = None
            await asyncio.sleep(0.15)

    return StreamingResponse(_events(), media_type="application/x-ndjson; charset=utf-8",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
