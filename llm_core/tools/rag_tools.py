# SPDX-License-Identifier: MIT
"""
tools/rag_tools.py
==================
RAG builtin tools — v2.

New in v2 vs v1:
  • rag_cite         : returns query-matched snippets with stable IDs so the
                        LLM can produce grounded answers that cite chunks.
  • rag_search       : + metadata filter (folder / filename patterns),
                        + multi-collection union (collections=[...]),
                        + score_threshold to drop noisy hits.
  • rag_get_document : returns a table of contents (chunk index map)
                        when a single-call read would exceed ctx limits.
  • Clearer error messages with actionable hints.
  • Backward-compatible: all v1 call shapes keep working.

Not MCP tools — these are injected into run_chat_multi_mcp() via builtin_tools={}.
Public entry point: build_rag_builtin_tools(...)   # signature preserved
"""
from __future__ import annotations

import json
import logging
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

# ─────────────────────────────────────────────────────────────────────────────
# Caps & ctx limits
# ─────────────────────────────────────────────────────────────────────────────
_DEFAULT_SEARCH_TOP_K     = 8
_DEFAULT_SEARCH_MAX_CHARS = 1_500   # per result sent to LLM


def _rag_err(message: str, **extra: Any) -> str:
    """Enveloppe d'erreur des builtins RAG — ``ok: false`` EXPLICITE.

    L'ancienne forme ``{"error", "hint"}`` (2 clés, sans ``ok``) était
    classée SUCCÈS par le classifieur partagé (règle 1-clé conservatrice,
    cf. ``llm_core.engine.result_contract``) : métriques, budget
    d'itérations productives et pilule rouge du front passaient à côté.
    """
    payload: Dict[str, Any] = {"ok": False, "error": message}
    payload.update({k: v for k, v in extra.items() if v is not None})
    return json.dumps(payload, ensure_ascii=False)


def _clip_excerpt(text: str, cap: int = _DEFAULT_SEARCH_MAX_CHARS) -> str:
    """Extrait borné AVEC marqueur — une coupe silencieuse faisait passer
    un chunk amputé pour le texte intégral (citations fausses)."""
    if len(text) <= cap:
        return text
    omitted = len(text) - cap
    return (text[:cap]
            + f"… [excerpt truncated, {omitted} chars omitted — "
              f"use rag_get_document for the full text]")

# Ratio UNIFIÉ de l'autorité tokens (3.3) — le 3.5 local divergeait de ~6 %
# du reste de l'app (audit 2026-07, diagnostic #2).
from llm_core.context.tokens import CHARS_PER_TOKEN as _CHARS_PER_TOKEN

_CTX_FILL_RATIO           = 0.80
_RAM_CAP_CHARS            = 600_000
_RAM_CAP_CHUNKS           = 600

_DEFAULT_DOC_MAX_CHUNKS   = 15
_DEFAULT_DOC_MAX_CHARS    = 20_000

# rag_cite specific
_CITE_MAX_RESULTS         = 10
_CITE_SNIPPET_CHARS       = 600     # short enough for inline citation


def _ctx_doc_limits(ctx_size: int = 0):
    if ctx_size and ctx_size > 0:
        raw_chars = int(ctx_size * _CTX_FILL_RATIO * _CHARS_PER_TOKEN)
        max_chars = min(raw_chars, _RAM_CAP_CHARS)
        max_chunks = min(max_chars // 300, _RAM_CAP_CHUNKS)
        return max_chars, max(1, max_chunks)
    return _DEFAULT_DOC_MAX_CHARS, _DEFAULT_DOC_MAX_CHUNKS


# ─────────────────────────────────────────────────────────────────────────────
# RAG module import
# ─────────────────────────────────────────────────────────────────────────────

def _import_rag_module():
    for mod_path in ("rag_app.rag_query", "rag_query", "backend.rag_query"):
        try:
            mod = __import__(
                mod_path,
                fromlist=["rag_search_only", "get_all_chunks_for_files",
                          "load_config", "list_indexed_files"],
            )
            if hasattr(mod, "rag_search_only") and hasattr(mod, "get_all_chunks_for_files"):
                return mod
        except ImportError:
            continue
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _normalize_filename(raw: str, collection: str = "") -> str:
    if not raw:
        return ""
    s = raw.strip().replace("\\", "/")
    if collection:
        col_lower = collection.lower().rstrip("/")
        s_lower = s.lower().lstrip("/")
        for prefix in (col_lower + "/", "collections/" + col_lower + "/",
                       "collection/" + col_lower + "/"):
            if s_lower.startswith(prefix):
                s = s[len(prefix):]
                break
    basename = PurePosixPath(s).name
    return (basename or s).strip().lstrip("./").strip()


def _fuzzy_match(target: str, available: List[str]) -> Optional[str]:
    if not target or not available:
        return None
    t = target.lower()
    for name in available:
        if name.lower() == t:
            return name
    for name in available:
        nl = name.lower()
        if nl.endswith(t) or nl.endswith("." + t):
            return name
    for name in available:
        nl = name.lower()
        if t in nl or nl in t:
            return name
    return None


def _matches_filter(name: str, folder: str, filters: Dict) -> bool:
    """Lightweight filter check on search results.
    Supports: file_glob (fnmatch on name), folder_contains, folder_equals."""
    if not filters:
        return True
    import fnmatch
    fg = filters.get("file_glob")
    if fg and not fnmatch.fnmatch((name or "").lower(), fg.lower()):
        return False
    fc = filters.get("folder_contains")
    if fc and fc.lower() not in (folder or "").lower():
        return False
    fe = filters.get("folder_equals")
    if fe and (folder or "").lower().rstrip("/") != fe.lower().rstrip("/"):
        return False
    return True


def _run_search(mod, cfg: Dict, query: str, top_k: int, use_hybrid: bool,
                use_mmr: bool, over_fetch: bool = False) -> List[Dict]:
    """Single search wrapper. over_fetch multiplies top_k to allow post-filtering."""
    k = top_k * (3 if over_fetch else 1)
    k = max(1, min(k, 64))
    # ``cfg`` porte la collection choisie pour ce chat — elle n'était JAMAIS
    # transmise (audit 2026-08-23) : la recherche partait sur la collection par
    # défaut du fichier de config, et le nom voulu était recollé sur les
    # résultats. Repli sans le paramètre si le service RAG déployé est plus
    # ancien (rag_app se déploie séparément).
    _coll = (cfg or {}).get("collection") or None
    try:
        result = mod.rag_search_only(
            question=query,
            top_k=k,
            use_hybrid=use_hybrid,
            use_mmr=use_mmr,
            collection=_coll,
        )
    except TypeError:
        result = mod.rag_search_only(
            question=query,
            top_k=k,
            use_hybrid=use_hybrid,
            use_mmr=use_mmr,
        )
    if not result.get("ok"):
        return []
    return result.get("results", []) or []


# ─────────────────────────────────────────────────────────────────────────────
# Handlers
# ─────────────────────────────────────────────────────────────────────────────

def _handle_rag_search(
    args: Dict,
    default_collection: str,
    search_mode: str,
    top_k: int,
    use_mmr: bool,
) -> str:
    mod = _import_rag_module()
    if not mod:
        return _rag_err("RAG module unavailable.",
                        hint="Check RAG module installation.")

    query = (args.get("query") or "").strip()
    if not query:
        return _rag_err("Parameter 'query' required.",
                        hint="Pass query='keywords or question'")

    # v2: optional filters
    filters: Dict = args.get("filters") or {}
    score_threshold = args.get("score_threshold")
    try:
        score_threshold = float(score_threshold) if score_threshold is not None else None
    except (TypeError, ValueError):
        score_threshold = None

    # v2: multi-collection support
    collections = args.get("collections")
    if not isinstance(collections, list) or not collections:
        collections = [default_collection] if default_collection else [""]

    try:
        cfg_base = mod.load_config()
        if not cfg_base:
            return _rag_err("RAG config not found.")

        capped_k = min(top_k, _DEFAULT_SEARCH_TOP_K)
        use_hybrid = (search_mode == "hybrid")

        pooled = []
        for coll in collections:
            cfg = {**cfg_base, "collection": coll} if coll else cfg_base
            try:
                items = _run_search(
                    mod, cfg, query, capped_k,
                    use_hybrid=use_hybrid,
                    use_mmr=use_mmr,
                    over_fetch=bool(filters),  # if filters active, fetch more to survive filtering
                )
            except Exception as e:
                logger.warning(f"[rag_tools] search failed on collection {coll!r}: {e}")
                items = []
            for r in items:
                r["_collection"] = coll
                pooled.append(r)

        if not pooled:
            return json.dumps({"results": [], "count": 0,
                               "message": "No results found.",
                               "collections_searched": collections},
                              ensure_ascii=False)

        # Deduplicate by (collection, name, chunk_index), keep best score
        best = {}
        for r in pooled:
            key = (r.get("_collection", ""), r.get("name", ""), r.get("chunk_index", 0))
            if key not in best or r.get("score", 0) > best[key].get("score", 0):
                best[key] = r
        pooled = list(best.values())

        # Apply post-filters
        filtered = []
        for r in pooled:
            if score_threshold is not None and float(r.get("score", 0)) < score_threshold:
                continue
            if not _matches_filter(r.get("name", ""), r.get("folder", ""), filters):
                continue
            filtered.append(r)

        # Sort by score desc
        filtered.sort(key=lambda x: -float(x.get("score", 0)))

        # Trim to top_k after filtering
        final = filtered[:capped_k]

        compact = []
        for r in final:
            name = r.get("name", "")
            folder = r.get("folder", "")
            compact.append({
                "source": f"{folder}/{name}" if folder else name,
                "get_document_name": name,
                "chunk": r.get("chunk_index", 0),
                "score": round(float(r.get("score", 0)), 4),
                "text": _clip_excerpt(r.get("text", "") or ""),
                "collection": r.get("_collection", "") or None,
            })

        payload = {
            "results": compact,
            "count": len(compact),
            "pooled_before_filter": len(pooled),
            "collections_searched": collections,
            "note": "Use 'get_document_name' (not 'source') in rag_get_document.",
        }
        if filters:
            payload["filters_applied"] = filters
        if score_threshold is not None:
            payload["score_threshold"] = score_threshold

        return json.dumps(payload, ensure_ascii=False)
    except Exception as e:
        logger.exception("[rag_tools] rag_search error")
        return _rag_err(str(e))


def _handle_rag_get_document(args: Dict, collection: str, ctx_size: int = 0) -> str:
    mod = _import_rag_module()
    if not mod:
        return _rag_err("RAG module unavailable.")

    raw_filename = (args.get("filename") or "").strip()
    if not raw_filename:
        return _rag_err("Parameter 'filename' required.",
                        hint="Call rag_list_sources to get the exact names.")

    # v2: optional chunk range (for iterative reading of huge docs)
    chunk_start = args.get("chunk_start")
    chunk_end = args.get("chunk_end")
    try: chunk_start = int(chunk_start) if chunk_start is not None else None
    except (TypeError, ValueError): chunk_start = None
    try: chunk_end = int(chunk_end) if chunk_end is not None else None
    except (TypeError, ValueError): chunk_end = None

    try:
        cfg = mod.load_config()
        if not cfg:
            return _rag_err("RAG config not found.")
        if collection:
            cfg = {**cfg, "collection": collection}

        filename = _normalize_filename(raw_filename, collection)
        _max_chars, _max_chunks = _ctx_doc_limits(ctx_size)

        # Over-fetch a bit to get accurate total
        chunks = mod.get_all_chunks_for_files(cfg, [filename],
                                              max_chunks=_max_chunks + 5)

        if not chunks and hasattr(mod, "list_indexed_files"):
            available = mod.list_indexed_files(cfg) or []
            matched = _fuzzy_match(filename, available)
            if matched and matched != filename:
                logger.info(f"[rag_tools] fuzzy-match: '{raw_filename}' → '{matched}'")
                chunks = mod.get_all_chunks_for_files(cfg, [matched],
                                                     max_chunks=_max_chunks + 5)
                filename = matched

        if not chunks and raw_filename != filename:
            chunks = mod.get_all_chunks_for_files(cfg, [raw_filename],
                                                 max_chunks=_max_chunks + 5)
            if chunks:
                filename = raw_filename

        if not chunks:
            hint = ""
            if hasattr(mod, "list_indexed_files"):
                avail = (mod.list_indexed_files(cfg) or [])[:20]
                if avail:
                    hint = f" Fichiers disponibles : {', '.join(avail)}"
            return json.dumps({"results": [], "count": 0,
                               "message": f"Aucun contenu pour '{raw_filename}'.{hint}"},
                              ensure_ascii=False)

        total_available = len(chunks)

        # v2: if chunk range specified, use it
        if chunk_start is not None or chunk_end is not None:
            s = max(0, chunk_start or 0)
            e = chunk_end if chunk_end is not None else total_available
            chunks_to_send = chunks[s:e]
        else:
            chunks_to_send = chunks[:_max_chunks]

        results, total, truncated = [], 0, False
        for c in chunks_to_send:
            text = c.get("text", "")
            if total + len(text) > _max_chars:
                truncated = True
                break
            results.append({"chunk": c.get("chunk_index", 0), "text": text})
            total += len(text)

        payload: Dict[str, Any] = {
            "filename": filename,
            "requested": raw_filename,
            "results": results,
            "count": len(results),
            "total_chars": total,
            "ctx_size": ctx_size,
            "limit_chars": _max_chars,
            "total_chunks_available": total_available,
        }
        if truncated:
            last_chunk = results[-1]["chunk"] if results else -1
            payload["warning"] = (
                f"Document truncated to {len(results)}/{total_available} chunks "
                f"(budget {_max_chars} chars ≈ 80% ctx_size={ctx_size}). "
                f"Pour lire la suite : rag_get_document(filename, chunk_start={last_chunk+1})."
            )
            payload["next_chunk_start"] = last_chunk + 1
        return json.dumps(payload, ensure_ascii=False)
    except Exception as e:
        logger.exception("[rag_tools] rag_get_document error")
        return _rag_err(str(e))


def _handle_rag_list_sources(args: Dict, collection: str) -> str:
    mod = _import_rag_module()
    if not mod:
        return _rag_err("RAG module unavailable.")
    try:
        cfg = mod.load_config()
        if not cfg:
            return _rag_err("RAG config not found.")
        if collection:
            cfg = {**cfg, "collection": collection}

        # v2: optional name filter for large indexes
        name_filter = (args.get("name_filter") or "").strip().lower()

        if hasattr(mod, "list_indexed_files"):
            files = mod.list_indexed_files(cfg) or []
        else:
            result = mod.rag_search_only("document fichier", top_k=50,
                                         use_hybrid=False, use_mmr=False)
            seen: Dict[str, bool] = {}
            for r in result.get("results", []):
                name = r.get("name", "")
                if name:
                    seen[name] = True
            files = sorted(seen.keys())

        if name_filter:
            files = [f for f in files if name_filter in f.lower()]

        return json.dumps({
            "files": files,
            "count": len(files),
            "collection": collection or "default",
            "note": "Utilisez ces noms exacts dans rag_get_document.",
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("[rag_tools] rag_list_sources error")
        return _rag_err(str(e))


def _handle_rag_cite(
    args: Dict,
    default_collection: str,
    search_mode: str,
    use_mmr: bool,
) -> str:
    """NEW v2: returns query-matched snippets formatted for grounded citation.

    Each result carries a stable `cite_id` (e.g. 'S1', 'S2') the LLM can refer to
    in its answer, plus a short excerpt ≤600 chars and the exact location.
    """
    mod = _import_rag_module()
    if not mod:
        return _rag_err("RAG module unavailable.")

    query = (args.get("query") or "").strip()
    if not query:
        return _rag_err("Parameter 'query' required.")

    k = int(args.get("max_sources") or 5)
    k = max(1, min(k, _CITE_MAX_RESULTS))

    collections = args.get("collections")
    if not isinstance(collections, list) or not collections:
        collections = [default_collection] if default_collection else [""]

    try:
        cfg_base = mod.load_config()
        if not cfg_base:
            return _rag_err("RAG config not found.")

        use_hybrid = (search_mode == "hybrid")
        pooled = []
        for coll in collections:
            cfg = {**cfg_base, "collection": coll} if coll else cfg_base
            try:
                items = _run_search(mod, cfg, query, k * 2,
                                    use_hybrid=use_hybrid, use_mmr=use_mmr)
            except Exception:
                items = []
            for r in items:
                r["_collection"] = coll
                pooled.append(r)

        # dedup + sort
        best = {}
        for r in pooled:
            key = (r.get("_collection", ""), r.get("name", ""), r.get("chunk_index", 0))
            if key not in best or r.get("score", 0) > best[key].get("score", 0):
                best[key] = r
        pooled = sorted(best.values(), key=lambda x: -float(x.get("score", 0)))[:k]

        if not pooled:
            return json.dumps({"sources": [], "count": 0,
                               "message": "No source found for this query."},
                              ensure_ascii=False)

        sources = []
        for i, r in enumerate(pooled, 1):
            name = r.get("name", "")
            folder = r.get("folder", "")
            text = (r.get("text", "") or "")[:_CITE_SNIPPET_CHARS]
            sources.append({
                "cite_id": f"S{i}",
                "source": f"{folder}/{name}" if folder else name,
                "document": name,
                "chunk": r.get("chunk_index", 0),
                "collection": r.get("_collection", "") or None,
                "score": round(float(r.get("score", 0)), 4),
                "excerpt": text,
            })

        return json.dumps({
            "sources": sources,
            "count": len(sources),
            "collections_searched": collections,
            "instruction_for_llm": (
                "Cite each factual claim with [S1], [S2]... matching the sources above. "
                "If a claim is not supported by any excerpt, say so explicitly."
            ),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("[rag_tools] rag_cite error")
        return _rag_err(str(e))


# ─────────────────────────────────────────────────────────────────────────────
# OpenAI function-calling definitions
# ─────────────────────────────────────────────────────────────────────────────

_TOOL_DEFS: List[Dict] = [
    {
        "type": "function",
        "function": {
            "name": "rag_search",
            "description": (
                "Semantic search over the document base. "
                "Returns relevant chunks with 'get_document_name' "
                "(exact value to pass to rag_get_document). "
                "Supports: filters={file_glob, folder_contains, folder_equals}, "
                "collections=[...] to search several collections, "
                "score_threshold to filter noisy results."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keywords or question to search for.",
                    },
                    "filters": {
                        "type": "object",
                        "description": (
                            "Optional filters: "
                            "{file_glob:'*.pdf', folder_contains:'api', folder_equals:'docs/'}"
                        ),
                    },
                    "collections": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Union of several collections. Empty = default collection.",
                    },
                    "score_threshold": {
                        "type": "number",
                        "description": "Minimum score (0..1). Useful to cut noise.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rag_get_document",
            "description": (
                "Fetch the content of one file. "
                "IMPORTANT: 'filename' = the 'get_document_name' returned by rag_search. "
                "Do not prefix it with the collection. "
                "For large documents: use chunk_start / chunk_end for iterative reading."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Exact file name, without path.",
                    },
                    "chunk_start": {
                        "type": "integer",
                        "description": "Index of the first chunk to return (0-based).",
                    },
                    "chunk_end": {
                        "type": "integer",
                        "description": "Exclusive end index (e.g. 30 for chunks 0..29).",
                    },
                },
                "required": ["filename"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rag_list_sources",
            "description": (
                "List the available files. "
                "Optional: name_filter='substring' to filter by name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name_filter": {
                        "type": "string",
                        "description": "Case-insensitive substring filter on names.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rag_cite",
            "description": (
                "Return short excerpts (≤600 chars) with a stable cite_id "
                "(S1, S2…) to produce sourced answers. "
                "Prefer it when the user asks for an answer with citations."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Question or keywords to source.",
                    },
                    "max_sources": {
                        "type": "integer",
                        "description": "Max number of sources (1..10, default 5).",
                    },
                    "collections": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Collections to query.",
                    },
                },
                "required": ["query"],
            },
        },
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point (signature preserved)
# ─────────────────────────────────────────────────────────────────────────────

def build_rag_builtin_tools(
    collection: str = "",
    search_mode: str = "classic",
    top_k: int = _DEFAULT_SEARCH_TOP_K,
    use_mmr: bool = True,
    ctx_size: int = 0,
) -> Dict[str, Any]:
    """Build builtin_tools dict for run_chat_multi_mcp().
    Returns {} if RAG module is missing."""
    mod = _import_rag_module()
    if not mod:
        logger.warning("[rag_tools] Module RAG introuvable — outils désactivés.")
        return {}

    _max_chars, _max_chunks = _ctx_doc_limits(ctx_size)
    logger.info(
        f"[rag_tools] RAG activé v2 "
        f"(col={collection or 'défaut'}, mode={search_mode}, "
        f"top_k={top_k}, use_mmr={use_mmr}, ctx_size={ctx_size}, "
        f"doc_limit={_max_chunks}ch/{_max_chars}c)"
    )

    return {
        "rag_search": {
            "definition": _TOOL_DEFS[0],
            "handler": lambda args, _c=collection, _m=search_mode, _k=top_k, _mmr=use_mmr: (
                _handle_rag_search(args, _c, _m, _k, _mmr)
            ),
        },
        "rag_get_document": {
            "definition": _TOOL_DEFS[1],
            "handler": lambda args, _c=collection, _ctx=ctx_size: (
                _handle_rag_get_document(args, _c, _ctx)
            ),
        },
        "rag_list_sources": {
            "definition": _TOOL_DEFS[2],
            "handler": lambda args, _c=collection: _handle_rag_list_sources(args, _c),
        },
        "rag_cite": {
            "definition": _TOOL_DEFS[3],
            "handler": lambda args, _c=collection, _m=search_mode, _mmr=use_mmr: (
                _handle_rag_cite(args, _c, _m, _mmr)
            ),
        },
    }
