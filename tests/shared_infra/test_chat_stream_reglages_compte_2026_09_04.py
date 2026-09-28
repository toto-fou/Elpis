# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_chat_stream_reglages_compte_2026_09_04.py — les
réglages du COMPTE atteignent-ils la route de génération quand la porte de
session a mis la ligne ``users`` en cache (forme de production) ?

RÉGRESSION 2026-09-02 → 2026-09-04 (audit passe 6, B4). Pour économiser un
``SELECT``, la route relisait ``settings_json`` depuis
``request.state._user_row`` avec ``json.loads`` — et ``json`` n'était pas
importé dans ``chats.py``. Le ``NameError`` tombait dans un
``except Exception: user_settings = {}``. Conséquence, à CHAQUE tour :
serveurs MCP externes jetés à la résolution (perso ET bibliothèque
partagée, faute de ``shared_mcp_visible``), sous-agents et mémoire éteints,
prompt custom perdu, ``enable_mcp`` remis au défaut. Les outils LOCAUX ne
passent pas par les réglages : « seuls les externes ont disparu ».

Pourquoi 4 000 tests n'ont rien vu : ils simulent l'authentification en
patchant ``require_user_id`` SANS poser ``_user_row``, donc seul le repli
(``get_user_settings``, correct) était exercé. Le faux ``require_user_id``
d'ici pose la ligne en cache EXACTEMENT comme ``deps._session_validity_checks``.
"""
from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

DOCX = {"id": "server_docx", "name": "docx", "type": "sse",
        "url": "http://127.0.0.1:1/sse", "command": "", "visible": True,
        "auth_mode": "", "auth_user": "", "auth_enc": "", "key_scheme": "plain"}


# ── L'aide de lecture de la ligne en cache ───────────────────────────────

def _row(settings_json):
    """Une vraie ``sqlite3.Row`` — c'est ce que la porte de session stocke."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE users (id INTEGER, username TEXT, settings_json TEXT)")
    conn.execute("INSERT INTO users VALUES (1, 'alice', ?)", (settings_json,))
    return conn.execute("SELECT * FROM users").fetchone()


def test_ligne_en_cache_row_sqlite():
    from chatbot_app.routes.chats import _settings_from_cached_row
    s = _settings_from_cached_row(_row(json.dumps({"enable_mcp": False, "mcp_servers": [DOCX]})))
    assert s == {"enable_mcp": False, "mcp_servers": [DOCX]}


def test_ligne_en_cache_dict_et_vide():
    from chatbot_app.routes.chats import _settings_from_cached_row
    assert _settings_from_cached_row({"settings_json": '{"a": 1}'}) == {"a": 1}
    assert _settings_from_cached_row(_row("")) == {}      # compte neuf : défauts
    assert _settings_from_cached_row(_row(None)) == {}


def test_ligne_en_cache_illisible_renvoie_none_jamais_vide(caplog):
    """Illisible ⇒ ``None`` (l'appelant relit en base), et ça se DIT. Un
    ``{}`` silencieux ici coupe tous les outils externes du compte."""
    from chatbot_app.routes.chats import _settings_from_cached_row
    with caplog.at_level("WARNING"):
        assert _settings_from_cached_row(_row("{pas du json")) is None
    assert "settings_json illisible" in caplog.text
    assert _settings_from_cached_row(_row("[1, 2]")) is None          # pas un objet
    assert _settings_from_cached_row({"username": "x"}) is None       # colonne absente


# ── La route, avec la ligne en cache posée comme en production ──────────

@pytest.fixture()
def harnais(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user, get_user_by_id, update_user_settings
    assert create_user("alice", "pw-alice") == 1

    import chatbot_app.routes.chats as chats_mod

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        # Forme de PRODUCTION (deps._session_validity_checks, passe 6 B4) : la
        # ligne ``users`` entière est mise en cache sur le state de la requête
        # et la route la relit AU LIEU de refaire un SELECT.
        request.state._user_row = get_user_by_id(int(uid))
        return int(uid)

    monkeypatch.setattr(chats_mod, "require_user_id", _fake_uid)

    # ── Boucle outillée remplacée par un stub qui capture ses configs ──
    import llm_core
    capture: dict = {"appels": []}

    async def _stub_outils(messages, mcp_configs=None, on_event=None, **kw):
        capture["appels"].append(list(mcp_configs or []))
        if on_event:
            await on_event({"type": "content_token", "text": "ok"})
        return "ok", [], {"model": "stub"}

    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _stub_outils)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp_v2", _stub_outils)
    # chats.py importe la boucle « classique » au niveau module : sans
    # config.json (clone neuf), le mode de scheduling vaut « classic ».
    monkeypatch.setattr(chats_mod, "run_chat_multi_mcp", _stub_outils)

    # ── Chemin SANS outils : jamais de réseau ─────────────────────────
    async def _stub_classique(msgs, **kw):
        capture["classique"] = True
        return "", "ok", {}

    monkeypatch.setattr(chats_mod, "llama_chat_stream_tokens", _stub_classique)

    async def _zero(_model=""):
        return 0
    monkeypatch.setattr(llm_core, "get_model_context_size", _zero)

    import llm_core._queue as queue_mod

    async def _pas_de_file(_model=None):
        return {}
    monkeypatch.setattr(queue_mod, "get_queue_status_for_async", _pas_de_file)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), update_user_settings, capture


def _tour(tc, serveurs):
    """Un tour éphémère (rien n'est persisté) ; renvoie les events NDJSON."""
    body = {"messages": [{"role": "user", "content": "quels sont tes outils ?"}],
            "chat_id": "", "ephemeral": True, "use_rag": False,
            "active_mcp_servers": serveurs}
    events = []
    with tc.stream("POST", "/api/chat-saved-stream3", json=body,
                   headers={"x-test-user": "1"}) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line:
                events.append(json.loads(line))
    return events


def _modes(events):
    return [e["text"] for e in events if e.get("type") == "mode"]


def test_serveur_perso_resolu_avec_la_ligne_en_cache(harnais):
    """LE cas de la régression : un serveur perso coché doit atteindre la
    boucle outillée avec son URL, résolue depuis les réglages du compte."""
    tc, update_user_settings, capture = harnais
    update_user_settings(1, {"enable_mcp": True, "mcp_servers": [DOCX]})

    events = _tour(tc, [{"id": "server_docx", "name": "docx", "type": "sse"}])

    assert any(m.startswith("MCP: docx") for m in _modes(events)), _modes(events)
    assert capture["appels"], "la boucle outillée n'a pas été appelée"
    configs = capture["appels"][-1]
    docx = [c for c in configs if c.get("name") == "docx"]
    assert docx and docx[0]["url"] == DOCX["url"]
    assert "classique" not in capture


def test_bibliotheque_partagee_resolue_avec_la_ligne_en_cache(harnais):
    """Même racine : ``shared_mcp_visible`` vit dans les réglages du compte.
    Réglages vides ⇒ aucun serveur partagé ne passe, sans erreur."""
    tc, update_user_settings, capture = harnais
    from shared_infra.mcp import servers as srv
    res = srv.create_shared(name="wiki", type="sse", url="http://127.0.0.1:1/wiki/sse")
    sid = res["id"] if isinstance(res, dict) else res
    public = f"{srv.ID_PREFIX}{sid}"
    update_user_settings(1, {"enable_mcp": True, "mcp_servers": [],
                             "shared_mcp_visible": [public]})

    events = _tour(tc, [{"id": public, "name": "wiki", "type": "sse", "shared": True}])

    assert any(m.startswith("MCP: wiki") for m in _modes(events)), _modes(events)
    configs = capture["appels"][-1]
    assert any(c.get("url") == "http://127.0.0.1:1/wiki/sse" for c in configs)


def test_enable_mcp_false_est_lu_depuis_la_ligne_en_cache(harnais):
    """L'interrupteur « Outils externes » du compte doit être VU : avec des
    réglages vides il retombait au défaut (ON) — autre face du même bug."""
    tc, update_user_settings, capture = harnais
    update_user_settings(1, {"enable_mcp": False, "mcp_servers": [DOCX]})

    events = _tour(tc, [{"id": "server_docx", "name": "docx", "type": "sse"}])

    assert "Génération en cours…" in _modes(events)
    assert not capture["appels"]
    assert capture.get("classique") is True


def test_sans_ligne_en_cache_le_repli_lit_la_base(harnais):
    """Le repli (state sans ``_user_row``) reste correct — c'est le seul
    chemin que les autres tests exercent, il ne doit pas régresser non plus."""
    tc, update_user_settings, capture = harnais
    import chatbot_app.routes.chats as chats_mod

    def _uid_sans_cache(request: Request):
        return int(request.headers["x-test-user"])
    chats_mod.require_user_id = _uid_sans_cache
    update_user_settings(1, {"enable_mcp": True, "mcp_servers": [DOCX]})

    events = _tour(tc, [{"id": "server_docx", "name": "docx", "type": "sse"}])

    assert any(m.startswith("MCP: docx") for m in _modes(events)), _modes(events)


@pytest.fixture(autouse=True)
def _sans_garde_ssrf(monkeypatch):
    """Serveurs factices sur 127.0.0.1 : la garde SSRF des MCP perso
    (audit 2026-09-22, H7) a ses propres tests."""
    import shared_infra.mcp.servers as _srv
    monkeypatch.setattr(_srv, "personal_url_block_reason", lambda url: None)
