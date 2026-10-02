# SPDX-License-Identifier: MIT
"""
chatbot_app.routes.chats — génération d'un tour de chat en flux NDJSON.

Route
-----
- POST /api/chat-saved-stream3 — le tour entier (RAG, outils MCP, file du
  moteur, compaction, partiel enregistré à l'annulation).

Le handler n'enchaîne que des étapes : admission (409 si une compression
manuelle ou une génération tourne déjà sur la conversation, 429 au-delà du
plafond d'exécutions du compte), ``prepare_turn`` (``chatbot_app.turn``),
prise du verrou de présence et recalage de la base après une passation,
réservation du verrou, puis ``StreamingResponse(run_turn(...))``. Les autres
routes du chat vivent dans ``chat_control`` (annulation, état, rattachement à
une exécution) et ``chat_compression`` (compression manuelle).

Invariants que le flux tient, et qu'une refonte doit garder :

  - un tour à la fois par conversation : verrou ``flock`` valable pour tous
    les workers (``shared_infra/runtime/chat_locks.py``) ; compaction ou
    génération déjà en cours → 409, trop d'exécutions du compte → 429 ;
  - toute exception levée entre la prise du verrou de présence et le
    ``StreamingResponse`` le relâche avant de remonter (``except
    BaseException`` autour de la relecture de passation, seul ``await`` de
    ce passage) ; le verrou est ensuite réservé dans ``_pending_gen_locks``
    jusqu'à ce que ``run_turn`` le réclame, et un filet le relâche si
    personne ne le réclame. Perdu, il resterait tenu jusqu'au redémarrage du
    worker (409 permanent sur ce chat) ;
  - adresses des serveurs MCP résolues côté serveur, jamais reprises du
    client ;
  - annulation publiée sur le bus d'annulation (tous les workers), partiel
    enregistré ;
  - navigateur déconnecté : l'exécution continue détachée si un outil a
    tourné, si la requête est ``resumable`` ou si
    ``llm.detach_run_on_disconnect`` (``DETACH_RUN_ON_DISCONNECT``) est
    actif, sinon elle s'arrête en enregistrant le partiel ; un Stop explicite
    l'arrête toujours ; tout worker peut la rejoindre
    (``GET /api/chat/{id}/run/events``) ;
  - enregistrement optimiste sur ``updated_at`` : un conflit est signalé,
    rien n'est écrasé ; la persistance précède ``kv_cache`` et ``final`` ;
  - types du flux NDJSON : registre ``llm_core/engine/stream_events.py``.

Ordre des événements d'un tour (en partie figé par
``tests/chatbot/test_flux_route.py``, voir « Couverture » plus bas) :

  1. RAG utilisé : ``mode`` « RAG ON » (« RAG Outils ON » quand le RAG passe
     par ses outils), puis ``rag_sources`` s'il y a des sources ; RAG en
     panne : ``info`` seul ;
  2. ``mode`` : « Génération en cours… » (chemin classique), sinon les
     serveurs MCP actifs et/ou « RAG Outils » (chemin outils) ;
  3. ``queue_status`` si le moteur n'est pas prêt ; ``thinking``
     « En attente… » si une requête sur ce modèle doit attendre un créneau
     du serveur llama.cpp ; d'autres ``queue_status`` pendant cette attente ;
  4. ``queue_cleared`` (seulement si un ``queue_status`` est parti) ;
  5. chemin classique : sur llama.cpp, ``compression_capped``, ou
     ``compression_start`` puis ``compression_done``, si la compaction se
     déclenche ; puis les jetons (``thinking_token``, ``content_token``),
     puis ``thinking_content`` / ``content_replace`` si le raisonnement est
     réattribué ; chemin outils : ``mode`` « Outils prêts… » puis les
     événements de la boucle (``tool_call``, ``tool_result``, jetons…) ;
  6. ``kv_cache``, seulement si l'occupation du contexte a pu être mesurée ;
  7. ``final`` (réponse, métriques, ``persisted``), puis fin du flux.

Modèle en cours de chargement (``queue_status`` ``kind=loading``) : un suivi
ASYNCHRONE (``_start_load_watch``, ``chatbot_app/turn/events.py``) republie
``queue_status`` à chaque pas du chargement, puis émet son propre
``queue_cleared`` une fois le modèle chargé ; ces événements s'intercalent
n'importe où tant que le chargement dure.

Variantes : panne → ``queue_cleared`` si un ``queue_status`` est parti sans
lui (panne pendant l'attente), ``error``, puis ``final`` partiel. Stop
pendant l'attente du moteur → ``final`` partiel seul : ``LLMQueueAborted``
n'est levée que sur le drapeau d'annulation (``cancel_probe``), si bien que
le ``queue_cleared`` émis ensuite est filtré par ``_drop_event_after_cancel``,
et une annulation directe de la tâche n'en émet aucun ; l'onglet qui arrête
retire lui-même le widget (``stopGeneration``, ``frontend/js/app-chat.js``).
Stop pendant la génération → plus aucun événement sauf le ``final`` partiel
et le ``task_step`` ``status=final`` d'un sous-agent (état terminal de sa
ligne). ``ping`` peut s'intercaler à tout moment (flux inactif).

Couverture de ``tests/chatbot/test_flux_route.py`` : chemin sans RAG,
classique et outils, panne, Stop pendant la file et pendant la génération,
détachement. Non couverts : ``thinking`` « En attente… »,
``thinking_content`` / ``content_replace``, événements de compression, suivi
de chargement. Le scénario ``stop_file`` lève ``LLMQueueAborted`` SANS
drapeau d'annulation (faux ordonnanceur) : son ``queue_cleared`` passe donc
avant le ``final``.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from chatbot_app.turn.admission import (
    _PENDING_GEN_LOCK_WATCHDOG_S,
    _acquire_gen_presence,
    _handover_rebaseline_ok,
    _manual_compression_active,
    _pending_gen_locks,
    _release_unclaimed_gen_lock,
    _sweep_pending_gen_locks,
)
from chatbot_app.turn.execution import run_turn
from chatbot_app.turn.preparation import prepare_turn
from shared_infra.chat.store import get_chat
from shared_infra.observability.tracing import swallow
from shared_infra.routes._state import is_chat_cancelled, is_generation_active, router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


@router.post("/api/chat-saved-stream3")
async def api_chat_saved_stream3(request: Request):

    user_id = require_user_id(request)
    # Le client renvoie TOUT l'historique à chaque tour (tool_history, images
    # en data URL) : plusieurs Mo décodés sur la boucle d'événements
    # gèleraient tous les flux du worker le temps du ``json.loads``. Au-delà
    # de 256 Ko, décodage dans un thread.
    _body = await request.body()
    try:
        data = (await asyncio.to_thread(json.loads, _body)
                if len(_body) > 256 * 1024 else json.loads(_body or b"{}"))
    except ValueError:
        raise HTTPException(400, "invalid_json")
    if not isinstance(data, dict):
        raise HTTPException(400, "invalid_json")
    chat_id = (data.get("chat_id") or "").strip()
    # Symétrie avec POST /api/chat/{id}/compress : une compression manuelle
    # réécrit messages_json de CE chat — démarrer un tour pendant ce temps
    # ferait écraser l'état fraîchement compressé par le persist de fin de
    # tour (construit sur un get_chat antérieur).
    if chat_id and _manual_compression_active(user_id, chat_id):
        raise HTTPException(409, "compression_running")
    # Sonde PRÉCOCE « une génération tourne déjà sur ce
    # chat ». Le verrou faisant autorité est pris plus bas (juste avant de
    # rendre le flux) ; celle-ci évite de payer toute la préparation du tour
    # (mémoire, RAG, résolution MCP) pour finir en 409. Elle est volontairement
    # tolérante : une passation (Stop suivi d'une régénération) est laissée
    # passer ici et arbitrée par ``_acquire_gen_presence``.
    _sweep_pending_gen_locks()
    if (chat_id and not is_chat_cancelled(user_id, chat_id)
            and is_generation_active(user_id, chat_id)):
        # « Stop puis régénérer » envoie l'annulation puis re-POSTe aussitôt ;
        # le drapeau d'annulation met jusqu'à ~100 ms à atteindre un AUTRE
        # worker (bus d'annulation). Sans ce court délai de grâce, la
        # régénération recevrait un 409 alors que la passation est en cours.
        # Un vrai doublon (autre onglet) reçoit toujours son 409.
        for _ in range(6):
            await asyncio.sleep(0.1)
            if (is_chat_cancelled(user_id, chat_id)
                    or not is_generation_active(user_id, chat_id)):
                break
        else:
            raise HTTPException(409, "generation_running")
    # Plafond de générations simultanées PAR COMPTE.
    # Les autres gardes sont par (utilisateur, chat) : sans celle-ci, un compte
    # pourrait lancer autant de missions que de chats ouverts et, la file de
    # l'ordonnanceur ne connaissant pas les utilisateurs, monopoliser le
    # serveur. Compté sur les verrous de présence : la vue est cross-worker.
    _max_runs = 0
    with swallow("chat.max_runs_cfg"):
        from shared_infra import config as _cfg_runs
        _max_runs = int(getattr(_cfg_runs, "MAX_RUNS_PER_USER", 0) or 0)
    if _max_runs > 0:
        _n_runs = 0
        with swallow("chat.max_runs_count"):
            from shared_infra.runtime import chat_locks as _cl_runs
            _n_runs = await _cl_runs.count_held_async("gen", user_id=user_id)
        if _n_runs >= _max_runs:
            logger.info("[chat_stream] user=%s a déjà %d génération(s) en "
                        "cours (plafond %d) — refus", user_id, _n_runs, _max_runs)
            raise HTTPException(429, "too_many_runs")
    plan, res, base = await prepare_turn(request, data, user_id, chat_id)
    # Chat neuf : la préparation lui a attribué son identifiant.
    chat_id = plan.chat_id

    # Verrou de présence pris ICI, dernière instruction
    # avant de rendre le flux : c'est le dernier point où l'on peut encore
    # répondre 409 (une fois le StreamingResponse rendu, plus rien ne peut
    # produire un code d'erreur). Toute exception levée d'ici au
    # ``StreamingResponse`` relâche le verrou avant de remonter (relecture de
    # passation ci-dessous) ; la réservation est ensuite surveillée par un
    # filet jusqu'à ce que ``run_turn`` la réclame.
    # Sans lui, deux runs pourraient tourner sur le même chat : il suffit
    # d'une coupure réseau avant le premier outil pour que le retry du client
    # (app-chat.js) atterrisse, via SO_REUSEPORT, sur un AUTRE worker que celui
    # qui streame encore — les deux persisteraient, l'un perdrait en conflit
    # optimiste, et les outils déjà exécutés repartiraient pour un tour.
    _passation: list = []
    _gen_fd = await _acquire_gen_presence(user_id, chat_id, waited_out=_passation)
    # PASSATION (Stop puis régénération) : le chat a été lu AVANT que le run
    # stoppé ait fini de s'arrêter, et celui-ci a persisté son partiel pendant
    # l'attente du verrou. Sans recalage, la garde optimiste de CE tour
    # partirait d'un ``updated_at`` périmé : question et réponse finiraient en
    # conflit, non sauvegardées. Le nouveau tour remplace le run stoppé : on
    # repart de ce qu'il a écrit.
    if _passation and not plan.ephemeral and not plan.chat_read_failed:
        try:
            with swallow("chat.handover_rebaseline"):
                _frais = await asyncio.to_thread(get_chat, user_id, chat_id)
                # Recalage SEULEMENT si le chat porte ce que le run stoppé a
                # pu écrire : l'historique lu + son partiel (``isTruncated``).
                # Un drapeau de Stop périmé (resté sur un autre worker) peut
                # faire passer pour une passation la simple attente d'un tour
                # NORMAL d'un autre onglet ; un recalage inconditionnel
                # adopterait alors ce tour, puis l'écraserait sans conflit.
                # Hors de ce cas, la garde optimiste reste sur la base lue :
                # l'écriture est refusée, rien n'est perdu.
                if _frais and _handover_rebaseline_ok(
                        base.messages, _frais.get("messages")):
                    base.updated_at = _frais.get("updated_at")
                    base.messages = _frais.get("messages")
                    base.title = _frais.get("title") or ""
        except BaseException:
            # Annulation (arrêt du worker, client parti) PENDANT la relecture :
            # le verrou n'est encore ni réservé ni surveillé — relâché ici,
            # sinon il resterait tenu jusqu'au redémarrage du worker.
            if _gen_fd is not None:
                try:
                    from shared_infra.runtime import chat_locks as _cl_rel
                    _cl_rel.release(_gen_fd)
                except Exception:  # noqa: BLE001 — relâche au mieux, l'exception d'origine remonte
                    pass
            raise
    if _gen_fd is not None:
        import time as _t_pend
        _pend_entry = (_gen_fd, _t_pend.monotonic())
        _pending_gen_locks[(user_id, str(chat_id))] = _pend_entry
        # Filet : un client parti AVANT que ``run_turn`` démarre ne le lance
        # jamais — personne ne réclame alors le verrou. Relâché ici sans
        # attendre qu'une autre requête passe par le balayage de CE worker.
        with swallow("chat.pending_lock_watchdog"):
            asyncio.get_running_loop().call_later(
                _PENDING_GEN_LOCK_WATCHDOG_S, _release_unclaimed_gen_lock,
                (user_id, str(chat_id)), _pend_entry)
    return StreamingResponse(run_turn(plan, res, base),
                             media_type="application/x-ndjson; charset=utf-8")
