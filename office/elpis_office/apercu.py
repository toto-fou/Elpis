# SPDX-License-Identifier: MIT
"""office/elpis_office/apercu.py — office_preview : pages d'un document rendues en images (PDF de LibreOffice, rendu à part par rendu_pdf.py)."""
from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

from .commun import Env, OfficeError, canon, chemin_entree, ecrire, entier, indice_chemin, lire

ALIAS: Dict[str, Iterable[str]] = {
    "path": ["file", "filename", "file_path", "fichier", "chemin", "document", "source"],
    "page": ["pages", "slide", "slides", "diapo", "diapositive", "page_number", "p", "numero"],
    "save_as": ["output", "output_path", "dest", "destination", "image"],
}
PAGES_MAX, COTE, DELAI_S = 3, 1400, 45
_PLAGE = re.compile(r"^\s*(\d+)\s*(?:[-–à]\s*(\d+))?\s*$")


def _pages(v: Any, notes: Any) -> List[int]:
    """1, « 3 », « 2-4 », [1, 3] → numéros (à partir de 1), au plus PAGES_MAX ; une plage n'est jamais déroulée au-delà."""
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
        for n in range(debut, min(max(debut, fin), debut + PAGES_MAX) + 1):
            if n not in pages:
                pages.append(n)
        if len(pages) > PAGES_MAX:
            break
    if len(pages) > PAGES_MAX:
        notes.warn(f"only the first {PAGES_MAX} pages asked are shown: call again for the next ones")
    return pages[:PAGES_MAX]


def lire_pdf(pdf: bytes, demande: Dict[str, Any]) -> Dict[str, Any]:
    """rendu_pdf.py dans un processus à part : un PDF piégé n'y bloque que lui (temps, mémoire)."""
    script = Path(__file__).with_name("rendu_pdf.py")
    try:
        fini = subprocess.run([sys.executable, "-I", str(script)], input=json.dumps(demande).encode() + b"\n" + pdf,
                              capture_output=True, timeout=DELAI_S, check=False)
    except subprocess.TimeoutExpired:
        raise OfficeError("rendering the page took too long (the PDF is too complex)", code="too_complex",
                          fix="tell the user; export it to PDF with office_export to look at it elsewhere")
    if fini.returncode != 0:
        raise OfficeError("the page could not be rendered (damaged or too heavy PDF)", code="bad_file",
                          fix="check that the file opens (docx_read / pptx_read), or export it to PDF")
    return json.loads(fini.stdout)


def _rendre(pdf: bytes, pages: List[int]) -> Tuple[int, List[Dict[str, Any]]]:
    resultat = lire_pdf(pdf, {"pages": pages, "cote": COTE})
    total, rendus = resultat["total"], resultat["pages"]
    hors = [n for n in pages if not 1 <= n <= total]
    if hors:
        raise OfficeError(f"page {hors[0]} does not exist (the document has {total} page(s))",
                          code="bad_index", fix=f"page = a number from 1 to {total}")
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
        pdf, _ = pdf_du_fichier(env, rel, ext, numeroter=False)     # un seul rendu : l'aperçu reste rapide
    total, rendus = _rendre(pdf, pages)
    res: Dict[str, Any] = {
        "path": env.espace.afficher(rel), "pages": total,
        "shown": [{"page": r["page"], "size": r["size"], "text": r["text"]} for r in rendus],
        "_png": [r["png"] for r in rendus],
        "summary": f"{'Page' if len(rendus) == 1 else 'Pages'} {', '.join(str(r['page']) for r in rendus)} of "
                   f"{total} of {env.espace.afficher(rel)} rendered"
                   + (" by LibreOffice (as office_export: fonts and line breaks can differ slightly from Word "
                      "or PowerPoint; a table of contents gets its page numbers in office_export)"
                      if ext != ".pdf" else ""),
    }
    if a.get("save_as"):
        ecrits = _enregistrer(env, str(a["save_as"]), rendus)
        res["saved"] = [e["path"] for e in ecrits]
        res["files_changed"] = [{**e, "change": "modified" if e["old_sha256"] else "created"} for e in ecrits]
    return res


def _enregistrer(env: Env, chemin: str, rendus: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Écrit les images dans la sandbox (une page : le nom donné ; plusieurs : -p<n> ajouté)."""
    base = chemin_entree(chemin)
    if base.lower().endswith(".png"):
        base = base[:-4]
    sortis: List[Dict[str, Any]] = []
    for r in rendus:
        cible = f"{base}.png" if len(rendus) == 1 else f"{base}-p{r['page']}.png"
        sortis.append(ecrire(env, cible, base64.b64decode(r["png"])))
    return sortis
