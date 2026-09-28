# SPDX-License-Identifier: MIT
"""Invariant de split : la couche mémoire ne tire pas chatbot_app.

Exécuté dans un interpréteur frais (subprocess) car les autres tests importent
déjà l'app dans le process pytest courant.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _run(code: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", code], cwd=str(ROOT),
                          capture_output=True, text=True)


def test_llm_core_memory_no_app_imports():
    code = (
        "import sys\n"
        "import llm_core.memory  # noqa\n"
        "import shared_infra.memory.store  # noqa\n"
        "leaked = [m for m in sys.modules if m == 'chatbot_app' "
        "or m.startswith('chatbot_app.')]\n"
        "assert not leaked, leaked\n"
        "print('OK')\n"
    )
    res = _run(code)
    assert res.returncode == 0, f"stdout={res.stdout!r} stderr={res.stderr!r}"
    assert "OK" in res.stdout
