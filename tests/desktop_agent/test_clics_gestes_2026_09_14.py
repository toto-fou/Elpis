# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_clics_gestes_2026_09_14.py — retour du Studio du
14/09 : « les clics (simple, double…) ne marchent pas à 100 % » et « je ne peux
pas saisir la durée d'attente ».

Côté agent (backend Windows, objets factices) : un DOUBLE / TRIPLE clic, un clic
DROIT ou MILIEU sont des GESTES — jamais un Toggle / Select / Invoke à leur place
(un double-clic sur un item de liste devenait un simple Select, un clic droit sur
un bouton une invocation). Un clic simple gauche garde les patterns.

Côté runtime : toute cible identifiable est résolue dans l'arbre AVEC attente
même si ``at=`` est fourni ; l'agent reçoit l'identité COURANTE du nœud (auto_id,
nom complet, rôle) ; le délai par défaut de la séance est 30 s (celui que le
Studio écrit) ; ``timeout=`` est honoré partout.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)

from backends import windows as W  # noqa: E402
from elpis_auto import Session  # noqa: E402
from test_elpis_auto import FakeBackend, _node, _calls  # noqa: E402


# ── agent : gestes vs patterns ───────────────────────────────────────────────
class Ctrl:
    """Contrôle pywinauto factice : SelectionItem + Invoke + Toggle exposés, tout journalisé."""
    def __init__(self, rect=(100, 200, 140, 220)):
        self.calls = []
        self._r = rect
        me = self

        class _Sel:
            def Select(self): me.calls.append("Select")

        class _Tog:
            CurrentToggleState = 0
            def Toggle(self): me.calls.append("Toggle")

        self.iface_selection_item = _Sel()
        self.iface_toggle = _Tog()

    def invoke(self): self.calls.append("Invoke")
    def click_input(self, button="left", double=False): self.calls.append(("click_input", button, double))
    def rectangle(self):
        class R: pass
        r = R(); r.left, r.top, r.right, r.bottom = self._r
        return r


def _be(monkeypatch, ctrl, origin=(0, 0)):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: ctrl)
    monkeypatch.setattr(be, "monitor_origin", lambda: origin)
    monkeypatch.setattr(W, "_retry_schedule", lambda *a, **k: [0.0])
    clicks = []
    monkeypatch.setattr(be, "click", lambda x, y, button="left", clicks_=1, **k: clicks.append((x, y, button, k.get("clicks", clicks_))))
    return be, clicks


def test_double_clic_est_un_geste_pas_un_select(monkeypatch):
    c = Ctrl()
    be, clicks = _be(monkeypatch, c)
    r = be.element_action(action="click", name="project_test", control_type="listitem", clicks=2)
    assert r["method"] == "click_input" and r["clicks"] == 2
    assert c.calls == [], "aucun Select/Toggle/Invoke, et pas le click_input de pywinauto (écran principal)"
    assert clicks == [(120, 210, "left", 2)], "double-clic RÉEL au centre COURANT du contrôle re-résolu"
    # /invoke (Studio en direct) : action double_click, même geste
    clicks.clear()
    be.element_action(action="double_click", name="project_test", control_type="listitem")
    assert clicks == [(120, 210, "left", 2)] and c.calls == []


def test_clic_droit_et_milieu_sont_des_gestes(monkeypatch):
    c = Ctrl()
    be, clicks = _be(monkeypatch, c)
    r = be.element_action(action="click", name="OK", control_type="button", button="right")
    assert r["method"] == "click_input" and r["button"] == "right"
    assert c.calls == [] and clicks == [(120, 210, "right", 1)], "jamais Toggle/Select/Invoke pour un clic droit"
    clicks.clear()
    be.element_action(action="click", name="OK", control_type="button", button="middle")
    assert c.calls == [] and clicks == [(120, 210, "middle", 1)]


def test_clic_simple_gauche_garde_les_patterns(monkeypatch):
    c = Ctrl()
    be, _ = _be(monkeypatch, c)
    # Toggle d'abord (case / bouton bascule), comme avant
    assert be.element_action(action="click", name="Console Python", control_type="checkbox")["method"] == "toggle"
    assert c.calls == ["Toggle"]


def test_triple_clic_sendinput_au_centre_courant(monkeypatch):
    c = Ctrl(rect=(1000, 500, 1100, 540))       # écran réel ; écran capturé décalé de (800, 0)
    be, clicks = _be(monkeypatch, c, origin=(800, 0))
    r = be.element_action(action="click", name="Titre", control_type="text", x=1, y=1, clicks=3)
    assert r["method"] == "click_input" and r["clicks"] == 3
    assert clicks == [(250, 520, "left", 3)], "centre COURANT du contrôle, en coordonnées de l'écran capturé"
    assert c.calls == [], "ni pattern ni click_input (pywinauto ne sait pas le triple)"


def test_geste_sans_controle_retombe_aux_coordonnees(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: None)
    monkeypatch.setattr(W, "_retry_schedule", lambda *a, **k: [0.0])
    monkeypatch.setattr(W, "_uia_element_action", lambda **kw: (_ for _ in ()).throw(AssertionError("comtypes ne joue pas un geste")))
    seen = []
    monkeypatch.setattr(be, "click", lambda x, y, button="left", clicks=1: seen.append((x, y, button, clicks)))
    assert be.element_action(action="click", name="X", button="right", x=7, y=8)["method"] == "coords"
    assert be.element_action(action="click", name="X", x=7, y=8, clicks=2)["method"] == "coords"
    assert seen == [(7, 8, "right", 1), (7, 8, "left", 2)]
    with pytest.raises(W.NotSupported):
        be.element_action(action="click", name="X", button="right")   # ni contrôle ni point


# ── runtime : attente + identité courante ────────────────────────────────────
class LateBackend(FakeBackend):
    """« Enregistrer (Ctrl+S) » n'apparaît qu'à la 3e lecture (dialogue qui s'ouvre)."""
    def __init__(self, **kw):
        super().__init__(nodes=[_node("window", "App", 0, 0, 800, 600, auto_id="MainWin")], **kw)
        self.reads = 0
        self.late = _node("button", "Enregistrer (Ctrl+S)", 300, 300, 40, 20, auto_id="saveBtn")

    def ui_tree(self, max_nodes=300, scope="focus", fanout=80):
        self.reads += 1
        self._log("ui_tree")
        return list(self.nodes) + ([self.late] if self.reads >= 3 else []), 1920, 1080


def test_cible_nommee_avec_at_attend_quand_meme_et_agit_au_centre_trouve(tmp_path):
    s = Session(backend=LateBackend(), report_dir=str(tmp_path), settle=0, timeout=5)
    s.click(name="Enregistrer", role="button", at=(1, 1))
    st = s.report.steps[-1]
    assert st["ok"] and st.get("waited_ms", 0) >= 300, "attendue, pas cliquée aveuglément au point d'enregistrement"
    ea = _calls(s, "element_action")[-1]
    assert (ea["x"], ea["y"]) == (320, 310), "centre COURANT, pas ``at``"
    assert ea["auto_id"] == "saveBtn" and ea["name"] == "Enregistrer (Ctrl+S)" and ea["control_type"] == "button", \
        "identité COURANTE (nom complet) : la re-résolution exacte de l'agent réussit"
    assert "healed" not in st or st["healed"]["by"] != "at"


def test_double_clic_et_clic_droit_du_runtime_portent_le_geste(tmp_path):
    s = Session(backend=FakeBackend(), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.click(name="Enregistrer", clicks=2)
    s.click(name="Enregistrer", button="right")
    ea = _calls(s, "element_action")
    assert ea[-2]["clicks"] == 2 and ea[-2]["button"] == "left" and ea[-2]["control_type"] == "button"
    assert ea[-1]["button"] == "right" and ea[-1]["clicks"] == 1
    assert s.report.steps[-2]["label"].startswith("double-clic") and "clic right" in s.report.steps[-1]["label"]


def test_check_une_seule_lecture_d_arbre(tmp_path):
    b = FakeBackend()          # « Accepter » est checked
    s = Session(backend=b, report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.uncheck(name="Accepter")
    assert len(_calls(s, "ui_tree")) == 2, "une lecture pour agir (nœud transmis), une pour VÉRIFIER l'état"
    ea = _calls(s, "element_action")[-1]
    assert ea["action"] == "uncheck" and (ea["x"], ea["y"]) == (20, 20) and ea["control_type"] == "checkbox"


def test_delai_par_defaut_30s_et_timeout_honore(tmp_path):
    s = Session(backend=FakeBackend(), report_dir=str(tmp_path), name="d")
    assert s.default_timeout == 30.0
    s2 = Session(backend=FakeBackend(), report_dir=str(tmp_path), name="d2", settle=0, timeout=0.3, patience=1)
    t0 = time.monotonic()
    with s2.step("x", on_error="continue"):
        s2.wait.element(name="Inexistant", timeout=0.8)
    assert 0.75 <= time.monotonic() - t0 < 3.0, "timeout= de la ligne, pas celui de la séance"
    assert "délai dépassé" in s2.report.steps[-1]["error"]


# ── relecture du 14/09 : rôle contraignant, délai non doublé, attente robuste ──
from elpis_auto import StepError, TargetNotFound  # noqa: E402


def test_role_demande_est_une_contrainte(tmp_path):
    nodes = [_node("button", "Enregistrer", 10, 10, 80, 20),
             _node("text", "Enregistrer sous…", 10, 40, 80, 20)]
    s = Session(backend=FakeBackend(nodes=nodes), report_dir=str(tmp_path), settle=0, timeout=0.3)
    assert not s.exists(name="Enregistrer", role="window"), "le bouton ne satisfait pas une attente de FENÊTRE"
    assert s.exists(name="Enregistrer", role="button")
    assert s.exists(name="sous", role="text") and not s.exists(name="sous", role="button")
    assert s.exists(name="Enregistrer"), "sans rôle : tout rôle"


def test_introuvable_sans_retry_explicite_n_attend_qu_une_fois(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.6, patience=0.6)
    assert s.default_retry == 1
    t0 = time.monotonic()
    with pytest.raises(TargetNotFound):
        s.click(name="Inexistant")
    dt = time.monotonic() - t0
    assert 0.55 <= dt < 1.1, f"une seule attente de 0.6 s, pas deux ({dt:.2f} s)"
    st = s.report.steps[-1]
    assert not st["ok"] and st["attempts"] == 1
    assert not any("nouvel essai" in n["text"] for n in s.report.notes)
    assert isinstance(TargetNotFound("x"), StepError), "compatible avec les scripts qui attrapent StepError"


def test_wait_window_continue_malgre_un_hoquet_com(tmp_path):
    class ComError(Exception):
        pass

    class Busy(FakeBackend):
        def __init__(self):
            super().__init__(); self.k = 0
        def wait_window(self, title_re="", auto_id="", class_name="", ready=True, timeout_ms=15000):
            self.k += 1
            if self.k <= 2:
                raise ComError("RPC_E_CALL_REJECTED : appli occupée")
            return {"found": True}
    s = Session(backend=Busy(), report_dir=str(tmp_path), settle=0, timeout=5)
    assert s.wait.window("QGIS")
    assert s.report.steps[-1]["ok"] and s._backend.k == 3


def test_set_value_de_secours_efface_avant_de_taper(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    seen = []

    class Field:
        def set_focus(self): seen.append("focus")
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: Field())
    monkeypatch.setattr(be, "key", lambda k: seen.append(("key", k)))
    monkeypatch.setattr(be, "type_text", lambda t: seen.append(("type", t)))
    assert be.set_value(name="Quantité", text="12") == {"method": "type"}
    assert seen == ["focus", ("key", "ctrl+a"), ("type", "12")]

    class NoFocus:
        def set_focus(self): raise RuntimeError("fenêtre en arrière-plan")
    seen.clear()
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: NoFocus())
    with pytest.raises(Exception, match="focus impossible"):
        be.set_value(name="Quantité", text="12")
    assert seen == [], "rien tapé à l'aveugle"


def test_point_de_l_arbre_traduit_pour_uia(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    monkeypatch.setattr(be, "_find_ctrl", lambda **kw: None)
    monkeypatch.setattr(be, "monitor_origin", lambda: (1920, 0))
    got = {}
    monkeypatch.setattr(W, "_uia_element_action", lambda **kw: got.update(kw) or {"method": "invoke", "via": "uia"})
    be.element_action(action="click", name="OK", control_type="button", x=100, y=50)
    assert (got["x"], got["y"]) == (2020, 50), "écran capturé → écran absolu"


def test_pause_fixe_journalisee_et_sautee_a_blanc(tmp_path):
    s = Session(backend=FakeBackend(), report_dir=str(tmp_path), settle=0, timeout=0.3)
    t0 = time.monotonic()
    assert s.wait.seconds(0.4)
    assert 0.38 <= time.monotonic() - t0 < 1.5
    st = s.report.steps[-1]
    assert st["ok"] and st["label"] == "pause 0.4 s" and st["ms"] >= 380
    with pytest.raises(TypeError):
        s.wait.seconds("abc")
    with pytest.raises(TypeError):
        s.wait.seconds(-1)
    d = Session(backend=FakeBackend(), report_dir=str(tmp_path), settle=0, dry_run=True)
    t0 = time.monotonic()
    assert d.wait.seconds(30)
    assert time.monotonic() - t0 < 0.5 and d.report.steps[-1]["dry"]


# ── relecture front/serveur du 14/09 ─────────────────────────────────────────
def test_clic_sur_item_cochable_selectionne_au_lieu_de_basculer(monkeypatch):
    c = Ctrl()                                   # expose Toggle ET SelectionItem
    be, _ = _be(monkeypatch, c)
    assert be.element_action(action="click", name="Couche A", control_type="treeitem")["method"] == "select"
    assert c.calls == ["Select"], "couche QGIS : un clic la choisit, il ne la masque pas"
    c.calls.clear()
    assert be.element_action(action="click", name="Accepter", control_type="checkbox")["method"] == "toggle"
    assert c.calls == ["Toggle"]
    # comtypes : même règle
    t, s_ = W_Pat(0), W_Pat()
    assert W._uia_action(W_Mod, W_El(50007, {W._UIA_PATTERN_IDS["toggle"]: t, W._UIA_PATTERN_IDS["selection_item"]: s_}), "click") == {"method": "select"}
    assert s_.calls == ["Select"] and t.calls == []


from test_uia_comtypes_fallback_2026_09_13 import Pat as W_Pat, Mod as W_Mod, El as W_El  # noqa: E402


def test_auto_id_partage_departage_par_le_nom(tmp_path):
    nodes = [_node("edit", "a.qgz", 10, 10, 80, 20, auto_id="System.ItemNameDisplay"),
             _node("edit", "projet.qgz", 10, 40, 80, 20, auto_id="System.ItemNameDisplay"),
             _node("edit", "z.qgz", 10, 70, 80, 20, auto_id="System.ItemNameDisplay")]
    s = Session(backend=FakeBackend(nodes=nodes), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.click(auto_id="System.ItemNameDisplay", name="projet.qgz", role="edit", clicks=2)
    ea = _calls(s, "element_action")[-1]
    assert (ea["x"], ea["y"]) == (50, 50), "le fichier NOMMÉ, pas le premier de l'auto_id"
    assert ea["auto_id"] == "" and ea["name"] == "projet.qgz", "auto_id partagé non transmis : l'agent départage par nom + point"
    assert s.report.steps[-1]["resolved_by"] == "auto_id"


def test_titres_de_fenetre_litteraux_et_regex(tmp_path):
    from elpis_auto.session import find_window, _pywinauto_title_re
    import re
    nodes = [_node("window", "Document (1).txt - Bloc-notes", 0, 0, 800, 600),
             _node("window", "Calculatrice", 0, 0, 300, 400)]
    assert find_window(nodes, "Document (1).txt - Bloc-notes") is nodes[0], "parenthèses = texte"
    assert find_window(nodes, "bloc-notes") is nodes[0]
    assert find_window(nodes, "Calc.*") is nodes[1], "une vraie regex reste une regex"
    rx = re.compile(_pywinauto_title_re("Bloc-notes"))            # pywinauto : re.match
    assert rx.match("Sans titre - Bloc-notes"), "n'importe où dans le titre, pas seulement au début"
    assert not rx.match("Calculatrice")
    b = FakeBackend(nodes=nodes)
    seen = []
    b.wait_window = lambda title_re="", **kw: seen.append(title_re) or {"found": True}
    s = Session(backend=b, report_dir=str(tmp_path), settle=0, timeout=1)
    assert s.wait.window("Document (1).txt")
    assert re.compile(seen[0]).match("Document (1).txt - Bloc-notes")


def test_suggestion_de_reparation_sur_une_ligne():
    from elpis_auto.session import identity_kwargs
    assert identity_kwargs({"name": "Ligne 1\nLigne 2", "role": "text"}) == 'name="Ligne 1\\nLigne 2", role="text"'


# ── relecture runtime du 14/09 ───────────────────────────────────────────────
def test_fenetre_pas_encore_ouverte_pas_de_nom_partiel_ailleurs(tmp_path):
    class Dialog(FakeBackend):
        def __init__(self):
            super().__init__(nodes=[_node("window", "QGIS", 0, 0, 1600, 1200),
                                    _node("button", "Enregistrer le projet", 10, 10, 30, 30)])
            self.reads = 0
        def ui_tree(self, max_nodes=300, scope="focus", fanout=80):
            self.reads += 1
            extra = []
            if self.reads >= 3:
                w = _node("window", "Enregistrer sous", 400, 300, 600, 400); w["depth"] = 0
                b = _node("button", "Enregistrer", 900, 650, 80, 30); b["depth"] = 1
                extra = [w, b]
            return list(self.nodes) + extra, 1920, 1080
    s = Session(backend=Dialog(), report_dir=str(tmp_path), settle=0, timeout=5)
    s.click(name="Enregistrer", role="button", window="Enregistrer sous", rel=(0.9, 0.9))
    ea = _calls(s, "element_action")[-1]
    assert (ea["x"], ea["y"]) == (940, 665), "le bouton du DIALOGUE, attendu — pas « Enregistrer le projet »"
    assert s.report.steps[-1].get("waited_ms", 0) > 0


def test_role_seul_jamais_hors_de_sa_fenetre(tmp_path):
    nodes = [_node("window", "Console", 0, 0, 800, 600), _node("document", "Text Area", 10, 10, 700, 500)]
    nodes[1]["depth"] = 1
    s = Session(backend=FakeBackend(nodes=nodes), report_dir=str(tmp_path), settle=0, timeout=0.3)
    assert not s.exists(role="document", window="Bloc-notes"), "le document de la console n'est pas celui du Bloc-notes"


def test_vol_a_blanc_ne_propage_pas_une_reparation(tmp_path):
    nodes = [_node("button", "OK", 10, 10, 40, 20), _node("button", "Annuler", 60, 10, 40, 20, auto_id="cancelBtn")]
    s = Session(backend=FakeBackend(nodes=nodes), report_dir=str(tmp_path), settle=0, timeout=0.3, dry_run=True)
    s.click(auto_id="perdu", name="OK", role="button")      # réparé : nom
    s.click(auto_id="cancelBtn", name="Annuler", role="button")
    assert s.report.steps[0].get("healed") and not s.report.steps[1].get("healed"), s.report.steps[1]


def test_check_absent_une_seule_attente(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.5, patience=0.5)
    t0 = time.monotonic()
    s.check(name="Inexistante", role="checkbox", at=(3, 4))
    assert time.monotonic() - t0 < 1.0, "une attente, pas deux"
    assert (_calls(s, "click")[-1]["x"], _calls(s, "click")[-1]["y"]) == (3, 4)


def test_require_ne_relance_pas_l_application_et_transmet_le_delai(tmp_path):
    class W(FakeBackend):
        def list_windows(self, max_items=60, include_desktop=False):
            return {"windows": []}
    s = Session(backend=W(), report_dir=str(tmp_path), settle=0, timeout=0.3, patience=0.3)
    with pytest.raises(StepError):
        s.require(window="QGIS", launch="qgis.exe")
    assert len(_calls(s, "launch")) == 1, "pas de 2e instance"
    s2 = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.2, patience=0.2)
    t0 = time.monotonic()
    s2.require(checked=True, name="Absente", at=(1, 1), timeout=0.8)
    assert time.monotonic() - t0 >= 0.75, "timeout= de require transmis à check"


def test_retry_zero_ecrit_desactive_le_reessai(tmp_path):
    class Flaky(FakeBackend):
        def type_text(self, text):
            self._log("type_text", text=text); raise RuntimeError("occupé")
    s = Session(backend=Flaky(), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError):
        s.type("x", retry=0)
    assert len(_calls(s, "type_text")) == 1
    with pytest.raises(StepError):
        s.type("y")
    assert len(_calls(s, "type_text")) == 3, "sans retry= : réessai de la séance"


def test_scroll_cible_absente_echoue_et_rel_compte(tmp_path):
    nodes = [_node("window", "Liste", 100, 100, 400, 400)]
    s = Session(backend=FakeBackend(nodes=nodes), report_dir=str(tmp_path), settle=0, timeout=0.3, patience=0.3)
    s.scroll(-3, window="Liste", rel=(0.5, 0.25))
    sc = _calls(s, "scroll")[-1]
    assert (sc["x"], sc["y"]) == (300, 200), "window + rel = point"
    with pytest.raises(TargetNotFound):
        s.scroll(-3, name="Inexistante")
    assert len(_calls(s, "scroll")) == 1, "pas de molette au centre de l'écran"


def test_set_value_resout_dans_l_arbre_et_passe_le_point(tmp_path):
    nodes = [_node("window", "Options", 0, 0, 400, 300), _node("edit", "Nom", 50, 50, 100, 20),
             _node("window", "Principale", 500, 0, 400, 300), _node("edit", "Nom", 550, 50, 100, 20)]
    nodes[1]["depth"] = nodes[3]["depth"] = 1
    s = Session(backend=FakeBackend(nodes=nodes), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.set_value("abc", name="Nom", role="edit", window="Principale")
    sv = _calls(s, "set_value")[-1]
    assert (sv["x"], sv["y"]) == (600, 60) and sv["name"] == "Nom" and sv["control_type"] == "edit"


def test_repli_clic_reserve_aux_gestes_de_clic(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError, match="scroll_into_view impossible"):
        s.scroll_into_view(name="Enregistrer")
    assert not _calls(s, "click"), "pas de clic qui ouvrirait l'élément"
    s.select(name="Enregistrer")
    assert _calls(s, "click"), "select : un clic sélectionne"


def test_premiere_lecture_protegee(tmp_path):
    class Hiccup(FakeBackend):
        def __init__(self):
            super().__init__(semantic=False); self.k = 0
        def ui_tree(self, max_nodes=300, scope="focus", fanout=80):
            self.k += 1
            if self.k == 1:
                raise RuntimeError("COM occupé")
            return list(self.nodes), 1920, 1080
    s = Session(backend=Hiccup(), report_dir=str(tmp_path), settle=0, timeout=2)
    s.click(name="Enregistrer")
    assert s.report.steps[-1]["ok"] and (_calls(s, "click")[-1]["x"], _calls(s, "click")[-1]["y"]) == (160, 35)


def test_regex_invalide_refusee_et_action_classee_en_erreur(tmp_path):
    s = Session(backend=FakeBackend(), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(TypeError, match="regex invalide"):
        s.expect.value(name="Résultat", regex="(")
    s2 = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.2, patience=0.2)
    with s2.step("x", on_error="continue"):
        s2.set_value("1", name="compte introuvable")
    assert s2.report.failed_steps == 1 and s2.report.failed_checks == 0, "une ACTION ratée = code 2, quel que soit son libellé"


def test_identite_proposee_resoluble():
    from elpis_auto.session import node_identity, resolve_path
    nodes = [_node("window", "App", 0, 0, 800, 600, auto_id="view_12"),
             _node("pane", "Panneau", 0, 0, 800, 600), _node("button", "", 10, 10, 20, 20)]
    nodes[0]["depth"], nodes[1]["depth"], nodes[2]["depth"] = 0, 1, 2
    ident = node_identity(nodes, nodes[2])
    assert "view_12" not in ident["path"] and resolve_path(nodes, ident["path"]) is nodes[2], ident
    nodes2 = [dict(nodes[0], auto_id=""), dict(nodes[1], role=""), nodes[2]]
    ident2 = node_identity(nodes2, nodes2[2])
    assert not ident2["path"].startswith(":") and resolve_path(nodes2, ident2["path"]) is nodes2[2], ident2


def test_monitor_zero_est_transmis(tmp_path):
    s = Session(backend=FakeBackend(), report_dir=str(tmp_path), monitor=0, settle=0)
    assert _calls(s, "set_monitor") == [{"index": 0}], "0 = tous les écrans (Studio)"
    s2 = Session(backend=FakeBackend(), report_dir=str(tmp_path), settle=0)
    assert not _calls(s2, "set_monitor"), "sans monitor= : écran par défaut du backend"


def test_image_float64_score_exact_partout():
    np = pytest.importorskip("numpy")
    from PIL import Image
    import io as _io
    from elpis_auto import visual
    rng = np.random.default_rng(0)
    screen = (rng.random((1080, 1920)) * 6 + 120).astype("uint8")
    tpl = screen[900:940, 1700:1760].copy()
    buf = _io.BytesIO(); Image.fromarray(screen).save(buf, format="PNG")
    import tempfile, os
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "t.png"); Image.fromarray(tpl).save(p)
        hit = visual.locate_template(buf.getvalue(), p)
    assert hit is not None and hit["rect"][:2] == (1700, 900) and hit["score"] > 0.97, hit


# ── relecture agent Windows du 14/09 ─────────────────────────────────────────
class _Fn:
    def __init__(self, log, name, ret=1):
        self.log, self.name, self.ret = log, name, ret
        self.argtypes = None; self.restype = None
    def __call__(self, *a):
        self.log.append((self.name,) + tuple(a))
        return self.ret(*a) if callable(self.ret) else self.ret


class _Dll:
    def __init__(self, log, rets=None):
        self._log, self._rets = log, rets or {}
    def __getattr__(self, name):
        f = _Fn(self._log, name, self._rets.get(name, 1))
        setattr(self, name, f)
        return f


def _fake_windll(monkeypatch, user_rets=None, kernel_rets=None):
    import ctypes
    log = []
    wd = type("WinDLL", (), {})()
    wd.user32 = _Dll(log, user_rets); wd.kernel32 = _Dll(log, kernel_rets)
    monkeypatch.setattr(ctypes, "windll", wd, raising=False)
    return log


def test_activer_une_fenetre_agrandie_ne_la_restaure_pas(monkeypatch):
    fg = {"h": 0}
    def set_fg(h):
        fg["h"] = int(h); return 1
    log = _fake_windll(monkeypatch, user_rets={"IsIconic": 0, "GetForegroundWindow": lambda: fg["h"],
                                               "SetForegroundWindow": set_fg, "GetWindowThreadProcessId": 0,
                                               "IsHungAppWindow": 0},
                       kernel_rets={"GetCurrentThreadId": 1})
    assert W._win32_force_foreground(42) is True
    shows = [c for c in log if c[0] in ("ShowWindow", "ShowWindowAsync")]
    assert shows == [("ShowWindowAsync", 42, 5)], f"SW_SHOW, jamais SW_RESTORE sur une fenêtre non réduite : {shows}"
    log.clear(); fg["h"] = 0
    monkeypatch.setattr(__import__("ctypes").windll.user32, "IsIconic", _Fn(log, "IsIconic", 1))
    W._win32_force_foreground(42)
    assert ("ShowWindowAsync", 42, 9) in log, "réduite : SW_RESTORE"


def test_wait_input_idle_appelle_user32(monkeypatch):
    log = _fake_windll(monkeypatch, user_rets={"GetWindowThreadProcessId": 1}, kernel_rets={"OpenProcess": 99})
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    import ctypes
    class FakeDW:                     # wintypes.DWORD() dont .value est non nul
        def __init__(self, v=0): self.value = 1234
    from ctypes import wintypes
    monkeypatch.setattr(wintypes, "DWORD", FakeDW)
    monkeypatch.setattr(ctypes, "byref", lambda x: x)
    be._wait_input_idle(7, 5000)
    names = [c[0] for c in log]
    assert "WaitForInputIdle" in names and names.index("WaitForInputIdle") > names.index("OpenProcess")
    assert "WaitForInputIdle" in vars(ctypes.windll.user32), "WaitForInputIdle vit dans user32"
    assert "WaitForInputIdle" not in vars(ctypes.windll.kernel32), "kernel32 ne l'exporte pas (AttributeError avalée)"
    assert "CloseHandle" in names


def test_role_vers_controltype_uia():
    assert W._role_ct_id("button") == 50000 and W._role_ct_id("Button") == 50000
    assert W._role_ct_id("textbox") == 50004 and W._role_ct_id("menu item") == 50011
    assert W._role_ct_id("radio") == 50013 and W._role_ct_id("") is None and W._role_ct_id("inconnu") is None


def test_uia_find_prefere_l_element_sous_le_point_toutes_portees(monkeypatch):
    from test_uia_comtypes_fallback_2026_09_13 import El, Mod, Found

    class Scope:
        def __init__(self, els): self.els = els
        def FindAll(self, scope, cond): return Found(self.els)

    class Auto:
        def __init__(self, fg, root): self.fg, self.root = fg, root
        def CreatePropertyCondition(self, pid, val): return (pid, val)
        def CreateAndCondition(self, a, b): return ("and", a, b)
        def ElementFromHandle(self, h): return self.fg
        def GetRootElement(self): return self.root
    ok_front = El(50000, {}, rect=(0, 0, 50, 20), name="OK")
    ok_dialog = El(50000, {}, rect=(900, 600, 50, 20), name="OK")
    auto = Auto(Scope([ok_front]), Scope([ok_front, ok_dialog]))
    monkeypatch.setattr(W, "_is_shell_window", lambda h: False)
    _fake_windll(monkeypatch, user_rets={"GetForegroundWindow": 5})
    assert W._uia_find(auto, Mod, name="OK", control_type="button", x=910, y=605) is ok_dialog, \
        "l'homonyme du premier plan ne vole pas le clic du dialogue"
    assert W._uia_find(auto, Mod, name="OK", control_type="button") is ok_front


def test_menuitem_pas_de_pattern_au_clic_et_tab_est_une_touche():
    class Ctl:
        class element_info:
            control_type = "MenuItem"
            class element:
                @staticmethod
                def SetFocus(): raise AssertionError("pas de focus forcé sur un menu")
    assert W._pattern_action(Ctl(), "click") is None
    d = W._text_key_descriptors("a\tb")
    assert d[2]["vk"] == 0x09 and d[2]["flags"] == 0 and d[3]["flags"] == W.KEYEVENTF_KEYUP


def test_find_ctrl_ignore_l_homonyme_qui_ne_contient_pas_le_point(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    monkeypatch.setattr(be, "monitor_origin", lambda: (0, 0))

    class Rect:
        left, top, right, bottom = 0, 0, 50, 20

    class Wrapper:
        def rectangle(self): return Rect()

    class Spec:
        def __init__(self, kw): self.kw = kw
        def exists(self, timeout=None): return True
        def wrapper_object(self): return Wrapper()

    seen = []

    class Dlg:
        def child_window(self, **kw):
            seen.append(kw); return Spec(kw)
    monkeypatch.setattr(be, "_foreground_dialog", lambda: Dlg())
    assert be._find_ctrl(name="OK", control_type="button", x=900, y=600) is None, "hors du point : homonyme ignoré"
    assert isinstance(be._find_ctrl(name="OK", control_type="button", x=10, y=10), Wrapper)
    assert seen[0]["control_type"] == 50000 and seen[0]["visible_only"] is False


def test_clic_sendinput_survol_puis_appuis_et_modificateurs_relaches(monkeypatch):
    be = W.WindowsBackend.__new__(W.WindowsBackend)
    be._use_sendinput = True
    monkeypatch.setattr(be, "monitor_origin", lambda: (0, 0))
    monkeypatch.setattr(W, "_virtual_screen", lambda: (0, 0, 1920, 1080))
    monkeypatch.setattr(W.time, "sleep", lambda s: batches.append(("sleep", s)))
    batches = []
    monkeypatch.setattr(W, "_sendinput", lambda d: batches.append([x.get("flags") for x in d]) or len(d))
    be.click(100, 100, button="left", clicks=2, modifiers="ctrl")
    kinds = [b if isinstance(b, tuple) else len(b) for b in batches]
    assert kinds == [2, ("sleep", W._CLICK_HOVER_S), 2, ("sleep", W._CLICK_GAP_S), 2, 1], kinds
    assert batches[-1] == [W.KEYEVENTF_KEYUP], "Ctrl relâché en dernier"
    # SendInput refusé en cours de geste : erreur, pas de rejeu pyautogui (clics en trop)
    n = {"k": 0}
    def flaky(d):
        n["k"] += 1
        return len(d) if n["k"] <= 2 else 0
    monkeypatch.setattr(W, "_sendinput", flaky)
    monkeypatch.setattr(be, "_need", lambda: (_ for _ in ()).throw(AssertionError("pas de repli pyautogui")))
    with pytest.raises(Exception, match="clic partiel"):
        be.click(100, 100, clicks=2)


def test_touches_etendues_et_note_de_lancement(tmp_path):
    d = W._named_key_descriptors("shift+right")
    assert [x["vk"] for x in d] == [0x10, 0x27, 0x27, 0x10]
    assert d[0]["flags"] == 0, "Maj n'est pas une touche étendue"
    assert d[1]["flags"] == W.KEYEVENTF_EXTENDEDKEY and d[2]["flags"] == W.KEYEVENTF_KEYUP | W.KEYEVENTF_EXTENDEDKEY
    assert W._named_key_descriptors("ctrl+s")[1]["flags"] == 0
    assert W._named_key_descriptors("delete")[0]["flags"] == W.KEYEVENTF_EXTENDEDKEY

    class NoWin(FakeBackend):
        def launch(self, target, args="", timeout_ms=15000):
            self._log("launch", target=target); return {"launched": target, "found": False, "hint": "splash ?"}
    s = Session(backend=NoWin(), report_dir=str(tmp_path), settle=0, timeout=1)
    s.launch("qgis.exe")
    assert s.report.steps[-1]["ok"] and any("aucune fenêtre prête" in n["text"] for n in s.report.notes)


def test_element_d_arbre_sans_selection_vrai_clic():
    """VM 15/09, QGIS 3.44 : la couche (treeitem) expose Toggle sans SelectionItem ; Toggle y
    est muet. Le clic simple doit partir en VRAI clic (None → coordonnées)."""
    t = W_Pat(1)
    assert W._uia_action(W_Mod, W_El(50024, {W._UIA_PATTERN_IDS["toggle"]: t}), "click") is None
    assert t.calls == [], "pas de Toggle muet à la place du clic"
    assert W._uia_action(W_Mod, W_El(50002, {W._UIA_PATTERN_IDS["toggle"]: t}), "click") == {"method": "toggle"}, "une case reste basculée"
    s_ = W_Pat()
    assert W._uia_action(W_Mod, W_El(50024, {W._UIA_PATTERN_IDS["selection_item"]: s_}), "click") == {"method": "select"}

    class TreeItem:
        class element_info:
            control_type = "TreeItem"
            class element:
                @staticmethod
                def SetFocus(): pass
        iface_selection_item = None
        class iface_toggle:
            @staticmethod
            def Toggle(): raise AssertionError("pas de Toggle")
    assert W._pattern_action(TreeItem(), "click") is None



def test_uncheck_bascule_muette_vrai_clic_sur_la_case_puis_echec_honnete(tmp_path):
    """VM 15/09, QGIS : Toggle « réussit » sans changer la couche. Le runtime vérifie
    l'état, clique la CASE (bord gauche de l'élément d'arbre), et échoue s'il ne change pas."""
    b = FakeBackend(nodes=[_node("treeitem", "OpenStreetMap", 21, 663, 259, 18, states=("checked",))])
    b.toggles_work = False
    s = Session(backend=b, report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.uncheck(name="OpenStreetMap", role="treeitem")
    st = s.report.steps[-1]
    assert st["ok"] and st["method"] == "clic:case", st
    c = _calls(s, "click")[-1]
    assert (c["x"], c["y"]) == (30, 672), "case au bord gauche de la ligne, pas le centre du libellé"
    assert "unchecked" in b.nodes[0]["states"]

    class Dead(FakeBackend):
        toggles_work = False
        def click(self, x, y, button="left", clicks=1, modifiers=""):
            self._log("click", x=x, y=y)             # clic sans effet non plus
    d = Dead(nodes=[_node("checkbox", "Rendu", 1418, 1138, 53, 17, states=("checked",))])
    s2 = Session(backend=d, report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError, match="sans effet"):
        s2.uncheck(name="Rendu", role="checkbox")



def test_titre_espace_insecable_du_bloc_notes():
    """VM 15/09 : le Bloc-notes titre « a\xa0- Bloc-notes » (espace insécable)."""
    import re
    from elpis_auto.session import _pywinauto_title_re, _first_title_match
    rx = re.compile(_pywinauto_title_re("a - Bloc-notes"))
    assert rx.match("a\xa0- Bloc-notes") and rx.match("Sans titre - a - Bloc-notes")
    assert _first_title_match([{"title": "a\xa0- Bloc-notes"}], "a - Bloc-notes") is not None
    assert re.compile(_pywinauto_title_re("Document (1)")).match("Document (1)\xa0- Bloc-notes")


def test_premier_plan_sans_alt_si_deja_devant_puis_souris_avant_alt(monkeypatch):
    """VM 15/09 : l'ALT synthétique activait la barre de menus de la fenêtre déjà devant
    et la touche suivante était avalée (« xyz » → « yz »)."""
    fg = {"h": 42}
    log = _fake_windll(monkeypatch, user_rets={"IsIconic": 0, "GetForegroundWindow": lambda: fg["h"],
                                               "GetAncestor": lambda h, f: h, "GetWindowThreadProcessId": 0,
                                               "IsHungAppWindow": 0},
                       kernel_rets={"GetCurrentThreadId": 1})
    sent = []
    monkeypatch.setattr(W, "_sendinput", lambda d: sent.append(d) or len(d))
    assert W._win32_force_foreground(42) is True
    assert not [c for c in log if c[0] == "keybd_event"] and not sent, "déjà devant : aucune entrée synthétique"
    # pas devant, SetForegroundWindow refusé une fois : mouvement de souris nul AVANT tout ALT
    fg["h"] = 7
    calls = {"n": 0}
    def set_fg(h):
        calls["n"] += 1
        if calls["n"] >= 2:
            fg["h"] = int(h)
        return 1
    monkeypatch.setattr(__import__("ctypes").windll.user32, "SetForegroundWindow", _Fn(log, "SetForegroundWindow", set_fg))
    log.clear()
    assert W._win32_force_foreground(42) is True
    assert sent and sent[-1][0]["flags"] == W.MOUSEEVENTF_MOVE and not [c for c in log if c[0] == "keybd_event"]


def test_focus_fenetre_deja_devant_ne_fait_rien(tmp_path):
    from test_elpis_auto_vm_2026_09_13 import WinBackend, DESKTOP
    b = WinBackend(nodes=DESKTOP(), foreground="project_test — QGIS")
    s = Session(backend=b, report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.focus(window="QGIS")
    assert s.report.steps[-1]["method"] == "already" and not _calls(s, "window_action")
    s.focus(window="rapports")
    assert _calls(s, "window_action")
