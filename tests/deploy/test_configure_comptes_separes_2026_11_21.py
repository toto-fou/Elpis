# SPDX-License-Identifier: MIT
"""tests/deploy/test_configure_comptes_separes_2026_11_21.py — ./elpis configure et comptes séparés : écriture au chemin réel en gardant propriétaire, groupe et droits."""
from __future__ import annotations

import importlib.util
import json
import os
import stat
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


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
