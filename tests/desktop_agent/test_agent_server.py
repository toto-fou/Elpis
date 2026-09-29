# SPDX-License-Identifier: MIT
"""
tests/desktop_agent/test_agent_server.py — chargement du serveur de l'agent +
mapping d'erreurs des helpers ``_do``/``_ret`` (NotSupported→501, autres→500).

Les ops UIA sont sérialisées sur UN thread worker dédié (voir test_agent_worker.py) ;
``_do``/``_ret`` restent les briques synchrones exécutées PAR ce worker, testées
ici en isolation. Le backend force MTA → un thread worker unique est COM-sûr.

Le ``server.py`` de l'agent est chargé SOUS UN ALIAS (importlib) pour ne pas
masquer le *package* ``server/`` du repo dans ``sys.modules``.
"""
from __future__ import annotations

import importlib.util
import os
import sys

import pytest

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


@pytest.fixture(scope="module")
def srv():
    saved_path = list(sys.path)
    saved_mods = set(sys.modules)
    sys.path.insert(0, _AGENT)
    try:
        spec = importlib.util.spec_from_file_location(
            "agent_server_under_test", os.path.join(_AGENT, "server.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)          # smoke : le serveur agent se charge
        yield mod
    finally:
        sys.path[:] = saved_path
        # Ne pas laisser traîner les modules de l'agent (sinon ``server`` masqué).
        for name in list(sys.modules):
            if name not in saved_mods and name.split(".")[0] in (
                    "backends", "normalize", "agent_server_under_test"):
                sys.modules.pop(name, None)


def test_do_returns_ok(srv):
    r = srv._do(lambda: None)
    # cursor joint à CHAQUE action (best-effort, None si indisponible côté backend).
    assert r["ok"] is True and "cursor" in r


def test_do_maps_not_supported_to_501(srv):
    from fastapi import HTTPException

    def boom():
        raise srv.NotSupported("nope")
    with pytest.raises(HTTPException) as ei:
        srv._do(boom)
    assert ei.value.status_code == 501


def test_do_maps_other_errors_to_500(srv):
    from fastapi import HTTPException

    def boom():
        raise RuntimeError("kaboom")
    with pytest.raises(HTTPException) as ei:
        srv._do(boom)
    assert ei.value.status_code == 500


def test_ret_returns_payload(srv):
    r = srv._ret(lambda **k: {"found": True})
    assert r["ok"] is True and r["found"] is True and "cursor" in r


def test_run_command_via_ret(srv):
    # Le backend chargé sur le poste de dev est Linux → run_command marche.
    r = srv._ret(srv._backend().run_command, command="printf ok", shell="bash",
                 cwd="", timeout_ms=5000, max_output=1000)
    assert r["returncode"] == 0 and r["stdout"] == "ok" and r["truncated"] is False


def test_run_command_disabled_maps_501(srv, monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setenv("DESKTOP_DISABLE_SHELL", "1")
    with pytest.raises(HTTPException) as ei:
        srv._ret(srv._backend().run_command, command="printf ok", shell="bash")
    assert ei.value.status_code == 501


def _pil_img():
    from PIL import Image
    return Image.new("RGB", (8, 8), "#123456")


def test_encode_screenshot_jpeg_by_param(srv):
    # P3 — le PARAM fmt='jpeg' prime : magic bytes JPEG (\xff\xd8).
    from backends import base
    data = base.encode_screenshot(_pil_img(), fmt="jpeg", quality=80)
    assert data[:2] == b"\xff\xd8"


def test_encode_screenshot_default_png(srv):
    from backends import base
    data = base.encode_screenshot(_pil_img())          # aucun param, env par défaut
    assert data[:8] == b"\x89PNG\r\n\x1a\n"


def test_gzip_response_header(srv):
    # gzip actif sur une réponse volumineuse quand le client l'accepte.
    import asyncio

    from httpx import ASGITransport, AsyncClient

    class _FB:
        name = "fake"

        def ui_tree(self, max_nodes, scope):
            return ([{"id": f"el_{i}", "name": "nœud " * 10} for i in range(120)], 100, 100)

        def cursor_pos(self):
            return [0, 0]

    srv.backend = _FB()

    async def _run():
        transport = ASGITransport(app=srv.app)
        async with AsyncClient(transport=transport, base_url="http://a") as ac:
            return await ac.post("/ui_tree", json={}, headers={"Accept-Encoding": "gzip"})

    r = asyncio.run(_run())
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"
