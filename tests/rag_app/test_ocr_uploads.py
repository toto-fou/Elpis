# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_uploads.py — copie bornée d'un upload.

``save_upload_bounded`` (porté de shared_infra.files.uploads) : écriture
streamée par chunks, short-circuit 413 sur un Content-Length menteur AVANT
toute écriture, 413 + fichier partiel supprimé si le flux réel dépasse le
plafond en cours de copie.
"""
from __future__ import annotations

import io
import types

import pytest
from fastapi import HTTPException

from rag_app.ocr import _uploads as U


def _upload(data: bytes, headers=None):
    """UploadFile-like minimal : .file (BytesIO) + .headers (dict.get)."""
    return types.SimpleNamespace(file=io.BytesIO(data),
                                 headers=dict(headers or {}))


async def test_copie_ok(tmp_path):
    dest = tmp_path / "sub" / "source.pdf"
    n = await U.save_upload_bounded(_upload(b"%PDF-contenu"), dest, 100)
    assert n == len(b"%PDF-contenu")
    assert dest.read_bytes() == b"%PDF-contenu"       # parent créé au passage


async def test_content_length_menteur_short_circuit(tmp_path):
    """Header > plafond : 413 AVANT toute écriture — pas de fichier vide."""
    dest = tmp_path / "gros.pdf"
    up = _upload(b"x", headers={"content-length": "1000"})
    with pytest.raises(HTTPException) as exc:
        await U.save_upload_bounded(up, dest, 100)
    assert exc.value.status_code == 413
    assert not dest.exists()
    assert up.file.tell() == 0                        # rien n'a été lu


async def test_content_length_illisible_ignore(tmp_path):
    """Header non numérique : ignoré, la vérification réelle prime."""
    dest = tmp_path / "ok.pdf"
    up = _upload(b"abc", headers={"content-length": "pas-un-nombre"})
    assert await U.save_upload_bounded(up, dest, 100) == 3
    assert dest.read_bytes() == b"abc"


async def test_depassement_reel_supprime_le_partiel(tmp_path):
    """La taille réelle prime sur le header : dépassement en cours de copie
    → 413 ET fichier partiel supprimé (pas de fantôme sur le disque)."""
    dest = tmp_path / "trop.pdf"
    up = _upload(b"y" * 200, headers={"content-length": "50"})   # header MENT
    with pytest.raises(HTTPException) as exc:
        await U.save_upload_bounded(up, dest, 100)
    assert exc.value.status_code == 413
    assert not dest.exists()


def test_copy_bounded_sync_multi_chunks(tmp_path, monkeypatch):
    """Le dépassement est détecté chunk par chunk (pas seulement au premier)."""
    monkeypatch.setattr(U, "_CHUNK_SIZE", 4)
    dest = tmp_path / "d.bin"
    with pytest.raises(HTTPException):
        U._copy_bounded_sync(io.BytesIO(b"0123456789"), dest, 6)
    assert not dest.exists()
    assert U._copy_bounded_sync(io.BytesIO(b"012345"), dest, 6) == 6
    assert dest.read_bytes() == b"012345"
