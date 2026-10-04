# SPDX-License-Identifier: MIT
"""Real multilevel lists.

Using the built-in "List Bullet" / "List Number" styles looks right until the
second numbered list, which continues from the first instead of restarting.
Word's actual model is a numbering definition per list, so that is what we build:
each list gets its own ``w:num`` pointing at a fresh ``w:abstractNum``.
"""

from __future__ import annotations

from docx.shared import Cm

from .util import frag, insert_in_order, qn

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

#: CT_Numbering sequence: every abstractNum must precede every num.
NUMBERING_ORDER = ("numPicBullet", "abstractNum", "num", "numIdMacAtCleanup")

#: CT_PPr — needed to place w:numPr correctly among paragraph properties.
from .fields import PPR_ORDER  # noqa: E402  (single source of truth for the sequence)

_BULLETS = (
    ("", "Symbol"),
    ("o", "Courier New"),
    ("", "Wingdings"),
    ("", "Symbol"),
    ("o", "Courier New"),
)

_NUMBER_FORMATS = ("decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter")
_NUMBER_TEXT = ("%1.", "%2.", "%3.", "%4.", "%5.")

MAX_LEVELS = 5


def _numbering_element(document):
    return document.part.numbering_part.element


def _next_ids(numbering) -> tuple[int, int]:
    abstract_ids = {
        int(node.get(qn("w:abstractNumId"), "0"))
        for node in numbering.findall(qn("w:abstractNum"))
    } or {0}
    num_ids = {int(node.get(qn("w:numId"), "0")) for node in numbering.findall(qn("w:num"))} or {0}
    return max(abstract_ids) + 1, max(num_ids) + 1


def create_numbering(document, ordered: bool, indent_cm: float = 0.63) -> int:
    """Define a fresh list and return its ``numId``.

    A new definition per list is what makes ordered lists restart at 1.
    """
    numbering = _numbering_element(document)
    abstract_id, num_id = _next_ids(numbering)

    levels = []
    for level in range(MAX_LEVELS):
        left = int(Cm(indent_cm * (level + 1) + 0.1).twips)
        hanging = int(Cm(indent_cm).twips)
        if ordered:
            levels.append(
                f'<w:lvl w:ilvl="{level}">'
                f'<w:start w:val="1"/><w:numFmt w:val="{_NUMBER_FORMATS[level]}"/>'
                f'<w:lvlText w:val="{_NUMBER_TEXT[level]}"/><w:lvlJc w:val="left"/>'
                f'<w:pPr><w:ind w:left="{left}" w:hanging="{hanging}"/></w:pPr>'
                "</w:lvl>"
            )
        else:
            glyph, font = _BULLETS[level]
            levels.append(
                f'<w:lvl w:ilvl="{level}">'
                f'<w:start w:val="1"/><w:numFmt w:val="bullet"/>'
                f'<w:lvlText w:val="{glyph}"/><w:lvlJc w:val="left"/>'
                f'<w:pPr><w:ind w:left="{left}" w:hanging="{hanging}"/></w:pPr>'
                f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:hint="default"/></w:rPr>'
                "</w:lvl>"
            )

    abstract = frag(
        f'<w:abstractNum xmlns:w="{W_NS}" w:abstractNumId="{abstract_id}">'
        '<w:multiLevelType w:val="hybridMultilevel"/>'
        f'{"".join(levels)}</w:abstractNum>'
    )
    number = frag(
        f'<w:num xmlns:w="{W_NS}" w:numId="{num_id}">'
        f'<w:abstractNumId w:val="{abstract_id}"/></w:num>'
    )
    insert_in_order(numbering, abstract, NUMBERING_ORDER)
    insert_in_order(numbering, number, NUMBERING_ORDER)
    return num_id


def apply_list_item(paragraph, num_id: int, level: int = 0) -> None:
    """Attach a paragraph to a numbering definition at the given level."""
    ppr = paragraph._p.get_or_add_pPr()
    for existing in ppr.findall(qn("w:numPr")):
        ppr.remove(existing)
    num_pr = frag(
        f'<w:numPr xmlns:w="{W_NS}">'
        f'<w:ilvl w:val="{max(0, min(level, MAX_LEVELS - 1))}"/>'
        f'<w:numId w:val="{num_id}"/></w:numPr>'
    )
    insert_in_order(ppr, num_pr, PPR_ORDER)
