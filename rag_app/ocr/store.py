# SPDX-License-Identifier: MIT
"""rag_app.ocr.store — stockage disque des documents OCR (mono-tenant).

Arborescence : ``<rag_app>/<ocr.store_dir>/<doc_id>/``
    source.<ext>       — le fichier déposé (pdf/docx)
    source.pdf         — le PDF converti (si .docx ; sinon = source)
    pages/NNNN.png     — raster de chaque page
    text/NNNN.txt      — couche texte extraite du PDF (vide pour un scan)
    result/NNNN.md     — Markdown reconnu (écrasé par l'édition humaine)
    boxes/NNNN.json    — zones détectées [{text, box:[x1,y1,x2,y2]} px page]
    meta.json          — état du document (statuts, progression, heartbeat)

La racine (défaut ``rag_app/OCR_STORE/``) vit à CÔTÉ de ``DATA/`` — les
miroirs RAG restent dans ``DATA/<collection>/``, le store OCR porte la
matière première (sources, rasters, transcriptions).

Pourquoi meta.json plutôt qu'une table SQL : l'état d'un document est local à
son dossier (suppression = rmtree, sauvegarde = le dossier), un seul writer
principal (le job) + écritures ponctuelles des routes → un flock par document
suffit — rag_app n'a de toute façon pas de base.

Concurrence : chaque lecture-modification-écriture de meta passe par
:func:`update_meta` (flock exclusif sur ``.lock`` + écriture atomique
tmp+replace) — sûr entre l'event loop et le threadpool FastAPI.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from ._common import ID_RE, file_lock, new_id, write_json_atomic, write_text_atomic
from .config import BASE_DIR, get_ocr_config

logger = logging.getLogger("uvicorn.error")

# Extensions acceptées à l'upload. Les .doc legacy sont refusés :
# la conversion soffice est moins fiable et le format est en voie d'extinction.
ALLOWED_EXTS = (".pdf", ".docx")

# Un doc « running » dont le heartbeat date de plus de STALE_SEC est orphelin
# (service tué en plein job) → requalifié en erreur à la lecture.
STALE_SEC = 300

# Alias local du format d'id commun (_common.ID_RE) — nom conservé.
_DOC_ID_RE = ID_RE


# ─────────────────────────────────────────────────────────────────────────────
#  Chemins
# ─────────────────────────────────────────────────────────────────────────────
def ocr_root() -> Path:
    """Racine du store OCR (créée à la demande).

    ``ocr.store_dir`` de rag_config.json, résolu contre ``rag_app/`` si
    relatif — indépendant du cwd du process.
    """
    raw = str(get_ocr_config().get("store_dir") or "OCR_STORE")
    root = _ROOTS.get(raw)
    if root is None or not root.is_dir():
        p = Path(raw)
        root = (p if p.is_absolute() else BASE_DIR / p).resolve()
        root.mkdir(parents=True, exist_ok=True)
        _ROOTS[raw] = root
    return root


# Racines déjà résolues/créées (passe RAG 2 : plus de resolve()+mkdir à
# chaque appel — ``_doc`` et ``_gate`` en faisaient un par requête).
_ROOTS: Dict[str, Path] = {}


def doc_dir(doc_id: str) -> Path:
    """Dossier d'un document — valide le format de l'id (anti-traversal)."""
    if not _DOC_ID_RE.match(doc_id or ""):
        raise FileNotFoundError(f"doc_id invalide : {doc_id!r}")
    d = ocr_root() / doc_id
    if not (d / "meta.json").is_file():
        raise FileNotFoundError(doc_id)
    return d


def page_image_path(d: Path, n: int) -> Path:
    return d / "pages" / f"{int(n):04d}.png"


def page_text_path(d: Path, n: int) -> Path:
    return d / "text" / f"{int(n):04d}.txt"


def page_result_path(d: Path, n: int) -> Path:
    return d / "result" / f"{int(n):04d}.md"


def page_raw_path(d: Path, n: int) -> Path:
    """Sortie BRUTE du modèle (avant nettoyage) — diagnostic des formats de
    grounding/tableaux et re-parse ultérieur sans re-OCR."""
    return d / "raw" / f"{int(n):04d}.txt"


def page_boxes_path(d: Path, n: int) -> Path:
    return d / "boxes" / f"{int(n):04d}.json"


# ─────────────────────────────────────────────────────────────────────────────
#  meta.json — lecture / écriture atomique + verrou inter-process
# ─────────────────────────────────────────────────────────────────────────────
def _meta_lock(d: Path):
    return file_lock(d / ".lock")


def read_meta(d: Path) -> Dict[str, Any]:
    with open(d / "meta.json", "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_meta_unlocked(d: Path, meta: Dict[str, Any]) -> None:
    write_json_atomic(d / "meta.json", meta)


def update_meta(d: Path, mutator: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
    """Lecture-modification-écriture ATOMIQUE de meta.json (flock + replace).

    ``mutator(meta)`` modifie le dict en place ; ``updated_at`` est
    horodaté ici. Retourne le meta écrit.
    """
    with _meta_lock(d):
        meta = read_meta(d)
        mutator(meta)
        meta["updated_at"] = time.time()
        _write_meta_unlocked(d, meta)
        return meta


def heartbeat(d: Path) -> None:
    """Marqueur de vie du job (détection d'orphelins après redémarrage)."""
    update_meta(d, lambda m: m.__setitem__("heartbeat_at", time.time()))


# ─────────────────────────────────────────────────────────────────────────────
#  Cycle de vie document
# ─────────────────────────────────────────────────────────────────────────────
def create_doc(name: str, ext: str) -> Path:
    """Crée le dossier + meta initial (status ``uploaded``). Retourne le dossier."""
    ext = ext.lower()
    if ext not in ALLOWED_EXTS:
        raise ValueError(f"extension non gérée : {ext}")
    doc_id = new_id()
    d = ocr_root() / doc_id
    for sub in ("pages", "text", "result", "boxes"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    now = time.time()
    meta = {
        "id": doc_id,
        # Nom d'origine borné et sans séparateurs (affichage uniquement —
        # jamais utilisé comme chemin).
        "name": (name or "document").replace("/", "_").replace("\\", "_")[:160],
        "ext": ext,
        "status": "uploaded",
        "error": "",
        "created_at": now,
        "updated_at": now,
        "heartbeat_at": now,
        "pages_total": 0,
        "pages_done": 0,
        "truncated": False,
        "model": "",   # modèle OCR choisi (découvert via /v1/models du serveur)
        "tags": [],    # étiquettes libres (filtre/tri de la liste)
        # ⚠ ``boxes`` ici = NOMBRE de zones (int) ; la LISTE des zones vit
        # dans boxes/NNNN.json et sort par load_page (même clé, contenu ≠).
        "pages": [],   # [{n,w,h,chars,status,edited,divergence,boxes:int}]
    }
    _write_meta_unlocked(d, meta)
    return d


def source_path(d: Path, meta: Dict[str, Any]) -> Path:
    return d / ("source" + meta.get("ext", ".pdf"))


def recount(meta: Dict[str, Any]) -> None:
    """``pages_done`` RECALCULÉ depuis les pages (plus jamais incrémenté :
    une annulation entre l'écriture d'une page et le ``+1`` le faisait
    dériver pour de bon)."""
    meta["pages_done"] = sum(1 for p in meta.get("pages") or []
                             if p.get("status") == "done")


def bump_rev(meta: Dict[str, Any]) -> None:
    """La transcription a changé : révision +1 (l'indexation RAG compare la
    révision lue au départ à celle de la fin pour savoir si elle est à jour)."""
    meta["rev"] = int(meta.get("rev") or 0) + 1


def save_page_result(d: Path, n: int, md: str, boxes: List[dict],
                     divergence: Optional[float], *,
                     truncated: bool = False) -> Dict[str, Any]:
    """Écrit résultat + boxes d'une page et passe son statut à ``done``.

    Écritures atomiques ; le dossier du document n'est jamais recréé (un
    document supprimé pendant la reconnaissance lève FileNotFoundError).
    """
    write_text_atomic(page_result_path(d, n), md)
    write_text_atomic(page_boxes_path(d, n), json.dumps(boxes, ensure_ascii=False))

    def _mut(meta: Dict[str, Any]) -> None:
        for p in meta.get("pages", []):
            if p.get("n") == n:
                p["status"] = "done"
                p["divergence"] = divergence
                p["boxes"] = len(boxes)
                if truncated:
                    p["truncated"] = True
                else:
                    p.pop("truncated", None)
        recount(meta)
        bump_rev(meta)
        meta["heartbeat_at"] = time.time()
    return update_meta(d, _mut)


def save_page_edit(d: Path, n: int, md: str) -> Dict[str, Any]:
    """Édition humaine d'une page : fait autorité. La page passe ``done``
    (une page ``pending`` éditée n'est plus re-OCRisée à la reprise).

    :raises RuntimeError: la page est en cours de reconnaissance.
    :raises FileNotFoundError: page inconnue.
    """
    with _meta_lock(d):
        meta = read_meta(d)
        page = next((p for p in meta.get("pages", []) if p.get("n") == n), None)
        if page is None:
            raise FileNotFoundError(f"page {n}")
        if page.get("status") == "running":
            raise RuntimeError("page en cours de reconnaissance")
        write_text_atomic(page_result_path(d, n), md)
        page["edited"] = True
        page["status"] = "done"
        page.pop("truncated", None)
        recount(meta)
        bump_rev(meta)
        meta["updated_at"] = time.time()
        _write_meta_unlocked(d, meta)
        return meta


def pages_ready(d: Path, meta: Dict[str, Any]) -> bool:
    """Tous les rasters de page existent (et ne sont pas vides) ?

    Remplace le test « la page 1 existe » : un raster interrompu laissait des
    pages manquantes ou tronquées envoyées telles quelles au modèle."""
    pages = meta.get("pages") or []
    if not pages:
        return False
    for p in pages:
        try:
            if page_image_path(d, int(p["n"])).stat().st_size <= 0:
                return False
        except (OSError, KeyError, ValueError):
            return False
    return True


def purge_results(d: Path) -> None:
    """Redo complet : les anciennes transcriptions (résultats, zones, brut)
    partent — sinon un redo annulé mélangeait ancien et nouveau texte à
    l'export, à la recherche et à l'indexation."""
    for sub in ("result", "boxes", "raw"):
        folder = d / sub
        if not folder.is_dir():
            continue
        for f in folder.iterdir():
            try:
                f.unlink()
            except OSError:
                pass


def load_page(d: Path, n: int) -> Dict[str, Any]:
    """Contenu d'une page pour l'UI : markdown courant + boxes + méta page.

    ⚠ ``boxes`` retourné = la LISTE des zones (boxes/NNNN.json) — dans
    meta.json, la même clé porte leur NOMBRE (compteur d'affichage).
    """
    meta = read_meta(d)
    page = next((p for p in meta.get("pages", []) if p.get("n") == n), None)
    if page is None:
        raise FileNotFoundError(f"page {n}")
    rp, bp = page_result_path(d, n), page_boxes_path(d, n)
    md = rp.read_text(encoding="utf-8") if rp.is_file() else ""
    try:
        boxes = json.loads(bp.read_text(encoding="utf-8")) if bp.is_file() else []
    except ValueError:
        boxes = []
    return {"n": n, "md": md, "boxes": boxes, **{k: page.get(k) for k in
            ("w", "h", "status", "edited", "divergence", "chars")}}


def summary(meta: Dict[str, Any]) -> Dict[str, Any]:
    """Sous-ensemble de meta pour la liste (sans le détail des pages)."""
    out = {k: meta.get(k) for k in
           ("id", "name", "ext", "status", "error", "created_at",
            "updated_at", "pages_total", "pages_done", "truncated", "model",
            "tags")}
    rag = meta.get("rag")
    if isinstance(rag, dict):   # badge « Indexé » / « périmé » de la liste
        out["rag"] = {k: rag.get(k) for k in ("collection", "indexed_at", "stale")}
    return out


def reconcile_stale(d: Path, meta: Dict[str, Any],
                    running_probe: Optional[Callable[[str], bool]] = None
                    ) -> Dict[str, Any]:
    """Requalifie en erreur un job « running » au heartbeat figé (crash).

    ``running_probe(doc_id)`` : prédicat « une task tourne DANS CE process »
    (fourni par jobs) — un job vivant local n'est jamais requalifié même si
    l'horloge dérive.
    """
    if meta.get("status") not in ("preparing", "running"):
        return meta
    if running_probe and running_probe(meta.get("id", "")):
        return meta
    if time.time() - float(meta.get("heartbeat_at") or 0) <= STALE_SEC:
        return meta

    def _mut(m: Dict[str, Any]) -> None:
        # Re-check sous verrou : une autre task peut avoir conclu entre-temps.
        if m.get("status") not in ("preparing", "running"):
            return
        m["status"] = "error"
        m["error"] = "Traitement interrompu (serveur redémarré ?). Relancez le document."
        for p in m.get("pages", []):
            if p.get("status") == "running":
                p["status"] = "error"
    return update_meta(d, _mut)


def _corrupt_summary(child: Path) -> Dict[str, Any]:
    """Entrée de liste d'un document au meta.json illisible : il reste
    VISIBLE (et donc supprimable depuis l'UI) au lieu de disparaître en
    gardant ses fichiers sur disque."""
    try:
        created = child.stat().st_mtime
    except OSError:
        created = 0
    return {"id": child.name, "name": child.name, "ext": "", "status": "error",
            "error": "État du document illisible (meta.json corrompu) — "
                     "supprimez-le puis déposez-le à nouveau.",
            "created_at": created, "updated_at": created, "pages_total": 0,
            "pages_done": 0, "truncated": False, "model": "", "tags": [],
            "corrupt": True}


def list_docs(running_probe: Optional[Callable[[str], bool]] = None
              ) -> List[Dict[str, Any]]:
    """Liste des documents (récents d'abord), réconciliée."""
    out: List[Dict[str, Any]] = []
    root = ocr_root()
    for child in root.iterdir():
        try:
            if not (child.is_dir() and _DOC_ID_RE.match(child.name)
                    and (child / "meta.json").is_file()):
                continue
            meta = reconcile_stale(child, read_meta(child), running_probe)
        except FileNotFoundError:
            continue   # supprimé pendant le parcours
        except (ValueError, OSError):
            out.append(_corrupt_summary(child))
            continue
        out.append(summary(meta))
    out.sort(key=lambda m: m.get("created_at") or 0, reverse=True)
    return out


def count_docs() -> int:
    root = ocr_root()
    return sum(1 for c in root.iterdir()
               if _DOC_ID_RE.match(c.name) and (c / "meta.json").is_file())


def iter_page_markdown(d: Path, meta: Dict[str, Any]) -> Iterator[Tuple[int, str]]:
    """``(n, markdown)`` des pages ayant un ``result/NNNN.md`` — dans l'ordre
    des pages. Point unique pour l'export, l'indexation RAG et la recherche
    (même règle de lecture partout)."""
    for p in meta.get("pages", []):
        n = int(p["n"])
        rp = page_result_path(d, n)
        try:
            text = rp.read_text(encoding="utf-8")
        except OSError:
            continue   # absente, ou document supprimé pendant la lecture
        yield n, text


def disk_usage() -> int:
    """Octets occupés par le store OCR — parcours complet (exact)."""
    total = 0
    for dirpath, _dirs, files in os.walk(ocr_root()):
        for name in files:
            try:
                total += os.stat(os.path.join(dirpath, name)).st_size
            except OSError:
                continue
    return total


# Cache du total disque pour le quota d'upload : le parcours complet (jusqu'à
# ~300 000 stat à pleine capacité) ne tourne plus à CHAQUE dépôt. Le total est
# ajusté à la main entre deux parcours (dépôt, raster, suppression).
_DISK_TTL_SEC = 60.0
_DISK = {"at": 0.0, "bytes": 0}
_DISK_LOCK = threading.Lock()


def disk_usage_cached() -> int:
    root = str(ocr_root())
    with _DISK_LOCK:
        if _DISK.get("root") == root and \
                time.monotonic() - _DISK["at"] < _DISK_TTL_SEC:
            return int(_DISK["bytes"])
    total = disk_usage()
    with _DISK_LOCK:
        _DISK["at"], _DISK["bytes"], _DISK["root"] = time.monotonic(), total, root
    return total


def disk_usage_add(delta: int) -> None:
    """Ajuste le total en cache (octets écrits/libérés depuis le parcours)."""
    with _DISK_LOCK:
        if _DISK["at"]:
            _DISK["bytes"] = max(0, int(_DISK["bytes"]) + int(delta))


def invalidate_disk_usage() -> None:
    with _DISK_LOCK:
        _DISK["at"] = 0.0


_TRASH_PREFIX = ".trash-"


def delete_doc(doc_id: str) -> None:
    """Suppression d'un document : RENOMMAGE atomique vers un dossier
    ``.trash-*`` puis rmtree.

    Le renommage fait disparaître le document d'un coup (liste, doc_dir) ; un
    thread encore en train d'écrire (job annulé qui termine son appel) vise
    l'ancien chemin et échoue au lieu de recréer un dossier fantôme — les
    écritures ne recréent jamais le dossier du document. Un rmtree qui
    échoue (ENOTEMPTY sur une écriture concurrente) est rejoué une fois ;
    un reste éventuel est purgé au démarrage suivant (:func:`purge_trash`).
    """
    d = doc_dir(doc_id)
    trash = d.with_name(f"{_TRASH_PREFIX}{doc_id}-{secrets.token_hex(3)}")
    os.replace(d, trash)
    invalidate_disk_usage()
    for attempt in range(2):
        try:
            shutil.rmtree(trash)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt:
                logger.warning("[ocr] suppression incomplète de %s — purgée au "
                               "prochain démarrage", trash.name)
            time.sleep(0.2)


def purge_trash() -> int:
    """Supprime les restes de suppressions interrompues. Retourne le nombre
    de dossiers purgés."""
    n = 0
    try:
        children = list(ocr_root().iterdir())
    except OSError:
        return 0
    for child in children:
        if child.name.startswith(_TRASH_PREFIX) and child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
            n += 1
    return n


# ─────────────────────────────────────────────────────────────────────────────
#  Recherche plein texte dans les transcriptions
# ─────────────────────────────────────────────────────────────────────────────
_SNIPPET_RADIUS = 60
# Plafond de FICHIERS LUS par recherche : max_page_hits borne les résultats,
# pas les lectures — sans ce cap, 200 docs × 300 pages = 60 000 read_text
# possibles pour une requête sans correspondance.
_MAX_SCAN_FILES = 2000


def search_docs(query: str, max_page_hits: int = 200) -> Dict[str, Any]:
    """Recherche (insensible à la casse) dans les ``result/*.md`` du store.
    Retourne ``{items: [{id, name, total, pages: [{n, count, snippet}]}],
    partial: bool}``, documents les plus récents d'abord — ``partial`` vrai
    si le scan a été tronqué (plafond de lectures/hits).
    """
    needle = (query or "").strip().lower()
    if len(needle) < 2:
        return {"items": [], "partial": False}
    hits = 0
    scanned = 0
    partial = False
    out: List[Dict[str, Any]] = []
    root = ocr_root()
    def _mtime(c: Path) -> float:
        # Un document supprimé pendant le tri ne fait plus échouer la
        # recherche (FileNotFoundError hors de tout try → 500).
        try:
            return c.stat().st_mtime
        except OSError:
            return 0.0
    docs = sorted((c for c in root.iterdir()
                   if _DOC_ID_RE.match(c.name) and (c / "meta.json").is_file()),
                  key=_mtime, reverse=True)
    for child in docs:
        try:
            meta = read_meta(child)
        except (ValueError, OSError):
            continue
        pages_out = []
        for n, text in iter_page_markdown(child, meta):
            scanned += 1
            folded = text.lower()
            count = folded.count(needle)
            if count:
                idx = folded.find(needle)
                start = max(0, idx - _SNIPPET_RADIUS)
                end = min(len(text), idx + len(needle) + _SNIPPET_RADIUS)
                snippet = (("…" if start else "")
                           + text[start:end].replace("\n", " ")
                           + ("…" if end < len(text) else ""))
                pages_out.append({"n": n, "count": count, "snippet": snippet})
                hits += 1
            if hits >= max_page_hits or scanned >= _MAX_SCAN_FILES:
                partial = True
                break
        if pages_out:
            out.append({"id": meta.get("id"), "name": meta.get("name"),
                        "total": sum(x["count"] for x in pages_out),
                        "pages": pages_out})
        if partial:
            break
    return {"items": out, "partial": partial}
