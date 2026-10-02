# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_system_message_coalesce.py

Régression — appels MCP/chat en HTTP 400 sur llama.cpp récent avec plusieurs
messages ``system``.

Les chat templates récents (Qwen3.5…) lèvent « System message must be at the
beginning » dès qu'un 2e message ``system`` apparaît OU qu'un ``system`` n'est
pas en position 0. L'app injecte légitimement un 2e ``system`` (runtime_context
sandbox + fragments de capacité) quand des outils fs/shell/git sont actifs → 400.

``_coalesce_system_messages`` (appliqué DANS ``_clamp_messages``, le chokepoint
partagé des deux chemins) fusionne tous les ``system`` en un seul en tête.
Vérifié EN LIVE contre un serveur b9592 (400→200). Ce test verrouille sans réseau.
"""
from __future__ import annotations

from llm_core._chat_classic import _clamp_messages, _coalesce_system_messages


def test_merges_multiple_systems_into_one_leading():
    msgs = [
        {"role": "system", "content": "BASE"},
        {"role": "system", "content": "RUNTIME_CTX"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "yo"},
    ]
    out = _coalesce_system_messages(msgs)
    assert [m["role"] for m in out] == ["system", "user", "assistant"]
    assert out[0]["content"] == "BASE\n\nRUNTIME_CTX"
    assert out[1:] == msgs[2:]


def test_noop_single_leading_system_preserves_identity():
    msgs = [{"role": "system", "content": "X"}, {"role": "user", "content": "y"}]
    assert _coalesce_system_messages(msgs) is msgs   # même objet → prefix-cache intact


def test_noop_no_system():
    msgs = [{"role": "user", "content": "y"}, {"role": "assistant", "content": "z"}]
    assert _coalesce_system_messages(msgs) is msgs


def test_non_leading_single_system_moved_to_front():
    msgs = [{"role": "user", "content": "a"},
            {"role": "system", "content": "S"},
            {"role": "user", "content": "b"}]
    out = _coalesce_system_messages(msgs)
    assert out[0] == {"role": "system", "content": "S"}
    assert [m["role"] for m in out] == ["system", "user", "user"]


def test_list_content_system_text_extracted():
    msgs = [{"role": "system", "content": "A"},
            {"role": "system", "content": [{"type": "text", "text": "B"},
                                           {"type": "image_url", "image_url": {"url": "x"}}]},
            {"role": "user", "content": "hi"}]
    out = _coalesce_system_messages(msgs)
    assert out[0]["content"] == "A\n\nB"


def test_boundary_composition_yields_single_system():
    # Les fonctions d'envoi appliquent ``_coalesce_system_messages`` APRÈS
    # ``_clamp_messages`` (concerns séparés). Cette composition — exactement ce que
    # font _llama_chat_with_tools_stream / llama_chat_stream_tokens — produit
    # toujours UN SEUL system en tête, même sur une conv courte (le cas du 400 :
    # 3 messages, donc _clamp_messages ne clampe pas).
    msgs = [{"role": "system", "content": "BASE"},
            {"role": "system", "content": "RUNTIME_CTX"},
            {"role": "user", "content": "liste les fichiers"}]
    out = _coalesce_system_messages(list(_clamp_messages(msgs, max_msgs=200)))
    assert sum(1 for m in out if m.get("role") == "system") == 1
    assert out[0]["content"] == "BASE\n\nRUNTIME_CTX"
    # _clamp_messages SEUL ne coalesce PAS (contrat préservé : il préserve les
    # system séparés, cf. test_clamp_messages.py).
    assert sum(1 for m in _clamp_messages(msgs, max_msgs=200)
               if m.get("role") == "system") == 2


# ──────────────────────────────────────────────────────────────────────────
# _fold_operational_block — le porteur d'état de compression n'est pas avalé
# (régression F1 : porteur fusionné dans la tête → recompression jetait tout
# le socle ; le fold saute désormais les porteurs, coalescés à l'envoi seul)
# ──────────────────────────────────────────────────────────────────────────

from llm_core.context.assembly import fold_operational_block as _fold_operational_block  # noqa: E402
from llm_core.conversation_compressor import build_state_system_message  # noqa: E402


def test_fold_sans_porteur_comportement_historique():
    msgs = [{"role": "system", "content": "BASE"},
            {"role": "system", "content": "SKILLS"},
            {"role": "user", "content": "hi"}]
    _fold_operational_block(msgs, "OP")
    assert [m["role"] for m in msgs] == ["system", "user"]
    assert msgs[0]["content"] == "BASE\n\n---\n\nSKILLS\n\n---\n\nOP"


def test_fold_saute_le_porteur():
    carrier = build_state_system_message("<context>s</context>", 1, 4)
    msgs = [{"role": "system", "content": "BASE"}, carrier,
            {"role": "user", "content": "hi"}]
    _fold_operational_block(msgs, "OP")
    systems = [m for m in msgs if m["role"] == "system"]
    assert len(systems) == 2
    assert systems[0]["content"] == "BASE\n\n---\n\nOP"
    assert systems[1] is carrier          # porteur intact, même objet


def test_fold_porteur_entre_deux_socles():
    carrier = build_state_system_message("<context>s</context>", 1, 4)
    msgs = [{"role": "system", "content": "BASE"}, carrier,
            {"role": "system", "content": "SKILLS"},
            {"role": "user", "content": "hi"}]
    _fold_operational_block(msgs, "OP")
    systems = [m for m in msgs if m["role"] == "system"]
    assert len(systems) == 2
    assert systems[0]["content"] == "BASE\n\n---\n\nSKILLS\n\n---\n\nOP"
    assert systems[1] is carrier


def test_fold_porteur_seul_op_devient_socle_en_tete():
    carrier = build_state_system_message("<context>s</context>", 1, 4)
    msgs = [carrier, {"role": "user", "content": "hi"}]
    _fold_operational_block(msgs, "OP")
    assert msgs[0] == {"role": "system", "content": "OP"}
    assert msgs[1] is carrier


def test_fold_sans_system_op_insere_en_tete():
    msgs = [{"role": "user", "content": "hi"}]
    _fold_operational_block(msgs, "OP")
    assert msgs[0] == {"role": "system", "content": "OP"}
