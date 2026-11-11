# SPDX-License-Identifier: MIT
"""
tests/desktop_agent/test_normalize_patterns.py — E3 : parité a11y Linux.

Dérivation COARSE des control-patterns (vocabulaire UIA partagé) à partir des
états AT-SPI + rôle, pour que le modèle 30-129B reçoive le même signal
« cochable/sélectionnable/dépliable/éditable/cliquable » sous Linux que sous
Windows. Fonction PURE → testable sans AT-SPI vivant.

Même précaution d'import que les autres tests desktop-agent : on insère
``desktop-agent`` au sys.path le temps de l'import.
"""
from __future__ import annotations

import os
import sys

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


def _normalize():
    saved = list(sys.path)
    sys.path.insert(0, _AGENT)
    try:
        import importlib
        return importlib.import_module("normalize")
    finally:
        sys.path[:] = saved


def test_derive_patterns_toggle():
    n = _normalize()
    assert "toggle" in n.derive_patterns(["checkable"], "check box")
    assert "toggle" in n.derive_patterns(["checked"], "check box")


def test_derive_patterns_select_expand_value():
    n = _normalize()
    assert "selectionitem" in n.derive_patterns(["selectable"], "list item")
    assert "expandcollapse" in n.derive_patterns(["expandable"], "combo box")
    assert "value" in n.derive_patterns(["editable"], "entry")


def test_derive_patterns_invoke_on_actionable_role():
    n = _normalize()
    assert "invoke" in n.derive_patterns([], "push button")     # rôle actionnable seul
    assert "invoke" in n.derive_patterns([], "menu item")


def test_derive_patterns_plain_label_has_none():
    n = _normalize()
    assert n.derive_patterns(["enabled"], "label") == []        # texte inerte → rien


def test_make_node_carries_patterns_and_runtime_id():
    n = _normalize()
    node = n.make_node("push button", "OK", 0, 0, 10, 10,
                       patterns=["invoke"], runtime_id="/org/a11y/.../42")
    assert node["patterns"] == ["invoke"]
    assert node["runtime_id"] == "/org/a11y/.../42"
    assert node["role"] == "button"


# ── Filtrage « visible à l'écran » (offscreen + centre-sur-région) ────────────
def test_keep_node_drops_offscreen():
    n = _normalize()
    base = dict(role="button", name="OK", rect=[10, 10, 40, 20], states=[])
    assert n.keep_node(base) is True
    assert n.keep_node({**base, "states": ["offscreen"]}) is False   # IsOffscreen/¬SHOWING


def test_keep_node_drops_zero_size_and_nameless():
    n = _normalize()
    assert n.keep_node({"role": "button", "name": "OK", "rect": [0, 0, 2, 2]}) is False  # < 3px
    assert n.keep_node({"role": "", "name": "", "rect": [0, 0, 40, 20]}) is False         # ni nom ni rôle


def test_center_in_region():
    n = _normalize()
    region = {"left": 0, "top": 0, "width": 1920, "height": 1080}
    assert n.center_in_region([100, 100, 40, 20], region) is True     # centre (120,110) dans le cadre
    assert n.center_in_region([1880, 100, 40, 20], region) is True    # centre x=1900 < 1920 → gardé
    assert n.center_in_region([2000, 100, 40, 20], region) is False   # centre sur le 2e écran → écarté
    assert n.center_in_region([-100, 100, 40, 20], region) is False   # centre à gauche du cadre
    assert n.center_in_region([100, 100, 40, 20], None) is True       # scope desktop → fail-open
    assert n.center_in_region([1, 2], region) is True                 # rect malformé → fail-open
