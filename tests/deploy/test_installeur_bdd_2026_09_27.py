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
import shutil
import sqlite3
import stat
import subprocess
from pathlib import Path

import pytest

from tests._serveur_pg import serveur_pg

REPO = Path(__file__).resolve().parents[2]


# ── install.sh ───────────────────────────────────────────────────────────────

def _install(*args):
    return subprocess.run(["bash", str(REPO / "install.sh"), "--dry-run", "--yes", *args],
                          capture_output=True, text=True, timeout=60, cwd=str(REPO),
                          stdin=subprocess.DEVNULL)


def test_install_syntaxe():
    for script in ("install.sh", "elpis"):
        assert subprocess.run(["bash", "-n", str(REPO / script)]).returncode == 0


@pytest.mark.parametrize("mode", ["sqlite", "postgres-local", "external"])
def test_install_choix_de_base(mode):
    r = _install("--db", mode)
    assert r.returncode == 0 or "l'installation réelle s'arrêterait" in r.stderr, r.stderr   # sudo, paquets apt de cet hôte
    assert re.search(rf"base de données\s+: {mode}\b", r.stdout), r.stdout


def test_install_alias_et_refus():
    assert "postgres-local" in _install("--db=postgresql").stdout
    r = _install("--db", "oracle")
    assert r.returncode == 2 and "--db" in r.stderr
    for retire in ("mariadb", "mariadb-local", "mysql"):
        r = _install("--db", retire)
        assert r.returncode == 2 and "n'est plus pris en charge" in r.stderr, r.stderr


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
    # Chemins calculés à l'import depuis la VRAIE racine : tous redirigés.
    monkeypatch.setattr(mod, "CONFIG", tmp_path / "config.json")
    monkeypatch.setattr(mod, "ENV_FILE", tmp_path / ".env")
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
    conf.step_database(conf.Prompter(False), _args(db="postgresql"), cfg)
    assert cfg["database"]["backend"] == "postgres" and cfg["database"]["port"] == 5432
    assert conf._checks[0]["password"] == "deja"


@pytest.mark.parametrize("actuel,demande", [("mysql", None), ("mysql", "sqlite"),
                                            ("sqlite", "mariadb"), ("sqlite", "mariadb-local")])
def test_mariadb_retire_refuse_sans_rien_ecrire(conf, capsys, actuel, demande):
    cfg = {"database": {"backend": actuel, "host": "db.lan"}}
    with pytest.raises(SystemExit) as ei:
        conf.step_database(conf.Prompter(False), _args(db=demande), cfg)
    assert ei.value.code == 2
    assert cfg["database"] == {"backend": actuel, "host": "db.lan"}
    assert not conf._checks
    assert "n'est plus pris en charge" in capsys.readouterr().err


def test_check_db_refuse_mariadb(conf, capsys):
    assert conf.check_db(_args(db="mariadb")) == 2
    assert "n'est plus pris en charge" in capsys.readouterr().out


@pytest.mark.parametrize("args", [["--yes"], ["--yes", "--force"]])
def test_configure_refuse_une_base_mariadb_avant_toute_ecriture(conf, tmp_path, monkeypatch, args):
    monkeypatch.delenv("APP_DB_BACKEND", raising=False)
    sur_disque = json.dumps({"database": {"backend": " MySQL "}})
    conf.CONFIG.write_text(sur_disque)
    with pytest.raises(SystemExit) as ei:
        conf.main(args)
    assert ei.value.code == 2
    assert conf.CONFIG.read_text() == sur_disque
    assert sorted(p.name for p in tmp_path.iterdir()) == ["config.json"]


def test_configure_refuse_app_db_backend_mariadb(conf, monkeypatch):
    monkeypatch.setenv("APP_DB_BACKEND", "mariadb")
    with pytest.raises(SystemExit) as ei:
        conf.main(["--yes"])
    assert ei.value.code == 2 and not conf.CONFIG.exists()


@pytest.mark.parametrize("config,env", [({"database": {"backend": "mysql"}}, None),
                                        ({"database": {"backend": "sqlite"}}, "MariaDB")])
def test_install_refuse_une_base_mariadb_avant_toute_etape(tmp_path, config, env):
    shutil.copy(REPO / "install.sh", tmp_path / "install.sh")
    (tmp_path / "config.json").write_text(json.dumps(config))
    environ = {k: v for k, v in os.environ.items() if k != "APP_DB_BACKEND"}
    if env:
        environ["APP_DB_BACKEND"] = env
    r = subprocess.run(["bash", str(tmp_path / "install.sh"), "--dry-run", "--yes"], env=environ,
                       capture_output=True, text=True, timeout=60, cwd=str(tmp_path),
                       stdin=subprocess.DEVNULL)
    assert r.returncode == 2 and "n'est plus pris en charge" in r.stderr, r.stderr
    assert sorted(p.name for p in tmp_path.iterdir()) == ["config.json", "install.sh"]


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
    host, port, name, user, password = serveur_pg(os.environ["ELPIS_TEST_PG"])
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


def test_copie_ratee_puis_nouveau_choix_retire_la_cible_en_attente(conf, monkeypatch):
    """Lot 3 (2026-10-03) : après une copie ratée, la cible est gardée « en
    attente » ; relancer l'installeur et choisir un serveur la remplace."""
    monkeypatch.setenv("ELPIS_CFG_DB_PASSWORD", "s3cret")
    cfg = {}
    conf.step_database(conf.Prompter(False), _args(db="postgres", db_host="db.lan"), cfg)
    conf.keep_sqlite_after_failed_transfer(cfg)
    assert cfg["database"]["backend"] == "sqlite" and cfg["database"]["pending"]["host"] == "db.lan"
    assert (conf.USER_DB / ".db_password.pending").read_text().strip() == "s3cret"
    conf.step_database(conf.Prompter(False), _args(db="postgres", db_host="db.lan"), cfg)
    assert cfg["database"]["backend"] == "postgres" and "pending" not in cfg["database"]
    assert not (conf.USER_DB / ".db_password.pending").exists()


# ── configure.py : relais vers l'hôte d'outils posé dans mcp.json ────────────

def test_mcp_json_existant_recoit_le_relais(conf, tmp_path):
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps({"mcpServers": {}, "sandboxHosts": {
        "main": {"url": "http://127.0.0.1:8765", "token": "${file:user_db/.local_mcp_token}"},
        "vm": {"url": "https://vm:8765", "relay": False}}}))
    assert conf.migrate_sandbox_relay(p) is True
    hosts = json.loads(p.read_text())["sandboxHosts"]
    assert hosts["main"]["relay"] is True and hosts["main"]["token"].startswith("${file:")
    assert hosts["vm"]["relay"] is False and "token" not in hosts["vm"]   # jeton local jamais envoyé au distant
    assert conf.migrate_sandbox_relay(p) is False                  # idempotent


def test_mcp_json_avec_toolhosts_seul_y_recoit_le_relais(conf, tmp_path):
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps({"toolHosts": {"vm": {"url": "https://vm:8765", "token": "t"}},
                             "placement": {"strategy": "single", "host": "vm"}}))
    assert conf.migrate_sandbox_relay(p) is True
    doc = json.loads(p.read_text())
    assert "sandboxHosts" not in doc and doc["toolHosts"]["vm"] == {"url": "https://vm:8765", "token": "t",
                                                                     "relay": True}


def test_mcp_json_sans_hote_recoit_l_hote_local(conf, tmp_path):
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps({"mcpServers": {}, "toolHosts": "invalide"}))
    assert conf.migrate_sandbox_relay(p) is True
    doc = json.loads(p.read_text())
    assert doc["sandboxHosts"] == {"main": {"url": "http://127.0.0.1:8765", "relay": True,
                                            "token": conf.TOOLHOST_TOKEN_REF}}
    assert doc["placement"] == {"strategy": "single", "host": "main"}


def test_mcp_json_illisible_laisse_tel_quel(conf, tmp_path, capsys):
    p = tmp_path / "mcp.json"
    p.write_text("{pas du json")
    assert conf.migrate_sandbox_relay(p) is False and p.read_text() == "{pas du json"
    assert "illisible" in capsys.readouterr().err


def test_exemple_mcp_json_active_le_relais():
    doc = json.loads((REPO / "mcp.example.json").read_text())
    assert all(h.get("relay") is True and h.get("token") for h in doc["sandboxHosts"].values())


def test_entrees_app_servies_en_processus(conf, tmp_path, capsys):
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps({"mcpServers": {
        "elpis-todo": {"type": "http", "url": "http://127.0.0.1:8766/mcp/todo",
                       "headers": {"Authorization": f"Bearer {conf.TOOLHOST_TOKEN_REF}"},
                       "x-elpis": {"role": "app", "families": ["todo"]}},
        "elpis-app": {"type": "http", "url": "http://localhost:8766/mcp", "description": "d",
                      "x-elpis": {"role": "app", "families": ["chart", "skill"], "default_on": ["skill"]}},
        "elpis-memory": {"type": "http", "url": "http://10.0.0.9:8766/mcp/memory",
                         "x-elpis": {"role": "app", "families": ["memory"]}},
        "elpis-autre-port": {"type": "http", "url": "http://127.0.0.1:9000/mcp/x",
                             "x-elpis": {"role": "app", "families": ["x"]}},
        "elpis-fs": {"type": "http", "url": "http://127.0.0.1:8765/mcp/fs", "x-elpis": {"role": "toolhost"}}}}))
    assert conf.migrate_app_entries(p) is True
    srv = json.loads(p.read_text())["mcpServers"]
    assert srv["elpis-todo"] == {"type": "inprocess", "x-elpis": {"role": "app", "families": ["todo"]}}
    assert srv["elpis-app"] == {"type": "inprocess", "description": "d",
                                "x-elpis": {"role": "app", "families": ["chart", "skill"], "default_on": ["skill"]}}
    assert srv["elpis-memory"]["url"] == "http://10.0.0.9:8766/mcp/memory"
    assert srv["elpis-autre-port"]["url"] == "http://127.0.0.1:9000/mcp/x"
    assert srv["elpis-fs"]["url"].endswith(":8765/mcp/fs")
    assert "en processus" in capsys.readouterr().out
    assert conf.migrate_app_entries(p) is False


def test_migrer_et_verifier_mcp_sans_question(conf, tmp_path, monkeypatch):
    monkeypatch.setattr(conf, "ROOT", tmp_path)
    monkeypatch.setattr(conf, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(conf, "SYSTEMD_DIR", tmp_path)
    monkeypatch.delenv("ELPIS_APPMCP", raising=False)
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps({"mcpServers": {
        "elpis-todo": {"type": "http", "url": "http://[::1]:8766/mcp/todo", "x-elpis": {"role": "app", "families": ["todo"]}},
        "elpis-x": {"type": "http", "url": "http://[::1/mcp", "x-elpis": {"role": "app", "families": ["x"]}}}}))
    avant = p.read_text()
    assert conf.migrate_app_entries(p, ecrire=False) is True and p.read_text() == avant
    assert conf.main(["--verifier-mcp"]) == 1
    (tmp_path / ".env").write_text("ELPIS_APPMCP=python\n")              # retour arrière retiré : sans effet
    assert conf.main(["--verifier-mcp"]) == 1
    assert conf.main(["--migrer-mcp"]) == 0
    srv = json.loads(p.read_text())["mcpServers"]
    assert srv["elpis-todo"]["type"] == "inprocess" and "url" not in srv["elpis-todo"]
    assert srv["elpis-x"]["url"] == "http://[::1/mcp"
    assert conf.main(["--verifier-mcp"]) == 0


# ── configure.py : familles de mcp.example.json absentes d'un mcp.json ancien (office, 04/10) ──

def _ancien_mcp(tmp_path, *retirees):
    """mcp.example.json copié sous ROOT, et un mcp.json d'avant ces familles sur un hôte d'outils personnalisé."""
    exemple = json.loads((REPO / "mcp.example.json").read_text())
    (tmp_path / "mcp.example.json").write_text(json.dumps(exemple))
    doc = json.loads(json.dumps(exemple))
    for nom in retirees:
        del doc["mcpServers"][nom]
    for spec in doc["mcpServers"].values():
        xe = spec["x-elpis"]
        if xe["role"] == "toolhost":
            spec["url"] = spec["url"].replace("http://127.0.0.1:8765", "https://outils.lan:9443")
            spec["headers"] = {"Authorization": "Bearer jeton-perso", "X-Perso": "1"}
            xe["host"] = "vm"
    doc["mcpServers"]["elpis-git"]["timeout"] = 120
    doc["mcpServers"]["externe"] = {"type": "http", "url": "https://ext.lan/mcp"}
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps(doc))
    return p, exemple


def test_famille_manquante_ajoutee_sur_le_modele_de_l_hote(conf, tmp_path, capsys):
    p, exemple = _ancien_mcp(tmp_path, "elpis-office")
    avant = json.loads(p.read_text())["mcpServers"]
    assert conf.migrate_missing_families(p, ecrire=False) == ["office"] and json.loads(p.read_text())["mcpServers"] == avant
    assert conf.migrate_missing_families(p) == ["office"]
    srv = json.loads(p.read_text())["mcpServers"]
    assert list(srv)[list(srv).index("elpis-git") + 1] == "elpis-office"
    assert {k: v for k, v in srv.items() if k != "elpis-office"} == avant
    office = srv["elpis-office"]
    assert office["url"] == "https://outils.lan:9443/mcp/office" and office["type"] == avant["elpis-fs"]["type"]
    assert office["headers"] == {"Authorization": "Bearer jeton-perso", "X-Perso": "1"}
    assert office["x-elpis"] == {**exemple["mcpServers"]["elpis-office"]["x-elpis"], "host": "vm"}
    assert "timeout" not in office and "office" in capsys.readouterr().out
    assert conf.migrate_missing_families(p) == []                  # idempotent


def test_familles_decidees_par_le_user_jamais_rajoutees(conf, tmp_path):
    p, exemple = _ancien_mcp(tmp_path)
    doc = json.loads(p.read_text())
    doc["mcpServers"]["mon-office"] = {**doc["mcpServers"].pop("elpis-office"), "enabled": False}  # renommée, éteinte
    p.write_text(json.dumps(doc))
    assert conf.migrate_missing_families(p) == []
    del doc["mcpServers"]["elpis-todo"]
    doc["mcpServers"]["mes-outils"] = {"type": "http", "url": "https://x/mcp",
                                       "x-elpis": {"role": "app", "families": "all,-todo"}}
    p.write_text(json.dumps(doc))
    assert conf.migrate_missing_families(p) == []                  # « -todo » : exclusion voulue
    p, _ = _ancien_mcp(tmp_path, "elpis-todo")
    doc = json.loads(p.read_text())
    perso = {"type": "inprocess", "x-elpis": {"role": "app", "families": ["memory"]}}
    doc["mcpServers"]["elpis-todo"] = perso
    p.write_text(json.dumps(doc))
    assert conf.migrate_missing_families(p) == []                  # nom pris : signalé, rien d'écrasé
    assert json.loads(p.read_text())["mcpServers"]["elpis-todo"] == perso


def test_sans_modele_toolhost_et_famille_du_compte_reprises_de_l_exemple(conf, tmp_path):
    exemple = json.loads((REPO / "mcp.example.json").read_text())
    (tmp_path / "mcp.example.json").write_text(json.dumps(exemple))
    p = tmp_path / "mcp.json"
    p.write_text(json.dumps({"mcpServers": {k: v for k, v in exemple["mcpServers"].items()
                                            if k not in ("elpis-shell", "elpis-todo") and v["x-elpis"]["role"] == "app"}}))
    ajoutees = conf.migrate_missing_families(p)
    assert "shell" in ajoutees and "todo" in ajoutees
    srv = json.loads(p.read_text())["mcpServers"]
    assert srv["elpis-shell"] == exemple["mcpServers"]["elpis-shell"]
    assert srv["elpis-todo"] == exemple["mcpServers"]["elpis-todo"]


def test_migrer_et_verifier_les_familles_sans_question(conf, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(conf, "SYSTEMD_DIR", tmp_path)
    monkeypatch.delenv("ELPIS_APPMCP", raising=False)
    p, exemple = _ancien_mcp(tmp_path, "elpis-office", "elpis-chart")
    assert conf.main(["--verifier-familles-mcp"]) == 1
    assert "office, chart" in capsys.readouterr().out
    assert conf.main(["--migrer-mcp"]) == 0
    srv = json.loads(p.read_text())["mcpServers"]
    assert srv["elpis-office"]["url"] == "https://outils.lan:9443/mcp/office"
    assert srv["elpis-chart"] == exemple["mcpServers"]["elpis-chart"]
    assert conf.main(["--verifier-familles-mcp"]) == 0


def test_doctor_verifie_les_familles():
    texte = (REPO / "elpis").read_text(encoding="utf-8")
    assert re.search(r'^\s*check "[^"]*" "\./elpis configure" "\$PY" "\$ROOT/deploy/configure\.py" --verifier-familles-mcp$', texte, re.M)
    assert re.search(r'^migrer_mcp\(\) \{ "\$PY" "\$ROOT/deploy/configure\.py" --migrer-mcp', texte, re.M)
