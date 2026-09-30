# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_run_automation_2026_09_13.py — exécution d'un script
d'automatisation SUR la cible depuis Elpis (point 11), matrice de machines +
notification (point 13), outil ``desktop_run_automation``.
L'agent est un faux (_agent_req monkeypatché) qui simule put/run/status/get.
"""
from __future__ import annotations

import base64
import json

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from llm_core.tools import desktop_tools as dt

FAKE_TGT = {"name": "vm1", "agent_url": "http://agent", "os": "windows"}
FAKE_TGT2 = {"name": "vm2", "agent_url": "http://agent2", "os": "windows"}


class FakeAgent:
    """Simule l'agent : dépôt, lancement (fini après N sondages), rapport."""
    def __init__(self, code=0, polls_before_done=1, fail_target=None):
        self.calls = []
        self.code = code
        self.polls = polls_before_done
        self.fail_target = fail_target
        self._n = {}

    def __call__(self, tgt, endpoint, payload=None, method="POST", timeout=None):
        self.calls.append((tgt["name"], endpoint, payload))
        if tgt["name"] == self.fail_target:
            return {"error": "agent_unreachable", "message": "injoignable"}
        if endpoint == "/put_file":
            return {"ok": True, "path": payload["path"]}
        if endpoint == "/run_script":
            return {"ok": True, "run_id": "r-" + tgt["name"]}
        if endpoint.startswith("/run_status"):
            k = tgt["name"]
            self._n[k] = self._n.get(k, 0) + 1
            running = self._n[k] <= self.polls
            return {"ok": True, "run_id": "r-" + k, "running": running, "code": None if running else self.code,
                    "report_dir": "" if running else "rapports/x-1", "summary": "" if running else "OK — 2 étape(s)", "log": ["l1"]}
        if endpoint.startswith("/get_file"):
            doc = {"summary": "OK — 2 étape(s)", "exit_code": self.code, "ok": 2, "failed": 0,
                   "steps": [{"index": 1, "label": "clic A", "ok": True, "line": 9}], "healed": [{"index": 1, "by": "name", "suggest": 'auto_id="a"'}]}
            return {"ok": True, "content_b64": base64.b64encode(json.dumps(doc).encode()).decode()}
        if endpoint == "/run_stop":
            return {"ok": True, "running": False}
        return {"ok": True}


@pytest.fixture
def agent(monkeypatch):
    fa = FakeAgent()
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": {"vm1": FAKE_TGT, "vm2": FAKE_TGT2, "": FAKE_TGT}.get(target))
    monkeypatch.setattr(dt, "_agent_req", fa)
    return fa


@pytest.fixture()
def client(monkeypatch, agent):
    import shared_infra.desktop.routes as rt
    import shared_infra.routes  # noqa: F401 — chef d'orchestre d'abord (import circulaire)

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)
    monkeypatch.setattr(rt, "require_user_id", _fake_uid)
    monkeypatch.setattr(rt, "_username_for", lambda uid: f"user{uid}")
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


_H = {"x-test-user": "1"}


def test_push_start_status_via_les_routes(client, agent):
    r = client.post("/api/desktop/run-automation",
                    json={"target": "vm1", "name": "Flux X", "code": "print(1)\n", "libs": {"lib/a.py": "x=1", "../bad.py": "x"},
                          "assets": {"assets/i.png": "aGk="}, "dry_run": True, "vision": False}, headers=_H)
    assert r.status_code == 200 and r.json()["run_id"] == "r-vm1"
    eps = [(e, p) for _, e, p in agent.calls]
    assert ("/put_file", {"path": "flux-x.py", "content": "print(1)\n"}) in eps
    assert ("/put_file", {"path": "lib/a.py", "content": "x=1"}) in eps and not any(p and p.get("path") == "../bad.py" for _, p in eps)
    assert ("/put_file", {"path": "assets/i.png", "content_b64": "aGk="}) in eps
    run = next(p for e, p in eps if e == "/run_script")
    assert run["name"] == "flux-x" and run["dry_run"] is True and "elpis_url" not in run
    st = client.get("/api/desktop/run-automation/status", params={"target": "vm1", "run_id": "r-vm1"}, headers=_H).json()
    assert st["running"] is True and "report" not in st
    st = client.get("/api/desktop/run-automation/status", params={"target": "vm1", "run_id": "r-vm1"}, headers=_H).json()
    assert st["running"] is False and st["report"]["healed"][0]["suggest"] == 'auto_id="a"' and st["report"]["steps"][0]["line"] == 9
    assert client.post("/api/desktop/run-automation", json={"target": "vm1", "code": ""}, headers=_H).status_code == 400
    f = client.get("/api/desktop/run-file", params={"target": "vm1", "path": "rapports/x-1/rapport.json"}, headers=_H)
    assert f.status_code == 200 and f.headers["content-type"].startswith("application/json")
    assert client.get("/api/desktop/run-file", params={"target": "vm1", "path": "../x"}, headers=_H).status_code == 400
    assert client.post("/api/desktop/run-automation/stop", json={"target": "vm1", "run_id": "r-vm1"}, headers=_H).status_code == 200


def test_matrice_sequentielle_et_notification(monkeypatch, agent):
    notes = []
    import shared_infra.notifications.store as ns
    monkeypatch.setattr(ns, "create_notification", lambda uid, kind, title, body="", ref_type="", ref_id=None: notes.append((uid, kind, title, body)) or 1)
    monkeypatch.setattr(dt.time, "sleep", lambda s: None)
    agent.fail_target = "vm2"
    doc = dt.run_automation_core("u", ["vm1", "vm2"], "Flux", "print(1)", timeout_s=30, notify_user_id=5)
    assert doc["targets"] == 2 and doc["ok_count"] == 1 and doc["summary"] == "1/2 cible(s) réussie(s)"
    r1, r2 = doc["results"]
    assert r1["target"] == "vm1" and r1["ok"] and r1["steps_ok"] == 2 and r1["healed"] == 1 and r1["report_dir"] == "rapports/x-1"
    assert r2["target"] == "vm2" and not r2["ok"] and r2["error"] == "agent_unreachable"
    assert notes and notes[0][0] == 5 and notes[0][1] == "automation" and "1/2" in notes[0][2] and "vm2 : ÉCHEC" in notes[0][3]


def test_matrice_timeout_arrete_l_execution(monkeypatch, agent):
    agent.polls = 999
    ticks = iter(range(0, 10_000, 20))
    monkeypatch.setattr(dt.time, "time", lambda: float(next(ticks)))
    monkeypatch.setattr(dt.time, "sleep", lambda s: None)
    doc = dt.run_automation_core("u", ["vm1"], "Flux", "print(1)", timeout_s=60)
    assert doc["results"][0]["error"] == "timeout" and any(e == "/run_stop" for _, e, _ in agent.calls)


def test_outil_desktop_run_automation_enregistre(monkeypatch, agent):
    import inspect
    tools = {}

    class M:
        def tool(self, *a, **kw):
            def deco(fn):
                tools[kw.get("name") or fn.__name__] = fn
                return fn
            return deco
    dt.register(M())
    fn = tools.get("desktop_run_automation")
    assert fn is not None, "outil exposé à la famille desktop"
    params = inspect.signature(fn).parameters
    assert {"name", "code", "targets", "dry_run", "trace", "timeout_s"} <= set(params)
    monkeypatch.setattr(dt, "get_username", lambda ctx: "u")
    monkeypatch.setattr(dt.time, "sleep", lambda s: None)
    out = fn(None, name="Flux", code="print(1)", targets="vm1")
    assert out["ok_count"] == 1
    assert fn(None, name="absent-de-la-sandbox", code="", targets="vm1")["error"] == "no_code"



def test_run_file_html_telecharge_png_en_ligne_et_points_de_suspension(client, agent):
    """Relecture du 14/09 : un .html n'est jamais servi en ligne (origine de l'app) ;
    un nom de capture contenant « ... » reste accessible ; ``..`` en segment refusé."""
    h = client.get("/api/desktop/run-file", params={"target": "vm1", "path": "assets/x.html"}, headers=_H)
    assert h.status_code == 200 and h.headers["content-type"].startswith("application/octet-stream")
    assert "attachment" in h.headers["content-disposition"] and "sandbox" in h.headers["content-security-policy"]
    p = client.get("/api/desktop/run-file", params={"target": "vm1", "path": "rapports/x-1/clic-Enregistrer-sous...-menuitem.png"}, headers=_H)
    assert p.status_code == 200 and p.headers["content-type"] == "image/png"
    for bad in ("../x.png", "rapports/../../x.png", "/etc/passwd", "C:/Windows/x.png"):
        assert client.get("/api/desktop/run-file", params={"target": "vm1", "path": bad}, headers=_H).status_code == 400, bad


def test_run_automation_repeat_mal_forme_pas_de_500(client, agent):
    r = client.post("/api/desktop/run-automation", json={"target": "vm1", "name": "f", "code": "print(1)", "repeat": "abc", "vision": False}, headers=_H)
    assert r.status_code == 200
    run = [p for _, e, p in agent.calls if e == "/run_script"][-1]
    assert run["repeat"] == 0
