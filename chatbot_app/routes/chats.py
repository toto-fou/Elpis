# SPDX-License-Identifier: MIT
"""
chatbot_app.routes.chats — cycle de vie d'un tour de chat : génération en
flux, annulation, rattachement à une exécution en cours, compression.

Routes
------
- POST /api/chat-saved-stream3          — génération en flux NDJSON : le tour
                                          entier (RAG, outils MCP, file du
                                          moteur, compaction, partiel
                                          enregistré à l'annulation) ;
- POST /api/chat/cancel                 — arrêt immédiat du tour (drapeau,
                                          tâche annulée, connexion au moteur
                                          coupée) ;
- POST /api/chat/task-cancel            — arrêt d'un sous-agent, sans le tour ;
- POST /api/chat/reasoning-end          — « Répondre maintenant » : coupe le
                                          raisonnement en cours ;
- GET  /api/chat/{id}/generation-status — génération en cours ou non ;
- GET  /api/chats/active-runs           — conversations dont un tour tourne,
                                          tous workers confondus ;
- GET  /api/chat/{id}/run/events        — rejeu puis suite en direct d'une
                                          exécution (NDJSON) ;
- GET  /api/chat/{id}/compression-state — état de compression (bouton manuel) ;
- POST /api/chat/{id}/compress          — compression manuelle, hors flux ;
- POST /api/chat/compress               — obsolète, sans effet (anciens
                                          clients).

Invariants que ``api_chat_saved_stream3`` tient, et qu'une refonte doit
garder :

  - un tour à la fois par conversation : verrou ``flock`` valable pour tous
    les workers (``shared_infra/runtime/chat_locks.py``) ; compaction ou
    génération déjà en cours → 409, trop d'exécutions du compte → 429 ;
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
    rien n'est écrasé ;
  - types du flux NDJSON : registre ``llm_core/engine/stream_events.py``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import secrets
import time
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException, Request  # noqa: F401  — kept for symmetry / future
from fastapi.responses import JSONResponse, StreamingResponse

from llm_core import (
    apply_rag,
    llama_chat,
    llama_chat_stream_tokens,
    run_chat_multi_mcp,
)

# Import au niveau MODULE : ce nom sert dans une clause ``except`` (cf. D2).
# Importé dans le corps de la coroutine, il n'existerait pas si l'exception
# survenait avant sa ligne d'import — le gestionnaire lèverait alors un
# NameError en masquant l'erreur d'origine.
from llm_core._scheduling import LLMQueueAborted
from shared_infra.accounts.users import (
    get_user_settings,
    get_username_by_id,
)
from shared_infra.chat.store import (
    enforce_recent_chats_cap,
    get_chat,
    get_chat_plan_mode,
    set_title_if_default,
    upsert_chat,
)
from shared_infra.db import (
    log_metric,
)
from shared_infra.observability.events_bus import CURRENT_LOADED_MODELS, _refresh_model_cache, system_events
from shared_infra.observability.tracing import swallow
from shared_infra.observability.usage_ctx import set_usage_context, usage_scope
from shared_infra.routes._helpers import _msg_text, _ndjson_line, last_user_text, recent_user_text
from shared_infra.routes._state import (
    _active_chat_tasks,
    clear_chat_cancellation,
    is_chat_cancelled,
    is_generation_active,
    mark_chat_cancelled,
    register_chat_task,
    router,
    unregister_chat_task,
)
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")

# Références FORTES des tâches fire-and-forget de ce module (cf. M3 de l'audit
# 2026-08-01) : asyncio ne les retient qu'en WeakSet.
_BG_TASKS: set = set()

# ── Verrous de présence RÉSERVÉS par le handler, pas encore réclamés ────────
# AUDIT 2026-08-22 (B1) — la garde « une seule génération par chat » doit être
# posée DANS LE HANDLER (c'est le seul endroit qui peut encore répondre 409),
# alors que le verrou est relâché par ``unregister_chat_task``, à la fin de
# ``gen()``. Entre les deux, une fenêtre : si le client se déconnecte avant la
# PREMIÈRE itération du générateur, son corps n'est jamais exécuté (fermer un
# générateur non démarré ne déroule aucun ``finally``) et le fd resterait
# ouvert pour la vie du process — le chat répondrait 409 pour toujours.
# On garde donc les fd réservés ici ; ``gen()`` les RÉCLAME à son entrée, et
# tout ce qui n'a pas été réclamé au bout du TTL est relâché (balayage
# opportuniste à chaque nouvelle requête de flux, pas de reaper dédié).
_pending_gen_locks: "dict[tuple, tuple]" = {}
_PENDING_GEN_LOCK_TTL_S = 120.0
# Attente max d'une PASSATION : « éditer un message puis régénérer » envoie un
# Stop et re-POSTe dans la foulée, pendant que l'ancien run déroule encore son
# annulation (il tient le verrou). Répondre 409 là-dessus casserait un geste
# parfaitement normal — on attend donc l'unwind, mais seulement si un Stop a
# bien été demandé sur ce chat, et jamais indéfiniment.
_HANDOVER_WAIT_S = 12.0


# Délai du filet par verrou réservé (AUDIT 2026-09-25) : ``gen()`` démarre en
# quelques millisecondes quand le client est là ; au-delà, personne ne le
# réclamera plus.
_PENDING_GEN_LOCK_WATCHDOG_S = 30.0


def _release_unclaimed_gen_lock(key: tuple, entry: tuple) -> None:
    """Relâche CE verrou réservé s'il n'a toujours pas été réclamé (même
    entrée : une réservation plus récente pour le même chat n'est pas
    touchée)."""
    if _pending_gen_locks.get(key) is not entry:
        return
    _pending_gen_locks.pop(key, None)
    try:
        from shared_infra.runtime import chat_locks as _cl
        _cl.release(entry[0])
    except Exception:                                           # noqa: BLE001
        pass
    logger.warning(
        "[chat_stream] verrou de présence réservé jamais réclamé (client "
        "parti avant le flux) — relâché par le filet : %r", key)


def _sweep_pending_gen_locks() -> None:
    """Relâche les verrous réservés que ``gen()`` n'a jamais réclamés."""
    if not _pending_gen_locks:
        return
    import time as _t
    now = _t.monotonic()
    for _k, (_fd, _ts) in list(_pending_gen_locks.items()):
        if now - _ts > _PENDING_GEN_LOCK_TTL_S:
            _pending_gen_locks.pop(_k, None)
            try:
                from shared_infra.runtime import chat_locks as _cl
                _cl.release(_fd)
            except Exception:                                   # noqa: BLE001
                pass
            logger.warning(
                "[chat_stream] verrou de présence réservé jamais réclamé "
                "(client déconnecté avant le flux) — relâché : %r", _k)


def _handover_rebaseline_ok(old, fresh) -> bool:
    """Le chat relu après une passation ne diffère-t-il de la base lue que
    par le PARTIEL du run stoppé ? Accepté : identique, un assistant tronqué
    (``isTruncated``) ajouté en queue, ou le dernier assistant remplacé par
    un tronqué (Stop pendant un « Continuer »)."""
    old = old if isinstance(old, list) else []
    fresh = fresh if isinstance(fresh, list) else []
    if fresh == old:
        return True

    def _trunc(m) -> bool:
        return (isinstance(m, dict) and m.get("role") == "assistant"
                and bool(m.get("isTruncated")))

    if not fresh or not _trunc(fresh[-1]):
        return False
    if len(fresh) == len(old) + 1:
        return fresh[:-1] == old
    if len(fresh) == len(old) and old and (old[-1] or {}).get("role") == "assistant":
        return fresh[:-1] == old[:-1]
    return False


async def _acquire_gen_presence(user_id: int, chat_id: str,
                                waited_out: Optional[list] = None):
    """Prend le verrou de présence « gen » pour ce chat, ou lève 409.

    Retourne le fd (ou ``None`` si le verrouillage est indisponible —
    fail-open historique de ``chat_locks``, l'appelant continue sans garde).

    ``waited_out`` (AUDIT 2026-09-25) : reçoit ``True`` quand le verrou n'a
    été obtenu qu'après une PASSATION (attente de l'unwind d'un run stoppé).
    Ce run a pu persister son partiel pendant l'attente : l'appelant doit
    relire l'état du chat avant sa garde optimiste.
    """
    from shared_infra.runtime import chat_locks as _cl
    # Prises HORS de la boucle (AUDIT 2026-09-26) : ``acquire`` dort jusqu'à
    # 3 × 2 ms pour distinguer une sonde d'un vrai détenteur (B1).
    fd = await _cl.acquire_async("gen", user_id, chat_id)
    if fd is not None:
        return fd
    # AUDIT moteur d'événements 2026-09-25 (B1) — le fail-open se décide sur
    # l'état du DOSSIER de verrous, jamais sur ``is_held`` : le détenteur peut
    # relâcher entre ``acquire`` et la sonde (ou une sonde occuper le verrou),
    # et « pas tenu » concluait alors « verrouillage indisponible » — run lancé
    # SANS verrou. Un ``acquire`` refusé sur un dossier sain = verrou tenu.
    _usable = getattr(_cl, "lock_dir_usable", None)
    if (not _usable()) if _usable is not None else (not _cl.is_held("gen", user_id, chat_id)):
        # Verrouillage indisponible (/tmp inutilisable) : fail-open, comme
        # partout ailleurs — on ne bloque pas l'app sur un défaut de spool.
        return None
    # Verrou tenu. PASSATION ? seulement si un Stop a été demandé sur ce chat
    # (le flag est diffusé à tous les workers par le cancel_bus).
    if is_chat_cancelled(user_id, chat_id):
        import time as _t
        _deadline = _t.monotonic() + _HANDOVER_WAIT_S
        while _t.monotonic() < _deadline:
            await asyncio.sleep(0.2)
            fd = await _cl.acquire_async("gen", user_id, chat_id)
            if fd is not None:
                if waited_out is not None:
                    waited_out.append(True)
                return fd
    else:
        # Détenteur qui vient de relâcher (fin de run à l'instant) : une
        # dernière tentative avant de répondre 409.
        fd = await _cl.acquire_async("gen", user_id, chat_id)
        if fd is not None:
            return fd
    raise HTTPException(409, "generation_running")


async def _cloturer_run(task: "asyncio.Task", user_id: int,
                        chat_id: str | None, *,
                        final_sent: bool = False) -> None:
    """Clôture du run quand le flux se ferme SANS détachement.

    Extrait du ``finally`` de ``gen()`` (audit 2026-08-23) : le bloc n'utilisait
    que ces trois valeurs, et enfoui dans un générateur imbriqué il n'était
    atteignable par aucun test — c'est ce qui avait laissé passer l'annulation
    diffusée en fin de tour NORMALE.

    Deux entrées très différentes y mènent :
      * la déconnexion d'un client alors que le worker travaille encore
        → on annule, on le dit aux autres workers, on attend l'unwind ;
      * la fin normale du tour (``task.done()``) → il n'y a RIEN à annuler,
        juste le verrou de présence à rendre.
    """
    # MAJ-19 — on ATTEND la fin du worker après l'annulation. Avant, on
    # se contentait de ``task.cancel()`` sans l'attendre : le worker
    # continuait jusqu'à son prochain ``await`` et exécutait son
    # ``finally`` (upsert_chat du partiel) APRÈS le retour du handler —
    # pouvant écraser un état plus récent si un nouveau message avait
    # déjà démarré (write-after-write). On borne l'attente pour ne pas
    # bloquer indéfiniment si le worker est gelé sur un I/O réseau.
    # BUG FIX — l'unregister est fait APRÈS le wait_for : sinon un
    # /api/chat/cancel concurrent pendant les 10 s d'attente ne
    # trouverait plus la task via get_active_chat_task.
    # AUDIT 2026-08-22 (B1) — DIRE qu'on annule, pas seulement annuler.
    # Le flag d'annulation est la seule chose que les AUTRES workers
    # voient ; sans lui, la garde de présence prend le verrou encore
    # tenu par ce run mourant pour une génération bien vivante et
    # refuse le tour suivant. Or le cas typique est justement une
    # re-tentative immédiate : le client rejoue un tour SANS OUTIL
    # après une micro-coupure (il ne rejoue jamais un tour qui a
    # exécuté des outils), et la requête atterrit sur un autre worker.
    # Le flag rend ce déroulement lisible partout : la garde attend
    # l'unwind au lieu de répondre 409, et le run visé se termine plus
    # vite (la boucle consulte ce même flag à chaque itération).
    #
    # AUDIT 2026-08-23 — ce bloc ne vaut QUE pour un worker encore
    # vivant. ``_should_detach_run`` rend False dans DEUX cas
    # opposés : la déconnexion sans détachement, et la fin NORMALE du
    # tour (``task_done=True``). Sans cette garde, chaque tour réussi
    # posait le flag d'annulation ET le publiait sur le bus : sur les
    # N-1 autres workers le flag restait collé (``clear_chat_cancellation``
    # est purement local, rien ne le diffuse), la sonde précoce du
    # tour suivant y était neutralisée, la garde de présence prenait ce
    # flag périmé pour la preuve d'un Stop — 12 s de passation au lieu
    # d'un 409 — et le spool d'annulation grossissait d'une ligne par
    # tour RÉUSSI. Une task terminée n'a par ailleurs rien à annuler.
    #
    # (passe 7, R4) — depuis que la télémétrie (sync mémoire + métriques)
    # part APRÈS le 'final' (passe 6, B2), le worker est encore vivant
    # quelques ms (davantage sous contention SQLite) alors que le tour est
    # fini côté client. Un flux fermé dans cette fenêtre (onglet fermé,
    # nouveau message enchaîné → reader.cancel()) tombait dans la branche
    # « annulation » : flag d'annulation publié sur le bus pour un tour
    # réussi — exactement le bug refermé le 2026-08-23. ``final_sent`` :
    # on attend simplement la fin du worker, sans flag ni cancel.
    if final_sent and not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception as _e:
            logger.debug("[chat_stream] worker post-final: %s", _e)
    elif not task.done():
        with swallow("chat.mark_cancel_on_disconnect"):
            mark_chat_cancelled(user_id, chat_id)
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception as _e:
            logger.debug("[chat_stream] worker cleanup: %s", _e)
    # On passe l'identité de NOTRE task : pendant le wait_for
    # ci-dessus, une nouvelle génération sur le même chat peut
    # s'être enregistrée sur la même clé — il ne faut pas la
    # désenregistrer (sinon son Stop perd le task.cancel direct).
    #
    # AUDIT 2026-08-22 (B2) — le désenregistrement (donc la libération
    # du verrou de présence) suit la fin RÉELLE du worker, pas le
    # chronomètre. L'annulation ne s'observe qu'à un ``await`` : un
    # outil parti pour plusieurs minutes (docker exec, git clone) ne
    # déroule pas en 10 s. Libérer quand même, c'était déclarer le chat
    # libre alors qu'un worker fantôme y travaillait encore : le Stop
    # suivant ne le trouvait plus, une compaction pouvait démarrer, et
    # le fantôme finissait par écraser l'état — exactement le
    # write-after-write que cette attente existe pour éviter.
    if task.done():
        unregister_chat_task(user_id, chat_id, task)
    else:
        logger.warning(
            "[chat_stream] worker toujours actif 10 s après l'annulation "
            "(user=%s chat=%s) — présence conservée jusqu'à sa fin réelle",
            user_id, chat_id)
        task.add_done_callback(
            lambda _t, _u=user_id, _c=chat_id, _k=task:
                unregister_chat_task(_u, _c, _k))

def _persist_turn(persist, user_id: int, chat_id: str, title: str, messages: list,
                  *, baseline_updated_at, baseline_messages, baseline_title: str,
                  read_chat=get_chat) -> "tuple[Any, str]":
    """Persistance d'un tour sous garde optimiste, avec reprise du conflit BÉNIN.

    La garde (``expected_updated_at``) refuse l'écriture dès que ``updated_at``
    a bougé depuis le début du tour. C'est voulu contre un tour CONCURRENT
    (autre worker, compaction) — mais ``updated_at`` bouge aussi sans que les
    messages changent : un renommage pendant la génération suffisait à faire
    perdre la réponse (AUDIT 2026-09-16, R2), toast « erreur base » à l'appui.

    Sur conflit, on relit donc le chat : messages identiques à ceux du début
    du tour ⇒ rien de concurrent n'a été écrit, on réécrit sur la nouvelle base
    en gardant le titre choisi entre-temps. Messages différents ⇒ vrai conflit,
    on ne clobbere pas. Retourne ``(résultat de persist, titre écrit)``.
    Synchrone (appelé en thread)."""
    ret = persist(user_id, chat_id, title, messages, time.time(),
                  expected_updated_at=baseline_updated_at)
    if ret is not False or baseline_updated_at is None:
        return ret, title
    try:
        current = read_chat(user_id, chat_id)
    except Exception:                                           # noqa: BLE001
        logger.warning("[chat_stream] relecture après conflit échouée chat=%s",
                       str(chat_id)[:12], exc_info=True)
        return False, title
    if not current or current.get("messages") != baseline_messages:
        return False, title
    stored_title = (current.get("title") or "").strip()
    if stored_title and stored_title != (baseline_title or "").strip():
        title = stored_title
    logger.info("[chat_stream] conflit bénin (chat modifié sans nouveau message, "
                "ex. renommage) chat=%s — réécriture sur la nouvelle base",
                str(chat_id)[:12])
    ret = persist(user_id, chat_id, title, messages, time.time(),
                  expected_updated_at=current.get("updated_at"))
    return ret, title


def _should_detach_run(*, detach_enabled: bool, task_done: bool,
                       user_stopped: bool, tools_ran: bool = False) -> bool:
    """Faut-il DÉTACHER le run plutôt que l'annuler quand le flux se ferme ?

    Le ``finally`` de ``gen()`` s'exécute dans deux situations très
    différentes : la fin NORMALE du flux (le worker a déjà rendu la main) et
    la DÉCONNEXION du client en pleine génération. Seule la seconde pose la
    question.

    - ``detach_enabled`` : ``config.DETACH_RUN_ON_DISCONNECT``, interrupteur
      global de l'exploitant (défaut False).
    - ``tools_ran`` : AU MOINS UN OUTIL a déjà tourné dans ce tour.
      AUDIT 2026-08-22 (B3/B4) — c'est le vrai critère. Un tour qui a écrit des
      fichiers, lancé un shell, commité, dépensé des heures de contexte n'est
      PAS jetable : la fermeture d'onglet, une veille du portable, un
      changement de réseau ou une session qui expire (le front purge alors son
      état et coupe le flux) le tuaient tous. À l'inverse, un tour de pur chat
      sans outil se relance pour trois fois rien : on lui garde le contrat
      historique « fermer l'onglet arrête la génération », qui est aussi le
      seul moyen d'arrêter depuis un onglet qu'on vient de fermer.
    - ``task_done`` : le worker a terminé → il n'y a rien à détacher, et
      ``task.cancel()`` serait de toute façon sans effet.
    - ``user_stopped`` : un Stop EXPLICITE a été demandé. On ne détache jamais
      dans ce cas : c'est une demande d'arrêt, pas une déconnexion subie.
    """
    if task_done or user_stopped:
        return False
    return bool(detach_enabled) or bool(tools_ran)


def _couper_file(q: "asyncio.Queue", drapeau: list) -> None:
    """Le lecteur de la file ``q`` est parti : couper l'alimentation, vider.

    Le worker écrit ses events dans une ``asyncio.Queue(maxsize=1000)`` que
    ``gen()`` draine vers le client. Quand le flux se ferme (client parti,
    onglet fermé, client engorgé coupé par le proxy), plus personne ne lit :
    un ``await q.put`` sur une file PLEINE ne rendrait jamais la main. Le
    worker restait alors bloqué à vie — sur le ``final`` du partiel ou sur la
    sentinelle ``None`` —, son ``finally`` ne se terminait pas, le verrou de
    présence n'était jamais rendu et le chat répondait 409 jusqu'au
    redémarrage.

    ``drapeau`` (liste d'un élément, lue par ``on_event`` et par la
    sentinelle de fin du worker) passe à True AVANT la vidange : plus rien
    n'est mis en file. La vidange réveille un ``put`` déjà en attente (chaque
    ``get_nowait`` libère une place et relance un producteur bloqué). Tant
    qu'un client lit, le drapeau reste à False : le ``final`` lui parvient.
    """
    drapeau[0] = True
    while True:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break


async def _attendre_hors_annulation(fut: "asyncio.Future"):
    """Attend ``fut`` jusqu'à SON terme, même si la tâche courante est annulée.

    Retourne ``(résultat, annulée_pendant)``. Sert à la persistance du tour
    COMPLET : ``await asyncio.to_thread(...)`` interrompu par un Stop rend la
    main tout de suite, mais le thread, lui, continue et écrit le tour. Le
    ``finally`` du worker voyait alors ``_final_assistant == ""`` et
    persistait EN PLUS un partiel : conflit optimiste contre le tour complet
    (toast « non sauvegardé »), méta de fin de tour sautées — et, sous
    contention SQLite, le partiel pouvait écraser le complet.

    Ici l'annulation est ABSORBÉE le temps que l'écriture se termine (le
    ``shield`` protège le thread, la boucle ré-attend après chaque annulation)
    puis retirée du compteur de la tâche (``uncancel``) : l'appelant finit son
    tour normalement (méta, ``final``), puisque la réponse est complète et
    écrite. Une exception de ``fut`` remonte telle quelle.
    """
    annulations = 0
    while True:
        try:
            res = await asyncio.shield(fut)
            break
        except asyncio.CancelledError:
            if fut.cancelled():
                raise
            annulations += 1
    if annulations:
        _t = asyncio.current_task()
        if _t is not None and hasattr(_t, "uncancel"):
            for _ in range(annulations):
                _t.uncancel()
    return res, annulations > 0


async def _drain_coalesced(q, *, window_ms: float = 25.0,
                           idle_ping_s: float = 20.0):
    """Draine la file d'événements du worker vers le client NDJSON, en
    agrégeant les tokens consécutifs (extraite pour testabilité).

    Deux étages d'agrégation des content_token / thinking_token (champ
    ``n`` = nb de tokens agrégés, pour que le front garde un tok/s exact) :

      1. SANS latence (perf vague 4) : tout ce qui est DÉJÀ en file
         (get_nowait) est agrégé — utile quand le client consomme moins
         vite que le LLM ne produit.
      2. Micro-fenêtre BORNÉE ``window_ms`` (perf vague 5) : quand le
         consommateur suit la cadence, l'étage 1 n'agrège jamais (la file
         est toujours vide) → 1 ligne NDJSON par token, soit 60 parses
         JSON + patchs Vue par seconde côté client. On attend donc jusqu'à
         ``window_ms`` de tokens supplémentaires avant d'émettre. Latence
         PERÇUE nulle : le front bufferise de toute façon ses flushs à
         40 ms — une ligne qui arrive ≤ 25 ms plus tard tombe dans le même
         flush (15 ms jusqu'au 2026-09-26 : 1-2 tokens agrégés seulement).
         ``window_ms=0`` restaure le comportement historique.

    Un événement d'un autre type interrompt l'agrégat (``pending``) pour
    préserver strictement l'ordre du flux. S'arrête sur la sentinelle None.

    ``idle_ping_s`` (0 = désactivé) : HEARTBEAT. Un outil long et silencieux
    (``execute_shell`` jusqu'à 600 s, un sous-agent ``task`` jusqu'à 1800 s)
    laissait le flux NDJSON muet pendant tout ce temps. Rien ne casse dans le
    déploiement actuel (Caddy n'impose aucun timeout de réponse), mais c'était
    une dépendance implicite à l'absence de proxy intermédiaire — et un client
    ne pouvait pas distinguer « ça travaille » de « la connexion est morte ».
    On émet donc une ligne ``{"type":"ping"}`` par période de silence ; le
    front l'ignore (aucune branche ne la traite, la chaîne de dispatch tombe
    dans le vide sans effet).
    """
    _COALESCABLE = ("content_token", "thinking_token")

    # Passe d'optimisation 2026-09-26 — les ``tool_call_delta`` (arguments
    # d'un write_file / edit_file streamés par le LLM) sont le type d'event le
    # plus fréquent pendant la génération d'un gros fichier, et n'étaient
    # jamais agrégés : une ligne NDJSON, un encodage, un parse et un maillon de
    # promesse front PAR fragment. Deux deltas consécutifs du même appel
    # (même ``iter`` et ``index``) se concatènent sans perte — le front fait
    # déjà ``argsBuf += args_delta``. Un ``reset`` n'est jamais fusionné.
    def _key(e):
        if not isinstance(e, dict):
            return None
        t = e.get("type")
        if t in _COALESCABLE:
            return (t,)
        if t == "tool_call_delta" and not e.get("reset"):
            return (t, e.get("iter"), e.get("index"))
        return None

    # Marqueur dédié : ``pending`` peut légitimement contenir None
    # (sentinelle de fin tirée par get_nowait pendant l'agrégation) —
    # il doit alors être traité comme un événement, pas comme « vide ».
    _NO_PENDING = object()
    pending = _NO_PENDING
    while True:
        if pending is not _NO_PENDING:
            ev = pending
            pending = _NO_PENDING
        elif idle_ping_s and idle_ping_s > 0:
            try:
                ev = await asyncio.wait_for(q.get(), timeout=idle_ping_s)
            except asyncio.TimeoutError:
                # Silence prolongé (outil long) : on prouve que le flux vit.
                # NB : annuler un Queue.get() ne perd aucun item.
                yield {"type": "ping"}
                continue
        else:
            ev = await q.get()
        if ev is None:
            return
        key = _key(ev)
        if key is not None:
            group = [ev]

            def _take_ready() -> bool:
                """Agrège ce qui est DÉJÀ en file. True = un event d'une autre
                nature a été rencontré (mis dans ``pending``)."""
                nonlocal pending
                while True:
                    try:
                        nxt = q.get_nowait()
                    except asyncio.QueueEmpty:
                        return False
                    if _key(nxt) == key:  # noqa: B023 (même itération)
                        group.append(nxt)  # noqa: B023 (même itération)
                    else:
                        pending = nxt
                        return True

            # Étage 1 : ce qui est déjà en file (gratuit).
            stopped = _take_ready()
            # Étage 2 : micro-fenêtre bornée, seulement si aucun event d'un
            # autre type n'attend (l'ordre du flux prime). UNE pause puis une
            # vidange sans attente — avant, un ``wait_for`` par token armait et
            # annulait un timer et un getter à chaque fois.
            if not stopped and window_ms > 0:
                await asyncio.sleep(window_ms / 1000.0)
                _take_ready()
            if len(group) > 1:
                if key[0] == "tool_call_delta":
                    ev = dict(ev)
                    names = "".join(g.get("name_delta") or "" for g in group)
                    args = "".join(g.get("args_delta") or "" for g in group)
                    ev.pop("name_delta", None)
                    ev.pop("args_delta", None)
                    if names:
                        ev["name_delta"] = names
                    if args:
                        ev["args_delta"] = args
                else:
                    n = sum(int(g.get("n") or 1) for g in group)
                    ev = {**ev, "text": "".join(g.get("text", "") for g in group), "n": n}
        yield ev


def _drop_event_after_cancel(evt_type, cancelled: bool, status=None) -> bool:
    """Garde du flux SSE post-cancel (extraite pour testabilité).

    Après un stop utilisateur on droppe les events parasites (tokens de
    compression/outils qui s'exécutent encore brièvement) — SAUF ``final`` :
    le 'final' du partiel est émis pendant que le flag cancel est encore posé
    et porte ``cancelled``/``persisted`` dont le front a besoin (sinon les
    tokens partiels sont perdus côté UI). Cf. BUG FIX audit 2026-06.

    Exception 2026-07-18 : le BILAN d'un sous-agent (``task_step`` avec
    status="final") passe aussi — il est émis pendant le unwinding du Stop
    parent et porte l'état terminal (cancelled) de la ligne agent ; le
    dropper laissait la ligne en spinner à vie côté UI. Les autres
    ``task_step`` (tick/running/done) restent droppés (bruit post-stop).
    """
    if not cancelled or evt_type == "final":
        return False
    return not (evt_type == "task_step" and status == "final")


def _metrics_for_persist(met) -> dict:
    """Pied d'un message (modèle, durée, débits, jetons, contexte) renvoyé par
    le client pour les tours PRÉCÉDENTS : valeurs simples et bornées
    seulement, jamais de copie du raisonnement ni des outils (2026-09-29 —
    sans cet aller-retour, le pied disparaissait au tour suivant)."""
    if not isinstance(met, dict):
        return {}
    out = {}
    for k, v in list(met.items())[:40]:
        if k in ("tool_history", "thinking") or not isinstance(k, str):
            continue
        if v is None or isinstance(v, (bool, int, float)):
            out[k] = v
        elif isinstance(v, str) and len(v) <= 200:
            out[k] = v
        elif k == "kv_cache" and isinstance(v, dict):
            out[k] = {x: v[x] for x in ("used", "total", "pct")
                      if isinstance(v.get(x), (int, float))}
    return out


def _task_runs_for_persist(runs):
    """Records ``task_runs`` persistés SANS le champ ``tools`` : le déroulé
    outil-par-outil n'est plus rendu depuis la refonte carte agent
    (2026-07-18 — la carte n'itère jamais ``run.tools``, le harnais
    task-verify assert même son absence). Le garder gonflait la DB ET le
    payload round-trippé à chaque tour (cap 50 × args_preview × runs).
    ``transcript`` (UX 2026-07-24) est en revanche CONSERVÉ : c'est le
    déroulé compact borné côté task_tool (120 entrées, texte 1500 c,
    résultat 400 c) qui alimente la modale « œil » de la carte agent
    après rechargement."""
    return [
        {k: v for k, v in r.items() if k != "tools"}
        for r in (runs or []) if isinstance(r, dict)
    ]


async def _cancel_engine_stream(user_id, chat_id: str) -> None:
    """``DELETE /v1/stream`` sur la session du couple (utilisateur, chat).

    Complète le bus d'annulation : celui-ci prévient les WORKERS, ceci arrête
    le MODÈLE. Silencieux si la fonctionnalité est coupée, si le moteur ne la
    connaît pas (404), ou si aucune session ne porte cet identifiant.

    AUDIT 2026-09-16 — le SERVEUR du run est lu dans son journal
    (``run_journal.current_run``) : un tour sur un connecteur llama.cpp est
    arrêté sur CE serveur, avec son en-tête d'auth. Sans journal : l'intégré,
    comme avant.
    """
    try:
        from shared_infra.config import LLAMA_RESUMABLE_STREAM, LLAMA_URL
        if not LLAMA_RESUMABLE_STREAM:
            return
        _engine = None
        with swallow("chat.cancel_engine.resolve"):
            from shared_infra.runtime.run_journal import current_run
            _cur = await asyncio.to_thread(current_run, user_id, chat_id)
            _ekey = (_cur or {}).get("engine_key") or "builtin"
            if _ekey != "builtin":
                from llm_core.engines import resolve_engine_for_user
                _engine = resolve_engine_for_user(user_id, _ekey)
                if _engine is None or not _engine.is_llamacpp:
                    return
        # Le flux n'a été NOMMÉ que si le moteur sait le reprendre : sans
        # cette preuve il n'y a aucune session à supprimer, et l'annulation
        # passe entièrement par le bus (comportement historique).
        # AUDIT 2026-08-23 — règle ASYMÉTRIQUE, et AUCUNE sonde ici.
        # Avant : ``await engine_caps()``, donc (a) une éventuelle sonde de 3 s
        # au beau milieu d'un Stop utilisateur, et (b) un abandon dès que les
        # capacités valaient UNKNOWN — état qu'un simple timeout de sonde
        # installait pour 300 s. L'arrêt moteur devenait alors un no-op
        # silencieux : le modèle continuait de générer, facturé, jusqu'au bout.
        # Or ``conversation_id`` est un HMAC déterministe de (utilisateur,
        # chat) — aucune capacité n'est nécessaire pour le calculer — et
        # ``cancel_stream`` absorbe déjà le 404 d'un moteur qui ne connaît pas
        # la route. On ne renonce donc que sur PREUVE que le moteur est trop
        # ancien, jamais sur une absence de preuve, et sans I/O.
        from llm_core.providers.llama_caps import cached_caps
        _caps = cached_caps(engine=_engine) if _engine is not None else cached_caps()
        if _caps.known and not _caps.resumable_stream:
            return
        from llm_core._client import _get_llm_client
        from llm_core.providers.llama_stream import (
            cancel_stream,
            conversation_id,
        )
        conv = conversation_id(user_id, chat_id)
        if not conv:
            return
        if _engine is not None:
            _auth = _engine.header_dict()
            await cancel_stream(_get_llm_client(_engine.base_root), _engine.base_root,
                                conv, **({"headers": _auth} if _auth else {}))
            return
        base = (LLAMA_URL or "").rstrip("/")
        for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        await cancel_stream(_get_llm_client(), base, conv)
    except Exception as e:
        logger.debug("[chat_cancel] arrêt moteur indisponible : %s", str(e)[:120])


# ─────────────────────────────────────────────────────────────────────────────
#  Chargement d'un modèle : progression RÉELLE plutôt qu'animation
# ─────────────────────────────────────────────────────────────────────────────
#: Un suivi au plus par conversation. Un nouveau tour remplace le précédent —
#: c'est aussi ce qui nettoie un suivi dont le tour a été abandonné.
_LOAD_WATCHERS: Dict[Tuple[Any, str], asyncio.Task] = {}


def _start_load_watch(model: str, on_event, user_id, chat_id: str,
                      base_status: Dict[str, Any]) -> None:
    """Suit le chargement du modèle et republie ``queue_status`` à chaque pas.

    Le widget de file annonçait « Chargement de X… » avec une barre ANIMÉE sur
    une estimation — une durée inventée, qui finissait bloquée à 100 % pendant
    que le modèle montait encore. Le moteur, lui, connaît le vrai pourcentage
    et l'émet sur ``/models/sse`` (échantillon toutes les 200 ms).

    Best-effort de bout en bout : moteur trop ancien, hors routeur ou
    injoignable ⇒ aucun suivi, le widget garde son estimation.
    """
    key = (user_id, chat_id or "")
    old = _LOAD_WATCHERS.pop(key, None)
    if old and not old.done():
        old.cancel()

    async def _run() -> None:
        try:
            from llm_core.providers.llama_models import watch_load

            async def _on_prog(stage, pct, stages) -> None:
                # Le client est parti (onglet fermé, Stop) : inutile de
                # continuer à publier dans le vide.
                if is_chat_cancelled(user_id, chat_id):
                    raise asyncio.CancelledError
                ev = {k: v for k, v in (base_status or {}).items()
                      if k != "type"}
                ev["kind"] = "loading"
                ev["stage"] = stage or ""
                ev["stages"] = stages or []
                if pct is not None:
                    ev["progress_pct"] = round(float(pct), 1)
                await on_event({"type": "queue_status", **ev})

            # ⚠ Borné : un suivi dont le tour est parti sans jamais charger
            # (autre modèle occupé des heures) ne doit pas garder une
            # connexion ouverte indéfiniment.
            if await watch_load(model, "", _on_prog, timeout_s=600.0) is True:
                # Le modèle est en VRAM : le widget n'a plus lieu d'être. Le
                # premier token le retirerait aussi, mais il peut se faire
                # attendre — le pré-remplissage vient seulement de commencer.
                await on_event({"type": "queue_cleared"})
        except asyncio.CancelledError:
            raise
        except Exception as e:                      # noqa: BLE001
            logger.debug("[queue_status] suivi de chargement abandonné : %s",
                         str(e)[:150])
        finally:
            # ⚠ Le finally d'un watcher ANNULÉ s'exécute au tick suivant son
            # cancel() — c'est-à-dire APRÈS que _start_load_watch a enregistré
            # son successeur sous la même clé. Un pop inconditionnel évinçait
            # ce successeur du registre : plus jamais annulable par
            # _stop_load_watch, il courait jusqu'à timeout_s en gardant sa
            # connexion /models/sse.
            if _LOAD_WATCHERS.get(key) is asyncio.current_task():
                _LOAD_WATCHERS.pop(key, None)

    try:
        _LOAD_WATCHERS[key] = asyncio.create_task(
            _run(), name=f"load-watch-{str(chat_id)[:8]}")
    except RuntimeError:
        pass            # pas de boucle (contexte de test) : sans importance


def _stop_load_watch(user_id, chat_id: str) -> None:
    """Arrête le suivi — le tour a commencé, ou il est fini."""
    t = _LOAD_WATCHERS.pop((user_id, chat_id or ""), None)
    if t and not t.done():
        t.cancel()


@router.post("/api/chat/reasoning-end")
async def api_chat_reasoning_end(request: Request):
    """« Répondre maintenant » — coupe le RAISONNEMENT en cours, sans relancer.

    Historiquement ce geste annulait la génération et repartait pour un tour
    complet, avec le raisonnement déjà produit en préfixe : tout le prompt
    était ré-évalué (des dizaines de secondes sur un contexte long) pour
    obtenir une réponse que le modèle était sur le point d'écrire.

    llama-server sait le faire nativement depuis b10545 : on demande la
    fermeture du bloc de raisonnement et le modèle enchaîne sur sa réponse
    DANS LE FLUX EN COURS. Rien n'est ré-évalué, rien n'est perdu.

    Répond ``{"ok": false, "reason": …}`` quand ce n'est pas possible (moteur
    trop ancien, raisonnement déjà terminé, fonctionnalité coupée) : le client
    retombe alors sur l'ancien geste, qui reste correct.
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
    # AUDIT 2026-09-16 — le SERVEUR qui porte la complétion (intégré ou
    # connecteur llama.cpp), re-résolu pour CET utilisateur : la clé stockée
    # n'est jamais crue sur parole (connecteur supprimé, retiré à l'appelant).
    from llm_core.engines import BUILTIN_KEY, resolve_engine_for_user
    _ekey = str(entry.get("engine_key") or BUILTIN_KEY)
    _engine = resolve_engine_for_user(user_id, _ekey)
    if _engine is None or not _engine.is_llamacpp:
        return {"ok": False, "reason": "unsupported"}
    # Moteur trop ancien : la route de contrôle n'existe pas. On le dit au
    # lieu de dépenser un aller-retour qui rendra 404 — le client retombe sur
    # l'ancien geste, qui reste correct.
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
      1. Set _cancelled_chats[(uid, chat_id)] → flag visible par services.py
      2. task.cancel() sur la task worker active → unwind immédiat
      3. Le worker ferme alors la socket llama-server (via httpx.client.aclose())
         ce qui force llama.cpp à arrêter le decoding au prochain token

    BUG FIX (élevé) — multi-tabs : on accepte un ``chat_id`` optionnel
    dans le body. Sans ça, deux onglets de chats différents se cancellaient
    mutuellement via le flag global indexé par user_id seulement.
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
            # (shared_infra/cancel_bus) — le worker qui streame l'applique
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
        # BUG FIX — legacy mode (sans chat_id) : on ne ratisse PAS toutes
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
    # (passe 5, B12) — la diffusion écrit sur le bus fichier sous flock
    # bloquant : hors boucle (l'application locale est du dict/set GIL-safe).
    active = await asyncio.to_thread(cancel_child, username, child_id)
    logger.info("[task_cancel] user=%s child=%s active=%s", username, child_id, active)
    return {"status": "cancelled", "active": active}


@router.post("/api/chat/compress")
async def api_chat_compress(request: Request):
    """[DEPRECATED] Endpoint conservé en no-op pour compatibilité.

    Historiquement : compressait la conversation côté front-triggered, avec
    un résumé non-structuré ``[Résumé des N messages précédents]``. Le
    front-end décidait du seuil et réinjectait le résultat dans le payload
    du chat suivant.

    Problème : cohabitait avec ``backend/services/conversation_compressor.py``
    (compression backend structurée, cumulative, turn+token based) — les
    deux systèmes se déclenchaient à des moments différents et se
    marchaient dessus. Résultat : compressions à moitié appliquées,
    résumés écrasés, perte d'info.

    Aujourd'hui : la compression est UNIQUEMENT backend, côté streaming,
    déclenchée par les seuils configurés dans ``/api/admin/compression-config``.
    Ce endpoint retourne simplement ``{compressed: false}`` pour que les
    anciens clients ne crashent pas — le backend fera son travail au
    prochain message envoyé sur le chat.
    """
    user_id = require_user_id(request)
    try:
        data = await request.json()
    except Exception:
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


# Dernier assistant = UNIQUEMENT un bloc <think> fermé (prefill « Répondre
# maintenant » du front, ou reprise d'un raisonnement tronqué par le plafond).
_THINK_ONLY_RE = re.compile(r"^\s*<think>[\s\S]*</think>\s*$", re.IGNORECASE)

# Placeholder du partiel annulé sans prose : du POINT DE VUE d'une reprise,
# c'est un contenu VIDE (le vrai état continuable est ``resume_thinking``).
_CANCEL_PLACEHOLDER = "_(génération interrompue)_"

_RESUME_ANSWER = (
    "Resume your previous answer exactly where it "
    "stopped. Do not repeat it and do not restart it "
    "from the beginning — simply continue."
)
# BUG FIX « le thinking sort du bloc » : quand le dernier assistant n'est QU'un
# raisonnement (<think>…</think>), la consigne « Reprends ta réponse » invitait
# le modèle à POURSUIVRE son raisonnement — streamé hors balises, donc classé
# content et rendu en markdown. On lui demande explicitement la réponse finale.
# Texte CANONIQUE dans llm_core._think_resume (partagé avec le repli
# d'auto-reprise des moteurs — une divergence recréerait deux comportements).
from llm_core._think_resume import (
    RESUME_AFTER_THINK_INSTRUCTION as _RESUME_AFTER_THINK,
)

# ── Titre de chat par le MODÈLE COURANT (adaptation OpenCode title.txt) ──────
# Appelé UNE fois, au premier tour d'un chat sans titre. Borné pour être quasi
# gratuit : entrée TRONQUÉE (600/240 chars), thinking OFF (chat_template_kwargs
# le coupe au niveau template), max_tokens 24, timeout dur. Best-effort : tout
# échec/sortie douteuse → None, l'appelant garde le titre tronqué historique.
_TITLE_PROMPT = (
    "You are a title generator. Output ONLY a chat title for the conversation "
    "below. A single line, maximum 50 characters, in the SAME language as the "
    "user message. Keep key technical terms, numbers and filenames. No quotes, "
    "no trailing punctuation, no emoji. Never answer the question itself."
)


async def _generate_chat_title(selected_model, first_user_text, assistant_text,
                               chat_id=None):
    _t0 = time.monotonic()
    try:
        _user = (first_user_text or "").strip()[:600]
        if not _user:
            return None
        logger.info("[chat_title] requête de titre (chat neuf) modèle=%s chat=%s",
                    selected_model, str(chat_id or "")[:12])
        _asst = (assistant_text or "").strip()[:240]
        msgs = [
            {"role": "system", "content": _TITLE_PROMPT},
            {"role": "user", "content": _user + (
                f"\n\n[the assistant's reply was about: {_asst}]" if _asst else "")},
        ]
        # Fenêtre LARGE (la tâche part en DÉBUT de tour et tourne en parallèle
        # du tour principal — elle peut faire la queue derrière lui sur un
        # serveur occupé sans rien coûter) ; c'est la RÉCOLTE au persist qui
        # est bornée court (cf. worker).
        # Scope « title » : ces tokens sont réels et n'étaient comptés nulle
        # part (un appel LLM par conversation neuve). Le user est hérité du
        # scope parent — la tâche est créée dans le contexte du tour.
        with usage_scope("title", origin_id=str(chat_id or "")):
            _t, content, _meta = await asyncio.wait_for(
                llama_chat_stream_tokens(
                    msgs, user_id="title", model_override=selected_model,
                    thinking_mode=False,
                    sampling_override={"temperature": 0.2, "max_tokens": 24},
                    chat_id=chat_id,
                    # Hors du slot du chat : posé dessus, le titre en
                    # évinçait le KV et le 2e tour re-préremplissait tout le
                    # 1er (OPTIM 2026-09-26). ``chat_id`` reste transmis pour
                    # le tap « Trafic LLM ».
                    slot_avoid_own=True,
                ),
                timeout=45.0,
            )
        t = (content or "").strip().splitlines()[0].strip()
        t = t.strip('"\'`«»').rstrip(".…:;,").strip()
        # Sortie douteuse (vide, résidu de raisonnement, prose) → fallback.
        if not t or len(t) < 3 or "<think" in t or len(t) > 80:
            logger.info("[chat_title] sortie inutilisable (%r) — fallback tronqué",
                        (content or "")[:60])
            return None
        logger.info("[chat_title] titre généré en %d ms : %r",
                    int((time.monotonic() - _t0) * 1000), t[:60])
        return t[:60]
    except Exception as _e:
        logger.info("[chat_title] échec (%s: %s) — fallback tronqué",
                    type(_e).__name__, str(_e)[:120])
        return None


def _resume_instruction(content) -> str:
    """Consigne de reprise selon la nature du dernier assistant (réponse
    entamée vs raisonnement seul)."""
    with swallow("chat.resume_instruction"):
        if _THINK_ONLY_RE.match(str(content or "")):
            return _RESUME_AFTER_THINK
    return _RESUME_ANSWER


def _tool_entry_sigs(h) -> set:
    """Signatures composites des entrées AGENTIQUES d'une entrée de
    ``tool_history`` (assistant.tool_calls / tool result). Entrées texte
    (assistant sans tool_calls, user) → set vide.

    L'id seul ne suffit pas : les ids fallback (``call_{iter}_{idx}``,
    ``legacy_{iter}_{idx}``) sont déterministes PAR RUN et se répètent d'un
    tour à l'autre — id + nom + préfixe d'arguments (ou de résultat) rend une
    collision entre travail frais et préfixe rejoué improbable."""
    sigs: set = set()
    if not isinstance(h, dict):
        return sigs
    if h.get("role") == "assistant" and h.get("tool_calls"):
        for _tc in h["tool_calls"]:
            if isinstance(_tc, dict):
                _fn = _tc.get("function") or {}
                sigs.add(("tc", _tc.get("id"), _fn.get("name"),
                          str(_fn.get("arguments") or "")[:80]))
    elif h.get("role") == "tool":
        sigs.add(("tr", h.get("tool_call_id"), str(h.get("content") or "")[:80]))
    return sigs


def _kv_gauge_used_tokens(metrics) -> int:
    """Occupation de contexte à pousser dans la jauge (event ``kv_cache``) en
    fin de tour, d'après les metrics du tour — 0 = ne rien pousser.

    ``last_prompt_tokens`` = taille du DERNIER prompt réellement envoyé : c'est
    l'occupation. ``input_tokens`` n'en est une que sur le chat classique (un
    seul appel LLM) ; sur le chemin outils c'est le CUMUL de toutes les
    itérations (``submitted_input_tokens``, sémantique de facturation) — s'y
    replier poussait une jauge à 100 % et déverrouillait la bannière
    « contexte presque plein » à chaque limite d'itérations, fenêtre à 30 %.
    Sans mesure fiable, on masque plutôt que d'afficher un chiffre faux."""
    if not isinstance(metrics, dict):
        return 0
    _lp = metrics.get("last_prompt_tokens")
    if isinstance(_lp, (int, float)) and _lp > 0:
        return int(_lp)
    if "submitted_input_tokens" in metrics or metrics.get("tool_limit_reached"):
        return 0
    try:
        return max(0, int(metrics.get("input_tokens", 0) or 0))
    except (TypeError, ValueError):
        return 0


async def _ctx_usage_snapshot(metrics, model, target) -> Optional[dict]:
    """Occupation RÉELLE du contexte en fin de tour — ``{used, total, pct,
    model, ts}`` ou None si on ne sait pas la mesurer honnêtement.

    Une seule source pour trois consommateurs : l'event ``kv_cache`` (jauge
    live), la pill figée du message (``metrics.kv_cache``, qui n'existait
    qu'en mémoire du client et disparaissait au reload) et
    ``meta_json["ctx_usage"]`` (re-seed de la jauge après rechargement /
    redémarrage). Jauge KV = serveur llama.cpp de la cible (intégré ou
    connecteur, AUDIT 2026-09-16 : ``get_model_context_size`` lit le /props
    de CE serveur) ; un fournisseur non llama.cpp n'a pas de n_ctx mesurable."""
    if not isinstance(metrics, dict) or not metrics:
        return None
    if not getattr(target, "is_llamacpp", False):
        return None
    used = _kv_gauge_used_tokens(metrics)
    if used <= 0:
        return None
    try:
        from llm_core import get_model_context_size as _gmc
        total = int(await _gmc(model or "") or 0)
    except Exception:
        total = 0
    if total <= 0:
        return None
    used = min(used, total)
    return {
        "used": used, "total": total,
        "pct": min(100, round(used / total * 100)),
        "model": str(model or "")[:120],
        "ts": time.time(),
    }


_FC_CHANGES = ("created", "modified", "deleted", "moved")
_FC_SHA = re.compile(r"^[0-9a-f]{64}$")
_FC_MAX = 200


def _fc_clean(e) -> Optional[dict]:
    """Entrée ``files_changed`` validée (vient du client au round-trip)."""
    if not isinstance(e, dict):
        return None
    path = e.get("path")
    if not isinstance(path, str) or not path or len(path) > 1024:
        return None
    out = {"path": path, "change": e.get("change") if e.get("change") in _FC_CHANGES else "modified"}
    for k in ("before", "after"):
        v = e.get(k)
        out[k] = v if isinstance(v, str) and _FC_SHA.match(v) else None
    for k in ("added", "removed"):
        if isinstance(e.get(k), int) and not isinstance(e.get(k), bool) and 0 <= e[k] < 10**8:
            out[k] = e[k]
    if isinstance(e.get("from"), str) and len(e["from"]) <= 1024:
        out["from"] = e["from"]
    return out


def _fc_merge(acc: dict, files) -> None:
    """Fusionne les ``files`` d'un ``tool_result`` dans ``acc`` ({chemin:
    entrée}) : l'état « avant » est celui du PREMIER outil du tour qui a
    touché le fichier, l'état « après » celui du dernier (2026-09-26). Les
    lignes ± ne valent que pour une seule écriture : au-delà, le front les
    recalcule depuis les deux versions."""
    if not isinstance(files, list):
        return
    for raw in files[:_FC_MAX]:
        e = _fc_clean(raw)
        if e is None:
            continue
        prev = acc.get(e["path"])
        if prev is None:
            if len(acc) < _FC_MAX:
                acc[e["path"]] = e
            continue
        merged = dict(prev)
        merged["after"] = e["after"]
        merged.pop("added", None)
        merged.pop("removed", None)
        if prev["change"] == "created":
            merged["change"] = "deleted" if e["change"] == "deleted" else "created"
        elif e["change"] == "deleted":
            merged["change"] = "deleted"
        elif prev["change"] == "deleted":
            merged["change"] = "modified"
        if prev["change"] == "created" and e["change"] == "deleted":
            acc.pop(e["path"], None)              # créé puis supprimé : rien
            continue
        acc[e["path"]] = merged


def _fc_list(msg: dict) -> list:
    """``files_changed`` validé d'un message (round-trip client)."""
    fc = msg.get("files_changed")
    if not isinstance(fc, list):
        return []
    return [e for e in (_fc_clean(x) for x in fc[:_FC_MAX]) if e]


_COMPACTION_NOMBRES = ("round", "threshold", "ctx_size", "tokens_before", "tokens_after", "tokens_saved",
                       "messages_before", "messages_after", "duration_ms", "turns_compressed")


def _compaction_pour_message(c: dict) -> dict:
    """Jalon de compaction gardé sur un message (L5.5) : champs connus,
    bornés (il revient du client au tour suivant)."""
    out: dict = {}
    for k in _COMPACTION_NOMBRES:
        v = c.get(k)
        # Bornes : le client renvoie ces jalons au tour suivant (Infinity,
        # NaN ou 1e300 passent json.loads).
        if isinstance(v, (int, float)) and not isinstance(v, bool) \
                and math.isfinite(v) and 0 <= v < 10**9:
            out[k] = int(v)
    for k, n in (("reason", 32), ("path", 32), ("model_used", 120)):
        v = c.get(k)
        if isinstance(v, str) and v:
            out[k] = v[:n]
    if isinstance(c.get("had_previous_summary"), bool):
        out["had_previous_summary"] = c["had_previous_summary"]
    return out


def _rounds_d_outils(tool_history) -> int:
    """Rounds d'outils (messages assistant porteurs de ``tool_calls``) d'une
    ``tool_history`` — l'unité du ``round`` d'un jalon de compaction."""
    return sum(1 for h in (tool_history or []) if isinstance(h, dict)
               and h.get("role") == "assistant" and h.get("tool_calls"))


def _merge_prev_segment_lists(prev_msg: dict, msg: dict) -> None:
    """« Continuer » : les ``task_runs`` et les exécutions (``run_ids``) du
    segment tronqué passent EN TÊTE de ceux de la continuation (sans
    doublon). Mute ``msg``."""
    # Jalons de compaction de la continuation : leur ``round`` compte depuis
    # la reprise ; la tool_history rechargée = tronc + delta → décalage du
    # nombre de rounds du tronc (format delta seulement, le legacy est
    # cumulatif et ne se recompte pas).
    if prev_msg.get("tool_history_delta") and isinstance(msg.get("compactions"), list):
        _dec = _rounds_d_outils(prev_msg.get("tool_history"))
        if _dec:
            msg["compactions"] = [({**c, "round": int(c.get("round") or 0) + _dec}
                                   if isinstance(c, dict) else c) for c in msg["compactions"]]
    for _k in ("task_runs", "run_ids", "compactions"):
        _anc = prev_msg.get(_k) if isinstance(prev_msg.get(_k), list) else []
        if not _anc:
            continue
        _neuf = msg.get(_k) if isinstance(msg.get(_k), list) else []
        msg[_k] = list(_anc) + [x for x in _neuf if x not in _anc]
    # Fichiers modifiés : l'« avant » du segment tronqué reste la référence.
    _anc_fc = _fc_list(prev_msg)
    if _anc_fc:
        _acc = {e["path"]: e for e in _anc_fc}
        _fc_merge(_acc, _fc_list(msg))
        msg["files_changed"] = list(_acc.values())




def _merge_continue_tool_history(prev_msg: dict, cont_hist, cont_is_delta: bool) -> dict:
    """Fusion de la ``tool_history`` d'un « Continuer » : tronc (message
    tronqué persisté) + delta de la continuation, CONCATÉNÉS.

    → ``{"tool_history": [...], "tool_history_delta": bool}`` ou ``{}`` si
    rien à porter. Le résultat n'est marqué delta que si AUCUN segment legacy
    (cumulatif) n'y entre : un tronc legacy garde le format legacy → la dédup
    de ``_expand_history_for_llm`` coupera son préfixe rejoué."""
    prev_hist = prev_msg.get("tool_history") if isinstance(prev_msg.get("tool_history"), list) else []
    prev_delta = bool(prev_msg.get("tool_history_delta"))
    cont = cont_hist if isinstance(cont_hist, list) else []
    merged = list(prev_hist) + list(cont)
    if not merged:
        return {}
    merged_delta = ((prev_delta or not prev_hist)
                    and (bool(cont_is_delta) or not cont))
    return {"tool_history": merged, "tool_history_delta": merged_delta}


# Rôles acceptés dans le payload client.
#
# ``notice`` = marqueur d'INTERFACE persistant (« conversation compactée »,
# posé par la compaction). Il ne part JAMAIS au modèle — _expand_history_for_llm
# l'exclut — mais il doit traverser le round-trip client, sinon il disparaît du
# fil dès le tour suivant. Il a longtemps manqué ici : la notice était jetée du
# payload, la persistance repartait de la liste filtrée, et le marqueur écrit
# par la compaction s'évaporait au message d'après.
_CLIENT_ROLES = ("user", "assistant", "system", "tool", "notice")

# Champs structurés d'une notice, préservés au persist : ce sont eux qui font
# vivre l'accordéon de vérification et le « contexte ≈ N tokens » après un
# rechargement (le porteur system, lui, est jeté par le front).
_NOTICE_FIELDS = ("kind", "ts", "round", "tokens_after", "summary")


_GRAFT_KEYS = ("tool_history", "tool_history_delta", "task_runs",
               "resume_thinking", "thinkingTruncated", "run_ids", "compactions")


def _graft_stopped_turn_state(filtres: list, persistables: list, db_msgs) -> int:
    """Recolle aux assistants TRONQUÉS du payload l'état d'outils que seule la
    base connaît (cf. appel). Même position, même question juste avant, même
    texte (ou texte vide / placeholder côté client) : sinon rien. Les dicts
    du client sont remplacés par des copies. Rend le nombre de messages
    complétés."""
    if not isinstance(db_msgs, list) or len(filtres) != len(persistables):
        return 0
    n = 0
    for i, m in enumerate(filtres):
        if i >= len(db_msgs):
            break
        if i == 0:
            continue
        d = db_msgs[i]
        if not (isinstance(d, dict) and m.get("role") == "assistant"
                and d.get("role") == "assistant" and d.get("isTruncated")):
            continue
        if m.get("tool_history") or not (d.get("tool_history") or d.get("task_runs")):
            continue
        _prev_c, _prev_d = filtres[i - 1], db_msgs[i - 1]
        if not (isinstance(_prev_d, dict) and _prev_c.get("role") == _prev_d.get("role")
                and _prev_c.get("content") == _prev_d.get("content")):
            continue
        _mc = m.get("content")
        if not (_mc == d.get("content") or _mc in ("", None, _CANCEL_PLACEHOLDER)):
            continue
        _add = {k: d[k] for k in _GRAFT_KEYS if d.get(k) and not m.get(k)}
        if not _add:
            continue
        _add.setdefault("isTruncated", True)
        filtres[i] = {**m, **_add}
        persistables[i] = {**persistables[i], **_add}
        n += 1
    return n


def _normalize_client_messages(messages: list) -> tuple[list, list]:
    """Payload client → ``(filtrés, persistables)``.

    - *filtrés* : les dicts d'origine dont le rôle et le type de contenu sont
      valides — c'est la vue passée à ``_expand_history_for_llm`` et à
      ``last_user_text``, qui peuvent avoir besoin de champs non persistés.
    - *persistables* : des copies à champs whitelistés, base de ce qui sera
      écrit en base à la fin du tour.

    On NE strippe PAS ``tool_history`` (bug mémoire inter-tours) : avant, ne
    garder que role+content effaçait l'historique d'outils des tours précédents
    à chaque persist — dès le 3e tour, le modèle ne retrouvait plus la trace de
    ses appels passés. Même raison pour ``thinking``, ``images``, ``task_runs``
    et les champs de notice.
    """
    filtres: list = []
    for _m in messages or []:
        if not isinstance(_m, dict):
            continue
        if _m.get("role") not in _CLIENT_ROLES:
            continue
        if not isinstance(_m.get("content", ""), (str, list)):
            continue
        filtres.append(_m)

    persistables: list = []
    for m in filtres:
        _mm = {"role": m["role"], "content": m.get("content", "")}
        if m.get("tool_history"):
            _mm["tool_history"] = m["tool_history"]
            # Marqueur de format delta : sans lui, un historique delta
            # re-persisté après un round-trip client redeviendrait « legacy »
            # aux yeux de la dédup d'expansion et du parseur de segments front.
            if m.get("tool_history_delta"):
                _mm["tool_history_delta"] = True
        if m.get("thinking"):
            _mm["thinking"] = m["thinking"]
        # Raisonnement d'un tour coupé en plein think (``truncated_in_think``) :
        # SEULE portion de thinking persistée (``save_chat`` strippe le champ
        # ``thinking`` générique) — c'est elle qui rend un « Continuer » utile
        # (reprise avec le raisonnement au lieu de repartir de zéro). Purgée à
        # la reprise aboutie (cf. fusion Continue).
        if isinstance(m.get("resume_thinking"), str) and m["resume_thinking"]:
            _mm["resume_thinking"] = m["resume_thinking"]
        if m.get("thinkingTruncated"):
            _mm["thinkingTruncated"] = True
        if m.get("images"):
            _mm["images"] = m["images"]
        # Fichiers modifiés par les outils du tour (diffs du chat).
        _fcl = _fc_list(m) if m.get("files_changed") else []
        if _fcl:
            _mm["files_changed"] = _fcl
        # Cartes agents (outil ``task``) des tours PRÉCÉDENTS : préservées au
        # round-trip client → sinon effacées au persist du tour suivant.
        # (``tools`` strippé — dégraisse aussi les records legacy.)
        if m.get("task_runs"):
            _runs_rt = _task_runs_for_persist(m["task_runs"])
            if _runs_rt:
                _mm["task_runs"] = _runs_rt
        # Exécutions du message (``runs``, L5.2) : sinon perdues au persist.
        if isinstance(m.get("run_ids"), list):
            _rids = [r for r in m["run_ids"] if isinstance(r, str) and 0 < len(r) <= 64][:64]
            if _rids:
                _mm["run_ids"] = _rids
        if isinstance(m.get("pruned"), int) and not isinstance(m.get("pruned"), bool) \
                and 0 < m["pruned"] < 100000:
            _mm["pruned"] = m["pruned"]
        # Jalons de compaction du message (L5.5) : sinon perdus au persist.
        if isinstance(m.get("compactions"), list):
            _cps = [_compaction_pour_message(c) for c in m["compactions"][:20] if isinstance(c, dict)]
            if _cps:
                _mm["compactions"] = _cps
        _met = _metrics_for_persist(m.get("metrics"))
        if _met:
            _mm["metrics"] = _met
        if m.get("role") == "notice":
            for _k in _NOTICE_FIELDS:
                if m.get(_k) is not None:
                    _mm[_k] = m[_k]
        persistables.append(_mm)
    return filtres, persistables


def _tronc_pour_reprise(prev: dict) -> str:
    """Tronc à conserver DEVANT la continuation, lors d'un « Continuer ».

    AUDIT 2026-08-23 — ``_CANCEL_PLACEHOLDER`` est un marqueur d'INTERFACE que
    la route écrit elle-même quand une annulation n'a produit aucune prose. Le
    concaténer devant la reprise le fige dans le contenu PERSISTÉ : la réponse
    finale commence par « _(génération interrompue)_ », et surtout l'égalité
    stricte de ``_expand_history_for_llm`` (qui sait, elle, écarter ce marqueur)
    ne reconnaît plus la chaîne fusionnée — le marqueur repart donc au modèle à
    tous les tours suivants. La vue modèle avait la garde, la persistance non.
    """
    texte = _msg_text(prev.get("content", ""))
    return "" if texte.strip() == _CANCEL_PLACEHOLDER else texte


def _split_for_continue(msgs: list) -> tuple[dict, list, list]:
    """Isole le dernier assistant d'un fil pouvant se terminer par des notices.

    Retourne ``(prev, avant, apres)`` — ``prev`` vaut ``{}`` si le fil ne se
    termine pas par un assistant, et l'appelant ne fusionne alors rien.

    Une notice est ajoutée EN FIN de fil par la compaction : elle peut donc
    s'intercaler après le dernier assistant. Un simple ``msgs[-1]`` raterait la
    fusion d'un « Continue » lancé juste après une compaction, et le
    rechargement afficherait DEUX bulles assistant — précisément ce que cette
    fusion existe pour éviter. ``apres`` est réinjecté après le message
    fusionné pour que la notice ne change pas de place dans le fil.
    """
    i = len(msgs) - 1
    while i >= 0 and (msgs[i] or {}).get("role") == "notice":
        i -= 1
    if i < 0 or (msgs[i] or {}).get("role") != "assistant":
        return {}, msgs, []
    return msgs[i], msgs[:i], msgs[i + 1:]


def _plan_mode_should_end(plan_mode: bool, persisted: bool, ephemeral: bool,
                          metrics: dict | None) -> bool:
    """Mode plan ONE-SHOT : le tour qui s'achève doit-il couper le mode ?

    Le mode couvre UN tour abouti, puis le serveur le coupe lui-même
    (autorité). On ne coupe PAS sur :
      - troncature (plafond tokens OU limite de boucle d'outils) — le
        « Continuer » doit reprendre EN mode plan, sinon la fin du plan
        repartirait avec les outils d'écriture ;
      - persist en échec (conflit optimiste = un tour concurrent écrit sur ce
        chat — on ne mute pas son meta_json sous lui) ;
      - session éphémère (aucun chat en base).
    Les chemins annulation/erreur n'appellent jamais ce helper : le plan n'a
    pas été rendu, le mode reste.
    """
    if not plan_mode or not persisted or ephemeral:
        return False
    if metrics and (metrics.get("truncated") or metrics.get("tool_limit_reached")):
        return False
    return True


def _expand_history_for_llm(messages: list, *, is_continue: bool = False,
                            pruned_keys=(), resume_native: bool = False,
                            user_suffixes=None) -> list:
    """Expanse l'historique client en messages OpenAI pour le LLM :
    ``tool_history`` persistée → messages assistant(tool_calls)/tool/user
    intercalés, + prompt de reprise si ``is_continue`` sur le dernier
    assistant.

    Deux formats de ``tool_history`` coexistent :
      • DELTA (``tool_history_delta`` sur le message) : uniquement le travail
        du run qui a produit ce message → expansion intégrale ;
      • LEGACY (non marqué) : capture CUMULATIVE depuis le 1er message
        agentique — chaque historique re-contient ceux des tours précédents.
        Expansé tel quel, le payload DOUBLAIT à chaque tour (1, 7, 19, 43,
        91, 187 messages…) jusqu'à saturer n_ctx (« génération interrompue »
        systématique). On coupe donc le préfixe déjà émis (signatures
        composites, cf. _tool_entry_sigs) — croissance ramenée à ~linéaire
        sans migration des chats existants.

    PARTAGÉ par la route de streaming ET la compression manuelle : les deux
    doivent produire exactement la même structure de tours, sinon le
    ``covered_turns`` persisté par l'un serait incohérent pour l'autre
    (le fallback no-drop rattraperait, mais en perdant l'économie du drop).

    ``pruned_keys`` (harnais v4, M4) : clés d'élagage persistées
    (``meta_json["ctx_pruned_keys"]``) — les tool_results correspondants
    sont rendus comme MARQUEUR plein dans la vue modèle (monotone, le
    stockage reste complet).

    ``resume_native`` : le serveur cible accepte ``continue_final_message``
    (support CONFIRMÉ, cf. ``continue_final_support``) — un Continue sur un
    assistant think-only (``resume_thinking``) émet alors la forme native
    ``{assistant, content:"", reasoning_content}`` en DERNIER message
    (build_llama_payload arme les flags) : la génération reprend DANS le bloc
    think. Sinon, repli « <think>…</think> fermé + consigne de conclusion ».
    """

    def _resume_tail_for(_rt: str) -> list:
        from llm_core._think_resume import clip_resume_thinking
        _rt = clip_resume_thinking(str(_rt))
        if resume_native:
            return [{"role": "assistant", "content": "", "reasoning_content": _rt}]
        return [
            {"role": "assistant", "content": "<think>\n" + _rt + "\n</think>"},
            {"role": "user", "content": _RESUME_AFTER_THINK},
        ]

    _pruned = set(pruned_keys or ())
    if _pruned:
        from llm_core.context.pruning import PRUNE_CLEARED_MARKER, _prune_key
    out: list = []
    # Signatures des entrées agentiques déjà émises — sert à couper le
    # préfixe rejoué des historiques LEGACY cumulatifs.
    seen_sigs: set = set()
    _suffixes = user_suffixes if isinstance(user_suffixes, dict) else {}
    if _suffixes:
        from llm_core.context.pruning import merge_user_suffix, user_suffix_sig
    _user_rank = 0
    _last_user_i = max((j for j, mm in enumerate(messages)
                        if (mm or {}).get("role") == "user"), default=-1)
    # ``last_idx`` = dernier message NON-notice : la consigne de reprise
    # (is_continue) vise le dernier assistant même si une notice de
    # compaction a été ajoutée après lui.
    last_idx = len(messages) - 1
    while last_idx >= 0 and (messages[last_idx] or {}).get("role") == "notice":
        last_idx -= 1
    for _i, _m in enumerate(messages):
        _role = _m.get("role")
        # ``notice`` = marqueur UI persisté (ex. « conversation compactée »,
        # posé par /compress) : affiché dans le fil, JAMAIS envoyé au modèle
        # (role inconnu → 400 Jinja) ni compté dans l'indexation des tours.
        if _role == "notice":
            continue
        _content = _m.get("content")
        _hist = _m.get("tool_history") if isinstance(_m, dict) else None
        if _role == "assistant" and isinstance(_hist, list) and _hist:
            _start = 0
            if not _m.get("tool_history_delta"):
                # LEGACY cumulatif : le préfixe rejoué est en TÊTE. On avance
                # tant que les signatures ont déjà été émises et on s'ARRÊTE à
                # la première entrée fraîche.
                #
                # AUDIT 2026-08-01 (C3) — avant, cette boucle retenait le
                # DERNIER index vu (`_last_seen = _k` sans `break`). Or les ids
                # de repli sont déterministes et se répètent d'un tour à
                # l'autre (`providers/llamacpp.py` émet `call_{i}` indexé sur
                # la position ; idem `call_{iter}_{idx}`), si bien qu'un outil
                # idempotent rappelé avec les mêmes arguments — `ls`,
                # `git status`, `read_file` — produit en QUEUE une signature
                # déjà vue. `_start` sautait alors par-dessus du travail frais :
                # soit il était retiré de la vue du modèle, soit la coupe
                # tombait entre un `assistant.tool_calls` et son résultat, et
                # le message `tool` orphelin faisait répondre 400 au provider
                # (« génération interrompue »).
                _start = 0
                for _k, _h in enumerate(_hist):
                    _sigs = _tool_entry_sigs(_h)
                    if not _sigs:
                        # Entrée texte : aucune signature, donc impossible de
                        # dire si elle a déjà été émise. Elle ne tranche pas et
                        # ne fait pas avancer la coupe (elle sera incluse dans
                        # le préfixe si une entrée VUE la suit).
                        continue
                    if _sigs <= seen_sigs:
                        _start = _k + 1          # entrée du préfixe rejoué
                        continue
                    break                        # première entrée FRAÎCHE
                # Les entrées ``user`` de tête après la coupe (prompts des
                # tours précédents / nudges) sont déjà présentes en messages
                # plats — les rejouer les dupliquerait.
                while _start < len(_hist) and (_hist[_start] or {}).get("role") == "user":
                    _start += 1
                # Ne JAMAIS commencer sur un résultat d'outil : sans son
                # ``assistant.tool_calls``, le provider rejette le payload.
                while _start < len(_hist) and (_hist[_start] or {}).get("role") == "tool":
                    _start += 1

            for _h in _hist[_start:]:
                if not isinstance(_h, dict):
                    continue
                _hr = _h.get("role")
                if _hr not in ("assistant", "tool", "user"):
                    continue

                _expanded = {"role": _hr}
                if "content" in _h:
                    _expanded["content"] = _h.get("content")
                if _hr == "assistant" and _h.get("tool_calls"):
                    _expanded["tool_calls"] = _h["tool_calls"]
                if _hr == "tool" and _h.get("tool_call_id"):
                    _expanded["tool_call_id"] = _h["tool_call_id"]
                    # Marque d'élagage (M4) : contenu ENTIER remplacé par le
                    # marqueur dans la vue envoyée — jamais dans le stockage.
                    if _pruned and _prune_key(_h) in _pruned:
                        _expanded["content"] = PRUNE_CLEARED_MARKER
                out.append(_expanded)
                seen_sigs |= _tool_entry_sigs(_h)

            if is_continue and _i == last_idx:
                # BUG FIX — is_continue sur un assistant AVEC tool_history :
                # avant on sautait simplement le content sans injecter le prompt
                # de reprise → le modèle ne savait pas qu'il devait continuer.
                _c_str = str(_content).strip() if _content else ""
                if _c_str and _c_str != _CANCEL_PLACEHOLDER:
                    out.append({"role": "assistant", "content": _content})
                    out.append({"role": "user", "content": _resume_instruction(_content)})
                elif _m.get("resume_thinking"):
                    # Tour coupé en PLEIN raisonnement (content vide) : reprise
                    # À PARTIR du raisonnement persisté — avant, aucune consigne
                    # n'était injectée (garde ``_content``) et le modèle
                    # repartait de zéro → re-raisonnait 5-10 min → retombait sur
                    # le même mur, en boucle.
                    out.extend(_resume_tail_for(_m["resume_thinking"]))
            else:
                if _content:
                    out.append({"role": "assistant", "content": _content})
        else:

            if is_continue and _i == last_idx and _role == "assistant":
                _c_str = str(_content).strip() if _content else ""
                if _c_str and _c_str != _CANCEL_PLACEHOLDER:
                    out.append({"role": "assistant", "content": _content})
                    out.append({"role": "user", "content": _resume_instruction(_content)})
                elif _m.get("resume_thinking"):
                    # Même trou que la branche tool_history : cf. ci-dessus.
                    out.extend(_resume_tail_for(_m["resume_thinking"]))
                continue
            # AUDIT 2026-09-25 — rejeu À L'OCTET du suffixe réservé au modèle
            # (rappel ``<todo_status>``) que la boucle avait fusionné à cette
            # question : sans lui, le préfixe KV divergeait dès elle au tour
            # suivant. Jamais sur la DERNIÈRE question (le tour en cours reçoit
            # son propre rappel, frais, de la boucle).
            # AUDIT 2026-09-26 — sur un « Continuer », la dernière question
            # est celle du tour REPRIS : elle a reçu (et persisté) son rappel
            # pendant ce tour ; la boucle fusionne le rappel frais dans la
            # consigne de reprise, pas dans elle. Sans ce rejeu, le préfixe
            # divergeait sur elle et tout le tour tronqué était re-prérempli.
            if _role == "user" and _suffixes and (_i < _last_user_i or is_continue):
                _sig = user_suffix_sig(_user_rank, _content)
                if _sig in _suffixes:
                    _content = merge_user_suffix(_content, _suffixes[_sig])
            if _role == "user":
                _user_rank += 1
            out.append({"role": _role, "content": _content})
    return out


# Compressions MANUELLES en vol : {(user_id, chat_id)}. Cache LOCAL au worker,
# doublé d'un verrou de présence PARTAGÉ (``shared_infra.runtime.chat_locks``) : le set
# seul était aveugle aux autres workers gunicorn, donc un /compact concurrent
# sur le même chat passait au lieu de répondre 409. La concurrence optimiste
# (``expected_updated_at``) empêchait la perte de données, mais en sacrifiant
# le tour : conflit au persist → réponse NON sauvegardée. Le pré-vol existe
# exactement pour éviter ça.
_manual_compressions: set = set()
# fd du verrou partagé tant que la compaction tourne, par clé.
_manual_compression_fds: dict = {}


def _settings_from_cached_row(urow) -> Optional[Dict[str, Any]]:
    """Réglages du compte depuis la ligne ``users`` déjà chargée par la porte
    de session (``request.state._user_row``). ``None`` = illisible : l'appelant
    relit en base, il ne repart JAMAIS sur ``{}``.

    RÉGRESSION 2026-09-02 → 2026-09-04 (passe 6, B4). L'ancien bloc faisait
    ``json.loads(...)`` dans un ``except Exception: user_settings = {}`` — et
    ``json`` n'était pas importé dans ce module. Le ``NameError`` était avalé,
    et CHAQUE tour partait avec des réglages VIDES : serveurs MCP externes
    (perso et bibliothèque partagée) jetés à la résolution, sous-agents et
    mémoire éteints, prompt custom perdu, ``enable_mcp`` remis au défaut… Les
    outils LOCAUX (``DEFAULT_LOCAL_PYTHON``) ne passent pas par les réglages,
    d'où le symptôme « seuls les outils externes ont disparu ». Les 4 000
    tests étaient aveugles : ils simulent l'auth en patchant
    ``require_user_id``, donc ``_user_row`` n'est jamais posé et seul le
    repli (correct) est exercé. D'où : (a) plus de ``except`` large ici —
    une erreur de programmation doit lever ; (b) un JSON illisible se
    SIGNALE et renvoie ``None`` pour relire en base ; (c) un test dédié pose
    ``_user_row`` comme en production.
    """
    try:
        raw = urow["settings_json"]
    except (KeyError, IndexError, TypeError):
        return None
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("[chats] settings_json illisible sur la ligne users en "
                       "cache — relecture en base pour ce tour")
        return None
    return parsed if isinstance(parsed, dict) else None


def _stdio_allowed_for(user_id) -> bool:
    """Le propriétaire peut-il faire exécuter une commande ``stdio`` sur
    l'hôte ? Administrateur PLEIN seulement (``is_admin == 1``)."""
    try:
        from shared_infra.accounts.users import get_user_by_id
        me = get_user_by_id(int(user_id))
        return bool(me and me["is_admin"] == 1)
    except Exception:
        return False


def _agent_mcp_configs(user_settings, user_id=None) -> list:
    """Serveurs MCP qu'un agent CUSTOM peut référencer par id.

    Délègue à ``shared_infra.mcp.servers.resolve_for_agents`` : le scheduler
    de routines lance les mêmes agents custom, et deux définitions auraient
    divergé au premier changement de règle.
    """
    from shared_infra.mcp.servers import resolve_for_agents
    return resolve_for_agents(
        user_settings, allow_stdio=_stdio_allowed_for(user_id) if user_id is not None else False)


def _manual_compression_active(user_id: int, chat_id: str) -> bool:
    """Une compaction manuelle tourne-t-elle sur ce chat, DANS N'IMPORTE QUEL
    worker ?"""
    if (user_id, chat_id) in _manual_compressions:
        return True
    try:
        from shared_infra.runtime import chat_locks
        return chat_locks.is_held("compact", user_id, chat_id)
    except Exception:                                           # noqa: BLE001
        return False


def _manual_compression_begin(user_id: int, chat_id: str) -> None:
    """Marque la compaction en vol (local + verrou partagé)."""
    _manual_compressions.add((user_id, chat_id))
    try:
        from shared_infra.runtime import chat_locks
        fd = chat_locks.acquire("compact", user_id, chat_id)
        if fd is not None:
            _manual_compression_fds[(user_id, chat_id)] = fd
    except Exception:                                           # noqa: BLE001
        pass


def _manual_compression_end(user_id: int, chat_id: str) -> None:
    """Fin de compaction : libère le local ET le verrou partagé."""
    _manual_compressions.discard((user_id, chat_id))
    try:
        from shared_infra.runtime import chat_locks
        chat_locks.release(_manual_compression_fds.pop((user_id, chat_id), None))
    except Exception:                                           # noqa: BLE001
        _manual_compression_fds.pop((user_id, chat_id), None)


@router.get("/api/chat/{chat_id}/generation-status")
async def api_chat_generation_status(chat_id: str, request: Request):
    """AUDIT 2026-08-02 (W14) — état « génération en cours » consultable.

    ``chat_locks.is_held("generation")`` n'était exposé qu'en garde 409
    interne : un utilisateur qui rechargeait la page pendant une génération
    lancée d'un autre onglet ne voyait RIEN, puis recevait un 409 déroutant
    en renvoyant un message. Le front interroge cet endpoint au chargement
    d'un chat (soft) et affiche une notice si une génération tourne ailleurs.
    """
    user_id = require_user_id(request)
    running = bool(is_generation_active(user_id, chat_id))
    out: Dict[str, Any] = {"generation_running": running, "run_id": None,
                           "resumable": False}
    # AUDIT 2026-09-16 (chantier C) — de quoi SE RATTACHER au run, pas seulement
    # savoir qu'il existe : identifiant, et la réconciliation du fil (nombre de
    # messages du tour, dernier message utilisateur). Un journal terminé
    # (``final`` émis) vaut « fini » même si le worker tient encore le verrou
    # le temps de sa télémétrie post-final (R12 : plus de faux « en cours »).
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
            # Passe d'optimisation 2026-09-26 — chaque onglet qui suit un run
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
            # AUDIT moteur d'événements 2026-09-25 (B5) — revalidation de
            # session, ping et déconnexion AVANT le ``continue`` du rejeu :
            # un run qui produit sans pause (tokens, outils) enchaînait des
            # lots non vides et ne passait JAMAIS par ces contrôles — une
            # session révoquée continuait de suivre le run jusqu'à la
            # première accalmie.
            if now - last_check > 60.0:
                last_check = now
                try:
                    from shared_infra.security.deps import stream_session_still_valid
                    if not await asyncio.to_thread(stream_session_still_valid,
                                                   int(user_id), _login_ts, _sid):
                        yield _ndjson_line({"type": "session_expired"})
                        return
                except Exception:                               # noqa: BLE001
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


@router.get("/api/chat/{chat_id}/compression-state")
def api_chat_compression_state(chat_id: str, request: Request):
    # AUDIT 2026-08-31 (passe 2) — ``def`` (threadpool), plus ``async def`` :
    # appelée À CHAQUE SWITCH de chat, la route désérialise tout
    # messages_json (get_chat) puis _expand_history_for_llm +
    # measured_prompt_tokens sur l'historique ENTIER — un gel de boucle
    # proportionnel à la plus grosse conversation. Aucun await dans le corps.
    """État de compression d'un chat pour l'UI du bouton manuel.

    Retourne : ``{round, max, can_compress, reason, turns, tokens_estimate,
    estimated, scope}``. ``reason`` ∈ ok | max_reached | too_short |
    generation_running | compression_running | disabled.
    ``tokens_estimate`` est l'heuristique unifiée (pas de /tokenize ici :
    l'endpoint est appelé à chaque changement de chat, il doit rester
    gratuit), calculée sur la vue POST-drop — historique seul
    (``scope: history_only``) : ni system prompt du tour, ni schéma tools —
    la jauge live reste la référence d'occupation.
    """
    user_id = require_user_id(request)
    chat = get_chat(user_id, chat_id)
    if not chat:
        raise HTTPException(404, "chat not found")

    from shared_infra import config as _cfg
    with swallow("chat.api_chat_compression_state"):
        _cfg.reload_compression_config_from_disk()
    from llm_core.context.tokens import measured_prompt_tokens
    from llm_core.conversation_compressor import _count_turns, apply_persisted_state, extract_compression_state

    _msgs = [m for m in (chat.get("messages") or [])
             if isinstance(m, dict) and m.get("role") != "system"]
    _expanded = _expand_history_for_llm(
        _msgs, pruned_keys=chat.get("ctx_pruned_keys") or ())
    _state = extract_compression_state(chat.get("messages") or [])
    # Vue RÉELLE de la prochaine requête : le résumé remplace les tours déjà
    # couverts (drop). Compter sur la vue brute rendait ``can_compress``
    # sur-optimiste (tours couverts recomptés → un clic finissait en
    # ``nothing_to_compress``) et ``tokens_estimate`` gonflé vs l'envoi réel.
    if _state:
        try:
            _expanded, _ = apply_persisted_state(_expanded, _state)
        except Exception:
            logger.warning("[compression-state] apply état échoué (vue brute)",
                           exc_info=True)
    _round = int((_state or {}).get("round") or 0)
    # Cap du COMPTE s'il en a réglé un (0 = illimité), défaut d'instance sinon.
    # L'UI affiche « round / max » et grise le bouton sur ce chiffre : le lire
    # ailleurs que le compresseur ferait mentir le badge.
    from llm_core.context.compaction_gate import resolve_max_rounds
    _user_max = resolve_max_rounds(get_user_settings(user_id))
    _max = (_user_max if _user_max is not None
            else int(getattr(_cfg, "COMPRESSION_MAX_PER_CHAT", 0) or 0))
    _turns = _count_turns(_expanded)
    # « Trop court » = rien dans la zone compressible (parité avec la garde
    # nothing_to_compress de compress() : tours ≤ recent+bridge).
    _min_turns = int(getattr(_cfg, "COMPRESSION_KEEP_RECENT", 6)) \
        + int(getattr(_cfg, "COMPRESSION_KEEP_BRIDGE", 3))

    # NB : ``COMPRESSION_ENABLED`` (toggle admin) ne gouverne que la
    # compression AUTOMATIQUE — cet endpoint alimente l'UI MANUELLE
    # (/compact), qui reste disponible quel que soit le toggle.
    if _max > 0 and _round >= _max:
        reason = "max_reached"
    elif is_generation_active(user_id, chat_id):
        reason = "generation_running"
    elif _manual_compression_active(user_id, chat_id):
        reason = "compression_running"
    elif _turns <= _min_turns:
        reason = "too_short"
    else:
        reason = "ok"

    return JSONResponse({
        "round":           _round,
        "max":             _max,
        "can_compress":    reason == "ok",
        "reason":          reason,
        "turns":           _turns,
        # Estimation via le ratio chars/token MESURÉ du modèle (harnais v4 —
        # plus d'heuristique 3.3 statique) ; toujours flaguée estimée.
        "tokens_estimate": measured_prompt_tokens(_expanded),
        "estimated":       True,
        # Périmètre du compte : historique (+ résumé) seul — sans system
        # prompt du tour ni schéma tools. La jauge live reste la référence.
        "scope":           "history_only",
    }, headers={"Cache-Control": "no-cache"})


@router.post("/api/chat/{chat_id}/compress")
async def api_chat_manual_compress(chat_id: str, request: Request):
    """Compression MANUELLE d'un chat persisté, hors streaming.

    Contrairement à l'ancien /api/chat/compress (front-triggered, déprécié),
    ce chemin réutilise le compresseur backend (maybe_compress_conversation,
    ``manual=True`` = seuils bypassés) sur l'historique PERSISTÉ, puis
    persiste l'état résultat (résumé + round) en tête de messages_json.
    Les bulles visibles ne changent pas. Respecte le cap
    COMPRESSION_MAX_PER_CHAT (auto + manuel confondus).

    409 si une génération est en cours sur ce chat (le persist de fin de tour
    écraserait l'état) ou si une compression manuelle y est déjà en vol.
    Échec métier (sans gain, résumé invalide, trop court) → 200
    ``{compressed: false, reason}`` : ce n'est pas une erreur HTTP.
    """
    user_id = require_user_id(request)
    # Threadpool : messages_json entier (cf. compression-state ci-dessus).
    chat = await asyncio.to_thread(get_chat, user_id, chat_id)
    if not chat:
        raise HTTPException(404, "chat not found")
    # Gardes CROSS-WORKER (cf. shared_infra.runtime.chat_locks) : le registre local ne
    # voit pas une génération/compaction hébergée par un autre worker gunicorn.
    if is_generation_active(user_id, chat_id):
        raise HTTPException(409, "generation_running")
    _key = (user_id, chat_id)
    if _manual_compression_active(user_id, chat_id):
        raise HTTPException(409, "compression_running")
    # ── Modèle de compression : le MODÈLE COURANT du chat, PAS le défaut ──────
    # BUG — la route ne recevait pas de modèle → maybe_compress passait model=None
    # → résolution ``model_override or _target.model or LLAMA_MODEL`` retombait sur
    # ``LLAMA_MODEL`` (défaut config, ex. « RAG » sur un routeur) → llama-server
    # renvoyait 400 (modèle inexistant) → « Erreur du modèle de compression ». On
    # prend donc le modèle envoyé par le front (selectedModel), sinon le modèle
    # RÉELLEMENT CHARGÉ côté serveur, et seulement en dernier repli LLAMA_MODEL.
    _req_model = None
    _req_connector = None
    try:
        _body = await request.json()
        if isinstance(_body, dict):
            _req_model = (str(_body.get("model") or "").strip() or None)
            _req_connector = _body.get("connector_id")
    except Exception:
        _req_model = None
    # AUDIT 2026-09-16 (M5) — le SERVEUR sélectionné compacte, pas toujours
    # l'intégré : la route ne recevait que le modèle, et un chat mené sur un
    # connecteur se faisait résumer par le modèle HOMONYME du serveur intégré
    # (ou par un 400 « modèle inexistant »). Même résolution stricte et même
    # politique d'accès que la route de chat.
    from llm_core._target import EngineUnavailable as _EU, resolve_llm_target as _rlt
    try:
        _cid = int(_req_connector) if _req_connector not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        _cid = None
    try:
        _cmp_target = _rlt(user_id, _cid, _req_model, strict=True)
    except _EU as _eu:
        raise HTTPException(409, {"code": "engine_unavailable",
                                  "reason": _eu.reason, "message": _eu.message})
    _cmp_allowed = True             # fail-open documenté dans engine_access
    with swallow("chat.manual_compress.access"):
        from shared_infra.llm import engine_access as _ea
        _cmp_allowed = _ea.can_use_engine(
            user_id, _ea.connector_key(_cid) if _cid else _ea.BUILTIN_KEY)
    if not _cmp_allowed:
        raise HTTPException(409, {"code": "engine_unavailable", "reason": "forbidden",
                                  "message": "Ce serveur ne vous est pas ouvert."})
    if not _req_model and _cmp_target.is_default:
        try:
            from llm_core import get_currently_loaded_model
            _req_model = await get_currently_loaded_model()
        except Exception:
            _req_model = None
    _manual_compression_begin(user_id, chat_id)
    try:
        from shared_infra import config as _cfg
        with swallow("chat.api_chat_manual_compress"):
            _cfg.reload_compression_config_from_disk()
        from llm_core.context.compaction_gate import resolve_max_rounds
        _user_max_rounds = resolve_max_rounds(get_user_settings(user_id))
        from llm_core.conversation_compressor import (
            _strip_summary_messages,
            apply_persisted_state,
            build_state_system_message,
            extract_compression_state,
            maybe_compress_conversation,
        )

        persisted = chat.get("messages") or []
        prev_state = extract_compression_state(persisted)
        bubbles = [m for m in persisted
                   if isinstance(m, dict) and m.get("role") != "system"]
        # Même expansion que le streaming → même indexation de tours que le
        # covered_turns persisté (déterminisme du drop).
        llm_view = _expand_history_for_llm(
            bubbles, pruned_keys=chat.get("ctx_pruned_keys") or ())
        if prev_state:
            llm_view, prev_state = apply_persisted_state(llm_view, prev_state)

        # n_ctx du MODÈLE DE COMPRESSION (le courant), utile aux stats ; pas au
        # déclenchement (manual=True bypasse les seuils).
        from llm_core import set_llm_target as _set_cmp_target
        _set_cmp_target(_cmp_target)    # contextvar : propre à cette requête
        _ctx_tok = 0
        try:
            from llm_core._ctx_window import resolve_context_window as _rcw
            _ctx_tok = int(await _rcw(_req_model or "", _cmp_target) or 0)
        except Exception:
            _ctx_tok = 0

        _state_holder: dict = {}

        async def _on_ev(ev: dict):
            if isinstance(ev, dict) and ev.get("type") == "compression_state":
                # Champs UTILES seulement (pas de copie aveugle de l'event :
                # symétrie avec l'interception du chemin streaming).
                for _k in ("round", "covered_turns", "summary_xml",
                           "turns_compressed", "ledger_block"):
                    if _k in ev:
                        _state_holder[_k] = ev[_k]

        _t0 = time.time()
        # Exécution (``runs``) et usage rattachés au compte et à la
        # conversation compactée (sans ce scope, la ligne d'usage n'avait
        # ni compte ni origine).
        from llm_core.engines import engine_for_target as _eng_cmp
        from shared_infra.observability.runs import run_scope
        async with run_scope("compaction", user_id=user_id, chat_id=chat_id,
                             model=_req_model or "", engine=_eng_cmp(_cmp_target).key):
            with usage_scope("compression", user_id=user_id, origin_id=str(chat_id)):
                _, stats = await maybe_compress_conversation(
                    llm_view,
                    llama_chat_fn   = llama_chat,
                    on_event        = _on_ev,
                    model           = _req_model,   # modèle COURANT (pas le défaut LLAMA_MODEL)
                    user_id         = str(user_id),
                    log_prefix      = "chat_manual",
                    ctx_size_tokens = _ctx_tok or None,
                    prev_state      = prev_state,
                    manual          = True,
                    # Cap par conversation : auto ET manuel partagent le compteur
                    # ``round``, donc le réglage du compte doit valoir des deux côtés —
                    # sinon /compact se ferait refuser par un plafond que l'utilisateur
                    # croit avoir relevé.
                    max_rounds      = _user_max_rounds,
                    fts_session_id  = str(chat_id),
                )

        compressed = bool(stats.get("compressed"))
        if compressed and _state_holder.get("summary_xml"):
            _state_msg = build_state_system_message(
                _state_holder["summary_xml"],
                int(_state_holder.get("round") or 1),
                int(_state_holder.get("covered_turns") or 0),
                turns_compressed=_state_holder.get("turns_compressed"),
                ledger_block=_state_holder.get("ledger_block") or "",
            )
            # Marqueur PERSISTANT dans le fil : l'utilisateur voit OÙ et QUAND
            # la conversation a été compactée (survit au reload — relu par
            # loadChat, renvoyé par le client au tour suivant, et exclu de la
            # vue LLM par _expand_history_for_llm). ``tokens_after`` = taille
            # du contexte APRÈS compaction (c'est elle qu'on affiche).
            _notice = {
                "role":         "notice",
                "kind":         "compaction",
                "ts":           time.time(),
                "round":        int(_state_holder.get("round") or 1),
                "tokens_after": int(stats.get("tokens_after") or 0),
                "content":      "Conversation compactée — contexte ≈ "
                                f"{int(stats.get('tokens_after') or 0):,} tokens".replace(",", " "),
                # Copie du résumé produit, pour l'accordéon de VÉRIFICATION du
                # fil (UX 2026-07-25) : le porteur system est jeté par le front
                # au reload (_history.js), la notice porte donc sa propre copie.
                # Clip défensif — le budget dur du prompt vise ≤ ~350 mots.
                "summary":      str(_state_holder.get("summary_xml") or "")[:12000],
            }
            new_msgs = [_state_msg] + _strip_summary_messages(persisted) + [_notice]
            try:
                # F2 — concurrence optimiste CROSS-WORKER : n'écrase QUE si le
                # chat n'a pas bougé depuis notre lecture (une génération sur un
                # autre worker a pu persister un nouveau tour pendant notre appel
                # LLM de compression). Sinon → 409 (ne PAS clobberer le tour).
                # AUDIT 2026-08-31 (passe 4, B3) — écriture SQLite hors boucle
                # (la lecture ``get_chat`` de cette même route l'est déjà).
                _persisted_ok = await asyncio.to_thread(
                    upsert_chat,
                    user_id, chat_id, chat.get("title") or "Nouveau chat",
                    new_msgs, time.time(),
                    expected_updated_at=chat.get("updated_at"))
                if not _persisted_ok:
                    return JSONResponse({
                        "ok": False, "compressed": False, "reason": "chat_modified",
                    }, status_code=409)
                # L'occupation persistée décrivait l'historique d'AVANT : le
                # front invalide sa jauge (elle se recale au prochain tour),
                # la base fait pareil — sinon un rechargement re-sèmerait
                # une valeur périmée.
                with swallow("chat_manual.ctx_usage"):
                    from shared_infra.chat.store import clear_chat_ctx_usage
                    await asyncio.to_thread(clear_chat_ctx_usage, user_id, chat_id)
            except Exception as _pe:
                logger.warning("[chat_manual] persist post-compression échoué : %s", _pe)
                return JSONResponse({
                    "ok": False, "compressed": False, "reason": "persist_failed",
                }, status_code=500)

        _max = (_user_max_rounds if _user_max_rounds is not None
                else int(getattr(_cfg, "COMPRESSION_MAX_PER_CHAT", 0) or 0))
        return JSONResponse({
            "ok":         True,
            "compressed": compressed,
            "reason":     stats.get("reason"),
            "stats": {
                "tokens_before":    stats.get("tokens_before"),
                "tokens_after":     stats.get("tokens_after"),
                "tokens_saved":     stats.get("tokens_saved"),
                "tokens_estimated": stats.get("tokens_estimated"),
                "turns_compressed": stats.get("turns_compressed"),
                "round":            stats.get("round") or int((prev_state or {}).get("round") or 0),
                "max":              _max,
                "duration_ms":      stats.get("duration_ms") or int((time.time() - _t0) * 1000),
                "path":             stats.get("path"),
                # Résumé produit → accordéon de vérification (notice optimiste
                # côté front, sans attendre un reload).
                "summary_xml":      str(_state_holder.get("summary_xml") or "")[:12000],
            },
        })
    finally:
        _manual_compression_end(user_id, chat_id)


@router.post("/api/chat-saved-stream3")
async def api_chat_saved_stream3(request: Request):

    user_id = require_user_id(request)
    # AUDIT 2026-09-25 — le client renvoie TOUT l'historique à chaque tour
    # (tool_history, images en data URL) : plusieurs Mo décodés sur la boucle
    # d'événements gelaient tous les flux du worker le temps du ``json.loads``.
    # Au-delà de 256 Ko, décodage dans un thread.
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
    # AUDIT 2026-08-22 (B1) — sonde PRÉCOCE « une génération tourne déjà sur ce
    # chat ». Le verrou faisant autorité est pris plus bas (juste avant de
    # rendre le flux) ; celle-ci évite de payer toute la préparation du tour
    # (mémoire, RAG, résolution MCP) pour finir en 409. Elle est volontairement
    # tolérante : une passation (Stop suivi d'une régénération) est laissée
    # passer ici et arbitrée par ``_acquire_gen_presence``.
    _sweep_pending_gen_locks()
    if (chat_id and not is_chat_cancelled(user_id, chat_id)
            and is_generation_active(user_id, chat_id)):
        # AUDIT 2026-09-25 — « Stop puis régénérer » envoie l'annulation puis
        # re-POSTe aussitôt ; le drapeau d'annulation met jusqu'à ~100 ms à
        # atteindre un AUTRE worker (bus d'annulation). Sans ce court délai de
        # grâce, la régénération recevait un 409 alors que la passation était
        # en cours. Un vrai doublon (autre onglet) reçoit toujours son 409.
        for _ in range(6):
            await asyncio.sleep(0.1)
            if (is_chat_cancelled(user_id, chat_id)
                    or not is_generation_active(user_id, chat_id)):
                break
        else:
            raise HTTPException(409, "generation_running")
    # AUDIT 2026-08-22 (D4) — plafond de générations simultanées PAR COMPTE.
    # Les autres gardes sont par (utilisateur, chat) : sans celle-ci, un compte
    # pouvait lancer autant de missions que de chats ouverts et, la file de
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
    messages = data.get("messages") or []
    active_mcp_servers = data.get("active_mcp_servers", [])
    # Snapshot des toggles du panneau Outils, AVANT l'injection mémoire :
    # catégories locales cochées + serveurs EXTERNES actifs (préfixe
    # ``ext:<id>``, même canal meta_json["tools"]) — mémorisé sur le chat en
    # fin de tour et retrouvé au switch. Avant, seuls les locaux étaient
    # per-chat : l'état des externes vivait dans les settings GLOBAUX et
    # « collait » d'un chat à l'autre (bug 2026-08-02).
    _ui_tool_cats: list = []
    _ui_ext_ids: list = []
    for _srv in (active_mcp_servers or []):
        if not isinstance(_srv, dict):
            continue
        if _srv.get("command") == "DEFAULT_LOCAL_PYTHON" \
                and isinstance(_srv.get("filter_categories"), list):
            if not _ui_tool_cats:
                _ui_tool_cats = [str(c) for c in _srv["filter_categories"] if isinstance(c, str)]
        elif _srv.get("id"):
            _ui_ext_ids.append("ext:" + str(_srv["id"]))
        elif _srv.get("manifest"):
            # (2026-09-11) Serveur DÉCLARÉ dans ``mcp.json`` : même canal
            # per-chat que les externes, préfixe ``mf:<nom>``.
            _ui_ext_ids.append("mf:" + str(_srv["manifest"]))

    # (2026-09-12) Outils DÉCOCHÉS un par un dans le panneau. Canal séparé
    # d'``active_mcp_servers``, à dessein : rangée dans la config d'un serveur,
    # cette liste entrerait dans la clé du pool (une connexion par combinaison
    # de cases cochées) et dans les snapshots de routines. C'est une donnée du
    # CHAT — elle s'applique APRÈS connexion, via ``deny_tool_names``, la seule
    # couche qui porte aussi les catégories cachées.
    _ui_excl: list = [
        str(_t).strip()[:64]
        for _t in (data.get("excluded_tools") or [])
        if isinstance(_t, str) and _t.strip()
    ][:96]

    use_rag = bool(data.get("use_rag", False))
    rag_collection  = data.get("rag_collection", "")
    rag_search_mode = data.get("rag_search_mode", "classic")
    if rag_search_mode not in ("classic", "hybrid", "bm25"):
        rag_search_mode = "classic"

    try:
        rag_top_k    = max(1, min(int(data.get("rag_top_k", 8)), 20))
        rag_use_mmr  = bool(data.get("rag_use_mmr", True))

        rag_ctx_size = max(0, int(data.get("ctx_size", 0)))
    except (TypeError, ValueError):
        raise HTTPException(400, "rag_top_k / ctx_size doivent être des entiers")

    selected_model = data.get("model")
    connector_id = data.get("connector_id")
    thinking_mode = bool(data.get("thinking_mode", False))

    # ── Connecteur LLM cible pour ce tour ─────────────────────────────────
    # Défaut (connector_id absent) = llama.cpp intégré → comportement inchangé.
    # Sinon : connecteur perso/partagé (cloud Anthropic/OpenAI… ou backend
    # local alternatif). Le target est activé dans le générateur de stream.
    #
    # AUDIT 2026-09-16 (M4 + lot B4) — plus AUCUN repli silencieux. Un
    # connecteur supprimé, désactivé ou à la clé illisible répondait avant par
    # le serveur INTÉGRÉ : avec deux serveurs exposant les mêmes noms de
    # modèles, la bascule était invisible. Et la visibilité des serveurs par
    # utilisateur / groupe (``engine_access``) doit être appliquée ICI, pas
    # seulement dans la liste du sélecteur. Refus = 409 explicite que le front
    # affiche et qui lui fait purger la sélection.
    from llm_core._target import EngineUnavailable as _EngineUnavailable, resolve_llm_target as _resolve_target
    try:
        _cid_int = int(connector_id) if connector_id not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        _cid_int = None
        connector_id = None
    try:
        _target = _resolve_target(user_id, _cid_int, selected_model, strict=True)
    except _EngineUnavailable as _eu:
        raise HTTPException(409, {"code": "engine_unavailable",
                                  "reason": _eu.reason, "message": _eu.message})
    try:
        from shared_infra.llm import engine_access as _ea
        _ekey = _ea.connector_key(_cid_int) if _cid_int else _ea.BUILTIN_KEY
        _allowed = await asyncio.to_thread(_ea.can_use_engine, user_id, _ekey)
    except Exception:                                           # noqa: BLE001
        _allowed = True             # fail-open documenté dans engine_access
    if not _allowed:
        raise HTTPException(409, {"code": "engine_unavailable",
                                  "reason": "forbidden",
                                  "message": "Ce serveur ne vous est pas ouvert."})

    # ``ephemeral`` : session jetable (Annotation Studio). On NE persiste PAS le
    # chat (pas de pollution de la sidebar des chats sauvegardés). Toutes les
    # écritures passent par ``_persist_chat`` qui devient un no-op.
    ephemeral = bool(data.get("ephemeral", False))
    _persist_chat = (lambda *a, **k: None) if ephemeral else upsert_chat

    sampling_override = data.get("sampling_override")
    if sampling_override is not None and not isinstance(sampling_override, dict):
        sampling_override = None

    # L'auto-chargement local (routeur multi-modèles) ne concerne QUE le moteur
    # intégré llama.cpp. Un moteur local vLLM/générique ou un modèle cloud ne se
    # « charge » pas ainsi côté serveur.
    if _target.is_local_llamacpp and selected_model and selected_model not in CURRENT_LOADED_MODELS:
        CURRENT_LOADED_MODELS.add(selected_model)
        # AUDIT 2026-08-01 (M3) — référence forte : asyncio ne retient les
        # tâches qu'en WeakSet, une tâche fire-and-forget non référencée peut
        # être collectée avant de tourner (ici : cache de modèles jamais
        # rafraîchi, l'UI affiche un modèle périmé).
        _mc_task = asyncio.create_task(_refresh_model_cache())
        _BG_TASKS.add(_mc_task)
        _mc_task.add_done_callback(_BG_TASKS.discard)
        await system_events.broadcast({
            "type": "log", "message": f"[LLM] Modèle auto-chargé par requête chat: {selected_model}", "level": "INFO",
        })

    # (passe 6, B4) — la gate de session (deps._session_validity_checks) a
    # déjà chargé la ligne ``users`` de cette requête : settings + username en
    # sortent sans nouveau SELECT (avant : DEUX ``SELECT *`` de la même ligne,
    # en synchrone sur la boucle). Repli en thread si le state est absent.
    # ⚠ Ligne en cache ILLISIBLE ⇒ relecture en base, jamais ``{}`` : des
    # réglages vides ici jettent silencieusement les serveurs MCP externes,
    # les sous-agents, la mémoire, le prompt custom (cf. _settings_from_cached_row).
    _urow = getattr(request.state, "_user_row", None)
    user_settings = _settings_from_cached_row(_urow) if _urow is not None else None
    if user_settings is not None:
        try:
            username = _urow["username"] or f"user_{user_id}"
        except (KeyError, IndexError, TypeError):
            username = f"user_{user_id}"
    else:
        def _read_user_bits():
            return get_user_settings(user_id), get_username_by_id(user_id)
        user_settings, _uname = await asyncio.to_thread(_read_user_bits)
        if not isinstance(user_settings, dict):
            user_settings = {}
        username = _uname or f"user_{user_id}"

    # ── Bibliothèque MCP PARTAGÉE : résolution CÔTÉ SERVEUR ───────────────
    # Le navigateur ne connaît d'un serveur publié que son nom, son type et son
    # URL — jamais l'identifiant d'accès (chiffré en base, cf.
    # shared_infra/mcp/servers.py). Il pousse donc une entrée-référence
    # ``{"id": "shared:<n>", "shared": true}`` que l'on remplace ici par la
    # vraie config (URL + en-tête d'auth).
    #
    # Trois refus, tous silencieux (l'entrée est simplement jetée) : id inconnu,
    # serveur dépublié/désactivé, et serveur que CE compte n'a pas coché dans
    # son panneau. Corollaire : un client modifié ne peut pas se fabriquer un
    # serveur arbitraire sous une identité partagée, ni emprunter un serveur
    # qu'il n'affiche pas.
    # Les serveurs PERSO passent par la même résolution. Avant, une entrée sans
    # id ``shared:`` était recopiée VERBATIM depuis le payload : un client
    # modifié faisait donc ouvrir au backend une URL arbitraire avec des en-têtes
    # arbitraires depuis sa position réseau (SSRF à en-têtes contrôlés,
    # atteignable par tout compte authentifié). Désormais le client ne fournit
    # qu'un id ; l'URL et l'auth viennent toujours du magasin serveur.
    if active_mcp_servers:
        from shared_infra.mcp.servers import (
            client_builtin_ref as _builtin_ref,
            resolve_config as _resolve_shared,
            resolve_personal as _resolve_perso,
            shared_id as _shared_id,
        )
        # Un serveur perso ``stdio`` n'est spawné que pour un administrateur
        # plein (2026-09-20, cf. servers.StdioNotAllowed).
        _stdio_ok = _stdio_allowed_for(user_id)
        _visible = {str(v) for v in ((user_settings or {}).get("shared_mcp_visible") or [])}
        _resolved: list = []
        for _srv in active_mcp_servers:
            if not isinstance(_srv, dict):
                continue
            _cats = _srv.get("filter_categories")

            # Serveur d'outils LOCAUX : pas d'id, commande en dur côté serveur.
            # L'entrée est RECONSTRUITE (nom + catégories du client, rien
            # d'autre) : recopiée telle quelle, ``type``/``url``/``headers``
            # ouvraient une URL arbitraire depuis le backend (2026-09-21).
            if not _srv.get("id"):
                _ref = _builtin_ref(_srv)
                if _ref is not None:
                    _resolved.append(_ref)
                elif _srv.get("manifest"):
                    # (2026-09-11) Serveur déclaré dans ``mcp.json`` : le
                    # navigateur n'envoie que le NOM ; URL, en-têtes et
                    # commande viennent du manifeste (autorité serveur).
                    from shared_infra.mcp.manifest import resolve_external_cfg as _mf_cfg
                    _cfg = _mf_cfg(str(_srv.get("manifest")))
                    if _cfg:
                        if _cats is not None:
                            _cfg["filter_categories"] = _cats
                        _resolved.append(_cfg)
                continue

            _rid = _shared_id(_srv.get("id"))
            if _rid is not None:
                if str(_srv.get("id")) not in _visible:
                    continue
                _cfg = _resolve_shared(_rid)
            else:
                _cfg = _resolve_perso(user_settings, _srv.get("id"), allow_stdio=_stdio_ok)
            if not _cfg:
                continue
            if _cats is not None:
                _cfg["filter_categories"] = _cats
            _resolved.append(_cfg)
        active_mcp_servers = _resolved
    # Mémoire long-terme (Hermes) : TOGGLE per-user, défaut OFF (opt-in). Le flag
    # global ``MEMORY_ENABLED`` reste un interrupteur maître. ``_memory_on``
    # gouverne À LA FOIS le bloc mémoire injecté (lecture, system prompt) ET
    # l'exposition des outils ``memory`` / ``session_search`` (passé en
    # ``memory_enabled`` à run_chat_multi_mcp). Hors du panneau d'outils.
    from shared_infra.config import MEMORY_ENABLED as _MEMORY_MASTER
    _memory_on = bool(_MEMORY_MASTER and (user_settings or {}).get("memory_enabled", False))
    # Sous-agents (outil ``task``) : même gabarit que la mémoire — TOGGLE
    # per-user ``agents_enabled`` (défaut OFF, opt-in) sous interrupteur maître
    # ``AGENTS_ENABLED``. Gouverne la construction du builtin ``task`` plus bas.
    from shared_infra.config import AGENTS_ENABLED as _AGENTS_MASTER
    _agents_on = bool(_AGENTS_MASTER and (user_settings or {}).get("agents_enabled", False))
    if _agents_on:
        # Toggle actif mais banque entièrement désactivée : pas d'outil ``task``
        # (son enum serait vide → grammaire llama.cpp invalide).
        from llm_core.tools.task_tool import has_active_agents
        _agents_on = has_active_agents((user_settings or {}).get("custom_agents") or [])
    # Terminal en direct : TOGGLE per-user (défaut ON — pur réglage
    # d'affichage, comme le thinking). Propagé à run_chat_multi_mcp qui pose
    # ``live_shell: "1"`` dans le meta MCP → execute_shell streame sa sortie
    # (événements ``shell_output``). OFF ⇒ rien n'est émis (zéro overhead).
    _live_shell_on = bool((user_settings or {}).get("live_shell_enabled", True))
    # Compaction AUTOMATIQUE : même gabarit — TOGGLE per-user
    # ``compression_enabled`` (défaut OFF, opt-in) sous interrupteur maître
    # ``COMPRESSION_ENABLED``. Motif produit : beaucoup d'utilisateurs préfèrent
    # décider eux-mêmes quand compacter (commande /compact), qui reste TOUJOURS
    # disponible quel que soit ce réglage. Ne gouverne que l'automatique — porte
    # d'occupation ET rattrapage « contexte dépassé ».
    from shared_infra.config import COMPRESSION_ENABLED as _COMPR_MASTER
    _compression_on = bool(_COMPR_MASTER and (user_settings or {}).get("compression_enabled", False))
    # « Contexte max avant compaction » : seuil choisi par le compte — en % de
    # la fenêtre OU en tokens — sinon le défaut d'instance
    # (``llm.compaction.threshold_*``), sinon auto (plafond technique =
    # comportement historique). Résolu ICI, comme ``_compression_on`` : la
    # boucle et le compresseur reçoivent une décision, pas des réglages à
    # recomposer.
    from llm_core.context.compaction_gate import resolve_threshold as _resolve_thr
    _compaction_threshold = _resolve_thr(user_settings)
    # Compactions max pour CETTE conversation (auto + /compact confondus).
    # None = le compte n'a rien réglé ⇒ défaut d'instance
    # ``COMPRESSION_MAX_PER_CHAT``. C'est le réglage qui décide si une mission
    # de plusieurs heures peut continuer à se compacter jusqu'au bout, ou si
    # elle finit sur le budget dur (qui jette les vieux tours au lieu de les
    # résumer).
    from llm_core.context.compaction_gate import resolve_max_rounds as _resolve_rounds
    _compaction_max_rounds = _resolve_rounds(user_settings)
    # Mémoire long-terme : les outils ``memory`` (écrire/éditer) et
    # ``session_search`` vivent dans le serveur MCP local. Ils ne sont exposés que
    # si ce serveur est actif — or il ne l'est QUE si l'utilisateur a activé au
    # moins une catégorie d'outils dans le panneau. Conséquence : mémoire ON mais
    # aucun outil actif ⇒ le modèle ne voit PAS l'outil mémoire et ne peut donc
    # rien mémoriser. On injecte donc un serveur local scopé à la catégorie cachée
    # ``memory`` dès que la mémoire est active et qu'aucun serveur local n'est déjà
    # présent. ``_apply_memory_gate`` + la catégorie ``memory`` laissée passer par
    # _collect_mcp_tools (quand memory_enabled) font le reste. Ça bascule aussi
    # ``_use_mcp_path`` à True (active_mcp_servers devient non vide).
    # ── Interrupteur « Outils externes » (settings ``enable_mcp``) ────────
    # Il ne coupait RIEN : il masquait seulement le bouton et le panneau côté
    # UI, pendant que les catégories déjà cochées continuaient de partir au
    # modèle à chaque tour — et l'utilisateur ne pouvait même plus les
    # décocher, le panneau étant caché. Le voici appliqué CÔTÉ SERVEUR, seule
    # place qui fait autorité (un client modifié ne peut pas le contourner).
    #
    # OFF ⇒ aucun serveur d'outils : ni local (fs/shell/git/browser/desktop…),
    # ni MCP externe. SEULE exception voulue : les outils de MÉMOIRE, qui sont
    # réinjectés juste en dessous si la mémoire est active — écrire un souvenir
    # n'est pas « exécuter du code chez l'utilisateur ».
    #
    # Défaut ABSENT = ON (fail-open) : la clé n'a jamais eu de défaut backend,
    # la couper d'office retirerait les outils à tout compte qui n'a jamais
    # ouvert ce réglage. Seul un ``false`` EXPLICITE coupe.
    _mcp_on = bool((user_settings or {}).get("enable_mcp", True))
    if not _mcp_on:
        active_mcp_servers = []
        _ui_tool_cats = []
        _ui_ext_ids = []
        _ui_excl = []
        # Sous-agents retirés avec le reste. ⚠ PAS parce qu'ils hériteraient
        # de la surface du parent — depuis 2026-08-06 un enfant reconstruit sa
        # config MCP de zéro (catégories pré-cochées de son type), donc il
        # aurait ses outils AU COMPLET pendant que le chat n'en a aucun.
        # C'est justement pour ça qu'il faut couper ici : cet interrupteur dit
        # « aucun outil ne tourne chez cet utilisateur », et déléguer serait le
        # contournement le plus simple qui soit.
        _agents_on = False
    # Deny FINAL quand les outils sont coupés : les catégories CACHÉES
    # (``memory``, ``task``) traversent ``filter_categories`` par conception,
    # si bien que le serveur « Mémoire » ramènerait aussi ``todowrite``. Or la
    # consigne est de ne garder QUE la mémoire — ``deny_tool_names`` est la
    # seule couche qui s'applique aussi aux catégories cachées.
    _deny_tools = None if _mcp_on else {"todowrite"}
    # Les cases décochées rejoignent le deny FINAL : un outil retiré l'est pour
    # ce tour, sans exception pour les catégories cachées.
    if _ui_excl:
        _deny_tools = set(_deny_tools or ()) | set(_ui_excl)

    # Chat persisté chargé ICI (avant plan/system/expansion) : les marques
    # d'élagage (M4) vivent dans meta_json["ctx_pruned_keys"] et pilotent le
    # rendu des tool_results ; ``_existing_chat`` est réutilisé plus bas
    # (état de compression, titre, garde optimiste).
    # AUDIT 2026-08-01 (E8) — ce ``except`` était NU et SILENCIEUX. Il avalait
    # aussi bien un « database is locked » (contention WAL multi-worker, après
    # les 10 s de busy_timeout) qu'un ``messages_json`` illisible. Or un échec
    # de CETTE lecture désarme trois choses d'un coup, sans aucune trace :
    #   • ``_baseline_updated_at`` → la persistance finale écrit SANS garde
    #     optimiste et peut clobberer un tour concurrent ;
    #   • ``_compr_prev_state`` → ``_with_compr_state`` ne re-préfixe plus le
    #     message system, donc le résumé de compaction et le compteur de rounds
    #     sont EFFACÉS de messages_json (le client ne renvoie jamais de system) ;
    #   • ``_pruned_keys`` → les marques d'élagage sont ignorées.
    # On distingue donc « chat absent » (légitime : chat neuf) d'un échec de
    # lecture, qui est désormais tracé ET marqué pour interdire l'écriture
    # destructrice plus bas.
    _existing_chat = None
    _chat_read_failed = False
    try:
        # AUDIT 2026-08-31 (passe 2) — json.loads de TOUT messages_json :
        # linéaire en taille de conversation, hors boucle (le persist de fin
        # de tour l'était déjà, la lecture ne l'était pas).
        _existing_chat = await asyncio.to_thread(get_chat, user_id, chat_id)
    except Exception:
        _existing_chat = None
        _chat_read_failed = True
    if _chat_read_failed:
        # AUDIT 2026-09-26 — UNE relecture après un court délai : l'échec
        # typique est une contention SQLite passagère, et un tour lancé sans
        # cette lecture n'a ni garde optimiste, ni état de compression, ni
        # titre connu (le persist pouvait écraser un tour concurrent).
        await asyncio.sleep(0.3)
        try:
            _existing_chat = await asyncio.to_thread(get_chat, user_id, chat_id)
            _chat_read_failed = False
        except Exception:
            _existing_chat = None
    if _chat_read_failed:
        logger.warning(
            "[chats] lecture du chat %s échouée — état de compression et garde "
            "optimiste indisponibles pour ce tour", str(chat_id)[:12],
            exc_info=True)

    # ── Mode lecture seule du chat (commande « /plan ») ───────────────────
    # Lu EN BASE, jamais dans le corps de la requête : c'est le serveur qui
    # fait autorité, un onglet resté ouvert ne doit pas pouvoir rendre la
    # main sur les toggles d'écriture en envoyant un état périmé.
    # AUDIT 2026-09-01 (passe 6, B3) — dérivé de ``_existing_chat`` (qui
    # expose déjà ``plan_mode``) au lieu d'un second SELECT meta_json fait
    # en synchrone sur la boucle. (passe 7, R2) — si CETTE lecture a échoué,
    # on ne dérive JAMAIS « mode normal » d'une absence de donnée (fail-open
    # sur les outils d'écriture d'un chat en lecture seule) : repli sur la
    # lecture légère d'origine, dont l'échec fait échouer le tour comme
    # avant (pas de tour sans connaître le mode).
    if _chat_read_failed:
        _plan_mode = bool(await asyncio.to_thread(get_chat_plan_mode, user_id, chat_id))
    else:
        _plan_mode = bool((_existing_chat or {}).get("plan_mode"))
    if _plan_mode:
        # La réduction de surface (outils annotés read-only seulement) est
        # faite par la boucle. Restent les BUILTINS, qui n'ont pas
        # d'annotations : ``task`` doit tomber ici, sans quoi un sous-agent
        # ``implement`` écrirait depuis un chat en lecture seule — le
        # contournement le plus évident qui soit. Le RAG, lui, est de la
        # consultation : il reste.
        _deny_tools = set(_deny_tools or set()) | {"task"}

    _has_local_srv = any(
        isinstance(s, dict) and s.get("command") == "DEFAULT_LOCAL_PYTHON"
        for s in (active_mcp_servers or [])
    )
    # (2026-09-11) Le service d'outils INTÉGRÉ (entrée ``toolhost`` du
    # manifeste ``mcp.json``) est joint dès qu'une de ces conditions tient,
    # même si aucune catégorie n'est cochée — il portait auparavant trois
    # serveurs SYNTHÉTIQUES (« Mémoire », « Agents », « Tâches ») fabriqués ici :
    #   • mémoire active : les outils ``memory``/``session_search`` (catégorie
    #     laissée passer par ``memory_enabled`` dans _collect_mcp_tools) — y
    #     compris outils COUPÉS (``enable_mcp`` faux : ``_deny_tools`` retire
    #     alors ``todowrite``, seule la mémoire reste) ;
    #   • sous-agents actifs sans aucun serveur : le builtin ``task`` n'existe
    #     que sur le chemin MCP, un serveur scopé à rien (``[]`` = catégories
    #     cachées seules) suffit à l'exposer ;
    #   • serveurs EXTERNES seuls : ``todowrite`` (catégorie cachée ``task``)
    #     doit rester disponible dès qu'au moins un outil MCP est actif.
    # ``filter_categories=[]`` = catégories cachées + mémoire si active : c'est
    # exactement ce que faisaient ``["memory"]`` et ``[]`` avant.
    if not _has_local_srv and (
            _memory_on
            or (_mcp_on and _agents_on and not active_mcp_servers)
            or (_mcp_on and active_mcp_servers)):
        from shared_infra.mcp.manifest import builtin_client_cfg as _builtin_cfg
        active_mcp_servers = list(active_mcp_servers or []) + [_builtin_cfg([])]
    # Refonte 2026 — le prompt de base du chatbot est CHATBOT_SYSTEM.md
    # (config.SYSTEM_PROMPT_DEFAULT), réellement injecté. Le prompt custom
    # de l'utilisateur (settings) est ajouté EN SUFFIXE s'il existe — il
    # étend/affine le défaut au lieu de le remplacer.
    from shared_infra.config import SYSTEM_PROMPT_DEFAULT as _BASE_SYS
    _base_sys = (_BASE_SYS or "").strip()
    _user_sys = user_settings.get("system_prompt", "").strip()
    if _base_sys and _user_sys:
        custom_sys = _base_sys + "\n\n---\n\n" + _user_sys
    else:
        custom_sys = _base_sys or _user_sys

    if not chat_id: chat_id = secrets.token_hex(12)

    if not isinstance(messages, list):
        raise HTTPException(400, "messages doit être une liste")

    messages, msgs = _normalize_client_messages(messages)
    if not messages:
        raise HTTPException(400, "messages: aucun message valide dans le payload")
    # AUDIT 2026-09-26 — travail d'outils d'un tour STOPPÉ : le serveur l'a
    # persisté avec le partiel, mais le client (fetch abandonné au Stop) ne
    # l'a jamais reçu et renvoie ce message sans. Le tour suivant ne voyait
    # plus les outils déjà exécutés (écritures, commits) — le modèle pouvait
    # les rejouer — et le persist effaçait leur trace en base.
    if _existing_chat and not _chat_read_failed:
        with swallow("chat.graft_stopped_tool_history"):
            _graft_stopped_turn_state(messages, msgs,
                                      _existing_chat.get("messages"))
    # Un payload de NOTICES seules n'est pas un tour : sans message réel, le
    # modèle recevrait la seule tête système et répondrait dans le vide.
    if all(_m.get("role") == "notice" for _m in messages):
        raise HTTPException(400, "messages: aucun message valide dans le payload")

    is_continue = bool(data.get("is_continue", False))

    # Dernier message utilisateur — sert au matching déterministe des skills
    # (procédures injectées dans le system prompt) ET à l'indexation mémoire.
    # Best-effort : si pas de message user, le bloc skills se réduit à l'index.
    # ``last_user_text`` gère aussi le content MULTIMODAL (liste texte+image) ;
    # avant, un message multimodal laissait ce texte vide → skills non matchés
    # et mémoire indexant un tour vide.
    _last_user_text = last_user_text(messages)

    # ── Run REPRENABLE (AUDIT 2026-09-16, chantier C) ────────────────────────
    # Le chat principal pose ``resumable`` : (a) ses événements sont journalisés
    # (``shared_infra.runtime.run_journal``) pour qu'un retour sur la
    # conversation — autre chat puis retour, rechargement, autre appareil —
    # REJOUE le tour puis le suive en direct ; (b) une déconnexion le DÉTACHE,
    # outils ou non : quitter la conversation laisse le tour se terminer
    # proprement côté serveur (décision utilisateur 2026-09-16). Studio,
    # routines et sessions éphémères ne le posent pas : contrat inchangé.
    _resumable = bool(data.get("resumable", False)) and not ephemeral
    _run_id = secrets.token_hex(8)
    # Exécution du tour (``runs``, L5.2) : même identifiant que son journal.
    _exec_id = f"chat-{_run_id}"

    # Matching des skills : fenêtre des derniers tours user (pas seulement le
    # dernier message) → le corps d'une procédure reste matché même au tour
    # « fais-le » / « continue » qui ne contient aucun mot-clé. La mémoire, elle,
    # garde ``_last_user_text`` (un seul tour) pour l'indexation.
    _skill_query = recent_user_text(messages, k=3)

    # Skills épinglés par l'utilisateur via /skill dans la barre de prompt :
    # injectés de force (en plus de l'auto-matching) pour ce message.
    _pinned_skills = data.get("pinned_skills") or []
    if not isinstance(_pinned_skills, list):
        _pinned_skills = []

    # Mémoire long-terme auto-curée (façon Hermes) : on construit le manager
    # per-user (scope "user") et on capture le snapshot UNE fois PAR REQUÊTE
    # (donc par tour — le manager est reconstruit ici à chaque appel). Ce bloc
    # figé ne change pas en cours de requête même si l'agent écrit via l'outil
    # ``memory`` pendant la boucle d'outils (intra-tour, le modèle se fie aux
    # ``entries`` renvoyées par l'outil) ; le prefix-cache n'est préservé
    # entre deux tours que si le store n'a pas muté (rendu déterministe,
    # ids stables f(contenus)). Best-effort, jamais bloquant.
    _memory_block = ""
    _mem_manager = None
    try:
        if _memory_on:
            from llm_core.memory import build_default_manager
            _mem_manager = build_default_manager(
                username=username, scope_key="user",
                app="chat", session_id=chat_id,
            )
            # Threadpool (passe 3) : initialize lit USER.md + MEMORY.md sur
            # disque — hors boucle, comme le reste du préambule déporté.
            await asyncio.to_thread(_mem_manager.initialize, session_id=chat_id)
            _memory_block = _mem_manager.system_prompt_block()
    except Exception:
        _mem_manager = None
        _memory_block = ""

    # Date du jour en anglais (tête système full-EN ; indépendant de la locale).
    import datetime as _dt

    from llm_core._system_prompts import assemble_system_messages
    _EN_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December")
    _n = _dt.datetime.now()
    _today_fr = f"{_EN_MONTHS[_n.month - 1]} {_n.day}, {_n.year}"
    # Le bloc skills (index + header qui dit d'appeler skill_get/skill_read_file/
    # skill_run_script) ne doit être injecté QUE si la catégorie d'outils
    # « skill » est active pour ce tour — sinon le modèle reçoit une instruction
    # morte (outils non exposés). On lit l'activation depuis les filter_categories
    # des serveurs MCP actifs (cf. _chat_with_tools._collect_mcp_tools).
    _skills_on = any(
        (_fc := (s.get("filter_categories") if isinstance(s, dict) else None)) is None
        or "skill" in _fc
        for s in (active_mcp_servers or [])
    )
    # Libellé du modèle pour l'en-tête runtime (« Backing model: … ») : le socle
    # dit de répondre aux questions d'identité depuis cette ligne — les modèles
    # servis ici sont interchangeables, un nom appris à l'entraînement serait
    # halluciné. Best-effort : cible résolue (connecteur OU sélection UI), sinon
    # le modèle configuré du moteur local. Placeholder de config non informatif
    # → ligne omise (le socle prévoit l'absence : « say you don't know »).
    _model_label = (_target.model or selected_model or "").strip()
    if not _model_label and _target.is_default:
        import shared_infra.config as _cfg_mod
        _m = (getattr(_cfg_mod, "LLAMA_MODEL", "") or "").strip()
        _model_label = "" if _m == "local-model" else _m
    msgs_for_llm = assemble_system_messages(
        custom_sys=custom_sys,
        last_user_text=_skill_query,
        user_id=user_id,
        pinned_skills=[str(x) for x in _pinned_skills if x],
        memory_block=_memory_block,
        today=_today_fr,
        skills_enabled=_skills_on,
        plan_mode=_plan_mode,
        model_label=_model_label,
    )

    # (``_existing_chat`` chargé plus haut, avant la résolution du mode plan —
    # passe 6, B3.)
    _pruned_keys = (_existing_chat or {}).get("ctx_pruned_keys") or []

    # Reprise NATIVE (continue_final_message) pour un Continue sur un tour
    # think-only : UNIQUEMENT si le support est CONFIRMÉ pour ce modèle — une
    # tentative optimiste échouerait ici en erreur de tour, sans le repli
    # in-run dont disposent les moteurs. Le cache est peuplé par les
    # auto-reprises (llm_core._think_resume) ; tant qu'il ne l'est pas, le
    # repli « think fermé + consigne de conclusion » fait le travail.
    _resume_native_ok = False
    if is_continue and _target.is_llamacpp:
        with swallow("chat.resume_native_probe"):
            from llm_core._llm_params import continue_final_support
            _resume_native_ok = continue_final_support(
                selected_model or _target.model) is True

    msgs_for_llm.extend(_expand_history_for_llm(
        messages, is_continue=is_continue, pruned_keys=_pruned_keys,
        resume_native=_resume_native_ok,
        user_suffixes=(_existing_chat or {}).get("llm_user_suffixes")))

    # ── État de compression PERSISTANT (round / tours couverts / résumé) ────
    # Le résumé vit en tête de messages_json côté serveur (le client ne
    # renvoie jamais de message system) : on le relit ici et on le ré-applique
    # au prompt — injection du résumé + drop des tours déjà couverts. Sans ça,
    # la compression était re-payée à chaque tour (résumé jamais persisté) et
    # le cap COMPRESSION_MAX_PER_CHAT n'aurait aucune mémoire. Appliqué pour
    # TOUTES les cibles (local + cloud : moins de tokens facturés).
    _compr_prev_state = None
    # F2 — baseline pour la concurrence optimiste : updated_at du chat AU DÉBUT
    # du stream. La persistance finale n'écrit que si le chat n'a pas bougé
    # depuis (sinon une génération/compression concurrente sur un autre worker a
    # écrit entre-temps → on NE clobbere PAS). None pour un chat neuf (INSERT).
    _baseline_updated_at = (_existing_chat or {}).get("updated_at") if _existing_chat else None
    # R2 (2026-09-16) — de quoi distinguer, sur conflit, un vrai tour concurrent
    # d'un simple renommage (cf. ``_persist_turn``). Référence, pas copie : rien
    # ne mute la liste lue.
    _baseline_messages = (_existing_chat or {}).get("messages") if _existing_chat else None
    _baseline_title = ((_existing_chat or {}).get("title") or "") if _existing_chat else ""
    try:
        if _existing_chat:
            from llm_core.conversation_compressor import apply_persisted_state, extract_compression_state
            _compr_prev_state = extract_compression_state(_existing_chat.get("messages") or [])
            if _compr_prev_state:
                msgs_for_llm, _compr_prev_state = apply_persisted_state(
                    msgs_for_llm, _compr_prev_state)
    except Exception:
        logger.warning("[chats] apply état de compression échoué (non-fatal)", exc_info=True)
        _compr_prev_state = None

    rag_meta = None
    _rag_builtin_tools = None

    if use_rag:

        from llm_core import build_rag_builtin_tools
        _rag_builtin_tools = build_rag_builtin_tools(
            collection=rag_collection,
            search_mode=rag_search_mode,
            top_k=rag_top_k,
            use_mmr=rag_use_mmr,
            ctx_size=rag_ctx_size,
        )
        if _rag_builtin_tools:
            rag_meta = {"enabled": True, "used": True, "mode": "tools"}
        else:

            # AUDIT 2026-08-31 (passe 3) — apply_rag est SYNCHRONE de bout en
            # bout (httpx.Client vers le service RAG, 30 s de timeout) :
            # exécuté sur la boucle, l'auto-RAG gelait tous les flux du worker
            # avant le premier token. Threadpool.
            msgs_for_llm, rag_meta = await asyncio.to_thread(
                apply_rag, msgs_for_llm,
                collection=rag_collection, search_mode=rag_search_mode)
            _rag_builtin_tools = None

    # BUG FIX — titre personnalisé (rename) écrasé silencieusement.
    # Avant : on recalculait TOUJOURS le titre depuis le 1er message user et on
    # le persistait via upsert_chat sans lire l'existant. Renommer un chat puis
    # lui reparler remplaçait le titre choisi par les 28 premiers caractères du
    # 1er message. On lit donc le chat existant : si un titre custom y figure
    # (non vide ET != "Nouveau chat"), on le CONSERVE et on n'auto-génère que
    # pour un chat neuf. ``_title_was_generated`` indique si on a (re)calculé un
    # titre côté serveur ce tour-ci → ne réémet le 'title' dans l'event 'final'
    # que dans ce cas (sinon la sidebar changerait sous les yeux de l'user).
    title = "Nouveau chat"
    _existing_title = ""
    try:
        # ``_existing_chat`` déjà chargé plus haut (état de compression) —
        # évite une 2e lecture/parse de messages_json sur les longs chats.
        if _existing_chat:
            _existing_title = (_existing_chat.get("title") or "").strip()
    except Exception:
        _existing_title = ""

    _title_was_generated = False
    if _existing_title and _existing_title != "Nouveau chat":
        # Chat déjà nommé (rename utilisateur ou titre auto antérieur) : on garde.
        title = _existing_title
    else:
        first_user = next((x for x in msgs if x["role"] == "user"), None)
        if first_user:
            _title_content = re.sub(r'---\s*FILE:\s*.+?\s*---[\s\S]*?---\s*END FILE\s*---\s*', '', _msg_text(first_user["content"])).strip()
            _new_title = (_title_content or "Nouveau chat")[:28]
            if _new_title != title:
                _title_was_generated = True
            title = _new_title

    # Run reprenable : la barre latérale (tous onglets) le montre en cours dès
    # qu'on le quitte ; sans titre posé tout de suite elle y lisait « Nouveau
    # chat » jusqu'à la fin du tour (save-messages est ignoré pendant un run).
    if _resumable and _title_was_generated and _existing_chat:
        with swallow("chat.early_title"):
            await asyncio.to_thread(set_title_if_default, user_id, chat_id, title)

    async def gen():
        # AUDIT 2026-09-25 — le verrou de présence réservé par le handler est
        # RÉCLAMÉ dès la première ligne (il ne l'était qu'après l'ouverture du
        # journal). Un client parti pendant ce premier ``await`` annulait
        # ``gen()`` avant la réclamation : verrou orphelin jusqu'au balayage,
        # 409 sur ce chat pendant deux minutes. Il est rendu si ``gen()`` meurt
        # avant de le confier au worker.
        _claimed = _pending_gen_locks.pop((user_id, str(chat_id)), None)
        _journal = None
        try:
            if _resumable:
                with swallow("chat.run_journal.open"):
                    from shared_infra.runtime.run_journal import RunJournal
                    _ekey = (f"conn:{_target.connector_id}"
                             if getattr(_target, "connector_id", None) else "builtin")
                    _jmeta = {"engine_key": _ekey, "model": selected_model or "",
                              "is_continue": bool(is_continue),
                              # Réconciliation côté client : nombre de messages du
                              # payload et texte du dernier message utilisateur (un
                              # autre appareil ne l'a pas encore en base).
                              "base_count": len(messages),
                              "user_message": (_last_user_text or "")[:20000]}
                    _journal = RunJournal(user_id, chat_id, _run_id, meta=_jmeta)
                    if not await _journal.open(dict(_jmeta, chat_id=chat_id)):
                        _journal = None
        except BaseException:
            if _claimed:
                with swallow("chat.gen.release_claim"):
                    from shared_infra.runtime import chat_locks as _cl_rel
                    _cl_rel.release(_claimed[0])
            raise
        # Borne anti-OOM : si le client est lent/déconnecté, ``await q.put`` applique
        # une contre-pression au worker au lieu de bufferiser sans fin (parité avec
        # agents.py _SSE_QUEUE_MAX). À la fermeture du flux, gen().finally coupe
        # l'alimentation et vide la file (``_couper_file``) AVANT d'annuler ou
        # de détacher le worker : un put en attente est débloqué, et le
        # ``final`` du partiel ne peut plus rester coincé sur une file pleine.
        q = asyncio.Queue(maxsize=1000)

        _partial_content_acc: list = []
        # Fichiers modifiés par les outils du tour (``files`` des
        # ``tool_result``) → ``files_changed`` du message : le chat retrouve
        # ses diffs après rechargement (2026-09-26).
        _files_changed_acc: dict = {}
        # Compactions du tour (L5.5) → ``compactions`` du message : le jalon
        # (motif, seuil, avant → après) survit au rechargement.
        _compactions_acc: list = []
        _compaction_en_cours: dict = {}
        # Rounds d'outils déjà faits (un appel LLM suivi d'au moins un
        # tool_call) → place du jalon au rechargement, dans l'unité de
        # _tool_segments.js. ``iteration`` arme, le 1er tool_call compte.
        _tours_vus: dict = {"n": 0, "arme": False}
        _partial_thinking_acc: list = []
        # Dernière tool_history cumulée émise par run_chat_multi_mcp juste avant de
        # propager une annulation (event interne ``tool_history_partial``). Liste
        # mutée EN PLACE (pas de ``nonlocal``) ; sert à rattacher le contexte
        # agentique au partiel sauvé pour qu'un « Continuer » ne reparte pas aveugle.
        _partial_tool_history: list = []
        # Nouvel état de compression produit CE tour (event interne
        # ``compression_state`` émis par maybe_compress_conversation). Dict
        # muté EN PLACE (même pattern que _partial_tool_history). Utilisé par
        # ``_with_compr_state`` à la persistance ; sinon carry-forward de
        # ``_compr_prev_state``.
        _new_compr_state: dict = {}
        # Clés d'élagage produites CE tour (event interne ``prune_state`` émis
        # en fin de run par la boucle). Liste mutée EN PLACE ; persistée dans
        # meta_json["ctx_pruned_keys"] à la fin du stream.
        _new_prune_keys: list = []
        # Suffixe LLM de la question de CE tour (event interne
        # ``llm_user_suffix`` de la boucle), persisté en fin de tour.
        _new_user_suffix: dict = {}
        # Détachement (cf. config.DETACH_RUN_ON_DISCONNECT) : passé à True par
        # le ``finally`` quand le CLIENT s'en va alors que le worker travaille
        # encore. Les events cessent alors d'être mis en file — sans ça le
        # worker se bloquerait sur ``q.put`` dès 1000 events en attente (la
        # contre-pression n'a plus personne pour drainer) et la mission
        # s'arrêterait quand même, mais en pleine action et sans persister.
        _detached = [False]
        # Flux fermé SANS détachement (le worker est annulé ou finit sa
        # télémétrie post-final) : même coupure que ``_detached``, mais sans en
        # porter le sens (« le run continue seul »). Cf. ``_couper_file``.
        _lecteur_parti = [False]
        # « Un outil a déjà tourné dans ce tour » — cf. _should_detach_run.
        # Liste d'un élément : posée depuis ``on_event``, lue depuis le
        # ``finally`` de gen() (deux portées de closure différentes).
        _tools_ran = [False]
        # (passe 7, R4) — le 'final' est parti : le tour est TERMINÉ côté
        # client, le worker n'a plus que sa télémétrie post-final à finir.
        # Une fermeture du flux dans cette fenêtre n'est PAS une annulation.
        _final_sent = [False]
        async def on_event(ev: dict):
            _evt = ev.get("type") if isinstance(ev, dict) else None
            # Event INTERNE (jamais forwardé au client) : capturé AVANT le filtre
            # _drop_event_after_cancel — il est justement émis PENDANT l'annulation,
            # quand ce filtre supprime tout sauf 'final'.
            if _evt == "tool_history_partial":
                _ph = ev.get("tool_history")
                if isinstance(_ph, list):
                    _partial_tool_history[:] = _ph
                return
            # Event INTERNE : état de compression à persister (round, tours
            # couverts, résumé). Jamais forwardé au client — le front n'a que
            # compression_start/done/capped.
            if _evt == "llm_user_suffix":
                if isinstance(ev.get("text"), str) and ev["text"]:
                    _new_user_suffix["text"] = ev["text"]
                return
            if _evt == "prune_state":
                _ks = ev.get("keys")
                if isinstance(_ks, list):
                    _new_prune_keys[:] = [k for k in _ks if isinstance(k, str)]
                return
            if _evt == "compression_state":
                _new_compr_state.clear()
                _new_compr_state.update({
                    "round":            ev.get("round"),
                    "covered_turns":    ev.get("covered_turns"),
                    "summary_xml":      ev.get("summary_xml"),
                    "turns_compressed": ev.get("turns_compressed"),
                    "ledger_block":     ev.get("ledger_block") or "",
                })
                return
            if _evt == "iteration":
                _tours_vus["arme"] = True
            elif _evt == "tool_call" and _tours_vus["arme"]:
                _tours_vus["n"] += 1
                _tours_vus["arme"] = False
            elif _evt == "compression_start":
                _compaction_en_cours.clear()
                _compaction_en_cours.update(reason=ev.get("reason"), threshold=ev.get("threshold"),
                                            ctx_size=ev.get("ctx_size"), round=_tours_vus["n"])
            elif _evt == "compression_done":
                _st = ev.get("stats") if isinstance(ev.get("stats"), dict) else {}
                if _st.get("compressed"):
                    _compactions_acc.append(_compaction_pour_message(
                        {**_st, **_compaction_en_cours, "path": ev.get("path")}))
                _compaction_en_cours.clear()
            # Relevé AVANT le filtre d'annulation : une écriture faite reste
            # faite, même si son résultat n'est plus montré.
            if _evt in ("tool_result", "task_step") and ev.get("files"):
                _fc_merge(_files_changed_acc, ev.get("files"))
            # BUG FIX — n'émet plus d'events après que l'utilisateur ait cancel
            # (events parasites de compression/outils), SAUF 'final' — cf.
            # docstring de _drop_event_after_cancel (audit 2026-06).
            if _drop_event_after_cancel(_evt, is_chat_cancelled(user_id, chat_id),
                                        ev.get("status")):
                return
            # AUDIT 2026-08-22 (B3) — « ce tour a déjà exécuté un outil ».
            # C'est ce qui décide, à la déconnexion, entre détacher le run et
            # l'annuler : un tour qui a écrit sur le disque ou lancé un shell
            # ne se rejoue pas à l'identique. ``tool_call`` est émis JUSTE
            # AVANT l'exécution — c'est volontaire : un outil interrompu en
            # plein vol est précisément le cas qu'on ne veut pas perdre.
            if _evt in ("tool_call", "tool_result"):
                _tools_ran[0] = True
            elif _evt == "final":
                _final_sent[0] = True
            if _evt == "content_token":
                _partial_content_acc.append(ev.get("text", ""))
                # AUDIT 2026-08-02 (M3) — compaction périodique : accumuler
                # une réponse de 100 Ko en ~25 000 micro-strings coûte
                # ~30× le texte en heap (49 o d'en-tête objet par token).
                # Le join périodique ramène la liste à 1 élément sans
                # changer le résultat final ("".join est associatif).
                if len(_partial_content_acc) > 512:
                    _partial_content_acc[:] = ["".join(_partial_content_acc)]
            elif _evt == "content_replace":
                # (passe 7, H10) — « remplace tout le corps » (nettoyage
                # divergent du streamé, reprise de prose) : le partiel persisté
                # sur un Stop entre ce point et ``_final_assistant`` portait
                # sinon la version BRUTE/tronquée que l'écran venait de corriger.
                _partial_content_acc[:] = [ev.get("text", "")]
            elif _evt == "thinking_token":
                _partial_thinking_acc.append(ev.get("text", ""))
                if len(_partial_thinking_acc) > 512:
                    _partial_thinking_acc[:] = ["".join(_partial_thinking_acc)]
            # Journal du run (chantier C) : TOUT événement destiné au client,
            # détaché ou non — c'est justement après un détachement qu'un
            # retour sur la conversation en a besoin. ``final`` clôt le
            # journal (``run_end``) sans attendre la télémétrie post-final :
            # un client rattaché voit le tour fini au moment où il l'est.
            if _journal is not None:
                _journal.append(ev)
                if _evt == "final":
                    _jstatus = ("cancelled" if ev.get("cancelled")
                                else ("error" if ev.get("persisted") is False
                                      and ev.get("persist_error") else "done"))
                    _jt = asyncio.create_task(_journal.close(_jstatus))
                    _BG_TASKS.add(_jt)
                    _jt.add_done_callback(_BG_TASKS.discard)
            # Plus personne au bout du fil : on jette au lieu de bufferiser.
            # Les events INTERNES (tool_history_partial, compression_state,
            # prune_state) sont traités plus haut et continuent d'alimenter
            # la persistance — c'est tout ce qui compte une fois détaché.
            if _detached[0] or _lecteur_parti[0]:
                return
            await q.put(ev)

        def _with_compr_state(_full: list) -> list:
            """Préfixe le message system d'état de compression à la liste
            persistée : nouvel état si une compression a eu lieu CE tour,
            sinon CARRY-FORWARD de l'état précédent (le client ne renvoie
            jamais les messages system — sans re-préfixage, l'état serait
            perdu au premier tour suivant la compression). No-op si le chat
            n'a jamais été compressé. Best-effort : ne casse jamais un persist."""
            nonlocal _compr_prev_state
            try:
                # E8 — si la lecture initiale du chat a ÉCHOUÉ (DB lockée en
                # WAL multi-worker), ``_compr_prev_state`` vaut None non pas
                # parce qu'il n'y a pas d'état, mais parce qu'on n'a pas pu le
                # lire. Persister ainsi EFFACERAIT le résumé de compaction et
                # le compteur de rounds. On retente donc la lecture ici, au
                # moment du persist (bien plus tard : la contention a
                # généralement disparu).
                if _chat_read_failed and _compr_prev_state is None:
                    try:
                        from llm_core.conversation_compressor import extract_compression_state as _extract_st
                        # Helper SYNC (chemin d'échec rare — la lecture
                        # initiale a raté) : lecture directe assumée.
                        _re = get_chat(user_id, chat_id)
                        if _re:
                            _compr_prev_state = _extract_st(_re.get("messages") or [])
                    except Exception:
                        logger.warning(
                            "[chat_stream] relecture de l'état de compression "
                            "échouée — persist SANS carry-forward", exc_info=True)

                _st = None
                if _new_compr_state.get("summary_xml"):
                    _st = _new_compr_state
                elif _compr_prev_state and _compr_prev_state.get("summary_xml"):
                    _st = _compr_prev_state
                if not _st:
                    return _full
                from llm_core.conversation_compressor import _strip_summary_messages, build_state_system_message
                _state_msg = build_state_system_message(
                    _st["summary_xml"],
                    int(_st.get("round") or 1),
                    int(_st.get("covered_turns") or 0),
                    turns_compressed=_st.get("turns_compressed"),
                    ledger_block=_st.get("ledger_block") or "",
                )
                return [_state_msg] + _strip_summary_messages(_full)
            except Exception:
                logger.warning("[chat_stream] _with_compr_state échoué (persist sans état)",
                               exc_info=True)
                return _full

        async def _persist_question():
            """Écrit la QUESTION en base dès le début d'un tour reprenable.

            AUDIT 2026-09-16 (B8) — le message de l'utilisateur n'était persisté
            qu'à la FIN du tour, avec la réponse. Un worker qui meurt en plein
            tour (redéploiement, OOM, recyclage) emportait donc la question
            elle-même : au rechargement, la conversation n'en gardait aucune
            trace. On écrit la base du tour tout de suite, avec le carry-forward
            de l'état de compression (le client ne renvoie jamais de system) et
            SOUS la garde optimiste. La base de comparaison du persist final est
            recalée sur ce qu'on vient d'écrire, sinon il tomberait en conflit
            contre sa propre écriture.
            """
            nonlocal _baseline_updated_at, _baseline_messages, _baseline_title
            if not _resumable or ephemeral or _chat_read_failed or is_continue:
                return
            with swallow("chat.persist_question"):
                _early = _with_compr_state(list(msgs))
                _ts = time.time()
                _ok = await asyncio.to_thread(
                    _persist_chat, user_id, chat_id, title, _early, _ts,
                    expected_updated_at=_baseline_updated_at)
                if _ok is not False:
                    _baseline_updated_at = _ts
                    _baseline_messages = _early
                    _baseline_title = title

        def _issue_du_tour(statut: str, kind: str = "") -> None:
            """Issue de l'exécution du tour (``runs``) : le worker avale
            annulations et pannes, ``run_scope`` n'en voit aucune (relecture
            L5 : un Stop ou un plantage finissait en « ok »)."""
            with swallow("chat.run_status"):
                from shared_infra.observability.runs import current_run
                _run = current_run()
                if _run is not None:
                    _run.finish(statut, error_kind=kind)

        async def worker():

            clear_chat_cancellation(user_id, chat_id)

            _final_assistant = ""
            _final_thinking = ""
            _final_metrics = None
            # Persistance du tour COMPLET engagée : à partir de là, le
            # ``finally`` ne doit plus écrire de partiel par-dessus (cf.
            # ``_attendre_hors_annulation``).
            _tour_persiste = False
            _was_cancelled = False
            # Exception NON gérée échappée du harnais (bug d'orchestration —
            # ex. parse d'un tool_call malformé hors du try de boucle) : le
            # partiel est persisté comme pour une annulation. Avant, tout le
            # tour — y compris les outils MUTANTS déjà exécutés — disparaissait
            # de l'historique, et aucun « Continuer » n'était proposé.
            _run_crashed = False
            # Un ``queue_status`` est-il parti vers le client ? Lié ici, au
            # niveau de ``worker()`` : les branches d'exception ci-dessous
            # doivent pouvoir retirer le widget de file même si l'incident
            # survient avant l'entrée dans le bloc d'ordonnancement.
            _file_annoncee = [False]
            # Sous-agents (outil ``task``) : sink rempli par la branche MCP, lu
            # au persist COMMUN et au persist PARTIEL (finally). Init AVANT le
            # try — un Stop (task.cancel) peut atterrir sur les premiers awaits
            # du try, avant toute affectation : le chemin partiel lisait alors
            # une variable non liée (UnboundLocalError avalé par le repli →
            # partiel perdu sans event final).
            _task_usage: dict = {}
            # Tâche de génération du titre (chat neuf) — lancée AU DÉBUT du
            # tour (cf. lancement sous le guard), récoltée au persist.
            _title_task = None
            try:
                # B8 : la question survit à un crash. AUDIT 2026-09-25 — DANS
                # le ``try`` : hors de lui, un Stop (``task.cancel``) pendant
                # cette écriture SQLite s'échappait du worker sans partiel,
                # sans event final ni marqueur de fin de file — le flux
                # restait ouvert et le verrou de présence tenu.
                await _persist_question()
                if rag_meta and rag_meta.get("used"):
                    mode_label = "RAG Outils" if _rag_builtin_tools else "RAG"
                    await on_event({"type": "mode", "text": f"{mode_label} ON" + (f" ({rag_collection})" if rag_collection else "")})
                    if rag_meta.get("sources"): await on_event({"type": "rag_sources", "text": "\n".join(rag_meta["sources"])})
                elif rag_meta and rag_meta.get("enabled") and rag_meta.get("error"):
                    # (2026-09-21) Service RAG en panne : le dire, au lieu d'une
                    # réponse sans documents qui ressemble à une réponse sourcée.
                    await on_event({"type": "info",
                                    "text": "Recherche documentaire indisponible — réponse sans les documents."})

                _use_mcp_path = bool(active_mcp_servers) or bool(_rag_builtin_tools)

                if not _use_mcp_path: await on_event({"type": "mode", "text": "Génération en cours…"})
                else:
                    parts = []
                    if active_mcp_servers:
                        parts.append("MCP: " + ", ".join(s.get("name", "?") for s in active_mcp_servers))
                    if _rag_builtin_tools:
                        parts.append("RAG Outils")
                    await on_event({"type": "mode", "text": " + ".join(parts)})

                metrics = {}
                assistant = ""

                # AUDIT 2026-08-23 — on suit ce qui est RÉELLEMENT parti vers
                # le client, pas ce que disait l'instantané. Celui-ci est pris
                # AVANT le guard et ment volontiers : ``get_queue_status_for``
                # est la variante synchrone, qui ne voit que les verrous de CE
                # worker — un run d'un autre worker gunicorn lui est invisible.
                # Quand il annonçait « ready » et que l'attente survenait
                # quand même, ``_on_queue_wait`` affichait le widget mais le
                # ``queue_cleared`` ci-dessous, conditionné à l'instantané, ne
                # partait jamais. Le front ne remet ``queueStatus`` à null que
                # sur ``queue_cleared`` ou le PREMIER ``content_token`` : un
                # tour sans prose (limite d'outils atteinte, erreur, Stop en
                # pleine réflexion) laissait le widget de file affiché après la
                # fin du tour.
                # AUDIT 2026-09-16 (M2) — la cible du tour est posée AVANT
                # l'instantané de file. Elle ne l'était qu'à l'entrée du guard
                # (plus bas) : l'instantané, le suivi de chargement et la sonde
                # du sémaphore voyaient donc le moteur INTÉGRÉ. Un tour destiné
                # à un second serveur dont un modèle porte le même nom affichait
                # « Chargement de <modèle>… » d'après l'état du serveur local,
                # et surveillait son /models/sse. Contextvar : propre à cette
                # tâche, la ré-affectation plus bas est idempotente.
                from llm_core import (
                    llm_scheduling_guard,
                    record_llm_duration,
                    resolve_scheduling_mode,
                    run_chat_multi_mcp_v2,
                    set_llm_target as _set_target_early,
                )

                # AUDIT 2026-08-23 — variante ASYNC. La SYNC ne voit ni le
                # snapshot Redis (donc rien de ce que tiennent les autres
                # workers) ni l'inventaire autoritaire du moteur : sous Redis
                # elle rendait toujours « ready », et le front affichait
                # « vous êtes 1er · ~15 s » à qui attendait derrière une
                # mission de plusieurs heures sur un autre worker.
                from llm_core._queue import get_queue_status_for_async
                _set_target_early(_target)
                _qstatus = await get_queue_status_for_async(selected_model)
                if _qstatus.get("kind") != "ready":
                    await on_event({"type": "queue_status", **_qstatus})
                    _file_annoncee[0] = True
                # Le modèle doit monter en VRAM : suivre sa progression RÉELLE
                # plutôt que d'animer une estimation. Le suivi s'éteint seul
                # quand le modèle est chargé.
                if _qstatus.get("kind") == "loading":
                    _start_load_watch(selected_model, on_event, user_id,
                                      chat_id, _qstatus)

                from llm_core._scheduling._engines import scheduling_for as _sched_for
                from llm_core.engines import engine_for_target as _eng_of
                if _target.is_llamacpp and _sched_for(_eng_of(_target))[1].locked_for(selected_model):
                    await on_event({"type": "thinking", "text": "En attente…"})
                # BUG FIX — init AVANT le async with pour qu'ils soient toujours
                # bornés même si llm_scheduling_guard lève pendant l'acquire.
                import time as _llm_t0
                _llm_start_wall = 0.0
                # AUDIT 2026-08-22 (D1/D2) — trois paramètres, trois effets :
                #   • ``target`` : une cible DISTANTE saute l'ordonnanceur
                #     local (elle ne consomme ni la VRAM ni les slots du
                #     llama-server) ;
                #   • ``on_wait`` : l'attente derrière un modèle occupé se VOIT
                #     (widget de file), au lieu d'un écran muet pendant des
                #     heures ;
                #   • ``cancel_probe`` : et elle s'ABANDONNE — le bouton Stop
                #     agit pendant l'attente comme il agit pendant la
                #     génération.
                async def _on_queue_wait(_waited: float):
                    _qs = dict(await get_queue_status_for_async(selected_model) or {})
                    _qs.pop("type", None)
                    _qs["kind"] = _qs.get("kind") or "waiting"
                    _qs["waited_ms"] = int(_waited * 1000)
                    _file_annoncee[0] = True
                    await on_event({"type": "queue_status", **_qs})

                _attente_t0 = _llm_t0.monotonic()
                async with llm_scheduling_guard(
                        selected_model, use_mcp_path=_use_mcp_path,
                        target=_target, on_wait=_on_queue_wait,
                        cancel_probe=lambda: is_chat_cancelled(user_id, chat_id)):
                    # Attente d'un créneau du moteur → exécution du tour.
                    with swallow("chat.run_wait"):
                        from shared_infra.observability.runs import current_run as _run_cour
                        _rc = _run_cour()
                        if _rc is not None:
                            _rc.add_wait(int((_llm_t0.monotonic() - _attente_t0) * 1000))

                    # Active le connecteur cible pour TOUS les appels LLM de ce
                    # tour (chat + compression). Contextvar : visible par le
                    # transport (_chat_classic / _chat_with_tools). Isolé par
                    # tâche de requête → pas de fuite entre utilisateurs.
                    from llm_core import set_llm_target as _set_target
                    _set_target(_target)

                    # Registre d'usage : la route ne MESURE plus la conso, elle
                    # se NOMME. Tout ce qui appelle le LLM sous ce scope (tour
                    # classic, boucle outils, titre, compression, sous-agents)
                    # est enregistré UNE fois, là où l'usage réel est connu.
                    # Avant, la route re-journalisait les mêmes tokens que la
                    # boucle : le tableau de bord admin les comptait deux fois.
                    set_usage_context("chat", user_id=user_id,
                                      origin_id=str(chat_id or ""))

                    if _file_annoncee[0]:
                        await on_event({"type": "queue_cleared"})
                        _file_annoncee[0] = False
                    _llm_start_wall = _llm_t0.time()
                    # ── Titre par le MODÈLE COURANT — AU TOUT DÉBUT du tour ──
                    # Chat neuf : la requête de titre part la PREMIÈRE (FIFO
                    # serveur : ~1 s avant le prefill principal), en parallèle
                    # de l'assemblage. Deux gains vs l'ancienne place (fin de
                    # tour) : le titre est prêt dès le persist SANS allonger la
                    # fin de tour, et sur un serveur mono-slot elle n'évince
                    # plus le KV de la conversation juste avant le tour suivant
                    # (le prefill principal repasse derrière elle au tour 1,
                    # où le cache est de toute façon vide). Best-effort :
                    # échec/timeout → titre tronqué historique au persist.
                    # Lecture du chat en échec : son titre (peut-être
                    # renommé par l'utilisateur) est inconnu — pas de titre
                    # généré par-dessus (AUDIT 2026-09-26).
                    if _title_was_generated and not ephemeral and not _chat_read_failed:
                        _title_task = asyncio.create_task(_generate_chat_title(
                            selected_model, _title_content, "", chat_id=chat_id))
                    if not _use_mcp_path:
                        import time as _time

                        from shared_infra.config import LLAMA_MODEL as _LLAMA_MODEL
                        _start = _time.time()
                        # AUDIT 2026-08-02 (M3) — ``content_chunks`` supprimé :
                        # il accumulait CHAQUE token de la réponse (25 000
                        # micro-strings pour 100 Ko) sans JAMAIS être lu — la
                        # réponse finale vient du retour de
                        # llama_chat_stream_tokens. Le même texte vivait donc
                        # 3× en heap (chunks + _partial_content_acc + queue).
                        thinking_chunks: list = []

                        async def _on_think(tok: str):
                            thinking_chunks.append(tok)
                            if len(thinking_chunks) > 512:              # M3
                                thinking_chunks[:] = ["".join(thinking_chunks)]
                            await on_event({"type": "thinking_token", "text": tok})

                        async def _on_content(tok: str):
                            await on_event({"type": "content_token", "text": tok})

                        from llm_core import get_model_context_size as _gmc_size
                        # Appels propres à un llama-server (n_ctx via /props,
                        # comptage via /tokenize, compression) : pour tout serveur
                        # llama.cpp — depuis le 2026-09-16 ils visent le serveur de
                        # la CIBLE (intégré ou connecteur). Pour un fournisseur non
                        # llama.cpp (cloud/vLLM) on les saute.
                        _ctx_tok = 0
                        if _target.is_llamacpp:
                            try:
                                _ctx_tok = await _gmc_size(selected_model or "")
                            except Exception:
                                _ctx_tok = 0

                        if _target.is_llamacpp:
                            # Chemin SANS outils : un seul appel LLM par tour,
                            # donc ce point EST la tête de tour — le seuil du
                            # compte s'applique pleinement (rien à couper).
                            from llm_core.context.compaction_gate import compaction_gate as _cgate
                            from llm_core.conversation_compressor import maybe_compress_conversation
                            # ``thinking_mode=False`` : PARITÉ STRICTE avec le
                            # repli que ``maybe_compress_conversation`` faisait
                            # lui-même jusqu'ici sur ce chemin. À seuil « auto »
                            # le plafond reste donc au token près celui d'avant.
                            # (Le budget dur juste en dessous, lui, passe le VRAI
                            # ``thinking_mode`` — divergence préexistante, non
                            # traitée ici pour ne pas changer un défaut au
                            # passage.)
                            _cl_gate = _cgate(_ctx_tok or 0,
                                              thinking_mode=False,
                                              threshold=_compaction_threshold)
                            _msgs_classic, _compr_stats_classic = await maybe_compress_conversation(
                                msgs_for_llm,
                                llama_chat_fn   = llama_chat,
                                on_event        = on_event,
                                model           = selected_model,
                                user_id         = str(user_id),
                                log_prefix      = "chat_classic",
                                ctx_size_tokens = _ctx_tok or None,
                                usable_tokens   = (_cl_gate.usable_tokens or None),
                                trigger_tokens  = (_cl_gate.trigger_tokens or None),
                                max_rounds      = _compaction_max_rounds,
                                prev_state      = _compr_prev_state,
                                auto_enabled    = _compression_on,
                            )
                            # ── Garantie DURE du budget de contexte (parité chemin outils) ──
                            # La compression est une HEURISTIQUE (peut ne pas se
                            # déclencher : seuil non atteint / désactivée / échouée, ou
                            # un seul tour très verbeux). Sans dernier rempart, un long
                            # chat SANS outils dépassait n_ctx → coupe finish=length en
                            # pleine réponse. ``_clamp_messages`` (dans la classic path)
                            # ne borne QUE le NOMBRE de messages (200), pas les tokens :
                            # 200 messages verbeux peuvent valoir 100K tokens sur un
                            # n_ctx 32K. On retire donc au besoin les plus vieux messages
                            # (system + tour courant préservés). Réserve = cap de
                            # génération effectif (adaptatif au n_ctx). Best-effort.
                            with swallow("chat.worker"):
                                from llm_core._chat_with_tools import _enforce_context_budget
                                from llm_core._constants import effective_generation_cap
                                _msgs_classic = await _enforce_context_budget(
                                    _msgs_classic,
                                    _ctx_tok or None,
                                    model_id=(selected_model or None),
                                    gen_cap_tokens=effective_generation_cap(
                                        thinking_mode, _ctx_tok or None),
                                )
                            # Jauge de contexte : AUCUNE émission pré-vol (on
                            # n'« imagine » plus le prompt). La jauge est recalée
                            # sur l'usage RÉEL du serveur via l'event kv_cache de
                            # fin de tour (plus bas, après llama_chat_stream_tokens).
                        else:
                            # Cible distante : pas de compression locale (cloud = grand
                            # contexte), pas d'appel /tokenize. Messages tels quels.
                            _msgs_classic = msgs_for_llm

                        _thinking_ret, assistant, _meta = await llama_chat_stream_tokens(
                            _msgs_classic,
                            user_id=username,
                            model_override=selected_model,
                            on_thinking_token=_on_think,
                            on_content_token=_on_content,
                            thinking_mode=thinking_mode,
                            is_cancelled=lambda uid=user_id, cid=chat_id: is_chat_cancelled(uid, cid),
                            sampling_override=sampling_override,
                            chat_id=chat_id,
                        )
                        # Watcher contexte/perf (LLAMA_WATCH=1) : prompt assemblé
                        # du chemin classic + mesure réelle. Best-effort.
                        with swallow("chat.worker.2"):
                            from llm_core._watch import watch_llm_call
                            watch_llm_call(
                                chat_id=chat_id, path="classic", iteration=None,
                                model=selected_model or "",
                                messages=_msgs_classic, tools_payload=None,
                                usage=(_meta or {}).get("usage"),
                                timings=(_meta or {}).get("timings"),
                            )
                        thinking_text = "".join(thinking_chunks) or _thinking_ret
                        # Réponse dé-routée hors du thinking par le recovery backend
                        # (<think> non fermé / reasoning_content-only) : le texte a été
                        # streamé en LIVE dans le panneau « thinking » mais constitue en
                        # fait la réponse (désormais dans ``assistant``). On vide le bloc
                        # thinking — live (thinking_content="" le remplace) ET côté méta —
                        # pour ne pas l'afficher en double (panneau + bulle).
                        if _meta.get("thinking_promoted"):
                            thinking_text = ""
                            await on_event({"type": "thinking_content", "text": ""})
                        # Raisonnement streamé comme réponse (``</think`` sans
                        # ouvrante) puis séparé par le backend : la bulle live
                        # porte encore raisonnement + balise → on la remplace,
                        # et le panneau reçoit le raisonnement.
                        elif _meta.get("thinking_extracted"):
                            thinking_text = _thinking_ret or ""
                            await on_event({"type": "thinking_content",
                                            "text": thinking_text})
                            await on_event({"type": "content_replace",
                                            "text": assistant or ""})
                        from llm_core import calculate_metrics as _calc
                        metrics = _calc(_meta, _time.time() - _start)
                        actual_model = metrics.get("model", _LLAMA_MODEL)
                        # Tokens : plus rien ici — ``llama_chat_stream_tokens``
                        # a déjà enregistré le tour dans ``usage_events`` avec
                        # l'usage réel et le scope posé plus haut. Seules les
                        # séries de PERF restent dans ``metric_events``.
                        # (passe 5, B15) — INSERT + flock du bus métriques :
                        # hors boucle, comme les voisins de fin de tour.
                        await asyncio.to_thread(
                            log_metric, "write_tps", metrics.get("write_tps", 0),
                            {"model": actual_model})
                        await asyncio.to_thread(
                            log_metric, "llm_latency", round(_time.time() - _start, 2),
                            {"model": actual_model})
                    else:
                        await on_event({"type": "mode", "text": "Outils prêts…"})

                        _scheduling_mode = resolve_scheduling_mode()
                        _mcp_fn = run_chat_multi_mcp_v2 if _scheduling_mode == "optimized" else run_chat_multi_mcp

                        # ── Sous-agents (outil ``task``) — builtin construit PAR
                        # TOUR : son handler capture le contexte du tour (modèle,
                        # configs, toggles, annulation, on_event, mode). Fusionné
                        # aux builtins RAG. L'enfant n'en hérite JAMAIS (deny_base
                        # + parent_builtin_tools = RAG seuls). Gaté par le toggle
                        # per-user ``agents_enabled`` (défaut OFF, cf. _agents_on).
                        _task_builtin = {}
                        if _agents_on:
                            from llm_core import build_task_builtin_tool
                            _task_builtin = build_task_builtin_tool(
                                parent_mcp_configs=active_mcp_servers,
                                parent_builtin_tools=_rag_builtin_tools,
                                username=username,
                                chat_id=chat_id,
                                model=selected_model,
                                sampling_override=sampling_override,
                                memory_enabled=_memory_on,
                                is_cancelled=lambda uid=user_id, cid=chat_id: is_chat_cancelled(uid, cid),
                                on_event=on_event,
                                scheduling_mode=_scheduling_mode,
                                usage_sink=_task_usage,
                                custom_agents=(user_settings or {}).get("custom_agents") or [],
                                # Serveurs référençables par un agent custom
                                # (``mcp_server_ids``) : les perso + ceux de la
                                # bibliothèque partagée que ce compte affiche,
                                # résolus AVEC leur auth (host-side, jamais
                                # sérialisés). Sans ça un agent custom ne pouvait
                                # pointer que des serveurs re-saisis à la main.
                                user_mcp_configs=_agent_mcp_configs(user_settings, user_id),
                                # Index des skills d'un enfant qui détient la
                                # catégorie ``skill`` (agents custom seulement).
                                user_id=user_id,
                            )
                        _all_builtins = {**(_rag_builtin_tools or {}), **_task_builtin} or None

                        assistant, _, metrics = await _mcp_fn(
                            msgs_for_llm,
                            mcp_configs=active_mcp_servers,
                            on_event=on_event,
                            username=username,
                            user_id=user_id,   # (P4) recopié dans le _meta des outils locaux
                            model=selected_model,
                            builtin_tools=_all_builtins,
                            is_cancelled=lambda uid=user_id, cid=chat_id: is_chat_cancelled(uid, cid),
                            chat_id=chat_id,
                            sampling_override=sampling_override,
                            thinking_mode=thinking_mode,
                            memory_enabled=_memory_on,
                            compression_prev_state=_compr_prev_state,
                            live_shell=_live_shell_on,
                            compression_enabled=_compression_on,
                            compaction_threshold=_compaction_threshold,
                            compaction_max_rounds=_compaction_max_rounds,
                            # Marques d'élagage DÉJÀ persistées : la boucle
                            # part de cet état et y ajoute ses sélections
                            # intra-run. Sans ça elle re-sélectionnerait à
                            # chaque tour des sorties déjà effacées de la vue.
                            prune_keys=_pruned_keys,
                            deny_tool_names=_deny_tools,
                            # Lecture seule : seuls les outils annotés
                            # read-only atteignent le modèle (cf. /plan).
                            read_only=_plan_mode,
                        )
                        thinking_text = metrics.get("thinking", "") if metrics else ""

                        # Sous-agents : compteur de RUNS seulement. Leurs tokens
                        # sont enregistrés par chaque enfant dans le registre
                        # (source « subagent », rattaché au parent) — les
                        # additionner ici les compterait une deuxième fois.
                        # L'ancien ``task_child_tokens`` n'entrait d'ailleurs
                        # dans aucun agrégat : la conso des sous-agents était
                        # invisible partout.
                        if _task_usage.get("tasks"):
                            await asyncio.to_thread(
                                log_metric, "task_runs", _task_usage["tasks"],
                                {"user": username})

                        # Tokens ET débit : déjà enregistrés par la boucle
                        # outils (``_write_end_of_turn_metrics`` écrit
                        # ``write_tps`` + ``llm_latency``). Les réécrire ici
                        # comptait chaque tour outillé DEUX fois dans la
                        # moyenne de débit du tableau de bord.

                # Estimateur de file d'attente : pertinent pour tout serveur
                # llama.cpp (chacun sa file, estimations indexées par serveur).
                # Un moteur vLLM/générique ou un modèle cloud n'a pas de slots.
                if _target.is_llamacpp:
                    with swallow("chat.worker.3"):
                        record_llm_duration(
                            selected_model,
                            (_llm_t0.time() - _llm_start_wall) * 1000.0,
                        )

                # Occupation de contexte de fin de tour : UNE mesure, trois
                # usages (pill figée du message, meta_json du chat, event
                # kv_cache). Calculée ici, avant la persistance, pour que la
                # pill survive au rechargement (elle n'était posée que côté
                # client jusqu'ici) et que la jauge se re-sème au chargement.
                _ctx_snap = None
                with swallow("chat.worker.ctx_snapshot"):
                    _ctx_snap = await _ctx_usage_snapshot(
                        metrics, selected_model, _target)

                # ``run_ids`` : exécutions du message (``runs``) — plusieurs
                # après un « Continuer », dans l'ordre.
                msg_assistant = {"role": "assistant", "content": assistant,
                                 "run_ids": [_exec_id]}
                if metrics:
                    # AUDIT 2026-08-22 (C6) — le message porte une COPIE des
                    # métriques SANS ``tool_history``. La liste (des mégaoctets
                    # sur une mission longue) était sinon présente deux fois
                    # dans le même message — au premier niveau ET dans les
                    # métriques — donc écrite deux fois en base à chaque tour.
                    # L'event NDJSON final, lui, continue de porter les
                    # métriques COMPLÈTES : le front lit ``metrics.tool_history``
                    # pour reconstruire les cartes d'outils en direct, et son
                    # repli ``data.metrics.thinking`` lit cet EVENT, jamais la base.
                    #
                    # AUDIT 2026-08-23 — ``thinking`` est retiré ici aussi. La
                    # règle produit est « le raisonnement n'est pas retenu en
                    # base » (seule exception : ``resume_thinking``), et
                    # ``upsert_chat`` ne nettoyait que le champ de PREMIER
                    # niveau : la copie nichée dans les métriques passait
                    # entière — jusqu'à ``THINKING_HISTORY_MAX_CHARS`` (400 000
                    # caractères) par message, re-sérialisés et réécrits à
                    # chaque tour puisque ``messages_json`` est reconstruit en
                    # entier.
                    msg_assistant["metrics"] = {
                        k: v for k, v in metrics.items()
                        if k not in ("tool_history", "thinking")}
                    if _ctx_snap:
                        msg_assistant["metrics"]["kv_cache"] = {
                            "used": _ctx_snap["used"], "total": _ctx_snap["total"],
                            "pct": _ctx_snap["pct"]}
                if thinking_text:
                    msg_assistant["thinking"] = thinking_text
                # Coupure en PLEIN raisonnement (``truncated_in_think``) :
                # persister le raisonnement sous ``resume_thinking`` — seule
                # exception au « thinking non persisté » (cf. save_chat), bornée
                # au suffixe utile — pour qu'un « Continuer » reprenne À PARTIR
                # du raisonnement déjà produit (même après rechargement) au lieu
                # de re-raisonner de zéro et retomber sur le même mur.
                if metrics and metrics.get("truncated_in_think") and thinking_text:
                    from llm_core._think_resume import clip_resume_thinking
                    msg_assistant["resume_thinking"] = clip_resume_thinking(thinking_text)
                    msg_assistant["thinkingTruncated"] = True

                if metrics and metrics.get("tool_history"):
                    msg_assistant["tool_history"] = metrics["tool_history"]
                    # Marqueur de format : la boucle produit désormais un
                    # DELTA (travail de CE run seul) — l'expansion du tour
                    # suivant l'expanse intégralement, sans dédup legacy.
                    if metrics.get("tool_history_delta"):
                        msg_assistant["tool_history_delta"] = True

                # Sous-agents (outil ``task``) : records des runs persistés SUR le
                # message (comme toolLoopStats) → la carte agent du front survit
                # au rechargement (_history.js réhydrate ``task_runs``).
                if _task_usage.get("runs"):
                    msg_assistant["task_runs"] = _task_runs_for_persist(_task_usage["runs"])
                if _files_changed_acc:
                    msg_assistant["files_changed"] = list(_files_changed_acc.values())
                if _compactions_acc:
                    msg_assistant["compactions"] = list(_compactions_acc)
                # Élagage visible (L5.5) : sorties d'outils retirées du contexte.
                if _new_prune_keys:
                    msg_assistant["pruned"] = len(_new_prune_keys)

                # BUG FIX — Continue (reprise) ne doit PAS créer un 2e message
                # assistant en base. Le front fusionne la continuation dans la
                # bulle tronquée existante (last.content += chunk) et ne crée
                # pas de nouvelle bulle ; côté serveur, ``msgs`` contient encore
                # l'ancien assistant tronqué. Si on ajoutait ``msg_assistant``
                # comme message séparé, la base finissait avec DEUX assistants
                # consécutifs → au rechargement (mapping 1:1) la réponse était
                # scindée en deux bulles et ``isTruncated`` perdu. On retire donc
                # le dernier assistant de ``msgs`` et on concatène son contenu +
                # tool_history/thinking dans un UNIQUE message.
                _base_msgs = msgs
                _tail_msgs: list = []
                _prev_c, _before_c, _after_c = (
                    _split_for_continue(msgs) if is_continue else ({}, msgs, []))
                if _prev_c:
                    _prev = _prev_c
                    _base_msgs, _tail_msgs = _before_c, _after_c
                    _prev_content = _tronc_pour_reprise(_prev)
                    msg_assistant["content"] = _prev_content + assistant
                    # tool_history : ``metrics["tool_history"]`` est le DELTA de la
                    # continuation (travail du run de reprise SEUL, cf.
                    # _run_tool_history) → on le CONCATÈNE au tronc persisté du
                    # message tronqué. L'ancienne capture cumulative imposait de
                    # REMPLACER (re-préfixer aurait doublé à chaque Continue) ;
                    # avec un delta, remplacer perdrait le travail du tronc.
                    _mth = _merge_continue_tool_history(
                        _prev,
                        msg_assistant.get("tool_history"),
                        bool(msg_assistant.get("tool_history_delta")),
                    )
                    msg_assistant.pop("tool_history", None)
                    msg_assistant.pop("tool_history_delta", None)
                    msg_assistant.update(_mth)
                    # AUDIT 2026-09-25 — cartes de sous-agents du
                    # SEGMENT tronqué : le message fusionné ne portait que
                    # celles de la continuation (perdues au rechargement, et
                    # absentes du contexte des tours suivants).
                    _merge_prev_segment_lists(_prev, msg_assistant)
                    # Fusionne thinking de la même façon (tronqué + reprise).
                    _prev_think = _prev.get("thinking")
                    _merged_think = (str(_prev_think) if _prev_think else "") + (thinking_text or "")
                    if _merged_think:
                        msg_assistant["thinking"] = _merged_think
                    # ``resume_thinking`` : purgé après une reprise ABOUTIE
                    # (retour à la règle « thinking non persisté ») ; si le
                    # nouveau tour est LUI-MÊME coupé en plein think, il vaut le
                    # raisonnement FUSIONNÉ — le prochain Continue repart du
                    # raisonnement complet.
                    if metrics and metrics.get("truncated_in_think"):
                        from llm_core._think_resume import clip_resume_thinking
                        _prev_rt = str(_prev.get("resume_thinking")
                                       or _prev.get("thinking") or "")
                        msg_assistant["resume_thinking"] = clip_resume_thinking(
                            _prev_rt + (thinking_text or ""))
                        msg_assistant["thinkingTruncated"] = True
                    else:
                        msg_assistant.pop("resume_thinking", None)
                        msg_assistant.pop("thinkingTruncated", None)
                    # Le contenu effectivement persisté/affiché est la fusion.
                    assistant = msg_assistant["content"]

                # Marqueurs de troncature persistés SUR le message (survivent au
                # reload via _history.js:298-300) : le bouton « Continuer »
                # réapparaît après rechargement — pour une limite de boucle d'outils
                # comme pour une coupure par plafond de tokens (finish=length).
                # Avant, msg_assistant ne les portait pas (seul le chemin annulation
                # posait isTruncated) → le « Continuer » d'un tour tool-limit était
                # déjà perdu au reload. Basés sur les metrics de CE tour (gère donc
                # la re-troncature d'une continuation).
                if metrics and metrics.get("tool_limit_reached"):
                    msg_assistant["isTruncated"] = True
                    msg_assistant["toolLoopTruncated"] = True
                    # ``iterations`` doit être HOMOGÈNE à ``max_iterations`` :
                    # ce dernier est le budget comparé aux itérations PRODUCTIVES,
                    # alors que ``tool_limit_iters`` porte le compteur dur (jusqu'à
                    # 2× le budget) → le couple pouvait décrire « 100/50 ». On
                    # relaie donc les productives ; le compteur dur reste dispo
                    # sous ``hard_iterations`` pour le diagnostic.
                    msg_assistant["toolLoopStats"] = {
                        "iterations":      metrics.get("tool_limit_effective_iters",
                                                       metrics.get("tool_limit_iters", 0)),
                        "hard_iterations": metrics.get("tool_limit_iters", 0),
                        "max_iterations":  metrics.get("tool_limit_max", 0),
                        "tool_calls_done": metrics.get("tool_limit_calls", 0),
                        # Cause fine de l'arrêt (steps | hard | wallclock |
                        # ctx_saturated | gen_cap | cycle | empty_choices) :
                        # le bandeau ne dit plus « limite atteinte » pour un
                        # run arrêté par le mur d'horloge ou une coupe.
                        "stop_reason":     metrics.get("tool_limit_stop_reason") or "",
                    }
                elif metrics and metrics.get("truncated"):
                    msg_assistant["isTruncated"] = True

                # Préfixe l'état de compression (nouveau round ou carry-forward)
                # AVANT persist — les bulles client restent inchangées.
                # ``_tail_msgs`` = les notices qui suivaient l'assistant fusionné
                # (Continue juste après une compaction) : replacées derrière lui
                # pour que le marqueur ne saute pas dans le fil.
                full = _with_compr_state(_base_msgs + [msg_assistant] + _tail_msgs)

                from shared_infra.charts.routes import embed_chart_configs
                # Threadpool : relit le chat persisté ENTIER (get_chat) + le
                # cache .charts/ dès qu'un graphique existe — sur la boucle,
                # pile au moment où la réponse se termine (passe 2).
                full = await asyncio.to_thread(
                    embed_chart_configs, user_id, chat_id, full)
                # Isole la persistance : une collision de chat_id (ValueError —
                # chat_id appartenant à un AUTRE user) ou toute erreur DB ne doit
                # PAS faire avorter le tour (la réponse EST générée). Sans ça,
                # l'exception remontait à l'except du worker → event 'error' + pas
                # de 'final' → réponse valide perdue. On dégrade : log + on continue.
                #
                # BUG FIX — succès silencieux trompeur : avant, sur échec d'upsert
                # on logguait un warning et on émettait quand même un 'final'
                # NORMAL (aucun indicateur d'échec) → le front affichait la
                # réponse comme réussie alors qu'elle n'était PAS persistée
                # (perdue au rechargement). On expose maintenant ``persisted`` +
                # ``persist_error`` dans l'event 'final' pour que le front lève un
                # toast non bloquant. Et sur collision cross-user (ValueError),
                # on régénère un chat_id serveur et on réessaie UNE fois.
                _persisted = False
                _persist_error = None
                # ── Récolte du titre lancé au début du tour (chat neuf) ──
                # La tâche est normalement déjà terminée (elle est passée
                # AVANT le prefill principal) → await quasi instantané ;
                # _generate_chat_title borne elle-même (timeout 45 s) et ne
                # lève jamais. Échec/None → titre tronqué historique.
                _final_title = title
                if _title_task is not None:
                    try:
                        # Récolte BORNÉE COURT : la tâche est partie en début
                        # de tour, elle est normalement déjà finie. Encore en
                        # course (serveur saturé) → on ne retient pas le
                        # 'final' plus de 3 s : fallback tronqué + annulation.
                        _llm_title = await asyncio.wait_for(
                            asyncio.shield(_title_task), timeout=3.0)
                    except asyncio.TimeoutError:
                        _title_task.cancel()
                        _llm_title = None
                    except asyncio.CancelledError:
                        # CancelledError de l'ENFANT (tâche titre annulée) →
                        # on continue sans titre LLM. Si c'est le WORKER qu'on
                        # annule (Stop), l'enfant n'est PAS cancelled → on
                        # propage pour ne pas casser le chemin d'annulation.
                        if not _title_task.cancelled():
                            raise
                        _llm_title = None
                    except Exception:
                        _llm_title = None
                    if _llm_title:
                        _final_title = _llm_title
                # ``_effective_chat_id`` = id réellement persisté. On NE mute PAS
                # la variable de fermeture ``chat_id`` (utilisée par le tracking
                # cancel / register_chat_task sur l'ancien id) : on n'expose le
                # nouvel id que dans l'event 'final' pour que le front recale.
                _effective_chat_id = chat_id
                try:
                    # F2 — garde optimiste cross-worker : ne persiste que si le
                    # chat n'a pas bougé depuis le début du stream. Conflit
                    # (autre génération/compression a écrit) → non persisté,
                    # surfacé au front (toast) plutôt que d'écraser son tour.
                    # (Le lambda ephemeral renvoie None → `is not False` = OK.)
                    # AUDIT 2026-08-22 (D6) — persist en THREAD. ``upsert_chat``
                    # est du SQLite synchrone : il sérialise la conversation
                    # entière (des mégaoctets en fin de mission) puis écrit et
                    # committe, avec ``busy_timeout=10000``. Appelé tel quel
                    # dans une coroutine, un writer en contention (WAL, N
                    # workers) endormait la boucle d'événements jusqu'à DIX
                    # SECONDES : pendant ce temps, plus un token pour les
                    # autres utilisateurs de ce worker, plus de SSE, et même le
                    # bouton Stop restait sans effet. Le pool de connexions est
                    # déjà par (pid, thread), donc l'appel depuis un thread est
                    # sûr.
                    #
                    # Stop PENDANT cette écriture : le thread va au bout quoi
                    # qu'il arrive. On l'attend donc jusqu'à son terme
                    # (``_attendre_hors_annulation``) et on finit le tour
                    # normalement ; ``_tour_persiste`` interdit au ``finally``
                    # d'écrire un partiel par-dessus le tour complet.
                    _tour_persiste = True
                    (_ret, _final_title), _stop_pendant_persist = (
                        await _attendre_hors_annulation(asyncio.ensure_future(
                            asyncio.to_thread(
                                _persist_turn, _persist_chat, user_id, chat_id,
                                _final_title, full,
                                baseline_updated_at=_baseline_updated_at,
                                baseline_messages=_baseline_messages,
                                baseline_title=_baseline_title))))
                    if _stop_pendant_persist:
                        logger.info(
                            "[chat_stream] Stop pendant la persistance du tour "
                            "complet (user_id=%s chat_id=%s) : écriture menée à "
                            "terme, pas de partiel", user_id, str(chat_id)[:12])
                    if _ret is False:
                        _persist_error = "conflict"
                        logger.warning(
                            "[chat_stream] persist en conflit optimiste (tour concurrent "
                            "sur le même chat) user_id=%s chat_id=%s — non écrasé",
                            user_id, str(chat_id)[:12])
                    else:
                        await asyncio.to_thread(enforce_recent_chats_cap, user_id)
                        _persisted = True
                except ValueError as _collision_err:
                    # Collision cross-user : ce chat_id appartient à un autre user.
                    # On bascule sur un chat_id serveur neuf et on réessaie une fois.
                    _new_chat_id = secrets.token_hex(12)
                    logger.warning(
                        "[chat_stream] collision chat_id cross-user — bascule sur un "
                        "nouvel id serveur user_id=%s ancien=%s nouveau=%s : %s",
                        user_id, str(chat_id)[:12], _new_chat_id[:12], _collision_err,
                    )
                    try:
                        await _attendre_hors_annulation(asyncio.ensure_future(
                            asyncio.to_thread(
                                _persist_chat, user_id, _new_chat_id, _final_title,
                                full, time.time())))
                        await asyncio.to_thread(enforce_recent_chats_cap, user_id)
                        _effective_chat_id = _new_chat_id
                        _persisted = True
                    except Exception as _retry_err:
                        _persist_error = "collision"
                        logger.warning(
                            "[chat_stream] retry sur nouvel id échoué "
                            "user_id=%s chat_id=%s : %s", user_id, _new_chat_id[:12], _retry_err,
                        )
                except Exception as _persist_err:
                    _persist_error = "db"
                    logger.warning(
                        "[chat_stream] persistance du tour échouée (réponse générée mais NON sauvegardée) "
                        "user_id=%s chat_id=%s : %s", user_id, str(chat_id)[:12], _persist_err,
                    )

                # ── Écritures meta_json de fin de tour : UNE transaction ──
                # (passe 6, B1) — marques d'élagage (M4, best-effort,
                # idempotent), toggles d'outils par chat et sortie one-shot du
                # mode plan partageaient la même colonne mais prenaient chacun
                # leur ``BEGIN IMMEDIATE`` (dont deux en SYNC sur la boucle).
                # Un seul ``finalize_turn_meta`` en thread fait les trois.
                #
                # Toggles : SAUF quand l'interrupteur maître « Outils
                # externes » est coupé — la liste est alors vide PAR DÉCISION
                # SERVEUR, pas par choix de l'utilisateur. L'écrire effaçait la
                # sélection de chaque chat touché pendant que le toggle était
                # OFF. Ne rien écrire préserve l'état d'avant.
                #
                # Mode plan ONE-SHOT : le plan est rendu → sortie AUTO.
                # Décision dans ``_plan_mode_should_end`` (module-level,
                # testable) ; le serveur reste l'autorité — le front n'est que
                # prévenu par ``plan_mode_done`` dans le 'final'. Les chemins
                # annulation/erreur ne passent pas ici (blocs except plus
                # bas) : le plan n'a pas été rendu, le mode reste.
                _do_prune = bool(_persisted and _new_prune_keys)
                _do_tools = bool(_persisted and not ephemeral and _mcp_on)
                _want_plan_off = _plan_mode_should_end(_plan_mode, _persisted, ephemeral, metrics)
                # Occupation de contexte : même transaction (un chat éphémère
                # n'a pas de ligne à mettre à jour).
                _do_ctx = bool(_persisted and not ephemeral and _ctx_snap)
                # Suffixe LLM de la question de ce tour (rappel todo) : rejoué
                # à l'octet aux tours suivants (AUDIT 2026-09-25). Signature =
                # rang + contenu de la DERNIÈRE question du payload, comme
                # l'expansion la recalculera.
                # AUDIT 2026-09-26 — l'entrée de la dernière question est
                # POSÉE ou RETIRÉE (``None``) à chaque tour persisté, et les
                # entrées de rang ≥ au sien (ancienne branche : retry,
                # édition) sont purgées ; avant, une entrée n'était jamais
                # retirée et un texte identique revenu au même rang rejouait
                # un rappel que le modèle n'avait jamais vu. L'écriture n'a
                # lieu que s'il y a quelque chose à changer.
                _suffix_map = None
                _suffix_drop_rank = None
                if _persisted and not ephemeral and not is_continue:
                    with swallow("chat.user_suffix_sig"):
                        from llm_core.context.pruning import user_suffix_sig
                        _uq = [m for m in messages if (m or {}).get("role") == "user"]
                        if _uq:
                            _rank = len(_uq) - 1
                            _prev_sfx = (_existing_chat or {}).get("llm_user_suffixes")
                            _stale = isinstance(_prev_sfx, dict) and any(
                                str(_k).split(":", 1)[0].isdigit()
                                and int(str(_k).split(":", 1)[0]) >= _rank
                                for _k in _prev_sfx)
                            if _new_user_suffix.get("text") or _stale:
                                _suffix_map = {user_suffix_sig(_rank, _uq[-1].get("content")):
                                               _new_user_suffix.get("text") or None}
                                _suffix_drop_rank = _rank
                _plan_done = False
                if _do_prune or _do_tools or _want_plan_off or _do_ctx or _suffix_map:
                    with swallow("chat.worker.4"):
                        from shared_infra.chat.store import finalize_turn_meta
                        _meta_ok = await asyncio.to_thread(
                            finalize_turn_meta, user_id, _effective_chat_id,
                            list(_new_prune_keys) if _do_prune else None,
                            (_ui_tool_cats + _ui_ext_ids
                             + ["-" + _n for _n in _ui_excl]) if _do_tools else None,
                            _want_plan_off,
                            ctx_usage=(_ctx_snap if _do_ctx else None),
                            user_suffixes=_suffix_map,
                            suffix_drop_from_rank=_suffix_drop_rank)
                        _plan_done = bool(_meta_ok and _want_plan_off)

                _final_assistant = assistant
                _final_thinking = thinking_text
                _final_metrics = metrics

                # Jauge de contexte : émission UNIQUE du tour, depuis l'usage
                # RÉEL du serveur (fin de requête) — le front recale la jauge
                # sur CHAQUE event kv_cache, il n'y a plus d'event pré-vol
                # estimé. Occupation = PROMPT RÉEL uniquement (last_prompt
                # _tokens) : on N'AJOUTE PAS la complétion, qui inclut le thinking —
                # éphémère, strippé de l'historique au tour suivant (l'inclure donnait
                # "4,7k en fin de tour" vs ~800 au prompt suivant) ; le contenu généré
                # apparaîtra dans le prompt réel du tour suivant.
                with swallow("chat.worker.6"):
                    if _ctx_snap:   # jauge KV = llama.cpp local uniquement (cf. _ctx_usage_snapshot)
                        await on_event({
                            "type": "kv_cache", "used": _ctx_snap["used"],
                            "total": _ctx_snap["total"], "pct": _ctx_snap["pct"],
                        })

                # (La sortie du mode plan est faite plus haut, dans la
                # transaction composite ``finalize_turn_meta`` — passe 6, B1.)
                _final_payload = {
                    "type": "final",
                    "assistant": assistant,
                    # Exécutions du message (``runs``) : le front les garde et
                    # les renvoie avec lui (« Détails », « Continuer »).
                    "run_ids": msg_assistant.get("run_ids") or [_exec_id],
                    **({"files_changed": msg_assistant["files_changed"]}
                       if msg_assistant.get("files_changed") else {}),
                    **({"compactions": msg_assistant["compactions"]}
                       if msg_assistant.get("compactions") else {}),
                    **({"pruned": msg_assistant["pruned"]} if msg_assistant.get("pruned") else {}),
                    "chat_id": _effective_chat_id,
                    # Additif : présent seulement quand la sortie auto du mode
                    # plan vient d'avoir lieu (cf. bloc ci-dessus).
                    **({"plan_mode_done": True} if _plan_done else {}),
                    # Additif : présent seulement quand le titre vient d'être
                    # (re)généré ce tour — le front recale header + sidebar.
                    **({"title": _final_title} if _title_was_generated else {}),
                    "metrics": metrics,
                    "thinking": msg_assistant.get("thinking", thinking_text),
                    "tool_limit_reached": bool(metrics and metrics.get("tool_limit_reached")),
                    # Troncature (plafond de tokens OU limite de boucle d'outils) →
                    # le front arme isTruncated et propose « Continuer ».
                    "truncated": bool(metrics and (metrics.get("truncated") or metrics.get("tool_limit_reached"))),
                    # Coupure par le plafond EN PLEIN raisonnement : le front
                    # GATE son filet de promotion (le thinking reste dans le
                    # bloc Réflexion, titre « Réflexion interrompue ») et le
                    # « Continuer » repart du raisonnement persisté
                    # (``resume_thinking`` → _expand_history_for_llm).
                    "truncated_in_think": bool(metrics and metrics.get("truncated_in_think")),
                    # BUG FIX — indicateur de persistance pour le front (toast non
                    # bloquant si la réponse n'a PAS été sauvegardée).
                    "persisted": _persisted,
                }
                if not _persisted and _persist_error:
                    _final_payload["persist_error"] = _persist_error
                # (Le 'title' additif est posé À LA CONSTRUCTION du payload,
                # depuis ``_final_title`` — le titre LLM quand il a réussi. Ne
                # PAS le réécrire ici depuis ``title`` : c'est le tronqué 28c,
                # il écraserait le titre LLM dans le header/sidebar — bug vu
                # en prod le 2026-07-12.)
                await on_event(_final_payload)

                # ── Télémétrie APRÈS le 'final' (passe 6, B2) ──
                # Sync mémoire (FTS5, 3 accès SQLite) + 2 log_metric (INSERT +
                # commit chacun) : rien de tout ça ne conditionne la réponse,
                # mais les faire AVANT le 'final' gardait le spinner à l'écran
                # (3 sauts de thread + 3 transactions) alors que la réponse
                # était complète. Un seul saut de thread ; chaque volet avale
                # ses erreurs — le 'final' est parti, plus AUCUNE exception ne
                # doit remonter à l'except du worker (il émettrait un event
                # 'error' après le 'final').
                def _post_final_bookkeeping():
                    if _mem_manager is not None:
                        with swallow("chat.worker.5"):
                            _mem_manager.sync_turn(_last_user_text, assistant)
                    with swallow("chat.worker.metrics"):
                        log_metric("message_sent", 1,
                                   {"role": "user", "user": username})
                        log_metric("message_sent", 1,
                                   {"role": "assistant", "user": username})
                with swallow("chat.worker.post_final"):
                    await asyncio.to_thread(_post_final_bookkeeping)
            except asyncio.CancelledError:
                _was_cancelled = True
                _issue_du_tour("cancelled")
                logger.info("[chat_stream] Cancellation détectée, sauvegarde du partiel…")
            except LLMQueueAborted:
                # Stop pendant l'ATTENTE d'un modèle occupé (cf. D2) : rien n'a
                # été généré, ce n'est pas une panne. Même traitement qu'une
                # annulation ordinaire — le partiel (vide) est persisté, le
                # front retire le widget de file.
                _was_cancelled = True
                _issue_du_tour("cancelled")
                logger.info("[chat_stream] attente du modèle abandonnée "
                            "(Stop pendant la file)")
                with swallow("chat.queue_abort_evt"):
                    await on_event({"type": "queue_cleared"})
            except Exception as e:
                # Filet : une panne pendant l'attente laissait le widget de
                # file affiché pour toujours (le front ne le retire que sur
                # ``queue_cleared`` ou le premier token).
                if _file_annoncee[0]:
                    _file_annoncee[0] = False
                    with swallow("chat.queue_clear_on_error"):
                        await on_event({"type": "queue_cleared"})
                # ``str(e)`` partait tel quel dans la bulle de chat : l'utilisateur
                # lisait « 'NoneType' object is not subscriptable », « KeyError:
                # 'content' » — ou, si l'exception était vide, le mot « Erreur »
                # tout seul. On affiche désormais une phrase par famille de panne,
                # et le motif technique voyage à côté (champ ``detail``, replié
                # dans l'UI) au lieu de le remplacer.
                logger.exception("[chat_stream] échec de la génération : %s",
                                 str(e)[:300])
                _run_crashed = True
                from llm_core._llm_retry import LLMFailure, llm_error_kind
                if isinstance(e, LLMFailure):
                    _text, _detail, _kind = str(e), e.detail, e.kind
                else:
                    _kind = llm_error_kind(e)
                    _text = (
                        "La génération s'est interrompue sur une erreur interne. "
                        "Relancez-la ; si le problème persiste, ouvrez un nouveau "
                        "chat ou signalez le détail ci-dessous."
                    )
                    _detail = f"{type(e).__name__}: {str(e)[:300]}"
                _issue_du_tour("error", _kind)
                await on_event({"type": "error", "text": _text,
                                "detail": _detail, "kind": _kind})
            finally:

                # BUG FIX — libère explicitement les ressources du MemoryManager
                # (providers, handles fichiers/index). Best-effort, jamais bloquant.
                if _mem_manager is not None:
                    with swallow("chat.worker.7"):
                        _mem_manager.shutdown()

                # Titre lancé au début du tour : récolte s'il est déjà prêt
                # (le partiel annulé profite aussi du titre LLM), sinon
                # annulation propre — pas de tâche orpheline qui continuerait
                # d'occuper le serveur après un Stop.
                _partial_title = title or "Nouveau chat"
                if _title_task is not None:
                    if _title_task.done() and not _title_task.cancelled():
                        with swallow("chat.worker.8"):
                            _partial_title = _title_task.result() or _partial_title
                    elif not _title_task.done():
                        _title_task.cancel()

                if ((_was_cancelled or _run_crashed) and not _final_assistant
                        and not _tour_persiste):

                    try:
                        partial = "".join(_partial_content_acc).strip()
                        partial_thinking = "".join(_partial_thinking_acc).strip()
                        # BUG FIX — même invariant qu'au tour complet : en
                        # is_continue, ``msgs`` contient encore l'assistant
                        # tronqué. On le retire et on fusionne son contenu/thinking
                        # dans le partiel pour ne pas créer deux bulles assistant.
                        _base_partial = msgs
                        _tail_partial: list = []
                        _prev_partial_think = ""
                        _prev_p: dict = {}
                        _pp, _bp, _ap = (
                            _split_for_continue(msgs) if is_continue else ({}, msgs, []))
                        if _pp:
                            _prev_p = _pp
                            _base_partial, _tail_partial = _bp, _ap
                            partial = (_tronc_pour_reprise(_prev_p) + partial)
                            _pt = _prev_p.get("thinking")
                            if _pt:
                                _prev_partial_think = str(_pt)
                        _merged_partial_think = _prev_partial_think + (partial_thinking or "")
                        if partial:

                            msg_partial = {
                                "role": "assistant",
                                "content": partial,
                                "isTruncated": True,
                                "run_ids": [_exec_id],
                            }
                            if _merged_partial_think:
                                msg_partial["thinking"] = _merged_partial_think
                        else:

                            msg_partial = {
                                "role": "assistant",
                                "content": _CANCEL_PLACEHOLDER,
                                # BUG FIX — le placeholder n'était PAS marqué
                                # continuable : une annulation en plein
                                # raisonnement (drain worker 300 s compris)
                                # perdait le bouton « Continuer ».
                                "isTruncated": True,
                                "run_ids": [_exec_id],
                            }
                            if _merged_partial_think:
                                msg_partial["thinking"] = _merged_partial_think
                                # Annulé 100 % thinking : le raisonnement doit
                                # SURVIVRE pour la reprise (cf. resume_thinking
                                # du tour complet).
                                from llm_core._think_resume import clip_resume_thinking
                                msg_partial["resume_thinking"] = clip_resume_thinking(
                                    _merged_partial_think)
                                msg_partial["thinkingTruncated"] = True
                        # Annulation EN PLEINE boucle d'outils : rattache la
                        # tool_history capturée (event interne tool_history_partial)
                        # pour qu'un « Continuer » rejoue le travail déjà fait au lieu
                        # de repartir aveugle (et de rejouer des outils mutants déjà
                        # appliqués). Le snapshot est le DELTA du run annulé → même
                        # fusion que le tour complet : concaténé au tronc si
                        # Continue (avant, le tronc était écrasé), et le tronc seul
                        # est préservé si le run annulé n'a rien produit.
                        msg_partial.update(_merge_continue_tool_history(
                            _prev_p, list(_partial_tool_history) or None, True))
                        # Lignes agents (outil ``task``) du tour interrompu :
                        # sans ce rattachement, les runs (y compris celui
                        # annulé en vol, poussé dans le sink AVANT la
                        # propagation du Stop) disparaissaient du partiel →
                        # cartes agents évaporées au rechargement (2026-07-18).
                        if _task_usage.get("runs"):
                            msg_partial["task_runs"] = _task_runs_for_persist(_task_usage["runs"])
                        if _files_changed_acc:
                            msg_partial["files_changed"] = list(_files_changed_acc.values())
                        if _compactions_acc:
                            msg_partial["compactions"] = list(_compactions_acc)
                        # AUDIT 2026-09-25 — Stop pendant un « Continuer » : les
                        # cartes de sous-agents du segment tronqué sont gardées.
                        if isinstance(_prev_p, dict) and _prev_p:
                            _merge_prev_segment_lists(_prev_p, msg_partial)
                        # BUG FIX — même garde que le tour complet : l'upsert du
                        # partiel peut échouer (collision cross-user / panne DB). On
                        # NE doit PAS avaler l'erreur sans 'final' (sinon le partiel
                        # s'affiche comme sauvegardé alors qu'il est perdu). On émet
                        # toujours le 'final' avec ``persisted`` pour que le front
                        # lève un toast non bloquant.
                        _partial_persisted = False
                        _partial_perr = None
                        try:
                            # Même invariant que le tour complet : l'état de
                            # compression est re-préfixé au partiel (sinon perdu).
                            # F2 — garde optimiste : ne pas clobberer un tour
                            # concurrent avec ce partiel (conflit → non persisté).
                            # AUDIT 2026-08-31 (passe 4, B2) — même déport que le
                            # tour complet : cette écriture SQLite (busy_timeout
                            # 10 s) tournait SUR la boucle au moment précis où
                            # l'utilisateur attend la réaction au Stop.
                            _pret, _partial_title = await asyncio.to_thread(
                                _persist_turn, _persist_chat, user_id, chat_id,
                                _partial_title,
                                _with_compr_state(_base_partial + [msg_partial] + _tail_partial),
                                baseline_updated_at=_baseline_updated_at,
                                baseline_messages=_baseline_messages,
                                baseline_title=_baseline_title)
                            if _pret is False:
                                _partial_perr = "conflict"
                            else:
                                _partial_persisted = True
                        except Exception as _pp_err:
                            _partial_perr = "db"
                            logger.warning(
                                "[chat_stream] persistance du partiel échouée (réponse interrompue "
                                "NON sauvegardée) user_id=%s chat_id=%s : %s",
                                user_id, str(chat_id)[:12], _pp_err,
                            )
                        _partial_final = {
                            "type": "final",
                            "assistant": msg_partial["content"],
                            "run_ids": msg_partial.get("run_ids") or [_exec_id],
                            "chat_id": chat_id,
                            "metrics": None,
                            "thinking": msg_partial.get("thinking", partial_thinking),
                            "tool_limit_reached": False,

                            "cancelled": bool(_was_cancelled),
                            # Crash (exception échappée) : même armement du
                            # « Continuer » que la troncature — le front lit
                            # cancelled OU truncated.
                            "truncated": bool(_run_crashed),
                            "persisted": _partial_persisted,
                            # Annulé en plein raisonnement (aucune prose) : le
                            # front garde le bloc Réflexion tel quel (pas de
                            # promotion) et marque la reprise possible.
                            "truncated_in_think": bool(
                                not partial and _merged_partial_think),
                        }
                        if _partial_perr:
                            _partial_final["persist_error"] = _partial_perr
                        # Cf. BUG FIX titre : ne réémet le titre que s'il a été
                        # généré ce tour-ci (chat neuf) ; sinon on préserve le
                        # rename côté front.
                        if _title_was_generated:
                            _partial_final["title"] = _partial_title
                        await on_event(_partial_final)
                    except Exception as e:
                        logger.warning("[chat_stream] Sauvegarde du partiel échouée: %s", e)
                        # (passe 8, B10) — une exception AVANT l'émission du
                        # ``final`` (split/tronc/clip/merge/task_runs/compr_state)
                        # fermait le flux SANS ``final`` : ni ``cancelled``, ni
                        # ``persisted``, ni ``persist_error`` — le front restait
                        # sur « connexion interrompue » sans bouton Continuer
                        # ni toast. On émet un ``final`` MINIMAL, non persisté.
                        if not _final_sent[0]:
                            with swallow("chat.worker.partial_final"):
                                _txt = "".join(_partial_content_acc).strip()
                                await on_event({
                                    "type": "final",
                                    "assistant": _txt or _CANCEL_PLACEHOLDER,
                                    "run_ids": [_exec_id],
                                    "chat_id": chat_id,
                                    "metrics": None,
                                    "thinking": "".join(_partial_thinking_acc).strip(),
                                    "tool_limit_reached": False,
                                    "cancelled": bool(_was_cancelled),
                                    "truncated": True,
                                    "persisted": False,
                                    "persist_error": "db",
                                    "truncated_in_think": bool(
                                        not _txt and "".join(_partial_thinking_acc).strip()),
                                })
                # Sentinelle de fin : seulement si quelqu'un lit encore. Flux
                # fermé → file pleine possible, ``put`` bloquant à vie (verrou
                # de présence jamais rendu, 409 jusqu'au redémarrage).
                if not (_detached[0] or _lecteur_parti[0]):
                    await q.put(None)
        async def _worker_journaled():
            # Fermeture GARANTIE du journal, même sans ``final`` (exception hors
            # harnais, annulation dure) : un client rattaché reçoit ``run_end``
            # au lieu d'attendre indéfiniment. Idempotent si ``final`` l'a fait.
            # L'exécution (``runs``) couvre tout le tour : ce que la boucle,
            # le titre, la compaction et les outils consomment y est versé.
            from llm_core.engines import engine_for_target as _eng_run
            from shared_infra.observability.runs import run_scope
            try:
                async with run_scope("chat", run_id=_exec_id, user_id=user_id,
                                     chat_id=chat_id, model=selected_model or "",
                                     engine=_eng_run(_target).key):
                    await worker()
            finally:
                if _journal is not None:
                    with swallow("chat.run_journal.close"):
                        await _journal.close("done" if _final_sent[0] else "error")

        task = asyncio.create_task(_worker_journaled())
        # AUDIT 2026-08-22 (A2) — référence forte + visibilité du drain : sans
        # elle, un run DÉTACHÉ n'était rattaché à rien (ni connexion uvicorn,
        # ni _BG_TASKS) — au plafond de drain, le process sortait en le tuant
        # sans que son ``finally`` ait persisté le partiel.
        _BG_TASKS.add(task)
        task.add_done_callback(_BG_TASKS.discard)

        # Verrou de présence réclamé en tête de ``gen()`` (cf. _pending_gen_locks) :
        # à partir d'ici, c'est ``unregister_chat_task`` qui le relâchera, sur
        # la fin RÉELLE du worker.
        register_chat_task(user_id, task, chat_id,
                           presence_fd=(_claimed[0] if _claimed else None))
        try:
            # Drain avec coalescing des tokens consécutifs — voir
            # _drain_coalesced (module) pour le contrat complet.
            async for ev in _drain_coalesced(q):
                yield _ndjson_line(ev)
        except asyncio.CancelledError:

            pass
        except Exception as _stream_err:
            # GARDE-FOU — une exception qui s'échappe d'ici (event non
            # sérialisable, bug dans _drain_coalesced…) remonterait dans le
            # BaseHTTPMiddleware (RequestLoggingMiddleware) et crasherait l'ASGI
            # en « Response content shorter than Content-Length », en MASQUANT
            # l'erreur réelle. On la logge AVEC sa stack (désormais visible), on
            # émet une dernière ligne d'erreur propre, puis on termine le flux
            # normalement plutôt que de laisser l'exception remonter.
            logger.exception("[chat_stream] erreur dans le drain du flux: %s", _stream_err)
            with swallow("chat.gen"):
                yield _ndjson_line({"type": "error", "text": f"Flux interrompu: {_stream_err}"})
        finally:
            # Le tour ne regarde plus le widget : couper le suivi de
            # chargement s'il tourne encore (run détaché compris — il
            # publierait dans une file que plus personne ne lit).
            with swallow("chat.stop_load_watch"):
                _stop_load_watch(user_id, chat_id)
            # ── Déconnexion du CLIENT alors que le run travaille encore ──────
            # Historiquement on annulait : fermer l'onglet tuait la génération.
            # Pour une mission autonome de plusieurs heures, cela veut dire
            # qu'elle dépend d'un navigateur resté ouvert tout ce temps — une
            # mise en veille suffisait à la perdre. Quand
            # ``DETACH_RUN_ON_DISCONNECT`` est actif, on DÉTACHE : le worker
            # continue, persiste normalement, et le résultat est là au
            # rechargement du chat.
            #
            # Trois précautions :
            #   * on ne détache PAS un Stop utilisateur (flag d'annulation posé)
            #     — c'est une demande explicite d'arrêt ;
            #   * on vide la file et on coupe l'alimentation (``_detached``),
            #     sinon le worker se bloque sur ``q.put`` dès 1000 events ;
            #   * la task RESTE enregistrée (un Stop ultérieur, depuis un autre
            #     onglet ou un autre worker via le cancel_bus, doit encore la
            #     trouver) ; le désenregistrement — donc la libération du verrou
            #     de présence — part sur un callback de fin.
            _user_stopped = False
            with swallow("chat.detach_probe"):
                _user_stopped = is_chat_cancelled(user_id, chat_id)
            # Lu À CHAUD (pas figé à l'import) : l'interrupteur doit pouvoir
            # être basculé par l'éditeur de configuration admin sans
            # redémarrage, comme le reste des réglages de génération.
            _detach_on_disconnect = False
            with swallow("chat.detach_flag"):
                from shared_infra import config as _cfg_detach
                _detach_on_disconnect = bool(
                    getattr(_cfg_detach, "DETACH_RUN_ON_DISCONNECT", False))
            if _should_detach_run(detach_enabled=(_detach_on_disconnect or _resumable),
                                  task_done=task.done(),
                                  user_stopped=_user_stopped,
                                  tools_ran=bool(_tools_ran[0])):
                _couper_file(q, _detached)
                task.add_done_callback(
                    lambda _t, _u=user_id, _c=chat_id, _k=task:
                        unregister_chat_task(_u, _c, _k))
                logger.info(
                    "[chat_stream] client déconnecté — run DÉTACHÉ (user=%s "
                    "chat=%s) : il ira au bout et persistera seul.",
                    user_id, chat_id)
                # ``return`` dans un ``finally`` d'async generator : VÉRIFIÉ
                # sûr. Le « async generator ignored GeneratorExit » ne frappe
                # qu'un générateur qui YIELD après avoir reçu GeneratorExit —
                # un ``return`` est au contraire la façon normale de terminer
                # pendant un ``aclose()``.
                return  # noqa: B012

            # Plus personne ne lit la file : sans cette coupure, le ``final``
            # du partiel (après ``task.cancel()``) ou la sentinelle de fin
            # (après la télémétrie post-final) bloquait le worker sur une file
            # pleine — il ne se terminait jamais et gardait le chat (409).
            _couper_file(q, _lecteur_parti)
            await _cloturer_run(task, user_id, chat_id,
                                final_sent=_final_sent[0])

    # AUDIT 2026-08-22 (B1) — verrou de présence pris ICI, dernière instruction
    # avant de rendre le flux : c'est le dernier point où l'on peut encore
    # répondre 409 (une fois le StreamingResponse rendu, plus rien ne peut
    # produire un code d'erreur), et il ne reste aucune instruction susceptible
    # de lever entre l'acquisition et la prise en charge par ``gen()``.
    # Sans lui, deux runs pouvaient tourner sur le même chat : il suffisait
    # d'une coupure réseau avant le premier outil pour que le retry du client
    # (app-chat.js) atterrisse, via SO_REUSEPORT, sur un AUTRE worker que celui
    # qui streamait encore — les deux persistaient, l'un perdait en conflit
    # optimiste, et les outils déjà exécutés repartaient pour un tour.
    _passation: list = []
    _gen_fd = await _acquire_gen_presence(user_id, chat_id, waited_out=_passation)
    # AUDIT 2026-09-25 — PASSATION (Stop puis régénération) : le chat a été lu
    # AVANT que l'ancien run ait fini de s'arrêter, et celui-ci a persisté son
    # partiel pendant l'attente du verrou. Sans recalage, la garde optimiste
    # de CE tour partait d'un ``updated_at`` périmé : question et réponse
    # finissaient en conflit, non sauvegardées. Le nouveau tour remplace
    # l'ancien : on repart de ce que l'ancien a écrit.
    if _passation and not ephemeral and not _chat_read_failed:
        try:
            with swallow("chat.handover_rebaseline"):
                _frais = await asyncio.to_thread(get_chat, user_id, chat_id)
                # AUDIT 2026-09-26 — recalage SEULEMENT si le chat porte ce
                # que le run stoppé a pu écrire : l'historique lu + son
                # partiel (``isTruncated``). Un drapeau de Stop périmé (resté
                # sur un autre worker) faisait passer pour une passation la
                # simple attente d'un tour NORMAL d'un autre onglet ; le
                # recalage adoptait alors ce tour, puis l'écrasait sans
                # conflit. Hors de ce cas, la garde optimiste reste sur
                # l'ancienne base : l'écriture est refusée, rien n'est perdu.
                if _frais and _handover_rebaseline_ok(
                        _baseline_messages, _frais.get("messages")):
                    _baseline_updated_at = _frais.get("updated_at")
                    _baseline_messages = _frais.get("messages")
                    _baseline_title = _frais.get("title") or ""
        except BaseException:
            # Annulation (arrêt du worker, client parti) PENDANT la relecture :
            # le verrou n'est encore ni réservé ni surveillé — relâché ici,
            # sinon il restait tenu jusqu'au redémarrage du worker.
            if _gen_fd is not None:
                try:
                    from shared_infra.runtime import chat_locks as _cl_rel
                    _cl_rel.release(_gen_fd)
                except Exception:                               # noqa: BLE001
                    pass
            raise
    if _gen_fd is not None:
        import time as _t_pend
        _pend_entry = (_gen_fd, _t_pend.monotonic())
        _pending_gen_locks[(user_id, str(chat_id))] = _pend_entry
        # Filet : un client parti AVANT que ``gen()`` démarre ne la lance
        # jamais — personne ne réclame alors le verrou. Relâché ici sans
        # attendre qu'une autre requête passe par le balayage de CE worker.
        with swallow("chat.pending_lock_watchdog"):
            asyncio.get_running_loop().call_later(
                _PENDING_GEN_LOCK_WATCHDOG_S, _release_unclaimed_gen_lock,
                (user_id, str(chat_id)), _pend_entry)
    return StreamingResponse(gen(), media_type="application/x-ndjson; charset=utf-8")

