# SPDX-License-Identifier: MIT
"""Page admin « Base de données » (chantier multi-moteurs, lot E).

    GET  /api/admin/database           état + réglages enregistrés
    POST /api/admin/database/test      tester un formulaire (sans l'enregistrer)
    POST /api/admin/database/save      enregistrer les réglages SANS basculer
    POST /api/admin/database/simulate  transfert à blanc vers la cible
    POST /api/admin/database/migrate   transférer puis basculer (tâche de fond)
    POST /api/admin/database/sqlite    revenir à un fichier SQLite neuf
    GET  /api/admin/database/job       avancement de la tâche

Le mot de passe n'est jamais rendu (``password_present``) ; vide dans un
formulaire = celui déjà enregistré.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict

from fastapi import HTTPException, Request

from shared_infra.routes._legacy import _require_admin
from shared_infra.routes.admin._state import admin_router

logger = logging.getLogger("uvicorn.error")

_ENV_KEYS = ("APP_DB_BACKEND", "APP_DB_HOST", "APP_DB_PORT", "APP_DB_NAME", "APP_DB_USER",
             "APP_DB_PASSWORD", "APP_DB_TLS")


def _saved() -> Dict[str, Any]:
    from pathlib import Path

    from shared_infra import config as cfg
    db = (cfg.read_config_json().get("database") or {})
    backend = db.get("backend") or "sqlite"
    return {"backend": backend, "host": db.get("host") or "127.0.0.1",
            "port": int(db.get("port") or 0) or None, "name": db.get("name") or "elpis",
            "user": db.get("user") or "elpis", "tls": db.get("tls") or "off",
            "password_present": bool(os.environ.get("APP_DB_PASSWORD"))
            or (Path(cfg.DB_PATH).parent / ".db_password").is_file()}


def _target(body: Dict[str, Any]) -> Dict[str, Any]:
    """Formulaire → cible de ``transfer`` (serveur uniquement)."""
    backend = str(body.get("backend") or "").strip().lower()
    backend = {"postgresql": "postgres", "mariadb": "mysql"}.get(backend, backend)
    if backend not in ("postgres", "mysql"):
        raise HTTPException(400, "Moteur : postgres ou mysql")
    host = str(body.get("host") or "").strip()
    name = str(body.get("name") or "").strip()
    user = str(body.get("user") or "").strip()
    if not host or not name or not user:
        raise HTTPException(400, "Hôte, base et utilisateur requis")
    try:
        port = int(body.get("port") or (5432 if backend == "postgres" else 3306))
    except (TypeError, ValueError):
        raise HTTPException(400, "Port invalide")
    tls = str(body.get("tls") or "off").lower()
    if tls not in ("off", "require", "verify"):
        raise HTTPException(400, "TLS : off, require ou verify")
    out = {"backend": backend, "host": host, "port": port, "name": name, "user": user,
           "tls": tls, "timeout": 30.0, "schema": None}
    if body.get("password"):
        out["password"] = str(body["password"])
    return out


@admin_router.get("/api/admin/database")
def admin_database_state(request: Request):
    _require_admin(request)
    from shared_infra.db._connection import db_info
    from shared_infra.ops import db_switch
    try:
        info = db_info()
    except Exception as exc:                        # base injoignable : la page doit s'afficher
        info = {"error": str(exc)}
    return {"active": info, "saved": _saved(),
            "env": [k for k in _ENV_KEYS if os.environ.get(k)],
            "job": db_switch.job_status()}


@admin_router.post("/api/admin/database/test")
async def admin_database_test(request: Request):
    _require_admin(request)
    target = _target(await request.json())
    from shared_infra.db.transfer import check_target
    try:
        return await asyncio.to_thread(check_target, target)
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:500]}


@admin_router.post("/api/admin/database/save")
async def admin_database_save(request: Request):
    _require_admin(request)
    target = _target(await request.json())
    from shared_infra.ops.db_switch import write_database_config
    write_database_config(target, switch=False)
    logger.info("[database] réglages enregistrés par uid=%s", request.session.get("user_id"))
    return {"ok": True, "saved": _saved()}


@admin_router.post("/api/admin/database/simulate")
async def admin_database_simulate(request: Request):
    _require_admin(request)
    target = _target(await request.json())
    from shared_infra.db import transfer as T
    try:
        return await asyncio.to_thread(T.transfer, T.active_target(), target, dry_run=True)
    except T.TransferError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:500]}


def _reloader():
    """Recharge main puis ce process (patron du toggle HTTPS)."""
    import httpx

    from shared_infra.routes.admin.lifecycle import schedule_self_reload
    loop = asyncio.get_running_loop()

    def reload():
        try:
            from shared_infra.observability.metrics import broadcast as metric_broadcast
            metric_broadcast.publish_event({
                "type": "restart", "message": "Le serveur redémarre sur sa nouvelle base "
                "de données. Reconnexion automatique...", "started_at": __import__("time").time()})
        except Exception as exc:
            logger.warning("[database] annonce du redémarrage impossible : %r", exc)
        if os.environ.get("APP_MODE", "full").lower() != "full":
            main_url = (os.environ.get("MAIN_INTERNAL_URL") or "http://127.0.0.1:8001").rstrip("/")
            try:
                httpx.post(f"{main_url}/api/admin/internal/restart-self", timeout=5.0)
            except httpx.HTTPError as exc:
                logger.warning("[database] redémarrage de main impossible : %r", exc)
        loop.call_soon_threadsafe(schedule_self_reload)

    return reload


@admin_router.post("/api/admin/database/migrate")
async def admin_database_migrate(request: Request):
    _require_admin(request)
    body = await request.json()
    target = _target(body)
    from shared_infra.ops import db_switch
    from shared_infra.db._connection import DB_BACKEND
    if not target.get("password"):
        from shared_infra import config as cfg
        pw = cfg.db_password()
        if pw:
            target["password"] = pw
    if os.environ.get("APP_DB_BACKEND"):
        raise HTTPException(409, "Moteur imposé par APP_DB_BACKEND : retirer la variable d'abord")
    logger.warning("[database] bascule %s → %s demandée par uid=%s", DB_BACKEND,
                   target["backend"], request.session.get("user_id"))
    return db_switch.start_job("migrate", target, _reloader())


@admin_router.post("/api/admin/database/sqlite")
async def admin_database_back_to_sqlite(request: Request):
    _require_admin(request)
    from shared_infra.db._connection import DB_BACKEND
    from shared_infra.ops import db_switch
    if DB_BACKEND == "sqlite":
        raise HTTPException(409, "Déjà sur SQLite")
    if os.environ.get("APP_DB_BACKEND"):
        raise HTTPException(409, "Moteur imposé par APP_DB_BACKEND : retirer la variable d'abord")
    return db_switch.start_job("sqlite", {"backend": "sqlite"}, _reloader())


@admin_router.get("/api/admin/database/job")
def admin_database_job(request: Request):
    _require_admin(request)
    from shared_infra.ops import db_switch
    return db_switch.job_status()
