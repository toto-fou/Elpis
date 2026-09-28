# SPDX-License-Identifier: MIT
"""Régression du wrapper shell de ``UserSandbox.exec`` (timeout côté container).

Bug historique (refonte sandbox) : le script ``umask 0000; exec timeout -k 5
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
# umask 0000 (et NON 0002) : hôte (UID 1000) et container (UID 10001) ne
# partagent AUCUN groupe → un fichier group-writable (0664/0775) reste non
# inscriptible par l'autre côté. 0000 → 0666/0777 (other-writable) rend /work
# cross-writable dans les deux sens (cf. _user_sandbox.exec).
_WRAPPER = 'umask 0000; t="$1"; shift; exec timeout -k 5 "$t" "$@"'

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
    # Garde-fou cross-UID : le wrapper doit forcer umask 0000 (other-writable),
    # PAS 0002 (group-only) — sinon l'hôte UID 1000 ne peut pas écrire dans les
    # dossiers créés par le container UID 10001 (aucun groupe partagé).
    assert "umask 0000;" in src, "le wrapper doit forcer umask 0000 (cross-UID)"
    assert "umask 0002;" not in src, (
        "regression : umask 0002 (group-only) ne bridge pas l'écriture cross-UID"
    )


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
