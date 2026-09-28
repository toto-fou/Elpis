# SPDX-License-Identifier: MIT
"""
tests/chatbot/test_route_continuer_2026_09_24.py — route de chat + « Continuer ».

A. Une reprise ABOUTIE (« Continuer » / « Reprendre ») : le ``final`` ne dit
   pas ``truncated`` et le message fusionné est persisté SANS ``isTruncated``
   (sinon le bandeau reviendrait au rechargement). Côté serveur c'était déjà
   juste — ces tests le verrouillent ; la cause du bandeau collant était dans
   le front (cf. tests/frontend/test_reprise_bandeau.js).

B. Flux fermé SANS détachement alors que la file du worker est PLEINE (client
   engorgé) : après ``task.cancel()``, le worker émettait le ``final`` du
   partiel par ``await q.put`` sur une file que plus personne ne vidait →
   bloqué à vie, verrou de présence jamais rendu, 409 jusqu'au redémarrage.

C. Stop pendant la persistance du tour COMPLET (``to_thread``) : le thread
   écrivait le tour, et le ``finally`` persistait EN PLUS un partiel (conflit,
   toast « non sauvegardé », méta de fin de tour sautées).

D. ``write_tps`` n'est écrit qu'UNE fois par tour outillé (la boucle d'outils
   l'enregistre déjà ; la route le doublait).
"""
from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from shared_infra.runtime import chat_locks
from shared_infra.routes import _state

DOCX = {"id": "server_docx", "name": "docx", "type": "sse",
        "url": "http://127.0.0.1:1/sse", "command": "", "visible": True,
        "auth_mode": "", "auth_user": "", "auth_enc": "", "key_scheme": "plain"}


@pytest.fixture()
def harnais(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.reset_pool()
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-12") == 1
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()

    import chatbot_app.routes.chats as chats_mod
    monkeypatch.setattr(chats_mod, "require_user_id", lambda request: 1)

    import llm_core

    async def _zero(_model=""):
        return 0
    monkeypatch.setattr(llm_core, "get_model_context_size", _zero)

    import llm_core._queue as queue_mod

    async def _pas_de_file(_model=None):
        return {}
    monkeypatch.setattr(queue_mod, "get_queue_status_for_async", _pas_de_file)

    import shared_infra.mcp.servers as _srv
    monkeypatch.setattr(_srv, "personal_url_block_reason", lambda url: None)

    yield chats_mod
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    legacy.reset_pool()


def _client():
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _tour(tc, body):
    events = []
    with tc.stream("POST", "/api/chat-saved-stream3", json=body) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line:
                events.append(json.loads(line))
    return events


def _final(events):
    finals = [e for e in events if e.get("type") == "final"]
    assert len(finals) == 1, events
    return finals[0]


def _requete(body: dict) -> Request:
    """Requête Starlette minimale pour appeler le handler SANS TestClient : il
    faut pouvoir ne PLUS lire le flux (client engorgé) puis le fermer."""
    brut = json.dumps(body).encode()
    envoye = [False]

    async def receive():
        if not envoye[0]:
            envoye[0] = True
            return {"type": "http.request", "body": brut, "more_body": False}
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    scope = {"type": "http", "method": "POST", "path": "/api/chat-saved-stream3",
             "headers": [(b"content-type", b"application/json")],
             "query_string": b"", "state": {}}
    return Request(scope, receive)


TRONQUE = [{"role": "user", "content": "q"},
           {"role": "assistant", "content": "début coupé", "isTruncated": True}]


# ── A. Reprise aboutie ───────────────────────────────────────────────────────

def test_continuer_abouti_ne_repose_pas_istruncated(harnais, monkeypatch):
    chats_mod = harnais
    from shared_infra.chat.store import get_chat, upsert_chat

    async def _classique(msgs, **kw):
        await kw["on_content_token"](" et la suite.")
        return "", " et la suite.", {"finish_reason": "stop"}
    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens", _classique)

    upsert_chat(1, "c1", "t", TRONQUE, 100.0)
    # Le front envoie la bulle reprise SANS isTruncated (effacé au clic).
    ev = _tour(_client(), {
        "messages": [TRONQUE[0], {"role": "assistant", "content": "début coupé"}],
        "chat_id": "c1", "is_continue": True, "use_rag": False,
        "active_mcp_servers": [], "resumable": True})
    fin = _final(ev)
    assert fin["truncated"] is False and not fin.get("cancelled")
    assert fin["assistant"] == "début coupé et la suite."
    msgs = get_chat(1, "c1")["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]   # fusion, pas 2 bulles
    assert msgs[-1]["content"] == "début coupé et la suite."
    assert "isTruncated" not in msgs[-1]


def test_reprendre_boucle_outils_aboutie_ne_repose_pas_istruncated(harnais, monkeypatch):
    chats_mod = harnais
    import llm_core
    from shared_infra.accounts.users import update_user_settings
    from shared_infra.chat.store import get_chat, upsert_chat

    async def _outils(messages, mcp_configs=None, on_event=None, **kw):
        return "Terminé.", [], {"model": "stub", "tool_limit_reached": False}
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _outils)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp_v2", _outils)
    monkeypatch.setattr(chats_mod, "run_chat_multi_mcp", _outils)
    update_user_settings(1, {"enable_mcp": True, "mcp_servers": [DOCX]})

    upsert_chat(1, "c2", "t", [
        {"role": "user", "content": "tâche"},
        {"role": "assistant", "content": "J'ai commencé. ", "isTruncated": True,
         "toolLoopTruncated": True}], 100.0)
    ev = _tour(_client(), {
        "messages": [{"role": "user", "content": "tâche"},
                     {"role": "assistant", "content": "J'ai commencé. "}],
        "chat_id": "c2", "is_continue": True, "use_rag": False, "resumable": True,
        "active_mcp_servers": [{"id": "server_docx", "name": "docx", "type": "sse"}]})
    fin = _final(ev)
    assert fin["truncated"] is False and fin["tool_limit_reached"] is False
    last = get_chat(1, "c2")["messages"][-1]
    assert last["content"] == "J'ai commencé. Terminé."
    assert "isTruncated" not in last and "toolLoopTruncated" not in last


# ── B. File pleine + flux fermé ──────────────────────────────────────────────

async def test_couper_file_debloque_un_put_en_attente():
    chats_mod = pytest.importorskip("chatbot_app.routes.chats")
    q: asyncio.Queue = asyncio.Queue(maxsize=3)
    for i in range(3):
        q.put_nowait(i)
    bloque = asyncio.ensure_future(q.put("final"))
    await asyncio.sleep(0.01)
    assert not bloque.done()           # file pleine : le put attend
    drapeau = [False]
    chats_mod._couper_file(q, drapeau)
    await asyncio.wait_for(bloque, 1.0)   # débloqué par la vidange
    assert drapeau == [True]


async def test_flux_ferme_file_pleine_le_worker_rend_le_chat(harnais, monkeypatch):
    chats_mod = harnais
    from shared_infra.chat.store import get_chat, upsert_chat
    produits = [0]

    async def _bavard(msgs, **kw):
        # Bien plus d'events que la file n'en contient (maxsize=1000).
        for _ in range(1500):
            await kw["on_content_token"]("x")
            produits[0] += 1
        await asyncio.sleep(3600)
        return "", "", {}
    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens", _bavard)

    upsert_chat(1, "c3", "t", [{"role": "user", "content": "q0"},
                               {"role": "assistant", "content": "r0"}], 100.0)
    resp = await chats_mod.api_chat_saved_stream3(_requete({
        "messages": [{"role": "user", "content": "q0"},
                     {"role": "assistant", "content": "r0"},
                     {"role": "user", "content": "q1"}],
        "chat_id": "c3", "use_rag": False, "active_mcp_servers": []}))
    it = resp.body_iterator
    await it.__anext__()
    # Le client ne lit plus : la file se remplit puis le worker se bloque.
    for _ in range(300):
        await asyncio.sleep(0.01)
        if produits[0] >= 990:
            break
    await asyncio.sleep(0.05)
    avant = produits[0]
    await asyncio.sleep(0.05)
    assert 990 <= produits[0] == avant < 1500, produits[0]

    t0 = time.monotonic()
    await it.aclose()   # flux fermé, run NON détaché (pas d'outil, pas resumable)
    # Avant : _cloturer_run attendait 10 s puis rendait la main, worker figé.
    assert time.monotonic() - t0 < 5
    assert _state.get_active_chat_task(1, "c3") is None
    assert not chat_locks.is_held("gen", 1, "c3")
    # Le partiel a bien été persisté par le finally du worker.
    last = get_chat(1, "c3")["messages"][-1]
    assert last["role"] == "assistant" and last.get("isTruncated") is True


# ── C. Stop pendant la persistance du tour complet ──────────────────────────

async def test_stop_pendant_la_persistance_finale_pas_de_partiel(harnais, monkeypatch):
    chats_mod = harnais
    from shared_infra.chat.store import get_chat, upsert_chat

    async def _classique(msgs, **kw):
        await kw["on_content_token"]("réponse complète")
        return "", "réponse complète", {"finish_reason": "stop"}
    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens", _classique)

    vrai = chats_mod._persist_turn
    appels: list = []
    en_ecriture = threading.Event()

    def _lent(persist, uid, cid, title, messages, **kw):
        appels.append(dict(messages[-1]))
        if messages[-1].get("content") == "réponse complète":
            en_ecriture.set()
            time.sleep(0.4)          # écriture SQLite en contention
        return vrai(persist, uid, cid, title, messages, **kw)
    monkeypatch.setattr(chats_mod, "_persist_turn", _lent)

    upsert_chat(1, "c4", "t", [], 100.0)
    resp = await chats_mod.api_chat_saved_stream3(_requete({
        "messages": [{"role": "user", "content": "q"}],
        "chat_id": "c4", "use_rag": False, "active_mcp_servers": []}))
    events: list = []

    async def _lire():
        async for line in resp.body_iterator:
            events.append(json.loads(line))
    lecteur = asyncio.ensure_future(_lire())

    for _ in range(500):
        if en_ecriture.is_set():
            break
        await asyncio.sleep(0.01)
    assert en_ecriture.is_set()
    # Stop : flag d'annulation + task.cancel(), comme /api/chat/cancel.
    task = _state.get_active_chat_task(1, "c4")
    assert task is not None
    chats_mod.mark_chat_cancelled(1, "c4")
    task.cancel()
    await asyncio.wait_for(lecteur, 5.0)

    # Une SEULE persistance : le tour complet. Aucun partiel par-dessus.
    assert [a.get("content") for a in appels] == ["réponse complète"], appels
    assert not any(a.get("isTruncated") for a in appels)
    last = get_chat(1, "c4")["messages"][-1]
    assert last["content"] == "réponse complète" and "isTruncated" not in last
    fin = _final(events)
    assert fin["persisted"] is True and "persist_error" not in fin
    assert not fin.get("cancelled")


async def test_attendre_hors_annulation_absorbe_et_decompte():
    chats_mod = pytest.importorskip("chatbot_app.routes.chats")
    fut = asyncio.ensure_future(asyncio.to_thread(lambda: (time.sleep(0.2), "ok")[1]))

    async def _appelant():
        res, annule = await chats_mod._attendre_hors_annulation(fut)
        # L'annulation absorbée est retirée du compteur de la tâche.
        return res, annule, asyncio.current_task().cancelling()
    t = asyncio.ensure_future(_appelant())
    await asyncio.sleep(0.05)
    t.cancel()
    assert await t == ("ok", True, 0)


# ── D. write_tps une seule fois ─────────────────────────────────────────────

def _espion_metriques(chats_mod, monkeypatch):
    noms: list = []
    monkeypatch.setattr(chats_mod, "log_metric",
                        lambda nom, *a, **k: noms.append(nom))
    return noms


def test_tour_outille_write_tps_pas_ecrit_par_la_route(harnais, monkeypatch):
    chats_mod = harnais
    import llm_core
    from shared_infra.accounts.users import update_user_settings

    async def _outils(messages, mcp_configs=None, on_event=None, **kw):
        # La vraie boucle écrit write_tps elle-même (_write_end_of_turn_metrics).
        return "ok", [], {"model": "stub", "write_tps": 12.5}
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _outils)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp_v2", _outils)
    monkeypatch.setattr(chats_mod, "run_chat_multi_mcp", _outils)
    update_user_settings(1, {"enable_mcp": True, "mcp_servers": [DOCX]})
    noms = _espion_metriques(chats_mod, monkeypatch)

    _final(_tour(_client(), {
        "messages": [{"role": "user", "content": "q"}], "chat_id": "",
        "ephemeral": True, "use_rag": False,
        "active_mcp_servers": [{"id": "server_docx", "name": "docx", "type": "sse"}]}))
    assert "write_tps" not in noms, noms


def test_chat_classique_write_tps_ecrit_une_fois(harnais, monkeypatch):
    chats_mod = harnais

    async def _classique(msgs, **kw):
        return "", "ok", {"finish_reason": "stop"}
    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens", _classique)
    noms = _espion_metriques(chats_mod, monkeypatch)

    _final(_tour(_client(), {
        "messages": [{"role": "user", "content": "q"}], "chat_id": "",
        "ephemeral": True, "use_rag": False, "active_mcp_servers": []}))
    assert noms.count("write_tps") == 1, noms
