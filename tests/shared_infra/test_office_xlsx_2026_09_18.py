# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_office_xlsx_2026_09_18.py — lecture d'un classeur
.xlsx EN FLUX (remplace la conversion LibreOffice pour la grille de l'éditeur).

Ce qui est verrouillé ici :
  * les valeurs sont rendues « telles qu'affichées » — c'est LibreOffice qui
    le faisait, et un classeur ne doit pas se mettre à montrer 45678 là où il
    montrait 2025-01-15 ;
  * la taille d'une feuille se lit dans son ``<dimension>``, sans parcourir les
    lignes (c'est ce qui rend l'ouverture d'un gros classeur immédiate) ;
  * la lecture est bornée (chaînes partagées, colonnes, caractères) et refuse
    les entités XML ;
  * la grille se prépare SANS LibreOffice : un serveur qui n'en a pas affiche
    quand même les tableurs.
"""
from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path

import pytest

from shared_infra.sandbox import office_preview as op
from shared_infra.sandbox import office_xlsx as ox
from shared_infra.sandbox.office_convert import OfficeError

from tests.shared_infra.test_office_preview import make_ooxml, mini_xlsx


# ─────────────────────────────────────────────────────────────────────────────
#  Rendu des valeurs (fidélité)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("brut,code,attendu", [
    ("45678", "yyyy-mm-dd", "2025-01-21"),          # date par code personnalisé
    ("45678", "mm-dd-yy", "2025-01-21"),            # format intégré 14
    ("45678.5", "m/d/yy h:mm", "2025-01-21 12:00:00"),
    ("0.75", "h:mm:ss", "18:00:00"),
    ("1.5", "[h]:mm:ss", "36:00:00"),               # durée, pas horloge
    ("75.3", "General", "75.3"),
    ("3.0", "General", "3"),
    ("1234.5678", "0.00", "1234.57"),
    ("1234567.891", "#,##0.00", "1,234,567.89"),
    ("0.1234", "0.0%", "12.3%"),
    ("-42", "#,##0;[Red](#,##0)", "-42"),           # 1re section seulement
    ("12", "0", "12"),
])
def test_valeur_rendue_comme_dans_le_tableur(brut, code, attendu):
    assert ox.format_value(brut, None, ox.Format(code)) == attendu


@pytest.mark.parametrize("brut,typ,attendu", [
    ("texte", "s", "texte"),
    ("1", "b", "VRAI"),
    ("0", "b", "FAUX"),
    ("#DIV/0!", "e", "#DIV/0!"),
    (None, None, ""),
    ("pas-un-nombre", None, "pas-un-nombre"),
])
def test_types_de_cellule(brut, typ, attendu):
    assert ox.format_value(brut, typ, ox.GENERAL) == attendu


def test_base_de_dates_1904():
    """Un classeur Mac historique compte à partir de 1904 : la même valeur
    brute n'y désigne pas le même jour."""
    assert ox.format_value("45678", None, ox.Format("yyyy-mm-dd")) == "2025-01-21"
    assert ox.format_value("45678", None, ox.Format("yyyy-mm-dd"), True) == "2029-01-22"


def test_formats_compiles_une_seule_fois():
    """Le coût d'analyse d'un code est payé par STYLE, pas par cellule (mesuré :
    douze fois le temps de lecture quand il l'était par cellule)."""
    formats = ox.compile_formats(["General", "yyyy-mm-dd", "General", "yyyy-mm-dd"])
    assert formats[0] is formats[2] and formats[1] is formats[3]
    assert formats[1].is_date and not formats[0].is_date


def test_reconnaissance_des_dates():
    assert ox.is_date_format("yyyy-mm-dd") and ox.is_date_format("h:mm")
    assert not ox.is_date_format("General") and not ox.is_date_format("0.00")
    # Un littéral ne doit pas faire passer un nombre pour une date.
    assert not ox.is_date_format('0.00" jours"')


# ─────────────────────────────────────────────────────────────────────────────
#  Structure du classeur
# ─────────────────────────────────────────────────────────────────────────────
def test_feuilles_ordre_masquees_et_parties(tmp_path):
    p = mini_xlsx(tmp_path / "a.xlsx", [
        ("Un", [["x"]], {}), ("Caché", [["y"]], {"hidden": True})])
    with zipfile.ZipFile(p) as zf:
        s = ox.sheets(zf)
    assert [x["name"] for x in s] == ["Un", "Caché"]
    assert s[1]["hidden"] is True
    assert s[0]["member"] == "xl/worksheets/sheet1.xml"


@pytest.mark.parametrize("ref,attendu", [
    ("A1:L80001", (80001, 12)),
    ("A1:A1", (1, 1)),
    ("B2", (2, 2)),
])
def test_dimension_lue_dans_l_entete(tmp_path, ref, attendu):
    p = mini_xlsx(tmp_path / f"d{len(ref)}.xlsx", [("S", [["x"]], {"dimension": ref})])
    with zipfile.ZipFile(p) as zf:
        assert ox.dimension(zf, "xl/worksheets/sheet1.xml") == attendu


def test_dimension_absente(tmp_path):
    p = mini_xlsx(tmp_path / "nodim.xlsx", [("S", [["x"]], {})])
    with zipfile.ZipFile(p) as zf:
        assert ox.dimension(zf, "xl/worksheets/sheet1.xml") is None


def test_chaines_partagees_en_flux_et_bornees(tmp_path, monkeypatch):
    p = mini_xlsx(tmp_path / "sst.xlsx", [("S", [["un", "deux", "trois"]], {})])
    with zipfile.ZipFile(p) as zf:
        assert ox.shared_strings(zf) == ["un", "deux", "trois"]
    monkeypatch.setattr(ox, "SST_MAX_ITEMS", 2)
    with zipfile.ZipFile(p) as zf:
        assert len(ox.shared_strings(zf)) == 2


def test_lignes_creuses_colonnes_manquantes_et_chaines_inline(tmp_path):
    p = mini_xlsx(tmp_path / "creux.xlsx", [("S", [
        (1, [("A", "s", "a"), ("D", "s", "d")]),          # trou en B et C
        (3, [("B", "inline", "brut")]),
    ], {"raw": True, "dimension": "A1:D3"})])
    with zipfile.ZipFile(p) as zf:
        sst = ox.shared_strings(zf)
        fmts = ox.compile_formats(ox.number_formats(zf))
        sheet = ox.sheets(zf)[0]
        rows = list(ox.iter_rows(zf, sheet, sst, fmts, max_cols=512, cell_chars=100))
    assert rows[0][0] == 1 and rows[0][1] == ["a", "", "", "d"]
    assert rows[1][0] == 3 and rows[1][1] == ["", "brut"]


def test_colonnes_au_dela_du_plafond_marquent_la_troncature(tmp_path):
    p = mini_xlsx(tmp_path / "large.xlsx", [("S", [["a", "b", "c"]], {})])
    with zipfile.ZipFile(p) as zf:
        sheet = ox.sheets(zf)[0]
        rows = list(ox.iter_rows(zf, sheet, ox.shared_strings(zf),
                                 ox.compile_formats(ox.number_formats(zf)),
                                 max_cols=2, cell_chars=100))
    assert rows[0][1] == ["a", "b"] and rows[0][2] is True


def test_entites_xml_refusees(tmp_path):
    bombe = ('<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY a "aaaa">]>'
             '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<si><t>&a;</t></si></sst>')
    p = mini_xlsx(tmp_path / "ent.xlsx", [("S", [["x"]], {})])
    with zipfile.ZipFile(p, "a") as zf:
        zf.writestr("xl/mechant.xml", bombe)
    with zipfile.ZipFile(p) as zf:
        with pytest.raises(ox.XlsxError):
            ox._safe_open(zf, "xl/mechant.xml")


# ─────────────────────────────────────────────────────────────────────────────
#  Préparation de l'aperçu : plus aucune conversion
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def bac(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_OFFICE_CACHE_DIR", str(tmp_path / "cache"))
    root = tmp_path / "alice" / "work"
    root.mkdir(parents=True)
    return root


def _classeur(root: Path, nom: str = "t.xlsx") -> Path:
    return mini_xlsx(root / nom, [
        ("Données", [["Nom", "Montant", "Date"],
                     ["Alice", "12", "45678"], ["Bob", "13", "45679"]], {"dimension": "A1:C3"}),
        ("Autre", [["x"], ["y"]], {"dimension": "A1:A2"}),
    ])


def test_preparation_sans_libreoffice(bac, monkeypatch):
    """Le tableur s'affiche même si LibreOffice n'est pas installé : la grille
    ne passe plus par lui du tout."""
    monkeypatch.setattr("shared_infra.sandbox.office_convert.soffice_bin", lambda: "")
    _classeur(bac)
    m = asyncio.run(op.prepare(uid=7, user_dir="alice", root=bac, path="t.xlsx"))
    assert m["kind"] == "xlsx" and m["view"] == "grid"
    feuilles = m["grid"]["sheets"]
    assert [f["name"] for f in feuilles] == ["Données", "Autre"]
    assert feuilles[0]["rows"] == 3 and feuilles[0]["cols"] == 3
    f, taille = op.sheet_chunk("alice", m["key"], 0, 0)
    assert json.loads(f.read_text())[0] == ["Nom", "Montant", "Date"]
    assert taille["rows"] == 3 and taille["complete"] is True


def test_morceau_bati_a_la_demande_sur_une_autre_feuille(bac, monkeypatch):
    monkeypatch.setattr("shared_infra.sandbox.office_convert.soffice_bin", lambda: "")
    _classeur(bac)
    m = asyncio.run(op.prepare(uid=7, user_dir="alice", root=bac, path="t.xlsx"))
    # Seule la 1re feuille est bâtie à la préparation ; la 2e l'est ici.
    assert m["grid"]["sheets"][1]["chunks"] == 0
    f, taille = op.sheet_chunk("alice", m["key"], 1, 0)
    assert f is not None and json.loads(f.read_text())[0] == ["x"]
    assert taille["rows"] == 2 and taille["complete"] is True


def test_morceau_hors_feuille_rend_rien(bac, monkeypatch):
    monkeypatch.setattr("shared_infra.sandbox.office_convert.soffice_bin", lambda: "")
    _classeur(bac)
    m = asyncio.run(op.prepare(uid=7, user_dir="alice", root=bac, path="t.xlsx"))
    op.sheet_chunk("alice", m["key"], 0, 0)              # feuille complète
    assert op.sheet_chunk("alice", m["key"], 0, 5)[0] is None
    assert op.sheet_chunk("alice", m["key"], 99, 0)[0] is None


def test_le_classeur_est_copie_dans_le_cache_pas_relu_dans_le_bac(bac, monkeypatch):
    """La grille se bâtit depuis la COPIE : le fichier de la sandbox peut être
    modifié ou supprimé sans que l'aperçu affiché se mette à mentir."""
    monkeypatch.setattr("shared_infra.sandbox.office_convert.soffice_bin", lambda: "")
    src = _classeur(bac)
    m = asyncio.run(op.prepare(uid=7, user_dir="alice", root=bac, path="t.xlsx"))
    src.unlink()
    f, _ = op.sheet_chunk("alice", m["key"], 1, 0)
    assert f is not None and json.loads(f.read_text())[0] == ["x"]


def test_classeur_sans_feuille_lisible(bac):
    make_ooxml(bac / "vide.xlsx", "xlsx")
    with pytest.raises(OfficeError) as e:
        op.xlsx_skeleton(bac / "vide.xlsx")
    assert e.value.code == "invalid"


def test_plafond_de_taille_xlsx_releve():
    """20 à 50 Mo doivent passer : le plafond ne protège plus une conversion,
    seulement la copie dans le cache."""
    assert op.max_bytes("xlsx") >= 50 * 1024 * 1024
