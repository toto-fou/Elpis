# SPDX-License-Identifier: MIT
"""llm_core.context — pipeline de gestion de la fenêtre de contexte.

La question « combien pèse ce prompt et que doit-il contenir ? » a sa
réponse ici, et nulle part ailleurs : un second chemin de comptage ou de
ratio divergerait (deux budgets différents pour le même prompt).

Responsabilité unique par module :

- ``tokens``   — L'AUTORITÉ de comptage : exact d'abord (``/tokenize`` +
                 ``/apply-template`` de llama-server, cache LRU), fallback
                 heuristique UNIQUE 3.3 chars/token. Personne d'autre ne
                 compte des tokens dans l'app.
- ``budget``   — TOUS les ratios/planchers de la fenêtre (réserve de sortie,
                 tiers de compaction, tail protégée…) dans une dataclass
                 gelée, surchargeable à froid via ``context_config.json``
                 (section ``budgets``).
- ``compaction_gate`` — les DEUX seuils de la compaction : plafond TECHNIQUE
                 (``n_ctx − cap de génération − buffer``, toujours armé) et
                 seuil EFFECTIF choisi par le compte (% de la fenêtre ou
                 tokens), armé à CHAQUE itération de la boucle outils — une
                 mission de plusieurs heures tient dans un seul tour. Porte
                 aussi le cap de compactions par conversation.
- ``pruning``  — pipeline ordonné de réduction : compaction des
                 tool_results → élagage vision → budget dur.
- ``assembly`` — assemblage byte-stable du message système de tête
                 (socle → runtime_context → fragments), invariant
                 prefix-cache.
- ``compression`` — porte + sérialiseur + résumeur + état persisté.
"""
from __future__ import annotations

from llm_core.context import tokens  # noqa: F401
from llm_core.context.budget import BUDGET, ContextBudget  # noqa: F401
from llm_core.context.compaction_gate import (  # noqa: F401
    AUTO as AUTO_COMPACTION_THRESHOLD,
    CompactionGate,
    CompactionThreshold,
    compaction_gate,
    gate_tokens,
    resolve_max_rounds,
    resolve_threshold,
    run_compaction_budget,
)
