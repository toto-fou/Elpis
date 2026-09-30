# SPDX-License-Identifier: MIT
"""PUT /api/admin/system-prompts/{catégorie} : des enregistrements simultanés
aboutissent tous, sans fichier intermédiaire partagé ni reste (2026-09-29)."""
from __future__ import annotations

import asyncio

import httpx
from fastapi import FastAPI


async def test_enregistrements_simultanes(tmp_path, monkeypatch):
    from shared_infra.routes.admin import system_prompts as sp
    from shared_infra.routes.admin._state import admin_router
    monkeypatch.setattr(sp, "_SYSTEM_P_DIR", tmp_path)
    monkeypatch.setattr(sp, "_require_admin", lambda request: None)
    (tmp_path / "ESSAI.md").write_text("v0\n")
    app = FastAPI()
    app.include_router(admin_router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://admin") as ac:
        reps = await asyncio.gather(*(ac.put("/api/admin/system-prompts/ESSAI",
                                             json={"content": f"version {i}"}) for i in range(60)))
    assert [r.status_code for r in reps] == [200] * 60
    assert (tmp_path / "ESSAI.md").read_text().startswith("version ")
    assert not list(tmp_path.glob("*.tmp"))
