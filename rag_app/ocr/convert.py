# SPDX-License-Identifier: MIT
"""rag_app.ocr.convert — préparation des documents : docx→PDF, PDF→pages.

Tout est SYNCHRONE (appelé via ``asyncio.to_thread`` par jobs) et les imports
lourds (pypdfium2, fitz) sont tardifs : le paquet reste importable au boot même si la
lib manque (les fonctions lèvent alors une :class:`OcrError` explicite).

- :func:`docx_to_pdf` — LibreOffice headless (binaire hôte ``soffice``),
  profil utilisateur JETABLE par conversion (-env:UserInstallation) : deux
  conversions concurrentes ne se disputent pas le verrou de profil LO.
- :func:`raster_pdf` — pypdfium2 (Apache-2.0/BSD, déjà tiré par pdfplumber) :
  PNG par page (grand côté ~``max_side_px``) + couche texte par page (vide
  sur un scan) servant de référence de vérification anti-hallucination.
  PyMuPDF (AGPL, extra ``requirements-agpl-optional.txt``) n'est tenté que
  si pypdfium2 manque.
- :func:`divergence` — écart [0..1] entre couche texte et texte OCR
  (None si la page n'a pas de couche texte exploitable).
"""
from __future__ import annotations

import difflib
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ._common import OcrError, write_text_atomic


class PrepareCanceled(OcrError):
    """La préparation a été annulée (``cancel_event`` posé) — le thread
    s'arrête proprement au lieu de continuer à écrire en tâche de fond."""


def _check(cancel_event: Optional[threading.Event], deadline: Optional[float]) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise PrepareCanceled("Préparation annulée.")
    if deadline is not None and time.monotonic() > deadline:
        raise OcrError("Préparation trop longue (délai dépassé) — document "
                       "trop lourd ou PDF pathologique.")


def _kill_group(proc: subprocess.Popen) -> None:
    """Tue le GROUPE de process (soffice relance un soffice.bin enfant que
    ``proc.kill()`` seul laissait tourner)."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass

_SOFFICE_TIMEOUT_SEC = 180
# Zoom du raster borné : ×4 max (page minuscule), en dessous le calcul
# grand-côté fait déjà le clamp pour les grandes pages (plans A0…).
_MAX_ZOOM = 4.0


def _soffice_bin() -> str:
    return os.environ.get("APP_OCR_SOFFICE_BIN") or shutil.which("soffice") or ""


def docx_to_pdf(src: Path, outdir: Path, *,
                cancel_event: Optional[threading.Event] = None,
                timeout_sec: Optional[float] = None) -> Path:
    """Convertit ``src`` (.docx) en PDF dans ``outdir``. Retourne le PDF.

    Process lancé dans sa PROPRE session : délai dépassé ou annulation tuent
    tout le groupe (soffice + soffice.bin).
    """
    soffice = _soffice_bin()
    if not soffice:
        raise OcrError("LibreOffice (soffice) introuvable sur le serveur — "
                       "conversion Word impossible.")
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ocr-lo-") as profile:
        cmd = [
            soffice, "--headless", "--norestore",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to", "pdf", "--outdir", str(outdir), str(src),
        ]
        limit = float(timeout_sec or _SOFFICE_TIMEOUT_SEC)
        deadline = time.monotonic() + limit
        with tempfile.TemporaryFile() as out:
            proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT,
                                    start_new_session=True)
            try:
                while proc.poll() is None:
                    if cancel_event is not None and cancel_event.is_set():
                        _kill_group(proc)
                        raise PrepareCanceled("Conversion annulée.")
                    if time.monotonic() > deadline:
                        _kill_group(proc)
                        raise OcrError("Conversion Word → PDF trop longue "
                                       "(délai dépassé).")
                    time.sleep(0.1)
            except BaseException:
                if proc.poll() is None:
                    _kill_group(proc)
                raise
            out.seek(0)
            output = out.read()[-4000:].decode("utf-8", "replace")
    pdf = outdir / (src.stem + ".pdf")
    if proc.returncode != 0 or not pdf.is_file():
        tail = output.strip()[-300:]
        raise OcrError("Conversion Word → PDF échouée."
                       + (f" Détail : {tail}" if tail else ""))
    return pdf


def raster_pdf(pdf_path: Path, pages_dir: Path, text_dir: Path,
               *, max_side_px: int, max_pages: int,
               cancel_event: Optional[threading.Event] = None,
               timeout_sec: Optional[float] = None,
               max_bytes: Optional[int] = None,
               ) -> Tuple[List[Dict], bool]:
    """Rend chaque page en PNG + extrait sa couche texte.

    Retourne ``(pages, truncated)`` — ``pages`` = [{n, w, h, chars}] (1-based),
    ``truncated`` = True si le document dépasse ``max_pages`` (les pages en
    excès sont ignorées, pas d'échec).

    Garde-fous (passe RAG 2) vérifiés entre deux pages : annulation
    (``cancel_event``), délai total (``timeout_sec``), budget disque
    (``max_bytes`` : quota du store restant). PNG écrits de façon atomique :
    une page interrompue n'est jamais laissée tronquée.
    """
    deadline = (time.monotonic() + float(timeout_sec)) if timeout_sec else None
    # Sans ``parents`` : le dossier du document doit exister (supprimé en
    # cours de route → échec net, pas de dossier fantôme recréé).
    pages_dir.mkdir(exist_ok=True)
    text_dir.mkdir(exist_ok=True)
    guard = _Guard(cancel_event, deadline, max_bytes)
    try:
        import pypdfium2  # noqa: F401 — import tardif (lib lourde)
    except ImportError:
        pages, truncated = _raster_fitz(pdf_path, pages_dir, text_dir,
                                        max_side_px=max_side_px,
                                        max_pages=max_pages, guard=guard)
    else:
        pages, truncated = _raster_pdfium(pdf_path, pages_dir, text_dir,
                                          max_side_px=max_side_px,
                                          max_pages=max_pages, guard=guard)
    if not pages:
        raise OcrError("Document vide (aucune page).")
    return pages, truncated


class _Guard:
    """Garde-fous vérifiés entre deux pages (annulation, délai, disque)."""

    def __init__(self, cancel_event, deadline, max_bytes):
        self.cancel_event = cancel_event
        self.deadline = deadline
        self.max_bytes = max_bytes
        self.written = 0

    def check(self) -> None:
        _check(self.cancel_event, self.deadline)

    def add(self, nbytes: int) -> None:
        self.written += nbytes
        if self.max_bytes is not None and self.written > self.max_bytes:
            raise OcrError("Espace documents saturé pendant la préparation "
                           "— supprimez des documents puis relancez.")


def _save_png(pages_dir: Path, n: int, save, guard: _Guard) -> None:
    """PNG écrit de façon atomique : une page interrompue n'est jamais
    laissée tronquée."""
    final = pages_dir / f"{n:04d}.png"
    tmp = pages_dir / f".{n:04d}.tmp.png"
    save(str(tmp))
    size = tmp.stat().st_size
    os.replace(tmp, final)
    guard.add(size)


def _save_page(pages: List[Dict], n: int, img, text: str,
               text_dir: Path) -> None:
    write_text_atomic(text_dir / f"{n:04d}.txt", text)
    pages.append({"n": n, "w": img[0], "h": img[1], "chars": len(text)})


def _raster_pdfium(pdf_path: Path, pages_dir: Path, text_dir: Path,
                   *, max_side_px: int, max_pages: int, guard: _Guard
                   ) -> Tuple[List[Dict], bool]:
    import pypdfium2 as pdfium

    pages: List[Dict] = []
    try:
        doc = pdfium.PdfDocument(str(pdf_path))
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise OcrError("PDF protégé par mot de passe — non géré.")
        raise OcrError("PDF illisible (corrompu ou chiffré ?).")
    except Exception:
        raise OcrError("PDF illisible (corrompu ou chiffré ?).")
    try:
        total = len(doc)
        truncated = total > max_pages
        for i in range(min(total, max_pages)):
            guard.check()
            page = doc[i]
            try:
                w, h = page.get_size()
                side = max(w, h) or 1.0
                zoom = min(_MAX_ZOOM, max_side_px / side)
                pil = page.render(scale=zoom).to_pil()
                n = i + 1
                _save_png(pages_dir, n, lambda p: pil.save(p, format="PNG"), guard)  # noqa: B023 (même itération)
                textpage = page.get_textpage()
                try:
                    text = (textpage.get_text_range() or "").strip()
                finally:
                    textpage.close()
                _save_page(pages, n, pil.size, text, text_dir)
            finally:
                page.close()
    finally:
        doc.close()
    return pages, truncated


def _raster_fitz(pdf_path: Path, pages_dir: Path, text_dir: Path,
                 *, max_side_px: int, max_pages: int, guard: _Guard
                 ) -> Tuple[List[Dict], bool]:
    try:
        import fitz  # PyMuPDF (AGPL) — extra facultatif
    except ImportError:
        raise OcrError("Ni pypdfium2 ni PyMuPDF sur le serveur — rendu de "
                       "pages impossible (pip install pypdfium2).")
    pages: List[Dict] = []
    try:
        doc = fitz.open(str(pdf_path))
    except Exception:
        raise OcrError("PDF illisible (corrompu ou chiffré ?).")
    try:
        if doc.needs_pass:
            raise OcrError("PDF protégé par mot de passe — non géré.")
        total = doc.page_count
        truncated = total > max_pages
        for i in range(min(total, max_pages)):
            guard.check()
            page = doc.load_page(i)
            rect = page.rect
            side = max(rect.width, rect.height) or 1.0
            zoom = min(_MAX_ZOOM, max_side_px / side)
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            n = i + 1
            _save_png(pages_dir, n, pix.save, guard)
            text = (page.get_text("text") or "").strip()
            _save_page(pages, n, (pix.width, pix.height), text, text_dir)
    finally:
        doc.close()
    return pages, truncated


_WORD_RE = re.compile(r"\w+", re.UNICODE)
# Cap des listes de mots comparées : SequenceMatcher est quadratique au pire ;
# 2000 mots ≈ 4-5 pages denses, largement assez pour un score par page.
_DIVERGENCE_MAX_WORDS = 2000


def divergence(text_layer: str, ocr_text: str) -> Optional[float]:
    """Écart [0..1] entre la couche texte du PDF et le texte OCR de la page.

    0 = identiques, 1 = disjoints, None = pas de couche texte exploitable
    (page scannée) — le score sert de signal de relecture, pas de vérité.
    """
    a = _WORD_RE.findall((text_layer or "").lower())[:_DIVERGENCE_MAX_WORDS]
    if len("".join(a)) < 20:
        return None
    b = _WORD_RE.findall((ocr_text or "").lower())[:_DIVERGENCE_MAX_WORDS]
    ratio = difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()
    return round(1.0 - ratio, 3)
