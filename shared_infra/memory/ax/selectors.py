# SPDX-License-Identifier: MIT
"""
Selector serialisation, ranking, and per-node retrieval.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Function bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
import re
import sqlite3

from shared_infra.db._dialect import cast_float, greatest

log = logging.getLogger(__name__)



# ── Constants used by selector helpers ───────────────────────────────
_WS = re.compile(r"\s+")

# Strategy ranking — lower number = higher priority. Used by _top_selectors
# to decide which selector to show the LLM first when several variants
# exist for the same node.
STRATEGY_PRIORITY = {
    "test_id":     0,
    "ref":         1,
    "role_name":   2,
    "label":       3,
    "placeholder": 4,
    "css":         5,
    "text":        6,
    "xpath":       7,
}


def node_key(role: str, name: str) -> str:
    role_s = (role or "generic").strip().lower()
    name_s = _WS.sub(" ", (name or "").strip()).lower()
    if len(name_s) > 80:
        name_s = name_s[:80]
    return f"{role_s}:{name_s}"


# ---------------------------------------------------------------------------
# Selecteurs : strategies supportees et extraction
# ---------------------------------------------------------------------------

STRATEGY_PRIORITY = {
    "test_id":     0,
    "ref":         1,
    "role_name":   2,
    "label":       3,
    "placeholder": 4,
    "css":         5,
    "text":        6,
    "xpath":       7,
}
def extract_selectors_from_kwargs(kw: dict) -> list[tuple[str, str]]:
    """
    Extrait les selecteurs passes a pw_act/pw_find sous forme de
    [(strategy, value), ...]. Ignore les strategies vides/None.
    """
    out: list[tuple[str, str]] = []
    role = (kw.get("role") or "").strip()
    name = (kw.get("name") or "").strip()
    if role and name:
        out.append(("role_name", f"{role}|{name}"))
    elif role:
        out.append(("role_name", f"{role}|"))

    for strat, key in [
        ("test_id",     "test_id"),
        ("label",       "label"),
        ("placeholder", "placeholder"),
        ("css",         "css"),
        ("xpath",       "xpath"),
        ("text",        "text"),
    ]:
        v = (kw.get(key) or "").strip()
        if v:
            out.append((strat, v))
    return out


# ---------------------------------------------------------------------------
# Region detection (heuristique simple, pas de DOM scraping)
# ---------------------------------------------------------------------------

_KNOWN_REGIONS = {
    "header", "nav", "main", "aside", "footer", "form",
    "dialog", "menu", "toolbar", "banner", "complementary",
    "contentinfo", "search", "navigation",
}
def _top_selectors(c: sqlite3.Connection, node_id: int,
                   limit: int = 3) -> list[dict]:
    """Retourne les N meilleurs selecteurs pour un noeud, tri par score."""
    rows = c.execute(f"""
        SELECT strategy, value, success_count, failure_count
          FROM ax_selectors
         WHERE node_id = ?
         ORDER BY
            ({cast_float("success_count")}
             / {greatest("success_count + failure_count", "1")}) DESC,
            success_count DESC,
            strategy ASC
         LIMIT ?
    """, (node_id, limit)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Public API : record_action
# ---------------------------------------------------------------------------
