# SPDX-License-Identifier: MIT
"""tests/rag_app/test_rag_engine_qdrant.py — I/O Qdrant + embeddings.

Client httpx injecté (MockTransport) : la logique testée est réelle, seul
le réseau est simulé. Couvre les régressions « échec silencieux » :
upsert_points doit compter les points ACCEPTÉS (statut HTTP vérifié),
reindex_single_file doit échouer (et ne pas marquer l'état) quand aucun
vecteur n'est stocké, get_embeddings doit rester ALIGNÉ sur l'entrée.
"""
from __future__ import annotations

import json
import threading

import httpx
import pytest

from rag_app import rag_engine as E


class QdrantStub:
    """Serveur Qdrant + embeddings simulé, piloté par flags."""

    def __init__(self, vec_dim=4, fail_embed=False, fail_upsert=False,
                 collection_exists=True):
        self.vec_dim = vec_dim
        self.fail_embed = fail_embed
        self.fail_upsert = fail_upsert
        self.collection_exists = collection_exists
        self.requests: list = []
        self.upsert_bodies: list = []
        self.embed_inputs: list = []
        self.created_bodies: list = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        path = request.url.path
        if path.endswith("/v1/embeddings"):
            if self.fail_embed:
                return httpx.Response(500, json={"error": "down"})
            body = json.loads(request.content.decode())
            self.embed_inputs.append(body["input"])
            data = [{"index": i, "embedding": [0.1] * self.vec_dim}
                    for i in range(len(body["input"]))]
            return httpx.Response(200, json={"data": data})
        if path.endswith("/points") and request.method == "PUT":
            if self.fail_upsert:
                return httpx.Response(400, json={"status": {"error": "schema"}})
            self.upsert_bodies.append(json.loads(request.content.decode()))
            return httpx.Response(200, json={"result": {}, "status": "ok"})
        if path.endswith("/points/delete"):
            return httpx.Response(200, json={"result": {}})
        if path.endswith("/points/count"):
            return httpx.Response(200, json={"result": {"count": 0}})
        if path.endswith("/points/scroll"):
            return httpx.Response(200, json={"result": {"points": [],
                                                        "next_page_offset": None}})
        if path.endswith("/index") and request.method == "PUT":
            return httpx.Response(200, json={"result": {}})
        if "/collections/" in path and request.method == "GET":
            if not self.collection_exists:
                return httpx.Response(404, json={"status": "not found"})
            return httpx.Response(200, json={"result": {
                "config": {"params": {"vectors": {"size": self.vec_dim,
                                                  "distance": "Cosine"}}}}})
        if "/collections/" in path and request.method == "PUT":
            self.created_bodies.append(json.loads(request.content.decode()))
            self.collection_exists = True
            return httpx.Response(200, json={"result": True})
        if "/collections/" in path and request.method == "DELETE":
            return httpx.Response(200, json={"result": True})
        return httpx.Response(404, json={})


def make_engine(tmp_path, monkeypatch, stub, **cfg_extra):
    monkeypatch.setattr(E, "BASE_DIR", tmp_path)
    cfg = {
        "collection": "col1",
        "qdrant_url": "http://q.test:6333",
        "embed_base_url": "http://emb.test",
        "embed_model": "bge-m3",
        "batch_embed": 2,
        "state_file": str(tmp_path / "state.json"),
        "global_method": "size",
        "global_chunk_size": 50,
        "global_chunk_overlap": 5,
        "global_max_chunk_size": 4000,
    }
    cfg.update(cfg_extra)
    p = tmp_path / "rag_config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    client = httpx.Client(transport=httpx.MockTransport(stub))
    return E.RAGEngine(str(p), http_client=client)


# ─── get_embeddings ─────────────────────────────────────────────────────────

def test_embeddings_alignes_avec_textes_vides(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub)
    out = eng.get_embeddings(["alpha", "   ", "beta"])
    assert len(out) == 3
    assert out[0] and out[2]           # embeddings réels
    assert out[1] == []                # texte blanc → vecteur vide, position gardée
    assert stub.embed_inputs == [["alpha", "beta"]]   # jamais envoyé au serveur


def test_embeddings_retry_puis_succes(tmp_path, monkeypatch):
    stub = QdrantStub(fail_embed=True)
    eng = make_engine(tmp_path, monkeypatch, stub)
    monkeypatch.setattr(E.time, "sleep", lambda s: None)

    calls = {"n": 0}
    real = stub.__call__

    def flaky(request):
        if request.url.path.endswith("/v1/embeddings"):
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(500, json={})
            stub.fail_embed = False
        return real(request)

    eng.http_client = httpx.Client(transport=httpx.MockTransport(flaky))
    out = eng.get_embeddings(["x"])
    assert out[0]
    assert calls["n"] == 2


def test_embeddings_echec_total_liste_alignee(tmp_path, monkeypatch):
    stub = QdrantStub(fail_embed=True)
    eng = make_engine(tmp_path, monkeypatch, stub)
    monkeypatch.setattr(E.time, "sleep", lambda s: None)
    out = eng.get_embeddings(["a", "b"], max_retries=2)
    assert out == [[], []]


# ─── upsert_points ──────────────────────────────────────────────────────────

def test_upsert_batches_et_compte(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub)
    pts = [{"id": i, "vector": [0.1], "payload": {"text": f"t{i}"}}
           for i in range(120)]
    accepted = eng.upsert_points(pts)
    assert accepted == 120
    assert len(stub.upsert_bodies) == 3           # 50 + 50 + 20
    assert [len(b["points"]) for b in stub.upsert_bodies] == [50, 50, 20]


def test_upsert_erreur_http_compte_zero(tmp_path, monkeypatch):
    stub = QdrantStub(fail_upsert=True)
    eng = make_engine(tmp_path, monkeypatch, stub, allowed_ext=[".txt"])
    pts = [{"id": 1, "vector": [0.1], "payload": {"text": "t"}}]
    assert eng.upsert_points(pts) == 0


def test_upsert_reecriture_sparse(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub,
                      sparse={"enabled": True, "url": "http://emb.test"})
    import types
    fake_sparse = types.ModuleType("sparse")
    fake_sparse.is_enabled = lambda cfg: True
    fake_sparse.collection_supports_sparse = lambda u, c: True
    fake_sparse.get_sparse_embeddings = lambda texts, cfg: [
        {"indices": [1], "values": [0.5]} for _ in texts]
    monkeypatch.setitem(__import__("sys").modules, "sparse", fake_sparse)

    pts = [{"id": 1, "vector": [0.1, 0.2], "payload": {"text": "t"}}]
    assert eng.upsert_points(pts) == 1
    sent = stub.upsert_bodies[0]["points"][0]
    assert sent["vector"]["dense"] == [0.1, 0.2]
    assert sent["vector"]["sparse"] == {"indices": [1], "values": [0.5]}


# ─── reindex_single_file ────────────────────────────────────────────────────

def test_reindex_succes_ecrit_etat(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub)
    f = eng.get_current_data_dir() / "doc.txt"
    f.write_text("mot " * 100, encoding="utf-8")
    res = eng.reindex_single_file("doc.txt")
    assert res["ok"] is True
    assert res["chunks"] > 0
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert str(f.resolve()) in state["files"]
    # points bien formés
    pt = stub.upsert_bodies[0]["points"][0]
    assert pt["payload"]["name"] == "doc.txt"
    assert isinstance(pt["id"], int)


def test_reindex_embedder_muet_echoue_sans_etat(tmp_path, monkeypatch):
    stub = QdrantStub(fail_embed=True)
    eng = make_engine(tmp_path, monkeypatch, stub)
    monkeypatch.setattr(E.time, "sleep", lambda s: None)
    f = eng.get_current_data_dir() / "doc.txt"
    f.write_text("mot " * 100, encoding="utf-8")
    res = eng.reindex_single_file("doc.txt")
    assert res["ok"] is False
    assert "vecteur" in res["msg"].lower()
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8")) \
        if (tmp_path / "state.json").exists() else {"files": {}}
    assert str(f.resolve()) not in state.get("files", {})


def test_reindex_qdrant_refuse_echoue(tmp_path, monkeypatch):
    stub = QdrantStub(fail_upsert=True)
    eng = make_engine(tmp_path, monkeypatch, stub, allowed_ext=[".txt"])
    f = eng.get_current_data_dir() / "doc.txt"
    f.write_text("mot " * 100, encoding="utf-8")
    res = eng.reindex_single_file("doc.txt")
    assert res["ok"] is False


def test_reindex_from_chunks_zero_upsert_echoue(tmp_path, monkeypatch):
    stub = QdrantStub(fail_embed=True)
    eng = make_engine(tmp_path, monkeypatch, stub)
    monkeypatch.setattr(E.time, "sleep", lambda s: None)
    f = eng.get_current_data_dir() / "doc.txt"
    f.write_text("x", encoding="utf-8")
    res = eng.reindex_from_chunks("doc.txt", ["chunk un", "chunk deux"])
    assert res["ok"] is False


# ─── ensure_collection / purge ──────────────────────────────────────────────

def test_ensure_collection_cree_si_absente(tmp_path, monkeypatch):
    stub = QdrantStub(collection_exists=False)
    eng = make_engine(tmp_path, monkeypatch, stub)
    eng.ensure_collection()
    assert stub.created_bodies
    body = stub.created_bodies[0]
    assert body["vectors"]["size"] == 4          # auto-détecté via embedding test
    assert body["vectors"]["distance"] == "Cosine"


def test_purge_database_echec_delete_remonte(tmp_path, monkeypatch):
    def handler(request):
        if request.method == "DELETE":
            return httpx.Response(500, json={})
        return httpx.Response(200, json={"result": {}})
    monkeypatch.setattr(E, "BASE_DIR", tmp_path)
    cfg_p = tmp_path / "c.json"
    cfg_p.write_text(json.dumps({"collection": "c", "qdrant_url": "http://q",
                                 "embed_base_url": "http://e", "embed_model": "m",
                                 "state_file": str(tmp_path / "s.json")}),
                     encoding="utf-8")
    eng = E.RAGEngine(str(cfg_p),
                      http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    res = eng.purge_database()
    assert res["ok"] is False
    assert "500" in res["msg"]


def test_purge_database_reinitialise_le_schema_detecte(tmp_path, monkeypatch):
    """Après une purge, le schéma doit être RE-détecté sur la collection neuve.

    ``_schema_uses_sparse`` est mémorisé définitivement sur l'instance. La purge
    supprime puis RECRÉE la collection — donc potentiellement avec l'autre
    schéma (vecteurs nommés dense/sparse si sparse est actif). Sans reset,
    l'engine continuait d'envoyer ses points au format de l'ancienne collection :
    Qdrant répondait 400, ``upsert_points`` retournait 0, et chaque fichier
    remontait « Aucun vecteur stocké » jusqu'au redémarrage du service.
    """
    def handler(request):
        if request.method == "DELETE":
            return httpx.Response(200, json={"result": True})
        return httpx.Response(200, json={"result": {}})

    monkeypatch.setattr(E, "BASE_DIR", tmp_path)
    cfg_p = tmp_path / "c.json"
    cfg_p.write_text(json.dumps({"collection": "c", "qdrant_url": "http://q",
                                 "embed_base_url": "http://e", "embed_model": "m",
                                 "state_file": str(tmp_path / "s.json")}),
                     encoding="utf-8")
    eng = E.RAGEngine(str(cfg_p),
                      http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(eng, "ensure_collection", lambda: None)

    eng._schema_uses_sparse = False        # schéma de l'ANCIENNE collection
    res = eng.purge_database()
    assert res["ok"] is True
    assert eng._schema_uses_sparse is None, "schéma périmé conservé après purge"


# ─── config / état ──────────────────────────────────────────────────────────

def test_save_config_coerce_et_atomique(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub)
    eng.save_config({"batch_embed": "abc", "top_k": "12"})
    assert eng.cfg["batch_embed"] == 2            # invalide → valeur précédente
    assert eng.cfg["top_k"] == 12                 # « 12 » → int
    on_disk = json.loads((tmp_path / "rag_config.json").read_text(encoding="utf-8"))
    assert on_disk["top_k"] == 12
    assert not (tmp_path / "rag_config.json.tmp").exists()
    assert eng._schema_uses_sparse is None        # cache schéma invalidé


def test_update_state_concurrent_sans_perte(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub)

    def writer(prefix):
        for i in range(50):
            key = f"{prefix}-{i}"
            eng._update_state(lambda s, k=key: s["files"].__setitem__(k, {"mtime": 1}))

    threads = [threading.Thread(target=writer, args=(f"t{n}",)) for n in range(4)]
    for t in threads: t.start()
    for t in threads: t.join()
    files = eng._load_state()["files"]
    assert len(files) == 200                      # aucune écriture perdue


def test_ingest_single_flight(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub)
    (eng.get_current_data_dir() / "a.txt").write_text("contenu", encoding="utf-8")
    gen1 = eng.ingest_process()
    first = next(gen1)                            # verrou pris
    assert first["type"] == "start"
    gen2 = eng.ingest_process()
    events = list(gen2)
    assert events[0]["type"] == "error"
    assert "en cours" in events[0]["msg"]
    gen1.close()                                  # libère le verrou
    events3 = list(eng.ingest_process())
    assert events3[0]["type"] == "start"          # verrou bien relâché


def test_changement_de_modele_reindexe_tout(tmp_path, monkeypatch):
    """(2026-09-21) Les fichiers « inchangés » étaient sautés après un
    changement de modèle d'embedding : index mêlant deux modèles."""
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub, allowed_ext=[".txt"])
    (eng.get_current_data_dir() / "a.txt").write_text("contenu", encoding="utf-8")
    first = list(eng.ingest_process())
    assert any(e["type"] == "ingest" for e in first)
    again = list(eng.ingest_process())
    assert any(e["type"] == "skip" for e in again)            # rien n'a changé
    eng.cfg["embed_model"] = "autre-modele"
    third = list(eng.ingest_process())
    assert any(e["type"] == "info" for e in third)
    assert any(e["type"] == "ingest" for e in third)          # réindexé
    assert not any(e["type"] == "skip" for e in third)


def test_ingestion_partielle_non_marquee(tmp_path, monkeypatch):
    stub = QdrantStub(fail_upsert=True)
    eng = make_engine(tmp_path, monkeypatch, stub, allowed_ext=[".txt"])
    (eng.get_current_data_dir() / "a.txt").write_text("contenu", encoding="utf-8")
    events = list(eng.ingest_process())
    assert any(e["type"] == "error" for e in events)
    assert not eng._load_state()["files"]                      # sera retenté
