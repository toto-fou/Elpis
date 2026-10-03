# SPDX-License-Identifier: MIT
"""Bascule de base robuste aux interruptions (lot 3, 2026-10-03).

* drapeau ``.db_maintenance`` laissé par un process admin tué : il bloquait
  toutes les écritures (503) indéfiniment ;
* fermeture stricte quand le drapeau ou config.json sont illisibles pendant
  une bascule ;
* copie ratée : la cible restait à moitié remplie et refusait toute reprise ;
* installeur : une copie ratée laissait poser le schéma dans la cible.
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.config as cfg
    from shared_infra.db import _connection as C
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"database": {"backend": "sqlite", "generation": 0}}), encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)
    cfg.invalidate_config_cache()
    monkeypatch.setattr(cfg, "DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setattr(C, "DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setattr(cfg, "DB_GENERATION", 0)
    monkeypatch.setattr(C, "_gen_stale", False)
    monkeypatch.setattr(C, "_gen_checked_at", 0.0)
    yield {"config": p, "dir": tmp_path}
    cfg.invalidate_config_cache()


def _drapeau(env, contenu=None):
    (env["dir"] / ".db_maintenance").write_text(
        contenu if contenu is not None else json.dumps({"generation": 1, "since": time.time()}),
        encoding="utf-8")


def _pid_mort() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def _client():
    from shared_infra.ops.db_switch import MaintenanceASGI
    app = FastAPI()

    @app.post("/api/x")
    def ecrire():
        return {"ok": True}

    app.add_middleware(MaintenanceASGI)
    return TestClient(app)


# ── Drapeau orphelin ─────────────────────────────────────────────────────────

def test_drapeau_sans_tache_n_est_plus_ecoute(env):
    from shared_infra.ops import db_switch
    _drapeau(env)
    assert not db_switch.maintenance_active()
    assert _client().post("/api/x").status_code == 200


def test_tache_dont_le_process_est_mort(env):
    from shared_infra.ops import db_switch
    _drapeau(env)
    db_switch._write_job(state="running", kind="migrate", pid=_pid_mort())
    assert not db_switch.maintenance_active()
    job = db_switch.job_status()
    assert job["state"] == "error" and "interrompue" in job["error"]
    assert not db_switch._running()                  # « Migrer » n'est plus bloqué 600 s


def test_tache_sans_avancement_depuis_dix_minutes(env, monkeypatch):
    from shared_infra.ops import db_switch
    _drapeau(env)
    db_switch._write_job(state="running", kind="migrate", pid=os.getpid())
    vrai = time.time
    monkeypatch.setattr(db_switch.time, "time", lambda: vrai() + db_switch._JOB_STALE_S + 1)
    assert not db_switch.maintenance_active()


def test_tache_vivante_bloque_les_ecritures(env):
    from shared_infra.ops import db_switch
    _drapeau(env)
    db_switch._write_job(state="running", kind="migrate", pid=os.getpid())
    assert db_switch.maintenance_active()
    assert _client().post("/api/x").status_code == 503


def test_bascule_publiee_bloque_les_anciens_process_sans_tache(env):
    import shared_infra.config as cfg
    from shared_infra.ops import db_switch
    _drapeau(env)
    env["config"].write_text(json.dumps({"database": {"generation": 1}}), encoding="utf-8")
    cfg.invalidate_config_cache()
    db_switch._write_job(state="done", kind="migrate")
    assert db_switch.maintenance_active()


def test_drapeau_illisible_strict_seulement_pendant_une_tache(env):
    from shared_infra.ops import db_switch
    _drapeau(env, "{pas du json")
    assert not db_switch.maintenance_active()
    db_switch._write_job(state="running", kind="migrate", pid=os.getpid())
    assert db_switch.maintenance_active()


# ── Garde de génération ──────────────────────────────────────────────────────

@pytest.mark.sqlite_only   # DB_PATH redirigé vers un fichier : la garde est commune
def test_sans_section_database_la_bascule_ne_bloque_pas_l_application(env, monkeypatch):
    """Relecture 2026-10-03 : une config sans section « database » ne doit pas
    fermer la base à tous les process (process admin compris) pendant la
    copie ; seule la publication rend les anciens process périmés."""
    import shared_infra.config as cfg
    from shared_infra.db import _connection as C
    from shared_infra.ops import db_switch
    env["config"].write_text(json.dumps({"app": {}}), encoding="utf-8")
    cfg.invalidate_config_cache()
    _drapeau(env)
    db_switch._write_job(state="running", kind="migrate", pid=os.getpid())
    with C.db_conn() as c:
        c.execute("SELECT 1").fetchone()


@pytest.mark.sqlite_only
def test_config_illisible_apres_publication_le_drapeau_suffit(env, monkeypatch):
    import shared_infra.config as cfg
    from shared_infra.db import _connection as C
    from shared_infra.ops import db_switch
    env["config"].write_text("{illisible", encoding="utf-8")
    cfg.invalidate_config_cache()
    _drapeau(env, json.dumps({"generation": 1, "published": True}))
    assert db_switch.published_generation() == 1
    assert db_switch.maintenance_active()            # 503 sans tâche ni config lisible
    monkeypatch.setattr(C, "_gen_checked_at", 0.0)
    with pytest.raises(sqlite3.OperationalError, match="basculée"):
        C.db()


# ── Copie ratée : cible vidée ────────────────────────────────────────────────

@pytest.mark.sqlite_only   # la source est le fichier SQLite du test
def test_copie_ratee_vide_la_cible_et_permet_de_reprendre(env, monkeypatch):
    from shared_infra.db import _connection as C, transfer as T
    from shared_infra.db._dialect import table_names
    C.init_db()
    from shared_infra.accounts.users import create_user
    create_user("alice", "pw-alice-123")
    source = {"backend": "sqlite", "path": str(env["dir"] / "app.db")}
    cible = {"backend": "sqlite", "path": str(env["dir"] / f"cible-{uuid.uuid4().hex[:6]}.db")}

    vrai, appels = T._insert_rows, []

    def panne(conn, table, cols, rows):
        appels.append(table)
        if len(appels) == 2:
            raise RuntimeError("disque plein")
        return vrai(conn, table, cols, rows)

    monkeypatch.setattr(T, "_insert_rows", panne)
    with pytest.raises(RuntimeError, match="disque plein"):
        T.transfer(source, cible)
    c = T.connect(cible)
    try:
        assert table_names(c) == []
    finally:
        c.close()

    monkeypatch.setattr(T, "_insert_rows", vrai)
    report = T.transfer(source, cible)
    assert report["ok"], report


@pytest.mark.sqlite_only
def test_verification_ratee_vide_aussi_la_cible(env, monkeypatch):
    from shared_infra.db import _connection as C, transfer as T
    from shared_infra.db._dialect import table_names
    C.init_db()
    from shared_infra.accounts.users import create_user
    create_user("alice", "pw-alice-123")
    cible = {"backend": "sqlite", "path": str(env["dir"] / "cible.db")}
    monkeypatch.setattr(T, "_digest", lambda rows: uuid.uuid4().hex)
    report = T.transfer({"backend": "sqlite", "path": str(env["dir"] / "app.db")}, cible)
    assert not report["ok"] and report["target_cleared"] is True
    c = T.connect(cible)
    try:
        assert table_names(c) == []
    finally:
        c.close()


@pytest.mark.sqlite_only
def test_process_tue_pendant_la_copie_la_tentative_suivante_reprend(env, monkeypatch):
    """Process admin tué pendant la copie : rien n'a vidé la cible. La table
    témoin la signale ; « Tester » la montre, la simulation n'y touche pas,
    le transfert suivant la vide et reprend."""
    from shared_infra.db import _connection as C, transfer as T
    from shared_infra.db._dialect import table_names
    C.init_db()
    from shared_infra.accounts.users import create_user
    create_user("alice", "pw-alice-123")
    source = {"backend": "sqlite", "path": str(env["dir"] / "app.db")}
    cible = {"backend": "sqlite", "path": str(env["dir"] / "cible.db")}

    vrai, appels = T._insert_rows, []

    def mort(conn, table, cols, rows):
        appels.append(table)
        if len(appels) == 2:
            raise SystemExit("process tué")
        return vrai(conn, table, cols, rows)

    vider = T._clear_target
    monkeypatch.setattr(T, "_insert_rows", mort)
    monkeypatch.setattr(T, "_clear_target", lambda conn, report: None)   # mort : rien ne vide
    with pytest.raises(SystemExit):
        T.transfer(source, cible)
    monkeypatch.setattr(T, "_insert_rows", vrai)
    monkeypatch.setattr(T, "_clear_target", vider)

    etat = T.check_target(cible)
    assert etat["partial"] is True and etat["empty"] is True
    assert T.transfer(source, cible, dry_run=True)["ok"]
    c = T.connect(cible)
    try:
        assert T.PARTIAL_MARK in table_names(c)       # la simulation n'a rien vidé
    finally:
        c.close()

    report = T.transfer(source, cible)
    assert report["ok"], report
    c = T.connect(cible)
    try:
        noms = table_names(c)
        assert T.PARTIAL_MARK not in noms and "users" in noms
        assert c.execute("SELECT username FROM users").fetchall() == [("alice",)]
    finally:
        c.close()


@pytest.mark.sqlite_only
def test_cible_non_vide_au_depart_jamais_videe(env, tmp_path):
    from shared_infra.db import _connection as C, transfer as T
    C.init_db()
    autre = tmp_path / "autre.db"
    c = sqlite3.connect(autre)
    c.execute("CREATE TABLE a_quelqu_un (x)")
    c.commit()
    c.close()
    with pytest.raises(T.TransferError, match="non vide"):
        T.transfer({"backend": "sqlite", "path": str(env["dir"] / "app.db")},
                   {"backend": "sqlite", "path": str(autre)})
    c = sqlite3.connect(autre)
    try:
        assert c.execute("SELECT name FROM sqlite_master").fetchall() == [("a_quelqu_un",)]
    finally:
        c.close()


# ── Installeur ───────────────────────────────────────────────────────────────

def test_installeur_reste_sur_sqlite_si_la_copie_echoue(tmp_path, monkeypatch):
    from deploy import configure as K
    monkeypatch.setattr(K, "CONFIG", tmp_path / "config.json")
    monkeypatch.setattr(K, "USER_DB", tmp_path / "user_db")
    monkeypatch.setattr(K, "DB_PASSWORD_FILE", tmp_path / "user_db" / ".db_password")
    K.write_private(K.DB_PASSWORD_FILE, "s3cret\n")
    cfg = {"database": {"backend": "postgres", "host": "db.lan", "port": 5432,
                        "name": "elpis", "user": "elpis", "tls": "off"}}
    K.keep_sqlite_after_failed_transfer(cfg)
    ecrit = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert ecrit["database"]["backend"] == "sqlite"
    assert ecrit["database"]["pending"] == {"backend": "postgres", "host": "db.lan", "port": 5432,
                                            "name": "elpis", "user": "elpis", "tls": "off"}
    assert (tmp_path / "user_db" / ".db_password.pending").read_text(encoding="utf-8").strip() == "s3cret"
