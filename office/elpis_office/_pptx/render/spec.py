# SPDX-License-Identifier: MIT
"""The declarative deck spec.

This is the contract ``pptx_build`` exposes to the model: one JSON object that
describes a whole presentation. The models double as the tool's input schema, so
the field descriptions here are what the model actually reads when deciding how
to call it — they are documentation, not decoration.

The shape is deliberately two-tier. A slide names a *layout* ("kpi", "chart",
"comparison") and supplies content; the builder computes every rectangle. When
that is not enough, any slide can carry ``elements`` with explicit frames, and
the ``blank`` layout is nothing but elements.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator


def _deep_sanitize(value):
    from ..ooxml.util import sanitize_text

    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, list):
        return [_deep_sanitize(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_deep_sanitize(item) for item in value)
    if isinstance(value, dict):
        return {key: _deep_sanitize(item) for key, item in value.items()}
    return value


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @model_validator(mode="before")
    @classmethod
    def _xml_safe_strings(cls, data):
        """Pasted text routinely carries control characters XML cannot hold;
        sanitising here covers every declarative and granular text field at
        once, instead of failing the call with lxml's cryptic ValueError."""
        if isinstance(data, dict):
            return {key: _deep_sanitize(value) for key, value in data.items()}
        return data


# ---------------------------------------------------------------------------
# Inline content
# ---------------------------------------------------------------------------


class RunSpec(Base):
    """A stretch of text with its own formatting."""

    text: str = ""
    bold: bool | None = None
    italic: bool | None = None
    underline: bool | None = None
    strike: bool | None = None
    color: str | None = Field(None, description="Hex like '#1F4E79' or a name like 'blue'.")
    size_pt: float | None = None
    font: str | None = None
    caps: Literal["all", "small", "none"] | None = None
    letter_spacing_pt: float | None = Field(
        None, description="Tracking. A little positive tracking is what makes an all-caps kicker read."
    )
    baseline: Literal["superscript", "subscript"] | None = None
    highlight: str | None = None
    code: bool = Field(False, description="Render in the theme's monospace face.")
    link: str | None = Field(
        None,
        description="Makes this run a hyperlink: a URL, or '#4' to jump to slide 4 (0-based).",
    )


class BulletSpec(Base):
    """One line of a bullet list."""

    text: str | None = None
    runs: list[RunSpec] = Field(default_factory=list)
    level: int = Field(0, ge=0, le=4, description="Nesting depth; 0 is top level.")
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = None
    size_pt: float | None = None
    bullet: str | None = Field(
        None, description="Override the glyph for this line, or '' for no glyph at all."
    )
    space_before_pt: float | None = None


Bullet = Union[str, BulletSpec]


class FrameSpec(Base):
    """Where an element goes.

    Three ways to say it, most specific first: explicit centimetres, a cell of the
    12 × 6 grid laid over the content area, or a named area. Anything you leave
    out is filled in from the layout's own idea of where that element belongs.
    """

    x_cm: float | None = None
    y_cm: float | None = None
    w_cm: float | None = None
    h_cm: float | None = None
    area: str | None = Field(
        None,
        description="full, safe, title, content, footer, left, right, top or bottom.",
    )
    col: int | None = Field(None, ge=0, le=11, description="Grid column, 0-11.")
    row: int | None = Field(None, ge=0, le=5, description="Grid row, 0-5.")
    cols: int = Field(12, ge=1, le=12, description="Grid columns to span.")
    rows: int = Field(1, ge=1, le=6, description="Grid rows to span.")


class BorderSpec(Base):
    color: str | None = None
    width_pt: float = 1.0
    dash: Literal["solid", "dot", "dash", "dash_dot", "long_dash"] | None = None


class SeriesSpec(Base):
    name: str
    values: list[float | None] | None = Field(
        None, description="One value per category. Use this for every chart except scatter/bubble."
    )
    points: list[list[float]] | None = Field(
        None, description="[x, y] pairs for scatter, [x, y, size] for bubble."
    )
    color: str | None = None
    trendline: str | None = Field(None, description="Name of a linear trend line drawn on this series.")


class TableCellSpec(Base):
    text: str | None = None
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = None
    fill: str | None = None
    align: str | None = None
    size_pt: float | None = None


TableCell = Union[str, int, float, None, TableCellSpec]


class MergeSpec(Base):
    """Inclusive 0-based grid coordinates. Row 0 is the header row when there is one."""

    row_start: int
    col_start: int
    row_end: int
    col_end: int


class KpiSpec(Base):
    """One number that matters, with the words that make it mean something."""

    value: str = Field(..., description="The number itself, already formatted: '18.4 M€', '+12 %'.")
    label: str | None = Field(None, description="What it measures.")
    caption: str | None = Field(None, description="A smaller line under the label — context, period.")
    delta: str | None = Field(None, description="Change versus the comparison point, e.g. '+3.2 pts'.")
    trend: Literal["up", "down", "flat"] | None = Field(
        None, description="Colours the delta and adds an arrow. 'up' is not always good — see good_is."
    )
    good_is: Literal["up", "down"] = Field(
        "up", description="Which direction is favourable, so churn going down reads as green."
    )
    color: str | None = Field(None, description="Override the tile accent for this KPI.")


class MilestoneSpec(Base):
    date: str | None = Field(None, description="The label on the axis: 'Q1', 'Mars 2026', 'J+30'.")
    title: str = ""
    text: str | None = None
    done: bool = Field(False, description="Draws the marker filled, for a milestone already passed.")


class StepSpec(Base):
    title: str = ""
    text: str | None = None


class ColumnSpec(Base):
    """One side of a comparison slide."""

    title: str | None = None
    items: list[Bullet] = Field(default_factory=list)
    accent: str | None = None
    icon: str | None = Field(None, description="A single character shown in the header, e.g. '✓'.")


# ---------------------------------------------------------------------------
# Elements
# ---------------------------------------------------------------------------


class ElementBase(Base):
    frame: FrameSpec | None = None
    alt_text: str | None = None
    name: str | None = Field(None, description="Shape name, as shown in the selection pane.")


class TextElement(ElementBase):
    type: Literal["text", "textbox"]
    text: str | None = None
    runs: list[RunSpec] = Field(default_factory=list)
    bullets: list[Bullet] = Field(default_factory=list)
    numbered: bool = False
    align: str | None = None
    valign: Literal["top", "middle", "bottom"] | None = None
    font_size_pt: float | None = Field(
        None, description="Leave unset and the size is computed from the box the text has to fit."
    )
    min_font_size_pt: float | None = None
    color: str | None = None
    font: str | None = None
    bold: bool | None = None
    italic: bool | None = None
    line_spacing: float | None = None
    space_before_pt: float | None = None
    fill: str | None = Field(None, description="Background of the text box — makes it a card.")
    gradient: list[str] | None = None
    border: BorderSpec | None = None
    radius: float | None = Field(
        None, ge=0, le=0.5, description="Corner rounding as a fraction of the shorter side."
    )
    shadow: bool = False
    padding_cm: float | None = None
    accent_bar: str | None = Field(
        None, description="Colour of a thick left edge — turns the box into a callout."
    )
    columns: int = Field(1, ge=1, le=4)
    autofit: bool = True


class ImageElement(ElementBase):
    type: Literal["image", "picture"]
    source: str = Field(..., description="A file path, a data: URI, or a bare base64 payload.")
    fit: Literal["contain", "cover", "stretch"] = Field(
        "contain", description="'contain' never crops; 'cover' fills the box and crops the overflow."
    )
    align: str | None = "center"
    valign: Literal["top", "middle", "bottom"] | None = "middle"
    caption: str | None = None
    border: BorderSpec | None = None
    shadow: bool = False


class ChartElement(ElementBase):
    type: Literal["chart"]
    chart_type: str = Field(
        "column_clustered",
        description=(
            "Native (editable in PowerPoint): column, column_stacked, column_stacked_100, bar, "
            "bar_stacked, bar_stacked_100, line, line_markers, area, area_stacked, pie, "
            "pie_exploded, doughnut, radar, radar_filled, scatter, scatter_lines, bubble. "
            "Rendered as an image: column_3d, bar_3d, pie_3d, stock, surface, heatmap, "
            "histogram, box, violin, waterfall, funnel, gauge, treemap, step."
        ),
    )
    categories: list[Union[str, int, float]] = Field(default_factory=list)
    series: list[SeriesSpec] = Field(default_factory=list)
    title: str | None = None
    x_title: str | None = None
    y_title: str | None = None
    legend: str = Field("auto", description="auto, none, right, left, top, bottom or top_right.")
    data_labels: bool | None = None
    data_label_position: str | None = None
    data_label_format: str | None = None
    number_format: str | None = Field(None, description="Excel format code, e.g. '#,##0.0' or '0%'.")
    x_number_format: str | None = Field(None, description="Format of a scatter chart's horizontal axis.")
    gridlines: bool = True
    y_min: float | None = None
    y_max: float | None = None
    palette: list[str] | None = None
    gap_width: int | None = None
    overlap: int | None = None
    hole_size: int | None = None
    smooth: bool | None = None
    render: Literal["auto", "native", "image"] = Field(
        "auto",
        description=(
            "'auto' picks for you. 'native' keeps the chart editable in PowerPoint and works "
            "for the native types only; 'image' rasterises, and works for the image types "
            "only. The two lists do not overlap — see pptx_chart_types."
        ),
    )


class TableElement(ElementBase):
    type: Literal["table"]
    header: list[TableCell] | None = None
    rows: list[list[TableCell]] = Field(default_factory=list)
    style: Literal["clean", "banded", "minimal", "bordered", "dark_header"] = Field(
        "clean", description="'clean' is a header rule plus hairlines — the default for data."
    )
    col_widths: list[float] | None = Field(
        None, description="Relative weights, e.g. [2, 1, 1]; or centimetres if they sum to the box width."
    )
    font_size_pt: float | None = None
    header_fill: str | None = None
    header_color: str | None = None
    first_column_bold: bool = False
    align: str | None = None
    numeric_align: str | None = Field(
        "right", description="Alignment applied to cells that parse as numbers."
    )
    row_height_cm: float | None = None
    merges: list[MergeSpec] = Field(default_factory=list)
    caption: str | None = None

    @model_validator(mode="after")
    def _merges_do_not_overlap(self):
        """Reject overlapping merge regions here, before anything is drawn.

        python-pptx refuses to merge a range that already contains a merged cell,
        but it raises a bare "range contains one or more merged cells" from deep
        inside the render — by which point the slide exists, the table is filled
        and the earlier merges are applied, so a failed call leaves a half-built
        slide behind. Catching it at validation makes the message name the two
        regions that actually conflict, and costs nothing because it only reads
        coordinates.
        """
        for index, merge in enumerate(self.merges):
            for other in self.merges[:index]:
                rows_meet = merge.row_start <= other.row_end and other.row_start <= merge.row_end
                cols_meet = merge.col_start <= other.col_end and other.col_start <= merge.col_end
                if rows_meet and cols_meet:
                    raise ValueError(
                        f"merge regions overlap: rows {other.row_start}-{other.row_end} x "
                        f"cols {other.col_start}-{other.col_end} and rows "
                        f"{merge.row_start}-{merge.row_end} x cols "
                        f"{merge.col_start}-{merge.col_end} share at least one cell"
                    )
        return self


class KpiElement(ElementBase):
    type: Literal["kpi", "metrics", "stats"]
    items: list[KpiSpec] = Field(default_factory=list)
    columns: int | None = Field(None, ge=1, le=6, description="Defaults to one column per KPI.")
    style: Literal["tile", "plain", "outline"] = "tile"


class TimelineElement(ElementBase):
    type: Literal["timeline"]
    milestones: list[MilestoneSpec] = Field(default_factory=list)


class ProcessElement(ElementBase):
    type: Literal["process", "steps"]
    steps: list[StepSpec] = Field(default_factory=list)


Element = Annotated[
    Union[
        TextElement, ImageElement, ChartElement, TableElement, KpiElement, TimelineElement,
        ProcessElement,
    ],
    Field(discriminator="type"),
]

#: What a column of a two-content slide accepts: prose, a bullet list, or any element.
Content = Union[str, list[Bullet], Element]


# ---------------------------------------------------------------------------
# Slides
# ---------------------------------------------------------------------------


class SlideBase(Base):
    notes: str | None = Field(None, description="Speaker notes — the words, not the slide.")
    elements: list[Element] = Field(
        default_factory=list, description="Extra elements drawn on top, with their own frames."
    )


class TitleSlide(SlideBase):
    layout: Literal["title", "cover"]
    title: str = ""
    subtitle: str | None = None
    author: str | None = None
    date: str | None = None


class SectionSlide(SlideBase):
    layout: Literal["section", "divider"]
    title: str = ""
    subtitle: str | None = None


class BulletsSlide(SlideBase):
    layout: Literal["bullets", "content", "text"]
    title: str | None = None
    kicker: str | None = Field(None, description="Small all-caps line above the title — the section it belongs to.")
    bullets: list[Bullet] = Field(default_factory=list)
    text: str | None = Field(None, description="Prose instead of bullets. Use one or the other.")
    numbered: bool = False
    image: str | None = Field(None, description="Illustration beside the text.")
    takeaway: str | None = Field(None, description="The one line the audience should leave with.")


class TwoContentSlide(SlideBase):
    layout: Literal["two_content", "two_column", "split"]
    title: str | None = None
    kicker: str | None = None
    left: Content | None = None
    right: Content | None = None
    left_title: str | None = None
    right_title: str | None = None
    takeaway: str | None = None


class ImageSlide(SlideBase):
    layout: Literal["image", "picture", "visual"]
    title: str | None = None
    kicker: str | None = None
    image: str = ""
    caption: str | None = None
    text: str | None = None
    fit: Literal["contain", "cover"] = "cover"


class ChartSlide(SlideBase):
    layout: Literal["chart", "graph"]
    title: str | None = None
    kicker: str | None = None
    # Tout élément : un graphique d'outil chart_* arrive en graphique natif,
    # en image (rendu serveur), en tableau ou en tuiles selon son type.
    chart: Element | None = None
    takeaway: str | None = Field(
        None, description="What the chart shows, in words. A chart without a claim is decoration."
    )
    bullets: list[Bullet] = Field(default_factory=list)
    bullets_position: Literal["left", "right", "none"] = "none"


class TableSlide(SlideBase):
    layout: Literal["table"]
    title: str | None = None
    kicker: str | None = None
    table: TableElement | None = None
    takeaway: str | None = None


class KpiSlide(SlideBase):
    layout: Literal["kpi", "metrics", "dashboard"]
    title: str | None = None
    kicker: str | None = None
    items: list[KpiSpec] = Field(default_factory=list)
    bullets: list[Bullet] = Field(default_factory=list)
    takeaway: str | None = None
    chart: ChartElement | None = Field(None, description="A chart under the tiles, if the numbers need a shape.")


class ComparisonSlide(SlideBase):
    layout: Literal["comparison", "versus", "pros_cons"]
    title: str | None = None
    kicker: str | None = None
    left: ColumnSpec = Field(default_factory=ColumnSpec)
    right: ColumnSpec = Field(default_factory=ColumnSpec)
    takeaway: str | None = None


class TimelineSlide(SlideBase):
    layout: Literal["timeline", "roadmap"]
    title: str | None = None
    kicker: str | None = None
    milestones: list[MilestoneSpec] = Field(default_factory=list)
    takeaway: str | None = None


class ProcessSlide(SlideBase):
    layout: Literal["process", "steps"]
    title: str | None = None
    kicker: str | None = None
    steps: list[StepSpec] = Field(default_factory=list)
    takeaway: str | None = None


class AgendaSlide(SlideBase):
    layout: Literal["agenda", "toc"]
    title: str | None = "Agenda"
    kicker: str | None = None
    items: list[Bullet] = Field(default_factory=list)


class QuoteSlide(SlideBase):
    layout: Literal["quote", "statement"]
    text: str = ""
    author: str | None = None
    role: str | None = None


class ClosingSlide(SlideBase):
    layout: Literal["closing", "end", "thanks"]
    title: str = "Merci"
    subtitle: str | None = None
    contact: list[str] = Field(default_factory=list)


class BlankSlide(SlideBase):
    layout: Literal["blank", "free", "custom"]
    title: str | None = None
    kicker: str | None = None


Slide = Annotated[
    Union[
        TitleSlide, SectionSlide, BulletsSlide, TwoContentSlide, ImageSlide, ChartSlide,
        TableSlide, KpiSlide, ComparisonSlide, TimelineSlide, ProcessSlide, AgendaSlide,
        QuoteSlide, ClosingSlide, BlankSlide,
    ],
    Field(discriminator="layout"),
]


# ---------------------------------------------------------------------------
# Deck level
# ---------------------------------------------------------------------------


class MetaSpec(Base):
    title: str | None = None
    author: str | None = None


class ThemeSpec(Base):
    preset: str | None = Field(
        None, description="corporate, slate, emerald, plum, sand, midnight or carbon."
    )
    accent: str | None = Field(None, description="The brand colour. Everything else adapts to it.")
    accent2: str | None = None
    background: str | None = None
    surface: str | None = Field(None, description="Fill for cards and tiles.")
    text_color: str | None = None
    muted_color: str | None = None
    border: str | None = None
    heading_font: str | None = None
    body_font: str | None = None
    mono_font: str | None = None
    chart_palette: list[str] | None = None
    base_font_size_pt: float | None = Field(
        None, description="Scales the whole type scale, not just body text."
    )
    font_sizes: dict[str, float] | None = Field(
        None,
        description=(
            "Override single roles: deck_title, section_title, slide_title, kicker, body, "
            "small, caption, footer, kpi_value, kpi_label, quote."
        ),
    )


class SizeSpec(Base):
    preset: Literal["16:9", "16:10", "4:3", "a4", "a4_landscape", "letter"] | None = "16:9"
    width_cm: float | None = Field(None, gt=5, le=150)
    height_cm: float | None = Field(None, gt=5, le=150)


class FooterSpec(Base):
    text: str | None = Field(None, description="Left-hand text — company, document title, classification.")
    slide_numbers: bool = True


class DeckSpec(Base):
    """The whole presentation, in one object."""

    filename: str = "presentation.pptx"
    meta: MetaSpec = Field(default_factory=MetaSpec)
    theme: ThemeSpec = Field(default_factory=ThemeSpec)
    size: Union[SizeSpec, str] = Field(
        default_factory=SizeSpec, description="'16:9' (default), '4:3', or {width_cm, height_cm}."
    )
    template: str | None = Field(
        None,
        description=(
            "A corporate deck to build on: its masters, layouts, theme and fonts are inherited. "
            "Normally a catalogue name from pptx_templates ('acme-corporate'); a path inside an "
            "allowed directory or a base64 payload also work. .potx, .ppsx and macro-enabled "
            "files are accepted — macros are dropped."
        ),
    )
    footer: FooterSpec | None = None
    slides: list[Slide] = Field(default_factory=list)


DeckSpec.model_rebuild()

#: Built once, after the rebuild above. Constructing a TypeAdapter compiles the
#: whole discriminated union — 3.9 ms for the 16-layout slide union, which every
#: pptx_add_slides / pptx_insert_slides call was paying before validating
#: anything. Roughly three hundred times the cost of the validation itself.
_SLIDES_ADAPTER = TypeAdapter(list[Slide])


def parse_slides(raw: Any) -> list[Slide]:
    """Validate a bare list of slides (used by the append/insert tools)."""
    if raw is None:
        return []
    if isinstance(raw, dict):
        raw = [raw]
    return _SLIDES_ADAPTER.validate_python(raw)
