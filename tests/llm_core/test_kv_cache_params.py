# SPDX-License-Identifier: MIT
"""tests/llm_core/test_kv_cache_params.py — params de réutilisation KV (source unique).

Couvre ``llm_core._constants.apply_kv_cache_params`` : régression du bug où le
champ ``cache_reuse`` (NON reconnu par llama-server) était envoyé à la place de
``n_cache_reuse`` → la réutilisation partielle du KV n'était jamais active.
"""
from __future__ import annotations

import importlib

from llm_core._constants import LLAMA_CACHE_REUSE_TOKENS, apply_kv_cache_params


def _run():
    payload: dict = {}
    apply_kv_cache_params(payload)
    return payload


def test_emits_correct_field_name():
    # Le champ RÉEL côté llama-server est n_cache_reuse — pas cache_reuse.
    payload = _run()
    assert "n_cache_reuse" in payload
    assert "cache_reuse" not in payload, (
        "regression: 'cache_reuse' n'est pas reconnu par llama-server, "
        "le champ doit être 'n_cache_reuse'"
    )


def test_cache_prompt_enabled_by_default():
    assert _run()["cache_prompt"] is True


def test_reuse_value_matches_constant():
    assert _run()["n_cache_reuse"] == LLAMA_CACHE_REUSE_TOKENS


def test_default_reuse_is_min_chunk_256():
    # 256 = min chunk size recommandé (ggerganov). L'ancien défaut 2048 était une
    # mécompréhension (pensé comme un "trou max") et rendait la réutilisation
    # MOINS agressive.
    assert LLAMA_CACHE_REUSE_TOKENS == 256


def test_reuse_omitted_when_disabled(monkeypatch):
    # LLAMA_CACHE_REUSE_TOKENS=0 -> on n'envoie pas le champ du tout.
    import llm_core._constants as C
    monkeypatch.setattr(C, "LLAMA_CACHE_REUSE_TOKENS", 0)
    payload: dict = {}
    C.apply_kv_cache_params(payload)
    assert "n_cache_reuse" not in payload
    assert payload.get("cache_prompt") is True


def test_cache_prompt_omitted_when_disabled(monkeypatch):
    import llm_core._constants as C
    monkeypatch.setattr(C, "LLAMA_CACHE_PROMPT", False)
    payload: dict = {}
    C.apply_kv_cache_params(payload)
    assert "cache_prompt" not in payload
