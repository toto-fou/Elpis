# SPDX-License-Identifier: MIT
"""tests/llm_core/test_no_mutation_pipeline.py — verrouillage par test de la
NON-MUTATION du pipeline de préparation du prompt (AUDIT 2026-06, style E1 :
« vérifier + verrouiller » plutôt que réécrire).

Les transformateurs ne doivent JAMAIS muter ``working_messages`` en place :
l'historique persisté (tool_history) partage ces dicts — une mutation ici
corromprait ce qui est sauvegardé en DB. Vérifié pour :
  - ``select_prune_keys``         (sélection d'élagage fin de tour, M4)
  - ``enforce_context_budget``    (drop des plus vieux messages)
  - ``_split_by_turn_index``      (découpage du compresseur)
"""
from __future__ import annotations

import copy

import pytest

from llm_core.context.pruning import enforce_context_budget, select_prune_keys
from llm_core.conversation_compressor import _split_by_turn_index


def _agentic_history(n_tools: int = 8, blob: str = "x" * 9000):
    msgs = [{"role": "system", "content": "sys"},
            {"role": "user", "content": "fais un truc"}]
    for i in range(n_tools):
        msgs.append({"role": "assistant", "content": "",
                     "tool_calls": [{"id": f"c{i}", "type": "function",
                                     "function": {"name": "t", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": blob})
    msgs.append({"role": "assistant", "content": "fin"})
    return msgs


@pytest.mark.asyncio
async def test_select_prune_keys_does_not_mutate_input(monkeypatch):
    import llm_core.context.pruning as _pruning

    async def fake_counts(messages, model_id=None):
        return [3_000] * len(messages)

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", fake_counts)
    msgs = _agentic_history(n_tools=10)
    snapshot = copy.deepcopy(msgs)
    # ctx petit → protect 20 % vite dépassé, gain ≥ min → sélection réelle.
    keys = await select_prune_keys(msgs, ctx_size=32_768)
    assert msgs == snapshot, "l'entrée a été mutée en place"
    # Sanity : la sélection a bien produit des clés (sinon test sans valeur).
    assert keys, "aucune clé sélectionnée — test sans valeur"


@pytest.mark.asyncio
async def test_enforce_budget_does_not_mutate_input(monkeypatch):
    import llm_core.context.pruning as _pruning
    # Comptage déterministe (pas de llama-server en test) : ~1 token/char,
    # substitué là où ``enforce_context_budget`` le lit.
    async def fake_count(messages, model_id=None):
        return [len(str(m.get("content") or "")) + 50 for m in messages]
    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", fake_count)

    msgs = _agentic_history(n_tools=6, blob="y" * 3000)
    snapshot = copy.deepcopy(msgs)
    out = await enforce_context_budget(msgs, ctx_size=4096)
    assert msgs == snapshot, "l'entrée a été mutée en place"
    assert len(out) < len(msgs), "le budget n'a rien retiré — test sans valeur"


def test_compressor_split_does_not_mutate_input():
    msgs = _agentic_history(n_tools=4, blob="z" * 500)
    snapshot = copy.deepcopy(msgs)
    _split_by_turn_index(msgs, keep_recent_turns=1, keep_bridge_turns=1)
    assert msgs == snapshot, "l'entrée a été mutée en place"
