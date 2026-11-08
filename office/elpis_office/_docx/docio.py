# SPDX-License-Identifier: MIT
"""Opening, reading and editing existing .docx files."""

from __future__ import annotations

import copy
import re
from typing import Any, Iterable

from docx.oxml.parser import register_element_cls
from docx.oxml.text.paragraph import CT_P
from docx.oxml.text.run import CT_R
from docx.text.run import Run

from ..commun import replace_in_runs
from .errors import InvalidSpec
from .ooxml.util import insert_in_order, qn

_HEADING = re.compile(r"^Heading (\d)$", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Inline content
# ---------------------------------------------------------------------------

_R, _SDT, _SDT_CONTENT, _HYPERLINK = qn("w:r"), qn("w:sdt"), qn("w:sdtContent"), qn("w:hyperlink")
_INLINE_CONTAINERS = frozenset(
    qn(f"w:{tag}")
    for tag in ("hyperlink", "ins", "moveTo", "smartTag", "customXml", "fldSimple", "dir", "bdo")
)
_KEPT_MARKS = frozenset(
    qn(f"w:{tag}")
    for tag in ("pPr", "bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd",
                "permStart", "permEnd")
)


def inline_runs(element) -> list:
    """Text runs of a paragraph as Word shows them: links, content controls and insertions in, deletions out."""
    runs = []
    for child in element:
        if child.tag == _R:
            runs.append(child)
        elif child.tag in _INLINE_CONTAINERS:
            runs.extend(inline_runs(child))
        elif child.tag == _SDT:
            content = child.find(_SDT_CONTENT)
            if content is not None:
                runs.extend(inline_runs(content))
    return runs


class _WordTextParagraph(CT_P):
    """``w:p`` whose ``text`` is ``inline_runs`` (python-docx reads direct runs and links only)."""

    @property
    def text(self) -> str:
        return "".join(run.text for run in inline_runs(self))


register_element_cls("w:p", _WordTextParagraph)

_RUN_TEXT = frozenset(qn(f"w:{tag}") for tag in ("br", "cr", "noBreakHyphen", "ptab", "t", "tab"))


class _FastTextRun(CT_R):
    """``w:r`` dont ``text`` parcourt ses enfants : python-docx recompile un XPath à chaque lecture."""

    text = property(lambda self: "".join(str(e) for e in self if e.tag in _RUN_TEXT),
                    CT_R.text.fset)  # type: ignore[attr-defined]


register_element_cls("w:r", _FastTextRun)


def _inside_link(run, paragraph) -> bool:
    parent = run.getparent()
    while parent is not None and parent is not paragraph:
        if parent.tag == _HYPERLINK:
            return True
        parent = parent.getparent()
    return False


def base_rpr(paragraph):
    """Properties of the first text outside a link: rewritten text keeps them."""
    for run in inline_runs(paragraph):
        if run.text and not _inside_link(run, paragraph):
            return copy_rpr(run)
    return None


def clear_inline(paragraph):
    """Remove text, links, controls and revisions; keep properties and anchors. Returns where new text goes."""
    removed, anchor = False, None
    for child in list(paragraph):
        if child.tag in _KEPT_MARKS or (
                child.tag == _R and child.find(qn("w:commentReference")) is not None):
            if removed and anchor is None:
                anchor = child
            continue
        paragraph.remove(child)
        removed = True
    return anchor


# ---------------------------------------------------------------------------
# Body blocks
# ---------------------------------------------------------------------------

_P, _TBL, _CUSTOM_XML = qn("w:p"), qn("w:tbl"), qn("w:customXml")
#: Where a located paragraph sits in the body (the rest are headers and footers).
BODY_WHERE = frozenset({"body", "table", "callout"})


def body_blocks(container) -> Iterable[Any]:
    """Paragraphs and tables of a body in reading order, including those inside block content controls."""
    for child in container.iterchildren():
        if child.tag in (_P, _TBL):
            yield child
        elif child.tag == _SDT:
            content = child.find(_SDT_CONTENT)
            if content is not None:
                yield from body_blocks(content)
        elif child.tag == _CUSTOM_XML:
            yield from body_blocks(child)


def is_callout(table) -> bool:
    """A boxed note as docx_create draws it: a single shaded cell with a thick left edge."""
    rows = table.findall(qn("w:tr"))
    cells = rows[0].findall(qn("w:tc")) if len(rows) == 1 else []
    if len(cells) != 1:
        return False
    shading = cells[0].find(f"{qn('w:tcPr')}/{qn('w:shd')}")
    if shading is None or (shading.get(qn("w:fill")) or "auto").upper() in ("AUTO", "FFFFFF"):
        return False
    borders = cells[0].find(f"{qn('w:tcPr')}/{qn('w:tcBorders')}")
    if borders is None:
        return False
    edge = borders.find(qn("w:left"))
    if edge is None:
        edge = borders.find(qn("w:start"))
    try:
        return edge is not None and int(edge.get(qn("w:sz")) or 0) >= 12
    except ValueError:
        return False


def body_paragraphs(document) -> list:
    """The numbered paragraphs (``p``) of docx_read and docx_edit, content controls included."""
    from docx.text.paragraph import Paragraph

    return [Paragraph(e, document._body) for e in body_blocks(document.element.body) if e.tag == _P]


def body_tables(document, callouts: bool = False) -> list:
    """The numbered tables of the body; callout boxes are apart (``callouts=True`` lists them instead)."""
    from docx.table import Table

    return [Table(e, document._body) for e in body_blocks(document.element.body)
            if e.tag == _TBL and is_callout(e) == callouts]


# ---------------------------------------------------------------------------
# Run properties
# ---------------------------------------------------------------------------

RPR_ORDER = (
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike",
    "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden",
    "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr",
    "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish",
    "oMath",
)


def copy_rpr(run):
    """A detached copy of a run's properties, without its tracked formatting change."""
    if run.rPr is None:
        return None
    rpr = copy.deepcopy(run.rPr)
    for change in rpr.findall(qn("w:rPrChange")):
        rpr.remove(change)
    return rpr


def merge_rpr(run, base) -> None:
    """Give a run the base properties it does not set itself, in schema order."""
    if base is None:
        return
    rpr = run.get_or_add_rPr()
    present = {child.tag for child in rpr}
    for child in base:
        if child.tag not in present:
            insert_in_order(rpr, copy.deepcopy(child), RPR_ORDER)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def _level_for_name(name: str) -> int | None:
    """The heading level a style *name* implies, or None. The single rule."""
    if name.lower() == "title":
        return 0
    match = _HEADING.match(name)
    return int(match.group(1)) if match else None


def style_levels(document) -> tuple[dict[str, int | None], str | None]:
    """Map every paragraph style id to the heading level its name implies.

    ``paragraph.style`` is the obvious way to ask this, and it is why reading a
    document used to cost 150 ms: for a paragraph with no explicit ``w:pStyle``
    python-docx resolves the default style by scanning the whole styles part,
    once per paragraph. Building the answer for every style up front turns that
    quadratic walk into one pass, and the map is cheap enough (~0.4 ms) to
    rebuild per call — so there is no cache to invalidate when a tool adds a
    style mid-document.

    Names go through ``BabelFish`` because ``w:name`` holds Word's internal name
    ("heading 1") while ``style.name`` — and therefore the rule above — sees the
    UI name ("Heading 1").
    """
    from docx.styles import BabelFish

    own: dict[str, tuple[int | None, int | None, str | None]] = {}
    default_id: str | None = None
    for style in document.styles.element.style_lst:
        # type 1 is WD_STYLE_TYPE.PARAGRAPH; a character style can never be a heading.
        if style.type is not None and int(style.type) != 1:
            continue
        style_id = style.styleId
        if style_id is None:
            continue
        outline = style.find(f"{qn('w:pPr')}/{qn('w:outlineLvl')}")
        try:
            outline_level = int(outline.get(qn("w:val"), "9")) if outline is not None else None
        except (TypeError, ValueError):
            outline_level = 9
        own[style_id] = (_level_for_name(BabelFish.internal2ui(style.name_val or "")), outline_level,
                         style.basedOn_val)
        if style.default and default_id is None:
            default_id = style_id

    # A company style ("Titre client") is a heading by its own outline level or by the
    # heading it is based on: Word's navigation pane and table of contents see it so.
    levels: dict[str, int | None] = {}

    def level_of(style_id: str, depth: int = 0) -> int | None:
        if style_id in levels:
            return levels[style_id]
        by_name, outline_level, parent = own[style_id]
        level: int | None
        if by_name is not None:
            level = by_name
        elif outline_level is not None:
            level = outline_level + 1 if 0 <= outline_level <= 8 else None
        elif parent in own and depth < 10:
            level = level_of(parent, depth + 1)
        else:
            level = None
        levels[style_id] = level
        return level

    for style_id in own:
        level_of(style_id)
    return levels, default_id


def heading_level_for(paragraph, levels: dict[str, int | None], default_id: str | None) -> int | None:
    """``heading_level`` against a prebuilt map. Identical results, ~140x faster."""
    # A direct w:outlineLvl of 9 means "not in the outline" — it is how the
    # TOC's own "Contents" title stays out of the contents. Honour it here so
    # the outline tool and the TOC agree on what counts as a heading.
    properties = paragraph._p.find(qn("w:pPr"))
    if properties is not None:
        outline = properties.find(qn("w:outlineLvl"))
        if outline is not None:
            try:
                value = int(outline.get(qn("w:val"), "9"))
            except (TypeError, ValueError):
                value = 9
            return value + 1 if 0 <= value <= 8 else None
        style = properties.find(qn("w:pStyle"))
        if style is not None:
            return levels.get(style.get(qn("w:val")) or "")
    # No w:pStyle at all means the document default applies.
    return levels.get(default_id or "")


def get_outline(document) -> list[dict[str, Any]]:
    outline = []
    levels, default_id = style_levels(document)
    for index, paragraph in enumerate(body_paragraphs(document)):
        level = heading_level_for(paragraph, levels, default_id)
        text = paragraph.text.strip()
        if level is not None and text:
            outline.append({"index": index, "level": level, "text": text})
    return outline


# ---------------------------------------------------------------------------
# Editing
# ---------------------------------------------------------------------------


#: What an unfinished document leaves behind. Checked by default, because the
#: failure they cause — a contract that ships saying "[À COMPLÉTER]" — is the one
#: nobody notices until the recipient does.
LEFTOVER_PATTERNS: tuple[tuple[str, re.Pattern], ...] = tuple((explanation, re.compile(pattern)) for pattern, explanation in (
    (r"<<[^<>\n]{1,60}>>", "an unfilled <<placeholder>>"),
    (r"\[[A-ZÀ-Þ][A-ZÀ-Þ0-9 _'’-]{2,40}\]", "a bracketed placeholder such as [XXX]"),
    (r"\bTODO\b|\bTBD\b|\bFIXME\b", "a TODO left in the text"),
    (r"(?i)\bà compléter\b|\bto be completed\b", "a 'to be completed' marker"),
    (r"(?i)\blorem ipsum\b", "placeholder Lorem ipsum text"),
))


def iter_located_paragraphs(document) -> Iterable[tuple[dict[str, Any], Any]]:
    """Every paragraph in the document, each with where it actually sits.

    The header is exactly where a stale quarter or an unreplaced client name
    survives a find-and-replace: replace and docx_read both walk this, so what is
    written and what is checked are the same surface.

    ``paragraph_index`` matches ``body_paragraphs`` (the ``p`` of docx_read), and
    callout boxes come apart from the numbered tables.
    """
    for index, paragraph in enumerate(body_paragraphs(document)):
        yield {"where": "body", "paragraph_index": index}, paragraph

    for table_index, table in enumerate(body_tables(document)):
        yield from _iter_table(table, {"where": "table", "table_index": table_index})
    for callout_index, table in enumerate(body_tables(document, callouts=True)):
        yield from _iter_table(table, {"where": "callout", "callout_index": callout_index})

    for section_index, section in enumerate(document.sections):
        for name, story in _stories(section):
            # Skipping linked stories does two jobs. It stops one stale string in a
            # shared header being reported once per section — and, more importantly,
            # it avoids *reading* a header that does not exist: python-docx creates
            # the part on access, so merely scanning a document would add six empty
            # header and footer parts to it. An empty but defined first-page header
            # is not nothing in Word — it means "no header on the first page", which
            # is how a corporate template silently loses its own.
            if getattr(story, "is_linked_to_previous", False):
                continue
            base = {"where": name, "section": section_index}
            for index, paragraph in enumerate(story.paragraphs):
                yield {**base, "paragraph_index": index}, paragraph
            for table_index, table in enumerate(getattr(story, "tables", []) or []):
                yield from _iter_table(table, {**base, "table_index": table_index})


_TR, _TC, _TC_PR, _GRID_SPAN, _V_MERGE, _VAL = (qn(f"w:{tag}") for tag in ("tr", "tc", "tcPr", "gridSpan", "vMerge", "val"))


def _iter_table(table, base: dict[str, Any]) -> Iterable[tuple[dict[str, Any], Any]]:
    """Paragraphes de chaque cellule à sa première colonne, comme ``row.cells`` sans un objet par case ; une fusion verticale est lue à son départ."""
    from docx.table import _Cell
    from docx.text.paragraph import Paragraph

    for row_index, tr in enumerate(table._tbl.iterchildren(_TR)):
        column = 0
        for tc in tr.iterchildren(_TC):
            properties = tc.find(_TC_PR)
            span = properties.find(_GRID_SPAN) if properties is not None else None
            merge = properties.find(_V_MERGE) if properties is not None else None
            if merge is None or merge.get(_VAL, "continue") != "continue":
                cell = _Cell(tc, table)
                for paragraph in tc.iterchildren(_P):
                    yield {**base, "row": row_index, "column": column}, Paragraph(paragraph, cell)
            column += int(span.get(_VAL)) if span is not None else 1


def _stories(section) -> Iterable[tuple[str, Any]]:
    candidates = (
        ("header", "header"), ("footer", "footer"),
        ("header", "first_page_header"), ("footer", "first_page_footer"),
        ("header", "even_page_header"), ("footer", "even_page_footer"),
    )
    for name, attribute in candidates:
        story = getattr(section, attribute, None)
        if story is None:
            continue
        yield (name if attribute in {"header", "footer"} else attribute), story


def find_pattern(located: list[tuple[dict[str, Any], str]], pattern: re.Pattern, limit: int = 200) -> list[dict[str, Any]]:
    """Chaque occurrence de ``pattern`` dans les textes situés (lieu, texte), avec un extrait autour."""
    found: list[dict[str, Any]] = []
    for location, text in located:
        for match in pattern.finditer(text):
            found.append({**location, "match": match.group(0), "excerpt": _excerpt(text, match)})
            if len(found) >= limit:
                return found
    return found


def _excerpt(text: str, match: re.Match, window: int = 40) -> str:
    start = max(0, match.start() - window)
    end = min(len(text), match.end() + window)
    return ("…" if start else "") + text[start:end].strip() + ("…" if end < len(text) else "")


def replace_text(document, search: str, replacement: str, *, regex: bool = False,
                 ignore_case: bool = False) -> int:
    """Search and replace across the document, headers and tables included, preserving run formatting.

    Word splits a sentence across runs at arbitrary points (a spell-check pass is
    enough to do it), so a match routinely spans several runs. Matches inside a
    single run are edited in place; a match that spans runs collapses onto the
    first run it touches, which is the only way to keep *some* formatting rather
    than none.
    """
    from .ooxml.util import sanitize_text

    replacement = sanitize_text(replacement)
    flags = re.IGNORECASE if ignore_case else 0
    pattern = re.compile(search if regex else re.escape(search), flags)
    return sum(replace_in_runs([Run(run, paragraph) for run in inline_runs(paragraph._p)], pattern, replacement)
               for _, paragraph in iter_located_paragraphs(document))


def set_metadata(document, **values: Any) -> dict[str, Any]:
    from .ooxml.util import sanitize_text

    properties = document.core_properties
    applied = {}
    for key, value in values.items():
        if value is None:
            continue
        value = sanitize_text(value)
        if not hasattr(properties, key):
            raise InvalidSpec(
                f"Unknown metadata field {key!r}. Valid fields: title, subject, author, "
                "keywords, category, comments, language."
            )
        setattr(properties, key, value)
        applied[key] = value
    return applied
