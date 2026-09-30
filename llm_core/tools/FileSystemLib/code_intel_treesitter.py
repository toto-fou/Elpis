# SPDX-License-Identifier: MIT
# tools/FileSystemLib/code_intel_treesitter.py
"""
Optional tree-sitter backend for code_intel — used for JavaScript/TypeScript,
Bash and Robot Framework parsing when the libraries are installed. Falls back
gracefully (caller checks HAS_TREESITTER and per-language flags before using).

Install (all optional, per-language):
    pip install tree-sitter \\
                tree-sitter-javascript \\
                tree-sitter-typescript \\
                tree-sitter-bash \\
                tree-sitter-robot

Per-language flags exposed:
    HAS_TREESITTER     : bool — True if at least the core `tree-sitter` lib is
                          importable (some languages may still be missing).
    HAS_TS_JS / HAS_TS_TS / HAS_TS_BASH / HAS_TS_ROBOT
                       : bool — True iff that specific grammar is available.

Public API:
    outline_jsts(text, lang_key, max_depth) -> List[dict]
        lang_key in {"javascript", "typescript", "tsx"}
    references_jsts(text, lang_key, name, max_results) -> List[dict]
    outline_bash(text, max_depth) -> List[dict]
    references_bash(text, name, max_results) -> List[dict]
    outline_robot(text, max_depth) -> List[dict]
    references_robot(text, name, max_results) -> List[dict]

Each backend returns [] if its grammar isn't available (caller falls back
to the regex/custom parser in code_intel.py).
"""
from __future__ import annotations

from typing import Any, Dict, List

HAS_TREESITTER = False
HAS_TS_JS = False
HAS_TS_TS = False
HAS_TS_BASH = False
HAS_TS_ROBOT = False

_PARSERS: Dict[str, Any] = {}
_LANGUAGES: Dict[str, Any] = {}

try:
    from tree_sitter import Language, Parser
    HAS_TREESITTER = True
except Exception:
    HAS_TREESITTER = False
    Language = None  # type: ignore
    Parser = None  # type: ignore


def _try_load(lang_key: str, importer):
    """Best-effort grammar load — returns True iff parser is now available."""
    if not HAS_TREESITTER:
        return False
    try:
        lang_obj = importer()
        _LANGUAGES[lang_key] = Language(lang_obj)
        _PARSERS[lang_key] = Parser(_LANGUAGES[lang_key])
        return True
    except Exception:
        return False


if HAS_TREESITTER:
    try:
        import tree_sitter_javascript as _ts_js
        HAS_TS_JS = _try_load("javascript", _ts_js.language)
    except Exception:
        HAS_TS_JS = False

    try:
        import tree_sitter_typescript as _ts_typescript
        HAS_TS_TS = (_try_load("typescript", _ts_typescript.language_typescript)
                     and _try_load("tsx", _ts_typescript.language_tsx))
    except Exception:
        HAS_TS_TS = False

    try:
        import tree_sitter_bash as _ts_bash
        HAS_TS_BASH = _try_load("bash", _ts_bash.language)
    except Exception:
        HAS_TS_BASH = False

    try:
        import tree_sitter_robot as _ts_robot
        HAS_TS_ROBOT = _try_load("robot", _ts_robot.language)
    except Exception:
        HAS_TS_ROBOT = False


# ── Generic helpers ─────────────────────────────────────────────────────────
def _node_text(node, src: bytes) -> str:
    return src[node.start_byte:node.end_byte].decode("utf-8", errors="replace")


def _line(node) -> int:
    return node.start_point[0] + 1


def _end_line(node) -> int:
    return node.end_point[0] + 1


def _find_child(node, type_name: str):
    for c in node.children:
        if c.type == type_name:
            return c
    return None


def _find_field(node, field_name: str):
    return node.child_by_field_name(field_name)


def _dedupe_by_line(items: List[Dict[str, Any]], cap: int) -> List[Dict[str, Any]]:
    seen, out = set(), []
    for it in items:
        if it["line"] in seen:
            continue
        seen.add(it["line"])
        out.append(it)
        if len(out) >= cap:
            break
    return out


# ════════════════════════════════════════════════════════════════════════════
# JavaScript / TypeScript
# ════════════════════════════════════════════════════════════════════════════
def _is_test_call_name(name: str) -> bool:
    return name in ("describe", "it", "test", "context", "suite",
                    "beforeEach", "afterEach", "beforeAll", "afterAll")


def _walk_outline_jsts(node, src: bytes, depth: int, max_depth: int,
                       out: List[Dict[str, Any]]) -> None:
    if depth > max_depth:
        return
    nt = node.type

    if nt == "import_statement":
        out.append({
            "kind": "import",
            "name": _node_text(node, src).strip().rstrip(";")[:160],
            "line": _line(node), "end_line": _end_line(node),
        })
        return

    if nt == "export_statement":
        for c in node.children:
            _walk_outline_jsts(c, src, depth, max_depth, out)
        return

    if nt in ("class_declaration", "abstract_class_declaration"):
        name_node = _find_field(node, "name") or _find_child(node, "type_identifier") \
                    or _find_child(node, "identifier")
        body = _find_field(node, "body") or _find_child(node, "class_body")
        children: List[Dict[str, Any]] = []
        if body:
            for c in body.children:
                if c.type in ("method_definition", "method_signature",
                              "abstract_method_signature"):
                    mn = _find_field(c, "name") or _find_child(c, "property_identifier")
                    children.append({
                        "kind": "method",
                        "name": _node_text(mn, src) if mn else "?",
                        "line": _line(c), "end_line": _end_line(c),
                    })
                elif c.type in ("public_field_definition", "field_definition"):
                    nn = _find_field(c, "name") or _find_child(c, "property_identifier")
                    if nn:
                        children.append({
                            "kind": "field",
                            "name": _node_text(nn, src),
                            "line": _line(c), "end_line": _end_line(c),
                        })
        out.append({
            "kind": "class",
            "name": _node_text(name_node, src) if name_node else "?",
            "line": _line(node), "end_line": _end_line(node),
            "children": children,
        })
        return

    if nt == "function_declaration":
        name_node = _find_field(node, "name") or _find_child(node, "identifier")
        out.append({
            "kind": "function",
            "name": _node_text(name_node, src) if name_node else "?",
            "line": _line(node), "end_line": _end_line(node),
        })
        return

    if nt in ("lexical_declaration", "variable_declaration"):
        for decl in node.children:
            if decl.type != "variable_declarator":
                continue
            name_node = _find_field(decl, "name") or _find_child(decl, "identifier")
            value = _find_field(decl, "value")
            if value and value.type in ("arrow_function", "function_expression",
                                        "function"):
                out.append({
                    "kind": "function",
                    "name": _node_text(name_node, src) if name_node else "?",
                    "line": _line(node), "end_line": _end_line(node),
                })
        return

    if nt == "expression_statement":
        inner = node.children[0] if node.children else None
        if inner and inner.type == "call_expression":
            fn = _find_field(inner, "function") or _find_child(inner, "identifier")
            if fn:
                fn_name = _node_text(fn, src)
                if _is_test_call_name(fn_name):
                    args = _find_field(inner, "arguments")
                    label = ""
                    if args:
                        for a in args.children:
                            if a.type == "string":
                                label = _node_text(a, src).strip("'\"`")
                                break
                    children: List[Dict[str, Any]] = []
                    if args:
                        for a in args.children:
                            if a.type in ("arrow_function", "function_expression",
                                          "function"):
                                body = _find_field(a, "body") or a
                                _walk_outline_jsts(body, src, depth + 1, max_depth, children)
                    out.append({
                        "kind": "test",
                        "name": f"{fn_name}({label})" if label else fn_name,
                        "line": _line(node), "end_line": _end_line(node),
                        "children": children,
                    })
                    return

    if nt in ("program", "statement_block", "lexical_declaration", "module"):
        for c in node.children:
            _walk_outline_jsts(c, src, depth + 1, max_depth, out)


def outline_jsts(text: str, lang_key: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    parser = _PARSERS.get(lang_key) or _PARSERS.get("typescript") or _PARSERS.get("javascript")
    if not parser:
        return []
    try:
        src = text.encode("utf-8")
        tree = parser.parse(src)
        out: List[Dict[str, Any]] = []
        _walk_outline_jsts(tree.root_node, src, 0, max_depth, out)
        return out
    except Exception:
        return []


def references_jsts(text: str, lang_key: str, name: str,
                    max_results: int = 200) -> List[Dict[str, Any]]:
    parser = _PARSERS.get(lang_key) or _PARSERS.get("typescript") or _PARSERS.get("javascript")
    if not parser or not name:
        return []
    try:
        src = text.encode("utf-8")
        tree = parser.parse(src)
    except Exception:
        return []
    name_b = name.encode("utf-8")
    ID_TYPES = {
        "identifier", "property_identifier", "type_identifier",
        "shorthand_property_identifier", "shorthand_property_identifier_pattern",
    }
    found: List[Dict[str, Any]] = []
    lines = text.splitlines()

    def _walk(n):
        if len(found) >= max_results:
            return
        if n.type in ID_TYPES:
            if src[n.start_byte:n.end_byte] == name_b:
                ln = n.start_point[0]
                if ln < len(lines):
                    found.append({
                        "line": ln + 1,
                        "text": lines[ln][:200].rstrip(),
                    })
            return
        for c in n.children:
            _walk(c)

    _walk(tree.root_node)
    return _dedupe_by_line(found, max_results)


# ════════════════════════════════════════════════════════════════════════════
# Bash
# ════════════════════════════════════════════════════════════════════════════
def _walk_outline_bash(node, src: bytes, depth: int, max_depth: int,
                       out: List[Dict[str, Any]]) -> None:
    if depth > max_depth:
        return
    nt = node.type

    if nt == "function_definition":
        name_node = _find_field(node, "name") or _find_child(node, "word")
        out.append({
            "kind": "function",
            "name": _node_text(name_node, src) if name_node else "?",
            "line": _line(node), "end_line": _end_line(node),
        })
        return

    # `readonly FOO=bar` / `export FOO=bar` / `declare -r FOO=bar`
    if nt == "declaration_command":
        first = node.children[0] if node.children else None
        kind_word = _node_text(first, src) if first else ""
        if kind_word in ("readonly", "export", "declare"):
            for c in node.children:
                if c.type == "variable_assignment":
                    nm = _find_field(c, "name") or _find_child(c, "variable_name")
                    if nm:
                        out.append({
                            "kind": "var",
                            "name": _node_text(nm, src),
                            "line": _line(c), "end_line": _end_line(c),
                            "scope": kind_word,
                        })
            return

    if nt == "program":
        for c in node.children:
            _walk_outline_bash(c, src, depth + 1, max_depth, out)


def outline_bash(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    parser = _PARSERS.get("bash")
    if not parser:
        return []
    try:
        src = text.encode("utf-8")
        tree = parser.parse(src)
        out: List[Dict[str, Any]] = []
        _walk_outline_bash(tree.root_node, src, 0, max_depth, out)
        return out
    except Exception:
        return []


def references_bash(text: str, name: str,
                    max_results: int = 200) -> List[Dict[str, Any]]:
    """Find `name` as: variable name (in expansions/assignments), function
    name (in command names and function definitions), or word identifier.
    Excludes occurrences inside string contents and comments."""
    parser = _PARSERS.get("bash")
    if not parser or not name:
        return []
    try:
        src = text.encode("utf-8")
        tree = parser.parse(src)
    except Exception:
        return []
    name_b = name.encode("utf-8")
    ID_TYPES = {"variable_name", "word", "command_name"}
    OPAQUE_TYPES = {"comment", "string_content", "heredoc_body",
                    "raw_string", "ansi_c_string"}
    found: List[Dict[str, Any]] = []
    lines = text.splitlines()

    def _walk(n):
        if len(found) >= max_results:
            return
        if n.type in OPAQUE_TYPES:
            return
        if n.type in ID_TYPES:
            if src[n.start_byte:n.end_byte] == name_b:
                ln = n.start_point[0]
                if ln < len(lines):
                    found.append({"line": ln + 1, "text": lines[ln][:200].rstrip()})
            return
        for c in n.children:
            _walk(c)

    _walk(tree.root_node)
    return _dedupe_by_line(found, max_results)


# ════════════════════════════════════════════════════════════════════════════
# Robot Framework
# ════════════════════════════════════════════════════════════════════════════
def _normalize_kw(name: str) -> str:
    """Robot keyword-name normalization: case-insensitive, treat _ and space
    as equivalent. Used for matching keyword usages to definitions."""
    return name.lower().replace("_", " ").replace("-", " ").strip()


def _walk_outline_robot(node, src: bytes, depth: int, max_depth: int,
                        out: List[Dict[str, Any]]) -> None:
    if depth > max_depth:
        return
    nt = node.type

    if nt in ("source_file", "section"):
        for c in node.children:
            _walk_outline_robot(c, src, depth + 1, max_depth, out)
        return

    if nt == "settings_section":
        for c in node.children:
            if c.type == "setting_statement":
                name_node = _find_field(c, "name") or _find_child(c, "setting_name")
                if name_node:
                    nm = _node_text(name_node, src)
                    args_node = _find_child(c, "arguments")
                    first_arg = ""
                    if args_node:
                        for a in args_node.children:
                            if a.type == "argument":
                                first_arg = _node_text(a, src)
                                break
                    out.append({
                        "kind": "setting",
                        "name": f"{nm}: {first_arg}" if first_arg else nm,
                        "line": _line(c), "end_line": _end_line(c),
                    })
        return

    if nt == "variables_section":
        for c in node.children:
            if c.type == "variable_definition":
                vn = _find_child(c, "variable_name")
                if vn:
                    out.append({
                        "kind": "var",
                        "name": _node_text(vn, src),
                        "line": _line(c), "end_line": _end_line(c),
                    })
        return

    if nt == "test_cases_section":
        for c in node.children:
            if c.type == "test_case_definition":
                name_node = _find_field(c, "name") or _find_child(c, "name")
                tags: List[str] = []
                body = _find_field(c, "body") or _find_child(c, "body")
                if body:
                    for b in body.children:
                        if b.type == "test_case_setting":
                            sn = _find_child(b, "test_case_setting_name")
                            if sn and _node_text(sn, src) == "Tags":
                                args = _find_child(b, "arguments")
                                if args:
                                    for a in args.children:
                                        if a.type == "argument":
                                            tags.append(_node_text(a, src))
                entry: Dict[str, Any] = {
                    "kind": "test",
                    "name": _node_text(name_node, src) if name_node else "?",
                    "line": _line(c), "end_line": _end_line(c),
                }
                if tags:
                    entry["tags"] = tags
                out.append(entry)
        return

    if nt == "keywords_section":
        for c in node.children:
            if c.type == "keyword_definition":
                name_node = _find_field(c, "name") or _find_child(c, "name")
                args_sig: List[str] = []
                body = _find_field(c, "body") or _find_child(c, "body")
                if body:
                    for b in body.children:
                        if b.type == "keyword_setting":
                            sn = _find_child(b, "keyword_setting_name")
                            if sn and _node_text(sn, src) == "Arguments":
                                args = _find_child(b, "arguments")
                                if args:
                                    for a in args.children:
                                        if a.type == "argument":
                                            args_sig.append(_node_text(a, src))
                entry = {
                    "kind": "keyword",
                    "name": _node_text(name_node, src) if name_node else "?",
                    "line": _line(c), "end_line": _end_line(c),
                }
                if args_sig:
                    entry["args"] = args_sig
                out.append(entry)
        return


def outline_robot(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    parser = _PARSERS.get("robot")
    if not parser:
        return []
    try:
        src = text.encode("utf-8")
        tree = parser.parse(src)
        out: List[Dict[str, Any]] = []
        _walk_outline_robot(tree.root_node, src, 0, max_depth, out)
        return out
    except Exception:
        return []


def references_robot(text: str, name: str,
                     max_results: int = 200) -> List[Dict[str, Any]]:
    """Find Robot keyword/variable references.

    Robot identifier matching is case-insensitive AND treats underscores +
    spaces as equivalent (so `Setup_System` == `Setup System` == `setup system`).

    Recognized as references:
      - keyword_invocation > keyword (the name node)
      - keyword_definition > name (the definition itself)
      - variable_definition > variable_name
      - scalar_variable / variable_name within arguments
    """
    parser = _PARSERS.get("robot")
    if not parser or not name:
        return []
    try:
        src = text.encode("utf-8")
        tree = parser.parse(src)
    except Exception:
        return []
    target = _normalize_kw(name)
    found: List[Dict[str, Any]] = []
    lines = text.splitlines()
    ID_TYPES = {"keyword", "name", "variable_name", "scalar_variable"}

    def _walk(n):
        if len(found) >= max_results:
            return
        if n.type in ID_TYPES:
            txt = _node_text(n, src)
            stripped = txt
            if stripped.startswith(("${", "@{", "&{")) and stripped.endswith("}"):
                stripped = stripped[2:-1]
            if _normalize_kw(stripped) == target:
                ln = n.start_point[0]
                if ln < len(lines):
                    found.append({
                        "line": ln + 1,
                        "text": lines[ln][:200].rstrip(),
                    })
            return
        for c in n.children:
            _walk(c)

    _walk(tree.root_node)
    return _dedupe_by_line(found, max_results)
