# SPDX-License-Identifier: MIT
"""Live shell — batcher de sortie incrémentale + scheduling des notifications.

Vrai FastMCP inutilisable dans ce sandbox (cf. tests/llm_core/
test_desktop_shell.py) → FakeCtx qui enregistre les ``info(msg, logger_name)``.

Points couverts :
  * ``_schedule_ctx_coro`` privilégie la loop serveur ENREGISTRÉE (même si une
    autre loop tourne — c'est le bug cross-loop qu'on évite), retourne la
    Future ; sans rien d'enregistré ni de loop courante, ferme la coroutine ;
  * ``_ShellStreamBatcher`` : flush par seuil (2 Ko), flush par timer 150 ms,
    cap live 64 Ko + ``live_truncated``, événement ``done`` toujours émis,
    ``close()`` bloque sur les futures (ordre notifications < CallToolResult),
    décodage UTF-8 incrémental (multibyte coupé entre deux reads).
"""
import asyncio
import json
import threading

import pytest

from llm_core.tools import _exec_bridge as bridge


# ── Infra : une loop « serveur » dédiée par test ─────────────────────────

@pytest.fixture()
def server_loop():
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    bridge.register_server_loop(loop)
    yield loop
    bridge.register_server_loop(None)
    loop.call_soon_threadsafe(loop.stop)
    t.join(timeout=2)


class FakeCtx:
    def __init__(self):
        self.calls = []          # [(logger_name, msg)]

    def info(self, msg, logger_name=None):
        async def _record():
            self.calls.append((logger_name, msg))
        return _record()

    def payloads(self):
        return [json.loads(m)["__shell_output__"] for (_ln, m) in self.calls]


def _on_bridge(fn, *a):
    """Exécute ``fn(*a)`` SUR la loop du bridge (comme les pompes d'exec)."""
    async def _run():
        return fn(*a)
    return asyncio.run_coroutine_threadsafe(
        _run(), bridge._get_bridge_loop()).result(timeout=5)


# ── _schedule_ctx_coro ───────────────────────────────────────────────────

def test_schedule_prefers_registered_server_loop(server_loop):
    seen = []

    async def probe():
        seen.append(asyncio.get_running_loop())

    fut = bridge._schedule_ctx_coro(probe())
    assert fut is not None
    fut.result(timeout=2)
    assert seen == [server_loop]


def test_schedule_from_bridge_loop_still_targets_server_loop(server_loop):
    """Depuis la loop du bridge (une loop TOURNE), la loop serveur doit gagner
    — planifier une coroutine de session sur la loop bridge est le bug."""
    seen = []

    async def probe():
        seen.append(asyncio.get_running_loop())

    fut = _on_bridge(lambda: bridge._schedule_ctx_coro(probe()))
    assert fut is not None
    fut.result(timeout=2)
    assert seen == [server_loop]


def test_schedule_without_any_loop_closes_coro():
    bridge.register_server_loop(None)
    state = {"ran": False}

    async def probe():
        state["ran"] = True

    assert bridge._schedule_ctx_coro(probe()) is None
    assert state["ran"] is False   # fermée proprement, jamais exécutée


# ── _ShellStreamBatcher ──────────────────────────────────────────────────

def test_batcher_chunks_then_done(server_loop):
    ctx = FakeCtx()
    b = bridge._ShellStreamBatcher(ctx)
    _on_bridge(b.add, "stdout", b"hello ")
    _on_bridge(b.add, "stderr", b"warn\n")
    _on_bridge(b.add, "stdout", b"world")
    b.close(returncode=3, duration_ms=1234, timed_out=False)

    p = ctx.payloads()
    done = p[-1]
    assert done["done"] is True
    assert done["returncode"] == 3
    assert done["duration_ms"] == 1234
    assert done["timed_out"] is False
    assert done["live_truncated"] is False
    chunks = [c for c in p if not c.get("done")]
    out = "".join(c["chunk"] for c in chunks if c["stream"] == "stdout")
    err = "".join(c["chunk"] for c in chunks if c["stream"] == "stderr")
    assert out == "hello world"
    assert err == "warn\n"
    # seq strictement croissant, done inclus
    seqs = [c["seq"] for c in p]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)


def test_batcher_flushes_on_size_threshold(server_loop):
    ctx = FakeCtx()
    b = bridge._ShellStreamBatcher(ctx)
    big = b"x" * (bridge._SHELL_STREAM_FLUSH_CHARS + 10)
    _on_bridge(b.add, "stdout", big)
    # Flush par seuil : la notification part SANS attendre close().
    deadline = 20
    while not ctx.calls and deadline:
        import time as _t
        _t.sleep(0.05)
        deadline -= 1
    assert ctx.calls, "le seuil de taille doit flusher immédiatement"
    b.close(returncode=0, duration_ms=1, timed_out=False)


def test_batcher_timer_flush(server_loop):
    ctx = FakeCtx()
    b = bridge._ShellStreamBatcher(ctx)
    _on_bridge(b.add, "stdout", b"tiny")     # < seuil → timer 150 ms
    import time as _t
    _t.sleep(bridge._SHELL_STREAM_FLUSH_DELAY_S + 0.25)
    assert ctx.calls, "le timer 150 ms doit flusher sans close()"
    b.close(returncode=0, duration_ms=1, timed_out=False)


def test_batcher_live_cap_sets_truncated(server_loop):
    ctx = FakeCtx()
    b = bridge._ShellStreamBatcher(ctx)
    blob = b"y" * 30_000
    for _ in range(4):                       # 120 Ko > cap 64 Ko
        _on_bridge(b.add, "stdout", blob)
    b.close(returncode=0, duration_ms=1, timed_out=False)
    p = ctx.payloads()
    done = p[-1]
    assert done["live_truncated"] is True
    streamed = sum(len(c.get("chunk") or "") for c in p if not c.get("done"))
    assert streamed <= bridge._SHELL_STREAM_LIVE_CAP


def test_batcher_utf8_split_across_reads(server_loop):
    ctx = FakeCtx()
    b = bridge._ShellStreamBatcher(ctx)
    raw = "héllo café".encode("utf-8")
    _on_bridge(b.add, "stdout", raw[:2])     # coupe en plein 'é'
    _on_bridge(b.add, "stdout", raw[2:])
    b.close(returncode=0, duration_ms=1, timed_out=False)
    text = "".join(c.get("chunk") or "" for c in ctx.payloads()
                   if not c.get("done"))
    assert text == "héllo café"


def test_batcher_done_always_emitted_even_without_output(server_loop):
    ctx = FakeCtx()
    b = bridge._ShellStreamBatcher(ctx)
    b.close(returncode=124, duration_ms=9, timed_out=True)
    p = ctx.payloads()
    assert len(p) == 1
    assert p[0]["done"] is True and p[0]["timed_out"] is True


def test_close_waits_for_futures(server_loop):
    """close() ne rend la main qu'une fois toutes les notifications écrites
    (sinon le wrapper client aurait déjà effacé son log_callback)."""
    ctx = FakeCtx()
    b = bridge._ShellStreamBatcher(ctx)
    _on_bridge(b.add, "stdout", b"z" * (bridge._SHELL_STREAM_FLUSH_CHARS + 1))
    b.close(returncode=0, duration_ms=1, timed_out=False)
    # Au retour de close(), TOUT est déjà dans ctx.calls — aucune attente.
    assert ctx.payloads()[-1]["done"] is True
    assert any(not c.get("done") for c in ctx.payloads())
