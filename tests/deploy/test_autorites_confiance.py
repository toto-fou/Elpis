# SPDX-License-Identifier: MIT
"""tests/deploy/test_autorites_confiance.py — l'assistant pose SSL_CERT_FILE dans .env (PKI interne) pour le core et les services."""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PEM = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n"


@pytest.fixture
def conf(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_ca", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ENV_FILE", tmp_path / ".env")
    monkeypatch.delenv("ELPIS_CFG_CA_FILE", raising=False)
    systeme = tmp_path / "ca-certificates.crt"
    systeme.write_text(PEM, encoding="utf-8")
    monkeypatch.setattr(mod, "SYSTEM_CA_FILES", (str(tmp_path / "absent.crt"), str(systeme)))
    mod._systeme = str(systeme)
    return mod


def _ca(conf, valeur=None):
    conf.step_ca(argparse.Namespace(ca_file=valeur), conf.read_env_file())
    return conf.read_env_file()


def test_par_defaut_le_magasin_du_systeme(conf):
    assert _ca(conf)["SSL_CERT_FILE"] == conf._systeme
    assert _ca(conf)["SSL_CERT_FILE"] == conf._systeme


def test_un_reglage_existant_est_garde(conf):
    conf.update_env_file({"SSL_CERT_DIR": "/etc/pki/interne"})
    env = _ca(conf)
    assert env["SSL_CERT_DIR"] == "/etc/pki/interne" and "SSL_CERT_FILE" not in env
    conf.update_env_file({"SSL_CERT_DIR": None, "SSL_CERT_FILE": "/etc/elpis/ca.pem"})
    assert _ca(conf)["SSL_CERT_FILE"] == "/etc/elpis/ca.pem"


def test_pem_fourni_ou_refuse(conf, tmp_path, capsys):
    bon = tmp_path / "interne.pem"
    bon.write_text(PEM, encoding="utf-8")
    assert _ca(conf, str(bon))["SSL_CERT_FILE"] == str(bon.resolve())
    mauvais = tmp_path / "vide.pem"
    mauvais.write_text("rien", encoding="utf-8")
    assert _ca(conf, str(mauvais))["SSL_CERT_FILE"] == str(bon.resolve())
    assert "aucun certificat PEM" in capsys.readouterr().err
    assert _ca(conf, str(tmp_path / "absent.pem"))["SSL_CERT_FILE"] == str(bon.resolve())
    espace = tmp_path / "CA interne.pem"
    espace.write_text(PEM, encoding="utf-8")
    assert _ca(conf, str(espace))["SSL_CERT_FILE"] == str(bon.resolve())
    assert "illisible dans .env" in capsys.readouterr().err


def test_aucun_retire_le_reglage_et_variable_d_environnement(conf, monkeypatch):
    _ca(conf)
    conf.update_env_file({"SSL_CERT_DIR": "/etc/pki/interne"})
    env = _ca(conf, "aucun")
    assert "SSL_CERT_FILE" not in env and "SSL_CERT_DIR" not in env
    monkeypatch.setenv("ELPIS_CFG_CA_FILE", "systeme")
    assert _ca(conf)["SSL_CERT_FILE"] == conf._systeme


def test_magasin_du_systeme_introuvable(conf, monkeypatch, capsys):
    monkeypatch.setattr(conf, "SYSTEM_CA_FILES", ("/nulle/part.crt",))
    assert "SSL_CERT_FILE" not in _ca(conf)
    assert "introuvable" in capsys.readouterr().err


def test_option_documentee(conf):
    aide = conf.build_parser().format_help()
    assert "--ca-file" in aide and "SSL_CERT_FILE" in aide
