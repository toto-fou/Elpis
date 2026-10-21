# SPDX-License-Identifier: MIT
"""Native, editable OOXML charts inside .docx — no Word, no LibreOffice, no image.

How this works
--------------
A chart in a Word document is a separate OPC part (``/word/charts/chartN.xml``)
holding a ``c:chartSpace`` tree, related to an embedded ``.xlsx`` workbook that
Word opens when the user clicks *Edit Data*. The body references the part through
``w:drawing/wp:inline/a:graphic/a:graphicData/c:chart@r:id``.

python-docx cannot build any of that, but ``python-pptx`` already contains a
complete, well-tested ``c:chartSpace`` writer plus a workbook serialiser — and
the DrawingML chart schema is *identical* for DOCX and PPTX. So we use
python-pptx purely as an XML factory, then re-style the tree and attach it to the
Word package ourselves.

Everything below the factory call is schema-order-aware: OOXML uses sequences,
not free-form children, and Word silently refuses to open a file whose chart
elements are out of order. ``_insert_ordered`` is what keeps that honest.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from lxml import etree
from pptx.chart.data import BubbleChartData, CategoryChartData, XyChartData
from pptx.chart.xmlwriter import ChartXmlWriter
from pptx.enum.chart import XL_CHART_TYPE

from .util import (
    Cm,
    cm_to_emu,
    frag,
    insert_in_order,
    local_name,
    make,
    next_drawing_id,
    parse_color,
    qn,
    replace_in_order,
)

CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------

#: Validated categorical palette (scripts/validate_palette.js, light surface):
#: lightness band PASS, chroma floor PASS, worst adjacent CVD ΔE 9.1, worst
#: adjacent normal-vision ΔE 19.6. Assigned in fixed order — never cycled by rank.
#: (Word's own default palette fails two hard gates: its grey slot has zero
#: chroma and its yellow sits outside the lightness band.)
DEFAULT_PALETTE: tuple[str, ...] = (
    "2A78D6",  # blue
    "EB6834",  # orange
    "1BAF7A",  # aqua
    "EDA100",  # yellow
    "E87BA4",  # magenta
    "008300",  # green
    "4A3AA7",  # violet
    "E34948",  # red
)

#: Recessive furniture — grid and axis lines must never compete with the marks.
GRIDLINE_COLOR = "E4E4E1"
AXIS_LINE_COLOR = "BFBFBF"
TEXT_COLOR = "404040"
DEFAULT_TEXT_PT = 10.0
DEFAULT_TITLE_PT = 12.0


# ---------------------------------------------------------------------------
# Chart types
# ---------------------------------------------------------------------------

NATIVE_TYPES: dict[str, XL_CHART_TYPE] = {
    # column / bar
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "column_clustered": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "column_stacked": XL_CHART_TYPE.COLUMN_STACKED,
    "column_stacked_100": XL_CHART_TYPE.COLUMN_STACKED_100,
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "bar_clustered": XL_CHART_TYPE.BAR_CLUSTERED,
    "bar_stacked": XL_CHART_TYPE.BAR_STACKED,
    "bar_stacked_100": XL_CHART_TYPE.BAR_STACKED_100,
    # line
    "line": XL_CHART_TYPE.LINE,
    "line_markers": XL_CHART_TYPE.LINE_MARKERS,
    "line_stacked": XL_CHART_TYPE.LINE_STACKED,
    "line_stacked_100": XL_CHART_TYPE.LINE_STACKED_100,
    "line_markers_stacked": XL_CHART_TYPE.LINE_MARKERS_STACKED,
    "line_markers_stacked_100": XL_CHART_TYPE.LINE_MARKERS_STACKED_100,
    # circular
    "pie": XL_CHART_TYPE.PIE,
    "pie_exploded": XL_CHART_TYPE.PIE_EXPLODED,
    "doughnut": XL_CHART_TYPE.DOUGHNUT,
    "donut": XL_CHART_TYPE.DOUGHNUT,
    "doughnut_exploded": XL_CHART_TYPE.DOUGHNUT_EXPLODED,
    # area
    "area": XL_CHART_TYPE.AREA,
    "area_stacked": XL_CHART_TYPE.AREA_STACKED,
    "area_stacked_100": XL_CHART_TYPE.AREA_STACKED_100,
    # radar
    "radar": XL_CHART_TYPE.RADAR,
    "radar_markers": XL_CHART_TYPE.RADAR_MARKERS,
    "radar_filled": XL_CHART_TYPE.RADAR_FILLED,
    # xy
    "scatter": XL_CHART_TYPE.XY_SCATTER,
    "xy_scatter": XL_CHART_TYPE.XY_SCATTER,
    "scatter_lines": XL_CHART_TYPE.XY_SCATTER_LINES,
    "scatter_lines_no_markers": XL_CHART_TYPE.XY_SCATTER_LINES_NO_MARKERS,
    "scatter_smooth": XL_CHART_TYPE.XY_SCATTER_SMOOTH,
    "scatter_smooth_no_markers": XL_CHART_TYPE.XY_SCATTER_SMOOTH_NO_MARKERS,
    "bubble": XL_CHART_TYPE.BUBBLE,
    "bubble_3d": XL_CHART_TYPE.BUBBLE_THREE_D_EFFECT,
}

XY_TYPES = {k for k in NATIVE_TYPES if k.startswith(("scatter", "xy_"))}
BUBBLE_TYPES = {"bubble", "bubble_3d"}
CIRCULAR_TYPES = {"pie", "pie_exploded", "doughnut", "donut", "doughnut_exploded"}
#: Series colour lands on the stroke, not the fill.
LINE_TYPES = {k for k in NATIVE_TYPES if k.startswith("line")} | XY_TYPES | {"radar", "radar_markers"}

#: Chart-group element local names, in the order the plotArea sequence allows.
_GROUP_TAGS = (
    "areaChart", "area3DChart", "lineChart", "line3DChart", "stockChart", "radarChart",
    "scatterChart", "pieChart", "pie3DChart", "doughnutChart", "barChart", "bar3DChart",
    "ofPieChart", "surfaceChart", "surface3DChart", "bubbleChart",
)


def native_chart_types() -> list[str]:
    return sorted(NATIVE_TYPES)


# ---------------------------------------------------------------------------
# Schema ordering
# ---------------------------------------------------------------------------

_AXIS_ORDER = (
    "axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title",
    "numFmt", "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx",
    "crosses", "crossesAt", "crossBetween", "auto", "lblAlgn", "lblOffset", "tickLblSkip",
    "tickMarkSkip", "noMultiLvlLbl", "majorUnit", "minorUnit", "dispUnits", "extLst",
)

#: parent local-name -> the sequence its children must follow.
SCHEMA_ORDER: dict[str, tuple[str, ...]] = {
    "chartSpace": (
        "date1904", "lang", "roundedCorners", "style", "clrMapOvr", "pivotSource",
        "protection", "chart", "spPr", "txPr", "externalData", "printSettings",
        "userShapes", "extLst",
    ),
    "chart": (
        "title", "autoTitleDeleted", "pivotFmts", "view3D", "floor", "sideWall",
        "backWall", "plotArea", "legend", "plotVisOnly", "dispBlanksAs",
        "showDLblsOverMax", "extLst",
    ),
    "plotArea": ("layout", *_GROUP_TAGS, "valAx", "catAx", "dateAx", "serAx", "dTable", "spPr", "extLst"),
    "catAx": _AXIS_ORDER,
    "valAx": _AXIS_ORDER,
    "dateAx": _AXIS_ORDER,
    "serAx": _AXIS_ORDER,
    "scaling": ("logBase", "orientation", "max", "min", "extLst"),
    "title": ("tx", "layout", "overlay", "spPr", "txPr", "extLst"),
    "legend": ("legendPos", "legendEntry", "layout", "overlay", "spPr", "txPr", "extLst"),
    "ser": (
        "idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "marker",
        "explosion", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "xVal",
        "yVal", "bubbleSize", "bubble3D", "shape", "smooth", "extLst",
    ),
    "dPt": ("idx", "invertIfNegative", "marker", "bubble3D", "explosion", "spPr", "pictureOptions", "extLst"),
    "dLbls": (
        "numFmt", "spPr", "txPr", "dLblPos", "showLegendKey", "showVal", "showCatName",
        "showSerName", "showPercent", "showBubbleSize", "separator", "showLeaderLines",
        "leaderLines", "extLst",
    ),
    "marker": ("symbol", "size", "spPr", "extLst"),
}

_GROUP_ORDER = (
    "barDir", "grouping", "scatterStyle", "radarStyle", "varyColors", "ser", "dLbls",
    "dropLines", "hiLowLines", "upDownBars", "marker", "smooth", "gapWidth", "overlap",
    "serLines", "firstSliceAng", "holeSize", "bubble3D", "bubbleScale", "showNegBubbles",
    "sizeRepresents", "axId", "extLst",
)
for _tag in _GROUP_TAGS:
    SCHEMA_ORDER[_tag] = _GROUP_ORDER


def _order_for(parent: etree._Element) -> tuple[str, ...]:
    return SCHEMA_ORDER.get(local_name(parent), ())


def _insert_ordered(parent: etree._Element, child: etree._Element) -> etree._Element:
    """Insert ``child`` at the position the OOXML sequence for ``parent`` requires."""
    return insert_in_order(parent, child, _order_for(parent))


def _replace(parent: etree._Element, tag: str, child: etree._Element | None) -> None:
    """Drop every existing ``tag`` child, then insert ``child`` in schema order."""
    replace_in_order(parent, tag, child, _order_for(parent))


_local = local_name
_frag = frag


# ---------------------------------------------------------------------------
# Request object
# ---------------------------------------------------------------------------


@dataclass
class SeriesData:
    name: str
    values: Sequence[float] | None = None
    #: (x, y) or (x, y, size) tuples for scatter / bubble charts
    points: Sequence[Sequence[float]] | None = None
    color: str | None = None


@dataclass
class ChartRequest:
    chart_type: str = "column_clustered"
    categories: Sequence[Any] = field(default_factory=list)
    series: Sequence[SeriesData] = field(default_factory=list)
    title: str | None = None
    x_title: str | None = None
    y_title: str | None = None
    #: "auto" | "none" | "right" | "left" | "top" | "bottom" | "top_right"
    legend: str = "auto"
    data_labels: bool | None = None
    data_label_position: str | None = None
    #: Number format for the labels themselves. Defaults to the axis format, except
    #: on circular charts where the label shows a share and "0%" is what people mean.
    data_label_format: str | None = None
    number_format: str | None = None
    gridlines: bool = True
    y_min: float | None = None
    y_max: float | None = None
    width_cm: float = 16.0
    height_cm: float = 9.0
    palette: Sequence[str] | None = None
    gap_width: int | None = None
    overlap: int | None = None
    hole_size: int | None = None
    smooth: bool | None = None
    font_size_pt: float = DEFAULT_TEXT_PT
    #: emitted by the builder when it wants to explain a downgrade to the model
    notes: list[str] = field(default_factory=list)

    def normalised_type(self) -> str:
        key = str(self.chart_type or "").strip().lower().replace("-", "_").replace(" ", "_")
        return key


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def add_native_chart(document, request: ChartRequest, paragraph=None):
    """Append a native chart to ``document`` (or to ``paragraph`` if given).

    Returns the paragraph holding the chart.
    """
    key = request.normalised_type()
    if key not in NATIVE_TYPES:
        raise ValueError(
            f"{request.chart_type!r} is not a native OOXML chart type. "
            f"Native types: {', '.join(native_chart_types())}."
        )
    xl_type = NATIVE_TYPES[key]

    chart_data = _build_chart_data(key, request)
    chart_xml = ChartXmlWriter(xl_type, chart_data).xml
    chart_space = etree.fromstring(chart_xml.encode("utf-8"))

    _style_chart(chart_space, key, request)

    index = _next_chart_index(document)
    package = document.part.package
    chart_part = Part(
        PackURI(f"/word/charts/chart{index}.xml"),
        CT_CHART,
        etree.tostring(chart_space, xml_declaration=True, encoding="UTF-8", standalone=True),
        package,
    )
    xlsx_part = Part(
        PackURI(f"/word/embeddings/chart{index}.xlsx"), CT_XLSX, chart_data.xlsx_blob, package
    )
    # The workbook relationship is what makes "Edit Data" work in Word.
    xlsx_rid = chart_part.relate_to(xlsx_part, RT.PACKAGE)
    _set_external_data(chart_space, xlsx_rid)
    chart_part._blob = etree.tostring(  # refresh the serialised blob with externalData
        chart_space, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    rid = document.part.relate_to(chart_part, RT.CHART)

    target = paragraph if paragraph is not None else document.add_paragraph()
    run = target.add_run()
    run._r.append(
        _inline_drawing(
            rid,
            cm_to_emu(request.width_cm) or int(Cm(16)),
            cm_to_emu(request.height_cm) or int(Cm(9)),
            next_drawing_id(document),
            request.title or f"Chart {index}",
        )
    )
    return target


# ---------------------------------------------------------------------------
# Data plumbing
# ---------------------------------------------------------------------------


def _build_chart_data(key: str, request: ChartRequest):
    if not request.series:
        raise ValueError("A chart needs at least one series.")

    if key in BUBBLE_TYPES:
        data = BubbleChartData()
        for series in request.series:
            handle = data.add_series(series.name)
            for point in _require_points(series, 3, key):
                handle.add_data_point(float(point[0]), float(point[1]), float(point[2]))
        return data

    if key in XY_TYPES:
        data = XyChartData()
        for series in request.series:
            handle = data.add_series(series.name)
            for point in _require_points(series, 2, key):
                handle.add_data_point(float(point[0]), float(point[1]))
        return data

    data = CategoryChartData()
    categories = [str(c) for c in request.categories]
    if not categories:
        longest = max((len(s.values or ()) for s in request.series), default=0)
        categories = [str(i + 1) for i in range(longest)]
    data.categories = categories
    for series in request.series:
        if series.values is None:
            raise ValueError(
                f"Series {series.name!r} has no 'values'. Category charts need one value per category; "
                "'points' is only for scatter and bubble charts."
            )
        values = [None if v is None else float(v) for v in series.values]
        if len(values) != len(categories):
            raise ValueError(
                f"Series {series.name!r} has {len(values)} values but there are "
                f"{len(categories)} categories — they must match."
            )
        data.add_series(series.name, values)
    return data


def _require_points(series: SeriesData, arity: int, key: str) -> list[Sequence[float]]:
    if not series.points:
        raise ValueError(
            f"Chart type {key!r} needs 'points' on series {series.name!r}: a list of "
            f"{'[x, y, size]' if arity == 3 else '[x, y]'} pairs."
        )
    for point in series.points:
        if len(point) < arity:
            raise ValueError(
                f"Series {series.name!r}: each point needs {arity} numbers, got {list(point)!r}."
            )
    return list(series.points)


def _next_chart_index(document) -> int:
    """Chart part names must be unique within the package."""
    used = {0}
    for part in document.part.package.iter_parts():
        name = str(part.partname)
        if name.startswith("/word/charts/chart") and name.endswith(".xml"):
            digits = name[len("/word/charts/chart") : -len(".xml")]
            if digits.isdigit():
                used.add(int(digits))
    return max(used) + 1


def _inline_drawing(rid: str, cx: int, cy: int, drawing_id: int, name: str) -> etree._Element:
    safe_name = (name or "Chart").replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    return _frag(
        '<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
        '<wp:inline distT="0" distB="0" distL="0" distR="0">'
        f'<wp:extent cx="{cx}" cy="{cy}"/>'
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        f'<wp:docPr id="{drawing_id}" name="{safe_name}" descr="{safe_name}"/>'
        "<wp:cNvGraphicFramePr/>"
        f'<a:graphic xmlns:a="{A_NS}">'
        f'<a:graphicData uri="{C_NS}">'
        f'<c:chart xmlns:c="{C_NS}" xmlns:r="{R_NS}" r:id="{rid}"/>'
        "</a:graphicData></a:graphic></wp:inline></w:drawing>"
    )


def _set_external_data(chart_space: etree._Element, rid: str) -> None:
    element = _frag(
        f'<c:externalData xmlns:c="{C_NS}" xmlns:r="{R_NS}" r:id="{rid}">'
        '<c:autoUpdate val="0"/></c:externalData>'
    )
    _replace(chart_space, "c:externalData", element)


# ---------------------------------------------------------------------------
# Styling
# ---------------------------------------------------------------------------


def _style_chart(chart_space: etree._Element, key: str, request: ChartRequest) -> None:
    chart = chart_space.find(qn("c:chart"))
    plot_area = chart.find(qn("c:plotArea"))
    group = _chart_group(plot_area)
    series_elements = group.findall(qn("c:ser"))
    palette = [parse_color(c) for c in (request.palette or DEFAULT_PALETTE)]
    palette = [c for c in palette if c] or list(DEFAULT_PALETTE)

    _replace(chart_space, "c:roundedCorners", make("c:roundedCorners", val="0"))
    # No frame around the chart: the surrounding page is the surface.
    _replace(
        chart_space,
        "c:spPr",
        _frag(f'<c:spPr xmlns:c="{C_NS}" xmlns:a="{A_NS}"><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'),
    )
    _set_default_text(chart_space, request.font_size_pt)

    _apply_title(chart, request.title)
    _apply_series_colors(key, group, series_elements, request, palette)
    _apply_group_options(key, group, request)
    _apply_data_labels(key, group, request, len(series_elements))
    _apply_axes(key, plot_area, request)
    _apply_legend(chart, plot_area, key, request, len(series_elements))

    _replace(chart, "c:plotVisOnly", make("c:plotVisOnly", val="1"))
    _replace(chart, "c:dispBlanksAs", make("c:dispBlanksAs", val="gap"))


def _chart_group(plot_area: etree._Element) -> etree._Element:
    for child in plot_area:
        if _local(child) in _GROUP_TAGS:
            return child
    raise ValueError("Generated chart XML has no chart group — this is a bug in docx-mcp.")


def _set_default_text(chart_space: etree._Element, size_pt: float) -> None:
    """python-pptx defaults to 18pt, which is enormous inside a Word page."""
    element = _frag(
        f'<c:txPr xmlns:c="{C_NS}" xmlns:a="{A_NS}"><a:bodyPr/><a:lstStyle/>'
        f'<a:p><a:pPr><a:defRPr sz="{int(size_pt * 100)}">'
        f'<a:solidFill><a:srgbClr val="{TEXT_COLOR}"/></a:solidFill>'
        "</a:defRPr></a:pPr><a:endParaRPr/></a:p></c:txPr>"
    )
    _replace(chart_space, "c:txPr", element)


def _rich_text(text: str, size_pt: float, bold: bool, vertical: bool = False) -> str:
    escaped = (
        str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    # A value-axis title reads bottom-to-top; -5400000 is 60000ths of a degree = -90°.
    rotation = '-5400000" vert="horz' if vertical else '0" vert="horz'
    return (
        f'<c:tx xmlns:c="{C_NS}" xmlns:a="{A_NS}"><c:rich>'
        f'<a:bodyPr rot="{rotation}" spcFirstLastPara="1" vertOverflow="ellipsis" '
        'wrap="square" anchor="ctr" anchorCtr="1"/>'
        "<a:lstStyle/><a:p><a:pPr>"
        f'<a:defRPr sz="{int(size_pt * 100)}" b="{1 if bold else 0}">'
        f'<a:solidFill><a:srgbClr val="{TEXT_COLOR}"/></a:solidFill></a:defRPr>'
        f"</a:pPr><a:r><a:t>{escaped}</a:t></a:r></a:p></c:rich></c:tx>"
    )


def _title_element(text: str, size_pt: float, bold: bool, vertical: bool = False) -> etree._Element:
    element = make("c:title")
    element.append(_frag(_rich_text(text, size_pt, bold, vertical)))
    _insert_ordered(element, make("c:overlay", val="0"))
    return element


def _apply_title(chart: etree._Element, title: str | None) -> None:
    if title:
        _replace(chart, "c:title", _title_element(title, DEFAULT_TITLE_PT, bold=True))
        _replace(chart, "c:autoTitleDeleted", make("c:autoTitleDeleted", val="0"))
    else:
        _replace(chart, "c:title", None)
        _replace(chart, "c:autoTitleDeleted", make("c:autoTitleDeleted", val="1"))


def _apply_series_colors(
    key: str,
    group: etree._Element,
    series_elements: list[etree._Element],
    request: ChartRequest,
    palette: list[str],
) -> None:
    explicit = [s.color for s in request.series]

    if key in CIRCULAR_TYPES:
        # One slice per category, so colour rides on data points, not on the series.
        _replace(group, "c:varyColors", make("c:varyColors", val="1"))
        if series_elements:
            _color_data_points(
                series_elements[0],
                len(request.categories) or _count_points(series_elements[0]),
                palette,
                exploded=key.endswith("_exploded"),
            )
        return

    _replace(group, "c:varyColors", make("c:varyColors", val="0"))
    stroke = key in LINE_TYPES
    for index, element in enumerate(series_elements):
        color = parse_color(explicit[index]) if index < len(explicit) and explicit[index] else None
        color = color or palette[index % len(palette)]
        _replace(element, "c:spPr", _series_shape(color, stroke=stroke))
        marker = element.find(qn("c:marker"))
        if marker is not None:
            _style_marker(marker, color)


def _count_points(series_element: etree._Element) -> int:
    count = series_element.find(f"{qn('c:val')}/{qn('c:numRef')}/{qn('c:numCache')}/{qn('c:ptCount')}")
    if count is None:
        return 0
    try:
        return int(count.get("val", "0"))
    except (TypeError, ValueError):
        return 0


def _series_shape(color: str, stroke: bool) -> etree._Element:
    if stroke:
        body = (
            f'<a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
            "<a:round/></a:ln><a:effectLst/>"
        )
    else:
        body = (
            f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
            '<a:ln w="9525"><a:solidFill><a:srgbClr val="FCFCFB"/></a:solidFill></a:ln>'
        )
    return _frag(f'<c:spPr xmlns:c="{C_NS}" xmlns:a="{A_NS}">{body}</c:spPr>')


def _style_marker(marker: etree._Element, color: str) -> None:
    symbol = marker.find(qn("c:symbol"))
    if symbol is not None and symbol.get("val") == "none":
        return  # the caller asked for a markerless line; leave it alone
    _replace(marker, "c:symbol", make("c:symbol", val="circle"))
    _replace(marker, "c:size", make("c:size", val="7"))
    # A surface-coloured ring keeps overlapping markers readable.
    _replace(
        marker,
        "c:spPr",
        _frag(
            f'<c:spPr xmlns:c="{C_NS}" xmlns:a="{A_NS}">'
            f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
            '<a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr>'
        ),
    )


def _color_data_points(
    series_element: etree._Element, count: int, palette: list[str], exploded: bool
) -> None:
    for existing in series_element.findall(qn("c:dPt")):
        series_element.remove(existing)
    for index in range(max(count, 0)):
        color = palette[index % len(palette)]
        point = make("c:dPt")
        _insert_ordered(point, make("c:idx", val=str(index)))
        _insert_ordered(point, make("c:bubble3D", val="0"))
        if exploded:
            _insert_ordered(point, make("c:explosion", val="12"))
        _insert_ordered(point, _series_shape(color, stroke=False))
        _insert_ordered(series_element, point)


def _apply_group_options(key: str, group: etree._Element, request: ChartRequest) -> None:
    if _local(group) == "barChart":
        gap = 80 if request.gap_width is None else int(request.gap_width)
        if request.overlap is not None:
            overlap = int(request.overlap)
        else:
            overlap = 100 if "stacked" in key else -10
        _replace(group, "c:gapWidth", make("c:gapWidth", val=str(gap)))
        _replace(group, "c:overlap", make("c:overlap", val=str(overlap)))
    if _local(group) == "doughnutChart":
        hole = 60 if request.hole_size is None else max(10, min(90, int(request.hole_size)))
        _replace(group, "c:holeSize", make("c:holeSize", val=str(hole)))
    if request.smooth is not None:
        value = "1" if request.smooth else "0"
        for series_element in group.findall(qn("c:ser")):
            _replace(series_element, "c:smooth", make("c:smooth", val=value))


def _apply_data_labels(key: str, group: etree._Element, request: ChartRequest, series_count: int) -> None:
    circular = key in CIRCULAR_TYPES
    # Direct labels replace the legend on circular charts; elsewhere a number on
    # every mark is noise, so labels stay opt-in.
    wanted = circular if request.data_labels is None else bool(request.data_labels)
    if not wanted:
        _replace(group, "c:dLbls", None)
        return

    labels = make("c:dLbls")
    number_format = request.data_label_format or ("0%" if circular else request.number_format)
    if number_format:
        _insert_ordered(labels, make("c:numFmt", formatCode=number_format, sourceLinked="0"))
    _insert_ordered(
        labels,
        _frag(f'<c:spPr xmlns:c="{C_NS}" xmlns:a="{A_NS}"><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'),
    )
    position = _label_position(key, request.data_label_position)
    # Labels that sit on top of a filled mark need to invert; labels outside it
    # stay in the neutral ink the rest of the chart uses.
    inside = circular and position in {None, "ctr", "inEnd", "bestFit"}
    label_color = "FFFFFF" if inside else TEXT_COLOR
    _insert_ordered(
        labels,
        _frag(
            f'<c:txPr xmlns:c="{C_NS}" xmlns:a="{A_NS}"><a:bodyPr/><a:lstStyle/><a:p><a:pPr>'
            f'<a:defRPr sz="{int(request.font_size_pt * 100)}" b="{1 if inside else 0}">'
            f'<a:solidFill><a:srgbClr val="{label_color}"/></a:solidFill></a:defRPr>'
            "</a:pPr><a:endParaRPr/></a:p></c:txPr>"
        ),
    )
    if position:
        _insert_ordered(labels, make("c:dLblPos", val=position))
    # Word wants the whole show* family present, not just the ones set to 1.
    flags = {
        "c:showLegendKey": "0",
        "c:showVal": "0" if circular else "1",
        "c:showCatName": "1" if circular else "0",
        "c:showSerName": "0",
        "c:showPercent": "1" if circular else "0",
        "c:showBubbleSize": "1" if key in BUBBLE_TYPES else "0",
    }
    for tag, value in flags.items():
        _insert_ordered(labels, make(tag, val=value))
    if circular:
        _insert_ordered(labels, make("c:separator", **{}))
        labels.find(qn("c:separator")).text = "\n"
    _replace(group, "c:dLbls", labels)


def _label_position(key: str, requested: str | None) -> str | None:
    if requested:
        return str(requested)
    if key in CIRCULAR_TYPES:
        return "outEnd" if not key.startswith("doughnut") and key != "donut" else None
    if "stacked" in key:
        return "ctr"  # outEnd is invalid on stacked plots and makes Word reject the file
    if key.startswith("line") or key in XY_TYPES:
        return "t"
    if key in BUBBLE_TYPES or key.startswith("area") or key.startswith("radar"):
        return None
    return "outEnd"


def _apply_axes(key: str, plot_area: etree._Element, request: ChartRequest) -> None:
    if key in CIRCULAR_TYPES:
        return  # no axes on circular plots

    axes = [child for child in plot_area if _local(child) in {"catAx", "valAx", "dateAx", "serAx"}]
    for axis in axes:
        position = axis.find(qn("c:axPos"))
        horizontal = position is not None and position.get("val") in {"b", "t"}
        is_value_axis = _local(axis) == "valAx"

        title = request.x_title if horizontal else request.y_title
        _replace(
            axis,
            "c:title",
            _title_element(title, request.font_size_pt, bold=False, vertical=not horizontal)
            if title
            else None,
        )

        show_grid = request.gridlines and not horizontal
        _replace(
            axis,
            "c:majorGridlines",
            _frag(
                f'<c:majorGridlines xmlns:c="{C_NS}" xmlns:a="{A_NS}"><c:spPr>'
                f'<a:ln w="9525"><a:solidFill><a:srgbClr val="{GRIDLINE_COLOR}"/></a:solidFill></a:ln>'
                "</c:spPr></c:majorGridlines>"
            )
            if show_grid
            else None,
        )
        _replace(axis, "c:majorTickMark", make("c:majorTickMark", val="none"))
        _replace(axis, "c:minorTickMark", make("c:minorTickMark", val="none"))
        _replace(
            axis,
            "c:spPr",
            _frag(
                f'<c:spPr xmlns:c="{C_NS}" xmlns:a="{A_NS}"><a:noFill/>'
                f'<a:ln w="9525" cap="flat"><a:solidFill><a:srgbClr val="{AXIS_LINE_COLOR}"/></a:solidFill>'
                "</a:ln></c:spPr>"
            ),
        )

        if is_value_axis and not horizontal:
            if request.number_format:
                _replace(
                    axis,
                    "c:numFmt",
                    make("c:numFmt", formatCode=request.number_format, sourceLinked="0"),
                )
            _apply_scaling(axis, request.y_min, request.y_max)


def _apply_scaling(axis: etree._Element, minimum: float | None, maximum: float | None) -> None:
    if minimum is None and maximum is None:
        return
    scaling = axis.find(qn("c:scaling"))
    if scaling is None:
        scaling = make("c:scaling")
        _insert_ordered(axis, scaling)
    # c:scaling is a sequence: logBase, orientation, max, min.
    _replace(scaling, "c:max", make("c:max", val=repr(float(maximum))) if maximum is not None else None)
    _replace(scaling, "c:min", make("c:min", val=repr(float(minimum))) if minimum is not None else None)


_LEGEND_POSITIONS = {
    "right": "r",
    "left": "l",
    "top": "t",
    "bottom": "b",
    "top_right": "tr",
    "topright": "tr",
}


def _apply_legend(
    chart: etree._Element,
    plot_area: etree._Element,
    key: str,
    request: ChartRequest,
    series_count: int,
) -> None:
    requested = str(request.legend or "auto").strip().lower()
    if requested == "auto":
        # One series needs no legend — the title already names it. Circular charts
        # carry direct labels instead.
        if key in CIRCULAR_TYPES or series_count < 2:
            requested = "none"
        else:
            requested = "bottom"

    if requested in {"none", "off", "false", "hidden"}:
        _replace(chart, "c:legend", None)
        return

    position = _LEGEND_POSITIONS.get(requested)
    if position is None:
        raise ValueError(
            f"Unknown legend position {request.legend!r}. Use auto, none, right, left, top, "
            "bottom or top_right."
        )
    legend = make("c:legend")
    _insert_ordered(legend, make("c:legendPos", val=position))
    _insert_ordered(legend, make("c:overlay", val="0"))
    _insert_ordered(
        legend,
        _frag(
            f'<c:txPr xmlns:c="{C_NS}" xmlns:a="{A_NS}"><a:bodyPr/><a:lstStyle/><a:p><a:pPr>'
            f'<a:defRPr sz="{int(request.font_size_pt * 100)}">'
            f'<a:solidFill><a:srgbClr val="{TEXT_COLOR}"/></a:solidFill></a:defRPr>'
            "</a:pPr><a:endParaRPr/></a:p></c:txPr>"
        ),
    )
    _replace(chart, "c:legend", legend)


__all__ = [
    "ChartRequest",
    "SeriesData",
    "DEFAULT_PALETTE",
    "NATIVE_TYPES",
    "add_native_chart",
    "native_chart_types",
]
