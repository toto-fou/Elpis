# SPDX-License-Identifier: MIT
"""Bascule de moteur de base (lots D/E) : garde de génération, mode
maintenance, réglages, routes admin, CLI, et bascule complète vers un
serveur de test (``ELPIS_TEST_PG``).
"""
import json
import os
import sqlite3
import stat
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """config.json + dossier de données temporaires."""
    import shared_infra.config as cfg
    from shared_infra.db import _connection as C
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"app": {}}), encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)
    cfg.invalidate_config_cache()
    monkeypatch.setattr(cfg, "DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setattr(C, "DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setattr(cfg, "DB_GENERATION", 0)
    monkeypatch.setattr(C, "_gen_stale", False)
    monkeypatch.setattr(C, "_gen_checked_at", 0.0)
    yield {"config": p, "dir": tmp_path}
    cfg.invalidate_config_cache()


def _cfg(env):
    return json.loads(env["config"].read_text(encoding="utf-8"))


# ── Garde de génération ──────────────────────────────────────────────────────

@pytest.mark.sqlite_only   # DB_PATH redirigé vers un fichier : la garde est commune
def test_un_process_perime_n_emprunte_plus(env, monkeypatch):
    from shared_infra.db import _connection as C
    with C.db_conn() as c:
        c.execute("SELECT 1").fetchone()
    env["config"].write_text(json.dumps({"database": {"generation": 1}}), encoding="utf-8")
    import shared_infra.config as cfg
    cfg.invalidate_config_cache()
    monkeypatch.setattr(C, "_gen_checked_at", 0.0)
    with pytest.raises(sqlite3.OperationalError, match="basculée"):
        C.db()
    # Définitif, même si la config redescendait.
    env["config"].write_text(json.dumps({"database": {"generation": 0}}), encoding="utf-8")
    cfg.invalidate_config_cache()
    with pytest.raises(sqlite3.OperationalError):
        C.db()


# ── Mode maintenance ─────────────────────────────────────────────────────────

def _app_maintenance():
    from shared_infra.ops.db_switch import MaintenanceASGI
    app = FastAPI()

    @app.get("/api/x")
    def lire():
        return {"ok": True}

    @app.post("/api/x")
    def ecrire():
        return {"ok": True}

    @app.post("/api/admin/database/job")
    def admin():
        return {"ok": True}

    app.add_middleware(MaintenanceASGI)
    return TestClient(app)


def test_maintenance_bloque_les_ecritures_des_anciens_process(env):
    from shared_infra.ops import db_switch
    client = _app_maintenance()
    assert client.post("/api/x").status_code == 200
    (env["dir"] / ".db_maintenance").write_text(json.dumps({"generation": 1}), encoding="utf-8")
    db_switch._write_job(state="running", kind="migrate", pid=os.getpid())   # bascule vivante
    client = _app_maintenance()                    # cache d'une seconde : app neuve
    assert db_switch.maintenance_active()
    assert client.post("/api/x").status_code == 503
    assert client.get("/api/x").status_code == 200
    assert client.post("/api/admin/database/job").status_code == 200


def test_maintenance_ignoree_par_les_process_de_la_nouvelle_generation(env, monkeypatch):
    import shared_infra.config as cfg
    from shared_infra.ops import db_switch
    (env["dir"] / ".db_maintenance").write_text(json.dumps({"generation": 1}), encoding="utf-8")
    monkeypatch.setattr(cfg, "DB_GENERATION", 1)
    assert not db_switch.maintenance_active()


# ── Réglages ─────────────────────────────────────────────────────────────────

def test_enregistrer_sans_basculer_puis_basculer(env):
    from shared_infra.ops.db_switch import write_database_config
    t = {"backend": "postgres", "host": "db", "port": 5432, "name": "e", "user": "u",
         "tls": "require", "password": "s3cret"}
    assert write_database_config(t, switch=False) == 0
    db = _cfg(env)["database"]
    assert db == {"pending": {"backend": "postgres", "host": "db", "port": 5432, "name": "e",
                              "user": "u", "tls": "require"}}
    pw = env["dir"] / ".db_password.pending"
    assert pw.read_text() == "s3cret" and stat.S_IMODE(pw.stat().st_mode) == 0o600
    assert not (env["dir"] / ".db_password").exists()
    assert "s3cret" not in env["config"].read_text()
    t.pop("password")                         # la bascule reprend celui en attente
    assert write_database_config(t, switch=True) == 1
    db = _cfg(env)["database"]
    assert db["backend"] == "postgres" and db["generation"] == 1 and db["host"] == "db"
    assert "pending" not in db and not pw.exists()
    assert (env["dir"] / ".db_password").read_text() == "s3cret"


def test_enregistrer_ne_touche_pas_la_base_active(env):
    """Sur un serveur actif, « Enregistrer » une autre cible ne change ni ses
    réglages ni son mot de passe (sinon le pool perd l'authentification)."""
    from shared_infra.ops.db_switch import write_database_config
    a = {"backend": "postgres", "host": "a", "port": 5432, "name": "e", "user": "ua",
         "tls": "off", "password": "pa"}
    write_database_config(a, switch=True)
    b = {"backend": "mysql", "host": "b", "port": 3306, "name": "e", "user": "ub",
         "tls": "off", "password": "pb"}
    write_database_config(b, switch=False)
    db = _cfg(env)["database"]
    assert (db["backend"], db["host"], db["user"]) == ("postgres", "a", "ua")
    assert db["pending"]["host"] == "b"
    assert (env["dir"] / ".db_password").read_text() == "pa"


# ── Routes admin ─────────────────────────────────────────────────────────────

@pytest.fixture()
def client(env, monkeypatch):
    import shared_infra.routes.admin.database as R
    monkeypatch.setattr(R, "_require_admin", lambda request: 1)
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="test")
    app.include_router(R.admin_router)
    return TestClient(app)


def test_etat_et_reglages(client, env, monkeypatch):
    # La suite peut tourner sur un serveur (APP_DB_* posées) : attendu calculé.
    import shared_infra.routes.admin.database as R
    r = client.get("/api/admin/database").json()
    assert r["saved"]["backend"] == "sqlite"
    assert r["saved"]["password_present"] is bool(os.environ.get("APP_DB_PASSWORD"))
    assert r["env"] == [k for k in R._ENV_KEYS if os.environ.get(k)]
    assert r["job"] == {"state": "idle"}
    assert r["active"]["backend"] in ("sqlite", "postgres", "mysql"), r["active"]
    body = {"backend": "mariadb", "host": "h", "name": "e", "user": "u", "password": "x"}
    saved = client.post("/api/admin/database/save", json=body).json()["saved"]
    assert saved["password_present"] and saved["pending"] and saved["backend"] == "mysql"
    assert _cfg(env)["database"]["pending"]["port"] == 3306
    assert "backend" not in _cfg(env)["database"]


def test_formulaire_invalide_et_env_impose(client, monkeypatch):
    assert client.post("/api/admin/database/test", json={"backend": "oracle"}).status_code == 400
    assert client.post("/api/admin/database/test",
                       json={"backend": "postgres", "host": ""}).status_code == 400
    monkeypatch.setenv("APP_DB_BACKEND", "sqlite")
    r = client.post("/api/admin/database/migrate",
                    json={"backend": "postgres", "host": "h", "name": "e", "user": "u"})
    assert r.status_code == 409


def test_test_d_un_serveur_injoignable_rend_une_erreur_lisible(client):
    r = client.post("/api/admin/database/test", json={
        "backend": "postgres", "host": "127.0.0.1", "port": 1, "name": "e", "user": "u"}).json()
    assert r["ok"] is False and r["error"]


# ── CLI ──────────────────────────────────────────────────────────────────────

def test_cli_check_et_transfert(tmp_path, capsys):
    from shared_infra.db.__main__ import main
    assert main(["check", f"sqlite:{tmp_path / 'vide.db'}"]) == 0
    assert json.loads(capsys.readouterr().out)["empty"] is True
    assert main(["transfer", "--from", f"sqlite:{tmp_path / 'vide.db'}",
                 "--to", f"sqlite:{tmp_path / 'b.db'}"]) == 2     # source sans schéma


# ── Bascule complète (serveur de test) ───────────────────────────────────────

@pytest.mark.sqlite_only   # la base ACTIVE doit être le fichier SQLite du test
@pytest.mark.skipif(not os.environ.get("ELPIS_TEST_PG"), reason="ELPIS_TEST_PG absent")
def test_bascule_sqlite_vers_postgres(env, monkeypatch):
    from shared_infra.db import _connection as C, transfer as T
    from shared_infra.ops import db_switch
    C.init_db()
    from shared_infra.accounts.users import create_user
    create_user("alice", "pw-alice-123")
    host, port, name, user, password = os.environ["ELPIS_TEST_PG"].split(":", 4)
    sch = "x_" + uuid.uuid4().hex[:12]
    base = dict(backend="postgres", host=host, port=int(port), name=name, user=user,
                password=password, tls="off", timeout=30, schema=None)
    admin = C.connect_server(base)
    admin.execute(f'CREATE SCHEMA "{sch}"')
    try:
        reloads = []
        db_switch._write_job(state="running", kind="migrate")
        db_switch._run("migrate", dict(base, schema=sch), lambda: reloads.append(1))
        job = db_switch.job_status()
        assert job["state"] == "done", job
        assert reloads == [1]
        d = _cfg(env)["database"]
        assert d["backend"] == "postgres" and d["generation"] == 1
        assert (env["dir"] / ".db_password").read_text() == password
        assert json.loads((env["dir"] / ".db_maintenance").read_text())["generation"] == 1
        c = T.connect(dict(base, schema=sch))
        try:
            assert c.execute("SELECT username FROM users").fetchall()[0][0] == "alice"
        finally:
            c.hard_close()
    finally:
        admin.execute(f'DROP SCHEMA "{sch}" CASCADE')
        admin.hard_close()
