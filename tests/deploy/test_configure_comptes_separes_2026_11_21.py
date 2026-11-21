# SPDX-License-Identifier: MIT
"""tests/deploy/test_configure_comptes_separes_2026_11_21.py — ./elpis configure et comptes séparés : écriture au chemin réel par un temporaire exclusif en gardant propriétaire, groupe et droits ; secret de session dans son fichier, jamais dans config.json ni remplacé s'il est illisible ; --ranger-secrets --sortie."""
from __future__ import annotations

import importlib.util
import json
import os
import stat
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
FORT = "f" * 48


@pytest.fixture
def conf(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_comptes", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "CONFIG", tmp_path / "config.json")
    monkeypatch.setattr(mod, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(mod, "USER_DB", tmp_path / "user_db")
    for nom in ("APP_DB_PATH", "APP_SESSION_SECRET"):
        monkeypatch.delenv(nom, raising=False)
    (tmp_path / "user_db").mkdir()
    return mod


def mode(p: Path) -> int:
    return stat.S_IMODE(os.stat(p).st_mode)


def test_lien_suivi_droits_et_groupe_gardes(conf, tmp_path):
    reel = tmp_path / "etc" / "config.json"
    reel.parent.mkdir()
    reel.write_text("{}", encoding="utf-8")
    os.chmod(reel, 0o640)
    (tmp_path / "config.json").symlink_to(reel)
    conf.write_config({"llm": {"x": 1}})
    assert (tmp_path / "config.json").is_symlink()
    assert json.loads(reel.read_text(encoding="utf-8")) == {"llm": {"x": 1}}
    assert (mode(reel), os.stat(reel).st_gid) == (0o640, os.getgid())
    assert sorted(p.name for p in reel.parent.iterdir()) == ["config.json"]


def test_fichier_neuf_en_0600(conf, tmp_path):
    conf.write_private(tmp_path / "user_db" / ".jeton", "x\n")
    assert mode(tmp_path / "user_db" / ".jeton") == 0o600


def test_secret_de_session_hors_de_config_json(conf, tmp_path):
    cfg = {"app": {"session_secret": ""}}
    conf.step_secrets(cfg, False)
    secret = (tmp_path / "user_db" / ".session_secret").read_text(encoding="utf-8")
    assert secret.startswith("ELPIS_") and len(secret) == 70
    assert mode(tmp_path / "user_db" / ".session_secret") == 0o600
    assert cfg["app"]["session_secret"] == ""
    conf.step_secrets(cfg, False)
    assert (tmp_path / "user_db" / ".session_secret").read_text(encoding="utf-8") == secret


@pytest.mark.parametrize("source", ["env", "fichier-env", "config"])
def test_secret_existant_garde(conf, tmp_path, monkeypatch, source):
    cfg: dict = {"app": {}}
    if source == "env":
        monkeypatch.setenv("APP_SESSION_SECRET", "secret-de-l-environnement")
    elif source == "fichier-env":
        (tmp_path / ".env").write_text("APP_SESSION_SECRET=secret-du-env\n", encoding="utf-8")
    else:
        cfg["app"]["session_secret"] = "secret-propre-a-l-operateur"
    conf.step_secrets(cfg, False)
    assert not (tmp_path / "user_db" / ".session_secret").exists()


def test_valeur_d_exemple_ou_fichier_trop_court_remplaces(conf, tmp_path):
    (tmp_path / "user_db" / ".session_secret").write_text("court", encoding="utf-8")
    conf.step_secrets({"app": {"session_secret": " ChangeMe "}}, False)
    assert len((tmp_path / "user_db" / ".session_secret").read_text(encoding="utf-8")) == 70


def test_base_deplacee_secret_pres_de_la_base(conf, tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "ailleurs" / "app.db"))
    conf.step_secrets({}, False)
    assert (tmp_path / "ailleurs" / ".session_secret").is_file()


def test_temporaire_exclusif_jamais_suivi(conf, tmp_path):
    cible = tmp_path / "user_db" / ".session_secret"
    ailleurs = tmp_path / "ailleurs"
    ailleurs.write_text("intact", encoding="utf-8")
    (cible.parent / f".session_secret.tmp{os.getpid()}").symlink_to(ailleurs)
    conf.write_private(cible, "secret\n")
    assert (cible.read_text(encoding="utf-8"), ailleurs.read_text(encoding="utf-8")) == ("secret\n", "intact")
    assert sorted(p.name for p in cible.parent.iterdir()) == [".session_secret", f".session_secret.tmp{os.getpid()}"]


def test_groupe_non_repris_droits_au_proprietaire(conf, tmp_path, monkeypatch):
    fichier = tmp_path / "user_db" / ".jeton"
    fichier.write_text("x", encoding="utf-8")
    os.chmod(fichier, 0o640)

    def refus(*_):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(conf.os, "fchown", refus)
    conf.write_private(fichier, "y")
    assert mode(fichier) == 0o600


@pytest.mark.skipif(os.geteuid() == 0, reason="root lit un fichier 0000")
def test_secret_illisible_jamais_remplace(conf, tmp_path):
    fichier = tmp_path / "user_db" / ".session_secret"
    fichier.write_text("s" * 64, encoding="utf-8")
    os.chmod(fichier, 0)
    try:
        conf.step_secrets({}, False)
        assert mode(fichier) == 0
    finally:
        os.chmod(fichier, 0o600)
    assert fichier.read_text(encoding="utf-8") == "s" * 64


def ranger(conf, *options):
    lu, ecrit = os.pipe()
    try:
        code = conf.main(["--ranger-secrets", "--sortie", str(ecrit), *options])
    finally:
        os.close(ecrit)
    with os.fdopen(lu, encoding="ascii") as fh:
        return code, fh.read()


def test_ranger_secrets(conf, tmp_path, capfd):
    cle = "cle-de-chiffrement-heritee-0123456789"
    jeton = "jeton-du-rag-0123456789"
    (tmp_path / "config.json").write_text(json.dumps({
        "app": {"session_secret": FORT, "encryption_key": f" {cle} ", "name": "x"},
        "rag": {"service_token": jeton, "service_url": "http://127.0.0.1:8000"},
    }), encoding="utf-8")
    os.chmod(tmp_path / "config.json", 0o640)
    bak = tmp_path / "config.json.bak"
    bak.write_text(json.dumps({"app": {"session_secret": "ancien-" + "a" * 40, "name": "x"}}), encoding="utf-8")
    os.chmod(bak, 0o640)
    avant = sorted(p.name for p in tmp_path.rglob("*"))
    code, sortie = ranger(conf)
    assert code == 0
    assert json.loads(sortie) == {"app.session_secret": FORT, "app.encryption_key": cle, "rag.service_token": jeton}
    vu = capfd.readouterr()
    for valeur in (FORT, cle, jeton, "ancien-"):
        assert valeur not in vu.out + vu.err
    cfg = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert cfg == {"app": {"name": "x"}, "rag": {"service_url": "http://127.0.0.1:8000"}}
    assert json.loads(bak.read_text(encoding="utf-8")) == {"app": {"name": "x"}}
    assert (mode(tmp_path / "config.json"), mode(bak)) == (0o640, 0o600)
    assert sorted(p.name for p in tmp_path.rglob("*")) == avant
    texte = (tmp_path / "config.json").read_text(encoding="utf-8")
    assert ranger(conf) == (0, "{}\n")
    assert (tmp_path / "config.json").read_text(encoding="utf-8") == texte


def test_ranger_secrets_sortie_standard(conf, tmp_path, capfd):
    (tmp_path / "config.json").write_text(json.dumps({"rag": {"service_token": "jeton-0123456789"}}), encoding="utf-8")
    assert conf.main(["--ranger-secrets", "--sortie", "-"]) == 0
    assert json.loads(capfd.readouterr().out) == {"rag.service_token": "jeton-0123456789"}


def test_ranger_secrets_refus(conf, tmp_path, monkeypatch, capfd):
    (tmp_path / "config.json").write_text(json.dumps({"app": {"session_secret": FORT}}), encoding="utf-8")
    assert conf.main(["--ranger-secrets"]) == 2
    assert conf.main(["--ranger-secrets", "--sortie", "x"]) == 2
    maitre, terminal = os.openpty()
    try:
        assert conf.main(["--ranger-secrets", "--sortie", str(terminal)]) == 2
    finally:
        os.close(maitre)
        os.close(terminal)
    monkeypatch.setattr(conf.os, "geteuid", lambda: os.getuid() + 1)
    assert ranger(conf) == (2, "")
    assert FORT not in "".join(capfd.readouterr())
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8")) == {"app": {"session_secret": FORT}}


def test_ranger_secrets_cas_limites(conf, tmp_path, capfd):
    assert ranger(conf) == (0, "{}\n")
    (tmp_path / "config.json").write_text(json.dumps({
        "app": {"session_secret": "court-mais-a-moi", "encryption_key": 42},
        "rag": {"service_token": ""},
    }), encoding="utf-8")
    assert ranger(conf) == (0, "{}\n")
    assert "court-mais-a-moi" not in "".join(capfd.readouterr())
    cfg = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert cfg == {"app": {"session_secret": "court-mais-a-moi", "encryption_key": 42}, "rag": {}}
    (tmp_path / "config.json").write_text('{"app": {"session_secret": "changeme"}}', encoding="utf-8")
    assert ranger(conf) == (0, "{}\n")
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8")) == {"app": {}}
    (tmp_path / "config.json").write_text("{ pas du json", encoding="utf-8")
    assert ranger(conf) == (1, "")
    assert sorted(p.name for p in (tmp_path / "user_db").iterdir()) == []
