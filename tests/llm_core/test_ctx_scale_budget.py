# SPDX-License-Identifier: MIT
"""tests/llm_core/test_ctx_scale_budget.py — étage 3 (budget dur) et
fast-path de ``fit_context`` aux échelles 256k / 1M (2026-07-28).

Pattern « compteurs virtuels » : ``count_messages_tokens_per_msg`` est
monkeypatché avec des comptes contrôlés — l'arithmétique du budget se teste
EXACTEMENT (réserve 47 185 / 188 743, budget 214 959 / 859 833, drops 86/41)
sans matérialiser des Mo de texte. Couvre :
- gen cap et réserve littéraux aux deux échelles ;
- drop ascendant : nombre EXACT de messages retirés, system + 10 derniers
  inviolés ;
- les trois branches de ``over_reason`` (overhead / nothing_droppable /
  tail_too_heavy) avec chiffres ``estimated``/``budget`` dans stats_out ;
- fast-path : bord EXACT à int(budget×0.85) (comptage /tokenize sauté ou
  non à un token près), et delta estimé qui repousse au comptage ;
- ``fit_context`` : stats ``dropped`` + non-mutation de l'entrée.

Aucun réseau : comptage par message monkeypatché (le fallback 3.3 n'est
même pas sollicité sur les chemins virtuels).
"""
from __future__ import annotations

import copy

from llm_core._constants import effective_generation_cap
from llm_core.context import pruning as _pruning
from llm_core.context.budget import BUDGET
from llm_core.context.pruning import enforce_context_budget, fit_context
from tests.llm_core.ctx_scale_harness import (
    CTX_1M,
    CTX_256K,
    blob,
    expected,
    scale_param,
    shell_round,
)


def _flat_conv(n_msgs: int, with_system: bool = True) -> list:
    """user/assistant alternés (aucune paire tool à désapparier au drop)."""
    msgs = [{"role": "system", "content": "SYS"}] if with_system else []
    i = 0
    while len(msgs) < n_msgs:
        role = "user" if i % 2 == 0 else "assistant"
        msgs.append({"role": role, "content": f"m{i}"})
        i += 1
    return msgs


def _patch_counts(monkeypatch, fn):
    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", fn)


# ── Gen cap + réserve + budget : littéraux ──────────────────────────────────

@scale_param
def test_gen_cap_et_reserve_litteraux(ctx):
    E = expected(ctx)
    assert effective_generation_cap(False, ctx) == E["gen_cap"]
    assert effective_generation_cap(True, ctx) == E["gen_cap_thinking"]
    assert BUDGET.reserve_tokens(ctx, E["gen_cap"]) == E["reserve"]
    assert BUDGET.prompt_budget(ctx, E["gen_cap"]) == E["prompt_budget"]
    # La réserve doit toujours couvrir le cap de génération (bug C2a).
    assert E["reserve"] >= E["gen_cap"]


# ── Drop ascendant : arithmétique exacte ────────────────────────────────────

@scale_param
async def test_drop_ascendant_arithmetique_exacte(ctx, monkeypatch):
    E = expected(ctx)
    n = {CTX_256K: 300, CTX_1M: 900}[ctx]

    async def _thousand(messages, model_id=None):
        return [1000] * len(messages)

    _patch_counts(monkeypatch, _thousand)
    msgs = _flat_conv(n)
    budget = E["prompt_budget"]
    # Hystérésis (AUDIT 2026-09-25) : le retrait descend jusqu'au FILIGRANE
    # BAS du budget, pas au ras — les itérations suivantes tiennent sans
    # nouveau retrait (préfixe KV stable).
    target = int(budget * _pruning._DROP_LOW_WATERMARK)
    want_drops = -(-(n * 1000 - target) // 1000)   # ceil
    assert want_drops == {CTX_256K: 139, CTX_1M: 256}[ctx], \
        "littéral de drops attendu — recalibrer la docstring si budgets retunés"
    # Tête alignée (audit 2026-09-24, n° 16) : un nombre IMPAIR de retraits
    # s'arrête sur une question et laisse sa réponse en tête — elle part aussi.
    want_drops += want_drops % 2

    stats: dict = {}
    out = await enforce_context_budget(
        msgs, ctx, model_id="m", gen_cap_tokens=E["gen_cap"], stats_out=stats)
    assert len(out) == n - want_drops
    assert out[0]["role"] == "system", "les system sont inviolables"
    assert out[-BUDGET.keep_recent_msgs:] == msgs[-BUDGET.keep_recent_msgs:], \
        "le tour courant (queue keep_recent) est inviolable"
    # Drop ASCENDANT : les plus anciens partent d'abord.
    assert msgs[1] not in out and msgs[-1] in out
    assert "over_budget" not in stats, "l'élagage a suffi — pas de dépassement"


# ── Les trois branches de over_reason ───────────────────────────────────────

@scale_param
async def test_over_reason_tail_too_heavy(ctx, monkeypatch):
    E = expected(ctx)
    n = 31
    # Queue protégée EFFECTIVE (bornée à un tiers de la conversation depuis
    # 2026-08-01) — la dimensionner sur le PLAFOND laisserait une partie de la
    # « queue » droppable, et le scénario testé ne se produirait pas.
    keep = _pruning.effective_keep_recent(n)
    tail_per = E["prompt_budget"] // keep + 1000

    async def _counts(messages, model_id=None):
        k = len(messages)
        return [5] * (k - keep) + [tail_per] * keep

    _patch_counts(monkeypatch, _counts)
    msgs = _flat_conv(n)
    stats: dict = {}
    out = await enforce_context_budget(
        msgs, ctx, model_id="m", gen_cap_tokens=E["gen_cap"], stats_out=stats)
    assert stats.get("over_budget") is True
    assert stats.get("over_reason") == "tail_too_heavy"
    assert stats.get("budget") == E["prompt_budget"]
    assert stats.get("estimated") > E["prompt_budget"], \
        "la queue protégée dépasse à elle seule le budget"
    # Tous les droppables sont partis, la queue protégée est intacte.
    # (L'ancre de tâche — dernier ``user`` — tombe ici DANS la queue, elle ne
    # préserve donc aucun message supplémentaire.)
    assert len(out) == 1 + keep


@scale_param
async def test_over_reason_nothing_droppable(ctx, monkeypatch):
    E = expected(ctx)

    async def _huge(messages, model_id=None):
        return [E["prompt_budget"] + 123] * len(messages)

    _patch_counts(monkeypatch, _huge)
    msgs = [{"role": "user", "content": "pièce jointe géante"}]
    stats: dict = {}
    out = await enforce_context_budget(
        msgs, ctx, model_id="m", gen_cap_tokens=E["gen_cap"], stats_out=stats)
    assert out == msgs, "rien de retirable → on part quand même (le serveur tranche)"
    assert stats.get("over_reason") == "nothing_droppable"
    assert stats.get("estimated") == E["prompt_budget"] + 123


@scale_param
async def test_over_reason_overhead_sans_comptage(ctx, monkeypatch):
    async def _boom(messages, model_id=None):
        raise AssertionError("le cas overhead doit sortir AVANT tout comptage")

    _patch_counts(monkeypatch, _boom)
    msgs = _flat_conv(5)
    stats: dict = {}
    out = await enforce_context_budget(
        msgs, ctx, model_id="m", gen_cap_tokens=0,
        fixed_overhead_tokens=ctx, stats_out=stats)
    assert out == msgs
    assert stats.get("over_reason") == "overhead"
    assert stats.get("budget") <= 0, "les schémas d'outils mangent tout le budget"


# ── Fast-path : bord exact ──────────────────────────────────────────────────

@scale_param
async def test_fastpath_bord_exact(ctx, monkeypatch):
    """À int(budget×0.85) tokens réels le comptage exact est SAUTÉ ; un token
    de plus et il redevient obligatoire — rigueur intacte près du bord."""
    E = expected(ctx)
    msgs = _flat_conv(8)

    # Au bord : projection ≤ marge → /tokenize jamais appelé.
    async def _boom(messages, model_id=None):
        raise AssertionError("comptage exact appelé — le fast-path devait le sauter")

    _patch_counts(monkeypatch, _boom)
    stats: dict = {}
    out = await fit_context(
        msgs, ctx_size=ctx, model_id="m", thinking_mode=False,
        tools_fixed_tokens=0,
        real_ctx_tokens=E["fastpath_edge"], real_ctx_msg_count=len(msgs),
        stats_out=stats)
    assert stats["fastpath"] is True and stats["dropped"] == 0
    assert out == msgs

    # Un token au-dessus du bord : comptage exact requis.
    called: list = []

    async def _count(messages, model_id=None):
        called.append(len(messages))
        return [10] * len(messages)

    _patch_counts(monkeypatch, _count)
    stats2: dict = {}
    await fit_context(
        msgs, ctx_size=ctx, model_id="m", thinking_mode=False,
        tools_fixed_tokens=0,
        real_ctx_tokens=E["fastpath_edge"] + 1, real_ctx_msg_count=len(msgs),
        stats_out=stats2)
    assert stats2["fastpath"] is False
    assert called, "au-dessus du bord, le budget dur doit re-compter"


@scale_param
async def test_fastpath_delta_estime_le_pousse_au_comptage(ctx, monkeypatch):
    """Mesure réelle confortable MAIS un gros tool_result apparu depuis :
    la projection (réel + estimation du delta) franchit le bord → comptage."""
    E = expected(ctx)
    real = E["fastpath_edge"] - 50_000          # confortable seul…
    msgs = _flat_conv(6) + shell_round(0, 300_000)   # …+ ~91k tokens de delta
    real_count = len(msgs) - 2                  # les 2 messages du round = delta

    called: list = []

    async def _count(messages, model_id=None):
        called.append(len(messages))
        return [10] * len(messages)

    _patch_counts(monkeypatch, _count)
    stats: dict = {}
    await fit_context(
        msgs, ctx_size=ctx, model_id="m", thinking_mode=False,
        tools_fixed_tokens=0,
        real_ctx_tokens=real, real_ctx_msg_count=real_count, stats_out=stats)
    assert stats["fastpath"] is False
    assert called, "le delta estimé (~91k tokens) devait pousser au comptage"


# ── fit_context : stats dropped + non-mutation ─────────────────────────────

@scale_param
async def test_fit_stats_dropped_et_non_mutation(ctx, monkeypatch):
    E = expected(ctx)
    per_msg = {CTX_256K: 10_000, CTX_1M: 30_000}[ctx]
    n = 40

    async def _counts(messages, model_id=None):
        return [per_msg] * len(messages)

    _patch_counts(monkeypatch, _counts)
    msgs = _flat_conv(n)
    snapshot = copy.deepcopy(msgs)
    # Retrait jusqu'au filigrane bas (hystérésis, AUDIT 2026-09-25).
    _target = int(E["prompt_budget"] * _pruning._DROP_LOW_WATERMARK)
    want_drops = -(-(n * per_msg - _target) // per_msg)   # ceil
    want_drops += want_drops % 2      # tête alignée sur un user (cf. n° 16)
    assert 0 < want_drops <= n - 1 - _pruning.effective_keep_recent(n), \
        "fixture : le drop doit être possible sans toucher la queue protégée"

    stats: dict = {}
    out = await fit_context(
        msgs, ctx_size=ctx, model_id="m", thinking_mode=False,
        tools_fixed_tokens=0, stats_out=stats)
    assert stats["fastpath"] is False, "aucune mesure réelle → chemin exact"
    assert stats["dropped"] == want_drops
    assert len(out) == n - want_drops
    assert msgs == snapshot, "working_messages ne doit JAMAIS être muté"
