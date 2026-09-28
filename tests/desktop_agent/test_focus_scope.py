# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_focus_scope.py — scope=focus & filtre de visibilité.

``keep_node`` DROP désormais les nœuds hors-écran (la docstring le promettait sans
le faire) ; ``_rect_intersects`` borne les enfants au rect de la fenêtre (clip du
scope=focus). Logique PURE, validée hors Windows (cf. test_uia_cache pour l'import).
"""
from __future__ import annotations

import os
import sys

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


def _load():
    saved = list(sys.path)
    sys.path.insert(0, _AGENT)
    try:
        import importlib
        norm = importlib.import_module("normalize")
        win = importlib.import_module("backends.windows")
        return norm, win
    finally:
        sys.path[:] = saved


def test_keep_node_drops_offscreen():
    norm, _ = _load()
    base = {"role": "button", "name": "Save", "rect": [10, 10, 80, 30], "states": []}
    assert norm.keep_node(base) is True
    assert norm.keep_node(dict(base, states=["offscreen"])) is False
    # même actionnable/coché, un nœud hors-écran reste écarté (anti-bruit tokens).
    assert norm.keep_node(dict(base, states=["enabled", "offscreen"])) is False


def test_keep_node_keeps_visible():
    norm, _ = _load()
    node = {"role": "checkbox", "name": "Wrap", "rect": [0, 0, 40, 20],
            "states": ["enabled", "checked"]}
    assert norm.keep_node(node) is True


def test_rect_intersects_clip():
    _, win = _load()
    f = win._rect_intersects
    clip = (0, 0, 100, 100)
    assert f((10, 10, 20, 20), clip) is True        # entièrement dans la fenêtre
    assert f((50, 50, 200, 200), clip) is True       # chevauche le bord → gardé
    assert f((150, 0, 20, 20), clip) is False        # hors fenêtre (à droite)
    assert f((0, 150, 20, 20), clip) is False        # hors fenêtre (en bas)
    assert f((10, 10, 20, 20), None) is True         # clip=None → no-op (monitor/desktop)


def test_foreground_hwnd_safe_off_windows():
    _, win = _load()
    # Hors Windows, ctypes.windll est absent → 0, JAMAIS d'exception (chemin []→ B/C).
    assert win._foreground_hwnd() == 0
