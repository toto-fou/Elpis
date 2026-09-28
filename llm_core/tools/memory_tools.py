# SPDX-License-Identifier: MIT
# tools/memory_tools.py
"""
Long-term memory tools (Hermes-style) — ``memory`` + ``session_search``.

History note: this module used to also host the chat-scoped TODO list
(todo_plan / todo_add / todo_update / …) and its MCP resource + prompt.
That working-memory feature was removed entirely (2026-06-12) — UI,
REST routes (/api/memory/todos) and tools. Only the long-term curated
memory and the full-text session recall remain.

  • Category travels IN the protocol: every ``@mcp.tool`` is registered
    with ``tags={"memory"}`` and ``meta={"category": CATEGORY}``. The
    backend reads the category off the live ``list_tools()`` response.

  • Structured output. Tools return Pydantic models, so FastMCP emits a
    real ``outputSchema`` and structured content the client can rely on.

  • ``Context`` injection. Each tool takes ``ctx: Context`` — used for
    ``ctx.info()`` logging and as the source of the (user, chat)
    identity (read from the MCP request ``_meta``).

Storage layout
--------------
``{APP_SANDBOX_DIR}/{username}/memory/MEMORY.md`` (+ USER.md, scopes/) —
see ``llm_core.memory`` for the store implementation.

Ciblage v2 (« IDs + erreurs guidées ») : ``replace``/``remove`` prennent un
``target`` = id court ``[a1f4]`` affiché devant chaque entrée, ou un extrait
(matching normalisé). ``old_text`` reste accepté UN cycle comme alias déprécié
(des historiques en vol contiennent encore des appels ``old_text`` ; sans
l'alias, la validation Pydantic les rejetterait avec une erreur opaque) — à
retirer à la prochaine version.
"""
import json
import time
from pathlib import Path
from typing import Any, Literal, Optional, Union

from fastmcp import Context, FastMCP
from pydantic import BaseModel, Field

from ._toolkit import (
    tool_kw, as_enum,
    tool_kw_readonly, tool_kw_mutating,
)
from ._models import ErrEnvelope

# ── Category descriptor ──────────────────────────────────────────────
# Single source of truth for this module's category — display metadata
# only. Attached to every tool via tags + meta (see _TOOL_KW_* below),
# so the backend discovers the category → tools mapping straight from
# the protocol.
CATEGORY: dict[str, Any] = {
    "name":   "memory",
    "label":  "Mémoire",
    "icon":   "ph-brain",
    "color":  "amber",
    # hidden=True → la catégorie n'apparaît PAS dans le panneau d'outils (elle
    # n'« apparaît pas comme un MCP ») : la mémoire est gouvernée par un TOGGLE
    # dédié dans les Paramètres (réglage per-user ``memory_enabled``, défaut
    # OFF). Le gating réel se fait dans ``_chat_with_tools._collect_mcp_tools``
    # (drop explicite des tools memory/session_search sauf si le toggle est ON),
    # ce qui PRIME sur le « hidden ⇒ toujours actif » habituel.
    "hidden": True,
}

# Built by the shared toolkit — one place to change if a FastMCP
# version ever rejects meta= (see MIGRATION.md).
_TOOL_KW: dict[str, Any] = tool_kw(CATEGORY)
_TOOL_KW_RO  = tool_kw_readonly(CATEGORY)
_TOOL_KW_MUT = tool_kw_mutating(CATEGORY, serial=True)


# ── Pydantic I/O models (structured output) ──────────────────────────
MemoryAction = Literal["add", "replace", "remove", "rewrite"]
MemoryStore  = Literal["memory", "user"]


class MemoryResult(BaseModel):
    """Résultat de l'outil ``memory``. En échec soft (ok=false), reprend la
    convention ``ErrEnvelope`` : ``error`` = code machine stable, ``message`` =
    phrase FR, ``fix`` = geste correctif — un seul pattern d'échec à apprendre
    au modèle. ``entries`` est le miroir compact de l'état : une ligne
    ``[id] (Nc) extrait`` par entrée (l'id est la cible sûre de replace/remove)."""
    ok:        bool = True
    action:    Optional[str] = None
    store:     Optional[str] = None
    error:     Optional[str] = None      # code machine (no_match, over_limit, …)
    message:   Optional[str] = None      # phrase FR lisible
    fix:       Optional[str] = None      # geste correctif FR actionnable
    closest:   Optional[str] = None      # "[id] (Nc) extrait" du meilleur candidat
    chars:     int = 0
    limit:     int = 0
    usage_pct: float = 0.0
    n_entries: int = 0
    entries:   list[str] = Field(default_factory=list)


class MemorySaved(BaseModel):
    """Succès de l'outil ``memory`` — retour COURT (2026-09-19, façon hermes).

    Plus aucune liste d'entrées : les autres entrées gardent leur id (calculé
    sur leur texte) et restent lisibles dans le bloc système ; seule l'entrée
    écrite change d'id, et on le donne. Renvoyer tout le magasin à chaque
    écriture coûtait des jetons et poussait le modèle à « trouver autre chose
    à corriger ». ``op`` identifie l'écriture dans le journal : l'interface y
    lit le détail (avant/après) et peut l'annuler — le modèle n'en paie pas le
    texte."""
    ok:     Literal[True] = True
    action: str
    store:  str
    id:     str = ""            # [xxxx] de l'entrée écrite (add/replace), sinon ""
    op:     str = ""            # identifiant de journal ("" si rien n'a changé)
    usage:  str = ""            # "63% · 1386/2200 chars · 7 entries"
    note:   str = ""            # consigne de fin : ne pas répéter


# ── Mise en forme état → LLM (économie de tokens) ─────────────────────
# Le store renvoie les textes COMPLETS ; à la frontière outil→LLM on compacte
# chaque entrée en "[id] (Nc) première ligne tronquée" : l'id suffit pour
# cibler, la taille sert aux décisions de budget, le texte complet reste
# visible dans le bloc système.
_ENTRY_EXCERPT_CHARS = 60


def _opt_str(v: Any) -> Optional[str]:
    """Param optionnel → str ou None. Un appel DIRECT de la closure (tests,
    FakeMCP) ne résout pas les défauts ``Field(...)`` : on reçoit alors le
    ``FieldInfo`` lui-même — à traiter comme « non fourni »."""
    from pydantic.fields import FieldInfo
    if v is None or isinstance(v, FieldInfo):
        return None
    return str(v)


def _fmt_entry(eid: str, text: str, max_chars: int = _ENTRY_EXCERPT_CHARS) -> str:
    full = str(text or "").strip()
    first = full.splitlines()[0] if full else ""
    if len(first) > max_chars:
        first = first[:max_chars].rstrip() + "…"
    elif "\n" in full:
        first += " …"
    return f"[{eid}] ({len(full)}c) {first}"


def _fmt_entries(res) -> list[str]:
    return [_fmt_entry(eid, txt) for eid, txt in zip(res.entry_ids, res.entries)]


def _fmt_index(res, i: Optional[int]) -> Optional[str]:
    if i is None or not (0 <= i < len(res.entries)):
        return None
    return _fmt_entry(res.entry_ids[i], res.entries[i])


def _fix_for(res) -> Optional[str]:
    """Geste correctif FR selon le code d'échec du store."""
    code = getattr(res, "error_code", None)
    if not code:
        return None
    if code == "no_match":
        c = _fmt_index(res, res.closest_index)
        base = "Reuse the exact bracketed id from entries."
        return f"{base} Likely candidate: {c}" if c else base
    if code == "ambiguous":
        cands = " ; ".join(filter(None, (_fmt_index(res, i) for i in res.candidate_indexes)))
        return f"Several entries match — narrow down with ONE id: {cands}"
    if code == "over_limit":
        return (f"Budget full ({res.chars}/{res.limit}c). Consolidate: remove/replace an "
                f"entry, or action=rewrite to rewrite the whole store shorter.")
    if code == "empty_content":
        return ("Pass the text in content (for rewrite: entries separated "
                "by a --- line).")
    return None


def _saved_result(act: str, store: str, res, content: Optional[str],
                  op: Optional[str]) -> MemorySaved:
    """Succès → retour court : id de l'entrée écrite, remplissage, consigne."""
    eid = ""
    if act in ("add", "replace"):
        from llm_core.memory import sanitize_entry_text
        txt = sanitize_entry_text((content or "").strip())
        if txt in res.entries:
            eid = res.entry_ids[res.entries.index(txt)]
    usage = (f"{res.usage_pct}% · {res.chars}/{res.limit} chars · "
             f"{res.n_entries} entr{'y' if res.n_entries == 1 else 'ies'}")
    if res.unchanged:
        note = f"Already stored as [{eid}] (identical text): nothing written."
    elif act == "add":
        note = "Saved. Done — do not repeat this call."
    elif act == "replace":
        note = "Updated. Done — do not repeat this call."
    elif act == "remove":
        note = "Removed. Done — do not repeat this call."
    else:
        note = (f"Store rewritten ({res.n_entries} entries, new ids next turn). "
                "Done — do not repeat this call.")
    return MemorySaved(action=act, store=store, id=eid, op=op or "",
                       usage=usage, note=note)


class SessionMatch(BaseModel):
    """Un passage retrouvé (2026-09-19 : EXTRAIT autour des mots trouvés, plus
    le message entier — une recherche courante renvoyait ~14 000 caractères)."""
    ref:     int = 0        # à repasser dans ``ref`` pour lire le passage entier
    date:    str = ""       # AAAA-MM-JJ
    chat:    str = ""       # titre du chat ("" hors chat)
    role:    str = ""       # user | assistant | tool | tool_call
    excerpt: str = ""       # ~32 jetons, mots trouvés entre « » (ou texte entier)


class SessionSearchResult(BaseModel):
    ok:      bool = True
    query:   str = ""
    matches: list[SessionMatch] = Field(default_factory=list)
    count:   int = 0
    error:   Optional[str] = None


def _iso_day(ts: Any) -> str:
    try:
        return time.strftime("%Y-%m-%d", time.localtime(float(ts)))
    except Exception:
        return ""


# ── Identity resolution ──────────────────────────────────────────────
def _safe_username(username: Optional[str]) -> str:
    return "".join(c for c in (username or "") if c.isalnum() or c in "-_") or "guest"


def _safe_chat_id(chat_id: Optional[str]) -> str:
    """Sanitize ``chat_id``. Kept aligned with the historical behaviour
    (hex chat ids pass through unchanged; stripped ids get a short
    deterministic hash suffix)."""
    if not chat_id:
        return "default"
    raw = str(chat_id)
    out = "".join(c for c in raw if c.isalnum() or c in "-_")
    if not out:
        return "default"
    if out == raw:
        return out
    import hashlib as _hashlib
    digest = _hashlib.sha1(raw.encode("utf-8", errors="replace")).hexdigest()[:8]
    return f"{out}_{digest}"


def _identity(ctx: Optional[Context]) -> tuple[str, str]:
    """Resolve the (username, chat_id) this call is scoped to.

    (passe 8, B1 — 2026-09-02) Délègue à ``_toolkit.get_username`` /
    ``get_chat_id`` : identité du JETON Bearer d'abord (client externe lié à
    un compte), puis ``meta`` (client de confiance : l'app), puis ``guest``.
    L'ancienne implémentation parallèle ne lisait QUE le ``meta`` : un client
    externe authentifié comme ``alice`` pouvait lire/écrire la mémoire et
    l'historique (``session_search``) de n'importe quel compte en déclarant
    ``_meta.username`` — précisément le contournement que la phase 1 ferme.
    """
    try:
        from llm_core.tools._toolkit import get_username, get_chat_id
        return _safe_username(get_username(ctx)), _safe_chat_id(get_chat_id(ctx))
    except Exception:
        return _safe_username(None), _safe_chat_id(None)


# (2026-09-11, P2 — A4) ``memory_scope`` était lu dans le ``meta`` et jamais
# posé par aucun appelant : code mort retiré. La portée est celle du compte.
_MEMORY_SCOPE = "user"


def _memory_limits() -> tuple[int, int]:
    """(memory_limit, user_limit) depuis la config (hot-reload), avec fallback."""
    try:
        from shared_infra import config as _cfg
        try:
            _cfg.reload_memory_config_from_disk()
        except Exception:
            pass
        return (int(getattr(_cfg, "MEMORY_MD_CHAR_LIMIT", 2200)),
                int(getattr(_cfg, "USER_MD_CHAR_LIMIT", 1375)))
    except Exception:
        return (2200, 1375)


# ── Registration ─────────────────────────────────────────────────────
def register(mcp: FastMCP, root_base: Path) -> None:
    """Register the long-term memory tools.

    Signature mirrors ``fs_tools.register(mcp, root_base)``. ``mcp`` is
    the raw FastMCP instance (category travels via tags/meta).
    """
    root_base = Path(root_base).resolve()

    # ── memory ─ long-term, agent-curated Markdown memory ────────────
    @mcp.tool(**_TOOL_KW_MUT)
    async def memory(
        ctx: Context,
        action: MemoryAction = Field(
            description="add | replace | remove | rewrite."),
        # OBLIGATOIRE (2026-09-21) : facultatif avec défaut, la grammaire
        # llama.cpp le rangeait APRÈS les autres facultatifs — un modèle qui
        # écrivait ``content`` d'abord ne pouvait plus le poser, et un fait de
        # profil partait en silence dans MEMORY.md. Même règle que todowrite.
        store: MemoryStore = Field(
            description="'memory' = project/environment notes (MEMORY.md); "
                        "'user' = the user's durable profile (USER.md)."),
        content: Optional[str] = Field(
            default=None,
            description="Entry text (add/replace). For rewrite: the ENTIRE "
                        "new store content, entries separated by a --- "
                        "line."),
        target: Optional[str] = Field(
            default=None,
            description="Target for replace/remove: the id shown in brackets "
                        "(e.g. [a1f4]) — the safe form — or an exact excerpt "
                        "of ONE entry."),
        old_text: Optional[str] = Field(
            default=None,
            description="Deprecated alias of target."),
        title: Optional[str] = Field(
            default=None,
            description="Short first-person sentence IN THE USER'S LANGUAGE "
                        "(French by default), shown to the user while writing "
                        "(e.g. « Je retiens que tu préfères des réponses "
                        "concises »). Purely visual: does not affect what is "
                        "memorized."),
    ) -> Union[MemorySaved, MemoryResult, ErrEnvelope]:
        """Curate your long-term memory (persists across sessions).

Two stores: 'memory' (MEMORY.md — environment facts, project conventions,
techniques learned, work done) and 'user' (USER.md — who the user is: role,
preferences, durable habits).

Actions:
  • add     — append an entry (`content`). Idempotent for identical text.
  • replace — replace the entry targeted by `target` with `content`.
  • remove  — delete the entry targeted by `target`.
  • rewrite — replace the WHOLE store with `content` (entries separated by a
              --- line): one-call consolidation when the budget is full.

`target` = the [a1f4] id shown before each entry (in the memory block and in
result `entries`) — the safe form — or an exact excerpt of ONE entry
(case/whitespace tolerant).

Each store has a character LIMIT: exceeding it → ok=false with usage stats;
consolidate, then retry. On failure read `error` (code), `message` and `fix`
(the corrective move); `entries` lists the current ids and `closest` suggests
the likely target — never resend the same call unchanged. On success the
result is short: `id` of the entry written (use it to target that entry later
in this turn; other entries keep their ids) and `usage`. A success is final:
do not repeat it."""
        username, _chat = _identity(ctx)
        scope = _MEMORY_SCOPE
        mem_limit, user_limit = _memory_limits()
        title = _opt_str(title)
        content = _opt_str(content)
        target = _opt_str(target)
        old_text = _opt_str(old_text)
        store = as_enum(store, {"memory", "user"}, "memory")
        # HARD failures (store unavailable, missing input, verrou occupé) →
        # ErrEnvelope, like every other tool. The SOFT, documented failure
        # (over_limit / no_match / ambiguous / empty_content) intentionally
        # stays a MemoryResult(ok=False) because it carries the usage stats +
        # entries the model needs to self-correct.
        try:
            from llm_core.memory import store_for
            from llm_core.memory._migrate import migrate_legacy_memory
            # Ensure the host-owned ``{root}/{user}/memory`` dir exists (and
            # migrate any legacy ``.memory`` content once) BEFORE the store
            # tries to take its file lock — the old ``.memory`` was owned by the
            # container UID 10001 and the host MCP could not create the lock.
            mem_dir = migrate_legacy_memory(root_base, username)
            md = store_for(store, username, scope, root_base,
                           memory_limit=mem_limit, user_limit=user_limit)
        except Exception as e:
            return ErrEnvelope(error="memory_store_unavailable",
                               message=f"memory store unavailable: {e}",
                               retryable=True)

        act = as_enum(action, {"add", "replace", "remove", "rewrite"}, None)
        if act is None:
            # Plus de retombée silencieuse sur "add" : une action inventée
            # ajoutait une entrée parasite au lieu de signaler l'erreur.
            return ErrEnvelope(error="bad_action",
                               message=f"unknown action: {action!r}",
                               fix="Use add, replace, remove or rewrite.")
        tgt = (target or old_text or "").strip()
        if act in ("replace", "remove") and not tgt:
            return ErrEnvelope(error="target_required",
                               message=f"{act} requires target",
                               fix="Pass target = the [xxxx] id shown before "
                                   "the entry, or an exact excerpt.")
        if act == "rewrite" and not (content or "").strip():
            return ErrEnvelope(error="content_required",
                               message="rewrite requires content",
                               fix="Pass the ENTIRE new store content in "
                                   "content, entries separated by a --- line.")

        # The store op (disk write) + audit append are blocking I/O — run them
        # off the event loop so the MCP server stays responsive.
        def _apply_and_audit():
            if act == "add":
                _res = md.add(content or "")
            elif act == "replace":
                _res = md.replace(tgt, content or "")
            elif act == "remove":
                _res = md.remove(tgt)
            else:  # rewrite
                _res = md.rewrite(content or "")
            # Append-only JSONL audit (monitoring /api/memory/audit). Best-effort.
            try:
                audit_path = mem_dir / ".audit.jsonl"
                audit_path.parent.mkdir(parents=True, exist_ok=True)
                line = json.dumps({
                    "ts": time.time(), "action": act, "store": store, "scope": scope,
                    "ok": bool(_res.ok), "error": _res.error,
                    "error_code": _res.error_code, "chars": _res.chars,
                    "limit": _res.limit, "usage_pct": _res.usage_pct,
                    "n_entries": _res.n_entries,
                }, ensure_ascii=False)
                with open(audit_path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except Exception:
                pass
            # Journal des écritures EFFECTIVES (2026-09-19) : détail et
            # annulation depuis le fil du chat, origine des notes dans les
            # Réglages. Best-effort : un journal en panne ne fait jamais
            # échouer une écriture réussie.
            _op = None
            if _res.ok and not _res.unchanged:
                try:
                    from llm_core.memory import _journal
                    _op = _journal.append(
                        mem_dir, action=act, store=store,
                        before=_res.before, after=_res.entries,
                        source="tool",
                        chat_id=(_chat if _chat and _chat != "default" else None),
                        title=title)
                except Exception:
                    _op = None
            return _res, _op

        import asyncio as _aio
        from llm_core.memory import StoreBusyError
        try:
            res, op = await _aio.to_thread(_apply_and_audit)
        except StoreBusyError as e:
            return ErrEnvelope(error="store_busy",
                               message=f"memory temporarily locked: {e}",
                               retryable=True, fix="Retry in a moment.")

        if res.ok:
            await ctx.info(f"memory {act} on {store} for {username} "
                           f"({res.usage_pct}% · {res.chars}/{res.limit})")
            return _saved_result(act, store, res, content, op)

        out = MemoryResult(
            ok=res.ok, action=res.action, store=store,
            error=(res.error_code if not res.ok else None),
            message=(res.error if not res.ok else None),
            fix=(_fix_for(res) if not res.ok else None),
            closest=(_fmt_index(res, res.closest_index) if not res.ok else None),
            chars=res.chars, limit=res.limit, usage_pct=res.usage_pct,
            n_entries=res.n_entries, entries=_fmt_entries(res),
        )
        return out

    # ── session_search ─ full-text recall of past messages ───────────
    @mcp.tool(**_TOOL_KW_RO)
    async def session_search(
        ctx: Context,
        query: str = Field(default="", description="Keywords to search for in past sessions."),
        limit: int = Field(default=5, description="Max number of results (1-20)."),
        ref: Optional[int] = Field(
            default=None,
            description="Read ONE passage in full: the `ref` of a previous result "
                        "(then `query` is ignored)."),
    ) -> Union[SessionSearchResult, ErrEnvelope]:
        """Full-text search over your past sessions (messages and old tool outputs).

Two steps: (1) `query` → short excerpts around the matched words (marked « »),
each with its date, chat title, role and a `ref`; (2) `ref` → the full text of
that one passage. Use it to recover an old exchange missing from your curated
memory, or a tool output that was cleared from the context. Refine the
keywords rather than raising `limit`. Useless for content already in front of
you."""
        username, _chat = _identity(ctx)
        q = _opt_str(query) or ""
        q = q.strip()
        _ref = ref if isinstance(ref, int) and not isinstance(ref, bool) else None
        if _ref is not None:
            try:
                from shared_infra.accounts.users import get_user
                from shared_infra.memory.store import session_message_by_ref
                row = get_user(username)
                import asyncio as _aio
                hit = (await _aio.to_thread(session_message_by_ref, int(row["id"]), _ref)
                       if row else None)
            except Exception as e:
                return ErrEnvelope(error="search_failed",
                                   message=f"search failed: {e}", retryable=True)
            if not hit:
                return ErrEnvelope(error="unknown_ref", message=f"no passage with ref {_ref}",
                                   fix="Use a ref returned by a previous session_search.")
            txt = hit["content"] + (" … [truncated]" if hit.get("truncated") else "")
            m = SessionMatch(ref=hit["ref"], date=_iso_day(hit.get("ts")),
                             chat=hit.get("title", "") or "", role=hit.get("role", ""),
                             excerpt=txt)
            return SessionSearchResult(ok=True, query="", matches=[m], count=1)
        if not q:
            return ErrEnvelope(error="empty_query", message="query is empty",
                               fix="Pass keywords to search for.")
        try:
            from shared_infra.accounts.users import get_user
            from shared_infra.memory.store import session_search_snippets
            row = get_user(username)
            if not row:
                return SessionSearchResult(ok=True, query=q, matches=[], count=0)
            # Appel direct de la closure (tests) : ``limit`` peut arriver en
            # FieldInfo — même garde que ``_opt_str``.
            lim = limit if isinstance(limit, int) and not isinstance(limit, bool) else 5
            lim = max(1, min(20, lim))
            # FTS query = blocking sqlite → off the event loop.
            import asyncio as _aio
            rows = await _aio.to_thread(session_search_snippets, int(row["id"]), q, limit=lim)
        except Exception as e:
            return ErrEnvelope(error="search_failed",
                               message=f"search failed: {e}", retryable=True)
        matches = [SessionMatch(ref=int(r.get("ref") or 0), date=_iso_day(r.get("ts")),
                                chat=r.get("title", "") or "",
                                role=r.get("role", ""), excerpt=r.get("snippet", ""))
                   for r in rows]
        return SessionSearchResult(ok=True, query=q, matches=matches, count=len(matches))
