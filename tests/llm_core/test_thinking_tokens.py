# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_thinking_tokens.py — La réflexion sort du total « sortie ».

Le défaut verrouillé ici : ``completion_tokens`` additionne le raisonnement,
les appels d'outils et la réponse visible, et aucune vue ne pouvait les
séparer. On vérifie l'ordre de vérité de la mesure (déclarée > tokenisée >
estimée), l'invariant « réflexion ⊆ sortie », et la décomposition exposée par
``calculate_metrics``.
"""
from __future__ import annotations

import asyncio

import pytest

from llm_core._metrics import calculate_metrics
from llm_core._think_tokens import (
    estimate_thinking_tokens,
    measure_thinking_tokens,
    native_reasoning_tokens,
)


def _run(coro):
    return asyncio.run(coro)


def _async(value):
    """Coroutine déjà résolue — remplace ``count_tokens_exact`` dans les mocks."""
    async def _c():
        return value
    return _c()


@pytest.fixture()
def remote_target(monkeypatch):
    """Cible NON locale : pas de ``/tokenize`` → chemin estimé."""
    import llm_core._target as tgt
    monkeypatch.setattr(tgt, "current_target",
                        lambda: tgt.LlmTarget(is_default=False,
                                              provider_type="generic"))
    return tgt


@pytest.fixture()
def local_target(monkeypatch):
    """Cible llama.cpp LOCALE : ``/tokenize`` autorisé."""
    import llm_core._target as tgt
    monkeypatch.setattr(tgt, "current_target",
                        lambda: tgt.LlmTarget(is_default=True,
                                              provider_type="llamacpp"))
    return tgt


# ── Lecture de ce que le backend déclare ────────────────────────────────────

def test_native_lit_le_detail_niche_et_les_cles_plates():
    assert native_reasoning_tokens(
        {"completion_tokens_details": {"reasoning_tokens": 512}}) == 512
    assert native_reasoning_tokens(
        {"output_tokens_details": {"reasoning_tokens": 7}}) == 7
    assert native_reasoning_tokens({"reasoning_tokens": 42}) == 42
    # 0 explicite = « ce tour n'a pas raisonné », PAS « non déclaré ».
    assert native_reasoning_tokens({"reasoning_tokens": 0}) == 0


def test_native_absent_ou_illisible_vaut_none():
    assert native_reasoning_tokens(None) is None
    assert native_reasoning_tokens({}) is None
    assert native_reasoning_tokens({"completion_tokens": 100}) is None
    assert native_reasoning_tokens({"reasoning_tokens": "beaucoup"}) is None
    # Un booléen n'est pas un compte, même si Python le tolère en int.
    assert native_reasoning_tokens({"reasoning_tokens": True}) is None


# ── Ordre de vérité ─────────────────────────────────────────────────────────

def test_declare_par_le_backend_prime_et_nest_pas_estime(remote_target):
    n, est = _run(measure_thinking_tokens(
        "peu importe le texte",
        usage={"completion_tokens_details": {"reasoning_tokens": 300}},
        output_tokens=1000))
    assert (n, est) == (300, False)


def test_tokenize_local_donne_un_compte_exact(local_target, monkeypatch):
    import llm_core._llama_http as http
    monkeypatch.setattr(http, "count_tokens_exact",
                        lambda *a, **k: _async(123))
    n, est = _run(measure_thinking_tokens("blabla de raisonnement",
                                          model_id="qwen", output_tokens=400))
    assert (n, est) == (123, False)


def test_cible_distante_estime_et_le_dit(remote_target):
    texte = "x" * 330
    n, est = _run(measure_thinking_tokens(texte, output_tokens=5000))
    assert est is True
    assert n == estimate_thinking_tokens(texte)
    assert n > 0


def test_tokenize_en_panne_retombe_sur_lestimation(local_target, monkeypatch):
    """Une panne du tokenizer ne doit pas faire disparaître le raisonnement :
    0 mentirait plus qu'une approximation."""
    import llm_core._llama_http as http

    async def _boom(*a, **k):
        raise RuntimeError("llama-server injoignable")

    monkeypatch.setattr(http, "count_tokens_exact", _boom)
    n, est = _run(measure_thinking_tokens("y" * 200, output_tokens=900))
    assert est is True and n > 0


def test_texte_vide_vaut_zero_exact(remote_target):
    assert _run(measure_thinking_tokens("")) == (0, False)
    assert _run(measure_thinking_tokens("   \n  ")) == (0, False)


def test_estimation_a_un_plancher_de_un_token():
    """Un raisonnement affiché à « 0 token » se lirait comme une absence de
    raisonnement."""
    assert estimate_thinking_tokens("ok") == 1
    assert estimate_thinking_tokens("") == 0


# ── Invariant : réflexion ⊆ sortie ──────────────────────────────────────────

def test_la_mesure_est_bornee_par_la_sortie(remote_target):
    """Sans borne, « réponse = sortie − réflexion » deviendrait négative."""
    n, _ = _run(measure_thinking_tokens("z" * 10_000, output_tokens=50))
    assert n == 50


def test_le_declare_aussi_est_borne(remote_target):
    n, est = _run(measure_thinking_tokens(
        "texte", usage={"reasoning_tokens": 9_999}, output_tokens=120))
    assert (n, est) == (120, False)


# ── Décomposition exposée aux vues ──────────────────────────────────────────

def test_calculate_metrics_decompose_la_sortie():
    m = calculate_metrics(
        {"usage": {"prompt_tokens": 1000, "completion_tokens": 800},
         "thinking_tokens": 600, "thinking_tokens_estimated": True},
        1.0)
    assert m["output_tokens"] == 800
    assert m["thinking_tokens"] == 600
    assert m["response_tokens"] == 200
    assert m["thinking_tokens_estimated"] is True
    # La réflexion NE S'AJOUTE PAS à l'entrée : le total facturé est inchangé.
    assert m["input_tokens"] == 1000


def test_calculate_metrics_sans_mesure_reste_coherent():
    """Un tour sans raisonnement (ou d'avant la mesure) : toute la sortie est
    de la réponse, et rien n'est annoncé comme estimé."""
    m = calculate_metrics(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 90}}, 1.0)
    assert m["thinking_tokens"] == 0
    assert m["response_tokens"] == 90
    assert m["thinking_tokens_estimated"] is False


def test_calculate_metrics_clampe_une_mesure_aberrante():
    m = calculate_metrics(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 40},
         "thinking_tokens": 999}, 1.0)
    assert m["thinking_tokens"] == 40
    assert m["response_tokens"] == 0


def test_calculate_metrics_recupere_le_declare_quand_personne_na_mesure():
    """forced_tool / open_tools ne mesurent pas : ils doivent au moins hériter
    de ce que le backend déclare, sans le compter comme estimé."""
    m = calculate_metrics(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 200,
                   "completion_tokens_details": {"reasoning_tokens": 150}}},
        1.0)
    assert m["thinking_tokens"] == 150
    assert m["response_tokens"] == 50
    assert m["thinking_tokens_estimated"] is False
