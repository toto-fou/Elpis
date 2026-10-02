# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_expand_history_for_llm.py — expansion de l'historique
client → messages LLM (helper PARTAGÉ stream + compression manuelle,
extrait de la route en 2026-07).

Non-régressions clés :
- « Continuer » ×2 : le contenu du tronc fusionné n'est ré-injecté qu'UNE
  fois par reprise (pas de croissance quadratique de l'historique) ;
- tool_history : ré-expansion assistant(tool_calls)/tool intercalés ;
- déterminisme : même entrée → même structure de tours (le covered_turns
  persisté par la compression manuelle doit rester cohérent avec le stream).
"""
from __future__ import annotations

from chatbot_app.turn.history import _expand_history_for_llm
from llm_core.conversation_compressor import _count_turns

_REPRISE_SNIPPET = "Resume your previous answer"


def test_expand_simple_history_inchangee():
    msgs = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "q2"},
    ]
    out = _expand_history_for_llm(msgs)
    assert out == msgs


def test_expand_tool_history_intercalee():
    msgs = [
        {"role": "user", "content": "fais le"},
        {"role": "assistant", "content": "voilà.", "tool_history": [
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "c1", "function": {"name": "read_file", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": '{"ok": true}'},
        ]},
    ]
    out = _expand_history_for_llm(msgs)
    roles = [m["role"] for m in out]
    assert roles == ["user", "assistant", "tool", "assistant"]
    assert out[1]["tool_calls"][0]["id"] == "c1"
    assert out[2]["tool_call_id"] == "c1"
    assert out[3]["content"] == "voilà."


def test_continue_ajoute_reprise_une_fois():
    msgs = [
        {"role": "user", "content": "écris long"},
        {"role": "assistant", "content": "début de réponse tronquée"},
    ]
    out = _expand_history_for_llm(msgs, is_continue=True)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]
    assert out[1]["content"] == "début de réponse tronquée"
    assert _REPRISE_SNIPPET in out[2]["content"]


def test_double_continue_pas_de_duplication():
    """Après le 1er Continue, le front fusionne tronc+suite dans UNE bulle
    assistant. Le 2e Continue ré-expanse cette bulle fusionnée : le contenu
    ne doit apparaître qu'UNE fois (croissance linéaire, pas de ré-injection
    en double), avec UN seul prompt de reprise."""
    merged = "début de réponse tronquée" + " suite après premier continue"
    msgs = [
        {"role": "user", "content": "écris long"},
        {"role": "assistant", "content": merged},
    ]
    out = _expand_history_for_llm(msgs, is_continue=True)
    assistants = [m for m in out if m["role"] == "assistant"]
    reprises = [m for m in out if m["role"] == "user" and _REPRISE_SNIPPET in (m.get("content") or "")]
    assert len(assistants) == 1
    assert len(reprises) == 1
    assert assistants[0]["content"] == merged
    # Le contenu du tronc n'apparaît pas en double dans le payload total.
    total = "\n".join(str(m.get("content") or "") for m in out)
    assert total.count("début de réponse tronquée") == 1


def test_continue_avec_tool_history_sur_le_dernier():
    msgs = [
        {"role": "user", "content": "fais le"},
        {"role": "assistant", "content": "réponse coupée", "tool_history": [
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "c1", "function": {"name": "t", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "r"},
        ]},
    ]
    out = _expand_history_for_llm(msgs, is_continue=True)
    roles = [m["role"] for m in out]
    # history expandée PUIS tronc PUIS reprise
    assert roles == ["user", "assistant", "tool", "assistant", "user"]
    assert _REPRISE_SNIPPET in out[-1]["content"]
    assert out[-2]["content"] == "réponse coupée"


def test_continue_dernier_assistant_vide_saute():
    """Tronc vide (annulation avant le 1er token) : pas de bulle fantôme ni
    de prompt de reprise orphelin."""
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "   "},
    ]
    out = _expand_history_for_llm(msgs, is_continue=True)
    assert [m["role"] for m in out] == ["user"]


def test_determinisme_tours_stream_vs_manuel():
    """La compression manuelle compte ses tours sur la MÊME expansion que le
    stream : covered_turns reste cohérent entre les deux chemins."""
    msgs = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1", "tool_history": [
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "c1", "function": {"name": "t", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "r"},
        ]},
        {"role": "user", "content": "q2"},
        {"role": "assistant", "content": "a2"},
    ]
    t1 = _count_turns(_expand_history_for_llm(msgs))
    t2 = _count_turns(_expand_history_for_llm(list(msgs)))
    # q1(1) + assistant tool_calls(1) + tool(0) + a1 finale post-tool(0)
    # + q2(1) + a2(1) = 4 tours
    assert t1 == t2 == 4


def test_expand_notice_exclue_de_la_vue_llm():
    """``role:notice`` (marqueur compaction) : affiché dans le fil, JAMAIS
    envoyé au modèle (role inconnu → 400 Jinja) ni compté dans les tours."""
    msgs = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
        {"role": "notice", "kind": "compaction", "ts": 1.0,
         "tokens_after": 8400, "content": "Conversation compactée"},
        {"role": "user", "content": "q2"},
    ]
    out = _expand_history_for_llm(msgs)
    assert all(m["role"] != "notice" for m in out)
    assert [m["content"] for m in out] == ["q1", "a1", "q2"]


def test_expand_continue_ignore_notice_terminale():
    """« Continuer » avec une notice APRÈS le dernier assistant : la consigne
    de reprise vise bien l'assistant (pas la notice)."""
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "réponse tronquée"},
        {"role": "notice", "kind": "compaction", "content": "compacté"},
    ]
    out = _expand_history_for_llm(msgs, is_continue=True)
    assert out[-1]["role"] == "user" and _REPRISE_SNIPPET.lower().split()[0] in out[-1]["content"].lower()
    assert out[-2] == {"role": "assistant", "content": "réponse tronquée"}


# ── _merge_continue_tool_history : fusion tronc + delta de continuation ──────
# (correctif « génération interrompue » 2026-07-27 : la boucle renvoie un
# DELTA du run → un Continue CONCATÈNE au tronc, il ne remplace plus.)

def test_merge_continue_tronc_delta_plus_suite_delta():
    from chatbot_app.turn.history import _merge_continue_tool_history
    prev = {"tool_history": [{"role": "tool", "tool_call_id": "c1", "content": "r1"}],
            "tool_history_delta": True}
    cont = [{"role": "tool", "tool_call_id": "c2", "content": "r2"}]
    out = _merge_continue_tool_history(prev, cont, True)
    assert [e["tool_call_id"] for e in out["tool_history"]] == ["c1", "c2"]
    assert out["tool_history_delta"] is True


def test_merge_continue_tronc_legacy_garde_format_legacy():
    """Tronc cumulatif (chat d'avant le correctif) + suite delta : concaténés,
    mais NON marqués delta → la dédup d'expansion coupera le préfixe rejoué."""
    from chatbot_app.turn.history import _merge_continue_tool_history
    prev = {"tool_history": [{"role": "tool", "tool_call_id": "c1", "content": "r1"}]}
    cont = [{"role": "tool", "tool_call_id": "c2", "content": "r2"}]
    out = _merge_continue_tool_history(prev, cont, True)
    assert len(out["tool_history"]) == 2
    assert out["tool_history_delta"] is False


def test_merge_continue_suite_vide_preserve_le_tronc():
    """Continuation sans outils (chemin classic) : le tronc et son marqueur
    survivent — avant le correctif, remplacer aurait tout perdu."""
    from chatbot_app.turn.history import _merge_continue_tool_history
    prev = {"tool_history": [{"role": "tool", "tool_call_id": "c1", "content": "r1"}],
            "tool_history_delta": True}
    out = _merge_continue_tool_history(prev, None, False)
    assert [e["tool_call_id"] for e in out["tool_history"]] == ["c1"]
    assert out["tool_history_delta"] is True


def test_merge_continue_sans_tronc_ni_suite():
    from chatbot_app.turn.history import _merge_continue_tool_history
    assert _merge_continue_tool_history({}, None, False) == {}
    assert _merge_continue_tool_history({}, [], True) == {}


def test_merge_continue_tronc_absent_suite_delta():
    from chatbot_app.turn.history import _merge_continue_tool_history
    cont = [{"role": "tool", "tool_call_id": "c9", "content": "r"}]
    out = _merge_continue_tool_history({}, cont, True)
    assert out["tool_history"] == cont
    assert out["tool_history_delta"] is True
