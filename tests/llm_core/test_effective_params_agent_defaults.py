# SPDX-License-Identifier: MIT
"""
describe_effective_params expose désormais les DÉFAUTS agent/reasoning réels
(config backend) sous la clé `agent_defaults`, pour que le panneau sampling
n'affiche plus de littéraux figés (« défaut 50 » / « 8192 » codés en dur).

On mocke les deux dépendances réseau (`_get_cached_props`, `get_thinking_support`)
pour rester hors-ligne (cf. suite llm_core).
"""

import llm_core._llm_params as P
from llm_core._constants import (
    LLAMA_MAX_TOOL_ITERATIONS,
    LLAMA_THINKING_BUDGET_TOKENS,
)


async def _no_network(monkeypatch, *, props=None, thinking=False):
    async def _fake_props(_model_id, **_k):
        return dict(props or {"temperature": 0.7, "top_p": 0.9})

    async def _fake_thinking(_model_id, **_k):
        return thinking

    monkeypatch.setattr(P, "_get_cached_props", _fake_props)
    monkeypatch.setattr(P, "get_thinking_support", _fake_thinking)


async def test_agent_defaults_reflect_backend_config(monkeypatch):
    await _no_network(monkeypatch, thinking=True)

    out = await P.describe_effective_params("some-model", task="chat")

    # La clé existe et reporte les vraies valeurs config (pas des littéraux UI).
    assert "agent_defaults" in out
    assert out["agent_defaults"]["max_tool_iterations"] == LLAMA_MAX_TOOL_ITERATIONS
    assert out["agent_defaults"]["thinking_budget_tokens"] == LLAMA_THINKING_BUDGET_TOKENS


async def test_agent_defaults_present_even_without_thinking(monkeypatch):
    # Les défauts agent sont indépendants du support reasoning du modèle.
    await _no_network(monkeypatch, thinking=False)

    out = await P.describe_effective_params("plain-model", task="chat")

    assert out["supports_thinking"] is False
    assert out["agent_defaults"]["max_tool_iterations"] == LLAMA_MAX_TOOL_ITERATIONS
    # max_tool_iterations / thinking_budget ne fuient PAS dans `effective`
    # (hors ALLOWED_SAMPLING_KEYS) — on n'expose qu'un défaut.
    assert "max_tool_iterations" not in out["effective"]
    assert "thinking_budget_tokens" not in out["effective"]


# ── Mode DÉGRADÉ (2026-07-27) : panneau sampling sans /props ─────────────────

def _forbid_network(monkeypatch):
    """Preuve d'invariant : la variante dégradée ne touche NI /props NI la
    détection thinking (lire /props d'un modèle non chargé le CHARGERAIT)."""
    async def _boom(*_a, **_k):
        raise AssertionError("degraded ne doit faire AUCUN accès réseau")

    monkeypatch.setattr(P, "_get_cached_props", _boom)
    monkeypatch.setattr(P, "get_thinking_support", _boom)


def test_degraded_shape_et_zero_reseau(monkeypatch):
    _forbid_network(monkeypatch)

    out = P.describe_effective_params_degraded("kimi-k2-instruct", task="chat")

    assert out["degraded"] is True
    assert out["model_id"] == "kimi-k2-instruct"
    assert out["supports_thinking"] is None          # inconnu sans /props
    assert out["sources"]["props"] == {}             # colonne « modèle » vide
    # Les défauts agent restent servis (config backend, pas le modèle).
    assert out["agent_defaults"]["max_tool_iterations"] == LLAMA_MAX_TOOL_ITERATIONS
    assert out["agent_defaults"]["thinking_budget_tokens"] == LLAMA_THINKING_BUDGET_TOKENS


def test_degraded_profil_de_tache_conserve(monkeypatch):
    _forbid_network(monkeypatch)

    out = P.describe_effective_params_degraded("local-x", task="tools")

    # Le profil de tâche (config locale, sans réseau) reste exposé : mêmes
    # clés que le chemin nominal pour que l'UI ne change pas de forme.
    assert out["task"] == "tools"
    assert out["sources"]["task_profile"] == P.TASK_PROFILES.get("tools", {})
    assert set(out["effective"]) == set(out["param_sources"])
    assert all(v == "task_profile" for v in out["param_sources"].values())
