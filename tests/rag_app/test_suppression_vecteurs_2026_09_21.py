# SPDX-License-Identifier: MIT
"""Audit 2026-09-21 (H6) — la suppression des vecteurs ne s'avale plus."""
from __future__ import annotations

import httpx
import pytest

from rag_app import rag_engine as E


def _engine(tmp_path, monkeypatch, handler):
    monkeypatch.setattr(E, "BASE_DIR", tmp_path)
    cfg = {"collection": "col1", "qdrant_url": "http://q.test:6333",
           "embed_base_url": "http://emb.test", "embed_model": "bge-m3",
           "state_file": str(tmp_path / "state.json"), "allowed_ext": [".txt"]}
    p = tmp_path / "rag_config.json"
    import json
    p.write_text(json.dumps(cfg), encoding="utf-8")
    eng = E.RAGEngine(str(p), http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    return eng


def test_qdrant_en_erreur_leve(tmp_path, monkeypatch):
    eng = _engine(tmp_path, monkeypatch, lambda r: httpx.Response(500))
    with pytest.raises(RuntimeError):
        eng.delete_file_points("/data/a.txt")


def test_collection_absente_est_un_succes(tmp_path, monkeypatch):
    eng = _engine(tmp_path, monkeypatch, lambda r: httpx.Response(404))
    eng.delete_file_points("/data/a.txt")


def test_delete_file_ne_retire_rien_si_qdrant_refuse(tmp_path, monkeypatch):
    eng = _engine(tmp_path, monkeypatch, lambda r: httpx.Response(503))
    full = eng._safe_data_path("a.txt")
    if full is None:
        pytest.skip("dossier DATA non résolu dans ce montage")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text("x", encoding="utf-8")
    out = eng.delete_file("a.txt")
    assert out["ok"] is False and full.exists()


# ── H7 : indexation partielle / texte d'erreur d'extraction ────────────────

def test_index_incomplete():
    assert E._index_incomplete(3, 5) and "3/5" in E._index_incomplete(3, 5)
    assert E._index_incomplete(5, 5) is None and E._index_incomplete(0, 0) is None


def test_extraction_en_erreur_refusee(tmp_path, monkeypatch):
    eng = _engine(tmp_path, monkeypatch, lambda r: httpx.Response(200, json={}))
    monkeypatch.setattr(eng, "extract_text", lambda p: "[Erreur PDF : fichier chiffré]")
    with pytest.raises(E.ExtractionError):
        eng.extract_text_strict(tmp_path / "a.pdf")
    monkeypatch.setattr(eng, "extract_text", lambda p: "[Erreur PDF : x]\nsuite du vrai texte")
    assert eng.extract_text_strict(tmp_path / "a.pdf").startswith("[Erreur")


def test_reindexation_partielle_non_marquee(tmp_path, monkeypatch):
    eng = _engine(tmp_path, monkeypatch, lambda r: httpx.Response(200, json={}))
    full = eng._safe_data_path("a.txt")
    if full is None:
        pytest.skip("dossier DATA non résolu dans ce montage")
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text("un deux trois", encoding="utf-8")
    key = str(full)
    eng._update_state(lambda s: s["files"].__setitem__(key, {"mtime": 1, "hash": "ancien"}))
    monkeypatch.setattr(eng, "ensure_collection", lambda *a, **k: None)
    monkeypatch.setattr(eng, "chunk_text", lambda *a, **k: [
        {"index": i, "text": f"c{i}"} for i in range(4)])
    monkeypatch.setattr(eng, "get_embeddings", lambda texts: [[0.1]] * (len(texts) - 1) + [[]])
    monkeypatch.setattr(eng, "upsert_points", lambda pts, **k: len(pts))
    out = eng.reindex_single_file("a.txt")
    assert out["ok"] is False and "3/4" in out["msg"]
    import json
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert key not in state.get("files", {})


# ── M8 : empreinte d'index ──────────────────────────────────────────────────

def test_changement_de_modele_signale(tmp_path, monkeypatch):
    eng = _engine(tmp_path, monkeypatch, lambda r: httpx.Response(200, json={}))
    assert eng.index_fingerprint_changed({"embed_model": "autre"}) is True
    assert eng.index_fingerprint_changed({"embed_model": "bge-m3", "top_k": 3}) is False
