# SPDX-License-Identifier: MIT
"""tests/llm_core/test_context_budget.py — ContextBudget (Phase 1).

Les ratios de fenêtre vivent dans UNE dataclass gelée, surchargeable à froid
via context_config.json → budgets.*. Les alias historiques de
``_chat_with_tools`` doivent pointer sur les MÊMES valeurs (déplacement pur,
zéro changement de comportement), et ``reserve_tokens`` doit répliquer
exactement le calcul inline du budget dur (C2a : réserve ≥ gen_cap).
"""
from __future__ import annotations

import llm_core._chat_with_tools as _cwt
from llm_core.context.budget import BUDGET, ContextBudget


def test_defauts_identiques_aux_constantes_historiques():
    b = ContextBudget()
    assert (b.output_reserve_ratio, b.output_reserve_min) == (0.18, 3072)
    assert b.reserve_ceiling_ratio == 0.75
    # 10 → 16 (audit 2026-08-01) : PLAFOND de la queue protégée, en régime
    # agentique un cycle d'outil = 2 messages. La taille EFFECTIVE est bornée
    # à un tiers de la conversation (cf. pruning.effective_keep_recent) pour
    # qu'un échange court reste élagable.
    assert b.keep_recent_msgs == 16
    assert b.head_split == 0.7
    # Harnais v4 (T0/M4) : caps d'émission et filet sanitize en TOKENS ; les
    # champs chars des vagues (trigger/protect/min_reclaim/level ×3.5) sont
    # SUPPRIMÉS — l'élagage vit en fin de tour (llm.prune.*, tokens).
    assert (b.emit_cap_min_tokens, b.emit_cap_ratio, b.emit_cap_max_tokens) \
        == (2400, 0.06, 25_000)
    assert b.sanitize_tool_max_tokens == 50_000


def test_alias_chat_with_tools_pointent_sur_budget():
    assert _cwt._CTX_OUTPUT_RESERVE_RATIO == BUDGET.output_reserve_ratio
    assert _cwt._CTX_OUTPUT_RESERVE_MIN == BUDGET.output_reserve_min
    assert _cwt._CTX_KEEP_RECENT == BUDGET.keep_recent_msgs


def test_reserve_couvre_le_gen_cap_et_respecte_le_plafond():
    b = ContextBudget()
    # C2a : la réserve couvre le cap de génération (32K ctx, cap chat 16384).
    assert b.reserve_tokens(32768, 16384) == 16384
    # Sans cap : max(plancher, 0.18·ctx).
    assert b.reserve_tokens(32768, 0) == max(3072, int(32768 * 0.18))
    # Petit n_ctx : plafonné à 75 % (il reste ≥ 25 % pour le prompt).
    assert b.reserve_tokens(4096, 16384) == int(4096 * 0.75)


def test_prompt_budget_soustrait_reserve_et_overhead():
    b = ContextBudget()
    ctx, cap, tools = 32768, 16384, 3000
    assert b.prompt_budget(ctx, cap, tools) == ctx - 16384 - 3000
    # Peut être ≤ 0 : l'appelant renonce (comportement du budget dur).
    assert b.prompt_budget(4096, 16384, 4000) <= 0


def test_generation_cap_delegue_a_la_source_unique():
    from llm_core._constants import effective_generation_cap
    b = ContextBudget()
    for thinking in (False, True):
        for ctx in (None, 8192, 240_000):
            assert b.generation_cap(thinking, ctx) == \
                effective_generation_cap(thinking, ctx)


def test_surcharge_json_budgets(monkeypatch):
    from llm_core.context_config import CTX
    monkeypatch.setitem(CTX._raw, "budgets", {
        "output_reserve_min": 4096,
        "emit_cap_ratio": 0.08,
        "emit_cap_max_tokens": "30000",    # str numérique → casté
        "head_split": "pas un nombre",     # invalide → défaut conservé
    })
    b = ContextBudget.load()
    assert b.output_reserve_min == 4096
    assert b.emit_cap_ratio == 0.08
    assert b.emit_cap_max_tokens == 30_000
    assert b.head_split == 0.7             # défaut : valeur invalide ignorée
    assert b.output_reserve_ratio == 0.18  # non surchargé → défaut
