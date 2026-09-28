# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_launch_resolve.py — résolution de nom d'appli
amical (« lance la calculatrice » → calc.exe) + câblage dans launch_core.

Toute la logique testable vit dans la couche MCP (Linux-testable) ; le backend
Windows n'est validé que par py_compile/import.
"""
from __future__ import annotations

import pytest

from llm_core.tools import desktop_tools as dt
from llm_core.tools.desktop_tools import _resolve_app_target

WIN_TGT = {"name": "vm-win", "agent_url": "http://agent", "os": "windows"}
LX_TGT = {"name": "vm-lx", "agent_url": "http://agent", "os": "linux"}


@pytest.mark.parametrize("app,expected", [
    ("calculatrice", "calc.exe"),
    ("Calculatrice", "calc.exe"),
    ("CALCULATRICE", "calc.exe"),
    ("calculator", "calc.exe"),
    ("calc", "calc.exe"),
    ("bloc-notes", "notepad.exe"),
    ("Bloc Notes", "notepad.exe"),
    ("notepad", "notepad.exe"),
    ("paramètres", "ms-settings:"),
    ("parametres", "ms-settings:"),
    ("gestionnaire des tâches", "taskmgr.exe"),
    ("éditeur du registre", "regedit.exe"),
])
def test_resolve_windows_aliases(app, expected):
    resolved, _note = _resolve_app_target(app, "windows")
    assert resolved == expected


def test_resolve_unknown_name_gets_exe_suffix():
    resolved, note = _resolve_app_target("MonAppliPerso", "windows")
    assert resolved == "MonAppliPerso.exe" and note


def test_resolve_path_passthrough():
    assert _resolve_app_target(r"C:\Apps\x.exe", "windows")[0] == r"C:\Apps\x.exe"
    assert _resolve_app_target("notepad.exe", "windows")[0] == "notepad.exe"
    assert _resolve_app_target("foo.lnk", "windows")[0] == "foo.lnk"


def test_resolve_uri_passthrough():
    assert _resolve_app_target("ms-settings:privacy", "windows")[0] == "ms-settings:privacy"
    assert _resolve_app_target("https://example.com", "windows")[0] == "https://example.com"


def test_resolve_linux_passthrough():
    # hors Windows : aucune traduction (Popen direct)
    assert _resolve_app_target("gnome-calculator", "linux")[0] == "gnome-calculator"
    assert _resolve_app_target("calculatrice", "linux")[0] == "calculatrice"


def test_resolve_never_raises_on_garbage():
    assert _resolve_app_target("", "windows")[0] == ""
    assert _resolve_app_target(None, "windows")[0] == ""


# ── câblage dans launch_core ────────────────────────────────────────────────
@pytest.fixture
def agent(monkeypatch):
    sent = {}

    def fake_agent_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        sent["endpoint"] = endpoint
        sent["payload"] = payload
        return sent.get("_resp", {"launched": payload.get("target"), "found": True,
                                  "title": "Calculatrice"})
    monkeypatch.setattr(dt, "_agent_req", fake_agent_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 800, 600))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "sig")
    return sent


def test_launch_core_resolves_before_agent_call(agent, monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": WIN_TGT)
    res = dt.launch_core("u", "vm-win", app="calculatrice")
    assert res["ok"] is True
    assert agent["payload"]["target"] == "calc.exe"      # résolu AVANT l'agent
    assert res["requested_app"] == "calculatrice"
    assert res["resolved"] == "calc.exe"
    assert res["found"] is True


def test_launch_core_linux_passes_through(agent, monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": LX_TGT)
    dt.launch_core("u", "vm-lx", app="gnome-calculator")
    assert agent["payload"]["target"] == "gnome-calculator"


def test_launch_core_found_false_adds_hint(agent, monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": WIN_TGT)
    agent["_resp"] = {"launched": "calc.exe", "found": False}
    res = dt.launch_core("u", "vm-win", app="calc")
    assert res["ok"] is True and res["found"] is False
    assert "hint" in res and "déjà ouverte" in res["hint"]


def test_launch_core_agent_error_passthrough(agent, monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": WIN_TGT)
    agent["_resp"] = {"ok": False, "error": "agent_unsupported", "message": "x"}
    # _agent_req renverrait déjà un err() ; on simule un dict d'erreur en sortie
    monkeypatch.setattr(dt, "_agent_req",
                        lambda *a, **k: {"error": "agent_unsupported", "ok": False})
    res = dt.launch_core("u", "vm-win", app="calc")
    assert res.get("error") == "agent_unsupported"


def test_launch_core_needs_app(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": WIN_TGT)
    assert dt.launch_core("u", "vm-win", app="")["error"] == "need_app"


# ── _agent_req : un 501 FastAPI (« detail ») doit faire surface ─────────────
import requests as _real_requests


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _FakeRequests:
    exceptions = _real_requests.exceptions

    def __init__(self, resp):
        self._resp = resp

    def post(self, url, json=None, timeout=None, **kw):   # headers= (X-Elpis-Timeout)
        return self._resp

    def get(self, url, timeout=None, **kw):
        return self._resp


def test_agent_err_message_reads_detail_then_error():
    assert dt._agent_err_message(_Resp(501, {"detail": "launch not available on this session"})) \
        == "launch not available on this session"
    assert dt._agent_err_message(_Resp(500, {"error": "boom"})) == "boom"
    assert dt._agent_err_message(_Resp(500, {"message": "m"})) == "m"
    assert dt._agent_err_message(_Resp(500, {})) is None


def test_agent_req_501_surfaces_real_reason(monkeypatch):
    # FastAPI HTTPException(501, "...") -> {"detail": "..."} : on doit le voir.
    monkeypatch.setattr(dt, "_AGENT_SESSION",
                        _FakeRequests(_Resp(501, {"detail": "launch not available on this session"})))
    r = dt._agent_req({"name": "t1", "agent_url": "http://agent"}, "/launch", {"target": "calc.exe"})
    assert r["error"] == "agent_unsupported"
    assert "launch not available on this session" in r["message"]   # le vrai motif, plus le texte générique
    assert "outdated" in (r.get("fix") or "").lower()               # piste : redéployer l'agent
    assert r.get("endpoint") == "/launch"


def test_agent_req_500_surfaces_detail(monkeypatch):
    monkeypatch.setattr(dt, "_AGENT_SESSION",
                        _FakeRequests(_Resp(500, {"detail": "ShellExecute a échoué : fichier introuvable"})))
    r = dt._agent_req({"name": "t1", "agent_url": "http://agent"}, "/launch", {"target": "nope.exe"})
    assert r["error"] == "agent_http_error" and r["status"] == 500
    assert "introuvable" in r["message"]
