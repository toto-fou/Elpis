# SPDX-License-Identifier: MIT
# tools/chart_tools.py
"""
Graphiques — un outil par type (``chart_bar``, ``chart_heatmap``, ``chart_gantt``…),
rendu par Apache ECharts dans le chat.

Le modèle donne un tableau de lignes (``data``) et, au besoin, les colonnes
qui jouent un rôle (``x``, ``y``, ``group``…). Le moteur ``_chart`` construit
l'option ECharts (JSON pur), la sauvegarde et rend une référence ``!id`` que
l'interface affiche. Chaque outil n'expose que les options de son type :
schémas courts, ``enum`` imposés par la grammaire de llama.cpp, validation
permissive côté serveur pour que la lecture tolérante rattrape le reste
(casse, synonymes, « 1 234,5 € », CSV, colonnes mal nommées…).

Banc ornith-1.5-9B (2026-10-04) : 28/28 graphiques justes au 1er appel contre
16/28 avec les quatre outils Chart.js précédents (et une boucle de 6 refus).

Outils : chart_<type> pour les 30 types de ``_chart.PER_TYPE`` (dont
``chart_table``, qui remplace ``generate_table``) ; ressource ``chart://``.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import tempfile
from pathlib import Path
from typing import Annotated, Any, Dict, Union

from fastmcp import Context, FastMCP
from pydantic import Field

from ._chart import PARAM_DEFAULTS, PARAM_SCHEMAS, PER_TYPE, run_chart, tool_description
from ._models import ChartResult, ErrEnvelope
from ._toolkit import (
    err,
    get_chat_id,
    get_username,
    ok,
    tag_kw,
    tool_kw_idempotent,
)

# ── Category descriptor (see fs_tools.CATEGORY for the contract) ──────
CATEGORY = {
    "name":  "chart",
    "label": "Graphiques",
    "icon":  "ph-chart-bar",
    "color": "emerald",
    # No "tools" list — captured automatically at registration time.
}

# Same args → same option → same cached file: idempotent.
_TOOL_KW_IDEMP = tool_kw_idempotent(CATEGORY)

# Size guards — a model (or a compromised upstream) can emit a huge table that
# both janks the browser AND gets embedded DURABLY into every chat save.
MAX_ROWS = max(1, int(os.environ.get("TOOL_CHART_MAX_ROWS", "10000") or 10000))
MAX_CELLS = max(1, int(os.environ.get("TOOL_CHART_MAX_CELLS", "60000") or 60000))


# ── Chart persistence: store the config, hand the model a tiny ref ───
# Instead of returning the full ECharts option for the model to copy into
# its reply (0.5-2k tokens of context, and JSON it can mangle), each
# chart_<type> tool SAVES the option and returns a short ``!id`` ref. The
# chat UI fetches the option from /api/charts/{id} and renders it.
# Content-addressed (sha1 of the option) so the same chart is never stored twice.
def _safe_username(username):
    return "".join(c for c in (username or "") if c.isalnum() or c in "-_") or "guest"


# ── Droits du cache (L4.6) ───────────────────────────────────────────────
# Le cache vit hors de la sandbox (``/tmp`` partagé), écrit par l'hôte
# d'outils et relu par l'app, sous le MÊME compte de service : privé
# (0700 / 0600). Il était élargi à 0777 / 0666 du temps où le conteneur
# (autre UID) le partageait. Best-effort : un chmod refusé (chemin d'un autre
# compte) ne masque jamais le résultat de l'écriture.
def _chmod_cross_writable(p: Path, is_dir: bool = False) -> None:
    try:
        # SÉCURITÉ : ``os.chmod`` déréférence les symlinks.
        if os.path.islink(p):
            return
        os.chmod(p, 0o700 if is_dir else 0o600)
    except OSError:
        pass


# ── Chart cache location: /tmp, NOT the sandbox ──────────────────────────
# Charts are a TRANSIENT cache. chart_<type> writes the option here and
# hands the model `!id`; at chat-save time embed_chart_configs() copies the
# config DURABLY into the conversation row (DB), after which this file is
# disposable. Writing under the per-user Docker sandbox mount
# (-v <sandbox>:/work) caused cross-UID PermissionError (host tool process
# vs container UID 10001) AND polluted the sandbox. We therefore write to a
# host-local temp dir, outside the mount: no UID conflict, no pollution, and
# /tmp being cleared on reboot is harmless (the durable copy lives in the DB).
# Override the base with CHART_CACHE_DIR if /tmp is unsuitable.
#
# MUST stay mirrored with shared_infra/charts/routes.py::_charts_dir — both
# the writer (here) and the reader/embedder (route) have to agree on the path.
def _charts_base() -> Path:
    return Path(os.environ.get("CHART_CACHE_DIR")
                or (Path(tempfile.gettempdir()) / "elpis_charts"))


def _charts_dir(username, root_base=None):
    # ``root_base`` kept for signature back-compat; no longer used (charts no
    # longer live under the sandbox). Path: <tmp>/elpis_charts/<username>/.
    base = _charts_base()
    d = base / _safe_username(username)
    d.mkdir(parents=True, exist_ok=True)
    # /tmp is shared; widen so a second host process (e.g. the FastAPI worker
    # embedding configs) under a different umask can still read/replace.
    _chmod_cross_writable(base, is_dir=True)
    _chmod_cross_writable(d, is_dir=True)
    return d


# How many config files to keep in a user's .charts/ cache. This is only
# a CACHE bound: every chart is also embedded durably into the chat that
# references it (see backend/routes/charts.py), so pruning here never
# makes a chart vanish from a conversation — it just means a cache miss
# that the /api/charts endpoint serves from the saved chat instead.
# Raise it on a busy multi-user instance via the env var.
_CHART_CACHE_MAX = max(50, int(os.environ.get("TOOL_CHART_CACHE_MAX", "1000") or 1000))


def _prune_charts(d, keep=None):
    """Bound the .charts/ directory - drop the oldest configs past `keep`."""
    if keep is None:
        keep = _CHART_CACHE_MAX
    try:
        files = sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime)
        for p in files[:-keep]:
            try:
                p.unlink()
            except OSError:
                pass
    except OSError:
        pass


def _save_chart_config(cfg, username, root_base=None):
    """Persist a chart option, return its short content-hash id.

    ``root_base`` is accepted for signature back-compat (the register()
    closure still passes it) but is IGNORED — charts now live in a host-local
    temp dir, not under the sandbox. See _charts_dir.

    Raises ``OSError`` (cleaned up, no stale tmp) if the cache dir is not
    writable / disk full — the caller turns it into a user-facing error
    envelope rather than a raw 500.
    """
    # allow_nan=False backstop: NaN/Infinity would serialize as bare NaN/Infinity
    # tokens (invalid JSON) that the browser's JSON.parse rejects → silent 404/error.
    # Validation already rejects these in user data; this guards composite arithmetic.
    payload = json.dumps(cfg, ensure_ascii=False, sort_keys=True, allow_nan=False)
    chart_id = hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]
    d = _charts_dir(username, root_base)
    path = d / f"{chart_id}.json"
    if not path.exists():
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(cfg, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            # Clean up a half-written tmp so the dir doesn't accumulate
            # cruft, then let the caller surface a clear message.
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        # Relax the new file so the container-UID can read it too (and a
        # later same-id rewrite from either side overwrites cleanly).
        _chmod_cross_writable(path, is_dir=False)
        _prune_charts(d)
    return chart_id


# ── Registration ─────────────────────────────────────────────────────────────

def _param_annotation(name: str) -> Any:
    """Schéma annoncé au modèle (enum, lignes typées) mais validation PERMISSIVE :
    la lecture tolérante de ``_chart`` corrige « Stacked », un CSV, un dict…"""
    if name in ("horizontal", "show_values", "trend"):
        return bool
    schema = dict(PARAM_SCHEMAS[name])
    desc = schema.pop("description", None)
    return Annotated[Any, Field(json_schema_extra=schema, description=desc)]


def _too_big(data: Any) -> bool:
    if not isinstance(data, list):
        return False
    if len(data) > MAX_ROWS:
        return True
    return sum(len(r) for r in data if isinstance(r, dict)) > MAX_CELLS


def register(mcp: FastMCP, root_base) -> None:

    def _finish(kind: str, args: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
        username = get_username(ctx)
        session = f"{username}:{get_chat_id(ctx)}"
        if _too_big(args.get("data")):
            return err("invalid_chart_spec",
                       f"data is too large (max {MAX_ROWS} rows / {MAX_CELLS} cells)",
                       fix="Aggregate or downsample the rows before charting.")
        result, option, drawn = run_chart({"type": kind, **args}, session=session)
        if not result.get("ok"):
            return result
        try:
            chart_id = _save_chart_config(option, username, root_base)
        except ValueError:
            # allow_nan=False backstop: a non-finite number reached the serializer.
            return err("invalid_chart_spec", "chart contains non-finite numbers (NaN/Infinity)",
                       fix="All numeric values must be finite.")
        except OSError as e:
            return err("chart_write_failed", f"Could not save the chart: {e}",
                       fix="Retry; if it persists, an admin should check that the chart "
                           "cache directory is writable by the tool process.")
        return ok(ref=f"!{chart_id}", chart_id=chart_id, **{k: v for k, v in result.items() if k != "ok"})

    def _make_tool(kind: str):
        _, _, opts = PER_TYPE[kind]

        def tool(ctx: Context, **kwargs: Any) -> Dict[str, Any]:
            # Seuls les arguments réellement donnés partent au moteur (les valeurs
            # par défaut produiraient des « corrections » parasites).
            args = {k: v for k, v in kwargs.items()
                    if not (k in PARAM_DEFAULTS and v == PARAM_DEFAULTS[k]) and v is not None}
            return _finish(kind, args, ctx)

        P = inspect.Parameter
        params = [P("ctx", P.POSITIONAL_OR_KEYWORD, annotation=Context),
                  P("data", P.KEYWORD_ONLY, annotation=_param_annotation("data")),
                  P("title", P.KEYWORD_ONLY, default="", annotation=str)]
        for name in opts:
            params.append(P(name, P.KEYWORD_ONLY, default=PARAM_DEFAULTS[name],
                            annotation=_param_annotation(name)))
        ret = Union[ChartResult, ErrEnvelope]
        # Signature EXPLICITE (objets de type, pas de chaînes) : FastMCP en tire le
        # schéma et n'évalue aucune annotation différée de closure.
        tool.__signature__ = inspect.Signature(params, return_annotation=ret)  # type: ignore[attr-defined]
        tool.__annotations__ = {p.name: p.annotation for p in params} | {"return": ret}
        tool.__name__ = f"chart_{kind}"
        tool.__qualname__ = f"chart_{kind}"
        tool.__doc__ = tool_description(kind)
        return tool

    for _kind in PER_TYPE:
        mcp.tool(name=f"chart_{_kind}", **_TOOL_KW_IDEMP)(_make_tool(_kind))

    # ── Resource: a stored chart option by id ────────────────────────
    # Lets an MCP client (e.g. the agentic pipeline) fetch a chart by id
    # instead of carrying the option in context.
    @mcp.resource("chart://{username}/{chart_id}",
                  mime_type="application/json", **tag_kw(CATEGORY))
    def chart_resource(username: str, chart_id: str) -> str:
        """A previously generated chart option (ECharts), as JSON."""
        safe_id = "".join(c for c in (chart_id or "") if c.isalnum())
        path = _charts_dir(username, root_base) / f"{safe_id}.json"
        if not path.is_file():
            return json.dumps({"ok": False, "error": "chart_not_found",
                               "chart_id": chart_id})
        return path.read_text(encoding="utf-8")
