# SPDX-License-Identifier: MIT
"""Markdown and HTML to document blocks.

Models write prose in Markdown naturally, so accepting it directly removes a
whole class of transcription work. The output is ordinary :mod:`spec` blocks,
which means Markdown content goes through exactly the same builder — and picks
up the same theme — as everything else.
"""

from __future__ import annotations

import re
from typing import Any

from ..errors import InvalidSpec
from . import spec as S

_HEADING_TAG = re.compile(r"^h([1-6])$", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------


def _parser():
    from markdown_it import MarkdownIt

    return MarkdownIt("commonmark").enable(["table", "strikethrough"])


def markdown_to_blocks(text: str, heading_offset: int = 0) -> list[S.Block]:
    if not (text or "").strip():
        return []
    tokens = _parser().parse(text)
    blocks: list[S.Block] = []
    index = 0
    while index < len(tokens):
        index = _consume(tokens, index, blocks, heading_offset)
    return blocks


def _consume(tokens, index: int, blocks: list, heading_offset: int) -> int:
    token = tokens[index]
    kind = token.type

    if kind == "heading_open":
        level = int(token.tag[1]) + heading_offset
        inline = tokens[index + 1] if index + 1 < len(tokens) else None
        runs = _inline_runs(inline) if inline is not None and inline.type == "inline" else []
        blocks.append(
            S.HeadingBlock(type="heading", level=max(0, min(9, level)), runs=runs)
        )
        return _skip_to(tokens, index, "heading_close")

    if kind == "paragraph_open":
        inline = tokens[index + 1] if index + 1 < len(tokens) else None
        if inline is not None and inline.type == "inline":
            image = _lone_image(inline)
            if image is not None:
                blocks.append(image)
            else:
                runs = _inline_runs(inline)
                if runs:
                    blocks.append(S.ParagraphBlock(type="paragraph", runs=runs))
        return _skip_to(tokens, index, "paragraph_close")

    if kind in {"fence", "code_block"}:
        blocks.append(
            S.CodeBlock(type="code", text=token.content.rstrip("\n"), language=(token.info or "").strip() or None)
        )
        return index + 1

    if kind == "hr":
        blocks.append(S.RuleBlock(type="hr"))
        return index + 1

    if kind in {"bullet_list_open", "ordered_list_open"}:
        items, next_index = _parse_list(tokens, index, kind.startswith("ordered"))
        if items:
            blocks.append(
                S.ListBlock(type="list", ordered=kind.startswith("ordered"), items=items)
            )
        return next_index

    if kind == "blockquote_open":
        text_parts: list[str] = []
        cursor = index + 1
        depth = 1
        while cursor < len(tokens):
            inner = tokens[cursor]
            if inner.type == "blockquote_open":
                depth += 1
            elif inner.type == "blockquote_close":
                depth -= 1
                if depth == 0:
                    break
            elif inner.type == "inline":
                text_parts.append(inner.content)
            cursor += 1
        blocks.append(S.QuoteBlock(type="quote", text="\n".join(text_parts).strip()))
        return cursor + 1

    if kind == "table_open":
        table, next_index = _parse_table(tokens, index)
        if table is not None:
            blocks.append(table)
        return next_index

    if kind == "html_block":
        # Raw HTML embedded in Markdown: reuse the HTML converter rather than
        # silently dropping the block's entire content.
        blocks.extend(html_to_blocks(token.content, heading_offset))
        return index + 1

    return index + 1


def _skip_to(tokens, index: int, closing: str) -> int:
    cursor = index + 1
    while cursor < len(tokens) and tokens[cursor].type != closing:
        cursor += 1
    return cursor + 1


def _parse_list(tokens, index: int, ordered: bool) -> tuple[list[S.ListItemSpec], int]:
    items: list[S.ListItemSpec] = []
    cursor = index + 1
    while cursor < len(tokens):
        token = tokens[cursor]
        if token.type in {"bullet_list_open", "ordered_list_open"}:
            nested, cursor = _parse_list(tokens, cursor, token.type.startswith("ordered"))
            items.extend(
                S.ListItemSpec(text=item.text, runs=item.runs, level=min(4, item.level + 1))
                for item in nested
            )
            continue
        if token.type in {"bullet_list_close", "ordered_list_close"}:
            return items, cursor + 1
        if token.type == "inline":
            runs = _inline_runs(token)
            if runs:
                items.append(S.ListItemSpec(runs=runs))
        cursor += 1
    return items, cursor


def _parse_table(tokens, index: int) -> tuple[S.TableBlock | None, int]:
    header: list[Any] = []
    rows: list[list[Any]] = []
    current: list[Any] | None = None
    in_header = False
    cursor = index + 1

    while cursor < len(tokens):
        token = tokens[cursor]
        if token.type == "table_close":
            cursor += 1
            break
        if token.type == "thead_open":
            in_header = True
        elif token.type == "thead_close":
            in_header = False
        elif token.type == "tr_open":
            current = []
        elif token.type == "tr_close":
            if current is not None:
                (header.extend(current) if in_header and not header else rows.append(current))
            current = None
        elif token.type == "inline" and current is not None:
            runs = _inline_runs(token)
            current.append(
                S.CellSpec(runs=runs) if len(runs) > 1 or (runs and _is_formatted(runs[0]))
                else (runs[0].text if runs else "")
            )
        cursor += 1

    if not header and not rows:
        return None, cursor
    return S.TableBlock(type="table", header=header or None, rows=rows), cursor


def _is_formatted(run: S.RunSpec) -> bool:
    return bool(run.bold or run.italic or run.strike or run.code or run.link or run.color)


def _lone_image(inline) -> S.ImageBlock | None:
    """A paragraph that is nothing but an image becomes an image block."""
    children = [c for c in (inline.children or []) if not (c.type == "text" and not c.content.strip())]
    if len(children) == 1 and children[0].type == "image":
        token = children[0]
        source = token.attrGet("src") or ""
        alt = "".join(child.content for child in (token.children or []))
        return S.ImageBlock(
            type="image", source=source, caption=(token.attrGet("title") or None), alt_text=alt or None
        )
    return None


def _inline_runs(inline) -> list[S.RunSpec]:
    runs: list[S.RunSpec] = []
    state: dict[str, Any] = {"bold": None, "italic": None, "strike": None, "link": None}

    def emit(text: str, **overrides: Any) -> None:
        if not text:
            return
        runs.append(S.RunSpec(text=text, **{**state, **overrides}))

    for token in inline.children or []:
        kind = token.type
        if kind == "text":
            emit(token.content)
        elif kind == "code_inline":
            emit(token.content, code=True)
        elif kind == "strong_open":
            state["bold"] = True
        elif kind == "strong_close":
            state["bold"] = None
        elif kind == "em_open":
            state["italic"] = True
        elif kind == "em_close":
            state["italic"] = None
        elif kind == "s_open":
            state["strike"] = True
        elif kind == "s_close":
            state["strike"] = None
        elif kind == "link_open":
            state["link"] = token.attrGet("href")
        elif kind == "link_close":
            state["link"] = None
        elif kind in {"softbreak", "hardbreak"}:
            emit(" " if kind == "softbreak" else "\n")
        elif kind == "image":
            alt = "".join(child.content for child in (token.children or []))
            emit(alt or "[image]", italic=True)
    return [run for run in runs if run.text]


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

_BLOCK_HANDLERS_DOC = "h1-h6, p, ul, ol, table, pre, blockquote, hr, img, div, section"


def html_to_blocks(html: str, heading_offset: int = 0) -> list[S.Block]:
    if not (html or "").strip():
        return []
    from lxml import html as lxml_html

    try:
        root = lxml_html.fragment_fromstring(html, create_parent="div")
    except Exception as exc:
        raise InvalidSpec(f"Could not parse the HTML: {exc}") from exc
    blocks: list[S.Block] = []
    # The synthetic parent is a container like any other, and has to be treated
    # as one: descending straight into its children drops its own text, so
    # "hello <b>world</b>" kept only "world" and "plain text only" produced
    # nothing at all.
    _walk_container(root, blocks, heading_offset)
    return blocks


def _walk_container(element, blocks: list, heading_offset: int) -> None:
    """Walk a container, or treat it as a paragraph when it holds only inline content."""
    children = {str(inner.tag).lower() for inner in element if isinstance(inner.tag, str)}
    if children & _CONTAINER_BLOCK_TAGS:
        _walk_html(element, blocks, heading_offset)
        return
    # Only inline content: recursing would drop the container's own text
    # ("<div>a <b>c</b> d</div>" kept just "c"). It is a paragraph in all but name.
    runs = _html_runs(element)
    if runs:
        blocks.append(S.ParagraphBlock(type="paragraph", runs=runs))


def _loose_text(text: str | None, blocks: list) -> None:
    """Emit text that sits between block elements rather than inside one.

    lxml hangs it off the surrounding elements as ``.text`` and ``.tail``, where
    it is easy to walk straight past — which is how "<p>a</p>tail" used to lose
    its tail. Whitespace between tags is not content, so only a non-blank string
    becomes a paragraph.
    """
    if text and text.strip():
        blocks.append(S.ParagraphBlock(type="paragraph", text=text.strip()))


def _walk_html(element, blocks: list, heading_offset: int) -> None:
    # The container's own text, before its first child element.
    _loose_text(element.text, blocks)
    for child in element:
        tag = str(child.tag).lower() if isinstance(child.tag, str) else ""
        heading = _HEADING_TAG.match(tag)

        if heading:
            level = int(heading.group(1)) + heading_offset
            blocks.append(
                S.HeadingBlock(type="heading", level=max(0, min(9, level)), runs=_html_runs(child))
            )
        elif tag == "p":
            runs = _html_runs(child)
            if runs:
                blocks.append(S.ParagraphBlock(type="paragraph", runs=runs))
        elif tag in {"ul", "ol"}:
            items = _html_list_items(child, 0)
            if items:
                blocks.append(S.ListBlock(type="list", ordered=tag == "ol", items=items))
        elif tag == "table":
            table = _html_table(child)
            if table is not None:
                blocks.append(table)
        elif tag == "pre":
            blocks.append(S.CodeBlock(type="code", text=child.text_content().rstrip("\n")))
        elif tag == "blockquote":
            blocks.append(S.QuoteBlock(type="quote", text=child.text_content().strip()))
        elif tag == "hr":
            blocks.append(S.RuleBlock(type="hr"))
        elif tag == "img":
            source = child.get("src") or ""
            if source:
                blocks.append(
                    S.ImageBlock(type="image", source=source, alt_text=child.get("alt") or None)
                )
        elif tag in {"div", "section", "article", "main", "body", "header", "footer"}:
            _walk_container(child, blocks, heading_offset)
        elif tag == "br":
            pass
        else:
            text = (child.text_content() or "").strip()
            if text:
                blocks.append(S.ParagraphBlock(type="paragraph", text=text))

        # Text sitting after this child but still inside the container.
        _loose_text(child.tail, blocks)


#: Tags that make a div/section a true container to flatten, rather than an
#: inline wrapper to read as one paragraph.
_CONTAINER_BLOCK_TAGS = {
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table", "pre",
    "blockquote", "hr", "img", "div", "section", "article", "main", "body",
    "header", "footer",
}

_INLINE_MARKS = {
    "b": {"bold": True}, "strong": {"bold": True},
    "i": {"italic": True}, "em": {"italic": True},
    "u": {"underline": True},
    "s": {"strike": True}, "del": {"strike": True}, "strike": {"strike": True},
    "code": {"code": True}, "kbd": {"code": True}, "samp": {"code": True},
    "sup": {"superscript": True}, "sub": {"subscript": True},
    "mark": {"highlight": "yellow"},
}


def _html_runs(element, inherited: dict | None = None) -> list[S.RunSpec]:
    runs: list[S.RunSpec] = []
    base = dict(inherited or {})

    if element.text and element.text.strip():
        runs.append(S.RunSpec(text=element.text, **base))

    for child in element:
        tag = str(child.tag).lower() if isinstance(child.tag, str) else ""
        style = dict(base)
        style.update(_INLINE_MARKS.get(tag, {}))
        if tag == "a" and child.get("href"):
            style["link"] = child.get("href")
        if tag == "br":
            runs.append(S.RunSpec(text="\n", **base))
        else:
            runs.extend(_html_runs(child, style))
        if child.tail and child.tail.strip():
            runs.append(S.RunSpec(text=child.tail, **base))

    return [run for run in runs if run.text]


def _html_list_items(element, level: int) -> list[S.ListItemSpec]:
    items: list[S.ListItemSpec] = []
    for item in element:
        if str(item.tag).lower() != "li":
            continue
        nested = [c for c in item if str(c.tag).lower() in {"ul", "ol"}]
        for sub in nested:
            item.remove(sub)
        runs = _html_runs(item)
        if runs:
            items.append(S.ListItemSpec(runs=runs, level=min(4, level)))
        for sub in nested:
            items.extend(_html_list_items(sub, level + 1))
    return items


def _html_table(element) -> S.TableBlock | None:
    header: list[Any] = []
    rows: list[list[Any]] = []
    for row in element.iter("tr"):
        cells = [c for c in row if str(c.tag).lower() in {"td", "th"}]
        if not cells:
            continue
        values = [(cell.text_content() or "").strip() for cell in cells]
        if not header and all(str(c.tag).lower() == "th" for c in cells):
            header = values
        else:
            rows.append(values)
    if not header and not rows:
        return None
    return S.TableBlock(type="table", header=header or None, rows=rows)
