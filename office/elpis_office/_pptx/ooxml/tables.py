# SPDX-License-Identifier: MIT
"""Table XML: cell borders, banding flags, built-in style ids.

python-pptx can fill a cell but cannot draw a line around it — ``a:tcPr`` border
children are XML-only. For a deck that is the whole game: a data table reads as
data because of its hairlines and its header rule, not its fill.
"""

from __future__ import annotations

from typing import Sequence

from .util import (
    TC_PR_ORDER,
    RGBColor,
    drop,
    frag,
    insert_in_order,
    parse_color,
    qn,
)

A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

_EDGES = {"left": "a:lnL", "right": "a:lnR", "top": "a:lnT", "bottom": "a:lnB"}

#: Built-in PowerPoint table styles, by the name they carry in the UI.
TABLE_STYLES = {
    "none": "{2D5ABB26-0587-4C30-8999-92F81FD0307C}",
    "no_style_no_grid": "{2D5ABB26-0587-4C30-8999-92F81FD0307C}",
    "no_style_table_grid": "{5940675A-B579-460E-94D1-54222C63F5DA}",
    "light_accent1": "{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}",
    "light_accent2": "{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}",
    "medium_accent1": "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
    "medium_accent2": "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}",
    "dark_accent1": "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}",
    "themed_style1_accent1": "{3C2FFA5D-87B4-456A-9821-1D502468CF0F}",
}


def _tc_pr(cell):
    """The ``a:tcPr`` of a table cell, created if the producer left it out."""
    tc = cell._tc
    tc_pr = tc.find(qn("a:tcPr"))
    if tc_pr is None:
        tc_pr = frag(f"<a:tcPr {A_NS}/>")
        tc.append(tc_pr)  # tcPr is the last child of a:tc
    return tc_pr


def set_cell_border(
    cell,
    edges: Sequence[str] = ("left", "right", "top", "bottom"),
    color: str | None = "D9D9D9",
    width_pt: float = 0.75,
    dash: str | None = None,
) -> None:
    """Draw (or, with ``color=None``, erase) borders on a cell.

    The four edge elements are a strict sequence in ``a:tcPr``; writing them out
    of order is one of the few things PowerPoint refuses outright.
    """
    tc_pr = _tc_pr(cell)
    for edge in edges:
        tag = _EDGES.get(str(edge).lower())
        if tag is None:
            raise ValueError(f"Unknown cell edge {edge!r}. Use left, right, top or bottom.")
        drop(tc_pr, tag)
        if color is None:
            body = "<a:noFill/>"
        else:
            dash_xml = f'<a:prstDash val="{dash}"/>' if dash else ""
            body = (
                f'<a:solidFill><a:srgbClr val="{parse_color(color)}"/></a:solidFill>{dash_xml}'
            )
        insert_in_order(tc_pr, frag(
            f'<{tag} {A_NS} w="{int(round(width_pt * 12700))}" cap="flat" cmpd="sng" algn="ctr">'
            f"{body}</{tag}>"
        ), TC_PR_ORDER)


def clear_borders(table) -> None:
    for row in table.rows:
        for cell in row.cells:
            set_cell_border(cell, color=None)


def set_cell_fill(cell, color: str | None) -> None:
    if color is None:
        tc_pr = _tc_pr(cell)
        drop(tc_pr, "a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill")
        insert_in_order(tc_pr, frag(f"<a:noFill {A_NS}/>"), TC_PR_ORDER)
        return
    cell.fill.solid()
    cell.fill.fore_color.rgb = RGBColor.from_string(parse_color(color))


def set_cell_margins(cell, left=0.15, top=0.08, right=0.15, bottom=0.08) -> None:
    """Cell padding in centimetres — python-pptx wants EMU."""
    from .util import cm_to_emu

    cell.margin_left = cm_to_emu(left)
    cell.margin_top = cm_to_emu(top)
    cell.margin_right = cm_to_emu(right)
    cell.margin_bottom = cm_to_emu(bottom)


def set_table_style(table, style: str | None) -> None:
    """Point the table at a built-in style GUID, or at 'none' for a bare grid."""
    if style is None:
        return
    key = str(style).strip().lower().replace(" ", "_").replace("-", "_")
    guid = TABLE_STYLES.get(key)
    if guid is None:
        raise ValueError(
            f"Unknown table style {style!r}. Use one of: {', '.join(sorted(TABLE_STYLES))}."
        )
    tbl = table._tbl
    tbl_pr = tbl.find(qn("a:tblPr"))
    if tbl_pr is None:
        tbl_pr = frag(f"<a:tblPr {A_NS}/>")
        tbl.insert(0, tbl_pr)
    drop(tbl_pr, "a:tableStyleId")
    tbl_pr.append(frag(f"<a:tableStyleId {A_NS}>{guid}</a:tableStyleId>"))


def set_banding(table, first_row: bool = True, band_rows: bool = True,
                first_column: bool = False, last_row: bool = False) -> None:
    tbl = table._tbl
    tbl_pr = tbl.find(qn("a:tblPr"))
    if tbl_pr is None:
        tbl_pr = frag(f"<a:tblPr {A_NS}/>")
        tbl.insert(0, tbl_pr)
    tbl_pr.set("firstRow", "1" if first_row else "0")
    tbl_pr.set("bandRow", "1" if band_rows else "0")
    tbl_pr.set("firstCol", "1" if first_column else "0")
    tbl_pr.set("lastRow", "1" if last_row else "0")


def merge_region(table, row_start: int, col_start: int, row_end: int, col_end: int) -> None:
    """Merge an inclusive rectangle of cells."""
    origin = table.cell(row_start, col_start)
    corner = table.cell(row_end, col_end)
    origin.merge(corner)
