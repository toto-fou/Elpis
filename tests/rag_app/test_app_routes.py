# SPDX-License-Identifier: MIT
"""tests/rag_app/test_app_routes.py — surface HTTP de rag_app (TestClient).

Rendu possible par le gating du détournement stdout (l'import de app sous
pytest garde les flux réels) et par les imports paquet-tolérants. Couvre :
protocole SSE des tools (start→result→done, erreurs typées), auth Bearer
(401/403/temps-constant), confinement upload + file_text, coercition des
entrées du playground, clamps du preview de chunking.
"""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from rag_app import app as A
from rag_app import rag_engine as E


def _ok_handler(request):
    return httpx.Response(200, json={"result": {}, "status": "ok"})


@pytest.fixture
def client():
    # Loopback direct : sans jeton, seule la machine locale passe (2026-09-22).
    return TestClient(A.app, client=("127.0.0.1", 50000))


@pytest.fixture
def tmp_engine(tmp_path, monkeypatch):
    """Engine isolé (DATA/ sous tmp, réseau simulé) substitué au global."""
    monkeypatch.setattr(E, "BASE_DIR", tmp_path)
    cfg = {
        "collection": "col1",
        "qdrant_url": "http://q.test:6333",
        "embed_base_url": "http://emb.test",
        "embed_model": "bge-m3",
        "state_file": str(tmp_path / "state.json"),
        "allowed_ext": [".txt", ".md"],
        "global_method": "size",
        "global_chunk_size": 100,
        "global_chunk_overlap": 10,
        "global_max_chunk_size": 4000,
    }
    p = tmp_path / "rag_config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    eng = E.RAGEngine(str(p),
                      http_client=httpx.Client(transport=httpx.MockTransport(_ok_handler)))
    monkeypatch.setattr(A, "engine", eng)
    return eng


def _sse_events(text: str):
    return [json.loads(line[6:]) for line in text.splitlines()
            if line.startswith("data: ")]


# ─── santé / statut ─────────────────────────────────────────────────────────

def test_health_enrichi(client, monkeypatch):
    monkeypatch.setattr(A.engine, "check_health",
                        lambda: {"qdrant": True, "llm": False})
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "rag_app"
    assert body["qdrant"] is True
    assert "auth_required" in body
    assert "reranker_enabled" in body


def test_startup_status(client):
    r = client.get("/api/startup_status")
    assert r.status_code == 200
    assert "done" in r.json()


# ─── auth Bearer des tools ──────────────────────────────────────────────────

def test_tools_ouverts_sans_token(client, monkeypatch):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {"collection": "c"})
    monkeypatch.setattr(A, "list_indexed_files", lambda cfg: ["a.txt"])
    r = client.post("/api/tools/rag_list_sources", json={})
    assert r.status_code == 200
    events = _sse_events(r.text)
    assert [e["type"] for e in events] == ["start", "result", "done"]
    assert events[1]["payload"]["files"] == ["a.txt"]


def test_tools_token_manquant_401(client, monkeypatch):
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "sekret")
    assert client.post("/api/tools/rag_list_sources", json={}).status_code == 401


def test_tools_token_invalide_403(client, monkeypatch):
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "sekret")
    r = client.post("/api/tools/rag_list_sources", json={},
                    headers={"Authorization": "Bearer mauvais"})
    assert r.status_code == 403


def test_tools_bearer_vide_403_pas_500(client, monkeypatch):
    # Régression : « Authorization: Bearer » sans valeur faisait un
    # IndexError → 500. Désormais 403 propre.
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "sekret")
    r = client.post("/api/tools/rag_list_sources", json={},
                    headers={"Authorization": "Bearer "})
    assert r.status_code == 403


def test_tools_token_valide(client, monkeypatch):
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "sekret")
    monkeypatch.setattr(A, "load_config", lambda: {"collection": "c"})
    monkeypatch.setattr(A, "list_indexed_files", lambda cfg: [])
    r = client.post("/api/tools/rag_list_sources", json={},
                    headers={"Authorization": "Bearer sekret"})
    assert r.status_code == 200


# ─── protocole SSE des tools ────────────────────────────────────────────────

def test_rag_search_query_vide_erreur_400_dans_le_flux(client, monkeypatch):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {"collection": "c"})
    r = client.post("/api/tools/rag_search", json={"query": "  "})
    assert r.status_code == 200                    # l'erreur voyage DANS le flux
    events = _sse_events(r.text)
    assert [e["type"] for e in events] == ["start", "error", "done"]
    assert events[1]["status"] == 400


def test_rag_search_resultats_et_filtres(client, monkeypatch):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {"collection": "cbase"})
    monkeypatch.setattr(A, "rag_tool_search",
                        lambda query, collection=None, search_mode="classic", top_k=8, **kw: {
                            "ok": True, "results": [
                                {"source": "dossier/a.txt", "chunk_index": 0,
                                 "score": 0.9, "text": "pertinent"},
                                {"source": "b.txt", "chunk_index": 1,
                                 "score": 0.1, "text": "bruit"}]})
    r = client.post("/api/tools/rag_search",
                    json={"query": "q", "score_threshold": 0.5})
    events = _sse_events(r.text)
    assert events[1]["type"] == "result"
    payload = events[1]["payload"]
    assert payload["count"] == 1                   # 0.1 filtré par le seuil
    row = payload["results"][0]
    assert row["source"] == "dossier/a.txt"
    assert row["get_document_name"] == "a.txt"


def test_rag_get_document_fuzzy_fallback(client, monkeypatch):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {"collection": "c"})
    doc = {"path": "/srv/DATA/c/Rapport-Final.PDF", "name": "Rapport-Final.PDF",
           "rel": "Rapport-Final.PDF"}
    monkeypatch.setattr(A, "resolve_documents",
                        lambda cfg, ident: [doc] if ident.lower() == "rapport-final.pdf" else [])

    def fake_count(cfg, name, path=None, min_index=None):
        return (1 if path == doc["path"] else 0) if not min_index else 0

    monkeypatch.setattr(A, "count_chunks_for_file", fake_count)
    monkeypatch.setattr(A, "get_document_chunk_window",
                        lambda cfg, name, s, e, path=None: [{"text": "contenu", "chunk_index": 0}])
    r = client.post("/api/tools/rag_get_document",
                    json={"filename": "rapport-final.pdf"})
    events = _sse_events(r.text)
    payload = events[1]["payload"]
    assert payload["filename"] == "Rapport-Final.PDF"   # résolu par le fuzzy
    assert payload["count"] == 1


def test_rag_get_document_pagination_expose_le_vrai_total(client, monkeypatch):
    """Le total annoncé est le total RÉEL du document, pas la taille du lot lu.

    Avant, il était déduit d'un scroll plafonné à ``max_chunks + 5`` : sur un
    document de 300 chunks, le modèle recevait 15 chunks pris au hasard (le
    scroll sort par id — des hachages — et le tri par chunk_index venait
    après) avec ``total_chunks_available: 20``. Il croyait donc avoir tout lu,
    et les chunks au-delà étaient inatteignables.
    """
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {"collection": "c"})
    monkeypatch.setattr(A, "resolve_documents",
                        lambda cfg, ident: [{"path": "/d/specs.pdf", "name": "specs.pdf",
                                             "rel": "specs.pdf"}])
    monkeypatch.setattr(A, "count_chunks_for_file",
                        lambda cfg, name, path=None, min_index=None: max(0, 300 - (min_index or 0)))

    seen = {}

    def fake_window(cfg, name, s, e, path=None):
        seen["range"] = (s, e)
        return [{"text": f"c{i}", "chunk_index": i} for i in range(s, min(e, 300))]

    monkeypatch.setattr(A, "get_document_chunk_window", fake_window)

    r = client.post("/api/tools/rag_get_document",
                    json={"filename": "specs.pdf", "max_chunks": 15})
    p = _sse_events(r.text)[1]["payload"]
    assert p["total_chunks_available"] == 300      # le VRAI total
    assert seen["range"] == (0, 15)                # fenêtre demandée à Qdrant
    assert [c["chunk"] for c in p["results"]] == list(range(15))
    assert p["next_chunk_start"] == 15             # la suite est proposée

    # …et la suite est réellement joignable (le bug : > 20 inatteignable).
    r2 = client.post("/api/tools/rag_get_document",
                     json={"filename": "specs.pdf", "chunk_start": 250,
                           "max_chunks": 15})
    p2 = _sse_events(r2.text)[1]["payload"]
    assert seen["range"] == (250, 265)
    assert [c["chunk"] for c in p2["results"]] == list(range(250, 265))

    # Au-delà de la fin : message explicite au lieu d'une liste vide muette.
    r3 = client.post("/api/tools/rag_get_document",
                     json={"filename": "specs.pdf", "chunk_start": 400})
    p3 = _sse_events(r3.text)[1]["payload"]
    assert p3["count"] == 0 and "dépasse" in p3["message"]


def test_rag_inline(client, monkeypatch):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "rag",
                        lambda q, search_mode="classic", collection=None:
                        ("CONTEXTE", ["[s1]"]))
    r = client.post("/api/tools/rag_inline", json={"question": "quoi ?"})
    payload = _sse_events(r.text)[1]["payload"]
    assert payload["used"] is True
    assert payload["context_text"] == "CONTEXTE"
    r2 = client.post("/api/tools/rag_inline", json={"question": " "})
    assert _sse_events(r2.text)[1]["payload"]["used"] is False


# ─── confinement fichiers ───────────────────────────────────────────────────

def test_upload_traversal_neutralise(client, tmp_engine, tmp_path):
    r = client.post("/api/upload",
                    files=[("files", ("evil.txt", b"pwn", "text/plain"))],
                    data={"paths": "../../evil.txt"})
    assert r.status_code == 200
    data_dir = tmp_engine.get_current_data_dir()
    # le fichier atterrit DANS DATA/ (composants « .. » retirés), jamais dehors
    assert (data_dir / "evil.txt").exists()
    assert not (tmp_path / "evil.txt").exists()
    assert not (tmp_path.parent / "evil.txt").exists()


def test_upload_legitime_sous_dossier(client, tmp_engine):
    r = client.post("/api/upload",
                    files=[("files", ("doc.txt", b"contenu", "text/plain"))],
                    data={"paths": "sous/dossier/doc.txt"})
    assert r.json()["count"] == 1
    assert (tmp_engine.get_current_data_dir() / "sous/dossier/doc.txt").exists()


def test_file_text_hors_data_403(client, tmp_engine):
    r = client.get("/api/file_text", params={"path": "/etc/passwd"})
    assert r.status_code == 403


def test_file_text_dans_data_ok(client, tmp_engine):
    f = tmp_engine.get_current_data_dir() / "note.txt"
    f.write_text("bonjour", encoding="utf-8")
    r = client.get("/api/file_text", params={"path": str(f)})
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "bonjour"
    assert body["truncated"] is False


def test_files_delete_traversal_erreur(client, tmp_engine, tmp_path):
    cible = tmp_path / "vital.txt"
    cible.write_text("x", encoding="utf-8")
    r = client.post("/api/files/delete", json={"rel_path": "../../vital.txt"})
    assert r.status_code == 409                    # refus = code d'erreur (passe 2)
    assert cible.exists()


# ─── playground & preview ───────────────────────────────────────────────────

def test_search_top_k_incoercible_retombe_a_10(client, monkeypatch):
    seen = {}

    def fake_search(query, **kw):
        seen.update(kw)
        return {"ok": True, "results": [], "query": query, "mode": "empty"}

    monkeypatch.setattr(A, "rag_search_only", fake_search)
    r = client.post("/api/search", json={"query": "q", "top_k": "beaucoup"})
    assert r.status_code == 200
    assert seen["top_k"] == 10
    client.post("/api/search", json={"query": "q", "top_k": 5000})
    assert seen["top_k"] == 100                    # borné


def test_search_query_vide(client):
    r = client.post("/api/search", json={"query": "   "})
    assert r.json()["ok"] is False


def test_preview_chunks_params_hostiles(client, tmp_engine):
    r = client.post("/api/chunks/split/preview",
                    json={"chunk_text": "mot " * 200,
                          "params": {"method": "size", "size": "50",
                                     "overlap": "9999"}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True                      # clampé, pas de boucle infinie
    assert body["total"] >= 1


def test_config_get(client, tmp_engine):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json()["collection"] == "col1"
