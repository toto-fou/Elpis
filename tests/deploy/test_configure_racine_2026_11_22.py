# SPDX-License-Identifier: MIT
"""tests/deploy/test_configure_racine_2026_11_22.py — « sudo ./elpis configure » : sous root, configure.py et wizard.py ne suivent aucun lien ni chemin de config.json ; un compte par service, sous le compte de la console ; chaque attaque des relectures rejouée, rien ne se passe."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import MOI, TALONS, _harnais, _mode, _sys, _unite

depot = _cs.depot

REPO = Path(__file__).resolve().parents[2]


# B3 — configure.py et wizard.py sous root : aucun lien suivi, aucun chemin pris à config.json, réponses hors de user_db.
@pytest.fixture
def conf_racine(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_racine", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for nom, val in (("ROOT", tmp_path), ("CONFIG", tmp_path / "config.json"), ("ENV_FILE", tmp_path / ".env"),
                     ("USER_DB", tmp_path / "user_db"), ("DB_PASSWORD_FILE", tmp_path / "user_db/.db_password")):
        monkeypatch.setattr(mod, nom, val)
    for nom in ("APP_DB_PATH", "APP_SESSION_SECRET"):
        monkeypatch.delenv(nom, raising=False)
    monkeypatch.setenv("ELPIS_PREFIXE_SYSTEME", str(tmp_path / "sys"))
    monkeypatch.setattr(mod.os, "geteuid", lambda: 0)
    (tmp_path / "user_db").mkdir()
    return mod


def test_b3_configure_sous_root_ne_suit_aucun_lien(conf_racine, tmp_path):
    victime = tmp_path / "victime"
    victime.mkdir()
    (victime / "zz").write_text("intact", encoding="utf-8")
    db = tmp_path / "user_db"
    for nom in (".local_mcp_token", ".rag_service_token"):
        (db / nom).symlink_to(victime / "zz")
    ailleurs = tmp_path / "ailleurs"
    ailleurs.mkdir()
    (ailleurs / ".session_secret").symlink_to(victime / "cree")
    cfg = {"app": {"db_path": str(ailleurs / "app.db")}}
    with pytest.raises(PermissionError):
        conf_racine.step_secrets(cfg, False)
    assert (victime / "zz").read_text(encoding="utf-8") == "intact" and not (victime / "cree").exists()
    assert (db / ".session_secret").is_file() and not (ailleurs / ".session_secret").resolve().exists()
    # config.json remplacé par un lien vers un fichier de root : ni lu ni écrit au travers.
    (tmp_path / "config.json").symlink_to(victime / "zz")
    assert conf_racine.read_config_strict(conf_racine.CONFIG) is None
    with pytest.raises(PermissionError):
        conf_racine.write_config({"llm": {}})
    assert (victime / "zz").read_text(encoding="utf-8") == "intact"
    # Seul lien admis : celui de « service install » vers /etc/elpis/config, écrit par le descripteur de ce dossier.
    conf_sys = tmp_path / "sys/etc/elpis/config"
    conf_sys.mkdir(parents=True)
    (tmp_path / "config.json").unlink()
    (tmp_path / "config.json").symlink_to(conf_sys / "config.json")
    conf_racine.write_config({"llm": {"x": 1}})
    assert json.loads((conf_sys / "config.json").read_text(encoding="utf-8")) == {"llm": {"x": 1}}
    (conf_sys / "config.json").unlink()
    (conf_sys / "config.json").symlink_to(victime / "zz")
    with pytest.raises(PermissionError):
        conf_racine.write_config({"llm": {"x": 2}})
    assert (victime / "zz").read_text(encoding="utf-8") == "intact"


def test_b3_mot_de_passe_de_la_base_jamais_lu_au_travers_d_un_lien(conf_racine, tmp_path):
    secret = tmp_path / "shadow"
    secret.write_text("root:$6$hash", encoding="utf-8")
    (tmp_path / "user_db/.db_password").symlink_to(secret)
    assert conf_racine.read_secret(conf_racine.DB_PASSWORD_FILE) == ""


@pytest.mark.skipif(shutil.which("script") is None, reason="script (util-linux) absent : pas de terminal factice")
def test_b3_assistant_sous_root_reponses_hors_de_user_db(depot):
    victime = depot.parent / "victime-run"
    victime.mkdir()
    victime.chmod(0o755)
    shutil.rmtree(depot / "user_db/run")
    (depot / "user_db/run").symlink_to(victime)
    (depot / "user_db").chmod(0o2771)
    vu = depot.parent / "vu"
    (depot / "deploy/wizard.py").write_text(
        f'import pathlib, sys\np = pathlib.Path(sys.argv[sys.argv.index("--out") + 1])\n'
        f'pathlib.Path("{vu}").write_text(str(p))\np.write_text("{{}}")\n', encoding="utf-8")
    (depot / "deploy/configure.py").write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
    texte = (depot / "elpis").read_text(encoding="utf-8")
    h = depot / "harnais-tty"
    h.write_text(texte[:texte.rindex('\ncase "${1:-}" in\n')] + "\n" + TALONS + "\ncmd_configure\n", encoding="utf-8")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8", "MOI": MOI,
           "ELPIS_PREFIXE_SYSTEME": str(_sys(depot))}
    r = subprocess.run(["script", "-qec", f"bash {h}", "/dev/null"], env=env, capture_output=True, text=True,
                       timeout=60, stdin=subprocess.DEVNULL)
    reponses = vu.read_text(encoding="utf-8")
    assert not reponses.startswith(str(depot)) and not Path(reponses).parent.exists(), r.stdout
    assert _mode(depot / "user_db") == "2771" and _mode(victime) == "755" and list(victime.iterdir()) == []


def test_b3_configure_sous_root_un_compte_par_service_par_la_console(depot):
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    reponses = depot.parent / "reponses.json"
    reponses.write_text('{"configure": {"argv": ["--yes"]}}', encoding="utf-8")
    reponses.chmod(0o600)
    talons = TALONS + 'app_console() { echo "console $* <$(cat)"; }\n'
    r = _harnais(depot, f'cmd_configure --answers "{reponses}" --yes', talons)
    assert r.stdout.strip() == f'console bash {depot}/elpis configure --answers - --yes <{reponses.read_text()}', r.stderr
    r = _harnais(depot, 'cmd_configure --llm-url http://x', talons)
    assert r.stdout.startswith(f"console bash {depot}/elpis configure --llm-url http://x"), r.stdout + r.stderr


def test_b3_configure_sans_sudo_refuse_quand_config_est_a_la_console(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_console", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    conf = tmp_path / "etc"
    conf.mkdir()
    (conf / "config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "config.json").symlink_to(conf / "config.json")
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "CONFIG", tmp_path / "config.json")
    conf.chmod(0o550)
    try:
        assert mod.main(["--yes"]) == 2
    finally:
        conf.chmod(0o750)


def test_b3_base_sqlite_jamais_ouverte_par_root_au_travers_d_un_lien(conf_racine, tmp_path, monkeypatch):
    import sqlite3
    monkeypatch.syspath_prepend(str(REPO / "deploy"))
    wiz = importlib.import_module("wizard")
    autre = tmp_path / "autre.db"
    c = sqlite3.connect(str(autre))
    c.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, is_admin INTEGER)")
    c.execute("INSERT INTO users(username, is_admin) VALUES ('intrus', 1)")
    c.commit()
    c.close()
    base = tmp_path / "user_db/app.db"
    base.symlink_to(autre)
    assert conf_racine._sqlite_has_data(base) is False and wiz._sqlite_admins(base) is None
    # Fichier ordinaire du propriétaire du dépôt : lu comme avant.
    base.unlink()
    shutil.copy2(autre, base)
    assert wiz._sqlite_admins(base) == ["intrus"] and conf_racine._sqlite_has_data(base) is True


def test_b3_installeur_teste_la_base_par_elpis_configure():
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    corps = texte[texte.index("db_check() {"):]
    corps = corps[:corps.index("\n}\n")]
    assert corps.count('bash "$ROOT/elpis" configure') == 2 and "deploy/configure.py" not in corps
