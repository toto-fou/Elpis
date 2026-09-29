# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_optimisation_evenements_2026_09_26.py — passe
d'optimisation du moteur d'événements (2026-09-26).

Verrouille que les optimisations ne changent RIEN au contenu livré :
  • ``_drain_coalesced`` fusionne les ``tool_call_delta`` d'un même appel
    (jamais un ``reset``, jamais deux appels différents) ;
  • le journal de run accumule des morceaux et restitue le même texte ;
  • ``FileTail.has_new`` voit l'écriture et la rotation ;
  • ``SystemEvents`` sérialise une fois pour tous les clients.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from shared_infra.observability.file_bus import FileBus
from shared_infra.runtime import chat_locks, run_journal as rj


async def _drain(events, **kw):
    from chatbot_app.routes.chats import _drain_coalesced
    q = asyncio.Queue()
    for e in events:
        q.put_nowait(e)
    q.put_nowait(None)
    return [e async for e in _drain_coalesced(q, window_ms=0, idle_ping_s=0, **kw)]


async def test_deltas_d_un_meme_appel_fusionnes():
    evs = [{"type": "tool_call_delta", "iter": 1, "index": 0, "name_delta": "write_"},
           {"type": "tool_call_delta", "iter": 1, "index": 0, "name_delta": "file"},
           {"type": "tool_call_delta", "iter": 1, "index": 0, "args_delta": '{"path":'},
           {"type": "tool_call_delta", "iter": 1, "index": 0, "args_delta": '"a"}'},
           {"type": "tool_call_delta", "iter": 1, "index": 1, "args_delta": "{}"},
           {"type": "tool_call_delta", "reset": True, "iter": 1, "index": -1},
           {"type": "tool_call_delta", "iter": 2, "index": 0, "args_delta": "x"}]
    out = await _drain(evs)
    assert out[0] == {"type": "tool_call_delta", "iter": 1, "index": 0,
                      "name_delta": "write_file", "args_delta": '{"path":"a"}'}
    assert out[1]["index"] == 1 and out[1]["args_delta"] == "{}"
    assert out[2].get("reset") is True
    assert out[3]["iter"] == 2
    assert len(out) == 4


async def test_tokens_toujours_fusionnes_avec_n():
    out = await _drain([{"type": "content_token", "text": t} for t in ("a", "b", "c")]
                       + [{"type": "final"}])
    assert out[0] == {"type": "content_token", "text": "abc", "n": 3}
    assert out[1] == {"type": "final"}


@pytest.fixture()
def _iso(tmp_path, monkeypatch):
    import time
    monkeypatch.setattr(rj, "RUN_DIR", tmp_path / "runs")
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr(rj, "_last_sweep", time.time())    # pas de balayage implicite


async def test_journal_morceaux_et_deltas(_iso):
    j = rj.RunJournal(1, "c-opt", "r-opt")
    assert await j.open({})
    emis = {"type": "content_token", "text": "x"}
    j.append(emis)
    j.append({"type": "content_token", "text": "y"})
    j.append({"type": "tool_call_delta", "iter": 1, "index": 0, "args_delta": "{"})
    j.append({"type": "tool_call_delta", "iter": 1, "index": 0, "args_delta": "}"})
    await j.close("done")
    assert emis == {"type": "content_token", "text": "x"}, "l'event de l'émetteur a été muté"
    evs = [json.loads(l)["e"] for l in open(j.path, encoding="utf-8")]
    types = [e["type"] for e in evs]
    assert types == ["run_started", "content_token", "tool_call_delta", "run_end"]
    assert evs[1]["text"] == "xy" and evs[1]["n"] == 2 and "_parts" not in evs[1]
    assert evs[2]["args_delta"] == "{}" and "_parts" not in evs[2]


def test_has_new_voit_ecriture_et_rotation(tmp_path):
    bus = FileBus(tmp_path / "ev.jsonl", max_bytes=50)
    t = bus.tail()
    assert t.has_new() is False
    bus.append({"a": 1})
    assert t.has_new() is True
    assert t.read_new() == [{"a": 1}]
    assert t.has_new() is False
    for i in range(5):
        bus.append({"n": i})                     # rotations (seuil 50 o)
    assert t.has_new() is True
    assert [m["n"] for m in t.read_new()] == [0, 1, 2, 3, 4]


async def test_system_events_serialise_une_fois(monkeypatch):
    from shared_infra.observability import events_bus as EB
    appels = {"n": 0}
    vrai = EB.json.dumps

    def compte(*a, **k):
        appels["n"] += 1
        return vrai(*a, **k)
    bus = EB.SystemEvents()
    qs = [asyncio.Queue() for _ in range(5)]
    for _i, q in enumerate(qs):
        bus.clients[q] = {"staff": False, "uid": None}
    monkeypatch.setattr(EB.json, "dumps", compte)
    await bus._fanout({"type": "restart", "message": "m"})
    assert appels["n"] == 1
    assert all(q.get_nowait() == '{"type": "restart", "message": "m"}' for q in qs)
