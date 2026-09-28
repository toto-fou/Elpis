# SPDX-License-Identifier: MIT
"""tests/rag_app/test_rag_engine_paths.py — confinement des chemins.

Toutes les opérations fichier pilotées par l'API passent par
``_safe_data_path`` : un ``rel_path`` qui s'échappe de DATA/<collection>
(« .. », chemin absolu, préfixe de dossier frère) est refusé. Régressions
couvertes : suppression arbitraire via /api/files/delete, écriture hors
DATA via save_file_text sur un chemin inexistant, faux positif du vieux
check ``startswith`` sur un dossier frère partageant le préfixe.
"""
from __future__ import annotations

import json

import httpx
import pytest

from rag_app import rag_engine as E


def _ok_handler(request):
    return httpx.Response(200, json={"result": {}, "status": "ok"})


@pytest.fixture
def eng(tmp_path, monkeypatch):
    monkeypatch.setattr(E, "BASE_DIR", tmp_path)   # DATA/ isolé sous tmp
    cfg = {
        "collection": "col1",
        "qdrant_url": "http://q.test:6333",
        "embed_base_url": "http://emb.test",
        "embed_model": "bge-m3",
        "state_file": str(tmp_path / "state.json"),
    }
    p = tmp_path / "rag_config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    client = httpx.Client(transport=httpx.MockTransport(_ok_handler))
    engine = E.RAGEngine(str(p), http_client=client)
    yield engine
    client.close()


def test_safe_data_path_confine(eng, tmp_path):
    data = eng.get_current_data_dir()
    assert eng._safe_data_path("a.txt") == (data / "a.txt").resolve()
    assert eng._safe_data_path("sub/../a.txt") == (data / "a.txt").resolve()
    for hostile in ("../evil.txt", "../../etc/passwd", "/etc/passwd",
                    "..", "", "   ", None):
        assert eng._safe_data_path(hostile) is None


def test_delete_file_traversal_refuse(eng, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("précieux", encoding="utf-8")
    res = eng.delete_file("../../outside.txt")
    assert res["ok"] is False
    assert outside.exists()


def test_delete_file_legitime(eng):
    data = eng.get_current_data_dir()
    f = data / "doc.txt"
    f.write_text("contenu", encoding="utf-8")
    key = str(f.resolve())
    eng._update_state(lambda s: s["files"].__setitem__(key, {"mtime": 1, "hash": "h"}))
    res = eng.delete_file("doc.txt")
    assert res["ok"] is True
    assert not f.exists()
    assert key not in eng._load_state()["files"]


def test_reindex_traversal_refuse(eng, tmp_path):
    (tmp_path / "dehors.txt").write_text("x", encoding="utf-8")
    res = eng.reindex_single_file("../../dehors.txt")
    assert res["ok"] is False
    assert "autoris" in res["msg"].lower()


def test_reindex_from_chunks_traversal_refuse(eng):
    res = eng.reindex_from_chunks("../../x.txt", ["chunk"])
    assert res["ok"] is False


def test_save_file_text_traversal_refuse_meme_inexistant(eng, tmp_path):
    # Régression : l'ancien code ne résolvait PAS les chemins inexistants
    # (« absolute() » gardait les .. textuels) → l'écriture s'échappait.
    res = eng.save_file_text("sub/../../../evasion.txt", "pwned")
    assert res["ok"] is False
    assert not (tmp_path / "evasion.txt").exists()
    assert not (tmp_path.parent / "evasion.txt").exists()


def test_save_file_text_cree_les_parents(eng):
    res = eng.save_file_text("a/b/c.txt", "ok")
    assert res["ok"] is True
    assert (eng.get_current_data_dir() / "a/b/c.txt").read_text(encoding="utf-8") == "ok"


def test_convert_file_traversal_refuse(eng):
    res = eng.convert_file("../../x.csv", ".md")
    assert res["ok"] is False


def test_index_document_chunks_prefixe_frere_refuse(eng, tmp_path):
    # DATA/col1extra partage le préfixe de DATA/col1 : l'ancien check
    # ``str(p).startswith(str(data_dir))`` l'acceptait.
    sibling = tmp_path / "DATA" / "col1extra"
    sibling.mkdir(parents=True, exist_ok=True)
    res = eng.index_document_chunks("../col1extra/doc.md", [{"text": "x"}])
    assert res["ok"] is False
    assert not (sibling / "doc.md").exists()


def test_deindex_document_traversal_refuse(eng):
    assert eng.deindex_document("../../x.md")["ok"] is False


def test_data_dir_collection_hostile(eng, tmp_path):
    eng.cfg["collection"] = "../evil"
    d = eng.get_current_data_dir()
    assert d.parent == tmp_path / "DATA"      # jamais hors de DATA/
    assert d.name == ".._evil"
    eng.cfg["collection"] = ".."
    d2 = eng.get_current_data_dir()
    assert d2.name == "default"
    eng.cfg["collection"] = "a/b"
    assert eng.get_current_data_dir().name == "a_b"
