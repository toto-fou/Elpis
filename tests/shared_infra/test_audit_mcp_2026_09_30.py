# SPDX-License-Identifier: MIT
"""Audit indépendant du 2026-09-30, segment outils externes : un compte coupé
ne garde aucun accès par jeton (jetons personnels, applications OAuth), vue
admin de ces accès, plafond des jetons de vision, registre des sessions du
navigateur (désenregistrement par le seul propriétaire, dossier privé), et
récupération d'un document de client connectée à l'adresse validée."""
from __future__ import annotations

import asyncio
import os
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.accounts import tokens as T


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    ids = {"admin": create_user("root", "pw-root-12", is_admin=1),
           "alice": create_user("alice", "pw-alice-1"), "bob": create_user("bob", "pw-bob-1")}
    cfg: dict = {}
    monkeypatch.setattr(T, "_cfg", lambda path, default: cfg.get(path, default))
    monkeypatch.setattr(T, "_opencode_enabled", lambda: True)
    import shared_infra.mcp.oauth as O
    monkeypatch.setattr(O, "_cfg", lambda path, default: cfg.get(path, default))
    T._touched.clear()
    return ids


def _grant(uid: int) -> dict:
    """Autorisation OAuth valable pour ``uid`` (client dynamique + paire)."""
    import shared_infra.mcp.oauth as O
    from shared_infra.db._connection import db_tx
    cl = O.register_client({"client_name": "Test", "redirect_uris": ["http://127.0.0.1:4242/cb"],
                            "token_endpoint_auth_method": "none"})
    O._prepare()
    with db_tx() as c:
        return O._issue_pair(c, grant_id=f"g-{uid}", user_id=uid, client_id=cl["client_id"], families=["fs"],
                             resource="http://testserver/api/mcp-bridge", pol=O.policy())


# ── Compte coupé : aucun accès par jeton ne survit ──────────────────────────

def test_revocation_complete_d_un_compte(base):
    import shared_infra.mcp.oauth as O
    ept, _ = T.create(base["alice"], "tools", "x", ["fs"], 10)
    pcr, _ = T.create(base["alice"], "opencode")
    paire = _grant(base["alice"])
    garde, _ = T.create(base["bob"], "tools", "y", ["fs"], 10)
    assert T.resolve(ept) and O.verify_access_token(paire["access_token"])
    out = T.revoke_all_access(base["alice"])
    assert out == {"tokens": 2, "oauth": 1}
    assert T.resolve(ept) is None and T.resolve(pcr, kinds=("opencode",)) is None
    assert O.verify_access_token(paire["access_token"]) is None
    assert T.resolve(garde) is not None                         # l'autre compte intact


def test_revocation_des_sessions_par_l_admin_coupe_aussi_les_jetons(base, monkeypatch):
    import shared_infra.routes.admin.security as SEC
    monkeypatch.setattr(SEC, "_require_admin", lambda request: base["admin"])
    ept, _ = T.create(base["alice"], "tools", "x", ["fs"], 10)
    from starlette.middleware.sessions import SessionMiddleware

    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="test")
    app.include_router(admin_router)
    c = TestClient(app)
    r = c.post(f"/api/admin/security/sessions/revoke-user/{base['alice']}")
    assert r.status_code == 200, r.text
    assert T.resolve(ept) is None


def test_vue_admin_des_acces_d_un_compte(base, monkeypatch):
    import shared_infra.routes.admin.users as U
    qui = {"uid": base["admin"]}
    monkeypatch.setattr(U, "require_user_id", lambda request: qui["uid"])
    T.create(base["alice"], "tools", "poste", ["fs"], 10)
    _grant(base["alice"])
    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.include_router(admin_router)
    c = TestClient(app)
    d = c.get(f"/api/admin/users/{base['alice']}/access").json()
    assert [t["name"] for t in d["tokens"]] == ["poste"] and len(d["grants"]) == 1
    assert "token_hash" not in repr(d)
    qui["uid"] = base["bob"]                                     # pas administrateur
    assert c.get(f"/api/admin/users/{base['alice']}/access").status_code == 403
    assert c.post(f"/api/admin/users/{base['alice']}/access/revoke").status_code == 403
    qui["uid"] = base["admin"]
    r = c.post(f"/api/admin/users/{base['alice']}/access/revoke").json()
    assert r["tokens"] == 1 and r["oauth"] == 1
    assert c.get(f"/api/admin/users/{base['alice']}/access").json() == {"tokens": [], "grants": []}
    assert c.get("/api/admin/users/9999/access").status_code == 404


# ── Jetons de vision : plafond par compte ────────────────────────────────────

def test_jetons_de_vision_plafonnes(base):
    toks = [T.create(base["alice"], "vision")[0] for _ in range(T.VISION_MAX_PER_USER + 5)]
    valides = [t for t in toks if T.resolve(t, kinds=("vision",))]
    assert len(valides) == T.VISION_MAX_PER_USER
    assert valides == toks[-T.VISION_MAX_PER_USER:]               # les plus récents gardés


# ── Registre des sessions du navigateur ──────────────────────────────────────

def test_stop_refuse_ne_desenregistre_pas_la_session_d_un_autre(tmp_path, monkeypatch):
    import llm_core._pw_session as P
    monkeypatch.setattr(P, "PW_OWNERS_DIR", str(tmp_path / "owners"))
    P._pw_session_owners.clear()
    sid = "sess-bob-12345678"

    async def scenario():
        await P.register_pw_session_owner(sid, "bob")
        # alice tente d'arrêter la session de bob : refusé par l'outil.
        await P._track_pw_session_ownership("pw_session", {"action": "stop", "session_id": sid},
                                            '{"ok": false, "error": "session inconnue"}', "alice")
        assert P.get_pw_session_owner(sid) == "bob"
        # même réussi, un stop d'alice ne désenregistre pas la session de bob
        await P._track_pw_session_ownership("pw_session", {"action": "stop", "session_id": sid},
                                            '{"status": "stopped"}', "alice")
        assert P.get_pw_session_owner(sid) == "bob"
        await P._track_pw_session_ownership("pw_session", {"action": "stop", "session_id": sid},
                                            '{"status": "stopped"}', "bob")
        assert P.get_pw_session_owner(sid) is None
    asyncio.run(scenario())


def test_dossier_des_proprietaires_prive_sinon_ignore(tmp_path, monkeypatch):
    import llm_core._pw_session as P
    d = tmp_path / "owners"
    monkeypatch.setattr(P, "PW_OWNERS_DIR", str(d))
    P._write_pw_owner_sidecar("sess-alice-1234567", "alice")
    assert oct(os.stat(d).st_mode & 0o777) == "0o700"
    assert P._read_pw_owner_sidecar("sess-alice-1234567") == "alice"
    os.chmod(d, 0o777)                                        # ouvert à tous : plus lu
    assert P._read_pw_owner_sidecar("sess-alice-1234567") is None
    P._write_pw_owner_sidecar("sess-alice-7654321", "alice")
    assert not (d / "sess-alice-7654321.owner").exists()


# ── Document de client (CIMD) : connexion à l'adresse validée ────────────────

def test_document_client_connecte_a_l_adresse_validee(monkeypatch):
    import socket

    import httpx

    import shared_infra.mcp.oauth as O
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    vu = {}

    def envoyer(self, request, **kw):
        vu["url"] = str(request.url)
        vu["host"] = request.headers.get("host")
        vu["sni"] = request.extensions.get("sni_hostname")
        vu["trust_env"] = self._trust_env
        return httpx.Response(200, content=b'{"x": 1}', request=request)
    monkeypatch.setattr(httpx.Client, "send", envoyer)
    assert O._fetch_pinned("https://app.example/client.json") == b'{"x": 1}'
    assert vu == {"url": "https://93.184.216.34/client.json", "host": "app.example",
                  "sni": "app.example", "trust_env": False}


def test_document_client_adresse_privee_refusee(monkeypatch):
    import socket

    import shared_infra.mcp.oauth as O
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 443))])
    with pytest.raises(O.OAuthError):
        O._fetch_pinned("https://app.example/client.json")


def test_quota_vision_n_empiete_pas_sur_les_jetons_de_poste(base):
    base_n = len(T.list_for(base["alice"]))
    for _ in range(3):
        T.create(base["alice"], "vision")
    assert len(T.list_for(base["alice"])) == base_n            # la vision reste masquée
    assert time.time() > 0
