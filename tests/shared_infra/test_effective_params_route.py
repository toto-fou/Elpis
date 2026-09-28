# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_effective_params_route.py — GET effective-params :
mode DÉGRADÉ (2026-07-27).

Avant : 404 pour tout modèle non local (connecteur) → le panneau sampling
était entièrement mort, alors que les overrides par chat s'appliquent sans
/props. Désormais :
- modèle non local  → 200 payload dégradé (jamais 404) ;
- ?degraded=1       → payload dégradé même pour un modèle local (le front
  l'envoie pour un modèle non chargé : lire /props le CHARGERAIT) ;
- chemin nominal inchangé pour un modèle local sans le flag.

Auth simulée en patchant ``require_user_id`` (pattern test_usage_route.py).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from llm_core._constants import LLAMA_MAX_TOOL_ITERATIONS


@pytest.fixture()
def client(monkeypatch):
    import shared_infra.llm.routes as llm_mod

    monkeypatch.setattr(llm_mod, "require_user_id", lambda request: 1)
    app = FastAPI()
    app.include_router(llm_mod.router)
    return TestClient(app), llm_mod


def test_non_local_renvoie_degrade_200(client, monkeypatch):
    c, llm_mod = client
    monkeypatch.setattr(llm_mod, "_is_local_model", lambda _m: False)

    # Preuve : le chemin nominal (réseau /props) n'est jamais invoqué.
    import llm_core._llm_params as P

    async def _boom(*_a, **_k):
        raise AssertionError("describe_effective_params ne doit pas être appelé")

    monkeypatch.setattr(P, "describe_effective_params", _boom)

    r = c.get("/api/llm/models/kimi-k2-instruct/effective-params?task=chat")
    assert r.status_code == 200
    d = r.json()
    assert d["degraded"] is True
    assert d["model_id"] == "kimi-k2-instruct"
    assert d["supports_thinking"] is None
    assert d["agent_defaults"]["max_tool_iterations"] == LLAMA_MAX_TOOL_ITERATIONS


def test_local_avec_flag_degrade(client, monkeypatch):
    c, llm_mod = client
    monkeypatch.setattr(llm_mod, "_is_local_model", lambda _m: True)

    import llm_core._llm_params as P

    async def _boom(*_a, **_k):
        raise AssertionError("degraded=1 ⇒ aucun accès /props")

    monkeypatch.setattr(P, "_get_cached_props", _boom)
    monkeypatch.setattr(P, "get_thinking_support", _boom)

    r = c.get("/api/llm/models/local-a/effective-params?task=chat&degraded=1")
    assert r.status_code == 200
    assert r.json()["degraded"] is True


def test_local_nominal_inchange(client, monkeypatch):
    c, llm_mod = client
    monkeypatch.setattr(llm_mod, "_is_local_model", lambda _m: True)

    import llm_core._llm_params as P

    async def _fake_full(model_id=None, task="chat"):
        return {"model_id": model_id, "task": task, "sentinel": "full"}

    monkeypatch.setattr(P, "describe_effective_params", _fake_full)

    r = c.get("/api/llm/models/local-a/effective-params?task=chat")
    assert r.status_code == 200
    d = r.json()
    assert d.get("sentinel") == "full"
    assert "degraded" not in d


def test_task_invalide_400_meme_non_local(client, monkeypatch):
    c, llm_mod = client
    monkeypatch.setattr(llm_mod, "_is_local_model", lambda _m: False)
    r = c.get("/api/llm/models/kimi-k2-instruct/effective-params?task=nimp")
    assert r.status_code == 400
