# SPDX-License-Identifier: MIT
"""
backend.ax_memory.detection — Auto-detection of sites from user text
and Playwright session URL resolution.

Two entry points used by the chat orchestration (``backend.services``) to
decide when to inject site-specific accessibility memory into the prompt.

- :func:`detect_sites_from_text` — extract normalized site identifiers
  from arbitrary user text (regex over ``https?://…`` URLs).
- :func:`detect_session_url` — scan the last few tool results for a
  Playwright ``session_id``, then query the local Node service on
  ``/smart_inspect`` to get the current page URL. Best-effort; returns
  ``None`` silently on any failure.
"""
from __future__ import annotations

import re
from typing import Optional

from shared_infra.memory.ax._legacy import normalize_url


def detect_sites_from_text(text: str) -> list[str]:
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for url in re.findall(r'https?://[^\s"\'<>`]+', text):
        site, _ = normalize_url(url)
        if site and site not in seen:
            seen.add(site)
            out.append(site)
    return out


def detect_session_url(messages: list) -> Optional[str]:
    """
    Recherche dans les messages (tool_results) un session_id Playwright actif
    et recupere son URL courante via le service Node.

    Retourne l'URL ou None. Best-effort : si le service n'est pas accessible,
    ou si pas de session trouvee, retourne None.
    """
    if not messages:
        return None

    # Cherche le dernier session_id dans les tool results
    session_id: Optional[str] = None
    try:
        for m in reversed(messages[-40:]):
            content = m.get("content") or ""
            if not isinstance(content, str):
                continue
            # Format typique : "session_id":"abc123..."
            match = re.search(r'"session_id"\s*:\s*"([a-zA-Z0-9_-]{6,})"',
                              content)
            if match:
                session_id = match.group(1)
                break
    except Exception:
        return None

    if not session_id:
        return None

    # Requete au service Node Playwright pour recuperer l'URL
    try:
        import os as _os
        import urllib.request
        import json as _json
        node_api = _os.environ.get("PLAYWRIGHT_API_URL",
                                   "http://localhost:3000")
        req = urllib.request.Request(
            f"{node_api}/smart_inspect?session_id={session_id}",
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
            return data.get("url") or data.get("current_url")
    except Exception:
        return None
