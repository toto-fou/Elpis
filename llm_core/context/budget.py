# SPDX-License-Identifier: MIT
"""llm_core.context.budget — TOUS les ratios/planchers de la fenêtre de
contexte, en un seul objet gelé.

``ContextBudget`` (dataclass frozen) est chargé UNE fois au boot,
surchargeable à froid via ``context_config.json`` section ``budgets``
(clés numériques du même nom que les champs). Le pipeline ``pruning``
consomme directement ses champs. Ne pas recoder un ratio de la fenêtre en
littéral dans un corps de fonction : la surcharge ``budgets`` ne le verrait
pas.

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
    # (sinon reserve < gen_cap → finish=length en plein tool_call).
    output_reserve_ratio: float = 0.18
    output_reserve_min: int = 3072
    # Sur un très petit n_ctx, ne pas réserver au point de ne rien laisser
    # au prompt (≥ 25 % pour les messages).
    reserve_ceiling_ratio: float = 0.75

    # Messages récents toujours préservés par le budget dur = le tour
    # courant (réponse et résultats d'outils déjà produits).
    # 16 : en régime agentique un cycle d'outil vaut DEUX messages
    # (assistant.tool_calls + tool result), donc 16 sanctuarisent 8 cycles ;
    # plus bas, le modèle perd le contexte immédiat de ce qu'il vient de faire
    # dès que le budget serre. L'élagage intra-run (marques appliquées dans
    # ``fit_context``) allège la queue par ailleurs, ce qui rend cette
    # fenêtre finançable.
    keep_recent_msgs: int = 16

    # ── Élagage des tool_results ────────────────────────────────────────
    # L'élagage vit en fin de tour, en TOKENS, avec marques persistées
    # (``pruning.select_prune_keys``, config ``llm.prune.*``) : il n'a aucun
    # réglage ici. Restent les caps d'émission et le filet.

    # ── Cap d'ÉMISSION d'un résultat d'outil (à l'append, vue modèle) ────
    # Le cap est exprimé en TOKENS et dérivé du n_ctx — cap_tokens =
    # clamp(emit_cap_min_tokens, emit_cap_ratio × n_ctx, emit_cap_max_tokens) ;
    # n_ctx inconnu → plancher. La COUPE est matérialisée en chars via le ratio
    # MESURÉ du modèle (coupe unique à l'émission — jamais re-coupée).
    # Calibrage, en équivalents chars : ~2400 tk ↔ 8000 ch, 0.06·ctx tk ↔ 55k ch
    # à 262k, 25k tk ↔ 100k ch.
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
        """Réserve de sortie effective, source unique du budget dur
        (``pruning.enforce_context_budget``) : max(plancher, ratio·n_ctx,
        gen_cap) plafonné à ``reserve_ceiling_ratio``·n_ctx."""
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
