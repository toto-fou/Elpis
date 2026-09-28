# SPDX-License-Identifier: MIT
"""tests/rag_app/test_reranker.py — couche de reranking cross-encoder.

No-op strict quand désactivé, tolérance aux dialectes de réponse
(Cohere/TEI ``relevance_score`` vs ``score``, dict vs liste), repli sur la
liste d'origine en cas d'échec réseau ou de filtre min_score trop agressif,
cache LRU (un seul appel HTTP pour deux requêtes identiques).
"""
from __future__ import annotations

import json

import httpx
import pytest

from rag_app import reranker as rr


@pytest.fixture(autouse=True)
def _client_partage_neuf():
    """Le client httpx est partagé (passe RAG 2026-09-26) : chaque test
    repart d'un client construit avec SON transport simulé."""
    rr._shared_client = None
    yield
    rr._shared_client = None

_REAL_CLIENT = httpx.Client   # capturé avant tout monkeypatch


@pytest.fixture(autouse=True)
def _cache_propre():
    with rr._cache_lock:
        rr._cache.clear()
    yield
    with rr._cache_lock:
        rr._cache.clear()


def _cfg(**over):
    base = {"reranker": {"enabled": True, "url": "http://rr.test",
                         "model": "bge-reranker-v2-m3", "top_k_before": 30,
                         "top_k_after": 8, "timeout": 5, "api_key": "",
                         "min_score": 0}}
    base["reranker"].update(over)
    return base


def _hits(n=3):
    return [{"score": 0.5 - i * 0.1,
             "payload": {"text": f"document numéro {i}", "name": f"d{i}.txt"}}
            for i in range(n)]


def _mock_http(monkeypatch, handler):
    """Remplace httpx.Client par une fabrique branchée sur MockTransport."""
    def factory(*args, **kwargs):
        return _REAL_CLIENT(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "Client", factory)


# ─── on/off ─────────────────────────────────────────────────────────────────

def test_desactive_est_un_noop():
    cfg = {"reranker": {"enabled": False}}
    hits = _hits()
    assert rr.rerank_hits("q", hits, cfg) == hits
    assert rr.rerank_hits("q", hits, cfg, top_k=2) == hits[:2]
    assert rr.is_enabled(cfg) is False
    assert rr.top_k_before(cfg) is None


def test_enabled_sans_url_est_off():
    assert rr.is_enabled(_cfg(url="")) is False


def test_top_k_before_actif():
    assert rr.top_k_before(_cfg()) == 30


# ─── dialectes de réponse ───────────────────────────────────────────────────

def test_reponse_dict_relevance_score(monkeypatch):
    def handler(request):
        assert request.url.path == "/v1/rerank"
        return httpx.Response(200, json={"results": [
            {"index": 2, "relevance_score": 0.95},
            {"index": 0, "relevance_score": 0.40}]})
    _mock_http(monkeypatch, handler)
    out = rr.rerank_hits("q", _hits(), _cfg(), top_k=2)
    assert [h["payload"]["name"] for h in out] == ["d2.txt", "d0.txt"]
    assert out[0]["score"] == 0.95
    assert out[0]["payload"]["rerank_score"] == 0.95
    assert out[0]["payload"]["original_score"] == pytest.approx(0.3)


def test_reponse_liste_et_cle_score(monkeypatch):
    def handler(request):
        return httpx.Response(200, json=[{"index": 1, "score": 0.8}])
    _mock_http(monkeypatch, handler)
    out = rr.rerank_hits("q", _hits(), _cfg(), top_k=3)
    assert out[0]["payload"]["name"] == "d1.txt"


def test_indices_hors_bornes_ignores(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"results": [
            {"index": 99, "relevance_score": 0.9},
            {"index": 1, "relevance_score": 0.7},
            {"index": "zut", "relevance_score": 0.6}]})
    _mock_http(monkeypatch, handler)
    out = rr.rerank_hits("q", _hits(), _cfg(), top_k=3)
    assert len(out) == 1
    assert out[0]["payload"]["name"] == "d1.txt"


# ─── replis ─────────────────────────────────────────────────────────────────

def test_echec_http_repli_liste_origine(monkeypatch):
    _mock_http(monkeypatch, lambda r: httpx.Response(500, json={}))
    hits = _hits()
    out = rr.rerank_hits("q", hits, _cfg(), top_k=2)
    assert out == hits[:2]


def test_reponse_sans_resultat_utilisable(monkeypatch):
    _mock_http(monkeypatch, lambda r: httpx.Response(200, json={"results": []}))
    hits = _hits()
    assert rr.rerank_hits("q", hits, _cfg(), top_k=2) == hits[:2]


def test_min_score_tout_filtre_repli(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"results": [
            {"index": 0, "relevance_score": 0.01}]})
    _mock_http(monkeypatch, handler)
    hits = _hits()
    out = rr.rerank_hits("q", hits, _cfg(min_score=0.5), top_k=2)
    assert out == hits[:2]                     # jamais de liste vide


def test_moins_de_deux_hits_pas_dappel(monkeypatch):
    def handler(request):
        raise AssertionError("ne doit pas appeler le réseau")
    _mock_http(monkeypatch, handler)
    solo = _hits(1)
    assert rr.rerank_hits("q", solo, _cfg()) == solo


# ─── cache ──────────────────────────────────────────────────────────────────

def test_cache_un_seul_appel_http(monkeypatch):
    calls = {"n": 0}
    def handler(request):
        calls["n"] += 1
        return httpx.Response(200, json={"results": [
            {"index": 0, "relevance_score": 0.9}]})
    _mock_http(monkeypatch, handler)
    hits = _hits()
    rr.rerank_hits("q", hits, _cfg(), top_k=2)
    rr.rerank_hits("q", hits, _cfg(), top_k=2)
    assert calls["n"] == 1


def test_echec_non_mis_en_cache(monkeypatch):
    calls = {"n": 0}
    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, json={})
        return httpx.Response(200, json={"results": [
            {"index": 0, "relevance_score": 0.9}]})
    _mock_http(monkeypatch, handler)
    hits = _hits()
    rr.rerank_hits("q", hits, _cfg(), top_k=2)          # échec → repli
    out = rr.rerank_hits("q", hits, _cfg(), top_k=2)    # retente
    assert calls["n"] == 2
    assert out[0]["payload"]["rerank_score"] == 0.9


# ─── rerank_simple_results ──────────────────────────────────────────────────

def test_simple_results_enrichis(monkeypatch):
    def handler(request):
        body = json.loads(request.content.decode())
        assert body["model"] == "bge-reranker-v2-m3"
        return httpx.Response(200, json={"results": [
            {"index": 1, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.2}]})
    _mock_http(monkeypatch, handler)
    rows = [{"source": "a.txt", "score": 0.5, "text": "aaa"},
            {"source": "b.txt", "score": 0.4, "text": "bbb"}]
    out = rr.rerank_simple_results("q", rows, _cfg(), top_k=2)
    assert out[0]["source"] == "b.txt"
    assert out[0]["rerank_score"] == 0.9
    assert out[0]["original_score"] == 0.4


def test_health_check_sans_url():
    res = rr.health_check({"reranker": {"enabled": True, "url": ""}})
    assert res["ok"] is False
    assert res["configured"] is False


# ─── cache : top_n fait partie de la clé (2026-09-20) ──────────────────────

def test_le_cache_distingue_top_n(monkeypatch):
    appels = []

    def _fake(query, documents, section, top_n=None):
        appels.append(top_n)
        return [(i, 1.0 - i * 0.1) for i in range(min(top_n or len(documents), len(documents)))]
    monkeypatch.setattr(rr, "_call_reranker", _fake)
    hits = _hits(5)
    assert len(rr.rerank_hits("q", hits, _cfg(), top_k=2)) == 2
    assert len(rr.rerank_hits("q", hits, _cfg(), top_k=4)) == 4, "un top_n plus large n'est pas servi par la liste tronquée"
    assert appels == [2, 4]
    rr.rerank_hits("q", hits, _cfg(), top_k=2)
    assert appels == [2, 4], "même requête, même top_n : servi par le cache"
    res = [{"text": f"t{i}", "score": 0.1 * i} for i in range(5)]
    assert len(rr.rerank_simple_results("q", res, _cfg(), top_k=3)) == 3
    assert len(rr.rerank_simple_results("q", res, _cfg(), top_k=5)) == 5
