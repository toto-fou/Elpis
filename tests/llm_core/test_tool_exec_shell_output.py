# SPDX-License-Identifier: MIT
"""Live shell — traduction des notifications MCP en événements ``shell_output``.

Le bridge exec émet la sortie incrémentale d'``execute_shell`` en
``ctx.info(json({"__shell_output__": ...}), logger_name="shell_output")``.
Côté client, ``execute_tool_batch._log_cb`` doit :
  * déballer l'enveloppe LogData fastmcp 3.x (``{"msg": str, "extra": ...}``)
    comme la forme brute (str) ;
  * traduire les payloads sentinelle en events ``{"type": "shell_output"}``
    (whitelist de champs, jamais de tool_log en doublon) ;
  * laisser passer tout le reste en ``tool_log`` inchangé (JSON malformé
    inclus).
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from llm_core.engine.tool_exec import execute_tool_batch


def _prep(name="execute_shell"):
    return {"call_id": "c1", "tool_name": name, "final_args": {}, "meta": None}


async def _noop_snapshot():
    pass


def _shell_payload(**pl):
    return json.dumps({"__shell_output__": pl}, ensure_ascii=False)


async def _run_with_log_params(params_list, tool_name="execute_shell"):
    """Exécute un batch d'un seul outil dont l'exec invoque ``log_callback``
    avec chaque ``params`` fourni ; retourne les events collectés."""
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
async def test_chunk_logdata_dict_traduit_en_shell_output():
    """Forme fastmcp 3.x : data = {"msg": <json sentinelle>, "extra": null}."""
    msg = _shell_payload(stream="stdout", chunk="hello\n", seq=1, done=False)
    params = SimpleNamespace(level="info", logger="shell_output",
                             data={"msg": msg, "extra": None})
    events = await _run_with_log_params([params])
    shell = [e for e in events if e["type"] == "shell_output"]
    assert len(shell) == 1
    assert shell[0]["name"] == "execute_shell"
    assert shell[0]["stream"] == "stdout"
    assert shell[0]["chunk"] == "hello\n"
    assert shell[0]["seq"] == 1
    assert shell[0]["done"] is False
    # jamais de tool_log en doublon pour une notification shell
    assert not [e for e in events if e["type"] == "tool_log"]


@pytest.mark.asyncio
async def test_done_event_raw_string_data():
    """Forme brute (fastmcp plus ancien) : data = str JSON sentinelle."""
    msg = _shell_payload(done=True, seq=7, returncode=0, duration_ms=1500,
                         timed_out=False, bytes_total=42, live_truncated=False)
    params = SimpleNamespace(level="info", logger="shell_output", data=msg)
    events = await _run_with_log_params([params])
    shell = [e for e in events if e["type"] == "shell_output"]
    assert len(shell) == 1
    ev = shell[0]
    assert ev["done"] is True and ev["returncode"] == 0
    assert ev["duration_ms"] == 1500 and ev["live_truncated"] is False
    assert "chunk" not in ev


@pytest.mark.asyncio
async def test_champs_inconnus_filtres():
    """Whitelist : un champ non prévu dans le payload n'atteint pas le front."""
    msg = json.dumps({"__shell_output__": {
        "stream": "stderr", "chunk": "x", "seq": 2, "done": False,
        "malicious": "<script>", "type": "final",   # tentative d'écrasement
    }})
    params = SimpleNamespace(level="info", logger="shell_output", data=msg)
    events = await _run_with_log_params([params])
    ev = [e for e in events if e["type"] == "shell_output"][0]
    assert ev["type"] == "shell_output"          # non écrasé
    assert "malicious" not in ev


@pytest.mark.asyncio
async def test_json_malforme_retombe_en_tool_log():
    params = SimpleNamespace(level="info", logger="shell_output",
                             data='{"__shell_output__": {broken')
    events = await _run_with_log_params([params])
    assert not [e for e in events if e["type"] == "shell_output"]
    logs = [e for e in events if e["type"] == "tool_log"]
    assert len(logs) == 1


@pytest.mark.asyncio
async def test_tool_log_generique_deballe_logdata():
    """Bonus : un ctx.info ordinaire enveloppé LogData doit afficher le msg,
    pas le dict ``{"msg": ..., "extra": null}`` sérialisé."""
    params = SimpleNamespace(level="info", logger="",
                             data={"msg": "shell → container: ls", "extra": None})
    events = await _run_with_log_params([params])
    logs = [e for e in events if e["type"] == "tool_log"]
    assert len(logs) == 1
    assert logs[0]["message"] == "shell → container: ls"
