# SPDX-License-Identifier: MIT
"""Opening, reading and editing existing .pptx files.

Reading matters more for decks than for documents: the common enterprise task is
not "make me a deck" but "take last quarter's deck and update it". So the reader
reports positions and shape identities, not just text — enough for a caller to
name the shape it wants to change.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from ..commun import replace_in_runs
from .errors import InvalidSpec
from .ooxml.util import sanitize_text

# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def iter_text_frames(slide, include_tables: bool = True) -> Iterable[Any]:
    """Every text frame on a slide, groups and table cells included."""
    for shape in _iter_shapes(slide.shapes):
        if shape.has_text_frame:
            yield shape.text_frame
        if include_tables and getattr(shape, "has_table", False):
            for row in shape.table.rows:
                for cell in row.cells:
                    yield cell.text_frame


def _iter_shapes(shapes) -> Iterable[Any]:
    for shape in shapes:
        yield shape
        if shape.shape_type == 6 and hasattr(shape, "shapes"):  # MSO_SHAPE_TYPE.GROUP
            yield from _iter_shapes(shape.shapes)


def slide_title(slide) -> str | None:
    """The slide's title: its title placeholder, or the topmost text if it has none."""
    for placeholder in slide.placeholders:
        if placeholder.placeholder_format.type in (1, 3):  # TITLE, CENTER_TITLE
            text = (placeholder.text_frame.text or "").strip()
            if text:
                return text.split("\n")[0]
    best, best_top = None, None
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        text = (shape.text_frame.text or "").strip()
        if not text:
            continue
        top = int(shape.top or 0)
        if best_top is None or top < best_top:
            best, best_top = text.split("\n")[0], top
    return best


def shape_kind(shape) -> str:
    if getattr(shape, "has_chart", False):
        return "chart"
    if getattr(shape, "has_table", False):
        return "table"
    if shape.shape_type is not None and str(shape.shape_type).startswith("PICTURE"):
        return "picture"
    if shape.is_placeholder:
        return "placeholder"
    if shape.has_text_frame and (shape.text_frame.text or "").strip():
        return "text"
    return "shape"


# ---------------------------------------------------------------------------
# Editing
# ---------------------------------------------------------------------------


def set_metadata(presentation, **values: Any) -> dict[str, Any]:
    properties = presentation.core_properties
    applied = {}
    for key, value in values.items():
        if value is None:
            continue
        value = sanitize_text(value)
        if not hasattr(properties, key):
            raise InvalidSpec(
                f"Unknown metadata field {key!r}. Valid fields: title, subject, author, "
                "keywords, category, comments."
            )
        setattr(properties, key, value)
        applied[key] = value
    return applied


def replace_text(presentation, search: str, replacement: str, *, regex: bool = False,
                 ignore_case: bool = False) -> int:
    """Search and replace across the deck (slides, tables, notes), preserving run formatting.

    PowerPoint splits a sentence across runs at arbitrary points, so a match
    routinely spans several. Matches inside a single run are edited in place; a
    match that spans runs collapses onto the first run it touches, which is the
    only way to keep *some* formatting rather than none.
    """
    replacement = sanitize_text(replacement)
    flags = re.IGNORECASE if ignore_case else 0
    try:
        pattern = re.compile(search if regex else re.escape(search), flags)
    except re.error as exc:
        raise InvalidSpec(f"Invalid regular expression {search!r}: {exc}") from exc

    total = 0
    for slide in presentation.slides:
        for frame in iter_text_frames(slide):
            for paragraph in frame.paragraphs:
                total += replace_in_runs(paragraph.runs, pattern, replacement)
        if slide.has_notes_slide:
            for paragraph in slide.notes_slide.notes_text_frame.paragraphs:
                total += replace_in_runs(paragraph.runs, pattern, replacement)
    return total
