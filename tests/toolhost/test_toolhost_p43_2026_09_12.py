# SPDX-License-Identifier: MIT
"""P4.3 (2026-09-12) — familles liées à l'app servies EN PROCESSUS (MCP interne
``elpis-app``), scission ``skill``/``skill_run``, registre par source, magasin
mémoire, miroir des skills, actifs distants."""
from __future__ import annotations

import asyncio
import io
import json
import os
import tarfile
from pathlib import Path

import pytest
from fastapi import FastAPI, Request

from llm_core.engine import tool_dispatch as _tool_dispatch
from shared_infra.accounts import identity as I

# ── Familles ────────────────────────────────────────────────────────────────

def test_table_des_familles_scindee():
    from shared_infra.mcp import families as F
    assert "skill_run" in F.FAMILY_NAMES and F.FAMILY_CATEGORY["skill_run"] == "skill"
    assert F.FAMILY_REGISTER_FN == {"skill": "register_library", "skill_run": "register_run"}
    assert set(F.SANDBOX_FAMILIES) | set(F.APP_FAMILIES) == set(F.FAMILY_NAMES)
    assert "skill_run" not in F.opencode_families("all")          # jamais à opencode (comme fs/shell)
    assert F.opencode_families() == ["git", "browser", "desktop"]


def test_skill_scindee_en_deux_enregistrements():
    from fastmcp import FastMCP

    from llm_core.tools import skill_tools as SK
    lib, run = FastMCP("lib"), FastMCP("run")
    SK.register_library(lib); SK.register_run(run)
    names_lib = {t.name for t in asyncio.run(lib.list_tools())}
    names_run = {t.name for t in asyncio.run(run.list_tools())}
    assert names_lib == {"skill_save", "skill_add_file", "ask_user", "skill_get", "skill_read_file"}
    assert names_run == {"skill_run_script"}
    both = FastMCP("both"); SK.register(both)
    assert {t.name for t in asyncio.run(both.list_tools())} == names_lib | names_run


def test_le_manifeste_de_reference_porte_les_dix_familles():
    from shared_infra.mcp import manifest as M
    raw = json.loads((Path(__file__).resolve().parents[2] / "mcp.example.json").read_text(encoding="utf-8"))
    assert M.validate_raw(raw) == []
    fams = [f for spec in raw["mcpServers"].values()
            for f in spec["x-elpis"]["families"]]
    from shared_infra.mcp.families import FAMILY_NAMES
    assert sorted(fams) == sorted(FAMILY_NAMES)      # dont skill_run
    # ``skill_run`` (exécution dans le sandbox) est servie par l'HÔTE ;
    # ``skill`` (bibliothèque liée au compte) reste dans l'app.
    roles = {f: spec["x-elpis"]["role"]
             for spec in raw["mcpServers"].values() for f in spec["x-elpis"]["families"]}
    assert roles["skill_run"] == "toolhost" and roles["skill"] == "app"


# ── MCP interne de l'app ────────────────────────────────────────────────────

@pytest.fixture
def app_manifest(tmp_path, monkeypatch):
    from shared_infra.mcp import manifest as M
    doc = {"mcpServers": {
        "elpis-tools": {"type": "http", "url": "http://127.0.0.1:1/mcp",
                        "x-elpis": {"role": "toolhost", "families": ["fs", "shell", "git", "skill_run", "browser", "desktop"]}},
        "elpis-app": {"description": "liées au compte",
                      "x-elpis": {"role": "app", "families": ["chart", "skill"]}},
    }}
    p = tmp_path / "mcp.json"; p.write_text(json.dumps(doc), encoding="utf-8")
    monkeypatch.setenv("APP_MCP_MANIFEST", str(p)); M.reload()
    yield M.load()
    M.reload()


def test_entree_app_devient_inprocess_et_la_sentinelle_se_developpe(app_manifest):
    from shared_infra.mcp import manifest as M
    e = app_manifest.get("elpis-app")
    assert e.type == "inprocess" and e.is_builtin and e.identity == "meta"
    cfgs = M.builtin_client_cfgs(["fs", "chart"])
    assert [c["type"] for c in cfgs] == ["stdio", "inprocess"]
    assert cfgs[0]["command"] == "DEFAULT_LOCAL_PYTHON" and cfgs[1]["families"] == ["chart", "skill"]
    assert all(c["filter_categories"] == ["fs", "chart"] for c in cfgs)
    from llm_core.engine.tool_catalog import _expand_builtin_configs
    out = _expand_builtin_configs([
        {"type": "stdio", "name": "Outils Locaux", "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["chart"]},
        {"type": "http", "name": "Ext", "url": "http://x/mcp"},
    ])
    assert [c.get("name") for c in out] == ["Outils Locaux", "elpis-app", "Ext"]
    assert out[1]["type"] == "inprocess"


def test_sans_entree_app_la_sentinelle_reste_seule(monkeypatch):
    monkeypatch.setenv("APP_MCP_MANIFEST", "/nonexistent/mcp.json")
    from shared_infra.mcp import manifest as M
    M.reload()
    from llm_core.engine.tool_catalog import _expand_builtin_configs
    cfg = {"type": "stdio", "name": "Outils Locaux", "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]}
    out = _expand_builtin_configs([cfg])
    assert len(out) == 1 and out[0]["command"] == "DEFAULT_LOCAL_PYTHON" and out[0]["name"] == "Outils Locaux"


def test_pool_traite_inprocess_comme_integre():
    from llm_core import _mcp_pool as P
    c = {"type": "inprocess", "name": "elpis-app", "manifest": "elpis-app", "families": ["chart"]}
    assert P._is_local_tools_cfg(c) is True
    k1 = P.MCPConnectionPool._make_key(c)
    k2 = P.MCPConnectionPool._make_key({**c, "filter_categories": ["memory"]})
    assert k1 == k2                                                 # catégories côté client
    assert P._transport_concurrency(type("MCPInProcessWrapper", (), {})()) > 1


def test_mcp_interne_sert_les_outils_graphiques_en_memoire(tmp_path, monkeypatch, app_manifest):
    """Bout-en-bout : wrapper mémoire → list_tools + call_tool avec ``_meta``
    (identité) et registre de catégories alimenté par SOURCE."""
    monkeypatch.setenv("CHART_CACHE_DIR", str(tmp_path / "charts"))
    from llm_core import _mcp_categories as C
    monkeypatch.setattr(C, "_CACHE_PATH", tmp_path / "cache.json")
    monkeypatch.setattr(C, "_registry", None)
    monkeypatch.setattr(C, "_disk_cache", {"at": 0.0, "reg": None})
    monkeypatch.setattr(C, "_sources", {})
    from llm_core._mcp_wrappers import MCPInProcessWrapper, _resolve_mcp_client
    from llm_core.tools import app_mcp
    app_mcp.reset()
    w = _resolve_mcp_client({"type": "inprocess", "name": "elpis-app", "manifest": "elpis-app", "families": ["chart"]})
    assert isinstance(w, MCPInProcessWrapper)

    async def _go():
        async with w:
            tools = await w.list_tools()
            names = {t.name for t in tools}
            assert {"chart_bar", "chart_table"} <= names and "read_file" not in names
            C.ingest_tools(tools, source="inprocess:elpis-app")
            C.ingest_tools([type("T", (), {"name": "read_file", "description": "d",
                                            "meta": {"category": {"name": "fs"}}})()], source="svc")
            r = await w.call_tool("chart_table", {"title": "t", "data": [{"a": "1"}]},
                                  meta={"username": "hugo", "user_id": "7", "chat_id": "c1"})
            return r
    r = asyncio.run(_go())
    txt = "".join(getattr(c, "text", "") for c in (getattr(r, "content", None) or []))
    assert txt and '"chart_type":"table"' in txt and '"ok":true' in txt
    # union des sources : fs (service) ET chart (interne)
    assert C.categorize("read_file") == "fs" and C.categorize("chart_bar") == "chart"
    assert C.tool_policy("chart_bar") == {} or isinstance(C.tool_policy("chart_bar"), dict)


# ── Magasin mémoire ─────────────────────────────────────────────────────────

def test_racine_memoire_dediee_par_defaut_sandbox():
    from shared_infra import config as cfg
    assert Path(cfg.MEMORY_DIR) == Path(cfg.SANDBOX_DIR)       # sans réglage : disposition inchangée
    import server.local_mcp_server as S
    assert S._memory_root() == Path(cfg.MEMORY_DIR).resolve()


# ── Miroir des skills ───────────────────────────────────────────────────────

def test_route_miroir_des_skills(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from shared_infra.routes import _helpers as H
    from shared_infra.routes._state import router
    from shared_infra.sandbox import routes_files  # noqa: F401 — enregistre la route
    from toolhost.auth import ToolhostAuthASGI
    monkeypatch.setattr(H, "SANDBOX_DIR", tmp_path)
    app = FastAPI(); app.include_router(router)
    app.add_middleware(ToolhostAuthASGI, token="svc")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, content in (("demo/SKILL.md", b"# demo"), ("demo/scripts/run.sh", b"echo hi"), ("../evil", b"x")):
            info = tarfile.TarInfo(name); info.size = len(content); tf.addfile(info, io.BytesIO(content))
    hdrs = {"Authorization": "Bearer svc", I.IDENTITY_HEADER: I.sign(I.Identity(user_id=7, username="hugo"), "svc")}
    r = TestClient(app).post("/api/sandbox/skills-mirror", headers=hdrs,
                             files={"archive": ("skills.tar.gz", buf.getvalue(), "application/gzip")})
    assert r.status_code == 200 and r.json()["files"] == 2, r.text
    assert (tmp_path / "hugo" / "skills" / "demo" / "scripts" / "run.sh").read_bytes() == b"echo hi"
    assert not (tmp_path / "evil").exists() and not (tmp_path / "hugo" / "evil").exists()


def test_push_du_miroir_inactif_en_local(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_MCP_MANIFEST", "/nonexistent/mcp.json")
    from shared_infra.mcp import manifest as M
    M.reload()
    from shared_infra.sandbox.relay import push_skills_mirror
    assert push_skills_mirror(7, tmp_path) is False


# ── Actifs distants (vision) ────────────────────────────────────────────────

def test_ensure_local_asset_rapatrie_par_le_relais(tmp_path, monkeypatch):
    from shared_infra.sandbox import relay as R
    local = tmp_path / "a" / "frame.png"

    async def _fake(uid, path, timeout_s=10.0):
        return b"PNG" if uid == 7 and path.endswith("/x.png") else None
    monkeypatch.setattr(R, "fetch_relayed_bytes", _fake)
    assert asyncio.run(_tool_dispatch._ensure_local_asset(7, str(local), "/api/playwright/screenshot/x.png")) is True
    assert local.read_bytes() == b"PNG"
    assert asyncio.run(_tool_dispatch._ensure_local_asset(7, str(tmp_path / "b.png"), "/api/playwright/screenshot/y.png")) is False
    assert asyncio.run(_tool_dispatch._ensure_local_asset(None, str(tmp_path / "c.png"), "/x")) is False
    assert asyncio.run(_tool_dispatch._ensure_local_asset(7, str(local), "/nope")) is True   # déjà présent
