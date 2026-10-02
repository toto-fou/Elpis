# SPDX-License-Identifier: MIT
"""
tests/chatbot/test_run_resume_2026_09_16.py — se RATTACHER à un run en cours
(chantier C, 2026-09-16).

Bug d'origine : revenir sur une conversation qui génère encore n'affichait
qu'un toast « génération en cours » — ni bulle, ni étapes, ni Stop. Ce qui est
verrouillé ici, au niveau des routes :
  - ``/api/chat/{id}/run/events`` rejoue TOUT le run puis suit le direct, sans
    trou ni doublon, et se termine sur ``run_end`` ;
  - un run dont plus aucun worker ne tient le verrou sans s'être terminé est
    signalé ``run_lost`` (le client recharge au lieu d'attendre à vie) ;
  - un compte ne lit jamais le run d'un autre ;
  - ``/generation-status`` rend de quoi se rattacher, et dit « fini » dès que
    le journal est clos (R12 : plus de faux « en cours » pendant la
    télémétrie post-final) ;
  - ``/api/chats/active-runs`` liste les runs vivants ;
  - un run reprenable est DÉTACHÉ à la déconnexion, outils ou non.
"""
from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request

from shared_infra.runtime import chat_locks, run_journal as rj
from tests._routes_chat import monter_routes_chat


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(rj, "RUN_DIR", tmp_path / "runs")
    monkeypatch.setattr(rj, "_last_sweep", time.time())
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    return monter_routes_chat(monkeypatch, _fake_uid)


def _client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", timeout=20.0)


H1 = {"x-test-user": "1"}


async def _lire_flux(client, url, headers, stop_types=("run_end", "run_lost")):
    out = []
    async with client.stream("GET", url, headers=headers) as r:
        assert r.status_code == 200
        async for line in r.aiter_lines():
            if not line.strip():
                continue
            ev = json.loads(line)
            out.append(ev)
            if ev.get("type") in stop_types:
                break
    return out


async def test_rejeu_puis_direct_sans_trou_ni_doublon(app):
    j = rj.RunJournal(1, "chatA", "run1", meta={"base_count": 2, "user_message": "q"})
    assert await j.open({"chat_id": "chatA"})
    fd = chat_locks.acquire("gen", 1, "chatA")
    for i in range(5):
        j.append({"type": "tool_call", "name": f"avant{i}"})
    await asyncio.sleep(0.3)                       # déjà écrit : partie REJOUÉE

    async def _producteur():
        await asyncio.sleep(0.4)                   # le lecteur est en DIRECT
        for i in range(5):
            j.append({"type": "tool_call", "name": f"apres{i}"})
            await asyncio.sleep(0.05)
        j.append({"type": "final", "assistant": "ok"})
        await j.close("done")

    try:
        async with _client(app) as c:
            prod = asyncio.create_task(_producteur())
            evs = await _lire_flux(c, "/api/chat/chatA/run/events?run_id=run1", H1)
            await prod
    finally:
        chat_locks.release(fd)
    noms = [e.get("name") for e in evs if e.get("type") == "tool_call"]
    assert noms == [f"avant{i}" for i in range(5)] + [f"apres{i}" for i in range(5)]
    types = [e["type"] for e in evs]
    assert types[0] == "run_started"
    assert "replay_done" in types and types.index("replay_done") < types.index("final")
    assert types[-1] == "run_end"
    seqs = [e["_s"] for e in evs if "_s" in e]
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs))


async def test_reprise_depuis_un_numero(app):
    j = rj.RunJournal(1, "chatB", "run2")
    assert await j.open({})
    for i in range(4):
        j.append({"type": "tool_call", "name": f"t{i}"})
    await j.close("done")
    async with _client(app) as c:
        evs = await _lire_flux(c, "/api/chat/chatB/run/events?run_id=run2&from=4", H1)
    assert [e.get("name") for e in evs if e["type"] == "tool_call"] == ["t2", "t3"]


async def test_run_perdu_quand_plus_aucun_worker_ne_le_porte(app):
    j = rj.RunJournal(1, "chatC", "run3")
    assert await j.open({})
    j.append({"type": "tool_call", "name": "x"})
    await asyncio.sleep(0.3)
    async with _client(app) as c:
        t0 = time.monotonic()
        evs = await _lire_flux(c, "/api/chat/chatC/run/events?run_id=run3", H1)
    assert evs[-1]["type"] == "run_lost"
    assert time.monotonic() - t0 < 10, "le client attendrait indéfiniment"


async def test_un_compte_ne_lit_pas_le_run_dun_autre(app):
    j = rj.RunJournal(1, "chatD", "run4")
    assert await j.open({})
    await j.close("done")
    async with _client(app) as c:
        r = await c.get("/api/chat/chatD/run/events?run_id=run4", headers={"x-test-user": "2"})
        assert r.status_code == 404
        r = await c.get("/api/chat/chatD/run/events?run_id=autre", headers=H1)
        assert r.status_code == 404


async def test_statut_de_generation_pour_se_rattacher(app):
    j = rj.RunJournal(1, "chatE", "run5", meta={"base_count": 4, "user_message": "fais-le",
                                                "is_continue": False, "engine_key": "conn:3"})
    assert await j.open({})
    fd = chat_locks.acquire("gen", 1, "chatE")
    try:
        async with _client(app) as c:
            d = (await c.get("/api/chat/chatE/generation-status", headers=H1)).json()
            assert d["generation_running"] is True and d["resumable"] is True
            assert d["run_id"] == "run5" and d["base_count"] == 4
            assert d["user_message"] == "fais-le" and d["engine_key"] == "conn:3"
            runs = (await c.get("/api/chats/active-runs", headers=H1)).json()
            assert runs["chat_ids"] == ["chatE"]
            # Le tour est fini (final → run_end) alors que le worker tient encore
            # le verrou pour sa télémétrie : « fini » tout de suite.
            await j.close("done")
            d = (await c.get("/api/chat/chatE/generation-status", headers=H1)).json()
            assert d["generation_running"] is False and d["resumable"] is False
            runs = (await c.get("/api/chats/active-runs", headers=H1)).json()
            assert runs["chat_ids"] == []
    finally:
        chat_locks.release(fd)


def test_un_run_reprenable_est_detache_a_la_deconnexion():
    """Quitter la conversation laisse le tour se terminer (décision 2026-09-16),
    même sans outil ; Stop reste un arrêt."""
    from chatbot_app.turn.execution import _should_detach_run
    assert _should_detach_run(detach_enabled=True, task_done=False,
                                 user_stopped=False, tools_ran=False) is True
    assert _should_detach_run(detach_enabled=True, task_done=False,
                                 user_stopped=True, tools_ran=True) is False
    from tests._sources import source_flux_chat
    src = source_flux_chat()
    assert "detach_enabled=(_detach_on_disconnect or _resumable)" in src
    assert '_resumable = bool(data.get("resumable", False)) and not ephemeral' in src
