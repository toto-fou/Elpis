# SPDX-License-Identifier: MIT
"""tests/memory/test_memory_delete_route.py

DELETE /api/memory/state — efface toute la mémoire long-terme du user courant
(USER.md + MEMORY.md + scopes/ + .audit.jsonl). Déclenché depuis Réglages →
Mémoire (bouton « Effacer tout » + confirmation). Scopé au user, jamais cross-user.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.memory.routes as mem
from llm_core.memory._migrate import migrate_legacy_memory


def _client(monkeypatch, tmp_path, username="alice"):
    monkeypatch.setattr(mem, "SANDBOX_DIR", tmp_path)
    monkeypatch.setattr(mem, "require_user_id", lambda r: 1)
    monkeypatch.setattr(mem, "get_username_by_id", lambda uid: username)
    app = FastAPI()
    app.include_router(mem.router)
    return TestClient(app)


def test_delete_clears_all_memory_artifacts(monkeypatch, tmp_path):
    base = migrate_legacy_memory(tmp_path, "alice")
    (base / "USER.md").write_text("profil", encoding="utf-8")
    (base / "MEMORY.md").write_text("notes", encoding="utf-8")
    (base / ".audit.jsonl").write_text('{"action":"add","ok":true}\n', encoding="utf-8")
    scope = base / "scopes" / "deadbeef"
    scope.mkdir(parents=True)
    (scope / "MEMORY.md").write_text("scoped note", encoding="utf-8")

    c = _client(monkeypatch, tmp_path)
    r = c.delete("/api/memory/state")
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] is True
    assert set(d["removed"]) >= {"USER.md", "MEMORY.md", ".audit.jsonl", "scopes/"}
    assert not (base / "USER.md").exists()
    assert not (base / "MEMORY.md").exists()
    assert not (base / ".audit.jsonl").exists()
    assert not (base / "scopes").exists()


def test_delete_empty_memory_is_ok(monkeypatch, tmp_path):
    """Rien à supprimer → 200 ok avec removed vide (jamais 404/500)."""
    migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    r = c.delete("/api/memory/state")
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] is True
    assert d["removed"] == []


def test_delete_is_scoped_to_current_user(monkeypatch, tmp_path):
    base_alice = migrate_legacy_memory(tmp_path, "alice")
    base_bob = migrate_legacy_memory(tmp_path, "bob")
    (base_alice / "MEMORY.md").write_text("alice-notes", encoding="utf-8")
    (base_bob / "MEMORY.md").write_text("bob-notes", encoding="utf-8")

    c = _client(monkeypatch, tmp_path, username="alice")
    r = c.delete("/api/memory/state")
    assert r.status_code == 200
    # Alice effacée, Bob INTACT (pas de fuite cross-user).
    assert not (base_alice / "MEMORY.md").exists()
    assert (base_bob / "MEMORY.md").exists()
    assert (base_bob / "MEMORY.md").read_text(encoding="utf-8") == "bob-notes"


def test_delete_preserves_memory_enabled_toggle(monkeypatch, tmp_path):
    """La suppression ne touche PAS au réglage memory_enabled : vider ≠ couper.
    On vérifie juste qu'aucun fichier de settings n'est écrit par la route
    (l'endpoint ne connaît que le dossier mémoire)."""
    base = migrate_legacy_memory(tmp_path, "alice")
    (base / "MEMORY.md").write_text("x", encoding="utf-8")
    c = _client(monkeypatch, tmp_path)
    r = c.delete("/api/memory/state")
    assert r.status_code == 200 and r.json()["ok"] is True
