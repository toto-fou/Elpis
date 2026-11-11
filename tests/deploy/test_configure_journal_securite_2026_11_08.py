# SPDX-License-Identifier: MIT
"""tests/deploy/test_configure_journal_securite_2026_11_08.py — ./elpis configure : config.json illisible jamais réécrit, conservation du journal de sécurité relue juste avant l'écriture."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def conf(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_journal", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "CONFIG", tmp_path / "config.json")
    return mod


@pytest.mark.parametrize("texte", ["", "{ pas du json", "[]", '"x"'])
def test_lecture_stricte(conf, tmp_path, texte):
    (tmp_path / "config.json").write_text(texte, encoding="utf-8")
    assert conf.read_config_strict(tmp_path / "config.json") is None


def test_section_du_journal_relue_avant_ecriture(conf, tmp_path):
    cfg = {"security": {"audit": {"retention_days": 365}}, "llm": {"x": 1}}
    (tmp_path / "config.json").write_text(
        json.dumps({"security": {"audit": {"retention_days": 1095, "hold": True, "hold_reason": "Enquête"}}}),
        encoding="utf-8",
    )
    conf.write_config(cfg)
    ecrit = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert ecrit["security"]["audit"] == {"retention_days": 1095, "hold": True, "hold_reason": "Enquête"}
    assert ecrit["llm"] == {"x": 1}


def test_config_illisible_rien_reecrit(conf, tmp_path, capsys):
    (tmp_path / "config.json").write_text('{ "security": { "audit": { "retention_days": 1095 }, } }', encoding="utf-8")
    avant = (tmp_path / "config.json").read_text(encoding="utf-8")
    assert conf.main(["--yes"]) == 1
    assert (tmp_path / "config.json").read_text(encoding="utf-8") == avant
    assert "config.json est illisible" in capsys.readouterr().err
