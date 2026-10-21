# SPDX-License-Identifier: MIT
"""Shape-level DrawingML: gradients, soft shadows, alt text, z-order.

python-pptx models solid fills and simple lines. Gradients past two preset stops,
outer shadows, and z-order are XML-only — and they are exactly what makes a KPI
tile or a section banner look designed rather than default.
"""

from __future__ import annotations

from typing import Sequence

from .util import (
    SPPR_ORDER,
    drop,
    frag,
    insert_in_order,
    make,
    parse_color,
    qn,
)

A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

_DASHES = {
    "solid": "solid",
    "dot": "sysDot",
    "dash": "dash",
    "dash_dot": "dashDot",
    "long_dash": "lgDash",
    "round_dot": "sysDot",
}


def strip_style(shape) -> None:
    """Drop the ``p:style`` block python-pptx attaches to every new autoshape.

    That block points at the theme's fill, line, effect and font *references*.
    An explicit ``a:effectLst`` in ``spPr`` is supposed to win, and PowerPoint
    agrees — but LibreOffice still honours ``effectRef``, so a shape we asked to
    be flat comes out with a drop shadow. Removing the whole block is the only
    way to get the same picture in both, and everything it supplied is set
    explicitly here anyway.
    """
    element = shape._element
    for child in element.findall(qn("p:style")):
        element.remove(child)


def _sp_pr(shape):
    """The ``p:spPr`` of any shape that has one, else None.

    Autoshapes, pictures and connectors carry shape properties; a graphic frame
    (table, chart) does not — its visual properties live inside the graphic.
    """
    return getattr(shape._element, "spPr", None)


def _alpha(value: float | None) -> str:
    if value is None:
        return ""
    return f'<a:alpha val="{int(round(max(0.0, min(1.0, value)) * 100000))}"/>'


# ---------------------------------------------------------------------------
# Fill
# ---------------------------------------------------------------------------


def solid_fill(shape, color: str, alpha: float | None = None) -> None:
    sp_pr = _sp_pr(shape)
    if sp_pr is None:
        return
    drop(sp_pr, "a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill")
    insert_in_order(sp_pr, frag(
        f'<a:solidFill {A_NS}><a:srgbClr val="{parse_color(color)}">{_alpha(alpha)}'
        "</a:srgbClr></a:solidFill>"
    ), SPPR_ORDER)


def gradient_fill(
    shape,
    colors: Sequence[str],
    *,
    angle_deg: float = 90.0,
    alphas: Sequence[float | None] | None = None,
) -> None:
    """Linear gradient across 2+ stops, spread evenly.

    Angle is the DrawingML convention: 0° left-to-right, 90° top-to-bottom.
    """
    sp_pr = _sp_pr(shape)
    if sp_pr is None or not colors:
        return
    stops = list(colors)
    if len(stops) == 1:
        stops = [stops[0], stops[0]]
    alpha_list = list(alphas or [None] * len(stops))
    alpha_list += [None] * (len(stops) - len(alpha_list))

    pieces = []
    for index, color in enumerate(stops):
        position = int(round(index / (len(stops) - 1) * 100000))
        pieces.append(
            f'<a:gs pos="{position}"><a:srgbClr val="{parse_color(color)}">'
            f"{_alpha(alpha_list[index])}</a:srgbClr></a:gs>"
        )
    drop(sp_pr, "a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill")
    insert_in_order(sp_pr, frag(
        f'<a:gradFill {A_NS} rotWithShape="1">'
        f'<a:gsLst>{"".join(pieces)}</a:gsLst>'
        f'<a:lin ang="{int(round(angle_deg * 60000)) % 21600000}" scaled="0"/>'
        "</a:gradFill>"
    ), SPPR_ORDER)


def clear_fill(shape) -> None:
    sp_pr = _sp_pr(shape)
    if sp_pr is None:
        return
    drop(sp_pr, "a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill")
    insert_in_order(sp_pr, make("a:noFill"), SPPR_ORDER)


# ---------------------------------------------------------------------------
# Outline
# ---------------------------------------------------------------------------


def outline(
    shape,
    color: str | None = None,
    width_pt: float = 1.0,
    dash: str | None = None,
) -> None:
    sp_pr = _sp_pr(shape)
    if sp_pr is None:
        return
    drop(sp_pr, "a:ln")
    if color is None:
        insert_in_order(sp_pr, frag(f"<a:ln {A_NS}><a:noFill/></a:ln>"), SPPR_ORDER)
        return
    dash_xml = f'<a:prstDash val="{_DASHES.get(str(dash).lower(), "solid")}"/>' if dash else ""
    insert_in_order(sp_pr, frag(
        f'<a:ln {A_NS} w="{int(round(width_pt * 12700))}" cap="flat">'
        f'<a:solidFill><a:srgbClr val="{parse_color(color)}"/></a:solidFill>'
        f'{dash_xml}<a:round/></a:ln>'
    ), SPPR_ORDER)


def no_outline(shape) -> None:
    outline(shape, None)


# ---------------------------------------------------------------------------
# Effects
# ---------------------------------------------------------------------------


def soft_shadow(
    shape,
    *,
    blur_pt: float = 12.0,
    distance_pt: float = 3.0,
    direction_deg: float = 90.0,
    color: str = "000000",
    alpha: float = 0.16,
) -> None:
    """An outer shadow — soft, low-contrast, straight down by default.

    Defaults are deliberately restrained: a card lifts off the slide, it does not
    float above it. PowerPoint's own preset shadows are far heavier.
    """
    sp_pr = _sp_pr(shape)
    if sp_pr is None:
        return
    drop(sp_pr, "a:effectLst")
    insert_in_order(sp_pr, frag(
        f"<a:effectLst {A_NS}>"
        f'<a:outerShdw blurRad="{int(round(blur_pt * 12700))}" '
        f'dist="{int(round(distance_pt * 12700))}" '
        f'dir="{int(round(direction_deg * 60000)) % 21600000}" rotWithShape="0">'
        f'<a:srgbClr val="{parse_color(color)}">{_alpha(alpha)}</a:srgbClr>'
        "</a:outerShdw></a:effectLst>"
    ), SPPR_ORDER)


def no_shadow(shape) -> None:
    sp_pr = _sp_pr(shape)
    if sp_pr is None:
        return
    drop(sp_pr, "a:effectLst")
    insert_in_order(sp_pr, make("a:effectLst"), SPPR_ORDER)


# ---------------------------------------------------------------------------
# Identity and ordering
# ---------------------------------------------------------------------------


def _c_nv_pr(shape):
    """The shape's ``p:cNvPr``, whichever ``nv*Pr`` wrapper it happens to sit in."""
    for child in shape._element:
        found = child.find(qn("p:cNvPr"))
        if found is not None:
            return found
    return None


def set_alt_text(shape, text: str) -> None:
    """Accessibility description. Corporate decks are routinely audited for this."""
    c_nv_pr = _c_nv_pr(shape)
    if c_nv_pr is None:  # pragma: no cover — every shape kind above is covered
        return
    c_nv_pr.set("descr", text)


def set_hidden(shape, hidden: bool = True) -> None:
    c_nv_pr = _c_nv_pr(shape)
    if c_nv_pr is not None:
        c_nv_pr.set("hidden", "1" if hidden else "0")


def bring_to_front(shape) -> None:
    element = shape._element
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)
        parent.append(element)


def send_to_back(shape) -> None:
    """Move behind every sibling — but after ``p:nvGrpSpPr``/``p:grpSpPr``,
    which must stay the first two children of a shape tree."""
    element = shape._element
    parent = element.getparent()
    if parent is None:
        return
    parent.remove(element)
    anchor = None
    for child in parent:
        if child.tag in (qn("p:nvGrpSpPr"), qn("p:grpSpPr")):
            anchor = child
            continue
        break
    if anchor is None:
        parent.insert(0, element)
    else:
        anchor.addnext(element)


def delete_shape(shape) -> None:
    element = shape._element
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def set_adjustment(shape, index: int, value: float) -> None:
    """Autoshape adjustment handle, e.g. the corner radius of a rounded rectangle."""
    try:
        shape.adjustments[index] = value
    except (IndexError, AttributeError, ValueError):
        pass
