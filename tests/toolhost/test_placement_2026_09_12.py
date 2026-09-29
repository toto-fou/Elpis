# SPDX-License-Identifier: MIT
"""P5 (2026-09-12) — placement des comptes sur les hôtes d'outils et migration
d'un sandbox entre hôtes (export/import de ``/work``)."""
from __future__ import annotations

import io
import json
import socket
import tarfile
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, File, Request, UploadFile

from shared_infra.accounts import identity as I


@pytest.fixture
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    return legacy


def test_migration_cree_la_table_et_les_affectations(db):
    from shared_infra.sandbox import placement as P
    assert P.list_placements() == [] and P.placement_of(7) is None
    P.assign(7, "a"); P.assign(8, "a"); P.assign(9, "b")
    assert P.placement_of(7) == "a" and P.counts_by_host() == {"a": 2, "b": 1}
    P.assign(7, "b")                                              # upsert
    assert P.placement_of(7) == "b" and P.counts_by_host() == {"a": 1, "b": 2}
    P.unassign(7); assert P.placement_of(7) is None


def test_affectation_automatique_au_moins_charge(db):
    from shared_infra.sandbox import placement as P
    hosts = {"a": {"url": "https://a:8765"}, "b": {"url": "https://b:8765"}, "vide": {}}
    assert P.least_loaded(hosts) == "a"                            # ordre de déclaration
    P.assign(1, "a"); P.assign(2, "a")
    assert P.least_loaded(hosts) == "b"
    assert P.host_for_user(3, hosts, "a") == "b" and P.placement_of(3) == "b"   # persistée
    assert P.host_for_user(3, hosts, "a") == "b"                   # stable
    assert P.host_for_user(4, {"a": hosts["a"]}, "a") == "a"       # un seul hôte
    P.assign(5, "disparu")
    assert P.host_for_user(5, hosts, "a") in ("a", "b")            # hôte retiré du manifeste → réaffecté


def test_relais_suit_le_placement_by_user(db, tmp_path, monkeypatch):
    from shared_infra.mcp import manifest as M
    from shared_infra.sandbox import placement as P, relay as R
    doc = {"mcpServers": {"elpis-tools": {"type": "http", "url": "http://127.0.0.1:8765/mcp", "x-elpis": {"role": "toolhost"}}},
           "sandboxHosts": {"local": {"url": "http://127.0.0.1:8765", "token": "t"},
                            "vm": {"url": "https://vm:8765", "token": "t"}},
           "placement": {"strategy": "by_user", "host": "local"}}
    p = tmp_path / "mcp.json"; p.write_text(json.dumps(doc), encoding="utf-8")
    monkeypatch.setenv("APP_MCP_MANIFEST", str(p)); M.reload()
    try:
        P.assign(7, "vm"); P.assign(8, "local")
        assert R.sandbox_host_for(7).id == "vm" and R.relay_active_for(7) is True
        assert R.sandbox_host_for(8).id == "local" and R.relay_active_for(8) is False
        h9 = R.sandbox_host_for(9)                                 # auto : moins chargé
        assert h9.id in ("local", "vm") and P.placement_of(9) == h9.id
    finally:
        M.reload()


# ── Export / import de /work ────────────────────────────────────────────────

def _hdrs(uid=7, username="hugo", token="svc"):
    return {"Authorization": f"Bearer {token}",
            I.IDENTITY_HEADER: I.sign(I.Identity(user_id=uid, username=username), token)}


@pytest.fixture
def sandbox_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from shared_infra.routes import _helpers as H
    from shared_infra.routes._state import router
    from shared_infra.sandbox import routes_files  # noqa: F401
    from toolhost.auth import ToolhostAuthASGI
    monkeypatch.setattr(H, "SANDBOX_DIR", tmp_path)
    app = FastAPI(); app.include_router(router)
    app.add_middleware(ToolhostAuthASGI, token="svc")
    return TestClient(app), tmp_path


def test_export_puis_import_de_work(sandbox_api):
    c, root = sandbox_api
    work = root / "hugo" / "work"; (work / "src").mkdir(parents=True)
    (work / "src" / "a.py").write_text("print(1)", encoding="utf-8"); (work / "README").write_text("r", encoding="utf-8")
    r = c.get("/api/sandbox/export", headers=_hdrs())
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/gzip")
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tf:
        assert sorted(tf.getnames()) == ["README", "src/a.py"]
    # import chez « zoe » (autre compte) : /work remplacé par l'agent, l'ancien
    # contenu gardé dans /work/.work-before-import-<ts>
    zwork = root / "zoe" / "work"; zwork.mkdir(parents=True); (zwork / "old.txt").write_text("x", encoding="utf-8")
    r2 = c.post("/api/sandbox/import", headers=_hdrs(uid=8, username="zoe"),
                files={"archive": ("work.tar.gz", r.content, "application/gzip")})
    assert r2.status_code == 200 and r2.json()["files"] == 2, r2.text
    assert (zwork / "src" / "a.py").read_text(encoding="utf-8") == "print(1)" and not (zwork / "old.txt").exists()
    (garde,) = [p for p in zwork.iterdir() if p.name.startswith(".work-before-import-")]
    assert (garde / "old.txt").read_text(encoding="utf-8") == "x"
    assert c.get("/api/sandbox/export").status_code == 401


def _free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@pytest.fixture
def fake_remote_host():
    """Un hôte distant minimal : reçoit l'import et enregistre ce qu'il a vu."""
    import logging

    import uvicorn

    from toolhost.auth import ToolhostAuthASGI
    seen = {}
    up = FastAPI()

    @up.post("/api/sandbox/import")
    async def imp(request: Request, archive: UploadFile = File(...)):
        data = await archive.read()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            seen["names"] = sorted(tf.getnames())
        seen["who"] = request.state.toolhost_identity.username
        return {"ok": True, "files": len(seen["names"])}
    up.add_middleware(ToolhostAuthASGI, token="svc-remote")
    names = ("uvicorn", "uvicorn.error", "uvicorn.access")
    levels = {n: logging.getLogger(n).level for n in names}
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(up, host="127.0.0.1", port=port, log_config=None))
    t = threading.Thread(target=server.run, daemon=True); t.start()
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.05)
    yield port, seen
    server.should_exit = True; t.join(timeout=5)
    for n, lvl in levels.items():
        logging.getLogger(n).setLevel(lvl)


def test_migration_local_vers_hote_distant(db, tmp_path, monkeypatch, fake_remote_host):
    port, seen = fake_remote_host
    from shared_infra.mcp import manifest as M
    from shared_infra.routes import _helpers as H
    from shared_infra.sandbox import placement as P
    monkeypatch.setattr(H, "SANDBOX_DIR", tmp_path / "sb")
    monkeypatch.setattr(H, "get_username_by_id", lambda uid: "hugo" if uid == 7 else None)
    from shared_infra.sandbox import relay as R
    monkeypatch.setattr(R, "_identity_for", lambda uid: I.Identity(user_id=uid, username="hugo"))
    work = tmp_path / "sb" / "hugo" / "work"; work.mkdir(parents=True); (work / "f.txt").write_text("1", encoding="utf-8")
    doc = {"mcpServers": {"elpis-tools": {"type": "http", "url": "http://127.0.0.1:8765/mcp", "x-elpis": {"role": "toolhost"}}},
           "sandboxHosts": {"local": {"url": "http://127.0.0.1:8765", "token": "t"},
                            "vm": {"url": f"http://127.0.0.1:{port}", "token": "svc-remote", "relay": True}},
           "placement": {"strategy": "by_user", "host": "local"}}
    p = tmp_path / "mcp.json"; p.write_text(json.dumps(doc), encoding="utf-8")
    monkeypatch.setenv("APP_MCP_MANIFEST", str(p)); M.reload()
    try:
        P.assign(7, "local")
        res = P.migrate_user(7, "vm")
        assert res["ok"] and res["moved"] and res["from"] == "local" and res["to"] == "vm" and res["files"] == 1
        assert seen == {"names": ["f.txt"], "who": "hugo"}
        assert P.placement_of(7) == "vm"
        assert P.migrate_user(7, "vm")["moved"] is False           # déjà là
    finally:
        M.reload()


def test_routes_admin_toolhosts(db, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import shared_infra.routes.admin.toolhosts as T
    from shared_infra.mcp import manifest as M
    from shared_infra.routes.admin._state import admin_router
    from shared_infra.sandbox import placement as P
    monkeypatch.setattr(T, "_require_admin", lambda request: 1)
    monkeypatch.setattr(T, "audit_event", lambda *a, **k: None)
    doc = {"mcpServers": {"elpis-tools": {"type": "http", "url": "http://127.0.0.1:8765/mcp", "x-elpis": {"role": "toolhost"}}},
           "sandboxHosts": {"a": {"url": "http://127.0.0.1:1", "token": "t"}},
           "placement": {"strategy": "by_user", "host": "a"}}
    p = tmp_path / "mcp.json"; p.write_text(json.dumps(doc), encoding="utf-8")
    monkeypatch.setenv("APP_MCP_MANIFEST", str(p)); M.reload()
    try:
        app = FastAPI(); app.include_router(admin_router)
        c = TestClient(app)
        r = c.get("/api/admin/toolhosts")
        assert r.status_code == 200
        d = r.json()
        assert d["hosts"][0]["id"] == "a" and d["hosts"][0]["reachable"] is False and d["placement"]["strategy"] == "by_user"
        assert c.post("/api/admin/toolhosts/placements/7", json={"host_id": "zz"}).status_code == 404
        assert c.post("/api/admin/toolhosts/placements/7", json={"host_id": "a"}).json()["host_id"] == "a"
        assert P.placement_of(7) == "a"
        assert c.get("/api/admin/toolhosts").json()["hosts"][0]["accounts"] == 1
        assert c.delete("/api/admin/toolhosts/placements/7").json()["ok"] and P.placement_of(7) is None
    finally:
        M.reload()
