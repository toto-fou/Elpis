# SPDX-License-Identifier: MIT
"""Live shell — chemin de lecture incrémentale de ``UserSandbox.exec``.

Le paramètre ``on_chunk`` branche des pompes stdout/stderr (lecture 4 Ko)
qui relaient chaque paquet au callback SANS changer le contrat ExecResult :
les buffers complets restent identiques au chemin ``communicate()``.

Sans Docker : on intercepte ``asyncio.create_subprocess_exec`` et on exécute
LOCALEMENT la commande wrappée (la queue de l'argv docker après ``--`` et la
valeur de timeout), à la façon de tests/sandbox/test_exec_wrapper.py.
"""
import asyncio
import shutil
from pathlib import Path

import pytest

from shared_infra.sandbox.executors._user_sandbox import (
    SandboxAdminConfig,
    SandboxStatus,
    UserSandbox,
)

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None, reason="requires bash")


def _make_sb(tmp_path, monkeypatch):
    sb = UserSandbox(1, "tester", tmp_path, cfg=SandboxAdminConfig())

    async def _ensure_running():
        return SandboxStatus(exists=True, running=True,
                             container_id="cid", container_name=sb.container_name)

    monkeypatch.setattr(sb, "ensure_running", _ensure_running)

    # Exécute la vraie commande localement à la place du ``docker exec``.
    real_cse = asyncio.create_subprocess_exec

    async def _fake_cse(_bin, *args, **kw):
        args = list(args)
        i = args.index("--")           # sh -c WRAPPER -- TIMEOUT cmd...
        real_cmd = args[i + 2:]
        return await real_cse(*real_cmd, **kw)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_cse)
    return sb


async def test_chunks_delivered_and_result_identical(tmp_path, monkeypatch):
    sb = _make_sb(tmp_path, monkeypatch)
    chunks = []
    res = await sb.exec(
        ["bash", "-c", "printf 'out1\\n'; printf 'err1\\n' >&2; printf 'out2'"],
        timeout_s=10, on_chunk=lambda s, d: chunks.append((s, d)),
    )
    assert res.returncode == 0
    assert res.stdout == b"out1\nout2"
    assert res.stderr == b"err1\n"
    assert not res.timed_out
    # Chaque flux est relayé, dans l'ordre, et la concat vaut le buffer final.
    assert b"".join(d for s, d in chunks if s == "stdout") == b"out1\nout2"
    assert b"".join(d for s, d in chunks if s == "stderr") == b"err1\n"


async def test_no_on_chunk_keeps_legacy_path(tmp_path, monkeypatch):
    sb = _make_sb(tmp_path, monkeypatch)
    res = await sb.exec(["bash", "-c", "echo legacy"], timeout_s=10)
    assert res.returncode == 0
    assert res.stdout == b"legacy\n"


async def test_broken_callback_never_kills_exec(tmp_path, monkeypatch):
    sb = _make_sb(tmp_path, monkeypatch)

    def _boom(_s, _d):
        raise RuntimeError("callback cassé")

    res = await sb.exec(["bash", "-c", "echo survive"],
                        timeout_s=10, on_chunk=_boom)
    assert res.returncode == 0
    assert res.stdout == b"survive\n"


async def test_stdin_fed_and_closed(tmp_path, monkeypatch):
    sb = _make_sb(tmp_path, monkeypatch)
    chunks = []
    res = await sb.exec(["bash", "-c", "cat"], stdin_bytes=b"ping\x00pong",
                        timeout_s=10, on_chunk=lambda s, d: chunks.append((s, d)))
    assert res.returncode == 0
    # ``cat`` ne rend la main que si stdin est FERMÉ après écriture.
    assert res.stdout == b"ping\x00pong"


async def test_host_timeout_keeps_partial_buffers(tmp_path, monkeypatch):
    sb = _make_sb(tmp_path, monkeypatch)
    chunks = []
    # timeout hôte = timeout_s + 10 → on force un timeout_s négatif impossible ;
    # à la place : commande qui écrit puis dort au-delà du filet. On raccourcit
    # le filet en monkeypatchant wait_for est trop invasif — on passe par un
    # timeout_s minuscule et le ``timeout`` in-container absent (exécution
    # locale) → c'est le wait_for hôte (timeout_s+10) qui coupe. Trop long
    # pour un test → on réduit via un faux timeout.
    real_wait_for = asyncio.wait_for

    async def _short_wait_for(aw, timeout=None):
        return await real_wait_for(aw, timeout=0.5)

    monkeypatch.setattr(asyncio, "wait_for", _short_wait_for)
    res = await sb.exec(["bash", "-c", "printf partial; sleep 30"],
                        timeout_s=1, on_chunk=lambda s, d: chunks.append((s, d)))
    assert res.timed_out
    # Amélioration vs communicate() : la sortie partielle est conservée.
    assert res.stdout == b"partial"
    assert any(s == "stdout" and b"partial" in d for s, d in chunks)
