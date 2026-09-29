# SPDX-License-Identifier: MIT
"""
backend.routes.tools — Auxiliary tooling endpoints (RAG, file parsing,
and the Playwright screenshot proxy).

Endpoints
---------
File processing (any authenticated user)
- POST /api/tools/extract-text  — best-effort UTF-8/latin-1 text extraction
                                   from an upload (max 2 MB)
- POST /api/tools/parse-file    — structured parsing of binary formats
                                   (pcap, etc.) for LLM-friendly summaries

External services
- GET  /api/rag/collections     — list Qdrant collections (best-effort, returns
                                   ``[]`` if the RAG backend isn't reachable)
- GET  /api/playwright/screenshot/{filename}
                                — proxy a Playwright PNG to the frontend with
                                   per-session ownership check + anti-replay
                                   delete on first read

Module-level helpers (NOT re-exported through the package façade unless they
were before)
--------------------------------------------------------------------------
- ``PLAYWRIGHT_API`` — base URL of the browser-service. Read at import time
  from ``$PLAYWRIGHT_API_URL`` (default ``http://localhost:3000``).
- ``_username_for(user_id)`` — soft username lookup with fallback to
  ``user_<id>``. Used by the screenshot ownership check.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re as _re_pw

import httpx
from fastapi import File, HTTPException, Request, UploadFile
from fastapi.responses import Response

from llm_core import get_pw_session_owner as _get_pw_owner
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────────────────────
# Base URL of the browser-service (Playwright sidecar). Read at import time
# so a single source of truth is shared by every endpoint here. Override via
# the ``PLAYWRIGHT_API_URL`` environment variable.
PLAYWRIGHT_API = os.environ.get("PLAYWRIGHT_API_URL", "http://localhost:3000")

# Références FORTES des tâches fire-and-forget de ce module (cf. M3 de l'audit
# 2026-08-01) : sans elles, le GC peut collecter une tâche avant sa première
# exécution. Patron recommandé par la doc asyncio.
_BG_TASKS: set = set()


def _username_for(user_id: int) -> str:
    """Soft username lookup. Falls back to ``user_<id>`` on any failure —
    callers use this only for log lines and ownership comparison strings,
    so a stable string matters more than an authoritative one."""
    try:
        from shared_infra.accounts.identity import resolve_username as _ident_name
        _n = _ident_name(user_id)
        if _n:
            return _n
        from shared_infra.accounts.users import get_username_by_id as _gub
        return _gub(user_id) or f"user_{user_id}"
    except Exception:
        return f"user_{user_id}"


# ─────────────────────────────────────────────────────────────────────────────
#  RAG
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/rag/collections")
async def api_get_rag_collections(request: Request):
    """Best-effort enumeration of available RAG collections.

    Since the SSE-decoupling refactor (v3) the chatbot no longer reaches
    Qdrant directly — it asks the standalone ``rag_app`` service. The
    service exposes ``GET /api/collections`` which returns the list it
    sees on its own Qdrant. This way:

      * the chatbot doesn't need Qdrant credentials;
      * collections shown in the UI always match what the RAG tools
        will actually be able to search (single source of truth on the
        rag_app side);
      * we go through the configured auth (Bearer token) automatically.

    Any error is swallowed and we return ``{"collections": []}`` so
    the frontend keeps rendering.
    """
    require_user_id(request)  # énumération de collections → réservée aux users authentifiés
    from llm_core._rag_client import list_collections
    try:
        # AUDIT 2026-08-23 — ``list_collections`` est SYNCHRONE (httpx.Client) :
        # appelée telle quelle dans un ``async def``, elle fige la boucle
        # d'événements — donc TOUS les flux de TOUS les utilisateurs du worker —
        # pour la durée de l'aller-retour, jusqu'au plafond de 3 s si le service
        # accepte sans répondre. Et la page l'appelle à chaque ouverture.
        cols = await asyncio.to_thread(list_collections, timeout=3.0)
        return {"collections": cols or []}
    except Exception:
        return {"collections": []}


# ─────────────────────────────────────────────────────────────────────────────
#  FILE TOOLS
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/tools/extract-text")
async def api_extract_text(request: Request, file: UploadFile = File(...)):
    require_user_id(request)
    # Avant : ``await file.read()`` chargeait TOUT en RAM puis check la taille
    # → si l'user envoie 5 Go, OOM avant le check. Corrigé avec le helper
    # qui lit par chunks et interrompt dès le dépassement.
    from shared_infra.files.uploads import read_upload_bounded
    MAX_SIZE = 2 * 1024 * 1024
    try:
        content = await read_upload_bounded(file, MAX_SIZE)
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = content.decode("latin-1")
            except Exception:
                raise HTTPException(400, "Encodage non supporté.")
        return {"ok": True, "filename": file.filename, "content": text, "size": len(text)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Erreur lecture fichier: {str(e)}")


@router.post("/api/tools/parse-file")
async def api_parse_file(request: Request, file: UploadFile = File(...)):
    """Parse a binary file (pcap, etc.) into structured text for LLM analysis."""
    from shared_infra.files.parsers import SUPPORTED_EXTENSIONS, parse_file
    require_user_id(request)
    ext = ""
    if file.filename:
        dot = file.filename.rfind(".")
        ext = file.filename[dot:].lower() if dot >= 0 else ""
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, f"Format non supporté : {ext}. Formats acceptés : {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
    # Idem extract_text : lire par chunks avec interruption au dépassement
    # plutôt que ``await file.read()`` qui charge tout avant de checker.
    from shared_infra.files.uploads import read_upload_bounded
    data = await read_upload_bounded(file, 100 * 1024 * 1024)  # 100 Mo max
    try:
        # parse_file est CPU-intensif (dissection pcap, etc.) — to_thread
        # évite de figer l'event loop pendant le parsing.
        result = await asyncio.to_thread(parse_file, data, file.filename or "unknown")
    except Exception as e:
        logger.error(f"[PARSE] Erreur parsing {file.filename}: {e}")
        raise HTTPException(500, f"Erreur de parsing : {str(e)[:200]}")
    return {"ok": True, "filename": file.filename, "content": result, "length": len(result)}


# ─────────────────────────────────────────────────────────────────────────────
#  PLAYWRIGHT SCREENSHOT PROXY
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/playwright/screenshot/{filename}")
async def api_playwright_screenshot(request: Request, filename: str):
    """Proxy une PNG Playwright (./screenshots/<filename>) vers le front.
    Logs détaillés à chaque étape pour diagnostiquer les 404.
    """
    user_id = require_user_id(request)

    safe = os.path.basename(filename)
    if safe != filename or ".." in safe or not safe.lower().endswith(".png"):
        logger.warning("[pw_screenshot] BAD FILENAME: %r", filename)
        raise HTTPException(400, "Invalid filename")

    # ── Ownership check (soft : log mais ne bloque pas si owner inconnu) ──
    # Audit tools web 2026-09-05 — ``shot_<sid>_<ts>.png`` est le nom que
    # ``/screenshot`` (pw_page action=screenshot) donne à sa capture ; il n'était
    # pas relayé, donc aucune URL applicative ne pouvait l'atteindre.
    _step_pat = _re_pw.compile(r"^(?:step|shot)_([A-Za-z0-9\-]{8,64})_\d+\.png$")
    _other_pat = _re_pw.compile(r"^(?:live|smart|view)_([A-Za-z0-9\-]{8,64})\.png$")
    m = _step_pat.match(safe) or _other_pat.match(safe)
    if not m:
        logger.warning("[pw_screenshot] PATTERN FAIL: %r (no match)", safe)
        raise HTTPException(400, "Invalid screenshot filename pattern")
    sid = m.group(1)
    owner = _get_pw_owner(sid)
    expected_username = _username_for(user_id)

    if owner is None:
        # AUDIT 2026-08-22 (D7) — REFUS. Ce contrôle laissait passer toute
        # session inconnue « le temps de la propagation », en s'appuyant sur un
        # filtrage par le système de fichiers qui n'existe pas : la suite se
        # contente de relayer la capture depuis le service Playwright, sans
        # aucun filtre par utilisateur. Or la propriété n'est plus seulement en
        # mémoire — un sidecar disque partagé la rend visible à TOUS les
        # workers (cf. get_pw_session_owner) : une session réellement en cours
        # est donc connue ici, quel que soit le worker qui répond. « Inconnue »
        # ne veut plus dire « pas encore propagée », mais « pas la vôtre ».
        logger.warning("[pw_screenshot] DENIED: sid=%s sans propriétaire connu "
                       "(user=%s)", sid[:8], expected_username)
        raise HTTPException(403, "Access denied: unknown session")
    elif owner != expected_username:
        logger.warning("[pw_screenshot] DENIED: user=%s tried to access session of user=%s",
                       expected_username, owner)
        raise HTTPException(403, "Access denied: not your session")

    url = f"{PLAYWRIGHT_API}/screenshots/{safe}"
    delete_url = f"{PLAYWRIGHT_API}/screenshots/{safe}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            for attempt in range(4):  # 4 tentatives au lieu de 3
                r = await client.get(url)
                if r.status_code == 200:
                    if attempt > 0:
                        logger.info("[pw_screenshot] OK after %d retries: %s", attempt, safe)
                    content = r.content
                    # Cleanup serveur immédiat (fire-and-forget) :
                    # le frontend a déjà le blob, on n'a plus besoin de la PNG.
                    async def _delete_after_serve():
                        try:
                            async with httpx.AsyncClient(timeout=2.0) as _c:
                                await _c.delete(delete_url)
                        except Exception:
                            pass
                    # AUDIT 2026-08-01 (M3) — référence FORTE obligatoire :
                    # asyncio ne garde qu'une WeakSet des tâches, donc une
                    # tâche qui n'a encore rien awaité et que personne ne
                    # référence peut être collectée avant de s'exécuter. Le
                    # DELETE promis ci-dessus pouvait donc ne jamais partir et
                    # les PNG s'accumuler côté service Playwright.
                    _t = asyncio.create_task(_delete_after_serve())
                    _BG_TASKS.add(_t)
                    _t.add_done_callback(_BG_TASKS.discard)
                    return Response(
                        content=content,
                        media_type="image/png",
                        headers={
                            "Cache-Control": "no-store, no-cache, must-revalidate",
                            "Pragma": "no-cache",
                        },
                    )
                if r.status_code != 404:
                    logger.warning("[pw_screenshot] PLAYWRIGHT_ERROR: %s → %d", safe, r.status_code)
                    raise HTTPException(502, f"Playwright returned {r.status_code}")
                # 404 du serveur Playwright : la PNG n'est pas (encore) sur disque
                await asyncio.sleep(0.3 * (attempt + 1))
            logger.warning("[pw_screenshot] NOT_READY: %s 404 after 4 retries (file never appeared)", safe)
            raise HTTPException(404, "Screenshot not ready")
    except httpx.RequestError as e:
        logger.error("[pw_screenshot] PLAYWRIGHT_DOWN: %s (%s)", url, e)
        raise HTTPException(503, f"Playwright unreachable: {e}")


