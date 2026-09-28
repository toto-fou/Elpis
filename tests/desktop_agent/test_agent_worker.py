# SPDX-License-Identifier: MIT
"""
tests/desktop_agent/test_agent_worker.py — worker UIA sérialisé (R2).

Les endpoints UIA sont routés vers UN thread worker unique : sérialisation (une
op à la fois, même thread), /health reste vivant même worker occupé, une op figée
→ 503 ``agent_busy`` net (au lieu d'un gel total), NotSupported→501 à travers la
Future, timeout d'op→503. COM/UIA réel indisponible ici (Linux) → FakeBackend.

Le serveur agent est chargé sous alias importlib (comme test_agent_server.py) pour
ne pas masquer le package ``server/`` du repo. Chaque test recharge un module
FRAIS (worker + file propres) pour l'isolation.
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import threading
import time

import pytest

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


def _fresh_server(env=None):
    """Charge une instance FRAÎCHE de server.py (worker/file neufs)."""
    saved_path = list(sys.path)
    saved_mods = set(sys.modules)
    sys.path.insert(0, _AGENT)
    for k, v in (env or {}).items():
        os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location(
            "agent_srv_worker_test", os.path.join(_AGENT, "server.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod, (saved_path, saved_mods)
    except Exception:
        sys.path[:] = saved_path
        raise


def _cleanup(saved):
    saved_path, saved_mods = saved
    sys.path[:] = saved_path
    for name in list(sys.modules):
        if name not in saved_mods and name.split(".")[0] in (
                "backends", "normalize", "agent_srv_worker_test"):
            sys.modules.pop(name, None)


class _FakeBackend:
    name = "fake"

    def __init__(self):
        self.calls = []            # (op, thread_id)
        self.threads = set()
        self._gate = None          # threading.Event pour bloquer volontairement
        self._gate_op = None

    def health(self):
        return {"os": "fake"}

    def cursor_pos(self):
        return [0, 0]

    def _record(self, op):
        self.calls.append((op, threading.get_ident()))
        self.threads.add(threading.get_ident())
        if self._gate is not None and op == self._gate_op:
            self._gate.wait(timeout=10)

    def click(self, x, y, button, clicks, modifiers):
        self._record("click")

    def type_text(self, text):
        self._record("type")

    def ui_tree(self, max_nodes, scope):
        self._record("ui_tree")
        return ([], 100, 100)

    def set_monitor(self, idx):
        self._record("select_monitor")
        return idx

    def invoke(self, **kw):
        self._record("invoke")
        raise self._NotSupported("invoke indisponible")

    _NotSupported = None   # rempli après chargement du module (classe du serveur)


async def _client_call(mod, method, path, json=None):
    from httpx import ASGITransport, AsyncClient
    transport = ASGITransport(app=mod.app)
    async with AsyncClient(transport=transport, base_url="http://agent") as ac:
        if method == "GET":
            return await ac.get(path)
        return await ac.post(path, json=json or {})


@pytest.fixture
def srv():
    mod, saved = _fresh_server()
    fake = _FakeBackend()
    fake._NotSupported = mod.NotSupported
    mod.backend = fake
    try:
        yield mod, fake
    finally:
        _cleanup(saved)


def test_ok_and_serialized_same_thread(srv):
    mod, fake = srv

    async def run():
        # Deux ops concurrentes → sérialisées sur LE MÊME thread worker.
        r1, r2 = await asyncio.gather(
            _client_call(mod, "POST", "/click", {"x": 1, "y": 2}),
            _client_call(mod, "POST", "/type", {"text": "hi"}),
        )
        return r1, r2

    r1, r2 = asyncio.run(run())
    assert r1.status_code == 200 and r2.status_code == 200
    assert {c[0] for c in fake.calls} == {"click", "type"}
    # Toutes les ops UIA sur UN seul thread (sérialisation + MTA cohérent).
    assert len(fake.threads) == 1
    # ...et ce n'est PAS le thread principal du test.
    assert threading.get_ident() not in fake.threads


def test_health_alive_while_worker_busy(srv):
    mod, fake = srv
    # HUNG bas pour que la 2e op voie tout de suite le worker « figé ».
    mod._HUNG_AFTER_SEC = 0.2
    fake._gate = threading.Event()
    fake._gate_op = "ui_tree"       # ui_tree va bloquer sur le gate

    async def run():
        # Lance ui_tree (bloquant) sans l'attendre, laisse le worker se marquer busy.
        blocked = asyncio.ensure_future(_client_call(mod, "POST", "/ui_tree", {}))
        await asyncio.sleep(0.4)
        # /health répond MALGRÉ le worker occupé (sync def → threadpool).
        h = await _client_call(mod, "GET", "/health")
        # Un nouvel appel UIA voit le worker figé → 503 net.
        busy = await _client_call(mod, "POST", "/click", {"x": 1, "y": 1})
        fake._gate.set()            # libère ui_tree
        await blocked
        return h, busy

    h, busy = asyncio.run(run())
    assert h.status_code == 200
    hj = h.json()
    assert hj["worker"]["busy"] is True and hj["worker"]["op"] == "ui_tree"
    assert busy.status_code == 503 and "occupé" in busy.text


def test_not_supported_maps_501_through_future(srv):
    mod, fake = srv

    async def run():
        return await _client_call(mod, "POST", "/invoke", {"auto_id": "x"})

    r = asyncio.run(run())
    assert r.status_code == 501


def test_op_timeout_maps_503(srv):
    mod, fake = srv
    mod._OP_TIMEOUT_SEC = 0.2       # timeout d'op très court
    mod._HUNG_AFTER_SEC = 999       # ne PAS court-circuiter par la garde « figé »
    fake._gate = threading.Event()
    fake._gate_op = "click"

    async def run():
        r = await _client_call(mod, "POST", "/click", {"x": 1, "y": 1})
        fake._gate.set()            # libère l'op (elle finira dans le worker)
        return r

    r = asyncio.run(run())
    assert r.status_code == 503 and "répondu à temps" in r.text


def test_gzip_on_large_ui_tree(srv):
    mod, fake = srv
    # Beaucoup de nœuds → réponse JSON > minimum_size (1024) → gzip si demandé.
    fake.ui_tree = lambda max_nodes, scope: (
        [{"id": f"el_{i}", "name": "nœud volumineux " * 8} for i in range(200)], 1920, 1080)

    async def run():
        from httpx import ASGITransport, AsyncClient
        transport = ASGITransport(app=mod.app)
        async with AsyncClient(transport=transport, base_url="http://agent") as ac:
            return await ac.post("/ui_tree", json={}, headers={"Accept-Encoding": "gzip"})

    r = asyncio.run(run())
    assert r.status_code == 200
    # httpx décompresse et retire l'en-tête ; on vérifie que le middleware a agi.
    assert r.headers.get("content-encoding") == "gzip"
    assert len(r.json()["elements"]) == 200


def test_attente_longue_legitime_n_est_pas_un_gel_et_op_abandonnee_non_executee(srv):
    """Relecture du 14/09 : un /wait_window de 90 s n'est pas « figé » tant qu'il reste
    dans SON délai ; une op dont l'appelant a abandonné avant le départ n'est pas jouée."""
    mod, fake = srv
    mod._HUNG_AFTER_SEC = 0.2
    fake._gate = threading.Event()
    fake._gate_op = "ui_tree"

    async def run():
        # op d'attente déclarée (budget 30 s) qui bloque
        blocked = asyncio.ensure_future(mod._run_uia("wait_window", lambda: (fake._gate.wait(5), {"ok": True})[1], timeout_s=30))
        await asyncio.sleep(0.4)
        # l'op suivante n'est PAS refusée comme « figée » : elle attend son tour, puis expire côté serveur
        try:
            await mod._run_uia("click", lambda: executed.append("click") or {"ok": True}, timeout_s=0.3)
            r = "ok"
        except Exception as e:                 # HTTPException 503 « n'a pas répondu à temps »
            r = getattr(e, "detail", str(e))
        fake._gate.set()
        await blocked
        await asyncio.sleep(0.3)               # le worker dépile la requête abandonnée
        return r

    executed = []
    r = asyncio.run(run())
    assert "bloquée depuis" not in str(r), "une attente légitime n'est pas déclarée gelée"
    assert "à temps" in str(r)
    assert executed == [], "requête abandonnée avant son départ : jamais exécutée (pas de double clic au réessai)"
