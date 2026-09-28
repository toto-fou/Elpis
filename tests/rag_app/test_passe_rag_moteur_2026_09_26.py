# SPDX-License-Identifier: MIT
"""tests/rag_app/test_passe_rag_moteur_2026_09_26.py — passe RAG 2026-09-26,
partie MOTEUR d'ingestion (rag_engine) : remplacement atomique d'un document,
verrou d'index attendu, chevauchement borné.

⚠ S'appuie sur l'audit RAG du 2026-09-21 (``_index_incomplete``,
``_discard_partial``…), non commité au moment de l'écriture : ce fichier part
avec ce chantier.
"""
from __future__ import annotations

import json
import threading
import time

import httpx
import pytest

from rag_app import rag_engine as E


# ── Remplacement atomique ────────────────────────────────────────────────────

@pytest.fixture
def eng(monkeypatch, tmp_path):
    cfg_path = tmp_path / "rag_config.json"
    cfg_path.write_text(json.dumps({
        "collection": "c1", "qdrant_url": "http://qdrant.test:6333",
        "embed_base_url": "http://emb.test", "embed_model": "m",
        "state_file": str(tmp_path / "rag_state.json"), "batch_embed": 2,
    }), encoding="utf-8")
    engine = E.RAGEngine(str(cfg_path))
    data_dir = tmp_path / "DATA" / "c1"
    data_dir.mkdir(parents=True)
    monkeypatch.setattr(E.RAGEngine, "get_current_data_dir", lambda self: data_dir)
    calls = {"ops": []}
    monkeypatch.setattr(engine, "ensure_collection", lambda: None)
    monkeypatch.setattr(engine, "delete_file_points",
                        lambda path: calls["ops"].append(("delete_all", path)))
    monkeypatch.setattr(engine, "delete_stale_points",
                        lambda path, keep: calls["ops"].append(("stale", sorted(keep))))
    monkeypatch.setattr(engine, "upsert_points",
                        lambda pts, **kw: calls["ops"].append(("upsert", len(pts))) or len(pts))
    engine._calls = calls
    engine._dir = data_dir
    return engine


def test_ecriture_avant_nettoyage(eng, monkeypatch):
    monkeypatch.setattr(eng, "get_embeddings", lambda texts, **kw: [[0.1]] * len(texts))
    res = eng.index_document_chunks("d.md", [{"text": t} for t in "abc"])
    assert res["ok"] is True
    ops = [o[0] for o in eng._calls["ops"]]
    assert "delete_all" not in ops, "plus de purge AVANT les embeddings"
    assert ops[-1] == "stale" and eng._calls["ops"][-1][1] == [0, 1, 2]
    assert (eng._dir / "d.md").read_text() == "a\n\nb\n\nc"


def test_embedder_muet_laisse_l_ancien_index(eng, monkeypatch):
    (eng._dir / "d.md").write_text("ancienne version")
    monkeypatch.setattr(eng, "get_embeddings", lambda texts, **kw: [[] for _ in texts])
    res = eng.index_document_chunks("d.md", [{"text": "nouveau"}])
    assert res["ok"] is False and res.get("discarded") is False
    assert not [o for o in eng._calls["ops"] if o[0] != "upsert"], \
        "rien ne doit être supprimé si rien n'est écrit"
    assert (eng._dir / "d.md").read_text() == "ancienne version"


def test_ecriture_partielle_retire_tout(eng, monkeypatch):
    lots = iter([[[0.1], [0.1]], [[]]])           # 2 écrits puis panne
    monkeypatch.setattr(eng, "get_embeddings", lambda texts, **kw: next(lots))
    res = eng.index_document_chunks("d.md", [{"text": t} for t in "abc"])
    assert res["ok"] is False and res["discarded"] is True
    assert ("delete_all", eng._normalize_path(str(eng._dir / "d.md"))) in eng._calls["ops"]


def test_filtre_de_nettoyage(monkeypatch, tmp_path):
    vus = []

    def handler(request):
        vus.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "ok"})
    cfg_path = tmp_path / "c.json"
    cfg_path.write_text(json.dumps({"collection": "c", "qdrant_url": "http://q",
                                    "state_file": str(tmp_path / "s.json")}))
    eng = E.RAGEngine(str(cfg_path),
                      http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    eng.delete_stale_points("docs/a.md", [2, 0, 1])
    flt = vus[0]["filter"]
    assert flt["must"][0]["key"] == "path"
    assert flt["must_not"] == [{"key": "chunk_index", "match": {"any": [0, 1, 2]}}]


def test_verrou_d_index_attendu_puis_occupe():
    assert E._INGEST_LOCK.acquire(blocking=False)
    try:
        t0 = time.monotonic()
        with pytest.raises(E.IngestionEnCours):
            with E.index_op(0.2):
                pass
        assert time.monotonic() - t0 >= 0.19
    finally:
        E._INGEST_LOCK.release()
    libere = threading.Timer(0.1, lambda: None)
    with E.index_op(1.0):                          # libre : obtenu tout de suite
        pass
    libere.cancel()


def test_chevauchement_borne(eng):
    chunks = eng._chunk_by_size("x" * 10_000, 1000, 999)
    assert len(chunks) <= 25, f"{len(chunks)} chunks : pas d'un caractère"


