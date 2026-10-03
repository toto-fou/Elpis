# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.events — pompe NDJSON du tour : drain coalescé de la
file du worker vers le client, filtre des événements après un Stop, coupure
de la file quand plus personne ne lit, arrêt du flux côté moteur et suivi
réel du chargement d'un modèle (``queue_status``).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Tuple

from shared_infra.observability.tracing import swallow
from shared_infra.routes._state import is_chat_cancelled

logger = logging.getLogger("uvicorn.error")


def _prompt_progress_relay(on_event):
    """Relais de la progression du pré-remplissage (``return_progress`` de
    llama.cpp) pour le chemin SANS outils, au format du chemin outils
    (``prompt_progress`` : total, traités, cache, durée) : au plus un
    événement par demi-seconde, le dernier (100 %) toujours. Sans lui, la
    pastille restait muette pendant toute la lecture d'un long historique."""
    dernier = [0.0]

    async def relais(pp: Dict[str, Any]) -> None:
        total = int(pp.get("total") or 0)
        traites = int(pp.get("processed") or 0)
        final = total > 0 and traites >= total
        now = time.monotonic()
        if not (final or now - dernier[0] >= 0.5):
            return
        dernier[0] = now
        with swallow("chat.prompt_progress"):
            await on_event({"type": "prompt_progress", "total": total, "processed": traites,
                            "cache": int(pp.get("cache") or 0),
                            "time_ms": int(pp.get("time_ms") or 0), "iter": 1})
    return relais


def _couper_file(q: "asyncio.Queue", drapeau: list) -> None:
    """Le lecteur de la file ``q`` est parti : couper l'alimentation, vider.

    Le worker écrit ses events dans une ``asyncio.Queue(maxsize=1000)`` que
    ``run_turn`` draine vers le client. Quand le flux se ferme (client parti,
    onglet fermé, client engorgé coupé par le proxy), plus personne ne lit :
    un ``await q.put`` sur une file PLEINE ne rendrait jamais la main. Le
    worker resterait alors bloqué à vie — sur le ``final`` du partiel ou sur
    la sentinelle ``None`` —, son ``finally`` ne se terminerait pas, le verrou
    de présence ne serait jamais rendu et le chat répondrait 409 jusqu'au
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

async def _drain_coalesced(q, *, window_ms: float = 25.0,
                           idle_ping_s: float = 20.0):
    """Draine la file d'événements du worker vers le client NDJSON, en
    agrégeant les tokens consécutifs (extraite pour testabilité).

    Deux étages d'agrégation des content_token / thinking_token (champ
    ``n`` = nb de tokens agrégés, pour que le front garde un tok/s exact) :

      1. SANS latence : tout ce qui est DÉJÀ en file
         (get_nowait) est agrégé — utile quand le client consomme moins
         vite que le LLM ne produit.
      2. Micro-fenêtre BORNÉE ``window_ms`` : quand le
         consommateur suit la cadence, l'étage 1 n'agrège jamais (la file
         est toujours vide) → 1 ligne NDJSON par token, soit 60 parses
         JSON + patchs Vue par seconde côté client. On attend donc jusqu'à
         ``window_ms`` de tokens supplémentaires avant d'émettre. Latence
         PERÇUE nulle : le front bufferise de toute façon ses flushs à
         40 ms — une ligne qui arrive ≤ 25 ms plus tard tombe dans le même
         flush (une fenêtre de 15 ms n'agrège que 1-2 tokens).
         ``window_ms=0`` désactive la fenêtre (étage 1 seul).

    Un événement d'un autre type interrompt l'agrégat (``pending``) pour
    préserver strictement l'ordre du flux. S'arrête sur la sentinelle None.

    ``idle_ping_s`` (0 = désactivé) : HEARTBEAT. Un outil long et silencieux
    (``execute_shell`` jusqu'à 600 s, un sous-agent ``task`` jusqu'à 1800 s)
    laisserait sinon le flux NDJSON muet pendant tout ce temps. Caddy n'impose
    aucun timeout de réponse, mais un proxy intermédiaire le pourrait — et un
    client ne pourrait pas distinguer « ça travaille » de « la connexion est
    morte ».
    On émet donc une ligne ``{"type":"ping"}`` par période de silence ; le
    front l'ignore (aucune branche ne la traite, la chaîne de dispatch tombe
    dans le vide sans effet).
    """
    _COALESCABLE = ("content_token", "thinking_token")

    # Les ``tool_call_delta`` (arguments d'un write_file / edit_file streamés
    # par le LLM) sont le type d'event le plus fréquent pendant la génération
    # d'un gros fichier : sans agrégation, une ligne NDJSON, un encodage, un
    # parse et un maillon de promesse front PAR fragment. Deux deltas
    # consécutifs du même appel
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
            # vidange sans attente : pas de ``wait_for`` par token, qui armerait
            # et annulerait un timer et un getter à chaque fois.
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
    """Garde du flux NDJSON post-cancel (extraite pour testabilité).

    Après un stop utilisateur on droppe les events parasites (tokens de
    compression/outils qui s'exécutent encore brièvement) — SAUF ``final`` :
    le 'final' du partiel est émis pendant que le flag cancel est encore posé
    et porte ``cancelled``/``persisted`` dont le front a besoin (sinon les
    tokens partiels sont perdus côté UI).

    Exception : le BILAN d'un sous-agent (``task_step`` avec
    status="final") passe aussi — il est émis pendant le unwinding du Stop
    parent et porte l'état terminal (cancelled) de la ligne agent ; le
    dropper laisserait la ligne en spinner à vie côté UI. Les autres
    ``task_step`` (tick/running/done) restent droppés (bruit post-stop).
    """
    if not cancelled or evt_type == "final":
        return False
    return not (evt_type == "task_step" and status == "final")

async def _cancel_engine_stream(user_id, chat_id: str) -> None:
    """``DELETE /v1/stream`` sur la session du couple (utilisateur, chat).

    Complète le bus d'annulation : celui-ci prévient les WORKERS, ceci arrête
    le MODÈLE. Silencieux si la fonctionnalité est coupée, si le moteur ne la
    connaît pas (404), ou si aucune session ne porte cet identifiant.

    Le SERVEUR du run est lu dans son journal (``run_journal.current_run``) :
    un tour sur un connecteur llama.cpp est arrêté sur CE serveur, avec son
    en-tête d'auth. Sans journal : le serveur intégré.
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
        # passe entièrement par le bus.
        # Règle ASYMÉTRIQUE, et AUCUNE sonde ici. Pas d'``await engine_caps()`` :
        # (a) il pourrait sonder 3 s au beau milieu d'un Stop utilisateur, et
        # (b) il renoncerait dès que les capacités valent UNKNOWN — état qu'un
        # simple timeout de sonde installe pour 300 s. L'arrêt moteur
        # deviendrait alors un no-op silencieux : le modèle continuerait de
        # générer jusqu'au bout. Or ``conversation_id`` est un HMAC déterministe de (utilisateur,
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
    except Exception as e:  # noqa: BLE001 — arrêt moteur best-effort, le bus d'annulation reste
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

    Une barre ANIMÉE sur une estimation afficherait une durée inventée, et
    finirait bloquée à 100 % pendant que le modèle monte encore. Le moteur,
    lui, connaît le vrai pourcentage et l'émet sur ``/models/sse``
    (échantillon toutes les 200 ms).

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
        except Exception as e:  # noqa: BLE001 — suivi best-effort : le widget garde son estimation
            logger.debug("[queue_status] suivi de chargement abandonné : %s",
                         str(e)[:150])
        finally:
            # ⚠ Le finally d'un watcher ANNULÉ s'exécute au tick suivant son
            # cancel() — c'est-à-dire APRÈS que _start_load_watch a enregistré
            # son successeur sous la même clé. Un pop inconditionnel
            # évincerait ce successeur du registre : plus jamais annulable par
            # _stop_load_watch, il courrait jusqu'à timeout_s en gardant sa
            # connexion /models/sse.
            if _LOAD_WATCHERS.get(key) is asyncio.current_task():
                _LOAD_WATCHERS.pop(key, None)

    try:
        _LOAD_WATCHERS[key] = asyncio.create_task(
            _run(), name=f"load-watch-{str(chat_id)[:8]}")
    except RuntimeError:
        pass            # pas de boucle (contexte de test) : sans importance


def _stop_load_watch(user_id, chat_id: str) -> None:
    """Arrête le suivi : le flux du tour se ferme (``finally`` de
    ``run_turn``)."""
    t = _LOAD_WATCHERS.pop((user_id, chat_id or ""), None)
    if t and not t.done():
        t.cancel()
