# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_resume_manual.py — reprise MANUELLE (« Continuer ») d'un
tour coupé en plein raisonnement.

Couvre le trio de trous qui rendait le Continue inutile (boucle infinie) :
  (a) le message think-only survit au round-trip (``_normalize_client_messages``
      conserve ``resume_thinking``/``thinkingTruncated``) ;
  (b) ``_expand_history_for_llm`` injecte une reprise MÊME à content vide :
      repli « <think>…</think> + consigne de conclusion » par défaut, forme
      NATIVE ``{assistant, content:"", reasoning_content}`` quand
      ``resume_native=True`` ;
  (c) ``save_chat`` strippe ``thinking`` mais PAS ``resume_thinking``.

+ le placeholder d'annulation « _(génération interrompue)_ » compte comme un
  contenu VIDE pour la reprise (le vrai état continuable est resume_thinking).
"""
from __future__ import annotations

from chatbot_app.turn.history import (
    _CANCEL_PLACEHOLDER,
    _RESUME_AFTER_THINK,
    _expand_history_for_llm,
    _normalize_client_messages,
)


# ── (b) expansion : reprise sur assistant think-only ─────────────────────────
def _thread(content="", resume="raisonnement coupé", extra=None):
    asst = {"role": "assistant", "content": content,
            "resume_thinking": resume, "thinkingTruncated": True}
    if extra:
        asst.update(extra)
    return [{"role": "user", "content": "tâche difficile"}, asst]


def test_continue_think_only_fallback_injects_closed_think_and_instruction():
    out = _expand_history_for_llm(_thread(), is_continue=True)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]
    assert out[1]["content"] == "<think>\nraisonnement coupé\n</think>"
    assert out[2]["content"] == _RESUME_AFTER_THINK


def test_continue_think_only_native_emits_terminal_reasoning_message():
    out = _expand_history_for_llm(_thread(), is_continue=True, resume_native=True)
    assert [m["role"] for m in out] == ["user", "assistant"]
    # Forme native TERMINALE : build_llama_payload arme continue_final_message
    # dessus → la génération reprend DANS le bloc think.
    assert out[-1] == {"role": "assistant", "content": "",
                       "reasoning_content": "raisonnement coupé"}


def test_continue_without_resume_thinking_keeps_legacy_behavior():
    # Content vide SANS resume_thinking : comportement historique (aucune
    # consigne — dégradé mais plus le cas nominal depuis la persistance).
    msgs = [{"role": "user", "content": "q"},
            {"role": "assistant", "content": ""}]
    out = _expand_history_for_llm(msgs, is_continue=True)
    assert [m["role"] for m in out] == ["user"]


def test_continue_with_content_still_uses_resume_instruction():
    # Une vraie réponse entamée garde la reprise TEXTE (pas la voie think).
    msgs = [{"role": "user", "content": "q"},
            {"role": "assistant", "content": "début de réponse",
             "resume_thinking": "pensées", "thinkingTruncated": True}]
    out = _expand_history_for_llm(msgs, is_continue=True)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]
    assert out[1]["content"] == "début de réponse"
    assert "Resume your previous answer" in out[2]["content"]


def test_cancel_placeholder_counts_as_empty_for_resume():
    out = _expand_history_for_llm(
        _thread(content=_CANCEL_PLACEHOLDER), is_continue=True)
    assert out[-1]["content"] == _RESUME_AFTER_THINK
    assert out[-2]["content"].startswith("<think>")


def test_continue_think_only_with_tool_history_appends_after_expansion():
    th = [
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "function": {"name": "read_file",
                                                  "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"ok": true}'},
    ]
    out = _expand_history_for_llm(
        _thread(extra={"tool_history": th, "tool_history_delta": True}),
        is_continue=True)
    roles = [m["role"] for m in out]
    # user, assistant(tool_calls), tool, puis la queue de reprise (repli).
    assert roles == ["user", "assistant", "tool", "assistant", "user"]
    assert out[-2]["content"].endswith("</think>")
    assert out[-1]["content"] == _RESUME_AFTER_THINK


def test_resume_thinking_is_clipped_in_expansion():
    from llm_core._think_resume import MAX_RESUME_THINKING_CHARS, RESUME_TRUNC_MARKER
    huge = "y" * (MAX_RESUME_THINKING_CHARS + 1000)
    out = _expand_history_for_llm(_thread(resume=huge), is_continue=True,
                                  resume_native=True)
    rt = out[-1]["reasoning_content"]
    assert rt.startswith(RESUME_TRUNC_MARKER)
    assert len(rt) == len(RESUME_TRUNC_MARKER) + MAX_RESUME_THINKING_CHARS


# ── (a) round-trip client : resume_thinking conservé ─────────────────────────
def test_normalize_keeps_resume_thinking_fields():
    _filtres, persistables = _normalize_client_messages([
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "",
         "resume_thinking": "pensées", "thinkingTruncated": True,
         "isTruncated": True, "champ_inconnu": "jeté"},
    ])
    asst = persistables[-1]
    assert asst["resume_thinking"] == "pensées"
    assert asst["thinkingTruncated"] is True
    assert "champ_inconnu" not in asst


def test_normalize_ignores_non_string_resume_thinking():
    _f, persistables = _normalize_client_messages([
        {"role": "assistant", "content": "", "resume_thinking": {"x": 1}},
    ])
    assert "resume_thinking" not in persistables[-1]


# ── (c) upsert_chat : thinking strippé, resume_thinking conservé ─────────────
def test_save_chat_strips_thinking_keeps_resume_thinking(tmp_path, monkeypatch):
    import json

    from shared_infra.chat import store as dbchats

    saved = {}

    class _Cur:
        rowcount = 1

        def execute(self, _sql, params=()):
            # Capture le blob messages_json de l'upsert (2e paramètre selon la
            # requête — on repère la STRING JSON parmi les params).
            for p in params:
                if isinstance(p, str) and p.startswith("["):
                    saved["mj"] = p
            return self

        def fetchone(self):
            return None

    class _Conn:
        def cursor(self):
            return _Cur()

        def commit(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    monkeypatch.setattr(dbchats, "db_conn", lambda: _Conn())

    dbchats.upsert_chat("u1", "c1", "t", [
        {"role": "assistant", "content": "",
         "thinking": "ne doit PAS être persisté",
         "resume_thinking": "doit être persisté",
         "thinkingTruncated": True},
    ], 0.0)
    msgs = json.loads(saved["mj"])
    assert "thinking" not in msgs[0]
    assert msgs[0]["resume_thinking"] == "doit être persisté"
    assert msgs[0]["thinkingTruncated"] is True
