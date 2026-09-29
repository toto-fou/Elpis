# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_token_estimate.py — heuristique chars→tokens UNIFIÉE
(llm_core._token_estimate) + propagation du flag « estimé ».

Couvre :
- ratio unique : compresseur / _chat_with_tools / context_config donnent le
  MÊME compte pour le même message (fin des 4 / 3 / 3.3 divergents) ;
- tool_calls comptés (non-régression : la porte tokens du compresseur était
  neutralisée sur les conversations agentic si les arguments étaient ignorés) ;
- forfait image (CTX_IMAGE_TOKEN_COST) appliqué partout ;
- variantes ``*_ex`` par-message : (valeurs, n_fallback) — exact via /tokenize
  mocké, fallback heuristique compté.
"""
from __future__ import annotations

import pytest

from llm_core._token_estimate import (
    CHARS_PER_TOKEN,
    MSG_OVERHEAD_TOKENS,
    est_tokens_message,
    est_tokens_text,
    image_token_cost,
)

# ──────────────────────────────────────────────────────────────────────────
# Ratio unifié
# ──────────────────────────────────────────────────────────────────────────

def _msg_texte_et_tools():
    return {
        "role": "user",
        "content": "x" * 330,
        "tool_calls": [
            {"function": {"name": "grep", "arguments": '{"pattern": "' + "y" * 100 + '"}'}},
        ],
    }


def test_ratio_unique_partout():
    import llm_core.context.tokens as tok
    from llm_core.context.tokens import est_tokens_message as autorite, measured_prompt_tokens
    from llm_core.conversation_compressor import _estimate_tokens
    tok._measured_ratio.clear()   # amorce froide déterministe
    m = _msg_texte_et_tools()
    attendu = est_tokens_message(m)
    assert autorite(m) == attendu           # shim ≡ autorité (Phase 1)
    # Harnais v4 : le repli du compresseur passe par le ratio MESURÉ
    # (amorce 3.3 → parité avec measured_prompt_tokens, pas avec la somme
    # des arrondis par composant de l'ancienne heuristique).
    assert _estimate_tokens([m]) == measured_prompt_tokens([m])
    # Et le ratio texte pur suit bien CHARS_PER_TOKEN.
    assert est_tokens_text("z" * 330) == int(330 / CHARS_PER_TOKEN)


def test_context_config_default_tpc_unifie():
    from llm_core.context_config import ContextConfig
    assert ContextConfig({})._tpc == pytest.approx(1.0 / CHARS_PER_TOKEN)
    # L'override JSON reste prioritaire.
    assert ContextConfig({"budgets": {"tokens_per_char": 0.5}})._tpc == 0.5


def test_tool_calls_comptes():
    """Un message assistant SANS content mais avec de gros arguments d'outil
    doit peser son poids — pas ~MSG_OVERHEAD_TOKENS."""
    m = {"role": "assistant", "content": None,
         "tool_calls": [{"function": {"name": "write_file",
                                      "arguments": "a" * 3300}}]}
    n = est_tokens_message(m)
    assert n >= 1000  # ~3300/3.3 = 1000 tokens d'arguments


def test_forfait_image():
    img = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
    m = {"role": "user", "content": [img, img, {"type": "text", "text": "légende"}]}
    n = est_tokens_message(m)
    assert n >= 2 * image_token_cost()
    # Le compresseur compte pareil (l'ancienne version ignorait les images).
    from llm_core.conversation_compressor import _estimate_tokens
    assert _estimate_tokens([m]) == n


def test_message_vide_overhead_seul():
    assert est_tokens_message({"role": "user", "content": ""}) == MSG_OVERHEAD_TOKENS


def test_image_forfait_tokens_helper():
    """Helper PARTAGÉ jauge/compresseur : forfait par bloc image, zéro sinon."""
    from llm_core._token_estimate import image_forfait_tokens
    assert image_forfait_tokens([]) == 0
    assert image_forfait_tokens(None) == 0
    assert image_forfait_tokens([{"role": "user", "content": "texte"}]) == 0
    msgs = [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "a"}},
        {"type": "text", "text": "x"},
        {"type": "image", "source": {}},
    ]}]
    assert image_forfait_tokens(msgs) == 2 * image_token_cost()


# ──────────────────────────────────────────────────────────────────────────
# Variantes _ex — flag estimated
# ──────────────────────────────────────────────────────────────────────────

async def test_count_messages_tokens_per_msg_ex_exact(monkeypatch):
    import llm_core.context.tokens as cwt  # Phase 1 : autorité de comptage

    async def _fake_exact(text, model_id=None, timeout=None):
        return len(text)  # « tokenizer » déterministe

    monkeypatch.setattr(cwt, "count_tokens_exact", _fake_exact)
    msgs = [{"role": "user", "content": "abc"}, {"role": "assistant", "content": "defg"}]
    counts, n_fallback = await cwt.count_messages_tokens_per_msg_ex(msgs)
    assert n_fallback == 0
    assert all(c > 0 for c in counts)


async def test_count_messages_tokens_per_msg_ex_fallback(monkeypatch):
    import llm_core.context.tokens as cwt  # Phase 1 : autorité de comptage

    async def _boom(text, model_id=None, timeout=None):
        raise RuntimeError("tokenize down")

    monkeypatch.setattr(cwt, "count_tokens_exact", _boom)
    msgs = [{"role": "user", "content": "abc"}, {"role": "assistant", "content": "defg"}]
    counts, n_fallback = await cwt.count_messages_tokens_per_msg_ex(msgs)
    assert n_fallback == 2                     # les 2 messages non vides en fallback
    assert counts == [est_tokens_message(m) for m in msgs]


async def test_compressor_count_tokens_async_ex(monkeypatch):
    import llm_core._llama_http as lh
    from llm_core.conversation_compressor import _count_tokens_async_ex
    msgs = [{"role": "user", "content": "salut"}]

    async def _exact(messages, model_id=None, timeout=None):
        return 42

    monkeypatch.setattr(lh, "count_tokens_for_messages", _exact)
    assert await _count_tokens_async_ex(msgs) == (42, False)

    async def _none(messages, model_id=None, timeout=None):
        return None

    monkeypatch.setattr(lh, "count_tokens_for_messages", _none)
    n, est = await _count_tokens_async_ex(msgs)
    assert est is True and n == est_tokens_message(msgs[0])
