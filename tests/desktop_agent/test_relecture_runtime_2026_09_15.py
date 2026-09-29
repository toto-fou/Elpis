# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_relecture_runtime_2026_09_15.py — relecture du runtime
``elpis_auto`` (15/09) : geste partiel jamais rejoué, cible absente sans double
attente, lancement sans double délai, ``window`` + ``rel`` sur l'arbre COURANT,
bloc « continue » qui ne masque plus les erreurs du script, code de sortie, résumé
du vol à blanc, titres vides / drapeaux en ligne / fermeture littérale, image +
rôle, case à 3 états, échantillonnage de l'activité, cible visuelle, vision espacée.
Backend FACTICE (celui de test_elpis_auto)."""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
import types
from pathlib import Path

import pytest

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)
_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from elpis_auto import (  # noqa: E402
    Session,
    StepError,
    TargetNotFound,
    session as S,  # noqa: E402
)
from test_elpis_auto import FakeBackend, NotSupported, _calls, _node  # noqa: E402


class PartialInput(NotSupported):
    """Même NOM que l'exception de l'agent (backends.base.PartialInput)."""


def _sess(tmp_path, backend=None, **kw):
    kw.setdefault("timeout", 0.3)
    return Session(backend=backend or FakeBackend(), report_dir=str(tmp_path), name="relecture", settle=0, **kw)


# ── R1 : geste partiel ─────────────────────────────────────────────────────

def test_geste_partiel_jamais_rejoue_meme_avec_retry(tmp_path):
    class B(FakeBackend):
        def click(self, x, y, button="left", clicks=1, modifiers=""):
            self._log("click", x=x, y=y, clicks=clicks)
            raise PartialInput("clic partiel (1/2)")
    s = _sess(tmp_path, B())
    with pytest.raises(StepError):
        s.click(at=(5, 5), clicks=2, modifiers="ctrl", retry=2)
    assert len(_calls(s, "click")) == 1, "un double-clic partiel rejoué devenait un triple clic"
    assert s.report.steps[-1].get("attempts") == 1


def test_geste_partiel_de_l_agent_jamais_converti_en_clic_au_point(tmp_path):
    class B(FakeBackend):
        def element_action(self, **kw):
            self._log("element_action", **kw)
            raise PartialInput("clic partiel (1/2)")
    s = _sess(tmp_path, B())
    with pytest.raises(StepError):
        s.double_click(auto_id="num7Button")
    assert not _calls(s, "click") and len(_calls(s, "element_action")) == 1


def test_resultat_incertain_de_l_agent_note(tmp_path):
    class B(FakeBackend):
        def element_action(self, **kw):
            self._log("element_action", **kw)
            return {"method": "invoke", "uncertain": True, "error": "UIA_E_TIMEOUT"}
    s = _sess(tmp_path, B())
    s.click(auto_id="num7Button")
    assert s.report.steps[-1]["ok"] and any("incertain" in n["text"] for n in s.report.notes)


# ── R2 : action hors clic sur une cible absente ────────────────────────────

def test_expand_cible_absente_une_seule_attente(tmp_path):
    s = _sess(tmp_path, FakeBackend(semantic=False), timeout=0.4)
    t0 = time.monotonic()
    with pytest.raises(TargetNotFound):
        s.expand(name="Absent", role="treeitem")
    rec = s.report.steps[-1]
    assert rec.get("attempts") == 1 and rec["error"].startswith("TargetNotFound"), rec
    assert time.monotonic() - t0 < 1.2, "le réessai implicite relançait toute l'attente"


def test_expand_sans_pattern_sur_cible_trouvee_reste_une_erreur_d_etape(tmp_path):
    s = _sess(tmp_path, FakeBackend(semantic=False))
    with pytest.raises(StepError) as ei:
        s.expand(name="Sept", role="button")
    assert not isinstance(ei.value, TargetNotFound) and not _calls(s, "click")


# ── R3 : lancement + wait_window ───────────────────────────────────────────

class LaunchBackend(FakeBackend):
    def launch(self, target, args="", timeout_ms=15000):
        self._log("launch", target=target, timeout_ms=timeout_ms)
        return {"title": "Calculatrice", "method": "shell"}


def test_launch_avec_wait_window_ne_fait_pas_attendre_le_lancement_tout_le_delai(tmp_path):
    s = _sess(tmp_path, LaunchBackend())
    s.launch("calc.exe", wait_window="Calculatrice", timeout=30)
    assert _calls(s, "launch")[0]["timeout_ms"] == 5000
    assert _calls(s, "wait_window"), "l'attente nommée prend le relais"
    s2 = _sess(tmp_path, LaunchBackend())
    s2.launch("calc.exe", timeout=3)
    assert _calls(s2, "launch")[0]["timeout_ms"] == 3000, "sans wait_window : le lancement attend lui-même"
    s3 = _sess(tmp_path, LaunchBackend())
    s3.launch("calc.exe", wait_window="Calculatrice", timeout=2)
    assert _calls(s3, "launch")[0]["timeout_ms"] == 2000


# ── R4 : window + rel sur l'arbre courant ──────────────────────────────────

def test_window_rel_relit_l_arbre_et_attend_la_fenetre(tmp_path):
    b = FakeBackend(nodes=[_node("button", "Ouvrir", 10, 10, 50, 20)])
    s = _sess(tmp_path, b, timeout=2.0)
    s.click(name="Ouvrir")                                  # l'arbre lu n'a pas « Liste »
    t0 = time.monotonic()

    class Opener:
        def __init__(self):
            self.done = False
    op = Opener()
    real_tree = b.ui_tree

    def later(max_nodes=300, scope="focus"):
        if not op.done and time.monotonic() - t0 > 0.5:
            b.nodes.append(_node("window", "Liste", 100, 200, 400, 400))
            op.done = True
        return real_tree(max_nodes=max_nodes, scope=scope)
    b.ui_tree = later
    s.scroll(-3, window="Liste", rel=(0.5, 0.25))
    sc = _calls(s, "scroll")[-1]
    assert (sc["x"], sc["y"]) == (300, 300), sc
    assert s.report.steps[-1].get("waited_ms", 0) >= 400


def test_window_rel_fenetre_deplacee_point_courant(tmp_path):
    b = FakeBackend(nodes=[_node("window", "Liste", 0, 0, 100, 100)])
    s = _sess(tmp_path, b)
    s.scroll(-1, window="Liste", rel=(0.5, 0.5))
    b.nodes[0] = _node("window", "Liste", 500, 500, 100, 100)   # la fenêtre a bougé (nouvel arbre, nouveaux nœuds)
    s.scroll(-1, window="Liste", rel=(0.5, 0.5))
    assert [(c["x"], c["y"]) for c in _calls(s, "scroll")] == [(50, 50), (550, 550)]


# ── R6 : bloc « continue » ─────────────────────────────────────────────────

def test_step_continue_ne_masque_pas_une_faute_du_script(tmp_path):
    s = _sess(tmp_path)
    with pytest.raises(TypeError):
        with s.step("optionnel", on_error="continue"):
            s.click(nam="OK")
    with pytest.raises(TypeError):
        with s.step("optionnel", on_error="continue"):
            s.wait.seconds("abc")
    with s.step("optionnel", on_error="continue"):         # un échec d'étape reste avalé
        s.wait.element(name="Absent", timeout=0.1)
    assert s.report.failed_checks == 1


# ── R7 : code de sortie ────────────────────────────────────────────────────

def _run_script(tmp_path, body):
    script = tmp_path / "flux.py"
    script.write_text(textwrap.dedent("""
        import sys
        sys.path.insert(0, %r)
        from test_elpis_auto import FakeBackend
        from elpis_auto import Session
        class B(FakeBackend):
            def click(self, **kw):
                raise RuntimeError("clic refusé")
        s = Session(backend=B(), report_dir=%r, name="flux", settle=0, timeout=0.1)
    """ % (_HERE, str(tmp_path / "rapports"))) + textwrap.dedent(body), encoding="utf-8")
    env = dict(os.environ, PYTHONPATH=_AGENT + os.pathsep + _HERE)
    return subprocess.run([sys.executable, "-m", "elpis_auto", str(script)], cwd=str(tmp_path), env=env,
                          capture_output=True, text=True, timeout=60)


def test_code_de_sortie_script_sans_pied_et_verif_apres_echec_continue(tmp_path):
    r = _run_script(tmp_path, """
        with s.step("x", on_error="continue"):
            s.click(at=(1, 1))
    """)
    assert r.returncode == 2, r.stderr                       # pas de pied : l'échec compte quand même
    r = _run_script(tmp_path, """
        with s.step("x", on_error="continue"):
            s.click(at=(1, 1))
        s.expect.exists(name="Absent", timeout=0.1)
    """)
    assert r.returncode == 2, r.stderr                       # l'erreur d'exécution prime sur la vérif (1)


# ── R8 : résumé du vol à blanc ─────────────────────────────────────────────

def test_vol_a_blanc_ne_compte_que_les_cibles(tmp_path):
    s = _sess(tmp_path, dry_run=True)
    s.key("ctrl+s")
    s.wait.window("Absente")
    s.wait.seconds(1)
    s.click(name="Sept")
    s.click(name="Nulle part")
    s.finish()
    assert s.report.summary().startswith("VOL À BLANC — 1 cible(s) trouvée(s), 1 introuvable(s)"), s.report.summary()


# ── R9 : titres ────────────────────────────────────────────────────────────

def test_titre_vide_refuse(tmp_path):
    s = _sess(tmp_path)
    for fn in (lambda: s.focus(), lambda: s.close(), lambda: s.wait.window(""), lambda: s.focus(window="  ")):
        with pytest.raises(StepError):
            fn()
    assert not _calls(s, "window_action")
    assert S._first_title_match([{"title": "Calculatrice"}], "") is None


def test_drapeaux_en_ligne_dans_un_titre():
    assert S._title_rx("(?i)calc").search("Calculatrice")
    rx = S._pywinauto_title_re("(?i)calc")
    import re
    assert re.match(rx, "Calculatrice") and re.match(rx, "x - CALC")
    assert re.match(S._pywinauto_title_re("Document (1).txt"), "Document (1).txt - Bloc-notes")


def test_fermer_litteral_ne_ferme_pas_une_autre_fenetre(tmp_path):
    class B(FakeBackend):
        _wins = None
        def list_windows(self, max_items=60, include_desktop=False):
            if self._wins is None:
                self._wins = [{"hwnd": 5, "title": "Document 1.txt - Bloc-notes"}, {"hwnd": 11, "title": "Calculatrice"}]
            return {"windows": list(self._wins)}
    s = _sess(tmp_path, B())
    with pytest.raises(StepError):
        s.close(window="Document (1).txt")
    assert not [c for c in _calls(s, "window_action") if c["action"] == "close"]
    s.require(gone="Document (1).txt")                       # absente : rien à fermer
    assert not [c for c in _calls(s, "window_action") if c["action"] == "close"]
    s.close(window="Calc.*")                                  # une vraie regex reste permise
    assert [c["hwnd"] for c in _calls(s, "window_action") if c["action"] == "close"] == [11]


# ── R10 : image + rôle ─────────────────────────────────────────────────────

def test_image_avec_role_ne_prend_pas_le_premier_bouton(tmp_path):
    s = _sess(tmp_path)
    assert s.find(S.Target.of(image="assets/ok.png", role="button")) is None
    assert s.find(S.Target.of(role="button")) is not None


# ── case à 3 états ─────────────────────────────────────────────────────────

class TriBackend(FakeBackend):
    """Toggle muet ; un clic sur la case avance coché → indéterminé → décoché → coché."""
    toggles_work = False

    def click(self, x, y, button="left", clicks=1, modifiers=""):
        self._log("click", x=x, y=y)
        n = self.nodes[0]
        cyc = {"checked": "indeterminate", "indeterminate": "unchecked", "unchecked": "checked"}
        cur = next(v for v in n["states"] if v in cyc)
        n["states"] = [cyc[cur]]


def test_uncheck_case_indeterminee_verifie_l_etat(tmp_path):
    b = TriBackend(nodes=[_node("checkbox", "Tout", 10, 10, 20, 20, states=("indeterminate",))])
    s = _sess(tmp_path, b)
    out = s.uncheck(name="Tout")
    assert out["method"] == "clic:case" and b.nodes[0]["states"] == ["unchecked"]


def test_uncheck_case_3_etats_cochee_deux_clics(tmp_path):
    b = TriBackend(nodes=[_node("checkbox", "Tout", 10, 10, 20, 20, states=("checked",))])
    s = _sess(tmp_path, b)
    s.uncheck(name="Tout")
    assert b.nodes[0]["states"] == ["unchecked"] and len(_calls(s, "click")) == 2


def test_case_2_etats_un_seul_clic_de_repli(tmp_path):
    class Stuck(FakeBackend):
        toggles_work = False
        def click(self, x, y, button="left", clicks=1, modifiers=""):
            self._log("click", x=x, y=y)                    # clic sans effet
    b = Stuck(nodes=[_node("checkbox", "Accepter", 10, 10, 20, 20, states=("checked",))])
    s = _sess(tmp_path, b)
    with pytest.raises(StepError):
        s.uncheck(name="Accepter", retry=0)
    assert len(_calls(s, "click")) == 1


# ── O1 : échantillonnage de l'activité ─────────────────────────────────────

def test_patience_echantillonne_au_plus_une_capture_par_seconde(tmp_path, monkeypatch):
    class Cap(FakeBackend):
        def screenshot(self, fmt=None, quality=None):
            self._log("screenshot", fmt=fmt, quality=quality)
            return super().screenshot()
    s = _sess(tmp_path, Cap())
    clock = {"t": 1000.0}
    monkeypatch.setattr(S, "time", types.SimpleNamespace(monotonic=lambda: clock["t"], sleep=time.sleep))
    pat = S._Patience(s, 30.0, 120.0)
    for _ in range(20):                                       # 20 sondages à 0,3 s = 6 s
        pat.expired()
        clock["t"] += 0.3
    shots = _calls(s, "screenshot")
    assert 5 <= len(shots) <= 7, len(shots)
    assert all(c["fmt"] == "jpeg" for c in shots), "capture d'activité bon marché"
    short = S._Patience(s, 0.4, 5.0)
    assert short.every == pytest.approx(0.1), "délai court : échantillons plus serrés"


# ── O3 / O4 : cibles visuelles ─────────────────────────────────────────────

def test_cible_image_part_directement_au_point(tmp_path, monkeypatch):
    from elpis_auto import visual
    monkeypatch.setattr(visual, "locate_template", lambda png, path: {"rect": (10, 10, 20, 20), "score": 0.99})
    s = _sess(tmp_path)
    s.click(image="assets/ok.png")
    ea = _calls(s, "element_action")[-1]
    assert ea["auto_id"] == "" and ea["name"] == "" and ea["control_type"] == "" and (ea["x"], ea["y"]) == (20, 20)


def test_describe_sonde_espacee_et_borne_par_le_delai(tmp_path, monkeypatch):
    from elpis_auto import visual
    seen = []

    def fake(png, describe, timeout=30.0):
        seen.append(timeout)
        return None
    monkeypatch.setattr(visual, "locate_describe", fake)
    s = _sess(tmp_path, timeout=2.5)
    with pytest.raises(TargetNotFound):
        s.click(describe="le bouton vert")
    assert 1 <= len(seen) <= 3, seen
    assert all(t <= 30.0 for t in seen) and min(seen) <= 2.5
