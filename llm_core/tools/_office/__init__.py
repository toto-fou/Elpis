# SPDX-License-Identifier: MIT
"""llm_core/tools/_office — outils Word / PowerPoint d'Elpis (7 outils par intention, sans état).

  docx_create / docx_read / docx_edit     documents Word
  pptx_create / pptx_read / pptx_edit     présentations PowerPoint
  office_export                           PDF par LibreOffice (isolé)

Chaque appel lit et écrit des fichiers de la SANDBOX de l'appelant, par
l'``Env`` que fournit l'hôte (``llm_core/tools/office_tools.py`` dans Elpis).
Les moteurs de rendu (``_docx``, ``_pptx``) viennent des serveurs MCP
docx-mcp et pptx-mcp (MIT), allégés : ni registre en mémoire, ni réseau, ni
Jinja, ni matplotlib. Les graphiques sont ceux des outils ``chart_*``
(``graphiques.py``).

Comme pour les graphiques : lecture tolérante (casse, synonymes français),
corrections renvoyées dans ``fixes``, choix imposés dans ``warnings``, refus
guidés (``fix`` + ``example``) et garde-fou anti-boucle par conversation.
"""
from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Any, Callable, Dict

from .._chart import _refus
from .commun import EXT, EXT_LUES, Env, OfficeError, canon, chemin_entree, chemin_sortie, ecrire, lire
from .paquet import PaquetInvalide, normaliser

logger = logging.getLogger("uvicorn.error")

# ── Schémas annoncés au modèle ──────────────────────────────────────────────
_PATH = {"type": "string",
         "description": "File path in the sandbox, e.g. 'rapports/bilan-2026.docx' "
                        "(relative to /work)."}
_PATH_PPTX = {"type": "string",
              "description": "File path in the sandbox, e.g. 'presentations/comite.pptx' "
                             "(relative to /work)."}
_PATH_EXPORT = {"type": "string",
                "description": "The office file to convert, e.g. 'rapports/bilan-2026.docx'."}
_SLIDE_OBJ = {
    "type": "object",
    "description": "One slide. Fields depend on the layout; fields the layout does not use "
                   "are ignored (listed in fixes).",
    "properties": {
        "layout": {"type": "string", "enum": [
            "title", "section", "agenda", "bullets", "two_content", "kpi", "chart", "table",
            "comparison", "timeline", "process", "image", "quote", "closing"]},
        "title": {"type": "string"},
        "subtitle": {"type": "string", "description": "title / section / closing slides"},
        "bullets": {"type": "array", "items": {"type": "string"},
                    "description": "bullets slide; a sub-point starts with two spaces: "
                                   "[\"Point\", \"  sub-point\"]"},
        "text": {"type": "string", "description": "prose instead of bullets, or the quote text"},
        "chart": {"type": "string",
                  "description": "chart slide: the ref returned by a chart_<type> tool, "
                                 "e.g. '!a1b2c3d4e5f6'"},
        "items": {"type": "array", "description": "kpi: [{value, label, delta}] · agenda: "
                                                  "[\"Section 1\", …]",
                  "items": {"type": ["object", "string"]}},
        "milestones": {"type": "array", "description": "timeline: [{date, title, text, done}]",
                       "items": {"type": ["object", "string"]}},
        "steps": {"type": "array", "description": "process: [\"Step 1\", …] or [{title, text}]",
                  "items": {"type": ["object", "string"]}},
        "table": {"description": "table slide: {header: [...], rows: [[...]]}, a list of row "
                                 "objects, or a chart_table ref '!id'"},
        "left": {"description": "comparison: {title, items: [...]} · two_content: a list of "
                                "bullets, a text, or a chart ref '!id'"},
        "right": {"description": "same as left"},
        "image": {"type": "string", "description": "image slide: an image file in the sandbox"},
        "takeaway": {"type": "string", "description": "the one line to remember, shown in a band"},
        "notes": {"type": "string", "description": "speaker notes"},
        "author": {"type": "string"}, "date": {"type": "string"},
        "contact": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["layout"],
}
_DOCX_OP = {
    "type": "object",
    "properties": {
        "op": {"type": "string", "enum": ["replace", "fill", "set", "delete", "insert", "append",
                                          "set_cell", "add_row", "delete_row", "meta"]},
        "find": {"type": "string"}, "replace": {"type": "string"},
        "match_case": {"type": "boolean", "description": "replace: default true (exact case)"},
        "values": {"type": "object", "description": "fill: {field: value} for {{field}}"},
        "p": {"type": ["integer", "array"], "items": {"type": "integer"},
              "description": "paragraph number(s) from docx_read (from 0)"},
        "to": {"type": "integer", "description": "delete: last paragraph of a range"},
        "text": {"type": "string"},
        "after": {"type": ["integer", "string"],
                  "description": "insert: paragraph number, heading text, 'start' or 'end'"},
        "before": {"type": ["integer", "string"]},
        "at_end_of": {"type": "string", "description": "insert: at the end of this heading's section"},
        "content": {"type": "string", "description": "insert / append: Markdown"},
        "table": {"type": "integer"}, "row": {"type": "integer"}, "col": {"type": "integer"},
        "title": {"type": "string"}, "author": {"type": "string"}, "subject": {"type": "string"},
    },
    "required": ["op"],
}
_PPTX_OP = {
    "type": "object",
    "properties": {
        "op": {"type": "string", "enum": ["replace", "fill", "set_text", "add_slides",
                                          "delete_slide", "move_slide", "duplicate_slide",
                                          "notes", "meta"]},
        "find": {"type": "string"}, "replace": {"type": "string"},
        "match_case": {"type": "boolean"},
        "values": {"type": "object", "description": "fill: {field: value} for {{field}}"},
        "slide": {"type": ["integer", "array"], "items": {"type": "integer"},
                  "description": "slide number(s), from 1"},
        "shape": {"type": "integer", "description": "set_text: shape number from pptx_read"},
        "text": {"type": "string"},
        "slides": {"type": "array", "items": _SLIDE_OBJ, "description": "add_slides: new slides"},
        "after": {"type": ["integer", "string"],
                  "description": "add_slides: slide number, 'start' or 'end' (default)"},
        "before": {"type": "integer", "description": "add_slides: insert before this slide"},
        "to": {"type": "integer", "description": "move_slide / duplicate_slide: position wanted "
                                                 "in the deck at that point (from 1)"},
        "title": {"type": "string"}, "author": {"type": "string"},
    },
    "required": ["op"],
}

TOOLS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

TOOLS["docx_create"] = {
    "description": (
        "Create a Word document (.docx) in the sandbox from Markdown.\n"
        "content supports: # headings, paragraphs, **bold** / *italic*, lists, | tables |, "
        "> quotes, ```code```, ![caption](images/photo.png) from the sandbox, and:\n"
        "  !a1b2c3d4e5f6 alone on a line: a chart made first with a chart_<type> tool "
        "(native editable chart when possible, else an image); chart_table → a real table\n"
        "  > [!NOTE] Title  (TIP, IMPORTANT, WARNING, CAUTION): a callout box\n"
        "  [TOC]: table of contents · \\newpage: page break\n"
        "An existing file at path is replaced (the previous version stays in the file history, "
        "up to 5 MB). Returns path, outline (headings with paragraph numbers) and summary."),
    "params": OrderedDict([
        ("path", _PATH),
        ("content", {"type": "string", "description": "The document body in Markdown."}),
        ("title", {"type": "string", "description": "Document title (cover / first line, "
                                                    "file properties)."}),
        ("subtitle", {"type": "string"}), ("author", {"type": "string"}),
        ("date", {"type": "string"}),
        ("cover", {"type": "boolean", "description": "Start with a cover page (title, subtitle, "
                                                     "author, date)."}),
        ("toc", {"type": "boolean", "description": "Add a table of contents after the title."}),
        ("template", {"type": "string", "description": "A .dotx/.docx in the sandbox: its styles, "
                                                       "header, footer and page layout are kept "
                                                       "unless you set header/footer/page; its "
                                                       "text is not."}),
        ("theme", {"type": "object", "description": "Look: {accent: '#1F4E79', font: 'Calibri', "
                                                    "heading_font: 'Calibri Light', font_size: 11}",
                   "properties": {"accent": {"type": "string"}, "font": {"type": "string"},
                                  "heading_font": {"type": "string"},
                                  "font_size": {"type": "number"}}}),
        ("page", {"type": "object", "properties": {
            "size": {"type": "string", "enum": ["A4", "A3", "A5", "Letter", "Legal"]},
            "orientation": {"type": "string", "enum": ["portrait", "landscape"]},
            "margins_cm": {"type": "number"}}}),
        ("header", {"type": "string", "description": "Text at the top of every page."}),
        ("footer", {"type": "string", "description": "Text at the bottom of every page."}),
        ("page_numbers", {"type": "boolean", "description": "Page X / Y in the footer "
                                                            "(default true, false with a "
                                                            "template)."}),
        ("watermark", {"type": "string", "description": "e.g. CONFIDENTIEL, BROUILLON"}),
    ]),
    "required": ["path", "content"],
}
TOOLS["docx_read"] = {
    "description": (
        "Read a Word document of the sandbox: outline, numbered paragraphs (p), tables, header "
        "and footer, {{placeholders}} and unfinished marks (TODO, [XXX]…). Use the p and table "
        "numbers with docx_edit. find = text to locate (case ignored). Long documents come in "
        "pages: call again with start=next_start."),
    "params": OrderedDict([
        ("path", _PATH),
        ("find", {"type": "string", "description": "Text to locate."}),
        ("start", {"type": "integer", "description": "First paragraph number to list."}),
        ("limit", {"type": "integer", "description": "Max items listed (default 200)."}),
    ]),
    "required": ["path"],
}
TOOLS["docx_edit"] = {
    "description": (
        "Edit a Word document of the sandbox with a list of operations, applied together in one "
        "save. Paragraph (p), table, row and column numbers start at 0 and refer to the document "
        "BEFORE this call, as docx_read shows it:\n"
        "  {op:'replace', find, replace}            everywhere, headers and tables included "
        "(exact case unless match_case:false)\n"
        "  {op:'fill', values:{client:'ACME'}}       fills {{client}} placeholders\n"
        "  {op:'set', p, text}                       rewrites one paragraph (style kept)\n"
        "  {op:'delete', p} · {op:'delete', p, to} · {op:'delete', table}\n"
        "  {op:'insert', after|before: p or heading text, content: Markdown}\n"
        "  {op:'insert', at_end_of: heading text, content}\n"
        "  {op:'append', content: Markdown}          at the end (charts !id allowed)\n"
        "  {op:'set_cell', table, row, col, text} · {op:'add_row', table, values} · "
        "{op:'delete_row', table, row}   (from 0, row 0 = header)\n"
        "  {op:'meta', title, author, subject}\n"
        "save_as = write a copy instead of modifying the file. If the file changed since it was "
        "read, nothing is written (concurrent_modification): read it again."),
    "params": OrderedDict([
        ("path", _PATH),
        ("ops", {"type": "array", "items": _DOCX_OP, "minItems": 1}),
        ("save_as", {"type": "string", "description": "Optional: save the result to this path."}),
    ]),
    "required": ["path", "ops"],
}
TOOLS["pptx_create"] = {
    "description": (
        "Create a PowerPoint deck (.pptx) in the sandbox. Each slide is {layout, …}:\n"
        "  title {title, subtitle, author, date} · section {title, subtitle} · agenda {items}\n"
        "  bullets {title, bullets, takeaway} · two_content {title, left, right}\n"
        "  kpi {title, items:[{value:'18,4 M€', label, delta:'+12 %'}]}\n"
        "  chart {title, chart:'!id' from a chart_<type> tool, takeaway}\n"
        "  table {title, table} · comparison {title, left:{title, items}, right:{title, items}}\n"
        "  timeline {title, milestones:[{date, title}]} · process {title, steps}\n"
        "  image {title, image: sandbox path} · quote {text, author} · closing {title, contact}\n"
        "Every slide accepts notes (speaker notes). Layouts are composed and text is fitted for "
        "you. An existing file at path is replaced (previous version kept in the file history, "
        "up to 5 MB)."),
    "params": OrderedDict([
        ("path", _PATH_PPTX),
        ("slides", {"type": "array", "items": _SLIDE_OBJ, "minItems": 1}),
        ("title", {"type": "string", "description": "Deck title (file properties)."}),
        ("author", {"type": "string"}),
        ("theme", {"type": "string", "description": "corporate, slate, emerald, plum, sand, "
                                                    "midnight, carbon, or a brand colour "
                                                    "'#00693C'."}),
        ("template", {"type": "string", "description": "A corporate .potx/.pptx in the sandbox: "
                                                       "its masters, theme and fonts are used."}),
        ("size", {"type": "string", "enum": ["16:9", "4:3", "16:10", "a4", "a4_landscape"]}),
        ("footer", {"type": "string", "description": "Footer text on content slides."}),
        ("slide_numbers", {"type": "boolean", "description": "default true"}),
        ("markdown", {"type": "string", "description": "Alternative to slides: a Markdown outline "
                                                       "(# deck title, ## one slide each, - "
                                                       "bullets)."}),
    ]),
    "required": ["path"],
}
TOOLS["pptx_read"] = {
    "description": (
        "Read a PowerPoint deck of the sandbox: per slide (numbered from 1) its title, its shapes "
        "with their text (shape numbers for pptx_edit set_text), tables, charts and speaker "
        "notes. slide = read only that slide; find = text to locate (case ignored)."),
    "params": OrderedDict([
        ("path", _PATH_PPTX),
        ("slide", {"type": "integer", "description": "Only this slide (from 1)."}),
        ("find", {"type": "string", "description": "Text to locate."}),
    ]),
    "required": ["path"],
}
TOOLS["pptx_edit"] = {
    "description": (
        "Edit a PowerPoint deck of the sandbox with a list of operations, applied together in "
        "one save. Slide numbers start at 1 and refer to the deck BEFORE this call; shape "
        "numbers come from pptx_read:\n"
        "  {op:'replace', find, replace} · {op:'fill', values:{client:'ACME'}}\n"
        "  {op:'set_text', slide, shape, text}     shape number from pptx_read; one line per "
        "paragraph\n"
        "  {op:'add_slides', slides:[…same objects as pptx_create…], after|before: slide number}\n"
        "  {op:'delete_slide', slide} · {op:'move_slide', slide, to} · "
        "{op:'duplicate_slide', slide, to?}   (to = position in the deck at that point)\n"
        "  {op:'notes', slide, text} · {op:'meta', title, author}\n"
        "save_as = write a copy instead of modifying the file. If the file changed since it was "
        "read, nothing is written (concurrent_modification): read it again."),
    "params": OrderedDict([
        ("path", _PATH_PPTX),
        ("ops", {"type": "array", "items": _PPTX_OP, "minItems": 1}),
        ("save_as", {"type": "string", "description": "Optional: save the result to this path."}),
    ]),
    "required": ["path", "ops"],
}
TOOLS["office_export"] = {
    "description": (
        "Convert an office file of the sandbox (.docx, .pptx, .xlsx, .odt, .odp, .ods) to PDF "
        "with LibreOffice. The PDF is written next to it (or to save_as)."),
    "params": OrderedDict([
        ("path", _PATH_EXPORT),
        ("to", {"type": "string", "enum": ["pdf"]}),
        ("save_as", {"type": "string", "description": "Optional PDF path."}),
    ]),
    "required": ["path"],
}

def _impl(nom: str) -> Callable[[Dict[str, Any], Env], Dict[str, Any]]:
    from . import powerpoint, word
    return {"docx_create": word.docx_create, "docx_read": word.docx_read,
            "docx_edit": word.docx_edit, "pptx_create": powerpoint.pptx_create,
            "pptx_read": powerpoint.pptx_read, "pptx_edit": powerpoint.pptx_edit,
            "office_export": office_export}[nom]


# Exportables en PDF : formats que LibreOffice ouvre avec un filtre d'import
# FORCÉ (``office_convert.INFILTERS``) — un .doc/.ppt binaire ne l'est pas.
CONVERTIBLES = (".docx", ".dotx", ".docm", ".pptx", ".potx", ".pptm", ".ppsx", ".xlsx",
                ".xlsm", ".odt", ".odp", ".ods")
_SORTE = {".docx": "docx", ".dotx": "docx", ".docm": "docx", ".pptx": "pptx", ".potx": "pptx",
          ".pptm": "pptx", ".ppsx": "pptx"}


def office_export(args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    a = canon(args, {"path": ["file", "filename", "fichier", "chemin", "source", "input"],
                     "to": ["format", "as", "type", "vers"],
                     "save_as": ["output", "output_path", "dest", "destination"]}, env.notes)
    rel = chemin_entree(a.get("path"))
    ext = "." + rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else ""
    if ext not in CONVERTIBLES:
        raise OfficeError(f"'{rel}' is not a file this tool converts to PDF",
                          fix=f"path = a {', '.join(CONVERTIBLES)} file (save an old .doc/.ppt/"
                              ".xls in the new format first)", code="wrong_format")
    if str(a.get("to") or "pdf").lower().strip(". ") != "pdf":
        env.notes.warn(f"format '{a.get('to')}' not supported: PDF produced")
    if env.convertir is None:
        raise OfficeError("PDF export needs LibreOffice, which is not installed on this server",
                          code="unavailable", fix="tell the user; an administrator can install it "
                                                  "(./install.sh --with-office)")
    cible = _pdf(a.get("save_as") or (rel.rsplit(".", 1)[0] + ".pdf"), env)
    try:
        data = lire(env, rel, "file")
    except FileNotFoundError:
        raise OfficeError(f"file not found: {env.espace.afficher(rel)}", code="not_found",
                          fix="check the path (list the folder)")
    if ext in _SORTE:
        # Modèle ou fichier à macros : converti comme un document ordinaire,
        # macros retirées (LibreOffice ne les voit jamais).
        try:
            data, _ = normaliser(data, _SORTE[ext], f"file '{rel}'")
        except PaquetInvalide as e:
            raise OfficeError(str(e), code="bad_file", fix="check that the file is a valid "
                                                           f"{EXT[_SORTE[ext]]} file")
        ext = EXT[_SORTE[ext]]
    pdf = env.convertir(data, ext, "pdf")
    res = ecrire(env, cible, pdf)
    return {**res, "summary": f"Exported {env.espace.afficher(rel)} to {res['path']} "
                              f"({len(pdf) // 1024} KB)"}


def _pdf(path: Any, env: Env) -> str:
    base = chemin_entree(path)
    if not base.lower().endswith(".pdf"):
        base = base.rsplit(".", 1)[0] + ".pdf" if "." in base.rsplit("/", 1)[-1] else base + ".pdf"
        env.notes.fix(f"PDF saved as '{base}'")
    return base


_SUITE_OFFICE = ("Change the call as `fix` says (use `example` as a model), or tell the user "
                 "what is missing and stop editing this file.")


def executer(nom: str, args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    """Exécute un outil → retour pour le modèle (enveloppe ok / error). Ne lève
    jamais : une erreur imprévue du moteur devient ``internal_error`` (et passe
    par le garde-fou anti-boucle, comme tout refus)."""
    try:
        res = _impl(nom)(dict(args or {}), env)
    except OfficeError as e:
        out: Dict[str, Any] = {"ok": False, "error": e.code, "message": e.message}
        if e.fix:
            out["fix"] = e.fix
        if e.example is not None:
            out["example"] = e.example
        if e.retryable:
            out["retryable"] = True
    except Exception as e:                       # noqa: BLE001 — un outil ne lève jamais
        logger.exception("[office] %s : erreur imprévue", nom)
        out = {"ok": False, "error": "internal_error",
               "message": f"{nom} failed: {type(e).__name__}: {e}",
               "fix": "tell the user the file could not be processed"}
    else:
        out = {"ok": True, **res}
        if env.notes.fixes:
            out["fixes"] = env.notes.fixes[:12]
            if len(env.notes.fixes) > 12:
                out["fixes"].append(f"… and {len(env.notes.fixes) - 12} more")
        if env.notes.warnings:
            out["warnings"] = env.notes.warnings[:12]
        return out
    # Refus : ce qui a été compris et ce qui l'explique (« X not found »…).
    if env.notes.fixes:
        out["fixes"] = env.notes.fixes[:12]
    if env.notes.warnings:
        out["warnings"] = env.notes.warnings[:12]
    return _refus(env.session, {"tool": nom, **(args or {})}, out, next_action=_SUITE_OFFICE)


__all__ = ["TOOLS", "CONVERTIBLES", "Env", "OfficeError", "executer", "EXT_LUES",
           "chemin_sortie"]
