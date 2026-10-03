# SPDX-License-Identifier: MIT
"""Outil ``generate_image`` du modèle (``llm_core/tools/image_tool.py``) et son
branchement dans le tour de chat : proposé seulement si l'instance, les
groupes et les cases du compte le permettent, jamais en mode plan ; plafond
d'appels par tour ; images posées sur le message (``tool_images``), y compris
au partiel ; délai propre."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import json

import httpx
import pytest

from llm_core.tools import image_tool


def png(w=64, h=48) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 30, 160)).save(buf, "PNG")
    return buf.getvalue()


PNG_B64 = base64.b64encode(png()).decode()


class FauxSd:
    def __init__(self):
        self.vues: list = []
        self.echec = False

    def __call__(self, req):
        self.vues.append(req)
        p = req.url.path
        if p.endswith("capabilities"):
            return httpx.Response(200, json={"model": {"name": "qwen"}, "limits": {}})
        if p.endswith("img_gen"):
            return httpx.Response(202, json={"id": "t1"})
        if self.echec:
            return httpx.Response(200, json={"status": "failed", "error": "x"})
        return httpx.Response(200, json={"status": "completed",
                                         "result": {"images": [{"b64_json": PNG_B64}]}})

    def soumissions(self):
        return [json.loads(r.content) for r in self.vues if r.url.path.endswith("img_gen")]


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.config as cfg_mod
    import shared_infra.db._connection as legacy
    from llm_core.imagegen import http as transport_mod, sdcpp as sdcpp_mod, service
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "user_db" / "app.db"))
    legacy.reset_pool()
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-12") == 1
    chemin = tmp_path / "config.json"
    monkeypatch.setattr(cfg_mod, "CONFIG_JSON_PATH", chemin)

    def config(**image):
        base = {"enabled": True, "url": "http://sd:8084", "max_n": 4, "tool_max_calls": 2}
        base.update(image)
        chemin.write_text(json.dumps({"image": base}), encoding="utf-8")
        cfg_mod.invalidate_config_cache()
    config()
    faux = FauxSd()
    monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(faux))
    monkeypatch.setattr(sdcpp_mod, "_POLL_FIRST", 0.0)
    monkeypatch.setattr(sdcpp_mod, "_POLL_MAX", 0.0)
    service.forget_capabilities()
    yield {"faux": faux, "config": config, "tmp": tmp_path}
    service.forget_capabilities()
    legacy.reset_pool()
    cfg_mod.invalidate_config_cache()


def _outil(sink, events, prefs=None):
    async def on_event(ev):
        events.append(ev)
    return image_tool.build_image_builtin_tool(user_id=1, chat_id=None, on_event=on_event,
                                               is_cancelled=lambda: False, sink=sink,
                                               prefs=prefs)


def _appel(outil, args):
    return json.loads(asyncio.run(outil["generate_image"]["handler"](args)))


def test_absent_si_moteur_eteint(env):
    env["config"](enabled=False)
    assert _outil({}, []) == {}


def test_generation_par_l_outil(env):
    sink, events = {}, []
    outil = _outil(sink, events, prefs={"side": 768})
    d = outil["generate_image"]["definition"]["function"]
    assert d["parameters"]["properties"]["n"]["maximum"] == 4
    assert "ref_image_id" in d["parameters"]["properties"]
    r = _appel(outil, {"prompt": "a red fox", "aspect_ratio": "16:9", "n": 1})
    assert r["ok"] and r["images"][0]["width"] == 64
    assert sink["images"][0]["url"].startswith("/api/images/")
    assert {e["type"] for e in events} >= {"image_progress", "image"}
    assert all(e.get("source") == "tool" for e in events)
    soumis = env["faux"].soumissions()[0]
    assert (soumis["width"], soumis["height"]) == (768, 448), "côté préféré du compte"


def test_plafond_d_appels_par_tour(env):
    sink, events = {}, []
    outil = _outil(sink, events)
    assert _appel(outil, {"prompt": "a"})["ok"]
    assert _appel(outil, {"prompt": "b"})["ok"]
    r = _appel(outil, {"prompt": "c"})
    assert r["ok"] is False and "Limit" in r["error"]
    assert len(env["faux"].soumissions()) == 2


def test_tailles_fixes_au_format_le_plus_proche(env):
    env["config"](provider="openai", url="http://oai", size_policy="fixed", model="gpt-image-1",
                  sizes=["1024x1024", "1536x1024", "1024x1536"])
    cfg = __import__("shared_infra.image.config", fromlist=["x"]).get_image_config()
    assert image_tool._size(cfg, "16:9", 1024) == "1536x1024"
    assert image_tool._size(cfg, "9:16", 1024) == "1024x1536"
    assert image_tool._size(cfg, "1:1", 1024) == "1024x1024"


def test_modifier_par_identifiant(env):
    sink, events = {}, []
    outil = _outil(sink, events)
    iid = _appel(outil, {"prompt": "a fox"})["images"][0]["id"]
    r = _appel(outil, {"prompt": "the same fox in blue", "ref_image_id": iid})
    assert r["ok"] and "init_image" in env["faux"].soumissions()[-1]
    assert _appel(_outil({}, []), {"prompt": "x", "ref_image_id": "f" * 32})["ok"] is False


def test_echec_du_moteur_rendu_au_modele(env):
    env["faux"].echec = True
    sink, events = {}, []
    r = _appel(_outil(sink, events), {"prompt": "a fox"})
    assert r["ok"] is False and "images" not in sink
    assert events[-1]["type"] == "image_error" and events[-1]["source"] == "tool"


def test_delai_de_l_outil(env):
    from llm_core.engine.tool_dispatch import _tool_timeout_s
    from llm_core.imagegen.base import QUEUE_MAX_S
    env["config"](timeout_sec=300)
    assert _tool_timeout_s("generate_image") == QUEUE_MAX_S + 360.0


# ── Branchement dans le tour de chat ──────────────────────────────────────

class _Ordonnanceur:
    @contextlib.asynccontextmanager
    async def garde(self, *a, **kw):
        yield


@pytest.fixture()
def route(env, tmp_path, monkeypatch):
    import llm_core
    import llm_core._queue as queue_mod
    from chatbot_app.turn import execution
    from shared_infra.routes import _state
    from shared_infra.runtime import chat_locks
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()

    async def _n_ctx(_model=""):
        return 8192

    async def _file(_model=None):
        return {}
    monkeypatch.setattr(llm_core, "get_model_context_size", _n_ctx)
    monkeypatch.setattr(queue_mod, "get_queue_status_for_async", _file)
    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _Ordonnanceur().garde)
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda *a, **k: "classic")
    vus: dict = {}

    async def boucle(messages, mcp_configs=None, on_event=None, builtin_tools=None, **kw):
        vus["builtins"] = sorted(builtin_tools or {})
        vus["deny"] = kw.get("deny_tool_names")
        if builtin_tools and "generate_image" in builtin_tools:
            await builtin_tools["generate_image"]["handler"]({"prompt": "a fox"})
            if vus.get("stop"):
                raise asyncio.CancelledError()
        await on_event({"type": "content_token", "text": "Voilà."})
        return "Voilà.", [], {"model": "stub", "tool_limit_reached": False}
    for cible in (llm_core, execution):
        monkeypatch.setattr(cible, "run_chat_multi_mcp", boucle, raising=False)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp_v2", boucle)

    async def classique(msgs, **kw):
        vus["classique"] = True
        if kw.get("user_id") == "title":
            return "", "Titre", {"finish_reason": "stop"}
        await kw["on_content_token"]("Bonjour.")
        return "", "Bonjour.", {"finish_reason": "stop"}
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", classique)
    from fastapi.testclient import TestClient

    from tests._routes_chat import monter_routes_chat
    app = monter_routes_chat(monkeypatch, lambda request: 1)
    yield TestClient(app, raise_server_exceptions=False), vus
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()


def _tour(c, chat_id="c-outil"):
    events = []
    body = {"chat_id": chat_id, "messages": [{"role": "user", "content": "dessine un renard"}],
            "use_rag": False, "active_mcp_servers": []}
    with c.stream("POST", "/api/chat-saved-stream3", json=body) as r:
        assert r.status_code == 200, r.read()
        for line in r.iter_lines():
            if line:
                events.append(json.loads(line))
    return events


def test_outil_propose_et_images_sur_le_message(route):
    c, vus = route
    events = _tour(c)
    assert vus["builtins"] == ["generate_image"]
    fin = events[-1]
    assert fin["type"] == "final" and len(fin["tool_images"]) == 1
    from shared_infra.chat.store import get_chat
    assistant = get_chat(1, "c-outil")["messages"][-1]
    assert assistant["tool_images"][0]["id"] == fin["tool_images"][0]["id"]
    from shared_infra.image import store
    assert store.get_image(1, fin["tool_images"][0]["id"])["chat_id"] == "c-outil"


@pytest.mark.parametrize("cas", ["case_decochee", "outils_coupes", "moteur_eteint",
                                 "hors_groupe", "mode_plan"])
def test_outil_retire(route, env, cas):
    c, vus = route
    from shared_infra.accounts.users import update_user_settings
    if cas == "case_decochee":
        update_user_settings(1, {"image_tool_enabled": False})
    elif cas == "outils_coupes":
        update_user_settings(1, {"enable_mcp": False})
    elif cas == "moteur_eteint":
        env["config"](enabled=False)
    elif cas == "hors_groupe":
        env["config"](groups=[42])
    elif cas == "mode_plan":
        from shared_infra.chat.store import set_chat_plan_mode, upsert_chat
        upsert_chat(1, "c-outil", "t", [], 100.0)
        set_chat_plan_mode(1, "c-outil", True)
    events = _tour(c)
    assert events[-1]["type"] == "final"
    assert "generate_image" not in (vus.get("builtins") or [])
    assert "tool_images" not in events[-1]


def test_images_gardees_au_partiel(route):
    c, vus = route
    vus["stop"] = True
    events = _tour(c)
    fin = events[-1]
    assert fin["type"] == "final" and fin.get("tool_images")
    from shared_infra.chat.store import get_chat
    assert get_chat(1, "c-outil")["messages"][-1]["tool_images"]


def test_plafond_d_images_par_tour(env):
    """Au plus ``max_n`` images par tour pour l'outil, tous appels confondus ;
    un appel en échec rend sa réservation."""
    env["config"](max_n=3, tool_max_calls=10)
    sink, events = {}, []
    outil = _outil(sink, events)
    assert _appel(outil, {"prompt": "a", "n": 2})["ok"]
    env["faux"].echec = True
    assert _appel(outil, {"prompt": "b", "n": 1})["ok"] is False
    env["faux"].echec = False
    assert _appel(outil, {"prompt": "c", "n": 3})["ok"]
    assert env["faux"].soumissions()[-1]["batch_count"] == 1, "ramené au reste du tour"
    r = _appel(outil, {"prompt": "d"})
    assert r["ok"] is False and "images per turn" in r["error"]
