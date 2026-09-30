# SPDX-License-Identifier: MIT
"""Régression du wrapper shell de ``UserSandbox.exec`` (timeout côté container).

Bug historique (refonte sandbox) : le script ``umask …; exec timeout -k 5
"$1" "$@"`` réinjectait la valeur de timeout, car ``"$@"`` expanse TOUS les
positionnels à partir de ``$1`` — déjà capturé par ``"$1"``. Docker exécutait
donc ``timeout -k 5 60 60 <cmd>`` : ``timeout`` lisait le 2e « 60 » comme la
COMMANDE → « command not found » (rc 127) sur CHAQUE exec, cassant tout le FS
sandbox (upload/save/mkdir/rename) et le terminal.

Le fix capture ``$1``, fait ``shift``, puis ``"$@"`` = la vraie commande.

Ces tests valident le script à la couche shell exacte où le bug vivait, sans
exiger Docker (``sh`` + ``timeout`` coreutils suffisent).
"""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[2] / "shared_infra" / "sandbox" / "executors" / "_user_sandbox.py"

# Script shell tel qu'inliné dans UserSandbox.exec (doit rester synchronisé).
# umask 0022 : un seul UID écrit dans /work (L4.6), fichiers 0644 / dossiers
# 0755, quel que soit l'umask que l'image pose dans /etc/profile.
_WRAPPER = 'umask 0022; t="$1"; shift; exec timeout -k 5 "$t" "$@"'

pytestmark = pytest.mark.skipif(
    shutil.which("timeout") is None or shutil.which("sh") is None,
    reason="requires POSIX sh + coreutils timeout",
)


def test_source_uses_shift_not_double_dollar_args():
    """Garde-fou : le source ne doit PAS revenir au pattern fautif ``"$1" "$@"``."""
    src = _SRC.read_text(encoding="utf-8")
    assert _WRAPPER in src, "wrapper shell modifié — synchroniser ce test"
    assert 'exec timeout -k 5 "$1" "$@"' not in src, (
        "regression : le timeout est réinjecté via \"$1\" \"$@\""
    )
    # Fin de l'élargissement (L4.6) : ni 0000 (tout le monde en écriture), ni
    # l'umask de l'image.
    assert "umask 0022;" in src, "le wrapper doit forcer umask 0022"
    assert "umask 0000;" not in src and "umask 0002;" not in src


def test_wrapper_runs_the_command_not_the_timeout_value():
    """Le wrapper doit lancer la commande wrappée, pas la valeur de timeout."""
    # Reproduit l'invocation docker : sh -c SCRIPT -- <timeout> <cmd...>
    res = subprocess.run(
        ["sh", "-c", _WRAPPER, "--", "60", "echo", "hello-world"],
        capture_output=True, text=True, timeout=10,
    )
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == "hello-world"


def test_wrapper_streams_stdin_to_file_like_upload_and_save():
    """Le chemin upload/save (``cat > tmp; mv``) doit fonctionner via le wrapper."""
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "out.bin"
        payload = b"contenu\x00binaire test"
        res = subprocess.run(
            ["sh", "-c", _WRAPPER, "--", "60",
             "sh", "-c", 'cat > "$1"', "_", str(out)],
            input=payload, capture_output=True, timeout=10,
        )
        assert res.returncode == 0, res.stderr
        assert out.read_bytes() == payload


def test_old_buggy_wrapper_would_fail():
    """Sanity : l'ancien script échoue bien (documente la cause racine)."""
    buggy = 'umask 0000; exec timeout -k 5 "$1" "$@"'
    res = subprocess.run(
        ["sh", "-c", buggy, "--", "60", "echo", "hello-world"],
        capture_output=True, text=True, timeout=10,
    )
    assert res.returncode == 127  # timeout tente d'exécuter « 60 » comme commande
