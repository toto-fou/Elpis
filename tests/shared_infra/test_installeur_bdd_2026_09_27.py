# SPDX-License-Identifier: MIT
"""Installeur et choix de la base de données (lot F du chantier multi-moteurs).

* ``install.sh`` : option ``--db``, récapitulatif, refus des valeurs inconnues ;
* ``deploy/qdrant/`` versionné (install.sh le source ; la règle ``qdrant/`` du
  .gitignore l'avalait, installeur cassé sur un clone neuf) ;
* ``deploy/configure.py`` : étape « Base de données » (moteur, réglages, mot
  de passe hors de config.json, transfert des données SQLite existantes) ;
* licences : chaque paquet des ``requirements*.txt`` figure dans
  ``THIRD_PARTY_NOTICES.md``.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sqlite3
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


# ── install.sh ───────────────────────────────────────────────────────────────

def _install(*args):
    return subprocess.run(["bash", str(REPO / "install.sh"), "--dry-run", "--yes", *args],
                          capture_output=True, text=True, timeout=60, cwd=str(REPO),
                          stdin=subprocess.DEVNULL)


def test_install_syntaxe():
    for script in ("install.sh", "elpis"):
        assert subprocess.run(["bash", "-n", str(REPO / script)]).returncode == 0


@pytest.mark.parametrize("mode", ["sqlite", "postgres-local", "mariadb-local", "external"])
def test_install_choix_de_base(mode):
    r = _install("--db", mode)
    assert r.returncode == 0, r.stderr
    assert re.search(rf"base de données\s+: {mode}\b", r.stdout), r.stdout


def test_install_alias_et_refus():
    assert "postgres-local" in _install("--db=postgresql").stdout
    r = _install("--db", "oracle")
    assert r.returncode == 2 and "--db" in r.stderr


def test_qdrant_versionne_et_verifie():
    env = (REPO / "deploy/qdrant/qdrant.env").read_text(encoding="utf-8")
    vals = dict(l.split("=", 1) for l in env.splitlines() if "=" in l and not l.startswith("#"))
    assert re.fullmatch(r"\d+\.\d+\.\d+", vals["QDRANT_VERSION"])
    for arch in ("x86_64", "aarch64"):
        assert vals[f"QDRANT_ASSET_{arch}"].endswith(".tar.gz")
        assert re.fullmatch(r"[0-9a-f]{64}", vals[f"QDRANT_SHA256_{arch}"])
    assert (REPO / "deploy/qdrant/config.yaml").is_file()
    r = subprocess.run(["git", "check-ignore", "-q", "deploy/qdrant/qdrant.env"], cwd=str(REPO))
    assert r.returncode == 1, "deploy/qdrant/ ne doit pas être ignoré par git"


# ── configure.py : étape base de données ─────────────────────────────────────

@pytest.fixture
def conf(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_test", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "USER_DB", tmp_path / "user_db")
    monkeypatch.setattr(mod, "DB_PASSWORD_FILE", tmp_path / "user_db" / ".db_password")
    for k in list(os.environ):
        if k.startswith("ELPIS_CFG_DB"):
            monkeypatch.delenv(k)
    checks = []

    def fake_check(target):
        checks.append(dict(target))
        return {"ok": True, "version": "PostgreSQL 17", "tables": 0, "empty": True}

    monkeypatch.setattr(mod, "_db_check", fake_check)
    mod._checks = checks
    return mod


def _args(**kw):
    base = dict(db=None, db_host=None, db_port=None, db_name=None, db_user=None,
                db_tls=None, db_transfer=None)
    base.update(kw)
    return argparse.Namespace(**base)


def test_sqlite_par_defaut(conf):
    cfg = {}
    assert conf.step_database(conf.Prompter(False), _args(), cfg) is None
    assert cfg["database"] == {"backend": "sqlite"}


def test_serveur_mot_de_passe_hors_config(conf, monkeypatch):
    monkeypatch.setenv("ELPIS_CFG_DB_PASSWORD", "s3cret")
    cfg = {}
    plan = conf.step_database(conf.Prompter(False), _args(db="postgres-local", db_host="db.lan"), cfg)
    assert plan is None                                      # pas de base SQLite à copier
    assert cfg["database"] == {"backend": "postgres", "host": "db.lan", "port": 5432,
                               "name": "elpis", "user": "elpis", "tls": "off"}
    pw = conf.DB_PASSWORD_FILE
    assert pw.read_text().strip() == "s3cret" and stat.S_IMODE(pw.stat().st_mode) == 0o600
    assert "s3cret" not in json.dumps(cfg)
    assert conf._checks[0]["password"] == "s3cret"


def test_mot_de_passe_existant_reutilise(conf):
    conf.USER_DB.mkdir()
    conf.DB_PASSWORD_FILE.write_text("deja\n")
    cfg = {}
    conf.step_database(conf.Prompter(False), _args(db="mariadb"), cfg)
    assert cfg["database"]["backend"] == "mysql" and cfg["database"]["port"] == 3306
    assert conf._checks[0]["password"] == "deja"


def _sqlite_peuplee(root: Path):
    (root / "user_db").mkdir(exist_ok=True)
    c = sqlite3.connect(str(root / "user_db" / "app.db"))
    c.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
    c.execute("INSERT INTO users(username) VALUES ('alice')")
    c.commit()
    c.close()


def test_donnees_sqlite_existantes_proposees_au_transfert(conf, monkeypatch, tmp_path):
    _sqlite_peuplee(tmp_path)
    monkeypatch.setenv("ELPIS_CFG_DB_PASSWORD", "pw")
    plan = conf.step_database(conf.Prompter(False), _args(db="postgres"), {})
    assert plan["source"] == f"sqlite:{tmp_path / 'user_db' / 'app.db'}"
    assert plan["target"] == "postgres://elpis@127.0.0.1:5432/elpis?tls=off"
    assert plan["password"] == "pw"
    assert conf.step_database(conf.Prompter(False), _args(db="postgres", db_transfer="0"), {
        "database": {"backend": "sqlite"}}) is None


def test_connexion_impossible_non_interactive_garde_les_reglages(conf, monkeypatch):
    monkeypatch.setattr(conf, "_db_check", lambda t: {"ok": False, "error": "refusé"})
    cfg = {}
    assert conf.step_database(conf.Prompter(False), _args(db="postgres"), cfg) is None
    assert cfg["database"]["backend"] == "postgres"


def test_options_de_la_ligne_de_commande():
    spec = importlib.util.spec_from_file_location("elpis_configure_cli", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    a = mod.build_parser().parse_args(["--db", "postgres", "--db-host", "h", "--db-port", "6543",
                                       "--db-tls", "require", "--db-transfer", "off"])
    assert (a.db, a.db_host, a.db_port, a.db_tls, a.db_transfer) == ("postgres", "h", "6543",
                                                                      "require", "off")


@pytest.mark.skipif(not os.environ.get("ELPIS_TEST_PG"), reason="ELPIS_TEST_PG absent")
def test_sonde_reelle_en_sous_processus():
    spec = importlib.util.spec_from_file_location("elpis_configure_real", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    host, port, name, user, password = os.environ["ELPIS_TEST_PG"].split(":", 4)
    res = mod._db_check({"backend": "postgres", "host": host, "port": int(port), "name": name,
                         "user": user, "password": password, "tls": "off", "timeout": 10,
                         "schema": None})
    assert res["ok"] and res["version"].startswith("PostgreSQL")
    bad = mod._db_check({"backend": "postgres", "host": host, "port": int(port), "name": name,
                         "user": user, "password": "faux", "tls": "off", "timeout": 10,
                         "schema": None})
    assert bad["ok"] is False and bad["error"]


# ── Licences ─────────────────────────────────────────────────────────────────

def _paquets(req: Path):
    out = []
    for line in req.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        out.append(re.split(r"[\[<>=!~ ;]", line, maxsplit=1)[0])
    return out


def test_chaque_dependance_figure_dans_les_notices():
    notices = (REPO / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8").lower()
    manquants = []
    for req in sorted(REPO.glob("requirements*.txt")):
        for pkg in _paquets(req):
            name = pkg.lower()
            variants = {name, name.replace("-", "_"), name.replace("_", "-"),
                        name.replace("python-", "")}
            if not any(re.search(rf"(?<![\w-]){re.escape(v)}(?![\w-])", notices) for v in variants):
                manquants.append(f"{req.name}: {pkg}")
    assert not manquants, "à déclarer dans THIRD_PARTY_NOTICES.md : " + ", ".join(manquants)
