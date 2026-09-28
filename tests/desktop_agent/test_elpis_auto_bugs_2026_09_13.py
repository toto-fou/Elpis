# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_elpis_auto_bugs_2026_09_13.py — chasse aux bugs du
13/09 (relecture + épreuve sur la VM) : ``window=`` borne la recherche, une
cible identifiée ATTEND toujours (rel/at = repli), mots-clés inconnus refusés,
``timeout=`` par action, valeur = nom / texte du document, ``close`` vérifie la
disparition, ``copy`` sonde le presse-papiers, ``wait.window`` sans pywinauto,
coche ASCII sur console sans UTF-8. Backend factice."""
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
from elpis_auto.session import Target, _value_of  # noqa: E402
from elpis_auto import report as _report  # noqa: E402
from test_elpis_auto import FakeBackend, _node, _calls  # noqa: E402


def n(role, name, depth, x, y, w, h, auto_id="", states=(), value=None):
    d = _node(role, name, x, y, w, h, auto_id=auto_id, states=states, value=value)
    d["depth"] = depth
    return d


def SCENE():
    return [
        n("window", "C:\\Windows\\cmd.exe", 0, 0, 0, 800, 500),
        n("document", "Text Area", 1, 10, 30, 780, 460, auto_id="Text Area"),
        n("button", "OK", 1, 700, 460, 80, 30),                       # un « OK » dans la console
        n("window", "Sans titre - Bloc-notes", 0, 300, 300, 900, 700),
        n("textbox", "Éditeur de texte", 1, 310, 340, 880, 600, auto_id="15"),
        n("button", "OK", 1, 1100, 950, 80, 30, auto_id="npOk"),
        n("window", "Options", 0, 500, 500, 400, 300),                 # dialogue À PART (top-level)
        n("treeitem", "Polices", 1, 520, 540, 100, 20),
        n("text", "Nom du fichier", 1, 520, 580, 90, 20),
        n("textbox", "", 1, 620, 580, 150, 22, auto_id="fileName"),    # champ sans nom à DROITE du libellé
    ]


class Backend(FakeBackend):
    def __init__(self, nodes=None):
        super().__init__(nodes=nodes if nodes is not None else SCENE())
        self.texts = {}
        self.closed = []
        self.wins = [{"hwnd": 5, "title": "Sans titre - Bloc-notes", "state": "normal", "is_foreground": True},
                     {"hwnd": 7, "title": "Calculatrice", "state": "normal", "is_foreground": False}]

    def list_windows(self, max_items=60, include_desktop=False):
        self._log("list_windows"); return {"windows": list(self.wins)}

    def window_action(self, action="activate", hwnd=0):
        self._log("window_action", action=action, hwnd=hwnd)
        if action == "close":
            self.closed.append(hwnd)
        return {"ok": True}

    def element_text(self, auto_id="", name="", control_type="", x=None, y=None):
        self._log("element_text", auto_id=auto_id)
        if auto_id in self.texts:
            return {"text": self.texts[auto_id], "method": "text"}
        raise RuntimeError("NotSupported")


@pytest.fixture
def s(tmp_path):
    return Session(backend=Backend(), report_dir=str(tmp_path), name="bugs", settle=0, timeout=0.3)


# ── window= borne la recherche ────────────────────────────────────────────────

def test_window_borne_la_recherche_puis_tout_l_ecran(s):
    assert s.find(Target.of(name="OK", role="button", window="Bloc-notes"))["auto_id"] == "npOk", "pas le OK de la console"
    assert s.find(Target.of(name="OK", role="button"))["auto_id"] == "", "sans fenêtre : le premier de l'écran"
    # un dialogue top-level n'est PAS sous la racine de l'appli : repli sur tout l'écran
    assert s.find(Target.of(name="Polices", role="treeitem", window="Bloc-notes"))["name"] == "Polices"


def test_role_seul_reste_dans_sa_fenetre(s):
    t = s.find(Target.of(role="textbox", window="Bloc-notes"))
    assert t["auto_id"] == "15" and s.resolved_by == "role"
    assert s.find(Target.of(role="document", window="Bloc-notes")) is None, "le document d'une console n'est pas « le document » du Bloc-notes"
    assert s.find(Target.of(role="document"))["auto_id"] == "Text Area", "sans fenêtre : le premier de ce rôle"
    assert Target.of(role="textbox", window="Bloc-notes").label() == "(textbox) dans /Bloc-notes/"


def test_near_accepte_les_textbox(s):
    # un textbox SANS nom est un voisin valide d'un libellé (formulaire Qt/Win32)
    assert s.find(Target.of(near="Nom du fichier", role="textbox", side="right"))["auto_id"] == "fileName"


# ── mots-clés inconnus, timeout par action ───────────────────────────────────

def test_mot_cle_inconnu_refuse(s):
    with pytest.raises(TypeError, match="paramètre inconnu : nam"):
        s.click(nam="OK")
    with pytest.raises(TypeError, match="roll"):
        s.wait.element(name="OK", roll="button")


def test_timeout_par_action(s):
    # cible STRUCTURELLE absente → vrai échec (le faux backend ne peut pas la simuler)
    t0 = time.monotonic()
    with s.step("x", on_error="continue"):
        s.click(path="#Absent/button[1]", timeout=0.9)
    assert 0.85 <= time.monotonic() - t0 < 4.0
    st = s.report.steps[-1]
    assert not st["ok"] and st["waited_ms"] >= 850


# ── valeur : nom, puis texte du document ────────────────────────────────────

def test_valeur_retombe_sur_le_nom():
    assert _value_of({"name": "L’affichage est 15", "value": None}) == "L’affichage est 15"
    assert _value_of({"name": "x", "value": "7"}) == "7"
    assert _value_of({"name": "x", "value": ""}) == "x"


def test_texte_d_un_document_lu_a_l_agent(s):
    s._backend.texts["15"] = "Bonjour la VM"
    assert s.value(role="textbox", window="Bloc-notes") == "Bonjour la VM"
    assert s.expect.value(role="textbox", window="Bloc-notes", contains="Bonjour")
    assert s.value(name="Text Area") == "Text Area", "sans texte ni valeur : le nom"


# ── close / require(gone) vérifient la disparition ──────────────────────────

def test_close_attend_la_disparition(s):
    b = s._backend

    def _close(action="activate", hwnd=0):
        b._log("window_action", action=action, hwnd=hwnd)
        if action == "close":
            b.wins = [w for w in b.wins if w["hwnd"] != hwnd]
        return {}
    b.window_action = _close
    s.close(window="Calculatrice")
    assert s.report.steps[-1]["ok"] and all(w["hwnd"] != 7 for w in b.wins)
    s.require(gone="Bloc-notes")
    assert s.report.steps[-1]["ok"] and s.report.steps[-1]["method"] == "close"


def test_close_retenue_par_une_boite_echoue(s):
    with pytest.raises(StepError, match="toujours ouverte"):
        s.close(window="Bloc-notes", timeout=0.4)
    assert 5 in s._backend.closed, "la croix a bien été envoyée"


# ── wait.window sans pywinauto, regex tolérante ─────────────────────────────

def test_wait_window_agent_sans_pywinauto(s):
    def _ww(**kw):
        raise ImportError("DLL load failed while importing win32ui")
    s._backend.wait_window = _ww
    assert s.wait.window("Bloc-notes")
    assert s.report.steps[-1]["ok"]


# ── console sans UTF-8 : coche ASCII ────────────────────────────────────────

def test_coche_ascii_si_la_console_ne_sait_pas(monkeypatch):
    class Stream:
        def __init__(self, enc): self.encoding = enc
        def write(self, s): pass
        def flush(self): pass
    monkeypatch.setattr(sys, "stderr", Stream("cp1252"))
    assert _report._mark("✓", "OK") == "OK" and _report._mark("→", "->") == "->"
    monkeypatch.setattr(sys, "stderr", Stream("utf-8"))
    assert _report._mark("✓", "OK") == "✓"
    monkeypatch.setattr(sys, "stderr", Stream(None))   # encoding inconnu → utf-8 supposé
    assert _report._mark("✓", "OK") == "✓"
