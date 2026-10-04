# SPDX-License-Identifier: MIT
"""Text-body XML python-pptx has no API for: bullets, autofit, fields, columns.

python-pptx gives you paragraphs, runs and fonts. It does not give you the bullet
glyph, the auto-shrink behaviour, or the live slide-number field — the three
things that separate a deck that looks hand-made from one that looks generated.
"""

from __future__ import annotations

import uuid
from typing import Any

from .util import (
    BODY_PR_ORDER,
    PPR_ORDER,
    RPR_ORDER,
    drop,
    frag,
    insert_in_order,
    make,
    parse_color,
    qn,
)

A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

#: Left indent per bullet level, in EMU. Level 0 hangs the glyph in the margin.
LEVEL_INDENT_EMU = 285750  # 0.25"
#: Bullet glyph per level — filled, hollow, dash. Deeper levels reuse the dash.
BULLET_CHARS = ("●", "○", "–", "–", "–")
#: Arial carries all three glyphs on Windows, macOS and every Linux font stack.
BULLET_FONT = "Arial"

_AUTONUM_TYPES = {
    "arabic": "arabicPeriod",
    "arabic_period": "arabicPeriod",
    "arabic_paren": "arabicParenR",
    "alpha": "alphaLcPeriod",
    "alpha_upper": "alphaUcPeriod",
    "roman": "romanLcPeriod",
    "roman_upper": "romanUcPeriod",
}


def _ppr(paragraph_element):
    """``a:pPr``, created in the right position if absent."""
    ppr = paragraph_element.find(qn("a:pPr"))
    if ppr is None:
        ppr = make("a:pPr")
        paragraph_element.insert(0, ppr)
    return ppr


def _body_pr(text_frame):
    body = text_frame._txBody
    body_pr = body.find(qn("a:bodyPr"))
    if body_pr is None:  # pragma: no cover — python-pptx always writes one
        body_pr = make("a:bodyPr")
        body.insert(0, body_pr)
    return body_pr


# ---------------------------------------------------------------------------
# Bullets
# ---------------------------------------------------------------------------


def set_bullet(
    paragraph,
    kind: str = "char",
    *,
    char: str | None = None,
    color: str | None = None,
    size_pct: int | None = 90,
    font: str = BULLET_FONT,
    start_at: int = 1,
    number_type: str = "arabic",
    level: int | None = None,
    indent_emu: int | None = None,
    hanging: bool = True,
) -> None:
    """Set (or clear) the bullet glyph on one paragraph.

    ``kind`` is ``"char"`` for a glyph, ``"number"`` for an auto-numbered list, or
    ``"none"`` for prose. Indentation is written explicitly rather than inherited:
    a text box built from scratch has no list styles to inherit from, so without
    this every level would sit flush left.
    """
    element = paragraph._p
    ppr = _ppr(element)
    drop(ppr, "a:buNone", "a:buChar", "a:buAutoNum", "a:buClr", "a:buSzPct", "a:buFont")

    depth = paragraph.level if level is None else level
    step = indent_emu if indent_emu is not None else LEVEL_INDENT_EMU

    if kind == "none":
        ppr.set("marL", str(max(0, depth) * step))
        ppr.set("indent", "0")
        insert_in_order(ppr, make("a:buNone"), PPR_ORDER)
        return

    left = (depth + 1) * step
    ppr.set("marL", str(left))
    ppr.set("indent", str(-step if hanging else 0))

    if color:
        insert_in_order(ppr, frag(
            f'<a:buClr {A_NS}><a:srgbClr val="{parse_color(color)}"/></a:buClr>'
        ), PPR_ORDER)
    if size_pct:
        insert_in_order(ppr, make("a:buSzPct", val=str(int(size_pct) * 1000)), PPR_ORDER)

    if kind == "number":
        insert_in_order(ppr, make("a:buFont", typeface=font, pitchFamily="34", charset="0"), PPR_ORDER)
        insert_in_order(ppr, make(
            "a:buAutoNum",
            type=_AUTONUM_TYPES.get(str(number_type).lower(), "arabicPeriod"),
            startAt=str(int(start_at)) if start_at and start_at != 1 else None,
        ), PPR_ORDER)
        return

    glyph = char or BULLET_CHARS[min(max(depth, 0), len(BULLET_CHARS) - 1)]
    insert_in_order(ppr, make("a:buFont", typeface=font, pitchFamily="34", charset="0"), PPR_ORDER)
    insert_in_order(ppr, make("a:buChar", char=glyph), PPR_ORDER)


def set_indent(paragraph, left_emu: int, hanging_emu: int = 0) -> None:
    ppr = _ppr(paragraph._p)
    ppr.set("marL", str(int(left_emu)))
    ppr.set("indent", str(int(-hanging_emu)))


# ---------------------------------------------------------------------------
# Body properties
# ---------------------------------------------------------------------------


def set_autofit(
    text_frame,
    mode: str = "shrink",
    *,
    font_scale: float | None = None,
    line_reduction: float | None = None,
) -> None:
    """Choose what happens when the text is taller than its box.

    ``shrink`` is PowerPoint's "shrink text on overflow". We compute a starting
    font size ourselves (see :mod:`pptx_mcp.render.layout`) so the deck looks
    right in every renderer; ``normAutofit`` is the safety net for the case where
    a real PowerPoint re-flows the text with different metrics.
    """
    body_pr = _body_pr(text_frame)
    drop(body_pr, "a:noAutofit", "a:normAutofit", "a:spAutoFit")
    if mode == "shrink":
        attrs: dict[str, Any] = {}
        if font_scale is not None:
            attrs["fontScale"] = str(int(round(max(0.25, min(1.0, font_scale)) * 100000)))
        if line_reduction is not None:
            attrs["lnSpcReduction"] = str(int(round(max(0.0, min(0.2, line_reduction)) * 100000)))
        insert_in_order(body_pr, make("a:normAutofit", **attrs), BODY_PR_ORDER)
    elif mode == "resize":
        insert_in_order(body_pr, make("a:spAutoFit"), BODY_PR_ORDER)
    else:
        insert_in_order(body_pr, make("a:noAutofit"), BODY_PR_ORDER)


def set_columns(text_frame, count: int, spacing_emu: int = 228600) -> None:
    body_pr = _body_pr(text_frame)
    body_pr.set("numCol", str(max(1, int(count))))
    body_pr.set("spcCol", str(int(spacing_emu)))


def set_wrap(text_frame, wrap: bool) -> None:
    _body_pr(text_frame).set("wrap", "square" if wrap else "none")


def set_insets(text_frame, left=None, top=None, right=None, bottom=None) -> None:
    """Text insets in EMU. python-pptx exposes these, but not on every shape type."""
    body_pr = _body_pr(text_frame)
    for attribute, value in (("lIns", left), ("tIns", top), ("rIns", right), ("bIns", bottom)):
        if value is not None:
            body_pr.set(attribute, str(int(value)))


# ---------------------------------------------------------------------------
# Fields
# ---------------------------------------------------------------------------


def add_field(paragraph, field_type: str = "slidenum", placeholder: str = "1"):
    """Append a live field run — the slide number that renumbers itself.

    A field needs a GUID that is unique within the presentation; PowerPoint
    rewrites the cached ``a:t`` on open, so the placeholder is only what other
    renderers show until then.
    """
    fld = frag(
        f'<a:fld {A_NS} id="{{{uuid.uuid4()}}}" type="{field_type}">'
        f"<a:t>{placeholder}</a:t></a:fld>"
    )
    paragraph._p.append(fld)
    return fld


def field_run_properties(field_element, *, size_pt=None, color=None, font=None, bold=None):
    """Style a field run — it carries its own ``a:rPr``, not the paragraph's."""
    rpr = field_element.find(qn("a:rPr"))
    if rpr is None:
        rpr = make("a:rPr", lang="en-US")
        field_element.insert(0, rpr)
    if size_pt is not None:
        rpr.set("sz", str(int(round(float(size_pt) * 100))))
    if bold is not None:
        rpr.set("b", "1" if bold else "0")
    if color:
        insert_in_order(rpr, frag(
            f'<a:solidFill {A_NS}><a:srgbClr val="{parse_color(color)}"/></a:solidFill>'
        ), RPR_ORDER)
    if font:
        insert_in_order(rpr, make("a:latin", typeface=font), RPR_ORDER)
        insert_in_order(rpr, make("a:cs", typeface=font), RPR_ORDER)
    return rpr


# ---------------------------------------------------------------------------
# Run-level extras
# ---------------------------------------------------------------------------


def set_typeface(run, name: str) -> None:
    """Set the typeface for latin, complex-script and east-asian text at once."""
    rpr = run._r.get_or_add_rPr()
    for tag in ("a:latin", "a:cs", "a:ea"):
        drop(rpr, tag)
        insert_in_order(rpr, make(tag, typeface=name), RPR_ORDER)


def set_strike(run, value: bool = True) -> None:
    run._r.get_or_add_rPr().set("strike", "sngStrike" if value else "noStrike")


def set_caps(run, mode: str) -> None:
    """``all``, ``small`` or ``none``."""
    run._r.get_or_add_rPr().set("cap", {"all": "all", "small": "small"}.get(mode, "none"))


def set_baseline(run, mode: str | None) -> None:
    """Superscript / subscript, expressed as a percentage baseline shift."""
    rpr = run._r.get_or_add_rPr()
    if mode == "superscript":
        rpr.set("baseline", "30000")
    elif mode == "subscript":
        rpr.set("baseline", "-25000")
    else:
        rpr.attrib.pop("baseline", None)


def set_char_spacing(run, points: float) -> None:
    """Letter-spacing — the cheapest way to make an all-caps kicker read well."""
    run._r.get_or_add_rPr().set("spc", str(int(round(float(points) * 100))))


def set_highlight(run, color: str) -> None:
    rpr = run._r.get_or_add_rPr()
    drop(rpr, "a:highlight")
    insert_in_order(rpr, frag(
        f'<a:highlight {A_NS}><a:srgbClr val="{parse_color(color)}"/></a:highlight>'
    ), RPR_ORDER)
