# SPDX-License-Identifier: MIT
"""
rag_app.sparse — Optional bge-m3 sparse vectors + native Qdrant hybrid.

What this replaces
------------------
The current pipeline does hybrid search by:
  1. Doing a dense vector search in Qdrant.
  2. Computing BM25 in pure Python on the returned candidates' text.
  3. Fusing the two rankings with RRF in Python.

That works but has three issues:
  * BM25 IDF is recomputed at every query (no global index → can't use
    actual corpus statistics, only the candidate set's).
  * It double-fetches from Qdrant on each hybrid call.
  * Performance is bounded by the Python BM25 implementation.

This module enables a cleaner alternative: bge-m3 produces sparse
vectors natively (lexical_weights output). Qdrant can store them
alongside the dense vectors as "named vectors" and run a true hybrid
query (dense + sparse, fused by RRF on the SERVER side) in a single
round-trip.

Net result with sparse enabled:
  * +5-15% recall vs Python BM25 (sparse uses learned weights, not TF-IDF)
  * Lower latency (one Qdrant call instead of fetch+BM25)
  * Less Python code on the hot path

Why optional?
-------------
Same reason the reranker is optional:
  * Requires TEI/Infinity to serve the ``/embed_sparse`` endpoint
  * Requires reindexing existing collections (sparse vectors need to
    be stored, can't be added retroactively to old points)
  * Some operators may not want a second embedding round-trip

When ``sparse.enabled = false`` (default) the existing BM25 Python
path is used, no behaviour change vs pre-sparse.

Wire format expected from the embedding server
----------------------------------------------
TEI's ``/embed_sparse`` (which Infinity also implements):

    POST {url}/embed_sparse
    Content-Type: application/json
    {"inputs": ["text1", "text2"]}
    →
    [
      [{"index": 12345, "value": 0.42}, {"index": 67890, "value": 0.18}, ...],
      [{"index": 22222, "value": 0.81}, ...]
    ]

We convert that to Qdrant's sparse vector format:
    {"indices": [12345, 67890, ...], "values": [0.42, 0.18, ...]}
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Dict, List, Optional, Tuple

import httpx

# Passe RAG 2026-09-26 — client PARTAGÉ (keep-alive) : chaque sous-lot d'upsert
# (50 points) et chaque tentative ouvrait une connexion TCP/TLS neuve vers
# ``/embed_sparse``. Le délai reste passé PAR REQUÊTE.
_client_lock = threading.Lock()
_shared_client: Optional[httpx.Client] = None


def _client() -> httpx.Client:
    global _shared_client
    with _client_lock:
        if _shared_client is None or _shared_client.is_closed:
            _shared_client = httpx.Client(
                limits=httpx.Limits(max_connections=16, max_keepalive_connections=8))
        return _shared_client

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────
# Config
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


def _section(cfg: dict) -> dict:
    """Read the ``sparse`` section of rag_config.json with safe defaults."""
    raw = cfg.get("sparse") if isinstance(cfg.get("sparse"), dict) else {}
    # If url is empty, fall back to embed_base_url — TEI serves both
    # /v1/embeddings and /embed_sparse on the same host, so reusing
    # the existing config saves a duplicate field for the typical
    # deployment.
    url = _cv(raw, "url", "", str) or (cfg.get("embed_base_url") or "")
    return {
        "enabled":  _cv(raw, "enabled", False, bool),
        "url":      str(url).strip().rstrip("/"),
        "timeout":  _cv(raw, "timeout", 30.0, float),
        # Sparse retrieval pool — server-side prefetch limit per branch
        # before RRF fusion. Bigger = better recall, slower.
        "prefetch_limit": max(1, _cv(raw, "prefetch_limit", 50, int)),
    }


def prefetch_limit(cfg: dict) -> int:
    """Taille du pré-tirage par branche (dense / sparse) avant fusion RRF."""
    return _section(cfg)["prefetch_limit"]


def is_enabled(cfg: dict) -> bool:
    s = _section(cfg)
    return s["enabled"] and bool(s["url"])


# ─────────────────────────────────────────────────────────────────────
# Embedding fetch
# ─────────────────────────────────────────────────────────────────────

def get_sparse_embeddings(texts: List[str], cfg: dict,
                          timeout: Optional[float] = None,
                          max_retries: int = 2) -> List[Optional[Dict]]:
    """
    Fetch sparse vectors for ``texts`` from the configured server.

    Returns a list aligned with the input — each element is either a
    Qdrant-shaped sparse dict ``{"indices": [...], "values": [...]}``
    or ``None`` on failure for that specific text.

    Why ``None`` on per-text failure?
    ---------------------------------
    Bulk ingestion may have one bad string in 1000. Returning per-text
    None lets the caller skip that point in the upsert without aborting
    the whole batch. Total network failure returns ``[None] * len(texts)``
    which has the same effect.
    """
    if not texts:
        return []
    s = _section(cfg)
    if not (s["enabled"] and s["url"]):
        return [None] * len(texts)

    url = f"{s['url']}/embed_sparse"
    body = {"inputs": texts}
    t = timeout or s["timeout"]

    for attempt in range(max_retries):
        try:
            r = _client().post(url, json=body, timeout=t)
            if r.status_code != 200:
                logger.warning(
                    "[sparse] HTTP %s on %s — falling back. body: %s",
                    r.status_code, url, r.text[:200]
                )
                return [None] * len(texts)
            data = r.json()
        except httpx.HTTPError as e:
            if attempt < max_retries - 1:
                time.sleep(0.5 * (attempt + 1))     # pas de rafale de reprises
                continue
            logger.warning("[sparse] network error after %d attempts: %s",
                           max_retries, e)
            return [None] * len(texts)
        except Exception as e:
            logger.warning("[sparse] unexpected error: %s", e)
            return [None] * len(texts)

        # Réponse 200 inattendue (objet d'erreur, longueur différente) :
        # l'itérer donnait une liste désalignée sur ``texts`` (passe 2).
        if not isinstance(data, list) or len(data) != len(texts):
            logger.warning("[sparse] réponse inattendue (%s éléments pour %d textes)",
                           len(data) if isinstance(data, list) else type(data).__name__,
                           len(texts))
            return [None] * len(texts)

        # Convert TEI shape → Qdrant shape, item by item.
        out: List[Optional[Dict]] = []
        for item in data:
            if not isinstance(item, list):
                out.append(None)
                continue
            indices: List[int] = []
            values:  List[float] = []
            for entry in item:
                try:
                    idx = int(entry.get("index", -1))
                    val = float(entry.get("value", 0.0))
                except (TypeError, ValueError, AttributeError):
                    continue
                if idx >= 0 and val != 0.0:
                    indices.append(idx)
                    values.append(val)
            if not indices:
                # Empty sparse vector — Qdrant rejects these. Treat
                # as "no sparse for this text"; the dense vector
                # alone will carry the search signal.
                out.append(None)
            else:
                out.append({"indices": indices, "values": values})
        return out

    return [None] * len(texts)


# ─────────────────────────────────────────────────────────────────────
# Collection schema detection
# ─────────────────────────────────────────────────────────────────────

# Le schéma d'une collection ne change presque jamais, mais cette sonde
# était appelée À CHAQUE requête quand sparse est activé (un GET Qdrant de
# plus sur le chemin chaud). Cache TTL court : 60 s de latence maximum pour
# voir apparaître un slot sparse après migration, zéro round-trip sinon.
_SUPPORT_TTL_SEC = 60.0
_support_cache: Dict[Tuple[str, str], Tuple[float, bool, Optional[bool]]] = {}
_support_lock = threading.Lock()


def _support_cache_clear() -> None:
    """Vidage du cache (tests / après migration de collection)."""
    with _support_lock:
        _support_cache.clear()


def _schema(qdrant_url: str, collection: str,
            timeout: float = 3.0) -> Tuple[bool, Optional[bool]]:
    """``(slot_sparse, dense_nommé)`` de la collection, en cache TTL.

    ``dense_nommé`` vaut ``None`` si le schéma n'a pas pu être lu (sonde en
    échec) — l'appelant retombe alors sur un essai / repli."""
    key = (str(qdrant_url).rstrip("/"), str(collection))
    now = time.monotonic()
    with _support_lock:
        hit = _support_cache.get(key)
        if hit and now - hit[0] < _SUPPORT_TTL_SEC:
            return hit[1], hit[2]
    supported, named = False, None
    try:
        r = _client().get(f"{qdrant_url.rstrip('/')}/collections/{collection}",
                          timeout=timeout)
        if r.status_code == 200:
            result = r.json().get("result", {})
            # Qdrant returns either:
            #  - legacy: ``config.params.vectors = {"size": N, "distance": "..."}``
            #  - named:  ``config.params.vectors = {"dense": {...}, ...}``
            #            and ``config.params.sparse_vectors = {"sparse": {...}}``
            params = (result.get("config") or {}).get("params") or {}
            sparse_cfg = params.get("sparse_vectors")
            supported = isinstance(sparse_cfg, dict) and "sparse" in sparse_cfg
            vecs = params.get("vectors")
            named = isinstance(vecs, dict) and "dense" in vecs and "size" not in vecs
    except Exception:
        supported, named = False, None
    with _support_lock:
        _support_cache[key] = (now, supported, named)
    return supported, named


def collection_supports_sparse(qdrant_url: str, collection: str,
                               timeout: float = 3.0) -> bool:
    """
    True iff the collection is configured with a named ``sparse``
    vector slot (réponse mise en cache ``_SUPPORT_TTL_SEC`` secondes).

    This lets the caller decide: "should I send a hybrid query, or
    fall back to pure-dense + Python BM25?"
    """
    return _schema(qdrant_url, collection, timeout)[0]


def collection_uses_named_dense(qdrant_url: str, collection: str,
                                timeout: float = 3.0) -> Optional[bool]:
    """True si la collection stocke le dense sous le NOM ``dense`` (schéma
    hybride), False si vecteur unique, None si inconnu (passe RAG 2026-09-26 :
    la recherche dense seule envoyait un vecteur SANS nom à une collection
    hybride — HTTP 400, RAG entièrement « indisponible » précisément dans les
    cas de repli)."""
    return _schema(qdrant_url, collection, timeout)[1]


# ─────────────────────────────────────────────────────────────────────
# Hybrid query payload builder
# ─────────────────────────────────────────────────────────────────────

def build_hybrid_query(dense_vec: List[float],
                       sparse_vec: Optional[Dict],
                       *,
                       limit: int = 10,
                       prefetch_limit: int = 50,
                       qdrant_filter: Optional[Dict] = None) -> Dict:
    """
    Build the body for ``POST /collections/{name}/points/query``.

    Two prefetch branches (dense + sparse) feed RRF fusion at the top
    level. The server returns the fused top-K — single round-trip,
    no Python BM25 needed.

    If ``sparse_vec`` is None (e.g. the embedding server returned
    nothing useful for the query), we fall back to dense-only — still
    using the query API for consistency, but with one branch.
    """
    body: Dict = {
        "prefetch": [
            {"query": dense_vec, "using": "dense", "limit": prefetch_limit},
        ],
        "limit":        limit,
        "with_payload": True,
        "with_vector":  False,
    }
    if sparse_vec is not None:
        body["prefetch"].append({
            "query": sparse_vec,
            "using": "sparse",
            "limit": prefetch_limit,
        })
        # Two branches → RRF fusion. With one branch the server just
        # returns that branch's results, no fusion needed.
        body["query"] = {"fusion": "rrf"}

    if qdrant_filter:
        # Apply the filter at the prefetch level — Qdrant pushes it
        # down before the kNN search. Applying it at the top would
        # filter AFTER fusion, which is more expensive and can
        # under-fill the result set.
        for branch in body["prefetch"]:
            branch["filter"] = qdrant_filter
    return body


# ─────────────────────────────────────────────────────────────────────
# Health check (called from /api/sparse/test)
# ─────────────────────────────────────────────────────────────────────

def health_check(cfg: dict) -> Dict:
    """
    Probe the configured sparse endpoint with a single trivial input.
    Returns a structured dict for the admin UI.
    """
    s = _section(cfg)
    if not s["url"]:
        return {"ok": False, "configured": False,
                "msg": "Aucune URL configurée pour l'embedding sparse."}

    import time
    t0 = time.time()
    out = get_sparse_embeddings(["test"], cfg, timeout=5.0, max_retries=1)
    elapsed_ms = int((time.time() - t0) * 1000)

    if not out or out[0] is None:
        return {"ok": False, "configured": True,
                "url": s["url"], "elapsed_ms": elapsed_ms,
                "msg": "Le serveur n'a pas répondu correctement (voir logs)."}

    sample = out[0]
    return {
        "ok": True, "configured": True,
        "url": s["url"], "elapsed_ms": elapsed_ms,
        "sparse_dim": len(sample.get("indices", [])),
        "msg": f"Sparse OK — {len(sample.get('indices', []))} dimensions actives sur 'test'.",
    }
