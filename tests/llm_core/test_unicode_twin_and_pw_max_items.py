# SPDX-License-Identifier: MIT
"""Régressions audit 2026-07-26 — doublons unicode (fs) + pagination pw_*.

- ``unicode_twin_warning`` : un nom ne différant que par accents/casse d'un
  frère existant est signalé à la CRÉATION (write_file/mkdir/copy/move),
  jamais bloquant, et pas re-signalé sur les écritures suivantes.
- ``pw_act``/``pw_find`` exposent ``max_items`` (le ``page_after`` d'un simple
  click renvoyait ~25 éléments sans aucun moyen de le borner, contrairement à
  ``pw_page``).
"""
from __future__ import annotations

import inspect

import pytest

import llm_core.tools.fs_tools as fs_tools
import llm_core.tools.firefox_tools as ff
from llm_core.tools._toolkit import unicode_twin_warning


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def fs(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    mcp = _FakeMCP()
    fs_tools.register(mcp, tmp_path)
    work = tmp_path / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    return mcp.tools, work


# ── helper ───────────────────────────────────────────────────────────────

def test_twin_helper_accent_and_case(tmp_path):
    (tmp_path / "projet-devinette").mkdir()
    assert unicode_twin_warning(tmp_path / "projét-devinette", tmp_path)
    assert unicode_twin_warning(tmp_path / "PROJET-DEVINETTE", tmp_path)
    assert unicode_twin_warning(tmp_path / "autre", tmp_path) is None
    # Chemin existant (aucun composant nouveau) → silence.
    assert unicode_twin_warning(tmp_path / "projet-devinette", tmp_path) is None


# ── write_file / manage_files ────────────────────────────────────────────

def test_write_file_warns_on_twin_dir_creation(fs):
    tools, work = fs
    (work / "projet-devinette").mkdir()
    r = tools["write_file"](None, path="projét-devinette/jeu.py", content="x=1\n")
    assert r.get("ok"), r
    assert "projet-devinette" in (r.get("warning") or "")
    # Ré-écrire dans le dossier désormais existant ne re-signale pas.
    r2 = tools["write_file"](None, path="projét-devinette/jeu2.py", content="y=2\n")
    assert r2.get("ok") and "warning" not in r2


def test_mkdir_and_move_warn_on_twin(fs):
    tools, work = fs
    (work / "notes").mkdir()
    r = tools["manage_files"](None, action="mkdir", path="Notés")
    assert r.get("ok"), r
    assert "notes" in (r.get("warning") or "")

    (work / "src.txt").write_text("data")
    r2 = tools["manage_files"](None, action="move", path="src.txt", dest="SRC.TXT")
    assert r2.get("ok"), r2
    assert "src.txt" in (r2.get("warning") or "")


def test_write_file_no_warning_on_plain_paths(fs):
    tools, _ = fs
    r = tools["write_file"](None, path="unique/normal.txt", content="ok")
    assert r.get("ok") and "warning" not in r


# ── pw_act / pw_find : max_items ─────────────────────────────────────────

def test_pw_tools_expose_max_items():
    mcp = _FakeMCP()
    ff.register(mcp)
    act_params = inspect.signature(mcp.tools["act"]).parameters
    find_params = inspect.signature(mcp.tools["find"]).parameters
    assert "max_items" in act_params
    assert act_params["max_items"].default == 25
    assert "max_items" in find_params


def test_finish_act_forwards_max_items(monkeypatch):
    seen = {}

    def fake_req(method, path, params=None, **kw):
        seen.update(params or {})
        return {"elements": []}

    monkeypatch.setattr(ff, "_req", fake_req)
    out = ff._finish_act({"status": "success"}, "sid", True, max_items=7)
    assert seen["max_items"] == 7
    assert "page_after" in out
    # Clamp : hors bornes → ramené dans [1, 200].
    seen.clear()
    ff._finish_act({"status": "success"}, "sid", True, max_items=9999)
    assert seen["max_items"] == 200


def test_clamp_items_bounds():
    assert ff._clamp_items(0) == 1
    assert ff._clamp_items(-5) == 1
    assert ff._clamp_items(50) == 50
    assert ff._clamp_items("bad") == 25
