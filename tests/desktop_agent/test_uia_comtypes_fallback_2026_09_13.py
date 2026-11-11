# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_uia_comtypes_fallback_2026_09_13.py — action
sémantique SANS pywinauto (win32ui/MFC absents sur une VM nue) : le même
IUIAutomation (comtypes) retrouve l'élément et joue Toggle/Select/Invoke.
Vu sur QGIS : Invoke sur un élément de MENU n'ouvre pas le menu → clic réel.
Objets factices : aucun COM ici."""
from __future__ import annotations

import sys
from pathlib import Path

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)

from backends import windows as W  # noqa: E402


class Pat:
    def __init__(self, state=None):
        self.calls = []
        self.CurrentToggleState = state
    def Toggle(self): self.calls.append("Toggle")
    def Select(self): self.calls.append("Select")
    def Invoke(self): self.calls.append("Invoke")
    def Expand(self): self.calls.append("Expand")
    def Collapse(self): self.calls.append("Collapse")
    def ScrollIntoView(self): self.calls.append("ScrollIntoView")
    def SetValue(self, v): self.calls.append(("SetValue", v))
    def QueryInterface(self, iface): return self


class Mod:
    IUIAutomationInvokePattern = "inv"; IUIAutomationSelectionItemPattern = "sel"; IUIAutomationTogglePattern = "tog"
    IUIAutomationExpandCollapsePattern = "exp"; IUIAutomationValuePattern = "val"; IUIAutomationScrollItemPattern = "scr"


class El:
    def __init__(self, ct, patterns, rect=(0, 0, 10, 10), name="", auto_id="", offscreen=False):
        self.CurrentControlType = ct; self._p = patterns
        self.CurrentName = name; self.CurrentAutomationId = auto_id; self.CurrentIsOffscreen = offscreen
        self._rect = rect
    def GetCurrentPattern(self, pid): return self._p.get(pid)
    @property
    def CurrentBoundingRectangle(self):
        class R: pass
        r = R(); r.left, r.top = self._rect[0], self._rect[1]; r.right, r.bottom = self._rect[0] + self._rect[2], self._rect[1] + self._rect[3]
        return r


TOG, SEL, INV = W._UIA_PATTERN_IDS["toggle"], W._UIA_PATTERN_IDS["selection_item"], W._UIA_PATTERN_IDS["invoke"]


def test_clic_prefere_toggle_puis_select_puis_invoke():
    t, s_, i = Pat(0), Pat(), Pat()
    assert W._uia_action(Mod, El(50002, {TOG: t, SEL: s_, INV: i}), "click") == {"method": "toggle"} and t.calls == ["Toggle"]
    assert W._uia_action(Mod, El(50024, {SEL: s_, INV: i}), "click") == {"method": "select"} and s_.calls == ["Select"]
    assert W._uia_action(Mod, El(50000, {INV: i}), "click") == {"method": "invoke"} and i.calls == ["Invoke"]
    assert W._uia_action(Mod, El(50000, {}), "click") is None, "aucun pattern → coordonnées"


def test_menuitem_se_clique_pour_de_vrai():
    i = Pat()
    assert W._uia_action(Mod, El(50011, {INV: i}), "click") is None
    assert i.calls == [], "Invoke sur une entrée de menu Qt n'ouvre pas le menu"


def test_check_uncheck_idempotents():
    t = Pat(1)
    assert W._uia_action(Mod, El(50002, {TOG: t}), "check") == {"method": "toggle", "noop": True, "toggle_state": "on"}
    assert t.calls == []
    assert W._uia_action(Mod, El(50002, {TOG: t}), "uncheck") == {"method": "toggle"} and t.calls == ["Toggle"]
    assert W._uia_action(Mod, El(50002, {}), "check") is None


def test_double_clic_et_valeur():
    i, v = Pat(), Pat()
    assert W._uia_action(Mod, El(50000, {INV: i}), "double_click") is None, "pas de pattern double-clic"
    assert W._uia_action(Mod, El(50004, {W._UIA_PATTERN_IDS["value"]: v}), "set_value", text="abc") == {"method": "set_value"}
    assert v.calls == [("SetValue", "abc")]


class Found:
    def __init__(self, els): self._els = els; self.Length = len(els)
    def GetElement(self, i): return self._els[i]


class Auto:
    def __init__(self, els): self.els = els; self.conds = []
    def CreatePropertyCondition(self, pid, val): self.conds.append((pid, val)); return (pid, val)
    def CreateAndCondition(self, a, b): return ("and", a, b)
    def GetRootElement(self): return self
    def ElementFromHandle(self, h): return self
    def FindAll(self, scope, cond): return Found(self.els)


def test_find_prefere_l_element_sous_le_point_puis_le_premier_a_l_ecran(monkeypatch):
    monkeypatch.setattr(W, "_is_shell_window", lambda h: True)   # pas de fenêtre au premier plan : racine seule
    a = El(50000, {}, rect=(0, 0, 50, 50), name="OK", offscreen=True)
    b = El(50000, {}, rect=(100, 100, 50, 50), name="OK")
    c = El(50000, {}, rect=(300, 300, 50, 50), name="OK")
    auto = Auto([a, b, c])
    assert W._uia_find(auto, Mod, name="OK", control_type="button", x=310, y=320) is c
    assert W._uia_find(auto, Mod, name="OK", control_type="button") is b, "le premier NON hors écran"
    assert ("and", (30005, "OK"), (30003, 50000)) in [cnd for cnd in [auto.conds and ("and", auto.conds[0], auto.conds[1])]]
    assert W._uia_find(Auto([]), Mod, name="OK") is None
    auto2 = Auto([b]); W._uia_find(auto2, Mod, auto_id="okBtn")
    assert auto2.conds[0] == (30011, "okBtn"), "auto_id d'abord, par propriété UIA"


def test_element_action_sans_pywinauto_passe_par_comtypes(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    calls = []
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: None)              # pywinauto muet
    monkeypatch.setattr(W, "_uia_element_action", lambda **kw: calls.append(kw) or {"method": "invoke", "via": "uia"})
    monkeypatch.setattr(be, "click", lambda *a, **k: calls.append(("click", a, k)))
    r = be.element_action(action="click", name="OK", control_type="button", x=5, y=6)
    assert r["via"] == "uia" and calls[0]["name"] == "OK" and (calls[0]["x"], calls[0]["y"]) == (5, 6)
    # double-clic : pas de pattern → coordonnées directement
    calls.clear()
    be.element_action(action="click", name="project_test", control_type="listitem", x=5, y=6, clicks=2)
    assert calls == [("click", (5, 6), {"button": "left", "clicks": 2})]


def test_pywinauto_ne_fait_pas_invoke_sur_un_menuitem(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)

    class Ctrl:
        def __init__(self): self.calls = []
        def invoke(self): self.calls.append("invoke")
        def click_input(self, button="left", double=False): self.calls.append(("click_input", double))
    c = Ctrl()
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: c)
    monkeypatch.setattr(W, "_pattern_action", lambda ctrl, action, text="", **kw: None)
    r = be.element_action(action="click", name="Préférences", control_type="menuitem")
    assert r["method"] == "click_input" and c.calls == [("click_input", False)]
    c.calls.clear()
    be.element_action(action="click", name="OK", control_type="button")
    assert c.calls == ["invoke"]
