# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_routines_route.py — API /api/routines (E2E sur le vrai
routeur partagé + vraie DB temp).

Auth simulée en patchant ``require_user_id`` du module de route pour lire un
header ``x-test-user`` (pattern de test_skills_crud.py). ``run-now`` stubbe
``launch_run`` → aucune exécution LLM réelle.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # DB temp + table users minimale (FK).
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.executemany("INSERT INTO users(id, username) VALUES (?,?)",
                         [(1, "alice"), (2, "bob")])
        conn.commit()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()

    # Auth fake : header x-test-user → user_id.
    import shared_infra.scheduling.routes_routines as rt

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(rt, "require_user_id", _fake_uid)

    # run-now : stub launch_run pour éviter une vraie exécution LLM.
    import shared_infra.scheduling.routines_scheduler as sched

    async def _fake_launch(routine, *, trigger):
        return 999

    monkeypatch.setattr(sched, "launch_run", _fake_launch)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _alice():
    return {"x-test-user": "1"}


def _bob():
    return {"x-test-user": "2"}


def _body(**over):
    b = {"name": "Veille", "cron_expr": "0 9 * * *", "task_prompt": "résume /work",
         "model": None, "system_prompt": "", "thinking_mode": False, "enabled": True,
         "mcp_servers": []}
    b.update(over)
    return b


def test_requires_auth(client):
    assert client.get("/api/routines").status_code == 401


def test_create_and_list_strips_secrets(client):
    body = _body(mcp_servers=[{"type": "sse", "name": "x", "url": "http://h",
                               "auth": "Bearer SECRET", "filter_categories": ["a"]}])
    r = client.post("/api/routines", headers=_alice(), json=body)
    assert r.status_code == 200, r.text
    rid = r.json()["id"]

    lst = client.get("/api/routines", headers=_alice()).json()["items"]
    assert len(lst) == 1 and lst[0]["id"] == rid

    detail = client.get(f"/api/routines/{rid}", headers=_alice()).json()
    snap = detail["mcp_snapshot"]
    assert snap[0]["url"] == "http://h"
    assert "auth" not in snap[0]              # secret strippé en base


def test_cron_validation_400(client):
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(cron_expr="* * *")).status_code == 400


def test_name_required_400(client):
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(name="  ")).status_code == 400


def test_tenant_isolation_404(client):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    assert client.get(f"/api/routines/{rid}", headers=_bob()).status_code == 404
    assert client.put(f"/api/routines/{rid}", headers=_bob(),
                      json={"name": "hack"}).status_code == 404
    assert client.post(f"/api/routines/{rid}/disable", headers=_bob()).status_code == 404
    assert client.delete(f"/api/routines/{rid}", headers=_bob()).status_code == 404
    assert client.post(f"/api/routines/{rid}/run-now", headers=_bob()).status_code == 404
    assert client.get(f"/api/routines/{rid}/runs", headers=_bob()).status_code == 404


def test_trigger_after_chain_validation(client):
    """Enchaînement à la Jenkins : amont du même owner uniquement, pas de
    self-référence, condition bornée, retrait par null."""
    a = client.post("/api/routines", headers=_alice(), json=_body(name="A")).json()["id"]
    r = client.post("/api/routines", headers=_alice(),
                    json=_body(name="B", trigger_after_id=a, trigger_after_on="error"))
    assert r.status_code == 200
    b = r.json()["id"]
    d = client.get(f"/api/routines/{b}", headers=_alice()).json()
    assert d["trigger_after_id"] == a and d["trigger_after_on"] == "error"
    # soi-même → 400
    assert client.put(f"/api/routines/{b}", headers=_alice(),
                      json={"trigger_after_id": b}).status_code == 400
    # routine d'un AUTRE user → 404 (cloisonnement)
    rb = client.post("/api/routines", headers=_bob(), json=_body(name="RB")).json()["id"]
    assert client.put(f"/api/routines/{b}", headers=_alice(),
                      json={"trigger_after_id": rb}).status_code == 404
    # condition invalide → 400
    assert client.put(f"/api/routines/{b}", headers=_alice(),
                      json={"trigger_after_id": a, "trigger_after_on": "maybe"}).status_code == 400
    # retrait : null PERSISTE (champ nullable, pas « inchangé »)
    assert client.put(f"/api/routines/{b}", headers=_alice(),
                      json={"trigger_after_id": None}).status_code == 200
    assert client.get(f"/api/routines/{b}",
                      headers=_alice()).json()["trigger_after_id"] is None


# ── Stop d'un run en cours ───────────────────────────────────────────────────

def _insert_running_run(routine_id: int, uid: int) -> int:
    from shared_infra.scheduling.routines_store import admit_and_insert_run
    run_id = admit_and_insert_run(routine_id, uid, trigger="manual",
                                  cap=10, worker_boot_id="test")
    assert run_id is not None
    return run_id


def test_stop_running_run_marks_and_broadcasts(client, monkeypatch):
    """Le stop pose le flag d'annulation sous la clé synthétique EXACTE de
    l'exécuteur (run_chat_key) — une divergence de format rendrait le bouton
    silencieusement inopérant — et répond ``stopping: true`` (optimiste)."""
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    run_id = _insert_running_run(rid, 1)

    calls = []
    import shared_infra.routes._state as st
    monkeypatch.setattr(st, "mark_chat_cancelled",
                        lambda uid, cid=None: calls.append((uid, cid)))
    monkeypatch.setattr(st, "get_active_chat_task", lambda uid, cid=None: None)

    r = client.post(f"/api/routines/{rid}/runs/{run_id}/stop", headers=_alice())
    assert r.status_code == 200
    assert r.json() == {"ok": True, "stopping": True}
    from shared_infra.scheduling.routines_scheduler import run_chat_key
    assert calls == [(1, run_chat_key(rid, run_id))]


def test_stop_finished_run_noop(client, monkeypatch):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    run_id = _insert_running_run(rid, 1)
    from shared_infra.scheduling.routines_store import mark_run_cancelled, mark_run_ok
    assert mark_run_ok(run_id) is True

    import shared_infra.routes._state as st
    monkeypatch.setattr(st, "mark_chat_cancelled",
                        lambda *a, **k: pytest.fail("ne doit pas être appelé"))
    r = client.post(f"/api/routines/{rid}/runs/{run_id}/stop", headers=_alice())
    assert r.status_code == 200
    body = r.json()
    assert body["stopping"] is False and body["status"] == "ok"
    # Un run déjà finalisé ne repasse jamais 'cancelled' (garde WHERE running).
    assert mark_run_cancelled(run_id) is False


def test_stop_tenant_isolation_and_wrong_routine(client):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    rid2 = client.post("/api/routines", headers=_alice(),
                       json=_body(name="Autre")).json()["id"]
    run_id = _insert_running_run(rid, 1)
    # bob ne voit ni la routine ni le run
    assert client.post(f"/api/routines/{rid}/runs/{run_id}/stop",
                       headers=_bob()).status_code == 404
    # run existant mais rattaché à une AUTRE routine → 404 (pas d'oracle)
    assert client.post(f"/api/routines/{rid2}/runs/{run_id}/stop",
                       headers=_alice()).status_code == 404


def test_mark_run_cancelled_transition(client):
    """running → cancelled : transition dédiée (le journal affichait « Échec »
    rouge pour un arrêt volontaire) + get_run owner-gated."""
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    run_id = _insert_running_run(rid, 1)
    from shared_infra.scheduling.routines_store import get_run, mark_run_cancelled
    assert mark_run_cancelled(run_id, duration_ms=1234) is True
    run = get_run(run_id, 1)
    assert run and run["status"] == "cancelled" and run["duration_ms"] == 1234
    assert run["ended_at"] is not None
    assert get_run(run_id, 2) is None            # owner-gated


def test_update_and_toggle(client):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    assert client.put(f"/api/routines/{rid}", headers=_alice(),
                      json={"name": "Renommée", "cron_expr": "*/15 * * * *"}).status_code == 200
    d = client.get(f"/api/routines/{rid}", headers=_alice()).json()
    assert d["name"] == "Renommée" and d["cron_expr"] == "*/15 * * * *"

    assert client.post(f"/api/routines/{rid}/disable", headers=_alice()).status_code == 200
    assert client.get(f"/api/routines/{rid}", headers=_alice()).json()["enabled"] is False
    assert client.post(f"/api/routines/{rid}/enable", headers=_alice()).status_code == 200
    assert client.get(f"/api/routines/{rid}", headers=_alice()).json()["enabled"] is True


def test_skills_roundtrip(client, monkeypatch):
    import shared_infra.scheduling.routes_routines as rt
    monkeypatch.setattr(rt, "_known_skill_ids", lambda uid: {"veille", "jenkins/deploy"})
    rid = client.post("/api/routines", headers=_alice(),
                      json=_body(skills=["veille", "jenkins/deploy", "veille"])).json()["id"]
    d = client.get(f"/api/routines/{rid}", headers=_alice()).json()
    assert d["skills"] == ["veille", "jenkins/deploy"]   # dédupliqué, ordre gardé

    # PUT partiel SANS skills → inchangé ; PUT skills=[] → vidé.
    assert client.put(f"/api/routines/{rid}", headers=_alice(),
                      json={"name": "n2"}).status_code == 200
    assert client.get(f"/api/routines/{rid}", headers=_alice()).json()["skills"] == \
        ["veille", "jenkins/deploy"]
    assert client.put(f"/api/routines/{rid}", headers=_alice(),
                      json={"skills": []}).status_code == 200
    assert client.get(f"/api/routines/{rid}", headers=_alice()).json()["skills"] == []


def test_skills_validation_400(client, monkeypatch):
    import shared_infra.scheduling.routes_routines as rt
    monkeypatch.setattr(rt, "_known_skill_ids", lambda uid: {"veille"})
    # Pas une liste.
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(skills="veille")).status_code == 400
    # Items non-string / vides.
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(skills=[42])).status_code == 400
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(skills=["  "])).status_code == 400
    # Cap (13 > 12) — vérifié avant l'existence.
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(skills=[f"s{i}" for i in range(13)])).status_code == 400
    # Skill inconnu → 400 explicite.
    r = client.post("/api/routines", headers=_alice(), json=_body(skills=["ghost"]))
    assert r.status_code == 400
    assert "introuvable" in r.json()["detail"]
    # Idem sur PUT.
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    assert client.put(f"/api/routines/{rid}", headers=_alice(),
                      json={"skills": ["ghost"]}).status_code == 400


def test_skills_validation_fail_open_when_discovery_down(client, monkeypatch):
    """Découverte indisponible (None) → on accepte (le runner ignore les ids
    inconnus) plutôt que de bloquer la sauvegarde."""
    import shared_infra.scheduling.routes_routines as rt
    monkeypatch.setattr(rt, "_known_skill_ids", lambda uid: None)
    r = client.post("/api/routines", headers=_alice(), json=_body(skills=["whatever"]))
    assert r.status_code == 200
    rid = r.json()["id"]
    assert client.get(f"/api/routines/{rid}", headers=_alice()).json()["skills"] == ["whatever"]


def test_run_now_stubbed(client):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    r = client.post(f"/api/routines/{rid}/run-now", headers=_alice())
    assert r.status_code == 200, r.text
    assert r.json()["run_id"] == 999


def test_delete(client):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    assert client.delete(f"/api/routines/{rid}", headers=_alice()).status_code == 200
    assert client.get(f"/api/routines/{rid}", headers=_alice()).status_code == 404


# ── Colonne `files` du journal (chemins produits par le run) ────────────────

def test_run_files_roundtrip_and_sanitizing(client):
    """mark_run_ok(files=…) → list_runs renvoie une LISTE (pas du JSON brut)."""
    import shared_infra.scheduling.routines_store as R
    rid = R.create_routine(1, name="r", cron_expr="* * * * *", model=None,
                           system_prompt="", task_prompt="t", mcp_servers=[],
                           skills=[], thinking_mode=False, enabled=True)
    run_id = R.admit_and_insert_run(rid, 1, trigger="manual", cap=10,
                                    worker_boot_id="b")
    assert run_id
    assert R.mark_run_ok(run_id, summary="ok",
                         files=["/work/a.md", " /work/a.md ", "", "/work/b.md"])
    runs = R.list_runs(rid, 1)
    # dédupliqué (après strip), ordre d'écriture gardé, vides ignorés
    assert runs[0]["files"] == ["/work/a.md", "/work/b.md"]


def test_run_files_default_empty_for_legacy_rows(client):
    """Un run d'avant la migration (ou sans écriture) expose [] — jamais None."""
    import shared_infra.scheduling.routines_store as R
    rid = R.create_routine(1, name="r2", cron_expr="* * * * *", model=None,
                           system_prompt="", task_prompt="t", mcp_servers=[],
                           skills=[], thinking_mode=False, enabled=True)
    run_id = R.admit_and_insert_run(rid, 1, trigger="manual", cap=10,
                                    worker_boot_id="b")
    assert R.mark_run_ok(run_id, summary="sans fichier")
    assert R.list_runs(rid, 1)[0]["files"] == []


def test_run_files_are_capped():
    import shared_infra.scheduling.routines_store as R
    assert len(R._sanitize_run_files([f"/w/f{i}" for i in range(200)])) == R._RUN_FILES_MAX
    assert R._sanitize_run_files("pas une liste") == []


@pytest.mark.sqlite_only   # introspection PRAGMA
def test_files_column_migrates_on_existing_db(tmp_path, monkeypatch):
    """Base d'AVANT la colonne : init_routines_db doit l'ajouter, pas planter.

    C'est le cas réel d'une mise à jour en place — la table existe déjà, donc le
    CREATE TABLE IF NOT EXISTS est un no-op et seul l'ALTER sauve la mise.
    """
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "old.db"))
    import shared_infra.scheduling.routines_store as R
    from shared_infra.db._connection import db_conn

    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users(id, username) VALUES (1, 'alice')")
        # schéma d'origine : PAS de colonne files
        conn.execute("""CREATE TABLE editor_routine_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, routine_id INTEGER NOT NULL,
            owner_user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running',
            trigger TEXT NOT NULL DEFAULT 'schedule', started_at REAL NOT NULL,
            ended_at REAL, duration_ms INTEGER, input_tokens INTEGER,
            output_tokens INTEGER, summary TEXT, error TEXT,
            tool_limit_reached INTEGER NOT NULL DEFAULT 0,
            worker_boot_id TEXT, heartbeat_at REAL)""")
        conn.execute("INSERT INTO editor_routine_runs(routine_id, owner_user_id, "
                     "status, started_at, summary) VALUES (1, 1, 'ok', 1.0, 'ancien')")
        conn.commit()

    R.init_routines_db()
    with db_conn() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(editor_routine_runs)")}
    assert "files" in cols
    # la ligne historique survit et expose une liste vide
    assert R.list_runs(1, 1)[0]["files"] == []


# ── Régressions audit 2026-08-04 ─────────────────────────────────────────────

def test_run_now_disabled_400(client):
    """run-now sur une routine désactivée : refus explicite — avant, un run
    était admis puis marqué 'error' (« Échec » rouge pour un clic impossible)."""
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    client.post(f"/api/routines/{rid}/disable", headers=_alice())
    r = client.post(f"/api/routines/{rid}/run-now", headers=_alice())
    assert r.status_code == 400


def test_put_noop_not_404(client):
    """PUT sans champ persistable : 200 — le ``sets`` vide de update_routine
    était traduit en 404 « Routine introuvable » (routine bien existante)."""
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    assert client.put(f"/api/routines/{rid}", headers=_alice(), json={}).status_code == 200
    # …mais une routine réellement absente reste un 404.
    assert client.put("/api/routines/999999", headers=_alice(), json={}).status_code == 404


def test_malformed_bodies_400_not_500(client):
    """Corps non-dict / champs mal typés : 400 propres (avant : AttributeError
    ou sqlite3.InterfaceError → 500)."""
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    assert client.post("/api/routines", headers=_alice(), json=[1, 2]).status_code == 400
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(name=123)).status_code == 400
    assert client.put(f"/api/routines/{rid}", headers=_alice(),
                      json={"system_prompt": {"a": 1}}).status_code == 400
    assert client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                       json="abc").status_code == 400


def test_delete_upstream_clears_downstream_pointer(client):
    """Supprimer une routine AMONT remet à NULL les pointeurs d'enchaînement des
    avales — une aval sans planification restait « après #id » à jamais, sans
    plus aucun déclencheur possible."""
    a = client.post("/api/routines", headers=_alice(), json=_body(name="A")).json()["id"]
    b = client.post("/api/routines", headers=_alice(),
                    json=_body(name="B", cron_expr="", trigger_after_id=a)).json()["id"]
    assert client.delete(f"/api/routines/{a}", headers=_alice()).status_code == 200
    d = client.get(f"/api/routines/{b}", headers=_alice()).json()
    assert d["trigger_after_id"] is None


def test_admit_overlap_guard_atomic(client):
    """F10 DANS la transaction d'admission (TOCTOU corrigé) : un run actif au
    heartbeat frais → refus du second pour la même routine ; sans le kwarg,
    comportement historique (cap user seul) inchangé."""
    import shared_infra.scheduling.routines_store as R
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    r1 = R.admit_and_insert_run(rid, 1, trigger="manual", cap=10,
                                worker_boot_id="t", overlap_fresh_after_s=300.0)
    assert isinstance(r1, int)
    assert R.admit_and_insert_run(rid, 1, trigger="manual", cap=10,
                                  worker_boot_id="t", overlap_fresh_after_s=300.0) is None
    # Sans garde F10 : admis (le cap user 10 n'est pas atteint).
    assert isinstance(R.admit_and_insert_run(rid, 1, trigger="manual", cap=10,
                                             worker_boot_id="t"), int)


def test_mark_run_skipped_transition(client):
    """Routine désactivée/supprimée entre admission et démarrage → 'skipped'
    avec raison (avant : 'error'). Gardé WHERE status='running'."""
    import shared_infra.scheduling.routines_store as R
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    run_id = R.admit_and_insert_run(rid, 1, trigger="manual", cap=10, worker_boot_id="t")
    assert R.mark_run_skipped(run_id, reason="routine désactivée avant démarrage") is True
    run = R.get_run(run_id, 1)
    assert run["status"] == "skipped" and "désactivée" in run["error"]
    assert R.mark_run_skipped(run_id, reason="x") is False


def test_stop_orphaned_run_direct_cancel(client):
    """Stop d'un run au heartbeat périmé (worker mort) : transition directe
    'cancelled' + réponse véridique — avant, « Arrêt demandé » menteur puis
    badge « Interrompu » à la réconciliation 5 min plus tard."""
    import time as _t

    import shared_infra.scheduling.routines_store as R
    from shared_infra.db._connection import db_conn
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    run_id = R.admit_and_insert_run(rid, 1, trigger="manual", cap=10, worker_boot_id="t")
    with db_conn() as conn:
        conn.execute("UPDATE editor_routine_runs SET heartbeat_at=? WHERE id=?",
                     (_t.time() - 9999, run_id))
        conn.commit()
    r = client.post(f"/api/routines/{rid}/runs/{run_id}/stop", headers=_alice())
    assert r.status_code == 200
    assert r.json() == {"ok": True, "stopping": False, "status": "cancelled"}
    assert R.get_run(run_id, 1)["status"] == "cancelled"


def test_reconcile_orphans_sets_duration(client):
    """La réconciliation renseigne duration_ms (borne basse heartbeat−départ) —
    la colonne restait NULL et le journal affichait « — »."""
    import time as _t

    import shared_infra.scheduling.routines_store as R
    from shared_infra.db._connection import db_conn
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    run_id = R.admit_and_insert_run(rid, 1, trigger="manual", cap=10, worker_boot_id="t")
    with db_conn() as conn:
        conn.execute("UPDATE editor_routine_runs SET started_at=?, heartbeat_at=? WHERE id=?",
                     (_t.time() - 800, _t.time() - 700, run_id))
        conn.commit()
    assert R.reconcile_orphans(stale_after_s=300.0) == 1
    run = R.get_run(run_id, 1)
    assert run["status"] == "orphaned"
    assert 90_000 <= int(run["duration_ms"]) <= 110_000


# ── Sous-agents : opt-in PAR ROUTINE (onglet Agents) ────────────────────────

def test_agents_enabled_roundtrip_and_default_off(client):
    """Le champ voyage POST → GET → PUT, et vaut FALSE quand on ne le demande
    pas : une routine existante ne se met pas à déléguer parce que la feature
    est arrivée."""
    r = client.post("/api/routines", headers=_alice(),
                    json={"name": "muette", "cron_expr": "0 9 * * *", "task_prompt": "x"})
    rid = r.json()["id"]
    assert client.get(f"/api/routines/{rid}", headers=_alice()).json()["agents_enabled"] is False

    r = client.post("/api/routines", headers=_alice(),
                    json={"name": "deleguante", "cron_expr": "0 9 * * *",
                          "task_prompt": "x", "agents_enabled": True})
    rid2 = r.json()["id"]
    assert client.get(f"/api/routines/{rid2}", headers=_alice()).json()["agents_enabled"] is True

    # PUT : on peut le rouvrir ET le refermer (un False ne doit pas être lu
    # comme « champ absent = inchangé »).
    client.put(f"/api/routines/{rid2}", headers=_alice(), json={"agents_enabled": False})
    assert client.get(f"/api/routines/{rid2}", headers=_alice()).json()["agents_enabled"] is False
    client.put(f"/api/routines/{rid2}", headers=_alice(), json={"agents_enabled": True})
    assert client.get(f"/api/routines/{rid2}", headers=_alice()).json()["agents_enabled"] is True
    # Un PUT qui ne parle pas d'agents ne touche pas au champ.
    client.put(f"/api/routines/{rid2}", headers=_alice(), json={"name": "renommée"})
    assert client.get(f"/api/routines/{rid2}", headers=_alice()).json()["agents_enabled"] is True


def test_agents_column_migrates_on_existing_db(tmp_path, monkeypatch):
    """Base d'AVANT la colonne (mise à jour en place) : ALTER, pas de crash, et
    les routines déjà là restent en opt-out."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "old.db"))
    import shared_infra.scheduling.routines_store as R
    from shared_infra.db._connection import db_conn

    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users(id, username) VALUES (1, 'alice')")
        conn.execute("""CREATE TABLE editor_routines (
            id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL,
            name TEXT NOT NULL, cron_expr TEXT NOT NULL, model TEXT DEFAULT NULL,
            system_prompt TEXT NOT NULL DEFAULT '', task_prompt TEXT NOT NULL DEFAULT '',
            mcp_snapshot TEXT NOT NULL DEFAULT '[]', thinking_mode INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL,
            updated_at REAL NOT NULL, last_fire_minute TEXT DEFAULT NULL)""")
        conn.execute("INSERT INTO editor_routines(owner_user_id, name, cron_expr, "
                     "created_at, updated_at) VALUES (1, 'ancienne', '0 9 * * *', 0, 0)")
        conn.commit()

    R.init_routines_db()
    rows = R.list_routines(1)
    assert rows and rows[0]["agents_enabled"] is False
    rid = rows[0]["id"]
    assert R.update_routine(rid, 1, agents_enabled=True)
    assert R.get_routine(rid, 1)["agents_enabled"] is True


# ─────────────────────────────────────────────────────────────────────────────
#  Historique PAR ROUTINE (2026-09-08) : runs_keep / notify_on / notify_keep
# ─────────────────────────────────────────────────────────────────────────────
def _hist(client, rid):
    d = client.get(f"/api/routines/{rid}", headers=_alice()).json()
    return d["runs_keep"], d["notify_on"], d["notify_keep"]


def test_history_fields_roundtrip_and_partial_put(client):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    assert _hist(client, rid) == (0, "all", 0)                # défauts = comportement d'avant
    rid2 = client.post("/api/routines", headers=_alice(),
                       json=_body(name="H", runs_keep=25, notify_on="error", notify_keep="10")).json()["id"]
    assert _hist(client, rid2) == (25, "error", 10)           # "10" (chaîne numérique) accepté
    # PUT partiel : un champ absent reste inchangé.
    assert client.put(f"/api/routines/{rid2}", headers=_alice(), json={"notify_on": "none"}).status_code == 200
    assert _hist(client, rid2) == (25, "none", 10)
    # Champ VIDÉ dans le formulaire ("" / null) → 0 = tout conserver.
    assert client.put(f"/api/routines/{rid2}", headers=_alice(),
                      json={"runs_keep": "", "notify_keep": None}).status_code == 200
    assert _hist(client, rid2) == (0, "none", 0)
    # La liste (page Routines + « récap » de la vue lecture) porte les champs.
    items = {r["id"]: r for r in client.get("/api/routines", headers=_alice()).json()["items"]}
    assert items[rid2]["notify_on"] == "none" and items[rid]["runs_keep"] == 0
    # Bob ne peut pas régler l'historique d'alice (404, pas 403).
    assert client.put(f"/api/routines/{rid2}", headers=_bob(), json={"runs_keep": 1}).status_code == 404


def test_history_fields_validation(client):
    rid = client.post("/api/routines", headers=_alice(), json=_body()).json()["id"]
    bad = [{"runs_keep": -1}, {"runs_keep": 501}, {"runs_keep": True}, {"runs_keep": 2.5},
           {"runs_keep": "abc"}, {"notify_keep": [1]}, {"notify_keep": {"n": 1}},
           {"notify_on": "maybe"}, {"notify_on": 3}, {"notify_on": ["all"]}]
    for payload in bad:
        r = client.put(f"/api/routines/{rid}", headers=_alice(), json=payload)
        assert r.status_code == 400, (payload, r.text)
    assert _hist(client, rid) == (0, "all", 0)                # un 400 n'a rien modifié
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(notify_on="jamais")).status_code == 400
    assert client.post("/api/routines", headers=_alice(),
                       json=_body(runs_keep=9999)).status_code == 400
    # bornes incluses : 0 et 500 passent
    assert client.put(f"/api/routines/{rid}", headers=_alice(),
                      json={"runs_keep": 500, "notify_keep": 0, "notify_on": " ALL "}).status_code == 200
    assert _hist(client, rid) == (500, "all", 0)


def test_delete_routine_removes_its_notifications_via_api(client):
    """Le « récap » (centre de notifications) suit la routine : DELETE emporte
    ses notifications ; un renommage réécrit leurs titres."""
    import importlib

    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        importlib.import_module(
            "shared_infra.db._migrations.0005_notifications_table").migrate(conn)
        conn.commit()
    from shared_infra.notifications.store import create_notification, list_notifications
    from shared_infra.scheduling.routines_store import routine_notification_title
    a = client.post("/api/routines", headers=_alice(), json=_body(name="Veille")).json()["id"]
    b = client.post("/api/routines", headers=_alice(), json=_body(name="Backup")).json()["id"]
    create_notification(1, "routine_ok", routine_notification_title("Veille", a, ok=True),
                        ref_type="routine", ref_id=a)
    create_notification(1, "routine_ok", routine_notification_title("Backup", b, ok=True),
                        ref_type="routine", ref_id=b)
    assert client.put(f"/api/routines/{a}", headers=_alice(), json={"name": "Veille 2"}).status_code == 200
    assert sorted(n["title"] for n in list_notifications(1)) == [
        "Routine « Backup » terminée", "Routine « Veille 2 » terminée"]
    assert client.delete(f"/api/routines/{a}", headers=_alice()).status_code == 200
    assert [n["title"] for n in list_notifications(1)] == ["Routine « Backup » terminée"]
