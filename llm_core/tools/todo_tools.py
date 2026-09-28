# SPDX-License-Identifier: MIT
"""
tools/todo_tools.py — liste de tâches de session (modèle OpenCode `todowrite`).

UN seul outil, sémantique *replace-all* : le modèle renvoie la liste COMPLÈTE à
chaque appel (pas d'id, la position dans le tableau EST l'ordre). Il n'y a pas
de `todoread` : la liste vit dans le contexte du modèle (il vient de l'écrire,
et le rappel ``<todo_status>`` la redonne en début de tour) et dans l'UI (event
`todo_updated` émis par la boucle + seed depuis `chats.meta_json["todos"]` au
chargement du chat).

Persistance : `chats.meta_json["todos"]` (canal per-chat existant, zéro
migration). Sans chat_id résolu (tests, runs hors chat), l'outil reste
fonctionnel mais éphémère (`persisted:false`).

Schéma (2026-09-19) — ALIGNÉ sur la pratique dominante (opencode, Codex
``update_plan``, Gemini ``write_todos``) : chaque tâche = ``content`` +
``status``, **tous deux obligatoires**, ``status`` en liste fermée, clés en plus
interdites. Pourquoi : llama.cpp contraint l'appel par une grammaire dérivée du
schéma qui impose les champs obligatoires d'abord puis les FACULTATIFS dans
l'ordre déclaré. Avec ``status``/``priority`` facultatifs, qwen qui écrivait
``priority`` en premier ne pouvait plus poser ``status`` : statut omis (le
défaut ``pending`` remettait à faire des tâches terminées, sans rien dire) ou
glissé dans la chaîne de ``priority`` (``"high\\", \\"status\\": \\"completed"``).
Relevé réel : 19 appels sur 59 sans statut, 3 cassés. ``priority`` quitte
l'entrée du modèle (Codex et Gemini n'en ont pas) ; les listes stockées la
gardent pour l'affichage.

Le schéma est STRICT (grammaire) mais la validation reste SOUPLE (connecteurs
sans grammaire, historiques) : clé en plus ignorée, statut manquant ou inconnu
→ HÉRITÉ de la tâche de même libellé dans la liste précédente (jamais une
régression silencieuse), et signalé dans le résultat.

Résultat COURT : liste canonique numérotée (``1. [completed] …``, la forme que
le modèle recopie) + compteurs + remarques. La liste structurée (``todos``)
alimente l'event UI puis est RETIRÉE du résultat vu par le modèle
(``engine/tool_exec.py``).
"""
from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastmcp import Context
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ._todo_format import counts, current_task, render_checklist
from ._toolkit import get_chat_id, get_username, tool_kw_mutating, with_policy

logger = logging.getLogger("uvicorn.error")

CATEGORY: dict[str, Any] = {
    "name":  "task",
    "label": "Tâches",
    "icon":  "ph-list-checks",
    "color": "emerald",
    # Modèle OpenCode : la todo-list n'est PAS un toggle utilisateur — elle est
    # disponible d'office dès que des outils MCP le sont. ``hidden`` retire la
    # catégorie du panneau (GET /api/mcp/categories) ET la fait passer d'office
    # dans _collect_mcp_tools (allowed_set = filter_categories | hidden).
    "hidden": True,
}

_TOOL_KW_MUT = tool_kw_mutating(CATEGORY, deny_for=["subagent"])

VALID_STATUS = ("pending", "in_progress", "completed", "cancelled")
VALID_PRIORITY = ("high", "medium", "low")
MAX_TODOS = 50
MAX_CONTENT_CHARS = 300

# Synonymes tolérés À LA VALIDATION (connecteurs sans grammaire).
_STATUS_SYNONYMS = {
    "todo": "pending", "open": "pending", "not_started": "pending",
    "inprogress": "in_progress", "doing": "in_progress", "active": "in_progress",
    "started": "in_progress", "current": "in_progress", "wip": "in_progress",
    "done": "completed", "complete": "completed", "finished": "completed",
    "canceled": "cancelled", "skipped": "cancelled", "abandoned": "cancelled",
}


def _strict_item_schema(schema: Dict[str, Any]) -> None:
    """Schéma vu par le modèle (et la grammaire llama.cpp) : content + status
    obligatoires, status énuméré, aucune clé en plus. La validation Pydantic,
    elle, reste souple (``status`` a un défaut vide, les extras sont ignorés)."""
    props = schema.setdefault("properties", {})
    # Propriété REMPLACÉE en entier : la validation accepte ``null`` (hérité),
    # ce que pydantic exprime par un ``anyOf`` string|null — la grammaire ne
    # doit voir qu'une chaîne énumérée.
    props["status"] = {
        "type": "string",
        "enum": list(VALID_STATUS),
        "description": "pending | in_progress | completed | cancelled",
    }
    schema["required"] = ["content", "status"]
    schema["additionalProperties"] = False


class TodoItem(BaseModel):
    model_config = ConfigDict(extra="ignore", json_schema_extra=_strict_item_schema)

    content: str = Field(
        description="The task, short and actionable (a few words). Copy it "
                    "verbatim from the previous list when it has not changed.")
    status: Optional[str] = Field(
        default="",
        description="pending | in_progress | completed | cancelled")

    @model_validator(mode="before")
    @classmethod
    def _plain_string(cls, data: Any) -> Any:
        # Tolérance : une tâche donnée comme simple chaîne.
        if isinstance(data, str):
            return {"content": data}
        return data


class TodoWriteResult(BaseModel):
    ok: Literal[True] = True
    done: int = Field(description="Completed todos")
    total: int = Field(description="Total number of todos")
    remaining: int = Field(description="Todos still pending or in progress")
    in_progress: str = Field(default="", description="The task in progress, if any")
    completed_now: List[str] = Field(default_factory=list,
                                     description="Tasks completed by THIS call")
    checklist: str = Field(description="The list as stored — copy items verbatim next time")
    notes: List[str] = Field(default_factory=list, description="Warnings and hints")
    persisted: bool = Field(description="True if saved to the chat (survives reload)")
    # Pour l'event UI ``todo_updated`` ; retiré du résultat vu par le modèle.
    todos: List[Dict[str, str]] = Field(default_factory=list)


def _norm_text(s: Any) -> str:
    t = unicodedata.normalize("NFC", str(s or "")).casefold()
    t = re.sub(r"\s+", " ", t).strip()
    return t.rstrip(" .;:")


def _similar(a: Any, b: Any) -> bool:
    """Deux libellés décrivent-ils la même tâche (reformulation légère) ?"""
    import difflib
    x, y = _norm_text(a), _norm_text(b)
    if not x or not y:
        return False
    return difflib.SequenceMatcher(None, x, y).ratio() >= 0.6


def _norm_status(s: Any) -> Optional[str]:
    """Statut canonique, ou None si absent / inconnu."""
    t = str(s or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not t:
        return None
    if t in VALID_STATUS:
        return t
    return _STATUS_SYNONYMS.get(t.replace("_", "")) or _STATUS_SYNONYMS.get(t)


def _normalize(items: List[Any],
               prev: Optional[List[Dict[str, Any]]] = None
               ) -> Tuple[List[Dict[str, str]], List[str]]:
    """Normalise la liste du modèle. Renvoie ``(todos, notes)``.

    - tâche vide → ignorée ; contenu capé ; 50 tâches max ;
    - statut absent ou inconnu → HÉRITÉ de la tâche de même libellé dans
      ``prev`` ; à défaut, de la tâche de MÊME POSITION si les deux listes ont
      la même longueur ET que les libellés se ressemblent (reformulation) ;
      sinon ``pending``. Signalé dans ``notes``. La ressemblance est exigée :
      un NOUVEAU plan de même longueur envoyé sans statuts héritait sinon de
      « completed » tâche par tâche (liste soldée à tort, plus de rappel) ;
    - priorité : reprise de la liste précédente (affichage), sinon celle
      fournie si valide (historiques), sinon ``medium``.
    """
    prev = [p for p in (prev or []) if isinstance(p, dict)]
    by_text = {_norm_text(p.get("content")): p for p in prev}
    raw: List[Dict[str, Any]] = []
    for it in (items or [])[:MAX_TODOS]:
        if isinstance(it, str):
            it = {"content": it}
        if not isinstance(it, dict):
            continue
        content = str(it.get("content") or "").strip()
        if not content:
            continue
        raw.append({**it, "content": content[:MAX_CONTENT_CHARS]})

    same_len = bool(prev) and len(prev) == len(raw)
    out: List[Dict[str, str]] = []
    notes: List[str] = []
    for i, it in enumerate(raw):
        content = it["content"]
        match = by_text.get(_norm_text(content))
        if match is None and same_len and _similar(content, prev[i].get("content")):
            match = prev[i]
        status = _norm_status(it.get("status"))
        if status is None:
            inherited = _norm_status((match or {}).get("status")) or "pending"
            given = str(it.get("status") or "").strip()
            why = f"unknown status {given!r}" if given else "no status"
            notes.append(f"Item {i + 1}: {why} — kept [{inherited}]. "
                         "Always send the status of every item.")
            status = inherited
        prio = str((match or {}).get("priority") or it.get("priority") or "").strip().lower()
        if prio not in VALID_PRIORITY:
            prio = "medium"
        out.append({"content": content, "status": status, "priority": prio})
    return out, notes


def _coerce(items: List[Any]) -> List[Dict[str, str]]:
    """Compat : normalisation sans liste précédente."""
    return _normalize(items, None)[0]


def _signature(todos: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    return [(_norm_text(t.get("content")), str(t.get("status") or ""))
            for t in todos if isinstance(t, dict)]


def _user_id(username: str) -> Optional[int]:
    try:
        from shared_infra.accounts.users import get_user
        row = get_user(username)
        return int(row["id"]) if row is not None else None
    except Exception:
        return None


def _load_prev(uid: Optional[int], chat_id: str) -> List[Dict[str, Any]]:
    if uid is None or not chat_id or chat_id == "default":
        return []
    try:
        from shared_infra.chat.store import get_chat_todos
        return get_chat_todos(uid, chat_id)
    except Exception:
        return []


def _persist(uid: Optional[int], chat_id: str, todos: List[Dict[str, str]]) -> bool:
    """Écrit la liste dans chats.meta_json["todos"]. Best-effort."""
    if uid is None or not chat_id or chat_id == "default":
        return False
    try:
        from shared_infra.chat.store import set_chat_todos
        return set_chat_todos(uid, chat_id, todos)
    except Exception as e:
        logger.debug("[todowrite] persistence skipped: %s", e)
        return False


def build_result(items: List[Any], prev: List[Dict[str, Any]],
                 persisted_fn=None) -> TodoWriteResult:
    """Cœur testable : normalise, compare à ``prev``, persiste, résume."""
    todos, notes = _normalize(items, prev)
    persisted = bool(persisted_fn(todos)) if persisted_fn else False
    c = counts(todos)
    prev_done = {_norm_text(p.get("content")) for p in prev
                 if isinstance(p, dict) and p.get("status") == "completed"}
    completed_now = [t["content"] for t in todos
                     if t["status"] == "completed" and _norm_text(t["content"]) not in prev_done]
    if prev and _signature(todos) == _signature(prev):
        cur = current_task(todos)
        notes.append("List unchanged: nothing to update. "
                     + (f"Continue with the task in progress: {cur}." if cur
                        else "Call todowrite again only when a task changes status."))
    n_prog = sum(1 for t in todos if t["status"] == "in_progress")
    if n_prog > 1:
        notes.append(f"{n_prog} tasks are in_progress: keep exactly ONE in progress.")
    if todos and c["open"] == 0:
        notes.append("All tasks are closed.")
    return TodoWriteResult(
        done=c["done"], total=c["total"], remaining=c["open"],
        in_progress=current_task(todos) or "",
        completed_now=completed_now,
        checklist=render_checklist(todos),
        notes=notes, persisted=persisted, todos=todos,
    )


def register(mcp) -> None:
    """Enregistre l'outil ``todowrite`` sur le serveur MCP local."""

    # AUDIT 2026-09-26 — ``serial`` : lecture de la liste précédente et
    # écriture partent dans des threads distincts ; deux ``todowrite`` d'un
    # même message, exécutés en parallèle, lisaient la même liste et la
    # dernière écriture gagnait au hasard (liste A plus ancienne conservée).
    @mcp.tool(**with_policy(_TOOL_KW_MUT, serial=True, replay_safe=True))
    async def todowrite(
        todos: List[TodoItem],
        # ``ctx: Context`` TYPÉ — FastMCP n'injecte le Context (et donc le
        # meta out-of-band username/chat_id) QUE sur annotation exacte ;
        # ``ctx=None`` non typé = paramètre ordinaire jamais rempli →
        # identité perdue → persisted:false sur tous les appels réels
        # (bug trouvé au live E2E 2026-07-12).
        ctx: Context,
    ) -> TodoWriteResult:
        """Create and maintain the task list for the current session. Replaces the WHOLE list on every call: send every item, each with its `content` AND its `status`.

        When to use — proactively when:
        - the task needs 3+ distinct steps, or the user gives multiple tasks;
        - new instructions arrive mid-task (capture them as todos);
        - you start a step → mark it `in_progress` (exactly ONE at a time);
        - you finish a step → mark it `completed` IMMEDIATELY (never batch
          completions), and add any follow-up discovered along the way.

        When NOT to use: single straightforward task, purely informational
        request, <3 trivial steps. When in doubt, use it.

        Rules:
        - status: pending | in_progress | completed | cancelled — required on
          EVERY item, including the ones that did not change.
        - `completed` only when the work is actually done and verified — never
          on intent. If blocked, keep it `in_progress` and add a todo
          describing the blocker.
        - Items are short (a few words), specific and actionable. Copy
          unchanged items verbatim from the latest `checklist` (or the
          <todo_status> block); keep user-provided commands verbatim.
        - Do not resend an unchanged list.

        Args:
            todos: the COMPLETE updated list (max 50 items).

        Returns: {done, total, remaining, in_progress, completed_now, checklist, notes}.
        """
        items = [
            t.model_dump() if hasattr(t, "model_dump") else t
            for t in (todos or [])
        ]
        username = get_username(ctx, "")
        chat_id = get_chat_id(ctx, "")
        # AUDIT 2026-09-25 — trois accès SQLite (compte, lecture, écriture sous
        # ``BEGIN IMMEDIATE``, busy_timeout 10 s) faits en SYNCHRONE dans cet
        # outil ``async`` : sous contention d'écriture, la boucle de l'hôte
        # d'outils — partagée par tous les utilisateurs — gelait jusqu'à 10 s
        # (et le terminal en direct avec elle). Même geste que ``memory``.
        import asyncio as _asyncio
        uid = await _asyncio.to_thread(_user_id, username) if username else None
        prev = await _asyncio.to_thread(_load_prev, uid, chat_id)
        return await _asyncio.to_thread(
            build_result, items, prev,
            persisted_fn=lambda lst: _persist(uid, chat_id, lst))
