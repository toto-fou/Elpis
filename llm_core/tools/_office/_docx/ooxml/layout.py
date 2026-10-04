# SPDX-License-Identifier: MIT
"""Page geometry: paper size, orientation, margins, columns, section breaks."""

from __future__ import annotations

from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.shared import Cm

from .util import insert_in_order, make, qn

#: width x height in centimetres, portrait.
PAGE_SIZES: dict[str, tuple[float, float]] = {
    "a3": (29.7, 42.0),
    "a4": (21.0, 29.7),
    "a5": (14.8, 21.0),
    "letter": (21.59, 27.94),
    "legal": (21.59, 35.56),
    "tabloid": (27.94, 43.18),
    "executive": (18.41, 26.67),
}

_SECTION_STARTS = {
    "new_page": WD_SECTION.NEW_PAGE,
    "page": WD_SECTION.NEW_PAGE,
    "continuous": WD_SECTION.CONTINUOUS,
    "even_page": WD_SECTION.EVEN_PAGE,
    "odd_page": WD_SECTION.ODD_PAGE,
    "new_column": WD_SECTION.NEW_COLUMN,
}

#: CT_SectPr sequence.
SECTPR_ORDER = (
    "footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc", "pgBorders",
    "lnNumType", "pgNumType", "cols", "formProt", "vAlign", "noEndnote",
    "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings",
    "sectPrChange",
)


def page_size_cm(name: str | None) -> tuple[float, float] | None:
    if not name:
        return None
    key = str(name).strip().lower().replace(" ", "").replace("-", "")
    if key not in PAGE_SIZES:
        raise ValueError(
            f"Unknown page size {name!r}. Use one of: {', '.join(sorted(PAGE_SIZES))}, "
            "or give width_cm/height_cm explicitly."
        )
    return PAGE_SIZES[key]


def apply_page_setup(
    section,
    *,
    size: str | None = None,
    width_cm: float | None = None,
    height_cm: float | None = None,
    orientation: str | None = None,
    margins_cm: dict[str, float] | None = None,
    columns: int | None = None,
    column_spacing_cm: float | None = None,
    column_line: bool = False,
) -> None:
    """Apply page geometry to one section.

    Orientation is applied *after* the size so that landscape swaps the final
    dimensions — python-docx sets the ``w:orient`` attribute but never swaps
    ``pgSz``, which is the classic "why is my landscape page still portrait" trap.
    """
    dimensions = page_size_cm(size)
    if dimensions:
        width, height = dimensions
    else:
        width = width_cm
        height = height_cm

    if width is not None:
        section.page_width = Cm(float(width))
    if height is not None:
        section.page_height = Cm(float(height))

    if orientation:
        wanted = str(orientation).strip().lower()
        if wanted not in {"portrait", "landscape"}:
            raise ValueError(f"orientation must be 'portrait' or 'landscape', got {orientation!r}.")
        landscape = wanted == "landscape"
        current_w, current_h = section.page_width, section.page_height
        if current_w is not None and current_h is not None:
            long_side, short_side = max(current_w, current_h), min(current_w, current_h)
            section.page_width = long_side if landscape else short_side
            section.page_height = short_side if landscape else long_side
        section.orientation = WD_ORIENT.LANDSCAPE if landscape else WD_ORIENT.PORTRAIT

    for key, value in (margins_cm or {}).items():
        if value is None:
            continue
        attribute = {
            "top": "top_margin",
            "bottom": "bottom_margin",
            "left": "left_margin",
            "right": "right_margin",
            "gutter": "gutter",
            "header": "header_distance",
            "footer": "footer_distance",
        }.get(str(key).lower())
        if attribute is None:
            raise ValueError(
                f"Unknown margin {key!r}. Use top, bottom, left, right, gutter, header or footer."
            )
        setattr(section, attribute, Cm(float(value)))

    if columns:
        set_columns(section, int(columns), column_spacing_cm, column_line)


def set_columns(
    section, count: int, spacing_cm: float | None = None, line_between: bool = False
) -> None:
    if count < 1:
        raise ValueError("columns must be at least 1.")
    sect_pr = section._sectPr
    for existing in sect_pr.findall(qn("w:cols")):
        sect_pr.remove(existing)
    attrs = {"w:num": str(count), "w:equalWidth": "1"}
    if spacing_cm is not None:
        attrs["w:space"] = str(int(Cm(float(spacing_cm)).twips))
    if line_between:
        attrs["w:sep"] = "1"
    insert_in_order(sect_pr, make("w:cols", **attrs), SECTPR_ORDER)


def add_section(document, start: str = "new_page"):
    """Start a new section, inheriting the previous one's geometry."""
    key = str(start or "new_page").strip().lower()
    if key not in _SECTION_STARTS:
        raise ValueError(
            f"Unknown section start {start!r}. Use one of: {', '.join(sorted(_SECTION_STARTS))}."
        )
    return document.add_section(_SECTION_STARTS[key])


def restart_page_numbering(section, start: int = 1, number_format: str | None = None) -> None:
    """Make this section's page numbering restart, e.g. after a cover page."""
    sect_pr = section._sectPr
    for existing in sect_pr.findall(qn("w:pgNumType")):
        sect_pr.remove(existing)
    attrs = {"w:start": str(int(start))}
    if number_format:
        attrs["w:fmt"] = str(number_format)
    insert_in_order(sect_pr, make("w:pgNumType", **attrs), SECTPR_ORDER)


def content_width_cm(section) -> float:
    """Usable text width, for sizing images and tables to the page."""
    width = section.page_width or Cm(21)
    left = section.left_margin or Cm(2.5)
    right = section.right_margin or Cm(2.5)
    return max(1.0, (width - left - right) / 360000)
