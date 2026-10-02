# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_shell_tool_hardening.py — durcissement execute_shell
(passe « moins d'outils, plus capables » 2026-07).

Couvre :
- classification _result_is_tool_failure : commande exécutée avec exit≠0
  (pytest rouge…) ≠ échec d'OUTIL (36 % de faux échecs mesurés avant fix) ;
- mode ``background`` : wrapper argv-safe (la commande part en positionnel
  $1, JAMAIS ré-interpolée → zéro re-quoting), pid+log retournés — validé à
  la couche shell réelle (bash local, sans Docker) ET au niveau outil ;
- ``stdin_b64`` (stdin binaire) + conflit stdin/stdin_b64 ;
- ``save_stdout`` : le chemin HOST est transmis au bridge (qui écrit le
  stdout COMPLET avant troncature — fix du « save tronqué à 20 KB ») ;
- hints ciblés : rc=127 avec `python` → « utilise python3 » ; timeout →
  « background=true ».
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path

import pytest

import llm_core.tools.shell_tools as shell_tools
from llm_core.engine.result_contract import (
    result_is_error as _result_is_error,
    result_is_tool_failure as _result_is_tool_failure,
)

# ──────────────────────────────────────────────────────────────────────────
# Classification outil-en-panne vs commande-en-échec
# ──────────────────────────────────────────────────────────────────────────

def test_command_exit_nonzero_is_not_tool_failure():
    rc1 = json.dumps({"ok": False, "cmd": "pytest -q", "returncode": 1,
                      "stdout": "1 failed", "stderr": "", "truncated": False})
    assert _result_is_error(rc1) is True          # envelope inchangée (UI)
    assert _result_is_tool_failure(rc1) is False  # mais l'OUTIL a fonctionné


def test_timeout_and_toolkit_envelopes_are_tool_failures():
    timeout = json.dumps({"ok": False, "error": "timeout", "hint": "x",
                          "returncode": 124, "stdout": "", "stderr": ""})
    toolkit = json.dumps({"ok": False, "error": "path_outside_sandbox",
                          "message": "…", "fix": "…"})
    legacy = json.dumps({"error": "boom"})
    for env in (timeout, toolkit, legacy):
        assert _result_is_tool_failure(env) is True


def test_success_is_not_tool_failure():
    assert _result_is_tool_failure(json.dumps({"ok": True, "returncode": 0})) is False
    assert _result_is_tool_failure("sortie libre non JSON") is False


# ──────────────────────────────────────────────────────────────────────────
# Wrapper background — couche shell RÉELLE (bash local, pas de Docker)
# ──────────────────────────────────────────────────────────────────────────

# AUDIT 2026-08-23 — ``;`` au lieu de ``&&``, plus ``setsid``. En bash, ``&``
# a une précédence plus faible que ``&&`` : c'est la LISTE ENTIÈRE qui partait
# en tâche de fond, donc ``$!`` rendait le PID du sous-shell, pas celui de la
# commande. Le « kill <pid> » que l'outil dicte au modèle ne tuait rien.
_BG_WRAPPER = ('mkdir -p "$(dirname "$2")"; '
               'nohup setsid bash -c "$1" >"$2" 2>&1 </dev/null & '
               'echo "$!"')


@pytest.mark.skipif(shutil.which("bash") is None, reason="requires bash")
def test_background_wrapper_passes_nasty_command_verbatim(tmp_path):
    """La commande traverse en positionnel : quotes simples/doubles, $,
    backticks, newlines — AUCUN re-quoting, sortie intégrale dans le log."""
    log = tmp_path / "bg" / "out.log"
    nasty = '''printf '%s\\n' "double\\"quote" 'single' '$notexpanded' ; echo ligne2'''
    r = subprocess.run(
        ["bash", "-c", _BG_WRAPPER, "bash", nasty, str(log)],
        capture_output=True, text=True, timeout=10,
    )
    assert r.returncode == 0
    pid = r.stdout.strip().splitlines()[-1]
    assert pid.isdigit()
    # Attend la fin du process détaché (écriture log asynchrone).
    for _ in range(50):
        if log.exists() and "ligne2" in log.read_text():
            break
        time.sleep(0.05)
    out = log.read_text()
    assert 'double"quote' in out
    assert "single" in out
    assert "$notexpanded" in out
    assert "ligne2" in out


@pytest.mark.skipif(shutil.which("bash") is None, reason="requires bash")
def test_le_pid_annonce_est_celui_de_la_commande(tmp_path):
    """AUDIT 2026-08-23 — LE constat : ``$!`` désignait le sous-shell
    intermédiaire. Le modèle lançait le ``kill <pid>`` que l'outil lui dicte,
    croyait avoir arrêté son serveur, et le port restait occupé."""
    log = tmp_path / "bg" / "pid.log"
    r = subprocess.run(
        ["bash", "-c", _BG_WRAPPER, "bash", "sleep 7", str(log)],
        capture_output=True, text=True, timeout=10,
    )
    pid = int(r.stdout.strip().splitlines()[-1])
    time.sleep(0.4)
    try:
        ps = subprocess.run(["ps", "-o", "args=", "-p", str(pid)],
                            capture_output=True, text=True, timeout=5)
        args = (ps.stdout or "").strip()
        assert "sleep 7" in args, (
            f"le PID annoncé ({pid}) désigne {args!r} et non la commande — "
            f"un « kill » dessus laisserait le processus vivant")
    finally:
        subprocess.run(["kill", "-9", str(pid)], capture_output=True)


def test_source_wrapper_matches_test_copy():
    """Garde-fou de synchronisation : le wrapper inliné dans shell_tools doit
    rester identique à celui validé ci-dessus à la couche shell."""
    src = Path(shell_tools.__file__).read_text(encoding="utf-8")
    assert 'nohup setsid bash -c "$1" >"$2" 2>&1 </dev/null & ' in src
    assert '"$(dirname "$2")" && ' not in src, \
        "le ``&&`` est de retour : ``$!`` redésignerait le sous-shell"


# ──────────────────────────────────────────────────────────────────────────
# Niveau outil — bridge mocké
# ──────────────────────────────────────────────────────────────────────────

class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def shell_tool(tmp_path, monkeypatch):
    """Enregistre execute_shell avec un bridge mocké ; retourne
    (tool_fn, captured_kwargs, réponse_mutable)."""
    captured: dict = {}
    reply: dict = {"value": {"ok": True, "cmd": "x", "cwd": "/work",
                             "returncode": 0, "stdout": "", "stderr": "",
                             "truncated": False, "duration_ms": 1,
                             "executor": "test"}}

    def _fake_bridge(**kw):
        captured.clear()
        captured.update(kw)
        return dict(reply["value"])

    monkeypatch.setattr(shell_tools, "run_shell_via_executor", _fake_bridge)
    # Sandbox locale : évite Docker/ensure_work_subdir réels.
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    mcp = _FakeMCP()
    shell_tools.register(mcp, tmp_path)
    return mcp.tools["execute_shell"], captured, reply


def test_background_tool_tokens_and_response(shell_tool):
    tool, captured, reply = shell_tool
    reply["value"] = {"ok": True, "returncode": 0, "stdout": "12345\n",
                      "stderr": "", "truncated": False, "duration_ms": 3,
                      "executor": "t", "cwd": "/work", "cmd": "x"}
    cmd = 'python3 -m http.server 8899 --bind "127.0.0.1"'
    out = tool(None, command=cmd, background=True)
    toks = captured["tokens"]
    # argv : ["bash","-c",wrapper,"bash",<commande VERBATIM>,<log>]
    assert toks[0] == "bash" and toks[1] == "-c"
    assert toks[3] == "bash"
    assert toks[4] == cmd                     # aucun re-quoting
    assert toks[5].startswith("/work/.bg/bg-") and toks[5].endswith(".log")
    assert out["ok"] is True and out["background"] is True
    assert out["pid"] == 12345
    assert out["log"] == toks[5]


def test_background_launch_failure_surfaces(shell_tool):
    tool, _, reply = shell_tool
    reply["value"] = {"ok": False, "returncode": 1, "stdout": "",
                      "stderr": "bash: erreur", "truncated": False,
                      "duration_ms": 3, "executor": "t", "cwd": "/work", "cmd": "x"}
    out = tool(None, command="boom", background=True)
    assert out["ok"] is False and out["error"] == "background_launch_failed"


def test_stdin_b64_decoded_and_conflict(shell_tool):
    tool, captured, _ = shell_tool
    import base64
    raw = bytes(range(256))
    out = tool(None, command="cat", stdin_b64=base64.b64encode(raw).decode())
    assert out.get("ok") is True
    assert captured["stdin_bytes"] == raw     # octets exacts, binaire-safe

    out2 = tool(None, command="cat", stdin="x", stdin_b64="eA==")
    assert out2["ok"] is False and out2["error"] == "stdin_conflict"

    out3 = tool(None, command="cat", stdin_b64="%%%pas-du-b64%%%")
    assert out3["ok"] is False and out3["error"] == "stdin_b64_invalid"


def test_cwd_verifie_par_l_agent(shell_tool, tmp_path):
    """cwd relatif à /work, vérifié par l'agent : dossier sous /work."""
    tool, captured, _ = shell_tool
    tool(None, command="true")                   # crée la sandbox
    work = tmp_path / "guest" / "work"
    (work / "src").mkdir()
    (work / "f.txt").write_text("x")
    ailleurs = tmp_path / "ailleurs"
    ailleurs.mkdir()
    (work / "lien").symlink_to(ailleurs, target_is_directory=True)
    assert tool(None, command="pwd", cwd="/work/src")["ok"]
    assert captured["workdir_rel"] == "src"
    for cwd in ("absent", "f.txt"):
        r = tool(None, command="pwd", cwd=cwd)
        assert r["ok"] is False and r["error"].startswith("cwd_not_a_directory"), r
    for cwd in ("lien", "lien/x", "../x"):
        r = tool(None, command="pwd", cwd=cwd)
        assert r["ok"] is False and r["error"] == "cwd_outside_sandbox", (cwd, r)


def test_save_stdout_passed_to_bridge(shell_tool, tmp_path):
    tool, captured, reply = shell_tool
    reply["value"] = {"ok": True, "returncode": 0, "stdout": "tronqué…",
                      "stderr": "", "truncated": True, "duration_ms": 3,
                      "executor": "t", "cwd": "/work", "cmd": "x",
                      "saved_bytes": 123456}
    out = tool(None, command="seq 1 100000", save_stdout="out/full.txt")
    assert captured["save_stdout_rel"] == "out/full.txt"
    assert out["saved_bytes"] == 123456
    assert out["saved_to"].endswith("out/full.txt")
    assert out["saved_to"].startswith("/work/")


def test_hint_127_python(shell_tool):
    tool, _, reply = shell_tool
    reply["value"] = {"ok": False, "returncode": 127,
                      "stdout": "bash: line 1: python: command not found\n",
                      "stderr": "", "truncated": False, "duration_ms": 3,
                      "executor": "t", "cwd": "/work", "cmd": "x"}
    out = tool(None, command="python script.py")
    assert "python3" in out["fix"]

    out2 = tool(None, command="foobar --version")
    assert "127" in out2["fix"] or "introuvable" in out2["fix"]


def test_hint_timeout_background(shell_tool):
    tool, _, reply = shell_tool
    reply["value"] = {"ok": False, "error": "timeout", "hint": "Exceeded 30.0s.",
                      "returncode": 124, "stdout": "", "stderr": "",
                      "duration_ms": 30000, "executor": "t",
                      "cwd": "/work", "cmd": "x"}
    out = tool(None, command="python3 -m http.server")
    assert "background=true" in out["fix"]
