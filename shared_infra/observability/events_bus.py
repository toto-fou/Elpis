# SPDX-License-Identifier: MIT
"""
shared_infra.observability.events_bus — SSE event buses, scheduler, model cache, log fanout.

What lives here
---------------
1. **System events bus** (``SystemEvents`` + global ``system_events``):
   in-process pub/sub for admin logs and ad-hoc broadcasts. Backed by a
   ``set[asyncio.Queue]`` of currently-listening clients, with bounded
   queues so a slow client cannot block the broadcaster.

2. **Pipeline events bus** (``PipelineEvents`` + global ``pipeline_events``):
   per-user events (page Code : ``code.event``), multi-worker safe. Publie
   sur Redis quand il est joignable, sinon sur le journal fichier partagé
   (``file_bus``), que TOUS les workers suivent.

3. **Worker cleanup** (``start_cron_scheduler``, ``_local_cleanup_loop``):
   per-worker cleanup loop for resources owned by the current process
   (PTY terminals).

4. **Background-task registry** (``_register_bg_task``, ``shutdown_bg_tasks``):
   bookkeeping for every long-running task this module owns, so the lifespan
   shutdown can drain them cleanly.

5. **Model cache** (``_model_cache``, ``_refresh_model_cache``,
   ``_model_poll_loop``, ``_ensure_model_poller``,
   ``CURRENT_LOADED_MODELS``): cached snapshot of llama-server's
   /v1/models + /props with a 10 s polling background task. Guarded by a
   lazily-initialised lock to be safe under concurrent requests.

6. **SSELogHandler**: ``logging.Handler`` that keeps the in-memory log
   history (``logs`` field of GET /api/admin/logs/recent); live logs reach
   the staff through ``_staff_log_tail_loop``.

These are imported as a unit because they are tightly coupled by shared
module-level state (``system_events``, ``CURRENT_LOADED_MODELS``, etc.).
Splitting them further would either duplicate the state or introduce
import cycles.

Re-export contract
------------------
``shared_infra/routes/_legacy.py`` re-imports the names defined here, so
``from shared_infra.routes._legacy import system_events`` works.
``shared_infra/routes/__init__.py`` adds this module to its ``_SUBMODULES``
tuple so the same names are also reachable via
``from shared_infra.routes import …``.
"""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import threading as _threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from llm_core import get_llm_health, get_remote_models_with_status
from shared_infra.observability.file_bus import FileBus, FileTail
from shared_infra.observability.tracing import swallow
from shared_infra.runtime.runtime_dir import runtime_path

logger = logging.getLogger("uvicorn.error")

# CURRENT_LOADED_MODELS is module-level on purpose: every code path that
# loads/unloads a model touches it (`api_llm_load_model`,
# `api_llm_unload_model`, `_refresh_model_cache`, the auto-load of the chat
# turn in ``chatbot_app/turn/preparation.py``). A set rather than a dict
# because we only need membership; the model-cache structure stays alongside.
CURRENT_LOADED_MODELS: set = set()


# Sentinelle de fermeture propre d'un client SSE (cf. SystemEvents.listen /
# broadcast). Objet unique comparé par IDENTITÉ : aucun message légitime ne
# peut le contrefaire.
_CLIENT_CLOSED = object()


class SystemEvents:
    LOG_HISTORY_MAXLEN = 300
    QUEUE_MAX_SIZE = 500

    def __init__(self):
        # queue → {"staff": bool, "uid": int|None}. Le flux /api/system-events
        # sert TOUT utilisateur authentifié (model_status / restart /
        # notification en dépendent), mais deux familles d'events sont
        # filtrées PAR QUEUE, à l'enqueue (pas à la consommation, pour ne pas
        # saturer QUEUE_MAX_SIZE avec des messages jetés) :
        #   • ``type="log"`` : relais de TOUS les logs du worker (access-logs
        #     avec uid/IP d'autres comptes, traces, chemins disque) →
        #     divulgation transversale pour un non-staff. Staff only.
        #   • ``type="notification"`` : event PER-USER (badge cloche). Ne sort
        #     que vers les sessions du destinataire (data.user_id). Un filtre
        #     côté client seul livrerait à tout utilisateur authentifié le
        #     user_id/kind/compteur non-lus des autres.
        self.clients: dict = {}
        self._log_history = collections.deque(maxlen=self.LOG_HISTORY_MAXLEN)

    # Période de revalidation de session des flux ouverts. 60 s = compromis
    # entre réactivité de la révocation et coût DB (un SELECT indexé par
    # client toutes les 60 s).
    SESSION_RECHECK_SEC = 60.0

    async def listen(self, *, is_staff: bool = False, user_id: Optional[int] = None,
                     validity_check=None):
        """Flux SSE d'un client.

        ``validity_check`` : callable SYNC sans argument → bool, construit
        par l'endpoint avec les valeurs de session capturées au handshake.
        Ré-exécuté toutes les ``SESSION_RECHECK_SEC`` : s'il rend False, on
        émet un event ``session_expired`` (le front purge et affiche le
        login) puis on termine le flux. Sans lui, une session
        expirée/révoquée garderait son SSE ouvert indéfiniment (firehose de
        logs staff compris).
        """
        q = asyncio.Queue(maxsize=self.QUEUE_MAX_SIZE)
        self.clients[q] = {"staff": bool(is_staff), "uid": user_id}
        if is_staff:
            _ensure_staff_log_tail()
        last_check = time.time()
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    msg = None
                if (validity_check is not None
                        and time.time() - last_check >= self.SESSION_RECHECK_SEC):
                    last_check = time.time()
                    try:
                        still_valid = await asyncio.to_thread(validity_check)
                    except Exception:
                        still_valid = True  # transitoire → fail-open (cf. deps)
                    if not still_valid:
                        yield f"data: {json.dumps({'type': 'session_expired'})}\n\n"
                        return
                if msg is None:
                    continue
                # Sentinelle de fermeture (cf. broadcast) : on SORT de la
                # boucle pour que le ``finally`` s'exécute et que la réponse
                # SSE se termine — le navigateur reconnectera de lui-même.
                if msg is _CLIENT_CLOSED:
                    return
                # Même garde que PipelineEvents.listen : un payload non
                # sérialisable (datetime, Path, Exception…) lèverait TypeError
                # et tuerait le flux SSE de CE client sans aucun event
                # d'erreur. On droppe le message fautif, pas le client.
                # ``_fanout`` met en file le texte DÉJÀ sérialisé (une fois
                # pour tous les clients) ; seuls les messages de contrôle
                # (disconnect_user, avertissement de saturation) arrivent en
                # dict.
                if isinstance(msg, str):
                    payload = msg
                else:
                    try:
                        payload = json.dumps(msg)
                    except (TypeError, ValueError):
                        logger.debug("[system_events] payload non sérialisable droppé")
                        continue
                yield f"data: {payload}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            self.clients.pop(q, None)

    def disconnect_user(self, uid: Optional[int] = None,
                        message: Optional[dict] = None) -> int:
        """Ferme proprement les flux SSE d'un utilisateur (ou de tous).

        Appelé sur révocation admin (via le bus fichier inter-workers) et au
        force_logout. Pousse un ``message``
        optionnel (ex. ``{"type": "session_expired"}``) PUIS la sentinelle
        de fermeture, pour que le client apprenne la cause avant la coupure.
        Retourne le nombre de flux fermés.
        """
        closed = 0
        for q, meta in list(self.clients.items()):
            if uid is not None and meta.get("uid") != uid:
                continue
            self.clients.pop(q, None)
            try:
                if message is not None:
                    q.put_nowait(message)
                q.put_nowait(_CLIENT_CLOSED)
            except Exception:
                # Queue saturée : on la vide pour GARANTIR la place de la
                # sentinelle — sans elle, listen() resterait bloqué à vider
                # une queue que plus personne n'alimente (générateur retenu
                # tant que le navigateur ne ferme pas).
                try:
                    while True:
                        q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                with swallow("events.disconnect_user"):
                    # Ré-enfiler la CAUSE avant la sentinelle : la queue vient
                    # d'être vidée, les deux places sont garanties. Sans ceci,
                    # un client saturé au moment d'une révocation/évacuation
                    # fermerait sans jamais apprendre pourquoi (perte du hint
                    # session_expired / worker_recycling).
                    if message is not None:
                        q.put_nowait(message)
                    q.put_nowait(_CLIENT_CLOSED)
            closed += 1
        return closed

    async def broadcast(self, msg: dict):
        is_log = msg.get("type") == "log"
        if is_log:
            self._log_history.append({
                "id":      time.time(),
                "message": msg.get("message", ""),
                "level":   msg.get("level", ""),
            })
            # Un ``log`` s'écrit dans le journal commun, pas dans les queues
            # locales (qui n'atteindraient que le staff branché sur CE
            # worker) : la boucle ``_staff_log_tail_loop`` de chaque worker le
            # relaie à SES clients staff.
            try:
                from shared_infra.observability.access_logging import write_event
                write_event(str(msg.get("level") or "INFO").upper(),
                            msg.get("category") or "app",
                            str(msg.get("message", "")),
                            logger_name="system_events")
            except Exception:
                logger.debug("[system_events] log non journalisé", exc_info=True)
            return
        await self._fanout(msg)

    async def _fanout(self, msg: dict):
        """Distribue aux clients LOCAUX (filtres staff / destinataire)."""
        is_log = msg.get("type") == "log"
        # Routage per-destinataire des notifications : on extrait l'uid cible.
        # Sans user_id exploitable on DROPPE (privacy-first) plutôt que de
        # diffuser à tous — l'émetteur (routines_scheduler) le renseigne
        # toujours ; un payload malformé signale un bug, pas un besoin.
        notif_uid: Optional[int] = None
        if msg.get("type") == "notification":
            data = msg.get("data")
            try:
                notif_uid = int(data.get("user_id")) if isinstance(data, dict) else None
            except (TypeError, ValueError):
                notif_uid = None
            if notif_uid is None:
                logger.debug("[system_events] notification sans user_id valide — droppée")
                return
        # L'inventaire du serveur INTÉGRÉ ne part que vers les comptes qui y
        # ont accès (politique par utilisateur / groupe). Résolution en cache
        # court côté ``engine_access`` ; toute erreur laisse passer (fail-open
        # documenté là-bas).
        is_model_status = msg.get("type") == "model_status"
        # Sérialisation UNIQUE, paresseuse (seulement s'il y a au moins un
        # destinataire), pas un ``json.dumps`` par client dans ``listen`` :
        # ``model_status`` porte la liste complète des modèles et part vers
        # TOUS les utilisateurs à chaque variation du cache KV. Et l'accès au
        # moteur intégré n'est résolu qu'une fois par COMPTE (un compte ouvre
        # souvent plusieurs onglets), pas une fois par flux.
        payload: Optional[str] = None
        access: Dict[Any, bool] = {}
        dead = []
        for q, meta in list(self.clients.items()):
            if is_log and not meta["staff"]:
                continue   # les logs serveur ne sortent que vers le staff
            if notif_uid is not None and meta["uid"] != notif_uid:
                continue   # notification : uniquement les sessions du destinataire
            uid = meta.get("uid")
            if is_model_status and uid is not None:
                if uid not in access:
                    try:
                        from shared_infra.llm import engine_access as _ea
                        access[uid] = bool(_ea.can_use_engine(uid, _ea.BUILTIN_KEY))
                    except Exception:                           # noqa: BLE001
                        access[uid] = True                      # fail-open
                if not access[uid]:
                    continue
            if payload is None:
                try:
                    payload = json.dumps(msg)
                except (TypeError, ValueError):
                    logger.debug("[system_events] payload non sérialisable droppé")
                    return
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            # Queue pleine : PERDRE DU LOG plutôt que le client. On vide la
            # moitié la plus ancienne de la queue et on ré-enfile le message
            # courant ; le client reste inscrit et le flux repart.
            #
            # Ne pas simplement désinscrire le client (``clients.pop(q)``) : son
            # ``listen()`` resterait bloqué pour toujours sur ``await q.get()``
            # (plus personne ne pousse), le ``finally`` ne s'exécuterait jamais,
            # et les pings d'``EventSourceResponse`` (toutes les 15 s) feraient
            # voir au navigateur une connexion saine — ni ``onerror``, ni
            # reconnexion : logs et notifications gelés sans signe d'erreur.
            try:
                for _ in range(max(1, self.QUEUE_MAX_SIZE // 2)):
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                q.put_nowait({
                    "type":    "log",
                    "level":   "warning",
                    "message": "[system_events] client saturé — événements "
                               "les plus anciens abandonnés",
                })
                q.put_nowait(payload)
            except Exception:
                # Vraiment impossible de réalimenter ce client : on le libère
                # PROPREMENT via une sentinelle, que ``listen`` interprète
                # comme « termine » — le ``finally`` s'exécute, la réponse se
                # ferme et le navigateur reconnecte tout seul.
                self.clients.pop(q, None)
                with swallow("events.broadcast"):
                    q.put_nowait(_CLIENT_CLOSED)

    def get_recent_logs(self) -> list:
        return list(self._log_history)

system_events = SystemEvents()


# ═════════════════════════════════════════════════════════════════════════════
#  Pipeline Events — flux SSE per-user, multi-worker.
#
#  Pourquoi pas SystemEvents :
#    SystemEvents est en mémoire — chaque worker gunicorn a SA propre
#    instance. Quand l'event naît sur le worker 1 et que le SSE de
#    l'utilisateur est branché sur le worker 2, il ne traverse pas.
#
#  Transport :
#    - Redis pub/sub quand il est joignable (latence < 1 ms) ;
#    - journal fichier partagé (``file_bus.FileBus``) TOUJOURS suivi par
#      chaque worker, qu'il soit en Redis ou non.
#    Chaque event part sur UN transport (Redis si ce worker l'a, sinon le
#    fichier), tous les workers lisent le fichier, et un worker sans Redis
#    retente de s'y abonner périodiquement. Ne pas laisser un worker n'écouter
#    QUE son propre transport : un worker passé en fichier (Redis absent à son
#    démarrage) et ses voisins restés en Redis ne s'entendraient plus, sans
#    rien signaler, et le secours fichier d'une publication Redis ratée ne
#    serait lu par personne.
#
#  Limites assumées :
#    - Latence du fichier ~50 ms (polling) ; aucun rejeu (un client qui se
#      reconnecte resynchronise son état par HTTP, cf. _code_menu.js).
# ═════════════════════════════════════════════════════════════════════════════

class PipelineEvents:
    """Flux SSE per-user — Redis quand il est là, fichier partagé toujours.

    Garanties :
      - Isolation stricte par user_id
      - Thread-safe
      - Queue-full handling (perte des plus anciens, jamais du client)
      - Ping keep-alive (15 s)
      - Stats d'observabilité
    """
    QUEUE_MAX_SIZE       = 500
    MAX_CLIENTS_PER_USER = 50
    PING_INTERVAL_SEC    = 15.0
    SESSION_RECHECK_SEC  = 60.0       # cf. SystemEvents.SESSION_RECHECK_SEC
    POLL_INTERVAL_SEC    = 0.05
    # Cadence du fichier quand Redis porte le trafic : le fichier n'y sert que
    # de secours (publication Redis ratée, voisin sans Redis).
    POLL_REDIS_MODE_SEC  = 0.5
    # Cadence quand AUCUN abonné n'est connecté à ce worker : redistribuer
    # n'aurait alors personne à servir. Sortie immédiate dès qu'un client
    # arrive (``_wake``), donc aucune latence perdue.
    POLL_IDLE_SEC        = 1.0
    REDIS_RETRY_SEC      = 30.0
    MAX_FILE_SIZE_BYTES  = 5_000_000
    # Sous la racine runtime quand elle est posée (un ``PrivateTmp`` systemd
    # scinderait ce canal en silence) ; ``/tmp`` sinon (``runtime_path``).
    EVENTS_FILE          = runtime_path("pipeline_events.jsonl", "ELPIS_PIPELINE_EVENTS_FILE",
                                        "/tmp/elpis_pipeline_events.jsonl")
    REDIS_CHANNEL        = "elpis:pipeline_events"
    REDIS_CONNECT_TIMEOUT = 1.5

    # Modes de backend (``_mode`` = transport de PUBLICATION de ce worker)
    MODE_REDIS  = "redis"
    MODE_FILE   = "file"
    MODE_MEMORY = "memory"

    def __init__(self):
        # État local aux SSE clients connectés à CE worker
        self.clients: Dict[int, set] = {}
        self._lock = _threading.Lock()
        self._total_dropped = 0
        self._total_errors  = 0

        self._mode: str = self.MODE_MEMORY
        self._initialized = False
        self._init_lock = asyncio.Lock()

        # Fichier partagé : bus + curseur (recréés si EVENTS_FILE change —
        # les tests le repointent après construction).
        self._fbus: Optional[FileBus] = None
        self._ftail: Optional[FileTail] = None
        self._file_ok = False
        self._file_poll_task: Optional[asyncio.Task] = None
        # Armé par ``_register`` : fait sortir la boucle de tail de sa cadence
        # lente dès qu'un abonné arrive (cf. _file_poll_loop).
        self._wake = asyncio.Event()

        # Redis
        self._redis = None
        self._redis_sub_task: Optional[asyncio.Task] = None
        self._redis_retry_task: Optional[asyncio.Task] = None

    # ═══ Fichier partagé : accès ══════════════════════════════════════════

    def _bus(self) -> FileBus:
        if self._fbus is None or self._fbus.path != Path(self.EVENTS_FILE):
            self._fbus = FileBus(Path(self.EVENTS_FILE), self.MAX_FILE_SIZE_BYTES)
            self._ftail = None
        return self._fbus

    def _tail(self) -> FileTail:
        bus = self._bus()
        if self._ftail is None:
            self._ftail = bus.tail()
        return self._ftail

    # ═══ INITIALISATION ═══════════════════════════════════════════════════

    async def _ensure_initialized(self) -> None:
        """Démarre le suivi du fichier et l'abonnement Redis (1 fois/worker)."""
        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return
            self._file_ok = await self._try_init_file()
            if await self._try_init_redis():
                self._mode = self.MODE_REDIS
            elif self._file_ok:
                self._mode = self.MODE_FILE
                self._start_redis_retry()
            else:
                self._mode = self.MODE_MEMORY
                self._start_redis_retry()
            self._initialized = True
            if self._mode == self.MODE_MEMORY:
                logger.warning(
                    "[pipeline_events] backend=MEMORY (single-process uniquement) pid=%d — "
                    "le multi-worker SSE ne fonctionnera pas correctement.",
                    os.getpid(),
                )
            else:
                logger.info("[pipeline_events] backend=%s (fichier %s) pid=%d",
                            self._mode.upper(),
                            "suivi" if self._file_ok else "INDISPONIBLE",
                            os.getpid())

    async def _try_init_redis(self) -> bool:
        """Tente de se connecter à Redis et de lancer le listener pub/sub."""
        from shared_infra.env_compat import env
        if (env("ELPIS_DISABLE_REDIS") or "").lower() in ("1", "true", "yes"):
            return False
        try:
            import redis.asyncio as aioredis  # type: ignore
        except ImportError:
            return False
        redis_url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
        client = None
        try:
            client = aioredis.from_url(
                redis_url,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=self.REDIS_CONNECT_TIMEOUT,
                socket_keepalive=True,
                health_check_interval=30,
            )
            await asyncio.wait_for(client.ping(), timeout=self.REDIS_CONNECT_TIMEOUT)
            self._redis = client
            self._redis_sub_task = asyncio.create_task(self._redis_subscriber())
            return True
        except Exception as e:
            logger.debug("[pipeline_events] Redis indisponible (%s): %s", redis_url, e)
            if client is not None:
                with swallow("events.redis_init_close"):
                    await client.aclose()
            self._redis = None
            return False

    def _start_redis_retry(self) -> None:
        from shared_infra.env_compat import env
        if (env("ELPIS_DISABLE_REDIS") or "").lower() in ("1", "true", "yes"):
            return
        if self._redis_retry_task is None or self._redis_retry_task.done():
            self._redis_retry_task = asyncio.create_task(self._redis_retry_loop())

    async def _redis_retry_loop(self) -> None:
        """Worker démarré sans Redis : s'y abonne dès qu'il devient joignable,
        pour ne pas rester sourd aux voisins qui publient dessus."""
        try:
            while self._redis is None:
                await asyncio.sleep(self.REDIS_RETRY_SEC)
                if await self._try_init_redis():
                    self._mode = self.MODE_REDIS
                    logger.info("[pipeline_events] Redis rejoint en cours de route pid=%d",
                                os.getpid())
        except asyncio.CancelledError:
            return

    async def _try_init_file(self) -> bool:
        """Positionne le curseur en fin de fichier et lance la boucle de tail."""
        try:
            await asyncio.to_thread(self._tail().skip_to_end)
            self._file_poll_task = asyncio.create_task(self._file_poll_loop())
            return True
        except Exception as e:
            logger.debug("[pipeline_events] fichier partagé indisponible: %s", e)
            return False

    # ═══ BACKEND REDIS : pub/sub ═══════════════════════════════════════════

    async def _redis_subscriber(self) -> None:
        """Écoute le channel Redis et redistribue aux SSE locaux."""
        backoff = 1.0
        pubsub = None
        while True:
            try:
                if self._redis is None:
                    return
                pubsub = self._redis.pubsub()
                await pubsub.subscribe(self.REDIS_CHANNEL)
                backoff = 1.0  # reset après subscribe réussi
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    try:
                        raw = message.get("data") or ""
                        if not raw:
                            continue
                        self._deliver_envelope(json.loads(raw))
                    except Exception:
                        with self._lock:
                            self._total_errors += 1
            except asyncio.CancelledError:
                # Ferme proprement pubsub sur cancel (shutdown).
                if pubsub is not None:
                    with swallow("events.redis_subscriber"):
                        await pubsub.aclose()
                return
            except Exception as e:
                # Ferme pubsub avant le retry, sinon chaque flap réseau fuit
                # une connexion Redis.
                if pubsub is not None:
                    with swallow("events.redis_subscriber.2"):
                        await pubsub.aclose()
                    pubsub = None
                logger.warning(
                    "[pipeline_events] Redis subscriber crashed: %s — retry in %.0fs",
                    e, backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)  # back-off exponentiel, max 30s

    async def _redis_publish(self, user_id: int, msg: dict) -> bool:
        """Publie un event sur Redis. Retourne True si OK, False pour fallback."""
        client = self._redis
        if client is None:
            return False
        try:
            envelope = json.dumps({"__uid": int(user_id), "__msg": msg}, ensure_ascii=False)
            await client.publish(self.REDIS_CHANNEL, envelope)
            return True
        except Exception as e:
            with self._lock:
                self._total_errors += 1
            logger.debug("[pipeline_events] Redis publish failed: %s", e)
            return False

    # ═══ BACKEND FILE : fichier partagé ═══════════════════════════════════

    async def _file_poll_loop(self) -> None:
        """Tail le fichier et redistribue les nouveaux events.

        La cadence suit la PRÉSENCE D'UN ABONNÉ sur ce worker, pas l'activité :
        sans personne pour recevoir, redistribuer ne sert à rien, et 20 tours
        par seconde coûtent 0,48 % d'un cœur par worker — mesuré — pour rien.

        * la bascule est INSTANTANÉE — ``_wake`` est armé par ``_register`` ;
        * elle n'introduit AUCUNE latence — la cadence rapide est conservée
          dès qu'un abonné existe (plus lente en mode Redis, où le fichier
          n'est qu'un secours).

        Pendant l'attente longue, on cale le curseur sur la fin du fichier :
        un abonné qui arrive reçoit la suite, pas l'historique accumulé.
        """
        # Curseur posé DÈS le démarrage : créé paresseusement au premier tour
        # utile, il se caserait en fin de fichier APRÈS des events déjà
        # destinés au premier abonné.
        self._tail()
        while True:
            try:
                if self._has_clients():
                    await asyncio.sleep(self.POLL_REDIS_MODE_SEC
                                        if self._redis is not None
                                        else self.POLL_INTERVAL_SEC)
                    await self._file_read_new()
                else:
                    self._wake.clear()
                    try:
                        await asyncio.wait_for(self._wake.wait(),
                                               timeout=self.POLL_IDLE_SEC)
                    except asyncio.TimeoutError:
                        pass
                    if not self._has_clients():
                        self._file_skip_to_end()
            except asyncio.CancelledError:
                return
            except Exception:
                with self._lock:
                    self._total_errors += 1
                await asyncio.sleep(1.0)

    def _has_clients(self) -> bool:
        with self._lock:
            return any(self.clients.values())

    def _file_skip_to_end(self) -> None:
        """Cale la position de lecture sur la fin du fichier, sans distribuer."""
        self._tail().skip_to_end()

    async def _file_read_new(self) -> None:
        # I/O en thread ; la distribution (put_nowait sur des queues asyncio)
        # reste sur la boucle. Le curseur n'est touché que par cette boucle
        # séquentielle (la rotation est faite par RENOMMAGE côté writer, le
        # curseur ne bouge plus sous nos pieds).
        tail = self._tail()
        if not tail.has_new():
            return               # tour vide (le cas courant) : pas de thread
        try:
            envelopes = await asyncio.to_thread(tail.read_new)
        except Exception:
            with self._lock:
                self._total_errors += 1
            return
        for payload in envelopes:
            try:
                self._deliver_envelope(payload)
            except Exception:
                with self._lock:
                    self._total_errors += 1

    async def _file_publish(self, user_id: int, msg: dict) -> bool:
        ok = await asyncio.to_thread(
            self._bus().append, {"__uid": int(user_id), "__msg": msg})
        if not ok:
            with self._lock:
                self._total_errors += 1
        return ok

    # ═══ DISTRIBUTION LOCALE (commun à tous les backends) ═════════════════

    def _deliver_envelope(self, payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        uid = payload.get("__uid")
        msg = payload.get("__msg")
        if uid is None or msg is None:
            return
        self._distribute_local(int(uid), msg)

    def _register(self, user_id: int, q: asyncio.Queue) -> bool:
        with self._lock:
            queues = self.clients.get(user_id)
            if queues is None:
                queues = set()
                self.clients[user_id] = queues
            if len(queues) >= self.MAX_CLIENTS_PER_USER:
                return False
            queues.add(q)
        # Réveille la boucle de tail : elle dort en cadence lente tant que
        # personne n'écoute, et doit repasser en cadence rapide TOUT DE SUITE.
        try:
            self._wake.set()
        except Exception:
            pass
        return True

    def _unregister(self, user_id: int, q: asyncio.Queue) -> None:
        with self._lock:
            queues = self.clients.get(user_id)
            if queues is None:
                return
            queues.discard(q)
            if not queues:
                self.clients.pop(user_id, None)

    def _snapshot_queues(self, user_id: int) -> list:
        with self._lock:
            queues = self.clients.get(user_id)
            return list(queues) if queues else []

    def _distribute_local(self, user_id: int, msg: dict) -> None:
        """Distribue un message aux SSE clients locaux (post-réception backend)."""
        queues = self._snapshot_queues(user_id)
        if not queues:
            return
        dead = []
        for q in queues:
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # PERDRE des events anciens plutôt que le client : on vide la
                # moitié la plus ancienne et on ré-enfile le message courant.
                # Si même ça échoue → sentinelle, le flux se ferme proprement
                # et le navigateur reconnecte.
                try:
                    for _ in range(max(1, self.QUEUE_MAX_SIZE // 2)):
                        try:
                            q.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                    q.put_nowait(msg)
                    with self._lock:
                        self._total_dropped += 1
                except Exception:
                    dead.append(q)
            except Exception:
                dead.append(q)
                with self._lock:
                    self._total_errors += 1
        if dead:
            with self._lock:
                queues_live = self.clients.get(user_id)
                if queues_live is not None:
                    for q in dead:
                        queues_live.discard(q)
                    if not queues_live:
                        self.clients.pop(user_id, None)
                self._total_dropped += len(dead)
            for q in dead:
                with swallow("events.pipeline_distribute"):
                    # Libère un slot d'abord : une queue restée PLEINE
                    # refuserait la sentinelle (retour au zombie).
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    q.put_nowait(_CLIENT_CLOSED)

    # ═══ API PUBLIQUE ═════════════════════════════════════════════════════

    async def listen(self, user_id: int, *, validity_check=None, render=None):
        """Flux SSE d'un client : s'inscrit pour recevoir ses events.

        ``validity_check`` : même mécanique que ``SystemEvents.listen`` —
        ré-exécuté toutes les ``SESSION_RECHECK_SEC`` ; à False, on émet
        ``session_expired`` puis on termine.

        ``render`` : ``dict -> str | None``, le texte du champ ``data``
        (``None`` = ne rien envoyer). Défaut :
        ``json.dumps``. Évite au consommateur (page Code) de RE-décoder puis
        re-encoder chaque event, par client, à cadence quasi-token.
        """
        _render = render or json.dumps

        def _frame(obj):
            try:
                data = _render(obj)
            except (TypeError, ValueError):
                with self._lock:
                    self._total_errors += 1
                return None
            return None if data is None else f"data: {data}\n\n"

        await self._ensure_initialized()
        q: asyncio.Queue = asyncio.Queue(maxsize=self.QUEUE_MAX_SIZE)
        if not self._register(user_id, q):
            f = _frame({'type': 'error', 'code': 'too_many_streams',
                        'message': 'Too many concurrent SSE connections'})
            if f:
                yield f
            return
        last_check = time.time()
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=self.PING_INTERVAL_SEC)
                except asyncio.TimeoutError:
                    msg = None
                if (validity_check is not None
                        and time.time() - last_check >= self.SESSION_RECHECK_SEC):
                    last_check = time.time()
                    try:
                        still_valid = await asyncio.to_thread(validity_check)
                    except Exception:
                        still_valid = True  # transitoire → fail-open (cf. deps)
                    if not still_valid:
                        f = _frame({'type': 'session_expired'})
                        if f:
                            yield f
                        return
                if msg is None:
                    yield ": ping\n\n"
                    continue
                # Sentinelle de fermeture : poussée par ``disconnect_user``
                # (révocation, évacuation d'un worker qui s'arrête).
                if msg is _CLIENT_CLOSED:
                    return
                f = _frame(msg)
                if f:
                    yield f
        except asyncio.CancelledError:
            pass
        except Exception:
            with self._lock:
                self._total_errors += 1
        finally:
            self._unregister(user_id, q)

    def disconnect_user(self, user_id: int, message: Optional[dict] = None) -> int:
        """Ferme les flux SSE pipeline locaux d'un utilisateur.

        ``message`` : la CAUSE (``session_expired``, ``worker_recycling``)
        poussée avant la sentinelle, comme ``SystemEvents.disconnect_user`` —
        sans elle, la page Code verrait une fin de flux muette, se
        reconnecterait, prendrait un 401 et bouclerait sans jamais afficher
        l'écran de connexion.
        Retourne le nombre de flux fermés sur CE worker."""
        queues = self._snapshot_queues(int(user_id))
        closed = 0
        for q in queues:
            try:
                if message is not None:
                    q.put_nowait(message)
                q.put_nowait(_CLIENT_CLOSED)
            except Exception:
                try:
                    while True:
                        q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                with swallow("events.disconnect_user.2"):
                    if message is not None:
                        q.put_nowait(message)
                    q.put_nowait(_CLIENT_CLOSED)
            closed += 1
        return closed

    def disconnect_all(self, message: Optional[dict] = None) -> int:
        with self._lock:
            uids = list(self.clients.keys())
        return sum(self.disconnect_user(u, message=message) for u in uids)

    async def broadcast_to_user(self, user_id: int, msg: dict) -> None:
        """Publie un event : Redis si ce worker l'a, sinon le fichier partagé
        (lu par TOUS les workers), en dernier recours les clients locaux."""
        await self._ensure_initialized()
        uid = int(user_id)
        if self._redis is not None and await self._redis_publish(uid, msg):
            return
        if self._file_ok and await self._file_publish(uid, msg):
            return
        self._distribute_local(uid, msg)

    def stats(self) -> dict:
        """Snapshot observabilité — utile pour /api/admin/metrics ou debug."""
        with self._lock:
            total_clients = sum(len(qs) for qs in self.clients.values())
            file_size = 0
            with swallow("events.stats"):
                p = Path(self.EVENTS_FILE)
                file_size = p.stat().st_size if p.exists() else 0
            return {
                "backend":           self._mode,
                "initialized":       self._initialized,
                "file_tail":         self._file_ok,
                "users_connected":   len(self.clients),
                "total_clients":     total_clients,
                "events_dropped":    self._total_dropped,
                "errors":            self._total_errors,
                "file_size_bytes":   file_size,
                "redis_ready":       self._redis is not None,
            }


pipeline_events = PipelineEvents()

# ── Model status cache + background SSE push ─────────────────────────────────
# Instead of every client polling /api/llm/models every 5s, a single
# background task polls the LLM server every 10s, caches the result,
# and broadcasts via SSE only when something changes.

_model_cache: Dict[str, Any] = {}
_model_cache_hash: str = ""
_model_cache_lock = None  # initialized lazily (needs event loop)

async def _refresh_model_cache():
    """Fetch model status from llama-server, update cache, broadcast if changed."""
    global _model_cache, _model_cache_hash
    try:
        # Les deux sondes sont indépendantes : fan-out, pas d'enchaînement
        # (chacune télécharge /v1/models de son côté ; en parallèle, le
        # doublon ne coûte pas de temps mur).
        health, models_with_status = await asyncio.gather(
            get_llm_health(), get_remote_models_with_status())

        model_ids = [m["id"] for m in models_with_status]
        loaded_ids = {m["id"] for m in models_with_status if m["status"] == "loaded"}

        # MUTATION EN PLACE — jamais de rebind. ``chatbot_app/turn/preparation.py``,
        # ``shared_infra/llm/routes.py`` et ``shared_infra/routes/_legacy.py``
        # font ``from shared_infra.observability.events_bus import
        # CURRENT_LOADED_MODELS`` : leur nom local reste lié à l'objet
        # importé. Un rebind (``= set(...)``) laisserait ces lecteurs sur le
        # set d'origine, perpétuellement vide → faux broadcasts « Modèle
        # auto-chargé par requête chat » à la 1re utilisation de chaque modèle
        # déjà chargé, et refresh légitime sauté après une éviction réelle.
        # clear()+update() s'exécutent sans await intermédiaire : aucun
        # lecteur ne voit le set vide.
        CURRENT_LOADED_MODELS.clear()
        CURRENT_LOADED_MODELS.update(loaded_ids)

        health["models_loaded"] = [{"id": m} for m in loaded_ids]
        if "props" not in health or not isinstance(health["props"], dict):
            health["props"] = {}
        health["props"]["model"] = list(loaded_ids)[0] if loaded_ids else ""

        # ── Flag vision par modèle ──
        # Dérivé par get_remote_models_with_status depuis l'entrée /v1/models
        # déjà téléchargée. Ne pas sonder chaque modèle à part : une requête
        # réseau (client httpx neuf + liste complète re-téléchargée) par
        # modèle, séquentielle, toutes les 10 s et par worker.
        for m in models_with_status:
            m.setdefault("vision", False)

        new_cache = {
            "models": model_ids,
            "models_with_status": models_with_status,
            "models_loaded": health.get("models_loaded", []),
            "kv_cache": health.get("kv_cache", {}),
            "server_reachable": health.get("server_reachable", False),
            "status": health.get("status", "unreachable"),
            "props": health.get("props", {}),
        }

        # Hash on model list + loaded set + kv cache to detect changes
        new_hash = json.dumps({
            "ids": sorted(model_ids),
            "loaded": sorted(loaded_ids),
            "status": health.get("status", ""),
            "kv_pct": health.get("kv_cache", {}).get("pct", 0),
        }, sort_keys=True)

        _model_cache.update(new_cache)

        if new_hash != _model_cache_hash:
            _model_cache_hash = new_hash
            await system_events.broadcast({
                "type": "model_status",
                "data": new_cache,
            })
    except Exception as e:
        logger.debug(f"[model_cache] refresh error: {e}")


async def refresh_models_everywhere() -> None:
    """Rafraîchit l'état des modèles ici ET sur tous les autres workers.

    Après un chargement ou un déchargement, un événement de contrôle
    ``model_cache_refresh`` sur le bus fichier fait rafraîchir chaque worker
    tout de suite. Sans lui, seul le worker qui a traité la requête repousse
    ``model_status`` à SES clients : ceux des autres workers gardent une
    pastille périmée jusqu'à 10 s (leur propre poller), et
    ``CURRENT_LOADED_MODELS`` y reste faux d'autant."""
    await _refresh_model_cache()
    try:
        from shared_infra.observability.metrics.broadcast import publish_event
        await asyncio.to_thread(publish_event, {"type": "model_cache_refresh"})
    except Exception:
        logger.debug("[model_cache] diffusion inter-workers impossible", exc_info=True)


async def _model_poll_loop():
    """Background task: refresh model cache every 10s."""
    while True:
        with swallow("events.model_poll_loop"):
            await _refresh_model_cache()
        await asyncio.sleep(10)


_model_poller_started = False

def _ensure_model_poller():
    """Start the background model poller if not already running."""
    global _model_poller_started
    if _model_poller_started:
        return
    _model_poller_started = True
    try:
        # Tâche enregistrée via _register_bg_task : sans référence tenue,
        # Python peut la collecter à chaud (RuntimeWarning "coroutine was
        # never awaited"), et elle ne serait jamais annulée au shutdown
        # (poll jusqu'à la mort du worker). Import via le réexport de
        # ``shared_infra.routes._legacy``.
        from shared_infra.routes._legacy import _register_bg_task as _reg
        _reg(asyncio.create_task(_model_poll_loop()))
        logger.info("[model_cache] Background model poller started (10s interval)")
    except RuntimeError:
        _model_poller_started = False

# ── Cron scheduler ────────────────────────────────────────────────────────────

def _cron_matches(expr: str, now) -> bool:
    parts = expr.strip().split()
    if len(parts) != 5:
        return False
    fields = [
        (parts[0], now.minute),
        (parts[1], now.hour),
        (parts[2], now.day),
        (parts[3], now.month),
        (parts[4], now.weekday() + 1),
    ]
    for pat, val in fields:
        if pat == '*':
            continue
        try:
            if '/' in pat:
                step = int(pat.split('/')[1])
                if val % step != 0:
                    return False
            elif '-' in pat:
                a, b = pat.split('-')
                if not (int(a) <= val <= int(b)):
                    return False
            elif ',' in pat:
                if val not in [int(x) for x in pat.split(',')]:
                    return False
            else:
                if int(pat) != val:
                    return False
        except Exception:
            return False
    return True


# Garde d'idempotence. ``start_cron_scheduler`` peut etre appele depuis DEUX
# endroits : le lifespan de l'app (au boot, sur chaque worker) et l'endpoint
# ``/api/system-events`` (lazy). Sans cette garde, un second appel
# relancerait ``_local_cleanup_loop``.
_cron_scheduler_started = False

def start_cron_scheduler():
    """Lance le cleanup local par worker (``_local_cleanup_loop``).

    ``_local_cleanup_loop`` tourne sur CHAQUE worker : il nettoie les
    ressources propres au worker courant (terminaux PTY ``_terminals``, dict
    par-process). Sans ce cleanup, chaque worker accumulerait indefiniment ses
    propres bash + master_fd -> fuite RAM/fd.

    Le nom est conserve car ``server.app`` (lifespan) et
    ``shared_infra.observability.routes_events`` (``/api/system-events``)
    l'appellent sous ce nom.

    Les tasks sont enregistrees dans ``_bg_tasks`` pour que
    ``shutdown_bg_tasks()`` puisse les cancel proprement au demontage.
    """
    import asyncio as _aio
    try:
        loop = _aio.get_running_loop()
    except RuntimeError:
        return

    global _cron_scheduler_started
    if _cron_scheduler_started:
        return
    _cron_scheduler_started = True

    # Cleanup local : TOUJOURS demarre, sur chaque worker.
    _register_bg_task(loop.create_task(_local_cleanup_loop()))


# ── Background tasks tracking ─────────────────────────────────────────────────
# Toute task asyncio de type "background loop" (durée de vie = worker)
# doit être enregistrée ici pour être cancel proprement au shutdown.
# Sans ça :
#   - Python peut GC un task pending dont aucune ref n'est tenue, ce qui
#     lève RuntimeWarning et tue la loop silencieusement.
#   - Au shutdown, les loops continuent à tourner et empêchent la fermeture
#     propre (uvicorn attend ``graceful_timeout``, puis SIGKILL).
_bg_tasks: "set[asyncio.Task]" = set()


def _on_bg_task_done(task: "asyncio.Task") -> None:
    """Retire la task du registre ET journalise son exception éventuelle.

    ``task.exception()`` est consulté systématiquement : un callback qui ne
    ferait que ``discard`` laisserait une boucle de fond morte (tailer
    cancel_bus, sampler métriques, poller modèles…) disparaître sans la
    moindre trace applicative — seule la dégradation silencieuse (Stop qui
    ne marche plus, dashboard figé) trahirait l'incident, parfois des jours
    plus tard.
    """
    _bg_tasks.discard(task)
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except Exception:
        return
    if exc is not None:
        logger.error(
            "[bg-task] la tâche de fond %r est morte sur une exception",
            task.get_name(), exc_info=exc,
        )


def _register_bg_task(task: "asyncio.Task") -> None:
    """Enregistre une task background avec auto-cleanup à la fin."""
    _bg_tasks.add(task)
    task.add_done_callback(_on_bg_task_done)


async def shutdown_bg_tasks() -> int:
    """Cancel toutes les background tasks enregistrées et attend leur fin.

    Appelée depuis le lifespan shutdown de l'app. Retourne le nombre de
    tasks cancellées.
    """
    if not _bg_tasks:
        return 0
    pending = [t for t in _bg_tasks if not t.done()]
    for t in pending:
        t.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    n = len(pending)
    _bg_tasks.clear()
    return n


async def _local_cleanup_loop():
    """Cleanup des ressources propres au worker courant.

    Doit tourner sur CHAQUE worker, pas uniquement sur le lock-holder,
    car ``_terminals`` est un dict module-level par process — il n'est
    pas visible depuis les autres workers.
    """
    import asyncio as _aio
    from datetime import datetime as _dt
    last_run_min = -1
    while True:
        try:
            await _aio.sleep(60)  # granularité 1 min
            minute = _dt.now().minute
            if minute == last_run_min:
                continue
            last_run_min = minute
            # Toutes les 5 min
            if minute % 5 != 0:
                continue
            try:
                # Local import: ``shared_infra.terminal.pty`` may import
                # shared helpers; importing inside the loop body avoids any
                # import cycle at this module's load time.
                from shared_infra.terminal.pty import _cleanup_idle_terminals
                _cleanup_idle_terminals()
            except Exception as e:
                logger.warning(f"[CLEANUP] _cleanup_idle_terminals: {e}")
        except _aio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"[CLEANUP] loop error: {e}")

async def apply_session_revocation(payload: dict) -> None:
    """Applique localement (sur CE worker) une révocation de session.

    Les endpoints de révocation admin publient un event
    ``{"type": "session_revoked", "uid": N|null}`` sur le bus fichier
    inter-workers ; chaque tailer appelle ce helper, qui ferme les flux
    et tue les PTY de l'utilisateur visé (``uid=None`` = tous). Un simple
    timestamp de révocation ne suffit pas : les requêtes HTTP tombent en
    401, mais les flux DÉJÀ ouverts (SSE système — firehose de logs staff
    compris —, SSE pipeline, shell WebSocket) resteraient vivants sans
    limite.
    Idempotent : re-l'appliquer sur un worker sans flux concerné est un no-op.
    """
    raw_uid = payload.get("uid")
    try:
        uid = int(raw_uid) if raw_uid is not None else None
    except (TypeError, ValueError):
        logger.warning("[session_revoked] uid invalide dans le payload: %r", raw_uid)
        return
    _expired = {"type": "session_expired"}
    n_sys = system_events.disconnect_user(uid, message=_expired)
    try:
        if uid is not None:
            n_pipe = pipeline_events.disconnect_user(uid, message=_expired)
        else:
            n_pipe = pipeline_events.disconnect_all(message=_expired)
    except Exception:
        n_pipe = 0
    try:
        # Import local : _pty importe des helpers partagés, on évite le
        # cycle au chargement du module (même motif que _local_cleanup_loop).
        from shared_infra.terminal.pty import kill_user_terminals, shutdown_all_terminals
        if uid is not None:
            n_pty = kill_user_terminals(uid)
        else:
            shutdown_all_terminals()
            n_pty = -1
    except Exception:
        logger.exception("[session_revoked] fermeture des terminaux échouée")
        n_pty = 0
    if n_sys or n_pipe or n_pty:
        logger.info(
            "[session_revoked] uid=%s : %d flux système, %d flux pipeline, %s PTY fermés (pid=%d)",
            uid if uid is not None else "ALL", n_sys, n_pipe,
            "tous" if n_pty == -1 else n_pty, os.getpid(),
        )


class SSELogHandler(logging.Handler):
    """Alimente l'historique legacy (``_log_history``, champ ``logs`` de
    GET /api/admin/logs/recent) — et rien d'autre.

    Le relais LIVE des logs vers la console staff ne passe pas par ici : il
    suit le journal JSONL unifié (``_staff_log_tail_loop``), que TOUS les
    process alimentent via ``FileEventHandler``. Ne pas diffuser depuis ce
    handler : il ne voit que les lignes du SEUL worker courant (la console
    d'un admin branché sur le worker 2 ne verrait jamais les logs du worker
    1, ni ceux du service admin), créerait une Task par ligne, et perdrait
    les lignes émises depuis un thread."""

    def emit(self, record):
        try:
            msg = self.format(record)
        except Exception:
            return
        with swallow("events.emit"):
            system_events._log_history.append({
                "id":      time.time(),
                "message": msg,
                "level":   record.levelname,
            })


# ── Flux live des journaux pour le staff ─────────────────────────────────────
# Une boucle par worker, vivante tant qu'au moins un client STAFF est branché
# sur ce worker : elle suit ``user_db/logs/app.log.jsonl`` (journal commun à
# tous les workers ET au service admin, tourné par renommage en ``.1``) et
# pousse chaque ligne « live » aux clients staff. Sans client staff, elle
# s'arrête — un nouveau client repart de la fin (l'historique se charge en
# HTTP, cf. GET /api/admin/logs/recent).
_STAFF_LOG_POLL_SEC = 0.25
_staff_log_task: Optional[asyncio.Task] = None


def _has_staff_client() -> bool:
    return any(m.get("staff") for m in list(system_events.clients.values()))


def _ensure_staff_log_tail() -> None:
    global _staff_log_task
    if _staff_log_task is not None and not _staff_log_task.done():
        return
    try:
        _staff_log_task = asyncio.get_running_loop().create_task(_staff_log_tail_loop())
        _register_bg_task(_staff_log_task)
    except RuntimeError:
        _staff_log_task = None


def _log_record_to_event(rec: dict) -> Optional[dict]:
    """Ligne du journal JSONL → event SSE ``log`` (forme attendue par la
    console staff : ``message``, ``level``, ``category``…)."""
    if not rec.get("live", True):
        return None          # lignes forensiques (HTTP 2xx…) : fichier seulement
    return {
        "type":     "log",
        "message":  f"[{rec.get('service', '?')}/{rec.get('category', '?')}] "
                    f"{rec.get('message', '')}",
        "level":    rec.get("level", "INFO"),
        "category": rec.get("category"),
        "service":  rec.get("service"),
        "ts":       rec.get("ts"),
    }


async def _staff_log_tail_loop() -> None:
    from shared_infra.observability.access_logging import _log_path
    tail = FileTail(FileBus(_log_path()), check_safe=False)
    await asyncio.to_thread(tail.skip_to_end)
    while _has_staff_client():
        await asyncio.sleep(_STAFF_LOG_POLL_SEC)
        if not tail.has_new():
            continue
        try:
            records = await asyncio.to_thread(tail.read_new)
        except Exception as exc:
            logger.debug("[staff_logs] lecture impossible : %r", exc)
            continue
        for rec in records:
            ev = _log_record_to_event(rec)
            if ev is not None:
                with swallow("events.staff_logs"):
                    await system_events._fanout(ev)


sse_handler = SSELogHandler()
sse_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s', datefmt='%H:%M:%S'))
logging.getLogger().addHandler(sse_handler)
logging.getLogger("uvicorn.error").addHandler(sse_handler)
logging.getLogger("uvicorn.access").addHandler(sse_handler)
