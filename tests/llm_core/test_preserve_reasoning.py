# SPDX-License-Identifier: MIT
"""tests/llm_core/test_preserve_reasoning.py — toggle « Raisonnement conservé ».

Chaîne complète côté serveur, sans réseau :
- détection : capacité ``/props.chat_template_caps.supports_preserve_reasoning``
  exposée par llama.cpp (signal AUTORITAIRE — le serveur rend réellement le
  template pour la calculer), + repli marqueurs pour les builds antérieurs ;
- sanitisation TRI-ÉTAT de la valeur reçue du client (None = défaut template) ;
- injection dans ``chat_template_kwargs`` UNIQUEMENT si llama.cpp local ET
  capacité confirmée — un modèle sans support ne reçoit RIEN ;
- exposition dans effective-params (plein + dégradé).

Valeurs de référence relevées sur le serveur réel (llama-server b10076,
Qwen3.8-27B) : caps.supports_preserve_reasoning = true, et le rendu du
template avec ``preserve_reasoning: true`` est BYTE-IDENTIQUE au rendu sans
kwarg (le défaut du template Qwen3.8 est « preserve »).
"""
from __future__ import annotations

import pytest

import llm_core._llm_params as lp
from llm_core._llm_params import (
    _detect_preserve_reasoning_from_props,
    get_preserve_reasoning_support,
    invalidate_params_cache,
    sanitize_preserve_reasoning,
)
from llm_core.providers.llamacpp import build_llama_payload

# Forme réelle de /props (build b10076) : la capacité est dans chat_template_caps.
_CAPS_OK = {"chat_template_caps": {"supports_tools": True,
                                   "supports_preserve_reasoning": True}}
_CAPS_KO = {"chat_template_caps": {"supports_tools": True,
                                   "supports_preserve_reasoning": False}}

# Build ANTÉRIEUR à chat_template_caps → repli sur les marqueurs du template.
# Extrait fidèle du template Qwen3.8 réel.
_TMPL_PRESERVE = (
    '{%- if preserve_thinking is undefined or preserve_thinking is true '
    'or loop.index0 > ns.last_query_index %}<think>{% endif %}'
)
_TMPL_CLASSIC = "{% if enable_thinking %}<think>{% endif %}{{ messages }}"


# ── Détection ───────────────────────────────────────────────────────────────

def test_detect_capacite_props_autoritaire():
    assert _detect_preserve_reasoning_from_props(_CAPS_OK) is True
    assert _detect_preserve_reasoning_from_props(_CAPS_KO) is False


def test_detect_caps_prime_sur_le_template():
    # caps=false alors que le template cite la variable : la capacité calculée
    # par le serveur fait FOI (il a rendu le template pour l'obtenir).
    props = dict(_CAPS_KO, chat_template=_TMPL_PRESERVE)
    assert _detect_preserve_reasoning_from_props(props) is False


def test_detect_repli_marqueurs_sans_caps():
    assert _detect_preserve_reasoning_from_props(
        {"chat_template": _TMPL_PRESERVE}) is True
    assert _detect_preserve_reasoning_from_props(
        {"chat_template": _TMPL_CLASSIC}) is False


def test_detect_repli_shape_default_generation_settings():
    props = {"default_generation_settings": {"chat_template": _TMPL_PRESERVE}}
    assert _detect_preserve_reasoning_from_props(props) is True


def test_detect_props_vides_ou_invalides():
    assert _detect_preserve_reasoning_from_props({}) is False
    assert _detect_preserve_reasoning_from_props(None) is False  # type: ignore[arg-type]


# ── Sanitisation TRI-ÉTAT ───────────────────────────────────────────────────

def test_sanitize_tri_etat():
    assert sanitize_preserve_reasoning({"preserve_reasoning": True}) is True
    assert sanitize_preserve_reasoning({"preserve_reasoning": False}) is False
    # None = clé absente/invalide → aucun kwarg, défaut du template conservé.
    assert sanitize_preserve_reasoning({}) is None
    assert sanitize_preserve_reasoning(None) is None
    assert sanitize_preserve_reasoning({"preserve_reasoning": "true"}) is None
    assert sanitize_preserve_reasoning({"preserve_reasoning": 1}) is None
    assert sanitize_preserve_reasoning("true") is None  # type: ignore[arg-type]


# ── Cache + invalidation ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cache_et_invalidation(monkeypatch):
    calls = {"n": 0}

    async def _fake_fetch(_mid):
        calls["n"] += 1
        return _CAPS_OK

    monkeypatch.setattr(lp, "_fetch_raw_props", _fake_fetch)
    invalidate_params_cache()

    assert await get_preserve_reasoning_support("qwen3.8") is True
    assert await get_preserve_reasoning_support("qwen3.8") is True
    assert calls["n"] == 1  # 2e appel servi par le cache

    invalidate_params_cache("qwen3.8")
    await get_preserve_reasoning_support("qwen3.8")
    assert calls["n"] == 2  # purge ciblée → re-fetch


# ── Injection dans le payload llama.cpp ─────────────────────────────────────

def _patch_local(monkeypatch, supported):
    import llm_core._constants as const
    import llm_core._model_info as mi

    async def _ctx(_m):
        return 8192

    async def _slot(_cid):
        return -1

    async def _sup(_m):
        return supported

    monkeypatch.setattr(mi, "get_model_context_size", _ctx)
    monkeypatch.setattr(const, "resolve_slot_id_async", _slot)
    monkeypatch.setattr(lp, "get_preserve_reasoning_support", _sup)


async def _payload(**kw):
    base = dict(target_model="qwen3.8", user_id="u", sampling_params={},
                llama_native=True, local_llamacpp=True, thinking_mode=True,
                chat_id=None)
    base.update(kw)
    return await build_llama_payload([{"role": "user", "content": "hi"}], **base)


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [True, False])
async def test_payload_injecte_les_deux_etats(monkeypatch, value):
    # False est une valeur SIGNIFIANTE (purge explicite) : elle doit partir,
    # pas être confondue avec « absent ».
    _patch_local(monkeypatch, True)
    p = await _payload(preserve_reasoning=value)
    assert p["chat_template_kwargs"] == {
        "enable_thinking": True, "preserve_reasoning": value,
    }


@pytest.mark.asyncio
async def test_payload_ignore_si_modele_sans_support(monkeypatch):
    # Le point central : l'override est GLOBAL au navigateur — un modèle non
    # concerné garde un payload strictement identique à avant.
    _patch_local(monkeypatch, False)
    p = await _payload(target_model="llama3", preserve_reasoning=False)
    assert p["chat_template_kwargs"] == {"enable_thinking": True}


@pytest.mark.asyncio
async def test_payload_defaut_none_inchange(monkeypatch):
    # Sans override (défaut None) : aucun kwarg, aucun accès réseau — le
    # template garde son défaut. Non-régression goldens.
    _patch_local(monkeypatch, True)
    p = await _payload()
    assert p["chat_template_kwargs"] == {"enable_thinking": True}


@pytest.mark.asyncio
async def test_payload_jamais_sur_llamacpp_distant():
    # Cible distante : template non sondable via le /props local → rien.
    p = await _payload(local_llamacpp=False, thinking_mode=False,
                       preserve_reasoning=True)
    assert p["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.asyncio
async def test_payload_detection_ko_ne_casse_pas(monkeypatch):
    # /props injoignable pendant la détection → on n'injecte pas, on ne lève pas.
    import llm_core._constants as const
    import llm_core._model_info as mi

    async def _ctx(_m):
        return 8192

    async def _slot(_cid):
        return -1

    async def _boom(_m):
        raise RuntimeError("props KO")

    monkeypatch.setattr(mi, "get_model_context_size", _ctx)
    monkeypatch.setattr(const, "resolve_slot_id_async", _slot)
    monkeypatch.setattr(lp, "get_preserve_reasoning_support", _boom)

    p = await _payload(preserve_reasoning=True)
    assert p["chat_template_kwargs"] == {"enable_thinking": True}


# ── Exposition effective-params ─────────────────────────────────────────────

def test_degraded_expose_inconnu():
    # None (inconnu) → le front MASQUE le toggle (pas de faux positif).
    d = lp.describe_effective_params_degraded("qwen3.8", "chat")
    assert d["supports_preserve_reasoning"] is None


@pytest.mark.asyncio
async def test_effective_params_expose_la_capacite(monkeypatch):
    async def _props(_mid):
        return _CAPS_OK

    monkeypatch.setattr(lp, "_fetch_raw_props", _props)
    invalidate_params_cache()
    d = await lp.describe_effective_params(model_id="qwen3.8", task="chat")
    assert d["supports_preserve_reasoning"] is True


@pytest.mark.asyncio
async def test_effective_params_capacite_absente(monkeypatch):
    async def _props(_mid):
        return {"chat_template": _TMPL_CLASSIC}

    monkeypatch.setattr(lp, "_fetch_raw_props", _props)
    invalidate_params_cache()
    d = await lp.describe_effective_params(model_id="llama3", task="chat")
    assert d["supports_preserve_reasoning"] is False
