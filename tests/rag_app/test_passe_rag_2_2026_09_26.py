# SPDX-License-Identifier: MIT
"""tests/rag_app/test_passe_rag_2_2026_09_26.py — 2e passe rag_app (cœur,
recherche, application).

Réseau simulé (httpx.MockTransport), aucun Qdrant ni serveur d'embeddings.
"""
from __future__ import annotations

import json
import time

import httpx
import pytest
from starlette.testclient import TestClient

from rag_app import app as A
from rag_app import rag_engine as E
from rag_app import rag_query as rq
from rag_app import reranker as RR
from rag_app import sparse as SP

from tests.rag_app.test_rag_engine_qdrant import QdrantStub, make_engine


# ─── Ingestion ──────────────────────────────────────────────────────────────

def _ingest(eng):
    return list(eng.ingest_process())


def test_ingest_ne_renomme_ni_n_ecrase_aucun_fichier(tmp_path, monkeypatch):
    """P0 : « rapport final.txt » était renommé en « rapport_final.txt » et
    ÉCRASAIT le fichier existant de ce nom."""
    eng = make_engine(tmp_path, monkeypatch, QdrantStub(), allowed_ext=[".txt"])
    d = eng.get_current_data_dir()
    (d / "rapport final.txt").write_text("version A " * 20, encoding="utf-8")
    (d / "rapport_final.txt").write_text("version B " * 20, encoding="utf-8")
    evts = _ingest(eng)
    assert (d / "rapport final.txt").read_text(encoding="utf-8").startswith("version A")
    assert (d / "rapport_final.txt").read_text(encoding="utf-8").startswith("version B")
    assert sum(1 for e in evts if e["type"] == "ingest") == 2


def test_reindex_force_en_echec_est_retente(tmp_path, monkeypatch):
    """Modèle changé + embedder en panne : l'entrée d'état est retirée et
    l'empreinte n'est PAS enregistrée (sinon le fichier gardait à jamais les
    vecteurs de l'ancien modèle)."""
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub, allowed_ext=[".txt"])
    monkeypatch.setattr(E.time, "sleep", lambda s: None)
    f = eng.get_current_data_dir() / "a.txt"
    f.write_text("mot " * 50, encoding="utf-8")
    _ingest(eng)
    key = str(f.resolve())
    old_fp = json.loads((tmp_path / "state.json").read_text())["index_fingerprint"]

    eng.cfg["embed_model"] = "autre-modele"
    stub.fail_embed = True
    evts = _ingest(eng)
    assert any(e["type"] == "error" for e in evts)
    state = json.loads((tmp_path / "state.json").read_text())
    assert key not in state["files"]
    assert state["index_fingerprint"] == old_fp


def test_regle_de_decoupage_reindexe_le_fichier_concerne(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub(), allowed_ext=[".txt"])
    d = eng.get_current_data_dir()
    (d / "a.txt").write_text("mot " * 50, encoding="utf-8")
    (d / "b.txt").write_text("mot " * 50, encoding="utf-8")
    _ingest(eng)
    eng.cfg["file_rules"] = {"a.txt": {"method": "size", "size": "20", "overlap": "0"}}
    evts = _ingest(eng)
    done = {e["file"] for e in evts if e["type"] == "ingest"}
    skipped = {e["file"] for e in evts if e["type"] == "skip"}
    assert done == {"a.txt"} and "b.txt" in skipped


def test_ancienne_empreinte_sans_cles_nouvelles_ne_force_rien():
    old = {"embed_model": "m", "vector_size": None, "global_chunk_size": 1,
           "global_chunk_overlap": 0, "global_max_chunk_size": 9}
    new = {**old, "contextual": False, "sparse": False}
    assert E._fingerprint_differs(old, new) is False
    assert E._fingerprint_differs({**old, "embed_model": "x"}, new) is True


def test_extraction_bloquee_abandonnee(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub(), allowed_ext=[".txt"],
                      extract_timeout_s=0.2)
    f = eng.get_current_data_dir() / "lent.txt"
    f.write_text("x", encoding="utf-8")
    monkeypatch.setattr(eng, "extract_text_strict", lambda p: time.sleep(2) or "x")
    with pytest.raises(E.ExtractionError):
        eng._extract_for_index(f)


# ─── Démarrage / reset / collection ─────────────────────────────────────────

def test_demarrage_qdrant_injoignable_ne_reembed_rien(tmp_path, monkeypatch):
    def down(request):
        raise httpx.ConnectError("refusé")
    monkeypatch.setattr(E, "BASE_DIR", tmp_path)
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"collection": "c", "qdrant_url": "http://q",
                               "embed_base_url": "http://e", "embed_model": "m",
                               "state_file": str(tmp_path / "s.json")}))
    eng = E.RAGEngine(str(cfg), http_client=httpx.Client(transport=httpx.MockTransport(down)))
    f = eng.get_current_data_dir() / "a.txt"
    f.write_text("x", encoding="utf-8")
    eng._update_state(lambda s: s["files"].__setitem__(str(f.resolve()), {"mtime": 1, "hash": "h"}))
    called = []
    monkeypatch.setattr(eng, "reindex_single_file", lambda rel: called.append(rel) or {"ok": True})
    res = eng.startup_reembed_check()
    assert res["ok"] is False and res.get("retry") is True
    assert called == []


def test_reset_ne_vide_que_la_collection_active(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub())
    mine = str(eng.get_current_data_dir().resolve() / "a.txt")
    other = str((tmp_path / "DATA" / "autre" / "b.txt"))
    eng._update_state(lambda s: s["files"].update({mine: {"mtime": 1}, other: {"mtime": 1}}))
    assert eng.purge_database()["ok"] is True
    files = json.loads((tmp_path / "state.json").read_text())["files"]
    assert mine not in files and other in files


def test_ensure_collection_leve_si_dimension_inconnue(tmp_path, monkeypatch):
    stub = QdrantStub(collection_exists=False, fail_embed=True)
    eng = make_engine(tmp_path, monkeypatch, stub, embed_model="modele-sans-cache")
    monkeypatch.setattr(E.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="dimension"):
        eng.ensure_collection()
    assert stub.created_bodies == []          # jamais de 1024 codé en dur


def test_ensure_collection_une_seule_verification(tmp_path, monkeypatch):
    stub = QdrantStub()
    eng = make_engine(tmp_path, monkeypatch, stub)
    eng.ensure_collection()
    n = len(stub.requests)
    eng.ensure_collection()
    assert len(stub.requests) == n


def test_embeddings_4xx_sans_reessai_et_cause_remontee(tmp_path, monkeypatch):
    calls = {"n": 0}

    def h(request):
        calls["n"] += 1
        return httpx.Response(413, text="input too long")
    eng = make_engine(tmp_path, monkeypatch, QdrantStub())
    eng.http_client = httpx.Client(transport=httpx.MockTransport(h))
    monkeypatch.setattr(E.time, "sleep", lambda s: None)
    assert eng.get_embeddings(["x"]) == [[]]
    assert calls["n"] == 1
    assert "413" in E._index_incomplete(0, 3)


def test_metadonnees_n_ecrasent_pas_l_identite():
    pt = E._build_point("/d/a.txt", "a.txt", "", ".txt", 0, "t", [0.1],
                        extra_payload={"path": "/pirate", "page": 3})
    assert pt["payload"]["path"] == "/d/a.txt" and pt["payload"]["page"] == 3


def test_suppression_d_un_dossier_refusee(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub())
    (eng.get_current_data_dir() / "sous").mkdir()
    res = eng.delete_file("sous")
    assert res["ok"] is False and "dossier" in res["msg"]


# ─── Configuration ──────────────────────────────────────────────────────────

def test_config_state_file_hors_du_service_refuse(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub())
    with pytest.raises(E.ConfigInvalide):
        eng.save_config({"state_file": "/etc/cron.d/x.json"})
    with pytest.raises(E.ConfigInvalide):
        eng.save_config({"allowed_ext": ".pdf"})
    with pytest.raises(E.ConfigInvalide):
        eng.save_config({"qdrant_url": "ftp://x"})


def test_config_fusion_profonde_et_edition_disque_preservee(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub(),
                      sparse={"enabled": False, "url": "http://s", "timeout": 5})
    p = tmp_path / "rag_config.json"
    on_disk = json.loads(p.read_text())
    on_disk["cle_manuelle"] = 1
    p.write_text(json.dumps(on_disk))
    eng.save_config({"sparse": {"enabled": True}})
    saved = json.loads(p.read_text())
    assert saved["sparse"] == {"enabled": True, "url": "http://s", "timeout": 5}
    assert saved["cle_manuelle"] == 1


def test_config_imbriquee_invalide_ne_casse_rien():
    cfg = {"reranker": {"enabled": "false", "timeout": "10s", "top_k_before": [1]},
           "sparse": {"enabled": False, "timeout": "x", "prefetch_limit": "abc"}}
    assert RR.is_enabled(cfg) is False
    assert RR._cfg_section(cfg)["timeout"] == 10.0
    assert SP.prefetch_limit(cfg) == 50


def test_sparse_reponse_de_mauvaise_longueur(monkeypatch):
    class _C:
        def post(self, *a, **k):
            return httpx.Response(200, json={"error": "x"})
    monkeypatch.setattr(SP, "_client", lambda: _C())
    out = SP.get_sparse_embeddings(["a", "b"], {"sparse": {"enabled": True, "url": "http://s"}})
    assert out == [None, None]


# ─── Recherche : identification par chemin ──────────────────────────────────

def _docs_transport(points, fail=False):
    def h(request):
        if fail:
            raise httpx.ConnectError("down")
        body = json.loads(request.content.decode() or "{}")
        path = request.url.path
        if path.endswith("/points/scroll"):
            must = (body.get("filter") or {}).get("must") or []
            pts = points
            for m in must:
                if "match" in m:
                    pts = [p for p in pts if p["payload"].get(m["key"]) == m["match"]["value"]]
                if "range" in m:
                    r = m["range"]
                    pts = [p for p in pts if r["gte"] <= p["payload"]["chunk_index"] < r["lt"]]
            return httpx.Response(200, json={"result": {"points": pts, "next_page_offset": None}})
        if path.endswith("/points/count"):
            pts = points
            for m in body["filter"]["must"]:
                if "match" in m:
                    pts = [p for p in pts if p["payload"].get(m["key"]) == m["match"]["value"]]
                if "range" in m:
                    pts = [p for p in pts if p["payload"]["chunk_index"] >= m["range"]["gte"]]
            n = len(pts)
            return httpx.Response(200, json={"result": {"count": n}})
        return httpx.Response(404)
    return httpx.Client(transport=httpx.MockTransport(h))


def _pt(path, idx, text="t"):
    name = path.rsplit("/", 1)[-1]
    return {"id": hash((path, idx)), "payload": {"path": path, "name": name, "text": text,
                                                   "chunk_index": idx, "folder": ""}}


CFG = {"qdrant_url": "http://q", "collection": "c", "tool_max_chunks": 3}


@pytest.fixture
def _rq_isole(monkeypatch):
    rq.invalidate_docs_cache()
    rq._SEARCH_ERROR.set(None)
    yield monkeypatch
    rq.invalidate_docs_cache()


def test_homonymes_distingues_par_chemin(_rq_isole):
    pts = [_pt("/x/DATA/c/a/README.md", 0), _pt("/x/DATA/c/b/README.md", 0)]
    _rq_isole.setattr(rq, "_http_client", _docs_transport(pts))
    assert rq.list_indexed_files(CFG) == ["a/README.md", "b/README.md"]
    assert len(rq.resolve_documents(CFG, "README.md")) == 2        # ambigu
    [doc] = rq.resolve_documents(CFG, "b/README.md")
    assert doc["path"] == "/x/DATA/c/b/README.md"
    assert rq.count_chunks_for_file(CFG, "README.md", path=doc["path"]) == 1


def test_fichier_entier_fenetre_contigue(_rq_isole):
    pts = [_pt("/x/DATA/c/gros.md", i, f"c{i}") for i in range(10)]
    _rq_isole.setattr(rq, "_http_client", _docs_transport(pts))
    got = rq.get_all_chunks_for_files(CFG, ["gros.md"])
    assert [c["chunk_index"] for c in got] == [0, 1, 2]           # début, sans trou


def test_fichier_entier_saute_les_trous_d_index(_rq_isole):
    # Chunk 1 découpé : retiré, enfants numérotés 3 et 4 après le dernier.
    pts = [_pt("/x/DATA/c/d.md", i) for i in (0, 2, 3, 4)]
    _rq_isole.setattr(rq, "_http_client", _docs_transport(pts))
    got = rq.get_all_chunks_for_files({**CFG, "tool_max_chunks": 10}, ["d.md"])
    assert [c["chunk_index"] for c in got] == [0, 2, 3, 4]


def test_reset_oublie_l_empreinte_meme_si_la_recreation_echoue(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub())
    mine = str(eng.get_current_data_dir().resolve() / "a.txt")
    eng._update_state(lambda s: (s["files"].__setitem__(mine, {"mtime": 1}),
                                 s.__setitem__("index_fingerprint", {"vector_size": 1})))

    def boom():
        raise RuntimeError("embedder tombé")
    monkeypatch.setattr(eng, "ensure_collection", boom)
    assert eng.purge_database()["ok"] is False
    st = json.loads((tmp_path / "state.json").read_text())
    assert mine not in st["files"] and "index_fingerprint" not in st


def test_delai_nul_vaut_defaut():
    assert RR._cfg_section({"reranker": {"timeout": 0}})["timeout"] == 10.0


def test_panne_qdrant_n_est_pas_une_collection_vide(_rq_isole):
    _rq_isole.setattr(rq, "_http_client", _docs_transport([], fail=True))
    assert rq.list_indexed_files(CFG) == []
    assert rq._SEARCH_ERROR.get()


def test_nom_cite_non_indexe_ne_filtre_pas_la_recherche(_rq_isole, tmp_path):
    cfg_file = tmp_path / "rag_config.json"
    cfg_file.write_text(json.dumps({**CFG, "embed_base_url": "http://e", "embed_model": "m",
                                    "allowed_ext": [".json"], "top_k": 5}))
    _rq_isole.setattr(rq, "CONFIG_FILE", cfg_file)
    _rq_isole.setattr(rq, "TRACE_FILE", tmp_path / "t.json")
    _rq_isole.setattr(rq, "_http_client", _docs_transport([]))
    _rq_isole.setattr(rq, "get_embeddings", lambda q, cfg: [0.1])
    seen = {}

    def fake_search(vec, cfg, **kw):
        seen.update(kw)
        return [{"score": 0.9, "payload": {"text": "réponse", "name": "x.md",
                                           "folder": "", "chunk_index": 0}}]
    _rq_isole.setattr(rq, "search_qdrant", fake_search)
    out = rq.rag("que contient package.json ?")
    rq.flush_traces()
    assert out is not None
    assert not seen.get("target_filenames")


def test_budget_de_temps_epuise():
    rq._DEADLINE.set(time.monotonic() - 1)
    try:
        with pytest.raises(TimeoutError):
            rq._t(10.0)
    finally:
        rq._DEADLINE.set(None)


def test_traces_tronquees(tmp_path, monkeypatch):
    monkeypatch.setattr(rq, "TRACE_FILE", tmp_path / "t.json")
    rq.save_trace("q", {}, "m", [{"source": "s", "text": "x" * 5000}])
    rq.flush_traces()
    [t] = json.loads((tmp_path / "t.json").read_text())
    assert len(t["chunks"][0]["text"]) <= rq._TRACE_TEXT_MAX + 1


# ─── Application ────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    return TestClient(A.app, client=("127.0.0.1", 50000))


@pytest.fixture
def eng_app(tmp_path, monkeypatch):
    eng = make_engine(tmp_path, monkeypatch, QdrantStub(), allowed_ext=[".txt"])
    monkeypatch.setattr(A, "engine", eng)
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "_index_task", None)
    return eng


def _wait_task(client, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        t = client.get("/api/tasks/index").json()["task"]
        if t and t["state"] != "running":
            return t
        time.sleep(0.05)
    raise AssertionError("tâche non terminée")


def test_indexation_de_fond_sans_client_connecte(client, eng_app):
    (eng_app.get_current_data_dir() / "a.txt").write_text("mot " * 40, encoding="utf-8")
    r = client.post("/api/tasks/index", json={"kind": "ingest"})
    assert r.status_code == 202
    t = _wait_task(client)
    assert t["state"] == "done" and t["success"] == 1
    types = [e["type"] for e in t["events"]]
    assert types[0] == "start" and types[-1] == "end"
    # Flux de suivi : rejoue puis se ferme sur « end ».
    body = client.get("/api/tasks/index/events", params={"since": 0}).text
    assert '"type": "end"' in body


def test_une_seule_indexation_a_la_fois(client, eng_app, monkeypatch):
    task = A._IndexTask("ingest", None)
    monkeypatch.setattr(A, "_index_task", task)
    r = client.post("/api/tasks/index", json={"kind": "bulk_reindex"})
    assert r.status_code == 409 and r.json()["task_id"] == task.id
    r = client.post("/api/restart", json={})
    assert r.status_code == 409


def test_upload_extension_refusee_et_ecrasement_signale(client, eng_app):
    d = eng_app.get_current_data_dir()
    (d / "deja.txt").write_text("ancien", encoding="utf-8")
    r = client.post("/api/upload",
                    files=[("files", ("deja.txt", b"neuf", "text/plain")),
                           ("files", ("prog.exe", b"MZ", "application/octet-stream"))],
                    data={"paths": ["deja.txt", "prog.exe"]})
    body = r.json()
    assert body["overwritten"] == ["deja.txt"]
    assert body["rejected"][0]["name"] == "prog.exe"
    assert not (d / "prog.exe").exists()


def test_upload_trop_gros_refuse_avant_lecture(client, eng_app, monkeypatch):
    monkeypatch.setattr(A, "_REQUEST_MAX_BYTES", 10)
    r = client.post("/api/upload",
                    files=[("files", ("a.txt", b"x" * 100, "text/plain"))],
                    data={"paths": "a.txt"})
    assert r.status_code == 413


def test_config_invalide_422(client, eng_app):
    r = client.post("/api/config", json={"embed_base_url": "pas une url"})
    assert r.status_code == 422


def test_cookie_console_revoque_a_la_deconnexion(client, monkeypatch):
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "JETON")
    r = client.post("/api/console/login", json={"token": "JETON"})
    cookie = r.cookies.get(A._CONSOLE_COOKIE)
    assert cookie
    c2 = TestClient(A.app, client=("10.0.0.2", 1))
    c2.cookies.set(A._CONSOLE_COOKIE, cookie)
    assert c2.get("/api/startup_status").status_code == 200
    c2.post("/api/console/logout")
    c3 = TestClient(A.app, client=("10.0.0.2", 1))
    c3.cookies.set(A._CONSOLE_COOKIE, cookie)
    assert c3.get("/api/startup_status").status_code == 401


def test_cookie_console_expire_cote_serveur(monkeypatch):
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "JETON")
    old = A._console_cookie_value("JETON", exp=int(time.time()) - 10)
    c = TestClient(A.app, client=("10.0.0.2", 1))
    c.cookies.set(A._CONSOLE_COOKIE, old)
    assert c.get("/api/startup_status").status_code == 401
