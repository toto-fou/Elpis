# SPDX-License-Identifier: MIT
"""Small shared primitives: namespaces, element construction, colours, lengths."""

from __future__ import annotations

import re
from typing import Any, Iterable, Sequence

from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Emu, Pt, RGBColor
from lxml import etree

__all__ = [
    "Cm",
    "Emu",
    "Pt",
    "RGBColor",
    "nsdecls",
    "parse_xml",
    "qn",
    "make",
    "sub",
    "frag",
    "local_name",
    "insert_in_order",
    "replace_in_order",
    "parse_color",
    "rgb",
    "ALIGNMENTS",
    "align_paragraph",
    "table_alignment",
    "cm_to_emu",
    "next_drawing_id",
    "srgb_fill",
    "srgb_line",
    "apply_run_format",
]

#: Extra namespaces python-docx does not register but that we emit.
EXTRA_NS = {
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
    "w10": "urn:schemas-microsoft-com:office:word",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
}


def make(tag: str, **attrs: Any) -> etree._Element:
    """Create an element from a ``prefix:local`` tag with ``prefix:local`` attributes.

    ``make("w:jc", **{"w:val": "center"})`` → ``<w:jc w:val="center"/>``.
    Attributes whose value is None are skipped, which keeps callers free of
    conditional-append noise.
    """
    element = OxmlElement(tag)
    for key, value in attrs.items():
        if value is None:
            continue
        element.set(qn(key) if ":" in key else key, str(value))
    return element


def sub(parent: etree._Element, tag: str, **attrs: Any) -> etree._Element:
    """``make`` plus append, returning the child."""
    child = make(tag, **attrs)
    parent.append(child)
    return child


# -- schema-order-aware insertion ------------------------------------------------
#
# OOXML element content is a *sequence*, not a bag: a child in the wrong position
# makes Word refuse the file outright. Every module that hand-writes XML inserts
# through these two helpers and passes the sequence from the relevant CT_* type.


def local_name(element: etree._Element) -> str:
    return etree.QName(element).localname


def insert_in_order(
    parent: etree._Element, child: etree._Element, order: Sequence[str]
) -> etree._Element:
    """Insert ``child`` before the first sibling that must follow it."""
    try:
        rank = order.index(local_name(child))
    except ValueError:
        parent.append(child)
        return child
    for existing in parent:
        name = local_name(existing)
        if name in order and order.index(name) > rank:
            existing.addprevious(child)
            return child
    parent.append(child)
    return child


def replace_in_order(
    parent: etree._Element, tag: str, child: etree._Element | None, order: Sequence[str]
) -> etree._Element | None:
    """Drop every existing ``tag`` child, then insert ``child`` in schema order."""
    for existing in parent.findall(qn(tag)):
        parent.remove(existing)
    if child is None:
        return None
    return insert_in_order(parent, child, order)


def frag(xml: str) -> etree._Element:
    """Parse an XML fragment that carries its own namespace declarations."""
    return etree.fromstring(xml.encode("utf-8"))


# -- colours ---------------------------------------------------------------------

_HEX = re.compile(r"^#?([0-9A-Fa-f]{6})$")
_HEX3 = re.compile(r"^#?([0-9A-Fa-f]{3})$")

NAMED_COLORS: dict[str, str] = {
    "black": "000000",
    "white": "FFFFFF",
    "red": "C00000",
    "orange": "ED7D31",
    "amber": "FFC000",
    "yellow": "FFD966",
    "green": "70AD47",
    "teal": "2E9599",
    "cyan": "00B0F0",
    "blue": "1F4E79",
    "lightblue": "5B9BD5",
    "indigo": "4472C4",
    "purple": "7030A0",
    "violet": "8064A2",
    "pink": "E75480",
    "brown": "833C0C",
    "grey": "808080",
    "gray": "808080",
    "lightgrey": "D9D9D9",
    "lightgray": "D9D9D9",
    "darkgrey": "404040",
    "darkgray": "404040",
    "silver": "BFBFBF",
}


#: XML 1.0 cannot carry these at all; lxml refuses them with a cryptic error.
_XML_UNSAFE = re.compile(
    "[\x00-\x08\x0e-\x1f\x7f\ud800-\udfff\ufdd0-\ufddf\ufffe\uffff]"
)
#: Vertical whitespace that pasted text (PDFs, terminals, Excel) carries often.
_VERTICAL_WS = re.compile("[\x0b\x0c\u2028\u2029]")


def sanitize_text(value: str) -> str:
    """Make arbitrary caller text XML-safe instead of failing the whole call.

    Vertical tab / form feed / line- and paragraph-separators become newlines
    (python-docx turns those into real breaks); the characters XML 1.0 simply
    cannot represent — C0 controls, lone surrogates, non-characters — are
    dropped.
    """
    if not isinstance(value, str):
        return value
    value = _VERTICAL_WS.sub("\n", value)
    return _XML_UNSAFE.sub("", value)


def parse_color(value: str | None) -> str | None:
    """Normalise ``#1f4e79`` / ``1F4E79`` / ``#abc`` / ``blue`` to ``"1F4E79"``.

    Returns None for None/empty so callers can treat "unset" uniformly.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    match = _HEX.match(text)
    if match:
        return match.group(1).upper()
    match = _HEX3.match(text)
    if match:
        return "".join(ch * 2 for ch in match.group(1)).upper()
    named = NAMED_COLORS.get(text.lower())
    if named:
        return named
    raise ValueError(
        f"Unrecognised colour {value!r}. Use a hex string like '#1F4E79' or one of: "
        + ", ".join(sorted(NAMED_COLORS))
    )


def rgb(value: str | None) -> RGBColor | None:
    hex_value = parse_color(value)
    return RGBColor.from_string(hex_value) if hex_value else None


# -- geometry --------------------------------------------------------------------

EMU_PER_CM = 360000


def cm_to_emu(value: float | int | None) -> int | None:
    return None if value is None else int(round(float(value) * EMU_PER_CM))


ALIGNMENTS: dict[str, WD_ALIGN_PARAGRAPH] = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "start": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "centre": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "end": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
    "both": WD_ALIGN_PARAGRAPH.JUSTIFY,
}

_TABLE_ALIGNMENTS = {
    "left": WD_TABLE_ALIGNMENT.LEFT,
    "center": WD_TABLE_ALIGNMENT.CENTER,
    "centre": WD_TABLE_ALIGNMENT.CENTER,
    "right": WD_TABLE_ALIGNMENT.RIGHT,
}


def align_paragraph(paragraph, value: str | None) -> None:
    if value:
        try:
            paragraph.alignment = ALIGNMENTS[str(value).lower()]
        except KeyError:
            raise ValueError(
                f"Unknown alignment {value!r}. Use one of: {', '.join(sorted(set(ALIGNMENTS)))}."
            ) from None


def table_alignment(value: str | None):
    if not value:
        return None
    try:
        return _TABLE_ALIGNMENTS[str(value).lower()]
    except KeyError:
        raise ValueError(f"Unknown table alignment {value!r}. Use left, center or right.") from None


# -- drawing ids -----------------------------------------------------------------


def next_drawing_id(document) -> int:
    """Allocate a ``wp:docPr`` id that is unique within the document.

    Word tolerates duplicates but LibreOffice and some validators do not, and the
    ids must also be unique across headers/footers, so we scan every part.
    """
    used: set[int] = {0}
    for part in _iter_story_elements(document):
        for doc_pr in part.iter(qn("wp:docPr")):
            try:
                used.add(int(doc_pr.get("id", "0")))
            except (TypeError, ValueError):
                continue
    return max(used) + 1


def _iter_story_elements(document) -> Iterable[etree._Element]:
    yield document.element.body
    for section in document.sections:
        for story in (
            section.header,
            section.first_page_header,
            section.even_page_header,
            section.footer,
            section.first_page_footer,
            section.even_page_footer,
        ):
            try:
                yield story._element
            except AttributeError:  # pragma: no cover — story not materialised
                continue


# -- DrawingML fragments ---------------------------------------------------------


def srgb_fill(color: str) -> str:
    """A ``<a:solidFill>`` XML fragment for use inside chart / shape properties."""
    return (
        '<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        f'<a:srgbClr val="{parse_color(color)}"/></a:solidFill>'
    )


def srgb_line(color: str, width_pt: float = 1.0) -> str:
    return (
        '<a:ln xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        f'w="{int(width_pt * 12700)}">{srgb_fill(color)}</a:ln>'
    )


# -- runs ------------------------------------------------------------------------

_HIGHLIGHTS = {
    "yellow",
    "green",
    "cyan",
    "magenta",
    "blue",
    "red",
    "darkBlue",
    "darkCyan",
    "darkGreen",
    "darkMagenta",
    "darkRed",
    "darkYellow",
    "darkGray",
    "lightGray",
    "black",
    "white",
}


def apply_run_format(run, fmt: dict[str, Any]) -> None:
    """Apply the RunSpec-style dict of formatting options to a python-docx run."""
    font = run.font
    if fmt.get("bold") is not None:
        run.bold = bool(fmt["bold"])
    if fmt.get("italic") is not None:
        run.italic = bool(fmt["italic"])
    if fmt.get("underline") is not None:
        run.underline = bool(fmt["underline"])
    if fmt.get("strike") is not None:
        font.strike = bool(fmt["strike"])
    if fmt.get("small_caps") is not None:
        font.small_caps = bool(fmt["small_caps"])
    if fmt.get("all_caps") is not None:
        font.all_caps = bool(fmt["all_caps"])
    if fmt.get("superscript"):
        font.superscript = True
    if fmt.get("subscript"):
        font.subscript = True
    if fmt.get("size_pt"):
        font.size = Pt(float(fmt["size_pt"]))
    if fmt.get("font"):
        _set_run_typeface(run, str(fmt["font"]))
    color = fmt.get("color")
    if color:
        font.color.rgb = rgb(color)
    highlight = fmt.get("highlight")
    if highlight:
        _set_highlight(run, str(highlight))
    if fmt.get("style"):
        run.style = fmt["style"]


def _set_run_typeface(run, name: str) -> None:
    """Set the typeface for all scripts, not just latin — matters for symbols and CJK."""
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = sub(rpr, "w:rFonts")
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        fonts.set(qn(attr), name)


def _set_highlight(run, value: str) -> None:
    normalised = value if value in _HIGHLIGHTS else value.lower()
    if normalised not in _HIGHLIGHTS:
        # fall back to shading, which accepts any colour
        rpr = run._element.get_or_add_rPr()
        shd = sub(rpr, "w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), parse_color(value) or "FFFF00")
        return
    rpr = run._element.get_or_add_rPr()
    sub(rpr, "w:highlight", **{"w:val": normalised})


def line_spacing_rule(value: float | None):
    if value is None:
        return None, None
    if abs(value - 1.0) < 1e-6:
        return 1.0, WD_LINE_SPACING.SINGLE
    return float(value), WD_LINE_SPACING.MULTIPLE
