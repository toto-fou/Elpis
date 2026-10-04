# SPDX-License-Identifier: MIT
"""Footnotes.

python-docx has no footnote support at all, so the ``/word/footnotes.xml`` part —
including the separator entries Word requires — is created and maintained here.
"""

from __future__ import annotations

from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from lxml import etree

from .util import frag, make, qn

CT_FOOTNOTES = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"
)
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

#: Word will not open a document whose footnotes part lacks these two entries.
_SKELETON = (
    f'<w:footnotes xmlns:w="{W_NS}">'
    '<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr>'
    '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
    "<w:r><w:separator/></w:r></w:p></w:footnote>"
    '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr>'
    '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
    "<w:r><w:continuationSeparator/></w:r></w:p></w:footnote>"
    "</w:footnotes>"
)


class FootnotesPart(Part):
    """An OPC part that keeps its XML tree live and re-serialises on demand."""

    def __init__(self, partname, content_type, element, package):
        super().__init__(partname, content_type, b"", package)
        self.element = element

    @property
    def blob(self) -> bytes:  # type: ignore[override]
        return etree.tostring(
            self.element, xml_declaration=True, encoding="UTF-8", standalone=True
        )


def _adopt(rel) -> FootnotesPart:
    """Re-wrap a footnotes part loaded from disk.

    A package opened by python-docx loads /word/footnotes.xml as a generic
    blob :class:`Part` with no live tree. Parse it back and swap the
    relationship target so later saves serialise our edits, not the stale blob.
    """
    old = rel.target_part
    part = FootnotesPart(
        old.partname, old.content_type, etree.fromstring(old.blob), old.package
    )
    rel._target = part
    return part


def _get_or_create_part(document) -> FootnotesPart:
    document_part = document.part
    for rel in document_part.rels.values():
        if rel.reltype == RT.FOOTNOTES and not rel.is_external:
            part = rel.target_part
            return part if isinstance(part, FootnotesPart) else _adopt(rel)
    part = FootnotesPart(
        PackURI("/word/footnotes.xml"),
        CT_FOOTNOTES,
        frag(_SKELETON),
        document_part.package,
    )
    document_part.relate_to(part, RT.FOOTNOTES)
    return part


def _next_footnote_id(part: FootnotesPart) -> int:
    used = {0}
    for note in part.element.findall(qn("w:footnote")):
        try:
            used.add(int(note.get(qn("w:id"), "0")))
        except (TypeError, ValueError):
            continue
    return max(used) + 1


def _has_style(document, style_id: str) -> bool:
    try:
        document.styles[style_id]
        return True
    except KeyError:
        return False


def add_footnote(document, paragraph, text: str, *, font_size_pt: float = 9.0) -> int:
    """Append a footnote reference to ``paragraph`` and its text at the page foot.

    Returns the footnote id, which is also the number Word will display.
    """
    if not str(text).strip():
        raise ValueError("A footnote needs some text.")
    from .util import sanitize_text

    text = sanitize_text(str(text))

    part = _get_or_create_part(document)
    note_id = _next_footnote_id(part)

    use_ref_style = _has_style(document, "Footnote Reference")
    use_text_style = _has_style(document, "Footnote Text")

    # The marker inside the body.
    run = paragraph.add_run()
    rpr = run._element.get_or_add_rPr()
    if use_ref_style:
        rpr.append(make("w:rStyle", **{"w:val": "FootnoteReference"}))
    else:
        rpr.append(make("w:vertAlign", **{"w:val": "superscript"}))
    run._element.append(make("w:footnoteReference", **{"w:id": str(note_id)}))

    # The note body at the foot of the page.
    style_xml = '<w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>' if use_text_style else ""
    ref_rpr = (
        '<w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>'
        if use_ref_style
        else '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
    )
    size_rpr = "" if use_text_style else f'<w:rPr><w:sz w:val="{int(font_size_pt * 2)}"/></w:rPr>'
    escaped = (
        str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    note = frag(
        f'<w:footnote xmlns:w="{W_NS}" w:id="{note_id}"><w:p>{style_xml}'
        f"<w:r>{ref_rpr}<w:footnoteRef/></w:r>"
        f'<w:r>{size_rpr}<w:t xml:space="preserve"> {escaped}</w:t></w:r>'
        "</w:p></w:footnote>"
    )
    part.element.append(note)
    return note_id


def count_footnotes(document) -> int:
    for rel in document.part.rels.values():
        if rel.reltype == RT.FOOTNOTES and not rel.is_external:
            part = rel.target_part
            element = (
                part.element
                if isinstance(part, FootnotesPart)
                else etree.fromstring(part.blob)
            )
            return max(0, len(element.findall(qn("w:footnote"))) - 2)
    return 0
