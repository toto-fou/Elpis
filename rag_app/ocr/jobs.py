# SPDX-License-Identifier: MIT
"""rag_app.ocr.jobs — exécution asynchrone d'un document OCR.

Un job = une ``asyncio.Task`` sur l'event loop uvicorn (service MONO-process
— pas de coordination inter-worker : le registre RAM ``_TASKS`` fait
autorité, le heartbeat + ``store.reconcile_stale`` ne servent plus qu'à
requalifier les orphelins d'un crash/redémarrage). Un seul job OCR actif à
la fois (le serveur OCR n'a de toute façon qu'un slot GPU).

Événements live (onglet Documents) : chaque étape publie sur le bus
in-process ``events.bus`` un message ``{"type": "ocr", "data": {…}}``
avec ``data.kind`` ∈ :

- ``progress``  {doc, status, done, total, page}   — avancement global
- ``text``      {doc, page, delta}                 — texte reconnu (nettoyé), throttlé
- ``boxes``     {doc, page, boxes, total}          — zones détectées EN DIRECT
- ``page_done`` {doc, page, status, boxes, divergence, truncated}
- ``rag``       {doc, rag}                         — indexation RAG terminée
- ``job_done``  {doc, status, error}
- ``queue``     {queue: {paused, active, items, batch}} — snapshot de la FILE
- ``notice``    {level, title, body, doc}          — remplace les
  notifications push du chatbot (rag_app n'a pas de centre de
  notifications : l'UI toaste ces events, le log serveur garde trace)

Fin de job : notice best-effort ; un job lancé par la FILE ne notifie pas
par document (une seule notice par lot, cf. ``_notify_batch``).

Passe RAG 2 (2026-09-26) — cycle de vie durci :

- tout le corps d'un job (y compris la lecture initiale de meta) est dans
  son ``try`` : une annulation précoce ne tue plus la pompe de file ;
- ``cancel_job`` n'envoie qu'UNE annulation par task (une seconde
  interrompait le gestionnaire d'annulation lui-même) ;
- les appels bloquants de préparation sont ANNULABLES (événement transmis
  au thread, qui tue soffice / arrête le raster) et attendus jusqu'au bout :
  le sémaphore n'est rendu qu'une fois le thread réellement terminé ;
- ``stop_doc`` (suppression) annule ET attend la fin effective du job, de
  la préparation et de l'indexation du document ;
- l'indexation RAG a son registre (``_INDEX_TASKS``) : une seule par
  document, jamais dans le slot OCR (l'auto-index ne retient plus le GPU) ;
- ``_SHUTTING_DOWN`` : à l'arrêt propre, le document actif de la file est
  remis en tête (ni annulé, ni compté comme plantage).
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import client as ocr_client, convert as ocr_convert, store as ocr_store
from ._common import OcrError
from .config import apply_doc_model, get_ocr_config
from .events import bus

logger = logging.getLogger("uvicorn.error")

# Throttle du flux « text » : on regroupe les deltas par paquets.
_FLUSH_CHARS = 256
_FLUSH_SEC = 0.25

# Heartbeat pendant le STREAM d'une page : une page dense peut dépasser
# STALE_SEC (le timeout httpx se ré-arme à chaque chunk) — sans rafraîchir
# le marqueur, un redémarrage requalifierait à tort un doc encore vivant
# repris juste après.
_HEARTBEAT_SEC = 60

# Attente maximale de la fin RÉELLE d'un thread (préparation, indexation)
# après annulation de la coroutine qui l'attendait.
_THREAD_GRACE_SEC = 60

# Registre des jobs OCR de CE process : doc_id → Task. C'est LE slot :
# une entrée vivante = reconnaissance en cours.
_TASKS: Dict[str, asyncio.Task] = {}

# Registre des PRÉPARATIONS (conversion + raster) : hors slot OCR — déposer
# N fichiers pendant une reconnaissance est permis, seul le GPU est sérialisé.
# Le sémaphore borne la charge CPU/soffice (profil LO jetable concurrent-safe).
_PREP_TASKS: Dict[str, asyncio.Task] = {}
_PREP_SEM = asyncio.Semaphore(2)

# Registre des INDEXATIONS RAG (embeddings, en thread) : une par document.
_INDEX_TASKS: Dict[str, asyncio.Task] = {}

# Pompe de file unique (liste à 1 case : mutable partagé sans global).
_QUEUE_TASK: list = [None]

# Tasks ayant déjà reçu leur annulation (une seule par task).
_CANCEL_SENT: "set[int]" = set()

# Arrêt propre du service en cours (lifecycle.on_shutdown).
_SHUTTING_DOWN: list = [False]

# Reprise de démarrage terminée (lifecycle.on_startup) ? Tant qu'elle ne
# l'est pas, la pompe ne démarre pas : un GET /api/ocr/queue arrivé avant
# faisait tourner un document que la réconciliation de démarrage, elle,
# croyait orphelin (plantage compté + remise en tête PENDANT qu'il tournait).
_STARTUP_DONE: list = [False]


def _cfg_for(meta: Dict) -> Dict:
    """Config effective du document (modèle du doc > défaut admin)."""
    return apply_doc_model(get_ocr_config(), meta)


def _alive(task: Optional[asyncio.Task]) -> bool:
    return task is not None and not task.done()


def _queue_pump_alive() -> bool:
    return _alive(_QUEUE_TASK[0])


def has_active_job() -> Optional[str]:
    """doc_id du job OCR actif dans ce process, sinon None."""
    for doc_id, task in _TASKS.items():
        if not task.done():
            return doc_id
    return None


def job_busy() -> Optional[str]:
    """Le SLOT OCR est-il occupé ? doc_id, ``"file"`` (pompe entre deux
    documents) ou None. Mono-process : le registre RAM est la vérité —
    l'ancienne sonde flock inter-worker n'a plus d'objet."""
    local = has_active_job()
    if local:
        return local
    if _queue_pump_alive():
        return "file"
    return None


def is_running(doc_id: str) -> bool:
    """Une task (OCR ou préparation) vit-elle pour ce document ?"""
    return _alive(_TASKS.get(doc_id)) or _alive(_PREP_TASKS.get(doc_id))


def index_running(doc_id: str) -> bool:
    return _alive(_INDEX_TASKS.get(doc_id))


def busy_any() -> bool:
    """Un travail OCR quelconque tourne-t-il (job, préparation, indexation,
    pompe) ? Utilisé pour refuser un redémarrage du service."""
    if _queue_pump_alive():
        return True
    return any(_alive(t) for reg in (_TASKS, _PREP_TASKS, _INDEX_TASKS)
               for t in reg.values())


def running_probe():
    """Prédicat ``doc_id → job vivant ici`` pour ``store.reconcile_stale``."""
    return lambda doc_id: is_running(doc_id)


async def _emit(data: Dict) -> None:
    """Publie un event live — best-effort, jamais bloquant pour le job.

    (Reste ``async`` pour garder les ~20 sites d'appel inchangés ; la
    publication elle-même est synchrone et non bloquante.)
    """
    try:
        bus.publish(data)
    except Exception:  # noqa: BLE001 — le live est du sucre
        logger.debug("[ocr] emit échoué", exc_info=True)


def _notify(title: str, body: str, doc_id: str, level: str = "info") -> None:
    """Notice utilisateur (toast côté UI) + trace serveur."""
    try:
        bus.publish({"kind": "notice", "level": level, "title": title,
                     "body": body, "doc": doc_id})
    except Exception:  # noqa: BLE001
        pass
    (logger.warning if level == "warning" else logger.info)(
        "[ocr] %s — %s", title, body)


def _register(reg: Dict[str, asyncio.Task], doc_id: str,
              task: asyncio.Task, on_done: Optional[Callable] = None) -> None:
    reg[doc_id] = task

    def _cleanup(t: asyncio.Task) -> None:
        if reg.get(doc_id) is t:
            reg.pop(doc_id, None)
        _CANCEL_SENT.discard(id(t))
        if on_done is not None:
            try:
                on_done(t)
            except Exception:  # noqa: BLE001 — best-effort
                pass
    task.add_done_callback(_cleanup)


def _spawn(doc_id: str, coro) -> bool:
    """Enregistre la task du job si le slot est libre.

    False si un job/pompe occupe le slot (aucune task créée) — la coroutine
    est alors fermée proprement (pas de warning « never awaited »).
    Mono-thread event loop : le check + create_task est atomique (aucun
    await entre les deux), pas de course possible.
    """
    if job_busy() or _SHUTTING_DOWN[0]:
        coro.close()
        return False
    task = asyncio.create_task(coro)
    # Slot libéré : si une file attend, la pompe repart.
    _register(_TASKS, doc_id, task, on_done=lambda t: ensure_queue_runner())
    return True


def start_prepare(doc_id: str) -> bool:
    """Prépare le document (conversion + raster → aperçus) SANS lancer l'OCR.

    Lancé automatiquement au dépôt. HORS slot OCR : déposer un lot pendant
    une reconnaissance est permis — le sémaphore borne juste la charge.
    Refusé si une préparation ou un job vit déjà pour ce document.
    """
    if is_running(doc_id) or _SHUTTING_DOWN[0]:
        return False

    async def _guarded() -> None:
        async with _PREP_SEM:
            await _run_prepare_job(doc_id)
    _register(_PREP_TASKS, doc_id, asyncio.create_task(_guarded()))
    return True


def start_job(doc_id: str) -> bool:
    """Lance la RECONNAISSANCE d'un document. False si le slot est occupé."""
    return _spawn(doc_id, _run_job(doc_id))


def start_page_rerun(doc_id: str, page_n: int) -> bool:
    """Re-OCR d'une seule page (document déjà préparé)."""
    return _spawn(doc_id, _run_page_rerun(doc_id, page_n))


def cancel_job(doc_id: str) -> bool:
    """Annule les tasks (OCR et préparation) du document.

    Une seule annulation par task : une seconde interrompait le
    gestionnaire d'annulation en plein milieu (statut jamais écrit). True si
    au moins une task vivante était concernée.
    """
    found = False
    for reg in (_TASKS, _PREP_TASKS):
        task = reg.get(doc_id)
        if _alive(task):
            found = True
            if id(task) not in _CANCEL_SENT:
                _CANCEL_SENT.add(id(task))
                task.cancel()
    return found


async def stop_doc(doc_id: str, timeout: float = 30.0) -> bool:
    """Arrête TOUT travail en cours sur le document et attend sa fin réelle
    (job, préparation, indexation). Préalable à la suppression : sans
    attente, les threads du job recréaient des fichiers dans le dossier en
    cours de suppression et une indexation en vol écrivait des vecteurs
    orphelins. True si plus rien ne tourne."""
    cancel_job(doc_id)
    tasks = [t for reg in (_TASKS, _PREP_TASKS, _INDEX_TASKS)
             if _alive(t := reg.get(doc_id))]
    if not tasks:
        return True
    _done, pending = await asyncio.wait(tasks, timeout=timeout)
    return not pending


async def _await_thread(fut: "asyncio.Future", on_cancel: Optional[Callable] = None):
    """Attend un ``to_thread`` en garantissant qu'une annulation de
    l'appelant n'abandonne pas le thread en tâche de fond : ``on_cancel``
    (signal d'arrêt au thread) puis attente bornée de sa fin réelle."""
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        if on_cancel is not None:
            on_cancel()
        try:
            await asyncio.wait_for(asyncio.shield(fut), _THREAD_GRACE_SEC)
        except BaseException:  # noqa: BLE001 — l'annulation d'origine prime
            pass
        raise


async def _prep_call(fn, *args, **kwargs):
    """Appel de préparation (soffice / raster) annulable pour de vrai."""
    ev = threading.Event()
    fut = asyncio.ensure_future(asyncio.to_thread(fn, *args, cancel_event=ev, **kwargs))
    return await _await_thread(fut, on_cancel=ev.set)


async def _safe_update(d: Optional[Path], mutator) -> Optional[Dict]:
    """update_meta en thread qui tolère un document supprimé entre-temps."""
    if d is None:
        return None
    try:
        return await asyncio.to_thread(ocr_store.update_meta, d, mutator)
    except (FileNotFoundError, ValueError, OSError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
#  Indexation RAG (registre dédié, hors slot OCR)
# ─────────────────────────────────────────────────────────────────────────────
def start_index(doc_id: str, collection: str = "", *,
                auto: bool = False) -> Optional[asyncio.Task]:
    """Lance l'indexation RAG du document. None si une indexation tourne déjà
    pour lui (double clic, auto-index + manuel : les deux faisaient un
    retrait + une indexation croisés).

    ``auto`` : échec journalisé en WARNING + notice UI (au lieu de lever).
    """
    if index_running(doc_id) or _SHUTTING_DOWN[0]:
        return None
    from . import rag_index as ocr_rag

    async def _run() -> Dict[str, Any]:
        fut = asyncio.ensure_future(
            asyncio.to_thread(ocr_rag.index_doc, doc_id, collection))
        try:
            rag = await _await_thread(fut)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            if not auto:
                raise
            logger.warning("[ocr] auto-index RAG échoué (doc=%s) : %s", doc_id, e)
            _notify("Indexation automatique échouée",
                    f"{e}" if isinstance(e, OcrError) else
                    f"Erreur interne ({e.__class__.__name__}).",
                    doc_id, level="warning")
            return {}
        await _emit({"kind": "rag", "doc": doc_id, "rag": rag})
        return rag
    task = asyncio.create_task(_run())
    _register(_INDEX_TASKS, doc_id, task)
    return task


# ─────────────────────────────────────────────────────────────────────────────
#  Exécution
# ─────────────────────────────────────────────────────────────────────────────
async def _ocr_one_page(doc_id: str, d: Path, page: Dict, cfg: Dict, *,
                        force: bool = False) -> bool:
    """OCR d'UNE page : stream live nettoyé → résultat + boxes + divergence.

    Retourne False (rien fait) si la page est devenue ``done`` entre-temps
    (édition humaine d'une page en attente) et que ``force`` est faux : une
    édition n'est jamais écrasée par la reprise.
    """
    n = int(page["n"])
    claimed = [False]

    def _claim(m: Dict) -> None:
        for p in m.get("pages", []):
            if p.get("n") == n:
                if p.get("status") == "done" and not force:
                    return
                p["status"] = "running"
                claimed[0] = True
    # AUDIT 2026-08-31 (passe 4, B10) — toute l'I/O de cette coroutine part en
    # thread (flock + réécriture de meta, PNG multi-Mo).
    await asyncio.to_thread(ocr_store.update_meta, d, _claim)
    if not claimed[0]:
        return False

    png = await asyncio.to_thread(ocr_store.page_image_path(d, n).read_bytes)
    page_w, page_h = int(page.get("w") or 0), int(page.get("h") or 0)
    sanitizer = ocr_client.StreamSanitizer()
    pending = ""
    raw_acc = ""
    boxes_sent = 0
    last_flush = time.monotonic()
    last_hb = time.monotonic()

    async def _flush(force_: bool = False) -> None:
        nonlocal pending, last_flush, boxes_sent, last_hb
        # Marqueur de vie pendant le stream : une page peut durer > STALE_SEC
        # sans frontière de page (seul endroit où meta bougeait).
        if time.monotonic() - last_hb > _HEARTBEAT_SEC:
            await asyncio.to_thread(ocr_store.heartbeat, d)
            last_hb = time.monotonic()
        if not force_ and len(pending) < _FLUSH_CHARS \
                and time.monotonic() - last_flush < _FLUSH_SEC:
            return
        if pending:
            await _emit({"kind": "text", "doc": doc_id,
                         "page": n, "delta": pending})
            pending = ""
        # Boxes EN DIRECT : le parseur ne matche que les blocs grounding
        # COMPLETS — reparser le brut accumulé est sûr (un bloc encore
        # ouvert est ignoré) et bon marché (regex sur quelques Ko).
        _, live_boxes = ocr_client.parse_grounding(raw_acc, page_w, page_h)
        if len(live_boxes) > boxes_sent:
            await _emit({"kind": "boxes", "doc": doc_id, "page": n,
                         "boxes": live_boxes[boxes_sent:],
                         "total": len(live_boxes)})
            boxes_sent = len(live_boxes)
        last_flush = time.monotonic()

    async def _on_delta(delta: str) -> None:
        nonlocal pending, raw_acc
        raw_acc += delta
        pending += sanitizer.feed(delta)
        await _flush()

    truncated = False
    async with ocr_client.gpu_slot():
        try:
            raw = await ocr_client.stream_ocr(png, cfg=cfg, on_delta=_on_delta)
        except ocr_client.OcrTruncated as e:
            # Plafond de génération : le texte reçu est gardé, la page est
            # SIGNALÉE tronquée (relancer à l'identique redonnerait la même
            # coupe — c'est ``max_tokens`` qu'il faut relever).
            raw, truncated = e.raw, True
    pending += sanitizer.flush()
    await _flush(force_=True)

    # Brut conservé : diagnostic des formats modèle + re-parse sans re-OCR.
    raw_path = ocr_store.page_raw_path(d, n)

    def _persist_raw():
        # Sans ``parents`` : un document supprimé ne renaît pas en dossier
        # fantôme ``<id>/raw/``.
        raw_path.parent.mkdir(exist_ok=True)
        ocr_store.write_text_atomic(raw_path, raw)
    await asyncio.to_thread(_persist_raw)

    md, boxes = ocr_client.parse_grounding(raw, page_w, page_h)
    text_path = ocr_store.page_text_path(d, n)
    layer = await asyncio.to_thread(
        lambda: text_path.read_text(encoding="utf-8") if text_path.is_file() else "")
    div = ocr_convert.divergence(layer, md)
    await asyncio.to_thread(ocr_store.save_page_result, d, n, md, boxes, div,
                            truncated=truncated)
    await _emit({"kind": "page_done", "doc": doc_id, "page": n,
                 "status": "done", "boxes": len(boxes),
                 "divergence": div, "truncated": truncated})
    if truncated:
        _notify("Page tronquée",
                f"Page {n} : plafond de génération atteint (max_tokens) — "
                "texte incomplet, à relire.", doc_id, level="warning")
    return True


async def _prepare(d: Path, meta: Dict, cfg: Dict, *,
                   final_status: str = "ready") -> Dict:
    """Conversion (docx→PDF) + raster des pages — threads ANNULABLES."""
    src = ocr_store.source_path(d, meta)
    timeout = float(cfg.get("prepare_timeout_sec") or 900)
    if meta.get("ext") == ".docx":
        pdf = await _prep_call(ocr_convert.docx_to_pdf, src, d, timeout_sec=timeout)
    else:
        pdf = src
    quota = int(cfg.get("max_disk_mb") or 8192) * 1024 * 1024
    used = await asyncio.to_thread(ocr_store.disk_usage_cached)
    pages, truncated = await _prep_call(
        ocr_convert.raster_pdf, pdf, d / "pages", d / "text",
        max_side_px=cfg["max_side_px"], max_pages=cfg["max_pages"],
        timeout_sec=timeout, max_bytes=max(0, quota - used))
    ocr_store.invalidate_disk_usage()

    def _mut(m: Dict) -> None:
        # Relance d'un doc en erreur/annulé : les pages déjà transcrites
        # (et les éditions manuelles) sont PRÉSERVÉES — seul le reste repart.
        prev = {p.get("n"): p for p in (m.get("pages") or [])}
        merged = []
        for p in pages:
            old = prev.get(p["n"]) or {}
            done = old.get("status") == "done"
            entry = {**p,
                     "status": "done" if done else "pending",
                     "edited": bool(old.get("edited")) if done else False,
                     "divergence": old.get("divergence") if done else None,
                     "boxes": old.get("boxes") if done else 0}
            if done and old.get("truncated"):
                entry["truncated"] = True
            merged.append(entry)
        m["pages"] = merged
        m["pages_total"] = len(pages)
        ocr_store.recount(m)
        m["truncated"] = truncated
        m["status"] = final_status
        m["heartbeat_at"] = time.time()
    return await asyncio.to_thread(ocr_store.update_meta, d, _mut)


async def _run_prepare_job(doc_id: str) -> None:
    """Job de PRÉPARATION seul : le doc passe uploaded → preparing → ready.

    Les aperçus (vignettes + scène) sont disponibles avant tout appel au
    modèle — la reconnaissance attend le bouton « Lancer »."""
    d: Optional[Path] = None
    try:
        d = await asyncio.to_thread(ocr_store.doc_dir, doc_id)
        meta = await asyncio.to_thread(ocr_store.read_meta, d)
        await asyncio.to_thread(ocr_store.update_meta, d, lambda m: (
            m.__setitem__("status", "preparing"),
            m.__setitem__("error", ""),
            m.__setitem__("heartbeat_at", time.time())))
        await _emit({"kind": "progress", "doc": doc_id,
                     "status": "preparing", "done": 0, "total": 0,
                     "page": 0})
        meta = await _prepare(d, meta, get_ocr_config(), final_status="ready")
        await _emit({"kind": "progress", "doc": doc_id,
                     "status": "ready", "done": meta["pages_done"],
                     "total": meta["pages_total"], "page": 0})
    except asyncio.CancelledError:
        if _SHUTTING_DOWN[0]:
            # Arrêt du service : « uploaded » (et non « canceled ») pour que
            # le démarrage suivant RELANCE la préparation (_recover_docs).
            await _safe_update(d, lambda m: m.__setitem__("status", "uploaded"))
        else:
            await _safe_update(d, lambda m: _mark_canceled(m))
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "canceled", "error": ""})
    except FileNotFoundError:
        # Document supprimé pendant la préparation : rien à écrire.
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "canceled", "error": ""})
    except OcrError as e:
        await _fail(doc_id, d, str(e))
    except Exception:  # noqa: BLE001
        logger.exception("[ocr] préparation %s en erreur", doc_id)
        await _fail(doc_id, d, "Erreur interne à la préparation.")


def _mark_canceled(m: Dict) -> None:
    m["status"] = "canceled"
    m["error"] = ("Interrompu par un redémarrage du service — relancez."
                  if _SHUTTING_DOWN[0] else "")
    for p in m.get("pages", []):
        if p.get("status") == "running":
            p["status"] = "pending"
    ocr_store.recount(m)


async def _run_job(doc_id: str, *, notify: bool = True) -> str:
    """Reconnaissance complète d'un document. Retourne ``done|error|canceled``
    (consommé par la pompe de file). ``notify=False`` : pas de notice par
    document — la file en émet UNE par lot.

    TOUT le corps est sous ``try`` (lecture initiale comprise) : une
    annulation qui tombe avant la première page est soldée proprement au
    lieu de remonter jusqu'à la pompe."""
    d: Optional[Path] = None
    try:
        d = await asyncio.to_thread(ocr_store.doc_dir, doc_id)
        # Préparation automatique encore en cours (dépôt suivi aussitôt d'un
        # « Lancer » / d'une mise en file) : on l'ATTEND — deux rasters du
        # même document écrivaient les mêmes pages en parallèle.
        prep = _PREP_TASKS.get(doc_id)
        if _alive(prep):
            await asyncio.wait({prep})
        meta = await asyncio.to_thread(ocr_store.read_meta, d)
        cfg = _cfg_for(meta)
        # Modèle vide (ni doc ni default_model) : résolution auto via
        # /v1/models — sans quoi le routeur refuse le body (« missing model
        # name in request »). Le modèle RÉSOLU est noté à part
        # (``model_used``) : ``meta.model`` reste le CHOIX de l'utilisateur
        # (sinon le modèle auto-choisi s'y figeait pour toujours).
        cfg = await ocr_client.ensure_model(cfg)
        needs_prepare = not await asyncio.to_thread(ocr_store.pages_ready, d, meta)
        await asyncio.to_thread(ocr_store.update_meta, d, lambda m: (
            m.__setitem__("status", "preparing" if needs_prepare else "running"),
            m.__setitem__("error", ""),
            m.__setitem__("model_used", cfg.get("model") or ""),
            m.__setitem__("heartbeat_at", time.time())))
        if needs_prepare:
            await _emit({"kind": "progress", "doc": doc_id,
                         "status": "preparing", "done": 0, "total": 0,
                         "page": 0})
            meta = await _prepare(d, meta, cfg, final_status="running")
        else:
            meta = await asyncio.to_thread(ocr_store.read_meta, d)
        total = meta["pages_total"]
        done_count = int(meta.get("pages_done") or 0)

        from . import rag_index as ocr_rag
        first_page = True
        for page in meta["pages"]:
            if page.get("status") == "done":   # reprise après re-lancement
                continue
            n = int(page["n"])
            # Respiration entre deux pages : la page finie reste visible
            # (texte + boxes) avant la bascule. Configurable
            # (ocr.page_transition_ms).
            if not first_page:
                await asyncio.sleep(
                    max(0, int(cfg.get("page_transition_ms") or 0)) / 1000)
            first_page = False
            await _emit({"kind": "progress", "doc": doc_id,
                         "status": "running",
                         "done": done_count, "total": total,
                         "page": n})
            if await _ocr_one_page(doc_id, d, page, cfg):
                # L'index RAG éventuel ne reflète plus le document (page
                # ajoutée) — avant, un index partiel restait « à jour ».
                await asyncio.to_thread(ocr_rag.mark_stale, d)
            done_count = int((await asyncio.to_thread(
                ocr_store.read_meta, d)).get("pages_done") or 0)

        meta = await asyncio.to_thread(ocr_store.update_meta, d, lambda m: (
            m.__setitem__("status", "done"), ocr_store.recount(m)))
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "done", "error": ""})
        if notify:
            _notify("Document reconnu",
                    f"« {meta.get('name')} » — {total} page(s) transcrites.",
                    doc_id)
        if cfg.get("auto_index"):
            # Indexation RAG automatique — dans SA task (registre dédié) :
            # le slot OCR est libéré tout de suite, une annulation tardive
            # ne peut plus transformer ce document terminé en « annulé »,
            # et un échec est signalé (WARNING + notice) au lieu d'un DEBUG.
            start_index(doc_id, auto=True)
        return "done"

    except asyncio.CancelledError:
        # Annulation utilisateur (ou arrêt du service) : état propre.
        await _safe_update(d, _mark_canceled)
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "canceled", "error": ""})
        return "canceled"
    except FileNotFoundError:
        # Document supprimé pendant le traitement.
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "canceled", "error": ""})
        return "canceled"
    except OcrError as e:
        await _fail(doc_id, d, str(e), notify=notify)
        return "error"
    except Exception as e:  # noqa: BLE001 — le job ne doit jamais crasher muet
        logger.exception("[ocr] job %s en erreur", doc_id)
        await _fail(doc_id, d, f"Erreur interne : {e.__class__.__name__}",
                    notify=notify)
        return "error"


async def _fail(doc_id: str, d: Optional[Path], message: str, *,
                notify: bool = True) -> None:
    def _mut(m: Dict) -> None:
        m["status"] = "error"
        m["error"] = message
        for p in m.get("pages", []):
            if p.get("status") == "running":
                p["status"] = "error"
        ocr_store.recount(m)
    meta = await _safe_update(d, _mut) or {}
    await _emit({"kind": "job_done", "doc": doc_id,
                 "status": "error", "error": message})
    if notify:
        _notify("Échec de la reconnaissance",
                f"« {meta.get('name') or doc_id} » : {message}", doc_id)


# ─────────────────────────────────────────────────────────────────────────────
#  File d'attente multi-documents (pompe séquentielle)
# ─────────────────────────────────────────────────────────────────────────────
async def queue_snapshot() -> Dict[str, Any]:
    """Snapshot de la file (en thread) ; si la purge des documents disparus
    vient de CLORE le lot, sa notice de fin de lot part ici (avant, elle ne
    partait jamais)."""
    from . import queue as ocr_queue
    snap = await asyncio.to_thread(ocr_queue.snapshot)
    closed = snap.pop("closed_batch", None)
    if closed:
        _notify_batch(closed)
    return snap


async def _emit_queue() -> None:
    await _emit({"kind": "queue", "queue": await queue_snapshot()})


def _notify_batch(batch: Dict) -> None:
    """UNE notice par LOT (jamais par document de la file)."""
    done = int(batch.get("done") or 0)
    failed = int(batch.get("failed") or 0)
    body = f"{done} document(s) transcrit(s)"
    if failed:
        body += f", {failed} en erreur"
    _notify("Lot terminé", body, "")


def ensure_queue_runner() -> bool:
    """(Re)lance la pompe de file si nécessaire — reprise PARESSEUSE, pas de
    leader dédié : appelée à l'enqueue, au GET /queue, à la libération du
    slot et au démarrage (lifecycle). True si une pompe vit (déjà là ou
    lancée).

    Aucune E/S disque ici (passe RAG 2) : l'état de la file vient de son
    reflet RAM (``queue.has_pending_work``) ; inconnu → la pompe démarre et
    lit elle-même la file en thread (elle s'arrête aussitôt si vide).
    """
    if _queue_pump_alive():
        return True
    if not _STARTUP_DONE[0] or _SHUTTING_DOWN[0] or has_active_job():
        return False   # le démarrage / le job direct la relancera
    from . import queue as ocr_queue
    if ocr_queue.has_pending_work() is False:
        return False
    task = asyncio.create_task(_run_queue())
    _QUEUE_TASK[0] = task
    task.add_done_callback(
        lambda t: _QUEUE_TASK.__setitem__(0, None)
        if _QUEUE_TASK[0] is t else None)
    return True


def _pump_cancelled() -> bool:
    me = asyncio.current_task()
    return _SHUTTING_DOWN[0] or bool(me is not None and me.cancelling())


async def _run_queue() -> None:
    """Vidange séquentielle de la file — la pompe EST le slot tant qu'elle vit
    (``job_busy`` la voit, aucun job direct ne peut démarrer en parallèle).

    Chaque document tourne dans SA propre task enregistrée dans ``_TASKS`` :
    ``cancel_job`` annule le doc ACTIF sans tuer la pompe (elle solde et
    enchaîne). Pause = arrêt entre deux documents. Arrêt du service : le
    document actif est remis en TÊTE (repris au démarrage suivant).
    """
    from . import queue as ocr_queue
    # Passe RAG 2026-09-26 — reconcile / pop_next / finish_active prennent le
    # flock de la file et réécrivent queue.json : en thread.
    rq = await asyncio.to_thread(ocr_queue.reconcile, running_probe())
    if rq.get("closed_batch"):
        _notify_batch(rq["closed_batch"])
    while not _SHUTTING_DOWN[0]:
        item = await asyncio.to_thread(ocr_queue.pop_next)
        if item is None:
            break
        doc_id = item["doc"]
        await _emit_queue()
        status = "canceled"
        try:
            d = await asyncio.to_thread(ocr_store.doc_dir, doc_id)
        except FileNotFoundError:
            d = None   # supprimé pendant l'attente : soldé « canceled »
        if d is not None:
            if item.get("model"):
                await _safe_update(d, lambda m: m.__setitem__("model", item["model"]))  # noqa: B023 (même itération)
            task = asyncio.create_task(_run_job(doc_id, notify=False))
            _register(_TASKS, doc_id, task)
            try:
                status = await task
            except asyncio.CancelledError:
                if task.cancelled() and not _pump_cancelled():
                    # Annulation du DOCUMENT tombée avant son ``try`` (garde
                    # restante) : on solde « canceled » et on continue.
                    status = "canceled"
                else:
                    # C'est la POMPE qu'on arrête : fin réelle du document
                    # attendue, puis remise en tête de file.
                    if not task.done():
                        await asyncio.wait({task}, timeout=_THREAD_GRACE_SEC)
                    await asyncio.shield(asyncio.to_thread(
                        ocr_queue.requeue_active_front, doc_id))
                    raise
            except Exception:  # noqa: BLE001 — _run_job ne lève pas, ceinture
                status = "error"
            if _pump_cancelled():
                # L'annulation de la pompe a été « absorbée » par le document
                # (qui l'a soldée « canceled ») : on la rétablit.
                await asyncio.shield(asyncio.to_thread(
                    ocr_queue.requeue_active_front, doc_id))
                raise asyncio.CancelledError()
        _q, batch = await asyncio.to_thread(ocr_queue.finish_active, doc_id, status)
        await _emit_queue()
        if batch:
            _notify_batch(batch)


async def _run_page_rerun(doc_id: str, page_n: int) -> None:
    d: Optional[Path] = None
    prev: Dict = {}
    n = int(page_n)
    try:
        d = await asyncio.to_thread(ocr_store.doc_dir, doc_id)
        meta = await asyncio.to_thread(ocr_store.read_meta, d)
        page = next((p for p in meta.get("pages", [])
                     if p.get("n") == n), None)
        if page is None:
            raise OcrError(f"Page {page_n} inconnue.")
        # État AVANT re-run : restauré si l'utilisateur annule (la page avait
        # peut-être déjà un résultat valide — il ne doit pas devenir « error »).
        prev = {k: page.get(k) for k in ("status", "edited", "divergence", "boxes")}
        await _emit({"kind": "progress", "doc": doc_id,
                     "status": "running", "done": meta["pages_done"],
                     "total": meta["pages_total"], "page": n})
        await _ocr_one_page(doc_id, d, page,
                            await ocr_client.ensure_model(_cfg_for(meta)),
                            force=True)
        # Le re-OCR écrase une éventuelle édition manuelle → drapeau remis.
        await asyncio.to_thread(ocr_store.update_meta, d, lambda m: [
            p.__setitem__("edited", False)
            for p in m.get("pages", []) if p.get("n") == n])
        from . import rag_index as ocr_rag
        await asyncio.to_thread(ocr_rag.mark_stale, d)
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "done", "error": ""})
    except asyncio.CancelledError:
        def _restore(m: Dict) -> None:
            for p in m.get("pages", []):
                # Ne restaurer que si le re-run était encore en cours : passé
                # save_page_result (fenêtre minuscule), le nouveau résultat
                # est complet et légitime — on le garde.
                if p.get("n") == n and p.get("status") == "running":
                    p.update(prev or {"status": "pending"})
            ocr_store.recount(m)
        await _safe_update(d, _restore)
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "canceled", "error": ""})
    except FileNotFoundError:
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "canceled", "error": ""})
    except Exception as e:  # noqa: BLE001 — jamais de page figée « running »
        if not isinstance(e, OcrError):
            logger.exception("[ocr] relecture de la page %s de %s en erreur",
                             n, doc_id)
        msg = str(e) if isinstance(e, OcrError) else \
            f"Erreur interne : {e.__class__.__name__}"

        def _err(m: Dict) -> None:
            for p in m.get("pages", []):
                if p.get("n") == n and p.get("status") == "running":
                    p["status"] = "error"
            ocr_store.recount(m)
        await _safe_update(d, _err)
        await _emit({"kind": "job_done", "doc": doc_id,
                     "status": "error", "error": msg})
