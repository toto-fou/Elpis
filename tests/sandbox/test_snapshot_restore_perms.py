# SPDX-License-Identifier: MIT
"""Restore de snapshot — modes cross-UID des membres extraits (bug 2026-07-30).

Les membres de l'archive sont extraits CÔTÉ HÔTE (UID de l'app), donc les
fichiers restaurés appartiennent à l'hôte. Or l'hôte et le conteneur (UID
10001) ne partagent AUCUN groupe dans ce déploiement : le conteneur tombe dans
« other ». Le restore ré-alignait sur 0664/0775 — group-writable, donc r--/r-x
pour le conteneur : après un restore, le terminal ne pouvait plus modifier ses
propres fichiers (« permission denied » sur tout l'arbre restauré).

L'invariant /work est 0666/0777 (bit « other »), comme partout ailleurs :
wrapper ``umask 0000`` des exec conteneur, et ``paths.widen_beneath`` pour tout
ce que l'hôte écrit (outils fichiers, restore, grant).
"""
import os
import stat

import pytest

from shared_infra.sandbox.paths import widen_beneath


def _mode(p):
    return stat.S_IMODE(os.stat(p).st_mode) & 0o777


def test_dir_becomes_other_writable(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    os.chmod(d, 0o775)                       # ancien comportement du restore
    widen_beneath(tmp_path, "src")
    assert _mode(d) == 0o777, "sans le bit other, le conteneur ne peut pas écrire"


@pytest.mark.parametrize("initial", [0o644, 0o664, 0o600])
def test_regular_file_becomes_other_writable(tmp_path, initial):
    f = tmp_path / "a.txt"
    f.write_text("x")
    os.chmod(f, initial)
    widen_beneath(tmp_path, "a.txt")
    assert _mode(f) == 0o666


@pytest.mark.parametrize("initial", [0o755, 0o744, 0o700])
def test_executable_bit_is_preserved(tmp_path, initial):
    s = tmp_path / "run.sh"
    s.write_text("#!/bin/sh\n")
    os.chmod(s, initial)
    widen_beneath(tmp_path, "run.sh")
    assert _mode(s) == 0o777, "scripts et hooks git doivent rester exécutables"


def test_missing_path_is_a_noop(tmp_path):
    # Un membre skippé (extract en erreur) ne doit pas casser le restore.
    widen_beneath(tmp_path, "nope")
