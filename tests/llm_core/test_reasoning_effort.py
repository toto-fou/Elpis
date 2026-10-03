# SPDX-License-Identifier: MIT
"""tests/llm_core/test_reasoning_effort.py — sélecteur d'effort de réflexion.

Chaîne complète côté serveur, sans réseau :
- détection : chat_template (via /props) citant ``reasoning_effort`` +
  extraction des valeurs littérales que le template accepte (Qwen3.8…) ;
- sanitisation de la valeur reçue du client (sampling_override brut) ;
- injection dans ``chat_template_kwargs`` UNIQUEMENT si llama.cpp local ET
  valeur dans la liste détectée — un modèle sans support ne reçoit RIEN
  (invariant : la feature n'impacte pas les autres modèles) ;
- exposition dans effective-params (plein + dégradé).
"""
from __future__ import annotations

import pytest

import llm_core._llm_params as lp
from llm_core._llm_params import (
    _detect_reasoning_effort_from_props,
    get_reasoning_effort_values,
    invalidate_params_cache,
    sanitize_reasoning_effort,
)
from llm_core.providers.llamacpp import build_llama_payload

# Extrait représentatif d'un template type Qwen3.8 : la variable est comparée
# à des littéraux entre guillemets — c'est ce que la détection lit.
_TMPL_EFFORT = """
{%- if reasoning_effort == "low" -%}Think briefly.
{%- elif reasoning_effort == "medium" -%}
{%- elif reasoning_effort == "xhigh" -%}Think very hard.
{%- endif -%}
{%- if enable_thinking %}<think>{% endif %}
"""

_TMPL_CLASSIC = "{% if enable_thinking %}<think>{% endif %}{{ messages }}"


# ── Détection depuis le chat_template ───────────────────────────────────────

def test_detect_valeurs_du_template():
    vals = _detect_reasoning_effort_from_props({"chat_template": _TMPL_EFFORT})
    # Ordre stable = ordre de _REASONING_EFFORT_KNOWN_VALUES.
    assert vals == ["low", "medium", "xhigh"]


def test_detect_template_sans_effort():
    assert _detect_reasoning_effort_from_props({"chat_template": _TMPL_CLASSIC}) == []


def test_detect_props_vides_ou_invalides():
    assert _detect_reasoning_effort_from_props({}) == []
    assert _detect_reasoning_effort_from_props(None) == []  # type: ignore[arg-type]


def test_detect_shape_default_generation_settings():
    props = {"default_generation_settings": {"chat_template": _TMPL_EFFORT}}
    assert _detect_reasoning_effort_from_props(props) == ["low", "medium", "xhigh"]


def test_detect_variable_sans_litteraux_repli_conservateur():
    # Template qui référence la variable sans comparer à des littéraux
    # détectables → trio répandu, jamais une liste vide trompeuse.
    props = {"chat_template": "{{ reasoning_effort }}"}
    assert _detect_reasoning_effort_from_props(props) == ["low", "medium", "high"]


def test_detect_guillemets_evitent_les_collisions_de_sous_chaine():
    # "xhigh" cité ne doit PAS faire détecter "high" (ancré sur les quotes).
    props = {"chat_template": 'x {% if reasoning_effort == "xhigh" %}y{% endif %}'}
    assert _detect_reasoning_effort_from_props(props) == ["xhigh"]


# ── Sanitisation de l'override client ───────────────────────────────────────

def test_sanitize_valeurs():
    assert sanitize_reasoning_effort({"reasoning_effort": "low"}) == "low"
    assert sanitize_reasoning_effort({"reasoning_effort": "  XHigh "}) == "xhigh"
    assert sanitize_reasoning_effort({"reasoning_effort": "turbo"}) is None
    assert sanitize_reasoning_effort({"reasoning_effort": 3}) is None
    assert sanitize_reasoning_effort({}) is None
    assert sanitize_reasoning_effort(None) is None
    assert sanitize_reasoning_effort("low") is None  # type: ignore[arg-type]


# ── Cache + invalidation ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_values_cache_et_invalidation(monkeypatch):
    calls = {"n": 0}

    async def _fake_fetch(_mid, **_k):
        calls["n"] += 1
        return {"chat_template": _TMPL_EFFORT}

    monkeypatch.setattr(lp, "_fetch_raw_props", _fake_fetch)
    invalidate_params_cache()

    assert await get_reasoning_effort_values("qwen3.8") == ["low", "medium", "xhigh"]
    assert await get_reasoning_effort_values("qwen3.8") == ["low", "medium", "xhigh"]
    assert calls["n"] == 1  # 2e appel servi par le cache

    invalidate_params_cache("qwen3.8")
    await get_reasoning_effort_values("qwen3.8")
    assert calls["n"] == 2  # purge ciblée → re-fetch


# ── Injection dans le payload llama.cpp ─────────────────────────────────────

def _patch_local(monkeypatch, efforts):
    import llm_core._constants as const
    import llm_core._model_info as mi

    async def _ctx(_m):
        return 8192

    async def _slot(_cid):
        return -1

    async def _efforts(_m, **_k):
        return efforts

    monkeypatch.setattr(mi, "get_model_context_size", _ctx)
    monkeypatch.setattr(const, "resolve_slot_id_async", _slot)
    monkeypatch.setattr(lp, "get_reasoning_effort_values", _efforts)


@pytest.mark.asyncio
async def test_payload_injecte_si_supporte(monkeypatch):
    _patch_local(monkeypatch, ["low", "medium", "xhigh"])
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="qwen3.8", user_id="u",
        sampling_params={}, llama_native=True, local_llamacpp=True,
        thinking_mode=True, chat_id=None, reasoning_effort="low",
    )
    assert p["chat_template_kwargs"] == {
        "enable_thinking": True, "reasoning_effort": "low",
    }


@pytest.mark.asyncio
async def test_payload_ignore_si_valeur_hors_liste_du_modele(monkeypatch):
    # Valeur mémorisée côté client mais absente de la liste DU template
    # (ex. "none" sur un template qui ne l'accepte pas) → jamais envoyée.
    _patch_local(monkeypatch, ["low", "medium", "xhigh"])
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="qwen3.8", user_id="u",
        sampling_params={}, llama_native=True, local_llamacpp=True,
        thinking_mode=False, chat_id=None, reasoning_effort="none",
    )
    assert p["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.asyncio
async def test_payload_ignore_si_modele_sans_support(monkeypatch):
    # Le point central de la feature : un modèle NON concerné garde un payload
    # strictement identique à avant (enable_thinking seul).
    _patch_local(monkeypatch, [])
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="llama3", user_id="u",
        sampling_params={}, llama_native=True, local_llamacpp=True,
        thinking_mode=False, chat_id=None, reasoning_effort="low",
    )
    assert p["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.asyncio
async def test_payload_defaut_sans_effort_inchange():
    # Sans reasoning_effort (défaut None) : aucun accès réseau, payload
    # identique au comportement historique — non-régression goldens.
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="m", user_id="u",
        sampling_params={}, llama_native=True, local_llamacpp=False,
        thinking_mode=True, chat_id=None,
    )
    assert p["chat_template_kwargs"] == {"enable_thinking": True}


@pytest.mark.asyncio
async def test_payload_jamais_sur_llamacpp_distant():
    # llama.cpp DISTANT (connecteur) : son template n'est pas sondable via le
    # /props local → on n'injecte pas, même avec une valeur plausible.
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="qwen3.8", user_id="u",
        sampling_params={}, llama_native=True, local_llamacpp=False,
        thinking_mode=False, chat_id=None, reasoning_effort="low",
    )
    assert p["chat_template_kwargs"] == {"enable_thinking": False}


# ── Exposition effective-params ─────────────────────────────────────────────

def test_degraded_expose_inconnu():
    d = lp.describe_effective_params_degraded("qwen3.8", "chat")
    assert d["supports_reasoning_effort"] is None
    assert d["reasoning_effort_values"] == []


@pytest.mark.asyncio
async def test_effective_params_expose_la_capacite(monkeypatch):
    async def _props(_mid, **_k):
        return {"temperature": 0.7}

    async def _think(_mid, **_k):
        return True

    async def _efforts(_mid, **_k):
        return ["low", "medium", "xhigh"]

    monkeypatch.setattr(lp, "_get_cached_props", _props)
    monkeypatch.setattr(lp, "get_thinking_support", _think)
    monkeypatch.setattr(lp, "get_reasoning_effort_values", _efforts)

    d = await lp.describe_effective_params("qwen3.8", "chat")
    assert d["supports_reasoning_effort"] is True
    assert d["reasoning_effort_values"] == ["low", "medium", "xhigh"]

    async def _no_efforts(_mid, **_k):
        return []

    monkeypatch.setattr(lp, "get_reasoning_effort_values", _no_efforts)
    d = await lp.describe_effective_params("llama3", "chat")
    assert d["supports_reasoning_effort"] is False
    assert d["reasoning_effort_values"] == []
