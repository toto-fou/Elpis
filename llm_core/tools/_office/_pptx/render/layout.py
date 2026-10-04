# SPDX-License-Identifier: MIT
"""The geometry engine: where things go, and how big the text has to be to fit.

A slide is a fixed canvas. Nothing reflows, nothing scrolls — so every element
either has a rectangle computed for it or it overlaps something else. This module
owns that arithmetic: named bands (title, content, footer), a 12-column grid over
the content area, and a text fitter that picks a font size from the box it has to
live in rather than hoping.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

EMU_PER_CM = 360000
PT_PER_CM = 28.3465

#: Proportions of the slide, taken from a 16:9 deck at 33.87 × 19.05 cm and
#: expressed as fractions so 4:3 and A4 land somewhere sensible too.
MARGIN_X_RATIO = 0.058
MARGIN_TOP_RATIO = 0.0709
MARGIN_BOTTOM_RATIO = 0.0551
TITLE_H_RATIO = 0.0919
KICKER_H_RATIO = 0.0341
TITLE_GAP_RATIO = 0.0300
FOOTER_H_RATIO = 0.0394

#: How much wider than tall a typical glyph is not — the fraction of the font
#: size an average latin character occupies. Measured across Calibri, Segoe UI
#: and Arial at body sizes; deliberately a touch generous so the fitter errs
#: towards shrinking rather than towards overflow.
CHAR_WIDTH_RATIO = 0.50
LINE_HEIGHT_RATIO = 1.22


def cm(value: float) -> int:
    return int(round(float(value) * EMU_PER_CM))


def to_cm(value: int | float) -> float:
    return round(float(value) / EMU_PER_CM, 3)


@dataclass(frozen=True)
class Frame:
    """A rectangle in EMU. Immutable — every operation returns a new one."""

    x: int
    y: int
    w: int
    h: int

    # -- edges -------------------------------------------------------------------

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    @property
    def cx(self) -> int:
        return self.x + self.w // 2

    @property
    def cy(self) -> int:
        return self.y + self.h // 2

    @property
    def w_cm(self) -> float:
        return to_cm(self.w)

    @property
    def h_cm(self) -> float:
        return to_cm(self.h)

    def as_tuple(self) -> tuple[int, int, int, int]:
        return self.x, self.y, self.w, self.h

    def as_cm(self) -> dict[str, float]:
        return {"x_cm": to_cm(self.x), "y_cm": to_cm(self.y),
                "w_cm": to_cm(self.w), "h_cm": to_cm(self.h)}

    # -- transforms --------------------------------------------------------------

    def pad(self, left: int = 0, top: int = 0, right: int = 0, bottom: int = 0) -> "Frame":
        return Frame(self.x + left, self.y + top,
                     max(0, self.w - left - right), max(0, self.h - top - bottom))

    def inset(self, amount: int) -> "Frame":
        return self.pad(amount, amount, amount, amount)

    def offset(self, dx: int = 0, dy: int = 0) -> "Frame":
        return Frame(self.x + dx, self.y + dy, self.w, self.h)

    def resized(self, w: int | None = None, h: int | None = None) -> "Frame":
        return Frame(self.x, self.y, self.w if w is None else w, self.h if h is None else h)

    def moved(self, x: int | None = None, y: int | None = None) -> "Frame":
        return Frame(self.x if x is None else x, self.y if y is None else y, self.w, self.h)

    def centred_in(self, other: "Frame") -> "Frame":
        return Frame(other.x + (other.w - self.w) // 2, other.y + (other.h - self.h) // 2,
                     self.w, self.h)

    def top_slice(self, height: int) -> "Frame":
        return Frame(self.x, self.y, self.w, min(height, self.h))

    def bottom_slice(self, height: int) -> "Frame":
        height = min(height, self.h)
        return Frame(self.x, self.bottom - height, self.w, height)

    def below(self, other: "Frame", gap: int = 0) -> "Frame":
        """This frame, moved to start just under ``other``, keeping its height."""
        return Frame(self.x, other.bottom + gap, self.w, self.h)

    def remaining_below(self, other: "Frame", gap: int = 0) -> "Frame":
        """Everything of this frame that is left under ``other``."""
        top = other.bottom + gap
        return Frame(self.x, top, self.w, max(0, self.bottom - top))

    # -- subdivision -------------------------------------------------------------

    def columns(self, count: int, gap: int = 0, weights: Sequence[float] | None = None
                ) -> list["Frame"]:
        count = max(1, int(count))
        if weights and len(weights) == count and sum(weights) > 0:
            total = sum(weights)
            free = self.w - gap * (count - 1)
            widths = [int(free * weight / total) for weight in weights]
        else:
            free = self.w - gap * (count - 1)
            widths = [free // count] * count
            widths[-1] += free - sum(widths)
        frames, cursor = [], self.x
        for width in widths:
            frames.append(Frame(cursor, self.y, width, self.h))
            cursor += width + gap
        return frames

    def rows(self, count: int, gap: int = 0, weights: Sequence[float] | None = None
             ) -> list["Frame"]:
        count = max(1, int(count))
        if weights and len(weights) == count and sum(weights) > 0:
            total = sum(weights)
            free = self.h - gap * (count - 1)
            heights = [int(free * weight / total) for weight in weights]
        else:
            free = self.h - gap * (count - 1)
            heights = [free // count] * count
            heights[-1] += free - sum(heights)
        frames, cursor = [], self.y
        for height in heights:
            frames.append(Frame(self.x, cursor, self.w, height))
            cursor += height + gap
        return frames

    def split_h(self, ratio: float = 0.5, gap: int = 0) -> tuple["Frame", "Frame"]:
        ratio = max(0.05, min(0.95, float(ratio)))
        left_w = int((self.w - gap) * ratio)
        return (Frame(self.x, self.y, left_w, self.h),
                Frame(self.x + left_w + gap, self.y, self.w - left_w - gap, self.h))

    def split_v(self, ratio: float = 0.5, gap: int = 0) -> tuple["Frame", "Frame"]:
        ratio = max(0.05, min(0.95, float(ratio)))
        top_h = int((self.h - gap) * ratio)
        return (Frame(self.x, self.y, self.w, top_h),
                Frame(self.x, self.y + top_h + gap, self.w, self.h - top_h - gap))

    def grid_cell(self, col: int, row: int, cols: int = 1, rows_: int = 1,
                  columns: int = 12, rows_total: int = 6, gap: int = 0) -> "Frame":
        """A cell of a ``columns × rows_total`` grid laid over this frame."""
        col_w = (self.w - gap * (columns - 1)) / columns
        row_h = (self.h - gap * (rows_total - 1)) / rows_total
        x = self.x + round(col * (col_w + gap))
        y = self.y + round(row * (row_h + gap))
        w = round(cols * col_w + gap * (cols - 1))
        h = round(rows_ * row_h + gap * (rows_ - 1))
        return Frame(int(x), int(y), int(w), int(h))


@dataclass(frozen=True)
class Geometry:
    """Named bands of one slide, computed once per deck."""

    width: int
    height: int

    @classmethod
    def from_presentation(cls, presentation) -> "Geometry":
        return cls(int(presentation.slide_width), int(presentation.slide_height))

    # -- metrics -----------------------------------------------------------------

    @property
    def margin_x(self) -> int:
        return int(self.width * MARGIN_X_RATIO)

    @property
    def margin_top(self) -> int:
        return int(self.height * MARGIN_TOP_RATIO)

    @property
    def margin_bottom(self) -> int:
        return int(self.height * MARGIN_BOTTOM_RATIO)

    @property
    def title_height(self) -> int:
        return int(self.height * TITLE_H_RATIO)

    @property
    def kicker_height(self) -> int:
        return int(self.height * KICKER_H_RATIO)

    @property
    def title_gap(self) -> int:
        return int(self.height * TITLE_GAP_RATIO)

    @property
    def footer_height(self) -> int:
        return int(self.height * FOOTER_H_RATIO)

    @property
    def gap(self) -> int:
        """The one spacing unit everything else is a multiple of."""
        return int(self.height * 0.026)

    @property
    def height_cm(self) -> float:
        return to_cm(self.height)

    @property
    def width_cm(self) -> float:
        return to_cm(self.width)

    # -- bands -------------------------------------------------------------------

    def full(self) -> Frame:
        return Frame(0, 0, self.width, self.height)

    def safe(self) -> Frame:
        """Everything inside the margins, footer band excluded."""
        top = self.margin_top
        bottom = self.height - self.margin_bottom - self.footer_height
        return Frame(self.margin_x, top, self.width - 2 * self.margin_x, max(0, bottom - top))

    def kicker(self) -> Frame:
        return Frame(self.margin_x, self.margin_top, self.width - 2 * self.margin_x,
                     self.kicker_height)

    def title(self, with_kicker: bool = False) -> Frame:
        top = self.margin_top + (self.kicker_height if with_kicker else 0)
        return Frame(self.margin_x, top, self.width - 2 * self.margin_x, self.title_height)

    def content(self, with_title: bool = True, with_kicker: bool = False) -> Frame:
        """The area a slide's payload gets, once the title band is accounted for."""
        if with_title:
            title = self.title(with_kicker)
            top = title.bottom + self.title_gap
        else:
            top = self.margin_top
        bottom = self.height - self.margin_bottom - self.footer_height
        return Frame(self.margin_x, top, self.width - 2 * self.margin_x, max(0, bottom - top))

    def footer(self) -> Frame:
        return Frame(self.margin_x, self.height - self.margin_bottom - self.footer_height,
                     self.width - 2 * self.margin_x, self.footer_height)

    def area(self, name: str, with_title: bool = True) -> Frame:
        """Resolve a named area — what a ``frame: {area: "..."}`` spec asks for."""
        content = self.content(with_title=with_title)
        areas = {
            "full": self.full(),
            "slide": self.full(),
            "safe": self.safe(),
            "title": self.title(),
            "kicker": self.kicker(),
            "content": content,
            "footer": self.footer(),
            "left": content.split_h(0.5, self.gap)[0],
            "right": content.split_h(0.5, self.gap)[1],
            "top": content.split_v(0.5, self.gap)[0],
            "bottom": content.split_v(0.5, self.gap)[1],
            "top_half": content.split_v(0.5, self.gap)[0],
            "bottom_half": content.split_v(0.5, self.gap)[1],
        }
        try:
            return areas[str(name).strip().lower()]
        except KeyError:
            raise ValueError(
                f"Unknown area {name!r}. Use one of: {', '.join(sorted(areas))}."
            ) from None


# ---------------------------------------------------------------------------
# Text fitting
# ---------------------------------------------------------------------------


def chars_per_line(width_cm: float, font_pt: float, char_ratio: float = CHAR_WIDTH_RATIO) -> int:
    """How many average characters fit on one line of this width."""
    char_cm = font_pt * char_ratio / PT_PER_CM
    if char_cm <= 0:
        return 1
    return max(1, int(width_cm / char_cm))


def wrapped_lines(text: str, width_cm: float, font_pt: float,
                  char_ratio: float = CHAR_WIDTH_RATIO) -> int:
    """Line count after wrapping, counting explicit newlines too."""
    if not text:
        return 1
    per_line = chars_per_line(width_cm, font_pt, char_ratio)
    total = 0
    for segment in str(text).split("\n"):
        total += max(1, math.ceil(len(segment) / per_line))
    return total


def text_height_cm(
    items: Sequence[tuple[str, int]],
    width_cm: float,
    font_pt: float,
    *,
    line_spacing: float = 1.0,
    space_before_pt: float = 0.0,
    indent_cm: float = 0.85,
    char_ratio: float = CHAR_WIDTH_RATIO,
) -> float:
    """Height a list of ``(text, level)`` paragraphs needs at this font size."""
    line_cm = font_pt * LINE_HEIGHT_RATIO * line_spacing / PT_PER_CM
    gap_cm = space_before_pt / PT_PER_CM
    total = 0.0
    for index, (text, level) in enumerate(items):
        available = max(1.0, width_cm - indent_cm * max(0, level))
        total += wrapped_lines(text, available, font_pt, char_ratio) * line_cm
        if index:
            total += gap_cm
    return total


def fit_font_size(
    items: Sequence[tuple[str, int]],
    frame: Frame,
    *,
    base_pt: float,
    min_pt: float = 10.0,
    line_spacing: float = 1.0,
    space_before_pt: float = 0.0,
    indent_cm: float = 0.85,
    inset_cm: float = 0.5,
    char_ratio: float = CHAR_WIDTH_RATIO,
    max_lines: int | None = None,
) -> float:
    """Largest size from ``base_pt`` down that fits the items inside the frame.

    ``max_lines`` additionally caps how many lines the text may wrap onto — a KPI
    number that breaks in half is worse than a smaller KPI number, and no height
    check catches that on its own.

    Returns ``min_pt`` when even that overflows — the caller then knows the box is
    genuinely too small and can say so in the build notes rather than silently
    producing a slide with text running off the bottom.
    """
    width_cm = max(1.0, frame.w_cm - inset_cm)
    height_cm = max(1.0, frame.h_cm - inset_cm * 0.6)
    size = float(base_pt)
    while size > min_pt:
        needed = text_height_cm(
            items, width_cm, size, line_spacing=line_spacing,
            space_before_pt=space_before_pt * size / max(base_pt, 1.0),
            indent_cm=indent_cm, char_ratio=char_ratio,
        )
        fits_height = needed <= height_cm
        fits_lines = max_lines is None or sum(
            wrapped_lines(text, max(1.0, width_cm - indent_cm * max(0, level)), size, char_ratio)
            for text, level in items
        ) <= max_lines
        if fits_height and fits_lines:
            return round(size, 1)
        size -= 0.5
    return round(min_pt, 1)


def overflows(
    items: Sequence[tuple[str, int]],
    frame: Frame,
    font_pt: float,
    **kwargs,
) -> bool:
    width_cm = max(1.0, frame.w_cm - kwargs.pop("inset_cm", 0.5))
    return text_height_cm(items, width_cm, font_pt, **kwargs) > frame.h_cm


def distribute(count: int, frame: Frame, gap: int, horizontal: bool = True) -> list[Frame]:
    """Evenly split a frame into ``count`` tiles — the KPI / process / agenda helper."""
    if count <= 0:
        return []
    return frame.columns(count, gap) if horizontal else frame.rows(count, gap)


def flow(frames: Iterable[Frame]) -> Frame:
    """The bounding box of several frames."""
    items = list(frames)
    if not items:
        return Frame(0, 0, 0, 0)
    x = min(f.x for f in items)
    y = min(f.y for f in items)
    return Frame(x, y, max(f.right for f in items) - x, max(f.bottom for f in items) - y)
