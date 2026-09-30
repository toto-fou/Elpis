# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_chmod_symlink_escape.py

``os.chmod`` DÉRÉFÉRENCE les symlinks (Linux n'a pas de ``lchmod``). Tout code
hôte qui élargit les droits d'un chemin issu du contenu de /work doit donc
sauter les liens : sinon l'utilisateur pose ``ln -s <chemin hôte> /work/x`` et
fait élargir par l'app — qui tourne en UID hôte — les droits d'une cible SITUÉE
HORS de la sandbox (confused deputy). C'est une sortie de sandbox : le
conteneur ne franchit pas le mount, mais il fait franchir l'app à sa place.

Pièges couverts (une régression sur l'un d'eux rouvre l'évasion) ; depuis
L4.6, l'hôte ne change plus aucun droit dans /work :

* ``manage_files chmod`` (par l'agent, L4.2) — un lien qui sort de /work
  est refusé.
* ``chart_tools._chmod_cross_writable`` — cache des graphiques (hors /work).
"""
from __future__ import annotations

import asyncio
import os
import stat

import pytest

OUTSIDE_MODE = 0o700


@pytest.fixture()
def tree(tmp_path):
    """sandbox/ = /work ; outside/ = arborescence HÔTE hors sandbox.

    Retourne (sandbox_root, outside_dir, outside_file).
    """
    root = tmp_path / "sandbox"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    outside_file = outside / "secret.txt"
    outside_file.write_text("TOP-SECRET-HOST-CONTENT")
    os.chmod(outside, OUTSIDE_MODE)
    os.chmod(outside_file, 0o600)
    return root, outside, outside_file


def _mode(p) -> int:
    return stat.S_IMODE(os.stat(p).st_mode)


def test_manage_files_chmod_refuse_un_lien_sortant(tmp_path, monkeypatch):
    from llm_core.tools import fs_tools

    class _MCP:
        tools: dict = {}

        def tool(self, **kw):
            def deco(fn):
                self.tools[fn.__name__] = fn
                return fn
            return deco
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.txt"
    secret.write_text("x")
    os.chmod(outside, OUTSIDE_MODE)
    os.chmod(secret, 0o600)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _MCP()
    fs_tools.register(mcp, base)
    os.symlink(secret, work / "leak")
    os.symlink(outside, work / "leakdir")
    for rel in ("leak", "leakdir"):
        r = mcp.tools["manage_files"](None, action="chmod", path=rel)
        assert r["ok"] is False, r
    assert _mode(secret) == 0o600
    assert _mode(outside) == OUTSIDE_MODE


def test_chart_tools_chmod_cross_writable_saute_les_liens(tree):
    root, outside, outside_file = tree
    link = root / "leak"
    os.symlink(outside_file, link)

    from llm_core.tools import chart_tools

    chart_tools._chmod_cross_writable(link, is_dir=False)
    assert _mode(outside_file) == 0o600
