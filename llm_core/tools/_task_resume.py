# SPDX-License-Identifier: MIT
"""llm_core.tools._task_resume — persistance CROSS-WORKER du travail partiel
d'un sous-agent (reprise par ``task_id``).

Pourquoi ce module
------------------
Quand un enfant est interrompu (timeout, échec, ✕ ciblé, Stop parent), le
handler lui garde son historique et rend au modèle un ``task_id`` avec la
consigne explicite « pass task_id to resume this agent from its partial work ».

Le store d'origine (``task_tool._RESUME_STORE``) est un ``OrderedDict``
module-level, donc PAR PROCESS. Or l'app tourne sous gunicorn multi-worker
(``server/gunicorn_conf.py``) et le tour suivant — celui qui rejoue le
``task_id`` — est une NOUVELLE requête HTTP, distribuée sans affinité. Résultat
avant ce module : la reprise marchait dans le tour courant, puis répondait
``unknown_task_id`` d'un tour à l'autre (N-1)/N du temps. Le modèle se voyait
donc proposer une reprise… puis annoncer que l'agent n'a jamais existé.

Fonctionnement
--------------
Un fichier JSON par (username, child_id) sous ``/tmp``, écrit atomiquement
(tmp + ``os.replace``) en 0600. Le TTL et le cap d'entrées répliquent la
sémantique mémoire (``TASK_RESUME_TTL_S`` / ``TASK_RESUME_MAX``), l'éviction se
faisant sur la mtime. ``task_tool`` garde son dictionnaire en cache L1 : le
disque n'est relu que sur défaut de cache, ou quand sa version (``peek_ts``,
un ``stat``) est plus récente que celle du L1 — reprise faite entre-temps par
un autre worker.

Bornes et modes de défaillance
------------------------------
  * un enregistrement au-delà de ``_MAX_BYTES`` n'est PAS écrit sur disque
    (un historique d'enfant peut peser des Mo) : la reprise reste alors
    possible sur le worker d'origine, comme avant. Journalisé.
  * ``/tmp`` plein ou non inscriptible → toutes les fonctions dégradent en
    silence vers « pas de store partagé » (comportement d'avant ce module).
    Jamais d'exception : on est sur le chemin de sortie d'un outil.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Racine commune (cf. shared_infra.runtime.runtime_dir) ; ``ELPIS_TASK_RESUME_DIR``
# reste prioritaire.
from shared_infra.runtime.runtime_dir import runtime_path as _runtime_path  # noqa: E402

STORE_DIR = _runtime_path("task_resume", "ELPIS_TASK_RESUME_DIR",
                          "/tmp/elpis_task_resume")

# Un historique d'enfant peut être volumineux ; au-delà on reste en mémoire.
_MAX_BYTES = 8 * 1024 * 1024

_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]")


def _path(username: str, child_id: str) -> Path:
    """``username`` est haché (charset libre), ``child_id`` assaini — il est
    généré par nous (``t{n}-{hex}``) mais peut arriver du modèle sur une
    reprise, donc jamais concaténé tel quel dans un chemin."""
    h = hashlib.sha256(str(username).encode("utf-8")).hexdigest()[:16]
    safe_child = _SAFE_RE.sub("_", str(child_id))[:64] or "_"
    return STORE_DIR / f"{h}-{safe_child}.json"


def _ensure_dir() -> bool:
    try:
        STORE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("[task_resume] %s inutilisable (%r) — reprise locale seule",
                       STORE_DIR, exc)
        return False
    try:
        os.chmod(STORE_DIR, 0o700)
    except OSError:
        pass
    return True


def put(username: str, child_id: str, record: Dict[str, Any]) -> bool:
    """Persiste un enregistrement de reprise. ``True`` si écrit sur disque."""
    if not _ensure_dir():
        return False
    try:
        blob = json.dumps(record, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        logger.warning("[task_resume] enregistrement non sérialisable (%r)", exc)
        return False
    if len(blob) > _MAX_BYTES:
        logger.info("[task_resume] %s/%s : %d octets > plafond — reprise "
                    "limitée au worker d'origine", username, child_id, len(blob))
        return False
    p = _path(username, child_id)
    tmp = p.with_suffix(".tmp")
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, blob)
        finally:
            os.close(fd)
        os.replace(str(tmp), str(p))          # atomique : jamais de JSON tronqué lu
        # AUDIT 2026-09-24 — mtime CALÉE sur le ``ts`` du record : ``peek_ts``
        # expose ainsi la version du disque pour le prix d'un ``stat`` (le
        # cache L1 d'un worker la compare à la sienne), et le TTL de ``prune``
        # (sur mtime) reste celui du record.
        _ts = record.get("ts")
        if isinstance(_ts, (int, float)) and _ts > 0:
            try:
                _ns = int(float(_ts) * 1e9)
                os.utime(str(p), ns=(_ns, _ns))
            except OSError:
                pass
        return True
    except OSError as exc:
        logger.warning("[task_resume] écriture %s échouée (%r)", p, exc)
        try:
            tmp.unlink()
        except OSError:
            pass
        return False


def get(username: str, child_id: str, ttl_s: float) -> Optional[Dict[str, Any]]:
    """Relit un enregistrement non périmé, ou ``None``. Un fichier expiré ou
    illisible est retiré au passage."""
    p = _path(username, child_id)
    try:
        raw = p.read_bytes()
    except OSError:
        return None
    try:
        rec = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        try:
            p.unlink()
        except OSError:
            pass
        return None
    if not isinstance(rec, dict):
        return None
    if time.time() - float(rec.get("ts") or 0) > float(ttl_s):
        try:
            p.unlink()
        except OSError:
            pass
        return None
    return rec


def peek_ts(username: str, child_id: str) -> Optional[float]:
    """Horodatage (``ts``) de l'enregistrement sur disque, SANS le relire :
    la mtime, que ``put`` cale sur ``ts``. ``None`` si absent/illisible.
    Sert au cache L1 de ``task_tool`` à détecter qu'un autre worker a écrit
    une version plus récente (reprise faite ailleurs entre-temps)."""
    try:
        return _path(username, child_id).stat().st_mtime_ns / 1e9
    except OSError:
        return None


def prune(ttl_s: float, max_entries: int, now: Optional[float] = None) -> None:
    """TTL puis cap d'entrées (les plus anciennes par mtime partent d'abord).
    Best-effort : ce n'est qu'un ramasse-miettes."""
    now = now if now is not None else time.time()
    try:
        entries = [p for p in STORE_DIR.iterdir() if p.suffix == ".json"]
    except OSError:
        return
    survivors = []
    for p in entries:
        try:
            st = p.stat()
        except OSError:
            continue
        if now - st.st_mtime > float(ttl_s):
            try:
                p.unlink()
            except OSError:
                pass
            continue
        survivors.append((st.st_mtime, p))
    if max_entries > 0 and len(survivors) > max_entries:
        survivors.sort()
        for _mt, p in survivors[:len(survivors) - max_entries]:
            try:
                p.unlink()
            except OSError:
                pass


__all__ = ["STORE_DIR", "put", "get", "peek_ts", "prune"]
