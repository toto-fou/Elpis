# SPDX-License-Identifier: MIT
"""tests/deploy/test_configure_comptes_separes_2026_11_21.py — ./elpis configure et comptes séparés : écriture au chemin réel en gardant propriétaire, groupe et droits ; secret de session dans son fichier, jamais dans config.json ; --ranger-secrets."""
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


def test_ranger_secrets(conf, tmp_path, capsys):
    cle = "cle-de-chiffrement-heritee-0123456789"
    jeton = "jeton-du-rag-0123456789"
    (tmp_path / "config.json").write_text(json.dumps({
        "app": {"session_secret": FORT, "encryption_key": f" {cle} ", "name": "x"},
        "rag": {"service_token": jeton, "service_url": "http://127.0.0.1:8000"},
    }), encoding="utf-8")
    os.chmod(tmp_path / "config.json", 0o640)
    (tmp_path / "user_db" / ".session_secret").write_text("ancien-secret-different-" + "a" * 30, encoding="utf-8")
    fichier_jeton = tmp_path / "etc" / "rag.token"
    assert conf.main(["--ranger-secrets", "--fichier-jeton-rag", str(fichier_jeton)]) == 0
    sortie = capsys.readouterr()
    for valeur in (FORT, cle, jeton):
        assert valeur not in sortie.out + sortie.err
    assert (tmp_path / "user_db" / ".session_secret").read_text(encoding="utf-8").strip() == FORT
    assert (tmp_path / "user_db" / ".encryption_key").read_text(encoding="utf-8") == cle + "\n"
    assert fichier_jeton.read_text(encoding="utf-8") == jeton + "\n"
    assert mode(fichier_jeton) == 0o600
    cfg = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert cfg == {"app": {"name": "x"}, "rag": {"service_url": "http://127.0.0.1:8000"}}
    assert mode(tmp_path / "config.json") == 0o640
    avant = (tmp_path / "config.json").read_text(encoding="utf-8")
    assert conf.main(["--ranger-secrets", "--fichier-jeton-rag", str(fichier_jeton)]) == 0
    assert (tmp_path / "config.json").read_text(encoding="utf-8") == avant


def test_ranger_secrets_cas_limites(conf, tmp_path, capsys):
    assert conf.main(["--ranger-secrets"]) == 0
    (tmp_path / "config.json").write_text(json.dumps({
        "app": {"session_secret": "court-mais-a-moi", "encryption_key": 42},
        "rag": {"service_token": ""},
    }), encoding="utf-8")
    assert conf.main(["--ranger-secrets"]) == 0
    assert "court-mais-a-moi" not in capsys.readouterr().out
    cfg = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert cfg == {"app": {"session_secret": "court-mais-a-moi", "encryption_key": 42}, "rag": {}}
    assert not (tmp_path / "user_db" / ".rag_service_token").exists()
    (tmp_path / "config.json").write_text('{"app": {"session_secret": "changeme"}}', encoding="utf-8")
    assert conf.main(["--ranger-secrets"]) == 0
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8")) == {"app": {}}
    assert not (tmp_path / "user_db" / ".session_secret").exists()
    (tmp_path / "config.json").write_text("{ pas du json", encoding="utf-8")
    assert conf.main(["--ranger-secrets"]) == 1
