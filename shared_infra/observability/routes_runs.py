# SPDX-License-Identifier: MIT
"""shared_infra/observability/routes_runs.py — exécutions d'un compte (L5.3).

* ``GET /api/runs/{id}`` : la ligne ``runs`` et ses exécutions filles ;
* ``GET /api/runs/{id}/timeline`` : chronologie (tours LLM, appels d'outils
  avec argument principal et extrait du résultat, sous-exécutions) ;
* ``GET /api/runs/{id}/export`` : la même, filles comprises, en JSON
  téléchargeable, secrets masqués.

Réservé au compte propriétaire : un identifiant inconnu ou d'un autre compte
répond 404, sans distinction (pas d'oracle). La vue de l'administrateur vit
dans la console (L5.7).
"""
from __future__ import annotations

import asyncio
import json
import re

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from shared_infra.observability import runs_timeline as T
from shared_infra.observability.runs import get_run
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

_ID = re.compile(r"[a-z]{1,16}-[A-Za-z0-9_-]{1,64}")


def _run_du_compte(request: Request, run_id: str) -> dict:
    uid = require_user_id(request)
    if not _ID.fullmatch(run_id or ""):
        raise HTTPException(404, "Exécution introuvable")
    run = get_run(run_id)
    if not T.run_accessible(run, uid):
        raise HTTPException(404, "Exécution introuvable")
    assert run is not None
    return run


@router.get("/api/runs/{run_id}")
async def api_run(request: Request, run_id: str):
    run = await asyncio.to_thread(_run_du_compte, request, run_id)
    run["children"] = await asyncio.to_thread(T._enfants, run["id"])
    return JSONResponse(run)


@router.get("/api/runs/{run_id}/timeline")
async def api_run_timeline(request: Request, run_id: str):
    run = await asyncio.to_thread(_run_du_compte, request, run_id)
    return JSONResponse(await asyncio.to_thread(T.timeline, run))


@router.get("/api/runs/{run_id}/export")
async def api_run_export(request: Request, run_id: str):
    run = await asyncio.to_thread(_run_du_compte, request, run_id)
    corps = await asyncio.to_thread(T.export, run)
    return Response(json.dumps(corps, ensure_ascii=False, indent=2, default=str),
                    media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="execution-{run["id"]}.json"',
                             "Cache-Control": "no-store"})


__all__: list = []
