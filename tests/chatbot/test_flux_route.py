# SPDX-License-Identifier: MIT
"""tests/chatbot/test_flux_route.py — goldens NDJSON de ``POST /api/chat-saved-stream3``.

Fige, de bout en bout et par scénario, la SÉQUENCE des événements du flux et
l'état de la base qui l'accompagne : ce que le front reçoit et ce qui reste
après le tour. Les autres harnais de la route neutralisent ce qu'il faut
observer ici (file vide, contexte inconnu) ; celui-ci force une attente de file
et un contexte mesurable, pour que ``queue_status``, ``queue_cleared`` et
``kv_cache`` partent réellement.

Ordre attendu d'un tour : ``mode`` → ``queue_status`` (attente) →
``queue_cleared`` → jetons (classique) ou ``mode`` « Outils prêts… » puis
événements de la boucle (outils) → ``kv_cache`` → ``final``. Variantes : panne
→ ``error`` puis ``final`` partiel ; abandon de la file → ``queue_cleared``
puis ``final`` partiel (voir ``test_stop_pendant_la_file``). Ordre complet et
cas non couverts : en-tête de ``chatbot_app/routes/chats.py``.

Normalisation : les ``ping`` sont retirés (cadence d'horloge), les jetons
consécutifs d'un même type sont fusionnés (l'agrégation du drain dépend du
timing), les champs volatils (identifiants d'exécution, durées, débits) ne
gardent que leur forme.

Régénérer (changement de comportement VOULU, diff relu) :
``GOLDEN_UPDATE=1 venv/bin/pytest -n0 tests/chatbot/test_flux_route.py``.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from chatbot_app.turn import execution
from shared_infra.routes import _state
from shared_infra.runtime import chat_locks
from tests.llm_core.goldens_harness import assert_matches_golden

FILE = {"kind": "waiting", "position": 1, "ahead": 1}
N_CTX = 8192

DOCX = {"id": "server_docx", "name": "docx", "type": "sse",
        "url": "http://127.0.0.1:1/sse", "command": "", "visible": True,
        "auth_mode": "", "auth_user": "", "auth_enc": "", "key_scheme": "plain"}


# ── Harnais ──────────────────────────────────────────────────────────────────

class _Ordonnanceur:
    """Faux ``llm_scheduling_guard`` : une attente rapportée (``on_wait``),
    puis le créneau — ou l'abandon de la file si ``abandon``."""

    def __init__(self):
        self.abandon = False

    @contextlib.asynccontextmanager
    async def garde(self, model, use_mcp_path=False, target=None, on_wait=None,
                    cancel_probe=None, **_kw):
        if on_wait is not None:
            await on_wait(0.25)
        if self.abandon:
            from llm_core._scheduling import LLMQueueAborted
            raise LLMQueueAborted()
        yield


@pytest.fixture()
def route(tmp_path, monkeypatch):
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

    async def _n_ctx(_model=""):
        return N_CTX
    monkeypatch.setattr(llm_core, "get_model_context_size", _n_ctx)

    import llm_core._queue as queue_mod

    async def _file(_model=None):
        return dict(FILE)
    monkeypatch.setattr(queue_mod, "get_queue_status_for_async", _file)

    ordo = _Ordonnanceur()
    monkeypatch.setattr(llm_core, "llm_scheduling_guard", ordo.garde)
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda *a, **k: "classic")

    import shared_infra.mcp.servers as _srv
    monkeypatch.setattr(_srv, "personal_url_block_reason", lambda url: None)

    yield chats_mod, ordo
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    legacy.reset_pool()


def _client():
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _requete(body: dict) -> Request:
    """Requête Starlette minimale pour appeler le handler sans TestClient
    (Stop, déconnexion : il faut piloter la lecture du flux)."""
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


def _messages_base(chat_id: str):
    from shared_infra.chat.store import get_chat
    chat = get_chat(1, chat_id)
    return None if chat is None else _norm_messages(chat.get("messages") or [])


def _tour(body: dict, *, base_au_final: bool = False):
    """Un tour par le TestClient ; rend (événements bruts, base lue au moment
    où le ``final`` arrive)."""
    events, au_final = [], None
    with _client().stream("POST", "/api/chat-saved-stream3", json=body) as r:
        assert r.status_code == 200, r.text
        for line in r.iter_lines():
            if not line:
                continue
            e = json.loads(line)
            events.append(e)
            if base_au_final and e.get("type") == "final":
                au_final = _messages_base(body["chat_id"])
    return events, au_final


# ── Normalisation ────────────────────────────────────────────────────────────

_JETONS = ("content_token", "thinking_token")
_MESSAGE_VALEURS = ("role", "content", "thinking", "isTruncated",
                    "toolLoopTruncated", "cancelled")


def _norm_messages(messages):
    out = []
    for m in messages:
        n = {"cles": sorted(m)}
        n.update({k: m[k] for k in _MESSAGE_VALEURS if k in m})
        out.append(n)
    return out


def _norm_final(e):
    out = {"cles": sorted(e)}
    for k in ("assistant", "chat_id", "thinking", "title", "truncated",
              "truncated_in_think", "tool_limit_reached", "cancelled",
              "persisted", "persist_error", "plan_mode_done"):
        if k in e:
            out[k] = e[k]
    out["run_ids"] = len(e.get("run_ids") or [])
    out["metrics"] = sorted(e["metrics"]) if isinstance(e.get("metrics"), dict) else e.get("metrics")
    return out


def _norm(events):
    out = []
    for e in events:
        t = e.get("type")
        if t == "ping":
            continue
        if t in _JETONS and out and out[-1]["type"] == t:
            out[-1]["text"] += e.get("text", "")
            continue
        if t == "final":
            out.append({"type": t, **_norm_final(e)})
        elif t in _JETONS:
            out.append({"type": t, "text": e.get("text", "")})
        else:
            out.append({k: v for k, v in e.items() if k not in ("n", "ts")})
    return out


def _types(events):
    return [e["type"] for e in _norm(events)]


# ── Faux moteurs ─────────────────────────────────────────────────────────────

def _classique(reponse="Bonjour.", pendant=None):
    """Faux ``llama_chat_stream_tokens`` : un raisonnement, la réponse en deux
    jetons, un usage mesurable (jauge). Les appels de titre (``user_id``
    « title ») rendent un titre fixe."""
    async def _f(msgs, **kw):
        if kw.get("user_id") == "title":
            return "", "Titre du modèle", {"finish_reason": "stop"}
        if kw.get("on_thinking_token"):
            await kw["on_thinking_token"]("je réfléchis")
        moitie = len(reponse) // 2
        await kw["on_content_token"](reponse[:moitie])
        if pendant is not None:
            await pendant()
        await kw["on_content_token"](reponse[moitie:])
        return "je réfléchis", reponse, {
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 1500, "completion_tokens": 4}}
    return _f


def _outils(monkeypatch, chats_mod):
    """Faux ``run_chat_multi_mcp`` : un appel d'outil, son résultat, la prose."""
    import llm_core

    async def _f(messages, mcp_configs=None, on_event=None, **kw):
        await on_event({"type": "tool_call", "name": "docx_lire", "id": "c1",
                        "args": {"chemin": "a.docx"}})
        await on_event({"type": "tool_result", "name": "docx_lire", "id": "c1",
                        "ok": True, "result": "contenu"})
        await on_event({"type": "content_token", "text": "Terminé."})
        return "Terminé.", [], {"model": "stub", "last_prompt_tokens": 2048,
                                "tool_limit_reached": False}
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _f)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp_v2", _f)
    monkeypatch.setattr(execution, "run_chat_multi_mcp", _f)


# ── Scénarios ────────────────────────────────────────────────────────────────

def test_classique(route, monkeypatch):
    """Tour sans outils sur un chat existant, réponse complète."""
    chats_mod, _ = route
    from shared_infra.chat.store import upsert_chat
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _classique())
    upsert_chat(1, "c1", "t", [{"role": "user", "content": "q0"},
                               {"role": "assistant", "content": "r0"}], 100.0)
    events, au_final = _tour({
        "messages": [{"role": "user", "content": "q0"},
                     {"role": "assistant", "content": "r0"},
                     {"role": "user", "content": "q1"}],
        "chat_id": "c1", "use_rag": False, "active_mcp_servers": []},
        base_au_final=True)
    assert _types(events) == ["mode", "queue_status", "queue_status", "queue_cleared",
                              "thinking_token", "content_token", "kv_cache", "final"]
    # La réponse est en base AVANT que le front ne reçoive le ``final``.
    assert au_final[-1]["content"] == "Bonjour."
    assert_matches_golden("flux_route_classique", {
        "evenements": _norm(events), "base_au_final": au_final,
        "base_apres": _messages_base("c1")})


def test_classique_chat_neuf_titre(route, monkeypatch):
    """Chat neuf : le titre généré par le modèle part dans le ``final``."""
    chats_mod, _ = route
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _classique())
    events, _ = _tour({
        "messages": [{"role": "user", "content": "Explique les goldens"}],
        "chat_id": "neuf", "use_rag": False, "active_mcp_servers": []})
    final = _norm(events)[-1]
    assert final["type"] == "final" and final["persisted"] is True
    assert_matches_golden("flux_route_chat_neuf_titre", {
        "evenements": _norm(events), "base_apres": _messages_base("neuf")})


def test_reprenable_question_en_base_avant_la_reponse(route, monkeypatch):
    """Run reprenable : la question est écrite dès le début du tour (elle
    survit à un crash), et la base de l'enregistrement optimiste est recalée
    sur cette écriture — l'enregistrement final passe sans conflit."""
    chats_mod, _ = route
    from shared_infra.chat.store import upsert_chat
    vu_pendant: list = []

    async def _pendant():
        vu_pendant.append(_messages_base("c2"))
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _classique(pendant=_pendant))
    upsert_chat(1, "c2", "t", [{"role": "user", "content": "q0"},
                               {"role": "assistant", "content": "r0"}], 100.0)
    events, _ = _tour({
        "messages": [{"role": "user", "content": "q0"},
                     {"role": "assistant", "content": "r0"},
                     {"role": "user", "content": "q1"}],
        "chat_id": "c2", "use_rag": False, "active_mcp_servers": [],
        "resumable": True})
    assert vu_pendant and vu_pendant[0][-1] == {"cles": ["content", "role"],
                                                "role": "user", "content": "q1"}
    final = _norm(events)[-1]
    assert final["persisted"] is True and "persist_error" not in final
    assert_matches_golden("flux_route_reprenable", {
        "evenements": _norm(events), "base_pendant_generation": vu_pendant[0],
        "base_apres": _messages_base("c2")})


def test_outils(route, monkeypatch):
    """Chemin MCP : ``mode`` « Outils prêts… » puis les événements de la boucle."""
    chats_mod, _ = route
    from shared_infra.accounts.users import update_user_settings
    from shared_infra.chat.store import upsert_chat
    _outils(monkeypatch, chats_mod)
    update_user_settings(1, {"enable_mcp": True, "mcp_servers": [DOCX]})
    upsert_chat(1, "c3", "t", [], 100.0)
    events, _ = _tour({
        "messages": [{"role": "user", "content": "lis a.docx"}],
        "chat_id": "c3", "use_rag": False,
        "active_mcp_servers": [{"id": "server_docx", "name": "docx", "type": "sse"}]})
    types = _types(events)
    assert types.index("queue_cleared") < types.index("tool_call") < types.index("final")
    assert_matches_golden("flux_route_outils", {
        "evenements": _norm(events), "base_apres": _messages_base("c3")})


def test_panne_du_worker(route, monkeypatch):
    """Exception pendant la génération : ``error`` puis ``final`` partiel."""
    chats_mod, _ = route
    from shared_infra.chat.store import upsert_chat

    async def _panne(msgs, **kw):
        await kw["on_content_token"]("début")
        raise RuntimeError("panne simulée")
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _panne)
    upsert_chat(1, "c4", "t", [], 100.0)
    events, _ = _tour({"messages": [{"role": "user", "content": "q"}],
                       "chat_id": "c4", "use_rag": False, "active_mcp_servers": []})
    types = _types(events)
    assert types[-2:] == ["error", "final"]
    assert_matches_golden("flux_route_panne", {
        "evenements": _norm(events), "base_apres": _messages_base("c4")})


def test_stop_pendant_la_file(route, monkeypatch):
    """Abandon de l'attente d'un modèle occupé : ``queue_cleared`` puis
    ``final`` partiel, pas de panne.

    Le faux ordonnanceur lève ``LLMQueueAborted`` SANS drapeau d'annulation :
    le ``queue_cleared`` de l'abandon passe donc le filtre. En production,
    ``cancel_probe`` n'abandonne que sur ce drapeau (un Stop) :
    ``_drop_event_after_cancel`` jette alors ce ``queue_cleared`` et seul le
    ``final`` partiel part."""
    chats_mod, ordo = route
    from shared_infra.chat.store import upsert_chat
    ordo.abandon = True
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _classique())
    upsert_chat(1, "c5", "t", [], 100.0)
    events, _ = _tour({"messages": [{"role": "user", "content": "q"}],
                       "chat_id": "c5", "use_rag": False, "active_mcp_servers": []})
    assert "error" not in _types(events)
    assert _types(events)[-2:] == ["queue_cleared", "final"]
    assert_matches_golden("flux_route_stop_file", {
        "evenements": _norm(events), "base_apres": _messages_base("c5")})


def test_continuer(route, monkeypatch):
    """« Continuer » d'une réponse tronquée : un seul message fusionné."""
    chats_mod, _ = route
    from shared_infra.chat.store import upsert_chat
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _classique(" et la suite."))
    upsert_chat(1, "c6", "t", [{"role": "user", "content": "q"},
                               {"role": "assistant", "content": "début coupé",
                                "isTruncated": True}], 100.0)
    events, _ = _tour({
        "messages": [{"role": "user", "content": "q"},
                     {"role": "assistant", "content": "début coupé"}],
        "chat_id": "c6", "is_continue": True, "use_rag": False,
        "active_mcp_servers": [], "resumable": True})
    assert_matches_golden("flux_route_continuer", {
        "evenements": _norm(events), "base_apres": _messages_base("c6")})


def test_conflit_d_enregistrement_optimiste(route, monkeypatch):
    """Le chat change en base pendant le tour (autre onglet) : rien n'est
    écrasé, le ``final`` le signale."""
    chats_mod, _ = route
    from shared_infra.chat.store import upsert_chat

    async def _ecriture_concurrente():
        upsert_chat(1, "c7", "t", [{"role": "user", "content": "autre onglet"},
                                   {"role": "assistant", "content": "autre réponse"}],
                    time.time() + 60)
    monkeypatch.setattr(execution, "llama_chat_stream_tokens",
                        _classique(pendant=_ecriture_concurrente))
    upsert_chat(1, "c7", "t", [], 100.0)
    events, _ = _tour({"messages": [{"role": "user", "content": "q"}],
                       "chat_id": "c7", "use_rag": False, "active_mcp_servers": []})
    final = _norm(events)[-1]
    assert final["persisted"] is False
    assert _messages_base("c7")[-1]["content"] == "autre réponse"
    assert_matches_golden("flux_route_conflit", {
        "evenements": _norm(events), "base_apres": _messages_base("c7")})


async def _lire_jusqu_a(it, events, type_):
    async for line in it:
        events.append(json.loads(line))
        if events[-1].get("type") == type_:
            return
    raise AssertionError(f"flux fini sans {type_}: {events}")


async def _attendre_fin_du_run(chat_id):
    for _ in range(500):
        if (_state.get_active_chat_task(1, chat_id) is None
                and not chat_locks.is_held("gen", 1, chat_id)):
            return
        await asyncio.sleep(0.01)
    raise AssertionError("le run ne s'est pas terminé")


async def test_stop_pendant_la_generation(route, monkeypatch):
    """Stop (drapeau + ``task.cancel``, comme ``/api/chat/cancel``) en pleine
    génération : ``final`` partiel annulé, partiel persisté."""
    chats_mod, _ = route
    from shared_infra.chat.store import upsert_chat

    async def _sans_fin():
        await asyncio.sleep(3600)
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _classique(pendant=_sans_fin))
    upsert_chat(1, "c8", "t", [], 100.0)
    resp = await chats_mod.api_chat_saved_stream3(_requete({
        "messages": [{"role": "user", "content": "q"}],
        "chat_id": "c8", "use_rag": False, "active_mcp_servers": []}))
    events: list = []
    it = resp.body_iterator
    await asyncio.wait_for(_lire_jusqu_a(it, events, "content_token"), 5)
    task = _state.get_active_chat_task(1, "c8")
    assert task is not None
    execution.mark_chat_cancelled(1, "c8")
    task.cancel()
    async for line in it:
        events.append(json.loads(line))
    await _attendre_fin_du_run("c8")
    final = _norm(events)[-1]
    assert final["type"] == "final" and final["cancelled"] is True
    assert_matches_golden("flux_route_stop_generation", {
        "evenements": _norm(events), "base_apres": _messages_base("c8")})


async def test_deconnexion_d_un_run_reprenable_le_detache(route, monkeypatch):
    """Navigateur parti pendant un run reprenable : l'exécution continue
    détachée et la réponse COMPLÈTE finit en base."""
    chats_mod, _ = route
    from shared_infra.chat.store import upsert_chat
    reprise = asyncio.Event()

    async def _attendre_le_feu_vert():
        await reprise.wait()
    monkeypatch.setattr(execution, "llama_chat_stream_tokens",
                        _classique(pendant=_attendre_le_feu_vert))
    upsert_chat(1, "c9", "t", [], 100.0)
    resp = await chats_mod.api_chat_saved_stream3(_requete({
        "messages": [{"role": "user", "content": "q"}],
        "chat_id": "c9", "use_rag": False, "active_mcp_servers": [],
        "resumable": True}))
    events: list = []
    it = resp.body_iterator
    await asyncio.wait_for(_lire_jusqu_a(it, events, "content_token"), 5)
    await it.aclose()                      # le navigateur part
    assert _state.get_active_chat_task(1, "c9") is not None, "run arrêté au lieu d'être détaché"
    reprise.set()
    await _attendre_fin_du_run("c9")
    apres = _messages_base("c9")
    assert apres[-1]["content"] == "Bonjour." and "isTruncated" not in apres[-1]
    assert_matches_golden("flux_route_detache", {
        "evenements_avant_depart": _norm(events), "base_apres": apres})
