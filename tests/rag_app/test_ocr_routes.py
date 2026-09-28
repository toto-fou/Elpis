# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_routes.py — endpoints /api/ocr/* (rag_app).

Le routeur est monté sur une app FastAPI de test (JAMAIS rag_app.app : son
import tire rag_engine → pdf2docx qui crash le sandbox dev). Surface
MONO-TENANT sans auth : gate ``ocr.enabled`` (404), statut, modèles, upload
(validation extension / endpoint absent / quotas), liste + détail, restart
(reprise / redo / 409), cancel, delete, tags, RAG in-process (status /
index / remove / stale), file d'attente, export Markdown, pages (GET / PUT /
image / rerun zone+page) — et la DISPARITION des routes du chatbot
(exports pro, ask/extract/conformity, gabarits).
"""
from __future__ import annotations

import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from rag_app.ocr import client as ocr_client
from rag_app.ocr import config as ocr_config
from rag_app.ocr import jobs as ocr_jobs
from rag_app.ocr import queue as ocr_queue
from rag_app.ocr import rag_index as ocr_rag
from rag_app.ocr import store as ocr_store
from rag_app.ocr._common import OcrError

_SECTION = {
    "enabled": True, "endpoint_url": "http://ocr.test:8090",
    "default_model": "unlimited-ocr", "timeout_sec": 5, "max_tokens": 512,
    "max_side_px": 640, "max_upload_mb": 1, "max_pages": 10, "max_docs": 2,
}


def _client(monkeypatch, tmp_path, section=None):
    """App de test : router seul + config isolée (bloc ocr patché à la
    SOURCE — _read_section — pour couvrir routes/store/jobs/rag_index)."""
    sec = dict(_SECTION if section is None else section)
    monkeypatch.setattr(ocr_config, "_read_section", lambda: dict(sec))
    monkeypatch.setattr(ocr_store, "ocr_root", lambda: tmp_path)
    # Ni le job réel ni la préparation ne sont lancés dans ces tests.
    started, prepared = [], []
    monkeypatch.setattr(ocr_jobs, "start_job",
                        lambda doc_id: started.append(doc_id) or True)
    monkeypatch.setattr(ocr_jobs, "start_prepare",
                        lambda doc_id: prepared.append(doc_id) or True)
    # Désindexation best-effort : jamais le vrai _engine (import rag_engine).
    monkeypatch.setattr(ocr_rag, "deindex_doc", lambda doc_id: False)

    from rag_app.ocr.routes import router
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    client.started, client.prepared = started, prepared
    return client, started


def _upload(client, name="doc.pdf", content=b"%PDF-fake"):
    return client.post("/api/ocr/docs",
                       files={"file": (name, io.BytesIO(content), "application/pdf")})


def _quiet_queue(monkeypatch):
    """Coupe la pompe réelle (elle appellerait le vrai stream_ocr) et le bus."""
    async def _noop_emit():
        return None
    monkeypatch.setattr(ocr_jobs, "ensure_queue_runner", lambda: False)
    monkeypatch.setattr(ocr_jobs, "_emit_queue", _noop_emit)


# ─────────────────────────────────────────────────────────────────────────────
#  Gate + statut
# ─────────────────────────────────────────────────────────────────────────────
def test_gate_404_quand_desactive(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path, section={"enabled": False})
    # /status répond toujours (l'UI y lit s'il faut afficher l'onglet).
    st = client.get("/api/ocr/status")
    assert st.status_code == 200 and st.json()["enabled"] is False
    assert client.get("/api/ocr/docs").status_code == 404
    assert _upload(client).status_code == 404
    assert client.get("/api/ocr/queue").status_code == 404
    assert client.get("/api/ocr/rag/status").status_code == 404


def test_status(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    d = client.get("/api/ocr/status").json()
    assert d["enabled"] is True and d["endpoint_configured"] is True
    assert d["default_model"] == "unlimited-ocr"
    assert d["max_upload_mb"] == 1 and d["max_pages"] == 10


def test_status_endpoint_absent(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path,
                         section={**_SECTION, "endpoint_url": ""})
    assert client.get("/api/ocr/status").json()["endpoint_configured"] is False
    # et l'upload est refusé tant que rien n'est configuré
    assert _upload(client).status_code == 503


# ─────────────────────────────────────────────────────────────────────────────
#  Upload / liste / détail
# ─────────────────────────────────────────────────────────────────────────────
def test_upload_prepare_sans_lancer(monkeypatch, tmp_path):
    """Le dépôt PRÉPARE (aperçus) mais ne lance JAMAIS la reconnaissance —
    elle attend le bouton « Lancer » (POST /restart)."""
    client, started = _client(monkeypatch, tmp_path)
    r = _upload(client, "Rapport.pdf")
    assert r.status_code == 200
    d = r.json()
    assert d["name"] == "Rapport.pdf" and d["status"] == "uploaded"
    assert d["prepare_started"] is True
    assert client.prepared == [d["id"]]
    assert started == []
    # le fichier source est bien posé
    doc = ocr_store.doc_dir(d["id"])
    assert (doc / "source.pdf").read_bytes() == b"%PDF-fake"
    # et la liste le renvoie
    items = client.get("/api/ocr/docs").json()["items"]
    assert [i["id"] for i in items] == [d["id"]]


def test_upload_extension_refusee(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    assert _upload(client, "x.exe").status_code == 415


def test_upload_quota_docs(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    assert _upload(client, "a.pdf").status_code == 200
    assert _upload(client, "b.pdf").status_code == 200
    assert _upload(client, "c.pdf").status_code == 409      # max_docs = 2


def test_upload_trop_gros(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    big = b"x" * (2 * 1024 * 1024)                          # max_upload_mb = 1
    r = _upload(client, "big.pdf", big)
    assert r.status_code == 413
    assert client.get("/api/ocr/docs").json()["items"] == []   # pas de fantôme


def test_upload_quota_disque(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    monkeypatch.setattr(ocr_store, "disk_usage",
                        lambda: 10 * 1024 * 1024 * 1024)   # 10 Go
    r = _upload(client, "gros.pdf")
    assert r.status_code == 409
    assert "satur" in r.json()["detail"].lower()


def test_upload_prepare_non_lance(monkeypatch, tmp_path):
    """Préparation refusée au dépôt : le doc est GARDÉ (relançable) et la
    réponse porte prepare_started=false — le front prévient l'utilisateur."""
    client, _s = _client(monkeypatch, tmp_path)
    monkeypatch.setattr(ocr_jobs, "start_prepare", lambda doc_id: False)
    r = _upload(client, "occupe.pdf")
    assert r.status_code == 200
    d = r.json()
    assert d["prepare_started"] is False
    assert d["status"] == "uploaded"          # pas supprimé, pas fantôme
    assert client.get(f"/api/ocr/docs/{d['id']}").status_code == 200


def test_upload_avec_modele(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    r = client.post("/api/ocr/docs",
                    files={"file": ("d.pdf", io.BytesIO(b"%PDF"), "application/pdf")},
                    data={"model": "deepseek-ocr"})
    assert r.status_code == 200
    meta = ocr_store.read_meta(ocr_store.doc_dir(r.json()["id"]))
    assert meta["model"] == "deepseek-ocr"


def test_upload_modele_invalide(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    r = client.post("/api/ocr/docs",
                    files={"file": ("d.pdf", io.BytesIO(b"%PDF"), "application/pdf")},
                    data={"model": "x" * 300})
    assert r.status_code == 422


def test_detail_et_404(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id = _upload(client).json()["id"]
    assert client.get(f"/api/ocr/docs/{doc_id}").json()["id"] == doc_id
    assert client.get("/api/ocr/docs/20990101-000000-deadbeef").status_code == 404
    assert client.get("/api/ocr/docs/../etc").status_code == 404


def _with_page(client, md="# transcrit"):
    """Upload + fabrique une page « done » directement dans le store."""
    doc_id = client.post("/api/ocr/docs",
                         files={"file": ("d.pdf", io.BytesIO(b"%PDF"), "application/pdf")}
                         ).json()["id"]
    d = ocr_store.doc_dir(doc_id)
    ocr_store.update_meta(d, lambda m: m.update(
        status="done", pages_total=1, pages_done=1,
        pages=[{"n": 1, "w": 640, "h": 900, "chars": 10, "status": "running",
                "edited": False, "divergence": None, "boxes": 0}]))
    (d / "pages" / "0001.png").write_bytes(b"\x89PNG-fake")
    ocr_store.save_page_result(d, 1, md, [{"text": "t", "box": [1, 2, 3, 4]}], 0.05)
    return doc_id, d


# ─────────────────────────────────────────────────────────────────────────────
#  Pages / export / suppression / tags / recherche
# ─────────────────────────────────────────────────────────────────────────────
def test_page_get_put_et_image(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    page = client.get(f"/api/ocr/docs/{doc_id}/pages/1").json()
    assert page["md"] == "# transcrit" and len(page["boxes"]) == 1
    img = client.get(f"/api/ocr/docs/{doc_id}/pages/1/image")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert client.get(f"/api/ocr/docs/{doc_id}/pages/9").status_code == 404
    # PUT : l'édition humaine remplace et marque la page
    r = client.put(f"/api/ocr/docs/{doc_id}/pages/1", json={"md": "# corrigé"})
    assert r.status_code == 200
    assert client.get(f"/api/ocr/docs/{doc_id}/pages/1").json()["md"] == "# corrigé"
    meta = ocr_store.read_meta(d)
    assert meta["pages"][0]["edited"] is True
    assert client.put(f"/api/ocr/docs/{doc_id}/pages/1", json={}).status_code == 422


def test_rerun_zone_et_page(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, _d = _with_page(client)

    async def fake_zone(png_path, bbox, *, cfg):
        assert bbox == [10, 20, 200, 120]
        assert cfg.get("model") == "unlimited-ocr"   # modèle du doc/défaut
        return "texte de zone"
    monkeypatch.setattr(ocr_client, "ocr_zone", fake_zone)
    r = client.post(f"/api/ocr/docs/{doc_id}/pages/1/rerun",
                    json={"bbox": [10, 20, 200, 120]})
    assert r.status_code == 200 and r.json()["text"] == "texte de zone"
    assert client.post(f"/api/ocr/docs/{doc_id}/pages/1/rerun",
                       json={"bbox": [1, 2]}).status_code == 422

    reruns = []
    monkeypatch.setattr(ocr_jobs, "start_page_rerun",
                        lambda doc, n: reruns.append((doc, n)) or True)
    assert client.post(f"/api/ocr/docs/{doc_id}/pages/1/rerun").status_code == 200
    assert reruns == [(doc_id, 1)]
    # slot occupé → 409
    monkeypatch.setattr(ocr_jobs, "start_page_rerun", lambda doc, n: False)
    assert client.post(f"/api/ocr/docs/{doc_id}/pages/1/rerun").status_code == 409


def test_rerun_zone_erreur_endpoint(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, _d = _with_page(client)

    async def boom(png_path, bbox, *, cfg):
        raise OcrError("Endpoint OCR injoignable (ConnectError).")
    monkeypatch.setattr(ocr_client, "ocr_zone", boom)
    r = client.post(f"/api/ocr/docs/{doc_id}/pages/1/rerun",
                    json={"bbox": [0, 0, 10, 10]})
    assert r.status_code == 502


def test_export(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, _d = _with_page(client, md="# Page une")
    r = client.get(f"/api/ocr/docs/{doc_id}/export")
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    assert "<!-- page 1 -->" in r.text and "# Page une" in r.text


def test_delete(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, _d = _with_page(client)
    deindexed = []
    monkeypatch.setattr(ocr_rag, "deindex_doc",
                        lambda did: deindexed.append(did) or False)
    # Document non indexé : rien à retirer de la recherche.
    assert client.delete(f"/api/ocr/docs/{doc_id}").status_code == 200
    assert client.get(f"/api/ocr/docs/{doc_id}").status_code == 404
    assert deindexed == []


def test_delete_document_indexe_refuse_si_desindexation_echoue(monkeypatch, tmp_path):
    """(2026-09-21) Ses vecteurs resteraient interrogeables sans plus aucun
    moyen de les retirer : la suppression attend que Qdrant réponde."""
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    ocr_store.update_meta(d, lambda m: m.__setitem__(
        "rag", {"collection": "ocr-documents", "rel_path": "x.md"}))
    monkeypatch.setattr(ocr_rag, "deindex_doc", lambda did: False)
    assert client.delete(f"/api/ocr/docs/{doc_id}").status_code == 502
    assert client.get(f"/api/ocr/docs/{doc_id}").status_code == 200
    monkeypatch.setattr(ocr_rag, "deindex_doc", lambda did: True)
    assert client.delete(f"/api/ocr/docs/{doc_id}").status_code == 200
    assert client.get(f"/api/ocr/docs/{doc_id}").status_code == 404


def test_search(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, _d = _with_page(client, md="# Rapport\nLa pompe P-101 fuit.")
    d = client.get("/api/ocr/search", params={"q": "pompe p-101"}).json()
    assert len(d["items"]) == 1
    hit = d["items"][0]
    assert hit["id"] == doc_id and hit["pages"][0]["n"] == 1
    assert "P-101" in hit["pages"][0]["snippet"]
    assert client.get("/api/ocr/search", params={"q": "x"}).json()["items"] == []


def test_tags(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    r = client.post(f"/api/ocr/docs/{doc_id}/tags",
                    json={"tags": [" chantier ", "2026", "chantier", ""]})
    assert r.status_code == 200
    assert r.json()["tags"] == ["chantier", "2026"]
    assert ocr_store.read_meta(d)["tags"] == ["chantier", "2026"]
    assert client.post(f"/api/ocr/docs/{doc_id}/tags",
                       json={"tags": "nope"}).status_code == 422


# ─────────────────────────────────────────────────────────────────────────────
#  Restart / cancel
# ─────────────────────────────────────────────────────────────────────────────
def test_restart(monkeypatch, tmp_path):
    client, started = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    ocr_store.update_meta(d, lambda m: m.__setitem__("status", "error"))
    assert client.post(f"/api/ocr/docs/{doc_id}/restart").status_code == 200
    assert started[-1] == doc_id


def test_restart_changement_de_modele_redo_complet(monkeypatch, tmp_path):
    """Changer de modèle à la relance = comparaison → toutes les pages
    repartent (statuts/éditions remis), le doc mémorise le nouveau modèle."""
    client, started = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    ocr_store.update_meta(d, lambda m: (
        m.__setitem__("model", "unlimited-ocr"),
        m.__setitem__("rag", {"collection": "ocr-documents", "rel_path": "x.md",
                              "name": "x.md", "indexed_at": 1.0, "chunks": 1,
                              "stale": False}),
        [p.__setitem__("edited", True) for p in m["pages"]]))
    r = client.post(f"/api/ocr/docs/{doc_id}/restart", json={"model": "deepseek-ocr"})
    assert r.status_code == 200 and started[-1] == doc_id
    meta = ocr_store.read_meta(d)
    assert meta["model"] == "deepseek-ocr"
    assert meta["pages_done"] == 0
    assert meta["pages"][0]["status"] == "pending"
    assert meta["pages"][0]["edited"] is False
    assert meta["rag"]["stale"] is True            # redo → index RAG périmé


def test_restart_meme_modele_preserve(monkeypatch, tmp_path):
    client, started = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    ocr_store.update_meta(d, lambda m: (
        m.__setitem__("status", "canceled"),
        m.__setitem__("model", "unlimited-ocr")))
    assert client.post(f"/api/ocr/docs/{doc_id}/restart",
                       json={"model": "unlimited-ocr"}).status_code == 200
    meta = ocr_store.read_meta(d)
    assert meta["pages"][0]["status"] == "done"    # reprise : page conservée


def test_restart_full_meme_modele(monkeypatch, tmp_path):
    """« Tout relire » : full=true refait TOUT même sans changer de modèle."""
    client, started = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    ocr_store.update_meta(d, lambda m: (
        m.__setitem__("model", "unlimited-ocr"),
        [p.__setitem__("edited", True) for p in m["pages"]]))
    r = client.post(f"/api/ocr/docs/{doc_id}/restart",
                    json={"model": "unlimited-ocr", "full": True})
    assert r.status_code == 200 and started[-1] == doc_id
    meta = ocr_store.read_meta(d)
    assert meta["model"] == "unlimited-ocr"
    assert meta["pages"][0]["status"] == "pending"
    assert meta["pages"][0]["edited"] is False


def test_restart_lance_un_doc_pret(monkeypatch, tmp_path):
    """Le bouton « Lancer » = POST /restart sur un doc préparé (ready)."""
    client, started = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    ocr_store.update_meta(d, lambda m: (
        m.__setitem__("status", "ready"),
        [p.__setitem__("status", "pending") for p in m["pages"]]))
    assert client.post(f"/api/ocr/docs/{doc_id}/restart").status_code == 200
    assert started[-1] == doc_id


def test_restart_slot_occupe(monkeypatch, tmp_path):
    """job_busy (doc en vol ou pompe vivante) → 409 ; le dépôt reste permis
    (la préparation n'occupe pas le slot OCR)."""
    client, _s = _client(monkeypatch, tmp_path)
    doc_id = _upload(client, "x.pdf").json()["id"]
    monkeypatch.setattr(ocr_jobs, "job_busy", lambda: "file")
    assert client.post(f"/api/ocr/docs/{doc_id}/restart").status_code == 409
    assert _upload(client, "y.pdf").status_code == 200


def test_restart_refus_start_job(monkeypatch, tmp_path):
    """Course résiduelle : start_job rend False → 409 (jamais un faux ok)."""
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    monkeypatch.setattr(ocr_jobs, "start_job", lambda doc: False)
    assert client.post(f"/api/ocr/docs/{doc_id}/restart").status_code == 409


def test_cancel(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, _d = _with_page(client)
    # rien ne tourne → 409
    assert client.post(f"/api/ocr/docs/{doc_id}/cancel").status_code == 409
    monkeypatch.setattr(ocr_jobs, "cancel_job", lambda doc: True)
    assert client.post(f"/api/ocr/docs/{doc_id}/cancel").status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
#  Modèles découverts
# ─────────────────────────────────────────────────────────────────────────────
def test_models_decouverte(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)

    async def fake_fetch(cfg):
        return [{"id": "unlimited-ocr", "state": "loaded"},
                {"id": "deepseek-ocr", "state": "unloaded"}]
    monkeypatch.setattr(ocr_client, "fetch_models", fake_fetch)
    d = client.get("/api/ocr/models").json()
    assert [m["id"] for m in d["models"]] == ["unlimited-ocr", "deepseek-ocr"]
    assert d["models"][0]["state"] == "loaded"
    assert d["default"] == "unlimited-ocr" and d["error"] == ""


def test_models_load_unload(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    calls = []

    async def fake_load(cfg, model):
        calls.append(("load", model))

    async def fake_unload(cfg, model):
        calls.append(("unload", model))
    monkeypatch.setattr(ocr_client, "load_model", fake_load)
    monkeypatch.setattr(ocr_client, "unload_model", fake_unload)
    assert client.post("/api/ocr/models/load",
                       json={"model": "unlimited-ocr"}).status_code == 200
    assert client.post("/api/ocr/models/unload",
                       json={"model": "unlimited-ocr"}).status_code == 200
    assert calls == [("load", "unlimited-ocr"), ("unload", "unlimited-ocr")]
    assert client.post("/api/ocr/models/load", json={}).status_code == 422


def test_models_serveur_injoignable(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)

    async def boom(cfg):
        raise OcrError("Serveur OCR injoignable (ConnectError).")
    monkeypatch.setattr(ocr_client, "fetch_models", boom)
    d = client.get("/api/ocr/models").json()
    assert d["models"] == [] and "injoignable" in d["error"]


def test_models_non_configure(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path,
                         section={**_SECTION, "endpoint_url": ""})
    d = client.get("/api/ocr/models").json()
    assert d["models"] == [] and "non configuré" in d["error"]


# ─────────────────────────────────────────────────────────────────────────────
#  RAG in-process (statut / index / stale / remove)
# ─────────────────────────────────────────────────────────────────────────────
def test_rag_status_toujours_configure(monkeypatch, tmp_path):
    """In-process : plus de sonde « service configuré ? » — toujours vrai,
    la vraie disponibilité (Qdrant/embedder) se voit à l'indexation."""
    client, _s = _client(monkeypatch, tmp_path)
    d = client.get("/api/ocr/rag/status").json()
    assert d["configured"] is True and d["error"] == ""
    assert d["default_collection"] == "ocr-documents"
    assert d["auto_index"] is False


def test_rag_index_et_stale(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, d = _with_page(client)
    # index simulé (le pont in-process est testé dans test_ocr_rag_index)
    indexed = []
    monkeypatch.setattr(ocr_rag, "index_doc",
                        lambda did, col="": indexed.append((did, col)) or
                        {"collection": "ocr-documents", "rel_path": "x.md",
                         "name": "x.md", "indexed_at": 1.0, "chunks": 1,
                         "stale": False})
    r = client.post(f"/api/ocr/docs/{doc_id}/rag/index", json={})
    assert r.status_code == 200
    assert r.json()["rag"]["collection"] == "ocr-documents"
    assert indexed == [(doc_id, "")]
    # collection explicite (validée), invalide → 422
    client.post(f"/api/ocr/docs/{doc_id}/rag/index", json={"collection": "perso"})
    assert indexed[-1] == (doc_id, "perso")
    assert client.post(f"/api/ocr/docs/{doc_id}/rag/index",
                       json={"collection": "in valide!"}).status_code == 422
    # échec d'indexation (embedder éteint) → 502, message utilisateur
    def _boom(did, col=""):
        raise OcrError("Indexation RAG impossible : embedder éteint")
    monkeypatch.setattr(ocr_rag, "index_doc", _boom)
    assert client.post(f"/api/ocr/docs/{doc_id}/rag/index",
                       json={}).status_code == 502
    # poser meta.rag réellement pour tester les hooks stale
    ocr_store.update_meta(d, lambda m: m.__setitem__("rag", {
        "collection": "ocr-documents", "rel_path": "x.md", "name": "x.md",
        "indexed_at": 1.0, "chunks": 1, "stale": False}))
    client.put(f"/api/ocr/docs/{doc_id}/pages/1", json={"md": "édité"})
    assert ocr_store.read_meta(d)["rag"]["stale"] is True
    # doc non transcrit → 409
    empty = _upload(client, "e.pdf").json()["id"]
    assert client.post(f"/api/ocr/docs/{empty}/rag/index", json={}).status_code == 409
    # désindexation : 409 si pas indexé, 200 sinon, 502 si l'engine échoue
    assert client.request("DELETE", f"/api/ocr/docs/{empty}/rag").status_code == 409
    assert client.request("DELETE", f"/api/ocr/docs/{doc_id}/rag").status_code == 502
    monkeypatch.setattr(ocr_rag, "deindex_doc", lambda did: True)
    assert client.request("DELETE", f"/api/ocr/docs/{doc_id}/rag").status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
#  File d'attente (routes)
# ─────────────────────────────────────────────────────────────────────────────
def test_queue_cycle_complet(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    _quiet_queue(monkeypatch)
    a = _upload(client, "a.pdf").json()["id"]
    b = _upload(client, "b.pdf").json()["id"]
    # enqueue (validation des statuts : uploaded accepté)
    r = client.post("/api/ocr/queue/items", json={"doc_ids": [a, b]})
    assert r.status_code == 200
    snap = r.json()
    assert [it["doc"] for it in snap["items"]] == [a, b]
    assert snap["batch"]["total"] == 2
    # GET = snapshot
    assert client.get("/api/ocr/queue").json()["items"][0]["name"] == "a.pdf"
    # pause / reprise
    assert client.post("/api/ocr/queue/pause").json()["paused"] is True
    assert client.post("/api/ocr/queue/resume").json()["paused"] is False
    # restart direct REFUSÉ pendant une file
    assert client.post(f"/api/ocr/docs/{a}/restart").status_code == 409
    # retrait d'un élément en attente
    assert client.request("DELETE", f"/api/ocr/queue/items/{b}").status_code == 200
    assert [it["doc"] for it in client.get("/api/ocr/queue").json()["items"]] == [a]
    # retrait d'un élément ACTIF → 409
    ocr_queue.pop_next()
    assert client.request("DELETE", f"/api/ocr/queue/items/{a}").status_code == 409
    # vidage
    assert client.request("DELETE", "/api/ocr/queue").status_code == 200
    assert client.get("/api/ocr/queue").json()["items"] == []


def test_queue_clear_cancel_active(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    _quiet_queue(monkeypatch)
    a = _upload(client, "a.pdf").json()["id"]
    client.post("/api/ocr/queue/items", json={"doc_ids": [a]})
    ocr_queue.pop_next()
    canceled = []
    monkeypatch.setattr(ocr_jobs, "cancel_job",
                        lambda doc: canceled.append(doc) or True)
    r = client.request("DELETE", "/api/ocr/queue", json={"cancel_active": True})
    assert r.status_code == 200
    assert canceled == [a]


def test_queue_validation(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    _quiet_queue(monkeypatch)
    assert client.post("/api/ocr/queue/items",
                       json={"doc_ids": []}).status_code == 422
    assert client.post("/api/ocr/queue/items",
                       json={"doc_ids": ["20990101-000000-deadbeef"]}).status_code == 404


def test_delete_doc_purge_la_file(monkeypatch, tmp_path):
    client, _s = _client(monkeypatch, tmp_path)
    _quiet_queue(monkeypatch)
    a = _upload(client, "a.pdf").json()["id"]
    client.post("/api/ocr/queue/items", json={"doc_ids": [a]})
    client.delete(f"/api/ocr/docs/{a}")
    assert client.get("/api/ocr/queue").json()["items"] == []


# ─────────────────────────────────────────────────────────────────────────────
#  Surface RETIRÉE au portage (chatbot only) — plus de route, 404/405
# ─────────────────────────────────────────────────────────────────────────────
def test_routes_chatbot_disparues(monkeypatch, tmp_path):
    """Exports pro, IDP (ask/extract/conformity) et gabarits n'ont PAS suivi
    la migration : leurs chemins ne sont plus routés du tout."""
    client, _s = _client(monkeypatch, tmp_path)
    doc_id, _d = _with_page(client)
    for path in (f"/api/ocr/docs/{doc_id}/export.docx",
                 f"/api/ocr/docs/{doc_id}/export.pdf",
                 f"/api/ocr/docs/{doc_id}/export.zip",
                 f"/api/ocr/docs/{doc_id}/tables.xlsx",
                 "/api/ocr/templates",
                 "/api/ocr/templates/charte"):
        assert client.get(path).status_code in (404, 405), path
    for path in (f"/api/ocr/docs/{doc_id}/ask",
                 f"/api/ocr/docs/{doc_id}/extract",
                 f"/api/ocr/docs/{doc_id}/conformity",
                 "/api/ocr/templates",
                 "/api/ocr/templates/induce"):
        assert client.post(path, json={}).status_code in (404, 405), path
    # le Markdown, lui, reste exporté
    assert client.get(f"/api/ocr/docs/{doc_id}/export").status_code == 200
