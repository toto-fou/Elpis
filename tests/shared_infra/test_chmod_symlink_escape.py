# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_chmod_symlink_escape.py

``os.chmod`` DÉRÉFÉRENCE les symlinks (Linux n'a pas de ``lchmod``). Tout code
hôte qui élargit les droits d'un chemin issu du contenu de /work doit donc
sauter les liens : sinon l'utilisateur pose ``ln -s <chemin hôte> /work/x`` et
fait élargir par l'app — qui tourne en UID hôte — les droits d'une cible SITUÉE
HORS de la sandbox (confused deputy). C'est une sortie de sandbox : le
conteneur ne franchit pas le mount, mais il fait franchir l'app à sa place.

Pièges couverts (une régression sur l'un d'eux rouvre l'évasion) :

* le grant (``exec_bridge``) — ``os.walk(followlinks=False)`` n'empêche que la
  RÉCURSION : un lien-vers-dossier reste listé dans ``dirnames`` et le
  ``chmod`` déréférence. C'était le finding C1 de l'audit 2026-08-01.
* ``fs_tools._chmod_cross_writable`` — après une copie ou un déplacement.
* ``chart_tools._chmod_cross_writable`` — cache des graphiques (hors /work).
* ``paths.widen_beneath`` (2026-09-29) — la primitive commune : entrée saisie
  par ``O_PATH | O_NOFOLLOW``, plus de fenêtre entre le contrôle et le chmod ;
  y compris un dossier remplacé par un lien PENDANT le parcours.
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

def test_fs_tools_chmod_cross_writable_saute_les_liens(tree, monkeypatch):
    root, outside, outside_file = tree
    from llm_core.tools import fs_tools
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: False)

    os.symlink(outside_file, root / "leak")
    fs_tools._chmod_cross_writable(root, root / "leak")
    assert _mode(outside_file) == 0o600

    os.symlink(outside, root / "leakdir")
    fs_tools._chmod_cross_writable(root, root / "leakdir", recursive=True)
    assert _mode(outside) == OUTSIDE_MODE


def test_chart_tools_chmod_cross_writable_saute_les_liens(tree):
    root, outside, outside_file = tree
    link = root / "leak"
    os.symlink(outside_file, link)

    from llm_core.tools import chart_tools

    chart_tools._chmod_cross_writable(link, is_dir=False)
    assert _mode(outside_file) == 0o600


def test_widen_beneath_saute_liens_et_parents_lies(tree):
    """Ni le lien lui-même, ni un chemin qui TRAVERSE un lien (parent lié)."""
    root, outside, outside_file = tree
    from shared_infra.sandbox.paths import widen_beneath

    os.symlink(outside_file, root / "leak")
    widen_beneath(root, "leak")
    assert _mode(outside_file) == 0o600

    sub = outside / "sub"
    sub.mkdir()
    (sub / "f.txt").write_text("x")
    os.chmod(sub / "f.txt", 0o600)
    os.chmod(sub, OUTSIDE_MODE)
    os.symlink(outside, root / "plink")
    widen_beneath(root, "plink/sub/f.txt")
    widen_beneath(root, "plink", recursive=True)
    assert _mode(sub) == OUTSIDE_MODE, "un dossier parent hôte a été élargi"
    assert _mode(sub / "f.txt") == 0o600
    assert _mode(outside) == OUTSIDE_MODE


def test_widen_beneath_dossier_remplace_par_un_lien_pendant_le_parcours(tree, monkeypatch):
    """Course : ``d`` est un vrai dossier quand le parcours le liste, puis un
    lien vers l'hôte quand il y descend. Rien de l'hôte n'est élargi."""
    root, outside, outside_file = tree
    from shared_infra.sandbox import paths
    (root / "d").mkdir()
    (root / "d" / "f.txt").write_text("x")
    vrai_fwalk = os.fwalk

    def fwalk_avec_bascule(*a, **k):
        for i, item in enumerate(vrai_fwalk(*a, **k)):
            if i == 0:                             # après la liste de la racine
                (root / "d" / "f.txt").unlink()
                (root / "d").rmdir()
                os.symlink(outside, root / "d")
            yield item
    monkeypatch.setattr(paths.os, "fwalk", fwalk_avec_bascule)
    paths.widen_beneath(root, "", recursive=True)
    assert _mode(outside) == OUTSIDE_MODE
    assert _mode(outside_file) == 0o600
