# SPDX-License-Identifier: MIT
"""
shared_infra.ops.maintenance — Passe d'entretien périodique (uptime longue durée).

Pourquoi ce module existe
=========================
L'application est conçue pour tourner DES MOIS sans redémarrage au sein d'une
équipe. Or l'entretien de la base (purge des télémétries + compactage du WAL
SQLite) n'était fait QU'AU DÉMARRAGE (``_run_startup_cleanup`` dans
``shared_infra/db/_legacy.py``, appelé par ``init_db``). Sur un serveur qui ne
reboote jamais, cela signifie :

  • ``metric_events`` : rétention de 90 j jamais ré-appliquée après le boot ;
  • ``tool_call_metrics`` / ``editor_routine_runs`` : aucune purge du tout ;
  • fichier ``-wal`` SQLite : jamais re-checkpointé → grossit indéfiniment
    (le code de ``wal_checkpoint`` l'avertit lui-même).

Ce service de fond corrige la cause racine : une passe quotidienne exécutée sur
le SEUL worker leader (élection ``cron_lock`` réutilisée), résiliente (la boucle
survit à toute exception, même pattern que ``routines_scheduler``), et démarrée
inconditionnellement dans le lifespan — donc indépendante de l'état de la
feature Routines.

La passe enchaîne : purges des trois tables (rétentions configurables, cf.
``shared_infra/config.py``) → ``wal_checkpoint(TRUNCATE)`` EN DERNIER (fusionne
les DELETE dans le .db et remet le -wal à zéro) → digest quotidien d'usage IA
(best-effort, cf. ``shared_infra/observability/metrics/daily_report.py``).
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from shared_infra.scheduling.cron_lock import try_acquire_cron_lock

logger = logging.getLogger("uvicorn.error")

# Re-vérifie 2×/h si la fenêtre quotidienne (heure ≥ MAINTENANCE_HOUR) est
# atteinte. Granularité largement suffisante pour un job journalier ; coût nul.
TICK_SECONDS = 1800

_scheduler_started = False
# Date "YYYY-MM-DD" du dernier passage effectué sur CE worker — garde-fou
# anti-double-exécution dans la même journée.
_last_run_date: Optional[str] = None


def run_maintenance_once() -> Dict[str, int]:
    """Exécute la passe d'entretien (SYNC, idempotente, best-effort — ne lève jamais).

    Extrait de la boucle pour être testable directement. Retourne un dict des
    nombres de lignes purgées par table (utile au log et aux tests).
    """
    from shared_infra.config import (
        DAILY_REPORT_RETENTION_DAYS,
        METRICS_RETENTION_DAYS,
        ROUTINE_RUNS_RETENTION_DAYS,
        TOOL_METRICS_RETENTION_DAYS,
        USAGE_EVENTS_RETENTION_DAYS,
    )
    from shared_infra.db._connection import purge_old_metrics, wal_checkpoint
    from shared_infra.observability.tool_metrics_store import purge_tool_call_metrics
    from shared_infra.observability.daily_reports_store import purge_daily_reports
    from shared_infra.scheduling.routines_store import purge_routine_runs, purge_webhook_deliveries
    from shared_infra.observability.usage_store import purge_usage_events

    out: Dict[str, int] = {"metric_events": 0, "usage_events": 0,
                           "tool_call_metrics": 0,
                           "routine_runs": 0, "daily_reports": 0,
                           "webhook_deliveries": 0, "session_messages": 0}
    # ⚠ ``purge_old_metrics`` ne se garde PAS contre retention_days<=0 (cutoff=now
    # → supprimerait TOUT). On ne l'appelle donc que si la rétention est > 0.
    if METRICS_RETENTION_DAYS > 0:
        try:
            out["metric_events"] = purge_old_metrics(METRICS_RETENTION_DAYS)
        except Exception:
            logger.debug("[maintenance] purge_old_metrics failed", exc_info=True)
    # ``purge_usage_events`` se garde elle-même contre <=0 (no-op).
    out["usage_events"] = purge_usage_events(USAGE_EVENTS_RETENTION_DAYS)
    try:
        out["tool_call_metrics"] = purge_tool_call_metrics(TOOL_METRICS_RETENTION_DAYS)
    except Exception:
        logger.debug("[maintenance] purge_tool_call_metrics failed", exc_info=True)
    try:
        out["routine_runs"] = purge_routine_runs(ROUTINE_RUNS_RETENTION_DAYS)
    except Exception:
        logger.debug("[maintenance] purge_routine_runs failed", exc_info=True)
    try:
        # Dédup webhook : la purge au fil de l'eau ne tourne que sur livraison —
        # sans ce filet, la table restait figée quand les livraisons cessent.
        out["webhook_deliveries"] = purge_webhook_deliveries()
    except Exception:
        logger.debug("[maintenance] purge_webhook_deliveries failed", exc_info=True)
    try:
        out["daily_reports"] = purge_daily_reports(DAILY_REPORT_RETENTION_DAYS)
    except Exception:
        logger.debug("[maintenance] purge_daily_reports failed", exc_info=True)
    try:
        # session_messages + miroir FTS5 (passe 3 2026-08-31) : dernière table
        # à croissance non bornée — cf. purge_session_messages.
        from shared_infra.config import SESSION_MESSAGES_RETENTION_DAYS
        from shared_infra.memory.store import purge_session_messages
        out["session_messages"] = purge_session_messages(
            SESSION_MESSAGES_RETENTION_DAYS)
    except Exception:
        logger.debug("[maintenance] purge_session_messages failed", exc_info=True)
    try:
        # Ancres du ciblage desktop : bornées par âge (TTL) puis par taille.
        from shared_infra.desktop.anchors import prune_action_cache
        out["action_cache"] = prune_action_cache()
    except Exception:
        logger.debug("[maintenance] prune_action_cache failed", exc_info=True)
    # AUDIT 2026-08-02 (m10) — purge des fichiers-verrous périmés. En régime
    # normal, /tmp/elpis_chat_locks n'était nettoyé qu'au-delà de 200 entrées
    # ET >24 h, et les sentinelles flock des outils fs JAMAIS : inodes qui
    # s'accumulent (un par (kind,user,chat) et par chemin écrit) et iterdir()
    # qui ralentit. Suppression sûre : on ne retire un .lock que si son flock
    # est LIBRE (acquis en non-bloquant l'instant du unlink) — un détenteur
    # actif garde son fd, on ne casse jamais un verrou tenu.
    #
    # ⚠ Sweeps FS sautés sous pytest (« "pytest" in sys.modules », même
    # convention que rag_app) : ils toucheraient les VRAIS /tmp/elpis_* et
    # user_sandboxes/ depuis un test — hermétisme d'abord.
    import sys as _sys
    if "pytest" not in _sys.modules:
        try:
            out["stale_locks"] = _sweep_stale_lock_files()
        except Exception:
            logger.debug("[maintenance] sweep_stale_lock_files failed", exc_info=True)
        # AUDIT 2026-08-02 (W11) — purge des uploads chunkés interrompus : un
        # ``.part`` orphelin (worker recyclé en plein upload) restait à vie
        # dans la sandbox, comptait dans le quota et polluait l'explorateur
        # (« quota dépassé » sans fichier visible). >24 h = abandonné.
        try:
            out["orphan_parts"] = _sweep_orphan_part_files()
        except Exception:
            logger.debug("[maintenance] sweep_orphan_part_files failed", exc_info=True)
        # (2026-09-15) Cache des aperçus Office/PDF de l'éditeur : TTL, plafonds
        # par utilisateur et global, verrous de conversion libres et anciens.
        try:
            from shared_infra.sandbox.office_preview import prune_all as _prune_office
            out["office_cache"] = _prune_office()
        except Exception:
            logger.debug("[maintenance] office cache prune failed", exc_info=True)
    # Checkpoint WAL EN DERNIER : fusionne les DELETE ci-dessus dans le .db et
    # compacte le fichier -wal (sinon il gonfle indéfiniment sans reboot).
    try:
        wal_checkpoint()
    except Exception:
        logger.debug("[maintenance] wal_checkpoint failed", exc_info=True)
    # Trace persistante de la passe : ``_last_run_date`` est une variable de
    # process, donc invisible aux autres workers ET perdue au redémarrage —
    # un opérateur n'avait aucun moyen de savoir si l'entretien tournait
    # encore. Une ligne en base, elle, se lit depuis n'importe quel worker.
    try:
        from shared_infra.db import log_metric
        log_metric("maintenance_pass", 1, {k: int(v) for k, v in out.items()})
    except Exception:
        logger.debug("[maintenance] marqueur de passe non journalisé", exc_info=True)
    logger.info("[maintenance] passe quotidienne : %s", out)
    return out


def _sweep_stale_lock_files(max_age_s: float = 24 * 3600.0) -> int:
    """Supprime les fichiers-verrous plus vieux que ``max_age_s`` dont le
    flock est libre (audit 2026-08-02, m10). Retourne le nombre supprimés."""
    import fcntl
    import time as _t

    dirs = []
    try:
        from shared_infra.runtime.chat_locks import LOCK_DIR
        dirs.append(Path(LOCK_DIR))
    except Exception:
        pass
    try:
        from llm_core.tools import fs_tools as _fs
        if getattr(_fs, "_WRITE_LOCKS_BASE", None):
            dirs.append(Path(_fs._WRITE_LOCKS_BASE))
    except Exception:
        pass

    removed = 0
    cutoff = _t.time() - max_age_s
    for d in dirs:
        try:
            if not d.is_dir():
                continue
            for f in d.iterdir():
                try:
                    if not f.is_file() or f.stat().st_mtime > cutoff:
                        continue
                    fd = os.open(str(f), os.O_RDWR)
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except OSError:
                        os.close(fd)
                        continue          # verrou TENU : ne pas toucher
                    try:
                        # AUDIT 2026-08-02 (M2) — sous le flock, revérifier :
                        # (a) mtime toujours périmé (un acquire a pu estampiller
                        # le fichier entre notre stat initial et notre flock) ;
                        # (b) l'inode tenu est bien celui du chemin. Sinon un
                        # acquire concurrent repartirait sur un nouvel inode →
                        # deux détenteurs du même verrou logique.
                        st = f.stat()
                        if st.st_mtime <= cutoff and os.fstat(fd).st_ino == st.st_ino:
                            f.unlink(missing_ok=True)
                            removed += 1
                    except OSError:
                        pass
                    finally:
                        os.close(fd)      # relâche aussi le flock
                except Exception:
                    continue
        except Exception:
            continue
    return removed


def _sweep_orphan_part_files(max_age_s: float = 24 * 3600.0) -> int:
    """Supprime les tmp d'upload chunké abandonnés (audit 2026-08-02, W11 ;
    E4). Retourne le nombre supprimés.

    AUDIT 2026-08-02 (E4) — l'ancien filtre ``*.part`` sur ``SANDBOX_DIR``
    entier supprimait TOUT fichier ``.part`` utilisateur (partial de moteur de
    template, téléchargement Firefox/``aria2`` interrompu, ``split -b … out.part``)
    sans log ni corbeille. Les tmp d'upload portent désormais un suffixe dédié
    (``UPLOAD_TMP_SUFFIX``, cf. ``routes/sandbox_files.py``) qu'aucun fichier
    utilisateur ne porte, et le balayage est restreint aux dossiers ``work/``.
    """
    import time as _t
    try:
        from shared_infra.config import SANDBOX_DIR
        from shared_infra.sandbox.routes_files import UPLOAD_TMP_SUFFIX
        root = Path(SANDBOX_DIR)
    except Exception:
        return 0
    if not root.is_dir():
        return 0
    removed = 0
    cutoff = _t.time() - max_age_s
    try:
        for f in root.rglob("*" + UPLOAD_TMP_SUFFIX):
            try:
                if f.is_symlink() or not f.is_file():
                    continue          # jamais suivre un lien (cf. P0.3)
                # Défense en profondeur : ne balayer que sous ``<sandbox>/work/``
                # (jamais skills/, memory/, _snapshots/…).
                if "work" not in f.relative_to(root).parts:
                    continue
                if f.stat().st_mtime <= cutoff:
                    f.unlink(missing_ok=True)
                    removed += 1
            except Exception:
                continue
    except Exception:
        pass
    return removed


def _maybe_run_daily_digest() -> None:
    """Génère le digest quotidien d'usage IA (SYNC, best-effort).

    Tolérant si le module de rapport n'est pas (encore) présent — la maintenance
    DB ne doit jamais dépendre du digest."""
    # Lecture FRAÎCHE de config.json (``maintenance.daily_digest_enabled``) :
    # honore le toggle admin sans redémarrage. Désactivé → aucun rapport ni
    # notification quotidienne (les métriques admin suffisent).
    try:
        from shared_infra.config import read_config_json
        _m = (read_config_json() or {}).get("maintenance", {})
        enabled = bool(_m.get("daily_digest_enabled", True)) if isinstance(_m, dict) else True
    except Exception:
        return
    if not enabled:
        return
    try:
        from shared_infra.observability.metrics.daily_report import generate_and_store_daily_digest
    except Exception:
        logger.debug("[maintenance] module daily_report indisponible (skip digest)", exc_info=True)
        return
    try:
        generate_and_store_daily_digest()
    except Exception as e:
        logger.warning("[maintenance] digest quotidien non généré : %s", e)


async def _maintenance_loop() -> None:
    """Boucle de fond : une passe / jour à partir de MAINTENANCE_HOUR, leader-only.

    Résiliente : toute exception est logguée puis la boucle continue (un crash
    silencieux laisserait l'entretien aux abonnés absents jusqu'au prochain
    reboot — exactement ce qu'on veut éviter)."""
    global _last_run_date
    from shared_infra.config import MAINTENANCE_HOUR
    while True:
        try:
            await asyncio.sleep(TICK_SECONDS)
            # Leader-only : réutilise l'élection cron (idempotent si déjà leader).
            if not try_acquire_cron_lock():
                continue
            now = datetime.now()
            today = now.strftime("%Y-%m-%d")
            if _last_run_date == today:
                continue                      # déjà passé aujourd'hui
            if now.hour < MAINTENANCE_HOUR:
                continue                      # fenêtre quotidienne pas encore atteinte
            # On marque AVANT de travailler : évite un double-run si la passe
            # déborde sur deux ticks. Les opérations sont idempotentes de toute façon.
            _last_run_date = today
            await asyncio.to_thread(run_maintenance_once)
            await asyncio.to_thread(_maybe_run_daily_digest)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("[maintenance] erreur de boucle : %s", e)


def start_maintenance_scheduler() -> None:
    """Démarre la boucle d'entretien (idempotent par worker).

    Enregistrée via ``_register_bg_task`` → annulée proprement au shutdown du
    lifespan, comme les autres tâches de fond."""
    global _scheduler_started
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _scheduler_started:
        return
    _scheduler_started = True
    from shared_infra.config import MAINTENANCE_HOUR
    from shared_infra.observability.events_bus import _register_bg_task
    _register_bg_task(loop.create_task(_maintenance_loop()))
    logger.info("[maintenance] scheduler d'entretien démarré (heure quotidienne=%dh).",
                MAINTENANCE_HOUR)
