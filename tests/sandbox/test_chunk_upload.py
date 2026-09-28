# SPDX-License-Identifier: MIT
"""Régression de l'upload CHUNKÉ des gros fichiers (sandbox).

Bug d'origine : un fichier de 1 Go était rejeté (« 0 fichier importé »), car
l'upload multipart plafonne chaque fichier à ``MAX_UPLOAD_BYTES`` (50 Mo) et
charge le fichier entier en RAM. Le fix streame les gros fichiers par chunks :
1er chunk crée le ``.part`` (truncate), les suivants l'append, le dernier le
renomme en fichier final — mémoire bornée des deux côtés.

Ces tests valident les scripts shell exacts exécutés via ``docker exec`` par
``sandbox_append_chunk`` (+ ``sandbox_rename`` pour la promotion), sans Docker
(``sh`` suffit), ainsi que la cohérence avec le source.
"""
import hashlib
import os
import random
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

_EXEC_SRC = Path(__file__).resolve().parents[2] / "shared_infra" / "sandbox" / "exec_bridge.py"

# Scripts tels qu'inlinés côté serveur (doivent rester synchronisés).
_TRUNC  = 'set -e; mkdir -p "$(dirname "$1")"; cat > "$1"'
_APPEND = 'set -e; cat >> "$1"'
_RENAME = 'set -e; mkdir -p "$(dirname "$2")"; mv -- "$1" "$2"'

pytestmark = pytest.mark.skipif(shutil.which("sh") is None, reason="requires POSIX sh")


def _sh(script, args, stdin=b""):
    return subprocess.run(["sh", "-c", script, "_", *args],
                          input=stdin, capture_output=True, timeout=30)


def test_source_has_append_chunk_scripts():
    """Garde-fou : les scripts truncate/append du helper sont bien présents."""
    src = _EXEC_SRC.read_text(encoding="utf-8")
    assert 'cat >> "$1"' in src, "script d'append du chunk manquant"
    assert 'mkdir -p "$(dirname "$1")"; cat > "$1"' in src, "script truncate manquant"


def test_chunked_reconstruction_is_byte_perfect():
    """truncate → append×N → mv reconstitue exactement le fichier (chemin avec
    espace inclus, pour valider le quoting positionnel)."""
    random.seed(7)
    chunks = [os.urandom(random.randint(1, 5000)) for _ in range(500)]
    with tempfile.TemporaryDirectory() as d:
        final = os.path.join(d, "sous dossier", "gros.bin")
        tmp = final + ".part"
        for idx, ch in enumerate(chunks):
            r = _sh(_TRUNC if idx == 0 else _APPEND, [tmp], ch)
            assert r.returncode == 0, r.stderr
        r = _sh(_RENAME, [tmp, final])
        assert r.returncode == 0, r.stderr
        assert not os.path.exists(tmp), ".part doit être promu (disparu)"
        got = Path(final).read_bytes()
        want = b"".join(chunks)
        assert hashlib.sha256(got).hexdigest() == hashlib.sha256(want).hexdigest()


def test_first_chunk_truncates_stale_part():
    """Un .part résiduel d'un upload avorté est ÉCRASÉ par le 1er chunk
    (truncate), pas appendé — sinon le fichier serait corrompu au retry."""
    with tempfile.TemporaryDirectory() as d:
        tmp = os.path.join(d, "x.bin.part")
        Path(tmp).write_bytes(b"RESIDU_AVORTE")
        assert _sh(_TRUNC, [tmp], b"AAAA").returncode == 0
        assert _sh(_APPEND, [tmp], b"BBBB").returncode == 0
        assert Path(tmp).read_bytes() == b"AAAABBBB"


# ── Découpage client (réplique de _uploadFileChunked dans app.js) ──────────
_UP_CHUNK_SIZE = 8 * 1024 * 1024


def _client_chunks(size):
    total = max(1, -(-size // _UP_CHUNK_SIZE))  # ceil
    segs = []
    for idx in range(total):
        start = idx * _UP_CHUNK_SIZE
        end = min(start + _UP_CHUNK_SIZE, size)
        segs.append((idx, start, end, total))
    return segs


@pytest.mark.parametrize("size,expected_n", [
    (0, 1), (1, 1),
    (_UP_CHUNK_SIZE, 1),
    (_UP_CHUNK_SIZE + 1, 2),
    (1024 * 1024 * 1024, 128),   # 1 Go → 128 chunks de 8 Mo
])
def test_client_chunk_split(size, expected_n):
    segs = _client_chunks(size)
    assert len(segs) == expected_n
    assert segs[0][1] == 0
    assert segs[-1][2] == size
    assert segs[-1][0] == expected_n - 1
    # contiguïté : pas de trou ni de chevauchement
    for i in range(1, len(segs)):
        assert segs[i][1] == segs[i - 1][2]
