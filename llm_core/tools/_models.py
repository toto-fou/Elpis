# SPDX-License-Identifier: MIT
# tools/_models.py
"""
Shared Pydantic output models for MCP tool returns.

v19 (Tier 1 MCP best practices, second half) — structured outputs.
Until now every tool returned ``Dict[str, Any]`` which produced a flat
``{"additionalProperties": true, "type": "object"}`` ``outputSchema`` in
the MCP tool definition — useless to the LLM (it can't tell what fields
exist or what their types are, so it guesses).

Switching the success returns to Pydantic models gives the LLM a real
JSON Schema per tool : it knows ``read_file`` returns ``{path, content,
sha256, total_lines, ...}``, with each field's type and which are
required. This reduces "field-name guessing" failures and makes
multi-tool chains more reliable.

Backward compatibility — KEY DESIGN POINT
-----------------------------------------
The wire format produced by FastMCP is **identical** for ``dict`` vs
Pydantic returns: the ``CallToolResult.content[0].text`` is the same
JSON string in both cases (the Pydantic model just gets ``.model_dump
(mode='json')``'d). ``pick_tool_payload`` in
``backend.services._chat_with_tools`` therefore receives the same dict
either way — no frontend change required for the success path.

We DO NOT migrate the error path (``{"ok": false, "error": "code", ...}``
envelope) here. The frontend's ``_isErrorResult`` heuristic in
``static/js/app-chat.js`` reads the ``error`` field directly; changing
the shape would require coordinated FE updates. The error envelope stays
exactly as ``tools/_toolkit.err()`` produces it.

For each tool we define a SUCCESS model. Every model has ``ok: Literal
[True] = True`` as the discriminator (matching the existing ``ok``
convention in ``_ok(...)``). Tools that can produce multiple shapes
(e.g. ``read_file`` in batch vs. single, ``write_file`` in mkdir vs.
write vs. b64) declare a Union of models or fall back to a base model
with ``extra='allow'`` for the rare polymorphic case.

Field documentation lives in the model — that's what the LLM sees as
its primary spec. Keep descriptions terse and operational.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

# ────────────────────────────────────────────────────────────────────
#  Common base — every success result carries ok=True (discriminator)
# ────────────────────────────────────────────────────────────────────

class _SuccessBase(BaseModel):
    """Base for every typed success return.

    ``ok: Literal[True]`` is the discriminator — the frontend and the
    LLM both rely on this field being ``true`` to recognize success vs.
    the failure envelope ``{"ok": false, "error": ...}``.

    ``extra='allow'`` so a tool can attach contextual extras (e.g.
    ``saved_to``, ``saved_bytes`` on ``execute_shell`` when
    ``save_stdout=`` is used) without us having to extend every model
    for every optional case. The core fields stay strictly typed; the
    LLM still gets a rich schema for the common case.
    """
    model_config = ConfigDict(extra="allow")
    ok: Literal[True] = True


class ErrEnvelope(BaseModel):
    """Typed shape of the error envelope produced by ``_toolkit.err()``.

    Mirrors the v17 contract that the chat frontend already parses :
      * ``ok`` is the discriminator (False = failure),
      * ``error`` is a stable machine code (snake_case),
      * ``message`` is the human-readable text,
      * ``fix`` is an optional hint how to recover.

    Tools declare their return type as ``Union[<SuccessModel>,
    ErrEnvelope]`` so FastMCP generates a discriminated union schema
    the LLM can pattern-match on the ``ok`` field. The runtime
    wire format is unchanged — both branches serialise to the same
    JSON dict the frontend already reads.

    ``extra='allow'`` because ``err()`` lets each call site attach
    context (``cmd``, ``path``, ``expected``, ``actual``, …) — these
    are kept for the LLM but aren't part of the strict schema.
    """
    model_config = ConfigDict(extra="allow")
    ok: Literal[False] = False
    error: str = Field(..., description="Stable machine code (e.g. 'not_found', 'too_large').")
    message: Optional[str] = Field(None, description="Human-readable error message.")
    fix: Optional[str] = Field(None, description="Suggested recovery action.")
    next_action: Optional[str] = Field(None, description="Concrete next tool/arg to try.")
    retryable: Optional[bool] = Field(None, description="True iff a retry might succeed (transient error).")


# ────────────────────────────────────────────────────────────────────
#  fs_tools — read / write / edit / list / manage / stat / outline / navigate
# ────────────────────────────────────────────────────────────────────

class ReadFileSingle(_SuccessBase):
    """Result of read_file in single-file mode."""
    path:        str                 = Field(..., description="Absolute host path read.")
    rel_path:    Optional[str]       = Field(None, description="Path relative to sandbox root.")
    content:     Optional[str]       = Field(None, description="Decoded text content (None for binary/auto_truncated/error).")
    encoding:    Optional[str]       = Field(None, description="Encoding used for text decode.")
    mime:        Optional[str]       = Field(None, description="Best-effort MIME type.")
    size:        Optional[int]       = Field(None, description="File size in bytes.")
    type:        Optional[str]       = Field(None, description="One of: file | dir | symlink.")
    sha256:      Optional[str]       = Field(None, description="SHA-256 of full file content.")
    total_lines: Optional[int]       = Field(None, description="Total line count (text files).")
    format:      Optional[str]       = Field(None, description="Output format: auto_truncated | head | tail | grep | range | summary | binary | json | yaml | b64.")
    truncated:   Optional[bool]      = Field(None, description="True iff content was truncated to fit max_chars.")
    base64:      Optional[str]       = Field(None, description="Base64-encoded bytes (binary / as_base64=True).")
    next_expected_sha256: Optional[str] = Field(None, description="Use as expected_sha256 on the next edit_file/write_file for race-free updates.")


class ReadFileBatch(_SuccessBase):
    """Result of read_file in batch mode (paths=[...])."""
    action:    Literal["batch_read"] = "batch_read"
    count:     int                   = Field(..., description="Number of paths requested.")
    succeeded: int                   = Field(..., description="Number of reads that returned ok=true.")
    failed:    int                   = Field(..., description="Number of reads that returned ok=false.")
    files:     Dict[str, Dict[str, Any]] = Field(..., description="Per-path result dict (success OR error envelope).")


ReadFileResult = Union[ReadFileBatch, ReadFileSingle]


class WriteFileResult(_SuccessBase):
    """Result of write_file (write/append/mkdir/b64)."""
    path:         str           = Field(..., description="Absolute host path written.")
    action:       str           = Field(..., description="write | append | mkdir | b64_write | noop.")
    bytes:        Optional[int] = Field(None, description="Final file size in bytes (write/append/b64).")
    old_sha256:   Optional[str] = Field(None, description="SHA-256 BEFORE write (empty if new file).")
    new_sha256:   Optional[str] = Field(None, description="SHA-256 AFTER write.")
    next_expected_sha256: Optional[str] = Field(None, description="Use as expected_sha256 on the NEXT edit/write to this file.")
    lines_added:   Optional[int] = Field(None, description="Number of new lines vs. prior content.")
    lines_removed: Optional[int] = Field(None, description="Number of removed lines vs. prior content.")
    unchanged:    Optional[bool] = Field(None, description="True iff the new content equals the prior content (action=noop).")
    note:         Optional[str]  = Field(None, description="Human-readable hint (esp. on noop).")
    dry_run:      Optional[bool] = Field(None, description="True iff dry_run=True was passed.")
    bytes_before: Optional[int]  = Field(None, description="File size BEFORE write (dry_run only).")
    bytes_after:  Optional[int]  = Field(None, description="File size that WOULD result (dry_run only).")
    would_create: Optional[bool] = Field(None, description="mkdir dry_run: whether the dir would be newly created.")


class EditFileResult(_SuccessBase):
    """Result of edit_file (str_replace / regex / insert / delete / replace / anchor / indent / multi)."""
    path:        str  = Field(..., description="Absolute host path edited.")
    action:      str  = Field(..., description="Edit action that was applied.")
    dry_run:     bool = Field(False, description="True iff dry_run=True.")
    diff:        Optional[str] = Field(None, description="Unified diff (truncated to fit budget).")
    old_sha256:  Optional[str] = Field(None, description="SHA-256 BEFORE edit.")
    new_sha256:  Optional[str] = Field(None, description="SHA-256 AFTER edit.")
    next_expected_sha256: Optional[str] = Field(None, description="Use as expected_sha256 on the NEXT edit to this file.")
    bytes_before:  Optional[int]   = Field(None, description="File size BEFORE.")
    bytes_after:   Optional[int]   = Field(None, description="File size AFTER.")
    lines_before:  Optional[int]   = Field(None, description="Line count BEFORE.")
    lines_after:   Optional[int]   = Field(None, description="Line count AFTER.")
    lines_added:   Optional[int]   = Field(None, description="Lines added by the edit.")
    lines_removed: Optional[int]   = Field(None, description="Lines removed by the edit.")
    applied:       Optional[List[Dict[str, Any]]] = Field(None, description="Per-edit info (action=multi).")
    formatter:     Optional[str]   = Field(None, description="Formatter name if auto_format ran.")
    unchanged:     Optional[bool]  = Field(None, description="True iff the edit produced no net change.")
    note:          Optional[str]   = Field(None, description="Human-readable hint (esp. on unchanged).")


class FileEntry(BaseModel):
    """One entry in a list_files result."""
    model_config = ConfigDict(extra="allow")
    name: str            = Field(..., description="File / dir name (no path).")
    path: str            = Field(..., description="Absolute host path.")
    type: str            = Field(..., description="file | dir | symlink.")
    size: Optional[int]  = Field(None, description="Bytes (files only).")
    mtime: Optional[int] = Field(None, description="Unix mtime.")
    mode:  Optional[str] = Field(None, description="Octal permission string.")
    rel:   Optional[str] = Field(None, description="Path relative to listing root.")


class ListFilesResult(_SuccessBase):
    """Result of list_files."""
    path:    str             = Field(..., description="Listed directory (absolute host).")
    items: List[Any] = Field(default_factory=list, description="Listed entries: relative paths (str), or per-file stat dicts when details=True.")
    count:   int             = Field(0, description="Number of entries returned.")
    truncated: Optional[bool] = Field(None, description="True iff capped at MAX_LIST.")


class ManageFilesResult(_SuccessBase):
    """Result of manage_files (copy/move/delete/chmod/mkdir/batch_delete)."""
    action: str           = Field(..., description="copy | move | delete | chmod | mkdir | batch_delete.")
    path:   Optional[str] = Field(None, description="Operated path (single-target actions).")
    src:    Optional[str] = Field(None, description="Source (copy/move).")
    dest:   Optional[str] = Field(None, description="Destination (copy/move).")
    mode:   Optional[str] = Field(None, description="New octal mode (chmod).")
    deleted: Optional[List[str]] = Field(None, description="Deleted paths (batch_delete).")
    count:   Optional[int]       = Field(None, description="Number of items operated on.")
    dry_run: Optional[bool]      = Field(None, description="True iff dry_run=True.")
    plan:    Optional[List[Dict[str, Any]]] = Field(None, description="Planned actions (dry_run batch_delete).")
    created:      Optional[bool] = Field(None, description="mkdir: True iff the directory was newly created (False if it already existed).")
    would_create: Optional[bool] = Field(None, description="mkdir dry_run: whether the directory would be newly created.")


class StatPathResult(_SuccessBase):
    """Result of stat_path."""
    path:  Optional[str]            = Field(None, description="Single-target host path.")
    paths: Optional[List[str]]      = Field(None, description="Batch input paths (echo).")
    files: Optional[Dict[str, Any]] = Field(None, description="Per-path stat result (batch).")
    # Single-target fields (flattened when not in batch mode)
    exists: Optional[bool] = Field(None, description="Whether the path exists.")
    type:   Optional[str]  = Field(None, description="file | dir | symlink | absent.")
    size:   Optional[int]  = Field(None, description="Bytes.")
    mtime:  Optional[int]  = Field(None, description="Unix mtime.")
    mode:   Optional[str]  = Field(None, description="Octal permissions.")
    sha256: Optional[str]  = Field(None, description="SHA-256 (files only, if requested).")


class CodeOutlineEntry(BaseModel):
    """One symbol in a code_outline result."""
    model_config = ConfigDict(extra="allow")
    kind: str = Field(..., description="function | class | method | const | import …")
    name: str
    line: int = Field(..., description="1-based line where the symbol starts.")


class CodeOutlineResult(_SuccessBase):
    """Result of code_outline."""
    path:    Optional[str] = Field(None, description="Single file path.")
    outline: Optional[List[CodeOutlineEntry]] = Field(None, description="Flat list of symbols.")
    files:   Optional[Dict[str, Any]] = Field(None, description="Per-path outline (batch mode).")
    language: Optional[str] = Field(None, description="Detected language (py/js/ts/robot/sh/yaml/json/md).")


class CodeNavigateResult(_SuccessBase):
    """Result of code_navigate."""
    matches: List[Dict[str, Any]] = Field(default_factory=list, description="Hits with {path, line, kind, name, preview}.")
    count: int = Field(0, description="Number of hits returned.")
    truncated: Optional[bool] = Field(None, description="True iff capped.")


# ────────────────────────────────────────────────────────────────────
#  shell_tools — execute_shell
# ────────────────────────────────────────────────────────────────────

class _ShellExecBase(_SuccessBase):
    """Shared fields produced by every Docker exec call.

    ``ok: bool`` overrides the base ``Literal[True]`` — shell ops use
    ``ok = (returncode == 0)`` as their success convention. A non-zero
    exit is NOT an error envelope here; the LLM gets stdout/stderr to
    reason about.
    """
    ok: bool = True  # type: ignore[assignment]  # overrides _SuccessBase
    cmd:         str = Field(..., description="The shell command that was executed (passed to `bash -c`).")
    cwd:         str = Field(..., description="Working directory used (container path).")
    returncode:  int = Field(..., description="Process exit code (0 = success, 124 = timeout).")
    stdout:      str = Field(..., description="Captured stdout, truncated to max_output.")
    stderr:      str = Field(..., description="Captured stderr, truncated to max_output.")
    truncated:   bool = Field(False, description="True iff stdout OR stderr was truncated.")
    duration_ms: int = Field(..., description="Wall-clock duration in milliseconds.")
    executor:    str = Field(..., description="Executor tag, e.g. 'docker.user.alice'.")


class BackgroundShellResult(_SuccessBase):
    """Retour du mode DÉTACHÉ de ``execute_shell`` (``background=True``).

    AUDIT 2026-08-23 — ce mode n'avait AUCUNE branche dans l'``outputSchema``.
    Son retour (``ok/background/pid/cmd/log/hint``) ne satisfaisait ni
    ``ExecuteShellResult`` (qui exige cwd/returncode/stdout/stderr/duration_ms/
    executor) ni ``ErrEnvelope`` (qui exige ``ok: false``) : la validation de
    sortie côté serveur MCP levait, l'appel remontait en erreur… APRÈS avoir
    lancé le processus. Le modèle voyait un échec et relançait — autant de
    processus détachés en double. Un modèle DÉDIÉ plutôt qu'un assouplissement
    d'``ExecuteShellResult`` : le chemin normal garde son schéma strict.
    """
    background: bool = Field(True, description="Always true: the process was detached.")
    pid:  int = Field(..., description="PID of the detached process, inside the container.")
    cmd:  str = Field(..., description="The shell command that was launched.")
    log:  str = Field(..., description="Container path of the file collecting stdout/stderr.")
    hint: str = Field("", description="How to read the log and how to stop the process.")


class ExecuteShellResult(_ShellExecBase):
    """Result of execute_shell."""
    saved_to:    Optional[str] = Field(None, description="Path stdout was also saved to (when save_stdout= was used).")
    saved_bytes: Optional[int] = Field(None, description="Bytes written to saved_to.")


# ────────────────────────────────────────────────────────────────────
#  git_tools — 10 tools with highly polymorphic per-action shapes
# ────────────────────────────────────────────────────────────────────
#
# The git tools dispatch on an ``action`` parameter (list, find, grep,
# show, blame, log, diff, status, branch, remote, tag, clone, push,
# commit, …). Each action returns a different dict shape. Rather than
# explode the LLM-visible schema with one model per (tool, action)
# combination (≥ 30 shapes, mostly self-evident from field names),
# we provide a base success model with the canonical ``ok=True``
# discriminator and ``extra='allow'`` for the action-specific fields.
#
# Selected high-frequency fields are still declared in the base so the
# LLM sees them in the schema; everything else flows through extras.

class GitQueryResult(_SuccessBase):
    """Result of git_query (list/find/grep/show/blame/log/diff/status/branch/remote/tag).

    Carries action-specific extras (``hits``, ``files``, ``log``, ``diff``,
    ``branches``, ``tags``, …) via ``extra='allow'``. The common fields
    declared here are the ones the LLM benefits from seeing in the schema.
    """
    action:    Optional[str] = Field(None, description="The query action that was dispatched.")
    repo:      Optional[str] = Field(None, description="Repository path (absolute, host).")
    count:     Optional[int] = Field(None, description="Result count (where applicable: hits, files, branches, …).")
    truncated: Optional[bool] = Field(None, description="True iff the result was capped.")


class GitWriteResult(_SuccessBase):
    """Result of git_write (create/edit/append/delete/find_replace files in a repo)."""
    action: Optional[str] = Field(None, description="The write action that was dispatched.")
    path:   Optional[str] = Field(None, description="Absolute host path of the file written.")
    repo:   Optional[str] = Field(None, description="Repository path.")
    bytes:  Optional[int] = Field(None, description="Final file size in bytes.")
    sha256: Optional[str] = Field(None, description="Final SHA-256 of the file.")
    dry_run: Optional[bool] = Field(None)


class GitActionResult(_SuccessBase):
    """Result of git_action (branch/checkout/merge/rebase/pull/fetch/reset/restore/stash)."""
    action: Optional[str] = Field(None)
    repo:   Optional[str] = Field(None)
    branch: Optional[str] = Field(None)
    dry_run: Optional[bool] = Field(None)


class GitRfResult(_SuccessBase):
    """Result of git_rf (scan | find | settings). Fields populated per action."""
    count:           Optional[int]                  = Field(None, description="Match count (find).")
    # scan
    libraries_found: Optional[int]                  = Field(None, description="Number of RF libraries found (scan).")
    import_summary:  Optional[List[Dict[str, Any]]] = Field(None, description="Per-library {library, import, keywords} (scan).")
    catalog_text:    Optional[str]                  = Field(None, description="Human-readable library/keyword catalog (scan).")
    # find
    found:           Optional[bool]                 = Field(None, description="Whether the keyword was found (find).")
    query:           Optional[str]                  = Field(None, description="Echoed keyword_name (find).")
    matches:         Optional[List[Dict[str, Any]]] = Field(None, description="Keyword matches {keyword, library, file, import, args, doc, exact} (find).")
    # settings
    settings_block:  Optional[str]                  = Field(None, description="Generated *** Settings *** block (settings).")
    resolved:        Optional[List[Dict[str, Any]]] = Field(None, description="Resolved keywords {keyword, library} (settings).")
    unresolved:      Optional[List[str]]            = Field(None, description="Keywords that couldn't be resolved (settings).")


class GitInspectResult(_SuccessBase):
    """Result of git_inspect (config/hooks/remotes/auth/index inspection)."""
    action: Optional[str] = Field(None)
    repo:   Optional[str] = Field(None)


class GitStartWorkResult(_SuccessBase):
    """Result of git_start_work (clone if missing → pull → branch off)."""
    repo:        Optional[str] = Field(None)
    branch:      Optional[str] = Field(None, description="The newly-created agent/<intent>-<hash> branch.")
    base_branch: Optional[str] = Field(None, description="Branch we branched OFF of.")
    cloned:      Optional[bool] = Field(None, description="True iff the repo was newly cloned.")
    pulled:      Optional[bool] = Field(None, description="True iff a pull happened (existing repo).")


class GitCommitResult(_SuccessBase):
    """Result of git_commit (stage selected paths + commit)."""
    repo:    Optional[str] = Field(None)
    sha:     Optional[str] = Field(None, description="Commit SHA (full).")
    message: Optional[str] = Field(None, description="Commit message that was applied.")
    files:   Optional[List[str]] = Field(None, description="Paths included in the commit.")
    dry_run: Optional[bool] = Field(None)


class GitSubmitResult(_SuccessBase):
    """Result of git_submit (push branch + open PR/MR upstream)."""
    repo:     Optional[str] = Field(None)
    branch:   Optional[str] = Field(None)
    pushed:   Optional[bool] = Field(None)
    pr_url:   Optional[str] = Field(None, description="URL of the pull/merge request.")
    pr_number: Optional[int] = Field(None)


class GitAbandonResult(_SuccessBase):
    """Result of git_abandon (reset --hard + branch delete — destructive)."""
    repo:    Optional[str] = Field(None)
    branch:  Optional[str] = Field(None)
    deleted: Optional[bool] = Field(None)


class GitCloneResult(_SuccessBase):
    """Result of git_clone."""
    repo:   Optional[str] = Field(None)
    url:    Optional[str] = Field(None)
    branch: Optional[str] = Field(None)


# ────────────────────────────────────────────────────────────────────
#  chart_tools — 2 tools producing chart/table refs the UI renders
# ────────────────────────────────────────────────────────────────────

class GenerateChartResult(_SuccessBase):
    """Result of generate_chart — returns a ``!<id>`` reference the UI expands."""
    ref:        str = Field(..., description="The ``!chart_<id>`` token to paste in the reply.")
    chart_id:   str = Field(..., description="Internal chart identifier.")
    chart_type: str = Field(..., description="Chart kind (bar/line/pie/…).")
    summary:    Optional[str] = Field(None, description="Plain-text 1-line summary of the chart.")
    hint:       Optional[str] = Field(None, description="How to use the ref in the reply text.")


class GenerateTableResult(_SuccessBase):
    """Result of generate_table — a ``!<id>`` table reference (``format="ref"``)
    OR the rendered table itself (``format="markdown"``, the default :
    ``table_markdown`` + ``rows_count``).

    (2026-09-12) ``ref``/``table_id`` étaient REQUIS alors que le défaut du
    tool rend ``table_markdown`` : le SDK client (mcp ≥ 1.10 valide
    ``structuredContent`` contre ``outputSchema``) rejetait le résultat comme
    « Invalid structured content ». Les deux formes sont valides."""
    ref:            Optional[str] = Field(None)
    table_id:       Optional[str] = Field(None)
    format:         Optional[str] = Field(None, description="markdown | ref")
    table_markdown: Optional[str] = Field(None, description="Rendered markdown table (format=markdown).")
    table_html:     Optional[str] = Field(None, description="Rendered HTML table (format=html).")
    table_csv:      Optional[str] = Field(None, description="Rendered CSV (format=csv).")
    rows_count:     Optional[int] = Field(None, description="Number of data rows (format=markdown).")
    rows:           Optional[int] = Field(None, description="Number of data rows in the table.")
    cols:           Optional[int] = Field(None, description="Number of columns.")
    summary:        Optional[str] = Field(None)
    hint:           Optional[str] = Field(None)



# ────────────────────────────────────────────────────────────────────
#  firefox_tools — 8 pw_* tools driving Playwright via a Firefox sidecar
# ────────────────────────────────────────────────────────────────────
#
# These tools have rich per-action shapes (find returns a node descriptor,
# act returns interaction telemetry, page returns viewport/url/title,
# chain returns a sequence of step results, …). Same approach as git:
# canonical ok=True discriminator + extra='allow' for the rich payload.
# Selected high-frequency fields surfaced for schema visibility.

class PWSessionResult(_SuccessBase):
    """Result of pw_session — start/list/close/info on Playwright sessions."""
    action:     Optional[str]  = Field(None)
    session_id: Optional[str]  = Field(None)
    sessions:   Optional[List[Dict[str, Any]]] = Field(None, description="Listing (action='list').")
    url:        Optional[str]  = Field(None)


class PWFindResult(_SuccessBase):
    """Result of pw_find — locate one or many DOM elements via the DSL or selector."""
    session_id: Optional[str] = Field(None)
    found:      Optional[bool] = Field(None)
    count:      Optional[int] = Field(None, description="How many matches were returned (capped by max=).")
    total:      Optional[int] = Field(None, description="How many elements matched before the cap.")
    matches:    Optional[List[Dict[str, Any]]] = Field(None, description="Each {tag, text, role, visible, enabled, ref, xpath, in_viewport, frame?}.")
    ref_ttl_s:  Optional[int]  = Field(None, description="Seconds a returned `ref` stays valid on the service — re-run pw_find after that, or sooner on content that shifts/disappears.")
    ref_reusable: Optional[bool] = Field(None, description="True: the same ref can be passed to several pw_act calls until it expires.")
    usage_hint: Optional[str]  = Field(None)
    node:       Optional[Dict[str, Any]] = Field(None, description="Single-match descriptor (tag, role, attributes, text…).")
    nodes:      Optional[List[Dict[str, Any]]] = Field(None, description="Multi-match descriptors.")


class PWActResult(_SuccessBase):
    """Result of pw_act — click / fill / type / press / select / hover / drag / expand…"""
    session_id: Optional[str] = Field(None)
    action:     Optional[str] = Field(None)
    target:     Optional[str] = Field(None, description="DSL or selector that was acted upon.")
    status:     Optional[str] = Field(None, description="Service outcome ('success').")
    strategy:   Optional[str] = Field(None, description="How the element was reached: ref | by_official | smart:<strategy> | page-scroll | container-scroll | keyboard.")
    resolved_selector: Optional[str] = Field(None, description="The Playwright expression the service actually used (e.g. getByRole('button', { name: /Login/i }).first()).")
    attempts:   Optional[List[Dict[str, Any]]] = Field(None, description="Ordered resolution attempts {via, ok, error?, ms?} — shows when the official locator failed and a fallback landed.")
    url:        Optional[str] = Field(None, description="Page URL after the action.")
    selected:   Optional[Dict[str, Any]] = Field(None, description="select/pick: the option really chosen {value, label, index}.")
    expanded:   Optional[bool] = Field(None, description="click/expand/collapse on a tree item or disclosure: aria-expanded AFTER the action (null when the element declares none).")
    page_after: Optional[Dict[str, Any]] = Field(None, description="Lite snapshot of the page after the action (observe=true).")
    screenshot_url: Optional[str] = Field(None, description="When action involved a screenshot.")
    step:       Optional[int] = Field(None, description="Step number within the session.")


class PWPageResult(_SuccessBase):
    """Result of pw_page — inspect / screenshot / wait / eval / extract / text / tabs / network / pdf.

    CONTRAT (audit tools web 2026-09-05) — ``status`` accepte un ENTIER (code
    HTTP d'une navigation) OU une CHAÎNE : le service Node répond
    ``{"status": "success"}`` (screenshot, onglets, pdf) et ``{"status":
    "found"}`` (wait). Typé ``int`` seul, le schéma de sortie rejetait ces
    réponses côté client MCP (``-32602 … status must be integer … must have
    required property 'error'``) : ``pw_page(action='screenshot')`` était
    inutilisable alors que la capture existait bien sur disque.
    """
    session_id: Optional[str] = Field(None)
    action:     Optional[str] = Field(None)
    url:        Optional[str] = Field(None)
    title:      Optional[str] = Field(None)
    status:     Optional[Union[int, str]] = Field(None, description="HTTP status of the last navigation (int), or the service outcome ('success', 'found').")
    screenshot: Optional[str] = Field(None, description="screenshot: PNG file name on the browser service.")
    screenshot_url: Optional[str] = Field(None, description="screenshot: app-relative URL serving that PNG (/api/playwright/screenshot/<file>).")
    screenshot_step: Optional[int] = Field(None, description="Step counter of the session (each call also writes step_<sid>_<N>.png).")


class PWExpectResult(_SuccessBase):
    """Result of pw_expect — assertion (visible, hidden, contains_text, …)."""
    session_id: Optional[str] = Field(None)
    expectation: Optional[str] = Field(None)
    passed:      Optional[bool] = Field(None)


class PWWaitResult(_SuccessBase):
    """Result of pw_wait — wait for a dynamic condition or a fixed duration.

    ``ok`` overrides the base ``Literal[True]``: a wait that expires without
    the condition being met returns ``ok=False`` with ``timed_out=True`` — it
    is a *normal* outcome (the element simply never disappeared), NOT an error
    envelope. Transport/session failures still return an ErrEnvelope.
    """
    ok: bool = True  # type: ignore[assignment]  # timed_out → ok=False
    session_id: Optional[str] = Field(None)
    mode:       Optional[str] = Field(None, description="'duration' (fixed sleep) or 'condition' (dynamic wait).")
    condition:  Optional[str] = Field(None, description="visible|hidden|attached|detached|text_contains|text_changes|attribute_changes|count_increases|count_decreases.")
    status:     Optional[str] = Field(None, description="Server outcome for a condition wait: found|hidden|attached|detached|matched|changed|timeout.")
    selector:   Optional[str] = Field(None, description="Resolved Playwright selector used for the wait.")
    via:        Optional[str] = Field(None, description="How the target was resolved on the service: official (by_*/ref) | smart:<strategy> | raw.")
    polled_value: Optional[Any] = Field(None, description="Last value observed while polling ({count, text, attr, visible}) — on a timeout it tells you WHAT the element showed instead.")
    elapsed_ms: Optional[int] = Field(None, description="Wall-clock elapsed time in milliseconds.")
    timed_out:  Optional[bool] = Field(None, description="True iff the condition was not met before max_wait_s (ok=False).")


class PWChainResult(_SuccessBase):
    """Result of pw_chain — multi-step action sequence in one call.

    ``ok`` overrides the base ``Literal[True]``: a chain whose step fails
    returns ``ok=False`` with the per-step ``results`` — an ordinary outcome
    the model must read, NOT an error envelope (audit 2026-09-05 : typé
    ``Literal[True]``, un échec d'étape devenait un ``-32602`` de schéma).
    """
    ok: bool = True  # type: ignore[assignment]  # a failed step → ok=False
    session_id: Optional[str] = Field(None)
    total:      Optional[int] = Field(None, description="Steps requested.")
    executed:   Optional[int] = Field(None, description="Steps actually run (stop_on_error halts the rest).")
    failed:     Optional[int] = Field(None, description="Steps that failed.")
    results:    Optional[List[Dict[str, Any]]] = Field(None, description="Per-step results {step, action, success, duration_ms, …, error?, alternatives?}.")
    page_after: Optional[Dict[str, Any]] = Field(None, description="Lite snapshot of the page after the chain (observe=true).")
    steps:      Optional[List[Dict[str, Any]]] = Field(None, description="Per-step results (legacy alias).")
    completed:  Optional[int] = Field(None)
    failed_at:  Optional[int] = Field(None, description="0-based index of the first failing step (if any).")


class PWMockResult(_SuccessBase):
    """Result of pw_mock — install/remove request mocks for the session."""
    session_id: Optional[str] = Field(None)
    action:     Optional[str] = Field(None)
    mock_id:    Optional[str] = Field(None)
    active_mocks: Optional[int] = Field(None)


class PWRecorderResult(_SuccessBase):
    """Result of pw_recorder — start/stop interaction recording for replay."""
    session_id: Optional[str] = Field(None)
    action:     Optional[str] = Field(None)
    recording:  Optional[bool] = Field(None)
    steps_captured: Optional[int] = Field(None)


class PWObserveResult(_SuccessBase):
    """Result of pw_observe — multi-mode page observation (indexed/ax/som)."""
    session_id: Optional[str] = Field(None)
    mode:       Optional[str] = Field(None, description="indexed | ax | som.")
    url:        Optional[str] = Field(None)
    items:      Optional[List[Dict[str, Any]]] = Field(None, description="Indexed items (mode=indexed/som).")
    count:      Optional[int] = Field(None)
    screenshot_url: Optional[str] = Field(None, description="SoM annotated screenshot (mode=som).")


class PWMemoryResult(_SuccessBase):
    """Result of pw_memory — query the AX memory store (sites/paths/find/credentials)."""
    op:    Optional[str] = Field(None, description="The memory operation that was dispatched.")
    site:  Optional[str] = Field(None)
    sites: Optional[List[Dict[str, Any]]] = Field(None, description="Known sites + stats (op='sites').")
    steps: Optional[List[Dict[str, Any]]] = Field(None, description="Ordered click-path steps (op='path').")
    hits:  Optional[List[Dict[str, Any]]] = Field(None, description="Matches (op='find').")
    count: Optional[int] = Field(None)


class PWA11yResult(_SuccessBase):
    """Result of pw_a11y — WCAG audit (dependency-free in-page checker)."""
    scope:      Optional[str]                  = Field(None, description="CSS scope audited.")
    violations: Optional[List[Dict[str, Any]]] = Field(None, description="Each {rule, impact, selector, message, text} (capped at 100).")
    total:      Optional[int]                  = Field(None, description="Total violation count.")
    truncated:  Optional[bool]                 = Field(None, description="True when `violations` was capped (total > listed).")
    by_impact:  Optional[Dict[str, int]]       = Field(None, description="Counts per impact (serious/moderate).")
    by_rule:    Optional[Dict[str, int]]       = Field(None, description="Counts per rule — proves which checks fired, not just how many.")
    rules_run:  Optional[List[str]]            = Field(None, description="Every rule the checker evaluated (a rule absent from by_rule passed).")
    contrast_sampled: Optional[int]            = Field(None, description="Text nodes sampled by the contrast check.")
    contrast_capped:  Optional[bool]           = Field(None, description="True when the contrast sample hit its cap (page larger than sampled).")
    passed:     Optional[bool]                 = Field(None, description="True if zero violations.")


class PWVisualResult(_SuccessBase):
    """Result of pw_visual — visual regression vs a stored baseline."""
    name:            Optional[str]   = Field(None, description="Baseline name/key.")
    baseline_created:Optional[bool]  = Field(None, description="True if this call just created the baseline (no compare).")
    passed:          Optional[bool]  = Field(None, description="True if diff_ratio <= threshold.")
    diff_ratio:      Optional[float] = Field(None, description="Fraction of differing pixels (0..1).")
    diff_pixels:     Optional[int]   = Field(None, description="Number of differing pixels.")
    threshold:       Optional[float] = Field(None, description="Allowed diff ratio.")
    screenshot_url:  Optional[str]   = Field(None, description="Current screenshot URL.")
    baseline_url:    Optional[str]   = Field(None, description="Baseline screenshot URL.")
    diff_url:        Optional[str]   = Field(None, description="Diff heatmap URL (inspectable by a vision model).")
    size_mismatch:   Optional[bool]  = Field(None, description="True if current and baseline dimensions differ beyond tolerance.")
    pixel_diff_failed: Optional[bool] = Field(None, description="True if diff_ratio exceeded the threshold (independent of size_mismatch).")
    fail_reason:     Optional[str]   = Field(None, description="Why passed=false: 'pixel_diff', 'size_mismatch' or 'pixel_diff+size_mismatch' (null when passed).")
    dims:            Optional[Dict[str, Any]] = Field(None, description="{baseline:{w,h}, current:{w,h}}.")


# ────────────────────────────────────────────────────────────────────
#  skill_tools — skill_save: persist a learned procedural skill
# ────────────────────────────────────────────────────────────────────

class AskUserResult(_SuccessBase):
    """Result of ask_user — interactive questionnaire displayed above the user's prompt bar."""
    displayed: bool = Field(True, description="The questionnaire panel was shown to the user.")
    count:     int  = Field(..., description="Number of questions displayed.")
    note:      str  = Field(..., description="How the model must end its turn (do not repeat the questions).")
    # Audit « limites fantômes » 2026-07-31 — les bornes (8 questions, 12
    # options, 300 c) étaient appliquées EN SILENCE : le modèle croyait avoir
    # posé 10 questions et attendait 10 réponses.
    warning:   Optional[str] = Field(None, description="Set when the input was clipped (extra questions/options dropped, long text cut) — tell the user what was left out.")

class SkillSaveResult(_SuccessBase):
    """Result of skill_save — a PERSONAL skill written to the caller's sandbox."""
    name:        str = Field(..., description="Slugified skill name (filename stem).")
    path:        str = Field(..., description="Absolute host path of the saved skill file.")
    source:      Literal["user", "learned", "global"] = Field("user", description="Storage scope of the saved skill — 'user' (personal sandbox) for skill_save.")
    domain:      Optional[str] = Field(None, description="Applicative domain subfolder (e.g. 'jenkins'), '' if at the scope root.")
    description: Optional[str] = Field(None, description="Echoed description.")
    tags:        Optional[List[str]] = Field(None, description="Echoed tags.")
    note:        Optional[str] = Field(None, description="Human-readable hint (e.g. how to promote).")



class SkillGetResult(_SuccessBase):
    """Result of skill_get — the full body of a known skill, loaded on demand."""
    name:        str = Field(..., description="Skill name (as listed in the skills index).")
    body:        str = Field(..., description="The full procedure markdown (the steps to follow).")
    description: Optional[str] = Field(None, description="One-line description of the skill.")
    domain:      Optional[str] = Field(None, description="Applicative domain (e.g. 'jenkins'), '' if none.")
    tags:        Optional[List[str]] = Field(None, description="Skill tags.")
    source:      Optional[str] = Field(None, description="Storage scope it was resolved from (user|global).")
    is_folder:   bool = Field(False, description="True if this is an Agent Skill (a directory bundling scripts/references/assets).")
    files:       Optional[List[str]] = Field(None, description="Bundled files (paths relative to the skill directory): scripts/, references/, assets/…. Read one with skill_read_file(name, path); run a script with skill_run_script(name, script).")
    sandbox_path: Optional[str] = Field(None, description="Deprecated, always null: skills are NO LONGER on the sandbox filesystem. Use skill_read_file / skill_run_script to read or execute bundled files.")


class SkillFileResult(_SuccessBase):
    """Result of skill_read_file — the content of one bundled file of a skill."""
    name:      str = Field(..., description="Skill name.")
    path:      str = Field(..., description="Bundled file path (relative to the skill directory).")
    content:   str = Field(..., description="UTF-8 text content of the file.")
    size:      int = Field(..., description="File size in bytes.")
    truncated: bool = Field(False, description="True if the content was capped to the size limit.")


class SkillRunResult(_SuccessBase):
    """Result of skill_run_script — execution of a bundled script in the sandbox container."""
    # Override the _SuccessBase Literal[True]: ``ok`` reflects the script's exit
    # code (rc==0), mirroring execute_shell — a crashed/timed-out run is ok=False.
    ok:         bool = Field(True, description="True iff the script exited 0 (rc==0).")
    name:       str = Field(..., description="Skill name.")
    script:     str = Field(..., description="Bundled script path executed (relative to the skill directory).")
    returncode: int = Field(..., description="Script exit code (0 = success).")
    stdout:     str = Field("", description="Captured standard output (possibly truncated).")
    stderr:     str = Field("", description="Captured standard error (possibly truncated).")
    truncated:  bool = Field(False, description="True if stdout/stderr was capped to the output limit.")
    note:       Optional[str] = Field(None, description="Human-readable hint.")


__all__ = [
    # Common
    "_SuccessBase", "ErrEnvelope",
    # fs_tools
    "ReadFileSingle", "ReadFileBatch", "ReadFileResult",
    "WriteFileResult",
    "EditFileResult",
    "FileEntry", "ListFilesResult",
    "ManageFilesResult",
    "StatPathResult",
    "CodeOutlineEntry", "CodeOutlineResult",
    "CodeNavigateResult",
    # shell_tools
    "ExecuteShellResult",
    # git_tools
    "GitQueryResult", "GitWriteResult", "GitActionResult", "GitRfResult",
    "GitInspectResult", "GitStartWorkResult", "GitCommitResult",
    "GitSubmitResult", "GitAbandonResult", "GitCloneResult",
    # chart_tools
    "GenerateChartResult", "GenerateTableResult",
    # skill_tools
    "AskUserResult",
    "SkillSaveResult", "SkillGetResult", "SkillFileResult", "SkillRunResult",
    # firefox_tools
    "PWSessionResult", "PWFindResult", "PWActResult", "PWPageResult",
    "PWExpectResult", "PWChainResult", "PWMockResult", "PWRecorderResult",
    "PWObserveResult", "PWMemoryResult", "PWA11yResult", "PWVisualResult",
]
