# SPDX-License-Identifier: MIT
"""tests/llm_core/test_ctx_scale_overflow_compression.py — LA règle unique
d'overflow (harnais v4, M3) et la compaction aux échelles 256k / 1M
(2026-07-28). Remplace les tests de l'ancienne pré-porte (gate.py supprimée).

Couvre :
- le bord EXACT de la règle : ``occupation ≥ usable = n_ctx − gen_cap −
  buffer`` (225 760 à 256k, 1 012 192 à 1M), à un token près, sur la mesure
  RÉELLE fournie par la boucle ;
- le chemin sans mesure : estimation au ratio mesuré (zéro I/O si en
  dessous), confirmation EXACTE avant d'agir, occupation exacte retournée
  pour ancrage (plus jamais un comptage par itération) ;
- ``ctx_unknown`` : fenêtre inconnue → aucune auto-compaction ;
- compaction PARTIELLE ancrée sur ``usable × 0.6`` (sélection en comptes
  exacts par tour), prise complète en manuel, rollback no-gain byte-égal,
  round-trip état persisté → ré-expansion → extraction.

Aucun réseau : /tokenize faké (chemins stats ET sélection), résumeur injecté,
n_ctx patché, FTS neutralisée.
"""
from __future__ import annotations

import pytest

from llm_core.conversation_compressor import (
    _count_turns,
    apply_persisted_state,
    compression_was_attempted,
    extract_compression_state,
    is_summary_carrier,
    maybe_compress_conversation,
)
from tests.llm_core.ctx_scale_harness import (
    CTX_1M,
    CTX_256K,
    build_conversation,
    compression_cfg,
    expected,
    fake_summarizer,
    patch_fake_tokenize,
    patch_scale,
    reset_measured_ratio,
    scale_param,
)


@pytest.fixture(autouse=True)
def _seed_ratio():
    reset_measured_ratio()
    yield
    reset_measured_ratio()


def _conv(n_pairs: int, chars: int = 200) -> list:
    msgs = [{"role": "system", "content": "socle"}]
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"question {i} " + "q" * chars})
        msgs.append({"role": "assistant", "content": f"reponse {i} " + "r" * chars})
    return msgs


# ── La règle : bord exact sur la mesure réelle ──────────────────────────────

@scale_param
async def test_regle_unique_bord_exact_sur_le_reel(ctx, monkeypatch):
    E = expected(ctx)
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    patch_scale(monkeypatch, ctx)
    msgs = _conv(12)   # 24 tours ≥ matière minimale (2+1+2)

    # Un token SOUS usable → porte fermée, AUCUN événement.
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fake_summarizer, model="scale-model",
        user_id="scale", ctx_size_tokens=ctx,
        real_tokens=E["usable"] - 1, fts_session_id=None)
    assert out is msgs and stats["reason"] == "threshold_not_reached"

    # AU bord → compaction (la mesure réelle est l'autorité, pas de
    # re-confirmation exacte).
    out2, stats2 = await maybe_compress_conversation(
        msgs, llama_chat_fn=fake_summarizer, model="scale-model",
        user_id="scale", ctx_size_tokens=ctx,
        real_tokens=E["usable"], fts_session_id=None)
    assert stats2.get("compressed") is True, stats2
    assert stats2["new_state"]["round"] == 1
    assert sum(1 for m in out2 if is_summary_carrier(m)) == 1


@scale_param
async def test_estimation_confirmee_par_exact_puis_ancree(ctx, monkeypatch):
    """Sans mesure réelle : l'estimation au ratio ouvre, le comptage EXACT
    confirme — et s'il dit « en dessous », l'occupation exacte est RETOURNÉE
    pour que la boucle l'ancre (fin de la bande morte : plus jamais un
    comptage full-history par itération)."""
    import llm_core._llama_http as lh
    E = expected(ctx)
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    patch_scale(monkeypatch, ctx)
    calls: list = []

    # Fake exact PLUS PETIT que l'estimation (chars//4 < chars/3.3) : la
    # porte estimée ouvre, l'exacte referme → branche d'ancrage.
    async def _count(messages, model_id=None, timeout=None):
        calls.append(len(messages))
        total = sum(len(m.get("content") or "") for m in messages
                    if isinstance(m.get("content"), str))
        return max(1, total // 4)

    monkeypatch.setattr(lh, "count_tokens_for_messages", _count)

    # ≈ 1.05×usable en estimation 3.3 → ouvre ; exact //4 ≈ 0.83×usable → referme.
    msgs = build_conversation(int(E["usable"] * 1.05))
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fake_summarizer, model="scale-model",
        user_id="scale", ctx_size_tokens=ctx, fts_session_id=None)
    assert stats["reason"] == "threshold_not_reached"
    assert len(calls) == 1, "UN comptage exact de confirmation, pas plus"
    assert 0 < stats["occupancy_tokens"] < E["usable"], \
        "l'occupation exacte doit être retournée pour ancrage"
    assert stats["usable_tokens"] == E["usable"]

    # Estimation DÉJÀ sous usable → zéro I/O du tout.
    calls.clear()
    small = _conv(12)
    out2, stats2 = await maybe_compress_conversation(
        small, llama_chat_fn=fake_summarizer, model="scale-model",
        user_id="scale", ctx_size_tokens=ctx, fts_session_id=None)
    assert stats2["reason"] == "threshold_not_reached"
    assert calls == [], "sous usable en estimation → aucun /tokenize"


async def test_ctx_inconnu_aucune_auto_compaction(monkeypatch):
    compression_cfg(monkeypatch)
    calls = patch_fake_tokenize(monkeypatch)
    msgs = _conv(12)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fake_summarizer, model="scale-model",
        user_id="scale", ctx_size_tokens=None, fts_session_id=None)
    assert stats["reason"] == "ctx_unknown"
    assert calls == [], "fenêtre inconnue → rien à dimensionner, zéro I/O"


@scale_param
async def test_matiere_minimale_avant_tout(ctx, monkeypatch):
    """Moins de recent+bridge+2 tours : refus AVANT tout comptage, même avec
    une occupation réelle au plafond."""
    E = expected(ctx)
    compression_cfg(monkeypatch)     # keep 2+1 → matière minimale 5 tours
    calls = patch_fake_tokenize(monkeypatch)
    msgs = _conv(2)                  # 4 tours < 5
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fake_summarizer, model="scale-model",
        user_id="scale", ctx_size_tokens=ctx,
        real_tokens=E["usable"] + 50_000, fts_session_id=None)
    assert stats["reason"] == "threshold_not_reached"
    assert calls == []


# ── Compaction partielle ancrée sur usable ──────────────────────────────────

@scale_param
async def test_compaction_partielle_ancree_sur_usable(ctx, monkeypatch):
    """Déclenchée par la règle unique, la compaction automatique reste
    PARTIELLE : seuls les tours les plus anciens nécessaires pour viser
    ``usable × 0.6`` partent au résumé — le plus important reste verbatim."""
    E = expected(ctx)
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    patch_scale(monkeypatch, ctx)

    # Estimation calée juste au-dessus de usable → l'exact //3 (≈ ×1.1)
    # confirme largement → déclenche, aux deux échelles.
    msgs = build_conversation(int(E["usable"] * 1.02))
    total_turns = _count_turns(msgs)
    events: list = []

    async def _cb(evt):
        events.append(evt)

    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fake_summarizer, on_event=_cb,
        model="scale-model", user_id="scale", ctx_size_tokens=ctx,
        fts_session_id=None)

    assert stats.get("compressed") is True, stats
    assert stats["new_state"]["round"] == 1
    assert stats["new_state"]["covered_turns"] == stats["turns_compressed"] > 0
    assert stats["tokens_after"] < stats["tokens_before"], "gain requis"
    # PARTIELLE : « ne prend pas tout » (compressible total = tours − 3).
    assert stats["turns_compressed"] < total_turns - 3, \
        (stats["turns_compressed"], total_turns)
    joined = " ".join(str(m.get("content")) for m in out
                      if isinstance(m.get("content"), str))
    assert "<<HEAD shell0>>" not in joined, "le plus ancien doit être résumé"
    kept_tools = [m for m in out if m.get("role") == "tool"
                  and isinstance(m.get("content"), str)
                  and "<<HEAD shell" in m["content"]]
    assert kept_tools, "des tours outillés doivent survivre verbatim"
    assert sum(1 for m in out if is_summary_carrier(m)) == 1
    assert out[-1] == msgs[-1], "la zone récente survit telle quelle"
    types = [e.get("type") for e in events]
    assert types[0] == "compression_start"
    assert "compression_state" in types and types[-1] == "compression_done"


@scale_param
async def test_compaction_manuelle_prend_tout(ctx, monkeypatch):
    """/compact (manual=True) garde la prise complète historique."""
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    patch_scale(monkeypatch, ctx)

    msgs = build_conversation(int(ctx * 0.55))
    total_turns = _count_turns(msgs)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fake_summarizer, model="scale-model",
        user_id="scale", ctx_size_tokens=ctx, prev_state=None,
        manual=True, fts_session_id=None)
    assert stats.get("compressed") is True, stats
    assert stats["turns_compressed"] == total_turns - 3, \
        "manuel = tout le compressible (hors bridge 1 + recent 2)"
    assert stats["tokens_after"] < stats["tokens_before"] * 0.3, \
        "prise complète → gain massif"


# ── Round-trip : état persisté → ré-expansion → extraction ──────────────────

@scale_param
def test_round_trip_etat_persiste_reexpansion(ctx, monkeypatch):
    from chatbot_app.turn.history import _expand_history_for_llm

    compression_cfg(monkeypatch)   # KEEP_RECENT=2 + KEEP_BRIDGE=1 → keep=3
    state = {"round": 1, "covered_turns": 8,
             "summary_xml": "<context>etat rejoue</context>", "ledger_block": ""}
    history = [{"role": "system", "content": "socle"}]
    for i in range(12):
        history.append({"role": "user", "content": f"question {i}"})
        history.append({"role": "assistant", "content": f"reponse {i}"})

    out, state_out = apply_persisted_state(list(history), state)
    assert is_summary_carrier(out[1]), "porteur inséré APRÈS le bloc system de tête"
    assert "[COMPRESSION_META v=1 round=1 covered_turns=8]" in out[1]["content"]
    contents = [m.get("content") for m in out]
    assert "question 0" not in contents and "question 3" not in contents
    assert "question 4" in contents, "le premier tour NON couvert survit"
    assert state_out["applied_drop"] is True and state_out["applied_drop_turns"] == 8

    out_bis, _ = apply_persisted_state(list(history), state)
    assert out_bis == out, "ré-application sur le même historique → même résultat"
    already = [history[0], out[1]] + history[1:]
    out_ter, _ = apply_persisted_state(already, state)
    assert sum(1 for m in out_ter if is_summary_carrier(m)) == 1

    assert extract_compression_state(out) == state

    bubble = {
        "role": "assistant", "content": "fin du tour",
        "tool_history_delta": True,
        "tool_history": [
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "d1", "type": "function",
                 "function": {"name": "execute_shell",
                              "arguments": "{\"command\": \"ls\"}"}}]},
            {"role": "tool", "tool_call_id": "d1", "content": "listing ok"},
        ],
    }
    ui = [{"role": "user", "content": "go"},
          {"role": "notice", "content": "conversation compactée"},
          bubble]
    expanded = _expand_history_for_llm(ui)
    assert [m["role"] for m in expanded] == ["user", "assistant", "tool", "assistant"]
    assert expanded[2] == {"role": "tool", "tool_call_id": "d1",
                           "content": "listing ok"}
    assert all(m["role"] != "notice" for m in expanded)


# ── Garde no-gain à l'échelle ───────────────────────────────────────────────

@scale_param
async def test_rollback_no_token_gain_a_l_echelle(ctx, monkeypatch):
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    patch_scale(monkeypatch, ctx)

    msgs = _conv(20)

    async def _obese(prompt, user_id="t", model_override=None):
        return "<context>" + "z" * 400_000 + "</context>", {"model": "fake"}

    events: list = []

    async def _cb(evt):
        events.append(evt)

    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_obese, on_event=_cb, model="scale-model",
        user_id="scale", ctx_size_tokens=ctx, prev_state=None,
        manual=True, fts_session_id=None)

    assert out is msgs, "rollback : l'objet ORIGINAL est rendu, byte-égal"
    assert stats.get("reason") == "no_token_gain"
    assert stats["tokens_after"] >= stats["tokens_before"]
    assert compression_was_attempted(stats) is True
    types = [e.get("type") for e in events]
    assert "compression_start" in types and "compression_done" in types
    assert "compression_state" not in types
