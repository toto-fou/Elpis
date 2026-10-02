# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_relecture_hote_2026_09_15.py — relecture du 15/09, côté hôte
(routes du Studio + outils desktop) :

• S2  budget de la matrice : ``timeout_s`` mal formé → défaut (pas un 500), borné,
      compté APRÈS le dépôt ; l'outil tient toute la matrice sous son plafond ;
• S3  la matrice passe la vision d'Elpis (``elpis_url`` / ``elpis_token``) ;
• S4  un sondage d'état raté n'abandonne pas le suivi d'une cible ; perdu → arrêt ;
• S5  un NOM de cible inconnu est refusé (il retombait sur la cible par défaut) ;
• S6  /launch : le HTTP survit au budget de l'agent (2 × délai + marge) ;
• S9  set_value : point de l'élément transmis, pas de libellé fabriqué comme nom ;
• S10 dépôts d'annexes refusés rendus (``push_errors``) ;
• S11 slug identique au Studio + suffixe quand il masquerait un module ;
• en-tête ``X-Elpis-Timeout`` sur chaque appel à l'agent ;
• l'event ``tool_result`` du chat principal ne porte plus la liste d'éléments.
"""
from __future__ import annotations

import base64
import json

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from llm_core.tools import desktop_tools as dt

TGTS = {"vm1": {"name": "vm1", "agent_url": "http://agent", "os": "windows"},
        "vm2": {"name": "vm2", "agent_url": "http://agent2", "os": "windows"}}


def _fake_resolve(target, username=""):
    """Comme la config : nom inconnu → cible par défaut (vm1)."""
    return TGTS.get(target) or TGTS["vm1"]


class Agent:
    def __init__(self, polls=1, status_errors=0, put_fail=()):
        self.calls = []
        self.polls = polls
        self.status_errors = status_errors
        self.put_fail = set(put_fail)
        self._n = {}

    def __call__(self, tgt, endpoint, payload=None, method="POST", timeout=None):
        self.calls.append((tgt["name"], endpoint, payload))
        if endpoint == "/put_file":
            if payload["path"] in self.put_fail:
                return {"ok": False, "error": "agent_http_error", "message": "fichier trop volumineux", "status": 413}
            return {"ok": True}
        if endpoint == "/run_script":
            return {"ok": True, "run_id": "r-" + tgt["name"]}
        if endpoint.startswith("/run_status"):
            if self.status_errors:
                self.status_errors -= 1
                return {"ok": False, "error": "agent_timeout", "message": "délai", "retryable": True}
            k = tgt["name"]
            self._n[k] = self._n.get(k, 0) + 1
            running = self._n[k] <= self.polls
            return {"ok": True, "running": running, "code": None if running else 0,
                    "report_dir": "" if running else "rapports/x", "summary": "" if running else "OK"}
        if endpoint.startswith("/get_file"):
            doc = {"summary": "OK", "ok": 1, "failed": 0, "steps": [], "healed": []}
            return {"ok": True, "content_b64": base64.b64encode(json.dumps(doc).encode()).decode()}
        return {"ok": True}

    def eps(self, name):
        return [p for _, e, p in self.calls if e == name]


@pytest.fixture
def agent(monkeypatch):
    a = Agent()
    monkeypatch.setattr(dt, "_resolve_target", _fake_resolve)
    monkeypatch.setattr(dt, "_agent_req", a)
    monkeypatch.setattr(dt.time, "sleep", lambda s: None)
    return a


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
    monkeypatch.setattr(rt, "_vision_credentials", lambda request, body: ("http://elpis:8000", "pcr_tok"))
    import shared_infra.notifications.store as ns
    monkeypatch.setattr(ns, "create_notification", lambda *a, **k: 1)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


_H = {"x-test-user": "1"}


# ── S2 ────────────────────────────────────────────────────────────────────────
def test_matrice_timeout_mal_forme_borne_et_vision(client, agent, monkeypatch):
    seen = {}
    real = dt.run_automation_core

    def spy(*a, **kw):
        seen.update(kw)
        return real(*a, **kw)
    monkeypatch.setattr(dt, "run_automation_core", spy)
    r = client.post("/api/desktop/run-automation-matrix",
                    json={"targets": ["vm1"], "name": "f", "code": "print(1)", "timeout_s": "abc"}, headers=_H)
    assert r.status_code == 200, r.text
    assert seen["timeout_s"] == 600
    client.post("/api/desktop/run-automation-matrix",
                json={"targets": ["vm1"], "name": "f", "code": "print(1)", "timeout_s": 99999}, headers=_H)
    assert seen["timeout_s"] == 3600
    # S3 : la vision d'Elpis part avec la matrice jusqu'à /run_script
    assert seen["elpis_url"] == "http://elpis:8000" and seen["elpis_token"] == "pcr_tok"
    run = agent.eps("/run_script")[-1]
    assert run["elpis_url"] == "http://elpis:8000" and run["elpis_token"] == "pcr_tok"


def test_budget_compte_apres_le_depot(monkeypatch, agent):
    """Un dépôt lent (vignettes) ne mange pas le budget d'exécution du script."""
    clock = {"t": 0.0}
    monkeypatch.setattr(dt.time, "time", lambda: clock["t"])
    real_push = dt.push_automation_core

    def slow_push(*a, **kw):
        clock["t"] += 50.0                     # dépôt : 50 s
        return real_push(*a, **kw)
    monkeypatch.setattr(dt, "push_automation_core", slow_push)

    def tick(s):
        clock["t"] += 1.0
    monkeypatch.setattr(dt.time, "sleep", tick)
    agent.polls = 20                           # 20 s d'exécution < budget 30 s (hors dépôt)
    doc = dt.run_automation_core("u", ["vm1"], "Flux", "print(1)", timeout_s=30, poll_s=1.0)
    assert doc["results"][0]["ok"] is True, doc
    assert not agent.eps("/run_stop")


def test_outil_ramene_le_budget_par_cible_sous_le_plafond(monkeypatch, agent):
    tools = {}

    class M:
        def tool(self, *a, **kw):
            def deco(fn):
                tools[kw.get("name") or fn.__name__] = fn
                return fn
            return deco
    dt.register(M())
    fn = tools["desktop_run_automation"]
    seen = {}
    monkeypatch.setattr(dt, "get_username", lambda ctx: "u")
    monkeypatch.setattr(dt, "run_automation_core", lambda *a, **kw: seen.update(kw) or {"ok": True, "results": []})
    out = fn(None, name="Flux", code="print(1)", targets="vm1,vm2,vm1", timeout_s=3600)
    assert seen["timeout_s"] == 1200 and seen["total_budget_s"] == dt._RUN_AUTOMATION_BUDGET_S
    assert "1200" in out["note"]
    fn(None, name="Flux", code="print(1)", targets="vm1", timeout_s="abc")
    assert seen["timeout_s"] == 600


def test_plafond_de_matrice_arrete_et_saute(monkeypatch, agent):
    clock = {"t": 0.0}
    monkeypatch.setattr(dt.time, "time", lambda: clock["t"])
    monkeypatch.setattr(dt.time, "sleep", lambda s: clock.__setitem__("t", clock["t"] + 10.0))
    agent.polls = 10_000
    doc = dt.run_automation_core("u", ["vm1", "vm2"], "Flux", "print(1)", timeout_s=3600, total_budget_s=100)
    r1, r2 = doc["results"]
    assert r1["error"] == "timeout" and agent.eps("/run_stop")
    assert r2["error"] == "skipped"


# ── S4 ────────────────────────────────────────────────────────────────────────
def test_sondage_rate_ne_termine_pas_le_suivi(monkeypatch, agent):
    agent.status_errors = 2
    doc = dt.run_automation_core("u", ["vm1"], "Flux", "print(1)", timeout_s=60)
    r = doc["results"][0]
    assert r["ok"] is True and r["error"] is None, r
    assert not agent.eps("/run_stop")


def test_suivi_perdu_arrete_l_execution(monkeypatch, agent):
    agent.status_errors = 100
    agent.polls = 100
    doc = dt.run_automation_core("u", ["vm1"], "Flux", "print(1)", timeout_s=600)
    r = doc["results"][0]
    assert r["error"] == "status_lost" and not r["ok"]
    assert agent.eps("/run_stop") == [{"run_id": "r-vm1"}]


# ── S5 ────────────────────────────────────────────────────────────────────────
def test_nom_de_cible_inconnu_refuse(client, agent):
    doc = dt.run_automation_core("u", ["vm-tset"], "Flux", "print(1)", timeout_s=60)
    assert doc["results"][0]["error"] == "no_target" and not agent.eps("/put_file"), "rien poussé sur la cible par défaut"
    r = client.post("/api/desktop/run-automation", json={"target": "vm-tset", "name": "f", "code": "print(1)"}, headers=_H)
    assert r.status_code == 400 and r.json()["error"] == "no_target"
    assert client.get("/api/desktop/run-automation/status", params={"target": "vm-tset", "run_id": "r"}, headers=_H).status_code == 400
    assert client.post("/api/desktop/run-automation/stop", json={"target": "vm-tset", "run_id": "r"}, headers=_H).status_code == 400
    assert client.get("/api/desktop/run-file", params={"target": "vm-tset", "path": "rapports/x/rapport.json"}, headers=_H).status_code == 404
    assert not agent.eps("/run_stop") and not any(e.startswith("/get_file") for _, e, _ in agent.calls)
    # cible vide = cible active / par défaut (inchangé)
    assert client.get("/api/desktop/run-automation/status", params={"target": "", "run_id": "r-vm1"}, headers=_H).status_code == 200


# ── S6 ────────────────────────────────────────────────────────────────────────
def test_launch_http_survit_au_budget_agent(monkeypatch, agent):
    seen = {}

    def fake(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen[endpoint] = timeout
        return {"ok": True, "found": True, "title": "App"}
    monkeypatch.setattr(dt, "_agent_req", fake)
    monkeypatch.setattr(dt, "_resolve_launch_target", lambda app, os_name="": app, raising=False)
    dt.launch_core("u", "vm1", app="app.exe", timeout_ms=60000)
    assert seen["/launch"] >= 2 * 60 + 10 + 1, seen


# ── S9 ────────────────────────────────────────────────────────────────────────
def test_set_value_point_de_l_element_sans_nom_fabrique(monkeypatch, agent):
    el = {"id": "el_3", "label": "edit", "role": "edit", "unnamed": True, "center": [120, 44], "box": [100, 30, 140, 58]}
    monkeypatch.setattr(dt, "_resolve_element_impl", lambda *a, **k: (el, "element_id"))
    dt.act_core("u", "vm1", op="set_value", element_id="el_3", text="42", observe_after=False)
    body = agent.eps("/set_value")[-1]
    assert body["x"] == 120 and body["y"] == 44 and body["name"] == "" and body["text"] == "42", body
    el2 = {"id": "el_4", "label": "champ quantité", "role": "edit", "label_source": "vision", "center": [5, 6]}
    monkeypatch.setattr(dt, "_resolve_element_impl", lambda *a, **k: (el2, "element_id"))
    dt.act_core("u", "vm1", op="set_value", element_id="el_4", text="1", observe_after=False)
    assert agent.eps("/set_value")[-1]["name"] == "", "libellé lu par la vision : pas un nom UIA"
    el3 = {"id": "el_5", "label": "Quantité", "role": "edit", "auto_id": "qty", "center": [7, 8]}
    monkeypatch.setattr(dt, "_resolve_element_impl", lambda *a, **k: (el3, "element_id"))
    dt.act_core("u", "vm1", op="set_value", element_id="el_5", text="1", observe_after=False)
    b3 = agent.eps("/set_value")[-1]
    assert b3["name"] == "Quantité" and b3["auto_id"] == "qty" and (b3["x"], b3["y"]) == (7, 8)


# ── S10 ───────────────────────────────────────────────────────────────────────
def test_depots_refuses_rendus(client, agent):
    agent.put_fail = {"assets/big.png"}
    r = client.post("/api/desktop/run-automation",
                    json={"target": "vm1", "name": "f", "code": "print(1)", "assets": {"assets/big.png": "aGk=", "assets/ok.png": "aGk="}},
                    headers=_H)
    assert r.status_code == 200
    errs = r.json()["push_errors"]
    assert [e["path"] for e in errs] == ["assets/big.png"] and errs[0]["message"] == "fichier trop volumineux"
    # le SCRIPT refusé : pas de lancement
    agent.put_fail = {"f.py"}
    n_runs = len(agent.eps("/run_script"))
    r = client.post("/api/desktop/run-automation", json={"target": "vm1", "name": "f", "code": "print(1)"}, headers=_H)
    assert r.status_code == 400 and len(agent.eps("/run_script")) == n_runs


# ── S11 ───────────────────────────────────────────────────────────────────────
def test_slug_identique_au_studio_et_modules_masques():
    assert dt._slug_auto("Réglages") == "reglages"
    assert dt._slug_auto("mon_script v2") == "mon-script-v2"
    assert dt._slug_auto("  --Été à Noël!! ") == "ete-a-noel"
    assert dt._slug_auto("") == "automatisation"
    assert len(dt._slug_auto("x" * 100)) == 60
    for name, slug in (("csv", "csv-script"), ("JSON", "json-script"), ("numpy", "numpy-script"),
                       ("elpis_auto", "elpis-auto"), ("lib", "lib-script"), ("calc", "calc"), ("Flux X", "flux-x")):
        assert dt._agent_slug(name) == slug, name


def test_depot_et_lancement_utilisent_le_slug_protege(agent):
    dt.push_automation_core("u", "vm1", "csv", "print(1)")
    dt.start_automation_core("u", "vm1", "csv")
    assert agent.eps("/put_file")[-1]["path"] == "csv-script.py"
    assert agent.eps("/run_script")[-1]["name"] == "csv-script"


def test_lecture_sandbox_avec_le_slug_du_studio(monkeypatch, tmp_path):
    import shared_infra.accounts.users as users
    import shared_infra.routes._helpers as helpers
    work = tmp_path / "u" / "work"
    (work / "automations").mkdir(parents=True)
    (work / "automations" / "reglages.py").write_text("print('ok')", encoding="utf-8")
    monkeypatch.setattr(users, "get_user", lambda username: {"id": 7})
    monkeypatch.setattr(helpers, "_get_work_path", lambda uid: str(work))
    assert dt._load_sandbox_automation("u", "Réglages") == "print('ok')"


# ── En-tête d'échéance ────────────────────────────────────────────────────────
def test_agent_req_transmet_l_echeance(monkeypatch):
    seen = []

    class Resp:
        status_code = 200

        def json(self):
            return {"ok": True}

    class Sess:
        def post(self, url, json=None, timeout=None, headers=None):
            seen.append(("POST", timeout, headers))
            return Resp()

        def get(self, url, timeout=None, headers=None):
            seen.append(("GET", timeout, headers))
            return Resp()
    monkeypatch.setattr(dt, "_AGENT_SESSION", Sess())
    tgt = {"name": "vm1", "agent_url": "http://agent"}
    dt._agent_req(tgt, "/click", {"x": 1}, timeout=12)
    dt._agent_req(tgt, "/run_status?run_id=x", method="GET", timeout=7)
    assert seen[0] == ("POST", 12, {"X-Elpis-Timeout": "12"})
    assert seen[1] == ("GET", 7, {"X-Elpis-Timeout": "7"})


# ── Event tool_result allégé hors Studio ──────────────────────────────────────
def test_event_desktop_elements_seulement_pour_le_studio():
    from llm_core.engine.tool_dispatch import _desktop_event_extra
    raw = json.dumps({"ok": True, "sig": "ab", "elements": [{"id": "el_1", "label": "OK", "role": "button"}]})
    assert _desktop_event_extra("desktop_act", raw, with_elements=False) == {"sig": "ab"}
    assert _desktop_event_extra("desktop_act", raw, with_elements=True)["elements"][0]["id"] == "el_1"
