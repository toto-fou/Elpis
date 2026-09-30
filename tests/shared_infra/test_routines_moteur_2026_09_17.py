# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_routines_moteur_2026_09_17.py — une routine part sur
LE serveur de sa fiche (M5).

Avant : ``routines_scheduler`` n'envoyait jamais de connecteur — une routine
partait toujours sur le serveur INTÉGRÉ, même quand le travail était pensé pour
un second serveur (et avec deux serveurs exposant les mêmes noms de modèles, la
bascule était invisible). La routine porte désormais ``connector_id``
(NULL = intégré), validé à l'enregistrement (existence, activation, politique
d'accès du propriétaire) et posé dans le contexte de la tâche à l'exécution.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    import shared_infra.scheduling.routines_store as store
    from shared_infra.accounts.users import create_user
    from shared_infra.llm import connectors as lc, engine_access as ea
    store.init_routines_db()
    ea.invalidate_cache()
    ids = {
        "alice": create_user("alice", "pw-alice-12"),
        "bob": create_user("bob", "pw-bob-1234"),
        "s2": lc.create_connector(scope="shared", provider_type="llamacpp", wire="openai",
                                  base_url="http://b:8080", label="Serveur 2",
                                  default_model="qwen-x"),
        "off": lc.create_connector(scope="shared", provider_type="llamacpp", wire="openai",
                                   base_url="http://c:8080", label="Éteint", enabled=False),
    }
    yield ids
    ea.invalidate_cache()


@pytest.fixture()
def client(base, monkeypatch):
    import shared_infra.scheduling.routes_routines as rt
    import shared_infra.scheduling.routines_scheduler as sched

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    async def _fake_launch(routine, *, trigger):
        return 999

    monkeypatch.setattr(rt, "require_user_id", _fake_uid)
    monkeypatch.setattr(sched, "launch_run", _fake_launch)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), base


def _h(uid):
    return {"x-test-user": str(uid)}


def _cree(tc, uid, **extra):
    body = {"name": "veille", "cron_expr": "0 8 * * *", "task_prompt": "fais-le"}
    body.update(extra)
    return tc.post("/api/routines", headers=_h(uid), json=body)


def test_le_serveur_choisi_est_persiste_et_relu(client):
    tc, ids = client
    r = _cree(tc, ids["alice"], connector_id=ids["s2"], model="qwen-x")
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    d = tc.get(f"/api/routines/{rid}", headers=_h(ids["alice"])).json()
    assert d["connector_id"] == ids["s2"] and d["model"] == "qwen-x"
    # Retour à l'intégré : NULL explicite, pas « inchangé ».
    assert tc.put(f"/api/routines/{rid}", headers=_h(ids["alice"]),
                  json={"connector_id": None}).status_code == 200
    assert tc.get(f"/api/routines/{rid}", headers=_h(ids["alice"])).json()["connector_id"] is None


def test_sans_serveur_la_routine_reste_sur_lintegre(client):
    tc, ids = client
    rid = _cree(tc, ids["alice"]).json()["id"]
    assert tc.get(f"/api/routines/{rid}", headers=_h(ids["alice"])).json()["connector_id"] is None


@pytest.mark.parametrize("cid_key,code", [("off", 400), ("inconnu", 400)])
def test_serveur_inutilisable_refuse_a_lenregistrement(client, cid_key, code):
    tc, ids = client
    cid = ids.get(cid_key, 99999)
    assert _cree(tc, ids["alice"], connector_id=cid).status_code == code


def test_serveur_ferme_a_ce_compte_refuse(client):
    tc, ids = client
    from shared_infra.llm import engine_access as ea
    ea.set_policy("user", ids["alice"], engine_keys=["builtin"], can_manage_models=None)
    try:
        assert _cree(tc, ids["alice"], connector_id=ids["s2"]).status_code == 403
    finally:
        ea.clear_policy("user", ids["alice"])


def test_la_cible_resolue_est_bien_celle_du_connecteur(base):
    """Cœur du correctif : la fiche donne (serveur, modèle) et la cible posée
    dans le contexte suit le connecteur, modèle par défaut du serveur compris."""
    import asyncio

    from llm_core import set_llm_target
    from llm_core._target import resolve_llm_target
    from llm_core.engines import current_engine
    from shared_infra.scheduling.routines_store import create_routine, get_routine

    rid = create_routine(base["alice"], name="veille", cron_expr="", model=None,
                         connector_id=base["s2"], system_prompt="", task_prompt="fais-le",
                         mcp_servers=[])
    routine = get_routine(rid, base["alice"])
    assert routine["connector_id"] == base["s2"]

    async def _essai():
        t = resolve_llm_target(base["alice"], routine["connector_id"], routine["model"],
                               strict=True, touch=False)
        set_llm_target(t)
        return current_engine().key, t.model

    key, model = asyncio.run(_essai())
    assert key == f"conn:{base['s2']}" and model == "qwen-x"


def test_la_source_du_planificateur_utilise_le_connecteur():
    import inspect

    import shared_infra.scheduling.routines_scheduler as sched
    src = inspect.getsource(sched)
    assert '_conn_id = routine.get("connector_id") or None' in src
    assert "set_llm_target(_target)" in src
    assert "_ea.connector_key(_conn_id) if _conn_id else _ea.BUILTIN_KEY" in src
