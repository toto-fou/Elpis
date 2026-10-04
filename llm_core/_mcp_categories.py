# SPDX-License-Identifier: MIT
"""
backend.services._mcp_categories — MCP tool category registry.

Source of truth: the LIVE tool list
------------------------------------
The category each tool belongs to travels IN the protocol. Every tool is
registered server-side with ``tags={"<category>"}`` and
``meta={"category": {...display...}}`` (see ``tools/memory_tools.py``).
The MCP pool, right after it connects, hands the ``list_tools()`` response
to :func:`ingest_tools`, which builds the registry from it.

Why a registry built from the live list (not the old manifest file)
--------------------------------------------------------------------
The previous version read ``tools/.tool_manifest.json`` — a side-car
written by the MCP subprocess at startup. The FastAPI workers import
their modules before that subprocess finishes booting, fell back to an
AST scan that returns EMPTY tool lists, and froze that empty result at
import time → ``LOCAL_PREFIXES`` empty → todo writes mis-routed.

Cross-worker cache (this revision)
----------------------------------
The in-memory registry is per-worker and only gets populated when *that*
worker connects the MCP pool. But ``GET /api/mcp/categories`` (the chat
side panel) can be served by any worker — including ones that have not
run a tool-chat yet. So :func:`ingest_tools` ALSO persists the registry
to a small JSON cache, and :func:`_get_registry` falls back to reading
that cache when its own in-memory registry is empty.

This is NOT the old race: the cache is written by ``ingest_tools`` —
i.e. in the backend, AFTER a real pool connection, from the live tool
list — and re-written on every connect. It is never consulted at import
time, and ``_constants.TOOL_CATEGORIES`` is a live proxy. The cache is
purely a "a sibling worker already discovered the tools, reuse that"
fast-path. Path: ``$TOOL_CATEGORIES_CACHE_PATH`` or
``<PROJECT_ROOT>/user_db/.tool_categories_cache.json``.

Public API (unchanged — drop-in)
--------------------------------
- ``ingest_tools(tools)``        — feed it the ``list_tools()`` result.
- ``get_categories(include_hidden=False)``
- ``get_tool_categories_dict(include_hidden=True)``
- ``categorize(tool_name)``      — ``"other"`` if unknown.
- ``is_hidden(category)`` / ``get_hidden_categories()``
- ``registry_source()``          — ``"live"`` | ``"static"`` | ``"empty"``
  (``manifest_source`` kept as an alias for any old caller).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")


# ── Cross-worker cache path ──────────────────────────────────────────
try:
    from shared_infra.config import PROJECT_ROOT as _PROJECT_ROOT
except Exception:  # pragma: no cover — keeps the module importable standalone
    _PROJECT_ROOT = Path.cwd()

_CACHE_PATH = Path(
    os.environ.get("TOOL_CATEGORIES_CACHE_PATH")
    or (Path(_PROJECT_ROOT) / "user_db" / ".tool_categories_cache.json")
).expanduser()


# ── Stable display metadata (NO tool lists — cannot drift) ───────────
# Used to render the chat side panel when the server doesn't ship a
# display descriptor in tool ``meta``. Unknown categories still work —
# they just render with the generic defaults.
_STATIC_DISPLAY: Dict[str, Dict[str, Any]] = {
    "fs":      {"label": "Fichiers",   "icon": "ph-folder",          "color": "orange",  "hidden": False},
    "shell":   {"label": "Terminal",   "icon": "ph-terminal-window", "color": "slate",   "hidden": False},
    "git":     {"label": "Git",        "icon": "ph-git-branch",      "color": "slate",   "hidden": False},
    "chart":   {"label": "Graphiques", "icon": "ph-chart-bar",       "color": "emerald", "hidden": False},
    "office":  {"label": "Documents Office", "icon": "ph-file-doc",  "color": "sky",     "hidden": False},
    "memory":  {"label": "Mémoire",    "icon": "ph-brain",     "color": "amber",   "hidden": False},
    "browser": {"label": "Navigateur", "icon": "ph-globe",           "color": "sky",     "hidden": False},
    "desktop": {"label": "Contrôle d'écran", "icon": "ph-desktop",   "color": "teal",    "hidden": False},
    # Todo-list de session (modèle OpenCode) : jamais un toggle utilisateur —
    # cachée du panneau, incluse d'office dès qu'un serveur d'outils est actif.
    "task":    {"label": "Tâches",     "icon": "ph-list-checks",     "color": "emerald", "hidden": True},
}

_GENERIC_DISPLAY = {"icon": "ph-package", "color": "slate", "hidden": False}


# ── Cache / state ────────────────────────────────────────────────────
_lock = threading.Lock()
_registry: Optional[Dict[str, Any]] = None        # set by ingest_tools() — this worker connected
# (2026-09-12, P4) registre PAR SOURCE (service partagé, MCP interne de l'app…) ;
# ``_registry`` est l'UNION de toutes les sources vues par ce worker.
_sources: Dict[str, Dict[str, Any]] = {}
_disk_cache: Dict[str, Any] = {"at": 0.0, "reg": None}  # fallback for workers that didn't
_DISK_TTL_SEC = 5.0


def _empty_registry() -> Dict[str, Any]:
    return {"descriptors": {}, "tool_to_category": {}, "tool_descriptions": {},
            "tool_policy": {}, "source": "empty"}


# ── On-disk cross-worker cache ───────────────────────────────────────
def _write_cache(reg: Dict[str, Any]) -> None:
    """Persist the registry so workers that have NOT connected the pool
    can still answer GET /api/mcp/categories. Best-effort: a failure
    here only means no cross-worker sharing — the connecting worker
    still has its in-memory registry."""
    try:
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        # AUDIT 2026-08-23 — temporaire PROPRE AU PROCESS. Le nom était
        # CONSTANT pour toute la machine : le ``os.replace`` est atomique, mais
        # l'écriture qui le précède ne l'est pas (le registre pèse ~16 Ko, plus
        # que le tampon de 8 Ko de ``write_text``). Deux workers qui
        # ré-ingèrent en même temps ouvraient le MÊME fichier en O_TRUNC, avec
        # chacun son offset : leurs blocs s'entrelaçaient et le premier
        # ``os.replace`` publiait le mélange. Mesuré : 18 lectures corrompues
        # sur 5 200. Une fois le fichier illisible, tout worker n'ayant pas
        # encore connecté le pool voyait ``registry_source() == "empty"`` — donc
        # panneau d'outils VIDE et ``_collect_mcp_tools`` en fail-open.
        tmp = _CACHE_PATH.with_suffix(f"{_CACHE_PATH.suffix}.{os.getpid()}.tmp")
        try:
            tmp.write_text(json.dumps(reg, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, _CACHE_PATH)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
    except Exception:
        logger.debug("[MCP_CATEGORIES] cache write skipped", exc_info=True)


def _read_cache() -> Optional[Dict[str, Any]]:
    """Load the registry persisted by whichever worker connected the
    pool. Returns None if absent / unreadable / malformed."""
    try:
        if not _CACHE_PATH.is_file():
            return None
        data = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
        if (isinstance(data, dict)
                and isinstance(data.get("descriptors"), dict)
                and isinstance(data.get("tool_to_category"), dict)):
            data.setdefault("source", "live")
            data.setdefault("tool_descriptions", {})
            data.setdefault("tool_policy", {})
            return data
    except Exception:
        logger.debug("[MCP_CATEGORIES] cache read skipped", exc_info=True)
    return None


# ── Defensive field access (tools may be objects OR dicts) ───────────
def _get(obj: Any, *names: str) -> Any:
    """Return the first present attribute/key among ``names``."""
    for n in names:
        if isinstance(obj, dict):
            if n in obj and obj[n] is not None:
                return obj[n]
        else:
            v = getattr(obj, n, None)
            if v is not None:
                return v
    return None


def _extract_category(tool: Any):
    """From one tool object, return ``(category_name, display_descriptor)``.

    ``display_descriptor`` is whatever the server shipped in
    ``meta["category"]`` (a dict) — may be ``None`` if it only shipped
    a tag. Extraction is deliberately defensive: the wire shape of
    ``tags`` / ``meta`` has moved across FastMCP releases, so we try
    several paths and degrade gracefully.
    """
    # meta may live under .meta, ._meta, or nested in fastmcp's own key.
    meta = _get(tool, "meta", "_meta") or {}
    if isinstance(meta, dict):
        fm = meta.get("_fastmcp") if isinstance(meta.get("_fastmcp"), dict) else {}
        cat = meta.get("category") or fm.get("category")
        if isinstance(cat, dict) and cat.get("name"):
            return str(cat["name"]).strip().lower(), cat
        if isinstance(cat, str) and cat.strip():
            return cat.strip().lower(), None

    # tags: a set/list of strings. Prefer one we recognise; else take
    # the first non-empty tag as the category name.
    tags = _get(tool, "tags") or []
    try:
        tag_list = [str(t).strip().lower() for t in tags if str(t).strip()]
    except TypeError:
        tag_list = []
    for t in sorted(tag_list):
        if t in _STATIC_DISPLAY:
            return t, None
    if tag_list:
        # ``tags`` peut être un set (ordre d'itération non déterministe entre
        # process) → on trie pour un classement STABLE, sinon deux workers
        # pouvaient ranger le même tool dans des catégories différentes et le
        # cache disque partagé « flottait » (audit MAJ-7).
        return sorted(tag_list)[0], None

    return None, None


_POLICY_KEYS = ("timeout_s", "serial", "replay_safe", "prune", "deny_for")


def _extract_annotations(tool: Any) -> Dict[str, Any]:
    """Titre lisible et drapeau lecture seule d'un outil, tels que le serveur
    les déclare dans ``annotations`` (spec MCP). Sert au panneau d'outils :
    une case à cocher a besoin d'un libellé, et le témoin « lecture seule »
    dit d'un coup d'œil ce qui ne peut rien abîmer. Absent → ``{}``, le
    panneau retombe sur le nom brut. Lu aussi par ``_tool_traits`` (lecture
    seule, mutant)."""
    ann = _get(tool, "annotations") or {}
    if not isinstance(ann, dict):
        ann = {k: getattr(ann, k, None) for k in ("title", "readOnlyHint", "read_only_hint")}
    out: Dict[str, Any] = {}
    titre = ann.get("title")
    if titre:
        out["title"] = " ".join(str(titre).split())[:80]
    ro = ann.get("readOnlyHint")
    if ro is None:
        ro = ann.get("read_only_hint")
    if ro is not None:
        out["read_only"] = bool(ro)
    return out


def _extract_policy(tool: Any) -> Dict[str, Any]:
    """``meta["policy"]`` d'un outil (2026-09-11, P2) — politique d'exécution
    déclarée PAR LE SERVEUR (timeout, sérialisation, rejeu, élagage, rôles
    exclus). Défensif : clés inconnues ignorées, types normalisés."""
    meta = _get(tool, "meta", "_meta") or {}
    if not isinstance(meta, dict):
        return {}
    fm = meta.get("_fastmcp") if isinstance(meta.get("_fastmcp"), dict) else {}
    pol = meta.get("policy") or fm.get("policy")
    if not isinstance(pol, dict):
        return {}
    out: Dict[str, Any] = {}
    for k in _POLICY_KEYS:
        if k not in pol or pol[k] is None:
            continue
        v = pol[k]
        if k == "timeout_s":
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if v <= 0:
                continue
        elif k in ("serial", "replay_safe"):
            v = bool(v)
        elif k == "prune":
            v = str(v).strip().lower()
        elif k == "deny_for":
            v = sorted({str(x).strip().lower() for x in (v if isinstance(v, (list, tuple, set)) else [v]) if str(x).strip()})
        out[k] = v
    return out


def _normalize_descriptor(name: str,
                          shipped: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the canonical descriptor for a category from (in order of
    precedence) what the server shipped, the static map, then generics.
    Never carries a ``tools`` list — that's filled by ingest_tools()."""
    shipped = shipped or {}
    static = _STATIC_DISPLAY.get(name, {})
    return {
        "name":   name,
        "label":  str(shipped.get("label") or static.get("label") or name),
        "icon":   str(shipped.get("icon") or static.get("icon") or _GENERIC_DISPLAY["icon"]),
        "color":  str(shipped.get("color") or static.get("color") or _GENERIC_DISPLAY["color"]),
        "hidden": bool(shipped.get("hidden", static.get("hidden", _GENERIC_DISPLAY["hidden"]))),
        "tools":  [],
    }


# ── Ingestion (called by the MCP pool after connect) ─────────────────
def ingest_tools(tools: Any, source: Optional[str] = None) -> Dict[str, Any]:
    """Rebuild the registry from a ``list_tools()`` response.

    ``source`` (2026-09-12, P4) : clé du service ingéré — le registre publié
    est l'UNION des dernières ingestions de chaque source (service partagé +
    MCP interne de l'app), jamais la seule dernière.

    Called once each time the pool (re)connects an MCP server — the
    patched ``_mcp_pool._connect_new()`` does exactly that, with the
    COMPLETE pool tool set. Idempotent. Returns the new registry and
    persists it to the cross-worker cache.

    ``tools`` is whatever the MCP client's ``list_tools()`` yields — a
    list of tool objects or dicts. Anything without an extractable
    category is bucketed nowhere (``categorize`` → ``"other"``).
    """
    descriptors: Dict[str, Dict[str, Any]] = {}
    tool_to_category: Dict[str, str] = {}
    tool_descriptions: Dict[str, str] = {}
    tool_policy: Dict[str, Dict[str, Any]] = {}
    tool_annotations: Dict[str, Dict[str, Any]] = {}

    for tool in (tools or []):
        tname = _get(tool, "name")
        if not tname:
            continue
        tname = str(tname)
        desc = _get(tool, "description")
        if desc:
            tool_descriptions[tname] = " ".join(str(desc).split())[:220]
        pol = _extract_policy(tool)
        if pol:
            tool_policy[tname] = pol
        ann = _extract_annotations(tool)
        if ann:
            tool_annotations[tname] = ann
        cat_name, shipped = _extract_category(tool)
        if not cat_name:
            continue
        if cat_name not in descriptors:
            descriptors[cat_name] = _normalize_descriptor(cat_name, shipped)
        elif shipped:
            # enrich if a later tool of the same category shipped meta
            keep_tools = descriptors[cat_name]["tools"]
            descriptors[cat_name] = _normalize_descriptor(cat_name, shipped)
            descriptors[cat_name]["tools"] = keep_tools
        if tname not in descriptors[cat_name]["tools"]:
            descriptors[cat_name]["tools"].append(tname)
        tool_to_category[tname] = cat_name

    reg = {
        "descriptors": descriptors,
        "tool_to_category": tool_to_category,
        "tool_descriptions": tool_descriptions,
        "tool_policy": tool_policy,
        "tool_annotations": tool_annotations,
        "source": "live" if tool_to_category else "static",
    }

    # MAJ-8 — anti-amputation du cache cross-worker. Si cette ingestion est
    # VIDE (serveur SSE encore en cours de boot qui répond list_tools avant
    # d'avoir enregistré ses tools), on NE remplace PAS un registre déjà
    # peuplé : on garderait sinon un cache amputé écrasant les catégories pour
    # tous les workers. De même, si l'ingestion est partielle (moins de
    # catégories que ce qu'on connaît déjà), on MERGE (union) au lieu d'écraser
    # — le set d'outils locaux est stable, une catégorie ne disparaît jamais
    # légitimement en cours de run.
    if not tool_to_category:
        logger.warning(
            "[MCP_CATEGORIES] ingestion vide ignorée (registre existant conservé)")
        return _get_registry()

    if source:
        with _lock:
            _sources[str(source)] = reg
            _parts = list(_sources.values())
        merged = _parts[0]
        for _p in _parts[1:]:
            merged = _merge_registries(merged, _p)
        reg = merged

    existing = _get_registry()
    if existing.get("tool_to_category") and len(descriptors) < len(existing["descriptors"]):
        reg = _merge_registries(existing, reg)
        logger.info("[MCP_CATEGORIES] ingestion partielle → mergée avec le registre existant")

    with _lock:
        global _registry
        _registry = reg
        _disk_cache["at"] = time.time()
        _disk_cache["reg"] = reg
    _write_cache(reg)
    logger.info(
        "[MCP_CATEGORIES] ingested %d tools across %d categories (source=%s)",
        len(reg["tool_to_category"]), len(reg["descriptors"]), reg["source"])
    return reg


def _merge_registries(old: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    """Union de deux registres ; ``new`` gagne sur les clés communes. Les
    catégories/outils présents seulement dans ``old`` sont préservés (monotone,
    sans régression des catégories connues — cf. MAJ-8)."""
    descs: Dict[str, Any] = {k: dict(v) for k, v in (old.get("descriptors") or {}).items()}
    for k, v in (new.get("descriptors") or {}).items():
        descs[k] = dict(v)
    t2c: Dict[str, str] = dict(old.get("tool_to_category") or {})
    t2c.update(new.get("tool_to_category") or {})
    tdesc: Dict[str, str] = dict(old.get("tool_descriptions") or {})
    tdesc.update(new.get("tool_descriptions") or {})
    tpol: Dict[str, Any] = dict(old.get("tool_policy") or {})
    tpol.update(new.get("tool_policy") or {})
    tann: Dict[str, Any] = dict(old.get("tool_annotations") or {})
    tann.update(new.get("tool_annotations") or {})
    return {"descriptors": descs, "tool_to_category": t2c, "tool_descriptions": tdesc,
            "tool_policy": tpol, "tool_annotations": tann,
            "source": "live" if t2c else "static"}


# AUDIT 2026-08-23 — ``get_tool_catalog`` et ``invalidate_cache`` SUPPRIMÉES :
# 0 appelant, 0 importeur, 0 test dans tout le dépôt (code, tests, frontend).
# Toutes deux étaient annoncées dans l'« API publique » de la docstring de
# tête, ce qui entretenait l'illusion qu'elles étaient branchées :
# ``get_tool_catalog`` se disait « pour les pickers (création/édition
# d'agent) » alors qu'aucune route ni composant Vue ne la sert. La matière
# reste disponible via ``get_tool_categories_dict`` + ``tool_descriptions``.


def _get_registry() -> Dict[str, Any]:
    """In-memory registry if this worker connected the pool; otherwise
    the cross-worker on-disk cache (memoised for a few seconds);
    otherwise empty."""
    with _lock:
        if _registry is not None:
            return _registry
        now = time.time()
        if _disk_cache["reg"] is not None and (now - _disk_cache["at"]) < _DISK_TTL_SEC:
            return _disk_cache["reg"]
    cached = _read_cache()
    with _lock:
        _disk_cache["at"] = time.time()
        _disk_cache["reg"] = cached
    return cached if cached is not None else _empty_registry()


# ── Public API ───────────────────────────────────────────────────────
def get_categories(include_hidden: bool = False) -> List[Dict[str, Any]]:
    """All discovered categories, sorted by ``name``. Hidden categories
    excluded unless ``include_hidden=True``.

    (2026-09-11) Chaque descripteur porte ``default_on`` : la catégorie est-elle
    PRÉ-COCHÉE dans un nouveau chat ? Source : ``x-elpis.default_on`` des
    entrées intégrées du manifeste ``mcp.json`` (vide par défaut — aucun outil
    sélectionné d'office, décision utilisateur du 2026-07-13)."""
    descs = _get_registry()["descriptors"].values()
    if not include_hidden:
        descs = [d for d in descs if not d.get("hidden")]
    try:
        from shared_infra.mcp.manifest import load as _mf_load
        _on = _mf_load().default_on_categories()
    except Exception:
        _on = set()
    out = []
    for d in descs:
        d = dict(d)
        d["default_on"] = d["name"] in _on
        out.append(d)
    return sorted(out, key=lambda c: c["name"])


def get_tool_categories_dict(include_hidden: bool = True) -> Dict[str, List[str]]:
    """``{cat_name: [tool_name, ...]}`` — exact tool names from the live
    tool list. Empty only if no worker has connected the pool yet AND
    no cache exists; callers MUST treat "empty" as "unknown / don't
    filter", never "filter everything"."""
    descs = _get_registry()["descriptors"]
    out: Dict[str, List[str]] = {}
    for name, d in descs.items():
        if not include_hidden and d.get("hidden"):
            continue
        out[name] = list(d.get("tools", []))
    return out




def all_tool_names(include_hidden: bool = True) -> set:
    """Tous les noms d'outils connus (registre caché). VIDE si aucun worker n'a
    encore connecté le pool → les appelants traitent "vide" comme
    "inconnu / ne pas rejeter", jamais "tout rejeter"."""
    reg = _get_registry()
    if include_hidden:
        return set(reg.get("tool_to_category") or {})
    hidden = {n for n, d in reg["descriptors"].items() if d.get("hidden")}
    return {t for t, c in (reg.get("tool_to_category") or {}).items() if c not in hidden}


def categorize(tool_name: str) -> str:
    """Map a tool name → its category. ``"other"`` if unknown."""
    if not tool_name:
        return "other"
    return _get_registry()["tool_to_category"].get(tool_name, "other")


def is_hidden(category: str) -> bool:
    d = _get_registry()["descriptors"].get((category or "").strip().lower())
    return bool(d and d.get("hidden"))


def get_hidden_categories() -> List[str]:
    return sorted(name for name, d in _get_registry()["descriptors"].items()
                  if d.get("hidden"))


def tool_policy(tool_name: str) -> Dict[str, Any]:
    """Politique d'exécution déclarée par le serveur pour ``tool_name``
    (``meta.policy`` ingéré à la connexion), ``{}`` si inconnue — les
    appelants retombent alors sur leurs replis historiques."""
    if not tool_name:
        return {}
    return dict((_get_registry().get("tool_policy") or {}).get(tool_name) or {})


def tool_info(tool_name: str) -> Dict[str, Any]:
    """Fiche d'un outil pour le panneau : nom, titre lisible, description
    courte, lecture seule. Champs absents = le serveur ne les a pas déclarés ;
    l'appelant affiche alors le nom brut."""
    reg = _get_registry()
    nom = str(tool_name or "")
    fiche: Dict[str, Any] = {"name": nom}
    ann = (reg.get("tool_annotations") or {}).get(nom) or {}
    if ann.get("title"):
        fiche["title"] = ann["title"]
    if "read_only" in ann:
        fiche["read_only"] = bool(ann["read_only"])
    desc = (reg.get("tool_descriptions") or {}).get(nom)
    if desc:
        fiche["description"] = desc
    return fiche


def tools_denied_for(role: str, fallback: Any = ()) -> set:
    """Outils dont la politique retire l'usage au rôle ``role`` (``subagent``,
    ``routine``…). Registre VIDE (aucun worker n'a encore connecté le pool) →
    ``fallback`` : ne jamais laisser passer, par méconnaissance, un outil qui
    bloquerait un enfant sans UI."""
    reg = _get_registry()
    pols = reg.get("tool_policy") or {}
    # Registre vide OU serveur qui ne déclare AUCUNE politique (version
    # antérieure, serveur tiers) → le repli statique. Sinon la politique fait
    # foi : un serveur qui déclare des politiques déclare aussi ses ``deny_for``.
    if not pols or reg.get("source", "empty") == "empty" or not reg.get("tool_to_category"):
        return set(fallback or ())
    role = (role or "").strip().lower()
    return {t for t, p in pols.items() if role in (p.get("deny_for") or ())}


def registry_source() -> str:
    """``"live"`` (built from real tools), ``"static"`` (tools ingested
    but none carried a category), or ``"empty"`` (nothing yet)."""
    return _get_registry().get("source", "empty")


# Backwards-compat alias for any caller still importing the old name.
manifest_source = registry_source
