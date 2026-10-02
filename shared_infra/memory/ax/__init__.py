# SPDX-License-Identifier: MIT
"""
shared_infra.memory.ax — Package façade.

The public import surface is the union of the submodules below: every
module-level name (public *and* private/underscore-prefixed) of each
submodule is importable from here.

Layout
======

  ``_connection.py`` → SQLite plumbing (set_db_path, _resolve_db_path, _conn)
                        + module-level ``_DB_LOCK`` / ``_DB_PATH``.
  ``init.py``        → ``init_db()`` — table creation, idempotent.
  ``urls.py``        → URL normalisation + site aliases + dedup heuristics.
  ``selectors.py``   → selector serialisation, ranking, per-node retrieval.
  ``actions.py``     → ``record_action``, ``record_inspection``, region
                        inference, ancestor-chain resolver.
  ``tree.py``        → tree dumps for admin/debug.
  ``sites.py``       → site CRUD + stats + delete/wipe.
  ``transitions.py`` → page-transition graph + BFS paths.
  ``rendering.py``   → prompt rendering (windowed / full / focused DOM).
  ``credentials.py`` → per-site credential storage.
  ``detection.py``   → site + session-URL auto-detection.
  ``_legacy.py``     → thin compat shim re-exporting every name above.

Public import contract (must stay stable)
-----------------------------------------
Known external callers:

- ``server/app.py``,
  ``server/local_mcp_server.py``      : ``init_db``
- ``shared_infra/memory/routes_ax.py`` (``/api/ax/*``) :
                                        ``list_sites_with_stats``,
                                        ``get_site_stats``, ``get_tree_json``,
                                        ``render_full_dom_for_prompt``,
                                        ``mark_site_stale``, ``delete_site``,
                                        ``delete_sites_bulk``,
                                        ``delete_credentials``, ``wipe_all``
- ``llm_core/context/assembly.py``    : ``detect_sites_from_text``,
                                        ``detect_session_url``,
                                        ``render_site_contextual``,
                                        ``normalize_url``
- ``llm_core/tools/firefox_tools.py`` : ``record_action``, ``record_inspection``,
                                        ``get_credentials``, ``save_credentials``,
                                        ``list_sites_with_stats``, ``find_path``,
                                        ``search_nodes``, ``load_dom_tree``
"""

# ─────────────────────────────────────────────────────────────────────────────
# Submodule loading order — _connection FIRST (it owns the module-level
# DB-path globals everyone else reads), then the leaf domain modules,
# then the auxiliary modules (credentials, detection), then the shim.
# ─────────────────────────────────────────────────────────────────────────────
from shared_infra.memory.ax import _connection   # noqa: F401 — SQLite plumbing
from shared_infra.memory.ax import init          # noqa: F401 — init_db
from shared_infra.memory.ax import urls          # noqa: F401 — URL normalisation
from shared_infra.memory.ax import selectors     # noqa: F401 — selector helpers
from shared_infra.memory.ax import actions       # noqa: F401 — record_action / inspection
from shared_infra.memory.ax import tree          # noqa: F401 — tree dumps
from shared_infra.memory.ax import sites         # noqa: F401 — site CRUD
from shared_infra.memory.ax import transitions   # noqa: F401 — transition graph
from shared_infra.memory.ax import rendering     # noqa: F401 — prompt rendering
from shared_infra.memory.ax import credentials   # noqa: F401 — per-site credentials
from shared_infra.memory.ax import detection     # noqa: F401 — site / session-URL detection
from shared_infra.memory.ax import _legacy       # noqa: F401 — thin compat shim

_SUBMODULES = (_connection, init, urls, selectors, actions, tree, sites,
               transitions, rendering, credentials, detection, _legacy)


# Full-fidelity re-export of every module-level symbol (incl. underscored).
for _mod in _SUBMODULES:
    for _name in dir(_mod):
        if _name.startswith("__"):
            continue
        globals()[_name] = getattr(_mod, _name)

try:
    del _mod, _name
except NameError:
    pass
