# SPDX-License-Identifier: MIT
"""llm_core.context.compression — compression de conversation (v3).

Découpage par responsabilité (Phase 3 du refactor) :

- ``serializer`` — sérialisation de l'historique pour le prompt de résumé +
                   **artifact ledger** (les fichiers touchés sont épinglés en
                   bloc déterministe, jamais confiés à la fidélité du LLM).
- ``state``      — état persisté {round, covered_turns, summary_xml} :
                   ``chats.meta_json`` en source de vérité (dual-read/write),
                   message in-band ``[COMPRESSION_META]`` en compat.

Le cœur du résumeur (``ConversationCompressor``, ``maybe_compress_conversation``)
vit encore dans ``llm_core.conversation_compressor`` (déménagement physique
prévu Phase 7 — le module historique restera une façade). Importer depuis ici
quand c'est possible.
"""
from __future__ import annotations

