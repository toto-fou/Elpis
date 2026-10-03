# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_admin_overview.py — GET /api/admin/overview.

Page d'arrivée de la console (lot 6, 2026-09-27). Invariants :

  - lecture pour le personnel (admin ET modérateur), refus pour un compte
    ordinaire ; un modérateur ne reçoit aucun geste (``action`` vide) ;
  - une sonde qui lève ou dépasse son délai rend « Inconnu », jamais une 500 ;
  - la tournée est partagée et mise en cache : un second appel dans la
    fenêtre ne relance pas les sondes ; seul un admin peut forcer ;
  - les alertes « À traiter » suivent les faits : service injoignable,
    redémarrage en attente, sauvegarde absente ou ancienne, HTTPS, politique
    de mot de passe, taux d'échec des outils ;
  - la compression sans adresse propre hérite de l'état du moteur local ;
  - ``/api/admin/restart-status`` est réservé aux administrateurs ;
  - chaque archive de sauvegarde produite est datée (``backup_created``).
"""
from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _svc(sid, state, page="inference", label=None, target="h:1"):
    return {"id": sid, "label": label or sid, "target": target, "state": state,
            "detail": "", "page": page}


@pytest.fixture()
def ov(monkeypatch):
    import shared_infra.routes.admin.overview as ov
    from shared_infra.ops import restart_pending as rp

    ov._cache.update(at=0.0, data=None)
    role = {"is_admin": 1}
    monkeypatch.setattr(ov, "require_user_id", lambda request: "1", raising=False)
    monkeypatch.setattr(ov, "get_user_by_id",
                        lambda uid: {"id": 1, "is_admin": role["is_admin"]}, raising=False)
    calls = {"n": 0}
    state = {"llm": "ok", "rag": "ok", "compression": "same", "pending": [],
             "backup_at": time.time() - 3600, "https": True, "policy_empty": False,
             "must_change": 0, "tools": (0, 0)}

    def fake(sid, page="inference"):
        async def probe():
            if sid == "llm":
                calls["n"] += 1
            return _svc(sid, state.get(sid, "ok"), page)
        return probe

    monkeypatch.setattr(ov, "_probe_llm", fake("llm"))
    monkeypatch.setattr(ov, "_probe_connectors", lambda: asyncio.sleep(0, result=[]))
    monkeypatch.setattr(ov, "_probe_compression", fake("compression", "compression"))
    monkeypatch.setattr(ov, "_probe_rag", fake("rag", "rag"))
    for name, page in (("vision", "vision"), ("voice", "voice"), ("images", "images"),
                       ("mcp", "mcp"), ("sandbox", "sandbox-limits"), ("database", "data")):
        monkeypatch.setattr(ov, f"_probe_{name}", fake(name, page))
    monkeypatch.setattr(ov, "_kpis_24h", lambda: {
        "users": 3, "turns": 40, "tokens": 12000, "failures": 1,
        "tool_calls": state["tools"][0], "tool_failures": state["tools"][1]})
    monkeypatch.setattr(ov, "_last_backup", lambda: {
        "at": state["backup_at"], "remote_enabled": False, "remote_failed": False, "remote_error": ""})
    monkeypatch.setattr(ov, "_security_facts", lambda: {
        "https": state["https"], "policy_empty": state["policy_empty"],
        "admin_must_change": state["must_change"], "instance_named": True})
    monkeypatch.setattr(rp, "pending", lambda current=None: list(state["pending"]))

    app = FastAPI()
    app.include_router(ov.admin_router)
    c = TestClient(app, raise_server_exceptions=False)
    c.role, c.calls, c.state, c.mod = role, calls, state, ov
    yield c
    ov._cache.update(at=0.0, data=None)


def _ids(body):
    return {a["id"] for a in body["alerts"]}


def test_lecture_personnel_refus_utilisateur(ov):
    r = ov.get("/api/admin/overview")
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "admin"
    assert {s["id"] for s in body["services"]} >= {"llm", "rag", "database", "sandbox"}
    assert body["kpis"]["turns"] == 40

    ov.role["is_admin"] = 2
    r = ov.get("/api/admin/overview")
    assert r.status_code == 200 and r.json()["role"] == "moderator"

    ov.role["is_admin"] = 0
    assert ov.get("/api/admin/overview").status_code == 403


def test_moderateur_sans_gestes(ov):
    ov.state.update(llm="down")
    ov.role["is_admin"] = 2
    body = ov.get("/api/admin/overview").json()
    assert body["alerts"] and all(a["action"] == "" for a in body["alerts"])


def test_cache_partage_et_forcage_admin(ov):
    ov.get("/api/admin/overview")
    ov.get("/api/admin/overview")
    assert ov.calls["n"] == 1, "second appel dans la fenêtre : pas de nouvelle tournée"
    ov.role["is_admin"] = 2
    ov.get("/api/admin/overview?refresh=1")
    assert ov.calls["n"] == 1, "un modérateur ne force pas les sondes"
    ov.role["is_admin"] = 1
    ov.get("/api/admin/overview?refresh=1")
    assert ov.calls["n"] == 2


def test_alertes_suivent_les_faits(ov):
    body = ov.get("/api/admin/overview").json()
    assert _ids(body) == set(), body["alerts"]

    ov.mod._cache.update(at=0.0, data=None)
    ov.state.update(rag="down", sandbox="warn", pending=["llama.ip", "maintenance.hour"], backup_at=None,
                    https=False, policy_empty=True, must_change=1, tools=(50, 12))
    body = ov.get("/api/admin/overview").json()
    ids = _ids(body)
    assert {"svc-rag", "restart", "backup", "https", "pwd-policy", "admin-pwd", "tools"} <= ids
    restart = next(a for a in body["alerts"] if a["id"] == "restart")
    assert restart["paths"] == ["llama.ip", "maintenance.hour"] and restart["action"] == "restart"
    rag = next(a for a in body["alerts"] if a["id"] == "svc-rag")
    assert rag["level"] == "danger" and rag["page"] == "rag"
    sb = next(a for a in body["alerts"] if a["id"] == "svc-sandbox")
    assert sb["level"] == "warn" and sb["page"] == "sandbox-limits" and sb["action"] == "page"
    assert next(a for a in body["alerts"] if a["id"] == "backup")["action"] == "backup"
    setup = {s["id"]: s["done"] for s in body["setup"]}
    assert setup["https"] is False and setup["admin-pwd"] is False and setup["name"] is True


def test_sauvegarde_ancienne_et_seuil_outils(ov):
    ov.state.update(backup_at=time.time() - 10 * 86400, tools=(100, 4))
    body = ov.get("/api/admin/overview").json()
    backup = next(a for a in body["alerts"] if a["id"] == "backup")
    assert "10 jours" in backup["title"]
    assert "tools" not in _ids(body), "4 échecs : sous le seuil (5 et 10 %)"


def test_compression_herite_du_moteur_local(ov):
    ov.state.update(llm="down")
    body = ov.get("/api/admin/overview").json()
    comp = next(s for s in body["services"] if s["id"] == "compression")
    assert comp["state"] == "down" and comp["detail"] == "Via le moteur local"


def test_sonde_en_echec_ou_trop_lente_rend_inconnu(ov, monkeypatch):
    async def boom():
        raise RuntimeError("panne")

    async def slow():
        await asyncio.sleep(5)

    monkeypatch.setattr(ov.mod, "PROBE_TIMEOUT", 0.05)
    monkeypatch.setattr(ov.mod, "_probe_rag", boom)
    monkeypatch.setattr(ov.mod, "_probe_vision", slow)
    r = ov.get("/api/admin/overview")
    assert r.status_code == 200
    by = {s["id"]: s for s in r.json()["services"]}
    assert by["rag"]["state"] == "unknown" and by["vision"]["state"] == "unknown"


def test_restart_status_admin_seulement(ov):
    r = ov.get("/api/admin/restart-status")
    assert r.status_code == 200
    body = r.json()
    assert "llama.ip" in body["paths"] and body["pending"] == []
    ov.role["is_admin"] = 2
    assert ov.get("/api/admin/restart-status").status_code == 403


def test_archive_de_sauvegarde_datee(tmp_path, monkeypatch):
    import os

    import shared_infra.config as _cfg
    from shared_infra.observability.usage_store import db_conn
    from shared_infra.routes import _helpers
    # Lu dans la fonction (``from shared_infra.config import MCP_SERVERS_DIR``).
    monkeypatch.setattr(_cfg, "MCP_SERVERS_DIR", tmp_path / "mcp")
    (tmp_path / "mcp").mkdir()
    (tmp_path / "mcp" / "srv.py").write_text("print(1)\n", encoding="utf-8")
    path, name = _helpers._make_backup_zip("mcp")
    try:
        assert name.startswith("backup_mcp_")
        with db_conn() as conn:
            row = conn.execute("SELECT MAX(created_at) FROM metric_events "
                               "WHERE event_type='backup_created'").fetchone()
        assert row[0] and time.time() - float(row[0]) < 60
    finally:
        os.unlink(path)
