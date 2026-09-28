# SPDX-License-Identifier: MIT
"""Editor write robustness: a stale-readiness 'no such container' must map to
503 (so the editor's restart UX engages) and transparently retry once (the
ops are idempotent); a genuine error stays 500. Plus the root-delete message."""
import pytest
from fastapi import HTTPException

from shared_infra.sandbox import exec_bridge as sx
from shared_infra.sandbox.executors._base import ExecResult
from shared_infra.sandbox.executors._user_sandbox import SandboxStatus


def _res(rc, stderr=b"", stdout=b"", timed_out=False):
    return ExecResult(returncode=rc, stdout=stdout, stderr=stderr,
                      duration_s=0.0, timed_out=timed_out)


class FakeSB:
    def __init__(self, results):
        self._results = list(results)
        self.exec_calls = 0
        self.ensure_calls = 0

    async def ensure_running(self):
        self.ensure_calls += 1
        return SandboxStatus(exists=True, running=True, container_name="elpis-sb-x")

    async def exec(self, cmd, **kw):
        self.exec_calls += 1
        return self._results.pop(0)


def _patch(monkeypatch, sb):
    monkeypatch.setattr(sx, "_get_sandbox_for_user", lambda uid: sb)


async def test_success_passthrough(monkeypatch):
    sb = FakeSB([_res(0, stdout=b"hello")])
    _patch(monkeypatch, sb)
    assert await sx._exec_in_sandbox(1, ["echo", "hi"]) == b"hello"
    assert sb.exec_calls == 1


async def test_dead_container_retry_recovers(monkeypatch):
    # 1st exec: container gone. Retry after ensure_running: success.
    sb = FakeSB([_res(1, b"Error: No such container: elpis-sb-x"),
                 _res(0, stdout=b"ok")])
    _patch(monkeypatch, sb)
    out = await sx._exec_in_sandbox(1, ["sh", "-c", "true"])
    assert out == b"ok"
    assert sb.exec_calls == 2  # retried exactly once
    assert sb.ensure_calls == 2  # initial + recovery


async def test_dead_container_retry_fails_maps_503(monkeypatch):
    sb = FakeSB([_res(1, b"No such container"), _res(1, b"is not running")])
    _patch(monkeypatch, sb)
    with pytest.raises(HTTPException) as ei:
        await sx._exec_in_sandbox(1, ["sh", "-c", "true"])
    assert ei.value.status_code == 503
    assert sb.exec_calls == 2


async def test_real_error_stays_500(monkeypatch):
    sb = FakeSB([_res(1, b"fatal: some genuine error")])
    _patch(monkeypatch, sb)
    with pytest.raises(HTTPException) as ei:
        await sx._exec_in_sandbox(1, ["sh", "-c", "false"])
    assert ei.value.status_code == 500
    assert sb.exec_calls == 1  # no retry for a non-dead error


async def test_delete_root_alias_message(monkeypatch):
    _patch(monkeypatch, FakeSB([]))
    for alias in ("/work", "work", "./work", ""):
        with pytest.raises(HTTPException) as ei:
            await sx.sandbox_delete(1, alias)
        assert ei.value.status_code == 400
        assert "suppression" in ei.value.detail.lower()


async def test_delete_real_path_proceeds(monkeypatch):
    sb = FakeSB([_res(0)])
    _patch(monkeypatch, sb)
    await sx.sandbox_delete(1, "notes.txt")  # must not raise
    assert sb.exec_calls == 1
