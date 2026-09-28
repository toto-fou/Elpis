# SPDX-License-Identifier: MIT
"""
tests/desktop_agent/test_agent_contract.py — contrat de l'agent (virage UIA).

On valide ce qui est testable hors Windows : le schéma de nœud (auto_id), le
contrat de base (les nouvelles méthodes lèvent NotSupported par défaut) et les
REPLIS gracieux du backend Linux (coords / poll borné). La logique UIA réelle
(pywinauto) se valide sur la cible Windows.

L'agent vit dans ``desktop-agent/`` (hors package du repo) : on l'ajoute au
sys.path le temps des imports PUIS on le retire — sinon son ``server.py``
masquerait le *package* ``server/`` du repo pour les autres tests.
"""
from __future__ import annotations

import os
import sys

import pytest

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


def _load():
    saved = list(sys.path)
    sys.path.insert(0, _AGENT)
    try:
        import normalize as norm
        from backends.base import DesktopBackend, NotSupported
        from backends.linux import LinuxBackend
        return norm, DesktopBackend, NotSupported, LinuxBackend
    finally:
        sys.path[:] = saved   # ne pas masquer le package repo ``server``


norm, DesktopBackend, NotSupported, LinuxBackend = _load()


def test_make_node_auto_id():
    n = norm.make_node("Button", "OK", 1, 2, 3, 4, auto_id="okBtn", states=["enabled"])
    assert n["auto_id"] == "okBtn"
    assert n["role"] == "button"            # rôle normalisé
    assert "enabled" in n["states"]
    # rétro-compat : auto_id par défaut vide
    assert norm.make_node("button", "x", 0, 0, 5, 5)["auto_id"] == ""
    # profondeur dans l'arbre UIA (vue hiérarchique)
    assert norm.make_node("button", "x", 0, 0, 5, 5, depth=3)["depth"] == 3


def test_base_new_methods_raise_not_supported():
    b = DesktopBackend()
    for call in (lambda: b.invoke(auto_id="x"),
                 lambda: b.set_value(text="x"),
                 lambda: b.element_action(action="toggle", auto_id="x"),
                 lambda: b.launch("notepad"),
                 lambda: b.wait_window(title_re="x"),
                 lambda: b.wait_element(auto_id="x")):
        with pytest.raises(NotSupported):
            call()


def test_linux_element_action_coords_fallback(monkeypatch):
    lb = LinuxBackend()
    seen = {}
    monkeypatch.setattr(lb, "click", lambda x, y, button="left", clicks=1: seen.update(x=x, y=y))
    out = lb.element_action(action="toggle", x=7, y=8)
    assert out["method"] == "coords" and seen == {"x": 7, "y": 8}


def test_linux_element_action_set_value(monkeypatch):
    lb = LinuxBackend()
    typed = {}
    monkeypatch.setattr(lb, "type_text", lambda t: typed.update(t=t))
    out = lb.element_action(action="set_value", text="hi")
    assert out["method"] == "type" and typed == {"t": "hi"}


def test_linux_element_action_no_coords_raises():
    with pytest.raises(NotSupported):
        LinuxBackend().element_action(action="select")    # pas de coords → pas de repli


def test_linux_wait_window_graceful_timeout():
    # Aucune fenêtre ne matche → repli borné → {found: False} (jamais d'exception).
    out = LinuxBackend().wait_window(title_re="NoSuchWindow_ZZZ", timeout_ms=120)
    assert out == {"found": False}


def test_linux_wait_element_graceful_timeout():
    out = LinuxBackend().wait_element(auto_id="nope_zzz", timeout_ms=120)
    assert out == {"found": False}


def test_linux_invoke_coords_fallback(monkeypatch):
    lb = LinuxBackend()
    seen = {}
    monkeypatch.setattr(lb, "click", lambda x, y, button="left", clicks=1: seen.update(x=x, y=y, b=button))
    out = lb.invoke(auto_id="ignored", x=12, y=34, button="left")
    assert out["method"] == "coords"
    assert seen == {"x": 12, "y": 34, "b": "left"}


def test_linux_invoke_without_coords_raises():
    with pytest.raises(NotSupported):
        LinuxBackend().invoke(auto_id="x")        # pas de coords → pas de repli


def test_linux_set_value_types(monkeypatch):
    lb = LinuxBackend()
    typed = {}
    monkeypatch.setattr(lb, "type_text", lambda t: typed.update(t=t))
    out = lb.set_value(auto_id="field", text="bonjour")
    assert out["method"] == "type" and typed == {"t": "bonjour"}


# ── Scoping fenêtre active (P0.4) ─────────────────────────────────────────────
class _FakeStateSet:
    def __init__(self, active):
        self._active = active

    def contains(self, st):
        return self._active and st == "ACTIVE"


class _FakeAcc:
    def __init__(self, children=(), active=False):
        self._children = list(children)
        self._active = active

    def get_child_count(self):
        return len(self._children)

    def get_child_at_index(self, i):
        return self._children[i] if 0 <= i < len(self._children) else None

    def get_state_set(self):
        return _FakeStateSet(self._active)


class _FakeAtspi:
    class StateType:
        ACTIVE = "ACTIVE"


def test_linux_active_roots_picks_active_window():
    lb = LinuxBackend()
    win_active = _FakeAcc(active=True)
    app = _FakeAcc(children=[_FakeAcc(active=False), win_active])
    desktop = _FakeAcc(children=[app])
    assert lb._atspi_active_roots(desktop, _FakeAtspi) == [win_active]


def test_linux_active_roots_empty_when_none_active():
    lb = LinuxBackend()
    desktop = _FakeAcc(children=[_FakeAcc(children=[_FakeAcc(active=False)])])
    assert lb._atspi_active_roots(desktop, _FakeAtspi) == []


# ── Sélection d'écran (multi-moniteur optionnel) ──────────────────────────────
def test_monitor_select_and_default():
    lb = LinuxBackend()
    assert lb.monitor_index == 1              # primaire par défaut
    assert lb.set_monitor(0) == 0             # tous les écrans
    assert lb.set_monitor("nope") == 1        # invalide → repli primaire
    out = lb.list_monitors()
    assert "monitors" in out and out["selected"] == 1
    # sans serveur X/mss (CI), pas d'écran détecté → origine neutre (no-op).
    assert lb.monitor_origin() == (0, 0)


# ── Visibilité AT-SPI (parité IsOffscreen Windows) ────────────────────────────
class _VisStateSet:
    def __init__(self, names):
        self._names = set(names)

    def contains(self, st):
        return st in self._names


class _VisAtspi:
    class CoordType:
        SCREEN = "SCREEN"

    class StateType:
        # Chaque état est sa propre chaîne-sentinelle (identité suffit pour contains()).
        VISIBLE = "VISIBLE"; SHOWING = "SHOWING"; ENABLED = "ENABLED"
        FOCUSABLE = "FOCUSABLE"; FOCUSED = "FOCUSED"; SELECTED = "SELECTED"
        CHECKED = "CHECKED"; EDITABLE = "EDITABLE"; CHECKABLE = "CHECKABLE"
        SELECTABLE = "SELECTABLE"; EXPANDABLE = "EXPANDABLE"; EXPANDED = "EXPANDED"


class _VisExt:
    def __init__(self, x, y, w, h):
        self.x, self.y, self.width, self.height = x, y, w, h


class _VisAcc:
    def __init__(self, states):
        self._ss = _VisStateSet(states)

    def get_extents(self, coord):
        return _VisExt(10, 20, 40, 20)

    def get_role_name(self):
        return "push button"

    def get_name(self):
        return "OK"

    def get_state_set(self):
        return self._ss

    def get_accessible_id(self):
        return "okBtn"

    def get_path(self):
        return "/a/1"


def test_atspi_node_marks_offscreen_when_visible_not_showing():
    lb = LinuxBackend()
    # VISIBLE mais PAS SHOWING (scrollé hors vue / onglet inactif) → offscreen.
    node = lb._atspi_node(_VisAcc(["VISIBLE", "ENABLED"]), 0, _VisAtspi)
    assert "offscreen" in node["states"]
    assert norm.keep_node(node) is False        # écarté du tree renvoyé


def test_atspi_node_kept_when_showing():
    lb = LinuxBackend()
    node = lb._atspi_node(_VisAcc(["VISIBLE", "SHOWING", "ENABLED"]), 0, _VisAtspi)
    assert "offscreen" not in node["states"]
    assert norm.keep_node(node) is True


def test_atspi_node_failopen_when_no_visibility_states():
    lb = LinuxBackend()
    # Toolkit qui ne rapporte NI VISIBLE NI SHOWING → on ne drop rien (fail-open).
    node = lb._atspi_node(_VisAcc(["ENABLED"]), 0, _VisAtspi)
    assert "offscreen" not in node["states"]
    assert norm.keep_node(node) is True
