# SPDX-License-Identifier: MIT
"""
tests/desktop_agent/test_uia_cache.py — P0/P1 : lecture UIA batchée par CacheRequest
+ enrichissement par control patterns. La logique PURE (construction de nœud depuis
les valeurs cachées, déduction value/states/patterns, RuntimeId, DFS sur l'arbre
caché) est validée hors Windows avec de FAUX éléments COM. Le seul code non couvert
ici est le BuildUpdatedCache réel (à valider sur la VM Windows).

Même précaution d'import que test_agent_contract : on insère ``desktop-agent`` au
sys.path le temps des imports puis on le retire (sinon son ``server.py`` masque le
package ``server/`` du repo).
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
        win = importlib.import_module("backends.windows")
        return win
    finally:
        sys.path[:] = saved


win = _load()


# ── RuntimeId → clé stable ────────────────────────────────────────────────────
def test_rid_to_hex():
    assert win._rid_to_hex([42, 133100]) == "42.133100"
    assert win._rid_to_hex((7,)) == "7"
    assert win._rid_to_hex(None) == ""
    assert win._rid_to_hex([]) == ""


# ── déduction value / states / patterns depuis les valeurs de pattern cachées ─
def test_toggle_checked():
    value, states, patterns = win._value_states_patterns(
        {"has_toggle": True, "toggle_state": 1})
    assert "checked" in states and "toggle" in patterns and value is None


def test_toggle_unchecked_and_indeterminate():
    _, s_off, _ = win._value_states_patterns({"has_toggle": True, "toggle_state": 0})
    _, s_ind, _ = win._value_states_patterns({"has_toggle": True, "toggle_state": 2})
    assert "unchecked" in s_off
    assert "indeterminate" in s_ind


def test_value_pattern_readonly():
    value, states, patterns = win._value_states_patterns(
        {"has_value": True, "value": "hello@x.com", "value_readonly": True})
    assert value == "hello@x.com" and "readonly" in states and "value" in patterns


def test_range_value_formats_number():
    value, _, patterns = win._value_states_patterns(
        {"has_range": True, "range_value": 42.0})
    assert value == "42" and "range" in patterns


def test_selection_and_expand_states():
    _, s_sel, p_sel = win._value_states_patterns(
        {"has_selectionitem": True, "selected": True})
    _, s_exp, p_exp = win._value_states_patterns(
        {"has_expandcollapse": True, "expand_state": 1})
    assert "selected" in s_sel and "selectionitem" in p_sel
    assert "expanded" in s_exp and "expandcollapse" in p_exp


def test_invoke_and_scrollitem_patterns_listed():
    _, _, patterns = win._value_states_patterns(
        {"has_invoke": True, "has_scrollitem": True})
    assert "invoke" in patterns and "scrollitem" in patterns


# ── _node_from_props : construction de nœud complète ──────────────────────────
def _props(**over):
    base = {
        "rect": [10, 20, 60, 24], "control_type": 50002, "name": "Accepter",
        "automation_id": "acceptChk", "class_name": "WinForms.Check",
        "runtime_id": [7, 999], "enabled": True, "focused": False, "offscreen": False,
        "has_toggle": True, "toggle_state": 1,
    }
    base.update(over)
    return base


def test_node_from_props_full():
    n = win._node_from_props(_props(), depth=2)
    assert n["role"] == "checkbox"           # 50002 → checkbox (normalisé)
    assert n["name"] == "Accepter"
    assert n["auto_id"] == "acceptChk"
    assert n["runtime_id"] == "7.999"
    assert n["class_name"] == "WinForms.Check"
    assert n["rect"] == [10, 20, 60, 24]
    assert n["depth"] == 2
    assert "enabled" in n["states"] and "checked" in n["states"]
    assert "toggle" in n["patterns"]


def test_node_from_props_rejects_zero_size():
    assert win._node_from_props(_props(rect=[0, 0, 0, 0]), 0) is None
    assert win._node_from_props(_props(rect=None), 0) is None
    assert win._node_from_props({"rect": [1, 2]}, 0) is None   # rect tronqué


def test_node_from_props_value_field_real():
    n = win._node_from_props(
        {"rect": [0, 0, 100, 20], "control_type": 50004, "name": "Email",
         "has_value": True, "value": "a@b.c"}, 1)
    assert n["value"] == "a@b.c" and n["role"] == "textbox"


# ── _extract_props : glue COM mince (faux élément) ────────────────────────────
class _FakeCachedEl:
    """Faux IUIAutomationElement caché : GetCachedPropertyValue(pid) lit un dict."""
    def __init__(self, props, children=None):
        self._p = props
        self._children = children or []

    def GetCachedPropertyValue(self, pid):
        return self._p.get(pid)

    def GetCachedChildren(self):
        return _FakeArray(self._children)


class _FakeArray:
    def __init__(self, items):
        self._items = items

    @property
    def Length(self):
        return len(self._items)

    def GetElement(self, i):
        return self._items[i]


def test_extract_props_maps_logical_keys(monkeypatch):
    # _PID mappe clé logique → pid ; ici pid == clé logique pour simplifier.
    monkeypatch.setattr(win, "_PID", {"rect": "rect", "name": "name",
                                      "control_type": "control_type"})
    el = _FakeCachedEl({"rect": [1, 2, 3, 4], "name": "X", "control_type": 50000})
    p = win._extract_props(el)
    assert p == {"rect": [1, 2, 3, 4], "name": "X", "control_type": 50000}


# ── _walk_cached : DFS sur arbre caché, bornes (depth/fanout/max_nodes) ───────
def _ident_pid(monkeypatch):
    monkeypatch.setattr(win, "_PID", {k: k for k in (
        "rect", "control_type", "name", "automation_id", "class_name",
        "runtime_id", "enabled", "focused", "offscreen")})


def _leaf(name, x=0):
    return _FakeCachedEl({"rect": [x, 0, 10, 10], "control_type": 50000,
                          "name": name, "enabled": True})


def test_walk_cached_collects_subtree(monkeypatch):
    _ident_pid(monkeypatch)
    child = _FakeCachedEl({"rect": [0, 0, 50, 50], "control_type": 50032,
                           "name": "panel", "enabled": True},
                          children=[_leaf("A", 1), _leaf("B", 2)])
    root = _FakeCachedEl({"rect": [0, 0, 100, 100], "control_type": 50032,
                          "name": "win", "enabled": True}, children=[child])
    nodes = []
    win._walk_cached(root, nodes, 1, max_nodes=300)
    names = [n["name"] for n in nodes]
    assert names == ["panel", "A", "B"]          # DFS pré-ordre
    assert [n["depth"] for n in nodes] == [1, 2, 2]


def test_walk_cached_respects_max_nodes(monkeypatch):
    _ident_pid(monkeypatch)
    root = _FakeCachedEl({"rect": [0, 0, 100, 100], "control_type": 50032,
                          "name": "win", "enabled": True},
                         children=[_leaf("a"), _leaf("b"), _leaf("c"), _leaf("d")])
    nodes = []
    win._walk_cached(root, nodes, 1, max_nodes=2)
    assert len(nodes) <= 2


# ── _pattern_action : action sémantique par control pattern (faux contrôle) ───
class _Toggle:
    def __init__(self, state=0, rec=None):
        self.CurrentToggleState = state
        self._rec = rec if rec is not None else []

    def Toggle(self):
        self._rec.append("Toggle")


class _Sel:
    def __init__(self, rec):
        self._rec = rec

    def Select(self):
        self._rec.append("Select")


class _Exp:
    def __init__(self, rec):
        self._rec = rec

    def Expand(self):
        self._rec.append("Expand")

    def Collapse(self):
        self._rec.append("Collapse")


def _ctrl(**iface):
    c = type("C", (), {})()
    for k, v in iface.items():
        setattr(c, k, v)
    return c


def test_pattern_action_toggle():
    rec = []
    r = win._pattern_action(_ctrl(iface_toggle=_Toggle(0, rec)), "toggle")
    assert r["method"] == "toggle" and rec == ["Toggle"]


def test_pattern_action_check_noop_when_already_on():
    rec = []
    r = win._pattern_action(_ctrl(iface_toggle=_Toggle(1, rec)), "check")
    assert r.get("noop") is True and rec == []      # déjà coché → pas de bascule


def test_pattern_action_uncheck_toggles_when_on():
    rec = []
    r = win._pattern_action(_ctrl(iface_toggle=_Toggle(1, rec)), "uncheck")
    assert r["method"] == "toggle" and rec == ["Toggle"]


def test_pattern_action_select_and_expand_collapse():
    rec = []
    assert win._pattern_action(_ctrl(iface_selection_item=_Sel(rec)), "select")["method"] == "select"
    assert win._pattern_action(_ctrl(iface_expand_collapse=_Exp(rec)), "expand")["method"] == "expand"
    assert win._pattern_action(_ctrl(iface_expand_collapse=_Exp(rec)), "collapse")["method"] == "collapse"
    assert rec == ["Select", "Expand", "Collapse"]


def test_pattern_action_set_value():
    got = {}
    v = type("V", (), {"SetValue": lambda self, t: got.update(t=t)})()
    r = win._pattern_action(_ctrl(iface_value=v), "set_value", text="hi")
    assert r["method"] == "set_value" and got == {"t": "hi"}


def test_pattern_action_generic_click_prefers_toggle_then_select():
    rec = []
    # checkbox : un clic = Toggle (InvokePattern absent → sinon clic-coords)
    assert win._pattern_action(_ctrl(iface_toggle=_Toggle(0, rec)), "click")["method"] == "toggle"
    # listitem : pas de toggle → Select
    assert win._pattern_action(_ctrl(iface_selection_item=_Sel(rec)), "click")["method"] == "select"
    assert rec == ["Toggle", "Select"]


def test_pattern_action_click_none_without_patterns():
    # bouton simple (aucun iface présent) → None → l'appelant fera Invoke/clic
    assert win._pattern_action(_ctrl(), "click") is None


def test_pattern_action_explicit_missing_pattern_returns_none():
    # toggle demandé mais contrôle sans TogglePattern → None (→ repli coords)
    assert win._pattern_action(_ctrl(), "toggle") is None


# ── P8 : classifieur COM transitoire + re-résolution / retry ──────────────────
class _FakeCOMError(Exception):
    def __init__(self, hresult):
        self.hresult = hresult
        super().__init__("com 0x%x" % (hresult & 0xFFFFFFFF))


def _raise(exc):
    def _f():
        raise exc
    return _f


def test_is_transient_com():
    assert win._is_transient_com(_FakeCOMError(-2147220991))     # 0x80040201 signé
    assert win._is_transient_com(_FakeCOMError(0x80010108))      # RPC_E_DISCONNECTED unsigned
    assert win._is_transient_com(_FakeCOMError(0x8001010A))      # RETRYLATER
    assert not win._is_transient_com(_FakeCOMError(0x80004005))  # E_FAIL → NON transitoire
    assert not win._is_transient_com(AttributeError("iface_toggle"))  # pattern absent
    e = Exception()
    e.args = (0x800706BA,)                                       # via args[0]
    assert win._is_transient_com(e)


def test_retry_schedule_bounded():
    s = win._retry_schedule()
    assert s[0] == 0.0                          # 1ʳᵉ tentative immédiate
    assert len(s) >= 2                          # au moins un retry
    assert sum(s) * 1000.0 <= 600 + 1           # cumul borné (~thread loop unique)


def test_try_pattern_call_distinguishes_transient_from_absent():
    import pytest
    assert win._try_pattern_call(lambda: None) is True
    assert win._try_pattern_call(_raise(AttributeError())) is False   # pattern absent
    with pytest.raises(Exception):
        win._try_pattern_call(_raise(_FakeCOMError(0x80040201)))      # transitoire → remonte


def test_pattern_action_reraises_transient_not_absent():
    import pytest

    class _TogTransient:
        CurrentToggleState = 0

        def Toggle(self):
            raise _FakeCOMError(0x80040201)     # élément périmé

    with pytest.raises(Exception):
        win._pattern_action(_ctrl(iface_toggle=_TogTransient()), "toggle")
    # pattern absent → None (repli coords), PAS d'exception
    assert win._pattern_action(_ctrl(), "select") is None


def test_element_action_retries_transient_then_succeeds(monkeypatch):
    wb = win.WindowsBackend()
    monkeypatch.setattr(win, "_retry_schedule", lambda *a, **k: [0.0, 0.0, 0.0])

    class _TogFail:
        CurrentToggleState = 0

        def Toggle(self):
            raise _FakeCOMError(0x80040201)     # 1ère résolution : élément périmé

    rec = []

    class _TogOK:
        CurrentToggleState = 0

        def Toggle(self):
            rec.append("ok")                    # 2e résolution : succès

    ctrls = iter([_ctrl(iface_toggle=_TogFail()), _ctrl(iface_toggle=_TogOK())])
    monkeypatch.setattr(wb, "_find_ctrl", lambda **k: next(ctrls))
    r = wb.element_action(action="toggle", auto_id="x")
    assert r["method"] == "toggle" and rec == ["ok"]   # re-résolu après le transitoire


def test_element_action_non_transient_falls_to_coords(monkeypatch):
    wb = win.WindowsBackend()
    monkeypatch.setattr(win, "_retry_schedule", lambda *a, **k: [0.0])
    seen = {}
    monkeypatch.setattr(wb, "click", lambda x, y, button="left", clicks=1: seen.update(x=x, y=y))

    class _TogErr:
        CurrentToggleState = 0

        def Toggle(self):
            raise ValueError("boom")            # NON transitoire → pas de retry COM

    monkeypatch.setattr(wb, "_find_ctrl", lambda **k: _ctrl(iface_toggle=_TogErr()))
    r = wb.element_action(action="toggle", auto_id="x", x=7, y=8)
    assert r["method"] == "coords" and seen == {"x": 7, "y": 8}


# ── P7 : builders SendInput (purs, testables hors Windows) ────────────────────
def test_utf16_units():
    assert win._utf16_units("a") == [0x61]
    assert win._utf16_units("é") == [0xE9]               # BMP
    assert win._utf16_units("😀") == [0xD83D, 0xDE00]     # hors-BMP → paire de substitution
    assert win._utf16_units("") == []


def test_vk_for():
    assert win._vk_for("ctrl") == 0x11
    assert win._vk_for("s") == 0x53                      # lettre = code ASCII majuscule
    assert win._vk_for("F5") == 0x74
    assert win._vk_for("enter") == 0x0D
    assert win._vk_for("?") is None                      # caractère non alphanum seul
    assert win._vk_for("") is None


def test_named_key_descriptors_combo_order():
    d = win._named_key_descriptors("ctrl+s")
    assert [x["vk"] for x in d] == [0x11, 0x53, 0x53, 0x11]   # mod↓ touche↓ touche↑ mod↑
    assert d[0]["flags"] == 0 and d[2]["flags"] == win.KEYEVENTF_KEYUP


def test_named_key_descriptors_multi_mod():
    d = win._named_key_descriptors("ctrl+shift+a")
    assert [x["vk"] for x in d] == [0x11, 0x10, 0x41, 0x41, 0x10, 0x11]


def test_named_key_descriptors_unknown_returns_empty():
    assert win._named_key_descriptors("ctrl+zzz") == []   # touche inconnue → repli pyautogui
    assert win._named_key_descriptors("") == []


def test_normalize_abs():
    assert win._normalize_abs(0, 0, 0, 0, 1920, 1080) == (0, 0)
    assert win._normalize_abs(1919, 0, 0, 0, 1920, 1080) == (65535, 0)
    assert win._normalize_abs(0, 1079, 0, 0, 1920, 1080) == (0, 65535)
    assert win._normalize_abs(5000, 0, 0, 0, 1920, 1080) == (65535, 0)   # clampé
    # bureau virtuel décalé (écran secondaire à gauche, left négatif)
    assert win._normalize_abs(-1920, 0, -1920, 0, 3840, 1080)[0] == 0


# ── routage type/key → SendInput (DÉFAUT ON, layout-indépendant, repli pyautogui) ─
def test_type_text_routes_to_sendinput_when_enabled(monkeypatch):
    wb = win.WindowsBackend()
    wb._use_sendinput = True
    sent = {}
    monkeypatch.setattr(win, "_sendinput", lambda desc: sent.update(n=len(desc)) or len(desc))
    wb.type_text("hi")
    assert sent["n"] == 4                                # 2 chars × (down, up), pas de pyautogui


def test_type_text_falls_back_when_sendinput_fails(monkeypatch):
    wb = win.WindowsBackend()
    wb._use_sendinput = True
    monkeypatch.setattr(win, "_sendinput", lambda desc: 0)   # SendInput KO
    written = {}
    wb._pyautogui = type("PG", (), {"write": lambda self, t, interval=0: written.update(t=t)})()
    wb._input_impl = "pyautogui"
    wb.type_text("hi")
    assert written["t"] == "hi"                          # repli pyautogui


def test_key_routes_to_sendinput_when_enabled(monkeypatch):
    wb = win.WindowsBackend()
    wb._use_sendinput = True
    cap = {}
    monkeypatch.setattr(win, "_sendinput", lambda desc: cap.update(desc=desc) or len(desc))
    wb.key("ctrl+s")
    assert [d["vk"] for d in cap["desc"]] == [0x11, 0x53, 0x53, 0x11]


def test_key_unknown_combo_falls_back_to_pyautogui(monkeypatch):
    wb = win.WindowsBackend()
    wb._use_sendinput = True
    monkeypatch.setattr(win, "_sendinput", lambda desc: len(desc))
    hot = {}
    wb._pyautogui = type("PG", (), {"hotkey": lambda self, *a: hot.update(a=a)})()
    wb._input_impl = "pyautogui"
    wb.key("ctrl+zzz")                                   # zzz inconnu → desc vide → repli
    assert hot["a"] == ("ctrl", "zzz")


def test_sendinput_on_by_default(monkeypatch):
    monkeypatch.delenv("DESKTOP_USE_SENDINPUT", raising=False)
    wb = win.WindowsBackend()
    assert wb._use_sendinput is True                     # DÉFAUT ON → frappe layout-indépendante


def test_sendinput_opt_out_via_env(monkeypatch):
    monkeypatch.setenv("DESKTOP_USE_SENDINPUT", "0")
    assert win.WindowsBackend()._use_sendinput is False   # opt-out explicite


def test_text_key_descriptors_unicode_and_newline():
    # « ( » injecté en Unicode (layout-indépendant), pas via une touche US.
    d = win._text_key_descriptors("(")
    assert d[0] == {"kind": "key", "vk": 0, "scan": 0x28, "flags": win.KEYEVENTF_UNICODE}
    # un saut de ligne devient Entrée (VK_RETURN), pas un LF Unicode nu.
    d2 = win._text_key_descriptors("a\nb")
    vks = [x["vk"] for x in d2]
    assert win._VK["enter"] in vks                        # Entrée présente
    # 'a' (2) + Entrée (2) + 'b' (2) = 6 descripteurs
    assert len(d2) == 6
    # \r\n compté comme UN seul saut de ligne
    assert len(win._text_key_descriptors("a\r\nb")) == 6


# ── Clic SendInput ancré : chaque évènement porte la position absolue ─────────
def test_mouse_click_descriptors_anchored_and_atomic():
    v = (0, 0, 1601, 1201)               # bureau virtuel 1600×1200 (largeur-1 = 1600)
    d = win._mouse_click_descriptors(800, 600, "left", 2, v)
    assert len(d) == 1 + 2 * 2, "move + (down, up) × 2 clics"
    base = win.MOUSEEVENTF_MOVE | win.MOUSEEVENTF_ABSOLUTE | win.MOUSEEVENTF_VIRTUALDESK
    assert d[0]["flags"] == base
    assert d[1]["flags"] == base | win.MOUSEEVENTF_LEFTDOWN and d[2]["flags"] == base | win.MOUSEEVENTF_LEFTUP
    assert d[3]["flags"] == base | win.MOUSEEVENTF_LEFTDOWN and d[4]["flags"] == base | win.MOUSEEVENTF_LEFTUP
    # position ABSOLUE répétée sur CHAQUE évènement (un mouvement utilisateur ne déplace pas le clic)
    assert all((x["dx"], x["dy"]) == (d[0]["dx"], d[0]["dy"]) for x in d)
    assert d[0]["dx"] == round(800 * 65535 / 1600) and d[0]["dy"] == round(600 * 65535 / 1200)
    r = win._mouse_click_descriptors(1, 1, "right", 1, v)
    assert r[1]["flags"] & win.MOUSEEVENTF_RIGHTDOWN and r[2]["flags"] & win.MOUSEEVENTF_RIGHTUP
    assert win._mouse_click_descriptors(1, 1, "x1", 1, v) == []
