# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_ctx_cache_and_budget.py

Audit compression/budget de contexte — phase 2 :

  • Cache n_ctx PAR MODÈLE (_model_info) : avant un scalaire global renvoyait le
    n_ctx du 1er modèle pour TOUT modèle (router / multi-user) → budget calculé
    sur la mauvaise fenêtre. Vérifie l'isolation + l'invalidation ciblée + l'URL-encode.

  • _enforce_context_budget (rempart dur que le chemin classic appelle désormais
    aussi) : retire les plus VIEUX messages non-system quand le prompt dépasse,
    en préservant system + le tour courant.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

import llm_core._chat_with_tools as _cwt
import llm_core._model_info as mi
import llm_core.context.pruning as _pruning  # Phase 2 : budget dur extrait


@pytest.fixture(autouse=True)
def _clear_ctx_cache():
    mi._cached_context_size.clear()
    yield
    mi._cached_context_size.clear()


# ── Cache n_ctx keyed par modèle ─────────────────────────────────────────────
async def test_ctx_cache_keyed_per_model():
    async def _fake_get(path, timeout=3.0):
        if "modelA" in path:
            return {"default_generation_settings": {"n_ctx": 32768}}
        if "modelB" in path:
            return {"default_generation_settings": {"n_ctx": 8192}}
        return {"default_generation_settings": {"n_ctx": 4096}}

    async def _fake_text(path, timeout=3.0):
        return ""

    with patch.object(mi, "_llama_get", _fake_get), patch.object(mi, "_llama_get_text", _fake_text):
        a = await mi.get_model_context_size("modelA")
        b = await mi.get_model_context_size("modelB")
        a_again = await mi.get_model_context_size("modelA")   # depuis cache
    # Chaque modèle garde SON n_ctx — pas de contamination croisée.
    assert (a, b, a_again) == (32768, 8192, 32768)
    assert mi._cached_context_size == {"modelA": 32768, "modelB": 8192}


async def test_ctx_cache_invalidate_one_then_all():
    async def _fake_get(path, timeout=3.0):
        return {"default_generation_settings": {"n_ctx": 16384}}

    async def _fake_text(path, timeout=3.0):
        return ""

    with patch.object(mi, "_llama_get", _fake_get), patch.object(mi, "_llama_get_text", _fake_text):
        await mi.get_model_context_size("m1")
        await mi.get_model_context_size("m2")
        assert set(mi._cached_context_size) == {"m1", "m2"}
        mi.invalidate_context_size_cache("m1")     # ciblé
        assert set(mi._cached_context_size) == {"m2"}
        mi.invalidate_context_size_cache()         # tout
        assert mi._cached_context_size == {}


async def test_ctx_cache_url_encodes_model_id():
    seen = {}

    async def _fake_get(path, timeout=3.0):
        seen["path"] = path
        return {"default_generation_settings": {"n_ctx": 2048}}

    async def _fake_text(path, timeout=3.0):
        return ""

    # Un nom avec caractères réservés d'URL ne doit PAS casser la query /props.
    with patch.object(mi, "_llama_get", _fake_get), patch.object(mi, "_llama_get_text", _fake_text):
        await mi.get_model_context_size("weird model#1?x=2")
    assert "weird%20model%231%3Fx%3D2" in seen["path"], seen["path"]


# ── _enforce_context_budget : rempart dur ────────────────────────────────────
async def test_enforce_budget_drops_oldest_keeps_system_and_recent(monkeypatch):
    # 1 system + 20 messages non-system, chacun « lourd » → dépasse le budget.
    msgs = [{"role": "system", "content": "SYS"}]
    for i in range(20):
        msgs.append({"role": ("user" if i % 2 == 0 else "assistant"), "content": f"m{i}"})

    async def _fake_counts(messages, model_id=None):
        # system petit, le reste lourd (force le dépassement et des drops).
        return [10 if m.get("role") == "system" else 500 for m in messages]

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _fake_counts)

    out = await _cwt._enforce_context_budget(
        msgs, ctx_size=8000, model_id="m", gen_cap_tokens=0)

    # Le system est toujours préservé.
    assert any(m.get("role") == "system" for m in out)
    # Des messages ont été retirés (best-effort fit).
    assert len(out) < len(msgs)
    # Le tour courant (queue protégée EFFECTIVE — bornée à un tiers de la
    # conversation depuis 2026-08-01) est intact.
    keep = _pruning.effective_keep_recent(len(msgs))
    assert msgs[-keep:] == out[-keep:]
    # Ce sont bien les PLUS VIEUX non-system qui partent (m0 retiré avant m19).
    contents = [m.get("content") for m in out]
    assert "m19" in contents and "m0" not in contents


async def test_enforce_budget_protege_le_tour_courant_entier(monkeypatch):
    """Recalibrage 2026-07-18 : le TOUR COURANT (tout ce qui suit le dernier
    ``user``) est protégé même quand il dépasse keep_recent_msgs — tant qu'il
    reste des tours PRÉCÉDENTS à retirer. Avant : seuls les 10 derniers
    messages étaient garantis, un tour agentique de 16 messages se faisait
    amputer ses propres tool_results."""
    msgs = [{"role": "system", "content": "SYS"}]
    for i in range(6):                                   # tours précédents
        msgs.append({"role": ("user" if i % 2 == 0 else "assistant"),
                     "content": f"old{i}"})
    msgs.append({"role": "user", "content": "MISSION"})  # dernier user réel
    # Tour courant agentique long (assistant-only : la re-sanitisation finale
    # retirerait des ``tool`` synthétiques sans tool_call_id apparié).
    for i in range(16):
        msgs.append({"role": "assistant", "content": f"cur{i}"})

    async def _fake_counts(messages, model_id=None):
        return [10 if m.get("role") == "system" else 500 for m in messages]

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _fake_counts)

    out = await _cwt._enforce_context_budget(
        msgs, ctx_size=12_000, model_id="m", gen_cap_tokens=0)

    contents = [m.get("content") for m in out]
    # Le tour courant est INTÉGRALEMENT préservé (17 messages > keep 10)…
    assert "MISSION" in contents
    assert all(f"cur{i}" in contents for i in range(16))
    # …et ce sont les tours précédents qui ont payé.
    assert "old0" not in contents


async def test_enforce_budget_ampute_le_tour_courant_en_dernier_recours(monkeypatch):
    """Un tour courant seul qui déborde reste amputable (par sa TÊTE, hors
    queue keep_recent_msgs) : le dernier rempart doit rester un rempart."""
    msgs = [{"role": "system", "content": "SYS"},
            {"role": "user", "content": "MISSION"}]
    for i in range(30):
        msgs.append({"role": "assistant", "content": f"cur{i}"})

    async def _fake_counts(messages, model_id=None):
        return [10 if m.get("role") == "system" else 500 for m in messages]

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _fake_counts)

    out = await _cwt._enforce_context_budget(
        msgs, ctx_size=12_000, model_id="m", gen_cap_tokens=0)

    contents = [m.get("content") for m in out]
    assert len(out) < len(msgs)                    # des drops ont eu lieu
    assert "cur29" in contents                     # la queue survit
    assert "cur0" not in contents                  # la tête du tour part d'abord
    assert any(m.get("role") == "system" for m in out)


async def test_enforce_budget_noop_when_ctx_unknown(monkeypatch):
    msgs = [{"role": "system", "content": "S"}, {"role": "user", "content": "x"}]

    async def _boom(*_a, **_k):
        raise AssertionError("ne doit pas compter les tokens quand ctx inconnu")

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _boom)
    # ctx_size None / 0 → retour immédiat, aucun comptage.
    assert await _cwt._enforce_context_budget(msgs, ctx_size=None) is msgs
    assert await _cwt._enforce_context_budget(msgs, ctx_size=0) is msgs


async def test_enforce_budget_soustrait_le_surcout_tools(monkeypatch):
    """Le schéma tools occupe réellement le prompt : le budget doit rétrécir
    d'autant (avant, le fit croyait le prompt rentrant et llama coupait en
    finish=length). Même liste : sans surcoût = aucun drop, avec = drops."""
    msgs = [{"role": "system", "content": "SYS"}]
    for i in range(20):
        msgs.append({"role": ("user" if i % 2 == 0 else "assistant"),
                     "content": f"m{i}"})

    async def _fake_counts(messages, model_id=None):
        return [10 if m.get("role") == "system" else 300 for m in messages]

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _fake_counts)

    # 10 + 20×300 = 6010 ; ctx 12000 − réserve 3072 = 8928 → tient sans drop.
    out0 = await _cwt._enforce_context_budget(
        msgs, ctx_size=12_000, model_id="m", gen_cap_tokens=0)
    assert out0 is msgs
    # Avec 3000 tokens de schéma tools : budget 5928 < 6010 → drop.
    out1 = await _cwt._enforce_context_budget(
        msgs, ctx_size=12_000, model_id="m", gen_cap_tokens=0,
        fixed_overhead_tokens=3_000)
    assert len(out1) < len(msgs)
    assert any(m.get("role") == "system" for m in out1)   # system préservé


async def test_enforce_budget_overhead_geant_early_return(monkeypatch):
    """Surcoût + réserve > n_ctx → budget ≤ 0 → comportement historique :
    envoi tel quel (early-return), aucun comptage réseau."""
    msgs = [{"role": "system", "content": "S"}, {"role": "user", "content": "x"}]

    async def _boom(*_a, **_k):
        raise AssertionError("budget<=0 → pas de comptage")

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _boom)
    out = await _cwt._enforce_context_budget(
        msgs, ctx_size=4096, fixed_overhead_tokens=10_000)
    assert out is msgs


async def test_enforce_budget_note_tail_too_heavy(monkeypatch):
    """Correctif 2026-07-27 : droppables ÉPUISÉS mais total ENCORE > budget
    (queue protégée trop lourde — régime d'un chat agentique mûr). Avant, le
    prompt surdimensionné partait en silence (aucun flag) et llama coupait
    chaque génération en finish=length. Désormais ``stats_out`` porte
    over_budget/tail_too_heavy → l'avertissement utilisateur existant tire."""
    msgs = [{"role": "system", "content": "SYS"},
            {"role": "user", "content": "old-drop"}]
    # Queue protégée massive : à elle seule > budget. On la dimensionne sur la
    # taille EFFECTIVE (bornée à un tiers de la liste) — sinon une partie du
    # « recentN » resterait droppable et le scénario testé ne se produirait pas.
    _n_recent = _pruning.effective_keep_recent(2 + _cwt._CTX_KEEP_RECENT)
    for i in range(_n_recent):
        msgs.append({"role": ("user" if i % 2 == 0 else "assistant"),
                     "content": f"recent{i}"})

    async def _fake_counts(messages, model_id=None):
        return [10 if m.get("role") == "system" else 900 for m in messages]

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _fake_counts)

    stats = {}
    out = await _cwt._enforce_context_budget(
        msgs, ctx_size=8000, model_id="m", gen_cap_tokens=0, stats_out=stats)

    # Le droppable est parti, la queue reste, et le dépassement est SIGNALÉ.
    contents = [m.get("content") for m in out]
    assert "old-drop" not in contents
    assert all(f"recent{i}" in contents for i in range(_n_recent))
    assert stats.get("over_budget") is True
    assert stats.get("over_reason") == "tail_too_heavy"
    assert stats.get("estimated") > stats.get("budget")
