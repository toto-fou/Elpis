# SPDX-License-Identifier: MIT
"""tests/deploy/test_configure_auth_2026_11_19.py — ./elpis configure : la section auth est relue juste avant l'écriture et gardée telle quelle ; avec --force, elle est reprise avec tous les fournisseurs éteints et le mot de passe local ouvert à tous."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

AUTH = {
    "public_url": "https://elpis.exemple.lan",
    "local": {"mode": "admins"},
    "providers": [{"id": "annuaire", "enabled": True}, {"id": "sso", "enabled": False}, "bizarre"],
}


@pytest.fixture
def conf(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_auth", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "CONFIG", tmp_path / "config.json")
    return mod


def ecrit(tmp_path):
    return json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))


def test_auth_relue_telle_quelle_avant_ecriture(conf, tmp_path):
    # Copie lue au départ : fournisseur allumé ; sur le disque, éteint entre-temps.
    cfg = {"llm": {"x": 1}, "auth": json.loads(json.dumps(AUTH))}
    eteinte = json.loads(json.dumps(AUTH))
    eteinte["providers"][0]["enabled"] = False
    (tmp_path / "config.json").write_text(json.dumps({"auth": eteinte}), encoding="utf-8")
    conf.write_config(cfg)
    assert ecrit(tmp_path)["auth"] == eteinte
    assert ecrit(tmp_path)["llm"] == {"x": 1}


def test_sans_auth_sur_le_disque_aucune_copie_perimee(conf, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"llm": {}}), encoding="utf-8")
    conf.write_config({"auth": json.loads(json.dumps(AUTH))})
    assert "auth" not in ecrit(tmp_path)


def test_force_reprend_auth_eteinte(conf, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"auth": AUTH}), encoding="utf-8")
    conf.write_config({"llm": {}}, True)
    auth = ecrit(tmp_path)["auth"]
    assert auth["local"]["mode"] == "all"
    assert auth["public_url"] == AUTH["public_url"]
    assert auth["providers"] == [{"id": "annuaire", "enabled": False}, {"id": "sso", "enabled": False}, "bizarre"]
    assert AUTH["providers"][0]["enabled"] is True  # la copie lue n'est pas modifiée


def test_ecritures_suivantes_gardent_ce_que_la_console_a_fait(conf, tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"auth": AUTH}), encoding="utf-8")
    conf.write_config({}, True)
    rallume = ecrit(tmp_path)
    rallume["auth"]["providers"][1]["enabled"] = True
    (tmp_path / "config.json").write_text(json.dumps(rallume), encoding="utf-8")
    conf.write_config({})
    assert ecrit(tmp_path)["auth"]["providers"][1]["enabled"] is True
