# SPDX-License-Identifier: MIT
"""tests/rag_app/test_sparse.py — vecteurs sparse bge-m3 + hybride natif.

Conversion du format TEI → Qdrant (entrées invalides ignorées, vecteur
vide → None), repli URL sur embed_base_url, cache TTL de la sonde de
schéma (zéro round-trip répété sur le chemin chaud), constructeur de
requête hybride (fusion RRF, pushdown du filtre dans les prefetch).
"""
from __future__ import annotations

import httpx
import pytest

from rag_app import sparse as sp

_REAL_CLIENT = httpx.Client


@pytest.fixture(autouse=True)
def _cache_propre():
    sp._support_cache_clear()
    sp._shared_client = None          # client partagé (passe RAG 2026-09-26)
    yield
    sp._support_cache_clear()
    sp._shared_client = None


def _mock_http(monkeypatch, handler):
    def factory(*args, **kwargs):
        return _REAL_CLIENT(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "Client", factory)


# ─── config ─────────────────────────────────────────────────────────────────

def test_section_url_repli_embed_base_url():
    s = sp._section({"embed_base_url": "http://emb.test/",
                     "sparse": {"enabled": True}})
    assert s["url"] == "http://emb.test"
    assert s["enabled"] is True


def test_is_enabled():
    assert sp.is_enabled({}) is False
    assert sp.is_enabled({"sparse": {"enabled": True}}) is False   # pas d'URL
    assert sp.is_enabled({"sparse": {"enabled": True, "url": "http://x"}}) is True


# ─── get_sparse_embeddings ──────────────────────────────────────────────────

def test_desactive_renvoie_none_alignes():
    out = sp.get_sparse_embeddings(["a", "b"], {})
    assert out == [None, None]
    assert sp.get_sparse_embeddings([], {}) == []


def test_conversion_tei_vers_qdrant(monkeypatch):
    def handler(request):
        assert request.url.path == "/embed_sparse"
        return httpx.Response(200, json=[
            [{"index": 12, "value": 0.42}, {"index": 7, "value": 0.0},
             {"index": -1, "value": 0.3}, {"bad": True}],
            [],
            "pas une liste",
        ])
    _mock_http(monkeypatch, handler)
    cfg = {"sparse": {"enabled": True, "url": "http://x"}}
    out = sp.get_sparse_embeddings(["t1", "t2", "t3"], cfg)
    assert out[0] == {"indices": [12], "values": [0.42]}   # 0.0 et -1 filtrés
    assert out[1] is None                                   # vecteur vide → None
    assert out[2] is None                                   # forme inattendue


def test_http_500_renvoie_none_partout(monkeypatch):
    _mock_http(monkeypatch, lambda r: httpx.Response(500, text="boom"))
    cfg = {"sparse": {"enabled": True, "url": "http://x"}}
    assert sp.get_sparse_embeddings(["a", "b"], cfg) == [None, None]


# ─── collection_supports_sparse + cache TTL ─────────────────────────────────

def _schema_handler(counter, named=True):
    def handler(request):
        counter["n"] += 1
        params = ({"vectors": {"dense": {"size": 4}},
                   "sparse_vectors": {"sparse": {}}} if named
                  else {"vectors": {"size": 4, "distance": "Cosine"}})
        return httpx.Response(200, json={"result": {"config": {"params": params}}})
    return handler


def test_support_detecte_schema_nomme(monkeypatch):
    counter = {"n": 0}
    _mock_http(monkeypatch, _schema_handler(counter, named=True))
    assert sp.collection_supports_sparse("http://q", "c") is True


def test_support_schema_legacy(monkeypatch):
    counter = {"n": 0}
    _mock_http(monkeypatch, _schema_handler(counter, named=False))
    assert sp.collection_supports_sparse("http://q", "c") is False


def test_support_cache_ttl(monkeypatch):
    counter = {"n": 0}
    _mock_http(monkeypatch, _schema_handler(counter, named=True))
    assert sp.collection_supports_sparse("http://q", "c") is True
    assert sp.collection_supports_sparse("http://q", "c") is True
    assert counter["n"] == 1                       # 2e réponse servie du cache
    sp._support_cache_clear()
    sp.collection_supports_sparse("http://q", "c")
    assert counter["n"] == 2                       # re-sonde après vidage
    # collection différente = entrée de cache distincte
    sp.collection_supports_sparse("http://q", "autre")
    assert counter["n"] == 3


def test_support_404(monkeypatch):
    _mock_http(monkeypatch, lambda r: httpx.Response(404, json={}))
    assert sp.collection_supports_sparse("http://q", "c") is False


# ─── build_hybrid_query ─────────────────────────────────────────────────────

def test_query_dense_seule():
    body = sp.build_hybrid_query([0.1, 0.2], None, limit=7, prefetch_limit=21)
    assert len(body["prefetch"]) == 1
    assert body["prefetch"][0]["using"] == "dense"
    assert body["prefetch"][0]["limit"] == 21
    assert "query" not in body                     # pas de fusion à une branche
    assert body["limit"] == 7


def test_query_hybride_rrf_et_filtre_pushdown():
    filt = {"must": [{"key": "name", "match": {"value": "a.txt"}}]}
    body = sp.build_hybrid_query([0.1], {"indices": [1], "values": [0.5]},
                                 limit=5, prefetch_limit=50, qdrant_filter=filt)
    assert len(body["prefetch"]) == 2
    assert body["query"] == {"fusion": "rrf"}
    assert all(b["filter"] == filt for b in body["prefetch"])
    assert body["prefetch"][1]["using"] == "sparse"


def test_health_check_sans_url():
    res = sp.health_check({"sparse": {"enabled": True}})
    assert res["ok"] is False
    assert res["configured"] is False
