# SPDX-License-Identifier: MIT
"""
llm_core._desktop_session — frame ownership + observation cache for the desktop
(computer-use) tools. Sibling of ``_pw_session.py``.

Two independent registries, each touched by a different process:

  • Frame-token ownership  (WEB process: the chat loop registers a token→user
    when it sees a ``desktop_*`` result; ``GET /api/desktop/frame/{token}``
    reads it to scope access). One annotated/raw screenshot is written to a
    shared temp dir under an opaque token; the route serves it once.

  • Last-observation cache  (MCP-tool process: ``desktop_observe`` writes the
    element list; ``desktop_act`` reads it to resolve an ``element_id`` or a
    natural-language ``target`` to a click point). Both tools run in the same
    local_mcp_server process, so a plain in-memory dict is enough.

``_extract_desktop_frame`` is the desktop counterpart of
``_extract_pw_screenshot_url`` — the chat loop calls it to build the live
``annotation_frame`` SSE event from a tool result.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import logging

logger = logging.getLogger("uvicorn.error")

# Shared temp dir for annotated/raw frames. MUST be visible to BOTH the MCP-tool
# process (writes) and the web process (reads + serves). ``/tmp`` is shared like
# the Playwright ``PW_SCREENS_DIR``.
DESKTOP_SCREENS_DIR = os.environ.get("DESKTOP_SCREENS_DIR", "/tmp/desktop_screens")

_TOKEN_RE = re.compile(r"[A-Za-z0-9_\-]{8,64}")


def desktop_frame_path(token: str) -> str:
    """Absolute path of the PNG backing a frame token."""
    return os.path.join(DESKTOP_SCREENS_DIR, f"frame_{token}.png")


def _frame_owner_path(token: str) -> str:
    """Sidecar file carrying the frame's owner (username), next to its PNG.

    R9 — la propriété en mémoire (``_frame_owners``) est PAR worker gunicorn : une
    frame écrite par le worker MCP / le rejeu n'était pas « possédée » côté worker
    web → on servait alors la frame à N'IMPORTE quel utilisateur (soft-pass). Le
    sidecar disque (dossier partagé) rend la propriété visible cross-process."""
    return os.path.join(DESKTOP_SCREENS_DIR, f"frame_{token}.owner")


def write_frame_owner(token: str, owner: str) -> None:
    """Écrit le sidecar de propriété (best-effort) à côté du PNG de la frame."""
    if not token or not owner:
        return
    try:
        with open(_frame_owner_path(token), "w", encoding="utf-8") as f:
            f.write(str(owner))
    except Exception as e:
        logger.warning("[desktop] frame owner sidecar failed: %s", e)


def ensure_screens_dir() -> None:
    try:
        os.makedirs(DESKTOP_SCREENS_DIR, exist_ok=True)
    except Exception:
        pass


_last_prune_ts = 0.0
_PRUNE_MIN_INTERVAL_S = 30.0     # P8 : ne PAS rescanner le dossier à chaque save


def prune_frames(ttl_sec: int = 900, force: bool = False) -> None:
    """Best-effort cleanup of stale frame PNGs (+ owner sidecars). Frames are
    served repeatably (chat panel AND Studio may fetch the same token), so we age
    them out here instead of deleting on first serve.

    P8 — THROTTLÉ : ``prune_frames`` était appelé à CHAQUE ``_save_frame`` → un
    ``os.listdir`` complet (+ getmtime) par action/observe. On limite le scan à un
    par ``_PRUNE_MIN_INTERVAL_S`` (``force=True`` pour les tests / la maintenance)."""
    global _last_prune_ts
    try:
        now = time.time()
        if not force and (now - _last_prune_ts) < _PRUNE_MIN_INTERVAL_S:
            return
        _last_prune_ts = now
        if not os.path.isdir(DESKTOP_SCREENS_DIR):
            return
        for fn in os.listdir(DESKTOP_SCREENS_DIR):
            if not fn.startswith("frame_"):
                continue
            p = os.path.join(DESKTOP_SCREENS_DIR, fn)
            try:
                if now - os.path.getmtime(p) > ttl_sec:
                    os.remove(p)
            except Exception:
                pass
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Frame-token ownership (web process)
# ─────────────────────────────────────────────────────────────────────────────
_frame_owners: Dict[str, str] = {}
_frame_lock = threading.Lock()
_FRAME_OWNERS_MAX = 500


def register_desktop_frame_owner(token: str, username: str) -> None:
    """Enregistre le propriétaire d'une frame : mémoire (accès rapide, par worker)
    ET sidecar disque (R9, partagé cross-worker/process). UN seul point d'écriture
    de propriété (le read fait mémoire → sidecar → hydrate)."""
    if not token or not username:
        return
    with _frame_lock:
        _frame_owners[token] = username
        if len(_frame_owners) > _FRAME_OWNERS_MAX:  # FIFO eviction
            for old in list(_frame_owners.keys())[:-_FRAME_OWNERS_MAX]:
                _frame_owners.pop(old, None)
    write_frame_owner(token, username)


def get_desktop_frame_owner(token: str) -> Optional[str]:
    if not token:
        return None
    owner = _frame_owners.get(token)
    if owner is not None:
        return owner
    # R9 — pas en mémoire (frame écrite par un AUTRE worker/process) : lire le
    # sidecar disque et hydrater le cache mémoire pour les prochains accès.
    if not _TOKEN_RE.fullmatch(token):     # défense : pas de traversée via le token
        return None
    try:
        with open(_frame_owner_path(token), "r", encoding="utf-8") as f:
            owner = (f.read() or "").strip()
    except Exception:
        return None
    if owner:
        with _frame_lock:
            _frame_owners[token] = owner
        return owner
    return None


# AUDIT 2026-08-23 — ``unregister_desktop_frame_owner`` SUPPRIMÉE : 0 appelant,
# 0 importeur, 0 test. Elle était de surcroît INCOHÉRENTE avec le mécanisme
# actuel — elle ne purgeait que le cache mémoire, alors que
# ``register_desktop_frame_owner`` écrit AUSSI un sidecar disque que
# ``get_desktop_frame_owner`` relit : l'appeler aurait été un no-op observable
# (la propriété serait revenue au premier accès). Le cycle de vie réel est
# assuré par ``prune_frames``, qui supprime PNG et sidecar ensemble au TTL.
# Si un besoin de révocation explicite apparaît, la réintroduire COMPLÈTE (en
# miroir de ``unregister_pw_session_owner`` : mémoire ET ``os.unlink`` du
# sidecar) — et l'appeler quelque part.


# ─────────────────────────────────────────────────────────────────────────────
# Last-observation cache (MCP-tool process)
# ─────────────────────────────────────────────────────────────────────────────
_observations: Dict[str, Dict[str, Any]] = {}   # "user::target" → {elements, ts}
_obs_lock = threading.Lock()
_OBS_MAX = 200


def _obs_key(username: str, target: str) -> str:
    return f"{username or '?'}::{target or '?'}"


# Dimensions de la DERNIÈRE capture par cible (écran sélectionné) → permet de
# valider/borner les coordonnées BRUTES d'une action avant de les envoyer à
# l'agent (un clic hors-écran sur des coords périmées tombe sinon n'importe où).
_screen_dims: Dict[str, Tuple[int, int]] = {}
_COORD_MARGIN = 2   # tolérance en px (bord exact) avant rejet


def set_screen_dims(username: str, target: str, w: int, h: int) -> None:
    try:
        w, h = int(w), int(h)
    except (TypeError, ValueError):
        return
    if w > 0 and h > 0:
        _screen_dims[_obs_key(username, target)] = (w, h)


def get_screen_dims(username: str, target: str) -> Optional[Tuple[int, int]]:
    return _screen_dims.get(_obs_key(username, target))


def validate_point(point, dims: Optional[Tuple[int, int]]):
    """Borne un point d'action. Renvoie le point (clampé aux pixels de bord si un
    léger dépassement) ou None s'il est FRANCHEMENT hors-écran (au-delà de la
    marge) → l'appelant transforme None en erreur explicite plutôt que de cliquer
    dans le vide. Sans dimensions connues, ne rejette que le négatif aberrant."""
    if not point or len(point) < 2:
        return None
    try:
        x, y = int(point[0]), int(point[1])
    except (TypeError, ValueError):
        return None
    m = _COORD_MARGIN
    if dims is None:
        # Pas de capture connue : on ne peut pas borner en haut, mais un négatif
        # franc est forcément faux (origine écran = 0,0 côté agent).
        if x < -m or y < -m:
            return None
        return (max(0, x), max(0, y))
    w, h = dims
    if x < -m or y < -m or x > w + m or y > h + m:
        return None
    return (min(max(0, x), w - 1), min(max(0, y), h - 1))


def register_desktop_observation(username: str, target: str, elements: List[Dict[str, Any]]) -> None:
    with _obs_lock:
        _observations[_obs_key(username, target)] = {"elements": list(elements or []), "ts": time.time()}
        if len(_observations) > _OBS_MAX:
            for old in list(_observations.keys())[:-_OBS_MAX]:
                _observations.pop(old, None)
                # R5 — les satellites clé-par-cible (_screen_dims, _obs_seq)
                # grandissaient SANS éviction : purger les clés orphelines en même
                # temps que l'observation qu'elles accompagnent.
                _screen_dims.pop(old, None)
                _obs_seq.pop(old, None)


def get_desktop_observation(username: str, target: str) -> List[Dict[str, Any]]:
    rec = _observations.get(_obs_key(username, target))
    return list(rec.get("elements", [])) if rec else []


_obs_seq: Dict[str, int] = {}   # clé cible → compteur el_N monotone (ids stables)


def assign_stable_ids(username: str, target: str,
                      elements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Réaffecte les id ``el_N`` en RÉUTILISANT celui de l'observation précédente
    pour tout élément de même ``runtime_id`` (UIA, stable intra-session) ou, à
    défaut, de même ``auto_id``. Tue l'« index drift » : entre deux observations
    d'un écran quasi identique, le même contrôle GARDE son id → un ``element_id``
    capturé par le modèle reste valide même si l'arbre a été re-numéroté entre la
    capture et l'action (observe_after, attente…). Compteur MONOTONE par cible :
    un nouvel élément ne réutilise jamais un ancien numéro (pas de collision). Mute
    ``elements`` en place (id) et le renvoie. No-op de fait sur la 1ʳᵉ observation
    (pas de précédent → numérotation el_1..el_N comme avant)."""
    key = _obs_key(username, target)
    with _obs_lock:
        prev = (_observations.get(key) or {}).get("elements") or []
        seq = _obs_seq.get(key, 0)
    prev_rid: Dict[str, str] = {}
    prev_aid: Dict[str, str] = {}
    for pe in prev:
        pid = pe.get("id")
        if not pid:
            continue
        rid = str(pe.get("runtime_id") or "")
        aid = str(pe.get("auto_id") or "")
        if rid:
            prev_rid.setdefault(rid, pid)
        if aid:
            prev_aid.setdefault(aid, pid)
    used: set = set()
    pending: List[Dict[str, Any]] = []
    for e in elements:
        rid = str(e.get("runtime_id") or "")
        aid = str(e.get("auto_id") or "")
        reuse = None
        if rid and prev_rid.get(rid) and prev_rid[rid] not in used:
            reuse = prev_rid[rid]
        elif aid and prev_aid.get(aid) and prev_aid[aid] not in used:
            reuse = prev_aid[aid]
        if reuse:
            e["id"] = reuse
            used.add(reuse)
        else:
            pending.append(e)
    for e in pending:
        while True:
            seq += 1
            cand = f"el_{seq}"
            if cand not in used:
                break
        e["id"] = cand
        used.add(cand)
    with _obs_lock:
        _obs_seq[key] = seq
    return elements


def _element_center(e: Dict[str, Any]):
    c = e.get("center") or []
    if len(c) >= 2:
        return (float(c[0]), float(c[1]))
    b = e.get("box") or []
    if len(b) >= 4:
        return ((float(b[0]) + float(b[2])) / 2.0, (float(b[1]) + float(b[3])) / 2.0)
    return None


def _pick_best(cands: List[Dict[str, Any]], *, near=None, role=None,
               query=None) -> Optional[Dict[str, Any]]:
    """Départage plusieurs candidats : même rôle > frontière de mot (label ==/
    commence par) > proximité à ``near`` (box enregistrée) > 1er. Stable et
    explicable — évite le « premier gagne » qui clique « Save As » pour « Save »."""
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    rl = str(role or "").strip().lower()
    q = str(query or "").strip().lower()

    def _score(e: Dict[str, Any]) -> float:
        s = 0.0
        if rl and str(e.get("role") or "").strip().lower() == rl:
            s += 100.0
        if q:
            lbl = str(e.get("label") or e.get("name") or "").strip().lower()
            if lbl == q:
                s += 50.0
            elif lbl.startswith(q):
                s += 20.0
        if near is not None:
            c = _element_center(e)
            if c is not None:
                d = ((c[0] - near[0]) ** 2 + (c[1] - near[1]) ** 2) ** 0.5
                s += max(0.0, 40.0 - d / 50.0)   # plus proche de la box d'origine = mieux
        # Préfère l'élément RÉELLEMENT actionnable : un doublon hors-écran (onglet
        # masqué, élément virtualisé replié) ou désactivé est fortement déprié →
        # casse les collisions de label « le bon OK » sans hint explicite.
        st = [str(x).lower() for x in (e.get("states") or [])]
        if "offscreen" in st:
            s -= 30.0
        if "enabled" in st:
            s += 5.0
        return s

    # max() est stable → à score égal, le 1er candidat (ordre d'observation) gagne.
    return max(cands, key=_score)


# ── Cache d'actions (mémoire inter-session des ancres) ──────────────────────
# Wrappers best-effort autour de la table ``editor_action_cache`` (DB partagée).
# Tout échec (table absente, DB occupée) retombe silencieusement sur la
# résolution normale — le cache n'est JAMAIS un point de panne.
_anchor_write_memo: Dict[str, str] = {}   # "scope|query" → auto_id déjà écrit (dédup write intra-process)


def _lookup_pinned_anchor(username: str, target: str, q: str) -> Optional[str]:
    try:
        from shared_infra.desktop.anchors import lookup_action_anchor
        rec = lookup_action_anchor(_obs_key(username, target), q)
        return rec.get("auto_id") if rec else None
    except Exception:
        return None


def _learn_anchor(username: str, target: str, q: str, el: Optional[Dict[str, Any]]) -> None:
    """Mémorise l'auto_id stable d'un élément résolu par requête (si présent).
    Dédupe les écritures identiques en process (long rejeu = des centaines de
    résolutions, inutile de réécrire la même ligne à chaque fois)."""
    if not el:
        return
    aid = str(el.get("auto_id") or "").strip()
    if not aid:
        return
    scope = _obs_key(username, target)
    memo_key = f"{scope}|{q}"
    if _anchor_write_memo.get(memo_key) == aid:
        return
    try:
        from shared_infra.desktop.anchors import record_action_anchor
        record_action_anchor(scope, q, aid, role=str(el.get("role") or ""),
                             center=el.get("center"))
        _anchor_write_memo[memo_key] = aid
        if len(_anchor_write_memo) > 1000:
            _anchor_write_memo.clear()
    except Exception:
        pass


def _resolve_element_impl(username: str, target: str,
                          element_id: Optional[str] = None,
                          query: Optional[str] = None,
                          auto_id: Optional[str] = None,
                          near=None, role: Optional[str] = None,
                          runtime_id: Optional[str] = None) -> Tuple[Optional[Dict[str, Any]], str]:
    """Cœur de :func:`resolve_element` qui remonte AUSSI *comment* l'élément a été
    résolu : ``runtime_id`` / ``auto_id`` / ``element_id`` / ``cache_pin`` /
    ``exact_label`` / ``substring`` (ou ``""`` si rien). Ce ``resolved_by`` sert
    au feedback modèle (A2) — un 30-129B voit s'il a visé une ancre stable ou un
    simple substring fragile, et arrête de rejouer à l'aveugle. Renvoie
    ``(element|None, method)``."""
    els = get_desktop_observation(username, target)
    if runtime_id:
        for e in els:
            if str(e.get("runtime_id") or "") == str(runtime_id):
                return e, "runtime_id"
    if auto_id:
        for e in els:
            if str(e.get("auto_id") or "") == str(auto_id):
                return e, "auto_id"
    if element_id:
        for e in els:
            if str(e.get("id")) == str(element_id):
                return e, "element_id"
    if query:
        q = query.strip().lower()
        if q:
            # Cache-first : une ancre déjà épinglée pour cette requête bat le
            # re-devinage — MAIS uniquement quand l'appelant ne fournit pas de
            # désambiguïsateur explicite (near/role) qui doit primer, et SEULEMENT
            # si l'élément épinglé est toujours là ET cohérent (le label contient
            # encore la requête → l'auto_id n'a pas été réattribué à un autre
            # contrôle). Sinon on retombe sur la résolution normale (et on
            # ré-apprend la nouvelle ancre).
            if near is None and not role:
                pinned = _lookup_pinned_anchor(username, target, q)
                if pinned:
                    for e in els:
                        if str(e.get("auto_id") or "") == pinned:
                            lbl = str(e.get("label") or e.get("name") or "").lower()
                            if q in lbl:
                                return e, "cache_pin"
                            break
            exact = [e for e in els
                     if str(e.get("label") or "").strip().lower() == q
                     or str(e.get("name") or "").strip().lower() == q]
            if exact:
                best = _pick_best(exact, near=near, role=role, query=q)
                _learn_anchor(username, target, q, best)
                return best, "exact_label"
            subs = [e for e in els
                    if q in str(e.get("label") or "").lower()
                    or q in str(e.get("name") or "").lower()]
            if subs:
                best = _pick_best(subs, near=near, role=role, query=q)
                _learn_anchor(username, target, q, best)
                return best, "substring"
    return None, ""


def resolve_element(username: str, target: str,
                    element_id: Optional[str] = None,
                    query: Optional[str] = None,
                    auto_id: Optional[str] = None,
                    near=None, role: Optional[str] = None,
                    runtime_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Resolve a cached observation element by ``runtime_id`` (UIA identity,
    stable WITHIN the session even if label/position move), then by ``auto_id``
    (stable UIA/AT-SPI id, also across sessions), then ``element_id``, then a
    PINNED anchor from the action cache, then exact label/name, then a
    DISAMBIGUATED substring (rôle + proximité à ``near`` si fourni, au lieu du
    premier match). Successful query resolutions LEARN their stable auto_id into
    the cache. Returns the element dict (with ``center``) or None. Voir
    ``_resolve_element_impl`` pour la variante qui remonte la méthode."""
    return _resolve_element_impl(
        username, target, element_id=element_id, query=query, auto_id=auto_id,
        near=near, role=role, runtime_id=runtime_id,
    )[0]


def ambiguous_query_candidates(username: str, target: str,
                               query: Optional[str]) -> Optional[List[Dict[str, Any]]]:
    """Chemin chat (T2-F) : une requête textuelle qui matche EXACTEMENT (label/
    name) PLUSIEURS éléments DISTINCTS, sans ancre épinglée pour trancher, est
    ambiguë → renvoie la liste des candidats (≥2) pour que l'appelant demande un
    ``element_id`` au lieu de cliquer au hasard. Renvoie None si non ambiguë (0/1
    cible, ou une ancre cache tranche) → l'appelant résout normalement. Les
    correspondances en SOUS-CHAÎNE ne sont PAS bloquées (``_pick_best`` les
    départage déjà). Lecture pure du cache — ne mute rien, ne lève jamais."""
    q = str(query or "").strip().lower()
    if not q:
        return None
    els = get_desktop_observation(username, target)
    exact = [e for e in els
             if str(e.get("label") or "").strip().lower() == q
             or str(e.get("name") or "").strip().lower() == q]
    # Cibles DISTINCTES seulement (un même contrôle ré-listé ne compte qu'une fois).
    seen: set = set()
    distinct: List[Dict[str, Any]] = []
    for e in exact:
        k = (str(e.get("auto_id") or "") or str(e.get("runtime_id") or "")
             or str(e.get("id") or ""))
        if k in seen:
            continue
        seen.add(k)
        distinct.append(e)
    if len(distinct) < 2:
        return None
    # Une ancre épinglée (résolution apprise) tranche → pas d'ambiguïté à signaler.
    pinned = _lookup_pinned_anchor(username, target, q)
    if pinned and any(str(e.get("auto_id") or "") == pinned for e in distinct):
        return None
    return distinct


# ─────────────────────────────────────────────────────────────────────────────
# Cible ACTIVE par utilisateur (sélecteur UI) — partagée web ↔ process d'outils
# ─────────────────────────────────────────────────────────────────────────────
# Persistée sur disque (JSON {username: target}) pour être visible des DEUX
# process (le web l'écrit via /api/desktop/active-target ; les outils desktop la
# lisent comme cible par défaut quand le modèle ne précise pas de ``target``).
_active_lock = threading.Lock()


def _active_path() -> str:
    p = os.environ.get("DESKTOP_ACTIVE_PATH")
    if p:
        return p
    try:
        from shared_infra.config import DB_PATH
        return os.path.join(os.path.dirname(str(DB_PATH)), "desktop_active.json")
    except Exception:
        return "/tmp/desktop_active.json"


def get_active_target(username: str) -> str:
    if not username:
        return ""
    try:
        with open(_active_path(), "r", encoding="utf-8") as f:
            return str((json.load(f) or {}).get(username, "") or "")
    except Exception:
        return ""


def set_active_target(username: str, target: str) -> None:
    if not username:
        return
    with _active_lock:
        path = _active_path()
        data = {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception:
            data = {}
        if target:
            data[username] = target
        else:
            data.pop(username, None)
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, path)
        except Exception as e:
            logger.warning("[desktop] écriture cible active échouée: %s", e)


# ─────────────────────────────────────────────────────────────────────────────
# Frame extraction for the chat-loop SSE (web process)
# ─────────────────────────────────────────────────────────────────────────────
def _extract_desktop_frame(tool_name: str, tool_args: Any,
                           result_json: str) -> Optional[Dict[str, Any]]:
    """If this is a ``desktop_*`` tool whose result carries a ``frame_token``,
    return the dict the chat loop needs to emit ``annotation_frame`` + enrich
    the ``tool_result`` event:

        {"url", "step"(token), "session_id"(target), "img_w", "img_h",
         "boxes"(elements), "token"}

    Returns None otherwise. Pure function — no counter kept here."""
    if not tool_name or not tool_name.startswith("desktop_"):
        return None
    if not result_json:
        return None
    try:
        data = json.loads(result_json)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    token = data.get("frame_token")
    if not token or not isinstance(token, str) or not _TOKEN_RE.fullmatch(token):
        return None
    target = ""
    if isinstance(data.get("target"), str):
        target = data["target"]
    elif isinstance(tool_args, dict) and isinstance(tool_args.get("target"), str):
        target = tool_args["target"]
    ts = int(time.time() * 1000)
    boxes = data.get("elements")
    return {
        "url": f"/api/desktop/frame/{token}?t={ts}",
        "step": token,
        "session_id": target,
        "img_w": int(data.get("img_w") or 0),
        "img_h": int(data.get("img_h") or 0),
        "boxes": boxes if isinstance(boxes, list) else [],
        "token": token,
        "sig": data.get("sig") or "",
    }
