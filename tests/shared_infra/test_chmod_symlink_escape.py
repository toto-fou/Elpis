# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_chmod_symlink_escape.py

``os.chmod`` DÉRÉFÉRENCE les symlinks (Linux n'a pas de ``lchmod``). Tout code
hôte qui élargit les droits d'un chemin issu du contenu de /work doit donc
sauter les liens : sinon l'utilisateur pose ``ln -s <chemin hôte> /work/x`` et
fait élargir par l'app — qui tourne en UID hôte — les droits d'une cible SITUÉE
HORS de la sandbox (confused deputy). C'est une sortie de sandbox : le
conteneur ne franchit pas le mount, mais il fait franchir l'app à sa place.

Pièges couverts (une régression sur l'un d'eux rouvre l'évasion) :

* ``_sandbox_exec._chmod_walk`` — ``os.walk(followlinks=False)`` n'empêche que
  la RÉCURSION : un lien-vers-dossier reste listé dans ``dirnames`` (la
  classification passe par ``entry.is_dir()``, qui déréférence) et le ``chmod``
  déréférence lui aussi. C'était le finding C1 de l'audit 2026-08-01.
* ``fs_tools._chmod_cross_writable`` — appelé sur les enfants d'un ``rglob``
  après ``copytree(symlinks=True)``, donc sur des liens recopiés tels quels.
* ``chart_tools._chmod_cross_writable`` — copie du helper précédent.
* ``git_tools._widen_cross_writable`` — chmode le fichier ET ses PARENTS.
* ``sandbox_snapshots._widen_cross_writable`` — restore d'archive.
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


# ── 1. _chmod_walk (finding C1) ────────────────────────────────────────────

def test_grant_access_ne_chmode_pas_a_travers_un_lien_vers_dossier(tree, monkeypatch):
    """``ln -s <dossier hôte> /work/x`` + action git ⇒ la cible NE doit PAS
    passer en 0777. Sans le filtre ``islink`` sur ``dirnames``, elle le fait."""
    root, outside, outside_file = tree
    os.symlink(outside, root / "x")
    (root / "reel").mkdir()

    import shared_infra.sandbox.exec_bridge as se

    class _FakeSandbox:
        sandbox_path = str(root)
        container_name = "elpis-sb-test"

    monkeypatch.setattr(se, "_get_sandbox_for_user", lambda uid: _FakeSandbox())
    # Neutralise setfacl et docker : on isole le chemin chmod host-side.
    monkeypatch.setattr(se.shutil, "which", lambda name: None)

    asyncio.run(se.sandbox_grant_access(1, ""))

    assert _mode(outside) == OUTSIDE_MODE, (
        "le dossier hôte pointé par le symlink a été chmodé à travers le lien "
        "— sortie de sandbox"
    )
    assert _mode(outside_file) == 0o600, "le fichier hôte a été élargi"
    # Le contenu RÉEL de la sandbox doit, lui, bien être élargi.
    assert _mode(root / "reel") == 0o777


def test_grant_access_ne_chmode_pas_a_travers_un_lien_vers_fichier(tree, monkeypatch):
    root, outside, outside_file = tree
    os.symlink(outside_file, root / "leak")

    import shared_infra.sandbox.exec_bridge as se

    class _FakeSandbox:
        sandbox_path = str(root)
        container_name = "elpis-sb-test"

    monkeypatch.setattr(se, "_get_sandbox_for_user", lambda uid: _FakeSandbox())
    monkeypatch.setattr(se.shutil, "which", lambda name: None)

    asyncio.run(se.sandbox_grant_access(1, ""))

    assert _mode(outside_file) == 0o600


# ── 2. Les helpers « cross-writable » ──────────────────────────────────────

def test_fs_tools_chmod_cross_writable_saute_les_liens(tree):
    root, outside, outside_file = tree
    link = root / "leak"
    os.symlink(outside_file, link)

    from llm_core.tools import fs_tools

    fs_tools._chmod_cross_writable(link, is_dir=False)
    assert _mode(outside_file) == 0o600

    dlink = root / "leakdir"
    os.symlink(outside, dlink)
    fs_tools._chmod_cross_writable(dlink, is_dir=True)
    assert _mode(outside) == OUTSIDE_MODE


def test_chart_tools_chmod_cross_writable_saute_les_liens(tree):
    root, outside, outside_file = tree
    link = root / "leak"
    os.symlink(outside_file, link)

    from llm_core.tools import chart_tools

    chart_tools._chmod_cross_writable(link, is_dir=False)
    assert _mode(outside_file) == 0o600


def test_git_tools_widen_saute_le_fichier_et_les_parents_lies(tree):
    """``_widen_cross_writable`` remonte les PARENTS : un parent symlinké ne
    doit ni être chmodé, ni laisser la remontée continuer au-delà."""
    root, outside, outside_file = tree
    from llm_core.tools import git_tools

    # (a) le chemin lui-même est un lien
    link = root / "leak"
    os.symlink(outside_file, link)
    git_tools._widen_cross_writable(link, root)
    assert _mode(outside_file) == 0o600

    # (b) un PARENT est un lien : outside/sub/f.txt atteint via sandbox/plink
    sub = outside / "sub"
    sub.mkdir()
    target = sub / "f.txt"
    target.write_text("x")
    os.chmod(target, 0o600)
    os.chmod(sub, OUTSIDE_MODE)
    plink = root / "plink"
    os.symlink(outside, plink)
    git_tools._widen_cross_writable(plink / "sub" / "f.txt", root)
    assert _mode(sub) == OUTSIDE_MODE, "un dossier parent hôte a été élargi"
    assert _mode(outside) == OUTSIDE_MODE


def test_snapshot_restore_chmod_saute_les_liens(tree):
    root, outside, outside_file = tree
    link = root / "leak"
    os.symlink(outside_file, link)

    from shared_infra.sandbox import routes_snapshots as snaps

    snaps._widen_cross_writable(link)
    assert _mode(outside_file) == 0o600
