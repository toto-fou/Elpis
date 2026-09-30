# SPDX-License-Identifier: MIT
"""
chatbot_app.routes.saved_chats — User chat history CRUD.

Endpoints
---------
List & search
- GET    /api/saved/chats                          — list (filter by archived)
- GET    /api/saved/chats/search                   — title (and optionally
                                                      content) search

Per-chat read/write
- GET    /api/saved/chats/{chat_id}                — load full chat
- POST   /api/saved/chats/new                      — create empty chat
- PATCH  /api/saved/chats/{chat_id}                — rename
- PUT    /api/saved/chats/{chat_id}/save-messages  — save partial messages
                                                      (used by background
                                                      streaming, persists
                                                      whatever the worker has
                                                      produced so far so an
                                                      interrupted run is
                                                      recoverable)
- DELETE /api/saved/chats/{chat_id}                — drop one

Bulk
- POST   /api/saved/chats/clear-all                — delete all non-archived
- POST   /api/saved/chats/delete-batch             — delete a list of ids

Archive
- POST   /api/saved/chats/{chat_id}/archive        — archive
- POST   /api/saved/chats/{chat_id}/unarchive      — unarchive (also re-runs
                                                      ``enforce_recent_chats_cap``
                                                      so the unarchived chat
                                                      can push older non-
                                                      archived ones out of
                                                      the recent window)
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from shared_infra.accounts.users import (
    get_username_by_id,
)
from shared_infra.chat.store import (
    archive_chat,
    delete_chat,
    enforce_recent_chats_cap,
    get_chat,
    list_chats,
    rename_chat,
    search_chats,
    unarchive_chat,
    upsert_chat,
)
from shared_infra.db import (
    log_metric,
)
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")

# ``_no_cache`` is a tiny header helper still living in ``_legacy``.
# Import directly to avoid duplicating the implementation.
from shared_infra.routes._legacy import _no_cache


# ─────────────────────────────────────────────────────────────────────────────
#  LIST & SEARCH
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/saved/chats")
def api_saved_list(request: Request, archived: int = 0):
    user_id = require_user_id(request)
    return JSONResponse(
        {"items": list_chats(user_id, archived=archived)},
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/api/saved/chats/search")
def api_search_chats_route(request: Request, q: str, archived: int = 0,
                           deep: int = 0):
    """Recherche chats. ``deep=1`` active le scan du contenu des messages
    (lent — par défaut on ne cherche que dans les titres).
    """
    user_id = require_user_id(request)
    if not q:
        return {"items": []}
    return {"items": search_chats(user_id, q, archived, deep=bool(deep))}


# ─────────────────────────────────────────────────────────────────────────────
#  PER-CHAT READ / WRITE
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/saved/chats/new")
async def api_saved_new(request: Request):
    user_id = require_user_id(request)
    # Corps OPTIONNEL ``{"plan_mode": bool}`` : créer le chat déjà en lecture
    # seule (« /plan » tapé sur un chat vierge — le mode doit couvrir le
    # PREMIER tour, sinon « préparer avant d'agir » ne veut rien dire).
    # Scellé À LA CRÉATION donc atomique : la route de génération relit
    # meta_json, il n'existe aucune fenêtre où le tour partirait avec les
    # outils d'écriture. Sans corps (appels historiques) : inchangé.
    plan_mode = False
    try:
        body = await request.json()
    except Exception:
        body = None
    if isinstance(body, dict) and "plan_mode" in body:
        if not isinstance(body["plan_mode"], bool):
            raise HTTPException(422, "plan_mode doit être un booléen")
        plan_mode = body["plan_mode"]
    chat_id = secrets.token_hex(12)

    # (passe 8, B4) — cinq transactions SQLite SYNCHRONES tournaient sur la
    # boucle (« Nouveau chat » gelait tous les flux du worker le temps du
    # verrou WAL) : déportées dans un thread, comme les routes voisines.
    def _creer() -> str:
        upsert_chat(user_id, chat_id, "Nouveau chat", [], time.time())
        if plan_mode:
            from shared_infra.chat.store import set_chat_plan_mode
            set_chat_plan_mode(user_id, chat_id, True)
        enforce_recent_chats_cap(user_id)
        username = get_username_by_id(user_id) or f"user_{user_id}"
        log_metric("new_chat", 1, {"user": username})
        return chat_id

    return {"id": await asyncio.to_thread(_creer)}


@router.get("/api/saved/chats/{chat_id}")
def api_saved_get(chat_id: str, request: Request):
    user_id = require_user_id(request)
    c = get_chat(user_id, chat_id)
    if not c:
        raise HTTPException(404, "chat not found")
    return _no_cache(JSONResponse(c))


@router.patch("/api/saved/chats/{chat_id}")
async def api_saved_rename(chat_id: str, request: Request):
    user_id = require_user_id(request)
    data = await request.json()
    ok = await asyncio.to_thread(rename_chat, user_id, chat_id, data.get("title", ""))   # (passe 8, B4)
    if not ok:
        raise HTTPException(404, "chat not found or invalid title")
    return {"ok": True}


@router.put("/api/saved/chats/{chat_id}/tools")
async def api_saved_set_tools(chat_id: str, request: Request):
    """Mémorise les catégories d'outils actives PAR CHAT (panneau Outils).

    Appelé par le front à chaque toggle (débouncé) ; le backend écrit aussi ce
    snapshot en fin de tour de génération. ``[]`` = tout décoché (état valide).
    """
    from shared_infra.chat.store import set_chat_tools
    user_id = require_user_id(request)
    data = await request.json()
    tools = data.get("tools")
    if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools):
        raise HTTPException(422, "tools doit être une liste de noms de catégories")
    if not await asyncio.to_thread(set_chat_tools, user_id, chat_id, tools):   # (passe 8, B4)
        raise HTTPException(404, "chat not found")
    return {"ok": True}


@router.put("/api/saved/chats/{chat_id}/plan-mode")
async def api_saved_set_plan_mode(chat_id: str, request: Request):
    """Bascule le mode LECTURE SEULE du chat (commande « /plan »).

    Même canal que les catégories d'outils : écrit dans ``meta_json``. La
    route de génération relit cette valeur — elle ne se fie pas au corps de
    la requête de streaming — pour que le mode reste vrai même si un onglet
    resté ouvert envoie un état périmé.
    """
    from shared_infra.chat.store import set_chat_plan_mode
    user_id = require_user_id(request)
    data = await request.json()
    value = data.get("plan_mode")
    if not isinstance(value, bool):
        raise HTTPException(422, "plan_mode doit être un booléen")
    if not await asyncio.to_thread(set_chat_plan_mode, user_id, chat_id, value):
        raise HTTPException(404, "chat not found")
    return {"ok": True, "plan_mode": value}


@router.put("/api/saved/chats/{chat_id}/save-messages")
async def api_saved_save_messages(chat_id: str, request: Request):
    """Save partial messages for a chat (used by background streaming)."""
    user_id = require_user_id(request)
    data = await request.json()
    msgs = data.get("messages", [])
    title = data.get("title", "")

    # ── Garde « run en cours » (AUDIT 2026-09-16, R1 — perte du résultat) ──
    # Un run qui tient ce chat persiste LUI-MÊME son tour (final, ou partiel
    # sur Stop/crash), sous garde optimiste sur l'``updated_at`` du début du
    # tour. Ce PUT, lui, écrit sans garde et avance ``updated_at`` : la
    # persistance finale du run tombait alors en conflit et la réponse —
    # outils exécutés, tokens payés — n'était jamais sauvée. Cas typique :
    # lancer une génération dans un autre chat pendant qu'un premier tourne
    # en arrière-plan. Le serveur est l'autorité tant que le run vit ; même
    # idiome « skipped » que les gardes ci-dessous (appel best-effort).
    from shared_infra.routes._state import is_generation_active
    if is_generation_active(user_id, chat_id):
        logger.info("[save-messages] chat=%s tenu par un run en cours : "
                    "sauvegarde partielle ignorée (le run persiste lui-même).",
                    str(chat_id)[:12])
        return {"ok": True, "skipped": "generation_running"}

    # État courant lu UNE fois : sert au fallback de titre ET aux deux gardes
    # ci-dessous. AUDIT 2026-08-31 (passe 4, B4) — lecture du chat COMPLET
    # (potentiellement des Mo de messages) : hors boucle, comme partout.
    existing = await asyncio.to_thread(get_chat, user_id, chat_id)

    # ── Garde anti-résurrection (BUG FIX — conversation supprimée qui revient) ──
    # Ce endpoint ne sert QU'aux sauvegardes partielles du streaming en arrière-
    # plan, et le front crée toujours le chat côté serveur AVANT de streamer
    # (``POST /api/saved/chats/new``, app-chat.js). Il n'a donc jamais à en
    # CRÉER un — or il passait par ``upsert_chat``, qui insère si la ligne
    # manque.
    #
    # Conséquence observée : l'utilisateur supprime une conversation pendant
    # qu'une génération tourne encore en arrière-plan ; la sauvegarde partielle
    # suivante la recrée, et elle réapparaît dans la liste. Reproduit à
    # l'identique en séquentiel strict — DELETE (200), GET (404), PUT (200),
    # GET (200) — donc sans même avoir besoin d'une course.
    #
    # On répond ``ok`` plutôt qu'une erreur : cet appel est du best-effort côté
    # client (``catch(e) {}``), et un 404 ne ferait qu'ajouter du bruit dans la
    # console pour un geste que l'utilisateur a délibérément posé. Même idiome
    # que le ``skipped: stale`` ci-dessous.
    if not existing:
        logger.info("[save-messages] chat=%s absent : sauvegarde partielle "
                    "ignorée (conversation supprimée entre-temps).",
                    str(chat_id)[:12])
        return {"ok": True, "skipped": "absent"}

    if not title:
        title = existing.get("title", "Nouveau chat")

    # ── Garde anti-régression (BUG FIX — perte de données) ───────────────
    # ``save-messages`` ne sert QU'aux sauvegardes partielles du streaming
    # en arrière-plan, dont le contenu ne fait que CROÎTRE pendant le tour.
    # Il existe une course : un chat qui termine son stream en bg est
    # persisté COMPLET par la route de streaming, puis émet ``final`` ;
    # pendant les quelques ms où ce ``final`` voyage vers le client, ce
    # dernier peut envoyer un ``save-messages`` partiel (snapshot pris
    # avant la fin) → il écrasait silencieusement la version complète.
    # On refuse donc tout payload dont le contenu total est STRICTEMENT
    # plus court que ce qui est déjà stocké : c'est un partiel périmé. Une
    # régression légitime (édition d'un message + régénération) passe par
    # la route de streaming, pas par cet endpoint — non affectée.
    if existing and isinstance(msgs, list):
        def _content_len(message_list):
            # BUG FIX — multimodal vision : un message dont content est une
            # liste (parts text + image) était compté 0 → le payload était
            # toujours rejeté "stale". On somme les parts text, et on ajoute
            # un poids fixe par part non-texte (image/audio) pour différencier
            # "rien" de "1 image".
            total = 0
            for m in message_list:
                if not isinstance(m, dict):
                    continue
                # Les messages system (état de compression persisté en tête)
                # et les ``notice`` (marqueur « conversation compactée » posé
                # côté serveur par /compress) peuvent n'exister QUE côté
                # stocké — les compter rendrait la garde anti-stale faussement
                # positive sur les chats compressés.
                if m.get("role") in ("system", "notice"):
                    continue
                c = m.get("content")
                if isinstance(c, str):
                    total += len(c)
                elif isinstance(c, list):
                    for part in c:
                        if not isinstance(part, dict):
                            continue
                        t = part.get("text")
                        if isinstance(t, str):
                            total += len(t)
                        else:
                            total += 1
            return total
        if _content_len(msgs) < _content_len(existing.get("messages", [])):
            logger.info(
                "[save-messages] payload périmé ignoré pour chat=%s "
                "(contenu entrant plus court que le stocké) — garde "
                "anti-écrasement de la sauvegarde finale.",
                str(chat_id)[:12],
            )
            return {"ok": True, "skipped": "stale"}

    # État de compression : le client ne renvoie JAMAIS le message system
    # d'état — on le re-préfixe depuis la version stockée (carry-forward),
    # sinon ce PUT effacerait le résumé + le compteur de rounds du cap.
    try:
        from llm_core.conversation_compressor import (
            _strip_summary_messages,
            build_state_system_message,
            extract_compression_state,
        )
        _compr_st = extract_compression_state((existing or {}).get("messages") or [])
        if _compr_st and (_compr_st.get("summary_xml") or "").strip():
            # Mêmes champs que ``_with_compr_state`` (routes/chats.py) : sans
            # ``ledger_block`` ni ``turns_compressed``, ce PUT effaçait le
            # registre d'artefacts de la compaction (2026-09-21).
            msgs = [build_state_system_message(
                _compr_st["summary_xml"],
                int(_compr_st.get("round") or 1),
                int(_compr_st.get("covered_turns") or 0),
                turns_compressed=_compr_st.get("turns_compressed"),
                ledger_block=_compr_st.get("ledger_block") or "",
            )] + _strip_summary_messages(msgs)
    except Exception:
        logger.warning("[save-messages] carry-forward état compression échoué", exc_info=True)

    # BUG FIX (élevé) : upsert_chat raise ValueError sur collision cross-user.
    # Avant ce fix, l'upsert retournait silencieusement avec rowcount=0 et
    # le client recevait 200 OK pour une opération qui n'avait rien fait.
    # Embed each referenced Chart.js config into the message it belongs to,
    # so a chart stays renderable even after its .charts/ cache file is
    # pruned (see backend/routes/charts.py). Lazy import: avoids any
    # import-order coupling between route modules.
    from shared_infra.charts.routes import embed_chart_configs
    # AUDIT 2026-08-31 (passe 4, B4) — ``embed_chart_configs`` RELIT tout le
    # chat + fichiers .charts/, et l'upsert écrit (busy_timeout 10 s) : les
    # deux hors boucle. Cet endpoint est appelé en rafale par le streaming bg.
    msgs = await asyncio.to_thread(embed_chart_configs, user_id, chat_id, msgs)
    try:
        await asyncio.to_thread(upsert_chat, user_id, chat_id, title, msgs, time.time())
    except ValueError:
        raise HTTPException(409, "chat_id already exists for another user")
    return {"ok": True}


@router.delete("/api/saved/chats/{chat_id}")
def api_saved_delete(chat_id: str, request: Request):
    user_id = require_user_id(request)
    ok = delete_chat(user_id, chat_id)
    if not ok:
        raise HTTPException(404, "chat not found")
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
#  BULK
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/saved/chats/clear-all")
def api_saved_clear_all(request: Request):
    """Delete all non-archived chats for the current user.

    AUDIT 2026-09-01 (passe 6, B6) — une seule transaction (un commit/fsync)
    au lieu d'un ``delete_chat`` par chat (100 chats = 100 fsync sous le
    verrou d'écriture WAL)."""
    user_id = require_user_id(request)
    from shared_infra.chat.store import delete_all_chats
    count = delete_all_chats(user_id, archived=0)
    return {"ok": True, "deleted": count}


@router.post("/api/saved/chats/delete-batch")
async def api_saved_delete_batch(request: Request):
    """Delete multiple chats by IDs."""
    user_id = require_user_id(request)
    data = await request.json()
    ids = data.get("ids", [])
    # BUG FIX — sans cette validation, un client envoyant ids="abc" passait
    # la liste = string → itération par caractère → N suppressions hasardeuses.
    if not isinstance(ids, list):
        raise HTTPException(400, "ids doit être une liste")
    # (passe 6, B6) — une transaction pour tout le lot, en thread (la boucle
    # ``delete_chat`` tournait de surcroît en SYNC sur la boucle d'événements).
    from shared_infra.chat.store import delete_chats_by_ids
    count = await asyncio.to_thread(delete_chats_by_ids, user_id,
                                    [str(c) for c in ids])
    return {"ok": True, "deleted": count}


# ─────────────────────────────────────────────────────────────────────────────
#  ARCHIVE / UNARCHIVE
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/saved/chats/archive-batch")
async def api_saved_archive_batch(request: Request):
    """Archive plusieurs chats d'un coup (passe 2 2026-08-31).

    L'UI d'archivage groupé faisait N POST séquentiels — chacun suivi d'un
    remplacement complet de la liste côté front — pendant que la suppression
    groupée avait déjà son endpoint batch. Symétrie rétablie ; la boucle DB
    part en threadpool."""
    user_id = require_user_id(request)
    data = await request.json()
    ids = data.get("ids", [])
    if not isinstance(ids, list):
        raise HTTPException(400, "ids doit être une liste")

    def _run() -> int:
        count = 0
        for cid in ids:
            if archive_chat(user_id, str(cid)):
                count += 1
        if count:
            enforce_recent_chats_cap(user_id)
        return count

    count = await asyncio.to_thread(_run)
    return {"ok": True, "archived": count}


@router.post("/api/saved/chats/{chat_id}/archive")
def api_saved_archive(chat_id: str, request: Request):
    user_id = require_user_id(request)
    ok = archive_chat(user_id, chat_id)
    if not ok:
        raise HTTPException(404, "chat not found")
    enforce_recent_chats_cap(user_id)
    return {"ok": True}


@router.post("/api/saved/chats/{chat_id}/unarchive")
def api_saved_unarchive(chat_id: str, request: Request):
    user_id = require_user_id(request)
    ok = unarchive_chat(user_id, chat_id)
    if not ok:
        raise HTTPException(404, "chat not found")
    enforce_recent_chats_cap(user_id)
    return {"ok": True}
