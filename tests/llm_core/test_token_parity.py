# SPDX-License-Identifier: MIT
"""tests/llm_core/test_token_parity.py — parité des compteurs (Phase 0).

Fige les VALEURS actuelles de chaque estimateur de tokens sur un corpus
déterministe. La Phase 1 (déménagement vers ``llm_core/context/tokens.py``)
doit reproduire ces nombres EXACTEMENT — un déplacement ne change pas un
compte. Toute divergence = régression du move, pas une « amélioration ».

NOTE Phase 1 : ``CTX.est_tokens`` utilise aujourd'hui ``tokens_per_char``
= 0.25 (context_config.json) qui DIVERGE du ratio unifié 1/3.3 — le test le
documente ; le retrait prévu de la clé JSON changera cette valeur-là
(mise à jour délibérée du test à ce moment-là).
"""
from __future__ import annotations

from llm_core import _token_estimate as te
from llm_core.context_config import CTX
from llm_core.conversation_compressor import _estimate_tokens as compr_estimate

TEXTS = ["", "a", "hello world", "é" * 10, "x" * 1000, "def f(x):\n    return x*2\n"]

MSGS = [
    {"role": "user", "content": "hello world"},
    {"role": "assistant", "content": None, "tool_calls": [
        {"id": "1", "type": "function",
         "function": {"name": "t", "arguments": "{\"a\": 1}"}}]},
    {"role": "tool", "tool_call_id": "1", "content": "{\"ok\": true}"},
    {"role": "user", "content": [
        {"type": "text", "text": "regarde"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
    {"role": "system", "content": "SOCLE"},
]

def test_constantes_unifiees():
    assert te.CHARS_PER_TOKEN == 3.3
    assert te.MSG_OVERHEAD_TOKENS == 8
    assert te.image_token_cost() == 1500


def test_est_tokens_text_parity():
    assert [te.est_tokens_text(t) for t in TEXTS] == [0, 0, 3, 3, 303, 7]


def test_est_tokens_message_parity():
    # 4e message : multimodal → forfait image (1500) inclus.
    assert [te.est_tokens_message(m) for m in MSGS] == [11, 10, 11, 1510, 9]


def test_image_forfait_parity():
    assert te.image_forfait_tokens(MSGS) == 1500


def test_compressor_estimate_meme_base():
    # Le compresseur compte sur la MÊME base que _token_estimate (3.3) :
    # somme exacte des est_tokens_message. C'est l'unification que la
    # Phase 1 doit préserver.
    assert compr_estimate(MSGS) == 1551
    assert compr_estimate(MSGS) == sum(te.est_tokens_message(m) for m in MSGS)


def test_ctx_est_tokens_unifie_depuis_phase1():
    # Phase 1 : la clé JSON ``budgets.tokens_per_char`` (0.25 → ratio 4.0,
    # diagnostic #2 de l'audit) est RETIRÉE — CTX.est_tokens délègue au
    # ratio unifié 1/3.3 comme tout le reste de l'app (avant : 25).
    assert CTX.est_tokens("x" * 100) == 30


def test_shim_token_estimate_pointe_sur_l_autorite():
    # _token_estimate est un shim : mêmes objets que context.tokens (un
    # importeur historique et un importeur Phase 1 comptent PAREIL).
    from llm_core.context import tokens as auth
    assert te.est_tokens_message is auth.est_tokens_message
    assert te.est_tokens_text is auth.est_tokens_text
    assert te.CHARS_PER_TOKEN == auth.CHARS_PER_TOKEN == 3.3
