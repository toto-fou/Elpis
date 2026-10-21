# SPDX-License-Identifier: MIT
"""Bookmarks, hyperlinks, numbered captions and cross-references."""

from __future__ import annotations

import re

from docx.opc.constants import RELATIONSHIP_TYPE as RT

from .fields import add_field, add_seq_field
from .util import align_paragraph, apply_run_format, make, qn

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

_BOOKMARK_SAFE = re.compile(r"[^0-9A-Za-z_]")


def normalise_bookmark(name: str) -> str:
    """Word bookmark names: letters, digits and underscores, starting with a letter."""
    cleaned = _BOOKMARK_SAFE.sub("_", str(name).strip())[:40] or "bookmark"
    if not cleaned[0].isalpha():
        cleaned = f"b_{cleaned}"
    return cleaned


def _next_bookmark_id(document) -> int:
    used = {0}
    for element in document.element.body.iter(qn("w:bookmarkStart")):
        try:
            used.add(int(element.get(qn("w:id"), "0")))
        except (TypeError, ValueError):
            continue
    return max(used) + 1


def _remove_bookmark(document, name: str) -> None:
    """Drop an existing bookmarkStart/End pair so the name can be re-anchored."""
    body = document.element.body
    for start in body.iter(qn("w:bookmarkStart")):
        if start.get(qn("w:name")) != name:
            continue
        mark_id = start.get(qn("w:id"))
        for end in body.iter(qn("w:bookmarkEnd")):
            if end.get(qn("w:id")) == mark_id:
                end.getparent().remove(end)
                break
        start.getparent().remove(start)
        return


def add_bookmark(document, paragraph, name: str) -> str:
    """Wrap ``paragraph``'s current content in a bookmark and return its final name.

    Re-using an existing name moves the bookmark, exactly as Word does —
    duplicate names would leave every REF/PAGEREF pointing at whichever copy
    the reader finds first.
    """
    bookmark = normalise_bookmark(name)
    _remove_bookmark(document, bookmark)
    bookmark_id = _next_bookmark_id(document)
    start = make("w:bookmarkStart", **{"w:id": str(bookmark_id), "w:name": bookmark})
    end = make("w:bookmarkEnd", **{"w:id": str(bookmark_id)})
    # CT_P: w:pPr must stay the FIRST child — the bookmark goes right after it.
    ppr = paragraph._p.find(qn("w:pPr"))
    paragraph._p.insert(paragraph._p.index(ppr) + 1 if ppr is not None else 0, start)
    paragraph._p.append(end)
    return bookmark


def add_hyperlink(
    document,
    paragraph,
    text: str,
    *,
    url: str | None = None,
    anchor: str | None = None,
    tooltip: str | None = None,
    color: str = "0563C1",
    underline: bool = True,
    **run_format,
):
    """Append a clickable run — external (``url``) or internal (``anchor``).

    python-docx has no hyperlink API, so the ``w:hyperlink`` element and, for
    external links, the package relationship are built here.
    """
    if not url and not anchor:
        raise ValueError("A hyperlink needs either 'url' (external) or 'anchor' (a bookmark name).")

    attrs: dict[str, str] = {}
    if url:
        rid = document.part.relate_to(str(url), RT.HYPERLINK, is_external=True)
        attrs["r:id"] = rid
    if anchor:
        attrs["w:anchor"] = normalise_bookmark(anchor)
    if tooltip:
        attrs["w:tooltip"] = str(tooltip)

    link = make("w:hyperlink", **attrs)
    paragraph._p.append(link)

    # Build the run through python-docx, then move it inside the hyperlink so we
    # keep the normal formatting API.
    run = paragraph.add_run(text)
    fmt = {"color": color, "underline": underline, **run_format}
    apply_run_format(run, fmt)
    try:
        run.style = "Hyperlink"
    except KeyError:
        pass  # style absent from this template; the direct formatting above covers it
    link.append(run._r)
    return run


#: Label -> the SEQ counter name Word uses. Keeping these stable matters because
#: a cross-reference resolves by counter name.
CAPTION_LABELS = {"figure": "Figure", "table": "Table", "equation": "Equation", "chart": "Figure"}


def add_caption(
    document,
    text: str,
    *,
    label: str = "Figure",
    separator: str = " — ",
    style: str | None = "Caption",
    align: str = "center",
    bookmark: str | None = None,
    paragraph=None,
):
    """Add an auto-numbered caption: ``Figure 3 — Quarterly revenue``.

    The number is a live SEQ field, so inserting a figure earlier in the document
    renumbers everything after it automatically.
    """
    counter = CAPTION_LABELS.get(str(label).strip().lower(), str(label).strip() or "Figure")
    target = paragraph if paragraph is not None else document.add_paragraph()
    if style:
        try:
            target.style = style
        except KeyError:
            target.style = "Normal"

    target.add_run(f"{counter} ")
    add_seq_field(target, counter)
    if text:
        target.add_run(f"{separator}{text}")
    align_paragraph(target, align)
    if bookmark:
        add_bookmark(document, target, bookmark)
    return target


def add_cross_reference(
    document, paragraph, bookmark: str, *, placeholder: str = "…", color: str = "0563C1"
):
    """Insert a REF field that resolves to the bookmarked text."""
    add_field(paragraph, f"REF {normalise_bookmark(bookmark)} \\h", placeholder=placeholder)
    return paragraph
