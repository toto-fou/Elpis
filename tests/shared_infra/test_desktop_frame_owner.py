# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_desktop_frame_owner.py — propriété des frames (R9).

La propriété est portée par un SIDECAR disque (``frame_<token>.owner``) partagé
cross-worker/process. La route sert la frame à son propriétaire (200), la refuse à
un autre (403), et — en mode STRICT (défaut) — refuse un propriétaire INCONNU
(404) ; l'échappatoire config restaure l'ancien soft-pass.
``DESKTOP_SCREENS_DIR`` est isolé dans un tmpdir.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import llm_core._desktop_session as ds
    monkeypatch.setattr(ds, "DESKTOP_SCREENS_DIR", str(tmp_path), raising=True)
    ds._frame_owners.clear()

    import shared_infra.desktop.routes as rt

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(rt, "require_user_id", _fake_uid)
    monkeypatch.setattr(rt, "_username_for", lambda uid: f"user{uid}")

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return ds, rt, TestClient(app), tmp_path


def _write_frame(ds, tmp_path, token, owner=None):
    (tmp_path / f"frame_{token}.png").write_bytes(b"\x89PNG\r\n\x1a\nDATA")
    if owner is not None:
        ds.write_frame_owner(token, owner)


_ALICE = {"x-test-user": "1"}   # → user1
_BOB = {"x-test-user": "2"}     # → user2


def test_owner_can_fetch(env):
    ds, rt, client, tmp = env
    _write_frame(ds, tmp, "tokenAAAAAAA1", owner="user1")
    r = client.get("/api/desktop/frame/tokenAAAAAAA1", headers=_ALICE)
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")


def test_other_user_denied_403(env):
    ds, rt, client, tmp = env
    _write_frame(ds, tmp, "tokenBBBBBBB2", owner="user1")
    r = client.get("/api/desktop/frame/tokenBBBBBBB2", headers=_BOB)
    assert r.status_code == 403


def test_unknown_owner_404_in_strict(env, monkeypatch):
    ds, rt, client, tmp = env
    monkeypatch.setattr(rt._cfg, "DESKTOP_FRAME_STRICT_OWNER", True, raising=False)
    _write_frame(ds, tmp, "tokenCCCCCCC3", owner=None)     # PNG sans sidecar
    r = client.get("/api/desktop/frame/tokenCCCCCCC3", headers=_ALICE)
    assert r.status_code == 404


def test_unknown_owner_soft_pass_when_strict_off(env, monkeypatch):
    ds, rt, client, tmp = env
    monkeypatch.setattr(rt._cfg, "DESKTOP_FRAME_STRICT_OWNER", False, raising=False)
    _write_frame(ds, tmp, "tokenDDDDDDD4", owner=None)
    r = client.get("/api/desktop/frame/tokenDDDDDDD4", headers=_ALICE)
    assert r.status_code == 200


def test_owner_read_from_sidecar_cross_process(env):
    # Simule un AUTRE process : le sidecar existe mais la mémoire est vide.
    ds, rt, client, tmp = env
    _write_frame(ds, tmp, "tokenEEEEEEE5", owner="user1")
    ds._frame_owners.clear()                                # « autre worker »
    assert ds.get_desktop_frame_owner("tokenEEEEEEE5") == "user1"   # lu depuis le sidecar
    r = client.get("/api/desktop/frame/tokenEEEEEEE5", headers=_BOB)
    assert r.status_code == 403                             # bob n'est pas le proprio


def test_prune_removes_sidecar(env):
    ds, rt, client, tmp = env
    _write_frame(ds, tmp, "tokenFFFFFFF6", owner="user1")
    assert (tmp / "frame_tokenFFFFFFF6.owner").exists()
    ds.prune_frames(ttl_sec=-1, force=True)                 # tout est « expiré »
    assert not (tmp / "frame_tokenFFFFFFF6.owner").exists()
    assert not (tmp / "frame_tokenFFFFFFF6.png").exists()


def test_jpeg_content_served_as_jpeg(env):
    # P3 — nom opaque .png mais contenu JPEG (magic \xff\xd8) → media_type sniffé.
    ds, rt, client, tmp = env
    (tmp / "frame_tokenGGGGGGG7.png").write_bytes(b"\xff\xd8\xff\xe0JFIF-data")
    ds.write_frame_owner("tokenGGGGGGG7", "user1")
    r = client.get("/api/desktop/frame/tokenGGGGGGG7", headers=_ALICE)
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
