# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_sandbox_tree_hidden.py — dotfiles masqués de l'arbre.

L'explorateur de fichiers du sandbox masque par défaut les entrées cachées
(``.git``, ``.env``…). Elles restent accessibles via le terminal et ré-incluables
avec ``?include_hidden=1`` (toggle « Afficher les fichiers cachés »).
"""
from __future__ import annotations

import pytest


def _names(items):
    out = []
    for it in items:
        out.append(it["name"])
        out += _names(it.get("children") or [])
    return out


@pytest.fixture()
def tree_root(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".env").write_text("secret")
    (tmp_path / "app.py").write_text("x")
    sub = tmp_path / "sub"; sub.mkdir()
    (sub / ".hidden").write_text("h")
    (sub / "main.js").write_text("y")
    return tmp_path


def test_build_file_tree_hides_dotfiles_by_default(tree_root):
    from shared_infra.routes._helpers import _build_file_tree
    default = _names(_build_file_tree(tree_root, tree_root))
    assert ".git" not in default and ".env" not in default and ".hidden" not in default
    assert "app.py" in default and "main.js" in default and "sub" in default


def test_build_file_tree_include_hidden(tree_root):
    from shared_infra.routes._helpers import _build_file_tree
    allf = _names(_build_file_tree(tree_root, tree_root, include_hidden=True))
    assert ".git" in allf and ".env" in allf and ".hidden" in allf


def test_tree_route_default_and_include_hidden(tree_root, monkeypatch):
    import shared_infra.sandbox.routes_files as sf
    monkeypatch.setattr(sf, "require_user_id", lambda r: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: tree_root)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI(); app.include_router(sf.router)
    c = TestClient(app)

    default = _names(c.get("/api/sandbox/tree").json()["items"])
    assert ".git" not in default and ".env" not in default and "app.py" in default

    allf = _names(c.get("/api/sandbox/tree?include_hidden=true").json()["items"])
    assert ".git" in allf and ".env" in allf
