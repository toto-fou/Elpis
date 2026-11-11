# SPDX-License-Identifier: MIT
"""tests/agent_bac.py — l'agent du bac (``sandbox-agent/server.py``) chargé comme module, pour les tests."""
import importlib.util
import sys
from pathlib import Path

_CHEMIN = Path(__file__).resolve().parents[1] / "sandbox-agent" / "server.py"
_SPEC = importlib.util.spec_from_file_location("elpis_agent_bac", _CHEMIN)
assert _SPEC and _SPEC.loader
S = sys.modules.get("elpis_agent_bac") or importlib.util.module_from_spec(_SPEC)
if "elpis_agent_bac" not in sys.modules:
    sys.modules["elpis_agent_bac"] = S
    _SPEC.loader.exec_module(S)
