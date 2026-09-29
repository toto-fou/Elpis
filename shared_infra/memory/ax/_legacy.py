# SPDX-License-Identifier: MIT
"""
backend.ax_memory._legacy — Compatibility shim.

Why this file still exists
--------------------------
Historically every consumer of ax_memory imported from
``backend.ax_memory`` (the package facade), so this shim is mostly here
for any straggler caller that did
``from backend.ax_memory._legacy import …``.

The implementation lives in dedicated sibling modules now:

  * ``_connection``  — SQLite plumbing (set_db_path, _resolve_db_path, _conn)
  * ``init``         — init_db (table creation, idempotent)
  * ``urls``         — normalize_url, site aliases, dedup heuristics
  * ``selectors``    — selector serialisation + ranking
  * ``actions``      — record_action, record_inspection, region inference
  * ``tree``         — load_tree, load_dom_tree, get_tree_json
  * ``sites``        — site CRUD + stats + wipe
  * ``transitions``  — page-transition graph + BFS paths
  * ``rendering``    — windowed / full / focused DOM prompt rendering
  * ``credentials``  — per-site credential storage
  * ``detection``    — site + session-URL auto-detection

Every name re-exported below was importable from
``backend.ax_memory._legacy`` before this split. Nothing is genuinely
defined here anymore.
"""
from __future__ import annotations

# ── Module logger (callers like credentials.py expect ``log`` here) ──
import logging  # noqa: E402

# ── Module-level mutable state (owned by _connection) ──
from shared_infra.memory.ax._connection import (  # noqa: F401
    _DB_LOCK,
    _DB_PATH,
    _conn,
    _resolve_db_path,
    set_db_path,
)

log = logging.getLogger(__name__)  # noqa: F401

# ── Database init ──
# ── Actions ──
from shared_infra.memory.ax.actions import (  # noqa: F401
    _get_or_create_region,
    _resolve_ancestor_chain,
    infer_region,
    is_action_success,
    record_action,
    record_inspection,
)
from shared_infra.memory.ax.init import init_db  # noqa: F401

# ── Rendering ──
from shared_infra.memory.ax.rendering import (  # noqa: F401
    _collect_ancestors,
    _collect_descendants,
    _find_node_by_path_and_context,
    _render_credentials_hint,
    _render_dom_subtree,
    _render_selector,
    render_focused_dom_for_prompt,
    render_for_prompt,
    render_full_dom_for_prompt,
    render_site_contextual,
    render_windowed_for_prompt,
)

# ── Selectors ──
from shared_infra.memory.ax.selectors import (  # noqa: F401
    _top_selectors,
    extract_selectors_from_kwargs,
    node_key,
)

# ── Site CRUD ──
from shared_infra.memory.ax.sites import (  # noqa: F401
    delete_site,
    delete_sites_bulk,
    get_site_stats,
    list_sites,
    list_sites_with_stats,
    mark_site_stale,
    wipe_all,
)

# ── Transitions ──
from shared_infra.memory.ax.transitions import (  # noqa: F401
    _bfs_paths,
    _build_adjacency,
    load_transitions,
)

# ── Tree dumps ──
from shared_infra.memory.ax.tree import (  # noqa: F401
    get_tree_json,
    load_dom_tree,
    load_tree,
)

# ── URL normalisation / site aliases ──
from shared_infra.memory.ax.urls import (  # noqa: F401
    _load_site_aliases,
    _normalize_site,
    _should_dedup_any_ip,
    normalize_url,
)
