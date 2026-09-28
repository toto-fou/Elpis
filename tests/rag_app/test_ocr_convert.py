# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_convert.py — préparation des documents.

Raster PDF réel (pypdfium2, fixture générée à la volée par fpdf2), divergence couche
texte / OCR, et conversion Word avec ``soffice`` SIMULÉ (subprocess patché —
pas de LibreOffice lancé dans la suite).
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path

import pytest

from rag_app.ocr import convert
from rag_app.ocr._common import OcrError

fpdf = pytest.importorskip("fpdf", reason="fpdf2 requis pour la fixture")


def _make_pdf(path, n_pages=2, text="essai de rasterisation"):
    doc = fpdf.FPDF(unit="pt", format=(595, 842))
    doc.set_font("Helvetica", size=14)
    for i in range(n_pages):
        doc.add_page()
        doc.text(72, 100, f"Page {i + 1} - {text}")
    doc.output(str(path))


def test_raster_pdf(tmp_path):
    pdf = tmp_path / "t.pdf"
    _make_pdf(pdf)
    pages, truncated = convert.raster_pdf(
        pdf, tmp_path / "pages", tmp_path / "text",
        max_side_px=1280, max_pages=300)
    assert len(pages) == 2 and truncated is False
    assert pages[0]["n"] == 1
    # Grand côté ≈ max_side_px (A4 portrait → hauteur)
    assert pages[0]["h"] == 1280 and 0 < pages[0]["w"] < 1280
    assert (tmp_path / "pages" / "0001.png").stat().st_size > 1000
    assert "rasterisation" in (tmp_path / "text" / "0001.txt").read_text()
    assert pages[0]["chars"] > 0


def test_raster_pdf_tronque(tmp_path):
    pdf = tmp_path / "t.pdf"
    _make_pdf(pdf, n_pages=3)
    pages, truncated = convert.raster_pdf(
        pdf, tmp_path / "pages", tmp_path / "text",
        max_side_px=640, max_pages=2)
    assert len(pages) == 2 and truncated is True


def test_raster_pdf_illisible(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"pas un pdf")
    with pytest.raises(OcrError):
        convert.raster_pdf(bad, tmp_path / "p", tmp_path / "t",
                           max_side_px=640, max_pages=10)


def test_divergence():
    ref = "le chat mange la souris grise dans le jardin de la maison"
    assert convert.divergence(ref, ref) == 0.0
    assert convert.divergence("", "peu importe") is None           # page scannée
    assert convert.divergence("abc", "abc") is None                # couche trop courte
    d = convert.divergence(ref, "contenu totalement different sans aucun rapport")
    assert d is not None and d > 0.5


def _fake_soffice(tmp_path, body: str) -> str:
    """Faux ``soffice`` (script shell) : docx_to_pdf lance un VRAI process
    (Popen + groupe de process) depuis la passe RAG 2."""
    script = tmp_path / "soffice"
    script.write_text("#!/bin/sh\n" + body)
    script.chmod(0o755)
    return str(script)


def test_docx_to_pdf_soffice_simule(tmp_path, monkeypatch):
    src = tmp_path / "doc.docx"
    src.write_bytes(b"fake docx")
    out = tmp_path / "out"
    # soffice écrit <stem>.pdf dans --outdir ; le profil LO est jetable.
    fake = _fake_soffice(tmp_path, f"""
case "$*" in *--headless*-env:UserInstallation=*) ;; *) exit 3 ;; esac
printf '%%PDF-fake' > "{out}/doc.pdf"
""")
    monkeypatch.setattr(convert, "_soffice_bin", lambda: fake)
    pdf = convert.docx_to_pdf(src, out)
    assert pdf == out / "doc.pdf" and pdf.is_file()


def test_docx_to_pdf_soffice_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(convert, "_soffice_bin", lambda: "")
    with pytest.raises(OcrError, match="soffice"):
        convert.docx_to_pdf(tmp_path / "d.docx", tmp_path / "out")


def test_docx_to_pdf_echec(tmp_path, monkeypatch):
    src = tmp_path / "doc.docx"
    src.write_bytes(b"fake")
    fake = _fake_soffice(tmp_path, "echo boom >&2\nexit 1\n")
    monkeypatch.setattr(convert, "_soffice_bin", lambda: fake)
    with pytest.raises(OcrError, match="échouée") as exc:
        convert.docx_to_pdf(src, tmp_path / "out")
    assert "boom" in str(exc.value)


def test_docx_to_pdf_delai_tue_le_groupe(tmp_path, monkeypatch):
    """Délai dépassé : le GROUPE de process est tué (soffice relance un
    soffice.bin enfant que kill() seul laissait vivre)."""
    src = tmp_path / "doc.docx"
    src.write_bytes(b"fake")
    pidfile = tmp_path / "child.pid"
    fake = _fake_soffice(tmp_path, f"sleep 30 &\necho $! > {pidfile}\nwait\n")
    monkeypatch.setattr(convert, "_soffice_bin", lambda: fake)
    t0 = time.monotonic()
    with pytest.raises(OcrError, match="trop longue"):
        convert.docx_to_pdf(src, tmp_path / "out", timeout_sec=0.5)
    assert time.monotonic() - t0 < 10
    child = int(pidfile.read_text())
    time.sleep(0.2)
    try:
        os.kill(child, 0)
        alive = Path(f"/proc/{child}/stat").read_text().split()[2] != "Z"
    except ProcessLookupError:
        alive = False
    assert not alive, "l'enfant de soffice survit au délai"


def test_docx_to_pdf_annulation(tmp_path, monkeypatch):
    src = tmp_path / "doc.docx"
    src.write_bytes(b"fake")
    fake = _fake_soffice(tmp_path, "sleep 30\n")
    monkeypatch.setattr(convert, "_soffice_bin", lambda: fake)
    ev = threading.Event()
    threading.Timer(0.3, ev.set).start()
    with pytest.raises(convert.PrepareCanceled):
        convert.docx_to_pdf(src, tmp_path / "out", cancel_event=ev)


def test_raster_annulation_et_budget(tmp_path):
    pdf = tmp_path / "t.pdf"
    _make_pdf(pdf, n_pages=3)
    ev = threading.Event()
    ev.set()
    with pytest.raises(convert.PrepareCanceled):
        convert.raster_pdf(pdf, tmp_path / "p1", tmp_path / "t1",
                           max_side_px=320, max_pages=10, cancel_event=ev)
    with pytest.raises(OcrError, match="saturé"):
        convert.raster_pdf(pdf, tmp_path / "p2", tmp_path / "t2",
                           max_side_px=320, max_pages=10, max_bytes=10)
    # aucun PNG temporaire laissé
    assert not list((tmp_path / "p2").glob(".*tmp*"))
