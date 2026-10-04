# SPDX-License-Identifier: MIT
"""Word field codes: table of contents, page numbers, caption numbering, cross-references.

A field is a *live* instruction Word evaluates, not baked text. That is what lets
this server produce a working table of contents and correct page numbers without
Word or LibreOffice ever touching the file: we write the instruction plus a
placeholder, and set ``w:updateFields`` so the reader recalculates on open.
"""

from __future__ import annotations

import re

from .util import frag, insert_in_order, make, qn

#: CT_Settings sequence, trimmed to the neighbourhood ``updateFields`` lives in.
#: (Full sequence per ECMA-376 §17.15.1.78; only relative order matters here.)
SETTINGS_ORDER = (
    "writeProtection", "view", "zoom", "removePersonalInformation", "removeDateAndTime",
    "doNotDisplayPageBoundaries", "displayBackgroundShape", "printPostScriptOverText",
    "printFractionalCharacterWidth", "printFormsData", "embedTrueTypeFonts",
    "embedSystemFonts", "saveSubsetFonts", "saveFormsData", "mirrorMargins",
    "alignBordersAndEdges", "bordersDoNotSurroundHeader", "bordersDoNotSurroundFooter",
    "gutterAtTop", "hideSpellingErrors", "hideGrammaticalErrors", "activeWritingStyle",
    "proofState", "formsDesign", "attachedTemplate", "linkStyles", "stylePaneFormatFilter",
    "stylePaneSortMethod", "documentType", "mailMerge", "revisionView", "trackChanges",
    "doNotTrackMoves", "doNotTrackFormatting", "documentProtection", "autoFormatOverride",
    "styleLockTheme", "styleLockQFSet", "defaultTabStop", "autoHyphenation",
    "consecutiveHyphenLimit", "hyphenationZone", "doNotHyphenateCaps", "showEnvelope",
    "summaryLength", "clickAndTypeStyle", "defaultTableStyle", "evenAndOddHeaders",
    "bookFoldRevPrinting", "bookFoldPrinting", "bookFoldPrintingSheets",
    "drawingGridHorizontalSpacing", "drawingGridVerticalSpacing",
    "displayHorizontalDrawingGridEvery", "displayVerticalDrawingGridEvery",
    "doNotUseMarginsForDrawingGridOrigin", "drawingGridHorizontalOrigin",
    "drawingGridVerticalOrigin", "doNotShadeFormData", "noPunctuationKerning",
    "characterSpacingControl", "printTwoOnOne", "strictFirstAndLastChars",
    "noLineBreaksAfter", "noLineBreaksBefore", "savePreviewPicture",
    "doNotValidateAgainstSchema", "saveInvalidXml", "ignoreMixedContent",
    "alwaysShowPlaceholderText", "doNotDemarcateInvalidXml", "saveXmlDataOnly",
    "useXSLTWhenSaving", "saveThroughXslt", "showXMLTags", "alwaysMergeEmptyNamespace",
    "updateFields", "hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "docVars",
    "rsids", "mathPr", "uiCompat97To2003", "attachedSchema", "themeFontLang",
    "clrSchemeMapping", "doNotIncludeSubdocsInStats", "doNotAutoCompressPictures",
    "forceUpgrade", "captions", "readModeInkLockDown", "smartTagType", "schemaLibrary",
    "shapeDefaults", "doNotEmbedSmartTags", "decimalSymbol", "listSeparator",
)

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def add_field(paragraph, instruction: str, placeholder: str = "", style: str | None = None):
    """Append a complete ``begin / instrText / separate / result / end`` field run set.

    ``placeholder`` is what a reader that never evaluates fields will show, so it
    should be a sensible fallback rather than empty.
    """
    _append_fld_char(paragraph, "begin", dirty=True)

    run = paragraph.add_run()
    instr = make("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {instruction.strip()} "
    run._r.append(instr)

    _append_fld_char(paragraph, "separate")

    result = paragraph.add_run(placeholder)
    if style:
        try:
            result.style = style
        except KeyError:
            pass

    _append_fld_char(paragraph, "end")
    return paragraph


def _append_fld_char(paragraph, char_type: str, dirty: bool = False):
    run = paragraph.add_run()
    attrs = {"w:fldCharType": char_type}
    if dirty:
        attrs["w:dirty"] = "true"
    run._r.append(make("w:fldChar", **attrs))
    return run


def add_toc(document, levels: tuple[int, int] = (1, 3), hyperlinks: bool = True):
    """Insert a table-of-contents field as a two-paragraph block.

    ``\\o`` picks up heading levels, ``\\h`` makes entries clickable, ``\\z`` hides
    tab leaders in web view and ``\\u`` includes outline-level paragraphs.

    The field starts empty; :func:`populate_toc` fills in the cached result once
    every heading exists. Both halves matter: the cached entries are what readers
    that never evaluate fields display, and the live field is what lets Word
    refresh the whole thing on open.
    """
    low, high = int(levels[0]), int(levels[1])
    switches = f'TOC \\o "{low}-{high}" \\z \\u'
    if hyperlinks:
        switches += " \\h"

    start = document.add_paragraph()
    _append_fld_char(start, "begin", dirty=True)
    run = start.add_run()
    instr = make("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {switches} "
    run._r.append(instr)
    _append_fld_char(start, "separate")

    end = document.add_paragraph()
    _append_fld_char(end, "end")
    return start


# -- cached TOC result -----------------------------------------------------------

_HEADING_STYLE = re.compile(r"^heading\s*(\d)$", re.IGNORECASE)
_TOC_BOOKMARK_PREFIX = "_Toc9"


def _paragraph_level(element) -> int | None:
    """Outline level of a body paragraph, 1-based, or None if it is not a heading."""
    ppr = element.find(qn("w:pPr"))
    if ppr is None:
        return None
    # A direct w:outlineLvl overrides whatever the style says — that is how a
    # paragraph styled Heading 1 (the "Contents" title) stays out of the contents.
    outline = ppr.find(qn("w:outlineLvl"))
    if outline is not None:
        try:
            value = int(outline.get(qn("w:val"), "9"))
        except (TypeError, ValueError):
            value = 9
        return value + 1 if 0 <= value <= 8 else None
    style = ppr.find(qn("w:pStyle"))
    if style is not None:
        match = _HEADING_STYLE.match((style.get(qn("w:val")) or "").replace("Heading", "Heading "))
        if match:
            return int(match.group(1))
    return None


def _paragraph_text(element) -> str:
    return "".join(node.text or "" for node in element.iter(qn("w:t"))).strip()


def _find_toc_blocks(paragraphs: list) -> list[tuple[int, int, str]]:
    """Locate ``(start_index, end_index, instruction)`` for every TOC field."""
    blocks: list[tuple[int, int, str]] = []
    index = 0
    while index < len(paragraphs):
        instructions = [
            (node.text or "").strip()
            for node in paragraphs[index].iter(qn("w:instrText"))
        ]
        toc = next((text for text in instructions if text.upper().startswith("TOC")), None)
        if toc is None:
            index += 1
            continue
        # Walk forward tracking field nesting: entries we generated contain their
        # own PAGEREF fields, so the first w:fldChar end is not necessarily ours.
        depth = 0
        end_index = None
        for cursor in range(index, len(paragraphs)):
            for field_char in paragraphs[cursor].iter(qn("w:fldChar")):
                kind = field_char.get(qn("w:fldCharType"))
                if kind == "begin":
                    depth += 1
                elif kind == "end":
                    depth -= 1
                    if depth == 0:
                        end_index = cursor
                        break
            if end_index is not None:
                break
        if end_index is None or end_index == index:
            index += 1
            continue
        blocks.append((index, end_index, toc))
        index = end_index + 1
    return blocks


def _levels_from_instruction(instruction: str) -> tuple[int, int]:
    match = re.search(r'\\o\s*"(\d)\s*-\s*(\d)"', instruction)
    if match:
        return int(match.group(1)), int(match.group(2))
    return 1, 3


def populate_toc(document) -> int:
    """Rebuild the cached result of every TOC field from the document's headings.

    Word repopulates a TOC on open (that is what ``w:updateFields`` asks for), but
    LibreOffice and most viewers do not — they render whatever the field's cached
    result holds. Writing real entries here is what makes the table of contents
    show up everywhere rather than only in Word.

    Idempotent: previously generated entries are discarded and rebuilt, so this
    can run before every save. Returns the number of entries written.
    """
    body = document.element.body
    paragraphs = list(body.iterchildren(qn("w:p")))
    blocks = _find_toc_blocks(paragraphs)
    if not blocks:
        return 0

    covered = {i for start, end, _ in blocks for i in range(start, end + 1)}
    right_tab = _right_tab_twips(document)
    written = 0

    # Rebuild back-to-front so earlier indices stay valid as we delete paragraphs.
    for start_index, end_index, instruction in reversed(blocks):
        low, high = _levels_from_instruction(instruction)
        start_paragraph = paragraphs[start_index]
        end_paragraph = paragraphs[end_index]

        for stale in paragraphs[start_index + 1 : end_index]:
            body.remove(stale)
        _truncate_after_separate(start_paragraph)

        entries = []
        for position, element in enumerate(paragraphs):
            if position in covered:
                continue
            level = _paragraph_level(element)
            if level is None or not (low <= level <= high):
                continue
            text = _paragraph_text(element)
            if text:
                entries.append((level, text, element))

        for counter, (level, text, element) in enumerate(entries, start=1):
            bookmark = f"{_TOC_BOOKMARK_PREFIX}{counter:07d}"
            _bookmark_heading(element, bookmark, counter)
            entry = _toc_entry(level, text, bookmark, right_tab, low)
            end_paragraph.addprevious(entry)
            written += 1

    return written


def _right_tab_twips(document) -> int:
    section = document.sections[0]
    width = section.page_width or 0
    left = section.left_margin or 0
    right = section.right_margin or 0
    usable = max(int(width) - int(left) - int(right), 0)
    return int(usable / 635) if usable else 9026  # EMU -> twips


def _truncate_after_separate(paragraph_element) -> None:
    """Drop the placeholder that sat between ``separate`` and the end of the field."""
    seen_separate = False
    for child in list(paragraph_element):
        if seen_separate:
            paragraph_element.remove(child)
            continue
        for field_char in child.iter(qn("w:fldChar")):
            if field_char.get(qn("w:fldCharType")) == "separate":
                seen_separate = True
                break


def _bookmark_heading(element, name: str, bookmark_id: int) -> None:
    for existing in list(element.iterchildren(qn("w:bookmarkStart"))):
        if (existing.get(qn("w:name")) or "").startswith(_TOC_BOOKMARK_PREFIX):
            element.remove(existing)
    for existing in list(element.iterchildren(qn("w:bookmarkEnd"))):
        element.remove(existing)
    identifier = str(900000 + bookmark_id)
    # CT_P: w:pPr must stay the FIRST child — the bookmark goes right after it.
    ppr = element.find(qn("w:pPr"))
    position = element.index(ppr) + 1 if ppr is not None else 0
    element.insert(position, make("w:bookmarkStart", **{"w:id": identifier, "w:name": name}))
    element.append(make("w:bookmarkEnd", **{"w:id": identifier}))


def _toc_entry(level: int, text: str, bookmark: str, right_tab: int, base_level: int):
    indent = max(0, (level - base_level)) * 220
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return frag(
        f'<w:p xmlns:w="{W_NS}"><w:pPr>'
        f'<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="{right_tab}"/></w:tabs>'
        f'<w:spacing w:after="60" w:line="240" w:lineRule="auto"/>'
        f'<w:ind w:left="{indent}" w:right="{560}"/>'
        "</w:pPr>"
        f'<w:hyperlink w:anchor="{bookmark}" w:history="1">'
        f'<w:r><w:rPr><w:noProof/>{"<w:b/>" if level == base_level else ""}'
        f'<w:color w:val="333333"/></w:rPr><w:t xml:space="preserve">{escaped}</w:t></w:r>'
        "<w:r><w:tab/></w:r>"
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        f'<w:r><w:instrText xml:space="preserve"> PAGEREF {bookmark} \\h </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        # Deliberately no cached number: we cannot lay out pages, and a wrong "1"
        # on every line is worse than a blank that Word fills in on open.
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        "</w:hyperlink></w:p>"
    )


TOC_NOTE = (
    "Table of contents: entry text and links are baked in; the page numbers are live "
    "PAGEREF fields that Word fills in when the document is opened (w:updateFields is set)."
)


def add_page_number(paragraph, kind: str = "PAGE") -> None:
    add_field(paragraph, kind.upper(), placeholder="1")


_FIELD_TOKEN = re.compile(r"\{\s*(PAGE|NUMPAGES|DATE|TIME|FILENAME|AUTHOR|TITLE)\s*\}", re.IGNORECASE)


def add_text_with_fields(paragraph, template: str, **run_format) -> None:
    """Write ``template`` into ``paragraph``, turning ``{PAGE}``-style tokens into fields.

    ``"Page {PAGE} / {NUMPAGES}"`` becomes literal text around two live fields.
    """
    from .util import apply_run_format  # local import: avoids a cycle at module load

    position = 0
    for match in _FIELD_TOKEN.finditer(template or ""):
        literal = template[position : match.start()]
        if literal:
            run = paragraph.add_run(literal)
            apply_run_format(run, run_format)
        add_field(paragraph, match.group(1).upper(), placeholder="1")
        position = match.end()
    tail = (template or "")[position:]
    if tail:
        run = paragraph.add_run(tail)
        apply_run_format(run, run_format)


def add_seq_field(paragraph, label: str) -> None:
    """A ``SEQ`` field — the counter behind auto-numbered Figure/Table captions."""
    add_field(paragraph, f"SEQ {label} \\* ARABIC", placeholder="1")


def add_cross_reference(paragraph, bookmark: str, placeholder: str = "…") -> None:
    """A ``REF`` field pointing at a bookmark, rendered as a hyperlink."""
    add_field(paragraph, f"REF {bookmark} \\h", placeholder=placeholder)


def set_update_fields_on_open(document) -> None:
    """Ask the reader to recalculate every field when the document is opened.

    Without this the TOC and page numbers show their placeholder until the user
    presses F9. With it, Word and LibreOffice both populate them on open — which
    is what makes a correct table of contents possible on a host with no Office.
    """
    settings = document.settings.element
    for existing in settings.findall(qn("w:updateFields")):
        settings.remove(existing)
    insert_in_order(settings, make("w:updateFields", **{"w:val": "true"}), SETTINGS_ORDER)


def add_line_break(paragraph, break_type: str | None = None) -> None:
    attrs = {"w:type": break_type} if break_type else {}
    paragraph.add_run()._r.append(make("w:br", **attrs))


def add_page_break(paragraph) -> None:
    add_line_break(paragraph, "page")


def horizontal_rule(paragraph, color: str = "BFBFBF", size: int = 6) -> None:
    """A bottom border on an empty paragraph — the OOXML way to draw a rule."""
    ppr = paragraph._p.get_or_add_pPr()
    for existing in ppr.findall(qn("w:pBdr")):
        ppr.remove(existing)
    border = frag(
        f'<w:pBdr xmlns:w="{W_NS}">'
        f'<w:bottom w:val="single" w:sz="{size}" w:space="1" w:color="{color}"/></w:pBdr>'
    )
    # w:pBdr follows pStyle/keepNext/keepLines/pageBreakBefore/framePr/widowControl/numPr/…
    insert_in_order(ppr, border, PPR_ORDER)


#: CT_PPr sequence — needed whenever we hand-write paragraph properties.
PPR_ORDER = (
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl",
    "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens",
    "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN",
    "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing",
    "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment",
    "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange",
)
