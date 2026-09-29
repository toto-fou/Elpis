# SPDX-License-Identifier: MIT
"""shared_infra.observability.metrics.process_sampler — Échantillonnage per-process persisté.

Pourquoi
--------
``BackgroundMonitor`` (metrics/engine.py) échantillonne le système global +
quelques signaux per-process, mais dans un thread SANS event-loop et dans un
``deque`` VOLATILE (perdu à chaque restart). Or le redémarrage hebdomadaire de
l'app vient d'une dégradation lente qu'on ne peut diagnostiquer qu'en observant
une tendance sur PLUSIEURS JOURS — donc persistée — et qui inclut des compteurs
APPLICATIFS (tasks asyncio, terminaux PTY, clients SSE…) qui ne sont lisibles
que depuis l'event-loop du worker.

Ce module ajoute un **sampler asyncio par worker** qui, toutes les
``SAMPLE_INTERVAL_SECONDS``, lit une poignée de compteurs O(1) et les persiste
via ``log_metric`` (table ``metric_events``, taguée par PID). Les providers
``proc_*`` du dashboard (engine.py) tracent ensuite la tendance 7 jours.

Robustesse (impératif — ce module EST une rustine anti-instabilité) :
  • la boucle ne meurt jamais sur une exception transitoire (``except
    Exception`` qui continue) — seul ``CancelledError`` la stoppe au shutdown ;
  • chaque accesseur est isolé : si l'un lève, les autres sont quand même
    échantillonnés (un compteur manquant ne doit pas masquer les autres) ;
  • imports tardifs à l'intérieur des accesseurs → aucun cycle au chargement
    (le pattern utilisé partout dans ce codebase).

Démarré depuis le lifespan de l'app (server/app.py), sur CHAQUE worker, juste
après ``start_routines_scheduler``. Enregistré via ``_register_bg_task`` pour un
cancel propre au shutdown.
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Dict, List, Tuple

from shared_infra.db._dialect import json_get_param_num

logger = logging.getLogger("uvicorn.error")

SAMPLE_INTERVAL_SECONDS = 300  # 5 min — tendance lente, pas de la télémétrie temps réel

_sampler_started = False

# psutil : déjà une dépendance (metrics/engine.py). Handle créé paresseusement.
try:
    import psutil
    _PROC = psutil.Process(os.getpid())
except Exception:  # pragma: no cover - psutil absent / process teardown
    _PROC = None


# ─────────────────────────────────────────────────────────────────────────────
#  Accesseurs — chacun renvoie un float, lève si la source est indisponible.
#  Imports tardifs : on lit l'état VIVANT du worker, sans cycle d'import.
# ─────────────────────────────────────────────────────────────────────────────
def _c_active_chat_tasks() -> float:
    from shared_infra.routes._state import _active_chat_tasks
    return float(len(_active_chat_tasks))


def _c_pty_terminals() -> float:
    from shared_infra.terminal.pty import _terminals
    return float(len(_terminals))


def _c_sse_clients() -> float:
    from shared_infra.observability.events_bus import pipeline_events, system_events
    n = len(getattr(system_events, "clients", ()) or ())
    # pipeline_events.clients : dict[user_id -> set[Queue]]
    pe = getattr(pipeline_events, "clients", None)
    if isinstance(pe, dict):
        n += sum(len(s or ()) for s in pe.values())
    return float(n)


def _c_bg_tasks() -> float:
    from shared_infra.observability.events_bus import _bg_tasks
    return float(len(_bg_tasks))


def _c_routine_tasks() -> float:
    from shared_infra.scheduling.routines_scheduler import _running_tasks
    return float(len(_running_tasks))


def _c_rss_mb() -> float:
    if _PROC is None:
        raise RuntimeError("psutil indisponible")
    return round(_PROC.memory_info().rss / (1024 * 1024), 1)


def _c_num_fds() -> float:
    if _PROC is None:
        raise RuntimeError("psutil indisponible")
    return float(_PROC.num_fds())  # POSIX-only


def _c_num_threads() -> float:
    if _PROC is None:
        raise RuntimeError("psutil indisponible")
    return float(_PROC.num_threads())


def _c_sqlite_wal_mb() -> float:
    from shared_infra.config import DB_PATH
    wal = str(DB_PATH) + "-wal"
    if not os.path.exists(wal):
        return 0.0
    return round(os.path.getsize(wal) / (1024 * 1024), 2)


def _c_scheduler_alive() -> float:
    """1 si ce worker est le leader cron ET que sa boucle a tické récemment.
    En multi-worker, seul le leader renvoie 1 ; les autres renvoient 0
    (normal). Un leader dont la boucle est silencieusement morte renverra 0
    → visible dans la tendance (le seul scénario « routines mortes jusqu'au
    restart » restant)."""
    from shared_infra.scheduling.routines_scheduler import scheduler_alive
    return 1.0 if scheduler_alive() else 0.0


# (event_type, accesseur) — l'ordre est cosmétique.
_SAMPLES: List[Tuple[str, Callable[[], float]]] = [
    ("proc_active_chat_tasks", _c_active_chat_tasks),
    ("proc_pty_terminals",     _c_pty_terminals),
    ("proc_sse_clients",       _c_sse_clients),
    ("proc_bg_tasks",          _c_bg_tasks),
    ("proc_routine_tasks",     _c_routine_tasks),
    ("proc_rss_mb",            _c_rss_mb),
    ("proc_num_fds",           _c_num_fds),
    ("proc_num_threads",       _c_num_threads),
    ("proc_sqlite_wal_mb",     _c_sqlite_wal_mb),
    ("proc_scheduler_alive",   _c_scheduler_alive),
]


# Nom d'événement du format GROUPÉ : une ligne par échantillon, les dix jauges
# dans ``tags_json``. Cf. :func:`sample_once` pour le pourquoi.
PROC_SAMPLE_EVENT = "proc_sample"


def sample_once() -> Dict[str, float]:
    """Échantillonne tous les compteurs et les persiste en UNE ligne.

    Historiquement, cette fonction appelait ``log_metric`` DIX fois — une par
    compteur — soit dix connexions SQLite, dix INSERT et vingt mises à jour
    d'index toutes les 5 minutes et par worker. Sur la base observée, ces dix
    séries pesaient 74 160 lignes sur 145 751, soit **51 % de metric_events**,
    la table et ses index représentant à eux seuls la moitié du fichier. Le
    gaspillage était surtout dans l'index : ``event_type`` est un TEXT recopié
    intégralement pour CHAQUE ligne.

    On écrit donc une seule ligne ``proc_sample`` portant les dix jauges dans
    ``tags_json``. Même information, dix fois moins de lignes et d'écritures.

    Best-effort par compteur : un accesseur qui lève est simplement absent des
    tags (les autres sont quand même persistés). Retourne le dict
    {nom: valeur} des compteurs effectivement collectés (utile pour les tests).
    """
    from shared_infra.db import log_metric

    collected: Dict[str, float] = {}
    for name, accessor in _SAMPLES:
        try:
            collected[name] = float(accessor())
        except Exception as e:
            logger.debug("[PROC_SAMPLER] %s indisponible : %s", name, e)

    if not collected:
        return collected
    try:
        log_metric(PROC_SAMPLE_EVENT, 1.0, tags={"pid": os.getpid(), **collected})
    except Exception as e:
        # log_metric est déjà best-effort en interne ; double garde.
        logger.debug("[PROC_SAMPLER] log_metric %s échoué : %s",
                     PROC_SAMPLE_EVENT, e)
    return collected


# ─────────────────────────────────────────────────────────────────────────────
#  Lecture — compatible avec les deux formats
# ─────────────────────────────────────────────────────────────────────────────
# Les lignes de l'ANCIEN format (un event_type par jauge) restent en base
# jusqu'au bout de la rétention (90 j par défaut). Les lecteurs doivent donc
# voir les deux, sans quoi les courbes du dashboard se couperaient net à la
# date de déploiement. Les deux helpers ci-dessous sont l'unique endroit qui
# connaît cette dualité ; ils pourront être simplifiés une fois la fenêtre de
# rétention écoulée.

def gauge_union_sql(select_expr: str) -> str:
    """Sous-requête ``(created_at, v)`` unifiant ancien et nouveau format.

    ``select_expr`` est projeté sur ``created_at``. Deux paramètres attendus,
    dans l'ordre : le nom de la jauge (deux fois) puis la borne temporelle
    (deux fois) — cf. :func:`gauge_union_params`.
    """
    return f"""
        SELECT {select_expr} AS h, created_at AS ts, value AS v
          FROM metric_events WHERE event_type=? AND created_at>?
        UNION ALL
        SELECT {select_expr} AS h, created_at AS ts,
               {json_get_param_num('tags_json')} AS v
          FROM metric_events WHERE event_type='{PROC_SAMPLE_EVENT}' AND created_at>?
    """


def gauge_union_params(gauge: str, since: float) -> tuple:
    return (gauge, since, gauge, since)


def last_heartbeat_at(conn, gauge: str = "proc_scheduler_alive") -> float:
    """Date du dernier échantillon où ``gauge`` était non nul. 0.0 si jamais."""
    row = conn.execute(
        f"""SELECT MAX(ts) FROM (
              SELECT created_at AS ts FROM metric_events
                WHERE event_type=? AND value>0
              UNION ALL
              SELECT created_at AS ts FROM metric_events
                WHERE event_type='{PROC_SAMPLE_EVENT}'
                  AND {json_get_param_num('tags_json')} > 0
            ) AS t""",
        (gauge, gauge),
    ).fetchone()
    return float(row[0]) if row and row[0] else 0.0


async def _sampler_loop() -> None:
    import asyncio as _aio
    while True:
        try:
            await _aio.sleep(SAMPLE_INTERVAL_SECONDS)
            await _aio.to_thread(sample_once)  # les accès DB/psutil sont bloquants
        except _aio.CancelledError:
            break
        except Exception as e:
            logger.warning("[PROC_SAMPLER] erreur de boucle : %s", e)


def start_process_sampler() -> None:
    """Démarre le sampler (idempotent par worker). Enregistré dans ``_bg_tasks``
    via ``_register_bg_task`` → cancel propre au shutdown.

    Même contrat que ``start_routines_scheduler`` / ``start_cron_scheduler`` :
    no-op s'il n'y a pas d'event-loop courante (appel hors lifespan)."""
    import asyncio as _aio

    global _sampler_started
    try:
        loop = _aio.get_running_loop()
    except RuntimeError:
        return
    if _sampler_started:
        return
    _sampler_started = True
    from shared_infra.observability.events_bus import _register_bg_task
    _register_bg_task(loop.create_task(_sampler_loop()))
    logger.info("[PROC_SAMPLER] démarré (intervalle=%ds, pid=%d)",
                SAMPLE_INTERVAL_SECONDS, os.getpid())
