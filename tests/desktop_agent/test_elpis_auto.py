# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_elpis_auto.py — le runtime des scripts du Studio,
sur un backend FACTICE (le vrai est UIA/Windows, non exécutable ici).

Ce qui est verrouillé : l'ordre de ciblage (auto_id → nom → coordonnées), le
repli coordonnées quand le backend ne sait pas agir par pattern, les
vérifications qui ÉCHOUENT pour de bon (code 1) et non en silence, la
politique par bloc (retry / continue), le refus explicite d'un script « à
vision » sans Elpis, le rapport écrit.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

import pytest

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)

from elpis_auto import Session, CheckFailed, NeedsVision, StepError  # noqa: E402

PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


class NotSupported(Exception):
    """Même NOM que l'exception de l'agent : le runtime la reconnaît au nom."""


def _node(role, name, x, y, w, h, auto_id="", value=None, states=()):
    return {"role": role, "name": name, "auto_id": auto_id, "rect": [x, y, w, h],
            "value": value, "states": list(states), "patterns": [], "depth": 0}


class FakeBackend:
    def __init__(self, nodes=None, semantic=True):
        self.nodes = nodes if nodes is not None else [
            _node("button", "Sept", 800, 600, 40, 40, auto_id="num7Button"),
            _node("button", "Enregistrer", 100, 20, 120, 30),
            _node("edit", "Résultat", 500, 100, 200, 30, auto_id="CalculatorResults", value="7"),
            _node("checkbox", "Accepter", 10, 10, 20, 20, states=("checked",)),
        ]
        self.semantic = semantic
        self.calls = []
        self.clipboard = ""

    def _log(self, _fn, **kw):
        self.calls.append((_fn, kw))

    def set_monitor(self, index): self._log("set_monitor", index=index)
    def screenshot(self, fmt=None, quality=None): return PNG_1x1, 1, 1
    def ui_tree(self, max_nodes=300, scope="focus"): self._log("ui_tree"); return list(self.nodes), 1920, 1080
    def click(self, x, y, button="left", clicks=1, modifiers=""):
        self._log("click", x=x, y=y, button=button, clicks=clicks)
        if button == "left" and int(clicks or 1) == 1:
            self._flip("click:case", x, y)      # un clic sur une case la bascule
    def type_text(self, text): self._log("type_text", text=text)
    def key(self, keys):
        self._log("key", keys=keys)
        if keys == "ctrl+c" and self.selection:
            self.clipboard = self.selection
    def scroll(self, x, y, dy): self._log("scroll", x=x, y=y, dy=dy)
    def move(self, x, y): self._log("move", x=x, y=y)
    def drag(self, x1, y1, x2, y2, modifiers=""): self._log("drag", x1=x1, y1=y1, x2=x2, y2=y2)

    def element_action(self, **kw):
        if not self.semantic:
            raise NotSupported("pas de patterns ici")
        self._log("element_action", **kw)
        self._flip(kw.get("action", ""), kw.get("x"), kw.get("y"), kw.get("name", ""))
        return {"method": "pattern:" + kw.get("action", "")}

    toggles_work = True                 # False : Toggle « réussit » sans rien changer (Qt, élément d'arbre)

    def _flip(self, action, x=None, y=None, name=""):
        """check/uncheck/toggle (ou un clic sur une case) changent l'état du nœud visé."""
        if action not in ("check", "uncheck", "toggle", "click:case") or (action != "click:case" and not self.toggles_work):
            return
        for n in self.nodes:
            st = n.get("states") or []
            if "checked" not in st and "unchecked" not in st:
                continue
            rx, ry, rw, rh = n["rect"]
            hit = (x is not None and y is not None and rx <= x <= rx + rw and ry <= y <= ry + rh) or (name and n.get("name") == name and x is None)
            if not hit:
                continue
            on = {"check": True, "uncheck": False}.get(action, "checked" not in st)
            n["states"] = [v for v in st if v not in ("checked", "unchecked")] + ["checked" if on else "unchecked"]
            return

    def set_value(self, **kw):
        if not self.semantic:
            raise NotSupported("pas de ValuePattern")
        self._log("set_value", **kw)
        return {"method": "value"}

    def launch(self, target, args="", timeout_ms=15000):
        self._log("launch", target=target, args=args); return {"title": "Calculatrice", "method": "shell"}

    def wait_window(self, title_re="", auto_id="", class_name="", ready=True, timeout_ms=15000):
        self._log("wait_window", title_re=title_re); return {"found": "Calc" in title_re or title_re == "."}

    _wins = None
    def list_windows(self, max_items=60, include_desktop=False):
        if self._wins is None:
            self._wins = [{"hwnd": 11, "title": "Calculatrice"}, {"hwnd": 22, "title": "Bloc-notes - x.txt"}]
        return {"windows": list(self._wins)}

    def window_action(self, action="activate", hwnd=0):
        self._log("window_action", action=action, hwnd=hwnd)
        if action == "close" and self._wins is not None:   # ferme POUR DE VRAI (close/require(gone) le vérifient)
            self._wins = [w for w in self._wins if w["hwnd"] != hwnd]
        return {"method": "pywinauto"}

    selection = ""                      # ce que Ctrl+C « copie » (double de test)
    def clipboard_get(self): return self.clipboard
    def clipboard_set(self, text): self.clipboard = text; self._log("clipboard_set", text=text)
    def run_command(self, command="", shell="", cwd="", timeout_ms=120000, max_output=20000):
        self._log("run_command", command=command); return {"returncode": 0, "stdout": "ok", "stderr": ""}


@pytest.fixture
def s(tmp_path):
    # timeout COURT : une cible absente attend (auto-wait) jusqu'au timeout de la séance.
    return Session(backend=FakeBackend(), report_dir=str(tmp_path), name="essai", settle=0, timeout=0.3)


def _calls(s, name):
    return [kw for n, kw in s._backend.calls if n == name]


# ── ciblage ──────────────────────────────────────────────────────────────

def test_clic_par_auto_id_passe_par_le_pattern(s):
    s.click(auto_id="num7Button", name="Sept", role="button", at=(1, 1))
    ea = _calls(s, "element_action")
    assert ea and ea[0]["auto_id"] == "num7Button" and ea[0]["action"] == "click"
    assert not _calls(s, "click"), "aucun clic en coordonnées quand le pattern répond"
    assert s.report.steps[-1]["method"] == "pattern:click"


def test_sans_pattern_le_clic_retombe_sur_les_coordonnees_de_l_element(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.click(name="Enregistrer", at=(0, 0))          # ``at`` = repli, pas la vérité
    c = _calls(s, "click")
    assert c and (c[0]["x"], c[0]["y"]) == (160, 35), "centre de l'élément TROUVÉ, pas le repli"
    assert s.report.steps[-1]["method"] == "coords"


def test_cible_introuvable_retombe_sur_at_puis_echoue_sans_at(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.click(name="Inexistant", at=(5, 6))
    assert (_calls(s, "click")[0]["x"], _calls(s, "click")[0]["y"]) == (5, 6)
    with pytest.raises(StepError):
        s.click(name="Inexistant")
    assert s.report.failed_steps == 1 and s.finish() == 2


def test_le_nom_est_departage_par_le_role(s):
    n = s.find(__import__("elpis_auto").Target.of(name="Résultat", role="edit"))
    assert n and n["auto_id"] == "CalculatorResults"
    assert s.exists(name="sept") and not s.exists(name="Huit")   # sous-chaîne, casse ignorée


# ── lecture d'état ───────────────────────────────────────────────────────

def test_value_state_count(s):
    assert s.value(auto_id="CalculatorResults") == "7"
    assert s.state("checked", name="Accepter") is True
    assert s.count(role="button") == 2


# ── vérifications ────────────────────────────────────────────────────────

def test_expect_value_ok_puis_echec_explicite(s):
    assert s.expect.value(auto_id="CalculatorResults", contains="7", timeout=0.3)
    with pytest.raises(CheckFailed):
        s.expect.value(auto_id="CalculatorResults", equals="9", timeout=0.3)
    assert s.report.failed_checks == 1
    assert s.finish() == 1                          # vérification échouée = code 1, pas 0


def test_expect_value_negate_et_regex(s):
    assert s.expect.value(auto_id="CalculatorResults", equals="9", negate=True, timeout=0.3)
    assert s.expect.value(auto_id="CalculatorResults", regex=r"^\d$", timeout=0.3)


def test_wait_gone_expire_et_echoue(s):
    with pytest.raises(CheckFailed):
        s.wait.gone(name="Sept", timeout=0.3)
    assert s.report.steps[-1]["ok"] is False


def test_wait_stable_est_best_effort(s):
    assert s.wait.stable(timeout=2, quiet=0.1) is True
    assert s.report.steps[-1]["ok"] is True


def test_wait_appear_compare_au_dernier_snapshot(s):
    s.snapshot()
    s._backend.nodes.append(_node("window", "Nouvelle", 0, 0, 10, 10))
    assert s.wait.appear(timeout=0.5)


# ── politique par bloc ───────────────────────────────────────────────────

def test_step_continue_avale_l_echec(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with s.step("optionnel", on_error="continue"):
        s.click(name="Inexistant")                  # échoue → journalisé, avalé
    assert s.report.failed_steps == 1
    assert any("échec ignoré" in n["text"] for n in s.report.notes)


def test_retry_rejoue_l_action(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError):
        s.click(name="Inexistant", retry=2)         # 3 essais, chacun relit l'arbre (et attend)
    assert len(_calls(s, "ui_tree")) >= 3
    assert s.report.steps[-1]["attempts"] == 3
    assert sum(1 for n in s.report.notes if "nouvel essai" in n["text"]) == 2


def test_step_abort_propage(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError):
        with s.step("strict"):
            s.click(name="Inexistant")


# ── fenêtres, lancement, saisie ──────────────────────────────────────────

def test_focus_par_titre_regex(s):
    s.focus(window="bloc.notes")
    wa = _calls(s, "window_action")
    assert wa and wa[0] == {"action": "activate", "hwnd": 22}
    with pytest.raises(StepError):
        s.focus(window="Inexistante")


def test_launch_puis_attente_de_fenetre(s):
    s.launch("calc.exe", wait_window="Calculatrice")
    assert _calls(s, "launch")[0]["target"] == "calc.exe"
    import re
    title_re = _calls(s, "wait_window")[0]["title_re"]
    # pywinauto applique re.match : le motif doit reconnaître le titre n'importe où, casse ignorée
    assert re.compile(title_re).match("Calculatrice") and re.compile(title_re).match("calculatrice - Mode standard")


def test_set_value_pattern_puis_repli_saisie(tmp_path):
    s = Session(backend=FakeBackend(), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.set_value("12", auto_id="CalculatorResults")
    assert _calls(s, "set_value")[0]["text"] == "12"
    s2 = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s2.set_value("12", name="Résultat")
    assert [n for n, _ in s2._backend.calls if n != "ui_tree"] == ["click", "key", "type_text"]


def test_paste_et_copy_passent_par_le_presse_papiers(s):
    s.paste("héllo")
    assert _calls(s, "clipboard_set")[0]["text"] == "héllo"
    assert _calls(s, "key")[-1]["keys"] == "ctrl+v"
    s._backend.selection = "copié"
    assert s.copy() == "copié"
    assert _calls(s, "clipboard_set")[-1]["text"].startswith("\u200b"), "jeton posé AVANT Ctrl+C"
    # rien de sélectionné : le presse-papiers garde le jeton → copie VIDE, pas le jeton
    s._backend.selection = ""
    assert s.copy(timeout=0.3) == ""


# ── paramètres, vision, rapport ──────────────────────────────────────────

def test_params_ligne_de_commande_env_et_inconnu(monkeypatch):
    monkeypatch.setenv("ELPIS_PARAM_NUMERO", "env-42")
    assert Session.params({"numero": "", "mode": "a"}, argv=[]) == {"numero": "env-42", "mode": "a"}
    assert Session.params({"numero": ""}, argv=["--numero=7"])["numero"] == "7"
    with pytest.raises(SystemExit):
        Session.params({"numero": ""}, argv=["--inconnu=1"])


def test_script_a_vision_refuse_sans_elpis(tmp_path, monkeypatch):
    monkeypatch.delenv("ELPIS_URL", raising=False)
    with pytest.raises(NeedsVision):
        Session(backend=FakeBackend(), report_dir=str(tmp_path), needs=["vision"], name="ocr")
    rapports = list(Path(tmp_path).glob("ocr-*/rapport.json"))
    assert rapports and json.loads(rapports[0].read_text(encoding="utf-8"))["exit_code"] == 2


def test_finish_ecrit_le_rapport_json_et_html(s):
    s.click(auto_id="num7Button")
    s.note("une remarque")
    assert s.finish() == 0
    d = Path(s.report.dir)
    doc = json.loads((d / "rapport.json").read_text(encoding="utf-8"))
    assert doc["exit_code"] == 0 and doc["ok"] == 1 and doc["notes"][0]["text"] == "une remarque"
    assert "rapport.html" in os.listdir(d)


def test_echec_pose_une_capture(tmp_path):
    s = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError):
        s.click(name="Inexistant")
    shot = s.report.steps[-1].get("screenshot", "")
    assert shot and Path(shot).is_file() and Path(shot).read_bytes() == PNG_1x1


# ── chemins structurels (path=) ──────────────────────────────────────────
# Un contrôle SANS nom ni auto_id (le cas « group group » du Studio) se vise par
# son chemin depuis un ancêtre nommé : « role:Nom/role[n]/… ». Le runtime le
# résout dans l'arbre À PLAT (pré-ordre + depth) et agit sur le point COURANT.

def _tree_nodes():
    def n(role, name, depth, x, y, w, h, auto_id=""):
        d = _node(role, name, x, y, w, h, auto_id=auto_id); d["depth"] = depth; return d
    return [
        n("window", "winapptest", 0, 0, 0, 800, 600),
        n("group", "", 1, 10, 10, 400, 300),
        n("group", "", 2, 20, 20, 200, 100),          # (profondeur 2, sans nom)
        n("button", "", 3, 30, 30, 60, 30),           # LA cible : centre (60, 45)
        n("button", "OK", 2, 430, 20, 70, 30),
        n("group", "", 1, 420, 10, 360, 290),
        n("button", "OK", 3, 430, 120, 70, 30),       # trou de profondeur (2 absent)
        n("pane", "Second", 0, 0, 0, 100, 100, auto_id="panel2"),
        n("edit", "", 1, 5, 5, 50, 20),
    ]


def test_resolve_path_descend_par_role_et_rang():
    from elpis_auto.session import resolve_path
    nodes = _tree_nodes()
    assert resolve_path(nodes, "window:winapptest/group[1]/group[1]/button[1]") is nodes[3]
    assert resolve_path(nodes, "winapptest/group[2]") is nodes[5]
    assert resolve_path(nodes, "#panel2/edit[1]") is nodes[8]
    assert resolve_path(nodes, "window[1]") is nodes[0] and resolve_path(nodes, "pane[1]") is nodes[7]
    # trou de profondeur : le bouton à depth 3 sous un group à depth 1 est un enfant DIRECT
    assert resolve_path(nodes, "winapptest/group[2]/button[1]") is nodes[6]
    assert resolve_path(nodes, "winapptest/group[9]") is None
    assert resolve_path(nodes, "") is None


def test_clic_par_chemin_agit_au_centre_courant_de_l_element(tmp_path):
    s = Session(backend=FakeBackend(nodes=_tree_nodes()), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.click(path="window:winapptest/group[1]/group[1]/button[1]")
    ea = _calls(s, "element_action")
    assert ea and (ea[0]["x"], ea[0]["y"]) == (60, 45) and ea[0]["auto_id"] == "" and ea[0]["name"] == ""
    assert s.report.steps[-1]["target"] == "window:winapptest/group[1]/group[1]/button[1]"
    # sans pattern : clic en coordonnées au même point
    s2 = Session(backend=FakeBackend(nodes=_tree_nodes(), semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s2.click(path="winapptest/group[1]/group[1]/button[1]")
    c = _calls(s2, "click")
    assert c and (c[0]["x"], c[0]["y"]) == (60, 45)


def test_chemin_introuvable_echoue_ou_retombe_sur_at(tmp_path):
    s = Session(backend=FakeBackend(nodes=_tree_nodes()), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError):
        s.click(path="winapptest/group[7]/slider[1]")     # aucun slider sous la fenêtre, même relâché
    assert s.report.failed_steps == 1
    s2 = Session(backend=FakeBackend(nodes=_tree_nodes(), semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s2.click(path="winapptest/slider[7]", at=(3, 4))
    assert (_calls(s2, "click")[0]["x"], _calls(s2, "click")[0]["y"]) == (3, 4)
    # chemin exact cassé mais feuille présente sous l'ancre → résolu (relâché), pas d'échec
    s3 = Session(backend=FakeBackend(nodes=_tree_nodes()), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s3.click(path="winapptest/group[7]/button[1]")
    assert s3.report.steps[-1]["ok"] and (_calls(s3, "element_action")[-1]["x"], _calls(s3, "element_action")[-1]["y"]) == (60, 45)


def test_attentes_et_verifs_acceptent_un_chemin(tmp_path):
    s = Session(backend=FakeBackend(nodes=_tree_nodes()), report_dir=str(tmp_path), settle=0, timeout=0.2)
    assert s.exists(path="#panel2/edit[1]") and not s.exists(path="#panel2/edit[2]")
    assert s.wait.element(path="winapptest/group[2]/button[1]")
    assert s.expect.exists(path="winapptest/group[1]/button[1]")     # le « OK » enfant direct du 1er groupe
    assert s.expect.exists(path="winapptest/button[1]")              # pas d'enfant DIRECT bouton → relâché : 1er bouton descendant
    with pytest.raises(CheckFailed):
        s.expect.exists(path="winapptest/slider[1]", timeout=0.2)    # aucun slider nulle part sous la fenêtre


# ── ``python -m elpis_auto`` : un abandon écrit le rapport et sort proprement ──

def _write_script(tmp_path, body):
    # Le script crée sa Session sur un backend factice défini INLINE (le vrai
    # backend UIA n'existe pas ici) ; report_dir dans tmp_path.
    src = (
        "import sys, json\n"
        "sys.path.insert(0, %r)\n"
        "from test_elpis_auto import FakeBackend\n"
        "from elpis_auto import Session\n"
        "s = Session(backend=FakeBackend(semantic=False), report_dir=%r, name='abandon', settle=0, timeout=0.2)\n"
        % (str(Path(__file__).resolve().parent), str(tmp_path / "rapports"))
    ) + body
    p = tmp_path / "script.py"
    p.write_text(src, encoding="utf-8")
    return str(p)


def _rapports(tmp_path):
    return list((tmp_path / "rapports").rglob("rapport.json"))


def test_main_cible_introuvable_ecrit_le_rapport_et_sort_en_2(tmp_path, capsys):
    from elpis_auto.__main__ import main
    code = main([_write_script(tmp_path, "s.click(name='Inexistant')\nraise SystemExit(s.finish())\n")])
    assert code == 2
    reps = _rapports(tmp_path)
    assert len(reps) == 1, "rapport écrit malgré l'abandon"
    doc = json.loads(reps[0].read_text(encoding="utf-8"))
    assert doc["exit_code"] == 2 and doc["failed"] == 1 and doc["summary"].startswith("ABANDON")
    err = capsys.readouterr().err
    assert "ABANDON" in err and "Traceback" not in err, "une ligne lisible, pas une trace brute"


def test_main_verification_fausse_sort_en_1(tmp_path):
    from elpis_auto.__main__ import main
    code = main([_write_script(tmp_path, "s.expect.exists(name='Inexistant', timeout=0.2)\nraise SystemExit(s.finish())\n")])
    assert code == 1
    assert json.loads(_rapports(tmp_path)[0].read_text(encoding="utf-8"))["exit_code"] == 1


def test_main_plantage_python_note_et_rapport(tmp_path, capsys):
    from elpis_auto.__main__ import main
    code = main([_write_script(tmp_path, "s.note('avant')\nx = 1 / 0\n")])
    assert code == 2
    doc = json.loads(_rapports(tmp_path)[0].read_text(encoding="utf-8"))
    assert "ZeroDivisionError" in json.dumps(doc["notes"], ensure_ascii=False)


def test_main_script_qui_finit_normalement(tmp_path):
    from elpis_auto.__main__ import main
    assert main([_write_script(tmp_path, "s.click(auto_id='num7Button')\nraise SystemExit(s.finish())\n")]) == 0


def test_cible_nommee_joint_son_centre_courant_en_repli(s):
    # Sans ``at=``, l'agent reçoit quand même x,y (centre lu dans l'arbre) : sur
    # une machine où pywinauto est dégradé, il clique ce point au lieu d'échouer.
    s.click(name="Enregistrer", role="button")
    ea = _calls(s, "element_action")[-1]
    assert (ea["x"], ea["y"]) == (160, 35) and ea["name"] == "Enregistrer"
    s.click(name="Inexistant", at=(3, 4))
    ea = _calls(s, "element_action")[-1]
    assert (ea["x"], ea["y"]) == (3, 4), "``at`` explicite conservé"


# ── Fiabilité (retour VM) : attente implicite, réessai par défaut, chemin relâché ──

class LateBackend(FakeBackend):
    """L'élément n'apparaît qu'à la N-ième lecture de l'arbre (fenêtre qui s'ouvre)."""
    def __init__(self, appear_at=3, **kw):
        super().__init__(**kw)
        self.reads = 0
        self.appear_at = appear_at
        self.late = _node("button", "Tardif", 300, 300, 40, 20, auto_id="lateBtn")

    def ui_tree(self, max_nodes=300, scope="focus", fanout=80):
        self.reads += 1
        self._log("ui_tree", max_nodes=max_nodes, fanout=fanout)
        return list(self.nodes) + ([self.late] if self.reads >= self.appear_at else []), 1920, 1080


def test_une_action_attend_sa_cible_au_lieu_d_echouer(tmp_path):
    s = Session(backend=LateBackend(appear_at=3), report_dir=str(tmp_path), settle=0, timeout=5)
    s.click(name="Tardif")
    st = s.report.steps[-1]
    assert st["ok"] and st.get("waited_ms", 0) >= 300, "l'attente est journalisée"
    assert "attempts" not in st, "trouvé au premier essai (après attente), pas un réessai"
    ea = _calls(s, "element_action")[-1]
    # l'agent reçoit l'identité COURANTE du nœud trouvé (auto_id lu dans l'arbre,
    # même si le script ne visait que le nom) + son centre
    assert ea["auto_id"] == "lateBtn" and ea["name"] == "Tardif" and (ea["x"], ea["y"]) == (320, 310)
    ut = _calls(s, "ui_tree")[-1]
    assert ut["max_nodes"] >= 4000 and ut["fanout"] >= 200, "arbre lu LARGE (feuilles profondes)"


def test_avec_at_on_attend_puis_repli(tmp_path):
    # ``at`` est un REPLI, pas une dispense d'attente : une cible nommée absente
    # est attendue (délai de la séance), puis le point sert — étape « réparée ».
    b = LateBackend(appear_at=99, semantic=False)
    s = Session(backend=b, report_dir=str(tmp_path), settle=0, timeout=0.4)
    t0 = __import__("time").monotonic()
    s.click(name="Tardif", at=(7, 8))
    assert 0.35 <= __import__("time").monotonic() - t0 < 3.0, "attente du délai, puis repli"
    assert (_calls(s, "click")[0]["x"], _calls(s, "click")[0]["y"]) == (7, 8)
    st = s.report.steps[-1]
    assert st["ok"] and st["healed"]["by"] == "at" and st.get("waited_ms", 0) >= 350


def test_reessai_par_defaut_puis_reussite(tmp_path):
    class Flaky(FakeBackend):
        def __init__(self):
            super().__init__(semantic=False); self.n = 0
        def click(self, x, y, button="left", clicks=1, modifiers=""):
            self.n += 1
            if self.n == 1:
                raise RuntimeError("écran repeint")
            self._log("click", x=x, y=y, button=button, clicks=clicks)
    s = Session(backend=Flaky(), report_dir=str(tmp_path), settle=0, timeout=0.3)   # retry=1 par défaut
    s.click(auto_id="num7Button")
    st = s.report.steps[-1]
    assert st["ok"] and st["attempts"] == 2
    assert "error" not in st, "un essai raté ne laisse pas d'erreur sur l'étape finalement réussie"
    assert any("nouvel essai" in n["text"] for n in s.report.notes)
    s0 = Session(backend=Flaky(), report_dir=str(tmp_path), settle=0, timeout=0.3, retry=0)
    with pytest.raises(StepError):
        s0.click(auto_id="num7Button")


def test_chemin_relache_quand_un_conteneur_change():
    from elpis_auto.session import resolve_path
    nodes = _tree_nodes()
    # le chemin enregistré passe par un conteneur en plus (custom[1]) : strict = None,
    # relâché = 2e checkbox/button sous l'ancre, dans l'ordre de lecture
    P = "winapptest/group[1]/custom[1]/group[1]/button[2]"
    assert resolve_path(nodes, P, relaxed=False) is None
    assert resolve_path(nodes, P) is nodes[4], "2e bouton descendant de winapptest = « OK »"
    assert resolve_path(nodes, "winapptest/pane[9]/edit[1]") is None, "rôle absent sous l'ancre → None"


def test_ancre_auto_id_pointee_retombe_sur_le_suffixe():
    # Enregistré console DOCKÉE (#QgisApp.PythonConsole) ; à l'exécution elle FLOTTE
    # (fenêtre #PythonConsole) → l'ancre suit, la feuille se résout relâchée.
    from elpis_auto.session import resolve_path
    def n(role, name, depth, auto_id=""):
        d = _node(role, name, 0, 0, 10, 10, auto_id=auto_id); d["depth"] = depth; return d
    nodes = [n("window", "QGIS", 0, "QgisApp"), n("group", "", 1),
             n("window", "Console Python", 0, "PythonConsole"), n("toolbar", "", 1),
             n("checkbox", "Effacer", 2), n("checkbox", "Exécuter", 2)]
    P = "#QgisApp.PythonConsole/group[1]/custom[1]/toolbar[1]/checkbox[2]"
    assert resolve_path(nodes, P, relaxed=False) is None
    assert resolve_path(nodes, P) is nodes[5]
    assert resolve_path(nodes, "#Autre.Chose/checkbox[1]") is None
    # sens inverse : enregistré FLOTTANT (#PythonConsole), exécuté ANCRÉ (#QgisApp.PythonConsole)
    docked = [n("window", "QGIS", 0, "QgisApp"), n("window", "Console Python", 1, "QgisApp.PythonConsole"),
              n("toolbar", "", 2), n("checkbox", "Effacer", 3), n("checkbox", "Exécuter", 3)]
    assert resolve_path(docked, "#PythonConsole/toolbar[1]/checkbox[2]") is docked[4]


def test_check_ne_touche_pas_une_case_deja_cochee(tmp_path):
    b = FakeBackend()      # « Accepter » est checked
    s = Session(backend=b, report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.check(name="Accepter")
    assert s.report.steps[-1]["method"] == "already" and not _calls(s, "element_action")
    s.uncheck(name="Accepter")
    ea = _calls(s, "element_action")[-1]
    assert ea["action"] == "uncheck" and (ea["x"], ea["y"]) == (20, 20), "centre joint, une seule lecture"
    # sans pattern (pywinauto dégradé) : clic aux coordonnées du centre
    s2 = Session(backend=FakeBackend(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s2.uncheck(name="Accepter")
    c = _calls(s2, "click")[-1]
    assert (c["x"], c["y"]) == (20, 20) and s2.report.steps[-1]["method"] == "coords"
