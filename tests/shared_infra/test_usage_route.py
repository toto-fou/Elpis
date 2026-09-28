# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_usage_route.py — API GET /api/usage/me (E2E sur le
routeur partagé + vraie DB temp).

Auth simulée en patchant ``require_user_id`` (pattern test_routines_route.py).
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn, init_db
    init_db()  # crée chats + metric_events + la vraie table users
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice") == 1
    assert create_user("bob", "pw-bob") == 2
    import shared_infra.observability.tool_metrics_store as am
    am.init_tool_metrics_db()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()

    import shared_infra.observability.routes_usage as usage_mod

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(usage_mod, "require_user_id", _fake_uid)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), db_conn, am


def _alice():
    return {"x-test-user": "1"}


# ──────────────────────────────────────────────────────────────────────────

def test_requires_auth(client):
    tc, _, _ = client
    assert tc.get("/api/usage/me").status_code == 401


def test_empty_user_gets_zeros(client):
    tc, _, _ = client
    r = tc.get("/api/usage/me", headers=_alice())
    assert r.status_code == 200
    d = r.json()
    assert d["days"] == 30
    assert d["chats"] == {"active": 0, "archived": 0, "total": 0}
    assert d["tokens"]["total"] == 0 and d["tokens"]["estimated"] is False
    assert d["messages"] == {"sent": 0, "received": 0}
    assert d["routines"]["runs"] == 0


def test_days_clamped_to_nearest(client):
    tc, _, _ = client
    assert tc.get("/api/usage/me?days=7", headers=_alice()).json()["days"] == 7
    assert tc.get("/api/usage/me?days=90", headers=_alice()).json()["days"] == 90
    assert tc.get("/api/usage/me?days=12", headers=_alice()).json()["days"] == 7   # plus proche
    assert tc.get("/api/usage/me?days=999", headers=_alice()).json()["days"] == 90
    assert tc.get("/api/usage/me?days=abc", headers=_alice()).json()["days"] == 30


def test_aggregates_chats_tokens_messages(client):
    tc, db_conn, _ = client
    now = time.time()
    with db_conn() as conn:
        # 2 chats actifs + 1 archivé pour alice (id=1)
        conn.executemany(
            "INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) "
            "VALUES (?,?,?,?,?,?)",
            [("c1", 1, "t", "[]", now, 0), ("c2", 1, "t", "[]", now, 0),
             ("c3", 1, "t", "[]", now, 1),
             ("cb", 2, "t", "[]", now, 0)])  # bob, ne doit pas compter
        # tokens alice — registre d'usage (une ligne par tour, user_id entier)
        conn.execute("INSERT INTO usage_events(ts, user_id, source, input_tokens, output_tokens) "
                     "VALUES (?,?,?,?,?)", (now, 1, "chat", 100, 250))
        # bruit bob
        conn.execute("INSERT INTO usage_events(ts, user_id, source, input_tokens, output_tokens) "
                     "VALUES (?,?,?,?,?)", (now, 2, "chat", 9999, 1))
        # messages alice
        conn.execute("INSERT INTO metric_events(event_type, value, tags_json, created_at) "
                     "VALUES (?,?,?,?)", ("message_sent", 1, json.dumps({"role": "user", "user": "alice"}), now))
        conn.execute("INSERT INTO metric_events(event_type, value, tags_json, created_at) "
                     "VALUES (?,?,?,?)", ("message_sent", 1, json.dumps({"role": "assistant", "user": "alice"}), now))
        conn.commit()

    d = tc.get("/api/usage/me", headers=_alice()).json()
    assert d["chats"] == {"active": 2, "archived": 1, "total": 3}
    assert d["tokens"]["input"] == 100 and d["tokens"]["output"] == 250
    assert d["tokens"]["total"] == 350 and d["tokens"]["estimated"] is False
    assert d["tokens"]["split_available"] is True
    assert d["messages"] == {"sent": 1, "received": 1}


def test_split_toujours_disponible(client):
    """Le badge « estimé / répartition indisponible » n'a plus lieu d'être :
    le registre sépare toujours entrée et sortie, sur tous les chemins."""
    tc, db_conn, _ = client
    now = time.time()
    with db_conn() as conn:
        conn.execute("INSERT INTO usage_events(ts, user_id, source, path, input_tokens, output_tokens) "
                     "VALUES (?,?,?,?,?,?)", (now, 1, "chat", "tools", 800, 200))
        conn.commit()
    d = tc.get("/api/usage/me", headers=_alice()).json()["tokens"]
    assert d["estimated"] is False
    assert d["split_available"] is True
    assert d["input"] == 800 and d["output"] == 200 and d["total"] == 1000


def test_conso_hors_chat_visible_et_ventilee(client):
    """Routines et sous-agents comptent pour leur propriétaire, et la
    ventilation par origine explique un total plus gros que les conversations.
    C'est précisément ce que l'ancienne source ne pouvait pas montrer."""
    tc, db_conn, _ = client
    now = time.time()
    with db_conn() as conn:
        conn.executemany(
            "INSERT INTO usage_events(ts, user_id, source, input_tokens, output_tokens) "
            "VALUES (?,?,?,?,?)",
            [(now, 1, "chat", 100, 50),
             (now, 1, "routine", 9000, 400),
             (now, 1, "subagent", 200, 30)])
        conn.commit()
    d = tc.get("/api/usage/me", headers=_alice()).json()["tokens"]
    assert d["total"] == 9780
    par_source = {s["source"]: s["tokens"] for s in d["by_source"]}
    assert par_source == {"chat": 150, "routine": 9400, "subagent": 230}


def test_old_events_excluded_by_window(client):
    tc, db_conn, _ = client
    old = time.time() - 60 * 86400   # 60 j → hors fenêtre 30 j
    with db_conn() as conn:
        conn.execute("INSERT INTO usage_events(ts, user_id, source, input_tokens) "
                     "VALUES (?,?,?,?)", (old, 1, "chat", 500))
        conn.commit()
    assert tc.get("/api/usage/me?days=30", headers=_alice()).json()["tokens"]["input"] == 0
    assert tc.get("/api/usage/me?days=90", headers=_alice()).json()["tokens"]["input"] == 500


def test_les_appels_d_outils_ne_sont_plus_agreges(client):
    """Le bloc « Outils » a été retiré de Réglages → Utilisation (2026-08-16) :
    des noms d'outils internes et leurs compteurs ne disent rien à l'utilisateur
    de son propre usage. Le payload a suivi — sinon on paierait un GROUP BY sur
    ``tool_call_metrics`` à chaque ouverture de l'onglet pour rien. Le détail par
    outil reste servi par Administration → Observabilité (route dédiée)."""
    tc, _, am = client
    am.record_tool_call_metric(run_id="r1", user_id=1, tool_name="read_file", status="success", duration_ms=12)
    am.record_tool_call_metric(run_id="r1", user_id=1, tool_name="git", status="error", duration_ms=5)
    d = tc.get("/api/usage/me", headers=_alice()).json()
    assert "tools" not in d
    # …et l'agrégateur reste fonctionnel pour l'administration.
    assert am.get_tool_call_metrics_summary(user_id=1)["totals"]["n"] == 2
