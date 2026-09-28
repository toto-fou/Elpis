# SPDX-License-Identifier: MIT
"""llm_core._token_estimate — SHIM de compatibilité (Phase 1 du refactor).

L'autorité de comptage vit désormais dans ``llm_core.context.tokens``
(exact-first + fallback unifié 3.3). Ce module ne fait que ré-exporter les
noms historiques pour les importeurs existants (conversation_compressor,
context_config, tests) — retrait prévu en Phase 7.
"""
from __future__ import annotations

from llm_core.context.tokens import (  # noqa: F401
    CHARS_PER_TOKEN,
    MSG_OVERHEAD_TOKENS,
    est_tokens_message,
    est_tokens_text,
    image_forfait_tokens,
    image_token_cost,
)
