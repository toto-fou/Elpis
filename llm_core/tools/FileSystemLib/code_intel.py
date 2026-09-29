# SPDX-License-Identifier: MIT
# tools/code_intel.py
"""
code_intel — Multi-language code intelligence helpers (parsers + outliners).

Standalone module imported by fs_tools.py. Pure stdlib + optional PyYAML
(graceful degradation if missing). No tree-sitter dependency to keep deploy
trivial.

Supported languages (auto-detected by extension):
    .py                 → Python AST (full fidelity)
    .js / .mjs / .cjs   → JavaScript (regex + brace counter)
    .ts / .tsx / .jsx   → TypeScript / TSX / JSX (regex)
    .robot / .resource  → Robot Framework (line-based parser)
    .sh / .bash         → Bash (regex)
    .yaml / .yml        → YAML / Ansible playbooks/roles (PyYAML if available)
    .json               → JSON (top-level structure summary)
    .md / .markdown     → Markdown (heading tree)

Public API:
    detect_language(path) -> str         # canonical lang key or 'unknown'
    outline(text, lang, max_depth=4)     # hierarchical structure
    list_symbols(text, lang)             # flat list with line numbers
    find_definition(text, lang, name)    # locate where a symbol is defined
    find_references(text, lang, name)    # locate usages (best-effort)
    summarize_structure(text, lang)      # one-paragraph summary

Each `outline` returns a list of dicts:
    {
        "kind":     "function" | "class" | "method" | "test" | "keyword" |
                    "task" | "handler" | "var" | "import" | "section" | ...
        "name":     str,
        "line":     int (1-based),
        "end_line": int (best-effort),
        "signature": str (optional, lang-dependent),
        "docstring": str (optional),
        "children": [ ... recursive ... ],
    }
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import yaml as _yaml  # type: ignore
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False

# Optional tree-sitter backend (graceful degradation per-language).
try:
    from . import code_intel_treesitter as _ts_backend
    _HAS_TS = bool(_ts_backend.HAS_TREESITTER)
except Exception:
    _HAS_TS = False
    _ts_backend = None  # type: ignore


# ── Language detection ───────────────────────────────────────────────────────

_EXT_TO_LANG = {
    ".py":       "python",
    ".pyw":      "python",
    ".js":       "javascript",
    ".mjs":      "javascript",
    ".cjs":      "javascript",
    ".jsx":      "javascript",
    ".ts":       "typescript",
    ".tsx":      "typescript",
    ".robot":    "robot",
    ".resource": "robot",
    ".sh":       "bash",
    ".bash":     "bash",
    ".zsh":      "bash",
    ".yaml":     "yaml",
    ".yml":      "yaml",
    ".json":     "json",
    ".md":       "markdown",
    ".markdown": "markdown",
}


def detect_language(path: str) -> str:
    """Map a filename to a canonical language key."""
    ext = Path(path).suffix.lower()
    return _EXT_TO_LANG.get(ext, "unknown")


# ── Python (ast) ─────────────────────────────────────────────────────────────

def _outline_python(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """Walk the Python AST and produce a hierarchical outline."""
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return [{
            "kind": "error",
            "name": "syntax_error",
            "line": e.lineno or 1,
            "message": str(e),
        }]

    def _docstring(node: ast.AST) -> str:
        ds = ast.get_docstring(node) if isinstance(
            node, (ast.AsyncFunctionDef, ast.FunctionDef, ast.ClassDef, ast.Module)
        ) else None
        if not ds:
            return ""
        # Compact: first non-empty line, max 120 chars.
        first = next((ln.strip() for ln in ds.splitlines() if ln.strip()), "")
        return first[:120]

    def _signature(node: ast.AST) -> str:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = []
            a = node.args
            for arg in a.args:
                args.append(arg.arg)
            if a.vararg:
                args.append(f"*{a.vararg.arg}")
            for arg in a.kwonlyargs:
                args.append(arg.arg)
            if a.kwarg:
                args.append(f"**{a.kwarg.arg}")
            prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
            return f"{prefix}{node.name}({', '.join(args)})"
        if isinstance(node, ast.ClassDef):
            bases = [ast.unparse(b) if hasattr(ast, "unparse") else getattr(b, "id", "?")
                     for b in node.bases]
            return f"class {node.name}" + (f"({', '.join(bases)})" if bases else "")
        return ""

    def _walk(node: ast.AST, depth: int, parent_kind: str = "") -> List[Dict[str, Any]]:
        if depth > max_depth:
            return []
        out: List[Dict[str, Any]] = []
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kind = "method" if parent_kind == "class" else "function"
                # Test detection: function name starts with test_ (pytest convention)
                if kind == "function" and child.name.startswith("test_"):
                    kind = "test"
                item = {
                    "kind":      kind,
                    "name":      child.name,
                    "line":      child.lineno,
                    "end_line":  getattr(child, "end_lineno", child.lineno),
                    "signature": _signature(child),
                    "docstring": _docstring(child),
                    "decorators": [ast.unparse(d) if hasattr(ast, "unparse") else "?"
                                    for d in child.decorator_list][:5],
                    "children":  _walk(child, depth + 1, kind),
                }
                # Drop empty fields for compactness.
                if not item["docstring"]:    item.pop("docstring")
                if not item["decorators"]:   item.pop("decorators")
                if not item["children"]:     item.pop("children")
                out.append(item)
            elif isinstance(child, ast.ClassDef):
                item = {
                    "kind":      "class",
                    "name":      child.name,
                    "line":      child.lineno,
                    "end_line":  getattr(child, "end_lineno", child.lineno),
                    "signature": _signature(child),
                    "docstring": _docstring(child),
                    "children":  _walk(child, depth + 1, "class"),
                }
                if not item["docstring"]:   item.pop("docstring")
                if not item["children"]:    item.pop("children")
                out.append(item)
            elif isinstance(child, (ast.Import, ast.ImportFrom)):
                if depth == 0:  # only top-level imports
                    if isinstance(child, ast.Import):
                        names = ", ".join(a.name for a in child.names)
                        out.append({"kind": "import", "name": names, "line": child.lineno})
                    else:
                        mod = child.module or ""
                        names = ", ".join(a.name for a in child.names)
                        out.append({"kind": "import",
                                    "name": f"from {mod} import {names}",
                                    "line": child.lineno})
            elif isinstance(child, ast.Assign) and depth == 0:
                # Top-level constants (UPPERCASE names) only
                for tgt in child.targets:
                    if isinstance(tgt, ast.Name) and tgt.id.isupper() and len(tgt.id) > 1:
                        out.append({"kind": "constant", "name": tgt.id, "line": child.lineno})
        return out

    return _walk(tree, 0)


# ── JavaScript / TypeScript (regex-based) ───────────────────────────────────
#
# Regex parsing is imperfect but covers the common patterns. The trade-off is
# zero dependency: no tree-sitter, no node, no esprima.
#
# Patterns we DON'T handle (acceptable misses):
#   - functions defined in object literals beyond top-level
#   - dynamic patterns like obj['name'] = function()
#   - JSX components defined as nested arrow chains
#   - exotic decorators
#
# Patterns we DO handle:
#   - function declarations, async functions, generators
#   - class declarations with methods, getters, setters
#   - top-level const/let/var = function|arrow|class
#   - export {default,named}
#   - import statements
#   - module.exports = ...
#   - test framework: describe()/it()/test() blocks (top-level)

_JS_FUNC_RE = re.compile(
    r"^[ \t]*(?P<exp>export\s+(?:default\s+)?)?"
    r"(?P<async>async\s+)?function(?P<gen>\s*\*)?\s+(?P<name>[A-Za-z_$][\w$]*)\s*\("
    r"(?P<args>[^)]*)\)",
    re.MULTILINE,
)
_JS_ARROW_RE = re.compile(
    r"^[ \t]*(?P<exp>export\s+(?:default\s+)?)?"
    r"(?:const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)\s*"
    r"(?::\s*[^=]+?)?"  # optional TS type annotation
    r"=\s*(?P<async>async\s+)?(?:\((?P<args>[^)]*)\)|(?P<arg1>[A-Za-z_$][\w$]*))\s*=>",
    re.MULTILINE,
)
_JS_CLASS_RE = re.compile(
    r"^[ \t]*(?P<exp>export\s+(?:default\s+)?)?"
    r"(?:abstract\s+)?class\s+(?P<name>[A-Za-z_$][\w$]*)"
    r"(?:\s+extends\s+(?P<base>[A-Za-z_$][\w$.]*))?",
    re.MULTILINE,
)
_JS_IMPORT_RE = re.compile(
    r"^[ \t]*(?:import\s+.+?from\s+['\"](?P<mod>[^'\"]+)['\"]"
    r"|import\s+['\"](?P<mod2>[^'\"]+)['\"]"
    r"|const\s+.+?=\s*require\(['\"](?P<mod3>[^'\"]+)['\"]\))",
    re.MULTILINE,
)
_JS_TEST_RE = re.compile(
    r"^[ \t]*(?P<kind>describe|it|test)\s*\(\s*['\"`](?P<name>[^'\"`]+)['\"`]",
    re.MULTILINE,
)


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _find_block_end(text: str, brace_pos: int) -> int:
    """Given the position of an opening `{`, return the line of its matching `}`.
    Best-effort: skips strings + line comments + block comments."""
    n = len(text)
    if brace_pos >= n or text[brace_pos] != "{":
        return _line_of(text, brace_pos)
    depth = 0
    i = brace_pos
    in_str = None  # holds the quote char if inside a string
    in_block_comment = False
    in_line_comment = False
    while i < n:
        c = text[i]
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1; continue
        if in_block_comment:
            if c == "*" and i + 1 < n and text[i+1] == "/":
                in_block_comment = False; i += 2; continue
            i += 1; continue
        if in_str:
            if c == "\\":
                i += 2; continue
            if c == in_str:
                in_str = None
            elif c == "\n" and in_str != "`":
                in_str = None  # unterminated single-line — bail out
            i += 1; continue
        # Not in any context.
        if c == "/" and i + 1 < n:
            n2 = text[i+1]
            if n2 == "/":
                in_line_comment = True; i += 2; continue
            if n2 == "*":
                in_block_comment = True; i += 2; continue
        if c in ('"', "'", "`"):
            in_str = c
            i += 1; continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return _line_of(text, i)
        i += 1
    return _line_of(text, brace_pos)  # never closed — fallback


def _outline_javascript(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """Regex-based JS/TS outliner. Top-level + class methods."""
    items: List[Dict[str, Any]] = []
    seen_lines: set = set()  # dedupe overlapping matches

    # Imports (top-level only — first 50 lines)
    head = "\n".join(text.splitlines()[:80])
    for m in _JS_IMPORT_RE.finditer(head):
        mod = m.group("mod") or m.group("mod2") or m.group("mod3")
        if mod:
            items.append({
                "kind": "import",
                "name": mod,
                "line": _line_of(text, m.start()),
            })

    # Functions (declaration form)
    for m in _JS_FUNC_RE.finditer(text):
        line = _line_of(text, m.start())
        if line in seen_lines:
            continue
        seen_lines.add(line)
        # Find opening brace after the args
        brace = text.find("{", m.end())
        end_line = _find_block_end(text, brace) if brace > 0 else line
        item = {
            "kind":      "function",
            "name":      m.group("name"),
            "line":      line,
            "end_line":  end_line,
            "signature": (
                ("export " if m.group("exp") else "")
                + ("async " if m.group("async") else "")
                + "function" + (m.group("gen") or "")
                + " " + m.group("name") + "(" + (m.group("args") or "").strip() + ")"
            ),
        }
        items.append(item)

    # Arrow functions assigned to const/let/var
    for m in _JS_ARROW_RE.finditer(text):
        line = _line_of(text, m.start())
        if line in seen_lines:
            continue
        seen_lines.add(line)
        # Body might be expression (no brace) or block
        end_line = line
        # Try to find brace within the next 200 chars
        tail = text[m.end():m.end() + 4000]
        brace_off = tail.find("{")
        if 0 <= brace_off <= 4:  # immediately after =>
            end_line = _find_block_end(text, m.end() + brace_off)
        args = m.group("args") if m.group("args") is not None else m.group("arg1") or ""
        item = {
            "kind":      "function",
            "name":      m.group("name"),
            "line":      line,
            "end_line":  end_line,
            "signature": (
                ("export " if m.group("exp") else "")
                + "const " + m.group("name") + " = "
                + ("async " if m.group("async") else "") + "(" + args.strip() + ") => …"
            ),
        }
        items.append(item)

    # Classes (with methods inside)
    for m in _JS_CLASS_RE.finditer(text):
        line = _line_of(text, m.start())
        if line in seen_lines:
            continue
        seen_lines.add(line)
        brace = text.find("{", m.end())
        end_line = _find_block_end(text, brace) if brace > 0 else line
        # Extract methods inside the class body
        body_start = brace + 1 if brace > 0 else m.end()
        # We need to find the position of the closing brace
        body_end_pos = _find_class_body_end_pos(text, brace) if brace > 0 else m.end()
        body = text[body_start:body_end_pos]
        methods = _extract_js_class_methods(body, body_start, text)
        item = {
            "kind":      "class",
            "name":      m.group("name"),
            "line":      line,
            "end_line":  end_line,
            "signature": (
                ("export " if m.group("exp") else "")
                + "class " + m.group("name")
                + (" extends " + m.group("base") if m.group("base") else "")
            ),
        }
        if methods:
            item["children"] = methods
        items.append(item)

    # Test blocks (describe/it/test) — only if no other items captured them
    test_count = 0
    for m in _JS_TEST_RE.finditer(text):
        line = _line_of(text, m.start())
        if line in seen_lines:
            continue
        items.append({
            "kind": m.group("kind"),  # describe/it/test
            "name": m.group("name"),
            "line": line,
        })
        test_count += 1
        if test_count >= 200:
            break

    items.sort(key=lambda x: x["line"])
    return items


_JS_METHOD_RE = re.compile(
    r"^[ \t]*(?P<async>async\s+)?(?P<gs>get\s+|set\s+)?"
    r"(?P<gen>\*\s*)?(?P<name>[A-Za-z_$#][\w$]*)\s*\((?P<args>[^)]*)\)\s*\{",
    re.MULTILINE,
)


def _find_class_body_end_pos(text: str, brace_pos: int) -> int:
    """Like _find_block_end but returns the byte offset, not the line."""
    n = len(text)
    if brace_pos >= n or text[brace_pos] != "{":
        return brace_pos
    depth = 0; i = brace_pos
    in_str = None; in_block_comment = False; in_line_comment = False
    while i < n:
        c = text[i]
        if in_line_comment:
            if c == "\n": in_line_comment = False
            i += 1; continue
        if in_block_comment:
            if c == "*" and i + 1 < n and text[i+1] == "/":
                in_block_comment = False; i += 2; continue
            i += 1; continue
        if in_str:
            if c == "\\": i += 2; continue
            if c == in_str: in_str = None
            i += 1; continue
        if c == "/" and i + 1 < n:
            n2 = text[i+1]
            if n2 == "/": in_line_comment = True; i += 2; continue
            if n2 == "*": in_block_comment = True; i += 2; continue
        if c in ('"', "'", "`"):
            in_str = c; i += 1; continue
        if c == "{": depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return n


def _extract_js_class_methods(body: str, body_offset: int, full_text: str) -> List[Dict[str, Any]]:
    """Extract methods from a class body. body_offset is the absolute position
    of `body` within `full_text` (used to compute correct line numbers)."""
    methods = []
    # Skip JS keywords that can appear at line-start in a class body
    SKIP = {"if", "for", "while", "switch", "return", "throw", "do", "try",
            "catch", "finally", "else", "constructor"}
    seen = set()
    for m in _JS_METHOD_RE.finditer(body):
        name = m.group("name")
        if name in SKIP and name != "constructor":
            continue
        abs_pos = body_offset + m.start()
        line = _line_of(full_text, abs_pos)
        if line in seen:
            continue
        seen.add(line)
        brace_pos = body_offset + body.find("{", m.end())
        end_line = _find_block_end(full_text, brace_pos) if brace_pos > body_offset else line
        gs = (m.group("gs") or "").strip()
        kind = "method"
        if gs == "get": kind = "getter"
        elif gs == "set": kind = "setter"
        if name == "constructor": kind = "constructor"
        sig = (("async " if m.group("async") else "")
               + (gs + " " if gs else "")
               + ("*" if m.group("gen") else "")
               + name + "(" + (m.group("args") or "").strip() + ")")
        methods.append({
            "kind": kind, "name": name, "line": line,
            "end_line": end_line, "signature": sig,
        })
    return methods


# ── Robot Framework ──────────────────────────────────────────────────────────

_RF_SECTION_RE = re.compile(
    r"^\*+\s*(Settings|Variables|Test\s*Cases?|Keywords?|Tasks?|Comments?)\s*\*+",
    re.IGNORECASE,
)


def _outline_robot(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """Robot Framework parser. Sections + tests + keywords."""
    items: List[Dict[str, Any]] = []
    lines = text.splitlines()
    current_section: Optional[str] = None
    current_item: Optional[Dict[str, Any]] = None
    section_node: Optional[Dict[str, Any]] = None

    def _flush_item():
        nonlocal current_item
        if current_item and section_node is not None:
            section_node.setdefault("children", []).append(current_item)
            current_item = None

    for i, ln in enumerate(lines, start=1):
        stripped = ln.rstrip()
        if not stripped:
            continue
        m = _RF_SECTION_RE.match(stripped)
        if m:
            _flush_item()
            sec = m.group(1).lower().replace(" ", "")
            if "testcase" in sec: sec = "test_cases"
            elif "keyword" in sec: sec = "keywords"
            elif "variable" in sec: sec = "variables"
            elif "setting" in sec: sec = "settings"
            elif "task" in sec: sec = "tasks"
            else: sec = sec
            section_node = {"kind": "section", "name": sec, "line": i, "children": []}
            items.append(section_node)
            current_section = sec
            continue

        if current_section is None:
            continue

        # Item start: starts at column 0 (no leading spaces/tabs)
        is_item_start = not ln.startswith((" ", "\t")) and bool(stripped)
        if is_item_start and current_section in ("test_cases", "keywords", "tasks"):
            _flush_item()
            kind = ("test" if current_section == "test_cases" else
                    "task" if current_section == "tasks" else
                    "keyword")
            current_item = {
                "kind": kind,
                "name": stripped,
                "line": i,
                "end_line": i,
            }
        elif current_section == "settings" and is_item_start:
            # Library / Resource / Variables / Documentation / Suite Setup ...
            tokens = re.split(r"\s{2,}|\t+", stripped, maxsplit=1)
            kind = "import" if tokens and tokens[0].lower() in ("library", "resource", "variables") else "setting"
            section_node.setdefault("children", []).append({
                "kind": kind,
                "name": stripped,
                "line": i,
            })
        elif current_section == "variables" and is_item_start:
            section_node.setdefault("children", []).append({
                "kind": "variable",
                "name": stripped.split(None, 1)[0] if stripped else stripped,
                "line": i,
            })
        else:
            # Continuation line for current_item — extend end_line
            if current_item:
                current_item["end_line"] = i

    _flush_item()
    return items


# ── Bash ────────────────────────────────────────────────────────────────────

_BASH_FUNC_RE = re.compile(
    r"^[ \t]*(?:function\s+)?(?P<name>[A-Za-z_][\w-]*)\s*\(\s*\)\s*\{",
    re.MULTILINE,
)
_BASH_VAR_RE = re.compile(
    r"^[ \t]*(?:export\s+|readonly\s+)?(?P<name>[A-Z_][A-Z0-9_]+)=",
    re.MULTILINE,
)


def _outline_bash(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    seen = set()
    for m in _BASH_FUNC_RE.finditer(text):
        line = _line_of(text, m.start())
        if line in seen:
            continue
        seen.add(line)
        brace_pos = text.find("{", m.end() - 1)
        # Bash brace matching is simpler — no string complexity here
        depth = 0; i = brace_pos; n = len(text)
        end_line = line
        while i < n:
            c = text[i]
            if c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end_line = _line_of(text, i)
                    break
            i += 1
        items.append({
            "kind": "function",
            "name": m.group("name"),
            "line": line,
            "end_line": end_line,
            "signature": f"{m.group('name')}()",
        })

    for m in _BASH_VAR_RE.finditer(text):
        line = _line_of(text, m.start())
        # Skip if inside a function body (rough heuristic via existing items)
        inside = any(it["line"] < line <= it["end_line"] for it in items if it["kind"] == "function")
        if inside:
            continue
        items.append({
            "kind": "variable",
            "name": m.group("name"),
            "line": line,
        })
    items.sort(key=lambda x: x["line"])
    return items


# ── YAML / Ansible ──────────────────────────────────────────────────────────

def _outline_yaml(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """YAML outline. For Ansible playbooks/roles, extracts task names."""
    if not _HAS_YAML:
        return _outline_yaml_fallback(text)
    try:
        # Allow multi-doc YAML (Ansible playbooks are often a list of plays)
        docs = list(_yaml.safe_load_all(text))
    except _yaml.YAMLError as e:
        return [{"kind": "error", "name": "yaml_error", "line": getattr(e, "problem_mark", None) and e.problem_mark.line + 1 or 1,
                 "message": str(e)}]
    items: List[Dict[str, Any]] = []
    for _di, doc in enumerate(docs):
        if doc is None:
            continue
        if isinstance(doc, list):
            # Likely an Ansible playbook (list of plays) or task list
            cursor_line = 1  # progressive cursor for accurate line numbers
            for pi, item in enumerate(doc):
                if not isinstance(item, dict):
                    continue
                # Detect a "play" (has hosts) vs a "task" (has a module)
                if "hosts" in item:
                    # Play : locate by name VALUE first, fallback to `hosts:` key
                    play_line = (
                        _yaml_locate_name_value(text, item.get("name") or "", near=cursor_line)
                        if item.get("name") else
                        _yaml_locate_key(text, "hosts", near=cursor_line)
                    )
                    cursor_line = play_line + 1
                    play = {
                        "kind": "play",
                        "name": item.get("name", f"<play #{pi+1}>"),
                        "line": play_line,
                    }
                    children = []
                    for section in ("pre_tasks", "tasks", "post_tasks", "handlers"):
                        if section in item and isinstance(item[section], list):
                            sec_line = _yaml_locate_key(text, section, near=cursor_line)
                            cursor_line = sec_line + 1
                            sec_node = {
                                "kind": "section",
                                "name": section,
                                "line": sec_line,
                                "children": [],
                            }
                            for t in item[section]:
                                if isinstance(t, dict):
                                    name_val = t.get("name") or ""
                                    module_key = _ansible_module_of(t) or ""
                                    tn = name_val or module_key or "<unnamed>"
                                    if name_val:
                                        t_line = _yaml_locate_name_value(text, name_val, near=cursor_line)
                                    elif module_key:
                                        t_line = _yaml_locate_key(text, module_key, near=cursor_line)
                                    else:
                                        t_line = cursor_line
                                    cursor_line = t_line + 1
                                    sec_node["children"].append({
                                        "kind": ("handler" if section == "handlers" else "task"),
                                        "name": tn,
                                        "line": t_line,
                                    })
                            children.append(sec_node)
                    if children:
                        play["children"] = children
                    items.append(play)
                else:
                    # Pure task list (e.g. role's tasks/main.yml)
                    name_val = item.get("name") or ""
                    module_key = _ansible_module_of(item) or ""
                    tn = name_val or module_key or f"<task #{pi+1}>"
                    if name_val:
                        t_line = _yaml_locate_name_value(text, name_val, near=cursor_line)
                    elif module_key:
                        t_line = _yaml_locate_key(text, module_key, near=cursor_line)
                    else:
                        t_line = cursor_line
                    cursor_line = t_line + 1
                    items.append({
                        "kind": "task",
                        "name": tn,
                        "line": t_line,
                    })
        elif isinstance(doc, dict):
            # Top-level mapping — list keys with type info
            cursor_line = 1
            for key, val in doc.items():
                line = _yaml_locate_key(text, str(key), near=cursor_line)
                cursor_line = line + 1
                kind = ("section" if isinstance(val, (list, dict)) else "key")
                node = {"kind": kind, "name": str(key), "line": line}
                # If it's a known Ansible role section (list), expand one level
                if isinstance(val, list) and key in ("tasks", "handlers", "pre_tasks", "post_tasks"):
                    children = []
                    inner_cursor = line + 1
                    for t in val:
                        if isinstance(t, dict):
                            name_val = t.get("name") or ""
                            module_key = _ansible_module_of(t) or ""
                            tn = name_val or module_key or "<unnamed>"
                            if name_val:
                                t_line = _yaml_locate_name_value(text, name_val, near=inner_cursor)
                            elif module_key:
                                t_line = _yaml_locate_key(text, module_key, near=inner_cursor)
                            else:
                                t_line = inner_cursor
                            inner_cursor = t_line + 1
                            children.append({
                                "kind": ("handler" if key == "handlers" else "task"),
                                "name": tn,
                                "line": t_line,
                            })
                    if children:
                        node["children"] = children
                items.append(node)
    return items


_ANSIBLE_META_KEYS = {
    "name", "when", "with_items", "loop", "tags", "register", "become", "become_user",
    "delegate_to", "run_once", "ignore_errors", "vars", "notify", "changed_when",
    "failed_when", "no_log", "block", "rescue", "always",
}


def _ansible_module_of(task: dict) -> Optional[str]:
    """Heuristic: find the module key of an Ansible task (the only key that's
    not a meta keyword)."""
    for k in task.keys():
        if k not in _ANSIBLE_META_KEYS:
            return k
    return None


def _yaml_locate_key(text: str, key: str, near: int = 1) -> int:
    """Best-effort: find the first line containing the key as a dict key,
    starting at or after `near`. Falls back to 1 if not found."""
    if not key:
        return near
    # Match `<key>:` at any indent.
    pat = re.compile(r"^[ \t]*(?:- )?(?P<k>" + re.escape(key) + r")\s*:", re.MULTILINE)
    best = 0
    for m in pat.finditer(text):
        ln = _line_of(text, m.start())
        if ln >= near:
            return ln
        best = ln
    return best or near


def _yaml_locate_name_value(text: str, name_value: str, near: int = 1) -> int:
    """Locate the line where `name: <name_value>` appears (Ansible task names).

    Tries multiple patterns to handle both quoted and unquoted forms:
        - name: My task
        - name: "My task"
        - name: 'My task'
    Returns the first match >= near, else `near` as fallback.
    """
    if not name_value:
        return near
    # Tolerant pattern : optional `- ` prefix, then `name:`, then any quoting,
    # then the literal name (escaped).
    pat = re.compile(
        r"^[ \t]*(?:- )?name\s*:\s*['\"]?" + re.escape(name_value) + r"['\"]?\s*$",
        re.MULTILINE,
    )
    for m in pat.finditer(text):
        ln = _line_of(text, m.start())
        if ln >= near:
            return ln
    return near


def _outline_yaml_fallback(text: str) -> List[Dict[str, Any]]:
    """If PyYAML missing, list top-level keys via regex."""
    items = []
    for i, ln in enumerate(text.splitlines(), start=1):
        m = re.match(r"^([A-Za-z_][\w-]*):", ln)
        if m:
            items.append({"kind": "key", "name": m.group(1), "line": i})
        m2 = re.match(r"^- name:\s*['\"]?(.+?)['\"]?\s*$", ln)
        if m2:
            items.append({"kind": "task", "name": m2.group(1), "line": i})
    return items


# ── JSON ────────────────────────────────────────────────────────────────────

def _outline_json(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """JSON outline: top-level keys with type and size info."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return [{"kind": "error", "name": "json_error", "line": e.lineno,
                 "message": str(e)}]

    def _summarize(v: Any) -> str:
        if isinstance(v, dict):  return f"object ({len(v)} keys)"
        if isinstance(v, list):  return f"array ({len(v)} items)"
        if isinstance(v, str):   return f"string ({len(v)} chars)"
        if isinstance(v, bool):  return f"bool ({v})"
        if v is None:            return "null"
        return f"{type(v).__name__} ({v})"

    items = []
    if isinstance(data, dict):
        for k, v in data.items():
            line = _yaml_locate_key(text, str(k))  # works for JSON too (regex-based)
            items.append({
                "kind": "key",
                "name": str(k),
                "line": line,
                "type": _summarize(v),
            })
    elif isinstance(data, list):
        items.append({"kind": "root", "name": "<array>", "line": 1,
                      "type": f"array ({len(data)} items)"})
    else:
        items.append({"kind": "root", "name": "<value>", "line": 1,
                      "type": _summarize(data)})
    return items


# ── Markdown ────────────────────────────────────────────────────────────────

_MD_HEADING_RE = re.compile(r"^(?P<hash>#{1,6})\s+(?P<text>.+?)\s*#*\s*$", re.MULTILINE)


def _outline_markdown(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """Markdown outline: hierarchical headings."""
    flat = []
    in_code = False
    for i, ln in enumerate(text.splitlines(), start=1):
        if ln.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = _MD_HEADING_RE.match(ln)
        if m:
            level = len(m.group("hash"))
            if level > max_depth:
                continue
            flat.append({
                "kind": f"h{level}",
                "name": m.group("text").strip(),
                "line": i,
                "level": level,
            })

    # Build nested tree
    root: List[Dict[str, Any]] = []
    stack: List[Tuple[int, Dict[str, Any]]] = []  # (level, node)
    for h in flat:
        level = h["level"]
        node = {"kind": h["kind"], "name": h["name"], "line": h["line"]}
        while stack and stack[-1][0] >= level:
            stack.pop()
        if stack:
            stack[-1][1].setdefault("children", []).append(node)
        else:
            root.append(node)
        stack.append((level, node))
    return root


# ── Public dispatch ─────────────────────────────────────────────────────────

def _outline_jsts_dispatch(text: str, max_depth: int = 4,
                            lang_key: str = "javascript") -> List[Dict[str, Any]]:
    """Try tree-sitter first; fall back to the regex parser. TS handles
    generics, decorators, destructuring imports, JSX/TSX."""
    if _HAS_TS and _ts_backend is not None and (
        getattr(_ts_backend, "HAS_TS_JS", False)
        or getattr(_ts_backend, "HAS_TS_TS", False)
    ):
        try:
            out = _ts_backend.outline_jsts(text, lang_key, max_depth=max_depth)
            if out:
                return out
        except Exception:
            pass
    return _outline_javascript(text, max_depth=max_depth)


def _outline_bash_dispatch(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """Tree-sitter Bash → robust on heredocs, complex command structures."""
    if _HAS_TS and _ts_backend is not None and getattr(_ts_backend, "HAS_TS_BASH", False):
        try:
            out = _ts_backend.outline_bash(text, max_depth=max_depth)
            if out:
                return out
        except Exception:
            pass
    return _outline_bash(text, max_depth=max_depth)


def _outline_robot_dispatch(text: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """Tree-sitter Robot → robust on continuation lines, embedded variables.
    Extracts test [Tags] and keyword [Arguments] which the line-based parser
    typically did not surface."""
    if _HAS_TS and _ts_backend is not None and getattr(_ts_backend, "HAS_TS_ROBOT", False):
        try:
            out = _ts_backend.outline_robot(text, max_depth=max_depth)
            if out:
                return out
        except Exception:
            pass
    return _outline_robot(text, max_depth=max_depth)


_OUTLINER = {
    "python":     _outline_python,
    "javascript": lambda t, max_depth=4: _outline_jsts_dispatch(t, max_depth, "javascript"),
    "typescript": lambda t, max_depth=4: _outline_jsts_dispatch(t, max_depth, "typescript"),
    "robot":      _outline_robot_dispatch,
    "bash":       _outline_bash_dispatch,
    "yaml":       _outline_yaml,
    "json":       _outline_json,
    "markdown":   _outline_markdown,
}


def outline(text: str, lang: str, max_depth: int = 4) -> List[Dict[str, Any]]:
    """Produce a hierarchical outline. Returns [] for unsupported langs."""
    fn = _OUTLINER.get(lang)
    if not fn:
        return []
    try:
        return fn(text, max_depth=max_depth)
    except Exception as e:
        return [{"kind": "error", "name": "outline_failed",
                 "line": 1, "message": f"{type(e).__name__}: {e}"}]


def list_symbols(text: str, lang: str) -> List[Dict[str, Any]]:
    """Flat list of all symbols (functions/classes/methods/tests) with line numbers."""
    flat = []
    def _walk(items):
        for it in items:
            if it.get("kind") in ("error",):
                continue
            flat.append({
                "kind": it["kind"],
                "name": it["name"],
                "line": it.get("line", 0),
                "end_line": it.get("end_line", it.get("line", 0)),
            })
            if "children" in it:
                _walk(it["children"])
    _walk(outline(text, lang, max_depth=99))
    return flat


def find_definition(text: str, lang: str, name: str) -> List[Dict[str, Any]]:
    """Find lines where a named symbol is DEFINED (not used)."""
    syms = list_symbols(text, lang)
    return [s for s in syms if s["name"] == name]


def _strip_jsts_strings_comments(text: str) -> str:
    """Replace string-literal contents and comments with spaces (preserves
    line numbers and column offsets). Adequate fallback when tree-sitter is
    not available for JS/TS/bash."""
    result: List[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                result.append(" "); i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            result.append("  "); i += 2
            while i < n - 1 and not (text[i] == "*" and text[i + 1] == "/"):
                result.append("\n" if text[i] == "\n" else " "); i += 1
            if i < n - 1:
                result.append("  "); i += 2
            continue
        if c in ('"', "'", "`"):
            quote = c
            result.append(" "); i += 1
            while i < n and text[i] != quote:
                if text[i] == "\\" and i + 1 < n:
                    result.append("  " if text[i + 1] != "\n" else " \n")
                    i += 2; continue
                result.append("\n" if text[i] == "\n" else " "); i += 1
            if i < n: result.append(" "); i += 1
            continue
        result.append(c); i += 1
    return "".join(result)


def _find_references_python(text: str, name: str,
                             max_results: int) -> List[Dict[str, Any]]:
    """Token-level scan via stdlib `tokenize` (skips strings/comments/numbers)."""
    import io
    import tokenize
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenizeError, IndentationError, SyntaxError):
        pat = re.compile(r"\b" + re.escape(name) + r"\b")
        out, lines = [], text.splitlines()
        for i, ln in enumerate(lines, 1):
            if pat.search(ln):
                out.append({"line": i, "text": ln[:200].rstrip()})
                if len(out) >= max_results: break
        return out
    out: List[Dict[str, Any]] = []
    seen_lines: set = set()
    lines = text.splitlines()
    for t in toks:
        if t.type != tokenize.NAME or t.string != name:
            continue
        ln = t.start[0]
        if ln in seen_lines: continue
        seen_lines.add(ln)
        out.append({
            "line": ln,
            "text": (lines[ln - 1] if 0 <= ln - 1 < len(lines) else "")[:200].rstrip(),
        })
        if len(out) >= max_results:
            break
    return out


def _normalize_robot_kw(s: str) -> str:
    """Robot keyword normalization (case-insensitive, _ ↔ space ↔ -)."""
    return s.lower().replace("_", " ").replace("-", " ").strip()


def find_references(text: str, lang: str, name: str,
                     max_results: int = 200) -> List[Dict[str, Any]]:
    """Find every line where `name` appears as an identifier (NOT inside
    strings or comments). Per-language strategy:

      python      : `tokenize` (stdlib, AST-precise).
      js/ts       : tree-sitter if available (zero false positives), else
                    regex on a copy where strings & comments are blanked.
      bash        : tree-sitter if available (handles heredocs/strings); else
                    string-stripped regex fallback.
      robot       : tree-sitter if available (case + underscore-insensitive
                    matching per Robot semantics); else case-insensitive regex.
      yaml/json/markdown : regex with `\\b` word boundary (best effort).
    """
    if not name or not name.replace("_", "").replace("-", "").replace(" ", "").isalnum():
        return []
    if lang == "python":
        return _find_references_python(text, name, max_results)

    if lang in ("javascript", "typescript"):
        if _HAS_TS and _ts_backend is not None and (
            getattr(_ts_backend, "HAS_TS_JS", False)
            or getattr(_ts_backend, "HAS_TS_TS", False)
        ):
            try:
                refs = _ts_backend.references_jsts(text, lang, name, max_results)
                if refs:
                    return refs
            except Exception:
                pass
        cleaned = _strip_jsts_strings_comments(text)
        pat = re.compile(r"\b" + re.escape(name) + r"\b")
        out, orig_lines, clean_lines = [], text.splitlines(), cleaned.splitlines()
        for i, (orig, clean) in enumerate(zip(orig_lines, clean_lines), 1):
            if pat.search(clean):
                out.append({"line": i, "text": orig[:200].rstrip()})
                if len(out) >= max_results: break
        return out

    if lang == "bash":
        if _HAS_TS and _ts_backend is not None and getattr(_ts_backend, "HAS_TS_BASH", False):
            try:
                refs = _ts_backend.references_bash(text, name, max_results)
                if refs:
                    return refs
            except Exception:
                pass
        # Fallback: strip `# comments` then strip strings, then regex
        no_comments = re.sub(
            r"(^|\s)#[^\n]*",
            lambda m: m.group(1) + " " * (len(m.group(0)) - len(m.group(1))),
            text,
        )
        cleaned = _strip_jsts_strings_comments(no_comments)
        pat = re.compile(r"\b" + re.escape(name) + r"\b")
        out, orig_lines, clean_lines = [], text.splitlines(), cleaned.splitlines()
        for i, (orig, clean) in enumerate(zip(orig_lines, clean_lines), 1):
            if pat.search(clean):
                out.append({"line": i, "text": orig[:200].rstrip()})
                if len(out) >= max_results: break
        return out

    if lang == "robot":
        if _HAS_TS and _ts_backend is not None and getattr(_ts_backend, "HAS_TS_ROBOT", False):
            try:
                refs = _ts_backend.references_robot(text, name, max_results)
                if refs:
                    return refs
            except Exception:
                pass
        # Fallback: case+underscore-insensitive line-level match
        target = _normalize_robot_kw(name)
        out: List[Dict[str, Any]] = []
        for i, ln in enumerate(text.splitlines(), 1):
            if target in _normalize_robot_kw(ln):
                out.append({"line": i, "text": ln[:200].rstrip()})
                if len(out) >= max_results: break
        return out

    # Other langs: \b boundary regex (already filters partial-word matches)
    pat = re.compile(r"\b" + re.escape(name) + r"\b")
    out = []
    for i, ln in enumerate(text.splitlines(), start=1):
        if pat.search(ln):
            out.append({"line": i, "text": ln[:200].rstrip()})
            if len(out) >= max_results: break
    return out


def summarize_structure(text: str, lang: str) -> str:
    """One-paragraph human-readable summary of the file structure."""
    items = outline(text, lang, max_depth=3)
    if not items:
        return f"({lang}: no outline available)"
    counts: Dict[str, int] = {}
    def _count(its):
        for it in its:
            counts[it["kind"]] = counts.get(it["kind"], 0) + 1
            if "children" in it:
                _count(it["children"])
    _count(items)
    parts = []
    for k in ("class", "function", "method", "test", "keyword", "task",
              "play", "section", "import", "key", "h1", "h2"):
        if counts.get(k):
            parts.append(f"{counts[k]} {k}{'es' if k.endswith('s') else 's'}")
    return ", ".join(parts) or "(empty)"
