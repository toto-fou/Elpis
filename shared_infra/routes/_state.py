# SPDX-License-Identifier: MIT
"""
backend.routes._state — Shared state and primitives for the routes package.

This module holds pieces of module-level state that are shared across several
route submodules (chat, pipelines, etc.). Consolidating them here breaks the
dependency cycles that would otherwise force submodules to import from each
other just to reach a common set or function.

Contains
--------
- ``router``: the single :class:`APIRouter` every submodule hangs endpoints on.
  Import it from here (``from backend.routes._state import router``) instead
  of creating a new one.
- Chat-cancellation state (``_cancelled_chats``, ``_active_chat_tasks``) and
  the helpers that manipulate it. These are consumed both by the
  ``/api/chat/cancel`` endpoint (chat submodule) and by long-running endpoints
  in other submodules (e.g. pipelines, saved-stream) that pass
  ``is_chat_cancelled`` as a callback into ``backend.services``.

Portée MULTI-WORKER
-------------------
Ces deux structures restent PAR PROCESS — c'est voulu : une ``asyncio.Task``
n'existe que dans son worker. Mais la requête de Stop n'atterrit presque jamais
sur le worker qui streame (gunicorn + ``reuse_port``, aucune affinité). La
demande est donc DIFFUSÉE aux autres process via ``shared_infra.runtime.cancel_bus``, et
chaque worker l'applique chez lui par ``apply_remote_cancellation`` : flag posé
partout, ``task.cancel()`` là où la task vit réellement.

Multi-tab semantics (BUG FIX élevé)
-----------------------------------
Both maps are keyed by ``(user_id, chat_id)`` rather than ``user_id`` alone.
Avant ce fix, un user qui ouvrait deux onglets et lançait deux générations :
  - L'enregistrement de Tab 2 dans ``_active_chat_tasks[uid]`` écrasait
    Tab 1 → la première task devenait orpheline (impossible à cancel via
    l'endpoint).
  - Un click sur "stop" sur Tab 1 mettait ``_cancelled_chats.add(uid)`` →
    cancellait aussi Tab 2 collateralement.
La clef composite isole les onglets. Pour les call-sites legacy qui ne
connaissent pas le ``chat_id``, des helpers ``mark_chat_cancelled_all_for_user``
et ``clear_all_chat_cancellations_for_user`` permettent une opération en
masse explicite (jamais utilisée par défaut).

Do NOT put domain logic here. Keep it small.
"""
from __future__ import annotations

import time as _time
from typing import Dict, Optional, Tuple, TYPE_CHECKING

from fastapi import APIRouter

if TYPE_CHECKING:
    import asyncio


# ═══════════════════════════════════════════════════════════════════
#  The single APIRouter for the whole package
# ═══════════════════════════════════════════════════════════════════
# Every submodule that defines endpoints does:
#     from backend.routes._state import router
#     @router.get("/api/something")
#     ...
# so that all decorated handlers end up on the same router, which
# ``app.py`` mounts once.
router = APIRouter()


# ═══════════════════════════════════════════════════════════════════
#  CHAT CANCELLATION — User-triggered stop mechanism
# ═══════════════════════════════════════════════════════════════════
# (user_id, chat_id) → timestamp de la demande d'annulation. Le worker
# services.py vérifie ce flag à chaque itération et à chaque tool call,
# et lève CancelledError dès qu'il est set. Le flag est automatiquement
# clear au démarrage de chaque nouvelle génération sur ce chat, et
# manuellement via POST /api/chat/cancel (qui inclut chat_id).
#
# Dict daté (pas un set) : la purge à l'unregister n'existe que sur le worker
# QUI HÉBERGE la task — sur les autres (récepteur du POST /stop + échos du
# bus), l'entrée restait à jamais. Les clés de run de routine étant UNIQUES
# (``routine:R:run:N``), le set croissait sans borne. Un flag est éphémère
# par nature (la génération visée meurt en secondes) : au-delà du TTL c'est
# un résidu, balayé opportunistement (cf. _sweep_cancel_flags).
_Key = Tuple[int, str]
_cancelled_chats: "Dict[_Key, float]" = {}
_CANCEL_FLAG_TTL_S = 3600.0
_CANCEL_FLAG_SWEEP_MIN = 256


def _sweep_cancel_flags() -> None:
    """Balayage opportuniste (appelé aux insertions) : borne la croissance sur
    les workers qui ne voient jamais l'unregister. Pas de reaper dédié."""
    if len(_cancelled_chats) <= _CANCEL_FLAG_SWEEP_MIN:
        return
    cutoff = _time.time() - _CANCEL_FLAG_TTL_S
    for _k in [k for k, ts in _cancelled_chats.items() if ts < cutoff]:
        _cancelled_chats.pop(_k, None)

# Mapping (user_id, chat_id) → asyncio.Task active.
# Deux onglets de la même conversation : impossible (le second tour
# attend que le premier finisse côté UI). Deux onglets sur deux chats
# différents : cohabitent grâce à la clef composite.
_active_chat_tasks: "Dict[_Key, asyncio.Task]" = {}

# Fds des verrous de PRÉSENCE cross-worker (shared_infra.runtime.chat_locks), un par
# clé tant qu'une génération tourne. Le registre ci-dessus est per-process :
# sans ce verrou, ``is_generation_active`` d'un AUTRE worker (garde 409 du
# /compact) ne voyait rien et laissait démarrer une compaction concurrente.
_activity_fds: "Dict[_Key, int]" = {}


# Dernier « clear » vu pour une clé (démarrage d'une nouvelle génération).
# Sert à écarter les échos PÉRIMÉS du bus : le worker qui reçoit le Stop
# applique l'annulation en direct ET l'écrit sur le bus ; sa propre ligne lui
# revient ~100 ms plus tard. Si entre-temps une NOUVELLE génération a démarré
# sur ce chat, ré-appliquer cette vieille demande la tuerait à la naissance.
_cleared_at: "Dict[_Key, float]" = {}
_CLEARED_MAX = 512


def _note_cleared(key: "_Key") -> None:
    """Date le reset d'une clé et borne le dictionnaire (pas de reaper)."""
    _cleared_at[key] = _time.time()
    if len(_cleared_at) > _CLEARED_MAX:
        for _k in sorted(_cleared_at, key=_cleared_at.get)[:len(_cleared_at) // 2]:
            _cleared_at.pop(_k, None)


def _publish_cancel(user_id: int, chat_id: str) -> None:
    """Diffuse la demande aux autres workers. Best-effort : une panne du bus
    ne doit jamais faire échouer un Stop (le worker local a déjà agi).

    AUDIT 2026-09-01 (passe 5, B12) — l'écriture prend un flock BLOQUANT sur
    un fichier partagé par N workers : appelée depuis la boucle (route
    ``api_chat_cancel`` → ``mark_chat_cancelled``), elle pouvait la geler le
    temps qu'un autre worker écrive. Sur la boucle → exécuteur (fire-and-
    forget : le retour n'est pas consommé ici et l'application est
    idempotente) ; hors boucle → appel direct."""
    try:
        from shared_infra.runtime.cancel_bus import publish_cancel
        import asyncio as _aio
        try:
            _loop = _aio.get_running_loop()
        except RuntimeError:
            _loop = None
        if _loop is not None:
            # (passe 7, R8) — thread ORDONNÉ (FIFO strict + échecs
            # journalisés), pas l'exécuteur multi-thread par défaut.
            from shared_infra.runtime.ordered_io import submit_ordered
            submit_ordered("cancel_bus.publish", publish_cancel, user_id, chat_id)
        else:
            publish_cancel(user_id, chat_id)
    except Exception:
        pass


def apply_remote_cancellation(user_id: int, chat_id: str, ts: float) -> None:
    """Applique une demande d'annulation reçue du bus (cf. cancel_bus).

    Appelée par le tailer de CHAQUE worker, y compris celui qui a émis la
    demande (idempotent). Deux gardes :
      • un écho antérieur au dernier démarrage de génération sur cette clé est
        ignoré — sinon le Stop du tour précédent tuerait le tour suivant ;
      • ``task.cancel()`` n'est tenté que si la task vit dans CE worker.
    """
    key = (int(user_id), _norm_chat_id(chat_id))
    if ts and _cleared_at.get(key, 0.0) >= ts:
        return
    _cancelled_chats[key] = _time.time()
    _sweep_cancel_flags()
    task = _active_chat_tasks.get(key)
    if task is not None and not task.done():
        task.cancel()


def _norm_chat_id(chat_id: Optional[str]) -> str:
    """Normalize chat_id for use as a key. ``None``/``""`` → ``"__none__"``
    so cancellation still works for chats not yet persisted (the very first
    user message of a new chat doesn't have an id yet — handler assigns one
    via secrets.token_hex BEFORE calling register_chat_task)."""
    return str(chat_id) if chat_id else "__none__"


def is_chat_cancelled(user_id: int, chat_id: Optional[str] = None) -> bool:
    """Appelée depuis services.py via une lambda. Retourne True si
    l'utilisateur a demandé l'annulation du chat passé en paramètre.

    ``chat_id=None`` reste accepté pour compatibilité (vérifie si N'IMPORTE
    QUELLE génération a été cancellée pour cet user) — mais le call-site
    moderne dans backend/routes/chats.py passe explicitement chat_id."""
    if chat_id is None:
        # Legacy path : True si au moins une (uid, *) est cancellée.
        return any(k[0] == user_id for k in _cancelled_chats)
    return (user_id, _norm_chat_id(chat_id)) in _cancelled_chats


def mark_chat_cancelled(user_id: int, chat_id: Optional[str] = None) -> None:
    """Marque le chat (uid, chat_id) comme à annuler. Sans chat_id, marque
    TOUTES les générations en cours pour cet user (utile pour logout).

    La demande est aussi DIFFUSÉE aux autres workers (cf.
    shared_infra/cancel_bus) : les registres ci-dessus sont par-process, et la
    requête de Stop n'atterrit presque jamais sur le worker qui streame. Le
    chemin inverse (appliquer une demande REÇUE du bus) est
    ``apply_remote_cancellation``, qui ne repasse pas par ici — sans quoi
    chaque worker ré-émettrait ce qu'il vient de recevoir.
    """
    if chat_id is None:
        for k in list(_active_chat_tasks.keys()):
            if k[0] == user_id:
                _cancelled_chats[k] = _time.time()
                _publish_cancel(k[0], k[1])
        _sweep_cancel_flags()
        return
    key = (user_id, _norm_chat_id(chat_id))
    _cancelled_chats[key] = _time.time()
    _sweep_cancel_flags()
    _publish_cancel(key[0], key[1])


def clear_chat_cancellation(user_id: int, chat_id: Optional[str] = None) -> None:
    """À appeler au démarrage d'une nouvelle génération pour reset."""
    if chat_id is None:
        for k in list(_cancelled_chats):
            if k[0] == user_id:
                _cancelled_chats.pop(k, None)
                _note_cleared(k)
        return
    key = (user_id, _norm_chat_id(chat_id))
    _cancelled_chats.pop(key, None)
    _note_cleared(key)


def register_chat_task(user_id: int, task: "asyncio.Task",
                       chat_id: Optional[str] = None,
                       presence_lock: bool = True,
                       presence_fd: "Optional[int]" = None) -> None:
    """Enregistre la task worker active pour ce (user, chat).

    Pose AUSSI un verrou de présence cross-worker : le registre ci-dessus est
    per-process, donc la garde 409 ``generation_running`` du /compact était
    aveugle dès que la génération vivait dans un autre worker gunicorn.

    Le verrou n'est pris qu'à la PREMIÈRE task de la clé et relâché au pop :
    sur une passation (édition + régénération sur le même chat, où l'ancien
    ``finally`` attend l'unwind pendant que la nouvelle s'enregistre), la
    présence reste continue au lieu de clignoter.
    """
    key = (user_id, _norm_chat_id(chat_id))
    _active_chat_tasks[key] = task
    # ``presence_lock=False`` : clés synthétiques (runs de routine) — la garde
    # 409 du /compact ne les concerne pas, et chaque clé unique créait un
    # fichier de verrou qui ne serait purgé qu'après 24 h.
    #
    # ``presence_fd`` (audit 2026-08-22, B1) : verrou DÉJÀ pris par l'appelant.
    # La route de flux doit le prendre dans son handler — seul endroit d'où un
    # 409 peut encore partir — puis nous le confier ; le ré-acquérir ici
    # échouerait forcément (on le tient déjà) et laisserait la clé sans fd,
    # donc sans libération à l'unregister.
    if presence_lock and key not in _activity_fds:
        fd = presence_fd
        if fd is None:
            try:
                from shared_infra.runtime import chat_locks
                fd = chat_locks.acquire("gen", user_id, chat_id)
            except Exception:                                   # noqa: BLE001
                fd = None
        if fd is not None:
            _activity_fds[key] = fd
    elif presence_fd is not None and _activity_fds.get(key) != presence_fd:
        # Passation : la clé a déjà un fd (l'ancien run n'a pas fini de se
        # désenregistrer). Le nôtre est en trop — le garder ouvert fuirait un
        # descripteur ET maintiendrait le verrou après notre propre fin.
        try:
            from shared_infra.runtime import chat_locks
            chat_locks.release(presence_fd)
        except Exception:                                       # noqa: BLE001
            pass


def unregister_chat_task(user_id: int, chat_id: Optional[str] = None,
                         task: "Optional[asyncio.Task]" = None) -> None:
    """Retire la task quand le worker termine (normal ou cancel).

    ``task`` (optionnel) : identité de la task qui se termine. RACE
    (edit + régénération sur le même chat) — le ``finally`` de l'ancien
    gen() attend l'unwind de son worker (``await wait_for(shield(task))``)
    AVANT d'appeler unregister ; pendant cet await, une NOUVELLE
    génération peut s'enregistrer sur la même clé (uid, chat_id). Sans le
    check d'identité, l'ancien finally pop la task de la nouvelle
    génération → le Stop suivant ne trouve plus de task à cancel
    (annulation dégradée au flag, latence) et le flag d'annulation de la
    nouvelle génération peut être effacé. ``task=None`` = pop
    inconditionnel (rétro-compat)."""
    key = (user_id, _norm_chat_id(chat_id))
    cur = _active_chat_tasks.get(key)
    if task is not None and cur is not None and cur is not task:
        # Une génération plus récente possède la clé — ne pas toucher son état.
        return
    _active_chat_tasks.pop(key, None)
    # Verrou de présence cross-worker : libéré ICI seulement (la garde
    # d'identité ci-dessus a déjà écarté le cas « une génération plus récente
    # possède la clé », qui doit garder la présence).
    try:
        from shared_infra.runtime import chat_locks
        chat_locks.release(_activity_fds.pop(key, None))
    except Exception:                                           # noqa: BLE001
        _activity_fds.pop(key, None)
    # BUG FIX (fuite lente) — purge aussi le flag d'annulation. Avant,
    # ``mark_chat_cancelled`` ajoutait ``(uid, cid)`` dans ``_cancelled_chats``
    # et SEUL ``clear_chat_cancellation`` — appelé au démarrage de la
    # PROCHAINE génération sur ce chat précis — le retirait. Un chat
    # « stoppé puis abandonné » (cas d'usage courant : on stoppe puis on
    # ouvre un nouveau chat) laissait l'entrée indéfiniment → croissance
    # non bornée du set, sans reaper. Le worker étant terminé ici, le flag
    # est devenu obsolète : on le retire.
    _cancelled_chats.pop(key, None)
    # …et on date ce retrait, pour qu'un écho tardif du bus (la demande de
    # Stop revient ~100 ms après son émission) ne ré-injecte pas le flag sur
    # une clé dont le worker est mort — ce serait exactement la fuite lente
    # décrite ci-dessus, réintroduite par le chemin cross-worker.
    _note_cleared(key)


def get_active_chat_task(user_id: int,
                         chat_id: Optional[str] = None) -> "Optional[asyncio.Task]":
    """Récupère la task active pour ce (user, chat), ou None.

    Si ``chat_id=None``, retourne n'importe quelle task active de l'user
    (legacy — préférer passer chat_id explicitement)."""
    if chat_id is not None:
        return _active_chat_tasks.get((user_id, _norm_chat_id(chat_id)))
    for k, t in _active_chat_tasks.items():
        if k[0] == user_id:
            return t
    return None


def active_run_count() -> int:
    """Travail LONG encore en vol sur CE worker (chat + routines + scénarios).

    AUDIT 2026-08-22 (A1/A2) — le drain de recyclage (``server/uvicorn_worker``)
    doit attendre la FIN NATURELLE des runs, pas la fin des connexions HTTP :
      • un run DÉTACHÉ n'a plus de connexion (uvicorn le croit terminé) ;
      • une mission de plusieurs heures dépasse tout ``timeout_graceful_shutdown``.
    Ce compteur est la mesure que le drain interroge. Il ne compte QUE les
    tâches vivantes de ce process (une task n'existe que dans son worker) —
    c'est exactement ce que ce worker doit finir avant de sortir.
    """
    n = 0
    for _t in list(_active_chat_tasks.values()):
        try:
            if not _t.done():
                n += 1
        except Exception:                                       # noqa: BLE001
            continue
    for _mod_path in ("shared_infra.scheduling.routines_scheduler",):
        try:
            import importlib as _importlib
            _mod = _importlib.import_module(_mod_path)
            for _t in list(getattr(_mod, "_running_tasks", {}).values()):
                if not _t.done():
                    n += 1
        except Exception:                                       # noqa: BLE001
            continue
    return n


def is_generation_active(user_id: int, chat_id: Optional[str] = None) -> bool:
    """Une génération tourne-t-elle pour ce (user, chat), DANS N'IMPORTE QUEL
    worker ?

    ``get_active_chat_task`` ne voit que CE process : sous gunicorn multi-worker
    (le cas nominal, cf. ``server/gunicorn_conf.py``), une génération sur un
    autre worker était invisible et les gardes 409 la laissaient piétiner — le
    tour finissait en conflit optimiste, donc NON persisté. On complète donc le
    registre local par le verrou de présence partagé.
    """
    if get_active_chat_task(user_id, chat_id) is not None:
        return True
    try:
        from shared_infra.runtime import chat_locks
        return chat_locks.is_held("gen", user_id, chat_id)
    except Exception:                                           # noqa: BLE001
        return False
