# SPDX-License-Identifier: MIT
"""tests/rag_app/test_rag_query_search.py — pipeline de recherche rag_query.

Fonctions pures (BM25, RRF, near-dup, seuil adaptatif, extraction de noms)
+ chemins d'intégration ``rag_search_only`` / ``rag_tool_search`` / ``rag``
avec réseau et embeddings monkeypatchés (aucun accès réseau).
"""
from __future__ import annotations

import json

import pytest

from rag_app import rag_query as rq


@pytest.fixture(autouse=True)
def _isole(monkeypatch, tmp_path):
    """Config/traces isolées + caches vidés entre tests."""
    cfg = {
        "collection": "col1",
        "qdrant_url": "http://q.test:6333",
        "embed_base_url": "http://emb.test",
        "embed_model": "bge-m3",
        "top_k": 5,
        "allowed_ext": [".txt", ".md", ".pdf"],
    }
    cfg_file = tmp_path / "rag_config.json"
    cfg_file.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setattr(rq, "CONFIG_FILE", cfg_file)
    monkeypatch.setattr(rq, "TRACE_FILE", tmp_path / "rag_traces.json")
    with rq._embed_cache_lock:
        rq._embed_cache.clear()
    rq.invalidate_docs_cache()
    yield
    rq.flush_traces()


def _hit(text, score, name="doc.txt", folder="", idx=0):
    return {"score": score, "payload": {"text": text, "name": name,
                                        "folder": folder, "chunk_index": idx,
                                        "keywords": [], "word_count": 1,
                                        "char_count": len(text)}}


# ─── Fonctions pures ────────────────────────────────────────────────────────

def test_bm25_document_pertinent_premier():
    docs = ["le chat mange la souris", "la météo est pluvieuse demain",
            "un chat noir dort"]
    scores = rq.bm25_scores("chat souris", docs)
    assert scores[0] == max(scores)
    assert scores[1] < scores[0]


def test_bm25_entrees_vides():
    assert rq.bm25_scores("", ["doc"]) == [0.0]
    assert rq.bm25_scores("query", []) == []


def test_rrf_fusion_prime_les_doubles_tetes():
    fused = rq.rrf_fusion([[0, 1, 2], [0, 2, 1]])
    assert fused[0][0] == 0                       # premier partout → premier
    assert {i for i, _ in fused} == {0, 1, 2}


def test_near_dup_filter_supprime_les_quasi_doublons():
    hits = [_hit("le contrat couvre la maintenance des serveurs", 0.9),
            _hit("le contrat couvre la maintenance des serveurs !", 0.8),
            _hit("la facturation est mensuelle et forfaitaire", 0.7)]
    out = rq._near_dup_filter(hits)
    assert len(out) == 2
    assert out[0]["score"] == 0.9


def test_adaptive_threshold():
    plat = [_hit("a", 0.31), _hit("b", 0.30), _hit("c", 0.29)]
    assert rq._adaptive_threshold(plat, 0.25) == 0.25          # scores serrés
    pique = [_hit("a", 0.9), _hit("b", 0.2)]
    assert rq._adaptive_threshold(pique, 0.25) == pytest.approx(0.54)
    assert rq._adaptive_threshold([], 0.25) == 0.25


def test_extract_filenames():
    cfg = {"allowed_ext": [".txt", ".pdf"]}
    found = rq._extract_filenames("voir rapport.pdf et notes.txt svp", cfg)
    assert set(found) == {"rapport.pdf", "notes.txt"}
    assert rq._extract_filenames("rien ici", cfg) == []
    assert rq._extract_filenames("x.txt", {"allowed_ext": []}) == []


def test_save_trace_cap_et_tolerance(tmp_path, monkeypatch):
    trace_file = tmp_path / "t.json"
    monkeypatch.setattr(rq, "TRACE_FILE", trace_file)
    trace_file.write_text("{corrompu", encoding="utf-8")     # JSON invalide toléré
    for i in range(105):
        rq.save_trace(f"q{i}", {}, "mode", [])
    rq.flush_traces()
    traces = json.loads(trace_file.read_text(encoding="utf-8"))
    assert len(traces) == 100                                  # cap
    assert traces[0]["question"] == "q104"                     # plus récent d'abord
    assert not trace_file.with_name("t.json.tmp").exists()


def test_get_embeddings_cache_lru(monkeypatch):
    calls = {"n": 0}

    class FakeResp:
        status_code = 200
        def json(self):
            return {"data": [{"embedding": [0.1, 0.2]}]}

    class FakeClient:
        def post(self, url, json=None, timeout=None):
            calls["n"] += 1
            return FakeResp()

    monkeypatch.setattr(rq, "_client", lambda: FakeClient())
    cfg = {"embed_base_url": "http://e", "embed_model": "m"}
    v1 = rq.get_embeddings("bonjour", cfg)
    v2 = rq.get_embeddings("bonjour", cfg)
    assert v1 == v2 == [0.1, 0.2]
    assert calls["n"] == 1                                     # 2e appel servi du cache


# ─── rag_search_only ────────────────────────────────────────────────────────

def test_rag_search_only_hybride(monkeypatch):
    hits = [_hit("les serveurs de production", 0.9, idx=0),
            _hit("la salle des machines", 0.5, idx=1),
            _hit("recette de cuisine au beurre", 0.3, idx=2)]
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1, 0.2])
    monkeypatch.setattr(rq, "search_qdrant",
                        lambda vec, cfg, **kw: [dict(h) for h in hits])
    res = rq.rag_search_only("serveurs production", top_k=3)
    assert res["ok"] is True
    assert res["results"]
    assert "hybrid" in res["mode"]
    row = res["results"][0]
    assert {"score", "vector_score", "bm25_score", "name", "text"} <= set(row)


def test_rag_search_only_echec_embedding(monkeypatch):
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [])
    res = rq.rag_search_only("question")
    assert res["ok"] is False
    assert res["results"] == []


def test_rag_search_only_aucun_hit(monkeypatch):
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1])
    monkeypatch.setattr(rq, "search_qdrant", lambda vec, cfg, **kw: [])
    res = rq.rag_search_only("question")
    assert res["ok"] is True
    assert res["mode"] == "empty"


def test_rag_search_only_mmr_filtre_les_doublons(monkeypatch):
    hits = [_hit("texte identique pour le test de doublon", 0.9, idx=0),
            _hit("texte identique pour le test de doublon", 0.8, idx=1)]
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1])
    monkeypatch.setattr(rq, "search_qdrant",
                        lambda vec, cfg, **kw: [dict(h) for h in hits])
    res = rq.rag_search_only("test", use_hybrid=False, use_mmr=True)
    assert len(res["results"]) == 1
    res2 = rq.rag_search_only("test", use_hybrid=False, use_mmr=False)
    assert len(res2["results"]) == 2


# ─── rag_tool_search ────────────────────────────────────────────────────────

def test_tool_search_classic_seuil_adaptatif(monkeypatch):
    hits = [_hit("réponse très pertinente", 0.9),
            _hit("bruit de fond sans rapport", 0.2, idx=1)]
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1])
    monkeypatch.setattr(rq, "search_qdrant",
                        lambda vec, cfg, **kw: [dict(h) for h in hits])
    res = rq.rag_tool_search("question", search_mode="classic", top_k=5)
    assert res["ok"] is True
    assert len(res["results"]) == 1               # 0.2 < seuil adaptatif (0.54)
    assert res["results"][0]["score"] == 0.9


def test_tool_search_query_vide():
    assert rq.rag_tool_search("  ")["ok"] is False


def test_tool_search_hybrid_shape(monkeypatch):
    hits = [_hit("alpha beta gamma", 0.8, name="a.txt", folder="dossier"),
            _hit("delta epsilon zeta", 0.6, name="b.txt", idx=1)]
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1])
    monkeypatch.setattr(rq, "search_qdrant",
                        lambda vec, cfg, **kw: [dict(h) for h in hits])
    res = rq.rag_tool_search("alpha", search_mode="hybrid", top_k=5)
    assert res["ok"] is True
    assert res["results"][0]["source"] == "dossier/a.txt"


# ─── rag() point d'entrée public ────────────────────────────────────────────

def test_rag_mode_fichier_nomme(monkeypatch):
    chunks = [{"name": "rapport.txt", "folder": "", "text": "contenu page 1",
               "chunk_index": 0},
              {"name": "rapport.txt", "folder": "", "text": "contenu page 2",
               "chunk_index": 1}]
    monkeypatch.setattr(rq, "get_all_chunks_for_files",
                        lambda cfg, names, max_chunks=None: chunks)
    out = rq.rag("résume le fichier rapport.txt")
    assert out is not None
    prompt, sources = out
    assert "contenu page 1" in prompt
    assert sources == ["[rapport.txt]"]
    assert "FULL DOCUMENT CONTEXT" in prompt


def test_rag_vectoriel_classique(monkeypatch):
    hits = [_hit("la réponse utile au sujet", 0.9),
            _hit("hors sujet complet ici", 0.1, idx=1)]
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1])
    monkeypatch.setattr(rq, "search_qdrant",
                        lambda vec, cfg, **kw: [dict(h) for h in hits])
    out = rq.rag("quelle est la réponse ?")
    assert out is not None
    prompt, sources = out
    assert "la réponse utile au sujet" in prompt
    assert len(sources) == 1                       # le hit 0.1 est sous le seuil


def test_rag_aucun_resultat(monkeypatch):
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1])
    monkeypatch.setattr(rq, "search_qdrant", lambda vec, cfg, **kw: [])
    assert rq.rag("question") is None


def test_rag_echec_embedding(monkeypatch):
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [])
    assert rq.rag("question") is None


def test_rag_config_absente(monkeypatch, tmp_path):
    monkeypatch.setattr(rq, "CONFIG_FILE", tmp_path / "absent.json")
    assert rq.rag("question") is None


# ─── (2026-09-21) une panne Qdrant n'est pas « aucun résultat » ────────────

def test_tool_search_qdrant_en_panne_rend_une_erreur(monkeypatch):
    import httpx
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1, 0.2])
    monkeypatch.setattr(rq, "_client", lambda: httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(503, text="down"))))
    res = rq.rag_tool_search("question", search_mode="classic", top_k=5)
    assert res["ok"] is False and "indisponible" in res["error"]


def test_tool_search_vide_reste_un_succes(monkeypatch):
    import httpx
    monkeypatch.setattr(rq, "get_embeddings", lambda q, cfg: [0.1, 0.2])
    monkeypatch.setattr(rq, "_client", lambda: httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"result": []}))))
    res = rq.rag_tool_search("question", search_mode="classic", top_k=5)
    assert res["ok"] is True and res["results"] == []
