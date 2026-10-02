# SPDX-License-Identifier: MIT
# tools/firefox_tools.py — Playwright browser tools (pw_*)
"""
Playwright browser automation MCP — the ``pw_*`` tools, English descriptions.

Core tools (pw_session, pw_find, pw_act, pw_page, pw_dialog, pw_wait) and
IHM testing / observation tools (pw_expect, pw_chain, pw_mock, pw_recorder,
pw_observe, pw_a11y, pw_visual, pw_memory) all live here; they drive the
Node browser service over HTTP (pw_memory reads the local AX memory).

Context-efficiency knobs are optional parameters (the wire format of a
call without them is unchanged):
  - pw_page(action="inspect") supports level=lite|nav|full, since_step=N,
    viewport_only, max_items.
  - pw_act accepts a unified `target` DSL (e.g. "role=button|name=Login")
    in addition to the separate selector params (full back-compat).
  - pw_session("list") supports url_filter to retrieve session_id by domain.
  - pw_page(action="eval") result is bounded.
  - back/forward record transitions in AX memory.
"""
from __future__ import annotations

import contextvars
import json
import os
import re
import time
from typing import Any, Dict, List, Tuple, Union

import requests
from fastmcp import Context, FastMCP

from ._models import (
    ErrEnvelope,
    PWA11yResult,
    PWActResult,
    PWChainResult,
    PWExpectResult,
    PWFindResult,
    PWMemoryResult,
    PWMockResult,
    PWObserveResult,
    PWPageResult,
    PWRecorderResult,
    PWSessionResult,
    PWVisualResult,
    PWWaitResult,
)
from ._toolkit import (  # politique par outil (with_policy), battement (Heartbeat)
    Heartbeat,
    clip_text,
    err as _tk_err,
    get_username,
    tool_kw,
    tool_kw_mutating,
    tool_kw_openworld,
    with_policy,
)

# ── Category descriptor (see fs_tools.CATEGORY for the contract) ──────
# Notes for the auto-discovery: tools registered below carry MCP names
# like ``pw_session``, ``pw_find``... so a prefix-only check ("pw_")
# covers them all and any future ``pw_*`` extras.
CATEGORY = {
    "name":  "browser",
    "label": "Navigateur",
    "icon":  "ph-globe",
    "color": "sky",
    # No "tools" list — captured automatically at registration time: a
    # hand-maintained list drifts (tools declared but never registered,
    # registered tools left out).
}

# Category carried IN the protocol (tags + meta), built by the shared
# toolkit — one place to change if a FastMCP version ever rejects meta=.
_TOOL_KW = tool_kw(CATEGORY)

# Per-behaviour annotation keysets for pw_* tools.
# Every browser op talks to a Firefox sidecar over HTTP → open-world.
#   pw_session  → mutating (creates/closes browser sessions), open-world
#   pw_find     → read-only (queries the DOM), still open-world (network)
#   pw_act      → mutating (click/fill/type), open-world
#   pw_page     → mutating for navigate/reload/back/forward,
#                 read-only for status/title/url/cookies.
#                 We mark it mutating+open-world (the union); the LLM
#                 wraps confirmation around the action arg if needed.
#   pw_expect   → read-only (assertion, no state change), open-world
#   pw_chain    → mutating multi-step sequence, open-world
#   pw_mock     → mutating (installs/removes request mocks), open-world
#   pw_recorder → mutating (toggles recording state), open-world
_TOOL_KW_OW_RO  = tool_kw_openworld(CATEGORY, read_only=True, serial=True)
_TOOL_KW_OW_MUT = tool_kw_mutating(CATEGORY, open_world=True, serial=True)


def _err(msg: str, hint: str = "", *, code: str = "", message: str = "",
         fix: str = "", **kw) -> Dict[str, Any]:
    """Harmonized error envelope (tools/_toolkit.py). Firefox keeps its
    {"error": ...} convention — callers detect failure via .get("error")
    — with `error` as a stable machine code, the human text in `message`,
    and the hint as the standard `fix`.

    ``message=``/``fix=`` permettent de dissocier le CODE (``msg``, slugifié)
    de la phrase rendue au modèle. Ne pas les retirer de la signature :
    ``_err("x", message=…, fix=…)`` lèverait un ``TypeError`` (``fix`` passé
    deux fois à ``_toolkit.err``) et un garde-fou écrit ainsi planterait au
    lieu de renvoyer son enveloppe."""
    _code = code or (
        re.sub(r"[^a-z0-9]+", "_", str(msg).lower()).strip("_")[:40] or "browser_error"
    )
    return _tk_err(_code, message or str(msg), fix=(fix or hint) or None, **kw)


# ── Token-budget safety net (axis 1: perception that never overloads) ──
# The node service already trims perception (smart_inspect level=lite,
# viewport_only, max_items). This is the LAST line of defence: a result
# that is STILL pathologically large gets its long string fields clipped
# with an honest marker. No-op for normal payloads — structure and keys
# are always preserved, so a 30B model is never flooded by one page.
_RESULT_BUDGET = max(4000, int(os.environ.get("PLAYWRIGHT_RESULT_BUDGET", "24000") or 24000))

def _clip_result(obj: Any, *, str_cap: int = 2000) -> Any:
    """Clip oversized string fields in a node-service result. No-op when
    the payload is already within budget (the common case)."""
    try:
        if len(json.dumps(obj, default=str)) <= _RESULT_BUDGET:
            return obj
    except (TypeError, ValueError):
        return obj
    def _walk(o, depth=0):
        if depth > 12:
            return o
        if isinstance(o, str):
            return clip_text(o, str_cap, label="champ") if len(o) > str_cap else o
        if isinstance(o, dict):
            return {k: _walk(v, depth + 1) for k, v in o.items()}
        if isinstance(o, list):
            return [_walk(v, depth + 1) for v in o]
        return o
    clipped = _walk(obj)
    try:
        if len(json.dumps(clipped, default=str)) > _RESULT_BUDGET * 2:
            return {"ok": True, "_truncated": True,
                    "note": ("page result too large even after clipping — "
                             "use level='lite', viewport_only=True, or a "
                             "narrower selector/target"),
                    "partial": str(clipped)[:_RESULT_BUDGET]}
    except (TypeError, ValueError):
        pass
    return clipped

# ── AX memory hooks (best-effort, never break tool calls) ──
# IMPORTANT : ce flag conditionne TOUT l'enregistrement AX. S'il passe à
# False silencieusement (échec d'import de shared_infra.memory.ax), la mémoire
# n'est plus alimentée du tout — sans le moindre signal. On loggue donc
# explicitement les deux cas, succès ET échec (avec l'exception).
import logging as _ax_logging

_ax_log = _ax_logging.getLogger("tools.firefox_tools.ax")
try:
    from shared_infra.memory.ax import record_action as _ax_record_action, record_inspection as _ax_record_inspection
    _AX_ENABLED = True
    _ax_log.info(
        "[ax] memory hooks ENABLED — record_action/record_inspection "
        "imported OK (pid=%s)", os.getpid(),
    )
except Exception as _ax_import_err:
    _AX_ENABLED = False
    def _ax_record_action(*a, **kw): return None
    def _ax_record_inspection(*a, **kw): return {"revived": 0, "deleted": 0}
    _ax_log.warning(
        "[ax] memory hooks DISABLED — import of backend.ax_memory failed: "
        "%r. AX memory will NOT be fed in this process.", _ax_import_err,
    )


def _ax_get_current_url(session_id: str) -> str:
    try:
        r = _req("GET", "/smart_inspect", params={
            "session_id": session_id, "skip_screenshot": "true", "level": "lite",
        })
        if isinstance(r, dict):
            return r.get("url") or ""
    except Exception:
        pass
    return ""


def _ax_extract_nodes_from_inspect(inspect_result: Any) -> List[Dict]:
    nodes: List[Dict] = []
    if not isinstance(inspect_result, dict):
        return nodes
    candidates = []
    for key in ("elements", "interactive", "interactives", "buttons", "inputs", "links", "nodes"):
        v = inspect_result.get(key)
        if isinstance(v, list):
            candidates.extend(v)
    tree = inspect_result.get("tree") or inspect_result.get("ax_tree")
    if isinstance(tree, (list, dict)):
        def _walk(n):
            if isinstance(n, dict):
                role = n.get("role") or n.get("type") or ""
                name = n.get("name") or n.get("text") or n.get("label") or ""
                if role:
                    nodes.append({"role": role, "name": name})
                for child_key in ("children", "nodes"):
                    for c in (n.get(child_key) or []):
                        _walk(c)
            elif isinstance(n, list):
                for c in n:
                    _walk(c)
        _walk(tree)
    for c in candidates:
        if not isinstance(c, dict):
            continue
        role = c.get("role") or c.get("tag") or c.get("type") or ""
        name = c.get("name") or c.get("text") or c.get("label") or c.get("accessible_name") or ""
        if role:
            nodes.append({"role": role, "name": name})
    return nodes


NODE_API = os.environ.get("PLAYWRIGHT_API_URL", "http://localhost:3000")
# Headless par défaut : économise CPU/RAM (pas de rendu GPU, pas de fenêtre X).
# Mettre PLAYWRIGHT_HEADLESS=false dans l'env pour forcer le mode fenêtré (debug).
HEADLESS = os.environ.get("PLAYWRIGHT_HEADLESS", "true").lower() == "true"
TIMEOUT = int(os.environ.get("PLAYWRIGHT_TIMEOUT", "10"))
VISION = os.environ.get("PLAYWRIGHT_VISION", "false").lower() == "true"

# Eval result hard cap (chars). Anything over is truncated with a clear marker.
EVAL_RESULT_MAX_CHARS = int(os.environ.get("PLAYWRIGHT_EVAL_MAX_CHARS", "50000"))

# ── pw_wait knobs ─────────────────────────────────────────────────────
# Chunked polling: each /wait_for_dynamic call caps its server-side wait at
# _WAIT_CHUNK_MS so a long wait never holds the Node per-session mutex
# (LOCK_WAIT_MS = 90s) for more than one chunk, and every request stays well
# under Node's default requestTimeout (~300s). _WAIT_MAX_S is the hard client
# cap on total wait time (and on a fixed pause); the agent-loop bound for
# pw_wait (``timeout_s=330.0`` in its ``with_policy`` below; fallback
# ``_TOOL_TIMEOUT_DEFAULTS`` in ``llm_core/engine/tool_dispatch.py``) is set
# above it so a legitimate wait is never cut short as a "tool timeout".
_WAIT_MAX_S    = int(os.environ.get("PLAYWRIGHT_WAIT_MAX_S", "300"))
_WAIT_CHUNK_MS = int(os.environ.get("PLAYWRIGHT_WAIT_CHUNK_MS", "8000"))


# Propriétaire de l'appel d'outil en cours : posé au début de
# chaque outil pw_* (par ``_refus_session_d_autrui``, que tous appellent) et
# transmis au service navigateur à CHAQUE requête, qui ne sert une session
# qu'à son propriétaire. ContextVar : un appel d'outil = un contexte copié,
# pas de fuite d'un appel à l'autre.
_PW_OWNER: contextvars.ContextVar[str] = contextvars.ContextVar("pw_owner", default="")


def _avec_proprietaire(json=None, params=None, method="POST"):
    """Ajoute ``owner`` au corps (POST) ou aux paramètres (GET)."""
    owner = _PW_OWNER.get()
    if not owner:
        return json, params
    if method == "GET":
        params = dict(params or {})
        params.setdefault("owner", owner)
    elif json is None or isinstance(json, dict):
        json = dict(json or {})
        json.setdefault("owner", owner)
    return json, params


def _refus_url(url) -> Any:
    """Enveloppe d'erreur si le navigateur n'a pas le droit de joindre
    ``url`` (même politique que le service, refus anticipé avec un message
    clair), sinon ``None``."""
    try:
        from shared_infra.security.browser_url import browser_url_block_reason, refus_message
        motif = browser_url_block_reason(str(url or ""))
    except Exception:                                           # noqa: BLE001
        return None           # le service applique de toute façon la garde
    if not motif:
        return None
    return _err("url_blocked", message=refus_message(str(url or ""), motif),
                fix="choisissez une adresse http(s) d'un site hors de la machine qui héberge Elpis")


def _refus_session_d_autrui(session_id, username: str):
    """Refuse une session Playwright qui appartient à un AUTRE compte.

    Chaque ``pw_*`` vérifie ici, contre le registre de propriété (sidecar
    disque cross-worker), à qui appartient le ``session_id`` reçu du modèle :
    un compte qui obtient un identifiant de session —
    ``pw_session(action='list')`` le donne, avec le propriétaire et l'URL —
    ne doit pas pouvoir lire ni piloter la session authentifiée d'un autre.

    Un propriétaire INCONNU du registre n'ouvre aucun passe-droit : la
    session est refusée, et ``pw_session(action='start')`` la rend (il
    réutilise l'instance du compte et réenregistre sa propriété). Le service
    navigateur vérifie de son côté le propriétaire transmis à chaque requête
    (``_PW_OWNER``) : ce contrôle-ci n'est que le refus anticipé.
    """
    try:
        from shared_infra.security.browser_url import pw_owner
        _PW_OWNER.set(pw_owner(username))
    except Exception:                                           # noqa: BLE001
        pass
    if not session_id:
        return None
    try:
        from llm_core._pw_session import get_pw_session_owner
        proprio = get_pw_session_owner(str(session_id))
    except Exception:                                           # noqa: BLE001
        proprio = None
    if proprio is None or proprio != username:
        return _err("not_your_session",
                    message="session de navigateur inconnue pour ce compte"
                            if proprio is None else
                            "cette session de navigateur appartient à un "
                            "autre utilisateur",
                    fix="pw_session(action='start', url=…) ouvre (ou retrouve) la vôtre")
    return None


def _req(method, endpoint, json=None, params=None, timeout=None):
    t = timeout if timeout is not None else TIMEOUT
    json, params = _avec_proprietaire(json, params, method)
    try:
        url = f"{NODE_API}{endpoint}"
        resp = requests.get(url, params=params, timeout=t) if method == "GET" \
            else requests.post(url, json=json, timeout=t)
        if resp.status_code == 410:
            return _err("Session expired",
                        hint="reopen with pw_session(action='start')")
        if resp.status_code == 404:
            return _err("Session not found",
                        hint="start one with pw_session(action='start')")
        if resp.status_code != 200:
            # Surface le champ ``error`` du corps JSON quand il existe (ex. le
            # 502 nav_error renvoyé par /action : « Navigation échouée vers … :
            # net::ERR_… ») au lieu du « Playwright error (NNN) » opaque.
            _msg = None
            try:
                _body = resp.json()
                if isinstance(_body, dict) and isinstance(_body.get("error"), str):
                    _msg = _body["error"]
            except Exception:
                pass
            return _err(_msg or f"Playwright error ({resp.status_code})",
                        hint=(None if _msg else (resp.text[:500] or None)))
        return _clip_result(resp.json())
    except requests.exceptions.ConnectionError:
        return _err("Playwright server not running",
                    hint="start it: node server.js")
    except requests.exceptions.Timeout:
        return _err(f"Timeout ({t}s)",
                    hint="the page may be slow or stuck; retry or simplify the action")
    except Exception as e:
        return _err(str(e))


def _req_status(method, endpoint, json=None, params=None, timeout=None):
    """Like _req but returns ``(status_code, body)`` instead of an error
    envelope, so a polling caller (pw_wait) can distinguish a benign 408
    ("condition not met yet") from a hard error. ``status_code`` is -1 on a
    transport failure (connection refused / client timeout); ``body`` is the
    decoded JSON dict when available, else ``{}``. No _clip_result — the
    /wait_for_dynamic bodies are tiny by construction."""
    t = timeout if timeout is not None else TIMEOUT
    json, params = _avec_proprietaire(json, params, method)
    try:
        url = f"{NODE_API}{endpoint}"
        resp = requests.get(url, params=params, timeout=t) if method == "GET" \
            else requests.post(url, json=json, timeout=t)
        try:
            body = resp.json()
            if not isinstance(body, dict):
                body = {"value": body}
        except Exception:
            body = {"error": (resp.text or "")[:500]}
        return resp.status_code, body
    except requests.exceptions.ConnectionError:
        return -1, {"error": "connection_refused"}
    except requests.exceptions.Timeout:
        return -1, {"error": "client_timeout"}
    except Exception as e:
        return -1, {"error": str(e)}


def _dsl_to_selector(target: str) -> str:
    """Collapse a target DSL (``role=button|name=Save``, ``css=.spinner`` …)
    into a single Playwright selector STRING, for endpoints that take a
    ``selector`` rather than by_* kwargs (e.g. /wait_for_dynamic, which calls
    page.waitForSelector / querySelector). Mirrors the legacy fallback ladder
    already used inside pw_chain. Returns "" when nothing usable is present.

    Note: the role engine is not expressible as a plain selector string, so a
    bare ``role=…`` (without css/text/xpath) falls back to its ``name`` as
    text — callers that need role-precise waits should pass css/text/xpath."""
    d = _parse_target_dsl(target)
    if d.get("ref"):         return f"ref:{d['ref']}"
    if d.get("test_id"):     return f'[data-testid="{d["test_id"]}"]'
    if d.get("css"):         return d["css"]
    if d.get("xpath"):       return f'xpath={d["xpath"]}'
    if d.get("label"):       return f'label={d["label"]}'
    if d.get("placeholder"): return f'placeholder={d["placeholder"]}'
    if d.get("text"):        return d["text"]          # smartResolve handles plain text
    if d.get("name"):        return d["name"]          # role+name → text fallback
    return ""


def _wait_payload(wait_after):
    if not wait_after: return {}
    try: return {"wait_after": int(wait_after)}
    except (TypeError, ValueError): return {"wait_after": wait_after}


def _clamp_items(n: Any, default: int = 25) -> int:
    """Clamp a max_items-style knob to [1, 200] (bad input → default)."""
    try:
        return max(1, min(int(n), 200))
    except (TypeError, ValueError):
        return default


# ── Perceive-act loop (axis 3) ───────────────────────────────────────
# After an action, attach a fresh lite snapshot of the page so the model
# SEES the outcome in the SAME call — no blind follow-up pw_page(action="inspect").
# This is the single biggest reliability win for smaller models: every
# action is immediately grounded in what it actually did. Best-effort —
# a failed observation never masks the action result.
def _finish_act(result: Any, session_id: str, observe: bool,
                max_items: int = 25) -> Any:
    if observe and isinstance(result, dict) and not result.get("error"):
        try:
            snap = _req("GET", "/smart_inspect", params={
                "session_id": session_id, "level": "lite",
                "viewport_only": "true",
                "max_items": _clamp_items(max_items, default=25),
                "skip_screenshot": "true",
            })
            if isinstance(snap, dict) and not snap.get("error"):
                result = {**result, "page_after": snap}
        except Exception:
            pass  # observation is a bonus, never break the action result
    return _clip_result(result)


# Route applicative qui relaie une PNG du service (shared_infra/routes/tools.py).
_SCREENSHOT_URL_PREFIX = "/api/playwright/screenshot/"


def _screenshot_result(r: Any, *, full_page: bool = False, target: str = "") -> Any:
    """Contrat de sortie STABLE de ``pw_page(action='screenshot')``.

    Le service répond ``{"status": "success", "screenshot":
    "shot_<sid>_<ts>.png"}``. Forme rendue alignée sur ``pw_visual`` /
    ``pw_observe(som)`` : nom du fichier + URL applicative + numéro d'étape,
    sans ``status`` textuel — la capture ne dépend pas du typage de
    ``status`` dans ``PWPageResult`` (un ``status: int`` strict ferait
    rejeter la réponse par le client MCP, ``-32602 … status must be
    integer``, et la capture, pourtant écrite, ne serait jamais vue). Une
    enveloppe d'erreur passe telle quelle."""
    if not isinstance(r, dict) or r.get("error"):
        return r
    fname = r.get("screenshot")
    out: Dict[str, Any] = {
        "ok": True, "action": "screenshot",
        "screenshot": fname,
        "screenshot_url": (_SCREENSHOT_URL_PREFIX + fname) if isinstance(fname, str) and fname else None,
        "full_page": bool(full_page),
    }
    if target:
        out["target"] = target
    step = r.get("screenshot_step")
    if isinstance(step, int):
        out["screenshot_step"] = step
    if r.get("elements"):
        out["elements"] = r["elements"]
    return out


# ──────────────────────────────────────────────────────────────────────
# TARGET DSL parser
# ──────────────────────────────────────────────────────────────────────
# Single-string locator: "role=button|name=Login" or "label=Email" or "ref=loc_x".
# Maps to the by_* / ref params transparently. The separate params remain
# accepted for back-compat — DSL is just an additional, recommended path.
_DSL_KEYS = {
    "role", "name", "text", "label", "placeholder", "test_id",
    "css", "xpath", "ref", "alt", "title", "nth",
}

def _parse_target_dsl(target: str) -> Dict[str, Any]:
    """Parse 'role=button|name=Login' → {'role':'button','name':'Login'}.
    Values may contain '=' (only the FIRST '=' is treated as separator).
    Whitespace around keys is stripped; values are kept as-is (preserves spaces)."""
    if not target:
        return {}
    out: Dict[str, Any] = {}
    for chunk in target.split("|"):
        if "=" not in chunk:
            continue
        k, v = chunk.split("=", 1)
        k = k.strip().lower()
        if k in _DSL_KEYS:
            if k == "nth":
                try: out[k] = int(v.strip())
                except (TypeError, ValueError): pass
            else:
                out[k] = v
    return out


def _build_locator_payload(
    *, role="", name="", text="", label="", placeholder="", test_id="",
    css="", xpath="", alt="", title="", ref="", nth=-1, max=5,
    target="",
) -> Dict[str, Any]:
    """Merge target DSL with separate kwargs. DSL wins on conflict (LLM intent)."""
    dsl = _parse_target_dsl(target)
    role        = dsl.get("role", role)
    name        = dsl.get("name", name)
    text        = dsl.get("text", text)
    label       = dsl.get("label", label)
    placeholder = dsl.get("placeholder", placeholder)
    test_id     = dsl.get("test_id", test_id)
    css         = dsl.get("css", css)
    xpath       = dsl.get("xpath", xpath)
    alt         = dsl.get("alt", alt)
    title       = dsl.get("title", title)
    ref         = dsl.get("ref", ref)
    nth         = dsl.get("nth", nth)
    return {
        "by_role": role or None, "by_name": name or None,
        "by_text": text or None, "by_label": label or None,
        "by_placeholder": placeholder or None, "by_test_id": test_id or None,
        "by_css": css or None, "by_xpath": xpath or None,
        "by_alt": alt or None, "by_title": title or None,
        "ref": ref or None,
        "nth": nth if (isinstance(nth, int) and nth >= 0) else None,
        "max": max,
    }, {  # also return resolved kwargs for AX recording
        "role": role, "name": name, "text": text, "label": label,
        "placeholder": placeholder, "test_id": test_id,
        "css": css, "xpath": xpath, "ref": ref, "nth": nth,
    }


# ──────────────────────────────────────────────────────────────────────
# Harmonisation des noms d'arguments
# ──────────────────────────────────────────────────────────────────────
# La même notion — « quel geste » — porte cinq noms selon l'outil :
# ``action`` (pw_session/pw_mock/pw_recorder), ``op`` (pw_page/pw_memory),
# ``do`` (pw_act), ``assertion`` (pw_expect), ``mode`` (pw_observe). Un agent
# qui vient d'appeler ``pw_page(op=…)`` enchaîne naturellement
# ``pw_act(op=…)`` : sans synonymes, erreur de schéma et un tour perdu. Même
# chose pour la valeur (``v`` vs ``value``) et pour la cible (``target`` DSL
# vs ``selector`` CSS).
#
# Ne RENOMMER rien : les schémas sont déjà appris et le format de fil MCP
# est public. ``action=`` / ``value=`` / ``selector=`` sont valides PARTOUT,
# et le nom propre à chaque outil reste accepté — sans dépréciation.
# Règle de priorité UNIFORME : le nom canonique l'emporte si les deux sont
# fournis (``action`` > ``op``/``do``/``assertion``/``mode``).
PW_VERB_ALIASES: Dict[str, Tuple[str, ...]] = {
    "pw_session":  ("action",),
    "pw_mock":     ("action",),
    "pw_recorder": ("action",),
    "pw_act":      ("action", "do"),
    "pw_page":     ("action", "op"),
    "pw_memory":   ("action", "op"),
    "pw_expect":   ("action", "assertion"),
    "pw_observe":  ("action", "mode"),
}


def _first(*candidates: Any) -> str:
    """Première valeur non vide parmi des synonymes (ordre = priorité).
    Les verbes/sélecteurs sont trimés — un ``" click "`` reste un click."""
    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()
    return ""


def _merge_value(*candidates: Any) -> str:
    """Comme ``_first`` mais SANS strip : une valeur saisie dans un champ peut
    légitimement être « " " » ou finir par un espace."""
    for c in candidates:
        if isinstance(c, str) and c != "":
            return c
    return ""


def pw_verb(tool_name: str, args: Dict[str, Any]) -> str:
    """Verbe effectif d'un appel ``pw_*``, quel que soit le synonyme employé.

    Source de vérité UNIQUE : les outils l'appliquent en interne, et les hooks
    qui inspectent les arguments BRUTS doivent passer par ici — sinon
    ``pw_session(op='stop')`` réussirait côté outil tout en laissant le suivi
    de propriété de session désynchronisé, et ``pw_page(action='inspect')``
    n'injecterait plus la capture pour les modèles vision.
    """
    if not isinstance(args, dict):
        return ""
    for key in PW_VERB_ALIASES.get(tool_name, ("action",)):
        v = args.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _merge_target(target: str, selector: str) -> str:
    """``selector=`` (CSS brut) et ``target=`` (DSL) désignent la même chose.
    Renvoie un ``target`` DSL ; ``target`` l'emporte si les deux sont fournis.
    Un ``selector`` déjà écrit en DSL (``css=…``, ``role=…``) est gardé tel quel."""
    t = (target or "").strip()
    if t:
        return t
    s = (selector or "").strip()
    if not s:
        return ""
    return s if _parse_target_dsl(s) else f"css={s}"


def _dsl_to_by_kw(target: str) -> Dict[str, Any]:
    """Map target DSL → flat by_* dict for server endpoints (used by pw_expect)."""
    d = _parse_target_dsl(target)
    return {
        "by_role": d.get("role"), "by_name": d.get("name"),
        "by_text": d.get("text"), "by_label": d.get("label"),
        "by_placeholder": d.get("placeholder"),
        "by_test_id": d.get("test_id"),
        "by_css": d.get("css"), "by_xpath": d.get("xpath"),
        "by_alt": d.get("alt"), "by_title": d.get("title"),
        "ref": d.get("ref"),
        "nth": d.get("nth"),
    }


def register(mcp: FastMCP) -> None:

    # ── 1. SESSION ───────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_session")
    def session(
        ctx: Context,
        action: str,
        url: str = "",
        session_id: str = "",
        username: str = None,
        password: str = None,
        load_state_id: str = None,
        record_har: bool = False,
        url_filter: str = "",
        device: str = "",
        viewport: str = "",
        locale: str = "",
        timezone: str = "",
        color_scheme: str = "",
        touch: bool = None,
        isolated: bool = False,
        trace: bool = False,
        record_video: bool = False,
    ) -> Union[PWSessionResult, ErrEnvelope]:
        """Manage Firefox browser session lifecycle.

action= :
  start       : open a session. Required: url=.
                HTTP AUTH (Basic AND Digest) → pass username= / password= HERE,
                at start. Credentials are set at context creation
                (httpCredentials) and can NOT be added afterwards via a goto.
                If a page returns 401, (re)start WITH the credentials
                (isolated=true for a fresh context). No popup is shown.
                Use load_state_id= to resume cookies from a saved session.
                IDEMPOTENT PER USER: one browser instance per user. If you
                already have a session, start REUSES it and opens url= in a
                NEW TAB (returns reused=true + tab_index). Use pw_page with
                action="tabs"/"tab_switch" to list/switch between your tabs.
                EMULATION (optional): device="iPhone 13"|"Pixel 7"|"iPad Mini"…
                OR viewport="1280x800"; plus locale=, timezone=,
                color_scheme="dark", touch=true. Default: desktop 1920x1080.
                TESTING (optional): isolated=true (FRESH context, no reuse —
                for reproducible tests) ; trace=true
                (then action="trace_export" → trace_url viewable via
                `npx playwright show-trace`) ; record_video=true (video_urls
                returned by action="stop").
  trace_export: stop le tracing et renvoie trace_url (si trace=true au start).
  stop        : close session. Required: session_id=.
  save_state  : save cookies/localStorage. Reusable via load_state_id.
  list        : list active sessions. Optional url_filter= (substring match
                on URL or domain) — returns matching sessions only.
  cleanup     : close all sessions + kill zombie browser processes.
  health      : Playwright server status.

PROTOCOL: you get a single instance. Call start whenever you need a URL —
it reuses your existing instance and opens a new tab rather than failing.
Switch between tabs with pw_page(action="tab_switch", index=N).

SYNONYMS (all pw_* tools): action= == op= == do=, value= == v=, target= == selector=."""
        _username = get_username(ctx)
        # ``start`` n'utilise pas ``session_id`` (il retrouve l'instance du
        # compte et réenregistre sa propriété) : un identifiant inconnu ou
        # périmé ne doit pas l'empêcher. Le propriétaire est posé quand même.
        _refus = (_refus_session_d_autrui(None, _username) if action == "start"
                  else _refus_session_d_autrui(session_id, _username))
        if _refus is not None:
            return _refus
        if action == "start":
            # ``url`` est « Required » pour ``start`` : sans ce refus, un
            # ``start`` sans url renverrait ``ok`` avec ``url="about:blank"``
            # — l'agent croirait sa session prête alors qu'elle est morte, et
            # repartirait inspecter une page vide. Refus tôt, en nommant les
            # DEUX sorties possibles.
            if not (url or "").strip():
                return _err(
                    "url_required",
                    message="pw_session(action='start') requires url= — "
                            "starting IS the navigation.",
                    fix="call pw_session(action='start', url='https://…'). An "
                        "already-open session is reused and the url opens in a "
                        "NEW TAB (pw_page action='tabs'/'tab_switch'). On a "
                        "session you already have, pw_act(action='goto', "
                        "url='https://…') navigates the current tab.",
                )
            _bloque = _refus_url(url)
            if _bloque is not None:
                return _bloque
            _creds_auto_injected = False
            if _AX_ENABLED and url and (not username or not password):
                try:
                    from shared_infra.memory.ax import get_credentials as _ax_get_creds
                    _known = _ax_get_creds(url, owner=_username or "")
                    if _known:
                        if not username:
                            username = _known.get("username")
                        if not password:
                            password = _known.get("password")
                        _creds_auto_injected = True
                        import logging as _lg
                        _lg.getLogger("uvicorn.error").info(
                            "[ax-creds] auto-injected creds for %s (user=%s, use_count=%d)",
                            url, _known.get("username"), _known.get("use_count", 0),
                        )
                except Exception:
                    pass

            # Une instance par utilisateur : `owner` dérive de l'identité
            # injectée (_username). Le browser-service réutilise la session
            # existante de cet owner s'il y en a une (URL → nouvel onglet).
            from shared_infra.security.browser_url import pw_owner as _pw_owner
            _owner = _pw_owner(_username)
            # Émulation device/viewport. viewport="WIDTHxHEIGHT".
            _start_body = {
                "url": url, "username": username, "password": password,
                "headless": HEADLESS, "load_state_id": load_state_id,
                "record_har": record_har, "owner": _owner,
            }
            if device: _start_body["device"] = device
            if viewport:
                try:
                    _w, _h = viewport.lower().split("x", 1)
                    _start_body["viewport"] = {"width": int(_w), "height": int(_h)}
                except Exception:
                    pass
            if locale: _start_body["locale"] = locale
            if timezone: _start_body["timezone"] = timezone
            if color_scheme: _start_body["color_scheme"] = color_scheme
            if touch is not None: _start_body["touch"] = touch
            # Isolation de test / trace / vidéo
            if isolated: _start_body["isolated"] = True
            if trace: _start_body["trace"] = True
            if record_video: _start_body["record_video"] = True
            _result = _req("POST", "/start", json=_start_body)
            # Propriété de la session posée PAR L'OUTIL, pas par la boucle de
            # chat : sur un hôte d'outils distant, la boucle vit ailleurs — la
            # route des captures lit ce registre ici.
            try:
                _sid = (_result.get("session_id") or _result.get("sid")) if isinstance(_result, dict) else None
                if _sid and _username and not _result.get("error"):
                    from llm_core._pw_session import record_pw_session_owner
                    record_pw_session_owner(str(_sid), str(_username))
            except Exception:                                   # noqa: BLE001
                pass

            if _AX_ENABLED and url and username and password and isinstance(_result, dict):
                try:
                    if not _result.get("error"):
                        from shared_infra.memory.ax import save_credentials as _ax_save_creds
                        _ax_save_creds(url, username, password,
                                       owner=_username or "")
                except Exception:
                    pass

            return _result
        if action == "stop":
            return _req("POST", "/stop", json={"session_id": session_id})
        if action == "trace_export":
            return _req("POST", "/trace_export", json={"session_id": session_id})
        if action == "save_state":
            return _req("POST", "/save_state", json={"session_id": session_id})
        if action == "list":
            r = _req("GET", "/sessions")
            # Filter by URL/domain if requested. Server returns full list;
            # we filter Python-side to stay backward-compatible.
            if isinstance(r, dict) and url_filter and isinstance(r.get("sessions"), list):
                f = url_filter.lower()
                matching = [
                    s for s in r["sessions"]
                    if f in (s.get("url", "") or "").lower()
                    or f in (s.get("origin", "") or "").lower()
                ]
                r = {**r, "sessions": matching, "filtered_count": len(matching)}
            return r
        if action == "cleanup":
            return _req("POST", "/cleanup")
        if action == "health":
            return _req("GET", "/health")
        return _err(f"unknown action {action!r}",
                    hint="use: start|stop|save_state|list|cleanup|health")


    # ── 2. FIND ──────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_OW_RO, name="pw_find")
    def find(
        ctx: Context,
        session_id: str,
        target: str = "",
        role: str = "",
        name: str = "",
        text: str = "",
        label: str = "",
        placeholder: str = "",
        test_id: str = "",
        css: str = "",
        xpath: str = "",
        alt: str = "",
        title: str = "",
        nth: int = -1,
        max: int = 5,
        max_items: int = 0,
        include_frames: bool = False,
        selector: str = "",
    ) -> Union[PWFindResult, ErrEnvelope]:
        """Locate element(s). Returns {count, matches:[{tag,text,visible,ref}]}.

include_frames=true : ALSO searches inside iframes (native Playwright
  page.frames()). Each match then carries `frame:{name,url}` and its `ref`
  stays actionable by pw_act (re-resolved on the right frame). Essential for
  legacy UIs built on iframes (framed login forms, etc.).

PREFERRED FORMAT — single target string (DSL):
  pw_find(target="role=button|name=Login")
  pw_find(target="label=Email")
  pw_find(target="placeholder=Search")
  pw_find(target="text=Welcome")
  pw_find(target="test_id=cta")
  pw_find(target="role=row|nth=0")
  pw_find(target="css=div.product-card", max=20)

LEGACY (still supported): pw_find(role="button", name="Login").

Strategy preference (most → least robust):
  role+name > label > placeholder > test_id > text > css > xpath

The returned `ref` can be passed to pw_act(target="ref=loc_xxx"). It stays
valid `ref_ttl_s` seconds (300) and is reusable — but on content that shifts
or disappears, re-run pw_find right before acting.
If you call pw_find with no target/selector, it returns smart_inspect (lite).

selector=  : raw CSS, synonym of target= (wrapped as "css=…"). target wins.

max=       : cap on locator matches returned (default 5).
max_items= : pagination cap, same knob as pw_page/pw_act. >0 caps the
             no-target smart_inspect fallback AND overrides `max` for
             matches (one consistent name across the pw_* API)."""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        # `selector=` (CSS brut) et `target=` (DSL) convergent vers le DSL.
        target = _merge_target(target, selector)
        # Empty call → quick lite inspect (helpful exploratory call)
        if not target and not any([role, text, label, placeholder, test_id, css, xpath, alt, title]):
            params = {
                "session_id": session_id, "level": "lite", "skip_screenshot": "true",
            }
            if max_items:
                params["max_items"] = _clamp_items(max_items)
            return _req("GET", "/smart_inspect", params=params)
        payload, _ = _build_locator_payload(
            target=target, role=role, name=name, text=text, label=label,
            placeholder=placeholder, test_id=test_id, css=css, xpath=xpath,
            alt=alt, title=title, nth=nth,
            max=_clamp_items(max_items) if max_items else max,
        )
        payload["session_id"] = session_id
        if include_frames:
            payload["include_frames"] = True
        return _req("POST", "/locator", json=payload)


    # ── 3. ACT ───────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_act")
    def act(
        ctx: Context,
        session_id: str,
        do: str = "",
        target: str = "",
        # legacy separate params (back-compat)
        ref: str = "",
        role: str = "", name: str = "",
        text: str = "", label: str = "",
        placeholder: str = "", test_id: str = "",
        css: str = "", xpath: str = "",
        alt: str = "", title: str = "",
        v: str = "",
        url: str = "",
        wait_after: str = "",
        observe: bool = True,
        max_items: int = 25,
        action: str = "",
        value: str = "",
        selector: str = "",
        option_label: str = "",
        option_value: str = "",
        direction: str = "",
        amount: int = 0,
        to: str = "",
    ) -> Union[PWActResult, ErrEnvelope]:
        """Act on an element or page.

PREFERRED — target DSL (single string):
  pw_act(sid, action="click", target="role=button|name=Login")
  pw_act(sid, action="click", target="text=Add to cart")
  pw_act(sid, action="fill",  target="label=Email",       value="me@x.com")
  pw_act(sid, action="fill",  target="placeholder=Password", value="hunter2")
  pw_act(sid, action="press", value="Enter")       # no target = current focus
  pw_act(sid, action="select", target="label=Country", option_label="France")
  pw_act(sid, action="pick",  target="css=#city", option_label="Lyon")  # ANY dropdown
  pw_act(sid, action="scroll", direction="down", amount=800)   # page
  pw_act(sid, action="goto",  url="https://example.com")
  pw_act(sid, action="click", target="ref=loc_abc")  # ref from pw_find
  pw_act(sid, action="drag",   target="css=#column-a", to="css=#column-b")   # drag & drop
  pw_act(sid, action="expand", target="role=treeitem|name=Tables")           # open a tree node

SYNONYMS (all pw_* tools): action= == do=, value= == v=, selector= == target=.

AUTH NOTE: for a page behind HTTP auth (Basic/Digest), goto takes NO
credentials. Open the session with: pw_session(action="start",
url=…, username=…, password=…). A goto on such a page returns the
auth_hint field as a reminder.

Actions (action=):
  click | fill | press | hover | check | uncheck | focus | type | clear
  dblclick | rclick | upload | goto | back | forward | reload
  select     : NATIVE <select> only. Prefer option_label= (what you SEE) or
               option_value=. The options are listed in pw_page("inspect").
  pick       : ANY dropdown — native <select>, autocomplete input, or a custom
               div/ul/role=listbox one. Opens it and clicks the option for you.
               Use this when the control is not a real <select>.
  scroll     : NO target  → scrolls the PAGE (direction=, amount=). When the
               page itself cannot scroll (max_y=0 — GWT/desktop-like layouts
               scroll INSIDE a panel), the largest scrollable container is
               scrolled instead and named in `container` (strategy=
               container-scroll); target it explicitly next time. The list
               of scrollable panels is in pw_page("inspect").scrollables.
               target= + direction= → scrolls INSIDE that container.
               target= alone → brings the element into view.
  drag       : drag target= and drop it on to= (DSL). Pointer drag first
               (Playwright dragTo), then synthetic HTML5 drag events when
               the drop did not land. Without to=, direction=/amount= drag
               by an offset in pixels.
  expand | collapse : open / close a tree node or disclosure (GWT CellTree,
               ARIA tree, accordion). A plain click on a tree item usually
               only SELECTS it: this tries the toggle icon, then
               focus + ArrowRight/ArrowLeft, then dblclick, and VERIFIES
               aria-expanded. Result: expanded_before / expanded / method.
               (A click on a tree item also reports `expanded` so you can
               see it did not open.)

wait_after= : "network" (wait networkidle, max 6s) | "selector:#x" |
              "text:Welcome" | <int ms>. Use after navigation-triggering clicks.

value= : text for fill/type, key for press (Enter/Tab/Escape/etc).
option_label= / option_value= : for select/pick. option_label is the visible
     text; option_value is the underlying value=. Passing the visible text as
     value= still works but is guessed.
direction= : down|up|left|right (scroll). amount= : pixels, default 500.

observe= : when true (default) the result carries `page_after` — a fresh
     lite snapshot of the page AFTER the action, so you SEE the outcome in
     THIS call (no separate pw_page(action="inspect") needed). Set false only for
     speed-critical sequences where you do not need to see the result.

max_items= : cap on the interactive elements listed in `page_after`
     (default 25, clamped 1-200). Lower it (e.g. 5-10) to save tokens on
     dense pages when you only need confirmation the action landed.
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        # Noms harmonisés : action|do, value|v, selector|target (cf. en-tête).
        do = _first(action, do)
        v = _merge_value(value, v)
        target = _merge_target(target, selector)
        _url_before = ""
        if _AX_ENABLED:
            try: _url_before = _ax_get_current_url(session_id)
            except Exception: pass

        # ── pick : n'importe quelle liste déroulante, en UN geste ──────────
        # `select` ne sait piloter qu'un <select> natif. Sur un combobox à base
        # de div (le cas majoritaire hors formulaires HTML purs), il faudrait
        # ouvrir puis cliquer l'option en devinant son sélecteur. `pick` passe
        # par /handle_dropdown du service, qui enchaîne 4 stratégies (select
        # natif, input + autocomplete/datalist, dropdown custom, shadow DOM).
        if do == "pick":
            _sel = _dsl_to_selector(target)
            if not _sel:
                return _err("target_required",
                            message="pick needs to know WHICH dropdown to open.",
                            fix="pw_act(session_id, action='pick', target='css=#city', "
                                "option_label='Lyon')")
            _wanted = _first(option_label, option_value, v)
            if not _wanted:
                return _err("option_required",
                            message="pick needs the option to choose.",
                            fix="pass option_label='<visible text>' (or option_value=).")
            _r = _req("POST", "/handle_dropdown", json={
                "session_id": session_id, "selector": _sel,
                "option_text": option_label or v or "",
                "option_value": option_value or "",
                "search_text": option_label or v or "",
            }, timeout=max(TIMEOUT, 25))
            return _finish_act(_r, session_id, observe, max_items)

        nav = {"goto": "goto", "back": "back", "forward": "forward", "reload": "reload"}
        if do in nav:
            # La navigation peut durer jusqu'au timeout de goto côté Node (60s),
            # PLUS les attentes post-goto (networkidle ~3s + overlays) sur le
            # chemin succès. Sans override, _req couperait à TIMEOUT (10s) → faux
            # « Timeout (10s) ». On laisse une marge confortable au-delà du
            # budget serveur (60s + post-goto) pour ne pas couper un succès lent.
            _nav_timeout = max(TIMEOUT, 75)
            if do == "goto":
                _bloque = _refus_url(url)
                if _bloque is not None:
                    return _bloque
            _result = _req("POST", "/action", json={
                "session_id": session_id, "type": nav[do], "url": url,
                **_wait_payload(wait_after),
            }, timeout=_nav_timeout)
            # AX hook for goto/back/forward — record the navigation transition.
            if _AX_ENABLED and do in ("goto", "back", "forward"):
                try:
                    _url_after = ""
                    if isinstance(_result, dict):
                        _url_after = _result.get("url") or _result.get("current_url") or ""
                    if not _url_after:
                        _url_after = _ax_get_current_url(session_id)
                    if _url_before and _url_after and _url_before != _url_after:
                        _ax_record_action(
                            url=_url_after,
                            role="navigation",
                            name=f"{do} {url or ''}".strip(),
                            result=_result,
                            locator_kw={"text": url or do},
                            url_before=_url_before,
                        )
                except Exception:
                    pass
            return _finish_act(_result, session_id, observe, max_items)

        amap = {"click":"click","fill":"fill","type":"type","clear":"clear","press":"press",
                "select":"select_option","hover":"hover","check":"check","uncheck":"uncheck",
                "focus":"focus","scroll":"scroll","scroll_to":"scroll_into_view",
                "dblclick":"double_click","rclick":"right_click","upload":"upload",
                # drag : geste du service (type 'drag', chemin selector=) ;
                # expand/collapse : un clic simple ne DÉPLIE pas un nœud de
                # CellTree GWT.
                "drag":"drag","expand":"expand","collapse":"collapse"}
        if not do:
            return _err("action_required",
                        message="pw_act needs to know WHICH gesture to perform.",
                        fix="pw_act(session_id, action='click'|'fill'|'press'|"
                            "'goto'|…, target='role=button|name=Login'). "
                            "action= (legacy synonym: do=) is required.")
        if do not in amap:
            return _err(f"action={do!r} unknown",
                        hint="use: " + "|".join(list(amap.keys()) + list(nav.keys())
                                                + ["pick"]))

        loc_payload, resolved_kw = _build_locator_payload(
            target=target, role=role, name=name, text=text, label=label,
            placeholder=placeholder, test_id=test_id, css=css, xpath=xpath,
            alt=alt, title=title, ref=ref,
        )
        # `scroll` avec une cible mais SANS direction = « amène-le à l'écran »
        # (le sens historique de scroll). Avec une direction = « fais défiler
        # DEDANS ». Sans cible = la page. Rétro-compatible dans les trois cas.
        _type = amap[do]
        if do == "scroll" and target and not direction and not amount:
            _type = "scroll_into_view"
        body = {
            "session_id": session_id, "type": _type,
            "ref": loc_payload.get("ref"),
            "by_role": loc_payload.get("by_role"),
            "by_name": loc_payload.get("by_name"),
            "by_text": loc_payload.get("by_text"),
            "by_label": loc_payload.get("by_label"),
            "by_placeholder": loc_payload.get("by_placeholder"),
            "by_test_id": loc_payload.get("by_test_id"),
            "by_css": loc_payload.get("by_css"),
            "by_xpath": loc_payload.get("by_xpath"),
            "by_alt": loc_payload.get("by_alt"),
            "by_title": loc_payload.get("by_title"),
            "text": v or None, "value": v or None, "key": v or None,
            **_wait_payload(wait_after),
        }
        # Choix d'option EXPLICITE : le service n'a pas à deviner si la chaîne
        # est une value= ou un libellé — deviner coûte 10 s de timeout au cas
        # le plus courant, choisir par le texte affiché.
        if option_label: body["option_label"] = option_label
        if option_value: body["option_value"] = option_value
        if direction: body["direction"] = direction
        if amount: body["amount"] = int(amount)
        if do == "drag":
            _to = _merge_target(to, "")
            if _to:
                body["to"] = {k: val for k, val in _dsl_to_by_kw(_to).items() if val is not None}
                _to_sel = _dsl_to_selector(_to)
                if _to_sel:
                    body["target_selector"] = _to_sel
            elif not (direction or amount):
                return _err("drag_destination_required",
                            message="drag needs WHERE to drop.",
                            fix="pw_act(session_id, action='drag', target='css=#a', "
                                "to='css=#b') — or direction=/amount= for an offset.")
        # SÉLECTEUR DE REPLI : la même cible, jointe sous forme de chaîne,
        # ouvre l'échelle « smart » du service — remontée du texte vers
        # l'ancêtre porteur du handler (GWT/GXT), recherche DANS les iframes,
        # repli sur aria-label/placeholder/title — que des by_* seuls laissent
        # injoignable (un locator officiel qui échoue rendrait un 500 sec). Le
        # service ne s'en sert QUE si l'officiel échoue.
        _fallback_sel = _dsl_to_selector(target)
        if _fallback_sel:
            body["selector"] = _fallback_sel
        _result = _req("POST", "/action", json=body)

        # AX memory hook (best-effort) ──
        if _AX_ENABLED:
            try:
                _url_after = ""
                if isinstance(_result, dict):
                    _url_after = _result.get("url") or _result.get("current_url") or ""
                if not _url_after:
                    _url_after = _ax_get_current_url(session_id)

                _role_eff = resolved_kw.get("role") or ""
                _name_eff = resolved_kw.get("name") or ""
                if isinstance(_result, dict):
                    if not _role_eff:
                        _role_eff = (_result.get("element_role") or _result.get("role") or "")
                    if not _name_eff:
                        _name_eff = (_result.get("element_name")
                                     or _result.get("accessible_name") or "")
                if not _name_eff:
                    _name_eff = (resolved_kw.get("text") or resolved_kw.get("label")
                                 or resolved_kw.get("placeholder")
                                 or resolved_kw.get("test_id") or "")
                if not _role_eff:
                    if do in ("fill", "type"):              _role_eff = "textbox"
                    elif do in ("click", "dblclick") and (resolved_kw.get("text")
                                                          or resolved_kw.get("label")
                                                          or resolved_kw.get("test_id")
                                                          or resolved_kw.get("css")):
                                                            _role_eff = "button"
                    elif do == "select":                    _role_eff = "combobox"
                    elif do in ("check", "uncheck"):        _role_eff = "checkbox"
                    else:                                   _role_eff = "generic"
                if not _name_eff and (resolved_kw.get("css") or resolved_kw.get("xpath")
                                      or resolved_kw.get("ref")):
                    _name_eff = (resolved_kw.get("css") or resolved_kw.get("xpath")
                                 or f"ref:{resolved_kw.get('ref')}")

                if _role_eff and _name_eff:
                    _ancestors = []
                    if isinstance(_result, dict):
                        _anc = _result.get("ancestors")
                        if isinstance(_anc, list): _ancestors = _anc
                    _ax_record_action(
                        url=_url_after, role=_role_eff, name=_name_eff,
                        result=_result, locator_kw=resolved_kw,
                        url_before=_url_before, ancestors=_ancestors,
                    )
            except Exception:
                import logging as _lg
                _lg.getLogger("uvicorn.error").warning(
                    "[ax-hook] hook exception", exc_info=True,
                )

        return _finish_act(_result, session_id, observe, max_items)


    # ── 4. PAGE ──────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_page")
    def page(
        ctx: Context,
        session_id: str,
        op: str = "",
        selector: str = "",
        v: str = "",
        index: int = -1,
        max: int = 50,
        # context-saving params for op="inspect" ──
        level: str = "lite",                # lite | nav | full
        since_step: int = 0,                # diff vs step N (0 = no diff)
        viewport_only: bool = True,         # ignore offscreen interactives
        max_items: int = 30,                # cap on returned interactives
        skip_screenshot: bool = False,
        # for op="screenshot" ──
        target: str = "",                   # element-targeted screenshot (DSL)
        full_page: bool = False,
        action: str = "",
        value: str = "",
        include_frames: bool = False,
        pierce_shadow: bool = True,
    ) -> Union[PWPageResult, ErrEnvelope]:
        """Page-level operations (no element target by default).

OPERATIONS (action=):
  inspect    : compact semantic map of the page.
               level= lite|nav|full (default lite — saves ~70% tokens).
                 lite : idx, type, role, name, text, selector, in_viewport
                 nav  : + form structures + href + region
                 full : all fields incl. colors, rect
               Each interactive carries `role` + accessible `name`. PREFER
               building targets from them — target="role=<role>|name=<name>"
               is the most robust locator (resolves via getByRole). Fall
               back to `selector` only when role/name are empty.
               A `<select>` always carries its `options` — pass one of those
               labels to pw_act(action="select", option_label=…).
               `detected_by` means the element was found by heuristic (cursor,
               widget class) and has NO declared role: target it BY TEXT.
               `expanded` tells you whether a dropdown is already open.
               include_frames=True : ALSO lists what is inside <iframe>s
                 (each item carries `frame`). Reach those via
                 pw_find(include_frames=true) → ref → pw_act(target="ref=…").
               since_step=N : returns ONLY elements changed since step N
                              (use payload.screenshot_step from a previous
                              call; cuts ~80% of tokens on stable pages).
               viewport_only=True : drops offscreen elements. The result
                 says what it DROPPED: `candidates_total` and
                 `omitted:{offscreen,hidden,too_small,over_max}` — when the
                 element you expect is missing, look there before
                 concluding it does not exist (raise max_items, or
                 viewport_only=False).
               max_items=30 : caps returned interactives count.
               skip_screenshot=True (default in lite) : no PNG written.
               pierce_shadow=True : reaches inside open shadow roots.
                 Interactive shadow elements are listed inline (each carries
                 in_shadow + shadow_host); a shadow root that holds only TEXT
                 (a web component with no controls) is listed as a
                 `shadow-content` item (in_shadow=true, its text as name), and
                 `shadow:[{host,text,interactive}]` summarizes every host.
                 `shadow_hosts` counts the components seen.
               `scrollables` is ALWAYS present ({selector, h, sh, top,
                 in_viewport}). Empty [] = the page itself scrolls (or nothing
                 does); non-empty = an inner panel scrolls — scroll INSIDE one
                 with pw_act(action="scroll", target="css=<selector>",
                 direction="down"). A page scroll that hits max_y:0 auto-scrolls
                 the largest panel and names it in `container`.
  screenshot : viewport capture, OR element-cropped if target= provided.
               full_page=True for full document (heavy, use sparingly).
               Returns {screenshot, screenshot_url, screenshot_step}.
  wait       : wait for an element to be visible. Required: target= (or selector=).
  eval       : run JS (value=script). Result capped at ~50 KB; over → preview.
  extract    : extract HTML TABLES (tables only — use "text" for prose).
               target= narrows to ONE table; without it, the first one.
  element    : everything about ONE element — all attributes, computed
               cursor/pointer-events/z-index, readOnly, contentEditable, and
               every <option> of a select. THE call to make when a click or a
               fill did not do what you expected. Required: target=.
  frames     : list the <iframe>s of the page (url, name, index).
  text       : extract textContent. Optional target=/selector= (default: whole page).
               include_frames=True : appends the text of each <iframe> (their
               content NEVER appears in the parent document's text).
  tabs       : list tabs.
  tab_new    : open tab (value=url).
  tab_switch : index= required.
  tab_close  : index= required.
  network    : recent network requests log — document + XHR/fetch, each
               {dir:REQ|RES, method, url, type, host, same_origin, status,
               postData}. Same-origin and document entries are kept first
               when the log exceeds max= (default 50); `by_host` counts
               everything, `total` is the size before the cap.
               value= filters on a URL substring.
  pdf        : export PDF.

SYNONYMS (all pw_* tools): action= == op=, value= == v=, target= == selector=.

EXAMPLES:
  pw_page(sid, action="inspect")                          # lite, viewport only
  pw_page(sid, action="inspect", level="full")            # exhaustive (heavy)
  pw_page(sid, action="inspect", since_step=3)            # diff since step 3
  pw_page(sid, action="screenshot", target="role=dialog") # cropped to dialog
  pw_page(sid, action="eval", value="return document.title")
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        # Noms harmonisés : action|op, value|v, target|selector (cf. en-tête).
        op = _first(action, op)
        v = _merge_value(value, v)
        sid = session_id
        if not op:
            return _err("action_required",
                        message="pw_page needs to know WHICH page operation to run.",
                        fix="pw_page(session_id, action='inspect'|'text'|"
                            "'screenshot'|'extract'|…). action= (legacy "
                            "synonym: op=) is required.")
        if op == "inspect":
            # NB: this function has a `max` parameter (used by op="extract"),
            # which shadows the builtin max(). Clamp max_items to [1, 200]
            # WITHOUT calling max() — doing so would raise
            # "TypeError: 'int' object is not callable".
            _mi = int(max_items)
            _mi = 1 if _mi < 1 else (200 if _mi > 200 else _mi)
            params = {
                "session_id": sid,
                "level": level if level in ("lite", "nav", "full") else "lite",
                "viewport_only": "true" if viewport_only else "false",
                "max_items": _mi,
                "skip_screenshot": "true" if (skip_screenshot or level == "lite") else "false",
            }
            if since_step and int(since_step) > 0:
                params["since_step"] = int(since_step)
            if include_frames:
                params["include_frames"] = "true"
            if not pierce_shadow:
                params["pierce_shadow"] = "false"
            _r = _req("GET", "/smart_inspect", params=params)
            if _AX_ENABLED:
                try:
                    _url = ""
                    if isinstance(_r, dict):
                        _url = _r.get("url") or _r.get("current_url") or ""
                    if _url:
                        _nodes = _ax_extract_nodes_from_inspect(_r)
                        _ax_record_inspection(_url, _nodes)
                except Exception:
                    pass
            return _r
        if op == "screenshot":
            _tgt = _merge_target(target, selector)
            if _tgt:
                # Element-cropped screenshot (server endpoint /element_screenshot)
                payload, _ = _build_locator_payload(target=_tgt)
                payload["session_id"] = sid
                _r = _req("POST", "/element_screenshot", json=payload)
            else:
                _r = _req("POST", "/screenshot", json={
                    "session_id": sid, "full_page": full_page,
                })
            return _screenshot_result(_r, full_page=full_page, target=_tgt)
        if op == "wait":
            # ``wait``/``text`` parlent au service en SÉLECTEUR brut ; le reste
            # de l'API parle en DSL. On accepte les deux et on aplatit ici
            # (même échelle de repli que pw_wait).
            _css = (selector or "").strip() or _dsl_to_selector(target)
            if not _css:
                return _err("target_required",
                            message="pw_page(action='wait') needs the element to wait for.",
                            fix="pw_page(action='wait', target='css=#done') — "
                                "target= (DSL) or selector= (raw CSS) is required.")
            return _req("POST", "/wait_for", json={
                "session_id": sid, "selector": _css, "timeout": 5000})
        if op == "eval":
            r = _req("POST", "/evaluate", json={"session_id": sid, "script": v})
            # Defensive cap on the result string
            if isinstance(r, dict):
                res = r.get("result")
                if isinstance(res, str) and len(res) > EVAL_RESULT_MAX_CHARS:
                    r = {**r,
                         "result": res[:EVAL_RESULT_MAX_CHARS],
                         "truncated": True,
                         "original_length": len(res),
                         "hint": "Result too large; narrow the script (e.g. .slice(0, N) or specific properties).",
                    }
                elif isinstance(res, (list, dict)):
                    import json as _json
                    s = _json.dumps(res)
                    if len(s) > EVAL_RESULT_MAX_CHARS:
                        r = {**r,
                             "result_preview": s[:5000],
                             "result": None,
                             "truncated": True,
                             "original_length": len(s),
                             "hint": "Result too large; narrow the script.",
                        }
            return r
        if op == "extract":
            # Sélecteur transmis : le service accepte `selector` (défaut
            # 'table') ; sans lui, une page à plusieurs tableaux rendrait
            # toujours le premier, sans moyen de viser.
            _body = {"session_id": sid, "max_rows": max}
            _css = (selector or "").strip() or _dsl_to_selector(target)
            if _css:
                _body["selector"] = _css
            return _req("POST", "/extract_table", json=_body)
        if op == "element":
            _css = (selector or "").strip() or _dsl_to_selector(target)
            if not _css:
                return _err("target_required",
                            message="element needs to know WHICH element to describe.",
                            fix="pw_page(action='element', target='css=#save')")
            return _req("POST", "/element_info", json={"session_id": sid, "selector": _css})
        if op == "frames":     return _req("GET", "/frames", params={"session_id": sid})
        if op == "text":
            # Clé ``selector`` OMISE quand l'appelant n'en fournit pas — ne
            # jamais envoyer ``null`` : le service déclare son défaut en
            # déstructuration JS (``const { selector = 'body' }``), qui ne
            # s'applique QU'À ``undefined``. Avec ``null``, ``innerText()``
            # rendrait ``null`` et le service exploserait sur ``text.replace``
            # (``cannot_read_properties_of_null_reading_r``, illisible pour
            # l'agent). ``pw_page`` est documenté « no element target by
            # default » : lire la page entière est le cas NOMINAL.
            _body = {"session_id": sid}
            _css = (selector or "").strip() or _dsl_to_selector(target)
            if _css:
                _body["selector"] = _css
            if include_frames:
                _body["include_frames"] = True
            if not pierce_shadow:
                _body["pierce_shadow"] = False
            # ⚠ `max` est un PARAMÈTRE de cette fonction (cf. op="inspect") :
            # appeler max() ici lèverait « 'int' object is not callable ».
            _to = (TIMEOUT if TIMEOUT > 30 else 30) if include_frames else None
            return _req("POST", "/extract_text", json=_body, timeout=_to)
        if op == "tabs":       return _req("GET", "/list_tabs", params={"session_id": sid})
        if op == "tab_new":
            if v:
                _bloque = _refus_url(v)
                if _bloque is not None:
                    return _bloque
            return _req("POST", "/new_tab", json={"session_id": sid, "url": v})
        if op == "tab_switch": return _req("POST", "/switch_tab", json={"session_id": sid, "tab_index": index})
        if op == "tab_close":  return _req("POST", "/close_tab", json={"session_id": sid, "tab_index": index})
        if op == "network":
            # ``max`` = taille du journal rendu ; ``value`` = filtre sur l'URL.
            _np: Dict[str, Any] = {"session_id": sid, "last": _clamp_items(max, default=50)}
            if v:
                _np["filter"] = v
            return _req("GET", "/network", params=_np)
        if op == "pdf":        return _req("POST", "/print_pdf", json={"session_id": sid})
        return _err(f"action={op!r} unknown",
                    hint="use: inspect|screenshot|wait|eval|extract|text|element|frames"
                         "|tabs|tab_new|tab_switch|tab_close|network|pdf")

    # ── pw_wait — wait for disappearance / dynamic condition / fixed pause ──
    # ── pw_dialog — alert / confirm / prompt natifs ──────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_dialog")
    def dialog(
        ctx: Context,
        session_id: str,
        action: str = "status",
        text: str = "",
        times: int = 1,
        sticky: bool = False,
    ) -> Union[Dict[str, Any], ErrEnvelope]:
        """Decide in advance how the next native dialog will be answered.

Native dialogs (alert / confirm / prompt) freeze the page until they are
answered, so the browser answers them for you: it ACCEPTS everything by
default. That default means you can never cancel a confirm, and never answer
a prompt (it gets an empty string). Arm a different answer BEFORE the click
that opens the dialog.

action= :
  accept : accept the next dialog. text= is the answer for a prompt.
  dismiss: cancel it (the "Cancel" button of a confirm).
  status : what is currently armed, and the last dialog seen
           ({type, message, action}) — use it to READ what the page asked.
  reset  : back to the default (accept).

times= : how many dialogs this policy covers (default 1, max 20). Useful for
         a flow that chains several confirms.
sticky=true : keep the policy until action="reset" (times= is then ignored).

status returns {armed, last, seen, history (last 10 dialogs), last_policy
(armed|default), default_when_unarmed:"accept", sticky}.

This call returns IMMEDIATELY — it arms a policy, it does not wait.

EXAMPLE — cancel a deletion:
  pw_dialog(sid, action="dismiss")
  pw_act(sid, action="click", target="role=button|name=Delete")
  pw_dialog(sid, action="status")   # → last: {type:"confirm", message:"Sure?"}
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        act_ = _first(action) or "status"
        if act_ not in ("accept", "dismiss", "status", "reset"):
            return _err(f"action={act_!r} unknown", hint="use: accept|dismiss|status|reset")
        return _req("POST", "/dialog", json={
            "session_id": session_id, "action": act_,
            "input_text": text, "times": times, "sticky": bool(sticky),
        })

    @mcp.tool(**with_policy(_TOOL_KW_OW_RO, timeout_s=330.0), name="pw_wait")
    def wait(
        ctx: Context,
        seconds: float = 0.0,
        session_id: str = "",
        target: str = "",
        selector: str = "",
        condition: str = "hidden",
        expected_text: str = "",
        attribute: str = "",
        expected_value: str = "",
        max_wait_s: int = 60,
        poll_ms: int = 300,
    ) -> Union[PWWaitResult, ErrEnvelope]:
        """Wait — for an element to DISAPPEAR, for a dynamic condition, or a fixed pause.

TWO MODES:
  1. Fixed pause — pw_wait(seconds=3)
     Sleeps N seconds (max 300). No session/target needed. Use sparingly (for
     an animation or a rate-limit); prefer a condition wait when you can.
  2. Condition wait — pw_wait(session_id=..., target=..., condition=...)
     Polls until the condition holds or max_wait_s elapses. Requires session_id
     and target= (DSL) or selector= (CSS/text/xpath).

CONDITIONS (default 'hidden'):
  hidden            : element gone / invisible  ← wait for a spinner/overlay/modal to vanish
  visible           : element appears and is visible
  attached          : element exists in the DOM (visible or not)
  detached          : element removed from the DOM
  text_contains     : element text contains expected_text=
  text_changes      : element text differs from its value when the wait began
  count_increases   : more elements match target= than at start
  count_decreases   : fewer elements match target= than at start
  attribute_changes : attribute= changes (or equals expected_value= when given)

RETURNS {ok, mode, condition, status, elapsed_ms, via, polled_value}. If the
condition is not met within max_wait_s, returns ok=False with timed_out=True —
a NORMAL outcome (the element simply never disappeared), not an error; decide
your next step from it. `polled_value` ({count, text, attr, visible}) is what
the element showed LAST — read it before retrying with another condition.

EXAMPLES:
  pw_wait(seconds=2)                                                       # fixed pause
  pw_wait(session_id=s, target="css=.spinner", condition="hidden")         # wait to disappear
  pw_wait(session_id=s, target="role=dialog", condition="hidden", max_wait_s=20)
  pw_wait(session_id=s, selector="#status", condition="text_contains", expected_text="Done")

The target is resolved EXACTLY like pw_expect (same by_*/ref locator on the
service, same fallback ladder on a raw selector), so a wait and the expect
that follows always look at the same element. Waits poll in short chunks, so
they never block other browser calls on the same session and never trip a
request timeout.
"""
        # ── Mode 1: fixed-duration pause (no browser / no session lock) ───
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        if seconds and seconds > 0 and not (session_id and (target or selector)):
            secs = max(0.0, min(float(seconds), float(_WAIT_MAX_S)))
            _t0 = time.monotonic()
            with Heartbeat(ctx):
                time.sleep(secs)
            return {"ok": True, "mode": "duration",
                    "elapsed_ms": int((time.monotonic() - _t0) * 1000)}

        # ── Mode 2: condition wait (chunked client-side polling) ──────────
        if not session_id:
            return _err("session_id required for a condition wait",
                        hint="pw_wait(session_id=..., target=..., condition='hidden') — "
                             "or pw_wait(seconds=N) for a fixed pause")
        # Même cible, même résolution que pw_expect : DSL → by_* (locator
        # officiel) + chaîne de repli. Ne pas passer ``selector=`` BRUT au
        # service : il le donne à ``document.querySelector``, où une forme DSL
        # (``css=#finish``, la plus naturelle après un pw_find) lève une
        # exception AVALÉE par la boucle de polling — l'attente expirerait sur
        # une cible pourtant présente.
        _sel_dsl = _merge_target(target, selector)
        sel = _dsl_to_selector(_sel_dsl)
        _by_kw = {k: val for k, val in _dsl_to_by_kw(_sel_dsl).items() if val is not None}
        if not sel and not _by_kw:
            return _err("target or selector required for a condition wait",
                        hint="pass target='css=.spinner' (or selector=) and a condition")
        _CONDITIONS = ("hidden", "visible", "attached", "detached", "text_contains",
                       "text_changes", "count_increases", "count_decreases",
                       "attribute_changes")
        if condition not in _CONDITIONS:
            return _err(f"condition={condition!r} unknown",
                        hint="use: " + "|".join(_CONDITIONS))

        budget = max(1, min(int(max_wait_s), _WAIT_MAX_S))
        poll = max(50, min(int(poll_ms), 5000))
        _t0 = time.monotonic()
        deadline = _t0 + budget
        # La ligne de base (texte/compte initial) est prise UNE fois : le
        # service la renvoie avec chaque 408 et on la lui repasse, sinon chaque
        # tranche de polling repartirait d'un état neuf et un changement
        # survenu à la frontière de deux tranches passerait inaperçu.
        _baseline = None
        _last_body: Dict[str, Any] = {}
        with Heartbeat(ctx):
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                chunk_ms = max(200, int(min(_WAIT_CHUNK_MS, remaining * 1000)))
                _payload: Dict[str, Any] = {
                    "session_id": session_id, "selector": sel, "condition": condition,
                    "expected_text": expected_text, "attribute": attribute,
                    "expected_value": expected_value,
                    "timeout": chunk_ms, "poll_interval": poll,
                    **_by_kw,
                }
                if _baseline is not None:
                    _payload["baseline"] = _baseline
                code, body = _req_status("POST", "/wait_for_dynamic", json=_payload,
                                         timeout=chunk_ms / 1000 + 5)
                if code == 200:
                    out = {"ok": True, "mode": "condition", "condition": condition,
                           "status": body.get("status"), "selector": sel,
                           "session_id": session_id,
                           "elapsed_ms": int((time.monotonic() - _t0) * 1000)}
                    for k in ("via", "polled_value", "text", "from", "to", "box",
                              "attribute", "value"):
                        if k in body:
                            out[k] = body[k]
                    return out
                if code == 408:
                    _last_body = body if isinstance(body, dict) else {}
                    if isinstance(_last_body.get("baseline"), dict):
                        _baseline = _last_body["baseline"]
                    continue  # condition not met yet — keep polling until deadline
                if code == 404:
                    return _err("Session not found", hint="start one with pw_session(action='start')")
                if code == 410:
                    return _err("Session expired", hint="reopen with pw_session(action='start')")
                if code in (423, 429):
                    time.sleep(0.3)  # session busy (Node per-session mutex) — brief backoff, retry
                    continue
                # Hard error (5xx / transport) — surface it rather than spin.
                return _err(str(body.get("error") or f"wait failed ({code})"),
                            hint="check the selector and that the session is alive")

        return {"ok": False, "mode": "condition", "condition": condition,
                "status": "timeout", "selector": sel, "session_id": session_id,
                "timed_out": True,
                "via": _last_body.get("via"),
                "polled_value": _last_body.get("polled_value"),
                "elapsed_ms": int((time.monotonic() - _t0) * 1000),
                "hint": f"condition '{condition}' on '{sel or _sel_dsl}' not met within {budget}s"
                        " — polled_value shows what the element displayed last"}

    # ═══════════════════════════════════════════════════════════════════
    # IHM TESTING + ADVANCED OBSERVATION TOOLS
    # ═══════════════════════════════════════════════════════════════════

    # ── pw_expect — assertion primitive ──────────────────────────────
    @mcp.tool(**_TOOL_KW_OW_RO, name="pw_expect")
    def expect(
        ctx: Context,
        session_id: str,
        assertion: str = "",
        target: str = "",
        value: str = "",
        timeout_ms: int = 5000,
        action: str = "",
        selector: str = "",
        v: str = "",
    ) -> Union[PWExpectResult, ErrEnvelope]:
        """Assert a condition. Returns {pass: bool, actual, expected, screenshot_on_fail?}.

ELEMENT ASSERTIONS (require target=):
  visible      : element exists and is visible.
  hidden       : element does not exist OR is invisible.
  enabled      : element is interactable.
  disabled     : element is disabled.
  checked      : checkbox/radio is checked.
  unchecked    : checkbox/radio is not checked.
  text-equals  : element textContent == value (trimmed, normalized).
  text-contains: element textContent contains value.
  value-equals : input value == value.
  count-eq     : exactly value (int) elements match the target.
  count-gte    : at least value (int) elements match.
  attr-equals  : attribute (value="attr=foo") equals (value="attr=foo|val=bar").
                 Use compound DSL: target="role=link|name=Docs",
                 value="attr=href|val=/docs".

PAGE ASSERTIONS (no target):
  url-equals    : page.url() == value.
  url-contains  : page.url() contains value.
  url-matches   : page.url() matches regex value.
  title-contains: document.title contains value.

EXAMPLES:
  pw_expect(sid, action="visible", target="role=alert|name=Saved")
  pw_expect(sid, action="text-equals", target="css=h1.title", value="Welcome John")
  pw_expect(sid, action="count-eq", target="role=row", value="5")
  pw_expect(sid, action="url-contains", value="/dashboard")
  pw_expect(sid, action="disabled", target="role=button|name=Submit")

SYNONYMS (all pw_* tools): action= == assertion=, value= == v=, target= == selector=.

This is the primitive for IHM testing. Combine multiple expects to build
an assertion suite. Failures include a screenshot and a hint.
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        # Noms harmonisés : action|assertion, value|v, target|selector.
        assertion = _first(action, assertion)
        value = _merge_value(value, v)
        target = _merge_target(target, selector)
        if not assertion:
            return _err("action_required",
                        message="pw_expect needs to know WHICH assertion to check.",
                        fix="pw_expect(session_id, action='visible'|"
                            "'text-equals'|'url-contains'|…). action= (legacy "
                            "synonym: assertion=) is required.")
        body = {
            "session_id": session_id,
            "assertion": assertion,
            "value": value,
            "timeout_ms": int(timeout_ms),
        }
        if target:
            body.update({k: v for k, v in _dsl_to_by_kw(target).items() if v is not None})
        # Slightly higher request timeout than assertion timeout (server needs headroom)
        return _req("POST", "/expect", json=body, timeout=max(TIMEOUT, int(timeout_ms / 1000) + 5))


    # ── pw_chain — batched actions ───────────────────────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_chain")
    def chain(
        ctx: Context,
        session_id: str,
        actions: List[Dict[str, Any]],
        stop_on_error: bool = True,
        screenshot_on_fail: bool = True,
        observe: bool = True,
        max_items: int = 25,
    ) -> Union[PWChainResult, ErrEnvelope]:
        """Execute multiple actions in a single round-trip (max 30).

actions= : list of {action, target?, value?, key?, url?, wait_after?, ms?}
  action values: click | fill | type | press | select | check | wait | scroll | goto | hover
  (per-step synonyms accepted: action|do|type, value|v)

EXAMPLES:
  # Login flow in one call:
  pw_chain(session_id, actions=[
    {"action": "fill", "target": "label=Email",    "value": "me@x.com"},
    {"action": "fill", "target": "label=Password", "value": "hunter2"},
    {"action": "click", "target": "role=button|name=Login", "wait_after": "network"},
  ])

  # Wait + verify pattern:
  pw_chain(session_id, actions=[
    {"action": "wait", "ms": 500},
    {"action": "click", "target": "test_id=continue"},
  ])

Returns {ok, total, executed, failed, results:[{step, action, success, ...}],
page_after}. ok=false when a step failed — read `results` (alternatives +
screenshot when enabled). observe=true (default) attaches `page_after`, a
lite snapshot taken AFTER the last step (max_items= caps it) — the same
grounding pw_act gives; set observe=false for speed-critical sequences.
Use this when you have a deterministic sequence to save 5-10x tool-call latency.
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        if not isinstance(actions, list) or not actions:
            return _err("actions[] required",
                        hint="pass a non-empty list of action steps")
        # Translate target DSL to BOTH a fallback `selector` string AND the
        # explicit by_* params. The server.js /chain endpoint prefers by_*
        # (Playwright official API, robust) and only falls back to the
        # selector string when no by_* is set. Never send the selector string
        # alone: `role=button[name="X"]` is NOT a valid CSS selector for
        # page.locator() and fails silently.
        translated = []
        for a in actions:
            a2 = dict(a)
            do = a2.pop("do", None) or a2.pop("type", None) or a2.pop("action", None)
            if do: a2["type"] = do
            if "target" in a2 and a2["target"]:
                d = _parse_target_dsl(a2["target"])
                # 1. Explicit by_* params (preferred — robust Playwright API)
                if d.get("ref"):           a2["ref"] = d["ref"]
                if d.get("role"):          a2["by_role"] = d["role"]
                if d.get("name"):          a2["by_name"] = d["name"]
                if d.get("text"):          a2["by_text"] = d["text"]
                if d.get("label"):         a2["by_label"] = d["label"]
                if d.get("placeholder"):   a2["by_placeholder"] = d["placeholder"]
                if d.get("test_id"):       a2["by_test_id"] = d["test_id"]
                if d.get("alt"):           a2["by_alt"] = d["alt"]
                if d.get("title"):         a2["by_title"] = d["title"]
                if d.get("css"):           a2["by_css"] = d["css"]
                if d.get("xpath"):         a2["by_xpath"] = d["xpath"]
                if isinstance(d.get("nth"), int): a2["nth"] = d["nth"]
                # 2. Fallback selector string for legacy server paths
                if d.get("ref"):                       a2.setdefault("selector", f"ref:{d['ref']}")
                elif d.get("test_id"):                 a2.setdefault("selector", f'[data-testid="{d["test_id"]}"]')
                elif d.get("label"):                   a2.setdefault("selector", f'label={d["label"]}')
                elif d.get("placeholder"):             a2.setdefault("selector", f'placeholder={d["placeholder"]}')
                elif d.get("text"):                    a2.setdefault("selector", d["text"])  # smartResolve handles plain text
                elif d.get("css"):                     a2.setdefault("selector", d["css"])
                elif d.get("xpath"):                   a2.setdefault("selector", f'xpath={d["xpath"]}')
                elif d.get("role") and d.get("name"):  a2.setdefault("selector", d["name"])  # text-fallback
                a2.pop("target", None)
            # v → text/key/value fallbacks (``value`` accepté en synonyme,
            # comme sur pw_act — un step de chaîne et un pw_act s'écrivent
            # pareil).
            v = a2.pop("v", None)
            if v is None and a2.get("type") not in ("select", "select_option"):
                v = a2.pop("value", None)
            if v is not None:
                if a2.get("type") == "press":
                    a2["key"] = a2.get("key") or v
                elif a2.get("type") in ("select", "select_option"):
                    a2["value"] = a2.get("value") or v
                else:
                    a2["text"] = a2.get("text") or v
            translated.append(a2)
        _r = _req("POST", "/chain", json={
            "session_id": session_id, "actions": translated,
            "stop_on_error": stop_on_error,
            "screenshot_on_fail": screenshot_on_fail,
        }, timeout=max(TIMEOUT, 60))
        # Comme pw_act : la page qui résulte de la chaîne est attachée à ses
        # étapes.
        return _finish_act(_r, session_id, observe, max_items)


    # ── pw_mock — network response stubbing ──────────────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_mock")
    def mock(
        ctx: Context,
        session_id: str,
        action: str,
        url_pattern: str = "",
        status: int = 200,
        body: str = "",
        content_type: str = "application/json",
        delay_ms: int = 0,
        times: int = -1,
    ) -> Union[PWMockResult, ErrEnvelope]:
        """Mock network responses to test UI under controlled backend conditions.

action= :
  add    : register a mock. url_pattern= (substring or regex), status=,
           body= (string), content_type=, delay_ms=, times= (-1 = unlimited).
  list   : list active mocks for this session.
  clear  : remove all mocks for this session.
  remove : remove mocks matching url_pattern=.

EXAMPLES — testing UI under failure conditions:
  pw_mock(sid, "add", url_pattern="/api/users", status=500, body='{"error":"DB down"}')
  pw_mock(sid, "add", url_pattern="/api/slow", delay_ms=3000)
  pw_mock(sid, "add", url_pattern="/api/login", status=401, times=1,
          body='{"error":"bad creds"}')

Returns {status, mocks_count?, removed?}.
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        if action == "add":
            if not url_pattern:
                return _err("url_pattern required",
                            hint="pass the URL (glob) pattern to mock")
            return _req("POST", "/mock/add", json={
                "session_id": session_id,
                "url_pattern": url_pattern,
                "status": int(status),
                "body": body,
                "content_type": content_type,
                "delay_ms": int(delay_ms),
                "times": int(times),
            })
        if action == "list":
            return _req("GET", "/mock/list", params={"session_id": session_id})
        if action == "clear":
            return _req("POST", "/mock/clear", json={"session_id": session_id})
        if action == "remove":
            return _req("POST", "/mock/remove", json={
                "session_id": session_id, "url_pattern": url_pattern,
            })
        return _err(f"unknown action {action!r}",
                    hint="use: add|list|clear|remove")


    # ── pw_recorder — record + replay sessions ──────────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_recorder")
    def recorder(
        ctx: Context,
        session_id: str,
        action: str,
        format: str = "playwright",
    ) -> Union[PWRecorderResult, ErrEnvelope]:
        """Record session actions and dump them as a reproducible test script.

action= :
  start : begin recording (idempotent — restarts).
  stop  : stop recording.
  dump  : return the recorded sequence in `format`.
          format= playwright | robot | cypress | json
  clear : drop the recording.
  status: returns {recording: bool, count: int}.

EXAMPLES:
  pw_recorder(sid, "start")
  # ... user / agent does pw_act calls ...
  pw_recorder(sid, "dump", format="playwright")
  → returns a runnable .spec.js file as text.

Use this to turn an exploratory agent run into a CI-ready regression test.
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        if action == "start":
            return _req("POST", "/recorder/start", json={"session_id": session_id})
        if action == "stop":
            return _req("POST", "/recorder/stop", json={"session_id": session_id})
        if action == "dump":
            return _req("GET", "/recorder/dump", params={
                "session_id": session_id, "format": format,
            })
        if action == "clear":
            return _req("POST", "/recorder/clear", json={"session_id": session_id})
        if action == "status":
            return _req("GET", "/recorder/status", params={"session_id": session_id})
        return _err(f"unknown action {action!r}",
                    hint="use: start|stop|dump|clear|status")


    # ── pw_observe — multi-mode observation (AX / indexed / SoM) ─────
    @mcp.tool(**_TOOL_KW_OW_RO, name="pw_observe")
    def observe(
        ctx: Context,
        session_id: str,
        mode: str = "indexed",
        viewport_only: bool = True,
        max_items: int = 30,
        since_step: int = 0,
        action: str = "",
        pierce_shadow: bool = True,
    ) -> Union[PWObserveResult, ErrEnvelope]:
        """Multi-mode page observation with explicit cost/robustness tradeoff.

action= (synonym: mode=) :
  indexed : compact text list — "[0] button \"Login\"", "[1] input \"Email\"",
            ... Cheap on tokens. LLM responds with the index. Use as default
            for new pages or when AX cache is empty.
  ax      : same as pw_page(action="inspect", level="lite"). Returns role+name+selector.
            Best when a stable selector matters (caching for AX memory).
  som     : Set-of-Mark — annotated screenshot with numbered boxes overlaid
            on every interactive element. Returns {screenshot, marks: [...]}.
            Use when:
              - the page has canvas/shadow DOM/custom widgets without ARIA
              - AX inspect returned ambiguous results (12x same role+name)
              - previous click attempts failed silently
            Cost: one screenshot pass + numbered overlay rendering.

OUTPUT (indexed mode):
  {
    "mode": "indexed",
    "url": "...",
    "items": [
      {"i": 0, "type": "button", "text": "Login", "selector": "..."},
      {"i": 1, "type": "input",  "text": "Email", "placeholder": "you@x.com", ...},
      ...
    ],
    "step": 7        # use as since_step= for next call to get only diffs
  }

After the LLM picks an index, dispatch with pw_act(target=f"ref={item.selector}")
or just pw_act(target=item['target_dsl']) — items include a `target_dsl` field.

EXAMPLES:
  pw_observe(sid)                              # indexed, viewport, top 30
  pw_observe(sid, action="som")                # for canvas / ambiguous
  pw_observe(sid, since_step=12)               # only diffs since step 12
"""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        mode = _first(action, mode) or "indexed"
        params = {
            "session_id": session_id,
            "mode": mode if mode in ("indexed", "ax", "som") else "indexed",
            "viewport_only": "true" if viewport_only else "false",
            "max_items": max(1, min(int(max_items), 200)),
        }
        if since_step and int(since_step) > 0:
            params["since_step"] = int(since_step)
        if not pierce_shadow:
            params["pierce_shadow"] = "false"
        return _req("GET", "/observe", params=params, timeout=max(TIMEOUT, 15))

    # ── pw_a11y — audit WCAG (checker maison, sans dépendance) ───────
    @mcp.tool(**_TOOL_KW_OW_RO, name="pw_a11y")
    def a11y(
        ctx: Context,
        session_id: str,
        scope: str = "",
        selector: str = "",
        target: str = "",
    ) -> Union[PWA11yResult, ErrEnvelope]:
        """WCAG accessibility audit of the page (built-in checker, no external lib).

Detects the violations that break a UI for keyboard / screen-reader /
color-blind users:
  • image-alt      : <img> without an alt attribute
  • label          : form field without a label/aria-label
  • control-name   : button/link without an accessible name
  • color-contrast : text/background contrast < AA (4.5:1, or 3:1 for large text)
  • duplicate-id   : duplicated HTML id
  • html-lang      : <html> without a lang attribute
  • heading-order  : skipped heading level (h1→h3)
  • tabindex       : positive tabindex (breaks tab order)

scope= : CSS selector to narrow the audit (default body = whole page).
         Synonyms: selector= / target= (same knob as the other pw_* tools).
Returns {violations:[{rule,impact,selector,message,text}], total, by_impact,
passed}. Run it after navigation/actions to validate UI quality."""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        _scope = _first(scope, selector) or _dsl_to_selector(target) or "body"
        return _req("POST", "/a11y_audit",
                    json={"session_id": session_id, "scope": _scope},
                    timeout=max(TIMEOUT, 20))

    # ── pw_visual — régression visuelle vs baseline ─────────────────
    @mcp.tool(**_TOOL_KW_OW_MUT, name="pw_visual")
    def visual(
        ctx: Context,
        session_id: str,
        name: str = "default",
        selector: str = "",
        threshold: float = 0.01,
        update: bool = False,
        target: str = "",
    ) -> Union[PWVisualResult, ErrEnvelope]:
        """Visual regression: compare the page (or one element) to a "golden" baseline.

First call (or update=true) → records the baseline (baseline_created=true).
Subsequent calls → pixel diff, returning: passed (diff_ratio<=threshold),
diff_ratio, diff_pixels + 3 image URLs (screenshot_url, baseline_url,
diff_url). diff_url is a RED heatmap of the changed pixels — inspect it if
you have vision capability.

name=       : baseline key (one per screen/state under watch).
selector=   : narrow to one element (otherwise full page). Synonym: target=.
threshold=  : tolerated ratio of differing pixels (default 0.01 = 1%).
update=true : replace the baseline with the current state (after a deliberate UI change)."""
        _username = get_username(ctx)
        _refus = _refus_session_d_autrui(session_id, _username)
        if _refus is not None:
            return _refus
        body = {"session_id": session_id, "name": name or "default",
                "threshold": float(threshold), "update": bool(update)}
        _sel = (selector or "").strip() or _dsl_to_selector(target)
        if _sel:
            body["selector"] = _sel
        return _req("POST", "/visual", json=body, timeout=max(TIMEOUT, 30))

    # ── pw_memory — interroge la mémoire AX accumulée ────────────────
    @mcp.tool(**_TOOL_KW_OW_RO, name="pw_memory")
    def memory(
        ctx: Context,
        op: str = "",
        action: str = "",
        site: str = "",
        path: str = "",
        to_path: str = "",
        from_path: str = "",
        query: str = "",
        limit: int = 20,
        max_depth: int = 6,
    ) -> Union[PWMemoryResult, ErrEnvelope]:
        """Query the accumulated AX memory of successfully-used UI paths.

This is how you REUSE what previous runs already learned about a UI
instead of re-discovering it from scratch. Every op returns a COMPACT,
scoped payload — none of them ever dump the whole tree into context.

WHEN TO USE: before navigating a site you may have visited before.
Check action="sites"; if the site is known, ask for a "path" or "find"
what you need rather than blindly inspecting page after page.

OPERATIONS (action=, synonym: op=):
  sites : list known sites + stats (elements, paths, transitions,
          stored credentials). No args. Start here.
  path  : shortest KNOWN click-path to reach a page.
          Required: site=, to_path=.
          Optional: from_path= (default: any known page),
                    max_depth= (default 6).
          Returns ordered steps {from, to, action_role, action_name,
          action_selector, verified_count} — feed action_selector
          straight into pw_act(target=...).
  find  : search elements by name/role across a site.
          Required: site=, query=. Optional: limit= (default 20).
          Returns compact matches {path, role, name, selector,
          verified_count, stale}.
  page  : known interactive elements of ONE page (not the whole site).
          Required: site=, path=. Optional: limit= (default 50, here
          passed as limit=).
          Returns a flat, capped element list.

site= is the normalized site id from action="sites" (host[:port]).
path= / to_path= / from_path= are URL paths ("/", "/admin/users", …).

EXAMPLES:
  pw_memory(action="sites")
  pw_memory(action="path", site="app.local:8080", to_path="/admin/users")
  pw_memory(action="path", site="app.local:8080", to_path="/billing",
            from_path="/dashboard")
  pw_memory(action="find", site="app.local:8080", query="export")
  pw_memory(action="page", site="app.local:8080", path="/settings")
"""
        _username = get_username(ctx)
        op = _first(action, op)
        if not op:
            return _err("action_required",
                        message="pw_memory needs to know WHICH query to run.",
                        fix="pw_memory(action='sites'|'path'|'find'|'page'). "
                            "action= (legacy synonym: op=) is required.")
        if not _AX_ENABLED:
            return _err("ax memory unavailable",
                        hint="backend.ax_memory failed to import in this "
                             "process — check server logs for [ax] lines")
        try:
            if op == "sites":
                from shared_infra.memory.ax import list_sites_with_stats
                # Bornée au compte appelant : sans ``owner``, cette vue
                # publierait ``cred_username`` pour TOUS les sites connus.
                sites = list_sites_with_stats(owner=get_username(ctx) or "")
                return {"op": "sites", "count": len(sites), "sites": sites}

            if op == "path":
                if not site or not to_path:
                    return _err("path requires site= and to_path=")
                from shared_infra.memory.ax import find_path
                r = find_path(site, to_path,
                              from_path=(from_path or None),
                              max_depth=max(1, min(int(max_depth), 12)))
                return {"op": "path", **r}

            if op == "find":
                if not site or not query:
                    return _err("find requires site= and query=")
                from shared_infra.memory.ax import search_nodes
                matches = search_nodes(site, query,
                                       limit=max(1, min(int(limit), 100)))
                return {"op": "find", "site": site, "query": query,
                        "count": len(matches), "matches": matches}

            if op == "page":
                if not site or not path:
                    return _err("page requires site= and path=")
                from shared_infra.memory.ax import load_dom_tree
                dom = load_dom_tree(site, path=path)
                page_data = dom.get(path) or {}
                by_id = page_data.get("by_id") or {}
                cap = max(1, min(int(limit), 200))
                elements = []
                for node in by_id.values():
                    if node.get("node_type") != "element":
                        continue
                    sels = node.get("selectors") or []
                    elements.append({
                        "role":           node.get("role"),
                        "name":           node.get("name"),
                        "region_tag":     node.get("region_tag"),
                        "verified_count": node.get("verified_count"),
                        "stale":          node.get("stale"),
                        "selector":       (sels[0] if sels else None),
                    })
                elements.sort(key=lambda e: (bool(e["stale"]),
                                             -(e["verified_count"] or 0)))
                truncated = len(elements) > cap
                return {"op": "page", "site": site, "path": path,
                        "count": min(len(elements), cap),
                        "truncated": truncated,
                        "elements": elements[:cap]}

            return _err(f"unknown action {op!r}",
                        hint="use: sites|path|find|page")
        except Exception as e:
            return _err(f"ax memory query failed: {e}")

