# SPDX-License-Identifier: MIT
"""rag_app.ocr.queue — file d'attente FIFO de reconnaissance (globale).

Un fonds documentaire réel se dépose par LOTS : la file enchaîne les
reconnaissances une à une (1 slot OCR), survit aux redémarrages (fichier
persisté, pas de registre RAM) et se reprend paresseusement — aucun leader :
le premier appel (GET /api/ocr/queue, enqueue, fin de job direct, lifespan)
relance la pompe si des éléments attendent.

Persistance : ``<ocr_root>/queue.json`` sous flock ``.queue.lock`` (patron
``store.update_meta``). Schéma::

    {
      "version": 1,
      "paused": false,
      "active": "20260722-...",        # doc en cours (retiré de items au pop)
      "items": [{"doc": id, "model": "", "enqueued_at": ts}],
      "batch": {"total": 4, "done": 2, "failed": 0, "canceled": 0,
                "started_at": ts},     # comptabilité du LOT courant
      "updated_at": ts
    }

``batch`` est ouvert/étendu à l'enqueue et soldé quand la file se vide —
c'est le déclencheur de la notice UNIQUE de fin de lot (jamais une notice
par document).
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import store as ocr_store
from ._common import file_lock, write_json_atomic

logger = logging.getLogger("uvicorn.error")

# Taille maximale de la file (aligné sur l'usage courant — pas de réglage V1).
MAX_QUEUE = 50
# Passe RAG 2026-09-26 — un document dont la reconnaissance TUE le process
# (OOM au rendu d'une page) était remis en tête de file à chaque redémarrage :
# boucle de plantages, file entière bloquée. Au-delà de ce nombre de reprises
# après plantage, il est retiré et marqué en erreur.
MAX_CRASH_RETRIES = 2

_EMPTY: Dict[str, Any] = {"version": 1, "paused": False, "active": None,
                          "items": [], "batch": None, "updated_at": 0.0}

# Statuts de document « terminés » : un actif orphelin dans cet état n'est
# PAS remis en file (le travail — ou l'annulation — a déjà eu lieu).
_TERMINAL = {"done": "done", "error": "error", "canceled": "canceled"}

# Reflet RAM de la file, tenu à jour à chaque lecture/écriture (service
# mono-process, seul écrivain) : ``ensure_queue_runner`` le consulte sans
# relire queue.json sur la boucle.
_STATE: Dict[str, Any] = {"known": False, "has_work": False, "paused": False}


def _mirror(q: Dict[str, Any]) -> None:
    _STATE["known"] = True
    _STATE["paused"] = bool(q.get("paused"))
    _STATE["has_work"] = bool(q.get("items") or q.get("active"))


def has_pending_work() -> Optional[bool]:
    """Travail en attente d'après le reflet RAM (None si jamais lu)."""
    if not _STATE["known"]:
        return None
    return _STATE["has_work"] and not _STATE["paused"]


def queue_path() -> Path:
    return ocr_store.ocr_root() / "queue.json"


def _lock():
    return file_lock(ocr_store.ocr_root() / ".queue.lock")


def _load(strict: bool) -> Dict[str, Any]:
    p = queue_path()
    try:
        with open(p, "r", encoding="utf-8") as fh:
            q = json.load(fh)
        if not isinstance(q, dict) or not isinstance(q.get("items", []), list):
            raise ValueError("forme inattendue")
    except FileNotFoundError:
        q = dict(_EMPTY, items=[])
    except (OSError, ValueError):
        if strict:
            raise
        q = dict(_EMPTY, items=[])
    for key, default in _EMPTY.items():
        q.setdefault(key, [] if key == "items" else default)
    q["items"] = [it for it in q["items"]
                  if isinstance(it, dict) and isinstance(it.get("doc"), str)]
    return q


def read_queue() -> Dict[str, Any]:
    q = _load(strict=False)
    _mirror(q)
    return q


def _quarantine() -> None:
    """queue.json illisible : mis de côté (``queue.json.corrupt-<ts>``) et
    journalisé — avant, la file se vidait EN SILENCE à l'écriture suivante."""
    src = queue_path()
    dst = src.with_name(f"queue.json.corrupt-{int(time.time())}")
    try:
        os.replace(src, dst)
        logger.warning("[ocr] queue.json illisible — mis de côté sous %s, "
                       "file repartie vide", dst.name)
    except OSError:
        logger.warning("[ocr] queue.json illisible et non déplaçable", exc_info=True)


def update_queue(mutator: Callable[[Dict[str, Any]], Any]) -> Dict[str, Any]:
    """Lecture-modification-écriture ATOMIQUE de queue.json (flock + replace)."""
    with _lock():
        try:
            q = _load(strict=True)
        except (OSError, ValueError):
            _quarantine()
            q = _load(strict=False)
        mutator(q)
        q["updated_at"] = time.time()
        write_json_atomic(queue_path(), q)
        _mirror(q)
        return q


def enqueue(doc_ids: List[str], model: str = "") -> Dict[str, Any]:
    """Ajoute des documents (dédoublonnés, bornés) et ouvre/étend le lot."""
    now = time.time()

    def _mut(q: Dict[str, Any]) -> None:
        present = {it["doc"] for it in q["items"]}
        if q.get("active"):
            present.add(q["active"])
        added = 0
        for doc_id in doc_ids:
            if doc_id in present:
                continue
            if len(q["items"]) >= MAX_QUEUE:
                rejected[0] += 1            # file pleine : SIGNALÉ, plus ignoré
                continue
            q["items"].append({"doc": doc_id, "model": model or "",
                               "enqueued_at": now})
            present.add(doc_id)
            added += 1
        if added:
            b = q.get("batch") or {"total": 0, "done": 0, "failed": 0,
                                   "canceled": 0, "started_at": now}
            b["total"] += added
            q["batch"] = b
    rejected = [0]
    q = update_queue(_mut)
    q["rejected"] = rejected[0]
    return q


def pop_next() -> Optional[Dict[str, Any]]:
    """Tête de file → ``active``. None si vide, en pause, ou actif déjà posé."""
    out: List[Optional[Dict]] = [None]

    def _mut(q: Dict[str, Any]) -> None:
        if q.get("paused") or q.get("active") or not q["items"]:
            return
        item = q["items"].pop(0)
        q["active"] = item["doc"]
        out[0] = item
    update_queue(_mut)
    return out[0]


def finish_active(doc_id: str, status: str
                  ) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """Solde le doc actif ; retourne ``(queue, lot_final_ou_None)``.

    Le lot final n'est retourné qu'UNE fois : quand la file vient de se vider
    (items vides + actif soldé) — c'est le signal de la notice unique.
    """
    done_batch: List[Optional[Dict]] = [None]
    key = {"done": "done", "error": "failed", "canceled": "canceled"}.get(
        status, "failed")

    def _mut(q: Dict[str, Any]) -> None:
        was_active = q.get("active") == doc_id
        if was_active:
            q["active"] = None
        (q.get("crashes") or {}).pop(doc_id, None)   # soldé normalement
        b = q.get("batch")
        if b and was_active:
            # Compté une seule fois : un second solde (déjà soldé ailleurs)
            # ne gonfle plus le lot.
            b[key] = int(b.get(key) or 0) + 1
        if not q["items"] and not q.get("active") and b:
            done_batch[0] = b
            q["batch"] = None
    return update_queue(_mut), done_batch[0]


def requeue_active_front(doc_id: str) -> Dict[str, Any]:
    """Arrêt PROPRE du service pendant un document de file : il repart en
    TÊTE au prochain démarrage — ni « annulé », ni compté comme plantage."""

    def _mut(q: Dict[str, Any]) -> None:
        if q.get("active") == doc_id:
            q["active"] = None
        if doc_id not in {it["doc"] for it in q["items"]}:
            q["items"].insert(0, {"doc": doc_id, "model": "",
                                  "enqueued_at": time.time()})
    return update_queue(_mut)


def remove_item(doc_id: str) -> bool:
    """Retire un élément EN ATTENTE (refuse l'actif — passer par /cancel)."""
    removed: List[bool] = [False]

    def _mut(q: Dict[str, Any]) -> None:
        if q.get("active") == doc_id:
            return
        before = len(q["items"])
        q["items"] = [it for it in q["items"] if it["doc"] != doc_id]
        if len(q["items"]) != before:
            removed[0] = True
            b = q.get("batch")
            if b:
                b["canceled"] = int(b.get("canceled") or 0) + 1
            if not q["items"] and not q.get("active"):
                q["batch"] = None
    update_queue(_mut)
    return removed[0]


def clear() -> Dict[str, Any]:
    """Vide les éléments EN ATTENTE (l'actif éventuel se solde à part)."""

    def _mut(q: Dict[str, Any]) -> None:
        n = len(q["items"])
        q["items"] = []
        b = q.get("batch")
        if b and n:
            b["canceled"] = int(b.get("canceled") or 0) + n
        if not q.get("active"):
            q["batch"] = None
    return update_queue(_mut)


def set_paused(paused: bool) -> Dict[str, Any]:
    """Pause = la pompe s'arrête ENTRE deux documents (l'actif va au bout)."""
    return update_queue(lambda q: q.__setitem__("paused", bool(paused)))


def reconcile(running_probe: Optional[Callable[[str], bool]] = None, *,
              startup: bool = False) -> Dict[str, Any]:
    """Répare un ``active`` orphelin (pompe morte avec un doc en vol).

    - ``running_probe`` fourni ou ``startup`` : le registre RAM fait foi
      (service mono-process) — le heartbeat n'est PAS consulté. Au
      démarrage, rien ne tourne : un heartbeat frais (arrêt il y a moins de
      5 min) laissait la file bloquée jusqu'à expiration.
    - Sans sonde (appel « aveugle ») : heartbeat frais = vivant.
    - Statut terminal (done/error/canceled) : soldé tel quel, jamais remis en
      file (l'annulation de l'utilisateur est respectée).
    - Sinon REMIS EN TÊTE de file (pages faites préservées). Seul un
      orphelin trouvé AU DÉMARRAGE compte comme plantage (``crashes``) : un
      arrêt propre a déjà remis le document en file lui-même
      (:func:`requeue_active_front`). Au-delà de ``MAX_CRASH_RETRIES`` :
      retiré, marqué en erreur, pages ``running`` → ``pending``.
    """
    settled: List[Tuple[str, str]] = []
    closed: List[Dict[str, Any]] = []

    def _close(q: Dict[str, Any]) -> None:
        b = _close_if_idle(q)
        if b:
            closed.append(b)

    def _mut(q: Dict[str, Any]) -> None:
        doc_id = q.get("active")
        if not doc_id:
            return
        if running_probe and running_probe(doc_id):
            return
        try:
            d = ocr_store.doc_dir(doc_id)
            meta = ocr_store.read_meta(d)
        except (FileNotFoundError, ValueError, OSError):
            # Doc disparu pendant qu'il était actif : on le solde.
            q["active"] = None
            b = q.get("batch")
            if b:
                b["canceled"] = int(b.get("canceled") or 0) + 1
            _close(q)
            return
        status = meta.get("status")
        if running_probe is None and not startup:
            alive = (status in ("preparing", "running")
                     and time.time() - float(meta.get("heartbeat_at") or 0)
                     <= ocr_store.STALE_SEC)
            if alive:
                return
        q["active"] = None
        if status in _TERMINAL:
            b = q.get("batch")
            key = {"done": "done", "error": "failed"}.get(status, "canceled")
            if b:
                b[key] = int(b.get(key) or 0) + 1
            (q.get("crashes") or {}).pop(doc_id, None)
            _close(q)
            settled.append((doc_id, status))
            return
        if startup:
            crashes = q.setdefault("crashes", {})
            crashes[doc_id] = int(crashes.get(doc_id) or 0) + 1
            if crashes[doc_id] > MAX_CRASH_RETRIES:
                crashes.pop(doc_id, None)
                b = q.get("batch")
                if b:
                    b["failed"] = int(b.get("failed") or 0) + 1
                _close(q)
                poisoned.append((doc_id, d))
                return
        q["items"].insert(0, {"doc": doc_id, "model": meta.get("model") or "",
                              "enqueued_at": time.time()})

    poisoned: List[Tuple[str, Path]] = []
    q = update_queue(_mut)
    # Hors du verrou de la file (ordre des verrous : jamais doc → file).
    for _doc_id, _d in poisoned:
        def _poison(m: Dict[str, Any]) -> None:
            m["status"] = "error"
            m["error"] = ("La reconnaissance de ce document a interrompu le "
                          "service à plusieurs reprises (mémoire ?) — retiré "
                          "de la file.")
            for p in m.get("pages") or []:
                if p.get("status") == "running":
                    p["status"] = "pending"
        try:
            ocr_store.update_meta(_d, _poison)
        except (FileNotFoundError, ValueError, OSError):
            pass
    q["settled"] = settled
    q["closed_batch"] = closed[0] if closed else None
    return q


def _close_if_idle(q: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """File vide et sans actif : le lot est clos. Retourne le lot clos (pour
    la notice de fin de lot) ou None."""
    if not q["items"] and not q.get("active") and q.get("batch"):
        b = q["batch"]
        q["batch"] = None
        return b
    return None


def snapshot() -> Dict[str, Any]:
    """Forme API/SSE de la file : items enrichis (nom, position), purge des
    documents supprimés entre-temps."""
    q = read_queue()
    items = []
    dropped = []
    for it in q["items"]:
        try:
            d = ocr_store.doc_dir(it["doc"])
            name = ocr_store.read_meta(d).get("name") or it["doc"]
        except (FileNotFoundError, ValueError, OSError):
            dropped.append(it["doc"])
            continue
        items.append({"doc": it["doc"], "name": name,
                      "position": len(items) + 1})
    closed: List[Dict[str, Any]] = []
    if dropped:
        def _purge(q2: Dict[str, Any]) -> None:
            before = len(q2["items"])
            q2["items"] = [it for it in q2["items"] if it["doc"] not in dropped]
            gone = before - len(q2["items"])
            b = q2.get("batch")
            if b and gone:
                # Le lot en tient compte (sinon, file vidée par purge : lot
                # jamais clos, compteurs reportés sur le lot suivant).
                b["canceled"] = int(b.get("canceled") or 0) + gone
            b_closed = _close_if_idle(q2)
            if b_closed:
                closed.append(b_closed)
        q = update_queue(_purge)
    # ``closed_batch`` : lot clos PAR CETTE PURGE (notice de fin de lot à
    # émettre par l'appelant — cf. ``jobs.queue_snapshot``).
    return {"paused": bool(q.get("paused")), "active": q.get("active"),
            "items": items, "batch": q.get("batch"),
            "closed_batch": closed[0] if closed else None}
