# SPDX-License-Identifier: MIT
"""shared_infra/routes/admin/runs.py — console › Supervision › Exécutions (L5.7).

* ``GET /api/admin/runs/accounts`` : coût en ressources par compte sur la
  fenêtre (exécutions, jetons, temps LLM, attente, appels d'outils, fichiers,
  pics CPU / RAM de la sandbox) — jamais en monnaie (D14) ;
* ``GET /api/admin/runs`` : exécutions de premier niveau (filtres compte,
  genre, statut), les plus récentes d'abord ;
* ``GET /api/admin/runs/{id}/timeline`` et ``/export`` : la chronologie
  d'une exécution de n'importe quel compte.

Agrégats et liste : admin ou modérateur (lecture, comme le reste de la
Supervision). Chronologie et export : administrateur seul — ils montrent des
arguments et des extraits de résultats d'outils ; les secrets y sont masqués.
Les jetons d'un sous-agent vivent dans SA ligne : les sommes par compte
portent sur toutes les exécutions, le compte des exécutions sur celles de
premier niveau.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from shared_infra.db._connection import db_conn
from shared_infra.observability import runs_timeline as T
from shared_infra.observability.runs import KINDS, get_run
from shared_infra.routes.admin._state import admin_router
from shared_infra.routes.admin.observability import _require_admin, _require_staff

_ID = re.compile(r"[a-z]{1,16}-[A-Za-z0-9_-]{1,64}")
_STATUT = re.compile(r"[a-z_]{1,24}")
_COLONNES_LISTE = ("id", "kind", "user_id", "chat_id", "routine_id", "model", "engine", "started_at",
                   "ended_at", "status", "error_kind", "input_tokens", "output_tokens",
                   "cache_read_tokens", "thinking_tokens", "tool_tokens", "llm_calls", "prefill_ms", "decode_ms", "wait_ms", "tool_calls",
                   "tool_errors", "files_changed", "sandbox_cpu_peak", "sandbox_mem_peak_mb")


def _heures(h: Any) -> int:
    try:
        return max(1, min(720, int(h)))
    except (TypeError, ValueError):
        return 24


def _par_compte(hours: int) -> List[Dict[str, Any]]:
    since = time.time() - hours * 3600
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT r.user_id, u.username, "
            "SUM(CASE WHEN r.parent_id = '' THEN 1 ELSE 0 END) AS runs, "
            "SUM(CASE WHEN r.parent_id = '' AND r.status NOT IN ('ok', 'running') THEN 1 ELSE 0 END) AS failed, "
            "SUM(CASE WHEN r.kind = 'subagent' THEN 1 ELSE 0 END) AS subagents, "
            "COALESCE(SUM(r.input_tokens), 0) AS input_tokens, "
            "COALESCE(SUM(r.output_tokens), 0) AS output_tokens, "
            "COALESCE(SUM(r.thinking_tokens), 0) AS thinking_tokens, "
            "COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens, "
            "COALESCE(SUM(r.cache_creation_tokens), 0) AS cache_creation_tokens, "
            "COALESCE(SUM(r.tool_tokens), 0) AS tool_tokens, "
            "COALESCE(SUM(r.prefill_ms + r.decode_ms), 0) AS llm_ms, "
            "COALESCE(SUM(r.prefill_ms), 0) AS prefill_ms, "
            "COALESCE(SUM(r.decode_ms), 0) AS decode_ms, "
            "COALESCE(SUM(r.wait_ms), 0) AS wait_ms, "
            "COALESCE(SUM(r.tool_calls), 0) AS tool_calls, "
            "COALESCE(SUM(r.tool_errors), 0) AS tool_errors, "
            "COALESCE(SUM(r.files_changed), 0) AS files_changed, "
            "MAX(r.sandbox_cpu_peak) AS sandbox_cpu_peak, "
            "MAX(r.sandbox_mem_peak_mb) AS sandbox_mem_peak_mb, "
            "MAX(r.started_at) AS last_at "
            "FROM runs r LEFT JOIN users u ON u.id = r.user_id "
            "WHERE r.started_at > ? GROUP BY r.user_id, u.username "
            "ORDER BY llm_ms DESC, input_tokens DESC LIMIT 500", (since,)).fetchall()
    return [dict(r) for r in rows]


def _liste(hours: int, user_id: Optional[int], kind: str, status: str, limit: int) -> List[Dict[str, Any]]:
    since = time.time() - hours * 3600
    sql = ["SELECT " + ", ".join("r." + c for c in _COLONNES_LISTE) + ", u.username "
           "FROM runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.started_at > ?"]
    params: List[Any] = [since]
    if kind:
        sql.append("AND r.kind = ?")
        params.append(kind)
    else:
        sql.append("AND r.parent_id = ''")
    if user_id is not None:
        sql.append("AND r.user_id = ?")
        params.append(user_id)
    if status:
        sql.append("AND r.status = ?")
        params.append(status)
    sql.append("ORDER BY r.started_at DESC LIMIT ?")
    params.append(limit)
    with db_conn() as conn:
        return [dict(r) for r in conn.execute(" ".join(sql), tuple(params)).fetchall()]


@admin_router.get("/api/admin/runs/accounts")
async def api_admin_runs_accounts(request: Request, hours: int = 24):
    _require_staff(request)
    h = _heures(hours)
    return JSONResponse({"hours": h, "items": await asyncio.to_thread(_par_compte, h)})


@admin_router.get("/api/admin/runs")
async def api_admin_runs(request: Request, hours: int = 24, user_id: Optional[int] = None,
                         kind: str = "", status: str = "", limit: int = 200):
    _require_staff(request)
    if kind and kind not in KINDS:
        raise HTTPException(400, "Genre d'exécution inconnu")
    if status and not _STATUT.fullmatch(status):
        raise HTTPException(400, "Statut inconnu")
    items = await asyncio.to_thread(_liste, _heures(hours), user_id, kind, status,
                                    max(1, min(1000, int(limit))))
    return JSONResponse({"items": items})


def _run_admin(request: Request, run_id: str) -> Dict[str, Any]:
    uid = _require_admin(request)
    if not _ID.fullmatch(run_id or ""):
        raise HTTPException(404, "Exécution introuvable")
    run = get_run(run_id)
    if not T.run_accessible(run, uid, is_admin=True):
        raise HTTPException(404, "Exécution introuvable")
    assert run is not None
    return run


@admin_router.get("/api/admin/runs/{run_id}/timeline")
async def api_admin_run_timeline(request: Request, run_id: str):
    run = await asyncio.to_thread(_run_admin, request, run_id)
    # Vue d'un compte tiers : secrets masqués comme à l'export.
    return JSONResponse(await asyncio.to_thread(lambda: T._masquer_objet(T.timeline(run))))


@admin_router.get("/api/admin/runs/{run_id}/export")
async def api_admin_run_export(request: Request, run_id: str):
    run = await asyncio.to_thread(_run_admin, request, run_id)
    corps = await asyncio.to_thread(T.export, run)
    return Response(json.dumps(corps, ensure_ascii=False, indent=2, default=str),
                    media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="execution-{run["id"]}.json"',
                             "Cache-Control": "no-store"})


__all__: list = []
