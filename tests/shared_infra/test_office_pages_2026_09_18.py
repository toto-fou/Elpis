# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_office_pages_2026_09_18.py — aperçu docx/pptx :
les PREMIÈRES PAGES d'abord, le document complet en tâche de fond.

Mesuré avant ce lot (docx de 60 Mo, 120 pages avec photos) : 22 s avant le
premier pixel, dont 1,6 s de chargement — tout le reste est l'export, à ~0,17 s
la page. Douze pages sortent en 2 s : on les rend, et la version complète
remplace l'aperçu quand elle est prête.

Ce qui est verrouillé ici :
  * un document COURT ne paie qu'une conversion (pas de passe de fond) ;
  * un document LONG rend un aperçu ``partial`` et garde une copie du source
    le temps de la passe complète ;
  * la passe complète publie une nouvelle RÉVISION (l'URL change, sinon le
    cache immuable servirait les premières pages à vie) et supprime la copie ;
  * elle ne part qu'une fois (deux onglets ne convertissent pas deux fois).
"""
from __future__ import annotations

import asyncio
import zipfile
from pathlib import Path

import pytest

from shared_infra.sandbox import office_convert as oc, office_preview as op

CT = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
}


def _document(path: Path, kind: str) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml",
                    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                    f'<Override PartName="/main.xml" ContentType="{CT[kind]}"/></Types>')
        zf.writestr("main.xml", "<x/>")
    return path


@pytest.fixture()
def bac(tmp_path, monkeypatch):
    """Sandbox + cache isolés, LibreOffice SIMULÉ : le faux convertisseur rend
    autant de pages que le document en compte, bornées par la plage demandée."""
    monkeypatch.setenv("APP_OFFICE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(oc, "LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr(oc, "soffice_bin", lambda: "/faux/soffice")
    monkeypatch.setattr(oc, "lo_version_token", lambda s: "t")
    monkeypatch.setattr(oc, "isolation_mode", lambda: "none")
    monkeypatch.setattr(oc, "ensure_profile", lambda p: Path(p).mkdir(parents=True, exist_ok=True))

    etat = {"pages_du_document": 40, "plages": [], "lenteur": 0.0}

    async def _faux_soffice(argv, env, *, cwd, log_path, timeout_s):
        plage = next(a for a in argv if a.startswith("pdf:"))
        demande = int(plage.split('"value":"1-')[1].split('"')[0])
        etat["plages"].append(demande)
        if etat["lenteur"]:
            await asyncio.sleep(etat["lenteur"])
        pages = min(demande, etat["pages_du_document"])
        out = Path(cwd) / "out"
        out.mkdir(exist_ok=True)
        (out / "in.pdf").write_bytes(b"%PDF-1.7\n" + b"<</Type/Page>>\n" * pages)
        log_path.write_text("ok\n")
        return 0

    monkeypatch.setattr(oc, "run_soffice", _faux_soffice)
    # La passe de fond est DÉCLENCHÉE explicitement par les tests : lancée en
    # tâche, elle serait tuée par la fin de ``asyncio.run`` au milieu de sa
    # conversion (et le test mesurerait une course, pas une règle).
    etat["planificateur"] = op._schedule_full_pdf          # le vrai, pour qui le teste
    monkeypatch.setattr(op, "_schedule_full_pdf", lambda *a, **k: None)
    root = tmp_path / "alice" / "work"
    root.mkdir(parents=True)
    return root, etat


def _prepare(root: Path, nom: str):
    return asyncio.run(op.prepare(uid=1, user_dir="alice", root=root, path=nom))


@pytest.mark.parametrize("kind", ["docx", "pptx"])
def test_document_long_rend_ses_premieres_pages_puis_le_reste(bac, kind):
    root, etat = bac
    _document(root / f"gros.{kind}", kind)
    m = _prepare(root, f"gros.{kind}")
    tete = op._limit("first_pages")
    assert m["pages"]["count"] == tete and m["pages"]["partial"] is True
    assert etat["plages"] == [tete], "la première passe ne convertit que la tête"
    assert "?r=" not in m["pages"]["url"]
    # Le source est gardé le temps de la passe complète (le relire dans le bac
    # ne serait pas le même document : il a pu changer).
    d = op.key_dir("alice", m["key"])
    assert (d / f"src.{kind}").is_file()

    asyncio.run(op._build_full_pdf(1, "alice", m["key"], kind, f".{kind}"))
    m2 = _prepare(root, f"gros.{kind}")
    assert m2["pages"]["count"] == 40 and m2["pages"]["partial"] is False
    assert m2["pages"]["url"].endswith("?r=1"), "sans révision, le cache servirait la tête"
    assert etat["plages"][-1] == op._limit("max_pages")
    assert not (d / f"src.{kind}").exists(), "la copie ne sert plus à rien"


def test_document_court_ne_paie_qu_une_conversion(bac):
    root, etat = bac
    etat["pages_du_document"] = 3
    _document(root / "court.docx", "docx")
    m = _prepare(root, "court.docx")
    assert m["pages"]["count"] == 3 and m["pages"]["partial"] is False
    assert len(etat["plages"]) == 1
    assert not (op.key_dir("alice", m["key"]) / "src.docx").exists()


def test_la_passe_complete_ne_part_qu_une_fois(bac, monkeypatch):
    root, etat = bac
    _document(root / "gros.docx", "docx")
    m = _prepare(root, "gros.docx")
    planifier = etat["planificateur"]
    lancees = []

    async def _faux_build(uid, user_dir, key, kind, ext):
        lancees.append(key)
        await asyncio.sleep(0.05)

    monkeypatch.setattr(op, "_build_full_pdf", _faux_build)

    async def _deux_fois():
        planifier(1, "alice", m["key"], "docx", ".docx")
        planifier(1, "alice", m["key"], "docx", ".docx")
        await asyncio.sleep(0.2)

    asyncio.run(_deux_fois())
    assert lancees == [m["key"]]


def test_la_passe_complete_ignore_un_apercu_deja_complet(bac):
    root, etat = bac
    etat["pages_du_document"] = 3
    _document(root / "court.docx", "docx")
    m = _prepare(root, "court.docx")
    avant = len(etat["plages"])
    asyncio.run(op._build_full_pdf(1, "alice", m["key"], "docx", ".docx"))
    assert len(etat["plages"]) == avant, "rien à compléter : aucune conversion"


def test_xlsx_en_vue_pages_convertit_d_un_coup(bac):
    """La vue « Pages » d'un tableur garde son plafond dédié (50 pages) et son
    unique passe : un classeur n'a pas de « premières pages » qui vaillent."""
    root, etat = bac
    from tests.shared_infra.test_office_preview import mini_xlsx
    mini_xlsx(root / "t.xlsx", [("S", [["a", "b"], ["1", "2"]], {"dimension": "A1:B2"})])
    m = asyncio.run(op.prepare(uid=1, user_dir="alice", root=root, path="t.xlsx", view="pages"))
    assert m["pages"]["partial"] is False
    assert etat["plages"] == [op._limit("xlsx_max_pages")]


def test_plafonds_de_taille_releves():
    """20 à 100 Mo de docx doivent passer : le plafond ne protège plus un temps
    de conversion (seules les premières pages sont converties à l'ouverture)."""
    assert op.max_bytes("docx") >= 100 * 1024 * 1024
    assert op.max_bytes("pptx") >= 150 * 1024 * 1024
