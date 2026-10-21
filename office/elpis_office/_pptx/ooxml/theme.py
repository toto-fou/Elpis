# SPDX-License-Identifier: MIT
"""Rewriting the theme part — how a deck becomes *branded* rather than merely coloured.

Every colour picker in PowerPoint, every table style, every chart the user later
inserts by hand reads from ``ppt/theme/themeN.xml``. Setting the accent slots and
the two font faces there means the deck keeps its identity when a human opens it
and carries on working — which a deck that only hard-codes colours per shape does
not.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from lxml import etree
from pptx.opc.constants import RELATIONSHIP_TYPE as RT

from .util import parse_color

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _tag(name: str) -> str:
    return f"{{{A_NS}}}{name}"


def iter_theme_parts(presentation) -> Iterable[object]:
    """Each distinct theme part reachable from the presentation, masters included."""
    seen: set[str] = set()
    parts = []
    for master in presentation.slide_masters:
        try:
            part = master.part.part_related_by(RT.THEME)
        except KeyError:  # pragma: no cover — a master without a theme is malformed
            continue
        key = str(part.partname)
        if key not in seen:
            seen.add(key)
            parts.append(part)
    return parts


def _load(part) -> etree._Element:
    return etree.fromstring(part.blob)


def _store(part, root: etree._Element) -> None:
    part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _set_srgb(parent: etree._Element, name: str, color: str) -> None:
    slot = parent.find(_tag(name))
    if slot is None:
        slot = etree.SubElement(parent, _tag(name))
    for child in list(slot):
        slot.remove(child)
    etree.SubElement(slot, _tag("srgbClr")).set("val", parse_color(color))


def apply_colors(
    presentation,
    *,
    accents: Sequence[str] | None = None,
    dark: str | None = None,
    light: str | None = None,
    hyperlink: str | None = None,
    followed_hyperlink: str | None = None,
    scheme_name: str | None = None,
) -> int:
    """Point the theme's accent1..6, dk2/lt2 and hyperlink slots at brand colours."""
    touched = 0
    for part in iter_theme_parts(presentation):
        root = _load(part)
        scheme = root.find(f"{_tag('themeElements')}/{_tag('clrScheme')}")
        if scheme is None:  # pragma: no cover — malformed theme
            continue
        if scheme_name:
            scheme.set("name", scheme_name)
        for index, color in enumerate(list(accents or [])[:6], start=1):
            _set_srgb(scheme, f"accent{index}", color)
        if dark:
            _set_srgb(scheme, "dk2", dark)
        if light:
            _set_srgb(scheme, "lt2", light)
        if hyperlink:
            _set_srgb(scheme, "hlink", hyperlink)
        if followed_hyperlink:
            _set_srgb(scheme, "folHlink", followed_hyperlink)
        _store(part, root)
        touched += 1
    return touched


def apply_fonts(presentation, major: str | None = None, minor: str | None = None) -> int:
    """Set the heading (major) and body (minor) typefaces in the theme's font scheme."""
    touched = 0
    for part in iter_theme_parts(presentation):
        root = _load(part)
        scheme = root.find(f"{_tag('themeElements')}/{_tag('fontScheme')}")
        if scheme is None:  # pragma: no cover
            continue
        for slot, typeface in (("majorFont", major), ("minorFont", minor)):
            if not typeface:
                continue
            font = scheme.find(_tag(slot))
            if font is None:
                continue
            for child_tag in ("latin", "ea", "cs"):
                node = font.find(_tag(child_tag))
                if node is None:
                    node = etree.SubElement(font, _tag(child_tag))
                # ea/cs stay empty so the renderer falls back per script; only the
                # latin face is a real typeface name.
                node.set("typeface", typeface if child_tag == "latin" else "")
        _store(part, root)
        touched += 1
    return touched


def read_theme(presentation) -> dict[str, object]:
    """What the theme currently says (accents, fonts) — read to style added slides."""
    for part in iter_theme_parts(presentation):
        root = _load(part)
        scheme = root.find(f"{_tag('themeElements')}/{_tag('clrScheme')}")
        fonts = root.find(f"{_tag('themeElements')}/{_tag('fontScheme')}")
        colors: dict[str, str] = {}
        if scheme is not None:
            for slot in scheme:
                name = etree.QName(slot).localname
                srgb = slot.find(_tag("srgbClr"))
                sys_clr = slot.find(_tag("sysClr"))
                if srgb is not None:
                    colors[name] = srgb.get("val", "")
                elif sys_clr is not None:
                    colors[name] = sys_clr.get("lastClr", "")
        def face(slot: str, fonts=fonts) -> str | None:
            if fonts is None:
                return None
            node = fonts.find(f"{_tag(slot)}/{_tag('latin')}")
            return node.get("typeface") if node is not None else None

        return {
            "name": root.get("name"),
            "colors": colors,
            "major_font": face("majorFont"),
            "minor_font": face("minorFont"),
        }
    return {}
