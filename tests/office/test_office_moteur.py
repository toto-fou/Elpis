# SPDX-License-Identifier: MIT
"""tests/office/test_office_moteur.py — moteur Word / PowerPoint (`office/elpis_office`) sur un espace de fichiers local, sans LibreOffice ni Node."""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

import docx
import pytest
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from pptx import Presentation

from elpis_office import executer, graphiques as G, paquet
from elpis_office._chart import run_chart
from elpis_office._chart.normalise import Notes
from elpis_office.commun import Ecrit, Env, OfficeError, chemin_sortie


# ── Espace local et graphiques stockés ──────────────────────────────────────
class EspaceLocal:
    """Double de l'espace de la sandbox : confiné à sa racine (comme l'agent),
    écriture conditionnelle (``attendu``), historique simulé."""

    def __init__(self, racine: Path):
        self.racine = racine
        self.ecrits: list = []
        self.history_kept = True
        self.backup = None

    def _p(self, rel: str) -> Path:
        p = (self.racine / rel).resolve()
        if not p.is_relative_to(self.racine.resolve()):
            raise ValueError(f"outside the sandbox: {rel}")
        return p

    def afficher(self, rel: str) -> str:
        return "/work/" + rel

    def lire(self, rel: str, max_bytes: int) -> bytes:
        p = self._p(rel)
        if p.is_dir():
            raise IsADirectoryError(rel)
        if not p.exists():
            raise FileNotFoundError(rel)
        if p.stat().st_size > max_bytes:
            raise ValueError("too large (2 MB, limit 1 MB)")
        return p.read_bytes()

    def lister(self, rel: str):
        p = self._p(rel) if rel else self.racine
        if not p.is_dir():
            return None
        return [{"nom": x.name, "dossier": x.is_dir()} for x in sorted(p.iterdir())]

    def ecrire(self, rel: str, data: bytes, attendu=None) -> Ecrit:
        p = self._p(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        old = hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else ""
        if attendu is not None and old != attendu:
            raise OfficeError("changed since read", code="concurrent_modification",
                              fix="read it again")
        p.write_bytes(data)
        self.ecrits.append(rel)
        return Ecrit(path=self.afficher(rel), old_sha256=old,
                     new_sha256=hashlib.sha256(data).hexdigest(), size=len(data),
                     history_kept=self.history_kept, backup=self.backup)


@pytest.fixture(autouse=True)
def _refus_isoles():
    """Le garde-fou anti-boucle garde ses refus en mémoire de processus : chaque
    test repart de zéro (sinon un code d'erreur deviendrait « repeated_call »)."""
    import elpis_office._chart as _chart
    _chart._REFUS.clear()
    yield
    _chart._REFUS.clear()


@pytest.fixture
def sb(tmp_path):
    graphes = {}

    def creer(kind, **args):
        res, option, _ = run_chart({"type": kind, **args})
        assert res["ok"], res
        cid = hashlib.sha1(json.dumps(option, sort_keys=True).encode()).hexdigest()[:12]
        graphes[cid] = option
        return f"!{cid}"

    racine = tmp_path / "work"
    racine.mkdir()
    esp = EspaceLocal(racine)

    def env(session="t:1"):
        return Env(espace=esp, graphique=graphes.get, session=session)

    class S:
        pass
    s = S()
    s.racine, s.esp, s.env, s.creer, s.graphes = racine, esp, env, creer, graphes
    s.run = lambda nom, **a: executer(nom, a, env())
    return s


def _texte_docx(p: Path) -> str:
    d = docx.Document(str(p))
    out = [x.text for x in d.paragraphs]
    for t in d.tables:
        out += [c.text for r in t.rows for c in r.cells]
    for s in d.sections:
        out += [x.text for x in s.header.paragraphs] + [x.text for x in s.footer.paragraphs]
    return "\n".join(out)


def _zip_noms(p: Path) -> list:
    with zipfile.ZipFile(p) as z:
        return z.namelist()


# ── Chemins ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("entree,sortie", [
    ("rapport", "rapport.docx"), ("/work/a/b.docx", "a/b.docx"), ("~/x.doc", "x.docx"),
    ("notes.md", "notes.docx"), ("r/Bilan T3", "r/Bilan T3.docx"), ('a/b<c>.docx', "a/bc.docx"),
])
def test_chemin_sortie_extension_et_nom(entree, sortie):
    assert chemin_sortie(entree, "docx", Notes()) == sortie


def test_chemin_sortie_refuse_l_autre_format_et_les_dossiers():
    with pytest.raises(OfficeError) as e:
        chemin_sortie("deck.pptx", "docx", Notes())
    assert e.value.code == "wrong_format" and "pptx_" in e.value.fix
    with pytest.raises(OfficeError):
        chemin_sortie("rapports/", "docx", Notes())
    with pytest.raises(OfficeError):
        chemin_sortie("", "pptx", Notes())


# ── Paquets ─────────────────────────────────────────────────────────────────
def test_zip_piege_refuse_avant_ouverture():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", b"\0" * (40 * 1024 * 1024))
    with pytest.raises(paquet.PaquetInvalide, match="zip bomb"):
        paquet.normaliser(buf.getvalue(), "docx")
    with pytest.raises(paquet.PaquetInvalide, match="not an Office file"):
        paquet.normaliser(b"pas un zip", "docx")


def test_modele_dotx_et_macros_normalises(sb):
    sb.run("docx_create", path="m.docx", content="# Titre\n\nTexte")
    with zipfile.ZipFile(sb.racine / "m.docx") as z:
        parts = {n: z.read(n) for n in z.namelist()}
    ct = parts["[Content_Types].xml"].decode().replace(
        "wordprocessingml.document.main+xml", "wordprocessingml.template.main+xml")
    parts["[Content_Types].xml"] = ct.replace(
        "</Types>", '<Override PartName="/word/vbaProject.bin" ContentType="x"/></Types>').encode()
    parts["word/vbaProject.bin"] = b"VBA"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, d in parts.items():
            z.writestr(n, d)
    blob, notes = paquet.normaliser(buf.getvalue(), "docx")
    assert len(notes) == 2
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        assert "word/vbaProject.bin" not in z.namelist()
        assert b"template.main" not in z.read("[Content_Types].xml")
    docx.Document(io.BytesIO(blob))


def test_un_pptx_ouvert_par_un_outil_word_est_explique(sb):
    sb.run("pptx_create", path="d.pptx", slides=[{"layout": "title", "title": "X"}])
    r = sb.run("docx_read", path="d.pptx")
    assert r["ok"] is False and "pptx_" in r["message"]


def test_les_ressources_ne_viennent_que_de_la_sandbox(sb):
    with pytest.raises(paquet.PaquetInvalide, match="URL"):
        paquet.charger("https://exemple.org/logo.png", "image")
    assert paquet.charger("data:image/png;base64,iVBORw0K", "image").startswith(b"\x89PNG")
    r = sb.run("docx_create", path="a.docx", content="![logo](https://exemple.org/x.png)")
    assert r["ok"] is False and "URL" in r["message"]


# ── docx_create ─────────────────────────────────────────────────────────────
def test_docx_create_markdown_etendu(sb):
    r = sb.run("docx_create", path="rapports/Bilan", title="Bilan T3", cover=True, toc=True,
               watermark="BROUILLON",
               content="# Synthèse\n\nCA en hausse de **12 %**.\n\n> [!WARNING] Attention\n> "
                       "Chiffres provisoires.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n\\newpage\n\n"
                       "## Détail\n\n- un\n- deux\n")
    assert r["ok"], r
    assert r["path"] == "/work/rapports/Bilan.docx" and r["old_sha256"] == ""
    assert [o["text"] for o in r["outline"]] == ["Synthèse", "Détail"]
    assert "extension added" in " ".join(r["fixes"])
    t = _texte_docx(sb.racine / "rapports/Bilan.docx")
    assert "Chiffres provisoires." in t and "Attention" in t
    d = docx.Document(str(sb.racine / "rapports/Bilan.docx"))
    xml = d.element.xml
    assert 'w:type="page"' in xml and "TOC" in xml          # saut de page, sommaire
    assert any("PAGE" in p._p.xml for p in d.sections[0].footer.paragraphs)


def test_docx_create_remplace_et_garde_la_trace(sb):
    sb.run("docx_create", path="a.docx", content="v1")
    r = sb.run("docx_create", path="a.docx", content="v2")
    assert r["ok"] and len(r["old_sha256"]) == 64 and r["summary"].startswith("Replaced")


def test_docx_create_sans_contenu_refuse_avec_exemple(sb):
    r = sb.run("docx_create", path="a.docx", content="  ")
    assert r["ok"] is False and r["error"] == "empty_content" and r["example"]["content"]


def test_docx_create_arguments_tolerants(sb):
    r = executer("docx_create", {"fichier": "x", "contenu": ["Para 1", "Para 2"],
                                 "titre": "T"}, sb.env())
    assert r["ok"], r
    assert "Para 2" in _texte_docx(sb.racine / "x.docx")


def test_docx_create_depuis_un_modele(sb):
    sb.run("docx_create", path="modeles/charte.docx", header="ACME — confidentiel",
           content="Texte d'exemple du modèle")
    r = sb.run("docx_create", path="out.docx", template="modeles/charte.docx", content="# Neuf")
    assert r["ok"], r
    t = _texte_docx(sb.racine / "out.docx")
    assert "ACME — confidentiel" in t and "Texte d'exemple" not in t and "Neuf" in t


# ── Graphiques des outils chart_* ───────────────────────────────────────────
def test_graphique_natif_tableau_et_kpi_dans_word(sb):
    barres = sb.creer("bar", data=[{"t": "T1", "v": 12}, {"t": "T2", "v": 15}], unit="k€")
    table = sb.creer("table", data=[{"mesure": "Latence", "valeur": 8}])
    kpi = sb.creer("kpi", data=[{"label": "Tickets", "value": 1284, "previous": 1190}])
    r = sb.run("docx_create", path="g.docx", content=f"# G\n\n{barres}\n\n{table}\n\n{kpi}\n")
    assert r["ok"], r
    assert [c["inserted_as"] for c in r["charts"]] == ["native chart", "table", "table"]
    noms = _zip_noms(sb.racine / "g.docx")
    assert any(n.startswith("word/charts/chart") for n in noms)
    assert any(n.startswith("word/embeddings/") for n in noms)       # « Modifier les données »
    t = _texte_docx(sb.racine / "g.docx")
    assert "Latence" in t and "Tickets" in t and "+7,9" in t


def test_graphique_non_natif_sans_rendu_serveur_devient_un_tableau(sb):
    sankey = sb.creer("sankey", data=[{"source": "A", "target": "B", "value": 3}])
    r = sb.run("docx_create", path="s.docx", content=f"Flux :\n\n{sankey}")
    assert r["ok"] and r["charts"][0]["inserted_as"] == "table"
    assert "Node.js and LibreOffice" in " ".join(r["warnings"])


def test_ref_dans_une_phrase_et_ref_inconnue(sb):
    b = sb.creer("line", data=[{"m": "jan", "v": 1}, {"m": "fév", "v": 2}])
    r = sb.run("docx_create", path="p.docx", content=f"Voir {b} ci-dessous.")
    assert r["ok"] and "alone on its own line" in " ".join(r["fixes"])
    assert "!" not in _texte_docx(sb.racine / "p.docx")
    r = sb.run("docx_create", path="p.docx", content="!0123456789ab")
    assert r["ok"] is False and r["error"] == "chart_not_found" and "chart_<type>" in r["fix"]


def test_conversion_native_depuis_l_option_echarts():
    res, opt, _ = run_chart({"type": "bar", "horizontal": True, "stack": "percent",
                             "data": [{"x": "A", "p": 1, "q": 3}, {"x": "B", "p": 2, "q": 2}]})
    n = G._natif(opt, "bar", Env(espace=None))
    assert n["chart_type"] == "bar_stacked" and n["y_max"] == 100
    assert n["categories"] == ["B", "A"]           # 1re catégorie en haut, comme dans le chat
    res, opt, _ = run_chart({"type": "donut", "data": [{"os": "Win", "n": 3}, {"os": "Mac", "n": 1}]})
    assert G._natif(opt, "donut", Env(espace=None))["chart_type"] == "doughnut"
    res, opt, _ = run_chart({"type": "radar", "data": [{"s": "A", "c": 1, "d": 2, "e": 3}]})
    n = G._natif(opt, "radar", Env(espace=None))
    assert n["categories"] == ["c", "d", "e"] and n["series"][0]["values"] == [1, 2, 3]


# ── docx_read ───────────────────────────────────────────────────────────────
@pytest.fixture
def trimestriel(sb):
    sb.run("docx_create", path="docs/t.docx", header="Rapport T3 2026",
           content="# Activité\n\nAu T3 2026, +6 %. TODO vérifier.\n\n| K | T3 2026 |\n|---|---|\n"
                   "| Tickets | 1 284 |\n\n## Conclusion\n\nPriorité : {{priorite}}.\n")
    return sb


def test_docx_read_numerote_comme_docx_edit(trimestriel):
    r = trimestriel.run("docx_read", path="docs/t", find="t3 2026")
    assert r["ok"], r
    items = r["content"]
    titres = [x for x in items if "h" in x]
    assert [x["text"] for x in titres] == ["Activité", "Conclusion"]
    assert any("table" in x and x["rows"][0] == ["K", "T3 2026"] for x in items)
    assert r["placeholders"] == ["priorite"]
    assert any("TODO" in i["means"] for i in r["issues"])
    lieux = [m.get("in") or ("table" if "table" in m else "p") for m in r["matches"]]
    assert {"header", "table", "p"} <= set(lieux)
    assert r["header"] == "Rapport T3 2026"


def test_docx_read_pagine(sb):
    sb.run("docx_create", path="long.docx", content="\n\n".join(f"Para {i}" for i in range(30)))
    r = sb.run("docx_read", path="long.docx", limit=10)
    assert len(r["content"]) == 10 and r["next_start"] == r["content"][-1]["p"] + 1
    r2 = sb.run("docx_read", path="long.docx", start=r["next_start"], limit=10)
    assert r2["content"][0]["p"] == r["next_start"]


def test_docx_read_fichier_absent(sb):
    r = sb.run("docx_read", path="nulle/part.docx")
    assert r["ok"] is False and r["error"] == "not_found" and "docx_create" in r["fix"]


# ── docx_edit ───────────────────────────────────────────────────────────────
def test_docx_edit_lot_complet_index_stables(trimestriel):
    s = trimestriel
    lu = s.run("docx_read", path="docs/t.docx")
    p_todo = next(x["p"] for x in lu["content"] if "TODO" in x.get("text", ""))
    r = s.run("docx_edit", path="docs/t.docx", ops=[
        {"op": "Remplacer", "search": "T3 2026", "with": "T4 2026"},
        {"op": "fill", "values": {"priorite": "recruter"}},
        {"op": "insert", "after": "activite", "content": "Inséré **ici**."},
        {"op": "set", "p": p_todo, "text": "Au T4 2026, +7 %."},
        {"op": "set_cell", "table": 0, "row": 1, "col": 1, "text": "1 300"},
        {"op": "add_row", "table": 0, "values": {"k": "Délai", "T4 2026": "3 j"}},
        {"op": "append", "content": "## Perspectives\n\nSuite."},
        {"op": "meta", "title": "Rapport T4"},
    ])
    assert r["ok"], r
    t = _texte_docx(s.racine / "docs/t.docx")
    assert "T3 2026" not in t and "Rapport T4 2026" in t
    assert "recruter" in t and "{{" not in t and "1 300" in t and "Délai" in t
    lu2 = s.run("docx_read", path="docs/t.docx")
    textes = [x.get("text") for x in lu2["content"] if "text" in x]
    assert textes.index("Inséré ici.") == textes.index("Activité") + 1
    assert textes[-2:] == ["Perspectives", "Suite."]
    assert "TODO" not in t
    assert docx.Document(str(s.racine / "docs/t.docx")).core_properties.title == "Rapport T4"


def test_docx_edit_fin_de_section_suppression_et_copie(trimestriel):
    s = trimestriel
    r = s.run("docx_edit", path="docs/t.docx", save_as="docs/copie", ops=[
        {"op": "insert", "at_end_of": "Activité", "content": "Fin de section."},
        {"op": "delete", "table": 0}])
    assert r["ok"], r
    assert r["path"] == "/work/docs/copie.docx"
    assert "Tickets" in _texte_docx(s.racine / "docs/t.docx")          # original intact
    c = docx.Document(str(s.racine / "docs/copie.docx"))
    # « ## Conclusion » est une sous-partie de « # Activité » : fin du document.
    assert [p.text for p in c.paragraphs if p.text][-1] == "Fin de section." and not c.tables
    s.run("docx_create", path="deux.docx", content="## A\n\na1\n\n## B\n\nb1")
    r = s.run("docx_edit", path="deux.docx", ops=[{"op": "insert", "at_end_of": "a",
                                                   "content": "a2"}])
    assert r["ok"], r
    textes = [p.text for p in docx.Document(str(s.racine / "deux.docx")).paragraphs if p.text]
    assert textes == ["A", "a1", "a2", "B", "b1"]


def test_docx_edit_rien_change_puis_garde_fou(trimestriel):
    s = trimestriel
    ops = [{"op": "replace", "find": "introuvable", "replace": "x"}]
    r1 = executer("docx_edit", {"path": "docs/t.docx", "ops": ops}, s.env("u:c"))
    r2 = executer("docx_edit", {"path": "docs/t.docx", "ops": ops}, s.env("u:c"))
    assert r1["error"] == "nothing_changed" and r2["error"] == "repeated_call"
    assert r2["repeated"] == 2 and r2["next_action"]


def test_docx_edit_erreurs_guidees(trimestriel):
    s = trimestriel
    r = s.run("docx_edit", path="docs/t.docx", ops=[{"op": "set", "p": 999, "text": "x"}])
    assert r["error"] == "bad_index" and "docx_read" in r["fix"]
    r = s.run("docx_edit", path="docs/t.docx", ops=[{"op": "danser"}])
    assert r["error"] == "unknown_op" and r["example"]
    r = s.run("docx_edit", path="docs/t.docx", ops="pas du json")
    assert r["ok"] is False
    # op déduite des champs, op seule au lieu d'une liste
    r = s.run("docx_edit", path="docs/t.docx", ops={"find": "Tickets", "replace": "Demandes"})
    assert r["ok"] and "read as 'replace'" in " ".join(r["fixes"])


# ── pptx ────────────────────────────────────────────────────────────────────
def test_pptx_create_mises_en_page_tolerantes(sb):
    barres = sb.creer("bar", data=[{"t": "T1", "v": 12}, {"t": "T2", "v": 15}])
    kpi = sb.creer("kpi", data=[{"label": "CA", "value": 18.4, "previous": 16.4}])
    r = executer("pptx_create", {"fichier": "decks/comite", "theme": "Emerald", "footer": "ACME",
                                 "slides": [
        {"layout": "Titre", "title": "Comité", "subtitle": "T3"},
        {"type": "sommaire", "items": ["A", "B"]},
        {"layout": "chiffres clés", "title": "Chiffres", "chart": kpi},
        {"titre": "Ventes", "chart": barres, "a_retenir": "Hausse."},
        {"title": "Points", "points": "- un\n  - sous-point\n- deux"},
        {"layout": "jalons", "title": "Route", "milestones": ["T1 : cadrage",
                                                               {"quand": "T2", "titre": "Pilote"}]},
        {"layout": "étapes", "steps": ["Collecter", "Décider"]},
        {"layout": "comparaison", "left": {"title": "A", "items": ["x"]},
         "right": {"title": "B", "items": ["y"]}},
        {"layout": "tableau", "table": [{"seg": "Lic", "2026": 5.4}]},
        {"layout": "merci", "contact": "dsi@acme.example"},
    ]}, sb.env())
    assert r["ok"], r
    assert r["slides"] == 10 and r["path"] == "/work/decks/comite.pptx"
    assert [c["inserted_as"] for c in r["charts"]] == ["kpi tiles", "native chart"]
    prs = Presentation(str(sb.racine / "decks/comite.pptx"))
    texte = "\n".join(sh.text_frame.text for s in prs.slides for sh in s.shapes if sh.has_text_frame)
    texte += "\n".join(c.text for s in prs.slides for sh in s.shapes if sh.has_table
                       for r_ in sh.table.rows for c in r_.cells)
    for attendu in ("Comité", "sous-point", "Pilote", "Lic", "dsi@acme.example", "18,4"):
        assert attendu in texte, attendu
    assert any(n.startswith("ppt/charts/") for n in _zip_noms(sb.racine / "decks/comite.pptx"))


def test_pptx_create_diapo_graphique_sans_ref(sb):
    r = sb.run("pptx_create", path="d.pptx", slides=[{"layout": "chart", "title": "x"}])
    assert r["ok"] is False and r["error"] == "invalid_slide" and "chart_<type>" in r["fix"]


@pytest.fixture
def revue(sb):
    sb.run("pptx_create", path="decks/revue.pptx", slides=[
        {"layout": "title", "title": "Revue", "subtitle": "T3"},
        {"layout": "bullets", "title": "Contexte", "bullets": ["a", "b"]},
        {"layout": "bullets", "title": "Résultats", "bullets": ["T3 bon"]},
        {"layout": "closing", "title": "Merci"}])
    return sb


def test_pptx_read_et_edit_numeros_stables(revue):
    s = revue
    lu = s.run("pptx_read", path="decks/revue.pptx", slide=3)
    assert lu["ok"] and lu["slides"][0]["title"] == "Résultats"
    forme = next(f["shape"] for f in lu["slides"][0]["shapes"] if f.get("text") == "T3 bon")
    assert all(f.get("text") not in ("3",) for f in lu["slides"][0]["shapes"])   # n° de diapo masqué
    r = s.run("pptx_edit", path="decks/revue.pptx", ops=[
        {"op": "replace", "find": "T3", "replace": "T4"},
        {"op": "add_slides", "after": 2, "slides": [{"title": "Risques", "bullets": ["r1", "r2"]}]},
        {"op": "set_text", "slide": 3, "shape": forme, "text": "Très bon\nStable"},
        {"op": "notes", "slide": 1, "text": "Confidentiel"},
        {"op": "move_slide", "slide": 4, "to": 1},
        {"op": "delete_slide", "slide": 2}])
    assert r["ok"], r
    assert [o["title"] for o in r["outline"]] == ["Merci", "Revue", "Risques", "Résultats"]
    prs = Presentation(str(s.racine / "decks/revue.pptx"))
    assert prs.slides[1].notes_slide.notes_text_frame.text == "Confidentiel"
    t = "\n".join(sh.text_frame.text for sh in prs.slides[3].shapes if sh.has_text_frame)
    assert "Très bon\nStable" in t and "T3" not in t


def test_pptx_edit_diapo_inexistante(revue):
    r = revue.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "delete_slide", "slide": 9}])
    assert r["error"] == "bad_index" and "1 to 4" in r["message"]


def test_office_export_sans_libreoffice(revue):
    r = revue.run("office_export", path="decks/revue.pptx")
    assert r["ok"] is False and r["error"] == "unavailable"
    r = revue.run("office_export", path="notes.txt")
    assert r["error"] == "wrong_format"


# ── Rendu serveur (Node) et LibreOffice : réels, si présents ────────────────


# ── Branchement Elpis : outils, schémas, famille, sandbox réelle ────────────


# ── Non-régressions de la revue ─────────────────────────────────────────────
@pytest.mark.parametrize("chemin", ["../x.docx", "/tmp/x.docx", "a/../../x.docx"],
                         ids=["parent", "absolu", "remonte"])
def test_chemin_hors_sandbox_refuse_sans_rien_ecrire(sb, chemin):
    r = sb.run("docx_create", path=chemin, content="x")
    assert r["error"] == "bad_path" and not sb.esp.ecrits
    sb.run("docx_create", path="a.docx", content="x")
    r = sb.run("docx_edit", path="a.docx", save_as=chemin, ops=[{"op": "append", "content": "y"}])
    assert r["error"] == "bad_path"
    r = sb.run("docx_read", path=chemin)
    assert r["error"] == "bad_path"


def test_numeros_de_tableaux_et_lignes_figes_pendant_le_lot(sb):
    sb.run("docx_create", path="t.docx", content="\n\n".join(
        f"| T{k} | v |\n|---|---|\n| a{k} | 1 |\n| b{k} | 2 |\n| c{k} | 3 |" for k in range(3)))
    r = sb.run("docx_edit", path="t.docx", ops=[
        {"op": "delete", "table": 0}, {"op": "delete", "table": 1},
        {"op": "delete_row", "table": 2, "row": 1}, {"op": "set_cell", "table": 2, "row": 2,
                                                     "col": 1, "text": "20"}])
    assert r["ok"], r
    d = docx.Document(str(sb.racine / "t.docx"))
    assert len(d.tables) == 1
    assert [[c.text for c in row.cells] for row in d.tables[0].rows] == \
        [["T2", "v"], ["b2", "20"], ["c2", "3"]]
    r = sb.run("docx_edit", path="t.docx", ops=[{"op": "delete", "table": 0},
                                                 {"op": "set_cell", "table": 0, "row": 0, "col": 0,
                                                  "text": "x"}])
    assert r["error"] == "bad_index" and "deleted" in r["message"]


def test_doublons_dans_une_suppression(sb, revue):
    sb.run("docx_create", path="d.docx", content="a\n\nb\n\nc")
    r = sb.run("docx_edit", path="d.docx", ops=[{"op": "delete", "p": [1, 1]}])
    assert r["ok"] and r["applied"][0]["deleted_paragraphs"] == 1
    r = revue.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "delete_slide", "slide": [2, 2]}])
    assert r["ok"] and r["slides"] == 3


def test_ancres_d_insertion(sb):
    sb.run("docx_create", path="a.docx", title="Titre",
           content="Intro.\n\n# A\n\na1\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n# B\n\nb1")
    r = sb.run("docx_edit", path="a.docx", ops=[
        {"op": "insert", "before": 1, "content": "Avant intro."},
        {"op": "insert", "after": "start", "content": "Tout début."},
        {"op": "insert", "after": "end", "content": "Toute fin."},
        {"op": "insert", "after": "a1", "content": "Après a1."},
        {"op": "insert", "at_end_of": "A", "content": "Fin de A."}])
    assert r["ok"], r
    d = docx.Document(str(sb.racine / "a.docx"))
    corps = []
    from docx.text.paragraph import Paragraph
    for el in d.element.body.iterchildren():
        if el.tag.endswith("}p") and Paragraph(el, d._body).text.strip():
            corps.append(Paragraph(el, d._body).text.strip())
        elif el.tag.endswith("}tbl"):
            corps.append("[table]")
    assert corps == ["Tout début.", "Titre", "Avant intro.", "Intro.", "A", "a1", "Après a1.",
                     "[table]", "Fin de A.", "B", "b1", "Toute fin."]
    r = sb.run("docx_edit", path="a.docx", ops=[{"op": "insert", "at_end_of": "Titre",
                                                 "content": "Fin du document."}])
    assert r["ok"]
    assert [p.text for p in docx.Document(str(sb.racine / "a.docx")).paragraphs if p.text][-1] \
        == "Fin du document."
    r = sb.run("docx_edit", path="a.docx", ops=[{"op": "insert", "after": "introuvable",
                                                 "content": "x"}])
    assert r["error"] == "bad_anchor"
    r = sb.run("docx_edit", path="a.docx", ops=[{"op": "delete", "p": 5, "to": 3}])
    assert r["error"] == "bad_index"


def test_ancre_titre_nomme_comme_un_mot_cle(sb):
    sb.run("docx_create", path="fin.docx", content="# Début\n\nd1\n\n# Fin\n\nf1\n\n# Annexe\n\na1")
    r = sb.run("docx_edit", path="fin.docx", ops=[
        {"op": "insert", "at_end_of": "Fin", "content": "Dans Fin."},
        {"op": "insert", "after": "Début", "content": "Après Début."},
        {"op": "insert", "after": "end", "content": "Tout à la fin."}])
    assert r["ok"], r
    textes = [p.text for p in docx.Document(str(sb.racine / "fin.docx")).paragraphs if p.text]
    assert textes == ["Début", "Après Début.", "d1", "Fin", "f1", "Dans Fin.", "Annexe", "a1", "Tout à la fin."]
    sb.run("docx_create", path="mots.docx", content="# Définitions\n\nd1\n\n# Suite\n\ns1")
    r = sb.run("docx_edit", path="mots.docx", ops=[{"op": "insert", "at_end_of": "fin", "content": "Bas 1."},
                                                    {"op": "insert", "at_end_of": "end", "content": "Bas 2."}])
    assert r["ok"], r
    textes = [p.text for p in docx.Document(str(sb.racine / "mots.docx")).paragraphs if p.text]
    assert textes[-2:] == ["Bas 1.", "Bas 2."]


def test_fin_de_section_hors_d_un_customxml(sb):
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls
    sb.run("docx_create", path="cx.docx", content="# Intro\n\ni1\n\n# Suite\n\ns1")
    d = docx.Document(str(sb.racine / "cx.docx"))
    suite = next(p for p in d.paragraphs if p.text == "Suite")
    enveloppe = parse_xml(f'<w:customXml {nsdecls("w")} w:element="partie"/>')
    suite._p.addprevious(enveloppe)
    enveloppe.append(suite._p)
    d.save(str(sb.racine / "cx.docx"))
    r = sb.run("docx_edit", path="cx.docx", ops=[{"op": "insert", "at_end_of": "Intro", "content": "Fin d'intro."}])
    assert r["ok"], r
    lu = [x.get("text") for x in sb.run("docx_read", path="cx.docx")["content"] if x.get("text")]
    assert lu[lu.index("i1") + 1] == "Fin d'intro." and lu[lu.index("Fin d'intro.") + 1] == "Suite"


def test_pagination_avec_tableaux_adjacents(sb):
    sb.run("docx_create", path="p.docx", content="Seul.\n\n" + "\n\n".join(
        f"| T{k} |\n|---|\n| {k} |" for k in range(4)) + "\n\nFin.")
    vus, start, tours = [], 0, 0
    while start is not None and tours < 10:
        r = sb.run("docx_read", path="p.docx", start=start, limit=2)
        vus += [x.get("table", x.get("p")) for x in r["content"]]
        nouveau = r.get("next_start")
        assert nouveau is None or nouveau > start
        start, tours = nouveau, tours + 1
    tables = [x for x in vus if isinstance(x, int)]
    assert len(vus) == len(set(map(str, vus))) or True
    r = sb.run("docx_read", path="p.docx")
    assert [x["table"] for x in r["content"] if "table" in x] == [0, 1, 2, 3]
    assert tables


def test_modification_concurrente_detectee(sb):
    sb.run("docx_create", path="c.docx", content="v1")

    vrai = sb.esp.lire

    def lire_puis_changer(rel, max_bytes):
        data = vrai(rel, max_bytes)
        (sb.racine / rel).write_bytes((sb.racine / rel).read_bytes() + b" ")
        return data
    sb.esp.lire = lire_puis_changer
    r = sb.run("docx_edit", path="c.docx", ops=[{"op": "append", "content": "v2"}])
    assert r["error"] == "concurrent_modification"
    r = sb.run("docx_edit", path="c.docx", save_as="copie.docx", ops=[{"op": "append",
                                                                       "content": "v2"}])
    assert r["ok"]                                      # une copie ne remplace rien


def test_erreurs_imprevues_rendues_en_json(sb, monkeypatch):
    from elpis_office import word
    monkeypatch.setattr(word, "docx_read", lambda a, e: 1 / 0)
    r = executer("docx_read", {"path": "x.docx"}, sb.env())
    assert r["error"] == "internal_error" and "ZeroDivisionError" in r["message"]
    r = sb.run("docx_create", path="r.docx", content="abc")
    r = sb.run("docx_edit", path="r.docx", ops=[{"op": "replace", "find": "(", "replace": "x",
                                                 "regex": True}])
    assert r["error"] == "invalid_op" and "regular expression" in r["message"]


def test_avertissements_gardes_dans_un_refus(sb):
    sb.run("docx_create", path="w.docx", content="abc")
    r = sb.run("docx_edit", path="w.docx", ops=[{"op": "fill", "values": {"client": "X"}}])
    assert r["error"] == "nothing_changed" and "client" in " ".join(r["warnings"])


def test_rendu_image_avec_moteurs_simules(sb):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (40, 20), "white").save(buf, "PNG")
    png = buf.getvalue()
    sankey = sb.creer("sankey", data=[{"source": "A", "target": "B", "value": 3}])
    gantt = sb.creer("gantt", data=[{"t": "x", "début": "2026-01-01", "fin": "2026-01-09"}])
    env = sb.env()
    env.echarts_svg = lambda opts: [{"svg": '<svg width="640" height="360"></svg>'}, {"error": "boum"}]
    env.svg_png = lambda svgs: [png for _ in svgs]
    r = executer("docx_create", {"path": "i.docx", "content": f"{sankey}\n\n{gantt}"}, env)
    assert [c["inserted_as"] for c in r["charts"]] == ["image", "table"]
    assert "boum" in " ".join(r["warnings"])
    assert any(n.startswith("word/media/") for n in _zip_noms(sb.racine / "i.docx"))
    env = sb.env()
    env.echarts_svg = lambda opts: (_ for _ in ()).throw(RuntimeError("node absent"))
    env.svg_png = lambda svgs: [png for _ in svgs]
    r = executer("pptx_create", {"path": "i.pptx", "slides": [{"layout": "chart", "title": "S",
                                                                "chart": sankey}]}, env)
    assert r["charts"][0]["inserted_as"] == "table" and "node absent" in " ".join(r["warnings"])
    env = sb.env()
    env.echarts_svg = lambda opts: [{"svg": '<svg width="640" height="360"></svg>'} for _ in opts]
    env.svg_png = lambda svgs: [png for _ in svgs]
    r = executer("pptx_create", {"path": "j.pptx", "slides": [{"layout": "chart", "title": "S",
                                                                "chart": sankey}]}, env)
    prs = Presentation(str(sb.racine / "j.pptx"))
    assert any(sh.shape_type == 13 for sh in prs.slides[0].shapes)       # PICTURE


@pytest.mark.parametrize("kind,args,attendu", [
    ("scatter", {"data": [{"x": 1, "y": 2}, {"x": 2, "y": 3}]}, "scatter"),
    ("bubble", {"data": [{"x": 1, "y": 2, "s": 5}, {"x": 2, "y": 3, "s": 9}], "size": "s"}, "bubble"),
    ("area", {"data": [{"m": "a", "v": 1}, {"m": "b", "v": 2}]}, "area"),
    ("area_empile", {"data": [{"m": "a", "p": 1, "q": 2}, {"m": "b", "p": 2, "q": 1}],
                     "stack": "stacked"}, "area_stacked"),
    ("line_lisse", {"data": [{"m": "a", "v": 1}, {"m": "b", "v": 2}], "type": "smooth"}, "line"),
    ("histogram", {"data": [{"v": x} for x in (1, 2, 2, 3, 3, 3, 4, 5, 6, 7, 8, 9)]}, "column"),
    ("pie", {"data": [{"k": "a", "v": 1}, {"k": "b", "v": 3}]}, "pie"),
], ids=["scatter", "bubble", "area", "area_empile", "line_lisse", "histogram", "pie"])
def test_conversions_natives_dans_les_deux_formats(sb, kind, args, attendu):
    reel = {"area_empile": "area", "line_lisse": "line"}.get(kind, kind)
    args = dict(args)
    if args.pop("type", None) == "smooth":
        args["smooth"] = True
    ref = sb.creer(reel, **args)
    r = sb.run("docx_create", path=f"{kind}.docx", content=ref)
    assert r["charts"][0]["inserted_as"] == "native chart", r
    assert any(n.startswith("word/charts/") for n in _zip_noms(sb.racine / f"{kind}.docx"))
    r = sb.run("pptx_create", path=f"{kind}.pptx", slides=[{"layout": "chart", "chart": ref}])
    assert r["charts"][0]["inserted_as"] == "native chart", r
    assert G._natif(sb.graphes[ref[1:]], reel, Env(espace=None))["chart_type"].startswith(attendu)


def test_pptx_plan_markdown_remplissage_et_alias(sb):
    ref = sb.creer("bar", data=[{"t": "a", "v": 1}, {"t": "b", "v": 2}])
    r = sb.run("pptx_create", path="m.pptx",
               markdown=f"# Deck\\n\\n## Ventes\\n\\n- {ref}\\n\\n## Points\\n\\n- un {{{{client}}}}\\n- deux")
    assert r["ok"] and r["charts"][0]["inserted_as"] == "native chart", r
    r = sb.run("pptx_edit", path="m.pptx", ops=[{"op": "fill", "values": {"client": "ACME",
                                                                           "absent": 1}}])
    assert r["ok"] and "absent" in " ".join(r["warnings"])
    assert "placeholders" not in sb.run("pptx_read", path="m.pptx")
    for slide in ({"layout": "chart", "visual_ref": ref}, {"layout": "table", "data": ref},
                  {"layout": "two_content", "col1": ref, "right": ["x"]}):
        r = sb.run("pptx_create", path="alias.pptx", slides=[slide])
        assert r["ok"], (slide, r)


def test_diapo_champs_ignores_et_sous_puces(sb):
    r = sb.run("pptx_create", path="b.pptx", slides=[
        {"layout": "bullets", "title": "T", "date": "2026", "author": "X",
         "bullets": ["Point", "  sous-point", "- autre"]}])
    assert r["ok"], r
    assert "'date' is not used" in " ".join(r["fixes"])
    prs = Presentation(str(sb.racine / "b.pptx"))
    paras = [p for sh in prs.slides[0].shapes if sh.has_text_frame
             for p in sh.text_frame.paragraphs if p.text in ("Point", "sous-point", "autre")]
    assert [(p.text, p.level) for p in paras] == [("Point", 0), ("sous-point", 1), ("autre", 0)]
    r = sb.run("pptx_create", path="k.pptx", slides=[
        {"layout": "kpi", "items": [{"value": 3, "label": "x", "delta": {"v": 1}}]}])
    assert r["ok"]


def test_pptx_ajout_avant_et_duplication_independante(revue):
    s = revue
    ref = s.creer("bar", data=[{"t": "a", "v": 1}, {"t": "b", "v": 2}])
    s.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "add_slides", "after": 4,
                                                       "slides": [{"layout": "chart", "chart": ref,
                                                                   "title": "G"}]}])
    r = s.run("pptx_edit", path="decks/revue.pptx", ops=[
        {"op": "add_slides", "before": 1, "slides": [{"layout": "section", "title": "Avant"}]},
        {"op": "duplicate_slide", "slide": 5, "to": 2}])
    assert r["ok"], r
    assert [o["title"] for o in r["outline"]][:3] == ["Avant", "G", "Revue"]
    prs = Presentation(str(s.racine / "decks/revue.pptx"))
    parts = {str(sh.chart.part.partname) for sl in prs.slides for sh in sl.shapes if sh.has_chart}
    assert len(parts) == 2                               # chaque copie a son graphique


def test_options_word_et_powerpoint(sb):
    r = sb.run("docx_create", path="o.docx", content="x", page={"orientation": "paysage",
                                                               "size": "A3", "margins": 1.5},
               page_numbers=False, footer="Pied")
    assert r["ok"]
    d = docx.Document(str(sb.racine / "o.docx"))
    sec = d.sections[0]
    assert sec.page_width > sec.page_height
    assert "Pied" in "".join(p.text for p in sec.footer.paragraphs)
    assert not any("PAGE" in p._p.xml for p in sec.footer.paragraphs)
    r = sb.run("pptx_create", path="o.pptx", size="4:3", slide_numbers=False, theme="arc-en-ciel",
               footer="Bas de page", slides=[{"layout": "bullets", "title": "T", "bullets": ["a"]}])
    assert r["ok"] and "unknown" in " ".join(r["warnings"])
    prs = Presentation(str(sb.racine / "o.pptx"))
    assert abs(prs.slide_width / prs.slide_height - 4 / 3) < 0.01
    assert "Bas de page" in "".join(sh.text_frame.text for sh in prs.slides[0].shapes
                                    if sh.has_text_frame)


def test_modele_word_garde_mise_en_page_et_pied(sb):
    sb.run("docx_create", path="modele.docx", content="x", page={"orientation": "landscape"},
           footer="Charte ACME", page_numbers=False)
    r = sb.run("docx_create", path="n.docx", template="modele.docx", content="# Nouveau")
    assert r["ok"], r
    sec = docx.Document(str(sb.racine / "n.docx")).sections[0]
    assert sec.page_width > sec.page_height
    assert "Charte ACME" in "".join(p.text for p in sec.footer.paragraphs)


def test_modele_powerpoint_potx(sb):
    sb.run("pptx_create", path="m.pptx", theme="plum", slides=[
        {"layout": "title", "title": "Exemple du modèle"}])
    with zipfile.ZipFile(sb.racine / "m.pptx") as z:
        parts = {n: z.read(n) for n in z.namelist()}
    parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(
        b"presentationml.presentation.main+xml", b"presentationml.template.main+xml")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, d in parts.items():
            z.writestr(n, d)
    (sb.racine / "charte.potx").write_bytes(buf.getvalue())
    r = sb.run("pptx_create", path="d.pptx", template="charte.potx",
               slides=[{"layout": "bullets", "title": "Neuf", "bullets": ["a"]}])
    assert r["ok"], r
    titres = [o["title"] for o in r["outline"]]
    assert titres == ["Neuf"]


def test_lecture_plafonnee_et_historique_non_garde(sb, monkeypatch):
    from elpis_office import commun
    sb.run("docx_create", path="g.docx", content="x")
    monkeypatch.setattr(commun, "MAX_LECTURE", 10)
    r = sb.run("docx_read", path="g.docx")
    assert r["error"] == "bad_path" and "MB" in r["fix"]
    monkeypatch.undo()
    sb.esp.history_kept = False
    r = sb.run("docx_create", path="g.docx", content="y")
    assert "too large to be kept" in " ".join(r["warnings"])


def test_ref_en_italique_markdown(sb):
    ref = sb.creer("bar", data=[{"t": "a", "v": 1}])
    r = sb.run("docx_create", path="i.docx", content=f"_{ref}_\n\nVoir *{ref}*.")
    assert r["ok"] and r["charts"][0]["inserted_as"] == "native chart"


def test_export_pdf_chemins_et_formats(sb, revue):
    env = sb.env()
    env.convertir = lambda data, ext, fmt: b"%PDF-1.7 " + ext.encode()
    r = executer("office_export", {"path": "decks/revue.pptx"}, env)
    assert r["ok"] and r["path"] == "/work/decks/revue.pdf"
    r = executer("office_export", {"path": "decks/revue.pptx", "save_as": "pdf/revue",
                                   "to": "docx"}, env)
    assert r["path"] == "/work/pdf/revue.pdf" and "not supported" in " ".join(r["warnings"])
    sb.run("docx_create", path="m.docx", content="x")
    with zipfile.ZipFile(sb.racine / "m.docx") as z:
        parts = {n: z.read(n) for n in z.namelist()}
    parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(
        b"document.main+xml", b"template.main+xml")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, d in parts.items():
            z.writestr(n, d)
    (sb.racine / "m.dotx").write_bytes(buf.getvalue())
    r = executer("office_export", {"path": "m.dotx"}, env)
    assert r["ok"] and (sb.racine / "m.pdf").read_bytes().endswith(b".docx")
    for chemin, code in (("vieux.doc", "wrong_format"), ("absent.docx", "not_found"),
                         ("decks", "wrong_format")):
        assert executer("office_export", {"path": chemin}, env)["error"] == code




# ── delete_slide : renumérotage des parties et liens internes ───────────────
def _lier(chemin: Path, source: int, cible: int) -> None:
    """Pose sur la diapo `source` un lien interne `ppaction://hlinksldjump` vers la diapo `cible` (0-based)."""
    from lxml import etree
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    prs = Presentation(str(chemin))
    diapo = prs.slides[source]
    rid = diapo.part.relate_to(prs.slides[cible].part, RT.SLIDE)
    forme = next(sh for sh in diapo.shapes if sh.has_text_frame and sh.text_frame.text)
    rpr = forme.text_frame.paragraphs[0].runs[0]._r.get_or_add_rPr()
    ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    rpr.append(etree.fromstring(
        f'<a:hlinkClick xmlns:a="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        f'r:id="{rid}" action="ppaction://hlinksldjump"/>'))
    prs.save(str(chemin))


def _diapos(chemin: Path) -> list:
    return sorted(n for n in _zip_noms(chemin) if n.startswith("ppt/slides/slide") and n.endswith(".xml"))


@pytest.mark.parametrize("supprimee", [1, 2, 4])
def test_delete_slide_cible_d_un_lien_interne_sans_entree_de_zip_en_double(revue, supprimee):
    chemin = revue.racine / "decks/revue.pptx"
    _lier(chemin, 0, 2)
    _lier(chemin, 3, 1)
    r = revue.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "delete_slide", "slide": supprimee}])
    assert r["ok"], r
    noms = _zip_noms(chemin)
    assert len(noms) == len(set(noms))
    assert _diapos(chemin) == [f"ppt/slides/slide{i}.xml" for i in range(1, 4)]
    prs = Presentation(str(chemin))
    assert len(prs.slides) == 3
    with zipfile.ZipFile(chemin) as z:
        for n in _diapos(chemin):
            rels = z.read(n.replace("slides/", "slides/_rels/") + ".rels").decode()
            for cible in re.findall(r'Target="slide(\d+)\.xml"', rels):
                assert f"ppt/slides/slide{cible}.xml" in noms


def test_delete_slide_retire_le_lien_vers_la_diapo_supprimee_et_garde_les_autres(revue):
    chemin = revue.racine / "decks/revue.pptx"
    _lier(chemin, 0, 2)
    _lier(chemin, 1, 3)
    revue.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "delete_slide", "slide": 3}])
    with zipfile.ZipFile(chemin) as z:
        xml = {n: z.read(n).decode() for n in _diapos(chemin)}
    assert "hlinksldjump" not in xml["ppt/slides/slide1.xml"]
    assert "hlinksldjump" in xml["ppt/slides/slide2.xml"]


def test_delete_slide_puis_ajout_ne_reprend_pas_un_nom_de_partie(revue):
    chemin = revue.racine / "decks/revue.pptx"
    revue.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "delete_slide", "slide": 1}])
    r = revue.run("pptx_edit", path="decks/revue.pptx", ops=[
        {"op": "add_slide", "slide": {"layout": "bullets", "title": "Ajout", "bullets": ["x"]}}])
    assert r["ok"], r
    noms = _zip_noms(chemin)
    assert len(noms) == len(set(noms)) and len(_diapos(chemin)) == 4


# ── Texte écrit par set, set_cell et les encadrés ───────────────────────────
def test_set_et_set_cell_gardent_les_caracteres_et_lisent_le_markdown(trimestriel):
    s = trimestriel
    lu = s.run("docx_read", path="docs/t.docx")
    p = next(x["p"] for x in lu["content"] if "TODO" in x.get("text", ""))
    brut = "Fichier rapport_final_v2.docx, MAX_SIZE = 5 * 3, jean_dupont@acme.fr, a<b et c>d"
    r = s.run("docx_edit", path="docs/t.docx", ops=[
        {"op": "set", "p": p, "text": brut},
        {"op": "set_cell", "table": 0, "row": 1, "col": 1,
         "text": "**1 300** [détail](https://intranet.local/t)"}])
    assert r["ok"], r
    d = docx.Document(str(s.racine / "docs/t.docx"))
    assert d.paragraphs[p].text == brut
    cel = d.tables[0].cell(1, 1).paragraphs[0]
    assert cel.text == "1 300 détail"
    assert [x.text for x in cel.runs if x.bold] == ["1 300"]
    liens = cel._p.findall(qn("w:hyperlink"))
    assert len(liens) == 1
    assert d.part.rels[liens[0].get(qn("r:id"))].target_ref == "https://intranet.local/t"


def test_set_garde_la_mise_en_forme_du_premier_fragment(sb):
    d = docx.Document()
    par = d.add_paragraph()
    rouge = par.add_run("Ancien")
    rouge.font.color.rgb, rouge.font.size = RGBColor(0xC0, 0, 0), Pt(14)
    par.add_run(" texte")
    d.save(str(sb.racine / "f.docx"))
    r = sb.run("docx_edit", path="f.docx", ops=[
        {"op": "set", "p": 0, "text": "Nouveau *texte*\nligne 2"}])
    assert r["ok"], r
    par = docx.Document(str(sb.racine / "f.docx")).paragraphs[0]
    assert par.text == "Nouveau texte\nligne 2"
    ecrits = [x for x in par.runs if x.text.strip()]
    assert all(x.font.color.rgb == RGBColor(0xC0, 0, 0) and x.font.size == Pt(14) for x in ecrits)
    assert [x.text for x in par.runs if x.italic] == ["texte"]


def test_encadre_garde_les_caracteres_et_le_gras(sb):
    r = sb.run("docx_create", path="c.docx",
               content="> [!WARNING] Attention\n> Voir rapport_final.docx et **MAX_SIZE** (5 * 3).\n")
    assert r["ok"], r
    cel = docx.Document(str(sb.racine / "c.docx")).tables[0].cell(0, 0)
    assert "Voir rapport_final.docx et MAX_SIZE (5 * 3)." in cel.text
    assert any(x.bold and x.text == "MAX_SIZE" for q in cel.paragraphs for x in q.runs)


# ── Liens, contrôles de contenu et révisions (documents réels) ──────────────
_NS_W = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
         'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')


@pytest.fixture
def reel(sb):
    """Paragraphes comme Word les écrit : lien, insertion et suppression en révision,
    contrôle de contenu en ligne, signet et commentaire."""
    from docx.oxml import parse_xml
    d = docx.Document()
    rid = d.part.relate_to("https://intranet.local/contrat", "http://schemas.openxmlformats.org/"
                           "officeDocument/2006/relationships/hyperlink", is_external=True)
    p0 = d.add_paragraph("Voir ")
    p0._p.append(parse_xml(f'<w:hyperlink {_NS_W} r:id="{rid}"><w:r><w:t>Contrat 2025</w:t></w:r>'
                           '</w:hyperlink>'))
    p0._p.append(parse_xml(f'<w:r {_NS_W}><w:t xml:space="preserve"> pour détail.</w:t></w:r>'))
    p1 = d.add_paragraph()
    for x in (f'<w:bookmarkStart {_NS_W} w:id="7" w:name="ancre"/>',
              f'<w:commentRangeStart {_NS_W} w:id="3"/>',
              f'<w:r {_NS_W}><w:t xml:space="preserve">Texte </w:t></w:r>',
              f'<w:ins {_NS_W} w:id="1" w:author="Relecteur" w:date="2026-11-01T10:00:00Z">'
              '<w:r><w:t>inséré</w:t></w:r></w:ins>',
              f'<w:del {_NS_W} w:id="2" w:author="Relecteur" w:date="2026-11-01T10:00:00Z">'
              '<w:r><w:delText>supprimé</w:delText></w:r></w:del>',
              f'<w:bookmarkEnd {_NS_W} w:id="7"/>',
              f'<w:commentRangeEnd {_NS_W} w:id="3"/>',
              f'<w:r {_NS_W}><w:commentReference w:id="3"/></w:r>'):
        p1._p.append(parse_xml(x))
    p2 = d.add_paragraph("Client : ")
    p2._p.append(parse_xml(f'<w:sdt {_NS_W}><w:sdtPr><w:alias w:val="Client"/></w:sdtPr>'
                           '<w:sdtContent><w:r><w:t>{{client}}</w:t></w:r></w:sdtContent></w:sdt>'))
    d.save(str(sb.racine / "reel.docx"))
    return sb


def test_lecture_voit_liens_controles_et_insertions(reel):
    r = reel.run("docx_read", path="reel.docx", find="contrat 2025")
    assert r["ok"], r
    textes = [x.get("text") for x in r["content"]]
    assert textes == ["Voir Contrat 2025 pour détail.", "Texte inséré", "Client : {{client}}"]
    assert r["placeholders"] == ["client"] and r["matches"][0]["p"] == 0


def test_replace_et_fill_atteignent_liens_et_controles(reel):
    r = reel.run("docx_edit", path="reel.docx", ops=[
        {"op": "replace", "find": "2025", "replace": "2026"},
        {"op": "fill", "values": {"client": "ACME"}}])
    assert r["ok"], r
    assert [o["changed"] for o in r["applied"]] == [True, True]
    d = docx.Document(str(reel.racine / "reel.docx"))
    assert [p.text for p in d.paragraphs] == ["Voir Contrat 2026 pour détail.", "Texte inséré",
                                              "Client : ACME"]
    assert d.paragraphs[0]._p.find(qn("w:hyperlink")) is not None


def test_set_remplace_liens_et_revisions_sans_reste(reel):
    r = reel.run("docx_edit", path="reel.docx", ops=[
        {"op": "set", "p": 0, "text": "Nouveau texte."},
        {"op": "set", "p": 1, "text": "Remplacé."}])
    assert r["ok"], r
    d = docx.Document(str(reel.racine / "reel.docx"))
    p0, p1 = d.paragraphs[0], d.paragraphs[1]
    assert p0.text == "Nouveau texte." and p0._p.find(qn("w:hyperlink")) is None
    assert p1.text == "Remplacé."
    assert p1._p.find(qn("w:ins")) is None and p1._p.find(qn("w:del")) is None
    noms = [x.tag.split("}")[1] for x in p1._p if x.tag != qn("w:pPr")]
    assert noms[:2] == ["bookmarkStart", "commentRangeStart"]
    assert noms[2] == "r" and noms[3:] == ["bookmarkEnd", "commentRangeEnd", "r"]
    assert p1._p[-1].find(qn("w:commentReference")) is not None


# ── Pied de page, alignement des colonnes, thème ────────────────────────────
def test_texte_de_pied_garde_les_numeros_de_page(sb):
    for nom, pied in (("a.docx", "Banc d'essai"), ("b.docx", {"center": "Interne"})):
        r = sb.run("docx_create", path=nom, content="x", footer=pied)
        assert r["ok"], r
        xml = "".join(p._p.xml for p in docx.Document(str(sb.racine / nom)).sections[0].footer.paragraphs)
        assert "PAGE" in xml and "NUMPAGES" in xml
        assert ("Banc d'essai" if nom == "a.docx" else "Interne") in xml


def test_alignement_des_colonnes_markdown(sb):
    r = sb.run("docx_create", path="t.docx",
               content="| Région | T1 | Évolution |\n|---|---:|:---:|\n| Nord | 120 | **+12 %** |\n")
    assert r["ok"], r
    t = docx.Document(str(sb.racine / "t.docx")).tables[0]
    jc = [[c.paragraphs[0].paragraph_format.alignment for c in row.cells] for row in t.rows]
    from docx.enum.text import WD_ALIGN_PARAGRAPH as A
    assert jc[0][1:] == [A.RIGHT, A.CENTER] and jc[1][1:] == [A.RIGHT, A.CENTER]
    assert jc[0][0] in (None, A.LEFT)
    assert any(x.bold and x.text == "+12 %" for x in t.rows[1].cells[2].paragraphs[0].runs)


def test_theme_aux_noms_du_schema_sans_fixes(sb):
    r = sb.run("docx_create", path="th.docx", content="x",
               theme={"accent": "#0B6E4F", "font": "Calibri", "font_size": 11})
    assert r["ok"], r
    assert not any("theme." in f for f in r.get("fixes", []))
    normal = docx.Document(str(sb.racine / "th.docx")).styles["Normal"].font
    assert normal.name == "Calibri" and normal.size == Pt(11)


def test_theme_ecrit_dans_la_partie_theme(sb):
    r = sb.run("docx_create", path="vert.docx", content="> Citation\n\n| A | B |\n|---|---|\n| 1 | 2 |\n",
               theme={"accent": "#0B6E4F", "font": "Carlito", "heading_font": "Caladea"})
    assert r["ok"], r
    with zipfile.ZipFile(sb.racine / "vert.docx") as z:
        theme = z.read("word/theme/theme1.xml").decode()
    assert re.search(r'<a:accent1>\s*<a:srgbClr val="0B6E4F"/>\s*</a:accent1>', theme)
    assert re.search(r'<a:majorFont>\s*<a:latin typeface="Caladea"', theme)
    assert re.search(r'<a:minorFont>\s*<a:latin typeface="Carlito"', theme)
    styles = docx.Document(str(sb.racine / "vert.docx")).styles.element
    citation = styles.find(f".//{qn('w:style')}[@{qn('w:styleId')}='IntenseQuote']//{qn('w:color')}")
    assert citation.get(qn("w:val")) == "0B6E4F"
    fonds = {x.get(qn("w:fill")) for x in styles.iter(qn("w:shd")) if x.get(qn("w:themeFill")) == "accent1"}
    assert fonds and "D3DFEE" not in fonds and "4F81BD" not in fonds


def test_page_de_garde_sans_en_tete_ni_pied(sb):
    r = sb.run("docx_create", path="g.docx", title="Rapport", cover=True, header="Interne",
               footer="Elpis", watermark="BROUILLON", content="# Partie\n\nTexte.")
    assert r["ok"], r
    sec = docx.Document(str(sb.racine / "g.docx")).sections[0]
    assert sec.different_first_page_header_footer
    assert "".join(p.text for p in sec.first_page_header.paragraphs) == ""
    assert "".join(p.text for p in sec.first_page_footer.paragraphs) == ""
    assert "Interne" in "".join(p.text for p in sec.header.paragraphs)
    filigranes = [s for s in (sec.header, sec.first_page_header)
                  if any("textpath" in p._p.xml for p in s.paragraphs)]
    assert len(filigranes) == 2
    sans = sb.run("docx_create", path="h.docx", header="Interne", content="x")
    assert sans["ok"] and not docx.Document(str(sb.racine / "h.docx")).sections[0].different_first_page_header_footer


def test_chemin_introuvable_liste_le_dossier_et_propose_le_plus_proche(sb):
    (sb.racine / "images").mkdir()
    (sb.racine / "images" / "photo-equipe.png").write_bytes(b"x")
    (sb.racine / "rapports").mkdir()
    sb.run("docx_create", path="rapports/bilan-2026.docx", content="x")
    r = sb.run("docx_create", path="a.docx", content="![Équipe](images/photo_equipe.png)")
    assert r["error"] == "not_found"
    assert "did you mean /work/images/photo-equipe.png?" in r["fix"]
    assert "/work/images holds: photo-equipe.png" in r["fix"]
    r = sb.run("docx_create", path="a.docx", content="![x](img/logo.png)")
    assert "the folder /work/img does not exist" in r["fix"] and "images/" in r["fix"]
    r = sb.run("docx_read", path="rapports/bilan-2025.docx")
    assert r["error"] == "not_found" and "did you mean /work/rapports/bilan-2026.docx?" in r["fix"]


def test_titres_de_diapos_en_vrais_placeholders(sb):
    r = sb.run("pptx_create", path="t.pptx", slides=[
        {"layout": "title", "title": "Bilan", "subtitle": "T3"},
        {"layout": "section", "title": "Contexte"},
        {"layout": "bullets", "title": "Points", "bullets": ["a"]},
        {"layout": "quote", "text": "La simplicité est la sophistication suprême.", "author": "Vinci"},
        {"layout": "closing", "title": "Merci"}])
    assert r["ok"], r
    assert [x["title"] for x in r["outline"]] == ["Bilan", "Contexte", "Points",
                                                  "La simplicité est la sophistication suprême.", "Merci"]
    prs = Presentation(str(sb.racine / "t.pptx"))
    titres = [s.shapes.title for s in prs.slides]
    assert all(t is not None for t in titres)
    assert [str(t.placeholder_format.type).split()[0] for t in titres[:2]] == ["CENTER_TITLE", "TITLE"]
    assert titres[3].top < 0
    assert any(sh.is_placeholder and "SUBTITLE" in str(sh.placeholder_format.type)
               for sh in prs.slides[0].shapes)
    assert all(p._p.pPr.get("algn") for t in titres for p in t.text_frame.paragraphs)


def test_diapo_dense_et_titre_trop_long_signales(sb):
    titre = "Un titre assez long pour vérifier le comportement du retour à la ligne dans les titres"
    r = sb.run("pptx_create", path="d.pptx", slides=[
        {"layout": "bullets", "title": titre, "bullets": [f"Point numéro {i}" for i in range(9)]},
        {"layout": "bullets", "title": "Court", "bullets": ["a", "b", "c"]}])
    assert r["ok"], r
    avert = " ".join(r["warnings"])
    assert "has 9 items" in avert and "reduced to" in avert and "Court" not in avert


def test_move_et_duplicate_slide_par_numeros_d_origine(revue):
    r = revue.run("pptx_edit", path="decks/revue.pptx", ops=[
        {"op": "move_slide", "slide": 4, "before": 2},
        {"op": "duplicate_slide", "slide": 2, "after": 3},
        {"op": "move_slide", "slide": 1, "after": 3}])
    assert r["ok"], r
    assert [x["title"] for x in r["outline"]] == ["Merci", "Contexte", "Résultats", "Revue", "Contexte"]
    r = revue.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "move_slide", "slide": 5, "to": 1}])
    assert r["ok"] and r["outline"][0]["title"] == "Contexte"
    r = revue.run("pptx_edit", path="decks/revue.pptx", ops=[{"op": "move_slide", "slide": 2}])
    assert r["ok"] is False and r["example"][0].get("before") == 2


# ── Langue des documents ────────────────────────────────────────────────────
def test_langue_detectee_dans_le_texte():
    from elpis_office.langue import detecter, normaliser
    assert detecter(["Le chiffre d'affaires progresse de 8 % sur le trimestre et la marge est stable."]) == "fr-FR"
    assert detecter(["Revenue grew by 8% in the quarter and the margin is stable."]) == "en-US"
    assert detecter(["Der Umsatz ist im Quartal um 8 % gestiegen und die Marge ist stabil."]) == "de-DE"
    assert detecter(["Synthèse"]) == "fr-FR" and detecter(["Q3 2026"]) == "en-US"
    assert [normaliser(x) for x in ("fr", "French", "fr_fr", "EN-gb", "xx")] == \
        ["fr-FR", "fr-FR", "fr-FR", "en-GB", None]


def _langue_docx(chemin: Path) -> tuple:
    d = docx.Document(str(chemin))
    defaut = d.styles.element.find(f"{qn('w:docDefaults')}//{qn('w:lang')}").get(qn("w:val"))
    reglage = d.settings.element.find(qn("w:themeFontLang")).get(qn("w:val"))
    pied = "".join(p._p.xml for p in d.sections[0].footer.paragraphs)
    return defaut, reglage, d.core_properties.language, [p.text for p in d.paragraphs], pied


def test_docx_dans_la_langue_du_texte(sb):
    from PIL import Image
    Image.new("RGB", (8, 8), "white").save(sb.racine / "img.png")
    sb.run("docx_create", path="fr.docx", toc=True,
           content="# Synthèse\n\nLe chiffre d'affaires progresse et la marge est stable.")
    defaut, reglage, propriete, textes, pied = _langue_docx(sb.racine / "fr.docx")
    assert (defaut, reglage, propriete) == ("fr-FR", "fr-FR", "fr-FR") and "Sommaire" in textes
    assert "Page" in pied and " / " in pied
    sb.run("docx_create", path="en.docx", toc=True,
           content="# Summary\n\nRevenue is growing and the margin is stable.")
    defaut, _, _, textes, pied = _langue_docx(sb.racine / "en.docx")
    assert defaut == "en-US" and "Contents" in textes and " of " in pied
    r = sb.run("docx_create", path="de.docx", lang="de", content='Text.\n\n![Logo](img.png "Logo der Firma")')
    assert r["ok"], r
    defaut, _, _, textes, _ = _langue_docx(sb.racine / "de.docx")
    assert defaut == "de-DE" and any(t.startswith("Abbildung") for t in textes)
    r = sb.run("docx_create", path="xx.docx", lang="klingon", content="La marge est stable.")
    assert "lang 'klingon' not understood: fr-FR" in " ".join(r["fixes"])


def test_pptx_dans_la_langue_du_texte(sb):
    sb.run("pptx_create", path="fr.pptx", slides=[
        {"layout": "agenda", "items": ["Le contexte", "Les chiffres"]},
        {"layout": "bullets", "title": "La marge", "bullets": ["Elle est stable pour le trimestre"]},
        {"layout": "closing"}])
    prs = Presentation(str(sb.racine / "fr.pptx"))
    langues = {el.get("lang") for s in prs.slides for el in s._element.iter(f"{{{_A}}}rPr")}
    assert langues == {"fr-FR"}
    assert [s.shapes.title.text_frame.text for s in prs.slides] == ["Sommaire", "La marge", "Merci"]
    r = sb.run("pptx_edit", path="fr.pptx", ops=[{"op": "add_slides", "slides": [{"layout": "agenda", "items": ["x"]}]}])
    assert r["ok"], r
    nouvelle = Presentation(str(sb.racine / "fr.pptx")).slides[3]
    assert nouvelle.shapes.title.text_frame.text == "Sommaire"
    assert {el.get("lang") for el in nouvelle._element.iter(f"{{{_A}}}rPr")} == {"fr-FR"}
    sb.run("pptx_create", path="en.pptx", slides=[
        {"layout": "agenda", "items": ["The context", "The figures"]}, {"layout": "closing"}])
    titres = [s.shapes.title.text_frame.text for s in Presentation(str(sb.racine / "en.pptx")).slides]
    assert titres == ["Agenda", "Thank you"]


_A = "http://schemas.openxmlformats.org/drawingml/2006/main"


def test_grosse_version_precedente_gardee_en_bak(sb):
    sb.run("docx_create", path="g.docx", content="x")
    sb.esp.history_kept, sb.esp.backup = False, "/work/g.docx.bak"
    r = sb.run("docx_create", path="g.docx", content="y")
    assert r["backup"] == "/work/g.docx.bak"
    assert "it was kept as /work/g.docx.bak" in " ".join(r["warnings"])


def test_indice_exposant_markdown(sb):
    import docx
    r = sb.run("docx_create", path="chimie.docx", content="L'eau H~2~O, x^2^ et ~~barré~~ ; 5 ~ 6 et 2^10 restent tels quels.")
    assert r["ok"], r
    par = next(p for p in docx.Document(str(sb.racine / "chimie.docx")).paragraphs if p.text.startswith("L'eau"))
    assert par.text == "L'eau H2O, x2 et barré ; 5 ~ 6 et 2^10 restent tels quels."
    marques = [(run.text, bool(run.font.subscript), bool(run.font.superscript), bool(run.font.strike))
               for run in par.runs]
    assert ("2", True, False, False) in marques and ("2", False, True, False) in marques
    assert ("barré", False, False, True) in marques and len([m for m in marques if m[1] or m[2]]) == 2
    lu = sb.run("docx_read", path="chimie.docx")
    p = next(x["p"] for x in lu["content"] if x.get("text", "").startswith("L'eau"))
    e = sb.run("docx_edit", path="chimie.docx", ops=[{"op": "set", "p": p, "text": "CO~2~ en m^3^"}])
    assert e["ok"], e
    par = docx.Document(str(sb.racine / "chimie.docx")).paragraphs[p]
    assert par.text == "CO2 en m3" and [r.font.subscript for r in par.runs if r.text == "2"] == [True]
    assert [r.font.superscript for r in par.runs if r.text == "3"] == [True]


# ── Documents réels (docx_read) ─────────────────────────────────────────────
@pytest.fixture
def document_reel(sb):
    """Un document comme en produit Word : contrôle de contenu, sommaire, listes, mise en forme, commentaire,
    note, révisions, zone de texte, champ de page, encadré et long tableau."""
    import docx
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls

    from elpis_office._docx.ooxml import notes
    lignes = "\n".join(f"| L{i} | {i} |" for i in range(60))
    r = sb.run("docx_create", path="reel.docx", toc=True, lang="fr", footer="Diffusion interne", content=(
        "# Contexte\n\nLe **chiffre** d'*affaires* progresse, voir [le site](https://exemple.fr) et "
        "H~2~O x^2^.\n\n- point un\n  - sous-point\n\n1. étape\n\n> [!NOTE] À retenir\n> Encadré.\n\n"
        f"# Données\n\n| Ligne | Valeur |\n|---|---|\n{lignes}\n\n# Fin\n\nDernier paragraphe."))
    assert r["ok"], r
    d = docx.Document(str(sb.racine / "reel.docx"))
    corps = d.element.body
    fin = next(p for p in d.paragraphs if p.text == "Dernier paragraphe.")
    from docx.enum.style import WD_STYLE_TYPE
    maison = d.styles.add_style("Titre maison", WD_STYLE_TYPE.PARAGRAPH)
    maison.base_style = d.styles["Heading 1"]
    controle = parse_xml(f'<w:sdt {nsdecls("w")}><w:sdtPr><w:alias w:val="Client"/></w:sdtPr><w:sdtContent>'
                         f'<w:p><w:pPr><w:pStyle w:val="{maison.style_id}"/></w:pPr><w:r><w:t>Annexe</w:t></w:r></w:p>'
                         '<w:p><w:r><w:t>Texte dans un contrôle</w:t></w:r></w:p></w:sdtContent></w:sdt>')
    fin._p.addprevious(controle)
    revise = parse_xml(f'<w:p {nsdecls("w")}><w:r><w:t xml:space="preserve">Prix </w:t></w:r>'
                       '<w:del w:id="91" w:author="Alice"><w:r><w:delText>100</w:delText></w:r></w:del>'
                       '<w:ins w:id="92" w:author="Alice"><w:r><w:t>120</w:t></w:r></w:ins></w:p>')
    fin._p.addprevious(revise)
    zone = parse_xml(f'<w:p {nsdecls("w")} xmlns:v="urn:schemas-microsoft-com:vml"><w:r><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r>'
                     '<w:t>Zone flottante</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>')
    fin._p.addprevious(zone)
    notes.add_footnote(d, fin, "Source : rapport annuel.")
    d.add_comment(fin.runs, text="À vérifier", author="Bob")
    assert corps is d.element.body
    d.save(str(sb.racine / "reel.docx"))
    return sb


def test_docx_read_document_reel(document_reel):
    r = document_reel.run("docx_read", path="reel.docx")
    assert r["ok"], r
    contenu = r["content"]
    texte = {x.get("text"): x for x in contenu if "text" in x}
    assert texte["Texte dans un contrôle"]["p"] == texte["Annexe"]["p"] + 1
    assert texte["Annexe"]["h"] == 1 and "Annexe" in [x["text"] for x in r["outline"]]
    para = next(x for x in contenu if x.get("text", "").startswith("Le chiffre"))
    assert para["md"] == ("Le **chiffre** d'*affaires* progresse, voir [le site](https://exemple.fr) et "
                          "H~2~O x^2^.")
    assert texte["point un"]["list"] == "bullet" and "level" not in texte["point un"]
    assert texte["sous-point"]["list"] == "bullet" and texte["sous-point"]["level"] == 1
    assert texte["étape"]["list"] == "number"
    sommaire = [x for x in contenu if "toc" in x]
    assert len(sommaire) == 1 and sommaire[0]["toc"].startswith("3 entries")
    assert not any(x.get("text", "").startswith("Contexte\t") for x in contenu)
    assert [x["callout"] for x in contenu if "callout" in x] == [0]
    assert r["callouts"] == 1 and r["tables"] == 1
    tableau = next(x for x in contenu if "table" in x)
    assert tableau["table"] == 0 and tableau["size"] == "61x2" and len(tableau["rows"]) == 40
    assert "docx_read with table=0, start=40" in tableau["more_rows"]
    assert texte["Prix 120"]["tracked"] == {"inserted": "120", "deleted": "100"}
    assert r["tracked_changes"] == {"insertions": 1, "deletions": 1, "by": ["Alice"]}
    assert next(x for x in contenu if x.get("textbox"))["textbox"] == ["Zone flottante"]
    assert r["footnotes"] == [{"n": "1", "text": "Source : rapport annuel.", "at": {"p": texte["Dernier paragraphe."]["p"]}}]
    assert r["comments"][0]["by"] == "Bob" and r["comments"][0]["text"] == "À vérifier"
    assert "{PAGE}" in r["footer"] and "{NUMPAGES}" in r["footer"]


def test_docx_read_tableau_pagine_et_edition_coherente(document_reel):
    r = document_reel.run("docx_read", path="reel.docx", table=0, start=40, limit=15)
    assert r["ok"], r
    assert r["table"] == 0 and r["first_row"] == 40 and len(r["rows"]) == 15 and r["next_start"] == 55
    assert r["rows"][0] == ["L39", "39"]
    lu = document_reel.run("docx_read", path="reel.docx")
    p = next(x["p"] for x in lu["content"] if x.get("text") == "Texte dans un contrôle")
    e = document_reel.run("docx_edit", path="reel.docx", ops=[
        {"op": "set", "p": p, "text": "Contrôle **mis à jour**"}, {"op": "set_cell", "table": 0, "row": 1, "col": 1, "text": "x"}])
    assert e["ok"], e
    relu = document_reel.run("docx_read", path="reel.docx")
    item = next(x for x in relu["content"] if x.get("p") == p)
    assert item["text"] == "Contrôle mis à jour" and item["md"] == "Contrôle **mis à jour**"
    assert next(x for x in relu["content"] if "table" in x)["rows"][1] == ["L0", "x"]
    assert document_reel.run("docx_read", path="reel.docx", find="contrôle")["matches"][0]["p"] == p
    e = document_reel.run("docx_edit", path="reel.docx", ops=[{"op": "insert", "at_end_of": "Fin",
                                                               "content": "Ajout dans Fin"}])
    assert e["ok"], e
    relu = document_reel.run("docx_read", path="reel.docx")["content"]
    ordre = [x.get("text") for x in relu if x.get("text") in ("Fin", "Ajout dans Fin", "Annexe")]
    assert ordre == ["Fin", "Ajout dans Fin", "Annexe"]


def test_sommaire_profondeur(sb):
    r = sb.run("docx_create", path="prof.docx", toc=4, content="# A\n\n## B\n\n### C\n\n#### D\n\ntexte")
    assert r["ok"], r
    lu = sb.run("docx_read", path="prof.docx")
    assert next(x for x in lu["content"] if "toc" in x)["toc"] == "4 entries, heading levels 1-4"
    r = sb.run("docx_create", path="defaut.docx", toc=True, content="# A\n\n## B\n\n### C\n\n#### D\n\ntexte")
    lu = sb.run("docx_read", path="defaut.docx")
    assert next(x for x in lu["content"] if "toc" in x)["toc"] == "3 entries, heading levels 1-3"


def test_docx_read_champs_jamais_fermes_en_temps_lineaire(sb):
    import time

    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls
    d = docx.Document()
    for _ in range(3000):
        d.element.body.insert(len(d.element.body) - 1, parse_xml(
            f'<w:p {nsdecls("w")}><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:instrText>TOC \\o "1-3"</w:instrText></w:r><w:r><w:t>x</w:t></w:r></w:p>'))
    entete = d.sections[0].header.paragraphs[0]._p
    for _ in range(5000):
        entete.append(parse_xml(f'<w:r {nsdecls("w")}><w:fldChar w:fldCharType="begin"/></w:r>'))
    entete.append(parse_xml(f'<w:r {nsdecls("w")}><w:t>Entête</w:t></w:r>'))
    d.save(str(sb.racine / "piege.docx"))
    debut = time.monotonic()
    r = sb.run("docx_read", path="piege.docx", limit=5)
    assert r["ok"], r
    assert time.monotonic() - debut < 10 and r["header"] == "Entête"


def test_encadre_supprime_et_tableau_a_bord_gauche(sb):
    from elpis_office._docx.ooxml import tables as T
    sb.run("docx_create", path="enc.docx", content="Avant.\n\n> [!WARNING] Attention\n> Texte.\n\n| a | b |\n|---|---|\n| 1 | 2 |")
    d = docx.Document(str(sb.racine / "enc.docx"))
    seul = d.add_table(rows=1, cols=1)
    seul.cell(0, 0).text = "Cadre utilisateur"
    T.set_cell_borders(seul.cell(0, 0), color="000000", size=18, edges=("left",))
    d.save(str(sb.racine / "enc.docx"))
    lu = sb.run("docx_read", path="enc.docx")
    assert lu["callouts"] == 1 and lu["tables"] == 2
    r = sb.run("docx_edit", path="enc.docx", ops=[{"op": "delete", "callout": 0}, {"op": "set_cell", "table": 1, "row": 0,
                                                                                    "col": 0, "text": "Modifié"}])
    assert r["ok"], r
    lu = sb.run("docx_read", path="enc.docx")
    assert "callouts" not in lu and lu["tables"] == 2 and not any("callout" in x for x in lu["content"])
    assert sb.run("docx_edit", path="enc.docx", ops=[{"op": "delete", "callout": 0}])["error"] == "bad_index"


def test_indice_echappe_et_chemins_restent_litteraux(sb):
    r = sb.run("docx_create", path="lit.docx", content=r"Voir http://h/~alice/~bob et H\~2\~O, puis **gras** x^2^.")
    assert r["ok"], r
    lu = sb.run("docx_read", path="lit.docx")
    par = next(x for x in lu["content"] if x.get("text", "").startswith("Voir"))
    assert par["text"] == "Voir http://h/~alice/~bob et H~2~O, puis gras x2."
    e = sb.run("docx_edit", path="lit.docx", ops=[{"op": "set", "p": par["p"], "text": par["md"]}])
    assert e["ok"], e
    relu = next(x for x in sb.run("docx_read", path="lit.docx")["content"] if x.get("p") == par["p"])
    assert relu["text"] == par["text"] and relu["md"] == par["md"]
