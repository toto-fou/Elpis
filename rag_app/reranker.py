# SPDX-License-Identifier: MIT
"""
rag_app/reranker.py
===================
Optional cross-encoder reranking layer.

What it does
------------
After the existing retrieval pipeline returns its top-K hits (vector,
hybrid+RRF, MMR — whatever the caller chose), this module re-scores
those hits with a *cross-encoder* model. Cross-encoders see the query
and each candidate document **together** in a single forward pass, so
they reason about the actual semantic relationship — much more accurate
than the dot-product score from a bi-encoder. Typical NDCG gain on RAG
benchmarks: +20-30 points.

The cost is one extra HTTP round-trip per query (~50-200 ms with
``bge-reranker-v2-m3`` on a small GPU), totally worth it for any
serious deployment.

Why it's optional
-----------------
Two reasons. First, a reranker is an extra service to operate — not
everyone wants the ops burden. Second, if the existing retrieval is
already returning the right answer in the top-3, reranking adds
latency for no gain. So this module is feature-gated: when
``rag_config.json`` has ``reranker.enabled = false`` (or no
``reranker`` key at all), every public function in this module becomes
a no-op pass-through. The rest of the codebase calls them
unconditionally, knowing the OFF path is free.

Wire format
-----------
We speak the de-facto-standard rerank API used by Cohere, Jina, Voyage,
Text-Embeddings-Inference (TEI), llama.cpp, and Infinity:

    POST {url}/v1/rerank
    {
        "model":     "bge-reranker-v2-m3",
        "query":     "...",
        "documents": ["...", "...", ...],
        "top_n":     8,
        "return_documents": false   # we only need indices+scores
    }
    →
    {
        "results": [
            {"index": 3, "relevance_score": 0.97},
            {"index": 0, "relevance_score": 0.84},
            ...
        ]
    }

If your reranker speaks a different dialect, this module is the only
place to adapt — see :func:`_call_reranker`.

Failure handling
----------------
The reranker is best-effort: on any failure (timeout, HTTP error, bad
response shape) we log a warning and return the *original* hit list
unchanged. The chatbot still gets results — just not reranked ones.
This is a deliberate design choice: a flaky reranker should degrade
quality, never break retrieval.
"""
from __future__ import annotations

import hashlib
import logging
import threading
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

import httpx

# Passe RAG 2026-09-26 — client PARTAGÉ : un ``httpx.Client`` neuf par rerank
# (donc par recherche) ouvrait une connexion TCP/TLS à chaque fois.
_client_lock = threading.Lock()
_shared_client: Optional[httpx.Client] = None


def _client() -> httpx.Client:
    global _shared_client
    with _client_lock:
        if _shared_client is None or _shared_client.is_closed:
            _shared_client = httpx.Client(
                limits=httpx.Limits(max_connections=16, max_keepalive_connections=8))
        return _shared_client


def _docs_digest(documents: List[str]) -> str:
    """Empreinte des documents pour la clé de cache : la clé gardait le
    TUPLE des textes (jusqu'à ~60 × 2 000 caractères, × 256 entrées ≈ 30 Mo
    retenus en RAM)."""
    h = hashlib.sha1()
    for d in documents:
        h.update(d.encode("utf-8", "surrogatepass"))
        h.update(b"\x00")
    return h.hexdigest()

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────
# Config helpers
# ─────────────────────────────────────────────────────────────────────

def _cv(raw, key, default, cast):
    """Valeur de config tolérante : une saisie invalide (« 10s », liste…)
    vaut le défaut au lieu de lever à CHAQUE requête — même module
    désactivé (passe 2)."""
    v = raw.get(key) if isinstance(raw, dict) else None
    if v is None or v == "":
        return default
    try:
        if cast is bool:
            return v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on", "oui")
        if cast is str:
            return v.strip() if isinstance(v, str) else default
        out = cast(v)
        # Délai ≤ 0 : httpx échoue alors à CHAQUE appel — défaut.
        if key == "timeout" and out <= 0:
            return default
        return out
    except (TypeError, ValueError):
        logger.warning(f"[config] {key}={v!r} invalide, défaut {default!r} utilisé")
        return default


def _cfg_section(cfg: dict) -> dict:
    """
    Return the ``reranker`` section of ``rag_config.json`` with sensible
    defaults filled in. Centralising this here means the rest of the
    module can assume the dict is fully populated.
    """
    raw = cfg.get("reranker") if isinstance(cfg.get("reranker"), dict) else {}
    return {
        "enabled":      _cv(raw, "enabled", False, bool),
        "url":          _cv(raw, "url", "", str).rstrip("/"),
        "model":        _cv(raw, "model", "", str) or "bge-reranker-v2-m3",
        # How many candidates to fetch from the bi-encoder before
        # reranking. The cross-encoder shines when given more candidates
        # than it ultimately keeps — 30 is a reasonable default that
        # balances latency vs recall.
        "top_k_before": max(1, _cv(raw, "top_k_before", 30, int)),
        # How many to return after reranking. None ⇒ caller decides.
        "top_k_after":  max(1, _cv(raw, "top_k_after", 8, int)),
        # Per-call HTTP timeout. Set generously; cross-encoders on CPU
        # can easily hit 1-2 s for batch 30.
        "timeout":      _cv(raw, "timeout", 10.0, float),
        # Optional Bearer auth (Cohere, Jina, etc. require it).
        "api_key":      _cv(raw, "api_key", "", str),
        # Drop reranked hits below this absolute score. 0.0 = keep all.
        "min_score":    _cv(raw, "min_score", 0.0, float),
    }


def is_enabled(cfg: dict) -> bool:
    """Single source of truth for the on/off check."""
    s = _cfg_section(cfg)
    return s["enabled"] and bool(s["url"])


def top_k_before(cfg: dict) -> Optional[int]:
    """
    How many candidates the retrieval layer should fetch when reranking
    is on. Returns ``None`` when reranking is off, signalling "use the
    caller's normal top_k". This keeps the integration point trivial:

        k = reranker.top_k_before(cfg) or top_k
    """
    return _cfg_section(cfg)["top_k_before"] if is_enabled(cfg) else None


# ─────────────────────────────────────────────────────────────────────
# Tiny LRU cache for repeat queries
# ─────────────────────────────────────────────────────────────────────
# Same query against the same candidate set ⇒ same scores. This isn't
# uncommon: when a user re-asks a slightly-rephrased question, the dense
# search may converge on the same chunks. Caching the rerank step saves
# one round-trip per repeat.

_CACHE_MAX = 256
_cache: "OrderedDict[Tuple, List[Tuple[int, float]]]" = OrderedDict()
# Les recherches arrivent depuis le threadpool FastAPI : muter une
# OrderedDict sans verrou depuis plusieurs threads corrompt sa liste
# chaînée interne.
_cache_lock = threading.Lock()


def _cache_get(key: Tuple) -> Optional[List[Tuple[int, float]]]:
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
        return None


def _cache_put(key: Tuple, value: List[Tuple[int, float]]) -> None:
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.popitem(last=False)
        _cache[key] = value


# ─────────────────────────────────────────────────────────────────────
# Network call
# ─────────────────────────────────────────────────────────────────────

def _call_reranker(query: str, documents: List[str], section: dict,
                   top_n: int) -> Optional[List[Tuple[int, float]]]:
    """
    Single POST to the reranker. Returns a list of ``(index, score)``
    tuples sorted by score desc, or ``None`` on any failure.

    Why ``Optional`` instead of raising? Callers want to fall back to
    the unreranked list on failure — returning None makes that branch
    trivial (``if scored is None: return original_hits``).
    """
    url = f"{section['url']}/v1/rerank"
    body = {
        "model":            section["model"],
        "query":            query,
        "documents":        documents,
        "top_n":            min(top_n, len(documents)),
        "return_documents": False,
    }
    headers = {"Content-Type": "application/json"}
    if section["api_key"]:
        headers["Authorization"] = f"Bearer {section['api_key']}"

    try:
        r = _client().post(url, json=body, headers=headers, timeout=section["timeout"])
        if r.status_code != 200:
            logger.warning(
                "[reranker] HTTP %s on %s — falling back to non-reranked. Body: %s",
                r.status_code, url, r.text[:200],
            )
            return None
        data = r.json()
    except httpx.HTTPError as e:
        logger.warning("[reranker] network error on %s — falling back. %s", url, e)
        return None
    except Exception as e:
        logger.warning("[reranker] unexpected error parsing response — falling back. %s", e)
        return None

    # The standard shape is {"results": [{"index", "relevance_score"}, ...]}.
    # Some servers return a top-level list. Accept both.
    if isinstance(data, dict):
        results = data.get("results") or data.get("data") or []
    elif isinstance(data, list):
        results = data
    else:
        logger.warning("[reranker] unexpected response shape: %s", type(data).__name__)
        return None

    scored: List[Tuple[int, float]] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("index", -1))
            # Accept both 'relevance_score' (Cohere/TEI) and 'score' (some forks)
            sc = float(item.get("relevance_score", item.get("score", 0.0)))
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(documents):
            scored.append((idx, sc))

    if not scored:
        logger.warning("[reranker] response had no usable results — falling back.")
        return None

    scored.sort(key=lambda t: -t[1])
    return scored


# ─────────────────────────────────────────────────────────────────────
# Public entry points (called from rag_query.py)
# ─────────────────────────────────────────────────────────────────────

def rerank_hits(
    query: str,
    hits: List[Dict],
    cfg: dict,
    top_k: Optional[int] = None,
) -> List[Dict]:
    """
    Rerank a list of Qdrant-shape hits and return the top ``top_k``.

    Each hit is expected to have ``{"payload": {"text": "..."}, ...}``.
    The original hit dicts are preserved (we don't rebuild them) — we
    just enrich with two payload fields:

      * ``rerank_score`` (float)  — the cross-encoder score
      * ``original_score`` (float) — the bi-encoder score before rerank
                                     (preserved for debugging / traces)

    No-op behaviour
    ---------------
    Returns ``hits[:top_k]`` unchanged when:
      * reranker is disabled in config,
      * hits list is empty or has fewer than 2 elements (no point),
      * the network call fails.
    """
    section = _cfg_section(cfg)
    if not (section["enabled"] and section["url"]):
        return hits[:top_k] if top_k else hits
    if len(hits) < 2:
        return hits[:top_k] if top_k else hits

    final_k = top_k or section["top_k_after"]

    # Build the document list in the same order as hits — the reranker
    # returns indices into THIS list, so the order matters.
    documents: List[str] = []
    for h in hits:
        text = (h.get("payload") or {}).get("text") or ""
        # Cap to ~2000 chars to bound cross-encoder ctx. bge-reranker-v2-m3
        # supports 8K but most chunks are far smaller; very long ones
        # bloat the request without helping the score (the relevance
        # signal usually lives in the first few sentences).
        documents.append(text[:2000])

    # (2026-09-20) ``final_k`` fait partie de la clé : la liste mémorisée a la
    # longueur du premier appel, un top_n plus large relisait une liste tronquée.
    cache_key = (query, section["model"], _docs_digest(documents), int(final_k or 0))
    cached = _cache_get(cache_key)
    if cached is None:
        cached = _call_reranker(query, documents, section, top_n=final_k)
        if cached is None:
            # Network/parse failure → fall back gracefully. We don't
            # cache None so a transient failure doesn't poison
            # subsequent identical queries.
            return hits[:final_k]
        _cache_put(cache_key, cached)

    # Apply min_score filter (after caching: the threshold is a config
    # knob the user may tune, and we don't want to invalidate the cache
    # on every tweak).
    min_score = section["min_score"]

    out: List[Dict] = []
    for idx, score in cached:
        if score < min_score:
            continue
        h = dict(hits[idx])           # shallow copy so we don't mutate caller's list
        payload = dict(h.get("payload") or {})
        # Preserve the bi-encoder score for traceability — admins want
        # to be able to diff "before rerank vs after" in logs.
        if "original_score" not in payload:
            payload["original_score"] = h.get("score", 0.0)
        payload["rerank_score"] = score
        h["payload"] = payload
        h["score"] = score             # downstream consumers sort on .score
        out.append(h)
        if len(out) >= final_k:
            break

    if not out:
        # Everything got filtered out by min_score. Don't return empty —
        # better to return the original best-effort list with a note in
        # logs. The user can lower min_score if they see this.
        logger.info(
            "[reranker] all %d candidates filtered by min_score=%.2f — falling back",
            len(hits), min_score,
        )
        return hits[:final_k]
    return out


def rerank_simple_results(
    query: str,
    results: List[Dict],
    cfg: dict,
    top_k: Optional[int] = None,
) -> List[Dict]:
    """
    Variant for code paths that work with already-flattened result rows
    (``rag_tool_search`` produces these): each row is
    ``{source, chunk_index, score, text, ...}``.

    Rather than reshape into Qdrant-hit form just to call
    :func:`rerank_hits`, we inline a smaller version here.
    """
    section = _cfg_section(cfg)
    if not (section["enabled"] and section["url"]):
        return results[:top_k] if top_k else results
    if len(results) < 2:
        return results[:top_k] if top_k else results

    final_k = top_k or section["top_k_after"]
    documents = [(r.get("text") or "")[:2000] for r in results]

    # (2026-09-20) ``final_k`` fait partie de la clé : la liste mémorisée a la
    # longueur du premier appel, un top_n plus large relisait une liste tronquée.
    cache_key = (query, section["model"], _docs_digest(documents), int(final_k or 0))
    cached = _cache_get(cache_key)
    if cached is None:
        cached = _call_reranker(query, documents, section, top_n=final_k)
        if cached is None:
            return results[:final_k]
        _cache_put(cache_key, cached)

    min_score = section["min_score"]
    out: List[Dict] = []
    for idx, score in cached:
        if score < min_score:
            continue
        r = dict(results[idx])
        r["original_score"] = r.get("score", 0.0)
        r["rerank_score"] = score
        r["score"] = round(score, 4)
        out.append(r)
        if len(out) >= final_k:
            break
    return out or results[:final_k]


# ─────────────────────────────────────────────────────────────────────
# Connectivity check (called from /api/reranker/test)
# ─────────────────────────────────────────────────────────────────────

def health_check(cfg: dict) -> Dict:
    """
    Probe the configured reranker with a 1-document trivial request.
    Used by the admin "Tester" button. Returns a structured dict the UI
    can render directly — never raises.
    """
    section = _cfg_section(cfg)
    if not section["url"]:
        return {"ok": False, "configured": False,
                "msg": "Aucune URL configurée."}

    # Minimal payload that any rerank server will accept
    test_query = "test"
    test_docs = ["Ceci est un document de test pour vérifier la connectivité."]

    import time
    t0 = time.time()
    try:
        scored = _call_reranker(test_query, test_docs, section, top_n=1)
    except Exception as e:
        return {"ok": False, "configured": True,
                "msg": f"Exception: {e}",
                "url": section["url"], "model": section["model"]}
    elapsed_ms = int((time.time() - t0) * 1000)

    if scored is None:
        return {"ok": False, "configured": True,
                "msg": "Le reranker n'a pas répondu correctement (voir logs).",
                "url": section["url"], "model": section["model"],
                "elapsed_ms": elapsed_ms}

    return {
        "ok": True, "configured": True,
        "url": section["url"], "model": section["model"],
        "elapsed_ms": elapsed_ms,
        "sample_score": round(scored[0][1], 4) if scored else None,
        "msg": "Reranker OK.",
    }
