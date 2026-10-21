# SPDX-License-Identifier: MIT
"""Small shared primitives: namespaces, element construction, colours, lengths.

Every element this package writes goes through :func:`frag` / :func:`make`, which
run the XML through python-pptx's own parser. That matters: python-pptx maps a
number of tags onto custom lxml classes, and an element built with bare lxml
would be inserted as a plain node that its accessors then choke on.

OOXML element content is a *sequence*, not a bag — a child in the wrong position
makes PowerPoint refuse the file outright — so anything hand-written is inserted
through :func:`insert_in_order` with the sequence from the relevant CT_* type.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Sequence

from lxml import etree
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn
from pptx.util import Cm, Emu, Inches, Pt

__all__ = [
    "Cm",
    "Emu",
    "Inches",
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
    "drop",
    "parse_color",
    "rgb",
    "mix",
    "relative_luminance",
    "readable_text_color",
    "sanitize_text",
    "ALIGNMENTS",
    "ANCHORS",
    "cm_to_emu",
    "emu_to_cm",
    "srgb_fill",
    "srgb_line",
    "BODY_PR_ORDER",
    "PPR_ORDER",
    "RPR_ORDER",
    "SPPR_ORDER",
    "CSLD_ORDER",
    "SLD_ORDER",
    "TC_PR_ORDER",
]

#: Prefixes that appear in the fragments this package writes.
PREFIXES = ("a", "p", "r", "c", "pic")


# ---------------------------------------------------------------------------
# Element construction
# ---------------------------------------------------------------------------


def frag(xml: str) -> etree._Element:
    """Parse an XML fragment through python-pptx's parser (custom classes included)."""
    return parse_xml(xml)


def make(tag: str, **attrs: Any) -> etree._Element:
    """Create an element from a ``prefix:local`` tag.

    ``make("a:buChar", char="•")`` → ``<a:buChar char="•"/>``. Attribute
    names containing a colon are namespace-qualified; the rest are plain.
    Attributes whose value is None are skipped, which keeps callers free of
    conditional-append noise.
    """
    prefix = tag.split(":", 1)[0]
    # Duplicate xmlns declarations are a parse error, so build the set first.
    prefixes = [prefix] + [p for p in ("a", "p", "r") if p != prefix]
    element = parse_xml(f"<{tag} {nsdecls(*prefixes)}/>")
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


def drop(parent: etree._Element, *tags: str) -> None:
    """Remove every child with one of these ``prefix:local`` tags."""
    for tag in tags:
        for existing in parent.findall(qn(tag)):
            parent.remove(existing)


def replace_in_order(
    parent: etree._Element, tag: str, child: etree._Element | None, order: Sequence[str]
) -> etree._Element | None:
    """Drop every existing ``tag`` child, then insert ``child`` in schema order."""
    drop(parent, tag)
    if child is None:
        return None
    return insert_in_order(parent, child, order)


# ---------------------------------------------------------------------------
# Schema sequences
# ---------------------------------------------------------------------------

#: CT_TextBodyProperties
BODY_PR_ORDER = (
    "prstTxWarp", "noAutofit", "normAutofit", "spAutoFit", "scene3d", "sp3d", "flatTx", "extLst",
)
#: CT_TextParagraphProperties
PPR_ORDER = (
    "lnSpc", "spcBef", "spcAft", "buClrTx", "buClr", "buSzTx", "buSzPct", "buSzPts",
    "buFontTx", "buFont", "buNone", "buAutoNum", "buChar", "tabLst", "defRPr", "extLst",
)
#: CT_TextCharacterProperties
RPR_ORDER = (
    "ln", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill",
    "effectLst", "effectDag", "highlight", "uLnTx", "uLn", "uFillTx", "uFill",
    "latin", "ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst",
)
#: CT_ShapeProperties
SPPR_ORDER = (
    "xfrm", "custGeom", "prstGeom", "noFill", "solidFill", "gradFill", "blipFill",
    "pattFill", "grpFill", "ln", "effectLst", "effectDag", "scene3d", "sp3d", "extLst",
)
#: CT_CommonSlideData
CSLD_ORDER = ("bg", "spTree", "custDataLst", "controls", "extLst")
#: CT_Slide
SLD_ORDER = ("cSld", "clrMapOvr", "transition", "timing", "extLst")
#: CT_TableCellProperties — the border elements are a strict sequence.
TC_PR_ORDER = (
    "lnL", "lnR", "lnT", "lnB", "lnTlToBr", "lnBlToTr", "cell3D",
    "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "headers", "extLst",
)


# ---------------------------------------------------------------------------
# Text hygiene
# ---------------------------------------------------------------------------

#: XML 1.0 cannot carry these at all; lxml refuses them with a cryptic error.
_XML_UNSAFE = re.compile("[\x00-\x08\x0e-\x1f\x7f\ud800-\udfff\ufdd0-\ufdef\ufffe\uffff]")
#: Vertical whitespace that pasted text (PDFs, terminals, Excel) carries often.
_VERTICAL_WS = re.compile("[\x0b\x0c\u2028\u2029]")


def sanitize_text(value: str) -> str:
    """Make arbitrary caller text XML-safe instead of failing the whole call.

    Line- and paragraph-separators become newlines (the text writer turns those
    into real line breaks); the characters XML 1.0 simply cannot represent — C0
    controls, lone surrogates, non-characters — are dropped.
    """
    if not isinstance(value, str):
        return value
    value = _VERTICAL_WS.sub("\n", value)
    return _XML_UNSAFE.sub("", value)


# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------

_HEX = re.compile(r"^#?([0-9A-Fa-f]{6})$")
_HEX3 = re.compile(r"^#?([0-9A-Fa-f]{3})$")

NAMED_COLORS: dict[str, str] = {
    "black": "000000",
    "white": "FFFFFF",
    "red": "E34948",
    "orange": "EB6834",
    "amber": "EDA100",
    "yellow": "FFD966",
    "green": "008300",
    "aqua": "1BAF7A",
    "teal": "2E9599",
    "cyan": "00B0F0",
    "blue": "2A78D6",
    "navy": "1F3864",
    "lightblue": "5B9BD5",
    "indigo": "4472C4",
    "purple": "7030A0",
    "violet": "4A3AA7",
    "magenta": "E87BA4",
    "pink": "E75480",
    "brown": "833C0C",
    "grey": "808080",
    "gray": "808080",
    "lightgrey": "D9D9D9",
    "lightgray": "D9D9D9",
    "darkgrey": "404040",
    "darkgray": "404040",
    "silver": "BFBFBF",
    "transparent": "FFFFFF",
}


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


def _channels(value: str) -> tuple[int, int, int]:
    hex_value = parse_color(value) or "000000"
    return int(hex_value[0:2], 16), int(hex_value[2:4], 16), int(hex_value[4:6], 16)


def mix(color: str, other: str, weight: float) -> str:
    """Blend ``color`` towards ``other``; weight 0 keeps colour, 1 becomes other.

    Used everywhere a design needs a lighter or darker relative of the accent —
    tints for KPI tiles, hairlines, hover-free "muted" text — without asking the
    caller to supply five colours instead of one.
    """
    weight = max(0.0, min(1.0, float(weight)))
    left, right = _channels(color), _channels(other)
    blended = tuple(round(a + (b - a) * weight) for a, b in zip(left, right))
    return "".join(f"{channel:02X}" for channel in blended)


def tint(color: str, amount: float) -> str:
    """Mix towards white."""
    return mix(color, "FFFFFF", amount)


def shade(color: str, amount: float) -> str:
    """Mix towards black."""
    return mix(color, "000000", amount)


def relative_luminance(color: str) -> float:
    """WCAG relative luminance, 0 (black) to 1 (white)."""

    def channel(raw: int) -> float:
        srgb = raw / 255
        return srgb / 12.92 if srgb <= 0.03928 else ((srgb + 0.055) / 1.055) ** 2.4

    red, green, blue = (channel(c) for c in _channels(color))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(first: str, second: str) -> float:
    light, dark = sorted((relative_luminance(first), relative_luminance(second)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def readable_text_color(background: str, dark: str = "1A1A1A", light: str = "FFFFFF") -> str:
    """Pick whichever of ``dark``/``light`` contrasts better with the background.

    Slides put text on coloured tiles constantly. Choosing the foreground from
    the fill — rather than trusting the caller to — is what keeps a red "danger"
    tile and a pale grey tile both legible.
    """
    return dark if contrast_ratio(background, dark) >= contrast_ratio(background, light) else light


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

EMU_PER_CM = 360000


def cm_to_emu(value: float | int | None) -> int | None:
    return None if value is None else int(round(float(value) * EMU_PER_CM))


def emu_to_cm(value: int | None) -> float | None:
    return None if value is None else round(float(value) / EMU_PER_CM, 3)


ALIGNMENTS: dict[str, PP_ALIGN] = {
    "left": PP_ALIGN.LEFT,
    "start": PP_ALIGN.LEFT,
    "center": PP_ALIGN.CENTER,
    "centre": PP_ALIGN.CENTER,
    "right": PP_ALIGN.RIGHT,
    "end": PP_ALIGN.RIGHT,
    "justify": PP_ALIGN.JUSTIFY,
    "both": PP_ALIGN.JUSTIFY,
}

ANCHORS: dict[str, MSO_ANCHOR] = {
    "top": MSO_ANCHOR.TOP,
    "middle": MSO_ANCHOR.MIDDLE,
    "center": MSO_ANCHOR.MIDDLE,
    "centre": MSO_ANCHOR.MIDDLE,
    "bottom": MSO_ANCHOR.BOTTOM,
}


def alignment(value: str | None) -> PP_ALIGN | None:
    if not value:
        return None
    try:
        return ALIGNMENTS[str(value).lower()]
    except KeyError:
        raise ValueError(
            f"Unknown alignment {value!r}. Use one of: {', '.join(sorted(set(ALIGNMENTS)))}."
        ) from None


def anchor(value: str | None) -> MSO_ANCHOR | None:
    if not value:
        return None
    try:
        return ANCHORS[str(value).lower()]
    except KeyError:
        raise ValueError(
            f"Unknown vertical alignment {value!r}. Use top, middle or bottom."
        ) from None


# ---------------------------------------------------------------------------
# DrawingML fragments
# ---------------------------------------------------------------------------

A_NS_DECL = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'


def srgb_fill(color: str, alpha: float | None = None) -> str:
    """An ``<a:solidFill>`` fragment for use inside shape / chart properties."""
    body = f'<a:srgbClr val="{parse_color(color)}">'
    body += f'<a:alpha val="{int(round(max(0.0, min(1.0, alpha)) * 100000))}"/>' if alpha is not None else ""
    body += "</a:srgbClr>"
    return f"<a:solidFill {A_NS_DECL}>{body}</a:solidFill>"


def srgb_line(color: str, width_pt: float = 1.0, dash: str | None = None) -> str:
    dash_xml = f'<a:prstDash val="{dash}"/>' if dash else ""
    return (
        f'<a:ln {A_NS_DECL} w="{int(width_pt * 12700)}" cap="flat">'
        f"{srgb_fill(color)}{dash_xml}</a:ln>"
    )


def no_fill() -> str:
    return f"<a:noFill {A_NS_DECL}/>"


def no_line() -> str:
    return f'<a:ln {A_NS_DECL}><a:noFill/></a:ln>'


def iter_shape_elements(container) -> Iterable[etree._Element]:
    """Every ``p:sp``/``p:pic``/``p:graphicFrame`` element under a shape tree."""
    for tag in ("p:sp", "p:pic", "p:graphicFrame", "p:grpSp", "p:cxnSp"):
        yield from container.findall(qn(tag))
