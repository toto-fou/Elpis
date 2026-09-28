# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_launch_error_map.py — couvre la partie Linux-testable
du durcissement de ``WindowsBackend.launch`` :
  - ``_shellexecute_error`` (pure, sans ctypes) ;
  - l'invariant « aucun appel risqué AVANT le try englobant » (garde anti-500).
Le comportement UIA réel se valide sur la VM Windows.
"""
from __future__ import annotations

import inspect
import os
import sys

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


def _load():
    saved = list(sys.path)
    sys.path.insert(0, _AGENT)
    try:
        from backends.windows import WindowsBackend, _shellexecute_error
        return WindowsBackend, _shellexecute_error
    finally:
        sys.path[:] = saved   # ne pas masquer le package repo ``server``


WindowsBackend, _shellexecute_error = _load()


def test_error_map_known_codes():
    assert "introuvable" in _shellexecute_error(2)          # SE_ERR_FNF
    assert "chemin" in _shellexecute_error(3)               # SE_ERR_PNF
    assert "accès" in _shellexecute_error(5).lower() or "acces" in _shellexecute_error(5).lower()
    assert "NOASSOC" in _shellexecute_error(31)             # aucune appli associée
    assert "DLL" in _shellexecute_error(32)


def test_error_map_unknown_code_default():
    assert "42" in _shellexecute_error(42)


def test_error_map_tolerates_garbage():
    assert isinstance(_shellexecute_error("nope"), str)
    assert isinstance(_shellexecute_error(None), str)


def test_launch_wraps_body_no_throw_before_try():
    """Garde anti-régression du 500 PRIMAIRE : la construction du Desktop UIA
    (et tout appel ctypes) doit être DANS le try englobant, pas avant."""
    src = inspect.getsource(WindowsBackend.launch)
    i_try = src.find("try:")
    i_desktop = src.find("Desktop(backend")
    assert i_try != -1, "launch() doit avoir un try englobant"
    assert i_desktop != -1
    assert i_desktop > i_try, "Desktop(backend=…) doit être DANS le try (sinon 500 sur échec COM)"
    # le corps se termine par un filet « tout le reste → dict structuré »
    assert "except Exception" in src
