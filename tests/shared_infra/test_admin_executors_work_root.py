# SPDX-License-Identifier: MIT
"""#1 regression: admin stop/destroy must build the UserSandbox on the WORK
root (P/work), NOT the per-user root P. Building on P poisons the process-wide
_USER_SANDBOXES cache and a later _create would re-mount the whole P at /work,
re-exposing skills/.memory — the exact thing the work-subdir split prevents.
"""
import types
from pathlib import Path


async def _run(handler_name, tmp_path, monkeypatch):
    import shared_infra.db as db
    import shared_infra.routes._helpers as helpers
    import shared_infra.routes.admin.executors as ex

    monkeypatch.setattr(ex, "_require_admin", lambda r: None)
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(ex, "audit_event", lambda **kw: None)

    # The handler resolves the mount path via _get_work_path (P/work). Stub it
    # to a sentinel and assert get_user_sandbox receives exactly that.
    sentinel = tmp_path / "alice" / "work"
    monkeypatch.setattr(helpers, "_get_work_path", lambda uid: sentinel)

    captured = {}

    class _FakeSB:
        async def stop(self):    captured["stopped"] = True
        async def destroy(self): captured["destroyed"] = True

    def _fake_get(uid, username, path, **kw):
        captured["path"] = Path(path)
        return _FakeSB()

    monkeypatch.setattr(ex, "get_user_sandbox", _fake_get)

    req = types.SimpleNamespace(state=types.SimpleNamespace(user_id=1, username="admin"))
    await getattr(ex, handler_name)(req, 7)
    return captured, sentinel


async def test_admin_stop_uses_work_root(tmp_path, monkeypatch):
    captured, sentinel = await _run("admin_sandbox_stop", tmp_path, monkeypatch)
    assert captured["path"] == sentinel
    assert captured["path"].name == "work"        # NOT the per-user root P
    assert captured.get("stopped") is True


async def test_admin_destroy_uses_work_root(tmp_path, monkeypatch):
    captured, sentinel = await _run("admin_sandbox_destroy", tmp_path, monkeypatch)
    assert captured["path"] == sentinel
    assert captured["path"].name == "work"
    assert captured.get("destroyed") is True
