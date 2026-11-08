# SPDX-License-Identifier: MIT
"""Slide-level operations python-pptx leaves out: delete, reorder, duplicate, background.

``prs.slides`` is an append-only collection in python-pptx. Everything a deck
actually needs — dropping slide 4, moving the appendix to the end, cloning a
branded slide — is a matter of editing ``p:sldIdLst`` and the slide part's
relationships by hand.
"""

from __future__ import annotations

import copy
from typing import Any, Iterable

from pptx.opc.constants import RELATIONSHIP_TYPE as RT

from .util import (
    CSLD_ORDER,
    drop,
    frag,
    insert_in_order,
    parse_color,
    qn,
)

A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

#: Relationships that belong to the *slide's identity*, not its content — a clone
#: gets its own, so they must not be copied across.
_NON_CONTENT_RELS = {RT.SLIDE_LAYOUT, RT.NOTES_SLIDE}


# ---------------------------------------------------------------------------
# Deck geometry
# ---------------------------------------------------------------------------


def set_slide_size(presentation, width_emu: int, height_emu: int) -> None:
    presentation.slide_width = int(width_emu)
    presentation.slide_height = int(height_emu)


# ---------------------------------------------------------------------------
# Layouts
# ---------------------------------------------------------------------------


def iter_layouts(presentation) -> Iterable[tuple[int, Any]]:
    """Every layout in every master, with a stable flat index."""
    index = 0
    for master in presentation.slide_masters:
        for layout in master.slide_layouts:
            yield index, layout
            index += 1


def blank_layout(presentation):
    """The emptiest layout available — what the designed slide builders draw onto.

    A layout with no placeholders means nothing inherited can collide with the
    geometry the layout engine computes. Falls back to the layout with the fewest
    placeholders when a corporate template has no true blank.
    """
    best, best_count = None, None
    for _, layout in iter_layouts(presentation):
        count = len(layout.placeholders._element.findall(qn("p:sp")))
        name = (layout.name or "").strip().lower()
        if name in {"blank", "vide", "leer", "vuoto", "en blanco"}:
            return layout
        if best_count is None or count < best_count:
            best, best_count = layout, count
    return best


# ---------------------------------------------------------------------------
# Slide list surgery
# ---------------------------------------------------------------------------


def _sld_id_lst(presentation):
    return presentation.slides._sldIdLst


def delete_slide(presentation, index: int) -> None:
    id_list = _sld_id_lst(presentation)
    entries = list(id_list)
    entry = entries[index]
    rel_id = entry.get(f"{R_NS}id")
    gone = presentation.part.related_part(rel_id)
    id_list.remove(entry)
    # links from the other slides to the deleted one are dropped, or the part would survive under a reused name
    for other in presentation.slides:
        for rid, rel in list(other.part.rels.items()):
            if not rel.is_external and rel.target_part is gone:
                for el in other._element.xpath(f'.//*[@r:id="{rid}"]'):
                    el.getparent().remove(el)
                other.part.drop_rel(rid)
    # drop_rel also prunes the part when nothing else references it
    presentation.part.drop_rel(rel_id)
    # renumber the survivors: the next added slide would otherwise reuse a taken partname
    presentation.part.rename_slide_parts([e.get(f"{R_NS}id") for e in _sld_id_lst(presentation)])


def move_slide(presentation, source: int, target: int) -> None:
    id_list = _sld_id_lst(presentation)
    entries = list(id_list)
    entry = entries[source]
    id_list.remove(entry)
    remaining = list(id_list)
    target = max(0, min(target, len(remaining)))
    if target == len(remaining):
        id_list.append(entry)
    else:
        remaining[target].addprevious(entry)


def duplicate_slide(presentation, index: int):
    """Clone a slide, including its pictures and charts.

    Shapes are deep-copied and every relationship the copied XML points at is
    re-established on the new part, with the ``r:id`` values rewritten to match.
    Media parts are shared rather than duplicated — that is how PowerPoint itself
    behaves when you copy a slide, and it keeps the file small. Charts are NOT
    shared: each copy gets its own chart part and workbook, otherwise editing
    the data of one chart would silently change the other.
    """
    source = presentation.slides[index]
    clone = presentation.slides.add_slide(source.slide_layout)

    # add_slide populates the layout's placeholders; the copy brings its own.
    for shape in list(clone.shapes):
        shape._element.getparent().remove(shape._element)

    mapping: dict[str, str] = {}
    for rel_id, rel in source.part.rels.items():
        if rel.reltype in _NON_CONTENT_RELS:
            continue
        if rel.is_external:
            mapping[rel_id] = clone.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
        elif rel.reltype == RT.CHART:
            mapping[rel_id] = clone.part.relate_to(_clone_chart(rel.target_part), rel.reltype)
        else:
            mapping[rel_id] = clone.part.relate_to(rel.target_part, rel.reltype)

    tree = clone.shapes._spTree
    for element in source.shapes._spTree:
        if element.tag in (qn("p:nvGrpSpPr"), qn("p:grpSpPr")):
            continue
        copied = copy.deepcopy(element)
        _remap_relationship_ids(copied, mapping)
        tree.append(copied)

    background = source._element.find(qn("p:cSld")).find(qn("p:bg"))
    if background is not None:
        c_sld = clone._element.find(qn("p:cSld"))
        drop(c_sld, "p:bg")
        insert_in_order(c_sld, copy.deepcopy(background), CSLD_ORDER)

    if source.has_notes_slide:
        set_notes(clone, source.notes_slide.notes_text_frame.text)

    return clone


def _clone_chart(source):
    """A chart part of its own (and its own embedded workbook) for a copied slide."""
    from pptx.parts.chart import ChartPart
    from pptx.parts.embeddedpackage import EmbeddedXlsxPart

    package = source.package
    partname = package.next_partname(ChartPart.partname_template)
    clone = ChartPart.load(partname, source.content_type, package, source.blob)
    mapping: dict[str, str] = {}
    for rel_id, rel in source.rels.items():
        if rel.is_external:
            mapping[rel_id] = clone.relate_to(rel.target_ref, rel.reltype, is_external=True)
        elif rel.reltype == RT.PACKAGE:
            workbook = EmbeddedXlsxPart.new(rel.target_part.blob, package)
            mapping[rel_id] = clone.relate_to(workbook, rel.reltype)
        else:
            mapping[rel_id] = clone.relate_to(rel.target_part, rel.reltype)
    _remap_relationship_ids(clone._element, mapping)
    return clone


def _remap_relationship_ids(element, mapping: dict[str, str]) -> None:
    for node in element.iter():
        for key, value in list(node.attrib.items()):
            if key.startswith(R_NS) and value in mapping:
                node.set(key, mapping[value])


# ---------------------------------------------------------------------------
# Slide properties
# ---------------------------------------------------------------------------


def set_background(slide, color: str) -> None:
    """Paint the slide background with a solid colour."""
    c_sld = slide._element.find(qn("p:cSld"))
    drop(c_sld, "p:bg")
    fill = f'<a:solidFill><a:srgbClr val="{parse_color(color)}"/></a:solidFill>'
    insert_in_order(c_sld, frag(
        f"<p:bg {P_NS} {A_NS}><p:bgPr>{fill}<a:effectLst/></p:bgPr></p:bg>"
    ), CSLD_ORDER)


def set_notes(slide, text: str) -> None:
    """Speaker notes. Creating the notes slide lazily is what python-pptx does too."""
    slide.notes_slide.notes_text_frame.text = text or ""


def enable_header_footer(presentation, slide_number: bool = True, footer: bool = True,
                         date: bool = False) -> None:
    """Write ``p:hf`` on every master so PowerPoint honours the footer placeholders."""
    for master in presentation.slide_masters:
        element = master._element
        drop(element, "p:hf")
        attrs = []
        if not slide_number:
            attrs.append('sldNum="0"')
        if not footer:
            attrs.append('ftr="0"')
        if not date:
            attrs.append('dt="0"')
        node = frag(f'<p:hf {P_NS} {" ".join(attrs)}/>')
        # p:hf follows p:clrMap in CT_SlideMaster.
        clr_map = element.find(qn("p:clrMap"))
        if clr_map is not None:
            clr_map.addnext(node)
        else:  # pragma: no cover — every master has a colour map
            element.append(node)
