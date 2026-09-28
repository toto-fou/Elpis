# SPDX-License-Identifier: MIT
"""tests/chatbot/test_chat_title_llm.py — titre de chat par le modèle courant.

Contrat de ``_generate_chat_title`` (adaptation OpenCode title.txt) :
- appel du modèle COURANT, thinking OFF, max_tokens 24, entrée TRONQUÉE ;
- nettoyage (1re ligne, quotes/ponctuation finale) et bornes (3..80 → cap 60) ;
- best-effort : sortie douteuse, exception ou timeout → None (l'appelant garde
  le titre tronqué historique).
"""
from __future__ import annotations

import asyncio

import pytest

import chatbot_app.routes.chats as chats_mod


def _fake_stream(reply: str, captured: dict):
    async def fake(msgs, **kw):
        captured["msgs"] = msgs
        captured["kw"] = kw
        return "", reply, {"usage": {}}
    return fake


async def test_titre_nominal_tronque_et_nettoye(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens",
                        _fake_stream('  "Migration Postgres 16 du service auth."  \n(ignore)', captured))
    t = await chats_mod._generate_chat_title("qwen", "u" * 2000, "a" * 2000,
                                             chat_id="c-abc")
    assert t == "Migration Postgres 16 du service auth"
    # Entrée TRONQUÉE (600/240) + thinking OFF + petit budget de génération.
    user_msg = captured["msgs"][-1]["content"]
    assert len(user_msg) <= 600 + 240 + 60
    assert captured["kw"]["thinking_mode"] is False
    assert captured["kw"]["sampling_override"]["max_tokens"] == 24
    assert captured["kw"]["model_override"] == "qwen"
    # chat_id forwardé (tap Trafic LLM + slot pinning du début de tour).
    assert captured["kw"]["chat_id"] == "c-abc"
    # … mais HORS du slot du chat : le titre en évinçait le KV (OPTIM 2026-09-26).
    assert captured["kw"]["slot_avoid_own"] is True


@pytest.mark.parametrize("bad", ["", "  ", "ok", "<think>hmm</think>", "x" * 200])
async def test_sorties_douteuses_fallback(monkeypatch, bad):
    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens",
                        _fake_stream(bad, {}))
    assert await chats_mod._generate_chat_title("m", "question", "") is None


async def test_exception_et_timeout_fallback(monkeypatch):
    async def boom(*_a, **_k):
        raise RuntimeError("down")

    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens", boom)
    assert await chats_mod._generate_chat_title("m", "question", "") is None

    async def slow(*_a, **_k):
        await asyncio.sleep(30)

    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens", slow)
    monkeypatch.setattr(chats_mod.asyncio, "wait_for",
                        lambda coro, timeout: asyncio.wait_for(coro, 0.05))
    assert await chats_mod._generate_chat_title("m", "question", "") is None


async def test_entree_vide_none(monkeypatch):
    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens",
                        _fake_stream("Titre", {}))
    assert await chats_mod._generate_chat_title("m", "", "") is None
