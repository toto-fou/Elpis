# SPDX-License-Identifier: MIT
"""tests/llm_core/test_pw_wait.py — outil navigateur ``pw_wait``.

Couvre les deux modes SANS backend Node ni navigateur :
- pause fixe (sleep Python borné, aucune session) ;
- attente de condition = boucle de polling PAR CHUNKS sur ``/wait_for_dynamic``
  (200 = satisfait, 408 = pas encore → reboucle, autres = erreur dure), avec
  sortie ``timed_out`` ORDINAIRE (ok=False, pas une exception) à l'expiration.

Le tool ``pw_wait`` est une closure de ``register(mcp)`` : on l'extrait via un
faux MCP qui capture les fonctions décorées (firefox_tools n'utilise ``mcp.`` que
pour ``@mcp.tool``). ``_req_status`` et ``time`` sont monkeypatchés → déterministe.
"""
from __future__ import annotations

import pytest

from llm_core.tools import firefox_tools as ff


class _FakeMCP:
    """Capture chaque fonction ``@mcp.tool(..., name=...)`` sans FastMCP."""
    def __init__(self):
        self.tools = {}

    def tool(self, *dargs, **dkw):
        name = dkw.get("name")

        def deco(fn):
            self.tools[name or fn.__name__] = fn
            return fn
        return deco


class _FakeClock:
    """Horloge monotone déterministe : chaque lecture avance de ``step`` s.
    Évite d'attendre le vrai wall-clock dans le test d'expiration."""
    def __init__(self, step=0.5):
        self.t = 1000.0
        self.step = step
        self.slept = []

    def monotonic(self):
        self.t += self.step
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


@pytest.fixture(autouse=True)
def _sessions_du_compte(monkeypatch):
    """Les sessions de ces tests appartiennent au compte du contexte
    (``guest``) : depuis 2026-09-30, une session inconnue est refusée."""
    import llm_core._pw_session as _pws
    monkeypatch.setattr(_pws, "get_pw_session_owner", lambda sid: "guest")


@pytest.fixture
def pw_wait():
    mcp = _FakeMCP()
    ff.register(mcp)
    return mcp.tools["pw_wait"]


# ── _dsl_to_selector : DSL → chaîne de sélecteur Playwright ──────────────────
@pytest.mark.parametrize("dsl,expected", [
    ("test_id=save", '[data-testid="save"]'),
    ("css=.spinner", ".spinner"),
    ("xpath=//div[@id='x']", "xpath=//div[@id='x']"),
    ("text=Loading…", "Loading…"),
    ("label=Email", "label=Email"),
    ("placeholder=Search", "placeholder=Search"),
    ("role=button|name=Save", "Save"),   # role non exprimable → repli sur name
    ("", ""),
    ("role=button", ""),                 # role seul → rien d'exploitable
])
def test_dsl_to_selector(dsl, expected):
    assert ff._dsl_to_selector(dsl) == expected


# ── Mode 1 : pause fixe ──────────────────────────────────────────────────────
def test_fixed_duration_sleeps_and_clamps(monkeypatch):
    mcp = _FakeMCP()
    ff.register(mcp)
    wait = mcp.tools["pw_wait"]
    clock = _FakeClock()
    monkeypatch.setattr(ff, "time", clock)

    r = wait(None, seconds=3)
    assert r["ok"] is True and r["mode"] == "duration"
    assert clock.slept == [3.0]
    assert r["elapsed_ms"] >= 0

    # borne haute : au-delà de _WAIT_MAX_S (300) → clampé.
    clock.slept.clear()
    r2 = wait(None, seconds=99999)
    assert clock.slept == [float(ff._WAIT_MAX_S)]
    assert r2["mode"] == "duration"


# ── Mode 2 : attente de condition ────────────────────────────────────────────
def test_condition_wait_polls_until_satisfied(monkeypatch):
    mcp = _FakeMCP()
    ff.register(mcp)
    wait = mcp.tools["pw_wait"]
    monkeypatch.setattr(ff, "time", _FakeClock())

    calls = {"n": 0, "last": None}

    def fake_req_status(method, endpoint, json=None, params=None, timeout=None):
        calls["n"] += 1
        calls["last"] = (endpoint, json)
        # 408 (pas encore disparu) deux fois, puis 200 (caché).
        if calls["n"] < 3:
            return 408, {"error": "still there"}
        return 200, {"status": "hidden", "elapsed_ms": 12}

    monkeypatch.setattr(ff, "_req_status", fake_req_status)

    r = wait(None, session_id="s1", target="css=.spinner",
             condition="hidden", max_wait_s=30)
    assert r["ok"] is True
    assert r["mode"] == "condition" and r["condition"] == "hidden"
    assert r["status"] == "hidden"
    assert r["selector"] == ".spinner"
    assert calls["n"] == 3
    # l'endpoint et le sélecteur résolu sont bien transmis
    assert calls["last"][0] == "/wait_for_dynamic"
    assert calls["last"][1]["selector"] == ".spinner"
    assert calls["last"][1]["condition"] == "hidden"


def test_condition_wait_times_out_ordinary(monkeypatch):
    mcp = _FakeMCP()
    ff.register(mcp)
    wait = mcp.tools["pw_wait"]
    monkeypatch.setattr(ff, "time", _FakeClock(step=0.5))

    # Toujours 408 → jamais satisfait → expiration.
    monkeypatch.setattr(ff, "_req_status",
                        lambda *a, **k: (408, {"error": "still there"}))

    r = wait(None, session_id="s1", selector="#load",
             condition="hidden", max_wait_s=1)
    # Enveloppe ORDINAIRE, pas une exception ni un err() code.
    assert r["ok"] is False
    assert r["timed_out"] is True
    assert r["condition"] == "hidden"
    assert "not met" in r["hint"]


def test_condition_wait_hard_error_surfaced(monkeypatch):
    mcp = _FakeMCP()
    ff.register(mcp)
    wait = mcp.tools["pw_wait"]
    monkeypatch.setattr(ff, "time", _FakeClock())
    # 404 = session introuvable → err() immédiat (pas de reboucle).
    monkeypatch.setattr(ff, "_req_status", lambda *a, **k: (404, {}))

    r = wait(None, session_id="dead", selector="#x", condition="hidden")
    assert r.get("ok") is not True
    assert r.get("error")  # code d'erreur harmonisé


def test_condition_wait_requires_session_and_target(monkeypatch):
    mcp = _FakeMCP()
    ff.register(mcp)
    wait = mcp.tools["pw_wait"]
    monkeypatch.setattr(ff, "time", _FakeClock())

    # ni seconds ni session → erreur claire
    r1 = wait(None)
    assert r1.get("error")
    # session sans cible → erreur claire
    r2 = wait(None, session_id="s1")
    assert r2.get("error")
