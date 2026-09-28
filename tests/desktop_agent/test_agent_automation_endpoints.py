# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_agent_automation_endpoints.py — l'agent dépose,
exécute et rapatrie les scripts d'automatisation (put_file / get_file /
list_files / run_script / run_status / run_stop), bornés à ``automations/``.
Le serveur est chargé sous alias (comme test_agent_server) ; ``run_script``
lance un VRAI ``python -m elpis_auto`` sur un script sans Session (aucun
backend), assez pour vérifier le suivi et la détection du dossier de rapport.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time

import pytest

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


@pytest.fixture(scope="module")
def srv(tmp_path_factory):
    saved_path = list(sys.path)
    saved_mods = set(sys.modules)
    sys.path.insert(0, _AGENT)
    try:
        spec = importlib.util.spec_from_file_location("agent_server_auto_test", os.path.join(_AGENT, "server.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        # automations/ dans un dossier temporaire : rien n'est écrit dans le dépôt
        from pathlib import Path
        mod._AUTOMATIONS = Path(str(tmp_path_factory.mktemp("automations")))
        yield mod
    finally:
        sys.path[:] = saved_path
        for name in list(sys.modules):
            if name not in saved_mods and name.split(".")[0] in ("backends", "normalize", "agent_server_auto_test"):
                sys.modules.pop(name, None)


@pytest.fixture
def client(srv):
    from fastapi.testclient import TestClient
    return TestClient(srv.app)


def test_put_get_list_bornes_a_automations(client):
    r = client.post("/put_file", json={"path": "essai.py", "content": "print('x')\n"})
    assert r.status_code == 200 and r.json()["size"] == 11
    r = client.post("/put_file", json={"path": "assets/a.png", "content_b64": "iVBORw0KGgo="})
    assert r.status_code == 200
    assert client.post("/put_file", json={"path": "../evil.py", "content": "x"}).status_code == 400
    assert client.post("/put_file", json={"path": "C:/x.py", "content": "x"}).status_code == 400
    assert client.post("/put_file", json={"path": "z.py"}).status_code == 400
    g = client.get("/get_file", params={"path": "essai.py"})
    assert g.status_code == 200 and g.json()["content_b64"]
    assert client.get("/get_file", params={"path": "absent.py"}).status_code == 404
    assert client.get("/get_file", params={"path": "../server.py"}).status_code == 400
    ls = client.get("/list_files", params={"path": ""}).json()
    assert {i["name"] for i in ls["items"]} >= {"essai.py", "assets"}


def test_run_script_suivi_et_rapport(client, srv):
    # script qui écrit un faux rapport et une ligne « … → rapports\x » comme le runtime
    code = (
        "import os, json\n"
        "os.makedirs('rapports/essai-x', exist_ok=True)\n"
        "json.dump({'summary': 'OK — 0 étape(s)', 'steps': [], 'exit_code': 0}, open('rapports/essai-x/rapport.json', 'w'))\n"
        "print('OK — 0 étape(s)  →  rapports\\\\essai-x')\n"
        "raise SystemExit(0)\n"
    )
    client.post("/put_file", json={"path": "essai.py", "content": code})
    r = client.post("/run_script", json={"name": "essai", "dry_run": True})
    assert r.status_code == 200
    run_id = r.json()["run_id"]
    for _ in range(80):
        st = client.get("/run_status", params={"run_id": run_id}).json()
        if not st["running"]:
            break
        time.sleep(0.15)
    assert st["running"] is False and st["code"] == 0, st
    assert st["report_dir"] == "rapports/essai-x" and "OK" in st["summary"]
    assert any("→" in l for l in st["log"])
    g = client.get("/get_file", params={"path": "rapports/essai-x/rapport.json"})
    assert g.status_code == 200
    assert client.get("/run_status", params={"run_id": "nope"}).status_code == 404
    assert client.post("/run_script", json={"name": "absent"}).status_code == 404


def test_run_stop(client):
    client.post("/put_file", json={"path": "long.py", "content": "import time\ntime.sleep(30)\n"})
    run_id = client.post("/run_script", json={"name": "long.py"}).json()["run_id"]
    time.sleep(0.3)
    st = client.post("/run_stop", json={"run_id": run_id}).json()
    for _ in range(40):
        st = client.get("/run_status", params={"run_id": run_id}).json()
        if not st["running"]:
            break
        time.sleep(0.1)
    assert st["running"] is False and st["code"] != 0



def test_une_note_avec_fleche_ne_detourne_pas_le_dossier_de_rapport(client, srv):
    """Relecture du 14/09 : seule la ligne de FIN (rapport.json écrit) désigne le dossier."""
    code = (
        "import os, json, sys\n"
        "print('  · étape A  →  étape B')\n"
        "os.makedirs('rapports/vrai-1', exist_ok=True)\n"
        "json.dump({'summary': 'OK', 'steps': [], 'exit_code': 0}, open('rapports/vrai-1/rapport.json', 'w'))\n"
        "print('OK — 1 étape(s)  →  rapports/vrai-1')\n"
        "print('  · après  →  ailleurs')\n"
        "raise SystemExit(0)\n"
    )
    client.post("/put_file", json={"path": "fleche.py", "content": code})
    run_id = client.post("/run_script", json={"name": "fleche"}).json()["run_id"]
    for _ in range(80):
        st = client.get("/run_status", params={"run_id": run_id}).json()
        if not st["running"]:
            break
        time.sleep(0.15)
    assert st["report_dir"] == "rapports/vrai-1" and st["summary"].startswith("OK"), st
