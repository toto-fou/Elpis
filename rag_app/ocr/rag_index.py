# SPDX-License-Identifier: MIT
"""rag_app.ocr.rag_index — indexation RAG des transcriptions OCR (in-process).

Le chatbot passait par HTTP (``llm_core._rag_client`` → ``/api/tools/
rag_index_document``) ; hébergé DANS rag_app, le pont devient un appel
direct à ``RAGEngine.index_document_chunks`` / ``deindex_document`` — mêmes
garanties (ensure_collection, miroir ``DATA/<collection>/<rel_path>``,
upsert idempotent), zéro réseau.

Choix mono-tenant :
- collection UNIQUE ``ocr.collection`` (défaut ``ocr-documents``),
  surchargeable par requête ;
- ``state_file`` SÉPARÉ (``ocr.state_file``) : le ``startup_reembed_check``
  de la collection par défaut ne voit jamais les miroirs OCR ;
- la page ne TRAVERSE pas la recherche (les hits ne remontent que
  source/texte) → chaque chunk commence par un en-tête ``[<doc> — page N]``
  dans le TEXTE ; le payload ``page`` est posé pour la suite (citations
  visuelles cliquables) ;
- ``rel_path``/``name`` déterministes par doc (suffixe ``--<8 hex>`` du
  doc_id) : réindexer ÉCRASE, jamais de doublon.

État côté doc : ``meta["rag"] = {collection, rel_path, name, indexed_at,
chunks, stale, rev}`` — ``stale`` est posé par toute mutation de
transcription (édition, re-run, redo complet, page reconnue pendant un job)
ET recalculé en fin d'indexation : ``meta.rev`` lu au départ ≠ ``meta.rev`` à
la fin (une page modifiée PENDANT l'embedding), ou document pas entièrement
transcrit (index partiel) ⇒ ``stale`` reste vrai.
"""
from __future__ import annotations

import re
import time
from typing import Any, Dict, List

from . import store as ocr_store
from ._common import OcrError
from .config import BASE_DIR, get_ocr_config

# Une page trop longue est sous-découpée par paragraphes (même n° de page) :
# un chunk d'embedding n'a pas à porter 30 000 caractères.
_MAX_CHUNK_CHARS = 6000


def _engine():
    """Instance FRAÎCHE de RAGEngine ciblant la collection OCR.

    Même patron que ``app._engine_for`` (instance dédiée à l'appel — le
    service est concurrent, muter ``engine.cfg`` global serait une course),
    répliqué ici pour éviter le cycle d'import ``ocr → app``. Import tardif
    et tolérant aux deux contextes (service ``rag_engine`` / tests
    ``rag_app.rag_engine``).
    """
    try:
        from rag_engine import RAGEngine          # service (cwd = rag_app/)
    except ImportError:
        from rag_app.rag_engine import RAGEngine  # tests (cwd = repo)
    cfg = get_ocr_config()
    eng = RAGEngine(str(BASE_DIR / "rag_config.json"))
    eng.cfg["collection"] = collection_for()
    # Isolation de l'état : fichier dédié, résolu contre rag_app/ (le
    # _load_state de l'engine résout les chemins relatifs contre le cwd).
    eng.cfg["state_file"] = str(BASE_DIR / (cfg.get("state_file")
                                            or "rag_ocr_state.json"))
    return eng


def _invalidate_query_cache() -> None:
    """Le cache « documents indexés » de rag_query (TTL 30 s) est vidé :
    les outils du chatbot voient l'ajout/retrait tout de suite. Best-effort."""
    try:
        try:
            from rag_query import invalidate_docs_cache          # service
        except ImportError:
            from rag_app.rag_query import invalidate_docs_cache  # tests
        invalidate_docs_cache()
    except Exception:  # noqa: BLE001
        pass


def collection_for() -> str:
    """Collection cible : ``ocr.collection`` (défaut ``ocr-documents``)."""
    return (get_ocr_config().get("collection") or "ocr-documents").strip()


def doc_rag_name(meta: Dict[str, Any]) -> str:
    """Nom de fichier stable et unique dans la collection."""
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-",
                  str(meta.get("name") or "document").rsplit(".", 1)[0]).strip("-")
    return f"{stem or 'document'}--{str(meta.get('id'))[-8:]}.md"


def doc_chunks(d, meta: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Un chunk par page transcrite, en-tête ``[<doc> — page N]`` en tête ;
    pages longues sous-découpées par paragraphes (page conservée)."""
    doc_name = str(meta.get("name") or "document")
    chunks: List[Dict[str, Any]] = []
    for n, md in ocr_store.iter_page_markdown(d, meta):
        header = f"[{doc_name} — page {n}]\n"
        body = md.strip()
        if not body:
            continue
        if len(body) <= _MAX_CHUNK_CHARS:
            chunks.append({"text": header + body, "page": n})
            continue
        acc = ""
        for para in body.split("\n\n"):
            if acc and len(acc) + len(para) + 2 > _MAX_CHUNK_CHARS:
                chunks.append({"text": header + acc, "page": n})
                acc = ""
            acc = (acc + "\n\n" + para) if acc else para
        if acc:
            chunks.append({"text": header + acc, "page": n})
    return chunks


def index_doc(doc_id: str, collection: str = "") -> Dict[str, Any]:
    """Indexe (ou RÉindexe — écrasement idempotent) un document transcrit.

    SYNCHRONE (embeddings httpx côté engine) : à appeler depuis un
    threadpool. Succès → ``meta["rag"]`` posé.
    :raises OcrError: message utilisateur.
    """
    d = ocr_store.doc_dir(doc_id)
    meta = ocr_store.read_meta(d)
    rev0 = int(meta.get("rev") or 0)
    partial = (meta.get("status") != "done"
               or any(p.get("status") != "done" for p in meta.get("pages") or []))
    chunks = doc_chunks(d, meta)
    if not chunks:
        raise OcrError("Ce document n'a pas encore de transcription.")
    col = (collection or "").strip() or collection_for()
    name = doc_rag_name(meta)
    # (2026-09-21) Réindexation vers une AUTRE collection (ou sous un autre
    # nom) : l'ancienne indexation est retirée d'abord — sinon ses chunks et
    # son fichier miroir restaient dans la première collection, orphelins.
    old = meta.get("rag") or {}
    if old.get("rel_path") and ((old.get("collection") or "") != col
                                or old.get("rel_path") != name):
        if not deindex_doc(doc_id):
            raise OcrError("Retrait de l'indexation précédente impossible "
                           "(Qdrant injoignable ?) — réessayez.")
    eng = _engine()
    try:
        eng.cfg["collection"] = col
        res = eng.index_document_chunks(
            name, chunks,
            extra_meta={"ocr_doc_id": doc_id, "document": meta.get("name") or ""})
    finally:
        # L'engine éphémère possède son client httpx : sans close(), chaque
        # indexation fuyait un pool de connexions.
        close = getattr(eng, "close", None)
        if callable(close):
            close()
    if not isinstance(res, dict) or not res.get("ok"):
        msg = (res or {}).get("msg") if isinstance(res, dict) else ""
        if isinstance(res, dict) and res.get("discarded"):
            _invalidate_query_cache()
            # Passe RAG 2026-09-26 — l'index partiel a été retiré : ``meta["rag"]``
            # continuait d'afficher « indexé, à jour » pour un document devenu
            # introuvable. (Sans écriture, l'ancien index reste servi et
            # l'état reste vrai.)
            try:
                ocr_store.update_meta(d, lambda m: m.pop("rag", None))
            except (FileNotFoundError, ValueError, OSError):
                pass
        raise OcrError(f"Indexation RAG impossible : {msg or 'erreur interne'}")
    rag = {"collection": res.get("collection") or col,
           "rel_path": res.get("rel_path") or name,
           "name": res.get("name") or name,
           "indexed_at": time.time(),
           "chunks": int(res.get("chunks") or len(chunks)),
           "stale": partial,
           "rev": rev0}

    def _set(m: Dict[str, Any]) -> None:
        cur = dict(rag)
        if int(m.get("rev") or 0) != rev0:
            cur["stale"] = True     # modifié pendant l'indexation
        m["rag"] = cur
        rag.update(cur)
    _invalidate_query_cache()
    try:
        ocr_store.update_meta(d, _set)
    except FileNotFoundError:
        # Document supprimé PENDANT l'indexation : ses vecteurs viennent
        # d'être écrits sans plus aucun moyen de les retirer depuis l'UI —
        # on les retire ici.
        _drop_vectors(rag["collection"], rag["rel_path"])
        raise OcrError("Document supprimé pendant l'indexation — index retiré.")
    return rag


def _drop_vectors(collection: str, rel_path: str) -> bool:
    """Retire du RAG un miroir connu par (collection, rel_path) —
    best-effort, sans passer par meta (le document peut ne plus exister)."""
    try:
        eng = _engine()
        try:
            eng.cfg["collection"] = collection
            res = eng.deindex_document(rel_path)
        finally:
            close = getattr(eng, "close", None)
            if callable(close):
                close()
        _invalidate_query_cache()
        return isinstance(res, dict) and bool(res.get("ok"))
    except Exception:  # noqa: BLE001
        return False


def deindex_doc(doc_id: str) -> bool:
    """Désindexation BEST-EFFORT (suppression de doc, bouton Retirer) —
    ne lève jamais : un Qdrant éteint ne bloque pas une suppression."""
    try:
        d = ocr_store.doc_dir(doc_id)
        meta = ocr_store.read_meta(d)
        rag = meta.get("rag") or {}
        if not rag.get("rel_path"):
            return False
        eng = _engine()
        try:
            if rag.get("collection"):
                eng.cfg["collection"] = rag["collection"]
            res = eng.deindex_document(rag["rel_path"])
        finally:
            close = getattr(eng, "close", None)
            if callable(close):
                close()
        _invalidate_query_cache()
        if not (isinstance(res, dict) and res.get("ok")):
            return False
        try:
            ocr_store.update_meta(d, lambda m: m.pop("rag", None))
        except (FileNotFoundError, ValueError, OSError):
            pass   # vecteurs retirés : c'est le résultat qui compte
        return True
    except Exception:  # noqa: BLE001
        return False


def mark_stale(d) -> None:
    """La transcription a changé : l'index RAG ne la reflète plus."""
    try:
        meta = ocr_store.read_meta(d)
        if meta.get("rag") and not meta["rag"].get("stale"):
            ocr_store.update_meta(
                d, lambda m: m.get("rag", {}).__setitem__("stale", True))
    except (FileNotFoundError, ValueError, OSError):
        pass
