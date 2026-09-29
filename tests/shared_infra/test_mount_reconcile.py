# SPDX-License-Identifier: MIT
"""One-shot /work mount reconciliation: a container created BEFORE the
work-subdir migration binds the old flat per-user dir at /work; the first
``ensure_running`` after deploy must detect the drift and recreate it with the
new ``P/work`` mount. Fail-open on any uncertainty (never disrupt a healthy
container we can't introspect).
"""
from pathlib import Path

from shared_infra.sandbox.executors._user_sandbox import (
    SandboxAdminConfig,
    SandboxStatus,
    UserSandbox,
)


class _FakeCLI:
    """Minimal async docker CLI stub. Answers the /work Mounts inspect with a
    canned source; records rm/other calls."""
    def __init__(self, mount_source):
        self.mount_source = mount_source
        self.calls = []

    async def call(self, *args, **kw):
        self.calls.append(args)
        if args and args[0] == "inspect" and any("Mounts" in str(a) for a in args):
            return (0, (self.mount_source or "").encode(), b"")
        return (0, b"", b"")


def _sb(mount_source):
    sb = UserSandbox(1, "alice", Path("/sb/alice/work"),
                     cfg=SandboxAdminConfig.from_dict({}),
                     network_profile_id="isolated")
    sb._cli = _FakeCLI(mount_source)
    return sb


def _running(sb):
    return SandboxStatus(exists=True, running=True, container_name=sb.container_name)


async def test_reconcile_recreates_on_mount_drift(monkeypatch):
    sb = _sb(mount_source="/sb/alice")          # OLD flat mount → drift
    created = {"n": 0}

    async def fake_create():
        created["n"] += 1

    async def fake_status():
        return _running(sb)

    monkeypatch.setattr(sb, "_create", fake_create)
    monkeypatch.setattr(sb, "status", fake_status)

    st = await sb._reconcile_work_mount(_running(sb))
    assert st.running
    assert created["n"] == 1                    # recreated due to drift
    assert sb._mount_verified
    assert any(c and c[0] == "rm" for c in sb._cli.calls)


async def test_reconcile_noop_when_mount_matches(monkeypatch):
    sb = _sb(mount_source="/sb/alice/work")     # already correct
    created = {"n": 0}

    async def fake_create():
        created["n"] += 1

    async def fake_status():
        return _running(sb)

    monkeypatch.setattr(sb, "_create", fake_create)
    monkeypatch.setattr(sb, "status", fake_status)

    await sb._reconcile_work_mount(_running(sb))
    assert created["n"] == 0                     # untouched
    assert sb._mount_verified
    assert not any(c and c[0] == "rm" for c in sb._cli.calls)


async def test_reconcile_fail_open_when_source_unknown(monkeypatch):
    sb = _sb(mount_source="")                    # inspect returns nothing
    created = {"n": 0}

    async def fake_create():
        created["n"] += 1

    async def fake_status():
        return _running(sb)

    monkeypatch.setattr(sb, "_create", fake_create)
    monkeypatch.setattr(sb, "status", fake_status)

    await sb._reconcile_work_mount(_running(sb))
    assert created["n"] == 0                     # uncertainty → never disrupt
    assert sb._mount_verified
