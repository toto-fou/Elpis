# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_snapshot_member_cap.py — caps anti zip-bomb à la
restauration de snapshots (AUDIT 2026-06) + verrouillage du scoping per-user.

Points clés vérifiés :
- une archive avec un membre au-delà de SNAPSHOT_MAX_MEMBER_MB est REFUSÉE
  avec une erreur explicite, AVANT la phase 'clearing' (sandbox intacte) ;
- idem pour le total au-delà de SNAPSHOT_MAX_TOTAL_GB ;
- une archive saine passe les caps ;
- scoping per-user : le chemin d'archive d'un user N'EST PAS atteignable
  via le snap_id seul (le répertoire est dérivé du username) — c'est la
  garantie qui rend un HMAC sur snap_id superflu (cf. audit).
"""
from __future__ import annotations

import io
import json
import tarfile

import pytest

import shared_infra.sandbox.routes_snapshots as snap


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────

def _make_archive(path, members):
    """Crée un .tar.gz ; members = [(name, size_annoncée, vrai_contenu|None)].
    Pour simuler une zip-bomb on écrit un header avec une taille énorme n'est
    pas possible via tarfile.add — on passe par TarInfo + addfile."""
    with tarfile.open(str(path), "w:gz") as tf:
        for name, size, payload in members:
            info = tarfile.TarInfo(name=name)
            data = payload if payload is not None else b"x" * size
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))


async def _collect(gen):
    return [json.loads(line) for line in [ev async for ev in gen] if line.strip()]


@pytest.fixture()
def patched_env(tmp_path, monkeypatch):
    """Route _archive_path/_sandbox_root_for vers tmp, neutralise le lock DB."""
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    (sandbox / "keep.txt").write_text("précieux")
    archive = tmp_path / "snap.tar.gz"

    monkeypatch.setattr(snap, "_archive_path", lambda uid, sid: archive)
    monkeypatch.setattr(snap, "_sandbox_root_for", lambda uid: sandbox)
    return sandbox, archive


# ──────────────────────────────────────────────────────────────────────────
# Caps
# ──────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_member_cap_rejected_before_clearing(patched_env, monkeypatch):
    sandbox, archive = patched_env
    monkeypatch.setattr(snap, "_MAX_MEMBER_BYTES", 1024)  # cap 1 Ko pour le test
    _make_archive(archive, [("big.bin", 0, b"y" * 4096)])

    events = await _collect(snap._restore_snapshot_stream(1, "a" * 32))
    kinds = [e.get("event") for e in events]
    assert "error" in kinds
    err = next(e for e in events if e["event"] == "error")
    assert "cap par membre" in err["message"]
    # La sandbox n'a PAS été vidée (erreur avant 'clearing')
    assert (sandbox / "keep.txt").exists()
    assert "clearing" not in [e.get("phase") for e in events if e.get("event") == "phase"]


@pytest.mark.asyncio
async def test_total_cap_rejected_before_clearing(patched_env, monkeypatch):
    sandbox, archive = patched_env
    monkeypatch.setattr(snap, "_MAX_TOTAL_BYTES", 2048)
    _make_archive(archive, [(f"f{i}.bin", 0, b"z" * 1024) for i in range(4)])

    events = await _collect(snap._restore_snapshot_stream(1, "a" * 32))
    err = next(e for e in events if e.get("event") == "error")
    assert "taille décompressée totale" in err["message"]
    assert (sandbox / "keep.txt").exists()


@pytest.mark.asyncio
async def test_sane_archive_passes_caps(patched_env):
    sandbox, archive = patched_env
    _make_archive(archive, [("ok.txt", 0, b"hello")])

    events = await _collect(snap._restore_snapshot_stream(1, "a" * 32))
    kinds = [e.get("event") for e in events]
    assert "done" in kinds, f"events: {events}"
    assert (sandbox / "ok.txt").read_text() == "hello"


# ──────────────────────────────────────────────────────────────────────────
# Scoping per-user (test de régression — remplace l'idée d'un HMAC)
# ──────────────────────────────────────────────────────────────────────────

def test_archive_path_is_scoped_per_user(monkeypatch):
    """Deux users avec le même snap_id → chemins DISTINCTS (répertoire par
    username). Deviner un snap_id ne donne pas accès cross-user."""
    monkeypatch.setattr(snap, "get_username_by_id",
                        lambda uid: {1: "alice", 2: "bob"}[uid])
    sid = "ab" * 16
    p1 = snap._archive_path(1, sid)
    p2 = snap._archive_path(2, sid)
    assert p1 != p2
    assert "alice" in str(p1) and "bob" in str(p2)
