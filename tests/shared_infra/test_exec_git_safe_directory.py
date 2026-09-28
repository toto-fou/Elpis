# SPDX-License-Identifier: MIT
"""Injection ``safe.directory=*`` dans l'env des exec conteneur (audit 2026-07-26).

Un repo créé côté HÔTE (git_action init/clone, panneau git) appartient à l'UID
de l'app, pas à ``exec_user`` : sans cette injection, git dans le shell du
conteneur refusait TOUTE commande (« detected dubious ownership ») même en
lecture. On la passe par le protocole env GIT_CONFIG (rien d'écrit dans /work),
sans écraser un GIT_CONFIG_COUNT posé par l'appelant.
"""
from pathlib import Path

import pytest

from shared_infra.sandbox.executors._user_sandbox import (
    UserSandbox, SandboxAdminConfig, SandboxStatus,
)


def _capture_exec_args(monkeypatch, sb):
    captured = {}

    async def _fake_ensure_running():
        return SandboxStatus(running=True, exists=True,
                             container_name=sb.container_name)

    class _FakeProc:
        returncode = 0
        # L'exécuteur lit la sortie par pompes (AUDIT 2026-09-25).
        stdin = stdout = stderr = None
        async def communicate(self, input=None):
            return b"", b""
        async def wait(self):
            return 0

    async def _fake_subprocess(bin_, *args, **kw):
        captured["args"] = list(args)
        return _FakeProc()

    monkeypatch.setattr(sb, "ensure_running", _fake_ensure_running)
    import shared_infra.sandbox.executors._user_sandbox as us
    monkeypatch.setattr(us.asyncio, "create_subprocess_exec", _fake_subprocess)
    return captured


@pytest.mark.asyncio
async def test_exec_injects_safe_directory(tmp_path, monkeypatch):
    cfg = SandboxAdminConfig.from_dict({})
    sb = UserSandbox(1, "alice", tmp_path, cfg=cfg, network_profile_id="isolated")
    captured = _capture_exec_args(monkeypatch, sb)
    await sb.exec(["git", "status"])
    args = captured["args"]
    assert "GIT_CONFIG_COUNT=1" in args
    assert "GIT_CONFIG_KEY_0=safe.directory" in args
    assert "GIT_CONFIG_VALUE_0=*" in args


@pytest.mark.asyncio
async def test_exec_does_not_clobber_caller_git_config(tmp_path, monkeypatch):
    cfg = SandboxAdminConfig.from_dict({})
    sb = UserSandbox(1, "alice", tmp_path, cfg=cfg, network_profile_id="isolated")
    captured = _capture_exec_args(monkeypatch, sb)
    await sb.exec(["git", "status"],
                  env={"GIT_CONFIG_COUNT": "1",
                       "GIT_CONFIG_KEY_0": "user.name",
                       "GIT_CONFIG_VALUE_0": "x"})
    args = captured["args"]
    assert "GIT_CONFIG_KEY_0=user.name" in args
    assert "GIT_CONFIG_KEY_0=safe.directory" not in args
