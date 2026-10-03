# SPDX-License-Identifier: MIT
"""Tour « Images » de ``POST /api/chat-saved-stream3`` (``chatbot_app/turn/image.py``).

De bout en bout par la route, contre un faux sd-server (``httpx.MockTransport``) :
événements du flux, persistance (question avec ``image_request``, réponse avec
références, pied et erreur), aller-retour des champs, pré-vol HTTP, verrou de
présence, Stop, exécution enregistrée (``runs``, genre ``image``), édition
d'une image jointe, session éphémère.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from shared_infra.routes import _state
from shared_infra.runtime import chat_locks


def png(w=64, h=48) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (30, 160, 90)).save(buf, "PNG")
    return buf.getvalue()


PNG_B64 = base64.b64encode(png()).decode()


class FauxSdServer:
    """sd-server minimal : capacités, soumission, états successifs."""

    def __init__(self):
        self.vues: list = []
        self.etats: list = []
        self.pendant = None            # appelé à chaque sondage

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.vues.append(req)
        p = req.url.path
        if p == "/sdcpp/v1/capabilities":
            return httpx.Response(200, json={"model": {"name": "qwen-image"},
                                             "current_mode": "img_gen",
                                             "limits": {"max_batch_count": 8}})
        if p == "/sdcpp/v1/img_gen":
            return httpx.Response(202, json={"id": "job1", "status": "queued"})
        if p.endswith("/cancel"):
            return httpx.Response(200, json={})
        if p.startswith("/sdcpp/v1/jobs/"):
            if self.pendant:
                self.pendant()
            etat = self.etats.pop(0) if self.etats else {
                "status": "completed", "result": {"images": [{"b64_json": PNG_B64}]}}
            return httpx.Response(200, json=etat)
        return httpx.Response(404)

    def soumissions(self):
        return [json.loads(r.content) for r in self.vues if r.url.path == "/sdcpp/v1/img_gen"]


@pytest.fixture()
def tour(tmp_path, monkeypatch):
    import shared_infra.config as cfg_mod
    import shared_infra.db._connection as legacy
    from llm_core.imagegen import http as transport_mod, sdcpp as sdcpp_mod, service
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "user_db" / "app.db"))
    legacy.reset_pool()
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-12") == 1
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()

    chemin = tmp_path / "config.json"
    monkeypatch.setattr(cfg_mod, "CONFIG_JSON_PATH", chemin)

    def config(**image):
        base = {"enabled": True, "url": "http://sd:8084", "provider": "sdcpp", "max_n": 4}
        base.update(image)
        chemin.write_text(json.dumps({"image": base}), encoding="utf-8")
        cfg_mod.invalidate_config_cache()
    config()

    faux = FauxSdServer()
    monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(faux))
    monkeypatch.setattr(sdcpp_mod, "_POLL_FIRST", 0.0)
    monkeypatch.setattr(sdcpp_mod, "_POLL_MAX", 0.0)
    service.forget_capabilities()

    from tests._routes_chat import monter_routes_chat
    app = monter_routes_chat(monkeypatch, lambda request: 1)
    import shared_infra.image.routes as image_routes
    monkeypatch.setattr(image_routes, "require_user_id", lambda request: 1)
    yield {"c": TestClient(app, raise_server_exceptions=False), "faux": faux,
           "config": config}
    service.forget_capabilities()
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    legacy.reset_pool()
    cfg_mod.invalidate_config_cache()


def _corps(chat_id="chat-img", texte="Un phare sous l'orage", **gen):
    opts = {"size": "1024x576", "n": 1, "ratio": "16:9", "side": 1024}
    opts.update(gen)
    return {"chat_id": chat_id, "messages": [{"role": "user", "content": texte,
                                              "image_request": {"size": "1024x576"}}],
            "image_gen": opts, "resumable": True}


def _flux(c, body):
    events = []
    with c.stream("POST", "/api/chat-saved-stream3", json=body) as r:
        if r.status_code != 200:
            r.read()
            return r.status_code, r.json()
        for line in r.iter_lines():
            if line:
                events.append(json.loads(line))
    return 200, events


def _chat(chat_id="chat-img"):
    from shared_infra.chat.store import get_chat
    return get_chat(1, chat_id)


def _run(run_id):
    from shared_infra.observability.runs import get_run
    for _ in range(50):
        r = get_run(run_id)
        if r and r.get("status") != "running":
            return r
        time.sleep(0.05)
    return get_run(run_id)


def test_tour_complet(tour):
    tour["faux"].etats = [{"status": "queued", "queue_position": 1},
                          {"status": "generating", "started": time.time()}]
    code, ev = _flux(tour["c"], _corps())
    assert code == 200, ev
    types = [e["type"] for e in ev]
    assert types[0] == "mode" and ev[0]["kind"] == "image"
    assert types[-2:] == ["image", "final"] and "image_error" not in types
    etats = [e["state"] for e in ev if e["type"] == "image_progress"]
    assert etats[0] == "queued" and "generating" in etats
    fin = ev[-1]
    assert fin["image"] is True and fin["persisted"] is True and len(fin["generated_images"]) == 1
    ref = fin["generated_images"][0]
    assert ref["url"] == f"/api/images/{ref['id']}" and ref["seed"] > 0
    assert fin["image_meta"]["model"] == "qwen-image" and fin["metrics"]["model"] == "qwen-image"
    assert fin["run_ids"][0].startswith("image-") and fin["title"].startswith("Un phare")
    assert tour["faux"].soumissions()[0]["width"] == 1024

    chat = _chat()
    user, assistant = chat["messages"][-2:]
    assert user["image_request"]["size"] == "1024x576"
    assert user["image_request"]["model"] == "qwen-image" and user["image_request"]["ratio"] == "16:9"
    assert assistant["content"] == "[Image générée : « Un phare sous l'orage »]"
    assert assistant["generated_images"][0]["id"] == ref["id"]
    assert assistant["image_meta"]["model"] == "qwen-image"
    assert assistant["run_ids"] == fin["run_ids"]
    r = tour["c"].get(ref["url"])
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")

    run = _run(fin["run_ids"][0])
    assert run and run["kind"] == "image" and run["status"] == "ok"
    assert run["chat_id"] == "chat-img" and run["model"] == "qwen-image"


def test_les_champs_survivent_au_tour_suivant(tour):
    _code, ev = _flux(tour["c"], _corps())
    fin = ev[-1]
    from chatbot_app.turn.history import _normalize_client_messages
    chat = _chat()
    retour = [dict(m) for m in chat["messages"] if m.get("role") != "system"]
    retour[-1]["generated_images"][0]["url"] = "http://ailleurs/piege.png"
    _f, persist = _normalize_client_messages(retour)
    assert persist[-1]["generated_images"][0]["url"] == f"/api/images/{fin['generated_images'][0]['id']}"
    assert persist[-1]["image_meta"]["model"] == "qwen-image"
    assert persist[-2]["image_request"]["size"] == "1024x576"


@pytest.mark.parametrize("cas, statut", [
    ("moteur_coupe", 503), ("case_decochee", 403), ("hors_groupe", 403),
    ("trop_d_images", 400), ("sans_description", 400), ("image_inconnue", 404),
    ("injoignable", 503)])
def test_pre_vol(tour, monkeypatch, cas, statut):
    body = _corps()
    if cas == "moteur_coupe":
        tour["config"](enabled=False)
    elif cas == "case_decochee":
        from shared_infra.accounts.users import merge_user_settings
        merge_user_settings(1, lambda s: s.update(image_enabled=False))
    elif cas == "hors_groupe":
        tour["config"](groups=[99])
    elif cas == "trop_d_images":
        body["image_gen"]["n"] = 9
    elif cas == "sans_description":
        body["messages"][0]["content"] = "   "
    elif cas == "image_inconnue":
        body["image_gen"]["ref_image_id"] = "a" * 32
    elif cas == "injoignable":
        from llm_core.imagegen import http as transport_mod

        def panne(req):
            raise httpx.ConnectError("éteint", request=req)
        monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(panne))
    code, detail = _flux(tour["c"], body)
    assert code == statut, detail
    assert _chat() is None, "rien d'écrit avant le flux"
    assert not chat_locks.is_held("gen", 1, "chat-img")


def test_echec_du_moteur(tour):
    tour["faux"].etats = [{"status": "failed", "error": {"message": "CUDA OOM"}}]
    _code, ev = _flux(tour["c"], _corps())
    types = [e["type"] for e in ev]
    assert "image" not in types and types[-2:] == ["image_error", "final"]
    err = ev[-2]
    assert err["code"] == "refused" and "CUDA" not in err["message"] and err["retryable"] is False
    assert ev[-1]["image_error"] == {k: err[k] for k in ("code", "message", "retryable")}
    assistant = _chat()["messages"][-1]
    assert assistant["image_error"]["code"] == "refused"
    assert assistant["content"].startswith("[Échec de la génération d'image")
    assert _run(ev[-1]["run_ids"][0])["status"] == "error"


def test_generation_deja_en_cours_409(tour):
    fd = chat_locks.acquire("gen", 1, "chat-img")
    try:
        code, detail = _flux(tour["c"], _corps())
        assert code == 409, detail
    finally:
        chat_locks.release(fd)


def test_stop_pendant_le_calcul(tour):
    """Stop venu du bus d'annulation (autre worker) : job annulé chez
    sd-server, tour écrit comme arrêté."""
    n = {"i": 0}

    def stop():
        n["i"] += 1
        if n["i"] == 2:
            _state.mark_chat_cancelled(1, "chat-img")
    tour["faux"].pendant = stop
    tour["faux"].etats = [{"status": "generating"}] * 50
    _code, ev = _flux(tour["c"], _corps())
    fin = ev[-1]
    assert fin["cancelled"] is True and fin["image_error"]["code"] == "cancelled"
    assert any(r.url.path == "/sdcpp/v1/jobs/job1/cancel" for r in tour["faux"].vues)
    assistant = _chat()["messages"][-1]
    assert assistant["content"] == "[Génération d'image arrêtée]"
    assert _run(fin["run_ids"][0])["status"] == "cancelled"
    assert not chat_locks.is_held("gen", 1, "chat-img"), "verrou rendu"


def test_edition_d_une_image_jointe(tour):
    body = _corps(strength=0.5)
    body["messages"][0]["content"] = [
        {"type": "text", "text": "La même en bleu"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,"
                                            + base64.b64encode(png(300, 300)).decode()}}]
    _code, ev = _flux(tour["c"], body)
    assert ev[-1]["persisted"] is True
    soumis = tour["faux"].soumissions()[0]
    assert soumis["init_image"].startswith("data:image/png;base64,") and soumis["strength"] == 0.5


def test_modifier_une_image_generee(tour):
    _code, ev = _flux(tour["c"], _corps())
    iid = ev[-1]["generated_images"][0]["id"]
    body = _corps(texte="Plus sombre", ref_image_id=iid)
    body["messages"] = _chat()["messages"] + body["messages"]
    _code, ev2 = _flux(tour["c"], body)
    assert ev2[-1]["persisted"] is True
    assert "init_image" in tour["faux"].soumissions()[-1]
    assert _chat()["messages"][-2]["image_request"]["ref_image_id"] == iid


def test_session_ephemere(tour):
    body = _corps(chat_id="")
    body["ephemeral"] = True
    _code, ev = _flux(tour["c"], body)
    fin = ev[-1]
    assert fin["persisted"] is True and fin["generated_images"]
    assert _chat(fin["chat_id"]) is None
    from shared_infra.image import store
    assert store.get_image(1, fin["generated_images"][0]["id"])["chat_id"] is None


def test_enrichissement(tour, monkeypatch):
    import chatbot_app.turn.image as image_mod
    import llm_core.imagegen.enhance as enh

    monkeypatch.setattr(image_mod, "_resolve_enhance_target", lambda uid, data: object())

    async def enrichir(prompt, *, model, chat_id=""):
        return "A lighthouse in a storm, engraving", ""
    monkeypatch.setattr(enh, "enhance_prompt", enrichir)
    _code, ev = _flux(tour["c"], _corps(enhance=True))
    assert {"type": "image_prompt", "text": "A lighthouse in a storm, engraving"} in ev
    assert tour["faux"].soumissions()[0]["prompt"] == "A lighthouse in a storm, engraving"
    assistant = _chat()["messages"][-1]
    assert assistant["revised_prompt"] == "A lighthouse in a storm, engraving"
    assert assistant["content"] == "[Image générée : « Un phare sous l'orage »]"


def _requete(body: dict, path: str):
    from starlette.requests import Request
    brut = json.dumps(body).encode()
    envoye = [False]

    async def receive():
        if not envoye[0]:
            envoye[0] = True
            return {"type": "http.request", "body": brut, "more_body": False}
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}
    return Request({"type": "http", "method": "POST", "path": path, "query_string": b"",
                    "headers": [(b"content-type", b"application/json")], "state": {}},
                   receive)


async def test_stop_par_l_interface_annule_la_tache(tour, monkeypatch):
    """``POST /api/chat/cancel`` sur le même worker : la tâche est annulée
    (``task.cancel``), le tour se termine quand même par un ``final`` arrêté."""
    from chatbot_app.routes.chat_control import api_chat_cancel
    from chatbot_app.routes.chats import api_chat_saved_stream3
    from llm_core.imagegen import sdcpp as sdcpp_mod
    monkeypatch.setattr(sdcpp_mod, "_POLL_FIRST", 0.02)
    monkeypatch.setattr(sdcpp_mod, "_POLL_MAX", 0.02)
    tour["faux"].etats = [{"status": "generating"}] * 2000
    resp = await api_chat_saved_stream3(_requete(_corps(), "/api/chat-saved-stream3"))
    ev = []
    async for chunk in resp.body_iterator:
        e = json.loads(chunk)
        ev.append(e)
        if e.get("type") == "image_progress" and e.get("state") == "generating":
            await api_chat_cancel(_requete({"chat_id": "chat-img"}, "/api/chat/cancel"))
    fin = ev[-1]
    assert fin["type"] == "final" and fin["cancelled"] is True, ev[-3:]
    assert _chat()["messages"][-1]["image_error"]["code"] == "cancelled"
    assert any(r.url.path.endswith("/cancel") for r in tour["faux"].vues)
    for _ in range(50):
        if not chat_locks.is_held("gen", 1, "chat-img"):
            break
        await asyncio.sleep(0.05)
    assert not chat_locks.is_held("gen", 1, "chat-img")
