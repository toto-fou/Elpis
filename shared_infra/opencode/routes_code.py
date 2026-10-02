# SPDX-License-Identifier: MIT
"""
shared_infra/opencode/routes_code.py — page « Code » : sessions opencode remontées ET pilotables.

Modèle : l'utilisateur lance ``opencode`` où il veut, avec le plugin ``elpis-remote``
(TypeScript, servi par ``/api/code/plugin.ts`` — source :
``shared_infra/opencode/plugin/``). Dans opencode, la commande ``/remote <jeton>``
active la remontée : le plugin **pousse** les events de session vers
``POST /api/code/ingest`` (lots, auth par token per-user) et **tire** les commandes
de la page (prompts, abort) via ``GET /api/code/pull`` (long-poll). La page est un
moniteur **interactif** : liste des sessions publiées, transcript live (SSE), et
composer qui pilote la session opencode à distance.

Gated par le flag global ``features.opencode`` (404 si désactivé).

Multi-worker safe : l'état vit en SQLite (``store``, transactions courtes,
claim de commandes atomique) et le fan-out SSE passe par le bus multi-worker
``pipeline_events`` (events enveloppés ``{"type": "code.event", "data": …}``) —
peu importe quel worker gunicorn sert l'ingest, le pull ou la page. L'epoch est
persisté : le plugin ne re-snapshotte pas à chaque redéploiement.
"""
from __future__ import annotations

import asyncio
import json as _json
import logging
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from shared_infra.config import feature_enabled
from shared_infra.db import _connection as _dbc
from shared_infra.db._connection import db_tx
from shared_infra.observability.events_bus import pipeline_events
from shared_infra.opencode import store as _cstore
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id, stream_session_still_valid

logger = logging.getLogger("uvicorn.error")

# Events que le plugin forwarde (+ session.snapshot, rattrapage d'historique ;
# + client.commands, liste des slash commands de la CLI pour l'autocomplétion).
_FORWARD = {
    "session.created", "session.updated", "session.deleted", "session.idle", "session.error",
    "message.updated", "message.part.updated", "message.removed",
    # permissions : opencode 1.17.x émet "permission.asked" (shape v2 — vérifié
    # sur le binaire réel) ; "permission.updated" (v1) gardé par compat versions.
    "permission.updated", "permission.asked", "permission.replied",
    # questions de l'outil `question` (greffon v14) : bloquantes côté CLI —
    # shape 1.18.16 vérifiée sur le binaire (question.asked = QuestionRequest,
    # replied/rejected = {sessionID, requestID}).
    "question.asked", "question.replied", "question.rejected",
    "session.snapshot", "client.commands", "client.models", "client.agents",
}

# ── Plugin elpis-remote : fichiers servis (source = shared_infra/opencode/plugin/) ──
# Le plugin est du TypeScript NATIF (opencode/Bun charge les plugins ``*.{ts,js}``
# sans build) : ``elpis-remote.ts`` est le canonique, servi par /api/code/plugin.ts.
# /api/code/plugin.js sert un SHIM de migration (JS pur) pour le chemin
# « /remote update » des anciens plugins ≤ v8 : il installe le .ts puis s'efface.
_PLUGIN_DIR = Path(__file__).resolve().parent / "plugin"
_PLUGIN_TS = (_PLUGIN_DIR / "elpis-remote.ts").read_text(encoding="utf-8")
_PLUGIN_BOOTSTRAP_JS = (_PLUGIN_DIR / "elpis-remote-bootstrap.js").read_text(encoding="utf-8")

# Version courante du plugin — SOURCE UNIQUE : parsée depuis le .ts (le shim doit
# la répliquer, vérifié ici — fail-fast à l'import plutôt qu'un update incohérent).
# Un client plus vieux garde un protocole compatible ; la page propose la MAJ et
# le plugin sait se mettre à jour (/remote update) — le pull renvoie
# plugin_current pour que la CLI se signale dépassée.
def _parse_plugin_version(src: str, name: str) -> int:
    m = re.search(r"const PLUGIN_VERSION = (\d+)", src)
    if not m:
        raise RuntimeError(f"PLUGIN_VERSION introuvable dans {name}")
    return int(m.group(1))


_PLUGIN_CURRENT = _parse_plugin_version(_PLUGIN_TS, "elpis-remote.ts")
if _parse_plugin_version(_PLUGIN_BOOTSTRAP_JS, "elpis-remote-bootstrap.js") != _PLUGIN_CURRENT:
    raise RuntimeError("elpis-remote-bootstrap.js désynchronisé de elpis-remote.ts "
                       "(PLUGIN_VERSION différent)")

# Actions natives opencode exécutables à distance (kind "action" du pull) —
# mappées côté plugin sur les endpoints session vérifiés (opencode 1.17.x) :
# revert/unrevert/summarize/share/unshare/init/create/delete.
_ACTIONS = {"undo", "redo", "compact", "share", "unshare", "init", "new", "delete"}


def _require_enabled() -> None:
    if not feature_enabled("opencode"):
        raise HTTPException(404, "OpenCode est désactivé par l'administrateur.")


async def _body(request: Request) -> dict:
    try:
        d = await request.json()
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


# ─────────────────────────────────────────────────────────────────────────────
#  Jetons opencode (``pcr_``) — magasin commun ``shared_infra.accounts.tokens``
# ─────────────────────────────────────────────────────────────────────────────
# Le jeton n'est jamais gardé en clair ni réaffichable : il se montre une fois
# (création, rotation, appairage) et seule son empreinte reste. Un compte peut
# avoir un jeton par poste.
_schema_ready: set = set()   # (pid, base) dont la table d'appairage est posée


def _db():
    """Transaction courte sur la base commune (``with _db() as c:``)."""
    key = (os.getpid(), str(_dbc.DB_PATH))
    if key not in _schema_ready:
        from shared_infra.db._schema import ensure_tables
        with db_tx() as c:
            ensure_tables(c, ("code_pairings",))
        _schema_ready.add(key)
    return db_tx()


def _mint_token(uid: int, name: str = "") -> str:
    """Nouveau jeton opencode du compte, rendu en clair UNE fois."""
    from shared_infra.accounts import tokens as _tokens
    try:
        tok, _row = _tokens.create(int(uid), "opencode", name or "opencode")
    except _tokens.TokenError as e:
        raise HTTPException(409, str(e))
    return tok


def _rotate_token(uid: int, name: str = "") -> str:
    """Révoque TOUS les jetons opencode du compte (tous les postes) et en
    crée un."""
    from shared_infra.accounts import tokens as _tokens
    _tokens.revoke_kind(int(uid), "opencode")
    return _mint_token(uid, name)


def _resolve_token(tok: str) -> Optional[int]:
    """Jeton opencode valide → id du compte (compte existant, fonction
    opencode active), sinon ``None``."""
    from shared_infra.accounts import tokens as _tokens
    d = _tokens.resolve(tok, kinds=("opencode",))
    return int(d["user_id"]) if d else None


def _token_uid(request: Request) -> int:
    """Auth des routes plugin (ingest/pull/hello) : header ``x-elpis-token``."""
    from shared_infra.env_compat import token_header
    uid = _resolve_token(token_header(request.headers))
    if uid is None:
        raise HTTPException(401, "Token elpis-remote invalide.")
    return uid


# ─────────────────────────────────────────────────────────────────────────────
#  Fan-out SSE : events rediffusés à la page via le bus multi-worker
# ─────────────────────────────────────────────────────────────────────────────
async def _publish(uid: int, data: dict) -> None:
    """Enveloppe ``code.event`` : le bus est partagé, /stream filtre par type."""
    try:
        await pipeline_events.broadcast_to_user(int(uid), {"type": "code.event", "data": data})
    except Exception:
        logger.exception("code: broadcast SSE échoué")


# ─────────────────────────────────────────────────────────────────────────────
#  Connexion CLI : config / token / plugin / hello
# ─────────────────────────────────────────────────────────────────────────────

class _ThreadStore:
    """Chaque appel au magasin part en thread : ``store`` fait du SQLite
    SYNCHRONE (busy timeout 5 s derrière le ``BEGIN IMMEDIATE`` de
    ``claim_commands``). Ne pas l'appeler sur la boucle depuis une route
    ``async`` : un verrou tenu gèlerait les SSE de tout le worker."""
    def __getattr__(self, name):
        fn = getattr(_cstore, name)
        if not callable(fn):
            return fn
        async def _call(*a, **k):
            return await asyncio.to_thread(fn, *a, **k)
        return _call


_ts = _ThreadStore()

@router.get("/api/code/health")
async def code_health(request: Request):
    """Battement de cœur de la page (toutes les 15 s tant qu'elle est ouverte).

    C'est aussi le seul moment fiable pour constater qu'une CLI est morte SANS
    dire au revoir : elle ne pousse plus rien, donc aucun ingest ne viendra
    balayer les commandes qu'elle ne prendra jamais. On le fait ici, et on le
    DIT dans le transcript — un envoi qui ne partira pas doit se voir.
    """
    _require_enabled()
    uid = int(require_user_id(request))
    # Battement toutes les 15 s par page ouverte : le sweep (BEGIN IMMEDIATE)
    # et les 4 lectures partent en thread, lectures regroupées en un seul saut
    # (``_health_reads``) — pas sur la boucle.
    for lost in await asyncio.to_thread(_cstore.sweep_undeliverable, uid):
        if not lost.get("sid"):
            continue
        # id DISTINCT de la commande : la trace « /cmd … » posée à l'envoi reste
        # visible, l'échec s'ajoute à côté au lieu de l'écraser.
        note = await asyncio.to_thread(
            _cstore.add_note, uid, lost["sid"], lost["id"] + ":lost", "error",
            "Non délivré", "CLI opencode déconnectée")
        await _publish(uid, {"type": "code.note",
                             "properties": {"sessionID": lost["sid"], "note": note}})
    connected, sessions, plug_min = await asyncio.to_thread(_health_reads, uid)
    return JSONResponse({"available": True, "connected": connected,
                         "sessions": sessions,
                         "plugin_version": plug_min,
                         "plugin_current": _PLUGIN_CURRENT})


def _health_reads(uid: int) -> tuple:
    """Les 4 lectures du battement, en un seul saut de thread."""
    connected = bool(_cstore.active_clients(uid)) \
        or (time.time() - _cstore.last_ingest(uid) < _cstore.CLIENT_TTL)
    return connected, _cstore.session_count(uid), _cstore.min_plugin_version(uid)


@router.get("/api/code/config")
def code_config(request: Request):
    """Panneau « Connecter opencode » : URL app + URL du plugin. Le jeton n'est
    pas rendu ici : ``POST /api/code/token`` en crée un, montré une fois ;
    ``tokens`` = nombre de jetons opencode actifs du compte."""
    _require_enabled()
    uid = require_user_id(request)
    # import à l'appel : ``routes_cli`` importe ``routes._state``, dont le paquet charge ce module (cycle)
    from shared_infra.opencode.routes_cli import _base_url
    base = _base_url(request)
    from shared_infra.accounts import tokens as _tokens
    n = sum(1 for t in _tokens.list_for(int(uid)) if t["kind"] == "opencode")
    return JSONResponse({"app_url": base, "plugin_url": f"{base}/api/code/plugin.ts",
                         "tokens": n})


@router.post("/api/code/token")
async def code_token_create(request: Request):
    """Jeton opencode d'un poste (nom libre, « opencode » par défaut), montré
    une seule fois. Utilisé par la page Code et par les installeurs."""
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    tok = await asyncio.to_thread(_mint_token, uid, str(body.get("name") or ""))
    return JSONResponse({"token": tok})


@router.post("/api/code/token/rotate")
def code_token_rotate(request: Request):
    """Révoque tous les jetons opencode du compte et en crée un."""
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse({"token": _rotate_token(int(uid))})


@router.get("/api/code/plugin.ts")
def code_plugin_ts(request: Request):
    """Plugin canonique (TypeScript, chargé nativement par opencode/Bun) — URL de
    l'app bakée (aucune variable d'env à exporter)."""
    _require_enabled()
    # import à l'appel : ``routes_cli`` importe ``routes._state``, dont le paquet charge ce module (cycle)
    from shared_infra.opencode.routes_cli import _base_url
    ts = _PLUGIN_TS.replace("__APP_URL__", _base_url(request))
    return PlainTextResponse(ts, media_type="application/typescript; charset=utf-8")


@router.get("/api/code/plugin.js")
def code_plugin_js(request: Request):
    """COMPAT ≤ v8 : les anciens plugins .js font « /remote update » sur cette
    URL et écrasent leur elpis-remote.js avec la réponse — on sert donc un shim
    JS VALIDE qui installe elpis-remote.ts puis s'efface au démarrage suivant."""
    _require_enabled()
    # import à l'appel : ``routes_cli`` importe ``routes._state``, dont le paquet charge ce module (cycle)
    from shared_infra.opencode.routes_cli import _base_url
    js = _PLUGIN_BOOTSTRAP_JS.replace("__APP_URL__", _base_url(request))
    return PlainTextResponse(js, media_type="text/javascript; charset=utf-8")


@router.get("/api/code/hello")
def code_hello(request: Request):
    """Validation du jeton à l'activation (/remote) — renvoie l'identité."""
    _require_enabled()
    uid = _token_uid(request)
    username = ""
    try:
        from shared_infra.accounts.users import get_user_by_id
        row = get_user_by_id(int(uid))
        username = (row["username"] if row else "") or ""
    except Exception:
        pass
    return JSONResponse({"ok": True, "user": username or f"user #{uid}"})


# ─────────────────────────────────────────────────────────────────────────────
#  Appairage par code (device flow) — /remote login côté CLI
# ─────────────────────────────────────────────────────────────────────────────
# La CLI démarre l'appairage SANS auth (elle n'a précisément plus de jeton
# valide) : elle affiche un code court que l'utilisateur confirme dans la page
# (session web authentifiée). Le jeton n'est livré qu'UNE fois, au poll, puis
# la demande est détruite. Garde-fous : codes 6 car. (~30 bits, alphabet sans
# caractères ambigus), TTL 5 min, usage unique, rate-limit start par IP et
# confirm par user — un attaquant connecté ne peut pas balayer l'espace de codes.
_PAIR_TTL = 300.0
_PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_PAIR_MAX_PER_IP = 3        # demandes par IP sur la fenêtre TTL
_PAIR_CONFIRM_MAX = 10      # essais de code ratés par user sur la fenêtre TTL


def _pair_new_code(c: sqlite3.Connection) -> str:
    for _ in range(5):
        code = "".join(secrets.choice(_PAIR_ALPHABET) for _ in range(6))
        if not c.execute("SELECT 1 FROM code_pairings WHERE code=?", (code,)).fetchone():
            return code
    return code     # collision 5× d'affilée ~impossible ; confirm prendra la + ancienne


@router.post("/api/code/pair/start")
async def code_pair_start(request: Request):
    """Ouvre une demande d'appairage (sans auth — la CLI n'a plus de jeton)."""
    _require_enabled()
    ip = (request.client.host if request.client else "") or ""
    now = time.time()

    def _tx():        # SQLite synchrone : en thread
        with _db() as c:
            c.execute("DELETE FROM code_pairings WHERE expires_at<?", (now,))
            row = c.execute("SELECT COUNT(*) FROM code_pairings WHERE ip=? AND created_at>?",
                            (ip, now - _PAIR_TTL)).fetchone()
            if row and row[0] >= _PAIR_MAX_PER_IP:
                raise HTTPException(429, "Trop de demandes d'appairage — réessayez dans quelques minutes.")
            code = _pair_new_code(c)
            pid = secrets.token_urlsafe(16)
            c.execute("INSERT INTO code_pairings(id,code,ip,created_at,expires_at) VALUES(?,?,?,?,?)",
                      (pid, code, ip, now, now + _PAIR_TTL))
            c.commit()
            return pid, code
    pid, code = await asyncio.to_thread(_tx)
    return JSONResponse({"id": pid, "code": code[:3] + "-" + code[3:],
                         "expires_in": int(_PAIR_TTL), "interval": 3})


@router.get("/api/code/pair/poll")
async def code_pair_poll(request: Request):
    """Poll de la CLI (sans auth — le pair_id 128 bits fait office de secret)."""
    _require_enabled()
    pid = str(request.query_params.get("id") or "")
    now = time.time()

    def _tx():        # SQLite synchrone : en thread
        with _db() as c:
            row = c.execute("SELECT expires_at, confirmed_uid FROM code_pairings WHERE id=?",
                            (pid,)).fetchone()
            if not row:
                raise HTTPException(404, "Demande d'appairage inconnue.")
            expires_at, uid = float(row[0] or 0), row[1]
            if uid and now <= expires_at:
                # Quota vérifié AVANT de consommer la demande : un refus la
                # laisse en place (révoquer un jeton puis relancer suffit).
                from shared_infra.accounts import tokens as _tokens
                try:
                    _tokens.check_quota(int(uid))
                except _tokens.TokenError as exc:
                    raise HTTPException(409, str(exc))
            if now > expires_at or uid:
                # Usage unique : la demande est détruite AVANT de créer le jeton,
                # et seul le poll qui l'a effectivement détruite le reçoit (deux
                # polls simultanés n'en obtiennent pas deux).
                cur = c.execute("DELETE FROM code_pairings WHERE id=?", (pid,))
                c.commit()
                if now > expires_at:
                    return {"status": "expired"}
                if cur.rowcount:
                    return {"status": "ok", "uid": int(uid)}
                raise HTTPException(404, "Demande d'appairage inconnue.")
        return {"status": "pending"}
    out = await asyncio.to_thread(_tx)
    if out.get("status") == "ok":
        # Le jeton est créé ICI, à la livraison, et n'est jamais stocké en clair :
        # ne pas le poser dans ``code_pairings`` en attendant le poll.
        tok = await asyncio.to_thread(_mint_token, out.pop("uid"), "opencode (appairage)")
        out["token"] = tok
    return JSONResponse(out)


@router.post("/api/code/pair/confirm")
async def code_pair_confirm(request: Request):
    """Confirmation du code par l'utilisateur connecté (page Remote code)."""
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    code = "".join(ch for ch in str(body.get("code") or "").upper() if ch.isalnum())
    if not code:
        raise HTTPException(422, "Code d'appairage vide.")
    now = time.time()
    # compteur d'échecs par user — persisté (code_meta) donc correct multi-worker
    try:
        fail = _json.loads(await _ts.meta_get(uid, "pair_fail") or "{}")
        fail = fail if isinstance(fail, dict) else {}
    except Exception:
        fail = {}
    n, since = int(fail.get("n") or 0), float(fail.get("since") or 0)
    if now - since > _PAIR_TTL:
        n, since = 0, now
    if n >= _PAIR_CONFIRM_MAX:
        raise HTTPException(429, "Trop d'essais de code — réessayez dans quelques minutes.")

    def _tx():        # SQLite synchrone : en thread
        matched = ""
        with _db() as c:
            c.execute("DELETE FROM code_pairings WHERE expires_at<?", (now,))
            rows = c.execute("SELECT id, code FROM code_pairings WHERE confirmed_uid IS NULL "
                             "ORDER BY created_at").fetchall()
            for pid, pcode in rows:
                # parcours complet sans break : comparaison en durée ~constante
                if secrets.compare_digest(pcode, code) and not matched:
                    matched = pid
            if matched:
                # Seul le compte est posé : le jeton naît au poll (``code_pair_poll``).
                c.execute("UPDATE code_pairings SET confirmed_uid=? WHERE id=?", (uid, matched))
            c.commit()
        return matched
    matched = await asyncio.to_thread(_tx)
    if not matched:
        await _ts.meta_set(uid, "pair_fail", _json.dumps({"n": n + 1, "since": since}))
        raise HTTPException(404, "Code d'appairage inconnu ou expiré.")
    await _ts.meta_set(uid, "pair_fail", _json.dumps({"n": 0, "since": now}))
    return JSONResponse({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
#  Ingest (plugin → app) : lots d'events
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/code/ingest")
async def code_ingest(request: Request):
    _require_enabled()
    uid = await asyncio.to_thread(_token_uid, request)   # lecture DB : hors boucle
    body = await _body(request)
    cid = str(body.get("client") or "")
    directory = body.get("directory") or ""
    try:
        plugin_version = int(body.get("plugin") or 0)   # plugin v2+ ; absent = v1
    except (TypeError, ValueError):
        plugin_version = 0
    # revive : un client qui POUSSE est réellement vivant — lève un éventuel
    # tombstone bye (réactivation /remote on du même process opencode)
    # Route du flux temps réel : les écritures du store (seen_client,
    # apply_events = tout le lot d'events) partent en thread, comme le prune
    # ci-dessous.
    await asyncio.to_thread(_cstore.seen_client, uid, cid,
                            plugin_version=plugin_version, directory=directory,
                            revive=True)
    # lot ({"events": […]}) ou event unique ({"type", "properties"}) — les deux acceptés
    events = body.get("events")
    if not isinstance(events, list):
        events = [body] if body.get("type") else []
    forwarded = [ev for ev in events
                 if isinstance(ev, dict) and (ev.get("type") or "") in _FORWARD]
    applied = await asyncio.to_thread(_cstore.apply_events, uid, forwarded,
                                      cid=cid, directory=directory)
    for ev in forwarded:
        typ, props = ev["type"], ev.get("properties") or {}
        # session.snapshot : ne pas rediffuser les messages complets sur le SSE (lourd) —
        # la page recharge via GET /sessions/{sid}/messages.
        if typ == "session.snapshot":
            await _publish(uid, {"type": typ, "properties": {"session": props.get("session") or {}}})
        elif typ in ("permission.updated", "permission.asked"):
            # rebroadcast NORMALISÉ (v1/v2 → un seul shape pour la page)
            norm = _cstore.normalize_permission(props)
            if norm:
                await _publish(uid, {"type": "permission.updated", "properties": norm})
        elif typ == "permission.replied":
            await _publish(uid, {"type": "permission.replied", "properties": {
                "sessionID": props.get("sessionID"),
                "permissionID": props.get("permissionID") or props.get("requestID")}})
        elif typ == "question.asked":
            # rebroadcast NORMALISÉ/BORNÉ (payload piloté par le modèle)
            norm = _cstore.normalize_question(props)
            if norm:
                await _publish(uid, {"type": "question.asked", "properties": norm})
        elif typ in ("question.replied", "question.rejected"):
            await _publish(uid, {"type": typ, "properties": {
                "sessionID": props.get("sessionID"),
                "questionID": props.get("requestID") or props.get("questionID")}})
        else:
            await _publish(uid, {"type": typ, "properties": props})
    # 4 DELETE corrélés (balayage complet des tables code_*) toutes les 60 s
    # par worker : hors boucle.
    await asyncio.to_thread(_cstore.prune)
    return JSONResponse({"ok": True, "applied": applied})


# ─────────────────────────────────────────────────────────────────────────────
#  Pull (plugin ← app) : long-poll des commandes de la page
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/code/pull")
async def code_pull(request: Request):
    _require_enabled()
    uid = await asyncio.to_thread(_token_uid, request)   # lecture DB : hors boucle
    cid = str(request.query_params.get("client") or "")
    try:
        wait = min(25.0, max(0.0, float(request.query_params.get("wait") or 0)))
    except ValueError:
        wait = 0.0
    # TOUT le travail SQLite de ce long-poll part en thread (connexion par
    # thread réutilisée côté store) : claim_commands = BEGIN IMMEDIATE +
    # DELETE + 3 SELECT, ~62 fois par pull de 25 s, soit ~2,5 prises/s du
    # verrou d'écriture global par CLI connectée, en concurrence directe avec
    # la persistance des chats — sur la boucle, il la bloquerait.
    await asyncio.to_thread(_cstore.seen_client, uid, cid)

    # Long-poll cross-worker : la commande peut être posée par n'importe quel
    # worker → polling DB court (les asyncio.Event ne traversent pas les
    # process). Latence ≤ 0,4 s, ~60 SELECT indexés par pull de 25 s.
    cmds = await asyncio.to_thread(_cstore.claim_commands, uid, cid)
    deadline = time.time() + wait
    while not cmds and time.time() < deadline:
        await asyncio.sleep(min(0.4, max(0.05, deadline - time.time())))
        cmds = await asyncio.to_thread(_cstore.claim_commands, uid, cid)
    epoch = await asyncio.to_thread(_final_pull_bookkeeping, uid, cid)
    # plugin_current : la CLI compare à sa version et propose /remote update
    return JSONResponse({"commands": cmds, "epoch": epoch,
                         "plugin_current": _PLUGIN_CURRENT})


def _final_pull_bookkeeping(uid: int, cid: str):
    """seen_client de sortie + epoch, en un seul saut de thread."""
    _cstore.seen_client(uid, cid)
    return _cstore.get_epoch()


# ─────────────────────────────────────────────────────────────────────────────
#  Page : sessions (store) + pilotage + flux SSE
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/code/sessions")
def code_sessions(request: Request):
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.sessions_list(int(uid)))


@router.get("/api/code/sessions/{sid}/messages")
def code_messages(request: Request, sid: str):
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.messages_list(int(uid), sid))


@router.post("/api/code/sessions/{sid}/prompt")
async def code_prompt(request: Request, sid: str):
    """Envoie un prompt à la session opencode distante (via le pull du plugin).

    ``model`` optionnel ``{providerID, modelID}`` (sélecteur /model de la page) :
    transmis tel quel au plugin, qui le passe à ``session.promptAsync``.
    ``agent`` optionnel (``build``/``plan``/agent primaire personnalisé) : c'est
    le mode du TUI, applicable POUR CE TOUR — le plugin le valide contre les
    agents réellement exposés par la CLI avant de l'appliquer.
    """
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(422, "Prompt vide.")
    if not await _ts.active_clients(uid):
        raise HTTPException(409, "Aucune CLI opencode connectée — tapez /remote côté CLI.")
    cmd = {"id": secrets.token_urlsafe(8), "sid": sid, "kind": "prompt", "text": text}
    model = body.get("model")
    if isinstance(model, dict) and model.get("providerID") and model.get("modelID"):
        cmd["model"] = {"providerID": str(model["providerID"]), "modelID": str(model["modelID"])}
    agent = str(body.get("agent") or "").strip()
    if agent:
        known = {a["name"] for a in ((await _ts.agents_list(uid)).get("agents") or [])}
        if known and agent not in known:
            raise HTTPException(422, f"Agent inconnu ({agent}).")
        cmd["agent"] = agent
    await _ts.queue_command(uid, cmd)
    return JSONResponse({"ok": True, "queued": True})


@router.get("/api/code/commands")
def code_commands(request: Request):
    """Slash commands de la CLI connectée (poussées par le plugin à l'activation)."""
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.commands_list(int(uid)))


@router.get("/api/code/models")
def code_models(request: Request):
    """Modèles d'inférence de la CLI connectée (sélecteur /model de la page)."""
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.models_list(int(uid)))


@router.get("/api/code/agents")
def code_agents(request: Request):
    """Agents primaires de la CLI connectée (sélecteur plan/build de la page)."""
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.agents_list(int(uid)))


@router.post("/api/code/sessions/{sid}/command")
async def code_command(request: Request, sid: str):
    """Exécute une slash command opencode sur la session distante (via le pull)."""
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    command = str(body.get("command") or "").strip().lstrip("/")
    if not command:
        raise HTTPException(422, "Commande vide.")
    if command == "remote":
        raise HTTPException(422, "/remote se pilote depuis la CLI (couperait la remontée).")
    if not await _ts.active_clients(uid):
        raise HTTPException(409, "Aucune CLI opencode connectée — tapez /remote côté CLI.")
    arguments = str(body.get("arguments") or "")
    cmd_id = secrets.token_urlsafe(8)
    await _ts.queue_command(uid, {"id": cmd_id, "sid": sid, "kind": "command",
                                "command": command, "arguments": arguments})
    # trace persistante dans le transcript (« ce qui a été fait ») — le message
    # user qui remonte par ingest est l'EXPANSION du template, pas « /cmd args ».
    note = await _ts.add_note(uid, sid, cmd_id, "command", "/" + command, arguments)
    await _publish(uid, {"type": "code.note", "properties": {"sessionID": sid, "note": note}})
    return JSONResponse({"ok": True, "queued": True})


@router.post("/api/code/sessions/{sid}/abort")
async def code_abort(request: Request, sid: str):
    """Interrompt la génération en cours sur la session opencode distante."""
    _require_enabled()
    uid = int(require_user_id(request))
    if not await _ts.active_clients(uid):
        raise HTTPException(409, "Aucune CLI opencode connectée.")
    await _ts.queue_command(uid, {"id": secrets.token_urlsafe(8), "sid": sid, "kind": "abort"})
    return JSONResponse({"ok": True, "queued": True})


@router.post("/api/code/sessions/{sid}/action")
async def code_action(request: Request, sid: str):
    """Action native opencode sur la session distante (undo/redo/compact/share/…).

    Exécutée par le plugin via les endpoints session d'opencode — PAS via une
    slash command (les natives ne sont pas dans command.list()).
    """
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    action = str(body.get("action") or "").strip()
    if action not in _ACTIONS:
        raise HTTPException(422, f"Action inconnue ({action or 'vide'}).")
    if not await _ts.active_clients(uid):
        raise HTTPException(409, "Aucune CLI opencode connectée — tapez /remote côté CLI.")
    if action == "delete":
        # un plugin < 7 droppe silencieusement l'action → faux succès ; gate sur
        # la CLI PROPRIÉTAIRE de la session (pas le min global, multi-CLI mixte)
        owner = await _ts.session_owner(uid, sid)
        if await _ts.client_plugin_version(uid, owner) < 7:
            raise HTTPException(409, "Le plugin elpis-remote v7 est requis pour supprimer — tapez /remote update côté CLI.")
    cmd_id = secrets.token_urlsafe(8)
    await _ts.queue_command(uid, {"id": cmd_id, "sid": sid, "kind": "action", "action": action})
    if action != "delete":
        # trace persistante — les actions natives ne laissent aucun message user.
        # (inutile pour delete : la session et ses notes disparaissent juste après)
        note = await _ts.add_note(uid, sid, cmd_id, "action", "/" + action)
        await _publish(uid, {"type": "code.note", "properties": {"sessionID": sid, "note": note}})
    return JSONResponse({"ok": True, "queued": True})


@router.get("/api/code/clients")
def code_clients(request: Request):
    """CLI actives de l'utilisateur — ciblage de /new (une CLI connectée sans
    session stockée est sinon invisible de la page)."""
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.clients_list(int(uid)))


@router.post("/api/code/clients/{cid}/disconnect")
async def code_client_disconnect(request: Request, cid: str):
    """Déconnecte une CLI depuis la page : le plugin fait stop() (bye + reprise
    auto désactivée — l'utilisateur réactive avec /remote côté CLI).

    Commande sans session, STRICTEMENT ciblée (comme /new) : déconnecter la
    mauvaise machine serait pire que ne rien faire.
    """
    _require_enabled()
    uid = int(require_user_id(request))
    if cid not in await _ts.active_clients(uid):
        raise HTTPException(409, "Cette CLI n'est plus connectée.")
    if await _ts.client_plugin_version(uid, cid) < 7:
        # un plugin < 7 droppe silencieusement le kind → faux succès
        raise HTTPException(409, "Le plugin elpis-remote v7 est requis pour déconnecter — tapez /remote update côté CLI.")
    await _ts.queue_command(uid, {"id": secrets.token_urlsafe(8), "sid": "", "kind": "disconnect",
                                "target": cid})
    return JSONResponse({"ok": True, "queued": True, "client": cid})


@router.post("/api/code/clients/{cid}/exit")
async def code_client_exit(request: Request, cid: str):
    """/exit depuis la page : ferme le process opencode proprement (app_exit
    TUI, fallback process.exit) — le bye part à la sortie, badge hors ligne
    immédiat. Ciblage STRICT, comme disconnect."""
    _require_enabled()
    uid = int(require_user_id(request))
    if cid not in await _ts.active_clients(uid):
        raise HTTPException(409, "Cette CLI n'est plus connectée.")
    if await _ts.client_plugin_version(uid, cid) < 7:
        # un plugin < 7 droppe silencieusement le kind → faux succès
        raise HTTPException(409, "Le plugin elpis-remote v7 est requis pour /exit — tapez /remote update côté CLI.")
    await _ts.queue_command(uid, {"id": secrets.token_urlsafe(8), "sid": "", "kind": "exit",
                                "target": cid})
    return JSONResponse({"ok": True, "queued": True, "client": cid})


@router.post("/api/code/new")
async def code_new(request: Request):
    """Crée une nouvelle session opencode sur une CLI connectée.

    Commande SANS session (sid vide), donc impossible à router par propriétaire
    comme les autres : ciblage STRICT d'un client (``target``) — jamais reroutée
    vers une autre machine (elle créerait la session dans le mauvais répertoire).
    Pas de note : les notes sont par-session et la session n'existe pas encore.
    """
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    target = str(body.get("client") or "")
    active = await _ts.active_clients(uid)
    if not active:
        raise HTTPException(409, "Aucune CLI opencode connectée — tapez /remote côté CLI.")
    if not target:
        if len(active) > 1:
            raise HTTPException(409, "Plusieurs CLI connectées — précisez la CLI cible.")
        target = active[0]
    elif target not in active:
        raise HTTPException(409, "Cette CLI n'est plus connectée.")
    if await _ts.client_plugin_version(uid, target) < 13:
        # v5 droppe l'action sans sid ; v6 crée la session SANS basculer le TUI ;
        # v7→v12 se contentent du raccourci `session.new` du TUI — or opencode ne
        # matérialise la session qu'au PREMIER message : rien n'apparaît dans
        # la page. Seul le v13 crée réellement la session puis y bascule le TUI.
        # 409 explicite plutôt qu'un demi-succès invisible.
        raise HTTPException(409, "Le plugin elpis-remote v13 est requis pour créer une session "
                                 "depuis la page — tapez /remote update côté CLI.")
    await _ts.queue_command(uid, {"id": secrets.token_urlsafe(8), "sid": "", "kind": "action",
                                "action": "new", "target": target})
    return JSONResponse({"ok": True, "queued": True, "client": target})


@router.delete("/api/code/sessions/{sid}")
def code_dismiss(request: Request, sid: str):
    """Retire une session de la vue (local — ne touche pas la session opencode)."""
    _require_enabled()
    uid = require_user_id(request)
    _cstore.dismiss_session(int(uid), sid)
    return JSONResponse({"ok": True})


@router.post("/api/code/bye")
async def code_bye(request: Request):
    """Déconnexion propre (dispose du plugin) : badge « hors ligne » immédiat,
    sans attendre le TTL de 40 s (gardé en filet pour les kill -9)."""
    _require_enabled()
    uid = _token_uid(request)
    body = await _body(request)
    cid = str(body.get("client") or "")
    await _ts.client_bye(uid, cid)
    await _publish(uid, {"type": "client.disconnected", "properties": {"client": cid}})
    return JSONResponse({"ok": True})


@router.post("/api/code/sessions/{sid}/rename")
async def code_rename(request: Request, sid: str):
    """Renomme la session opencode ELLE-MÊME (session.update côté plugin) — pas
    d'override local : le round-trip session.updated met à jour store + SSE."""
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    title = " ".join(str(body.get("title") or "").split())
    if not title or len(title) > 200:
        raise HTTPException(422, "Titre vide ou trop long (200 caractères max).")
    if not await _ts.active_clients(uid):
        raise HTTPException(409, "Aucune CLI opencode connectée — tapez /remote côté CLI.")
    if await _ts.min_plugin_version(uid) < 5:
        # un plugin v4 ignorerait silencieusement le kind → faux succès
        raise HTTPException(409, "Le plugin elpis-remote v5 est requis pour renommer — tapez /remote update côté CLI.")
    await _ts.queue_command(uid, {"id": secrets.token_urlsafe(8), "sid": sid, "kind": "rename",
                                "title": title})
    return JSONResponse({"ok": True, "queued": True})


@router.get("/api/code/sessions/{sid}/permissions")
def code_permissions(request: Request, sid: str):
    """Demandes de validation opencode en attente (bannière de la page)."""
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.permissions_list(int(uid), sid))


@router.post("/api/code/sessions/{sid}/permissions/{pid}")
async def code_permission_reply(request: Request, sid: str, pid: str):
    """Répond à une demande de validation (once/always/reject → CLI via le pull)."""
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    response = str(body.get("response") or "").strip()
    if response not in ("once", "always", "reject"):
        raise HTTPException(422, f"Réponse invalide ({response or 'vide'}) — once, always ou reject.")
    if not await _ts.active_clients(uid):
        raise HTTPException(409, "Aucune CLI opencode connectée — tapez /remote côté CLI.")
    await _ts.queue_command(uid, {"id": secrets.token_urlsafe(8), "sid": sid, "kind": "permission",
                                "permissionID": pid, "response": response})
    return JSONResponse({"ok": True, "queued": True})


@router.get("/api/code/sessions/{sid}/questions")
def code_questions(request: Request, sid: str):
    """Questions de l'outil ``question`` en attente (bannière de la page)."""
    _require_enabled()
    uid = require_user_id(request)
    return JSONResponse(_cstore.questions_list(int(uid), sid))


# Bornes de la réponse (une réponse = un tableau de libellés PAR question).
_QUESTION_MAX_ANSWERS = _cstore.QUESTION_MAX_QUESTIONS
_QUESTION_MAX_LABELS = _cstore.QUESTION_MAX_OPTIONS
_QUESTION_MAX_LABEL_LEN = _cstore.QUESTION_MAX_TEXT


@router.post("/api/code/sessions/{sid}/questions/{qid}")
async def code_question_reply(request: Request, sid: str, qid: str):
    """Répond à une question de l'outil ``question`` (→ CLI via le pull).

    Body : ``{"answers": [["Postgres"], ["oui", "avec tests"]]}`` — un tableau
    de libellés PAR question, dans l'ordre (shape ``QuestionReply`` d'opencode :
    « each answer is an array of selected labels ») ; ou ``{"reject": true}``
    pour refuser (le tour reprend sans réponse). Un libellé libre (saisie
    « custom ») est un libellé comme un autre.
    """
    _require_enabled()
    uid = int(require_user_id(request))
    body = await _body(request)
    reject = bool(body.get("reject"))
    answers = None
    if not reject:
        raw = body.get("answers")
        if not isinstance(raw, list) or not raw or len(raw) > _QUESTION_MAX_ANSWERS:
            raise HTTPException(422, "Réponse invalide — `answers` doit être une liste (une entrée par question).")
        answers = []
        for a in raw:
            if isinstance(a, str):
                a = [a]
            if not isinstance(a, list) or len(a) > _QUESTION_MAX_LABELS:
                raise HTTPException(422, "Réponse invalide — chaque entrée est une liste de libellés.")
            labels = [str(x).strip()[:_QUESTION_MAX_LABEL_LEN] for x in a
                      if isinstance(x, (str, int, float)) and str(x).strip()]
            answers.append(labels)
        if not any(answers):
            raise HTTPException(422, "Réponse vide — choisissez une option ou saisissez un texte.")
    if not await _ts.active_clients(uid):
        raise HTTPException(409, "Aucune CLI opencode connectée — tapez /remote côté CLI.")
    if await _ts.min_plugin_version(uid) < 14:
        # un greffon ≤ v13 ignorerait silencieusement le kind → faux succès et
        # question restée bloquante côté CLI
        raise HTTPException(409, "Le plugin elpis-remote v14 est requis pour répondre aux questions — "
                                 "tapez /remote update côté CLI.")
    cmd = {"id": secrets.token_urlsafe(8), "sid": sid, "kind": "question", "questionID": qid}
    if reject:
        cmd["response"] = "reject"
    else:
        cmd["answers"] = answers
    await _ts.queue_command(uid, cmd)
    return JSONResponse({"ok": True, "queued": True})


# Types de CONTRÔLE du bus relayés tels quels au navigateur (le reste du bus
# est enveloppé ``code.event``). Ne pas les filtrer : sans le
# ``session_expired`` de la revalidation, la cause d'une révocation, le
# ``worker_recycling`` d'une évacuation ou l'``error`` « trop de flux », la
# page voit une fin muette et se reconnecte en boucle.
_STREAM_CONTROL_TYPES = frozenset({"session_expired", "worker_recycling", "error"})


def _render_code_event(payload):
    """Texte SSE d'un message du bus pour la page Code (``None`` = filtré).
    Appelé UNE fois par message et par client, directement sur le dict du bus
    (sans décodage/ré-encodage)."""
    if not isinstance(payload, dict):
        return None
    kind = payload.get("type")
    if kind == "code.event":
        return _json.dumps(payload.get("data") or {}, ensure_ascii=False)
    if kind in _STREAM_CONTROL_TYPES:
        # Enveloppe distincte des events opencode (qui ont eux aussi un
        # ``type``) : le front ne peut pas les confondre.
        return _json.dumps({"__control": payload}, ensure_ascii=False)
    return None


def _stream_gen(uid: int, validity_check=None):
    """SSE de la page : events ``code.event`` du bus multi-worker + contrôle."""
    return pipeline_events.listen(uid, validity_check=validity_check,
                                  render=_render_code_event)


@router.get("/api/code/stream")
async def code_stream(request: Request):
    _require_enabled()
    uid = require_user_id(request)
    # Revalidation périodique de la session (``stream_session_still_valid``) :
    # sans elle, une session expirée garderait transcript et demandes de
    # permission en direct sans limite. Valeurs capturées au handshake (le
    # scope SSE ne revoit jamais le cookie).
    _login_ts = request.session.get("_login_ts")
    _sid = request.session.get("_sid")
    _uid_int = int(uid)

    def _still_valid() -> bool:
        return stream_session_still_valid(_uid_int, _login_ts, _sid)

    # import à l'appel : ``routes_events`` importe ``routes._state``, dont le paquet charge ce module (cycle)
    from shared_infra.observability.routes_events import _make_sse_response
    return _make_sse_response(_stream_gen(_uid_int, validity_check=_still_valid))
