# SPDX-License-Identifier: MIT
"""tests/llm_core/test_todo_status_reminder.py — rappel <todo_status> au début
de tour.

Constat utilisateur 2026-08-02 : une todo-list laissée ouverte au tour N
n'était jamais RE-DONNÉE au modèle au tour N+1 comme état courant — elle ne
survivait que dans le tool_history rejoué (enfoui, élagable par prune/
compaction, jamais relu spontanément) → le modèle ne la continuait ni ne la
soldait. Contrat :

- des tâches ouvertes (pending/in_progress) en ``meta_json["todos"]`` ET
  ``todowrite`` disponible ce run → un message user ÉPHÉMÈRE ``<todo_status>``
  est appendu en QUEUE du prompt du 1er appel LLM (tête système intacte) ;
- il liste chaque tâche avec son statut et n'est JAMAIS persisté (absent du
  tool_history retourné) ;
- liste vide / entièrement soldée / pas de chat_id / todowrite absent du run
  (enfant task en deny, run sans outils) → AUCUNE injection.
"""
from __future__ import annotations

import pytest

import llm_core._chat_with_tools as _cwt
import llm_core._target as _tgt

# ── Fixture DB : users + chats avec meta_json (pattern test_todo_tools) ──────

@pytest.fixture()
def DB(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE)"
        )
        conn.execute("INSERT INTO users (id, username) VALUES (7, 'u')")
        conn.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, "
            "messages_json TEXT, updated_at REAL, archived INTEGER DEFAULT 0, "
            "meta_json TEXT NOT NULL DEFAULT '{}')"
        )
        conn.execute(
            "INSERT INTO chats (id, user_id, title, messages_json, updated_at) "
            "VALUES ('c1', 7, 't', '[]', 1.0)"
        )
        conn.commit()
    import shared_infra.chat.store as chats
    return chats


OPEN_TODOS = [
    {"content": "Analyser le code", "status": "completed", "priority": "medium"},
    {"content": "Écrire le correctif", "status": "in_progress", "priority": "high"},
    {"content": "Lancer les tests", "status": "pending", "priority": "medium"},
]


# ── Unitaires : _todo_status_reminder ────────────────────────────────────────

def test_reminder_liste_ouverte(DB):
    DB.set_chat_todos(7, "c1", OPEN_TODOS)
    txt = _cwt._todo_status_reminder("u", "c1")
    assert txt and txt.startswith("<todo_status>") and txt.endswith("</todo_status>")
    assert "2 open task(s)" in txt
    # Forme canonique « N. [status] contenu », identique au ``checklist`` de
    # todowrite (le modèle recopie ce qu'il voit) ; plus de priorité montrée.
    assert "\n2. [in_progress] Écrire le correctif\n" in txt
    assert "3. [pending] Lancer les tests" in txt
    assert "priority" not in txt
    assert "todowrite" in txt              # consigne : solder via l'outil


def test_reminder_none_si_soldee_ou_absente(DB):
    assert _cwt._todo_status_reminder("u", "c1") is None          # pas de liste
    DB.set_chat_todos(7, "c1", [
        {"content": "a", "status": "completed", "priority": "medium"},
        {"content": "b", "status": "cancelled", "priority": "medium"},
    ])
    assert _cwt._todo_status_reminder("u", "c1") is None          # tout soldé


def test_reminder_none_sans_chat_persiste(DB):
    assert _cwt._todo_status_reminder("u", None) is None
    assert _cwt._todo_status_reminder("u", "default") is None
    assert _cwt._todo_status_reminder("inconnu", "c1") is None    # user inconnu


def test_get_chat_todos_lean(DB):
    DB.set_chat_todos(7, "c1", OPEN_TODOS)
    assert DB.get_chat_todos(7, "c1") == OPEN_TODOS
    assert DB.get_chat_todos(7, "nope") == []


# ── Intégration boucle : injection éphémère au 1er appel LLM ─────────────────

async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


class _FakeTarget:
    is_local_llamacpp = True


def _patch_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_tgt, "current_target", lambda: _FakeTarget())


async def _run_turn(monkeypatch, *, with_todowrite=True):
    """Un tour sans tool call (réponse directe) ; retourne (messages du 1er
    appel LLM, tool_history retourné)."""
    _patch_env(monkeypatch)
    seen_msgs: list = []

    async def _fake_stream(messages, tools_payload, **kw):
        seen_msgs.append([dict(m) for m in messages])
        return {
            "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": "ok", "tool_calls": None}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 5},
            "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    async def _bloc(fargs):
        return "{}"

    builtins = {"write_file": {
        "definition": {"type": "function", "function": {
            "name": "write_file", "parameters": {"type": "object"}}},
        "handler": _bloc}}
    if with_todowrite:
        builtins["todowrite"] = {
            "definition": {"type": "function", "function": {
                "name": "todowrite", "parameters": {"type": "object"}}},
            "handler": _bloc}

    final, _evs, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "Continue le travail."}],
        [], username="u", builtin_tools=builtins, chat_id="c1",
    )
    return seen_msgs[0], metrics.get("tool_history") or []


def _todo_msgs(msgs):
    return [m for m in msgs if m.get("role") == "user"
            and "<todo_status>" in str(m.get("content", ""))]


async def test_injection_ephemere_au_tour_suivant(DB, monkeypatch):
    DB.set_chat_todos(7, "c1", OPEN_TODOS)
    first_call, tool_history = await _run_turn(monkeypatch)
    reminders = _todo_msgs(first_call)
    assert len(reminders) == 1
    assert "Écrire le correctif" in reminders[0]["content"]
    # En QUEUE du prompt (après le message user réel), tête système intacte.
    assert first_call[-1]["content"] == reminders[0]["content"]
    assert first_call[0]["role"] == "system"
    # Éphémère : jamais rejoué aux tours suivants via le tool_history persisté.
    assert not _todo_msgs(tool_history)


async def test_pas_dinjection_liste_soldee(DB, monkeypatch):
    DB.set_chat_todos(7, "c1", [
        {"content": "a", "status": "completed", "priority": "medium"}])
    first_call, _th = await _run_turn(monkeypatch)
    assert not _todo_msgs(first_call)


async def test_pas_dinjection_sans_todowrite(DB, monkeypatch):
    """todowrite absent de la surface du run (enfant task en deny, run sans
    l'outil) → pas de rappel : le modèle ne pourrait pas mettre à jour."""
    DB.set_chat_todos(7, "c1", OPEN_TODOS)
    first_call, _th = await _run_turn(monkeypatch, with_todowrite=False)
    assert not _todo_msgs(first_call)
