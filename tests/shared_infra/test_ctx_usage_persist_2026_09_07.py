# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_ctx_usage_persist_2026_09_07.py — occupation de
contexte PERSISTÉE par chat (``meta_json["ctx_usage"]``).

Demande user (2026-09-07) : après un rechargement de page ou un redémarrage
du backend, l'utilisateur doit voir l'occupation RÉELLE du contexte du chat
(dernier prompt envoyé / n_ctx) avant de reprendre — jusqu'ici la jauge
repartait masquée et la pill « contexte au moment de la réponse » des
messages ne survivait pas au reload (snapshot client seulement).

Couvre :
  • store : ``finalize_turn_meta(..., ctx_usage=…)`` écrit un snapshot
    nettoyé, relu par ``get_chat`` ; shapes invalides ignorées ; volets
    voisins (élagage, outils) intacts ; ``clear_chat_ctx_usage`` l'efface ;
  • route : ``_ctx_usage_snapshot`` (chats.py) — cible locale + mesure
    fiable ⇒ snapshot ; cumul du chemin outils, cible distante, n_ctx
    inconnu ⇒ None (jamais un pourcentage inventé) ;
  • GET /api/saved/chats/{id} expose ``ctx_usage``.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    uid = create_user("alice", "pw-alice")
    from shared_infra.chat.store import upsert_chat
    upsert_chat(uid, "chat1", "t", [{"role": "user", "content": "x"}], 1.0)
    return uid


# ── Store ─────────────────────────────────────────────────────────────────────
def test_finalize_turn_meta_persiste_ctx_usage(db):
    from shared_infra.chat.store import finalize_turn_meta, get_chat
    uid = db
    assert get_chat(uid, "chat1")["ctx_usage"] is None
    ok = finalize_turn_meta(uid, "chat1", None, None, False, ctx_usage={
        "used": 18_400, "total": 65_536, "pct": 28, "model": "qwen3", "ts": 1.5})
    assert ok is True
    cu = get_chat(uid, "chat1")["ctx_usage"]
    assert cu["used"] == 18_400 and cu["total"] == 65_536 and cu["pct"] == 28
    assert cu["model"] == "qwen3" and cu["ts"] == 1.5
    # pct recalculé si absent ; ts posé si absent.
    finalize_turn_meta(uid, "chat1", None, None, False,
                       ctx_usage={"used": 32_768, "total": 65_536})
    cu = get_chat(uid, "chat1")["ctx_usage"]
    assert cu["pct"] == 50 and cu["ts"] > 0
    # Un snapshot borné : used > total ⇒ clampé, pct ≤ 100.
    finalize_turn_meta(uid, "chat1", None, None, False,
                       ctx_usage={"used": 70_000, "total": 65_536})
    cu = get_chat(uid, "chat1")["ctx_usage"]
    assert cu["used"] == 65_536 and cu["pct"] == 100


def test_ctx_usage_invalide_ignore_et_volets_voisins_intacts(db):
    from shared_infra.chat.store import finalize_turn_meta, get_chat
    uid = db
    finalize_turn_meta(uid, "chat1", ["k1"], ["fs"], False,
                       ctx_usage={"used": 1000, "total": 8192})
    # Shapes invalides : rien n'est écrasé.
    for bad in ({"used": 0, "total": 8192}, {"used": 10, "total": 0},
                {"used": "x", "total": 8192}, "nope", [], 42):
        finalize_turn_meta(uid, "chat1", None, None, False, ctx_usage=bad)
        assert get_chat(uid, "chat1")["ctx_usage"]["used"] == 1000
    c = get_chat(uid, "chat1")
    assert c["ctx_pruned_keys"] == ["k1"] and c["tools"] == ["fs"]
    # Appel SANS ctx_usage : la valeur précédente survit.
    finalize_turn_meta(uid, "chat1", ["k2"], None, False)
    assert get_chat(uid, "chat1")["ctx_usage"]["used"] == 1000


def test_clear_chat_ctx_usage(db):
    from shared_infra.chat.store import clear_chat_ctx_usage, finalize_turn_meta, get_chat
    uid = db
    finalize_turn_meta(uid, "chat1", None, None, False,
                       ctx_usage={"used": 1000, "total": 8192})
    assert clear_chat_ctx_usage(uid, "chat1") is True
    assert get_chat(uid, "chat1")["ctx_usage"] is None
    assert clear_chat_ctx_usage(uid, "inconnu") is False


# ── Route : snapshot de fin de tour ───────────────────────────────────────────
class _Local:
    is_local_llamacpp = True
    is_llamacpp = True


class _Remote:
    # Fournisseur NON llama.cpp (un connecteur llama.cpp a sa jauge depuis
    # le 2026-09-16 : n_ctx lu sur SON serveur).
    is_local_llamacpp = False
    is_llamacpp = False


async def test_ctx_usage_snapshot_cible_locale(monkeypatch):
    import llm_core
    from chatbot_app.turn.execution import _ctx_usage_snapshot

    async def _n_ctx(model):
        return 65_536

    monkeypatch.setattr(llm_core, "get_model_context_size", _n_ctx)
    # Chemin outils : dernier prompt réel → occupation.
    snap = await _ctx_usage_snapshot(
        {"input_tokens": 2_000_000, "submitted_input_tokens": 2_000_000,
         "last_prompt_tokens": 18_400}, "qwen3", _Local())
    assert snap and snap["used"] == 18_400 and snap["total"] == 65_536
    assert snap["pct"] == 28 and snap["model"] == "qwen3" and snap["ts"] > 0
    # Chat classique : input_tokens = prompt du seul appel.
    snap = await _ctx_usage_snapshot({"input_tokens": 900}, "qwen3", _Local())
    assert snap and snap["used"] == 900


async def test_ctx_usage_snapshot_refuse_les_mesures_douteuses(monkeypatch):
    import llm_core
    from chatbot_app.turn.execution import _ctx_usage_snapshot

    async def _n_ctx(model):
        return 65_536

    monkeypatch.setattr(llm_core, "get_model_context_size", _n_ctx)
    # Cumul du chemin outils sans last_prompt_tokens : jamais une occupation.
    assert await _ctx_usage_snapshot(
        {"input_tokens": 2_000_000, "submitted_input_tokens": 2_000_000,
         "tool_limit_reached": True}, "qwen3", _Local()) is None
    # Cible distante : n_ctx local ≠ modèle distant → rien.
    assert await _ctx_usage_snapshot(
        {"last_prompt_tokens": 18_400}, "claude", _Remote()) is None
    assert await _ctx_usage_snapshot(None, "qwen3", _Local()) is None

    async def _zero(model):
        return 0

    monkeypatch.setattr(llm_core, "get_model_context_size", _zero)
    assert await _ctx_usage_snapshot(
        {"last_prompt_tokens": 18_400}, "qwen3", _Local()) is None


# ── GET /api/saved/chats/{id} ─────────────────────────────────────────────────
def test_get_saved_chat_expose_ctx_usage(db, monkeypatch):
    uid = db
    import chatbot_app.routes.saved_chats as saved_mod

    def _fake_uid(request: Request):
        v = request.headers.get("x-test-user")
        if not v:
            raise HTTPException(401, "auth requise")
        return int(v)

    monkeypatch.setattr(saved_mod, "require_user_id", _fake_uid)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    r = client.get("/api/saved/chats/chat1", headers={"x-test-user": str(uid)})
    assert r.status_code == 200 and r.json()["ctx_usage"] is None

    from shared_infra.chat.store import finalize_turn_meta
    finalize_turn_meta(uid, "chat1", None, None, False,
                       ctx_usage={"used": 18_400, "total": 65_536, "model": "qwen3"})
    r = client.get("/api/saved/chats/chat1", headers={"x-test-user": str(uid)})
    cu = r.json()["ctx_usage"]
    assert cu["used"] == 18_400 and cu["total"] == 65_536 and cu["pct"] == 28
