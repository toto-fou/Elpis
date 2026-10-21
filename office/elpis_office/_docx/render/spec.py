# SPDX-License-Identifier: MIT
"""The declarative document spec.

This is the contract ``docx_build`` exposes to the model: one JSON object that
describes a whole document. The models double as the tool's input schema, so the
field descriptions here are what the model actually reads when deciding how to
call it — they are documentation, not decoration.
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
    small_caps: bool | None = None
    all_caps: bool | None = None
    superscript: bool = False
    subscript: bool = False
    color: str | None = Field(None, description="Hex like '#1F4E79' or a name like 'blue'.")
    highlight: str | None = None
    size_pt: float | None = None
    font: str | None = None
    style: str | None = Field(None, description="Character style name, e.g. 'Emphasis'.")
    link: str | None = Field(
        None,
        description="Makes this run a hyperlink. Use a URL, or '#bookmark_name' to link inside the document.",
    )
    code: bool = Field(False, description="Render in a monospace face with light shading.")
    footnote: str | None = Field(
        None, description="Attach a footnote whose text is this value, marked after this run."
    )


InlineText = Union[str, RunSpec]


class CellSpec(Base):
    text: str | None = None
    runs: list[RunSpec] = Field(default_factory=list)
    align: str | None = None
    valign: str | None = None
    bold: bool | None = None
    italic: bool | None = None
    color: str | None = None
    fill: str | None = Field(None, description="Cell background colour.")
    size_pt: float | None = None


TableCell = Union[str, int, float, None, CellSpec]


class MergeSpec(Base):
    """Inclusive 0-based grid coordinates. Row 0 is the header row when there is one."""

    row_start: int
    col_start: int
    row_end: int
    col_end: int


class SeriesSpec(Base):
    name: str
    values: list[float | None] | None = Field(
        None, description="One value per category. Use this for every chart except scatter/bubble."
    )
    points: list[list[float]] | None = Field(
        None, description="[x, y] pairs for scatter, [x, y, size] for bubble."
    )
    color: str | None = None


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------


class HeadingBlock(Base):
    type: Literal["heading", "h"]
    text: str = ""
    level: int = Field(1, ge=0, le=9, description="0 renders as the document Title style.")
    runs: list[RunSpec] = Field(default_factory=list)
    align: str | None = None
    color: str | None = None
    style: str | None = None
    bookmark: str | None = Field(None, description="Name this heading so blocks can link to it.")
    page_break_before: bool = False


class ParagraphBlock(Base):
    type: Literal["paragraph", "text", "p"]
    text: str | None = None
    runs: list[RunSpec] = Field(default_factory=list)
    style: str | None = None
    align: str | None = Field(None, description="left, center, right or justify.")
    space_before_pt: float | None = None
    space_after_pt: float | None = None
    line_spacing: float | None = None
    indent_left_cm: float | None = None
    indent_right_cm: float | None = None
    first_line_indent_cm: float | None = None
    keep_with_next: bool | None = None
    page_break_before: bool = False
    bookmark: str | None = None


class ListItemSpec(Base):
    text: str | None = None
    runs: list[RunSpec] = Field(default_factory=list)
    level: int = Field(0, ge=0, le=4)


class ListBlock(Base):
    type: Literal["list", "bullets", "bullet_list"]
    items: list[Union[str, ListItemSpec]] = Field(default_factory=list)
    ordered: bool = False
    style: str | None = None
    space_after_pt: float | None = 2


class TableBlock(Base):
    type: Literal["table"]
    header: list[TableCell] | None = None
    rows: list[list[TableCell]] = Field(default_factory=list)
    style: str | None = Field(
        "Light Grid Accent 1", description="A built-in Word table style name, or null for none."
    )
    banded_rows: bool = True
    first_column_bold: bool = False
    widths_cm: list[float | None] | None = None
    align: str | None = None
    font_size_pt: float | None = None
    header_fill: str | None = None
    header_color: str | None = None
    merges: list[MergeSpec] = Field(default_factory=list)
    caption: str | None = None
    bookmark: str | None = None
    autofit: bool = True
    repeat_header: bool = True


class ImageBlock(Base):
    type: Literal["image", "picture"]
    source: str = Field(
        ...,
        description="A file path, an http(s) URL, or a data URI / bare base64 string.",
    )
    width_cm: float | None = Field(default=None, gt=0, le=200)
    height_cm: float | None = Field(default=None, gt=0, le=200)
    align: str | None = "center"
    caption: str | None = None
    alt_text: str | None = None
    bookmark: str | None = None


class ChartBlock(Base):
    type: Literal["chart"]
    chart_type: str = Field(
        "column_clustered",
        description=(
            "Native (editable in Word): column, column_stacked, column_stacked_100, bar, "
            "bar_stacked, bar_stacked_100, line, line_markers, area, area_stacked, pie, "
            "pie_exploded, doughnut, radar, radar_filled, scatter, scatter_lines, bubble. "
            "Rendered as an image: column_3d, bar_3d, pie_3d, stock, surface, heatmap, "
            "histogram, box, waterfall, funnel, gauge, treemap."
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
    gridlines: bool = True
    y_min: float | None = None
    y_max: float | None = None
    width_cm: float = Field(default=16.0, gt=0, le=200)
    height_cm: float = Field(default=9.0, gt=0, le=200)
    palette: list[str] | None = None
    gap_width: int | None = None
    overlap: int | None = None
    hole_size: int | None = None
    smooth: bool | None = None
    caption: str | None = None
    bookmark: str | None = None
    render: Literal["auto", "native", "image"] = Field(
        "auto",
        description=(
            "'auto' picks for you. 'native' keeps the chart editable in Word and works for "
            "the native types only; 'image' rasterises, and works for the image types only. "
            "The two lists do not overlap — see docx_chart_types."
        ),
    )


class MarkdownBlock(Base):
    type: Literal["markdown", "md"]
    text: str = ""
    heading_offset: int = Field(0, description="Add this to every heading level found in the source.")


class HtmlBlock(Base):
    type: Literal["html"]
    html: str = ""
    heading_offset: int = 0


class CodeBlock(Base):
    type: Literal["code"]
    text: str = ""
    language: str | None = None
    caption: str | None = None
    font: str = "Consolas"
    size_pt: float = 9.0


class QuoteBlock(Base):
    type: Literal["quote"]
    text: str = ""
    author: str | None = None
    style: str | None = "Intense Quote"


class CalloutBlock(Base):
    type: Literal["callout", "admonition"]
    text: str = ""
    title: str | None = None
    variant: Literal["info", "note", "success", "warning", "danger"] = "info"


class TocBlock(Base):
    type: Literal["toc"]
    title: str | None = "Table of Contents"
    levels: list[int] = Field(default_factory=lambda: [1, 3], min_length=2, max_length=2)
    page_break_after: bool = True


class CoverBlock(Base):
    type: Literal["cover"]
    title: str = ""
    subtitle: str | None = None
    author: str | None = None
    date: str | None = None
    logo: str | None = Field(None, description="Image source, same forms as an image block.")
    accent: str | None = None
    page_break_after: bool = True


class CaptionBlock(Base):
    type: Literal["caption"]
    text: str = ""
    label: str = "Figure"
    bookmark: str | None = None


class PageBreakBlock(Base):
    type: Literal["page_break", "pagebreak"]


class RuleBlock(Base):
    type: Literal["hr", "rule", "divider"]
    color: str | None = "BFBFBF"


class SpacerBlock(Base):
    type: Literal["spacer"]
    height_pt: float = 12.0


class SectionBlock(Base):
    """Start a new section — the unit that owns page geometry in Word."""

    type: Literal["section"]
    start: Literal["new_page", "continuous", "even_page", "odd_page", "new_column"] = "new_page"
    size: str | None = None
    orientation: Literal["portrait", "landscape"] | None = None
    margins_cm: dict[str, float] | None = None
    columns: int | None = None
    column_spacing_cm: float | None = None
    column_line: bool = False
    restart_page_numbering_at: int | None = None
    header: "HeaderSpec | None" = None
    footer: "FooterSpec | None" = None


Block = Annotated[
    Union[
        HeadingBlock, ParagraphBlock, ListBlock, TableBlock, ImageBlock, ChartBlock,
        MarkdownBlock, HtmlBlock, CodeBlock, QuoteBlock, CalloutBlock, TocBlock,
        CoverBlock, CaptionBlock, PageBreakBlock, RuleBlock, SpacerBlock, SectionBlock,
    ],
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# Document level
# ---------------------------------------------------------------------------


class MetaSpec(Base):
    title: str | None = None
    subject: str | None = None
    author: str | None = None
    keywords: str | None = None
    category: str | None = None
    comments: str | None = None
    language: str | None = None


class ThemeSpec(Base):
    heading_font: str | None = None
    body_font: str | None = None
    mono_font: str = "Consolas"
    accent: str | None = Field(None, description="Colour applied to headings and rules.")
    base_font_size_pt: float | None = None
    chart_palette: list[str] | None = None


class PageSpec(Base):
    size: str | None = "A4"
    orientation: Literal["portrait", "landscape"] = "portrait"
    width_cm: float | None = Field(default=None, gt=0, le=200)
    height_cm: float | None = Field(default=None, gt=0, le=200)
    margins_cm: dict[str, float] | None = None
    columns: int | None = None
    column_spacing_cm: float | None = None


class HeaderSpec(Base):
    text: str | None = None
    left: str | None = None
    center: str | None = None
    right: str | None = None
    align: str | None = None
    font_size_pt: float | None = 9
    color: str | None = "808080"
    rule: bool = False
    different_first_page: bool = False
    first_page_text: str | None = None
    image: str | None = None
    image_width_cm: float = Field(default=3.0, gt=0, le=50)


class FooterSpec(Base):
    text: str | None = None
    left: str | None = None
    center: str | None = None
    right: str | None = None
    align: str | None = "center"
    font_size_pt: float | None = 9
    color: str | None = "808080"
    rule: bool = False
    page_numbers: bool = False
    page_number_format: str = "{PAGE} / {NUMPAGES}"
    different_first_page: bool = False


class WatermarkSpec(Base):
    text: str
    color: str = "E8E8E8"
    font: str = "Calibri"
    rotation: int = -45


class DocumentSpec(Base):
    """The whole document, in one object."""

    filename: str = "document.docx"
    meta: MetaSpec = Field(default_factory=MetaSpec)
    theme: ThemeSpec = Field(default_factory=ThemeSpec)
    # None : la mise en page du modèle (ou de python-docx) est gardée telle quelle.
    page: PageSpec | None = Field(default_factory=PageSpec)
    header: HeaderSpec | None = None
    footer: FooterSpec | None = None
    watermark: WatermarkSpec | None = None
    blocks: list[Block] = Field(default_factory=list)


SectionBlock.model_rebuild()
DocumentSpec.model_rebuild()

#: Built once, after the rebuilds above. Constructing a TypeAdapter compiles the
#: whole discriminated union, which cost 0.6 ms on every granular docx_add_* /
#: docx_insert_at / docx_append_blocks call — over a hundred times the cost of
#: the validation it then performs.
_BLOCKS_ADAPTER = TypeAdapter(list[Block])


def parse_blocks(raw: Any) -> list[Block]:
    """Validate a bare list of blocks (used by the append/add tools)."""
    if raw is None:
        return []
    if isinstance(raw, dict):
        raw = [raw]
    return _BLOCKS_ADAPTER.validate_python(raw)
