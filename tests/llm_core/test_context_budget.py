# SPDX-License-Identifier: MIT
"""tests/llm_core/test_context_budget.py — ContextBudget (Phase 1).

Les ratios de fenêtre vivent dans UNE dataclass gelée, surchargeable à froid
via context_config.json → budgets.*. La boucle n'en garde aucune copie
(une copie figée divergerait d'une surcharge), et ``reserve_tokens`` doit
répliquer exactement le calcul inline du budget dur (réserve ≥ gen_cap).
"""
from __future__ import annotations

import llm_core._chat_with_tools as _cwt
from llm_core.context.budget import ContextBudget


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


def test_la_boucle_ne_garde_pas_de_copie_des_budgets():
    """Les budgets se lisent dans ``BUDGET`` : aucune constante recopiée dans
    l'orchestrateur ni dans ses sous-routines."""
    import importlib
    import pkgutil

    import llm_core.engine as _engine
    modules = [_cwt] + [importlib.import_module(f"llm_core.engine.{m.name}")
                        for m in pkgutil.iter_modules(_engine.__path__)]
    recopies = {"_BUDGET", "_CTX_OUTPUT_RESERVE_RATIO", "_CTX_OUTPUT_RESERVE_MIN",
                "_CTX_KEEP_RECENT"}
    for mod in modules:
        copies = sorted(recopies & set(vars(mod)))
        assert not copies, f"{mod.__name__} recopie des budgets : {copies}"


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
