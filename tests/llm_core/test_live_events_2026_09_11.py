# SPDX-License-Identifier: MIT
"""P3 (2026-09-11) — événements live STANDARDISÉS : notifications MCP
structurées (``ctx.log(extra=…)``) pour le terminal en direct, battement
pendant une exécution silencieuse, sortie live des scripts de skills, et
preuve bout-en-bout sur un VRAI transport HTTP streamable."""
from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest
from fastmcp import Context, FastMCP  # au niveau module : annotations-chaînes des outils

# ── Faux contextes ──────────────────────────────────────────────────────────

class _CtxStructured:
    """Context fastmcp 3.x : ``log(message, level, logger_name, extra)``."""
    def __init__(self, meta=None):
        self.request_context = SimpleNamespace(meta=meta or {})
        self.calls: List[Dict[str, Any]] = []

    async def log(self, message, level=None, logger_name=None, extra=None):
        self.calls.append({"message": message, "level": level,
                           "logger": logger_name, "extra": dict(extra or {})})

    async def info(self, message, logger_name=None):
        self.calls.append({"message": message, "logger": logger_name, "extra": None})


class _CtxLegacy:
    """Context ancien : ``log`` sans ``extra`` → TypeError → repli ``info``."""
    def __init__(self, meta=None):
        self.request_context = SimpleNamespace(meta=meta or {})
        self.calls: List[Dict[str, Any]] = []

    async def log(self, message, level=None, logger_name=None):
        raise AssertionError("ne doit pas être appelé sans extra")

    async def info(self, message, logger_name=None):
        self.calls.append({"message": message, "logger": logger_name})


@pytest.fixture
def server_loop():
    from llm_core.tools import _toolkit as tk
    loop = asyncio.new_event_loop()
    tk.register_server_loop(loop)
    t = threading.Thread(target=loop.run_forever, daemon=True); t.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop); t.join(timeout=2)
    tk.register_server_loop(None)


def _wait_calls(ctx, n, timeout=2.0):
    t0 = time.monotonic()
    while len(ctx.calls) < n and time.monotonic() - t0 < timeout:
        time.sleep(0.02)
    return ctx.calls


# ── 1. Le batcher émet des notifications STRUCTURÉES ────────────────────────

def test_batcher_emet_extra_structure(server_loop):
    from llm_core.tools._exec_bridge import _ShellStreamBatcher
    from llm_core.tools._toolkit import LIVE_KIND_SHELL, LIVE_LOGGER_SHELL
    ctx = _CtxStructured({"call_id": "call_1", "log_token": "run:call_1"})
    b = _ShellStreamBatcher(ctx)
    asyncio.run_coroutine_threadsafe(asyncio.sleep(0), server_loop).result()
    # add() attend une loop courante : on l'appelle depuis la loop du bridge
    from llm_core.tools._exec_bridge import _get_bridge_loop
    bl = _get_bridge_loop()
    asyncio.run_coroutine_threadsafe(_run_add(b, "stdout", b"hello\n"), bl).result(2)
    b.close(returncode=0, duration_ms=12, timed_out=False)
    calls = _wait_calls(ctx, 2)
    kinds = [c["extra"].get("kind") for c in calls]
    assert kinds == [LIVE_KIND_SHELL, LIVE_KIND_SHELL]
    chunk, done = calls[0]["extra"], calls[1]["extra"]
    assert calls[0]["logger"] == LIVE_LOGGER_SHELL and calls[0]["level"] == "info"
    assert chunk["chunk"] == "hello\n" and chunk["stream"] == "stdout" and chunk["seq"] == 1
    assert chunk["call_id"] == "call_1" and chunk["log_token"] == "run:call_1"
    assert done["done"] is True and done["returncode"] == 0 and done["seq"] == 2
    # plus de JSON dans le message
    assert "__shell_output__" not in calls[0]["message"]


async def _run_add(b, stream, data):
    b.add(stream, data)
    b._flush()


def test_batcher_repli_sentinelle_json_pour_un_context_ancien(server_loop):
    from llm_core.tools._exec_bridge import _get_bridge_loop, _ShellStreamBatcher
    ctx = _CtxLegacy({"call_id": "c9"})
    b = _ShellStreamBatcher(ctx)
    asyncio.run_coroutine_threadsafe(_run_add(b, "stderr", b"x"), _get_bridge_loop()).result(2)
    calls = _wait_calls(ctx, 1)
    payload = json.loads(calls[0]["message"])["__shell_output__"]
    assert payload["chunk"] == "x" and payload["call_id"] == "c9"


# ── 2. Routeur + traduction côté client ─────────────────────────────────────

def _params(extra=None, msg="shell_output", logger="elpis.shell"):
    return SimpleNamespace(level="info", logger=logger, data={"msg": msg, "extra": extra})


def test_routeur_lit_extra_puis_le_repli_legacy():
    from llm_core._mcp_wrappers import _LogRouter
    r = _LogRouter()
    got = []
    r.register("run:call_1", "execute_shell", lambda p: got.append(("a", p)))
    r.register("run:call_2", "execute_shell", lambda p: got.append(("b", p)))
    cb = r.resolve(_params({"kind": "shell_output", "log_token": "run:call_2", "chunk": "z"}))
    assert cb is not None and cb.__call__ and cb(None) is None and got[-1][0] == "b"
    cb = r.resolve(_params({"kind": "heartbeat", "call_id": "call_1", "log_token": "run:call_1",
                            "elapsed_s": 15}, logger="elpis.heartbeat"))
    assert cb is not None and cb(None) is None and got[-1][0] == "a"
    # un battement sans jeton de run ne DEVINE pas son destinataire (deux comptes
    # peuvent porter le même call_id) → jeté
    assert r.resolve(_params({"kind": "heartbeat", "call_id": "call_1"}, logger="elpis.heartbeat")) is None
    # identifiant inconnu → jeté, jamais attribué à un voisin
    assert r.resolve(_params({"kind": "shell_output", "log_token": "run:call_9"})) is None
    # legacy : JSON dans le message
    legacy = SimpleNamespace(level="info", logger="shell_output",
                             data={"msg": json.dumps({"__shell_output__": {"log_token": "run:call_1"}}), "extra": None})
    cb = r.resolve(legacy)
    assert cb is not None and cb(None) is None and got[-1][0] == "a"


def _prep(name="execute_shell"):
    return {"call_id": "c1", "tool_name": name, "final_args": {}, "meta": None}


async def _noop_snapshot():
    pass


async def _run_with_log_params(params_list, tool_name="execute_shell"):
    """Même montage que test_tool_exec_shell_output : un lot d'un outil dont
    l'exec invoque ``log_callback`` avec chaque ``params`` ; events collectés."""
    from llm_core.engine.tool_exec import execute_tool_batch
    events = []

    async def on_event(ev):
        events.append(ev)

    async def _exec(name, args, *, meta=None, log_callback=None, **kw):
        for p in params_list:
            await log_callback(p)
        return json.dumps({"ok": True})

    await execute_tool_batch(
        [_prep(tool_name)], execute_single=_exec,
        record_metric=lambda *a, **k: None,
        is_tool_failure=lambda r: False,
        on_event=on_event, username="u", chat_id="c1",
        on_cancel_snapshot=_noop_snapshot, iteration=0,
        emit_progress_log=True,
    )
    return events


@pytest.mark.asyncio
async def test_log_cb_traduit_extra_et_jette_le_battement():
    """``extra.kind=shell_output`` → event ``shell_output`` porteur du call_id
    du lot ; ``heartbeat`` → AUCUN événement ; legacy JSON → idem qu'avant."""
    events = await _run_with_log_params([
        _params({"kind": "heartbeat", "call_id": "c1", "elapsed_s": 15}, logger="elpis.heartbeat"),
        _params({"kind": "shell_output", "stream": "stdout", "chunk": "a\n", "seq": 1,
                 "done": False, "call_id": "c1", "log_token": "r:c1", "inconnu": "x"}),
        _params({"kind": "shell_output", "done": True, "seq": 2, "returncode": 0,
                 "duration_ms": 5, "call_id": "c1"}),
        SimpleNamespace(level="info", logger="shell_output",
                        data={"msg": json.dumps({"__shell_output__": {"stream": "stderr", "chunk": "legacy", "seq": 3}}),
                              "extra": None}),
        SimpleNamespace(level="warning", logger="x", data={"msg": "plain log", "extra": None}),
    ])
    shell = [e for e in events if e.get("type") == "shell_output"]
    assert [e.get("chunk") for e in shell] == ["a\n", None, "legacy"]
    assert shell[0]["call_id"] == "c1" and shell[0]["stream"] == "stdout" and "inconnu" not in shell[0] \
        and "log_token" not in shell[0]
    assert shell[1]["done"] is True and shell[1]["returncode"] == 0
    logs = [e for e in events if e.get("type") == "tool_log"]
    assert [l["message"] for l in logs] == ["plain log"]           # le battement ne produit rien


# ── 3. Battement pendant une exécution silencieuse ──────────────────────────

def test_battement_pendant_une_execution_silencieuse(server_loop, monkeypatch):
    from llm_core.tools import _toolkit as tk
    from llm_core.tools._toolkit import LIVE_KIND_HEARTBEAT, LIVE_LOGGER_HEARTBEAT, Heartbeat
    ctx = _CtxStructured({"call_id": "call_7", "log_token": "run:call_7"})
    with Heartbeat(ctx, interval_s=0.05) as hb:
        time.sleep(0.3)
    calls = _wait_calls(ctx, 2)
    assert hb.ticks >= 2 and len(calls) >= 2
    x = calls[0]["extra"]
    assert x["kind"] == LIVE_KIND_HEARTBEAT and x["call_id"] == "call_7" and x["log_token"] == "run:call_7"
    assert calls[0]["logger"] == LIVE_LOGGER_HEARTBEAT and "elapsed_s" in x
    n = len(ctx.calls); time.sleep(0.2)
    assert len(ctx.calls) == n                             # arrêté avec le bloc


def test_battement_desactive_sans_context_ou_intervalle_nul():
    from llm_core.tools._toolkit import Heartbeat
    hb = Heartbeat(None).start(); hb.stop()
    assert hb.ticks == 0
    ctx = _CtxStructured({})
    hb = Heartbeat(ctx, interval_s=0).start(); time.sleep(0.05); hb.stop()
    assert hb.ticks == 0 and ctx.calls == []


def test_le_pont_shell_et_les_attentes_longues_battent():
    src_bridge = open("llm_core/tools/_exec_bridge.py", encoding="utf-8").read()
    assert "heartbeat = Heartbeat(ctx).start() if ctx is not None else None" in src_bridge
    src_pw = open("llm_core/tools/firefox_tools.py", encoding="utf-8").read()
    assert src_pw.count("with Heartbeat(ctx):") >= 2               # pause fixe + attente conditionnelle
    src_dk = open("llm_core/tools/desktop_tools.py", encoding="utf-8").read()
    assert "with Heartbeat(ctx):" in src_dk                          # desktop_wait


# ── 4. skill_run_script streame comme execute_shell ─────────────────────────

def test_skill_run_script_passe_stream_live():
    src = open("llm_core/tools/skill_tools.py", encoding="utf-8").read()
    assert '_live = (_read_meta_field(ctx, "live_shell") == "1")' in src
    assert "stream_live=_live," in src


# ── 5. Bout-en-bout : vrai serveur FastMCP, vrai transport HTTP streamable ──

def _free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@pytest.fixture
def live_server():
    """Un FastMCP réel exposant un outil qui parle comme le pont d'exécution
    (notifications structurées + battement), servi en HTTP streamable."""
    import uvicorn

    from llm_core.tools._toolkit import (
        LIVE_KIND_HEARTBEAT,
        LIVE_KIND_SHELL,
        LIVE_LOGGER_HEARTBEAT,
        LIVE_LOGGER_SHELL,
        live_notify,
    )

    mcp = FastMCP("live-test")

    @mcp.tool
    async def chatty(ctx: Context, n: int = 3) -> dict:
        meta = getattr(ctx.request_context, "meta", None) or {}
        cid = meta.get("call_id") if isinstance(meta, dict) else getattr(meta, "call_id", None)
        tok = meta.get("log_token") if isinstance(meta, dict) else getattr(meta, "log_token", None)
        for i in range(1, n + 1):
            await live_notify(ctx, LIVE_KIND_SHELL,
                              {"stream": "stdout", "chunk": f"line {i}\n", "seq": i,
                               "done": False, "call_id": cid, "log_token": tok},
                              logger_name=LIVE_LOGGER_SHELL)
            await live_notify(ctx, LIVE_KIND_HEARTBEAT, {"elapsed_s": i, "call_id": cid, "log_token": tok},
                              logger_name=LIVE_LOGGER_HEARTBEAT)
            await asyncio.sleep(0.01)
        await live_notify(ctx, LIVE_KIND_SHELL,
                          {"done": True, "seq": n + 1, "returncode": 0, "call_id": cid, "log_token": tok},
                          logger_name=LIVE_LOGGER_SHELL)
        return {"ok": True, "lines": n}

    port = _free_port()
    app = mcp.http_app(path="/mcp")
    # ⚠ uvicorn reconfigure le logging GLOBAL (dictConfig + niveaux des loggers
    # ``uvicorn*``, dont ``uvicorn.error`` utilisé par toute l'app) : les tests
    # ``caplog`` qui suivent ne verraient plus les WARNING. On neutralise
    # ``log_config`` et on RESTAURE les niveaux à la fin.
    import logging as _logging
    _names = ("uvicorn", "uvicorn.error", "uvicorn.access")
    _levels = {n: _logging.getLogger(n).level for n in _names}
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None)
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True); t.start()
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        server.should_exit = True; t.join(timeout=5)
        for n, lvl in _levels.items():
            _logging.getLogger(n).setLevel(lvl)


def test_bout_en_bout_http_streamable_route_les_notifications(live_server):
    """Deux appels CONCURRENTS sur la même session : chaque ligne arrive à SON
    appel (par log_token), les battements sont consommés sans événement."""
    from llm_core._mcp_wrappers import MCPStreamableHTTPWrapper

    async def _go():
        got: Dict[str, List[Any]] = {"A": [], "B": []}

        def _cb_for(key):
            async def _cb(params):
                got[key].append(params)
            return _cb

        async with MCPStreamableHTTPWrapper(live_server) as w:
            tools = await w.list_tools()
            assert any(getattr(t, "name", "") == "chatty" for t in tools)
            ra, rb = await asyncio.gather(
                w.call_tool("chatty", {"n": 3}, meta={"call_id": "call_a", "log_token": "run:call_a"},
                            log_callback=_cb_for("A")),
                w.call_tool("chatty", {"n": 2}, meta={"call_id": "call_b", "log_token": "run:call_b"},
                            log_callback=_cb_for("B")),
            )
        return got

    got = asyncio.run(_go())

    def _kinds(params_list):
        out = []
        for p in params_list:
            d = getattr(p, "data", None)
            x = d.get("extra") if isinstance(d, dict) else None
            out.append(((x or {}).get("kind"), (x or {}).get("log_token"), (x or {}).get("chunk")))
        return out
    a, b = _kinds(got["A"]), _kinds(got["B"])
    assert all(tok == "run:call_a" for _, tok, _ in a) and all(tok == "run:call_b" for _, tok, _ in b)
    assert [c for k, _, c in a if k == "shell_output" and c] == ["line 1\n", "line 2\n", "line 3\n"]
    assert [c for k, _, c in b if k == "shell_output" and c] == ["line 1\n", "line 2\n"]
    assert sum(1 for k, _, _ in a if k == "heartbeat") == 3 and sum(1 for k, _, _ in b if k == "heartbeat") == 2
