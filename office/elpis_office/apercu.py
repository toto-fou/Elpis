# SPDX-License-Identifier: MIT
"""office/elpis_office/apercu.py — office_preview : pages d'un document rendues en images (PDF de LibreOffice, pypdfium2)."""
from __future__ import annotations

import base64
import io
import re
import threading
from typing import Any, Dict, Iterable, List, Tuple

from .commun import Env, OfficeError, canon, chemin_entree, ecrire, entier, indice_chemin, lire

ALIAS: Dict[str, Iterable[str]] = {
    "path": ["file", "filename", "file_path", "fichier", "chemin", "document", "source"],
    "page": ["pages", "slide", "slides", "diapo", "diapositive", "page_number", "p", "numero"],
    "save_as": ["output", "output_path", "dest", "destination", "image"],
}
PAGES_MAX, COTE, TEXTE_MAX = 3, 1400, 1500
# pdfium n'est pas sûr entre threads : un rendu à la fois dans le worker.
_PDFIUM = threading.Lock()
_PLAGE = re.compile(r"^\s*(\d+)\s*(?:[-–à]\s*(\d+))?\s*$")


def _pages(v: Any, notes: Any) -> List[int]:
    """1, « 3 », « 2-4 », [1, 3] → numéros (à partir de 1), au plus PAGES_MAX."""
    if v in (None, "", []):
        return [1]
    brutes = v if isinstance(v, list) else str(v).split(",") if not isinstance(v, int) else [v]
    pages: List[int] = []
    for x in brutes:
        k = entier(x)
        m = _PLAGE.match(str(x))
        if k is not None:
            debut, fin = k, k
        elif m is not None:
            debut, fin = int(m.group(1)), int(m.group(2) or m.group(1))
        else:
            raise OfficeError(f"page {x!r} is not a page number", code="bad_index",
                              fix="page = a number from 1, a range '2-4' or a list [1, 3]")
        pages.extend(range(debut, max(debut, fin) + 1))
    pages = list(dict.fromkeys(pages))
    if len(pages) > PAGES_MAX:
        notes.warn(f"only the first {PAGES_MAX} pages asked are shown: call again for the next ones")
    return pages[:PAGES_MAX]


def _rendre(pdf: bytes, pages: List[int]) -> Tuple[int, List[Dict[str, Any]]]:
    import pypdfium2 as pdfium

    with _PDFIUM:
        doc = pdfium.PdfDocument(pdf)
        try:
            total = len(doc)
            hors = [n for n in pages if not 1 <= n <= total]
            if hors:
                raise OfficeError(f"page {hors[0]} does not exist (the document has {total} page(s))",
                                  code="bad_index", fix=f"page = a number from 1 to {total}")
            rendus = []
            for n in pages:
                page = doc[n - 1]
                try:
                    largeur, hauteur = page.get_size()
                    image = page.render(scale=COTE / max(largeur, hauteur, 1)).to_pil()
                    textes = page.get_textpage()
                    try:
                        texte = textes.get_text_range().replace("\r\n", "\n").strip()
                    finally:
                        textes.close()
                finally:
                    page.close()
                tampon = io.BytesIO()
                image.convert("RGB").save(tampon, "PNG", optimize=True)
                rendus.append({"page": n, "size": f"{image.width}x{image.height}", "png": tampon.getvalue(),
                               "text": texte if len(texte) <= TEXTE_MAX else texte[:TEXTE_MAX] + "…"})
        finally:
            doc.close()
    return total, rendus


def office_preview(args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    from . import CONVERTIBLES, pdf_du_fichier

    a = canon(args, ALIAS, env.notes)
    rel = chemin_entree(a.get("path"))
    ext = "." + rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else ""
    if ext not in (*CONVERTIBLES, ".pdf"):
        raise OfficeError(f"'{rel}' is not a file this tool renders", code="wrong_format",
                          fix=f"path = a .pdf or {', '.join(CONVERTIBLES)} file")
    pages = _pages(a.get("page"), env.notes)
    if ext == ".pdf":
        try:
            pdf = lire(env, rel, "file")
        except FileNotFoundError:
            raise OfficeError(f"file not found: {env.espace.afficher(rel)}", code="not_found",
                              fix=f"check the path{indice_chemin(env, rel) or ' (list the folder)'}")
        if not pdf.startswith(b"%PDF-"):
            raise OfficeError(f"'{rel}' is not a PDF file", code="bad_file", fix="check the file")
    else:
        pdf = pdf_du_fichier(env, rel, ext)
    try:
        total, rendus = _rendre(pdf, pages)
    except OfficeError:
        raise
    except Exception as e:                          # noqa: BLE001 — PDF illisible pour pdfium
        raise OfficeError(f"the rendered PDF cannot be read: {e}", code="bad_file",
                          fix="check that the file opens (docx_read / pptx_read), or export it to PDF")
    res: Dict[str, Any] = {
        "path": env.espace.afficher(rel), "pages": total,
        "shown": [{"page": r["page"], "size": r["size"], "text": r["text"]} for r in rendus],
        "_png": [base64.b64encode(r["png"]).decode("ascii") for r in rendus],
        "summary": f"{'Page' if len(rendus) == 1 else 'Pages'} {', '.join(str(r['page']) for r in rendus)} of "
                   f"{total} of {env.espace.afficher(rel)} rendered"
                   + (" by LibreOffice (as office_export: fonts and line breaks can differ slightly from Word "
                      "or PowerPoint; a table of contents has no page numbers)" if ext != ".pdf" else ""),
    }
    if a.get("save_as"):
        res["saved"] = _enregistrer(env, str(a["save_as"]), rendus)
    return res


def _enregistrer(env: Env, chemin: str, rendus: List[Dict[str, Any]]) -> List[str]:
    """Écrit les images dans la sandbox (une page : le nom donné ; plusieurs : -p<n> ajouté)."""
    base = chemin_entree(chemin)
    if base.lower().endswith(".png"):
        base = base[:-4]
    sortis = []
    for r in rendus:
        cible = f"{base}.png" if len(rendus) == 1 else f"{base}-p{r['page']}.png"
        sortis.append(ecrire(env, cible, r["png"])["path"])
    return sortis
