# SPDX-License-Identifier: MIT
"""
backend.services._rag_client
============================
Thin HTTP/SSE client that talks to the standalone ``rag_app`` service.

Why this module exists
----------------------
Before this refactor, the chatbot imported ``rag_app.rag_query`` directly
and called Qdrant/Embeddings in-process. That created hard coupling:

* the chatbot couldn't be deployed without the entire ``rag_app/`` source
  tree, including its Qdrant binary and embedding caches;
* multi-tenant isolation was impossible — every chatbot pod had to ship
  the same RAG model;
* failures in the RAG layer (slow embedding, locked Qdrant) blocked the
  chatbot's event loop.

Now ``rag_app`` is a regular HTTP service (the existing FastAPI on :8000)
exposing five SSE-streamed tool endpoints under ``/api/tools/*``. This
module wraps those calls with sane timeouts, optional bearer auth, and
a tiny SSE parser so we don't pull in another dependency for it.

Configuration source of truth
-----------------------------
``backend/config.json`` → ``rag.service_url`` / ``rag.service_token`` /
``rag.service_timeout``. Env vars ``RAG_SERVICE_URL`` /
``RAG_SERVICE_TOKEN`` / ``RAG_SERVICE_TIMEOUT`` override config (handy
for sysadmins debugging without restarting).

Public API
----------
``call_tool(tool_name: str, payload: dict) -> dict``
    Synchronously call a tool and return the final ``payload`` from the
    SSE stream (or raise ``RagServiceError`` on protocol/transport
    issues, or ``RagToolError`` on a structured error from the service).

``ping() -> dict``
    GET ``/api/health``. Returns the response dict on success, raises
    on failure. Used by the admin "Test connection" button.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger("uvicorn.error")

# AUDIT 2026-08-31 (passe 3) — client HTTP PARTAGÉ (keep-alive). Chaque appel
# RAG créait/détruisait son ``httpx.Client`` : une poignée de main TCP (+ TLS
# le cas échéant) par requête, sur un service appelé plusieurs fois par tour
# en mode outils. Thread-safe (httpx.Client l'est pour les requêtes) — les
# appels arrivent désormais depuis le threadpool. Le timeout reste passé PAR
# REQUÊTE (il varie selon la config).
_shared_client: Optional[httpx.Client] = None
_shared_client_lock = threading.Lock()


def _http_client() -> httpx.Client:
    global _shared_client
    c = _shared_client
    if c is None or c.is_closed:
        with _shared_client_lock:
            if _shared_client is None or _shared_client.is_closed:
                # AUDIT 2026-09-26 — 8 connexions pour tout le worker : au-delà
                # de 8 tours RAG simultanés, les suivants attendaient une
                # connexion jusqu'au délai GLOBAL (30 s, délai de pool
                # compris), chacun bloquant un thread, puis échouaient.
                _shared_client = httpx.Client(
                    timeout=_request_timeout(get_service_timeout()),
                    limits=httpx.Limits(max_keepalive_connections=8,
                                        max_connections=32),
                )
            c = _shared_client
    return c


def _request_timeout(total: float) -> httpx.Timeout:
    """Délais par PHASE : la lecture garde le délai configuré (un calcul
    long est tenu vivant par les ``: ping`` SSE du service), la connexion
    et l'attente d'une place dans le pool échouent vite."""
    return httpx.Timeout(total, connect=min(5.0, total), write=10.0, pool=10.0)


def _token_for(url: Optional[str], token: Optional[str]) -> str:
    """Jeton à présenter à ``url``. AUDIT 2026-09-26 — le jeton CONFIGURÉ
    n'est envoyé qu'au service configuré : un test de connexion vers une URL
    candidate sans jeton explicite l'envoyait à cette URL quelconque."""
    if token is not None:
        return token
    if url and url.rstrip("/") != (get_service_url() or "").rstrip("/"):
        return ""
    return get_service_token()


class RagServiceError(RuntimeError):
    """Transport-level error: service unreachable, bad SSE, timeout."""


class RagToolError(RuntimeError):
    """Service returned a structured error event for the requested tool."""


# ─────────────────────────────────────────────────────────────────────────
# Config resolution
# ─────────────────────────────────────────────────────────────────────────

#: Section ``rag`` mémoïsée, indexée par (mtime_ns, taille) du fichier de
#: configuration. AUDIT 2026-08-23 — sans ce cache, une seule requête RAG
#: reparse le ``config.json`` ENTIER jusqu'à trois fois (url, jeton, délai) ;
#: le fichier d'instance pèse ~400 Ko, soit ~0,4 ms de parsage par lecture,
#: payés sur la boucle d'événements. La clé de fichier suffit à voir une
#: modification par l'éditeur admin (écriture atomique par renommage).
_SECTION_RAG_CACHE: "tuple[tuple[int, int], Dict[str, Any]] | None" = None


def _read_rag_section() -> Dict[str, Any]:
    """
    Best-effort read of ``backend/config.json`` → ``rag``. Avoids importing
    backend.config at import time (circular when this module is loaded
    from services/__init__.py during app start).

    Mémoïsé sur (mtime, taille) du fichier ; rend une copie de surface, les
    appelants n'ayant qu'à lire des scalaires.
    """
    global _SECTION_RAG_CACHE
    try:
        from shared_infra.config import CONFIG_JSON_PATH  # local import
        st = os.stat(CONFIG_JSON_PATH)
        cle = (st.st_mtime_ns, st.st_size)
        cache = _SECTION_RAG_CACHE
        if cache is not None and cache[0] == cle:
            return dict(cache[1])
        with open(CONFIG_JSON_PATH, "r", encoding="utf-8") as fh:
            section = (json.load(fh) or {}).get("rag", {}) or {}
        _SECTION_RAG_CACHE = (cle, section)
        return dict(section)
    except Exception:
        return {}


def get_service_url() -> str:
    env = os.environ.get("RAG_SERVICE_URL", "").strip()
    if env:
        return env.rstrip("/")
    cfg = _read_rag_section()
    url = (cfg.get("service_url") or "").strip()
    return url.rstrip("/")


def get_service_token() -> str:
    """``RAG_SERVICE_TOKEN`` > ``config.json › rag.service_token`` >
    ``user_db/.rag_service_token`` (généré par ./elpis configure, lu aussi par le
    service RAG — audit 2026-09-22, C4)."""
    env = os.environ.get("RAG_SERVICE_TOKEN", "").strip()
    if env:
        return env
    tok = (_read_rag_section().get("service_token") or "").strip()
    if tok:
        return tok
    try:
        from shared_infra.config import PROJECT_ROOT
        return (PROJECT_ROOT / "user_db" / ".rag_service_token").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def get_service_timeout() -> float:
    env = os.environ.get("RAG_SERVICE_TIMEOUT", "").strip()
    if env:
        try: return float(env)
        except ValueError: pass
    try:
        return float(_read_rag_section().get("service_timeout") or 30.0)
    except (TypeError, ValueError):
        return 30.0


def is_configured() -> bool:
    return bool(get_service_url())


# ─────────────────────────────────────────────────────────────────────────
# SSE consumer
# ─────────────────────────────────────────────────────────────────────────

def _iter_sse_events(response: httpx.Response):
    """
    Minimal SSE parser. Yields decoded JSON dicts from ``data:`` lines,
    ignoring comments (``:``) and unrelated fields. We only emit events
    of ``data:`` so anything else is dropped.

    Why not use ``httpx-sse`` or ``sseclient-py``?
    Two reasons: (1) the protocol used by ``rag_app`` is the simplest
    subset (always ``data: {json}\n\n``), so we avoid the dependency;
    (2) it lets us stay synchronous in the same call style the existing
    tool handlers use.
    """
    for raw in response.iter_lines():
        # httpx ``iter_lines`` yields ``str`` (decoded), one logical line
        # at a time, with newlines stripped. Empty line = event boundary.
        if not raw:
            continue
        if raw.startswith(":"):  # comment / keep-alive
            continue
        if raw.startswith("data:"):
            data = raw[5:].lstrip()
            if not data:
                continue
            try:
                yield json.loads(data)
            except json.JSONDecodeError:
                # Malformed event — skip but log once. We don't raise
                # because a single bad frame shouldn't kill the stream.
                logger.warning("[rag_client] SSE: skipping malformed JSON frame: %s", data[:200])
                continue


def _headers() -> Dict[str, str]:
    h = {"Accept": "text/event-stream", "Content-Type": "application/json"}
    tok = get_service_token()
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


# ─────────────────────────────────────────────────────────────────────────
# Public functions
# ─────────────────────────────────────────────────────────────────────────

def call_tool(tool_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Call a SSE tool endpoint and return the final ``payload`` dict.

    The protocol guarantees one of these terminal events:
      * ``{"type":"result","payload":{...}}`` → returned to the caller.
      * ``{"type":"error","msg":"..."}``      → raises RagToolError.

    Either way, the stream ends with ``{"type":"done"}``. If the stream
    closes without a result, we raise RagServiceError.
    """
    base = get_service_url()
    if not base:
        raise RagServiceError(
            "RAG service URL is not configured. Set rag.service_url in "
            "config.json (repo root) or RAG_SERVICE_URL env var."
        )
    url = f"{base}/api/tools/{tool_name}"
    body = payload or {}
    timeout = get_service_timeout()

    last_error: Optional[str] = None
    result_payload: Optional[Dict[str, Any]] = None

    try:
        client = _http_client()
        with client.stream("POST", url, json=body, headers=_headers(),
                           timeout=_request_timeout(timeout)) as resp:
            if resp.status_code >= 400:
                # Try to read the body for a useful message
                body_txt = ""
                try: body_txt = resp.read().decode("utf-8", errors="replace")[:500]
                except Exception: pass
                raise RagServiceError(
                    f"HTTP {resp.status_code} on {url}: {body_txt or 'no body'}")
            for evt in _iter_sse_events(resp):
                t = evt.get("type")
                if t == "result":
                    result_payload = evt.get("payload") or {}
                elif t == "error":
                    last_error = evt.get("msg") or "unknown error"
                elif t == "done":
                    break
                # 'start' / 'progress' are informational only
    except httpx.HTTPError as e:
        raise RagServiceError(f"Network error contacting RAG service ({url}): {e}") from e

    if last_error is not None:
        raise RagToolError(last_error)
    if result_payload is None:
        raise RagServiceError(
            f"RAG service stream closed without a result event ({url}). "
            "Check the rag_app logs.")
    return result_payload


def ping(url: Optional[str] = None, token: Optional[str] = None,
         timeout: float = 5.0) -> Dict[str, Any]:
    """
    GET ``/api/health`` — used by the admin "Test connection" button.

    Args allow overriding the configured URL/token so the admin can
    test a candidate URL before saving it to config.
    """
    target = (url or get_service_url() or "").rstrip("/")
    if not target:
        raise RagServiceError("No URL provided.")
    headers = {"Accept": "application/json"}
    tok = _token_for(url, token)
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    try:
        with httpx.Client(timeout=timeout) as client:
            r = client.get(f"{target}/api/health", headers=headers)
        if r.status_code == 401 or r.status_code == 403:
            raise RagServiceError(f"Auth refused (HTTP {r.status_code}).")
        if r.status_code >= 400:
            raise RagServiceError(f"HTTP {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except Exception:
            return {"ok": True, "raw": r.text[:200]}
    except httpx.HTTPError as e:
        raise RagServiceError(f"Network error: {e}") from e


def list_collections(url: Optional[str] = None, token: Optional[str] = None,
                     timeout: float = 5.0) -> list:
    """
    Best-effort: GET ``/api/collections`` on the RAG service.
    Returns [] on any failure so the frontend keeps rendering.
    """
    target = (url or get_service_url() or "").rstrip("/")
    if not target:
        return []
    headers = {"Accept": "application/json"}
    tok = _token_for(url, token)
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    try:
        with httpx.Client(timeout=timeout) as client:
            r = client.get(f"{target}/api/collections", headers=headers)
        if r.status_code != 200:
            return []
        data = r.json()
        # rag_app's /api/collections returns {"collections": [...]}, list,
        # or a Qdrant-shaped dict — be tolerant.
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            cols = data.get("collections")
            if isinstance(cols, list):
                # could be list of strings or list of {name, ...}
                return [c if isinstance(c, str) else c.get("name", "") for c in cols if c]
        return []
    except Exception:
        return []
