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
    root = tmp_path / "w"
    (root / ".git").mkdir(parents=True)
    (root / ".env").write_text("secret")
    (root / "app.py").write_text("x")
    sub = root / "sub"; sub.mkdir()
    (sub / ".hidden").write_text("h")
    (sub / "main.js").write_text("y")
    return root


def test_tree_hides_dotfiles_by_default(tree_root, monkeypatch):
    from tests.conftest import arbre_editeur
    default = _names(arbre_editeur(monkeypatch, tree_root)["items"])
    assert ".git" not in default and ".env" not in default and ".hidden" not in default
    assert "app.py" in default and "main.js" in default and "sub" in default


def test_tree_include_hidden(tree_root, monkeypatch):
    from tests.conftest import arbre_editeur
    allf = _names(arbre_editeur(monkeypatch, tree_root, include_hidden=True)["items"])
    assert ".git" in allf and ".env" in allf and ".hidden" in allf
