# SPDX-License-Identifier: MIT
"""Aperçus Office avec le VRAI LibreOffice (et bwrap) — lancé explicitement.

    ELPIS_SOFFICE_TESTS=1 pytest tests/shared_infra/test_office_soffice_real.py

Sauté sinon (LibreOffice absent de la CI, conversions de l'ordre de la seconde).
Vérifie ce que les faux ne peuvent pas prouver : la commande bwrap réelle, le
recalcul d'une formule sans valeur en cache (fichier produit par openpyxl), la
détection des feuilles masquées, et qu'un délai dépassé ne laisse aucun
``soffice.bin``. Cf. docs/editor-office-preview-design-2026-09-15.md
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time
import zipfile
from pathlib import Path

import pytest

from shared_infra.sandbox import office_convert as oc
from shared_infra.sandbox import office_preview as op

pytestmark = pytest.mark.skipif(
    os.environ.get("ELPIS_SOFFICE_TESTS") != "1" or not shutil.which("soffice"),
    reason="ELPIS_SOFFICE_TESTS=1 et LibreOffice requis",
)

FIXTURES = Path(__file__).parent / "fixtures_office"


def _xlsx(path: Path) -> None:
    """Classeur minimal écrit à la main : A3 = SUM(A1:A2) SANS valeur en cache,
    seconde feuille masquée."""
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' \
         'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'),
        "xl/workbook.xml": (
            f'<?xml version="1.0" encoding="UTF-8"?><workbook {ns}><sheets>'
            '<sheet name="Données" sheetId="1" r:id="rId1"/>'
            '<sheet name="Caché" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
            '</Relationships>'),
        "xl/worksheets/sheet1.xml": (
            f'<?xml version="1.0" encoding="UTF-8"?><worksheet {ns}><sheetData>'
            '<row r="1"><c r="A1"><v>40</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>'
            '<row r="3"><c r="A3"><f>SUM(A1:A2)</f></c></row></sheetData></worksheet>'),
        "xl/worksheets/sheet2.xml": (
            f'<?xml version="1.0" encoding="UTF-8"?><worksheet {ns}><sheetData>'
            '<row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row></sheetData></worksheet>'),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts.items():
            zf.writestr(name, data)


@pytest.fixture()
def real(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_OFFICE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(oc, "LOCK_DIR", tmp_path / "locks")
    root = tmp_path / "alice" / "work"
    root.mkdir(parents=True)
    from docx import Document
    d = Document()
    for i in range(3):
        d.add_heading(f"Chapitre {i + 1}", 1)
        d.add_paragraph("Texte. " * 50)
        d.add_page_break()
    d.save(root / "rapport.docx")
    _xlsx(root / "calcul.xlsx")
    shutil.copy(FIXTURES / "deux-diapos.pptx", root / "deux-diapos.pptx")
    return root


def _run(coro):
    return asyncio.run(coro)


def test_docx_et_pptx_en_pdf_dans_la_prison(real):
    assert oc.isolation_mode() == "bwrap"
    r = _run(op.prepare(uid=1, user_dir="alice", root=real, path="rapport.docx"))
    assert r["pages"]["count"] >= 3
    pdf = op.pdf_file("alice", r["key"])
    assert pdf.read_bytes().startswith(b"%PDF-")
    p = _run(op.prepare(uid=1, user_dir="alice", root=real, path="deux-diapos.pptx"))
    assert p["pages"]["count"] == 2


def test_xlsx_formule_sans_cache_calculee_et_feuille_masquee(real):
    r = _run(op.prepare(uid=1, user_dir="alice", root=real, path="calcul.xlsx"))
    sheets = r["grid"]["sheets"]
    assert [(s["name"], s["hidden"]) for s in sheets] == [("Données", False), ("Caché", True)]
    rows = __import__("json").loads(op.sheet_chunk_file("alice", r["key"], 0, 0).read_text())
    assert rows == [["40"], ["2"], ["42"]]


def _soffice_pids() -> list:
    out = []
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                if os.readlink(f"/proc/{pid}/exe").endswith("soffice.bin"):
                    out.append(int(pid))
            except OSError:
                pass
    return out


def test_delai_depasse_aucun_soffice_survivant(real, monkeypatch):
    before = set(_soffice_pids())
    monkeypatch.setattr(oc, "cfg", lambda k, d=None: {"timeout_s": 5}.get(k, oc._DEFAULTS.get(k, d)))
    monkeypatch.setattr(oc, "_int_cfg", lambda k, lo, hi: {"timeout_s": 5}.get(k, int(oc._DEFAULTS[k])))
    orig = oc.run_soffice

    async def short(argv, env, *, cwd, log_path, timeout_s):
        return await orig(argv, env, cwd=cwd, log_path=log_path, timeout_s=0.8)
    monkeypatch.setattr(oc, "run_soffice", short)
    with pytest.raises(oc.OfficeError) as e:
        _run(op.prepare(uid=1, user_dir="alice", root=real, path="rapport.docx"))
    assert e.value.code == "timeout"
    time.sleep(0.5)
    assert set(_soffice_pids()) - before == set()
