# SPDX-License-Identifier: MIT
"""tests/llm_core/test_watch.py — watcher contexte/perf (LLAMA_WATCH).

Couvre : gating env (inactif = zéro écriture), records llm_call (tailles par
message, flag élagué, ratio KV depuis prompt_n réel, stats fit) et tool,
contenu tronqué par défaut / complet avec LLAMA_WATCH_FULL, rapport CLI.
"""
from __future__ import annotations

import json
import os

import pytest

import llm_core._watch as W


@pytest.fixture
def watch_env(tmp_path, monkeypatch):
    monkeypatch.setenv("LLAMA_WATCH", "1")
    monkeypatch.setenv("LLAMA_WATCH_DIR", str(tmp_path))
    monkeypatch.delenv("LLAMA_WATCH_FULL", raising=False)
    # Reset du handle module (fichier par jour/PID) entre tests.
    W._FH = None
    W._FH_DAY = None
    yield tmp_path
    W._FH = None
    W._FH_DAY = None


def _records(tmp_path):
    out = []
    for p in sorted(tmp_path.glob("watch-*.ndjson")):
        for line in p.read_text(encoding="utf-8").splitlines():
            out.append(json.loads(line))
    return out


def test_inactif_zero_ecriture(tmp_path, monkeypatch):
    monkeypatch.delenv("LLAMA_WATCH", raising=False)
    monkeypatch.setenv("LLAMA_WATCH_DIR", str(tmp_path))
    W._FH = None
    W.watch_llm_call(chat_id="c", path="tools", iteration=1, model="m",
                     messages=[{"role": "user", "content": "x"}],
                     tools_payload=None, usage={}, timings={})
    W.watch_tool_call(chat_id="c", iteration=1, tool="t", args_chars=1,
                      result_chars=1, duration_ms=1, status="ok")
    assert list(tmp_path.glob("*.ndjson")) == []


def test_llm_call_record_complet(watch_env):
    pruned_content = ("head\n…[1234 chars omitted — tool history "
                      "compaction]…\ntail")
    msgs = [
        {"role": "system", "content": "SOCLE " * 50},
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "grep", "arguments": '{"q":"x"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": pruned_content},
    ]
    W.watch_llm_call(
        chat_id="chat42", path="tools", iteration=3, model="qwen",
        messages=msgs, tools_payload=[{"type": "function",
                                       "function": {"name": "grep", "parameters": {}}}],
        usage={"prompt_tokens": 1000, "completion_tokens": 20},
        timings={"prompt_n": 150, "prompt_ms": 80.5, "predicted_n": 20},
        fit={"fastpath": True, "dropped": 0, "pruned_new": 1, "pruned_memo": 4},
    )
    recs = _records(watch_env)
    assert len(recs) == 1
    r = recs[0]
    assert (r["kind"], r["chat"], r["path"], r["iter"]) == ("llm_call", "chat42", "tools", 3)
    assert r["n_msgs"] == 4 and r["head_chars"] == len("SOCLE " * 50)
    # Le tool_result élagué est étiqueté, et le contenu est TRONQUÉ par défaut.
    tool_entry = next(e for e in r["msgs"] if e.get("role") == "tool")
    assert tool_entry["pruned"] is True and tool_entry["tcid"] == "c1"
    assert "content" not in tool_entry and len(tool_entry["head"]) <= 160
    # tool_calls de l'assistant résumés (nom + taille d'arguments).
    asst = next(e for e in r["msgs"] if e.get("tool_calls"))
    assert asst["tool_calls"] == [{"name": "grep", "args_chars": len('{"q":"x"}')}]
    # KV : ratio depuis le prompt_n RÉEL (1000 soumis, 150 re-préfillés).
    assert r["kv"] == {"reused": 850, "ratio": 0.85}
    assert r["fit"]["fastpath"] is True
    assert r["tools"]["n"] == 1 and r["tools"]["chars"] > 0


def test_full_content_opt_in(watch_env, monkeypatch):
    monkeypatch.setenv("LLAMA_WATCH_FULL", "1")
    W.watch_llm_call(chat_id="c", path="classic", iteration=None, model="m",
                     messages=[{"role": "user", "content": "x" * 500}],
                     tools_payload=None,
                     usage={"prompt_tokens": 5, "completion_tokens": 1},
                     timings={})
    r = _records(watch_env)[0]
    assert r["msgs"][0]["content"] == "x" * 500     # complet, pas de head


def test_tool_record_et_report(watch_env):
    W.watch_tool_call(chat_id="chat42", iteration=2, tool="read_file",
                      args_chars=30, result_chars=18_000, duration_ms=42,
                      status="ok")
    W.watch_llm_call(
        chat_id="chat42", path="tools", iteration=2, model="m",
        messages=[{"role": "user", "content": "y"}], tools_payload=None,
        usage={"prompt_tokens": 2000, "completion_tokens": 10},
        timings={"prompt_n": 500, "prompt_ms": 100.0},
    )
    recs = _records(watch_env)
    assert {r["kind"] for r in recs} == {"tool", "llm_call"}

    files = [str(p) for p in watch_env.glob("*.ndjson")]
    txt = W.report(files)
    assert "chat42" in txt
    assert "read_file" in txt and "18.0k" in txt
    assert "cache KV" in txt and "75 %" in txt      # 1500/2000 réutilisés


def test_multimodal_et_vision_pruned(watch_env):
    W.watch_llm_call(
        chat_id="c", path="tools", iteration=1, model="m",
        messages=[{"role": "user", "content": [
            {"type": "text", "text": "regarde"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
            {"type": "text", "text": "[previous screenshot elided to save context]"},
        ]}],
        tools_payload=None, usage={}, timings={},
    )
    e = _records(watch_env)[0]["msgs"][0]
    assert e["imgs"] == 1 and e["vision_pruned"] is True
