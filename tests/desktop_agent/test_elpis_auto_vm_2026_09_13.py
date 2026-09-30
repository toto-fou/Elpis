# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_elpis_auto_vm_2026_09_13.py — ce que la VM a appris
le 13/09 : (1) ``window=`` avant un clic est un geste SOUPLE (le bureau
« Program Manager » n'était pas listé → ABANDON dès l'étape 1) ; (2) une attente
est un délai d'INACTIVITÉ : tant que l'écran bouge (QGIS qui se lance en 20 s),
l'échéance recule ; (3) ``focus``/``require`` voient le bureau. Backend factice.
"""
from __future__ import annotations

import io
import sys
import time
from pathlib import Path

import pytest

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)

from elpis_auto import Session, StepError  # noqa: E402
from elpis_auto.session import _activity, _moved, _Patience  # noqa: E402
from test_elpis_auto import FakeBackend, PNG_1x1, _calls, _node  # noqa: E402


def _png(gray: int, size=(96, 54)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("L", size, gray).save(buf, format="PNG")
    return buf.getvalue()


def DESKTOP():
    return [
        _node("pane", "Program Manager", 0, 0, 1600, 1200),
        _node("listitem", "project_test", 20, 620, 60, 60),
        _node("window", "project_test — QGIS", 0, 0, 1600, 1200, auto_id="QgisApp"),
        _node("checkbox", "Console Python", 1105, 84, 32, 31, states=("unchecked",)),
    ]


class WinBackend(FakeBackend):
    """list_windows avec ``include_desktop`` (agent récent) et journal des activations."""
    def __init__(self, nodes=None, foreground="project_test — QGIS", desktop_supported=True):
        super().__init__(nodes=nodes)
        self.foreground = foreground
        self.desktop_supported = desktop_supported

    def list_windows(self, max_items=60, include_desktop=False):
        self._log("list_windows", include_desktop=include_desktop)
        wins = [{"hwnd": 11, "title": "project_test — QGIS", "state": "maximized",
                 "is_foreground": self.foreground == "project_test — QGIS"},
                {"hwnd": 12, "title": "rapports", "state": "normal", "is_foreground": self.foreground == "rapports"}]
        if include_desktop and self.desktop_supported:
            wins.append({"hwnd": 1, "title": "Program Manager", "state": "normal",
                         "is_foreground": self.foreground == "Program Manager", "desktop": True})
        return {"windows": wins}

    def window_action(self, action="activate", hwnd=0):
        self._log("window_action", action=action, hwnd=hwnd)
        return {"ok": True}


class OldBackend(FakeBackend):
    """Agent ANCIEN : list_windows sans paramètre."""
    def list_windows(self):
        self._log("list_windows")
        return {"windows": [{"hwnd": 11, "title": "project_test — QGIS", "state": "normal", "is_foreground": False}]}

    def window_action(self, action="activate", hwnd=0):
        self._log("window_action", action=action, hwnd=hwnd)
        return {"ok": True}


@pytest.fixture
def s(tmp_path):
    return Session(backend=WinBackend(nodes=DESKTOP()), report_dir=str(tmp_path), name="vm", settle=0, timeout=0.3)


# ── 1. premier plan SOUPLE avant un clic ─────────────────────────────────────

def test_clic_sur_le_bureau_active_program_manager_et_ne_casse_pas(s):
    s.click(name="project_test", role="listitem", window="Program Manager", clicks=2)
    st = s.report.steps[-1]
    assert st["ok"] and st["label"].startswith("double-clic"), "plus d'étape « premier plan » séparée qui abandonne"
    acts = _calls(s, "window_action")
    assert acts and acts[-1]["hwnd"] == 1, "le bureau est activé par son HWND (agent récent)"
    assert all(c.get("include_desktop") for c in _calls(s, "list_windows"))


def test_fenetre_deja_devant_pas_reactivee(s):
    s.click(name="Console Python", role="checkbox", window="QGIS")
    assert not _calls(s, "window_action"), "déjà au premier plan : pas de ré-activation (pas de clignotement)"
    s._backend.foreground = "rapports"
    s.click(name="Console Python", role="checkbox", window="QGIS")
    assert _calls(s, "window_action")[-1]["hwnd"] == 11


def test_fenetre_absente_note_une_fois_puis_continue(tmp_path):
    s = Session(backend=OldBackend(nodes=DESKTOP()), report_dir=str(tmp_path), name="vm", settle=0, timeout=0.3)
    s.click(name="project_test", role="listitem", window="Program Manager", clicks=2)
    s.click(name="project_test", role="listitem", window="Program Manager", clicks=2)
    assert all(st["ok"] for st in s.report.steps), "un titre non listé n'est pas une panne"
    notes = [n["text"] for n in s.report.notes if "Program Manager" in n["text"]]
    assert len(notes) == 1 and "non listée" in notes[0]
    assert not _calls(s, "window_action")


def test_ancre_diese_ne_cherche_pas_de_fenetre(s):
    s.click(name="Console Python", role="checkbox", window="#QgisApp", rel=(0.5, 0.5))
    assert not _calls(s, "list_windows"), "« #auto_id » = ancre de rel, pas un titre à activer"


# ── 3. focus / require voient le bureau ──────────────────────────────────────

def test_focus_explicite_trouve_le_bureau(s):
    s.focus(window="Program Manager")
    assert s.report.steps[-1]["ok"] and _calls(s, "window_action")[-1]["hwnd"] == 1


def test_focus_explicite_echoue_sur_un_titre_inconnu(s):
    with pytest.raises(StepError):
        s.focus(window="Inexistante")


def test_require_fenetre_et_agent_ancien(tmp_path):
    s = Session(backend=OldBackend(nodes=DESKTOP()), report_dir=str(tmp_path), name="vm", settle=0, timeout=0.3)
    s.require(window="QGIS")
    assert s.report.steps[-1]["ok"]
    assert _calls(s, "window_action")[-1]["hwnd"] == 11


# ── 2. attentes patientes ─────────────────────────────────────────────────────

def test_activite_ecran_detectee_et_bruit_ignore():
    a, b = _activity(_png(20)), _activity(_png(200))
    assert a is not None and _moved(a, b)
    assert not _moved(a, a)
    assert _activity(b"pas un png") is None and not _moved(None, a)


class MovingBackend(WinBackend):
    """L'écran change à chaque capture pendant ``moving_s`` secondes (splash),
    puis l'élément attendu apparaît ``appears_at`` s après le début."""
    def __init__(self, nodes, moving_s, appears_at):
        super().__init__(nodes=nodes)
        self.t0 = time.monotonic()
        self.moving_s = moving_s
        self.appears_at = appears_at
        self.k = 0

    def screenshot(self, fmt=None, quality=None):
        self.k += 1
        el = time.monotonic() - self.t0
        gray = (self.k * 60) % 256 if el < self.moving_s else 128
        return _png(gray), 96, 54

    def ui_tree(self, max_nodes=300, scope="focus", fanout=80):
        self._log("ui_tree")
        if time.monotonic() - self.t0 >= self.appears_at:
            return list(self.nodes), 1920, 1080
        return [self.nodes[0]], 1920, 1080


def test_attente_prolongee_tant_que_l_ecran_bouge(tmp_path):
    # délai 0.4 s, mais l'écran bouge 1.2 s et l'élément arrive à 1.0 s : l'attente tient
    b = MovingBackend(DESKTOP(), moving_s=1.2, appears_at=1.0)
    s = Session(backend=b, report_dir=str(tmp_path), name="vm", settle=0, timeout=0.4, patience=5)
    assert s.wait.element(name="Console Python", role="checkbox")
    st = s.report.steps[-1]
    assert st["ok"] and st["ms"] >= 900 and "prolongée" in st.get("method", "")


def test_ecran_immobile_echoue_au_delai_nominal(tmp_path):
    b = MovingBackend(DESKTOP(), moving_s=0.0, appears_at=99)
    s = Session(backend=b, report_dir=str(tmp_path), name="vm", settle=0, timeout=0.4, patience=5)
    with s.step("attente", on_error="continue"):
        s.wait.element(name="Console Python", role="checkbox")
    st = s.report.steps[-1]
    assert not st["ok"] and st["ms"] < 1500 and "écran immobile" in st["error"]


def test_patience_plafonne_meme_si_ca_bouge(tmp_path):
    b = MovingBackend(DESKTOP(), moving_s=99, appears_at=99)
    s = Session(backend=b, report_dir=str(tmp_path), name="vm", settle=0, timeout=0.3, patience=1.0)
    with s.step("attente", on_error="continue"):
        s.wait.element(name="Console Python", role="checkbox")
    st = s.report.steps[-1]
    assert not st["ok"] and 900 <= st["ms"] < 2500 and "prolongé" in st["error"]


def test_action_attend_aussi_patiemment(tmp_path):
    b = MovingBackend(DESKTOP(), moving_s=1.2, appears_at=1.0)
    s = Session(backend=b, report_dir=str(tmp_path), name="vm", settle=0, timeout=0.4, patience=5)
    s.click(name="Console Python", role="checkbox")
    st = s.report.steps[-1]
    assert st["ok"] and st.get("waited_ms", 0) >= 900
    assert any("apparu après" in n["text"] for n in s.report.notes)


def test_wait_window_patient_par_tranches(tmp_path):
    class Late(WinBackend):
        def __init__(self, nodes):
            super().__init__(nodes=nodes); self.t0 = time.monotonic(); self.k = 0
        def screenshot(self, fmt=None, quality=None):
            self.k += 1; return _png((self.k * 60) % 256), 96, 54
        def wait_window(self, title_re="", auto_id="", class_name="", ready=True, timeout_ms=15000):
            self._log("wait_window", timeout_ms=timeout_ms)
            time.sleep(0.05)
            return {"found": time.monotonic() - self.t0 > 0.8}
    s = Session(backend=Late(DESKTOP()), report_dir=str(tmp_path), name="vm", settle=0, timeout=0.3, patience=5)
    assert s.wait.window("QGIS")
    calls = _calls(s, "wait_window")
    assert len(calls) >= 2 and all(c["timeout_ms"] <= 1500 for c in calls), "tranches courtes côté agent"


def test_patience_env_et_defaut(tmp_path, monkeypatch):
    assert Session(backend=WinBackend(nodes=DESKTOP()), report_dir=str(tmp_path), name="vm").patience == 120
    monkeypatch.setenv("ELPIS_PATIENCE", "7")
    assert Session(backend=WinBackend(nodes=DESKTOP()), report_dir=str(tmp_path), name="vm").patience == 7
