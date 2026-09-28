# SPDX-License-Identifier: MIT
"""Quick wins 2026-07-13 — contrat de résultat unifié (Q1) et troncatures
honnêtes (Q2-S).

Couvre :
  * ``engine.result_contract.result_is_error`` = source UNIQUE, partagée par
    la boucle (``_result_is_error``) et le ledger (``serializer._result_ok``) ;
  * enveloppe d'erreur des builtins RAG → ``ok: false`` (l'ancienne forme
    2 clés ``{"error","hint"}`` était classée SUCCÈS) ;
  * ``pick_tool_payload`` : résultats MCP multi-blocs concaténés avec
    marqueur (avant : seul ``c[0]`` survivait, perte silencieuse) ;
  * préfixes mutants : ``manage_files``/``skill_save``/``skill_add_file``
    sérialisés ET ledgerisés (avant : pool parallèle + absents du ledger) ;
  * cap d'émission ``execute_shell`` : tête+queue (le bridge garde la queue,
    la coupe tête-seule jetait le verdict final) ; autres outils inchangés ;
  * marqueurs sur les coupes silencieuses (extraits RAG, stderr background).
"""
import json

import pytest

from llm_core.engine.result_contract import result_is_error


# ── Q1 : classifieur partagé ─────────────────────────────────────────────

def test_result_is_error_contract():
    assert result_is_error('{"ok": false, "error": "x"}') is True
    assert result_is_error('{"error": "x"}') is True                 # 1-clé
    # Règle 1-clé volontairement conservatrice : un dict multi-clés sans
    # ``ok`` n'est PAS un échec (payload de données d'un outil externe).
    assert result_is_error('{"error": "x", "hint": "y"}') is False
    assert result_is_error('{"results": [], "count": 0}') is False
    assert result_is_error("pas du JSON") is False
    assert result_is_error(None) is False
    assert result_is_error('["error"]') is False


def test_loop_and_ledger_share_the_classifier():
    from llm_core import _chat_with_tools
    from llm_core.context.compression import serializer
    assert _chat_with_tools._result_is_error is result_is_error
    assert serializer.result_is_error is result_is_error


def test_rag_error_envelope_is_classified_as_failure():
    from llm_core.tools.rag_tools import _rag_err
    raw = _rag_err("Module RAG non disponible.", hint="Check installation.")
    parsed = json.loads(raw)
    assert parsed["ok"] is False
    assert parsed["error"] == "Module RAG non disponible."
    assert parsed["hint"] == "Check installation."
    assert result_is_error(raw) is True
    # hint=None n'introduit pas de clé parasite
    assert "hint" not in json.loads(_rag_err("boom", hint=None))


# ── Q1 : pick_tool_payload multi-blocs ───────────────────────────────────

class _Block:
    def __init__(self, text):
        self.text = text


class _ImageBlock:
    pass


class _Result:
    def __init__(self, content):
        self.content = content


def test_pick_tool_payload_single_block_unchanged():
    from llm_core._chat_with_tools import pick_tool_payload
    assert pick_tool_payload(_Result([_Block('{"ok": true}')])) == {"ok": True}
    assert pick_tool_payload(_Result([_Block("texte libre")])) == "texte libre"


def test_pick_tool_payload_multiblock_concatenates_with_marker():
    from llm_core._chat_with_tools import pick_tool_payload
    out = pick_tool_payload(
        _Result([_Block("premier"), _Block("second"), _ImageBlock()]))
    assert isinstance(out, str)
    assert "premier" in out and "second" in out
    assert "[non-text content block: _ImageBlock]" in out
    # Pas de json.loads global sur la concaténation
    out2 = pick_tool_payload(_Result([_Block('{"a": 1}'), _Block('{"b": 2}')]))
    assert isinstance(out2, str) and '{"a": 1}' in out2 and '{"b": 2}' in out2


# ── Q1 : mutants complets (sérialisation + ledger) ───────────────────────

def test_serial_prefixes_cover_manage_files_and_skill_writes():
    from llm_core._constants import LLAMA_TOOL_SERIAL_PREFIXES
    for name in ("manage_files", "skill_save", "skill_add_file",
                 # (passe 7, H7) un écran / un onglet par session
                 "desktop_act", "desktop_observe", "pw_page", "pw_click"):
        assert any(name.startswith(p) for p in LLAMA_TOOL_SERIAL_PREFIXES), name
    # execute_shell reste parallèle (démultiplexé par call_id)
    assert not any("execute_shell".startswith(p)
                   for p in LLAMA_TOOL_SERIAL_PREFIXES)
    # session_search (lecture seule) reste parallèle
    assert not any("session_search".startswith(p)
                   for p in LLAMA_TOOL_SERIAL_PREFIXES)


def test_ledger_includes_manage_files_and_failed_status():
    from llm_core.context.compression.serializer import extract_artifact_ledger
    messages = [
        {"role": "assistant", "tool_calls": [
            {"id": "c1", "type": "function", "function": {
                "name": "manage_files",
                "arguments": json.dumps(
                    {"action": "batch_delete", "paths": ["/w/a.txt", "/w/b.txt"]}),
            }},
            {"id": "c2", "type": "function", "function": {
                "name": "skill_save",
                "arguments": json.dumps({"name": "mon-skill", "content": "x"}),
            }},
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"ok": true}'},
        {"role": "tool", "tool_call_id": "c2",
         "content": '{"ok": false, "error": "denied"}'},
    ]
    entries = extract_artifact_ledger(messages)
    by_op = {e.op: e for e in entries}
    assert "manage_files" in by_op, "manage_files doit entrer au ledger"
    assert by_op["manage_files"].path == "/w/a.txt (+1)"
    assert by_op["manage_files"].ok is True
    assert "skill_save" in by_op
    assert by_op["skill_save"].path == "mon-skill"
    assert by_op["skill_save"].ok is False


# ── Q2-S : émission shell tête+queue ─────────────────────────────────────

def test_emit_cap_shell_preserves_tail():
    from llm_core.context.pruning import emit_cap_chars, prepare_tool_result_for_model
    ctx = 32_768
    cap = emit_cap_chars(ctx)
    body = "HEAD_MARK " + ("x" * (cap * 3)) + " TAIL_VERDICT_OK"
    out = prepare_tool_result_for_model("execute_shell", body, ctx_tokens=ctx)
    assert len(out) < len(body)
    assert out.startswith("HEAD_MARK")
    assert out.rstrip().endswith("TAIL_VERDICT_OK")
    assert "chars omitted — result truncated at emission, tail preserved" in out


def test_emit_cap_other_tools_head_keep_unchanged():
    from llm_core.context.pruning import emit_cap_chars, prepare_tool_result_for_model
    ctx = 32_768
    cap = emit_cap_chars(ctx)
    body = ("y" * (cap * 2)) + "FIN"
    out = prepare_tool_result_for_model("read_file", body, ctx_tokens=ctx)
    assert "FIN" not in out                      # head-keep historique
    assert "…[result truncated," in out


def test_truncate_head_tail_default_marker_byte_stable():
    from llm_core.context.pruning import truncate_head_tail
    content = ("a" * 500) + "\n" + ("b" * 500)
    out = truncate_head_tail(content, 100)
    assert "— tool history compaction]…" in out   # défaut inchangé


def test_truncate_head_tail_respecte_strictement_la_limite():
    """2026-07-18 : la place du marqueur est RÉSERVÉE dans le budget — la
    sortie ne dépasse jamais ``limit`` (avant : limit + ~30-50 chars de
    marqueur ajoutés par-dessus). C'est cette garantie qui rend le filet
    sanitize idempotent."""
    from llm_core.context.pruning import truncate_head_tail
    contents = [("A" * 100 + "\n") * 25, "B" * 150_000, ("A" * 100 + "\n") * 2500]
    for c in contents:
        for limit in (200, 8000, 100_000, 200_000):
            if len(c) <= limit:
                continue
            out = truncate_head_tail(c, limit)
            assert len(out) <= limit, (len(c), limit, len(out))


def test_sanitize_filet_idempotent_des_la_premiere_passe():
    """Un contenu tool > _MAX_TOOL_CONTENT est coupé UNE fois puis plus jamais
    retouché (byte-identique aux passes suivantes). Avant : la coupe rendait
    ~cap+45 chars → chaque passe réécrivait le message (3 réécritures avant
    convergence) = invalidation du préfixe KV à cette profondeur à chaque
    tour + churn des clés du prune_memo."""
    from llm_core.context.pruning import sanitize_message_history
    c = ("A" * 100 + "\n") * 2500          # 252 500 chars > 200 000
    msgs = [
        {"role": "assistant", "content": None, "tool_calls": [{"id": "x", "type": "function",
            "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "x", "content": c},
    ]
    s1 = sanitize_message_history(msgs)
    # Repérage par RÔLE : la passe pose aussi une ancre de tâche quand
    # l'historique n'a aucun ``user`` (cf. _ensure_user_anchor), donc les
    # positions absolues ne sont plus un repère.
    tool_msg = next(m for m in s1 if m["role"] == "tool")
    assert len(tool_msg["content"]) <= 200_000
    s2 = sanitize_message_history(s1)
    assert s2 == s1                        # byte-stable dès la 1re coupe


def test_flatten_tool_messages_preserve_la_queue():
    """Le filet d'aplatissement de dernier recours coupait head-only à 8000
    chars en dur (le verdict final partait) — désormais tête+queue, aligné
    sur la philosophie du cap d'émission."""
    from llm_core._chat_with_tools import _flatten_tool_messages
    body = "HEAD_MARK " + ("x" * 20_000) + " TAIL_VERDICT_OK"
    msgs = [
        {"role": "assistant", "content": "avant",
         "tool_calls": [{"id": "c1", "type": "function",
                         "function": {"name": "execute_shell", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": body},
    ]
    out = _flatten_tool_messages(msgs)
    assert all(m.get("role") != "tool" and not m.get("tool_calls") for m in out)
    joined = "\n".join(str(m.get("content") or "") for m in out)
    assert "HEAD_MARK" in joined
    assert "TAIL_VERDICT_OK" in joined          # la queue survit désormais
    assert "chars omitted" in joined


# ── Q2-S : marqueurs sur coupes silencieuses ─────────────────────────────

def test_rag_excerpt_clip_marker():
    from llm_core.tools.rag_tools import _clip_excerpt, _DEFAULT_SEARCH_MAX_CHARS
    short = "z" * 100
    assert _clip_excerpt(short) == short
    long = "z" * (_DEFAULT_SEARCH_MAX_CHARS + 700)
    out = _clip_excerpt(long)
    assert out.startswith("z" * 50)
    assert "excerpt truncated, 700 chars omitted" in out
    assert "rag_get_document" in out


def test_shell_background_diag_clip_marker():
    from llm_core.tools.shell_tools import _clip_marked
    assert _clip_marked(None) == ""
    assert _clip_marked("ok") == "ok"
    out = _clip_marked("e" * 2500)
    assert out.startswith("e" * 100)
    assert "[+500 chars omitted]" in out
