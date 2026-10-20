# SPDX-License-Identifier: MIT
# rag_app/extracteur/travaux.py — travaux exécutés dans le processus enfant : extraire, rendre une page, localiser.
from __future__ import annotations

import base64
import io
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import format_docx, format_html, format_pdf, format_pptx, format_texte, format_xlsx, ooxml
from .blocs import Collecteur, LimiteAtteinte
from .chemins import FORMATS, mime_de
from .erreurs import ErreurExtracteur
from .localiser import localiser

Progres = Callable[[int, int], None]


def extraire(job: dict[str, Any], progres: Progres) -> dict[str, Any]:
    ext, chemin = job["ext"], Path(job["path"])
    format_ = FORMATS[ext]
    col = Collecteur(int(job["max_chars"]), progres)
    meta: dict[str, Any] = {"pages": None, "title": None, "text_layer": True}
    if format_ in ("docx", "pptx", "xlsx"):
        ooxml.controler(chemin, int(job["zip_max_mo"]))
    try:
        if format_ == "pdf":
            format_pdf.extraire(chemin, col, meta)
        elif format_ == "docx":
            format_docx.extraire(chemin, col, meta)
        elif format_ == "pptx":
            format_pptx.extraire(chemin, col, meta)
        elif format_ == "xlsx":
            format_xlsx.extraire(chemin, col, meta)
        elif format_ == "html":
            format_html.extraire(chemin, col, meta)
        else:
            format_texte.extraire(chemin, ext, format_, col, meta)
    except LimiteAtteinte:
        pass
    vides = meta.pop("pages_sans_texte", [])
    if not col.blocs and not (format_ == "pdf" and job.get("tolerer_vide")):
        raise ErreurExtracteur("no_text", "Aucun texte extractible." + (" Activez l'OCR." if format_ == "pdf" else ""))
    if vides and col.blocs and not job.get("tolerer_vide"):
        col.avertir("empty_pages", f"{len(vides)} page(s) sans texte.", pages=vides[:50])
    meta["mime"] = mime_de(ext)
    return {"meta": meta, "blocks": col.blocs, "warnings": col.avertissements, "pages_sans_texte": vides}


def _ouvrir_pdfium(chemin: str):
    import pypdfium2 as pdfium
    try:
        return pdfium.PdfDocument(chemin)
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise ErreurExtracteur("encrypted", "PDF protégé par mot de passe.")
        raise ErreurExtracteur("corrupt", "PDF illisible.")


def rendre(job: dict[str, Any], progres: Progres) -> dict[str, Any]:
    pdf = _ouvrir_pdfium(job["path"])
    try:
        total, numero = len(pdf), int(job["page"])
        if not 1 <= numero <= total:
            raise ErreurExtracteur("page_out_of_range", f"Page {numero} absente ({total} pages).", 404)
        page = pdf[numero - 1]
        try:
            largeur, hauteur = page.get_size()
            echelle = (min(4.0, job["max_side_px"] / max(largeur, hauteur, 1.0)) if job.get("max_side_px")
                       else float(job["dpi"]) / 72.0)
            if largeur * echelle * hauteur * echelle > int(job["pixels_max"]):
                raise ErreurExtracteur("too_large", "Page trop grande pour ce rendu.", 413)
            image = page.render(scale=echelle).to_pil()
        finally:
            page.close()
    finally:
        pdf.close()
    tampon = io.BytesIO()
    if job.get("fmt") == "png":
        image.save(tampon, format="PNG")
    else:
        image.save(tampon, format="WEBP", quality=80, method=4)
    return {"data": base64.b64encode(tampon.getvalue()).decode("ascii"), "pages": total,
            "page_width": round(largeur, 2), "page_height": round(hauteur, 2),
            "width_px": image.width, "height_px": image.height}


def localiser_passage(job: dict[str, Any], progres: Progres) -> dict[str, Any]:
    return localiser(job["path"], job["text"], job.get("page_hint"))


TRAVAUX: dict[str, Callable[[dict[str, Any], Progres], dict[str, Any]]] = {
    "extract": extraire, "render": rendre, "locate": localiser_passage,
}
