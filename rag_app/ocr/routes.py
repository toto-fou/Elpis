# SPDX-License-Identifier: MIT
"""rag_app.ocr.routes — endpoints de la feature « Documents » (OCR).

Onglet dédié de la SPA rag_app : dépôt PDF/Word → job OCR page par page
(paquet ``ocr``), progression live via le bus in-process (flux SSE dédié
``/api/ocr/events``), aperçu de page + boxes, édition du Markdown, export
Markdown, indexation RAG in-process.

Gate : ``ocr.enabled`` (rag_config.json, défaut ON) → 404 quand désactivé,
SAUF ``/api/ocr/status`` qui répond toujours ``{"enabled": …}`` (l'UI y lit
s'il faut afficher l'onglet).
Auth : la surface /api/* de rag_app est gardée par le middleware console
d'``app.py`` (jeton ou boucle locale) — ce routeur n'ajoute rien.

TOUTE lecture/écriture disque (meta, file, résultats — flock compris) passe
par ``run_in_threadpool`` / ``asyncio.to_thread`` : un flock contendu ne gèle
plus la boucle (SSE, recherche, santé).

Surface :
    GET    /api/ocr/status                       — feature + endpoint configuré ?
    GET    /api/ocr/models                       — modèles découverts (+ état routeur)
    POST   /api/ocr/models/load|unload           — charge/décharge sur le routeur
    GET    /api/ocr/search?q=                    — recherche plein texte
    GET    /api/ocr/events                       — SSE live (bus in-process)
    GET    /api/ocr/docs                         — liste (réconciliée)
    POST   /api/ocr/docs                         — upload (multipart) + préparation
    GET    /api/ocr/docs/{id}                    — meta détaillée (pages)
    POST   /api/ocr/docs/{id}/restart            — Lancer / relance / redo {model,full}
    POST   /api/ocr/docs/{id}/cancel             — annulation du job
    DELETE /api/ocr/docs/{id}                    — suppression
    POST   /api/ocr/docs/{id}/tags               — étiquettes
    GET    /api/ocr/rag/status                   — collection + auto_index
    POST   /api/ocr/docs/{id}/rag/index          — indexer/réindexer (in-process)
    DELETE /api/ocr/docs/{id}/rag                — retirer de l'index
    GET    /api/ocr/queue                        — file multi-docs (+ reprise lazy)
    POST   /api/ocr/queue/items                  — enfiler {doc_ids, model}
    DELETE /api/ocr/queue/items/{id}             — retirer un élément en attente
    POST   /api/ocr/queue/pause|resume           — pause (l'actif va au bout)
    DELETE /api/ocr/queue                        — vider {cancel_active?}
    GET    /api/ocr/docs/{id}/export             — Markdown concaténé (download)
    GET    /api/ocr/docs/{id}/pages/{n}/image    — PNG de la page
    GET    /api/ocr/docs/{id}/pages/{n}          — markdown + boxes + méta page
    PUT    /api/ocr/docs/{id}/pages/{n}          — sauvegarde l'édition humaine
    POST   /api/ocr/docs/{id}/pages/{n}/rerun    — re-OCR page, ou zone {bbox}
"""
from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from . import client as ocr_client
from . import jobs as ocr_jobs
from . import queue as ocr_queue
from . import rag_index as ocr_rag
from . import store as ocr_store
from ._common import OcrError
from ._uploads import save_upload_bounded
from .config import apply_doc_model, get_ocr_config, ocr_feature_enabled
from .events import TooManySubscribers, bus

logger = logging.getLogger("uvicorn.error")

router = APIRouter()


def _gate() -> None:
    """Feature OFF → 404 (surface invisible). Pas d'utilisateur : rag_app
    est mono-tenant, sa surface admin est ouverte (patron /api/upload)."""
    if not ocr_feature_enabled():
        raise HTTPException(404, "Not found")


def _doc(doc_id: str) -> Path:
    """Dossier du document (SYNCHRONE — threadpool ; en route async, passer
    par :func:`_doc_a`)."""
    try:
        return ocr_store.doc_dir(doc_id)
    except FileNotFoundError:
        raise HTTPException(404, "Document inconnu.")


async def _doc_a(doc_id: str) -> Path:
    return await run_in_threadpool(_doc, doc_id)


async def _meta_a(d: Path) -> dict:
    try:
        return await run_in_threadpool(ocr_store.read_meta, d)
    except FileNotFoundError:
        raise HTTPException(404, "Document inconnu.")
    except ValueError:
        raise HTTPException(409, "État du document illisible (meta.json "
                                 "corrompu) — supprimez-le.")


# Signatures de fichier acceptées (contrôle au-delà de l'extension).
_MAGIC = {".pdf": (b"%PDF",), ".docx": (b"PK\x03\x04",)}

# Décompte ``max_docs`` + création sous verrou : deux dépôts simultanés ne
# dépassent plus le plafond.
_UPLOAD_LOCK = asyncio.Lock()


def _sniff_ok(path: Path, ext: str) -> bool:
    try:
        with open(path, "rb") as fh:
            head = fh.read(1024)
    except OSError:
        return False
    if ext == ".pdf":
        return b"%PDF" in head           # certains PDF ont un préambule
    return any(head.startswith(sig) for sig in _MAGIC.get(ext, ()))


def _download_name(name: str) -> tuple:
    """(repli ASCII, nom UTF-8 encodé) pour Content-Disposition. Caractères
    de contrôle, guillemets et barres retirés — un nom avec « ’ », « € » ou
    un CR/LF faisait échouer l'export (500)."""
    stem = Path(name or "document").stem or "document"
    stem = "".join(c for c in stem if unicodedata.category(c)[0] != "C")
    stem = re.sub(r'["\\/;]+', "_", stem).strip() or "document"
    ascii_stem = (unicodedata.normalize("NFKD", stem)
                  .encode("ascii", "ignore").decode("ascii"))
    ascii_stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", ascii_stem).strip() or "document"
    return f"{ascii_stem}.md", quote(f"{stem}.md", safe="")


def _page_meta(meta: dict, n: int) -> dict:
    page = next((p for p in meta.get("pages", []) if p.get("n") == n), None)
    if page is None:
        raise HTTPException(404, "Page inconnue.")
    return page


def _check_model(model: str) -> str:
    """Assainit un id de modèle envoyé par le front ('' = défaut serveur).

    La liste vient de la DÉCOUVERTE live (/v1/models) — pas de whitelist
    figée : un id périmé produit une erreur claire du serveur OCR au moment
    du job. On borne juste la forme.
    """
    model = (model or "").strip()
    if len(model) > 200 or "\n" in model:
        raise HTTPException(422, "Nom de modèle invalide.")
    return model


# ─────────────────────────────────────────────────────────────────────────────
#  Statut + live
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/ocr/status")
async def api_ocr_status():
    # Jamais 404 : l'UI en déduit s'il faut afficher l'onglet Documents.
    if not ocr_feature_enabled():
        return JSONResponse({"enabled": False, "endpoint_configured": False})
    cfg = get_ocr_config()
    return JSONResponse({
        "enabled": True,
        "endpoint_configured": bool(cfg.get("endpoint_url")),
        "default_model": cfg.get("default_model") or "",
        "max_upload_mb": cfg.get("max_upload_mb"),
        "max_pages": cfg.get("max_pages"),
    })


@router.get("/api/ocr/models")
async def api_ocr_models():
    """Modèles DÉCOUVERTS sur le serveur OCR (GET /v1/models), avec l'ÉTAT du
    routeur (loaded / unloaded / loading, "" si non publié). Erreur douce :
    200 + message, l'UI affiche l'état sans casser."""
    _gate()
    cfg = get_ocr_config()
    if not cfg.get("endpoint_url"):
        return JSONResponse({"models": [], "default": "",
                             "error": "Serveur OCR non configuré."})
    try:
        models = await ocr_client.fetch_models(cfg)
    except OcrError as e:
        return JSONResponse({"models": [], "default": "", "error": str(e)})
    ids = [m["id"] for m in models]
    default = cfg.get("default_model") if cfg.get("default_model") in ids \
        else (ids[0] if ids else "")
    return JSONResponse({"models": models, "default": default, "error": ""})


@router.post("/api/ocr/models/load")
async def api_ocr_model_load(request: Request):
    """Charge un modèle sur le routeur OCR (POST /models/load) — évite le
    délai de premier chargement au moment de lancer une reconnaissance."""
    _gate()
    payload = await request.json()
    model = _check_model(str(payload.get("model") or ""))
    if not model:
        raise HTTPException(422, "Champ « model » requis.")
    try:
        await ocr_client.load_model(get_ocr_config(), model)
    except OcrError as e:
        raise HTTPException(502, str(e))
    return JSONResponse({"ok": True})


@router.post("/api/ocr/models/unload")
async def api_ocr_model_unload(request: Request):
    """Décharge un modèle du routeur OCR (libère la VRAM de la machine GPU)."""
    _gate()
    payload = await request.json()
    model = _check_model(str(payload.get("model") or ""))
    if not model:
        raise HTTPException(422, "Champ « model » requis.")
    try:
        await ocr_client.unload_model(get_ocr_config(), model)
    except OcrError as e:
        raise HTTPException(502, str(e))
    return JSONResponse({"ok": True})


@router.get("/api/ocr/search")
async def api_ocr_search(q: str = ""):
    """Recherche plein texte dans les transcriptions."""
    _gate()
    res = await run_in_threadpool(ocr_store.search_docs, q)
    return JSONResponse(res)


@router.get("/api/ocr/events")
async def api_ocr_events():
    """Flux SSE live (bus in-process) — l'onglet Documents s'y abonne."""
    _gate()
    try:
        q = bus.subscribe()
    except TooManySubscribers as e:
        raise HTTPException(503, str(e))
    return StreamingResponse(
        bus.listen(q), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ─────────────────────────────────────────────────────────────────────────────
#  Documents
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/ocr/docs")
async def api_ocr_docs():
    _gate()
    items = await run_in_threadpool(
        ocr_store.list_docs, ocr_jobs.running_probe())
    return JSONResponse({"items": items})


@router.post("/api/ocr/docs")
async def api_ocr_upload(file: UploadFile = File(...), model: str = Form("")):
    _gate()
    model = _check_model(model)
    cfg = get_ocr_config()
    if not cfg.get("endpoint_url"):
        raise HTTPException(503, "Serveur OCR non configuré (Connexions → OCR).")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ocr_store.ALLOWED_EXTS:
        raise HTTPException(415, "Formats acceptés : PDF et Word (.docx).")
    max_disk_mb = int(cfg.get("max_disk_mb") or 8192)
    # Total disque EN CACHE (ajusté à chaque dépôt) : le parcours complet du
    # store ne tourne plus à chaque upload.
    used = await run_in_threadpool(ocr_store.disk_usage_cached)
    if used >= max_disk_mb * 1024 * 1024:
        raise HTTPException(409, f"Espace documents saturé "
                                 f"({used // 1048576} Mo / {max_disk_mb} Mo) — "
                                 "supprimez des documents.")
    # Pas de garde « job actif » ici : la PRÉPARATION n'occupe pas le slot
    # OCR — déposer un lot pendant une reconnaissance est permis (file).

    # Passe RAG 2026-09-26 — création / meta / suppression (flock, rmtree,
    # JSON) passent en thread : un flock contendu gelait tout le service. Et
    # le nettoyage couvre TOUTE sortie anormale (client parti, disque plein),
    # plus seulement HTTPException : un dossier fantôme comptait dans
    # ``max_docs``.
    async with _UPLOAD_LOCK:
        if await run_in_threadpool(ocr_store.count_docs) >= int(cfg["max_docs"]):
            raise HTTPException(409, f"Limite de {cfg['max_docs']} documents "
                                     "atteinte — supprimez-en avant d'en ajouter.")
        d = await run_in_threadpool(ocr_store.create_doc,
                                    file.filename or "document", ext)
    try:
        if model:
            await run_in_threadpool(
                ocr_store.update_meta, d, lambda m: m.__setitem__("model", model))
        size = await save_upload_bounded(file, d / ("source" + ext),
                                         int(cfg["max_upload_mb"]) * 1024 * 1024)
        if not await run_in_threadpool(_sniff_ok, d / ("source" + ext), ext):
            raise HTTPException(415, "Le contenu du fichier ne correspond pas à "
                                     "son extension (PDF ou Word .docx attendu).")
        ocr_store.disk_usage_add(int(size or 0))
        meta = await run_in_threadpool(ocr_store.read_meta, d)
    except BaseException:
        # Upload trop gros / interrompu : pas de dossier fantôme.
        try:
            _id = (await asyncio.shield(run_in_threadpool(ocr_store.read_meta, d)))["id"]
            await asyncio.shield(run_in_threadpool(ocr_store.delete_doc, _id))
        except Exception:                                    # noqa: BLE001
            pass
        raise
    # PRÉPARATION seule (aperçus immédiats) — la reconnaissance attend le
    # bouton « Lancer » (choix UX : rien ne part au GPU sans geste explicite).
    started = ocr_jobs.start_prepare(meta["id"])
    return JSONResponse({**ocr_store.summary(meta), "prepare_started": started})


@router.get("/api/ocr/docs/{doc_id}")
async def api_ocr_doc_detail(doc_id: str):
    _gate()
    d = await _doc_a(doc_id)
    try:
        meta = await run_in_threadpool(
            lambda: ocr_store.reconcile_stale(d, ocr_store.read_meta(d),
                                              ocr_jobs.running_probe()))
    except FileNotFoundError:
        raise HTTPException(404, "Document inconnu.")
    except ValueError:
        raise HTTPException(409, "État du document illisible (meta.json "
                                 "corrompu) — supprimez-le.")
    meta["indexing"] = ocr_jobs.index_running(doc_id)
    return JSONResponse(meta)


@router.post("/api/ocr/docs/{doc_id}/restart")
async def api_ocr_doc_restart(request: Request, doc_id: str):
    """Relance le traitement. Corps optionnel ``{"model": id, "full": bool}`` :
    un modèle DIFFÉRENT de celui du document — ou ``full=true`` (« Tout
    relire ») — déclenche un REDO COMPLET ; sinon les pages déjà transcrites
    sont préservées (reprise)."""
    _gate()
    d = await _doc_a(doc_id)
    meta = await _meta_a(d)
    # Le registre RAM fait foi : une préparation EN ATTENTE du sémaphore
    # (statut encore « uploaded ») compte aussi — lancer maintenant faisait
    # deux rasters concurrents du même document.
    if ocr_jobs.is_running(doc_id):
        raise HTTPException(409, "Ce document est déjà en cours de traitement "
                                 "(préparation ou reconnaissance).")
    q = await run_in_threadpool(ocr_queue.read_queue)
    if q.get("active") or q["items"]:
        raise HTTPException(409, "Une file est en cours — ajoutez ce document "
                                 "à la file plutôt que de le lancer seul.")
    if ocr_jobs.job_busy():
        raise HTTPException(409, "Un autre document est en cours de traitement.")
    if not get_ocr_config().get("endpoint_url"):
        raise HTTPException(503, "Serveur OCR non configuré.")
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 — corps vide accepté
        payload = {}
    model = _check_model(str(payload.get("model") or ""))
    if (payload.get("full") is True) or (model and model != (meta.get("model") or "")):
        def _switch(m: dict) -> None:
            if model:
                m["model"] = model
            m["pages_done"] = 0
            for p in m.get("pages", []):
                p["status"] = "pending"
                p["edited"] = False
                p["divergence"] = None
                p["boxes"] = 0
                p.pop("truncated", None)
            ocr_store.bump_rev(m)

        def _redo():
            ocr_store.update_meta(d, _switch)
            # Anciennes transcriptions retirées : un redo annulé ne mélange
            # plus ancien et nouveau texte (export, recherche, index).
            ocr_store.purge_results(d)
            ocr_rag.mark_stale(d)   # redo complet : l'index RAG devient périmé
        await run_in_threadpool(_redo)
    if not ocr_jobs.start_job(doc_id):
        raise HTTPException(409, "Un autre document est en cours de traitement.")
    return JSONResponse({"ok": True})


@router.post("/api/ocr/docs/{doc_id}/cancel")
async def api_ocr_doc_cancel(doc_id: str):
    _gate()
    await _doc_a(doc_id)
    if not ocr_jobs.cancel_job(doc_id):
        raise HTTPException(409, "Aucun traitement en cours pour ce document.")
    return JSONResponse({"ok": True})


@router.delete("/api/ocr/docs/{doc_id}")
async def api_ocr_doc_delete(doc_id: str):
    _gate()
    await _doc_a(doc_id)
    # Passe RAG 2 — on ARRÊTE puis on ATTEND la fin réelle de tout travail
    # sur le document (job, préparation, indexation) avant de toucher au
    # disque : sinon les threads du job recréaient des fichiers dans le
    # dossier en cours de suppression (500, document « fantôme ») et une
    # indexation en vol écrivait des vecteurs qu'on ne pouvait plus retirer.
    if not await ocr_jobs.stop_doc(doc_id):
        raise HTTPException(409, "Le traitement de ce document s'arrête encore — "
                                 "réessayez dans quelques secondes.")
    await run_in_threadpool(ocr_queue.remove_item, doc_id)   # s'il attendait

    # rmtree de potentiellement 300 PNG + raw + text → hors event loop ;
    # désindexation RAG AVANT. (2026-09-21) Un document encore INDEXÉ dont la
    # désindexation échoue n'est plus supprimé : ses vecteurs resteraient
    # interrogeables sans plus aucun moyen de les retirer.
    def _purge():
        try:
            meta = ocr_store.read_meta(ocr_store.doc_dir(doc_id))
        except FileNotFoundError:
            return True                      # déjà parti
        except ValueError:
            meta = {}                        # meta corrompu : on supprime
        if (meta.get("rag") or {}).get("rel_path") and not ocr_rag.deindex_doc(doc_id):
            return False
        try:
            ocr_store.delete_doc(doc_id)
        except FileNotFoundError:
            pass
        return True
    if not await run_in_threadpool(_purge):
        raise HTTPException(502, "Suppression refusée : le document est encore dans la "
                                 "recherche RAG et Qdrant ne répond pas — réessayez.")
    await ocr_jobs._emit_queue()
    return JSONResponse({"ok": True})


@router.post("/api/ocr/docs/{doc_id}/tags")
async def api_ocr_doc_tags(request: Request, doc_id: str):
    """Étiquettes libres du document (filtre de la liste)."""
    _gate()
    d = await _doc_a(doc_id)
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(422, "Corps JSON attendu.")
    tags = payload.get("tags") if isinstance(payload, dict) else None
    if not isinstance(tags, list):
        raise HTTPException(422, "Champ « tags » attendu (liste).")
    clean = []
    for t in tags[:10]:
        t = str(t).strip()[:24]
        if t and t not in clean:
            clean.append(t)
    await run_in_threadpool(
        ocr_store.update_meta, d, lambda m: m.__setitem__("tags", clean))
    return JSONResponse({"ok": True, "tags": clean})


# ─────────────────────────────────────────────────────────────────────────────
#  Indexation RAG (in-process)
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/ocr/rag/status")
async def api_ocr_rag_status():
    """Collection cible + auto_index. In-process : toujours « configuré »
    (la vraie disponibilité — Qdrant/embedder — se voit à l'indexation)."""
    _gate()
    cfg = get_ocr_config()
    return JSONResponse({
        "configured": True,
        "default_collection": ocr_rag.collection_for(),
        "auto_index": bool(cfg.get("auto_index")),
        "error": "",
    })


@router.post("/api/ocr/docs/{doc_id}/rag/index")
async def api_ocr_doc_rag_index(request: Request, doc_id: str):
    """Indexe (ou réindexe) la transcription dans le RAG. Corps optionnel
    ``{"collection": "..."}`` (défaut : ``ocr.collection``)."""
    _gate()
    d = await _doc_a(doc_id)
    meta = await _meta_a(d)
    if meta.get("status") != "done" and not int(meta.get("pages_done") or 0):
        raise HTTPException(409, "Indexez un document transcrit (au moins une page).")
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 — corps vide accepté
        payload = {}
    collection = str(payload.get("collection") or "").strip()
    if collection and not re.match(r"^[A-Za-z0-9_-]{1,64}$", collection):
        raise HTTPException(422, "Nom de collection invalide.")
    # Une indexation à la fois par document (registre dédié) : un double
    # clic ou un auto-index concurrent se croisaient (retrait + indexation).
    task = ocr_jobs.start_index(doc_id, collection)
    if task is None:
        raise HTTPException(409, "Indexation déjà en cours pour ce document.")
    try:
        # shield : le client qui part n'interrompt pas l'indexation (elle se
        # termine et reste suivie par le registre).
        rag = await asyncio.shield(task)
    except OcrError as e:
        raise HTTPException(502, str(e))
    return JSONResponse({"ok": True, "rag": rag})


@router.delete("/api/ocr/docs/{doc_id}/rag")
async def api_ocr_doc_rag_remove(doc_id: str):
    _gate()
    d = await _doc_a(doc_id)
    if ocr_jobs.index_running(doc_id):
        raise HTTPException(409, "Indexation en cours pour ce document — "
                                 "réessayez à la fin.")
    if not ((await _meta_a(d)).get("rag") or {}).get("rel_path"):
        raise HTTPException(409, "Ce document n'est pas indexé.")
    removed = await run_in_threadpool(ocr_rag.deindex_doc, doc_id)
    if not removed:
        raise HTTPException(502, "Désindexation impossible (Qdrant "
                                 "injoignable ?) — réessayez.")
    return JSONResponse({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
#  File d'attente multi-documents
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/ocr/queue")
async def api_ocr_queue():
    """Snapshot de la file — et reprise PARESSEUSE de la pompe : ouvrir
    l'onglet suffit à relancer une file interrompue par un redémarrage."""
    _gate()
    ocr_jobs.ensure_queue_runner()
    return JSONResponse(await ocr_jobs.queue_snapshot())


@router.post("/api/ocr/queue/items")
async def api_ocr_queue_add(request: Request):
    """Enfile des documents relançables. Corps {"doc_ids": [...], "model": ""}."""
    _gate()
    payload = await request.json()
    doc_ids = payload.get("doc_ids")
    if not isinstance(doc_ids, list) or not doc_ids:
        raise HTTPException(422, "Champ « doc_ids » attendu (liste non vide).")
    model = _check_model(str(payload.get("model") or ""))
    if not get_ocr_config().get("endpoint_url"):
        raise HTTPException(503, "Serveur OCR non configuré.")
    # AUDIT 2026-09-01 (passe 5, B7) — jusqu'à 50 read_meta (open+json.load)
    # de validation + enqueue (flock bloquant) + snapshot (50 read_meta de
    # plus) tournaient SUR la boucle du service. Déport en threadpool, comme
    # le GET voisin le faisait déjà. ``ensure_queue_runner`` reste sur la
    # boucle (il crée la task asyncio de la pompe).
    def _validate_ids():
        valid = []
        for doc_id in doc_ids[:ocr_queue.MAX_QUEUE]:
            d = _doc(str(doc_id))
            meta = ocr_store.read_meta(d)
            if meta.get("status") in ("ready", "uploaded", "error", "canceled", "done"):
                valid.append(str(doc_id))
        return valid
    valid = await run_in_threadpool(_validate_ids)
    if not valid:
        raise HTTPException(409, "Aucun de ces documents n'est en état d'être "
                                 "mis en file.")
    res = await run_in_threadpool(ocr_queue.enqueue, valid, model)
    ocr_jobs.ensure_queue_runner()
    await ocr_jobs._emit_queue()
    snap = await ocr_jobs.queue_snapshot()
    # (passe RAG 2026-09-26) file pleine : le nombre de refusés est RENDU
    # (avant, ignorés en silence — l'utilisateur les croyait en file).
    snap["rejected"] = int((res or {}).get("rejected") or 0)
    return JSONResponse(snap)


@router.delete("/api/ocr/queue/items/{doc_id}")
async def api_ocr_queue_remove(doc_id: str):
    _gate()
    if not await run_in_threadpool(ocr_queue.remove_item, doc_id):   # (passe 5, B7)
        raise HTTPException(409, "Cet élément n'est pas en attente — s'il est "
                                 "en cours, utilisez l'arrêt du document.")
    await ocr_jobs._emit_queue()
    return JSONResponse(await ocr_jobs.queue_snapshot())


@router.post("/api/ocr/queue/pause")
async def api_ocr_queue_pause():
    """Pause : le document ACTIF va au bout, la pompe s'arrête ensuite."""
    _gate()
    await run_in_threadpool(ocr_queue.set_paused, True)   # (passe 5, B7)
    await ocr_jobs._emit_queue()
    return JSONResponse(await ocr_jobs.queue_snapshot())


@router.post("/api/ocr/queue/resume")
async def api_ocr_queue_resume():
    _gate()
    await run_in_threadpool(ocr_queue.set_paused, False)   # (passe 5, B7)
    ocr_jobs.ensure_queue_runner()
    await ocr_jobs._emit_queue()
    return JSONResponse(await ocr_jobs.queue_snapshot())


@router.delete("/api/ocr/queue")
async def api_ocr_queue_clear(request: Request):
    """Vide la file. Corps optionnel {"cancel_active": true} : arrête aussi
    le document en cours (best-effort)."""
    _gate()
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 — corps vide accepté
        payload = {}
    q = await run_in_threadpool(ocr_queue.clear)   # (passe 5, B7)
    if payload.get("cancel_active") and q.get("active"):
        ocr_jobs.cancel_job(q["active"])
    await ocr_jobs._emit_queue()
    return JSONResponse(await ocr_jobs.queue_snapshot())


# ─────────────────────────────────────────────────────────────────────────────
#  Export Markdown
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/ocr/docs/{doc_id}/export")
async def api_ocr_doc_export(doc_id: str):
    """Markdown concaténé des pages (téléchargement direct)."""
    _gate()
    d = await _doc_a(doc_id)

    def _build():
        meta = ocr_store.read_meta(d)
        parts = [f"<!-- page {n} -->\n\n" + md
                 for n, md in ocr_store.iter_page_markdown(d, meta)]
        return meta, "\n\n".join(parts)
    try:
        meta, body = await run_in_threadpool(_build)
    except FileNotFoundError:
        raise HTTPException(404, "Document inconnu.")
    fallback, utf8 = _download_name(meta.get("name") or "document")
    return Response(
        body, media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition":
                 f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{utf8}"})


# ─────────────────────────────────────────────────────────────────────────────
#  Pages
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/ocr/docs/{doc_id}/pages/{n}/image")
async def api_ocr_page_image(doc_id: str, n: int):
    _gate()
    d = await _doc_a(doc_id)
    path = ocr_store.page_image_path(d, n)
    if not await run_in_threadpool(path.is_file):
        raise HTTPException(404, "Page inconnue.")
    return FileResponse(path, media_type="image/png")


@router.get("/api/ocr/docs/{doc_id}/pages/{n}")
async def api_ocr_page_get(doc_id: str, n: int):
    _gate()
    d = await _doc_a(doc_id)
    try:
        return JSONResponse(await run_in_threadpool(ocr_store.load_page, d, n))
    except FileNotFoundError:
        raise HTTPException(404, "Page inconnue.")
    except ValueError:
        raise HTTPException(409, "État du document illisible.")


@router.put("/api/ocr/docs/{doc_id}/pages/{n}")
async def api_ocr_page_put(request: Request, doc_id: str, n: int):
    """Sauvegarde de l'édition humaine — fait autorité sur l'OCR."""
    _gate()
    d = await _doc_a(doc_id)
    _page_meta(await _meta_a(d), n)
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(422, "Corps JSON attendu.")
    md = payload.get("md") if isinstance(payload, dict) else None
    if not isinstance(md, str):
        raise HTTPException(422, "Champ « md » manquant.")
    if len(md.encode("utf-8", "ignore")) > 2_000_000:
        raise HTTPException(413, "Contenu trop volumineux.")

    def _save():
        # Page passée « done » (protégée du re-OCR à la reprise) ; refus si
        # elle est en cours de reconnaissance (l'édition serait écrasée).
        ocr_store.save_page_edit(d, n, md)
        ocr_rag.mark_stale(d)   # l'index RAG ne reflète plus la page
    try:
        await run_in_threadpool(_save)
    except RuntimeError:
        raise HTTPException(409, "Page en cours de reconnaissance — attendez la "
                                 "fin avant de l'éditer.")
    except FileNotFoundError:
        raise HTTPException(404, "Page inconnue.")
    return JSONResponse({"ok": True})


@router.post("/api/ocr/docs/{doc_id}/pages/{n}/rerun")
async def api_ocr_page_rerun(request: Request, doc_id: str, n: int):
    """Sans ``bbox`` : re-OCR asynchrone de la page (events live).
    Avec ``bbox`` [x1,y1,x2,y2] px page : lecture SYNCHRONE de la zone,
    texte retourné dans la réponse (l'utilisateur choisit quoi en faire)."""
    _gate()
    d = await _doc_a(doc_id)
    meta = await _meta_a(d)
    _page_meta(meta, n)
    # La lecture de zone utilise le MODÈLE du document (cohérence du résultat).
    cfg = apply_doc_model(get_ocr_config(), meta)
    if not cfg.get("endpoint_url"):
        raise HTTPException(503, "Serveur OCR non configuré.")
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 — corps vide accepté (re-OCR page)
        payload = {}
    bbox = payload.get("bbox")
    if bbox is not None:
        if (not isinstance(bbox, list) or len(bbox) != 4
                or not all(isinstance(v, (int, float)) for v in bbox)):
            raise HTTPException(422, "bbox attendu : [x1, y1, x2, y2].")
        # Slot GPU partagé avec la reconnaissance en cours : la zone passe
        # ENTRE deux pages (attente bornée) au lieu de se disputer l'unique
        # slot du serveur — l'un ou l'autre finissait en délai dépassé.
        slot = ocr_client.gpu_slot()
        try:
            await asyncio.wait_for(slot.acquire(),
                                   timeout=float(cfg.get("timeout_sec") or 180))
        except asyncio.TimeoutError:
            raise HTTPException(409, "Serveur OCR occupé par la reconnaissance "
                                     "en cours — réessayez.")
        try:
            cfg = await ocr_client.ensure_model(cfg)   # routeur : model requis
            text = await ocr_client.ocr_zone(
                ocr_store.page_image_path(d, n), [int(v) for v in bbox], cfg=cfg)
        except OcrError as e:
            raise HTTPException(502, str(e))
        finally:
            slot.release()
        return JSONResponse({"text": text})
    if not ocr_jobs.start_page_rerun(doc_id, n):
        raise HTTPException(409, "Un traitement est déjà en cours.")
    await run_in_threadpool(ocr_rag.mark_stale, d)   # le re-OCR va remplacer la page
    return JSONResponse({"ok": True})
