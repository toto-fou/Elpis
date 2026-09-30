# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_rag_index.py — pont d'indexation RAG in-process.

Le chatbot passait par HTTP (``_rag_client``) ; ici l'adapter appelle
DIRECTEMENT ``RAGEngine.index_document_chunks``/``deindex_document`` via la
factory ``_engine()`` — patchée dans ces tests (jamais d'import du vrai
``rag_engine`` : pdf2docx crash le sandbox dev). Couvre : découpage par page
(en-têtes ``[doc — page N]``, split des pages longues), rel_path/extra_meta
(SANS ocr_user), état ``meta.rag`` posé/purgé, best-effort à la
désindexation, marquage ``stale``, et l'isolation state_file/collection de
la factory (RAGEngine stubé dans sys.modules).
"""
from __future__ import annotations

import sys
import types

import pytest

from rag_app.ocr import rag_index as R, store
from rag_app.ocr._common import OcrError


class _FakeEngine:
    """Simulacre de RAGEngine : enregistre les appels, répond ok."""

    def __init__(self, calls, ok=True):
        self.cfg = {"collection": "ocr-documents"}
        self._calls = calls
        self._ok = ok

    def index_document_chunks(self, rel_path, chunks, extra_meta=None):
        self._calls.append(("index", rel_path, chunks, extra_meta,
                            self.cfg["collection"]))
        if not self._ok:
            return {"ok": False, "msg": "embedder muet"}
        return {"ok": True, "chunks": len(chunks),
                "collection": self.cfg["collection"],
                "rel_path": rel_path, "name": rel_path}

    def deindex_document(self, rel_path):
        self._calls.append(("deindex", rel_path, self.cfg["collection"]))
        return {"ok": True, "deleted_file": True}


@pytest.fixture
def root(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "ocr_root", lambda: tmp_path)
    monkeypatch.setattr(R, "get_ocr_config",
                        lambda: {"collection": "ocr-documents",
                                 "state_file": "rag_ocr_state.json",
                                 "auto_index": False})
    return tmp_path


def _fake_engine(monkeypatch, ok=True, calls=None):
    calls = calls if calls is not None else []
    monkeypatch.setattr(R, "_engine", lambda: _FakeEngine(calls, ok=ok))
    return calls


def _doc_transcrit(pages):
    d = store.create_doc("Rapport d'essai.pdf", ".pdf")
    metas = []
    for i, md in enumerate(pages, start=1):
        store.page_result_path(d, i).write_text(md, encoding="utf-8")
        metas.append({"n": i, "w": 100, "h": 100, "chars": 0, "status": "done",
                      "edited": False, "divergence": None, "boxes": 0})
    meta = store.update_meta(d, lambda m: (
        m.__setitem__("pages", metas),
        m.__setitem__("pages_total", len(pages)),
        m.__setitem__("pages_done", len(pages)),
        m.__setitem__("status", "done")))
    return d, meta


def test_doc_chunks_en_tete_et_split(root):
    longue = "Para un. " * 400 + "\n\n" + "Para deux. " * 400
    d, meta = _doc_transcrit(["# Page une", longue, ""])   # p3 vide → sautée
    chunks = R.doc_chunks(d, meta)
    assert chunks[0]["page"] == 1
    assert chunks[0]["text"].startswith("[Rapport d'essai.pdf — page 1]\n")
    # la page 2 déborde → sous-découpée, page CONSERVÉE sur chaque morceau
    p2 = [c for c in chunks if c["page"] == 2]
    assert len(p2) >= 2
    assert all(c["text"].startswith("[Rapport d'essai.pdf — page 2]") for c in p2)
    assert all(len(c["text"]) <= R._MAX_CHUNK_CHARS + 100 for c in chunks)
    assert not any(c["page"] == 3 for c in chunks)


def test_index_doc_payload_et_meta(root, monkeypatch):
    d, meta = _doc_transcrit(["# Contenu"])
    calls = _fake_engine(monkeypatch)
    rag = R.index_doc(meta["id"])
    kind, rel_path, chunks, extra_meta, col = calls[0]
    assert kind == "index"
    assert col == "ocr-documents"                     # collection mono-tenant
    # rel_path déterministe : <stem assaini>--<8 hex du doc_id>.md
    assert rel_path == f"Rapport-d-essai--{meta['id'][-8:]}.md"
    assert chunks[0]["page"] == 1
    assert chunks[0]["text"].startswith("[Rapport d'essai.pdf — page 1]\n")
    # extra_meta SANS ocr_user (service mono-tenant)
    assert extra_meta == {"ocr_doc_id": meta["id"],
                          "document": "Rapport d'essai.pdf"}
    assert "ocr_user" not in extra_meta
    # meta.rag posé, non périmé
    stored = store.read_meta(d)["rag"]
    assert stored["collection"] == "ocr-documents" and stored["stale"] is False
    assert stored["rel_path"] == rel_path
    assert rag["chunks"] == 1
    # et exposé dans le summary (badge de liste)
    assert store.summary(store.read_meta(d))["rag"]["stale"] is False


def test_index_doc_collection_surchargee(root, monkeypatch):
    d, meta = _doc_transcrit(["# Contenu"])
    calls = _fake_engine(monkeypatch)
    rag = R.index_doc(meta["id"], "collection-perso")
    assert calls[0][4] == "collection-perso"          # cfg mutée avant l'appel
    assert rag["collection"] == "collection-perso"
    assert store.read_meta(d)["rag"]["collection"] == "collection-perso"


def test_index_doc_erreurs_douces(root, monkeypatch):
    # engine qui répond ok:false → OcrError avec le message utilisateur
    d, meta = _doc_transcrit(["# Contenu"])
    _fake_engine(monkeypatch, ok=False)
    with pytest.raises(OcrError, match="embedder muet"):
        R.index_doc(meta["id"])
    assert "rag" not in store.read_meta(d)            # rien posé sur échec
    # document sans transcription : refus AVANT tout appel engine
    d2 = store.create_doc("vide.pdf", ".pdf")
    calls = _fake_engine(monkeypatch)
    with pytest.raises(OcrError):
        R.index_doc(store.read_meta(d2)["id"])
    assert calls == []


def test_deindex_doc_best_effort(root, monkeypatch):
    d, meta = _doc_transcrit(["# Contenu"])
    _fake_engine(monkeypatch)
    R.index_doc(meta["id"])
    # service en panne → False, JAMAIS d'exception (suppression non bloquée)
    def boom():
        raise RuntimeError("qdrant down")
    monkeypatch.setattr(R, "_engine", boom)
    assert R.deindex_doc(meta["id"]) is False
    assert store.read_meta(d).get("rag")              # état conservé
    # service revenu → purge de meta.rag, désindexation sur le bon rel_path
    calls = _fake_engine(monkeypatch)
    assert R.deindex_doc(meta["id"]) is True
    assert calls[0][0] == "deindex"
    assert calls[0][1].endswith(f"--{meta['id'][-8:]}.md")
    assert "rag" not in store.read_meta(d)
    # doc jamais indexé → False sans appel
    d3, m3 = _doc_transcrit(["x"])
    calls2 = _fake_engine(monkeypatch)
    assert R.deindex_doc(m3["id"]) is False
    assert calls2 == []


def test_mark_stale(root, monkeypatch):
    d, meta = _doc_transcrit(["# Contenu"])
    _fake_engine(monkeypatch)
    R.index_doc(meta["id"])
    R.mark_stale(d)
    assert store.read_meta(d)["rag"]["stale"] is True
    R.mark_stale(d)   # idempotent
    assert store.read_meta(d)["rag"]["stale"] is True
    # sans meta.rag : no-op silencieux
    d2 = store.create_doc("autre.pdf", ".pdf")
    R.mark_stale(d2)
    assert "rag" not in store.read_meta(d2)


def test_engine_factory_isole_collection_et_state(root, monkeypatch):
    """La factory _engine() (non patchée) cible la collection OCR et un
    state_file SÉPARÉ (rag_ocr_state.json) : le startup_reembed_check de la
    collection par défaut ne doit jamais adopter les miroirs OCR. Le vrai
    RAGEngine est stubé dans sys.modules (pdf2docx crash le sandbox)."""
    captured = {}

    class FakeRAGEngine:
        def __init__(self, cfg_path):
            captured["cfg_path"] = cfg_path
            self.cfg = {"collection": "exigences",
                        "state_file": "rag_state.json"}
    fake_mod = types.ModuleType("rag_engine")
    fake_mod.RAGEngine = FakeRAGEngine
    monkeypatch.setitem(sys.modules, "rag_engine", fake_mod)

    eng = R._engine()
    assert isinstance(eng, FakeRAGEngine)
    assert captured["cfg_path"].endswith("rag_config.json")
    assert eng.cfg["collection"] == "ocr-documents"
    assert eng.cfg["state_file"].endswith("rag_ocr_state.json")
    assert eng.cfg["state_file"] != "rag_ocr_state.json"   # résolu ABSOLU


def test_reindexation_vers_une_autre_collection_retire_l_ancienne(root, monkeypatch):
    """(2026-09-21) Les chunks restaient dans la première collection."""
    d, meta = _doc_transcrit(["# Contenu"])
    calls = _fake_engine(monkeypatch)
    R.index_doc(meta["id"])                                    # ocr-documents
    R.index_doc(meta["id"], "collection-perso")
    kinds = [(c[0], c[-1]) for c in calls]
    assert kinds == [("index", "ocr-documents"), ("deindex", "ocr-documents"),
                     ("index", "collection-perso")]
    # Même collection : pas de retrait préalable (écrasement idempotent).
    calls.clear()
    R.index_doc(meta["id"], "collection-perso")
    assert [c[0] for c in calls] == ["index"]


def test_reindexation_refusee_si_l_ancienne_ne_part_pas(root, monkeypatch):
    d, meta = _doc_transcrit(["# Contenu"])
    _fake_engine(monkeypatch)
    R.index_doc(meta["id"])

    class _Muet(_FakeEngine):
        def deindex_document(self, rel_path):
            return {"ok": False, "msg": "qdrant down"}
    monkeypatch.setattr(R, "_engine", lambda: _Muet([]))
    with pytest.raises(OcrError):
        R.index_doc(meta["id"], "autre")
    assert store.read_meta(d)["rag"]["collection"] == "ocr-documents"
