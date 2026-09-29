# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_manual_compress_route.py — déclencheur MANUEL de
compression (E2E routeur partagé + vraie DB temp).

Couvre :
- GET /api/chat/{id}/compression-state : 404, reasons ok/too_short/max_reached/
  generation_running, round/max exposés ;
- POST /api/chat/{id}/compress : 404, 409 génération en cours, 409 double
  compression, succès (état persisté EN TÊTE de messages_json, bulles
  intactes, round 1), cap → compressed:false max_rounds_reached ;
- PUT save-messages : carry-forward de l'état (le client ne renvoie jamais
  le message system) + garde anti-stale insensible au message d'état ;
- POST /api/chat-saved-stream3 : 409 si compression manuelle en vol.

Auth simulée en patchant ``require_user_id`` (pattern test_usage_route.py).
LLM de résumé + /tokenize monkeypatchés (aucun réseau).
"""
from __future__ import annotations

import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


def _conv(n_pairs: int, chars: int = 200) -> list:
    msgs = []
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"question {i} " + "x" * chars})
        msgs.append({"role": "assistant", "content": f"réponse {i} " + "y" * chars})
    return msgs


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice") == 1

    import chatbot_app.routes.chats as chats_mod
    import chatbot_app.routes.saved_chats as saved_mod  # enregistre PUT save-messages

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(chats_mod, "require_user_id", _fake_uid)
    monkeypatch.setattr(saved_mod, "require_user_id", _fake_uid)
    monkeypatch.setattr(chats_mod, "_manual_compressions", set())

    # ── Compression déterministe, zéro réseau ─────────────────────────────
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "reload_compression_config_from_disk",
                        lambda force=False: False)
    monkeypatch.setattr(cfg, "COMPRESSION_ENABLED", True)
    monkeypatch.setattr(cfg, "COMPRESSION_KEEP_RECENT", 2)
    monkeypatch.setattr(cfg, "COMPRESSION_KEEP_BRIDGE", 1)
    monkeypatch.setattr(cfg, "COMPRESSION_EXTERNAL_MODEL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_ENDPOINT_URL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_ENDPOINT_MODEL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_MAX_PER_CHAT", 2)

    import llm_core._llama_http as lh

    async def _count(messages, model_id=None, timeout=None):
        return max(1, sum(len(m.get("content") or "")
                          for m in messages if isinstance(m.get("content"), str)) // 3)

    monkeypatch.setattr(lh, "count_tokens_for_messages", _count)

    async def _fake_llama(prompt, user_id="t", model_override=None):
        return "<context>résumé compact</context>", {"model": "fake"}

    monkeypatch.setattr(chats_mod, "llama_chat", _fake_llama)

    import llm_core

    async def _no_ctx(_model=""):
        return 0

    monkeypatch.setattr(llm_core, "get_model_context_size", _no_ctx)

    # Fallback modèle chargé (route sans body) — zéro réseau.
    async def _loaded():
        return "loaded-model"
    monkeypatch.setattr(llm_core, "get_currently_loaded_model", _loaded)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    from shared_infra.chat.store import get_chat, upsert_chat
    return TestClient(app), chats_mod, get_chat, upsert_chat


def _alice():
    return {"x-test-user": "1"}


# ──────────────────────────────────────────────────────────────────────────

def test_state_404_chat_inconnu(client):
    tc, *_ = client
    assert tc.get("/api/chat/nope/compression-state", headers=_alice()).status_code == 404
    assert tc.post("/api/chat/nope/compress", headers=_alice()).status_code == 404


def test_state_too_short_puis_ok(client):
    tc, _, _, upsert = client
    upsert(1, "c1", "T", _conv(1), time.time())     # 2 tours ≤ keep(3)
    d = tc.get("/api/chat/c1/compression-state", headers=_alice()).json()
    assert d["reason"] == "too_short" and d["can_compress"] is False
    assert d["round"] == 0 and d["max"] == 2

    upsert(1, "c2", "T", _conv(8), time.time())     # 16 tours
    d = tc.get("/api/chat/c2/compression-state", headers=_alice()).json()
    assert d["reason"] == "ok" and d["can_compress"] is True
    assert d["turns"] == 16 and d["tokens_estimate"] > 0 and d["estimated"] is True


def test_state_turns_sur_vue_post_drop(client):
    """Le GET compte la vue RÉELLE de la prochaine requête : les tours déjà
    couverts par le résumé persisté sont droppés (avant : vue brute →
    can_compress sur-optimiste et tokens gonflés)."""
    tc, _, _, upsert = client
    from llm_core.conversation_compressor import build_state_system_message
    state = build_state_system_message("<context>x</context>", 1, 4)
    upsert(1, "c1", "T", [state] + _conv(8), time.time())    # 16 tours bruts
    d = tc.get("/api/chat/c1/compression-state", headers=_alice()).json()
    assert d["round"] == 1
    assert d["turns"] == 16 - 4              # drop appliqué
    assert d["scope"] == "history_only"
    assert d["tokens_estimate"] > 0


def test_state_too_short_parite_apres_compression(client):
    """Chat compressé dont le résidu post-drop ≤ keep → too_short. Avant, la
    vue brute promettait « ok » et le clic finissait en nothing_to_compress."""
    tc, _, _, upsert = client
    from llm_core.conversation_compressor import build_state_system_message
    state = build_state_system_message("<context>x</context>", 1, 5)
    upsert(1, "c1", "T", [state] + _conv(4), time.time())    # 8 tours bruts
    d = tc.get("/api/chat/c1/compression-state", headers=_alice()).json()
    assert d["turns"] == 3                   # 8 − 5 couverts
    assert d["reason"] == "too_short"
    assert d["can_compress"] is False


def test_compress_succes_persiste_etat_et_bulles(client):
    tc, _, get_chat, upsert = client
    bulles = _conv(8)
    upsert(1, "c1", "Mon chat", bulles, time.time())
    r = tc.post("/api/chat/c1/compress", headers=_alice())
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] is True and d["compressed"] is True
    assert d["stats"]["round"] == 1 and d["stats"]["max"] == 2
    assert d["stats"]["tokens_saved"] > 0

    stored = get_chat(1, "c1")["messages"]
    # État system EN TÊTE, bulles inchangées derrière, puis le MARQUEUR
    # persistant « conversation compactée » (role notice) en queue — c'est lui
    # qui rend la compaction visible dans le fil, reload compris.
    assert stored[0]["role"] == "system"
    assert "[COMPRESSION_META v=1 round=1" in stored[0]["content"]
    assert stored[1:-1] == bulles
    _notice = stored[-1]
    assert _notice["role"] == "notice" and _notice["kind"] == "compaction"
    assert _notice["tokens_after"] == d["stats"]["tokens_after"]
    assert _notice["ts"] > 0
    # Accordéon « Vérifier le compact » (UX 2026-07-25) : le résumé produit
    # voyage dans la RÉPONSE (notice optimiste du front) ET dans le notice
    # persisté (reload-proof) — même contenu que le porteur system.
    assert d["stats"]["summary_xml"].strip().startswith("<context>")
    assert _notice["summary"] == d["stats"]["summary_xml"]
    assert _notice["summary"] in stored[0]["content"]
    # L'état se reflète dans le GET.
    d2 = tc.get("/api/chat/c1/compression-state", headers=_alice()).json()
    assert d2["round"] == 1


def test_compress_utilise_le_modele_de_la_requete(client, monkeypatch):
    """Le LLM de compression reçoit le MODÈLE COURANT envoyé par le front, PAS
    le défaut LLAMA_MODEL (placeholder routeur type « RAG » → 400 llama-server)."""
    tc, chats_mod, _, upsert = client
    seen = {}

    async def _capture(prompt, user_id="t", model_override=None):
        seen["model"] = model_override
        return "<context>résumé compact</context>", {"model": model_override}
    monkeypatch.setattr(chats_mod, "llama_chat", _capture)

    upsert(1, "c1", "T", _conv(8), time.time())
    r = tc.post("/api/chat/c1/compress", headers=_alice(),
                json={"model": "Qwen-AgentWorld-35B"})
    assert r.status_code == 200 and r.json()["compressed"] is True
    assert seen["model"] == "Qwen-AgentWorld-35B"   # pas None / pas le défaut


def test_compress_fallback_modele_charge_si_pas_de_body(client, monkeypatch):
    """Sans modèle dans la requête, on retombe sur le modèle RÉELLEMENT CHARGÉ
    (get_currently_loaded_model), pas sur LLAMA_MODEL."""
    tc, chats_mod, _, upsert = client
    seen = {}

    async def _capture(prompt, user_id="t", model_override=None):
        seen["model"] = model_override
        return "<context>résumé compact</context>", {"model": model_override}
    monkeypatch.setattr(chats_mod, "llama_chat", _capture)

    upsert(1, "c1", "T", _conv(8), time.time())
    r = tc.post("/api/chat/c1/compress", headers=_alice())   # pas de body
    assert r.status_code == 200 and r.json()["compressed"] is True
    assert seen["model"] == "loaded-model"          # fallback modèle chargé


def test_compress_cap_atteint(client):
    tc, _, get_chat, upsert = client
    from llm_core.conversation_compressor import build_state_system_message
    state = build_state_system_message("<context>x</context>", 2, 10)
    upsert(1, "c1", "T", [state] + _conv(8), time.time())

    d = tc.get("/api/chat/c1/compression-state", headers=_alice()).json()
    assert d["reason"] == "max_reached" and d["can_compress"] is False
    assert d["round"] == 2 and d["max"] == 2

    r = tc.post("/api/chat/c1/compress", headers=_alice())
    assert r.status_code == 200
    d = r.json()
    assert d["compressed"] is False and d["reason"] == "max_rounds_reached"
    # L'état stocké n'a pas bougé.
    assert "round=2" in get_chat(1, "c1")["messages"][0]["content"]


def test_compress_409_generation_en_cours(client):
    tc, chats_mod, _, upsert = client
    upsert(1, "c1", "T", _conv(8), time.time())
    from shared_infra.routes._state import register_chat_task, unregister_chat_task

    class _FakeTask:
        pass

    register_chat_task(1, _FakeTask(), "c1")
    try:
        assert tc.post("/api/chat/c1/compress", headers=_alice()).status_code == 409
        d = tc.get("/api/chat/c1/compression-state", headers=_alice()).json()
        assert d["reason"] == "generation_running"
    finally:
        unregister_chat_task(1, "c1")


def test_compress_409_double_et_stream_409(client):
    tc, chats_mod, _, upsert = client
    upsert(1, "c1", "T", _conv(8), time.time())
    chats_mod._manual_compressions.add((1, "c1"))
    try:
        assert tc.post("/api/chat/c1/compress", headers=_alice()).status_code == 409
        # Symétrie : le stream refuse de démarrer pendant la compression.
        r = tc.post("/api/chat-saved-stream3", headers=_alice(),
                    json={"chat_id": "c1", "messages": []})
        assert r.status_code == 409
    finally:
        chats_mod._manual_compressions.discard((1, "c1"))


def test_save_messages_carry_forward_etat(client):
    tc, _, get_chat, upsert = client
    bulles = _conv(8)
    upsert(1, "c1", "T", bulles, time.time())
    assert tc.post("/api/chat/c1/compress", headers=_alice()).json()["compressed"] is True

    # Le client sauvegarde ses bulles (JAMAIS le message system) + du contenu
    # en plus (garde anti-stale : le contenu doit croître).
    new_bulles = bulles + [{"role": "user", "content": "nouvelle question " + "z" * 50}]
    r = tc.put("/api/saved/chats/c1/save-messages", headers=_alice(),
               json={"messages": new_bulles, "title": "T"})
    assert r.status_code == 200 and r.json().get("ok") is True

    stored = get_chat(1, "c1")["messages"]
    assert stored[0]["role"] == "system"
    assert "[COMPRESSION_META v=1 round=1" in stored[0]["content"]
    assert stored[1:] == new_bulles


def test_save_messages_anti_stale_ignore_etat(client):
    """La garde anti-stale compare les contenus SANS le message d'état —
    sinon tout save-messages d'un chat compressé serait rejeté « stale »."""
    tc, _, get_chat, upsert = client
    bulles = _conv(8)
    upsert(1, "c1", "T", bulles, time.time())
    assert tc.post("/api/chat/c1/compress", headers=_alice()).json()["compressed"] is True

    # Payload de MÊME taille que les bulles stockées (pas plus court) : doit
    # passer même si le stocké contient EN PLUS le gros message d'état.
    r = tc.put("/api/saved/chats/c1/save-messages", headers=_alice(),
               json={"messages": bulles, "title": "T"})
    assert r.status_code == 200
    assert r.json().get("skipped") is None


def test_compress_manuel_disponible_meme_auto_desactivee(client, monkeypatch):
    """Le toggle admin ``llm.compression.enabled`` (compression AUTO) ne doit
    JAMAIS désactiver la compaction manuelle (/compact) — acte explicite de
    l'utilisateur. Bug vu en prod 2026-07-13."""
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "COMPRESSION_ENABLED", False)
    tc, _, get_chat, upsert = client
    bulles = _conv(8)
    upsert(1, "c-off", "T", bulles, time.time())

    # L'état ne rapporte PAS "disabled" (l'UI manuelle reste opérante).
    st = tc.get("/api/chat/c-off/compression-state", headers=_alice()).json()
    assert st["reason"] != "disabled" and st["can_compress"] is True

    # Et la compaction manuelle passe (marqueur notice inclus).
    d = tc.post("/api/chat/c-off/compress", headers=_alice()).json()
    assert d["ok"] is True and d["compressed"] is True
    assert get_chat(1, "c-off")["messages"][-1]["role"] == "notice"


def test_save_messages_garde_le_registre_d_artefacts(client):
    """(2026-09-21, B6) Le carry-forward de save-messages reconstruisait l'état
    SANS ``ledger_block`` : le registre d'artefacts disparaissait."""
    from llm_core.context.compression.serializer import render_artifact_ledger
    from llm_core.conversation_compressor import build_state_system_message
    tc, _, get_chat, upsert = client
    bulles = _conv(8)
    ledger = render_artifact_ledger(["- write src/app.py (tour 3)"])
    etat = build_state_system_message("<summary>résumé</summary>", 1, 4,
                                      ledger_block=ledger)
    upsert(1, "c1", "T", [etat] + bulles, time.time())
    new_bulles = bulles + [{"role": "user", "content": "suite " + "z" * 50}]
    r = tc.put("/api/saved/chats/c1/save-messages", headers=_alice(),
               json={"messages": new_bulles, "title": "T"})
    assert r.status_code == 200
    stored = get_chat(1, "c1")["messages"]
    assert "write src/app.py" in stored[0]["content"]
