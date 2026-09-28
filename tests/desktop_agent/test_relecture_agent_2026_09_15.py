# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_relecture_agent_2026_09_15.py — relecture du 15/09 de
l'agent Windows (backend + serveur), objets factices (aucun COM ici).

- une action SANS pattern qui n'est pas un clic (collapse, scroll_into_view…) n'est
  jamais convertie en clic au centre ;
- un appel de pattern qui échoue LENTEMENT (Invoke bloqué par un dialogue modal) a
  probablement agi : pas de clic de repli sur le dialogue ;
- un geste envoyé en partie (PartialInput) n'est ni rejoué ni cliqué aux coordonnées ;
- homonymes dont aucun ne contient le point : ambigu → clic au point ;
- dialogue possédé au premier plan = sa fenêtre est devant ; appli figée : aucun appel bloquant ;
- serveur : délai du client (X-Elpis-Timeout), nom de script réservé, une exécution à la
  fois, dossier de rapport de --repeat, entiers défensifs, arrêt qui relâche les touches.
"""
from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path

import pytest

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)

from backends import windows as W  # noqa: E402
from backends.base import NotSupported, PartialInput  # noqa: E402
from test_clics_gestes_2026_09_14 import Ctrl, _be, _fake_windll, _Fn  # noqa: E402
from test_uia_comtypes_fallback_2026_09_13 import El, Mod, Found  # noqa: E402


# ── backend : repli coordonnées réservé aux clics ─────────────────────────────
def test_collapse_sans_pattern_jamais_un_clic(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: None)
    monkeypatch.setattr(W, "_retry_schedule", lambda *a, **k: [0.0])
    monkeypatch.setattr(W, "_uia_element_action", lambda **kw: None)
    seen = []
    monkeypatch.setattr(be, "click", lambda *a, **k: seen.append(a))
    for action in ("collapse", "expand", "scroll_into_view", "set_value"):
        with pytest.raises(NotSupported):
            be.element_action(action=action, name="Couches", control_type="treeitem", x=10, y=20)
    assert seen == [], "aucun clic au centre pour une action qu'un clic n'accomplit pas"
    assert be.element_action(action="toggle", name="Case", x=10, y=20)["method"] == "coords", "bascule : le clic reste le repli"


def test_invoke_lent_qui_echoue_n_est_pas_rejoue_en_clic(monkeypatch):
    """Invoke d'un bouton qui ouvre un dialogue modal : bloqué ~20 s puis UIA_E_TIMEOUT."""
    clock = {"t": 100.0}
    monkeypatch.setattr(W.time, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(W, "_automation", lambda: object())
    monkeypatch.setattr(W, "_UIA_MOD", Mod)
    monkeypatch.setattr(W, "_uia_find", lambda *a, **k: El(50000, {}))

    def slow_fail(mod, el, action, text=""):
        clock["t"] += 20.0
        raise OSError("UIA_E_TIMEOUT")
    monkeypatch.setattr(W, "_uia_action", slow_fail)
    r = W._uia_element_action(action="click", name="Propriétés", control_type="button", x=5, y=5)
    assert r and r["uncertain"] is True and r["method"] == "click", r

    def fast_fail(mod, el, action, text=""):
        raise OSError("E_NOTIMPL")
    monkeypatch.setattr(W, "_uia_action", fast_fail)
    assert W._uia_element_action(action="click", name="X", x=5, y=5) is None, "échec immédiat : l'appelant clique"

    # chemin pywinauto : Invoke avalé par _try_pattern_call mais LENT → pas de clic
    c = Ctrl()
    c.iface_selection_item = None
    c.iface_toggle = None

    def slow_invoke():
        clock["t"] += 20.0
        raise OSError("timeout")
    c.invoke = slow_invoke
    be, clicks = _be(monkeypatch, c)
    monkeypatch.setattr(W, "_pattern_action", lambda *a, **k: None)
    r = be.element_action(action="click", name="Propriétés", control_type="button", x=5, y=5)
    assert r.get("uncertain") is True and clicks == [], (r, clicks)


def test_geste_partiel_ni_rejoue_ni_clic_de_repli(monkeypatch):
    c = Ctrl()
    be, _ = _be(monkeypatch, c)

    def partial(*a, **k):
        raise PartialInput("clic partiel (1/2)")
    monkeypatch.setattr(be, "click", partial)
    monkeypatch.setattr(W, "_uia_element_action", lambda **kw: (_ for _ in ()).throw(AssertionError("pas de repli comtypes")))
    with pytest.raises(PartialInput):
        be.element_action(action="click", name="projet.qgz", control_type="listitem", clicks=2, x=1, y=1)


def test_uia_find_homonymes_hors_du_point_ambigus(monkeypatch):
    class Scope:
        def __init__(self, els): self.els = els
        def FindAll(self, scope, cond): return Found(self.els)

    class Auto:
        def __init__(self, fg, root): self.fg, self.root = fg, root
        def CreatePropertyCondition(self, pid, val): return (pid, val)
        def CreateAndCondition(self, a, b): return ("and", a, b)
        def ElementFromHandle(self, h): return self.fg
        def GetRootElement(self): return self.root
    rows = [El(50000, {}, rect=(0, y, 50, 20), name="Modifier") for y in (0, 30, 60)]
    monkeypatch.setattr(W, "_is_shell_window", lambda h: False)
    _fake_windll(monkeypatch, user_rets={"GetForegroundWindow": 5})
    auto = Auto(Scope(rows), Scope(rows))
    assert W._uia_find(auto, Mod, name="Modifier", control_type="button", x=25, y=500) is None, \
        "trois « Modifier », aucun sous le point : ambigu (l'appelant clique au point)"
    assert W._uia_find(auto, Mod, name="Modifier", control_type="button", x=25, y=65) is rows[2]
    one = El(50000, {}, rect=(0, 0, 50, 20), name="OK")
    assert W._uia_find(Auto(Scope([one]), Scope([one])), Mod, name="OK", x=400, y=400) is one, "candidat unique : gardé"


def test_menuitem_clic_sans_parcours_d_arbre(monkeypatch):
    monkeypatch.setattr(W, "_automation", lambda: object())
    monkeypatch.setattr(W, "_UIA_MOD", Mod)
    monkeypatch.setattr(W, "_uia_find", lambda *a, **k: (_ for _ in ()).throw(AssertionError("recherche inutile")))
    assert W._uia_element_action(action="click", name="Fichier", control_type="menu item", x=1, y=1) is None


# ── premier plan ──────────────────────────────────────────────────────────────
def test_dialogue_possede_au_premier_plan_compte_comme_devant(monkeypatch):
    # fg = dialogue 77, GA_ROOT(77) = 77, GA_ROOTOWNER(77) = 42 (QGIS)
    _fake_windll(monkeypatch, user_rets={"GetForegroundWindow": 77, "GetAncestor": lambda h, f: 42 if f == 3 else h})
    assert W._is_foreground_root(42) is True
    assert W._is_foreground_root(99) is False


def test_appli_figee_aucun_appel_bloquant(monkeypatch):
    log = _fake_windll(monkeypatch, user_rets={"GetForegroundWindow": 7, "GetAncestor": lambda h, f: h,
                                               "IsHungAppWindow": 1, "IsIconic": 0},
                       kernel_rets={"GetCurrentThreadId": 1})
    assert W._win32_force_foreground(42) is False
    names = {c[0] for c in log}
    assert not names & {"ShowWindow", "ShowWindowAsync", "BringWindowToTop", "AttachThreadInput", "SetForegroundWindow"}, names


def test_relache_les_touches_restees_enfoncees(monkeypatch):
    down = {0x11, 0x01}                                     # Ctrl + bouton gauche
    _fake_windll(monkeypatch, user_rets={"GetAsyncKeyState": lambda vk: 0x8000 if vk in down else 0})
    sent = []
    monkeypatch.setattr(W, "_sendinput", lambda d: sent.append(d) or len(d))
    assert W.release_stuck_inputs() == ["ctrl", "lbutton"]
    assert sent[0][0] == {"kind": "key", "vk": 0x11, "scan": 0, "flags": W.KEYEVENTF_KEYUP}
    assert sent[0][1]["flags"] == W.MOUSEEVENTF_LEFTUP
    down.clear(); sent.clear()
    assert W.release_stuck_inputs() == [] and sent == [], "rien d'enfoncé : aucune entrée"


def test_sortie_console_oem_et_presse_papiers_occupe(monkeypatch):
    _fake_windll(monkeypatch, kernel_rets={"GetOEMCP": 850})
    assert W._decode_console("Répertoire".encode("cp850")) == "Répertoire"
    assert W._decode_console("déjà".encode("utf-8")) == "déjà"
    tries = {"n": 0}

    class U:
        def OpenClipboard(self, h):
            tries["n"] += 1
            return tries["n"] >= 3
    monkeypatch.setattr(W.time, "sleep", lambda s: None)
    assert W._open_clipboard(U()) is True and tries["n"] == 3


def test_glisser_relache_le_bouton_sur_erreur(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    ev = []

    class PG:
        def moveTo(self, x, y):
            if ev and ev[-1] == "down":
                raise RuntimeError("FailSafe")
        def mouseDown(self, button="left"): ev.append("down")
        def mouseUp(self, button="left"): ev.append("up")
        def keyDown(self, k): ev.append("kd")
        def keyUp(self, k): ev.append("ku")
    monkeypatch.setattr(be, "_need", lambda: PG())
    monkeypatch.setattr(be, "monitor_origin", lambda: (0, 0))
    monkeypatch.setattr(be, "_mods", lambda m: ["shift"] if m else [])
    monkeypatch.setattr(W.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError):
        be.drag(0, 0, 10, 10, "shift")
    assert ev == ["kd", "down", "up", "ku"], ev


# ── serveur ───────────────────────────────────────────────────────────────────
from test_agent_worker import _fresh_server, _cleanup, _FakeBackend  # noqa: E402


@pytest.fixture
def srv(tmp_path):
    mod, saved = _fresh_server()
    fake = _FakeBackend()
    fake._NotSupported = mod.NotSupported
    mod.backend = fake
    mod._AUTOMATIONS = tmp_path
    try:
        yield mod, fake
    finally:
        _cleanup(saved)


async def _call(mod, method, path, json=None, headers=None):
    from httpx import ASGITransport, AsyncClient
    async with AsyncClient(transport=ASGITransport(app=mod.app), base_url="http://agent") as ac:
        if method == "GET":
            return await ac.get(path, headers=headers)
        return await ac.post(path, json=json or {}, headers=headers)


def test_op_en_file_abandonnee_par_le_client_ne_part_jamais(srv):
    """Elpis abandonne à 30 s : un clic resté EN FILE derrière une attente ne doit pas
    partir après coup (clic fantôme, puis celui du réessai)."""
    mod, fake = srv
    mod._HUNG_AFTER_SEC = 999
    fake._gate = threading.Event()
    fake._gate_op = "ui_tree"

    async def run():
        blocked = asyncio.ensure_future(_call(mod, "POST", "/ui_tree", {}))
        await asyncio.sleep(0.3)
        r = await _call(mod, "POST", "/click", {"x": 1, "y": 1}, headers={"X-Elpis-Timeout": "2"})
        fake._gate.set()
        await blocked
        await asyncio.sleep(0.3)                  # le worker dépile la suite
        return r

    r = asyncio.run(run())
    assert r.status_code == 503
    assert "click" not in [c[0] for c in fake.calls], "l'op abandonnée par le client n'a pas été exécutée"


def test_nom_de_script_reserve_refuse(srv):
    mod, _ = srv

    async def run():
        a = await _call(mod, "POST", "/put_file", {"path": "csv.py", "content": "x = 1"})
        b = await _call(mod, "POST", "/put_file", {"path": "elpis_auto.py", "content": "x = 1"})
        c = await _call(mod, "POST", "/put_file", {"path": "lib/csv.py", "content": "x = 1"})
        d = await _call(mod, "POST", "/put_file", {"path": "flux-csv.py", "content": "x = 1"})
        e = await _call(mod, "POST", "/run_script", {"name": "json"})
        return a, b, c, d, e
    a, b, c, d, e = asyncio.run(run())
    assert a.status_code == 400 and b.status_code == 400 and e.status_code == 400
    assert c.status_code == 200 and d.status_code == 200, "sous-dossier ou nom non importable : permis"
    assert not mod._shadows_import("Flux X.py") and mod._shadows_import("csv.py")


def test_une_execution_a_la_fois_et_rapport_de_repetition(srv, tmp_path):
    mod, _ = srv

    class Proc:
        def __init__(self, alive): self._alive = alive
        def poll(self): return None if self._alive else 0
    mod._RUNS.clear()
    mod._RUNS["r1"] = {"id": "r1", "name": "long", "proc": Proc(True), "code": None, "started": 0, "log": []}
    (tmp_path / "a.py").write_text("print(1)")

    async def run():
        return await _call(mod, "POST", "/run_script", {"name": "a"})
    r = asyncio.run(run())
    assert r.status_code == 409 and "déjà en cours" in r.text
    mod._RUNS["r1"]["proc"] = Proc(False)              # processus fini (code pas encore lu) : libre
    (tmp_path / "rapports" / "a-stab").mkdir(parents=True)
    (tmp_path / "rapports" / "a-stab" / "stabilite.json").write_text("{}")
    assert mod._report_dir_ok("rapports\\a-stab"), "--repeat : stabilite.json désigne le dossier"
    mod._RUNS.clear()


def test_entiers_defensifs(srv):
    mod, _ = srv
    assert mod._int("abc", 7) == 7 and mod._int({}, 1) == 1 and mod._int("12", 0) == 12 and mod._int(3.9, 0) == 3
    assert mod._int(None, None) is None


def test_arret_relache_les_touches(srv, monkeypatch):
    mod, _ = srv
    killed, released = [], []

    class Proc:
        pid = 4242
        def terminate(self): killed.append("terminate")
        def wait(self, timeout=None): return 0
    monkeypatch.setattr(mod.os, "name", "nt")
    monkeypatch.setattr(W, "kill_process_tree", lambda pid: killed.append(pid))
    monkeypatch.setattr(W, "release_stuck_inputs", lambda: released.append(1) or ["ctrl"])
    assert mod._stop_run_process(Proc()) == ["ctrl"]
    assert killed == [4242] and released == [1], "arbre tué puis touches relâchées"
