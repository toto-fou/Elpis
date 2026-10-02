# SPDX-License-Identifier: MIT
"""tests/llm_core/test_tool_result_model_view.py — vue MODÈLE des résultats
d'outils (étage d'émission unifié, 2026-07-12).

Couvre : cap d'émission dérivé du n_ctx (fin du 8000 fixe), strip du diff
d'edit_file côté modèle (l'event UI complet part avant), troncature shell en
QUEUE avec métadonnées en tête de JSON, débord automatique (hint saved_to),
extrait candidat sur old_str introuvable, borne MCP par-outil du shell.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from llm_core.context.budget import BUDGET
from llm_core.context.pruning import (
    emit_cap_chars,
    prepare_tool_result_for_model,
)

# ── Cap d'émission dérivé du n_ctx ───────────────────────────────────────────

def test_emit_cap_derive_du_ctx():
    """Harnais v4 (T0) : le cap est en TOKENS — clamp(2400, 0.06·n_ctx,
    25000) — matérialisé en chars via le ratio mesuré (amorce 3.3)."""
    import llm_core.context.tokens as tok
    from llm_core.context.pruning import emit_cap_tokens
    tok._measured_ratio.clear()   # amorce froide déterministe

    assert emit_cap_tokens(None) == BUDGET.emit_cap_min_tokens == 2_400
    assert emit_cap_tokens(32_768) == 2_400            # petit ctx → plancher
    assert emit_cap_tokens(262_144) == int(0.06 * 262_144)
    assert emit_cap_tokens(1_048_576) == BUDGET.emit_cap_max_tokens

    _r = tok.CHARS_PER_TOKEN
    assert emit_cap_chars(None) == int(2_400 * _r)          # inconnu → plancher
    assert emit_cap_chars(64_000) == int(int(0.06 * 64_000) * _r)   # zone linéaire
    assert emit_cap_chars(262_144) == int(int(0.06 * 262_144) * _r)
    assert emit_cap_chars(1_048_576) == int(25_000 * _r)    # plafond tokens


def test_task_report_tronque_tete_et_queue():
    # Le rapport final d'un sous-agent met ses conclusions à la FIN : la coupe
    # d'émission doit préserver la queue (comme execute_shell), pas tête-seule.
    report = ("<task id=\"t1-abc\" state=\"completed\">\n<task_result>\n"
              + "corpus " * 5_000 + "\nCONCLUSION FINALE\n</task_result>\n</task>")
    out = prepare_tool_result_for_model("task", report, ctx_tokens=32_768)
    assert len(out) < len(report)
    assert "tail preserved" in out
    assert out.startswith("<task id=\"t1-abc\"")      # enveloppe (tête) intacte
    assert "CONCLUSION FINALE" in out                  # conclusion (queue) intacte


def test_cap_marque_et_coupe():
    big = "x" * 30_000
    out = prepare_tool_result_for_model("read_file", big, ctx_tokens=32_768)
    assert len(out) < 30_000
    assert "chars omitted]" in out
    # grande fenêtre → cap plus généreux
    out2 = prepare_tool_result_for_model("read_file", big, ctx_tokens=128_000)
    assert len(out2) > len(out)


def test_non_str_passthrough():
    payload = {"structured": True}
    assert prepare_tool_result_for_model("t", payload, 32_768) is payload


# ── Diff d'edit_file : retiré côté modèle, stats conservées ─────────────────

def test_edit_diff_strippe_pour_le_modele():
    result = json.dumps({
        "ok": True, "path": "/work/a.py", "diff": "--- a\n+++ b\n" + ("+x\n" * 200),
        "lines_added": 200, "lines_removed": 3,
        "new_sha256": "abc", "next_expected_sha256": "abc",
    })
    out = prepare_tool_result_for_model("edit_file", result, 32_768)
    d = json.loads(out)
    assert "diff" not in d
    assert d["diff_stat"] == "+200/-3 lines"
    assert "re-read the file" in d["diff_note"]
    assert d["next_expected_sha256"] == "abc"      # chaînage sha intact
    # write_file sans diff → inchangé ; autres outils jamais touchés.
    plain = json.dumps({"ok": True, "diff": "---"})
    assert "diff" in json.loads(prepare_tool_result_for_model("read_file", plain, None))


# ── Desktop : compacté mais jamais capé au plancher générique ────────────────

def test_desktop_garde_son_budget_large():
    els = json.dumps({"elements": [{"id": i, "label": "b" * 40,
                                    "box": [1, 2, 3, 4], "confidence": 0.9}
                                   for i in range(400)]})
    out = prepare_tool_result_for_model("desktop_observe", els, 32_768)
    d = json.loads(out) if out.startswith("{") else None
    assert d is not None, "le desktop ne doit pas être coupé au cap générique"
    assert "box" not in out                        # éléments compactés
    assert len(d["elements"]) == 400               # liste ENTIÈRE


# ── Shell : troncature en QUEUE + métadonnées en tête ────────────────────────

def _fake_exec(stdout: bytes, stderr: bytes = b"", rc: int = 0):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=rc,
                           duration_s=0.5, executor_tag="docker",
                           timed_out=False)


def test_format_result_tail_keep_et_ordre():
    from llm_core.tools._exec_bridge import _format_result
    out = _format_result(_fake_exec(b"HEAD" + b"y" * 30_000 + b"TAIL_MARKER"),
                         ["bash", "-c", "x"], 20_000, "/work")
    assert out["truncated"] is True
    assert out["stdout"].endswith("TAIL_MARKER")           # queue gardée
    assert "TRUNCATED" in out["stdout"] and "tail" in out["stdout"]
    # métadonnées AVANT stdout/stderr dans l'ordre du dict (le cap d'émission
    # coupe la fin de la chaîne JSON → elles doivent survivre).
    keys = list(out.keys())
    assert keys.index("returncode") < keys.index("stdout")
    assert keys.index("truncated") < keys.index("stdout")
    assert keys.index("stdout") < keys.index("stderr")


async def test_shell_auto_spill_hint(tmp_path, monkeypatch):
    """Sortie tronquée sans save_stdout → saved_to + hint via le débord auto."""
    import llm_core.tools.shell_tools as st

    captured = {}

    def _fake_bridge(**kw):
        captured.update(kw)
        # Simule le bridge : sortie tronquée + débord auto écrit.
        assert kw["auto_spill_rel"] is not None
        return {"ok": True, "cmd": kw["tokens"], "cwd": "/work",
                "returncode": 0, "truncated": True, "duration_ms": 10,
                "executor": "docker", "stdout": "...tail", "stderr": "",
                "saved_bytes": 11, "auto_saved": True}

    monkeypatch.setattr(st, "run_shell_via_executor", _fake_bridge)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))

    class _StubMCP:
        def __init__(self):
            self.tools = {}

        def tool(self, **_kw):
            def deco(fn):
                self.tools[fn.__name__] = fn
                return fn
            return deco

    mcp = _StubMCP()
    st.register(mcp, tmp_path)
    res = mcp.tools["execute_shell"](ctx=None, command="seq 1 100000")
    assert res["ok"] is True
    assert res["saved_to"].startswith("/work/.tool-output/shell-")
    assert "read_file" in res["hint"] and "do not re-run" in res["hint"]
    # le chemin de débord précalculé est relatif à /work
    assert captured["auto_spill_rel"].startswith(".tool-output/shell-")


# ── old_str introuvable : extrait candidat ───────────────────────────────────

def test_nearest_candidate_montre_la_region():
    from llm_core.tools.fs_tools import _nearest_candidate
    text = "\n".join(f"line {i}" for i in range(1, 8)) + \
           "\ndef compute_total(x):\n    return x * 2\n"
    hint = _nearest_candidate(text, "def compute_totale(x):\n    return x * 3")
    assert "Closest match in the file" in hint
    assert "def compute_total(x):" in hint
    assert "Re-read that region" in hint
    # rien de plausible → chaîne vide (pas de bruit)
    assert _nearest_candidate(text, "zzzz qqqq wwww") == ""


# ── Borne MCP par-outil : execute_shell > 600 s ──────────────────────────────

def test_tool_timeout_execute_shell_couvre_600s():
    from llm_core.engine.tool_dispatch import _tool_timeout_s
    assert _tool_timeout_s("execute_shell") >= 610.0
    assert _tool_timeout_s("read_file") == pytest.approx(
        float(__import__("llm_core._constants", fromlist=["LLAMA_TOOL_TIMEOUT_S"]).LLAMA_TOOL_TIMEOUT_S))
