# SPDX-License-Identifier: MIT
"""tests/rag_app/test_passe_rag_2026_09_26.py — passe audit + optimisation du
RAG (2026-09-26).

Verrouille :
  • import : plafond, bombe d'archive, archive jamais laissée dans DATA/ ;
  • file OCR : document « poison » retiré, file pleine signalée ;
  • Contextual Retrieval : coupe-circuit conservé d'un lot à l'autre ;
  • requête : vecteur ``dense`` nommé, pas de seuil cosinus sur des scores
    RRF, panne d'embedding signalée ; reranker : clé de cache compacte.
"""
from __future__ import annotations

import io
import json
import threading
import time
import zipfile

import httpx
import pytest

from rag_app import rag_query as RQ

# ── Contextual Retrieval ─────────────────────────────────────────────────────

def test_coupe_circuit_conserve_d_un_lot_a_l_autre(monkeypatch):
    from rag_app import contextual as C
    appels = {"n": 0}

    def llm_mort(prompt, s, client=None):
        appels["n"] += 1
        return None
    monkeypatch.setattr(C, "_call_llm", llm_mort)
    cfg = {"contextual": {"enabled": True, "url": "http://llm", "model": "m"}}
    with C.ContextSession(cfg) as sess:
        for _ in range(10):                        # 10 lots de 4 chunks
            C.generate_contexts_for_doc("doc", ["a", "b", "c", "d"], cfg, session=sess)
    assert appels["n"] == C._MAX_CONSECUTIVE_FAILURES, "le coupe-circuit repartait à chaque lot"


# ── File OCR ─────────────────────────────────────────────────────────────────

@pytest.fixture
def ocr_root(monkeypatch, tmp_path):
    from rag_app.ocr import store
    monkeypatch.setattr(store, "ocr_root", lambda: tmp_path)
    return tmp_path


def test_document_poison_retire(ocr_root):
    from rag_app.ocr import queue as Q, store
    d = store.create_doc("p.pdf", ".pdf")
    a = store.read_meta(d)["id"]
    for _ in range(Q.MAX_CRASH_RETRIES):
        Q.enqueue([a])
        Q.pop_next()
        q = Q.reconcile(startup=True)              # « plantage » : remis en tête
        assert [it["doc"] for it in q["items"]] == [a]
        Q.pop_next()
        Q.update_queue(lambda q: q.__setitem__("active", a))
        q = Q.read_queue()
        Q.update_queue(lambda q: q.__setitem__("items", []))
    q = Q.reconcile(startup=True)
    assert a not in [it["doc"] for it in q["items"]] and q["active"] is None
    assert store.read_meta(d)["status"] == "error"


def test_file_pleine_signalee(ocr_root, monkeypatch):
    from rag_app.ocr import queue as Q, store
    monkeypatch.setattr(Q, "MAX_QUEUE", 1)
    ids = [store.read_meta(store.create_doc(f"{i}.pdf", ".pdf"))["id"] for i in range(3)]
    res = Q.enqueue(ids)
    assert len(res["items"]) == 1 and res["rejected"] == 2


# ── Import ───────────────────────────────────────────────────────────────────

def test_bombe_zip_refusee(tmp_path, monkeypatch):
    from rag_app import app as A
    monkeypatch.setattr(A, "_UNPACK_MAX_BYTES", 1000)
    z = tmp_path / "b.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("gros.txt", "0" * 5000)
    with pytest.raises(ValueError):
        A._safe_unpack(z, tmp_path / "out")
    assert not (tmp_path / "out" / "gros.txt").exists()


def test_copie_bornee_sans_fichier_partiel(tmp_path, monkeypatch):
    from rag_app import app as A
    monkeypatch.setattr(A, "_UPLOAD_MAX_BYTES", 10)
    with pytest.raises(ValueError):
        A._copy_upload_bounded(io.BytesIO(b"x" * 100), tmp_path / "f.txt")
    assert list(tmp_path.iterdir()) == []
    A._copy_upload_bounded(io.BytesIO(b"ok"), tmp_path / "g.txt")
    assert (tmp_path / "g.txt").read_bytes() == b"ok"


# ── Requête ──────────────────────────────────────────────────────────────────

def test_vecteur_dense_nomme(monkeypatch):
    from rag_app import sparse as sp
    sp._support_cache_clear()
    sp._shared_client = None
    envoye = []

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"result": {"config": {"params": {
                "vectors": {"dense": {"size": 3}},
                "sparse_vectors": {"sparse": {}}}}}})
        envoye.append(json.loads(request.content))
        return httpx.Response(200, json={"result": []})
    real = httpx.Client
    monkeypatch.setattr(httpx, "Client",
                        lambda *a, **k: real(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(RQ, "_client", lambda: real(transport=httpx.MockTransport(handler)))
    try:
        RQ.search_qdrant([0.1, 0.2, 0.3], {"qdrant_url": "http://q", "collection": "c"})
    finally:
        sp._support_cache_clear()
        sp._shared_client = None
    assert envoye and envoye[0]["vector"] == {"name": "dense", "vector": [0.1, 0.2, 0.3]}


def test_pas_de_seuil_cosinus_sur_rrf():
    hits = [{"score": 1 / (60 + i), "_fused": True, "payload": {"text": str(i)}}
            for i in range(10)]
    assert RQ._server_fused(hits) is True
    assert RQ._server_fused([{"score": 0.9}]) is False


def test_panne_d_embedding_signalee(monkeypatch):
    RQ._SEARCH_ERROR.set(None)

    def boom(*a, **k):
        raise httpx.ConnectError("refusé")

    class C:
        post = staticmethod(boom)
    monkeypatch.setattr(RQ, "_client", lambda: C)
    assert RQ.get_embeddings("question jamais vue 9f3a", {
        "embed_base_url": "http://e", "embed_model": "m"}) == []
    assert "embedding" in (RQ._SEARCH_ERROR.get() or "")


def test_cle_de_cache_reranker_compacte():
    from rag_app import reranker as rr
    k = rr._docs_digest(["a" * 2000] * 60)
    assert isinstance(k, str) and len(k) == 40
    assert rr._docs_digest(["a", "b"]) != rr._docs_digest(["ab"])
