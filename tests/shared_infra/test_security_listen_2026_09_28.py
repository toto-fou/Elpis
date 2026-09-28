# SPDX-License-Identifier: MIT
"""Réglage ``security.listen`` (« local » → 127.0.0.1, « lan » → 0.0.0.0).

Le bind lui-même est couvert par ``test_gunicorn_bind.py``. Ici, les
écrivains du réglage :

* console admin : ``POST /api/admin/security/listen`` (sans objet en HTTPS,
  « local » refusé depuis le réseau : il couperait l'accès de l'opérateur) ;
* assistant d'installation : défaut « local » en installation neuve, valeur
  en place (ou « lan » si la clé manque) en réinstallation, transmis à
  ``configure`` par ``--listen`` ;
* ``configure`` en lignes : même règle, écriture dans ``config.json``.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy"))

import configure as C  # noqa: E402
import tui as T  # noqa: E402
import wizard as W  # noqa: E402


# ── Console admin ────────────────────────────────────────────────────────────

@pytest.fixture()
def admin_env(tmp_path, monkeypatch):
    import shared_infra.config as cfg
    import shared_infra.routes.admin.lifecycle as lifecycle
    import shared_infra.routes.admin.security as sec
    from shared_infra.observability.metrics import broadcast as metric_broadcast

    p = tmp_path / "config.json"
    p.write_text(json.dumps({"security": {}}), encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)
    monkeypatch.setattr(sec, "_require_admin", lambda request: None)
    monkeypatch.setattr(sec, "_caddy_listening", lambda port, host="127.0.0.1": False)
    monkeypatch.setenv("APP_MODE", "full")
    reloads: list = []
    monkeypatch.setattr(lifecycle, "schedule_self_reload", lambda delay=5.0: reloads.append(delay))
    monkeypatch.setattr(metric_broadcast, "publish_event", lambda ev: None)
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="test")
    app.include_router(sec.admin_router)
    return {"path": p, "sec": sec, "reloads": reloads, "client": TestClient(app)}


def _cfg(env):
    return json.loads(env["path"].read_text(encoding="utf-8"))


def test_status_reporte_l_ecoute(admin_env):
    r = admin_env["client"].get("/api/admin/security/https").json()
    assert r["listen"] == "lan"                     # clé absente : historique
    assert r["client_local"] is False               # client de test ≠ loopback
    admin_env["path"].write_text(json.dumps({"security": {"listen": "local"}}), encoding="utf-8")
    assert admin_env["client"].get("/api/admin/security/https").json()["listen"] == "local"


def test_passer_en_lan_ecrit_et_redemarre(admin_env):
    r = admin_env["client"].post("/api/admin/security/listen", json={"listen": "lan"})
    assert r.status_code == 200 and r.json()["listen"] == "lan"
    assert _cfg(admin_env)["security"]["listen"] == "lan"
    assert admin_env["reloads"] == [5.0]


def test_local_refuse_depuis_le_reseau(admin_env):
    r = admin_env["client"].post("/api/admin/security/listen", json={"listen": "local"})
    assert r.status_code == 409
    assert "listen" not in _cfg(admin_env)["security"] and admin_env["reloads"] == []


def test_local_accepte_depuis_la_machine(admin_env, monkeypatch):
    monkeypatch.setattr(admin_env["sec"], "_client_local", lambda request: True)
    r = admin_env["client"].post("/api/admin/security/listen", json={"listen": "local"})
    assert r.status_code == 200 and _cfg(admin_env)["security"]["listen"] == "local"


def test_sans_objet_en_https_et_valeur_invalide(admin_env):
    c = admin_env["client"]
    assert c.post("/api/admin/security/listen", json={"listen": "tout"}).status_code == 400
    admin_env["path"].write_text(json.dumps({"security": {"https": {"enabled": True}}}), encoding="utf-8")
    assert c.post("/api/admin/security/listen", json={"listen": "lan"}).status_code == 409
    assert admin_env["reloads"] == []


def test_l_editeur_brut_ne_reecrit_pas_l_ecoute():
    from shared_infra.routes.admin.config import _OWNED_PATHS
    assert ("security", "listen") in _OWNED_PATHS


# ── Assistant d'installation ─────────────────────────────────────────────────

@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    (root / "rag_app").mkdir(parents=True)
    shutil.copy(REPO / "config.example.json", root / "config.example.json")
    shutil.copy(REPO / "rag_app" / "rag_config.example.json", root / "rag_app" / "rag_config.example.json")
    monkeypatch.setattr(W, "ROOT", root)
    monkeypatch.setattr(W.C, "CONFIG", root / "config.json")
    monkeypatch.setattr(W.C, "RAG_CONFIG", root / "rag_app" / "rag_config.json")
    monkeypatch.setattr(W.C, "ENV_FILE", root / ".env")
    monkeypatch.setattr(W.C, "DB_PASSWORD_FILE", root / "user_db" / ".db_password")
    for k in ("ELPIS_WIZ_OFFLINE", "ELPIS_WIZ_PRESET", "ELPIS_WIZ_CONFIGURE_ARGS", "ELPIS_CFG_LISTEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ELPIS_WIZ_ADMIN", "1")
    return root


def _state(mode="install"):
    ctx = W.Ctx(mode)
    return ctx, W.initial_state(ctx)


def test_installation_neuve_ecoute_locale(repo):
    ctx, st = _state()
    assert st["listen"] == "local"
    acces = next(p for p in W.build_pages(ctx) if p.key == "acces")
    field = next(f for f in acces.fields if f.key == "listen")
    assert field.visible(st)
    st["https"] = "local"
    assert not field.visible(st), "sans objet en HTTPS"


@pytest.mark.parametrize("security,attendu", [({}, "lan"), ({"listen": "local"}, "local"),
                                              ({"listen": "lan"}, "lan")])
def test_reinstallation_conserve_l_existant(repo, security, attendu):
    (repo / "config.json").write_text(json.dumps({"security": security}), encoding="utf-8")
    _ctx, st = _state("configure")
    assert st["listen"] == attendu


def test_option_de_la_ligne_de_commande(repo, monkeypatch):
    monkeypatch.setenv("ELPIS_WIZ_CONFIGURE_ARGS", json.dumps(["--listen", "lan"]))
    assert _state()[1]["listen"] == "lan"


def test_transmis_a_configure_et_resume(repo):
    ctx, st = _state()
    st.update({"db_mode": "sqlite", "https": "off", "listen": "local"})
    argv = W.build_outputs(st, "install", False)["configure"]["argv"]
    assert argv[argv.index("--listen") + 1] == "local"
    rows = dict(next(r for t, r in W.summary(st, ctx) if t == "Accès"))
    assert rows["Écoute"].startswith("ce serveur seulement")
    st["https"] = "local"
    assert "--listen" not in W.build_outputs(st, "install", False)["configure"]["argv"]


# ── configure en lignes ──────────────────────────────────────────────────────

def _access(repo, monkeypatch, cfg, *argv):
    monkeypatch.setattr(C, "ENV_FILE", repo / ".env")
    monkeypatch.setattr(C, "port_in_use", lambda port: False)
    monkeypatch.setattr(C.shutil, "which", lambda name: "/usr/bin/caddy")
    a = C.build_parser().parse_args(["--yes", *argv])
    C.step_access(C.Prompter(False), a, cfg, {})
    return cfg["security"]


def test_configure_ecrit_l_ecoute(repo, monkeypatch):
    assert _access(repo, monkeypatch, {"security": {}}, "--https", "off")["listen"] == "lan"
    assert _access(repo, monkeypatch, C.read_json(repo / "config.example.json"),
                   "--https", "off")["listen"] == "local"
    assert _access(repo, monkeypatch, {"security": {"listen": "local"}},
                   "--https", "off", "--listen", "lan")["listen"] == "lan"
    # HTTPS : sans objet, rien d'écrit (sauf demande explicite).
    assert "listen" not in _access(repo, monkeypatch, {"security": {}}, "--https", "local")
    with pytest.raises(SystemExit):
        C.build_parser().parse_args(["--listen", "tout"])
