# SPDX-License-Identifier: MIT
"""llm_core.context.budget — TOUS les ratios/planchers de la fenêtre de
contexte, en un seul objet gelé.

Avant (audit 2026-07, diagnostic #12) : 0.18/3072 dans ``_chat_with_tools``,
0.75 inline, 0.50/3.5 pour la compaction, tiers 0.12/0.04/0.008 et split 0.7
en littéraux dans les corps de fonctions, 12000/2500/200 en module — aucun
dans ``context_config`` qui ne gouvernait que le wording.

Désormais : ``ContextBudget`` (dataclass frozen) chargé UNE fois au boot,
surchargeable à froid via ``context_config.json`` section ``budgets``
(clés numériques du même nom que les champs). ``_chat_with_tools`` aliase
ses constantes historiques sur ``BUDGET`` (valeurs identiques) ; le pipeline
``pruning`` (Phase 2) consomme directement les champs.

La borne de GÉNÉRATION (0.4·n_ctx, plancher 2048) reste implémentée dans
``llm_core._constants.effective_generation_cap`` (elle clampe le payload,
pas le prompt) — ``generation_cap()`` y délègue pour n'avoir qu'une source.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Optional


@dataclass(frozen=True)
class ContextBudget:
    # ── Réserve de sortie (prompt ≤ n_ctx − réserve) ─────────────────────
    # La réserve DOIT couvrir le cap de génération réellement autorisé
    # (bug C2a : reserve < gen_cap → finish=length en plein tool_call).
    output_reserve_ratio: float = 0.18
    output_reserve_min: int = 3072
    # Sur un très petit n_ctx, ne pas réserver au point de ne rien laisser
    # au prompt (≥ 25 % pour les messages).
    reserve_ceiling_ratio: float = 0.75

    # Messages récents toujours préservés par le budget dur = le tour
    # courant (réponse et résultats d'outils déjà produits).
    # 10 → 16 (audit 2026-08-01) : en régime agentique un cycle d'outil vaut
    # DEUX messages (assistant.tool_calls + tool result), donc 10 ne
    # sanctuarisait que 5 cycles — le modèle perdait le contexte immédiat de
    # ce qu'il venait de faire dès que le budget serrait. L'élagage intra-run
    # (marques appliquées dans ``fit_context``) allège la queue par ailleurs,
    # ce qui rend cette fenêtre plus large finançable.
    keep_recent_msgs: int = 16

    # ── Élagage des tool_results : harnais v4 (M4) ───────────────────────
    # Les vagues par itération pilotées en CHARS (trigger/protect/min_reclaim/
    # level ×3.5) sont SUPPRIMÉES — l'élagage vit en fin de tour, en TOKENS,
    # avec marques persistées (``pruning.select_prune_keys``, config
    # ``llm.prune.*``). Il ne reste ici que les caps d'émission et le filet.

    # ── Cap d'ÉMISSION d'un résultat d'outil (à l'append, vue modèle) ────
    # Harnais v4 (T0, 2026-07-28) : le cap est exprimé en TOKENS et dérivé
    # du n_ctx — cap_tokens = clamp(emit_cap_min_tokens, emit_cap_ratio ×
    # n_ctx, emit_cap_max_tokens) ; n_ctx inconnu → plancher. La COUPE est
    # matérialisée en chars via le ratio MESURÉ du modèle (coupe unique à
    # l'émission — jamais re-coupée). Équivalents de l'ancien barème chars :
    # 8000 ch ↔ ~2400 tk, 55k ch à 262k ↔ 0.06·ctx tk, plafond 100k ch ↔ 25k tk.
    emit_cap_min_tokens: int = 2400
    emit_cap_ratio: float = 0.06
    emit_cap_max_tokens: int = 25_000
    # Filet structurel du sanitize (contenu tool pathologique) — en TOKENS,
    # matérialisé via le ratio STABLE (le filet est ré-évalué à chaque tour
    # sur du contenu stocké : un ratio mouvant re-couperait → KV instable).
    sanitize_tool_max_tokens: int = 50_000
    # Troncature tête+queue : part de la TÊTE (le reste va à la queue).
    head_split: float = 0.7

    # ── Chargement / dérivations ─────────────────────────────────────────

    @classmethod
    def load(cls) -> "ContextBudget":
        """Défauts ci-dessus, surchargés champ par champ via
        ``context_config.json`` → ``budgets.<nom_du_champ>`` (numérique).
        Valeur absente/invalide → défaut. Figé au boot, comme le reste de
        context_config."""
        try:
            from llm_core.context_config import CTX
        except Exception:
            return cls()
        kwargs = {}
        for f in fields(cls):
            raw = CTX.budget_raw(f.name)
            if raw is None:
                continue
            default = getattr(cls, f.name)
            try:
                kwargs[f.name] = type(default)(raw)   # cast au type du défaut
            except (TypeError, ValueError):
                continue
        return cls(**kwargs)

    def reserve_tokens(self, ctx_size: int, gen_cap_tokens: Optional[int]) -> int:
        """Réserve de sortie effective — réplique EXACTE du calcul du budget
        dur historique (``_enforce_context_budget``) : max(plancher,
        ratio·n_ctx, gen_cap) plafonné à ``reserve_ceiling_ratio``·n_ctx."""
        reserve = max(self.output_reserve_min,
                      int(ctx_size * self.output_reserve_ratio),
                      int(gen_cap_tokens or 0))
        return min(reserve, int(ctx_size * self.reserve_ceiling_ratio))

    def prompt_budget(self, ctx_size: int, gen_cap_tokens: Optional[int],
                      fixed_overhead_tokens: int = 0) -> int:
        """Budget de tokens disponible pour les MESSAGES : n_ctx − réserve −
        surcoût fixe (schéma des tools). Peut être ≤ 0 (l'appelant renonce)."""
        return ctx_size - self.reserve_tokens(ctx_size, gen_cap_tokens) \
            - max(0, int(fixed_overhead_tokens or 0))

    def generation_cap(self, thinking_mode: bool,
                       ctx_size: Optional[int]) -> int:
        """Cap de génération — délègue à la source unique
        ``_constants.effective_generation_cap`` (0.4·n_ctx, plancher 2048)."""
        from llm_core._constants import effective_generation_cap
        return effective_generation_cap(thinking_mode, ctx_size)


BUDGET = ContextBudget.load()
