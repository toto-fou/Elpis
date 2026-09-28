# SPDX-License-Identifier: MIT
"""
backend.routes.charts — REST surface + durability for chart references.

Mirrors ``tools/chart_tools.py``. When the LLM calls ``generate_chart``,
the tool SAVES the Chart.js config and hands the model a short
``chart_id``; the model emits a ``\u200b```chart-ref`` block with only that id,
and the chat UI fetches the real config here. This keeps the model's
context (and its own output) tiny instead of carrying 0.5-2k tokens of
JSON it could mangle.

Durability — why a chart never disappears from an old chat
----------------------------------------------------------
``generate_chart`` writes the config to a per-user *cache* in a host-local
temp dir (NOT the sandbox — that caused cross-UID PermissionError vs the
Docker container and polluted the sandbox):

    {tempdir}/elpis_charts/{username}/{chart_id}.json   (override: CHART_CACHE_DIR)

That cache is bounded (``TOOL_CHART_CACHE_MAX``) and ephemeral (cleared on
reboot). If that were the only copy, a chart referenced by a months-old
conversation would silently 404.

So the config is also **embedded into the chat itself**: every time a
chat is saved, ``embed_chart_configs()`` attaches each referenced config
to its message under ``message["charts"]``. ``messages_json`` already
stores arbitrary message fields (same mechanism as ``tool_history``), so
the config travels with the conversation for as long as it exists. The
GET endpoint tries the cache first (fast path) and falls back to the
durable copy embedded in the saved chat. The embed is *monotonic*:
configs already embedded are preserved on re-save even if the cache
file is gone by then.

Endpoint
--------
- GET /api/charts/{chart_id}?chat_id=...  — read one config (chat owner only)
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from pathlib import Path

logger = logging.getLogger("uvicorn.error")

from fastapi import HTTPException, Request

from shared_infra.security.deps import require_user_id
from shared_infra.accounts.users import get_username_by_id
from shared_infra.chat.store import get_chat
from shared_infra.routes._state import router


# ── Path helpers (mirror tools/chart_tools.py exactly) ───────────────
def _safe_username(username: str) -> str:
    return "".join(c for c in (username or "") if c.isalnum() or c in "-_") or "guest"


def _safe_chart_id(chart_id: str) -> str:
    """chart_id is produced as sha1(config)[:12] — pure lowercase hex.
    Strip anything else defensively so a manipulated path component can
    never escape the .charts/ directory."""
    return "".join(c for c in (chart_id or "") if c.isalnum())


def _charts_dir(username: str) -> Path:
    # MUST stay mirrored with llm_core/tools/chart_tools.py::_charts_dir —
    # charts now live in a host-local temp dir, not the sandbox (avoids the
    # cross-UID PermissionError vs the Docker container, and stops polluting
    # the sandbox). The durable copy is embedded in the chat row at save time.
    base = Path(os.environ.get("CHART_CACHE_DIR")
                or (Path(tempfile.gettempdir()) / "elpis_charts"))
    return base / _safe_username(username)


def _chart_path(username: str, chart_id: str) -> Path:
    return _charts_dir(username) / f"{_safe_chart_id(chart_id)}.json"


def _resolve_username(request: Request) -> str:
    """Same contract as routes/memory.py — see that file for the 500-vs-401
    rationale when the user record is missing for a valid session."""
    uid = require_user_id(request)
    name = get_username_by_id(uid)
    if not name:
        raise HTTPException(500, "user record missing for authenticated session")
    return name


# ── Durability: embed chart configs into the saved conversation ──────
# A chart reference appears in the model's reply in one of two forms:
#   • the one-token handle generate_chart hands back:   !<chart_id>
#   • a legacy fenced block (still accepted):  ```chart-ref\n<id>\n```
# chart_id is sha1(config)[:12] — exactly 12 hex chars.
_CHART_REF_RE = re.compile(
    r"```chart-ref\s*[\r\n]+\s*([0-9a-fA-F]{6,32})\s*[\r\n]*```"
    r"|!([0-9a-fA-F]{12})\b",
    re.MULTILINE,
)


def _scan_chart_ref_ids(text) -> set:
    """Return every chart_id referenced (either form) by `text`."""
    if not text or not isinstance(text, str):
        return set()
    out = set()
    for m in _CHART_REF_RE.finditer(text):
        cid = m.group(1) or m.group(2)
        if cid:
            out.add(cid.lower())
    return out


def _harvest_embedded(messages) -> dict:
    """Collect every config already embedded in a message list → {id: config}."""
    out = {}
    if not isinstance(messages, list):
        return out
    for m in messages:
        charts = m.get("charts") if isinstance(m, dict) else None
        if isinstance(charts, dict):
            for cid, cfg in charts.items():
                if cfg is not None:
                    out[str(cid).lower()] = cfg
    return out


def embed_chart_configs(user_id: int, chat_id: str, messages):
    """Attach every referenced Chart.js config to its message in place,
    so the chart survives ``.charts/`` cache pruning.

    Called on the chat-save paths just before ``upsert_chat``. Monotonic:
    a config already embedded in the saved version of this chat is kept
    even if its cache file has since been pruned — once durable, always
    durable. Best-effort: a missing config is simply skipped, never an
    error (saving the chat must not fail because of a chart).
    """
    if not isinstance(messages, list) or not messages:
        return messages

    per_msg = []
    all_ids = set()
    for m in messages:
        ids = _scan_chart_ref_ids(m.get("content", "")) if isinstance(m, dict) else set()
        per_msg.append(ids)
        all_ids |= ids
    if not all_ids:
        return messages

    # 1. configs already embedded in the previously-saved version (durable)
    try:
        prev = get_chat(user_id, chat_id)
        resolved = _harvest_embedded(prev.get("messages")) if prev else {}
    except Exception:
        resolved = {}
    # 2. anything still missing → read from the .charts/ cache
    missing = all_ids - set(resolved)
    if missing:
        try:
            username = get_username_by_id(user_id) or "guest"
        except Exception:
            username = "guest"
        cdir = _charts_dir(username)
        for cid in missing:
            p = cdir / f"{_safe_chart_id(cid)}.json"
            if p.is_file():
                try:
                    resolved[cid] = json.loads(p.read_text(encoding="utf-8"))
                except Exception as e:
                    # Cache corrompu : on retombe sur la copie durable embarquée,
                    # mais on TRACE (sinon une corruption disque passe inaperçue).
                    logger.warning("[charts] cache illisible %s : %s", p.name, e)

    # attach per message (merge with anything already present, defensively)
    for m, ids in zip(messages, per_msg):
        if not ids or not isinstance(m, dict):
            continue
        embedded = {cid: resolved[cid] for cid in ids if cid in resolved}
        if not embedded:
            continue
        existing = m.get("charts")
        if isinstance(existing, dict):
            merged = dict(existing)
            merged.update(embedded)
            m["charts"] = merged
        else:
            m["charts"] = embedded
    return messages


# ─────────────────────────────────────────────────────────────────────
#  ENDPOINT
# ─────────────────────────────────────────────────────────────────────
@router.get("/api/charts/{chart_id}")
def api_chart_get(chart_id: str, request: Request, chat_id: str = ""):
    """Return one Chart.js config by id. The chat UI calls this when it
    renders a ```chart-ref``` block.

    Resolution order:
      1. the per-user .charts/ cache  (fast path, fresh charts)
      2. the durable copy embedded in the saved chat  (survives pruning)
         — only consulted when ``chat_id`` is supplied (O(1) row fetch).

    404 only when the config is in neither place (e.g. a pre-feature
    chart whose cache file was already pruned)."""
    username = _resolve_username(request)
    safe_id = _safe_chart_id(chart_id)
    if not safe_id:
        raise HTTPException(400, "invalid chart_id")

    # 1. cache (fast path)
    p = _chart_path(username, safe_id)
    if p.is_file():
        try:
            return {"ok": True, "chart_id": safe_id,
                    "config": json.loads(p.read_text(encoding="utf-8")),
                    "source": "cache"}
        except Exception as e:
            logger.warning("[charts] cache illisible %s : %s — repli copie durable", p.name, e)
            # corrupt cache file → try the durable copy

    # 2. durable copy embedded in the saved chat
    if chat_id:
        uid = require_user_id(request)
        try:
            chat = get_chat(uid, chat_id)
        except Exception:
            chat = None
        if chat:
            for m in chat.get("messages", []):
                charts = m.get("charts") if isinstance(m, dict) else None
                if isinstance(charts, dict) and safe_id in charts:
                    return {"ok": True, "chart_id": safe_id,
                            "config": charts[safe_id], "source": "chat"}

    raise HTTPException(404, f"chart '{safe_id}' not found")
