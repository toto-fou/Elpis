# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_rag_engine.py — indexation OCR côté rag_app.

``RAGEngine.index_document_chunks`` / ``deindex_document`` testés DIRECT
(pas de TestClient sur rag_app.app : son import détourne stdout au niveau
module). Les dépendances lourdes sont STUBÉES — seules les primitives
réseau de l'engine sont simulées (upsert/delete/embeddings enregistrés),
la logique testée est réelle.

⚠ pdf2docx est stubé SANS import de sonde : dans le sandbox dev, son import
(via cv2) tue le process en Bus error — même « essayer pour voir » est
fatal. Les autres deps utilisent la sonde (stub seulement si absentes).
"""
from __future__ import annotations

import json
import sys
import types

import pytest


def _stub_always(name: str, **attrs):
    """Stub inconditionnel (module présent mais MORTEL à importer : cv2)."""
    if name in sys.modules:
        return
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod


def _stub_missing(name: str, **attrs):
    if name in sys.modules:
        return
    try:
        __import__(name)
    except ImportError:
        mod = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(mod, k, v)
        sys.modules[name] = mod


_stub_always("pdf2docx", Converter=object)
_stub_missing("pandas")
_stub_missing("yaml", safe_load=lambda *a, **k: {}, safe_dump=lambda *a, **k: "")
_stub_missing("charset_normalizer", from_bytes=lambda b: None)

from rag_app import rag_engine as E  # noqa: E402


@pytest.fixture
def eng(monkeypatch, tmp_path):
    cfg_path = tmp_path / "rag_config.json"
    cfg_path.write_text(json.dumps({
        "collection": "ocr-u1", "qdrant_url": "http://qdrant.test:6333",
        "embed_base_url": "http://emb.test", "embed_model": "bge-m3",
        "state_file": str(tmp_path / "rag_state.json"), "batch_embed": 2,
    }), encoding="utf-8")
    engine = E.RAGEngine(str(cfg_path))
    data_dir = tmp_path / "DATA" / "ocr-u1"
    data_dir.mkdir(parents=True)
    monkeypatch.setattr(E.RAGEngine, "get_current_data_dir",
                        lambda self: data_dir)
    calls = {"upserts": [], "deletes": [], "stale": [], "ensured": 0, "embeds": []}
    monkeypatch.setattr(engine, "ensure_collection",
                        lambda: calls.__setitem__("ensured", calls["ensured"] + 1))
    monkeypatch.setattr(engine, "delete_file_points",
                        lambda path: calls["deletes"].append(path))
    monkeypatch.setattr(engine, "delete_stale_points",
                        lambda path, keep: calls["stale"].append((path, sorted(keep))))
    def _fake_upsert(pts, **kw):
        # Nouveau contrat : upsert_points retourne le nombre de points
        # ACCEPTÉS par Qdrant (0 = échec signalé à l'appelant).
        calls["upserts"].extend(pts)
        return len(pts)
    monkeypatch.setattr(engine, "upsert_points", _fake_upsert)
    monkeypatch.setattr(engine, "get_embeddings",
                        lambda texts, **kw: calls["embeds"].append(list(texts))
                        or [[0.1, 0.2]] * len(texts))
    engine._test_calls = calls
    engine._test_data_dir = data_dir
    return engine


def test_index_document_chunks(eng):
    chunks = [{"text": "[doc.pdf — page 1]\n# Titre", "page": 1},
              {"text": "[doc.pdf — page 2]\nSuite du texte", "page": 2},
              {"text": "[doc.pdf — page 2]\nDébordement", "page": 2}]
    res = eng.index_document_chunks("rapport--ab12cd34.md", chunks,
                                    extra_meta={"ocr_doc_id": "X", "ocr_user": 1})
    assert res["ok"] is True and res["chunks"] == 3
    assert res["collection"] == "ocr-u1"
    assert res["name"] == "rapport--ab12cd34.md"
    # fichier miroir écrit sous DATA/<collection>
    mirror = eng._test_data_dir / "rapport--ab12cd34.md"
    assert mirror.is_file() and "# Titre" in mirror.read_text(encoding="utf-8")
    calls = eng._test_calls
    assert calls["ensured"] == 1
    # Idempotence SANS trou (passe RAG 2026-09-26) : plus de purge avant
    # l'upsert — les points sont écrasés puis les anciens en trop retirés.
    assert calls["deletes"] == []
    assert len(calls["stale"]) == 1 and calls["stale"][0][1] == [0, 1, 2]
    # payload : page + méta OCR posées, schéma additif (clés standard intactes)
    pts = calls["upserts"]
    assert len(pts) == 3
    assert [p["payload"]["page"] for p in pts] == [1, 2, 2]
    assert all(p["payload"]["ocr_doc_id"] == "X" for p in pts)
    assert all(p["payload"]["name"] == "rapport--ab12cd34.md" for p in pts)
    assert [p["payload"]["chunk_index"] for p in pts] == [0, 1, 2]
    # l'état est enregistré (le doc devient géré comme un fichier normal)
    state = json.loads((eng._test_data_dir.parent.parent / "rag_state.json")
                       .read_text(encoding="utf-8"))
    assert any("rapport--ab12cd34.md" in k for k in state["files"])


def test_index_document_embedder_muet(eng, monkeypatch):
    """0 embedding → ok:false ET pas de fichier fantôme non interrogeable."""
    monkeypatch.setattr(eng, "get_embeddings", lambda texts, **kw: [[] for _ in texts])
    res = eng.index_document_chunks("vide.md", [{"text": "x", "page": 1}])
    assert res["ok"] is False
    assert not (eng._test_data_dir / "vide.md").exists()


def test_index_document_anti_traversal(eng):
    res = eng.index_document_chunks("../evasion.md", [{"text": "x"}])
    assert res["ok"] is False


def test_deindex_document(eng):
    eng.index_document_chunks("a.md", [{"text": "contenu", "page": 1}])
    eng._test_calls["deletes"].clear()
    res = eng.deindex_document("a.md")
    assert res["ok"] is True and res["deleted_file"] is True
    assert not (eng._test_data_dir / "a.md").exists()
    assert len(eng._test_calls["deletes"]) == 1
    # état purgé
    state = json.loads((eng._test_data_dir.parent.parent / "rag_state.json")
                       .read_text(encoding="utf-8"))
    assert not any(k.endswith("a.md") for k in state.get("files", {}))
    assert eng.deindex_document("../evasion.md")["ok"] is False
