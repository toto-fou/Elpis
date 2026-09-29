# SPDX-License-Identifier: MIT
"""Régression de l'upload CHUNKÉ des gros fichiers (sandbox).

Bug d'origine : un fichier de 1 Go était rejeté (« 0 fichier importé »), car
l'upload multipart plafonne chaque fichier à ``MAX_UPLOAD_BYTES`` (50 Mo) et
charge le fichier entier en RAM. Le fix streame les gros fichiers par chunks :
1er chunk crée le ``.part`` (truncate), les suivants l'append, le dernier le
renomme en fichier final — mémoire bornée des deux côtés.

Ces tests passent par ``sandbox_append_chunk`` et ``sandbox_rename`` (agent de
la sandbox servi en thread par la suite de tests).
"""
import asyncio
import os
import random

import pytest

import shared_infra.sandbox.exec_bridge as xb


@pytest.fixture()
def root(tmp_path, monkeypatch):
    from shared_infra.sandbox.executors import get_user_sandbox
    work = tmp_path / "u" / "work"
    work.mkdir(parents=True)
    sb = get_user_sandbox(1, "u", work)
    monkeypatch.setattr(xb, "_get_sandbox_for_user", lambda uid: sb)
    return work


def test_chunked_reconstruction_is_byte_perfect(root):
    """truncate → append×N → rename reconstitue exactement le fichier (chemin
    avec espace inclus)."""
    random.seed(7)
    chunks = [os.urandom(random.randint(1, 5000)) for _ in range(200)]

    async def envoyer():
        for idx, ch in enumerate(chunks):
            await xb.sandbox_append_chunk(1, "sous dossier/gros.bin.part", ch, truncate=idx == 0)
        await xb.sandbox_rename(1, "sous dossier/gros.bin.part", "sous dossier/gros.bin",
                                overwrite=True)
    asyncio.run(envoyer())
    final = root / "sous dossier" / "gros.bin"
    assert not (root / "sous dossier" / "gros.bin.part").exists(), ".part doit être promu"
    assert final.read_bytes() == b"".join(chunks)


def test_first_chunk_truncates_stale_part(root):
    """Un ``.part`` resté d'un import abandonné est vidé par le 1er morceau."""
    (root / "f.part").write_bytes(b"ANCIEN" * 100)

    async def envoyer():
        await xb.sandbox_append_chunk(1, "f.part", b"neuf", truncate=True)
        await xb.sandbox_append_chunk(1, "f.part", b"+suite", truncate=False)
    asyncio.run(envoyer())
    assert (root / "f.part").read_bytes() == b"neuf+suite"


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
