# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_elpis_auto_phase_a.py — phase A des « 14 points » :
pile d'identités auto-réparante (1), ancres relationnelles (2), repli visuel
local (3), coordonnées relatives (4), préconditions (5), vol à blanc (6), trace
(7), stabilité (8), données (12). Backend FACTICE, tout en local.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import pytest

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)

from elpis_auto import Session, Target, StepError  # noqa: E402
from elpis_auto.session import find_near, find_window, node_identity, identity_kwargs  # noqa: E402
from test_elpis_auto import FakeBackend, _node, _calls, PNG_1x1  # noqa: E402


def n(role, name, depth, x, y, w, h, auto_id="", states=()):
    d = _node(role, name, x, y, w, h, auto_id=auto_id, states=states)
    d["depth"] = depth
    return d


def FORM():
    return [
        n("window", "Réglages", 0, 0, 0, 800, 600, auto_id="SettingsWin"),
        n("text", "Nom :", 1, 20, 40, 80, 20),
        n("edit", "", 1, 120, 40, 200, 24),                  # champ sans nom à DROITE du libellé
        n("text", "Console Python", 1, 20, 100, 120, 20),
        n("checkbox", "", 1, 160, 100, 20, 20, states=("unchecked",)),
        n("checkbox", "", 1, 20, 220, 20, 20, states=("checked",)),   # en dessous du libellé, plus loin
        n("button", "OK", 1, 600, 540, 80, 30, auto_id="okBtn"),
        n("button", "OK", 1, 700, 540, 80, 30),
    ]


@pytest.fixture
def s(tmp_path):
    return Session(backend=FakeBackend(nodes=FORM()), report_dir=str(tmp_path), name="phaseA", settle=0, timeout=0.3)


# ── 2. ancres relationnelles ────────────────────────────────────────────────

def test_near_trouve_le_controle_a_cote_du_libelle():
    nodes = FORM()
    e = find_near(nodes, "Nom", role="edit", side="right")
    assert e is nodes[2]
    cb = find_near(nodes, "Console Python", role="checkbox")
    assert cb is nodes[4], "le plus proche, tous côtés"
    below = find_near(nodes, "Console Python", role="checkbox", side="below")
    assert below is nodes[5]
    assert find_near(nodes, "Inconnu", role="edit") is None
    assert find_near(nodes, "Nom") is nodes[2], "sans rôle : le voisin interactif le plus proche"


def test_click_near_passe_par_la_pile(s):
    s.click(near="Nom", role="edit", side="right")
    assert s.report.steps[-1]["resolved_by"] == "near"
    ea = _calls(s, "element_action")[-1]
    assert (ea["x"], ea["y"]) == (220, 52)


# ── 1. pile d'identités + réparation ─────────────────────────────────────────

def test_pile_auto_id_puis_nom_puis_chemin_puis_voisin(s):
    # auto_id faux, nom bon → résolu par le nom, étape RÉPARÉE avec la ligne à écrire
    s.click(auto_id="okBtnRenomme", name="OK", role="button")
    st = s.report.steps[-1]
    assert st["resolved_by"] == "name" and st["healed"]["by"] == "name"
    assert st["healed"]["suggest"] == 'auto_id="okBtn"', "la meilleure identité du nœud trouvé"
    # tout faux sauf le voisin
    s.click(auto_id="x", name="Zzz", role="edit", near="Nom", side="right")
    st = s.report.steps[-1]
    assert st["resolved_by"] == "near" and st["healed"]["by"] == "near"
    assert st["healed"]["suggest"].startswith("path=")
    doc = s.report.finish(0)
    assert len(doc["healed"]) == 2 and "réparée" in doc["summary"]


def test_node_identity_et_kwargs():
    nodes = FORM()
    assert node_identity(nodes, nodes[6]) == {"auto_id": "okBtn"}
    assert node_identity(nodes, nodes[1]) == {"name": "Nom :", "role": "text"}
    assert node_identity(nodes, nodes[7]) == {"path": "#SettingsWin/button[2]"}, "« OK » ambigu → chemin"
    assert identity_kwargs({"name": 'A "b"', "role": "button"}) == 'name="A \\"b\\"", role="button"'


def test_sans_reparation_pas_de_healed(s):
    s.click(auto_id="okBtn")
    assert "healed" not in s.report.steps[-1] and s.report.steps[-1]["resolved_by"] == "auto_id"


# ── 4. coordonnées relatives à la fenêtre ────────────────────────────────────

def test_rel_suit_la_fenetre(tmp_path):
    nodes = FORM()
    b = FakeBackend(nodes=nodes, semantic=False)
    s = Session(backend=b, report_dir=str(tmp_path), settle=0, timeout=0.3)
    assert find_window(nodes, "#SettingsWin") is nodes[0] and find_window(nodes, "régl") is nodes[0]
    s.click(window="#SettingsWin", rel=(0.5, 0.25))
    c = _calls(s, "click")[-1]
    assert (c["x"], c["y"]) == (400, 150)
    nodes[0]["rect"] = [100, 50, 400, 300]          # la fenêtre a bougé et rétréci
    s.click(window="#SettingsWin", rel=(0.5, 0.25))
    c = _calls(s, "click")[-1]
    assert (c["x"], c["y"]) == (300, 125)
    # identité perdue, rel en repli → réparé par « rel », pas d'échec
    s.click(name="Disparu", window="#SettingsWin", rel=(0.5, 0.25))
    st = s.report.steps[-1]
    assert st["ok"] and st["healed"]["by"] == "rel"


# ── 5. préconditions ─────────────────────────────────────────────────────────

def test_require_fenetre_presente_ou_lancee(s):
    s.require(window="Calc")
    st = s.report.steps[-1]
    assert st["ok"] and st["method"] == "activate" and "précondition" in st["label"]
    assert _calls(s, "window_action")[-1]["action"] == "activate"
    with pytest.raises(StepError):
        s.require(window="Inexistante", timeout=0.3)
    with pytest.raises(StepError):
        s.require(window="Inexistante", launch="app.exe", timeout=0.3)   # lancée mais jamais visible → échec propre
    assert _calls(s, "launch") and not s.report.steps[-1]["ok"] and "lancement sans effet" in s.report.steps[-1]["error"]


def test_require_gone_et_checked(s, tmp_path):
    s.require(gone="Bloc-notes")
    assert _calls(s, "window_action")[-1]["action"] == "close"
    s.require(gone="Inexistante")
    assert s.report.steps[-1]["method"] == "already"
    s.require(checked=True, near="Console Python", role="checkbox")
    assert _calls(s, "element_action")[-1]["action"] == "check"
    s2 = Session(backend=FakeBackend(nodes=FORM(), semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError):
        s2.require(checked=False, name="Accepter")   # absente de FORM → attend puis échoue proprement
    assert not s2.report.steps[-1]["ok"]


# ── 6. vol à blanc ────────────────────────────────────────────────────────────

def test_dry_run_resout_sans_rien_envoyer(tmp_path):
    s = Session(backend=FakeBackend(nodes=FORM()), report_dir=str(tmp_path), settle=0, timeout=0.3, dry_run=True)
    s.click(auto_id="okBtn")
    s.click(auto_id="perdu", name="OK", role="button")
    s.click(name="Introuvable")
    s.type("hello")
    s.wait.element(name="OK")
    s.wait.stable()
    assert not _calls(s, "element_action") and not _calls(s, "click") and not _calls(s, "type_text"), "aucune entrée"
    st = s.report.steps
    assert st[0]["method"] == "trouvé:auto_id" and st[1]["method"] == "trouvé:name" and st[1]["healed"]["by"] == "name"
    assert st[2]["method"] == "introuvable" and not st[2]["ok"] and st[2]["strategies"] == ["name"]
    assert st[3]["method"] == "sauté" and st[4]["dry"] and st[5]["method"] == "sauté"
    doc = s.report.finish(s.report.exit_code())
    assert doc["dry_run"] is True and doc["targets"] == {"found": 2, "missing": 1}
    assert doc["summary"].startswith("VOL À BLANC")


# ── 7. trace ──────────────────────────────────────────────────────────────────

def test_trace_ecrit_capture_et_extrait_par_etape(tmp_path):
    s = Session(backend=FakeBackend(nodes=FORM()), report_dir=str(tmp_path), settle=0, timeout=0.3, trace=True)
    s.click(auto_id="okBtn")
    st = s.report.steps[-1]
    assert os.path.isfile(st["trace_png"]) and os.path.isfile(st["trace_tree"])
    ex = json.loads(Path(st["trace_tree"]).read_text(encoding="utf-8"))
    assert ex["box"] == [600, 540, 80, 30] and any(x["target"] for x in ex["nodes"])
    assert ex["nodes"][0]["auto_id"] == "SettingsWin", "ancêtres en tête"
    doc = s.report.finish(0)
    html_text = Path(s.report.dir, "rapport.html").read_text(encoding="utf-8")
    assert "Trace pas à pas" in html_text and "etape-01.png" in html_text


# ── 8. stabilité ──────────────────────────────────────────────────────────────

def test_stabilite_agrege_les_executions():
    from elpis_auto.__main__ import stability
    ok = {"exit_code": 0, "steps": [{"index": 1, "label": "clic A", "ok": True, "ms": 100},
                                    {"index": 2, "label": "clic B", "ok": True, "ms": 300, "waited_ms": 2500}]}
    ko = {"exit_code": 2, "steps": [{"index": 1, "label": "clic A", "ok": True, "ms": 120, "healed": {"by": "name"}},
                                    {"index": 2, "label": "clic B", "ok": False, "ms": 15000, "error": "délai dépassé (15 s)"}]}
    st = stability([ok, ok, ko])
    assert st["runs"] == 3 and st["runs_ok"] == 2 and st["fragile"] == [2]
    b = st["steps"][1]
    assert b["rate"] == pytest.approx(2 / 3, abs=0.01) and b["p95_ms"] == 15000
    assert any("attente" in x for x in b["suggestions"]) and any("délai" in x for x in b["suggestions"])
    a = st["steps"][0]
    assert a["rate"] == 1.0 and any("réparée" in x for x in a["suggestions"])


# ── 6/7/8/12 : ligne de commande ──────────────────────────────────────────────

def _script(tmp_path, body, name="script.py"):
    src = ("import sys\nsys.path.insert(0, %r)\nfrom test_elpis_auto import FakeBackend\nfrom elpis_auto import Session\n"
           "s = Session(backend=FakeBackend(), report_dir=%r, name='cli', settle=0, timeout=0.2)\n"
           % (str(Path(__file__).resolve().parent), str(tmp_path / "rapports"))) + body
    p = tmp_path / name
    p.write_text(src, encoding="utf-8")
    return str(p)


def test_cli_dry_run_et_repeat(tmp_path, monkeypatch):
    from elpis_auto.__main__ import main
    sc = _script(tmp_path, "s.click(auto_id='num7Button')\nraise SystemExit(s.finish())\n")
    assert main(["--dry-run", sc]) == 0
    reps = list((tmp_path / "rapports").glob("cli-*/rapport.json"))
    assert reps and json.loads(reps[0].read_text(encoding="utf-8")).get("dry_run") is True
    assert main(["--repeat", "2", sc]) == 0
    stab = list((tmp_path / "rapports").glob("cli-stabilite-*/stabilite.json"))
    assert stab and json.loads(stab[0].read_text(encoding="utf-8"))["runs"] == 2


def test_cli_data_une_execution_par_ligne(tmp_path):
    from elpis_auto.__main__ import main
    csv_path = tmp_path / "jeu.csv"
    csv_path.write_text("nom;valeur\nA;1\nB;2\n", encoding="utf-8")
    sc = _script(tmp_path, "p = s.params({'nom': '', 'valeur': ''})\ns.note('ligne ' + p['nom'] + '=' + p['valeur'])\nraise SystemExit(s.finish())\n")
    assert main(["--data", str(csv_path), sc]) == 0
    summ = list((tmp_path / "rapports").glob("cli-donnees-*/donnees.json"))
    assert summ
    d = json.loads(summ[0].read_text(encoding="utf-8"))
    assert d["rows"] == 2 and d["ok"] == 2 and d["results"][1]["params"] == {"nom": "B", "valeur": "2"}
    notes = [json.loads(p.read_text(encoding="utf-8"))["notes"][0]["text"] for p in sorted((tmp_path / "rapports").glob("cli-2*/rapport.json"))]
    assert "ligne A=1" in notes and "ligne B=2" in notes


def test_cli_lib_importable_a_cote_du_script(tmp_path):
    from elpis_auto.__main__ import main
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / "__init__.py").write_text("", encoding="utf-8")
    (tmp_path / "lib" / "outils.py").write_text("def bonjour():\n    return 'coucou'\n", encoding="utf-8")
    sc = _script(tmp_path, "from lib.outils import bonjour\ns.note(bonjour())\nraise SystemExit(s.finish())\n")
    assert main([sc]) == 0


# ── 3. repli visuel local ─────────────────────────────────────────────────────

def _png(im):
    out = io.BytesIO(); im.save(out, format="PNG"); return out.getvalue()


def test_image_retrouve_la_vignette_dans_la_capture(tmp_path):
    PIL = pytest.importorskip("PIL.Image")
    pytest.importorskip("numpy")
    from elpis_auto import visual
    from PIL import Image, ImageDraw
    screen = Image.new("RGB", (400, 300), (240, 240, 240))
    d = ImageDraw.Draw(screen)
    d.rectangle((250, 120, 310, 150), fill=(30, 120, 220)); d.text((258, 128), "OK", fill=(255, 255, 255))
    d.rectangle((40, 40, 120, 70), fill=(200, 60, 60))
    png = _png(screen)
    tpl = tmp_path / "ok.png"
    screen.crop((250, 120, 311, 151)).save(tpl, format="PNG")
    hit = visual.locate_template(png, str(tpl))
    assert hit and hit["score"] > 0.95 and abs(hit["rect"][0] - 250) <= 1 and abs(hit["rect"][1] - 120) <= 1
    # la même vignette dans un écran où le bouton a bougé
    screen2 = Image.new("RGB", (400, 300), (240, 240, 240))
    d2 = ImageDraw.Draw(screen2)
    d2.rectangle((100, 200, 160, 230), fill=(30, 120, 220)); d2.text((108, 208), "OK", fill=(255, 255, 255))
    hit2 = visual.locate_template(_png(screen2), str(tpl))
    assert hit2 and abs(hit2["rect"][0] - 100) <= 1 and abs(hit2["rect"][1] - 200) <= 1
    assert visual.locate_template(_png(Image.new("RGB", (400, 300), (0, 0, 0))), str(tpl)) is None, "absente → None"

    class Shot(FakeBackend):
        def screenshot(self, fmt=None, quality=None): return _png(screen2), 400, 300
    s = Session(backend=Shot(semantic=False), report_dir=str(tmp_path), settle=0, timeout=0.3)
    s.script_dir = str(tmp_path)
    s.click(name="Disparu", image="ok.png")
    st = s.report.steps[-1]
    assert st["ok"] and st["resolved_by"] == "image" and st["healed"]["by"] == "image"
    c = _calls(s, "click")[-1]
    assert abs(c["x"] - 130) <= 2 and abs(c["y"] - 215) <= 2


def test_describe_exige_elpis_url(tmp_path, monkeypatch):
    monkeypatch.delenv("ELPIS_URL", raising=False)
    s = Session(backend=FakeBackend(), report_dir=str(tmp_path), settle=0, timeout=0.3)
    with pytest.raises(StepError):
        s.click(describe="le bouton vert")
    assert "ELPIS_URL" in s.report.steps[-1]["error"]
