# SPDX-License-Identifier: MIT
"""Markdown → slides.

A deck outline is the one thing people already write in Markdown, so accepting it
directly removes the whole translation step. The mapping is deliberately literal:

* ``# Heading``    — a section divider (the first one becomes the title slide)
* ``## Heading``   — a new slide, with that title
* ``### Heading``  — a bold lead-in line inside the current slide
* ``---``          — force a slide break
* lists            — bullets, nesting preserved
* tables           — a table slide
* ``> quote``      — a quote slide when it stands alone
* ``![alt](path)`` — an image slide
* ``Notes: …``     — speaker notes for the current slide

Inline ``**bold**``, ``*italic*``, ``~~strike~~``, `` `code` `` and links survive.
"""

from __future__ import annotations

import re
from typing import Any

_BULLET = re.compile(r"^(?P<indent>[ \t]*)(?P<marker>[-*+]|\d+[.)])\s+(?P<text>.*)$")
_HEADING = re.compile(r"^(?P<hashes>#{1,6})\s+(?P<text>.*)$")
_IMAGE = re.compile(r"^!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)\)\s*$")
_RULE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
_TABLE_ROW = re.compile(r"^\s*\|(.+)\|\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?[\s:|-]+\|[\s:|-]*$")
_NOTES = re.compile(r"^\s*(?:notes?|speaker notes?)\s*:\s*(?P<text>.*)$", re.IGNORECASE)
_FENCE = re.compile(r"^\s*(?:```|~~~)(?P<lang>[\w+-]*)\s*$")


def _inline_runs(text: str) -> list[dict[str, Any]]:
    """Split one line of Markdown into formatted runs."""
    try:
        from markdown_it import MarkdownIt
    except ImportError:  # pragma: no cover — markdown-it is a hard dependency
        return [{"text": text}]

    tokens = MarkdownIt("commonmark").enable("strikethrough").parseInline(text)
    if not tokens or not tokens[0].children:
        return [{"text": text}]

    runs: list[dict[str, Any]] = []
    state = {"bold": 0, "italic": 0, "strike": 0, "link": None}
    for token in tokens[0].children:
        kind = token.type
        if kind == "text" and token.content:
            runs.append(_run(token.content, state))
        elif kind == "code_inline":
            run = _run(token.content, state)
            run["code"] = True
            runs.append(run)
        elif kind == "softbreak":
            runs.append(_run("\n", state))
        elif kind == "strong_open":
            state["bold"] += 1
        elif kind == "strong_close":
            state["bold"] = max(0, state["bold"] - 1)
        elif kind == "em_open":
            state["italic"] += 1
        elif kind == "em_close":
            state["italic"] = max(0, state["italic"] - 1)
        elif kind == "s_open":
            state["strike"] += 1
        elif kind == "s_close":
            state["strike"] = max(0, state["strike"] - 1)
        elif kind == "link_open":
            state["link"] = token.attrGet("href")
        elif kind == "link_close":
            state["link"] = None
    return runs or [{"text": text}]


def _run(text: str, state: dict) -> dict[str, Any]:
    run: dict[str, Any] = {"text": text}
    if state["bold"]:
        run["bold"] = True
    if state["italic"]:
        run["italic"] = True
    if state["strike"]:
        run["strike"] = True
    if state["link"]:
        run["link"] = state["link"]
    return run


def _plain(text: str) -> str:
    """Strip the Markdown that the inline parser would otherwise leave in a title."""
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[*_`~]", "", text).strip()


class _Deck:
    """Accumulates slides while the line walker works through the document."""

    def __init__(self, title_slide: bool) -> None:
        self.slides: list[dict[str, Any]] = []
        self.current: dict[str, Any] | None = None
        self.want_title = title_slide

    def start(self, slide: dict[str, Any]) -> dict[str, Any]:
        self.flush()
        self.current = slide
        return slide

    def flush(self) -> None:
        if self.current is None:
            return
        slide = self.current
        self.current = None
        if slide.get("layout") in {"bullets", None} and not slide.get("bullets") \
                and not slide.get("text") and not slide.get("elements"):
            # A heading with nothing under it is still a slide worth keeping,
            # but only if it has a title to show.
            if not slide.get("title"):
                return
        self.slides.append(slide)

    def body(self) -> dict[str, Any]:
        if self.current is None or self.current.get("layout") not in {"bullets", None}:
            self.start({"layout": "bullets", "title": None, "bullets": []})
        self.current.setdefault("bullets", [])
        return self.current


def markdown_to_slides(text: str, *, title_slide: bool = True) -> list[dict[str, Any]]:
    """Convert a Markdown document into a list of slide specs."""
    deck = _Deck(title_slide)
    lines = str(text or "").replace("\r\n", "\n").split("\n")

    index = 0
    fence_lang: str | None = None
    fence_buffer: list[str] = []
    table_buffer: list[str] = []

    def close_table() -> None:
        nonlocal table_buffer
        if table_buffer:
            _emit_table(deck, table_buffer)
            table_buffer = []

    while index < len(lines):
        line = lines[index]
        index += 1

        fence = _FENCE.match(line)
        if fence_lang is not None:
            if fence:
                _emit_code(deck, fence_buffer, fence_lang)
                fence_lang, fence_buffer = None, []
            else:
                fence_buffer.append(line)
            continue
        if fence:
            close_table()
            fence_lang = fence.group("lang") or ""
            continue

        if _TABLE_ROW.match(line):
            table_buffer.append(line)
            continue
        close_table()

        if not line.strip():
            continue

        notes = _NOTES.match(line)
        if notes and deck.current is not None:
            existing = deck.current.get("notes")
            deck.current["notes"] = (
                f"{existing}\n{notes.group('text')}" if existing else notes.group("text")
            )
            continue

        if _RULE.match(line):
            deck.flush()
            continue

        heading = _HEADING.match(line)
        if heading:
            level = len(heading.group("hashes"))
            title = _plain(heading.group("text"))
            if level == 1:
                if deck.want_title and not deck.slides and deck.current is None:
                    deck.want_title = False
                    subtitle = _peek_paragraph(lines, index)
                    deck.start({"layout": "title", "title": title, "subtitle": subtitle})
                    deck.flush()
                    if subtitle:
                        index = _skip_paragraph(lines, index)
                else:
                    deck.start({"layout": "section", "title": title})
                    deck.flush()
            elif level == 2:
                deck.start({"layout": "bullets", "title": title, "bullets": []})
            else:
                slide = deck.body()
                slide["bullets"].append({
                    "runs": [{"text": title, "bold": True}],
                    "level": 0,
                    "bullet": "",
                    "space_before_pt": 10,
                })
            continue

        image = _IMAGE.match(line.strip())
        if image:
            deck.start({
                "layout": "image", "image": image.group("src"),
                "caption": _plain(image.group("alt")) or None,
                "title": None, "fit": "contain",
            })
            deck.flush()
            continue

        if line.lstrip().startswith(">"):
            quote, index = _collect_quote(lines, index - 1)
            deck.start(quote)
            deck.flush()
            continue

        bullet = _BULLET.match(line)
        if bullet:
            slide = deck.body()
            depth = len(bullet.group("indent").replace("\t", "  ")) // 2
            slide["bullets"].append({
                "runs": _inline_runs(bullet.group("text").strip()),
                "level": min(depth, 4),
            })
            if bullet.group("marker")[0].isdigit():
                slide["numbered"] = True
            continue

        slide = deck.body()
        slide["bullets"].append({
            "runs": _inline_runs(line.strip()),
            "level": 0,
            "bullet": "",
            "space_before_pt": 8,
        })

    if fence_lang is not None:
        _emit_code(deck, fence_buffer, fence_lang)
    close_table()
    deck.flush()
    return deck.slides


def _peek_paragraph(lines: list[str], index: int) -> str | None:
    while index < len(lines) and not lines[index].strip():
        index += 1
    if index < len(lines):
        candidate = lines[index].strip()
        if candidate and not _HEADING.match(candidate) and not _BULLET.match(candidate) \
                and not _RULE.match(candidate):
            return _plain(candidate)
    return None


def _skip_paragraph(lines: list[str], index: int) -> int:
    while index < len(lines) and not lines[index].strip():
        index += 1
    return index + 1 if index < len(lines) else index


def _collect_quote(lines: list[str], start: int) -> tuple[dict[str, Any], int]:
    parts: list[str] = []
    index = start
    while index < len(lines) and lines[index].lstrip().startswith(">"):
        parts.append(lines[index].lstrip()[1:].strip())
        index += 1
    body = " ".join(part for part in parts if part)
    author = None
    match = re.search(r"[—–-]{1,2}\s*(?P<author>[^—–]+)$", body)
    if match and len(match.group("author")) < 60:
        author = match.group("author").strip()
        body = body[: match.start()].strip()
    return {"layout": "quote", "text": _plain(body), "author": author}, index


def _emit_table(deck: _Deck, rows: list[str]) -> None:
    parsed = [
        [cell.strip() for cell in _TABLE_ROW.match(row).group(1).split("|")]
        for row in rows
        if _TABLE_ROW.match(row) and not _TABLE_SEP.match(row)
    ]
    if not parsed:
        return
    header, body = parsed[0], parsed[1:]
    title = None
    if deck.current is not None and deck.current.get("layout") in {"bullets", None} \
            and not deck.current.get("bullets"):
        title = deck.current.get("title")
        deck.current = None
    deck.start({
        "layout": "table",
        "title": title,
        "table": {"type": "table", "header": header, "rows": body, "style": "clean"},
    })
    deck.flush()


def _emit_code(deck: _Deck, buffer: list[str], language: str) -> None:
    if not buffer:
        return
    slide = deck.body()
    # With bullets already on the slide the code goes underneath them; on an
    # otherwise empty slide it gets the whole content area.
    frame = {"area": "bottom"} if slide.get("bullets") else None
    slide.setdefault("elements", []).append({
        "type": "text",
        "text": "\n".join(buffer),
        "font": "Consolas",
        "fill": "F4F4F2",
        "padding_cm": 0.4,
        "font_size_pt": 12,
        "autofit": True,
        "frame": frame,
    })
