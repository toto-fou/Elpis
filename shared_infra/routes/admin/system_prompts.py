# SPDX-License-Identifier: MIT
"""
Admin: system prompt management.

Surface for admin users to inspect and edit the per-category system
prompt files in ``system_prompts/``. Mirrors what the assembler in
``backend.services._system_prompts`` reads at runtime.

Endpoints (all under ``admin_router`` — auth-gated to admin role):

  GET    /api/admin/system-prompts                    — list categories + sizes
  GET    /api/admin/system-prompts/{category}         — read one file's content
  PUT    /api/admin/system-prompts/{category}         — overwrite one file
  GET    /api/admin/system-prompts/_template          — read the _TEMPLATE.md
  GET    /api/admin/system-prompts/_preview?categories=... — assembled preview

Security
--------
- ``category`` is constrained to ``[A-Za-z0-9_-]+`` and looked up against
  the actual ``system_prompts/`` directory listing — no path traversal possible.
- Underscore-prefixed names (``_TEMPLATE``) are read-only via the
  ``/_template`` route; the regular GET/PUT routes refuse them.
- Edits invalidate the assembler's cache (mtime-based, automatic) so
  changes take effect on the very next chat request.
"""
from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

from fastapi import HTTPException, Request

# Reuse the assembler's directory + helper functions so we always agree
# on what counts as a "category file".
from llm_core._system_prompts import (
    _SYSTEM_P_DIR,
    assemble_system_messages,
    list_known_categories,
    preview as assemble_preview,
)
from shared_infra.routes._legacy import _require_admin
from shared_infra.routes.admin._state import admin_router

# Strict regex on category names — matches the file naming convention
# (lowercase letters, digits, hyphens, underscores). Keeps ``..`` and
# slashes out of the path.
_CATEGORY_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

# Server-side ceiling on .md file size to prevent runaway payloads
# from blowing up the LLM context window. 50 KB ≈ ~12.5k tokens —
# already absurd for a tool protocol; legit files target 1-2 KB.
_MAX_FILE_BYTES = 50_000


def _resolve_category_path(category: str, *, allow_template: bool = False) -> Path:
    """Validate the category name and return the absolute file path.

    Raises ``HTTPException`` on any path-traversal attempt or on
    non-existent files (when not creating a new one). The
    ``allow_template`` flag toggles access to the underscore-prefixed
    files (``_TEMPLATE.md`` etc.); regular GET/PUT routes pass False.
    """
    if not category or not _CATEGORY_RE.match(category):
        raise HTTPException(400, "invalid category name")
    if category.startswith("_") and not allow_template:
        raise HTTPException(404, "reserved name")

    if not _SYSTEM_P_DIR.is_dir():
        raise HTTPException(500, f"SYSTEM_P directory missing: {_SYSTEM_P_DIR}")

    # Resolve and verify the file still lives under system_prompts/. Even
    # though the regex above forbids slashes, double-check after
    # resolve() to be defensive against future regex drift.
    p = (_SYSTEM_P_DIR / f"{category}.md").resolve()
    # Containment robuste via relative_to (PAS startswith → préfixe frère).
    try:
        p.relative_to(_SYSTEM_P_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "path escapes system_prompts/")
    return p


@admin_router.get("/api/admin/system-prompts")
def admin_list_system_prompts(request: Request):
    """List every category file in system_prompts/ with size + mtime.

    Returns a structured listing rather than a flat array so the UI
    can show "available" vs "active" categories distinctly:

      {
        "directory": "/path/to/SYSTEM_P",
        "items": [
          {"category": "memory", "size_chars": 1804, "mtime": 17XXX, "exists": true},
          ...
        ],
        "template_exists": true
      }
    """
    # SECURITY FIX (P0) — TOUS les endpoints de ce module étaient
    # accessibles SANS AUCUNE AUTHENTIFICATION malgré la docstring
    # du module ("auth-gated to admin role"). Le admin_router est
    # monté sur la MÊME app FastAPI que les routes user en mode
    # APP_MODE=full (le défaut d'alors), donc ces routes étaient ouvertes sur
    # Internet si l'instance était exposée. Sur PUT/DELETE c'était
    # une injection de prompt à la source pour tous les chats.
    # ``_require_admin`` lève 401 si non-loggé, 403 si non-admin.
    _require_admin(request)
    cats = list_known_categories()
    out_items = []
    for cat in cats:
        p = _SYSTEM_P_DIR / f"{cat}.md"
        try:
            stat = p.stat()
            out_items.append({
                "category":   cat,
                "size_chars": stat.st_size,
                "mtime":      int(stat.st_mtime),
                "exists":     True,
            })
        except OSError:
            out_items.append({
                "category":   cat,
                "size_chars": 0,
                "mtime":      0,
                "exists":     False,
            })
    template = _SYSTEM_P_DIR / "_TEMPLATE.md"
    return {
        "directory":       str(_SYSTEM_P_DIR),
        "items":           out_items,
        "template_exists": template.is_file(),
    }


@admin_router.get("/api/admin/system-prompts/_template")
def admin_get_template(request: Request):
    """Return the contents of ``_TEMPLATE.md`` for the editor.

    Read-only — admins shouldn't edit the template through the UI;
    if they need to evolve the convention they should do it via a
    code change. The endpoint exists only so the editor can show
    "what should this file look like" alongside any per-category
    file when creating new ones.
    """
    _require_admin(request)
    p = _resolve_category_path("_TEMPLATE", allow_template=True)
    if not p.is_file():
        raise HTTPException(404, "_TEMPLATE.md not found")
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(500, f"read failed: {e}")
    return {"category": "_TEMPLATE", "content": text, "size_chars": len(text)}


async def _count_prompt_tokens(text: str) -> tuple:
    """``(nb_tokens, exact)`` du prompt assemblé.

    Exact via ``/tokenize`` quand le moteur répond ; sinon le ratio chars/token
    de l'application. On RENVOIE la provenance au lieu de laisser croire que
    le chiffre est une vérité — c'est tout l'intérêt d'un aperçu de prompt."""
    try:
        from llm_core._llama_http import count_tokens_exact
        # AUDIT 2026-09-16 (A2) — coroutine appelée sans ``await`` : ``n`` était
        # un objet coroutine, jamais un entier, donc l'aperçu retombait TOUJOURS
        # sur l'estimation (et journalisait « coroutine was never awaited »).
        n = await count_tokens_exact(text)
        if isinstance(n, int) and n > 0:
            return n, True
    except Exception:
        pass
    try:
        from llm_core.context.tokens import est_tokens_text
        return int(est_tokens_text(text)), False
    except Exception:
        return 0, False


@admin_router.get("/api/admin/system-prompts/_preview")
async def admin_preview_system_prompt(request: Request,
                                      categories: str = "",
                                      user_prompt: str = "",
                                      query: str = ""):
    """Assemble + return the system prompt that would be sent to a chat.

    Query params:
      categories  : comma-separated list (e.g. ``memory,fs,shell``).
      user_prompt : optional override of the user's saved system prompt
                    — empty string means "don't include any user prompt
                    section". Useful to inspect just the protocol blocks.
      query       : optional fake "last user message" used to match skills
                    (procedural memory) — lets an admin see which skill
                    bodies would be injected for a given request.
    """
    _require_admin(request)
    cat_list = [c.strip() for c in (categories or "").split(",") if c.strip()]
    fake_servers = (
        [{"type": "stdio", "name": "Local",
          "filter_categories": cat_list}]
        if cat_list else []
    )
    msgs = assemble_system_messages(user_prompt, fake_servers, last_user_text=query)
    text = assemble_preview(user_prompt, fake_servers, last_user_text=query)
    _n_tokens, _exact = await _count_prompt_tokens(text)
    return {
        "user_prompt":          user_prompt,
        "active_categories":    cat_list,
        "available_categories": list_known_categories(),
        "assembled":            text,
        "messages":             msgs,
        "size_chars":           len(text),
        # Comptage EXACT via /tokenize quand le moteur répond ; sinon le ratio
        # chars/token de l'app. L'ancien ``len(text) // 4`` était le dernier
        # comptage à la louche de l'application — et il ne collait même pas au
        # ratio que l'app utilise partout ailleurs (3,3).
        "approx_tokens":        _n_tokens,
        "tokens_exact":         _exact,
    }


@admin_router.get("/api/admin/system-prompts/{category}")
def admin_get_system_prompt(category: str, request: Request):
    """Return the raw .md content for one category."""
    _require_admin(request)
    p = _resolve_category_path(category)
    if not p.is_file():
        raise HTTPException(404, f"{category}.md not found")
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(500, f"read failed: {e}")
    return {"category": category, "content": text, "size_chars": len(text)}


@admin_router.put("/api/admin/system-prompts/{category}")
async def admin_put_system_prompt(category: str, request: Request):
    """Overwrite one category's .md file.

    Body JSON: ``{"content": "<new markdown text>"}``.

    The new content is written atomically (tmp + fsync + rename) so
    concurrent requests can't see a half-written file. Cache invalidation
    is automatic via the assembler's mtime check.

    The endpoint REJECTS:
      - missing or non-string ``content``
      - empty content (use DELETE to remove a file — not implemented yet
        intentionally; we want admins to think twice before removing
        a category's protocol)
      - content larger than ``_MAX_FILE_BYTES``
    """
    _require_admin(request)
    p = _resolve_category_path(category)
    body = await request.json()
    content = body.get("content")
    if not isinstance(content, str):
        raise HTTPException(400, "body.content must be a string")
    content = content.strip()
    if not content:
        raise HTTPException(400, "content is empty — use DELETE if you really want to remove this category")
    if len(content.encode("utf-8")) > _MAX_FILE_BYTES:
        raise HTTPException(
            400,
            f"content too large ({len(content)} chars > {_MAX_FILE_BYTES} bytes max)"
        )

    # Atomic write — same pattern as memory_tools / memory routes — hors de la
    # boucle d'événements (``fsync``).
    def _write() -> None:
        tmp = p.with_suffix(".md.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
            try:
                f.flush()
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, p)
    try:
        await asyncio.to_thread(_write)
    except OSError as e:
        raise HTTPException(500, f"write failed: {e}")

    return {
        "ok":         True,
        "category":   category,
        "size_chars": len(content),
        "path":       str(p),
    }


# NOTE — DELETE /api/admin/system-prompts/{category} retiré (réalignement
# admin 2026-06) : reste de l'ère des « protocoles d'outils » (.md par
# catégorie d'outils, supprimés). Le répertoire system_prompts/ ne contient
# plus que les prompts de base vitaux (CHATBOT_SYSTEM, COMPRESSOR_SYSTEM,
# AX_MEMORY_HEADER) — les supprimer n'est jamais une action admin légitime ;
# l'onglet Prompts offre édition + rechargement, ce qui suffit.
