# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_https_toggle.py — toggle HTTPS admin (frontal Caddy).

Couvre ``/api/admin/security/https`` (GET état + POST bascule) :
  - garde anti-lockout : activer sans Caddy à l'écoute → 409, config intacte ;
  - activation : ``security.https.enabled`` ET ``security.session.https_only``
    écrits ensemble, ports par défaut posés, reload planifié ;
  - désactivation : flags redescendus, ``same_site=none`` rétrogradé ``lax``
    (sinon app.py re-forcerait le cookie Secure en HTTP), sonde Caddy ignorée ;
  - gate admin sur les deux endpoints.

Le reload gunicorn et le broadcast cross-process sont monkeypatchés (enregistreurs) —
on vérifie l'orchestration, pas les SIGHUP réels.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware


def _mk_app():
    import shared_infra.routes.admin.security as sec
    app = FastAPI()
    # request.session est lu par le POST (audit log) → middleware requis.
    app.add_middleware(SessionMiddleware, secret_key="test")
    app.include_router(sec.admin_router)
    return app


@pytest.fixture()
def toggle_env(tmp_path, monkeypatch):
    """Config tmp + no-op admin gate + enregistreurs reload/broadcast."""
    import shared_infra.config as cfg
    import shared_infra.routes.admin.security as sec
    import shared_infra.routes.admin.lifecycle as lifecycle
    from shared_infra.observability.metrics import broadcast as metric_broadcast

    p = tmp_path / "config.json"
    p.write_text(json.dumps({
        "security": {"session": {"same_site": "lax", "https_only": False}},
    }), encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)

    monkeypatch.setattr(sec, "_require_admin", lambda request: None)
    # Full mode : pas d'appel httpx vers main, un seul reload (soi-même).
    monkeypatch.setenv("APP_MODE", "full")
    monkeypatch.delenv("APP_HTTPS_CHECK_SKIP", raising=False)

    reloads: list[float] = []
    monkeypatch.setattr(lifecycle, "schedule_self_reload",
                        lambda delay=5.0: reloads.append(delay))
    events: list[dict] = []
    monkeypatch.setattr(metric_broadcast, "publish_event",
                        lambda ev: events.append(ev))
    return {"path": p, "sec": sec, "reloads": reloads, "events": events}


def test_enable_refused_when_caddy_absent(toggle_env, monkeypatch):
    sec = toggle_env["sec"]
    monkeypatch.setattr(sec, "_caddy_listening", lambda port, host="127.0.0.1": False)
    client = TestClient(_mk_app())

    resp = client.post("/api/admin/security/https", json={"enabled": True})
    assert resp.status_code == 409
    assert "Caddy" in resp.json()["detail"]
    # Aucune écriture config, aucun reload : la garde protège du lockout.
    cfg_after = json.loads(toggle_env["path"].read_text(encoding="utf-8"))
    assert "https" not in cfg_after["security"]
    assert cfg_after["security"]["session"]["https_only"] is False
    assert toggle_env["reloads"] == []


def test_enable_writes_config_and_schedules_reload(toggle_env, monkeypatch):
    sec = toggle_env["sec"]
    probed: list[int] = []

    def _fake_listen(port, host="127.0.0.1"):
        probed.append(int(port))
        return True

    monkeypatch.setattr(sec, "_caddy_listening", _fake_listen)
    client = TestClient(_mk_app())

    resp = client.post("/api/admin/security/https", json={"enabled": True},
                       headers={"Host": "10.168.1.50:8002"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True and data["enabled"] is True
    # URLs de redirection : main port 443 implicite, admin explicite.
    assert data["urls"]["main"] == "https://10.168.1.50/"
    assert data["urls"]["admin"] == "https://10.168.1.50:8443/admin"

    cfg_after = json.loads(toggle_env["path"].read_text(encoding="utf-8"))
    https = cfg_after["security"]["https"]
    assert https["enabled"] is True
    # Ports par défaut posés (alignés Caddyfile) + sondés par la garde.
    assert (https["main_port"], https["admin_port"], https["rag_port"]) == (443, 8443, 8444)
    assert sorted(set(probed)) == [443, 8443]
    # Alignement cookie Secure — écrit dans la MÊME transaction config.
    assert cfg_after["security"]["session"]["https_only"] is True
    # Reload orchestré + popup maintenance broadcastée.
    assert toggle_env["reloads"] == [5.0]
    assert toggle_env["events"] and toggle_env["events"][0]["type"] == "restart"


def test_disable_downgrades_flags_without_probing(toggle_env, monkeypatch):
    sec = toggle_env["sec"]
    # Départ : mode HTTPS actif avec same_site=none (le pire cas de retour).
    p = toggle_env["path"]
    p.write_text(json.dumps({
        "security": {
            "https":   {"enabled": True, "main_port": 443, "admin_port": 8443, "rag_port": 8444},
            "session": {"same_site": "none", "https_only": True},
        },
    }), encoding="utf-8")

    def _boom(port, host="127.0.0.1"):
        raise AssertionError("la sonde Caddy ne doit PAS être consultée en désactivation")

    monkeypatch.setattr(sec, "_caddy_listening", _boom)
    client = TestClient(_mk_app())

    resp = client.post("/api/admin/security/https", json={"enabled": False},
                       headers={"Host": "10.168.1.50:8443"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["enabled"] is False
    assert data["urls"]["main"] == "http://10.168.1.50:8001/"
    assert data["urls"]["admin"] == "http://10.168.1.50:8002/admin"

    cfg_after = json.loads(p.read_text(encoding="utf-8"))
    assert cfg_after["security"]["https"]["enabled"] is False
    sess = cfg_after["security"]["session"]
    assert sess["https_only"] is False
    # none → lax : sans ça app.py re-forcerait https_only=True au boot.
    assert sess["same_site"] == "lax"
    assert toggle_env["reloads"] == [5.0]


def test_status_reports_probes_and_scheme(toggle_env, monkeypatch):
    sec = toggle_env["sec"]
    monkeypatch.setattr(
        sec, "_caddy_listening",
        lambda port, host="127.0.0.1": int(port) in (443, 8443),
    )
    client = TestClient(_mk_app())

    resp = client.get("/api/admin/security/https",
                      headers={"Host": "10.168.1.50:8002",
                               "X-Forwarded-Proto": "https"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["enabled"] is False
    assert data["caddy"] == {"main": True, "admin": True, "rag": False}
    assert data["ports"] == {"main": 443, "admin": 8443, "rag": 8444}
    # X-Forwarded-Proto honoré (requête vue à travers le proxy).
    assert data["current_scheme"] == "https"


def test_check_skip_env_bypasses_probe(toggle_env, monkeypatch):
    """APP_HTTPS_CHECK_SKIP=1 (VM dev sans Caddy) : la sonde répond True."""
    sec = toggle_env["sec"]
    monkeypatch.setenv("APP_HTTPS_CHECK_SKIP", "1")
    assert sec._caddy_listening(9) is True  # port fermé, sonde court-circuitée


# ─────────────────────────────────────────────────────────────────────────────
#  CHAÎNE COMPLÈTE — toggle → éditeur de config → bind gunicorn
# ─────────────────────────────────────────────────────────────────────────────
#  Les maillons sont testés séparément (ici, test_config_file_ownership.py,
#  test_gunicorn_bind.py) et passaient tous les trois pendant que la prod était
#  cassée : la panne vivait ENTRE eux. Ce test parcourt la chaîne réelle —
#  activer le HTTPS, enregistrer un formulaire périmé depuis l'onglet
#  Configuration, puis relire la conf gunicorn exactement comme le fait le
#  master au SIGHUP.
def test_a_stale_form_save_cannot_reopen_the_public_bind(toggle_env, monkeypatch):
    import runpy
    from pathlib import Path

    import shared_infra.routes.admin.config as adm
    from fastapi.testclient import TestClient as _TC

    sec = toggle_env["sec"]
    path = toggle_env["path"]
    monkeypatch.setattr(sec, "_caddy_listening", lambda port, host="127.0.0.1": True)

    # 1. L'opérateur active le HTTPS depuis la console.
    assert _TC(_mk_app()).post("/api/admin/security/https",
                               json={"enabled": True},
                               headers={"Host": "10.168.1.50:8002"}).status_code == 200

    # 2. …puis enregistre l'onglet Configuration, dont le formulaire avait été
    #    chargé AVANT la bascule (il porte donc « https coupé »).
    monkeypatch.setattr(adm, "DEFAULT_CONFIG_PATH", path, raising=False)
    monkeypatch.setattr(adm, "require_user_id", lambda request: "1", raising=False)
    monkeypatch.setattr(adm, "get_user_by_id",
                        lambda uid: {"id": 1, "is_admin": 1}, raising=False)
    cfg_app = FastAPI()
    cfg_app.include_router(adm.admin_router)
    stale = json.dumps({"security": {"https": {"enabled": False},
                                     "session": {"https_only": False}}})
    assert _TC(cfg_app, raise_server_exceptions=False).post(
        "/api/admin/config-file", json={"type": "main", "content": stale}
    ).status_code == 200

    # 3. Le master gunicorn relit sa conf (SIGHUP, ou simple redémarrage) :
    #    c'est LÀ que la panne se matérialisait, des heures après la sauvegarde.
    monkeypatch.setenv("APP_CONFIG_PATH", str(path))
    monkeypatch.delenv("BIND", raising=False)
    server_dir = Path(__file__).resolve().parents[2] / "server"
    for conf, port in (("gunicorn_conf.py", "8001"),
                       ("gunicorn_admin_conf.py", "8002")):
        bind = runpy.run_path(str(server_dir / conf))["bind"]
        assert bind == f"127.0.0.1:{port}", (
            f"{conf} rouvre {bind} : l'app répondrait en clair sur le LAN "
            "alors que Caddy sert du https")


@pytest.mark.parametrize("method,payload", [("GET", None), ("POST", {"enabled": True})])
def test_https_endpoints_require_admin(toggle_env, monkeypatch, method, payload):
    sec = toggle_env["sec"]

    def _deny(request):
        raise HTTPException(403, "Admin required")

    monkeypatch.setattr(sec, "_require_admin", _deny)
    client = TestClient(_mk_app())
    if method == "GET":
        resp = client.get("/api/admin/security/https")
    else:
        resp = client.post("/api/admin/security/https", json=payload)
    assert resp.status_code == 403
    assert toggle_env["reloads"] == []
