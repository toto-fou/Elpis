# SPDX-License-Identifier: MIT
"""Audit 2026-09-21 — console RAG (S7) et noms de collection (S6)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from rag_app import app as A


@pytest.fixture
def client():
    # Loopback direct : sans jeton, seule la machine locale passe (2026-09-22).
    return TestClient(A.app, client=("127.0.0.1", 50000))


@pytest.fixture
def jeton(monkeypatch):
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "JETON-TEST")
    return "JETON-TEST"


def test_console_ouverte_sans_jeton_configure(client, monkeypatch):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {})
    assert client.get("/api/startup_status").status_code == 200


def test_console_exige_le_jeton(client, jeton):
    assert client.get("/api/config").status_code == 401
    assert client.post("/api/reset").status_code == 401
    assert client.post("/api/files/delete", json={"rel_path": "a"}).status_code == 401
    # Santé publique (bouton « Tester la connexion » de l'admin du chatbot).
    assert client.get("/api/health").status_code != 401


def test_bearer_du_chatbot_accepte(client, jeton):
    r = client.get("/api/startup_status", headers={"Authorization": f"Bearer {jeton}"})
    assert r.status_code == 200


def test_connexion_par_cookie(client, jeton):
    assert client.post("/api/console/login", json={"token": "faux"}).status_code == 403
    r = client.post("/api/console/login", json={"token": jeton})
    assert r.status_code == 200 and A._CONSOLE_COOKIE in r.cookies
    assert client.get("/api/startup_status").status_code == 200
    client.cookies.clear()
    assert client.get("/api/startup_status").status_code == 401


def test_les_secrets_sont_masques_et_conserves(monkeypatch):
    cfg = {"collection": "c", "service_token": "S", "reranker": {"api_key": "K", "url": "u"},
           "ocr": {"api_key": ""}, "max_tokens": 5}
    m = A._mask_secrets(cfg)
    assert m["service_token"] == A._SECRET_MASK and m["reranker"]["api_key"] == A._SECRET_MASK
    assert m["ocr"]["api_key"] == "" and m["max_tokens"] == 5
    # Champ non retouché : la valeur stockée revient ; retouché : la nouvelle.
    back = A._unmask_secrets({**m, "reranker": {**m["reranker"], "url": "v"}}, cfg)
    assert back["service_token"] == "S" and back["reranker"] == {"api_key": "K", "url": "v"}
    assert A._unmask_secrets({"reranker": {"api_key": "NEUF"}}, cfg)["reranker"]["api_key"] == "NEUF"


@pytest.mark.parametrize("nom", ["x/points/delete?", "a b", "../c", "é"])
def test_collection_invalide_refusee(nom):
    with pytest.raises(A.HTTPException):
        A._checked_collection(nom)


def test_collection_valide_ou_absente():
    assert A._checked_collection("ocr-documents") == "ocr-documents"
    assert A._checked_collection(None) is None and A._checked_collection("  ") is None
    assert A._checked_collections({"collections": ["a", "b_2"]}) == ["a", "b_2"]
    assert A._checked_collections({"collection": None}) == [None]


# ── Audit 2026-09-22 (C4) : sans jeton, machine locale seulement ──────────

@pytest.fixture
def sans_jeton(monkeypatch, tmp_path):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {})
    monkeypatch.setattr(A, "_TOKEN_FILE", tmp_path / "absent")


def test_sans_jeton_lan_refuse(sans_jeton):
    lan = TestClient(A.app, client=("10.168.1.20", 50000))
    assert lan.get("/api/config").status_code == 401
    assert lan.post("/api/reset").status_code == 401
    assert lan.post("/api/tools/rag_list_sources", json={}).status_code == 401
    assert lan.get("/api/health").status_code != 401


def test_sans_jeton_proxy_local_refuse(client, sans_jeton):
    """Caddy sur la même machine : 127.0.0.1 + X-Forwarded-For = le LAN."""
    r = client.get("/api/startup_status", headers={"X-Forwarded-For": "10.168.1.20"})
    assert r.status_code == 401


def test_jeton_lu_dans_user_db(client, monkeypatch, tmp_path):
    monkeypatch.delenv("RAG_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(A, "load_config", lambda: {})
    f = tmp_path / ".rag_service_token"
    f.write_text("FICHIER\n")
    monkeypatch.setattr(A, "_TOKEN_FILE", f)
    assert client.get("/api/startup_status").status_code == 401
    r = client.get("/api/startup_status", headers={"Authorization": "Bearer FICHIER"})
    assert r.status_code == 200


def test_cors_ferme_par_defaut(client):
    r = client.options("/api/health", headers={"Origin": "http://evil.example",
                                               "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers
