# SPDX-License-Identifier: MIT
# tools/_toolkit.py
"""
Shared harmonization layer for the local MCP tools.

Every tool module imports from here so the whole suite presents ONE
consistent contract to the model:

  • one result shape, one error shape (errors that say how to recover);
  • one truncation marker, one pagination envelope;
  • one set of input-coercion rules (the model sends imperfect JSON);
  • one place that builds the FastMCP category tags/meta.

Why it matters: a model — anywhere from 30B to 220B — learns the
conventions ONCE and applies them to every tool. Consistency is what
lets a smaller model punch above its weight, and what stops a bigger
one from wasting its turn budget re-learning each tool.

Backward compatible by design
-----------------------------
The result/error envelope keeps ``{"ok": bool, "error": ...}`` at the
top level — the chat and agentic frontends already key off those — and
only ADDS optional guidance fields. Existing consumers ignore what they
don't recognise, so adopting this in a module never breaks the UI.

Output budget (serves "any model without overloading it")
---------------------------------------------------------
Truncation defaults are read from the environment so an operator can
dial verbosity per deployment / per model size without editing tools:

    TOOL_TEXT_BUDGET   default 6000   max chars for a text payload
    TOOL_LIST_BUDGET   default 50     max items in a paginated list

Docstring convention (every @mcp.tool)
--------------------------------------
Line 1: one imperative sentence — what it does.
Then:   WHEN to use it, and explicitly when NOT to (vs. sibling tools).
Then:   one concrete example call.
Then:   params with their constraints/defaults; limits stated.
Keep it tight — the docstring is the only thing the model sees.
"""
from __future__ import annotations

import fnmatch
import json
import os
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


# ── Output budgets (env-configurable) ────────────────────────────────
def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "").strip() or default))
    except (TypeError, ValueError):
        return default


TEXT_BUDGET  = _env_int("TOOL_TEXT_BUDGET", 6000)
# AUDIT 2026-08-23 — ``clip_lines`` et ``LINES_BUDGET`` SUPPRIMÉS : zéro
# occurrence hors leurs définitions. La variable d'environnement documentée
# ``TOOL_LINES_BUDGET`` n'avait donc AUCUN lecteur — un réglage annoncé qui
# ne réglait rien.
LIST_BUDGET  = _env_int("TOOL_LIST_BUDGET", 50)


# ── Result envelope ──────────────────────────────────────────────────
def ok(**fields: Any) -> Dict[str, Any]:
    """A success result. ``ok(todos=[...], total=3)`` →
    ``{"ok": True, "todos": [...], "total": 3}``."""
    return {"ok": True, **fields}


def err(
    code: str,
    message: str,
    *,
    fix: Optional[str] = None,
    next_action: Optional[str] = None,
    retryable: bool = False,
    **context: Any,
) -> Dict[str, Any]:
    """A failure that TEACHES the model how to recover.

    code         short machine-readable token (``"file_not_found"``) — stable,
                 lets the model branch without parsing prose.
    message      one human sentence: what happened.
    fix          how to correct THIS call (the most useful field — fill it
                 whenever the cause is knowable).
    next_action  what to do instead / which other tool to reach for.
    retryable    True only for transient failures worth retrying as-is.
    **context    structured data the model can act on directly, e.g.
                 ``valid_choices=[...]``, ``existing_ids=[...]``,
                 ``did_you_mean="..."``.

    A bad error is ``{"error": "invalid input"}``. A good error is
    ``err("bad_path", "path is outside the sandbox",
          fix="pass a path relative to the project root",
          next_action="call list_files to see what's available")``.
    """
    e: Dict[str, Any] = {"ok": False, "error": code, "message": message}
    if fix:
        e["fix"] = fix
    if next_action:
        e["next_action"] = next_action
    if retryable:
        e["retryable"] = True
    e.update(context)
    # Wording éditable à froid : si errors.<code> existe dans
    # context_config.json, ses champs message/fix surchargent le défaut
    # (centralisation/traduction). Absent/vide => texte d'origine intact.
    try:
        from llm_core.context_config import CTX as _CTX
        _ov = _CTX.get(f"errors.{code}")
        if isinstance(_ov, dict):
            if _ov.get("message"):
                e["message"] = _ov["message"]
            if _ov.get("fix"):
                e["fix"] = _ov["fix"]
    except Exception:
        pass
    return e


# ── Token economy ────────────────────────────────────────────────────
# Every tool result is permanent context for the rest of the run — the
# model re-reads it on every later turn. These keep payloads bounded and
# their truncation honest (the model must SEE that it was cut, and how
# to get the rest).
def clip_text(text: str, max_chars: Optional[int] = None,
              *, label: str = "contenu") -> str:
    """Clip a text payload, leaving a parseable marker stating how much
    was dropped and the true total. Use for file contents, command
    output, anything free-form."""
    if text is None:
        return ""
    text = str(text)
    limit = TEXT_BUDGET if max_chars is None else max_chars
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    return (text[:limit]
            + f"\n…[{label} tronqué : {omitted} caractères omis sur "
              f"{len(text)} — affine la requête (plage, filtre) pour voir le reste]")


def head_tail(text: str, *, head_lines: int = 40, tail_lines: int = 20,
              label: str = "sortie") -> str:
    """Keep the START and END of a long payload, drop the middle. Right
    choice for logs / command output where both ends carry signal."""
    if text is None:
        return ""
    lines = str(text).splitlines()
    if len(lines) <= head_lines + tail_lines:
        return str(text)
    dropped = len(lines) - head_lines - tail_lines
    return "\n".join(
        lines[:head_lines]
        + [f"…[{label} : {dropped} lignes du milieu omises sur {len(lines)}]"]
        + lines[-tail_lines:]
    )




def page(items: Sequence[Any], *, offset: int = 0,
         limit: Optional[int] = None) -> Dict[str, Any]:
    """One pagination envelope for every list-returning tool, so the
    model learns the shape once. Returns ``items`` plus the cursor info
    it needs to ask for more."""
    offset = max(0, int(offset or 0))
    limit = LIST_BUDGET if limit is None else max(1, int(limit))
    total = len(items)
    window = list(items[offset:offset + limit])
    has_more = offset + limit < total
    return {
        "items": window,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": has_more,
        "next_offset": (offset + limit) if has_more else None,
    }


# ── Input tolerance (the model sends imperfect JSON) ─────────────────
_QUOTE_PAIRS = (('"', '"'), ("'", "'"), ("\u201c", "\u201d"), ("\u2018", "\u2019"))


def unquote(s: Any) -> str:
    """Strip over-quoting a model commonly adds, including nested layers:
    ``'"value"'`` → ``value``, smart quotes included."""
    if s is None:
        return ""
    s = str(s).strip()
    changed = True
    while changed and len(s) >= 2:
        changed = False
        for a, b in _QUOTE_PAIRS:
            if s.startswith(a) and s.endswith(b):
                s = s[1:-1].strip()
                changed = True
                break
    return s


def as_str(v: Any, default: str = "") -> str:
    """Coerce to a clean string, stripping over-quoting."""
    if v is None:
        return default
    return unquote(v)


def as_int(v: Any, default: Optional[int] = None) -> Optional[int]:
    """Coerce ``"5"``, ``5.0``, ``" 5 "``, ``'"5"'`` → ``5``. ``default``
    on anything unparseable — never raises."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    try:
        return int(float(unquote(v)))
    except (TypeError, ValueError):
        return default


def as_bool(v: Any, default: bool = False) -> bool:
    """Coerce common truthy/falsy spellings the model emits."""
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    s = unquote(v).lower()
    if s in ("true", "1", "yes", "y", "on", "oui"):
        return True
    if s in ("false", "0", "no", "n", "off", "non", ""):
        return False
    return default


def as_list(v: Any) -> List[Any]:
    """Be liberal: a real list passes through; a JSON-encoded list string
    is parsed; a lone scalar is wrapped. Models routinely send a single
    item where a list is expected, or a list serialized as a string."""
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, tuple):
        return list(v)
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("[") and s.endswith("]"):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return parsed
            except (ValueError, TypeError):
                pass
        return [v] if s else []
    return [v]


def as_enum(v: Any, choices: Iterable[str], default: Optional[str] = None,
            *, normalize: bool = True) -> Optional[str]:
    """Coerce to one of ``choices``. With ``normalize`` (default) it also
    lowercases and maps ``-``/spaces → ``_`` before matching, so
    ``"In Progress"`` resolves to ``in_progress``. ``default`` on miss."""
    choices = list(choices)
    s = unquote(v)
    if normalize:
        s = s.lower().replace("-", "_").replace(" ", "_")
        norm = {c.lower().replace("-", "_").replace(" ", "_"): c for c in choices}
        return norm.get(s, default)
    return s if s in choices else default


# ── Identity helpers (ctx-aware) ─────────────────────────────────────
#
# v17.19+ (Phase 2 fastmcp 3.x migration) — pattern unifié pour résoudre
# l'identité (username, chat_id) d'un appel de tool. Le pattern miroite
# ``memory_tools._identity()`` (qui a établi le pattern) et le rend
# réutilisable sans dépendance circulaire entre files.
#
# Order de priorité (le plus haut gagne) :
#
#   1. ``ctx.request_context.meta["username"]`` — c'est l'end-state cible.
#      Le client backend envoie l'identité dans le _meta du MCP request,
#      out-of-band, donc le LLM ne voit JAMAIS ces champs.
#   2. L'argument legacy ``_username: str = "guest"`` injecté par le client
#      dans les kwargs du tool — pattern transitoire, kept pour Backward
#      compat tant que tous les serveurs/clients ne sont pas sur le _meta.
#   3. Défaut "guest" si rien ne résout.
#
# Une fois TOUS les clients sur _meta, on peut supprimer l'arg ``_username``
# de chaque tool function (Phase 2c — cleanup). Cette étape n'est PAS
# automatique : le helper continue à accepter un fallback explicite, donc
# l'appelant peut juste passer "" et tout fonctionne.

def _safe_username(username: Optional[str]) -> str:
    """Normalise un username pour usage comme nom de dir sandbox.

    Garde uniquement [A-Za-z0-9_-], default "guest" si vide après nettoyage.
    Identique à la version locale de memory_tools, centralisée ici.
    """
    # Délègue à la source unique pour rester strictement aligné avec le
    # dossier sandbox / le nom de container / l'arbo du front.
    try:
        from shared_infra.config import safe_sandbox_name as _ssn
        return _ssn(username)
    except Exception:
        if not username:
            return "guest"
        import re as _re
        s = _re.sub(r"[^A-Za-z0-9_-]", "", str(username))
        return s or "guest"


def _safe_chat_id(chat_id: Optional[str]) -> str:
    """Normalise un chat_id pour usage comme suffixe de fichier."""
    if not chat_id:
        return "default"
    import re as _re
    s = _re.sub(r"[^A-Za-z0-9_-]", "", str(chat_id))
    return s or "default"


def _read_meta_field(ctx: Any, field: str) -> Optional[str]:
    """Lecture défensive de ctx.request_context.meta[field].

    Le chemin attribut exact a varié entre les releases fastmcp 2.x/3.x.
    Ce helper retourne ``None`` silencieusement si quoi que ce soit
    manque, plutôt que de lever.
    """
    try:
        rc = getattr(ctx, "request_context", None)
        meta = getattr(rc, "meta", None) if rc is not None else None
        if meta is None:
            return None
        if isinstance(meta, dict):
            v = meta.get(field)
        else:
            v = getattr(meta, field, None)
        return str(v) if v else None
    except Exception:
        return None


def _token_identity() -> Optional[str]:
    """(2026-09-02) Identité LIÉE AU JETON Bearer de l'appel — client EXTERNE
    (``LOCAL_MCP_CLIENT_TOKENS``). Prime sur le ``meta``, auto-déclaré par le
    client. ``None`` hors auth (stdio, tests) et pour le jeton de SERVICE de
    l'app (``trusted_meta`` : l'identité vient alors du ``meta``)."""
    try:
        from fastmcp.server.dependencies import get_access_token
        tok = get_access_token()
    except Exception:
        return None
    if tok is None:
        return None
    claims = getattr(tok, "claims", None) or {}
    if claims.get("trusted_meta"):
        return None
    u = claims.get("username") or getattr(tok, "client_id", None)
    return str(u) if u else None


def get_username(ctx: Any, fallback_arg: str = "guest") -> str:
    """Résout le username pour un appel de tool.

    Ordre : identité du JETON (client externe) → ``meta.username`` (client de
    confiance : l'app) → arg legacy ``_username`` → ``guest``.

    Args:
        ctx: ``fastmcp.Context`` injecté dans le tool. Peut être ``None``
             si on est appelé hors d'un contexte MCP (tests unitaires).
        fallback_arg: la valeur passée en arg legacy ``_username`` par le
             client (peut être ``"guest"`` ou ``""`` selon le client).

    Returns:
        Un username sanitisé, garanti non-vide ([A-Za-z0-9_-]+).
    """
    tid = _token_identity()
    if tid:
        return _safe_username(tid)
    v = _read_meta_field(ctx, "username")
    if v:
        return _safe_username(v)
    return _safe_username(fallback_arg)


def get_chat_id(ctx: Any, fallback_arg: str = "default") -> str:
    """Résout le chat_id pour un appel de tool. Voir ``get_username``."""
    v = _read_meta_field(ctx, "chat_id")
    if v:
        return _safe_chat_id(v)
    return _safe_chat_id(fallback_arg)


# ── Loop du serveur MCP + notifications LIVE + battement (2026-09-11, P3) ──
#
# Les coroutines ``ctx.*`` touchent la session MCP, qui vit sur la loop du
# SERVEUR FastMCP. Depuis le thread sync d'un outil (cas dominant) il n'y a pas
# de loop courante, et depuis la loop du pont d'exécution on aurait la MAUVAISE
# loop (cross-loop sur les streams anyio). Le serveur enregistre sa loop au
# premier appel d'outil (middleware ``ServerLoopCapture``) et
# ``schedule_ctx_coro`` la privilégie TOUJOURS. Vivait dans ``_exec_bridge``
# (sandbox) ; remonté ici pour que navigateur/desktop (sans sandbox) puissent
# battre pendant une attente longue.
import asyncio as _asyncio
import os as _os
import threading as _threading
import time as _time

_server_loop: "Optional[object]" = None


def register_server_loop(loop) -> None:
    """Enregistre la loop asyncio du serveur MCP (idempotent — affectation
    atomique, pas besoin de verrou)."""
    global _server_loop
    if _server_loop is not loop:
        _server_loop = loop


def schedule_ctx_coro(coro):
    """Fire-and-forget d'une coroutine ``ctx.*`` sur la loop du SERVEUR MCP.

    Ordre de préférence :
      1. la loop serveur enregistrée (``register_server_loop``) — seule loop
         où la session MCP peut émettre ; on retourne la ``Future`` pour que
         l'appelant puisse s'y synchroniser (batcher live shell) ;
      2. la loop courante si on est déjà DANS un contexte async (appelant
         natif async → c'est la loop serveur par construction) ;
      3. sinon on ferme proprement la coroutine (best-effort, pas de warning
         « never awaited »).
    """
    loop = _server_loop
    if loop is not None and getattr(loop, "is_running", lambda: False)():
        try:
            return _asyncio.run_coroutine_threadsafe(coro, loop)
        except Exception:
            pass
    try:
        cur = _asyncio.get_running_loop()
    except RuntimeError:
        cur = None
    if cur is not None and cur.is_running():
        cur.call_soon_threadsafe(lambda: _asyncio.ensure_future(coro))
        return None
    try:
        coro.close()
    except Exception:
        pass
    return None


# Notifications MCP STRUCTURÉES du terminal en direct (``ctx.log(..., extra=…)``).
# Le client (``_mcp_wrappers._LogRouter`` + ``engine/tool_exec._log_cb``) lit
# d'abord ``extra`` ; la sentinelle JSON ``__shell_output__`` dans le message
# n'est plus qu'un REPLI pour un serveur d'outils antérieur (une version).
LIVE_LOGGER_SHELL = "elpis.shell"
LIVE_LOGGER_HEARTBEAT = "elpis.heartbeat"
LIVE_KIND_SHELL = "shell_output"
LIVE_KIND_HEARTBEAT = "heartbeat"
# Battement pendant une exécution SILENCIEUSE : une notification légère toutes
# les N secondes garde vivant le flux HTTP d'un ``tools/call`` long (proxy TLS,
# relais) et dit au client que l'appel vit encore. 0 = désactivé.
try:
    HEARTBEAT_S = float(_os.environ.get("ELPIS_TOOL_HEARTBEAT_S", "15") or 0)
except ValueError:
    HEARTBEAT_S = 15.0


def live_notify(ctx: Any, kind: str, payload: Dict[str, Any], *,
                logger_name: str, legacy_key: Optional[str] = None) -> Any:
    """Coroutine ``ctx.log`` structurée (``extra={"kind": kind, **payload}``),
    ou repli sentinelle JSON dans le message si ce ``Context`` n'accepte pas
    ``extra`` (fastmcp ancien). ``None`` si rien ne peut être envoyé. Ne
    poste rien : l'appelant ``await`` (outil async) ou ``schedule_ctx_coro``
    (thread sync)."""
    import json as _json
    extra = {"kind": kind, **payload}
    try:
        return ctx.log(kind, level="info", logger_name=logger_name, extra=extra)
    except (TypeError, AttributeError):
        pass                      # ``log`` absent ou sans ``extra`` → repli
    except Exception:
        return None
    if legacy_key is None:
        return None
    try:
        msg = _json.dumps({legacy_key: payload}, ensure_ascii=False)
        try:
            return ctx.info(msg, logger_name=logger_name)
        except TypeError:
            return ctx.info(msg)
    except Exception:
        return None


class Heartbeat:
    """Battement périodique (``extra.kind = heartbeat``) posté sur la loop du
    serveur pendant qu'un outil long tourne dans son thread. Aucun événement
    côté front : le client le consomme pour lui-même (flux vivant).

    ``with Heartbeat(ctx): …`` autour d'une exécution / attente longue."""

    def __init__(self, ctx: Any, *, interval_s: Optional[float] = None) -> None:
        self._ctx = ctx
        self._interval = float(HEARTBEAT_S if interval_s is None else interval_s)
        self._stop = _threading.Event()
        self._thread: Optional[_threading.Thread] = None
        self._t0 = _time.monotonic()
        self._call_id = _read_meta_field(ctx, "call_id") if ctx is not None else None
        self._log_token = _read_meta_field(ctx, "log_token") if ctx is not None else None
        self.ticks = 0

    def _payload(self) -> Dict[str, Any]:
        p: Dict[str, Any] = {"elapsed_s": round(_time.monotonic() - self._t0, 1)}
        if self._call_id:
            p["call_id"] = self._call_id
        if self._log_token:
            p["log_token"] = self._log_token
        return p

    def tick(self) -> None:
        if self._ctx is None:
            return
        coro = live_notify(self._ctx, LIVE_KIND_HEARTBEAT, self._payload(),
                           logger_name=LIVE_LOGGER_HEARTBEAT)
        if coro is not None:
            schedule_ctx_coro(coro)
            self.ticks += 1

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.tick()

    def start(self) -> "Heartbeat":
        if self._ctx is None or self._interval <= 0 or self._thread is not None:
            return self
        self._thread = _threading.Thread(target=self._run, name="elpis-heartbeat", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=1.0)

    def __enter__(self) -> "Heartbeat":
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()


# ── FastMCP category tagging ─────────────────────────────────────────
#
# v18 (Tier 1 MCP best practices) — annotation builders.
#
# Every tool decorator should be `@mcp.tool(**_TOOL_KW_<kind>)` where the
# kind reflects the tool's *behaviour* (read-only, mutating, destructive,
# open-world). The annotations end up in the tool's JSON schema and are
# read by MCP-aware clients to:
#   * skip confirmation on read-only tools (saves a click + LLM turn),
#   * surface a warning on destructive ones (delete, force-push, …),
#   * auto-retry on idempotent failures,
#   * mark open-world tools (touch external networks / services) so the
#     UI can show a network icon and the admin can audit them.
#
# Spec: https://modelcontextprotocol.io/specification/server/tools#annotations
# FastMCP: ``annotations=ToolAnnotations(...)`` or a dict, both accepted.

# ── Politique d'EXÉCUTION portée par le protocole (2026-09-11, P2) ─────────
#
# Jusqu'ici le harnais de l'app tenait huit listes PAR NOM D'OUTIL (timeouts,
# préfixes sériels, rejeu après reconnexion, élagage, deny sous-agents/
# routines…). Un outil ajouté ou renommé côté serveur les laissait fausses en
# silence. La politique voyage désormais DANS ``meta["policy"]`` de chaque
# outil et le client la lit à la connexion (``llm_core._mcp_categories``) :
#
#   timeout_s    : borne d'exécution côté client (défaut : LLAMA_TOOL_TIMEOUT_S)
#   serial       : sérialiser dans un lot parallèle (effets sur état partagé)
#   replay_safe  : rejouable après reconnexion sans doublon (défaut : not serial)
#   prune        : élagage du résultat : "diff" | "head_tail" | "desktop" | ""
#   deny_for     : rôles pour lesquels l'outil est RETIRÉ : "subagent", "routine"
#
# Les anciennes listes restent des REPLIS pour les serveurs qui ne déclarent
# rien (externes) et pour un registre encore vide.
_POLICY_KEYS = ("timeout_s", "serial", "replay_safe", "prune", "deny_for")


def with_policy(kw: Dict[str, Any], **policy: Any) -> Dict[str, Any]:
    """Copie de ``kw`` (un keyset ``_TOOL_KW_*``) avec ``meta.policy`` enrichi.
    ``@mcp.tool(**with_policy(_TOOL_KW_RO, timeout_s=330))``."""
    bad = [k for k in policy if k not in _POLICY_KEYS]
    if bad:
        raise ValueError(f"clé de politique inconnue : {bad}")
    out = dict(kw)
    meta = dict(out.get("meta") or {})
    pol = dict(meta.get("policy") or {})
    for k, v in policy.items():
        if v is None:
            continue
        if k == "deny_for":
            v = sorted({str(x) for x in (v or ())})
        pol[k] = v
    if "serial" in pol and "replay_safe" not in pol:
        pol["replay_safe"] = not bool(pol["serial"])
    meta["policy"] = pol
    out["meta"] = meta
    return out


def tool_kw(category: Dict[str, Any], **policy: Any) -> Dict[str, Any]:
    """Build the ``@mcp.tool(**tool_kw(CATEGORY))`` kwargs — category in
    the protocol via ``tags`` + ``meta``. One place to change if a
    FastMCP version ever rejects ``meta=`` (then: return only ``tags``).

    No annotations set — caller specifies behaviour via the variants below.
    ``**policy`` : politique d'exécution (cf. ``with_policy``).
    """
    base = {"tags": {category["name"]}, "meta": {"category": category}}
    return with_policy(base, **policy) if policy else base


def _annotated(
    category: Dict[str, Any],
    *,
    title: Optional[str] = None,
    read_only: bool = False,
    destructive: bool = False,
    idempotent: bool = False,
    open_world: bool = False,
    **policy: Any,
) -> Dict[str, Any]:
    """Internal: build kwargs with the full annotation set.

    The MCP spec defines four boolean hints + an optional title. Defaults
    here mirror the "neutral" tool: not read-only, not destructive, not
    idempotent, closed-world (sandbox-only). Variants override what they
    care about and leave the rest at the safe default.
    """
    base = tool_kw(category, **policy)
    annotations: Dict[str, Any] = {
        "readOnlyHint":    read_only,
        "destructiveHint": destructive,
        "idempotentHint":  idempotent,
        "openWorldHint":   open_world,
    }
    if title:
        annotations["title"] = title
    base["annotations"] = annotations
    return base


def tool_kw_readonly(category: Dict[str, Any], *,
                     title: Optional[str] = None, **policy: Any) -> Dict[str, Any]:
    """Marks an outil as read-only. The UI is free to auto-confirm.

    Use for: file readers (read_file, list_files, stat_path), introspection
    (code_outline), git read-ops (git_query, git_inspect), chart generation
    (no side effects on user state).

    read_only=True implies destructive=False; idempotent=True is implied
    semantically (reading the same file twice yields the same answer) so
    we set it too.
    """
    return _annotated(category, title=title,
                      read_only=True, destructive=False,
                      idempotent=True, open_world=False, **policy)


def tool_kw_destructive(category: Dict[str, Any], *,
                        title: Optional[str] = None,
                        open_world: bool = False, **policy: Any) -> Dict[str, Any]:
    """Marks a tool as performing destructive changes.

    Triggers a confirmation prompt in MCP-aware clients. Use sparingly —
    too many destructive flags numb the user.

    Use for: manage_files(action="delete"|"batch_delete"), git_abandon,
    git_action(action="restore"), shell ops that explicitly nuke state.
    """
    return _annotated(category, title=title,
                      read_only=False, destructive=True,
                      idempotent=False, open_world=open_world, **policy)


def tool_kw_idempotent(category: Dict[str, Any], *,
                       title: Optional[str] = None,
                       open_world: bool = False, **policy: Any) -> Dict[str, Any]:
    """Mutating, but repeating the same call yields the same result.

    Use for: write_file (same content → same file), mkdir (exists OK),
    edit_file with anchor=str_replace (same edit → same file).

    The client may retry on transient failures without asking the LLM
    again.
    """
    return _annotated(category, title=title,
                      read_only=False, destructive=False,
                      idempotent=True, open_world=open_world, **policy)


def tool_kw_mutating(category: Dict[str, Any], *,
                     title: Optional[str] = None,
                     open_world: bool = False, **policy: Any) -> Dict[str, Any]:
    """Mutating, non-idempotent, non-destructive — the boring middle.

    Repeating the call may change state (append, increment, commit a
    duplicate). The client should ask the LLM before retrying.

    Use for: write_file(mode="append"), git_commit (creates a new sha
    each call), memory(action="add").
    """
    return _annotated(category, title=title,
                      read_only=False, destructive=False,
                      idempotent=False, open_world=open_world, **policy)


def tool_kw_openworld(category: Dict[str, Any], *,
                      title: Optional[str] = None,
                      read_only: bool = False,
                      idempotent: bool = False, **policy: Any) -> Dict[str, Any]:
    """Touches external services (network, third-party APIs).

    Use for: git_clone (HTTPS fetch), git_submit (REST API to GitHub/
    GitLab), execute_shell with a network_profile attached, rag_* tools.
    """
    return _annotated(category, title=title,
                      read_only=read_only, destructive=False,
                      idempotent=idempotent, open_world=True, **policy)


def tag_kw(category: Dict[str, Any]) -> Dict[str, Any]:
    """Lighter variant for ``@mcp.resource`` / ``@mcp.prompt`` — tags
    only (universally accepted across FastMCP versions)."""
    return {"tags": {category["name"]}}


# ── Unicode twin detection ────────────────────────────────────────────
# "projet-devinette/" vs "projét-devinette/" are two DISTINCT dirs on Linux
# but collapse into one on accent/case-insensitive filesystems (macOS,
# Windows) — and are near-indistinguishable to a human or an LLM reading a
# listing. Creation paths (write_file, mkdir, git init/clone) call this to
# attach a warning when a new path component has such a twin sibling.

def glob_match(rel: str, pattern: str) -> bool:
    """Glob d'un chemin RELATIF (POSIX) — sémantique des outils usuels
    (AUDIT 2026-09-25) :

    - motif SANS ``/`` : appliqué au NOM, à toute profondeur (``*.py``) ;
    - motif AVEC ``/`` : segment par segment ; ``*`` ne franchit pas ``/`` et
      ``**`` couvre zéro ou plusieurs dossiers (``**/*.py`` inclut
      ``main.py`` à la racine, ``src/**/*.ts`` inclut ``src/x.ts``).

    Avant, ``fnmatch`` sur le chemin entier exigeait au moins un ``/`` pour
    ``**/*.py`` : le modèle concluait que les fichiers n'existaient pas."""
    if not pattern:
        return True
    pat = pattern.strip()
    while pat.startswith("./"):
        pat = pat[2:]
    if "/" not in pat:
        return fnmatch.fnmatch(rel.rsplit("/", 1)[-1], pat) or fnmatch.fnmatch(rel, pat)
    psegs = [s for s in pat.strip("/").split("/") if s]
    rsegs = [s for s in rel.split("/") if s]
    memo: Dict[Tuple[int, int], bool] = {}

    def _m(i: int, j: int) -> bool:
        key = (i, j)
        if key in memo:
            return memo[key]
        if i == len(psegs):
            r = j == len(rsegs)
        elif psegs[i] == "**":
            r = any(_m(i + 1, k) for k in range(j, len(rsegs) + 1))
        else:
            r = (j < len(rsegs) and fnmatch.fnmatchcase(rsegs[j], psegs[i])
                 and _m(i + 1, j + 1))
        memo[key] = r
        return r
    return _m(0, 0)


def _fold_confusable(s: str) -> str:
    """Accent-insensitive + case-insensitive canonical form of a name."""
    import unicodedata
    decomposed = unicodedata.normalize("NFKD", s)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def unicode_twin_warning(target, root, max_scan: int = 500) -> Optional[str]:
    """Warn if creating ``target`` (under ``root``) introduces a sibling whose
    name differs ONLY by accents/case/unicode normalization.

    Only components of ``target`` that do NOT exist yet are checked — writing
    into an existing dir never warns (avoids repeating the warning on every
    subsequent write). Returns a human-readable warning string, or ``None``.
    Best-effort: any OS error → ``None`` (never blocks the operation).
    """
    from pathlib import Path
    try:
        rel = Path(target).resolve().relative_to(Path(root).resolve())
    except Exception:
        return None
    twins = []
    parent = Path(root)
    for comp in rel.parts:
        cur = parent / comp
        try:
            if not cur.exists() and parent.is_dir():
                folded = _fold_confusable(comp)
                for i, entry in enumerate(os.scandir(parent)):
                    if i >= max_scan:
                        break
                    if entry.name != comp and _fold_confusable(entry.name) == folded:
                        twins.append((entry.name, comp))
        except OSError:
            pass
        parent = cur
    if not twins:
        return None
    pairs = "; ".join(f"'{new}' ≈ existing '{old}'" for old, new in twins[:3])
    return (
        f"Probable unicode twin: {pairs} — the names differ only by accents "
        f"or case. On accent/case-insensitive filesystems they are the SAME "
        f"path. Double-check you are not creating a duplicate of the "
        f"existing file/folder."
    )
