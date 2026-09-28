# SPDX-License-Identifier: MIT
"""tests/llm_core/test_compression_serializer.py — sérialiseur v3 + ledger + FTS.

Corrige la perte de données du compresseur (audit, diagnostic #4) :
- le CONTENU d'un outil MUTANT (write_file…) ne part plus au résumeur — le
  ledger déterministe fixe {op, chemin, taille, statut} ;
- arguments non-mutants : 500 chars (avant 200) ;
- budget par message dérivé du n_ctx du modèle de compression ;
- le ledger SURVIT au roundtrip d'état (porteur → extract → rebuild) et est
  retiré proprement à la recompression (pas de duplication) ;
- FTS avant destruction : les tool_results/tool_calls des tours compressés
  deviennent cherchables via session_search.
"""
from __future__ import annotations

import json

from llm_core.context.compression.serializer import (
    ArtifactEntry,
    LEDGER_START,
    compute_serializer_budget,
    extract_artifact_ledger,
    merge_ledger_lines,
    parse_ledger_lines,
    render_artifact_ledger,
    serialize_for_compression,
)

CODE = "def main():\n    return 42\n" * 200          # ~5200 chars


def _turn_write(path="src/app.py", ok=True, call_id="c1"):
    args = json.dumps({"path": path, "content": CODE})
    return [
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": call_id, "type": "function",
             "function": {"name": "write_file", "arguments": args}}]},
        {"role": "tool", "tool_call_id": call_id,
         "content": json.dumps({"ok": ok} if ok else {"ok": False, "error": "denied"})},
    ]


# ── sérialisation ───────────────────────────────────────────────────────────

def test_contenu_mutant_absent_du_texte_resumeur():
    txt = serialize_for_compression(_turn_write())
    assert "return 42" not in txt                    # le code n'y est PLUS
    assert "write_file(path=src/app.py" in txt       # la référence oui
    assert "ARTIFACTS" in txt                        # pointeur vers le ledger


def test_args_non_mutants_cap_500():
    big = json.dumps({"pattern": "x" * 2000})
    msgs = [{"role": "assistant", "content": None, "tool_calls": [
        {"id": "g", "type": "function",
         "function": {"name": "grep_search", "arguments": big}}]}]
    txt = serialize_for_compression(msgs)
    line = next(l for l in txt.splitlines() if "grep_search" in l)
    assert len(line) < 600 and line.endswith("…)")


def test_budget_derive_du_ctx():
    """Harnais v4 (M5) : budgets en TOKENS [600, 6000], matérialisés en chars
    via le ratio mesuré (amorce 3.3)."""
    import llm_core.context.tokens as tok
    from llm_core.context.compression.serializer import (
        compute_serializer_budget_tokens)
    tok._measured_ratio.clear()

    assert compute_serializer_budget_tokens(10, None) == 600     # ctx inconnu
    assert compute_serializer_budget_tokens(10, 240_000) == 6_000   # plafond
    assert compute_serializer_budget_tokens(200, 32_000) == 600  # plancher
    mid_tk = compute_serializer_budget_tokens(10, 32_000)
    assert 600 < mid_tk <= 6_000                                 # dérivé
    # Matérialisation chars = tokens × ratio (3.3 à froid).
    assert compute_serializer_budget(10, None) == int(600 * tok.CHARS_PER_TOKEN)
    assert compute_serializer_budget(10, 32_000) == int(mid_tk * tok.CHARS_PER_TOKEN)


# ── ledger ──────────────────────────────────────────────────────────────────

def test_extract_ledger_statut_apparie():
    entries = extract_artifact_ledger(
        _turn_write(ok=True, call_id="a") + _turn_write(path="b.py", ok=False, call_id="b"))
    assert [e.path for e in entries] == ["src/app.py", "b.py"]
    assert entries[0].ok is True and entries[1].ok is False
    assert entries[0].size_chars > 5000


def test_render_parse_merge_roundtrip():
    lines = [ArtifactEntry("write_file", f"f{i}.py", 100 + i, True).render()
             for i in range(3)]
    block = render_artifact_ledger(lines)
    assert block.startswith(LEDGER_START)
    assert parse_ledger_lines(f"préambule\n{block}\nsuite") == lines
    # merge : même (op, path) → la plus récente gagne, position conservée.
    newer = [ArtifactEntry("write_file", "f1.py", 999, False).render()]
    merged = merge_ledger_lines(lines, newer)
    assert len(merged) == 3 and "999" in merged[1] and "ÉCHEC" in merged[1]


def test_render_cap_garde_les_recentes():
    lines = [f"- write_file f{i}.py (1 chars, ok)" for i in range(60)]
    block = render_artifact_ledger(lines, cap=40)
    assert "f59.py" in block and "f0.py" not in block
    assert "20 entrée(s)" in block                   # omission annoncée


# ── roundtrip d'état (porteur → extract → rebuild → strip) ──────────────────

def test_ledger_survit_au_roundtrip_etat():
    from llm_core.conversation_compressor import (
        _strip_summary_messages,
        build_state_system_message,
        extract_compression_state,
    )
    block = render_artifact_ledger(
        [ArtifactEntry("write_file", "src/x.py", 5321, True).render()])
    carrier = build_state_system_message(
        "<context>résumé</context>", 1, 4, ledger_block=block)
    # Le porteur transporte le ledger…
    assert LEDGER_START in carrier["content"]
    # …extract le restitue dans l'état…
    st = extract_compression_state([carrier])
    assert st and "src/x.py" in (st.get("ledger_block") or "")
    # …rebuild le ré-épingle…
    rebuilt = build_state_system_message(
        st["summary_xml"], st["round"], st["covered_turns"],
        ledger_block=st["ledger_block"])
    assert "src/x.py" in rebuilt["content"]
    # …et le strip retire TOUT le bloc (aucun résidu à la recompression).
    assert _strip_summary_messages([rebuilt]) == []


def test_ledger_jamais_renvoye_au_llm():
    from llm_core.conversation_compressor import (
        _extract_previous_summary,
        build_state_system_message,
    )
    block = render_artifact_ledger(
        [ArtifactEntry("write_file", "secret.py", 10, True).render()])
    carrier = build_state_system_message("<context>r</context>", 1, 2,
                                         ledger_block=block)
    prev = _extract_previous_summary([carrier])
    assert prev == "<context>r</context>"            # ledger HORS prev_summary


# ── FTS avant destruction ───────────────────────────────────────────────────

def test_fts_indexe_tools_avant_drop(monkeypatch, tmp_path):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw") == 1

    from llm_core.conversation_compressor import _index_covered_turns_fts
    _index_covered_turns_fts(
        _turn_write(path="notes/plan.md"),
        username="alice", session_id="chat-42",
    )
    from shared_infra.memory.store import session_search_fts
    hits = session_search_fts(1, "plan.md")
    roles = {h["role"] for h in hits}
    assert "tool_call" in roles                       # l'appel est cherchable
    assert any(h["session_id"] == "chat-42" for h in hits)


def test_fts_username_inconnu_noop(monkeypatch, tmp_path):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "x.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from llm_core.conversation_compressor import _index_covered_turns_fts
    # Ne lève pas, n'écrit rien (user inconnu → best-effort silencieux).
    _index_covered_turns_fts(_turn_write(), username="fantome", session_id="s")
