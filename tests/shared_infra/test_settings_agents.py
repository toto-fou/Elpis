# SPDX-License-Identifier: MIT
"""Tests GET/PUT /api/settings pour les clés sous-agents (2026-07-18).

Couvre le toggle ``agents_enabled`` (coercition bool), la liste
``custom_agents`` (validation/normalisation par
``llm_core.tools.task_tool.validate_custom_agents`` — source de vérité
unique), le merge non destructif du PUT partiel et le filtre allow-list.

Recette d'auth : celle de test_skills_crud.py — router partagé réel monté sur
une app nue, ``require_user_id`` monkeypatché sur des ContextVars alimentées
par un middleware de test, store ``users.settings_json`` remplacé par un dict
en mémoire (get/update_user_settings patchés sur le module de routes).
"""
from __future__ import annotations

from contextvars import ContextVar

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

_CUR_UID: "ContextVar[str | None]" = ContextVar("_CUR_UID", default=None)


@pytest.fixture()
def store():
    """settings_json en mémoire : {uid: {clé: valeur}}."""
    return {}


@pytest.fixture()
def client(monkeypatch, store):
    import shared_infra.accounts.routes_settings as routes_settings

    def _fake_require_user_id(request):
        uid = _CUR_UID.get()
        if not uid:
            raise HTTPException(401, "Authentification requise")
        return uid

    monkeypatch.setattr(routes_settings, "require_user_id", _fake_require_user_id)
    monkeypatch.setattr(routes_settings, "get_user_settings",
                        lambda uid: dict(store.get(uid) or {}))
    monkeypatch.setattr(routes_settings, "update_user_settings",
                        lambda uid, s: store.__setitem__(uid, dict(s)))
    # AUDIT 2026-08-02 (E5) — le handler PUT fusionne désormais via
    # merge_user_settings (atomique) ; on le mocke sur le store en mémoire.
    def _fake_merge_user_settings(uid, mutate, _st=store):
        s = dict(_st.get(uid) or {})
        mutate(s)
        _st[uid] = dict(s)
        return dict(s)
    monkeypatch.setattr(routes_settings, "merge_user_settings", _fake_merge_user_settings)
    monkeypatch.setattr(routes_settings, "get_username_by_id", lambda uid: str(uid))
    monkeypatch.setattr(routes_settings, "read_config_json", lambda: {})

    from shared_infra.routes._state import router
    app = FastAPI()

    @app.middleware("http")
    async def _inject_auth(request: Request, call_next):
        tok = _CUR_UID.set(request.headers.get("x-test-user") or None)
        try:
            return await call_next(request)
        finally:
            _CUR_UID.reset(tok)

    app.include_router(router)
    return TestClient(app)


def _user(uid="alice"):
    return {"x-test-user": uid}


# ---------------------------------------------------------------------------
# GET : défauts
# ---------------------------------------------------------------------------


def test_get_defaults(client):
    r = client.get("/api/settings", headers=_user())
    assert r.status_code == 200
    data = r.json()
    assert data["agents_enabled"] is False      # sous-agents = opt-in
    assert data["custom_agents"] == []
    assert data["memory_enabled"] is False
    assert data["hide_thinking"] is False


# ---------------------------------------------------------------------------
# PUT : toggle + custom_agents
# ---------------------------------------------------------------------------


def test_put_toggle_coerced_bool(client, store):
    r = client.put("/api/settings", headers=_user(), json={"agents_enabled": 1})
    assert r.status_code == 200
    assert store["alice"]["agents_enabled"] is True
    r = client.put("/api/settings", headers=_user(), json={"agents_enabled": ""})
    assert r.status_code == 200
    assert store["alice"]["agents_enabled"] is False


def test_put_custom_agents_normalized(client, store):
    payload = [{"name": " Docs-Writer ", "description": " one\nline ",
                "prompt": " You write docs. ", "tool_categories": ["FS", "fs", "git"],
                "mcp_server_ids": [" srv_a ", "srv_a", "srv_b"]}]
    r = client.put("/api/settings", headers=_user(), json={"custom_agents": payload})
    assert r.status_code == 200, r.text
    assert store["alice"]["custom_agents"] == [{
        "name": "docs-writer", "description": "one line",
        "prompt": "You write docs.", "tool_categories": ["fs", "git"],
        "mcp_server_ids": ["srv_a", "srv_b"],
    }]


def test_put_custom_agents_invalid_400(client, store):
    for bad in (
        [{"name": "a b", "prompt": "x"}],       # regex KO
        [{"name": "ok", "prompt": ""}],         # prompt vide
        "junk",                                  # non-liste
    ):
        r = client.put("/api/settings", headers=_user(), json={"custom_agents": bad})
        assert r.status_code == 400, (bad, r.text)
    # rien n'a été persisté par les PUT refusés
    assert "custom_agents" not in (store.get("alice") or {})


def test_put_reserved_agent_name_is_renamed_not_400(client, store):
    # Depuis la banque d'agents (2026-09-11), seul « task » est réservé : un
    # nom INTÉGRÉ est une surcharge (cf. test_put_builtin_name_is_an_override).
    """Un nom devenu RÉSERVÉ (le casting intégré bouge) ne doit PAS faire
    échouer le PUT : le panneau Paramètres re-poste le blob entier à chaque
    « Enregistrer », donc un 400 ici bloquait TOUS les réglages de
    l'utilisateur — thème, modèle, serveurs MCP — jusqu'à renommage manuel."""
    r = client.put("/api/settings", headers=_user(), json={
        "custom_agents": [{"name": "task", "prompt": "x", "tool_categories": ["git"]}],
        "agents_enabled": True,
    })
    assert r.status_code == 200, r.text
    stored = (store.get("alice") or {}).get("custom_agents") or []
    assert len(stored) == 1
    assert stored[0]["name"] != "task" and stored[0]["name"].startswith("task-")
    assert stored[0]["prompt"] == "x" and stored[0]["tool_categories"] == ["git"]
    # Le reste du blob a bien été enregistré (c'était l'enjeu réel).
    assert (store.get("alice") or {}).get("agents_enabled") is True


def test_put_junk_category_or_server_id_is_dropped_not_400(client, store):
    """Même piège que le nom réservé, par une autre porte : ni les slugs de
    catégorie ni les ids de serveur ne se SAISISSENT (le formulaire n'a que des
    cases à cocher). Une valeur malformée vient donc de données stockées, que
    l'utilisateur ne peut PAS retirer depuis le panneau — un id absent de la
    liste n'a pas de case à décocher. La refuser bloquait l'enregistrement du
    blob entier, sans issue. Elle est sautée ; le reste de l'agent survit."""
    r = client.put("/api/settings", headers=_user(), json={
        "custom_agents": [{
            "name": "ci", "prompt": "x",
            "tool_categories": ["git", "pas un slug", ""],
            "mcp_server_ids": ["srv_a", "", None, "z" * 80],
        }],
        "agents_enabled": True,
    })
    assert r.status_code == 200, r.text
    stored = (store.get("alice") or {}).get("custom_agents") or []
    assert stored[0]["tool_categories"] == ["git"]
    assert stored[0]["mcp_server_ids"] == ["srv_a"]
    assert (store.get("alice") or {}).get("agents_enabled") is True


def test_agent_with_only_junk_ids_falls_back_to_the_default_toolset(client, store):
    """…et un agent dont TOUT est tombé ne part pas les mains vides : il
    récupère le socle par défaut, comme un agent créé sans rien cocher."""
    from llm_core.tools.task_tool import CUSTOM_DEFAULT_CATEGORIES

    r = client.put("/api/settings", headers=_user(), json={"custom_agents": [
        {"name": "ci", "prompt": "x", "tool_categories": [],
         "mcp_server_ids": [""]},
    ]})
    assert r.status_code == 200, r.text
    stored = (store.get("alice") or {}).get("custom_agents") or []
    assert stored[0]["tool_categories"] == list(CUSTOM_DEFAULT_CATEGORIES)


def test_partial_put_merges(client, store):
    """Un PUT mono-clé (persist immédiat du toggle mémoire) ne détruit pas les
    clés agents déjà stockées — merge non destructif du backend."""
    client.put("/api/settings", headers=_user(), json={
        "custom_agents": [{"name": "aa", "prompt": "p", "tool_categories": []}],
        "agents_enabled": True,
    })
    client.put("/api/settings", headers=_user(), json={"memory_enabled": True})
    s = store["alice"]
    assert s["memory_enabled"] is True
    assert s["agents_enabled"] is True
    assert s["custom_agents"][0]["name"] == "aa"


def test_unknown_key_ignored(client, store):
    client.put("/api/settings", headers=_user(),
               json={"agents_enabled": True, "totally_unknown": 1})
    assert "totally_unknown" not in store["alice"]
    assert store["alice"]["agents_enabled"] is True


# ── Interrupteur MAÎTRE : le front doit pouvoir le lire ─────────────────────

def test_public_config_expose_le_flag_agents():
    """``AGENTS_ENABLED`` (llm.task.enabled) gouverne les sous-agents pour toute
    l'instance. Sans l'exposer, le panneau Paramètres ET l'onglet Agents d'une
    routine offraient une case à cocher que le serveur ignore — un réglage mort,
    invisible depuis l'UI. Le front lit ``features.agents`` pour le dire."""
    import inspect

    import shared_infra.routes.system as sys_routes

    src = inspect.getsource(sys_routes)
    assert '"agents": bool(AGENTS_ENABLED)' in src
    # Le flag vient bien de la config d'instance, pas d'un littéral.
    from shared_infra.config import AGENTS_ENABLED
    assert isinstance(AGENTS_ENABLED, bool)


def test_put_builtin_name_is_an_override(client, store):
    """Un nom intégré n'est ni refusé ni renommé : c'est une SURCHARGE du
    modèle livré, qui ne stocke que ses écarts (prompt vide = persona livrée).
    Une surcharge sans aucun écart n'est pas écrite du tout."""
    r = client.put("/api/settings", json={
        "custom_agents": [
            {"name": "pr", "tool_categories": ["git"]},         # écart : catégories
            {"name": "explore", "prompt": "", "tool_categories": []},  # rien
            {"name": "web", "enabled": False},                  # écart : désactivé
        ],
    }, headers={"x-test-user": "alice"})
    assert r.status_code == 200, r.text
    stored = client.get("/api/settings", headers={"x-test-user": "alice"}).json()["custom_agents"]
    assert [a["name"] for a in stored] == ["pr", "web"]
    assert stored[0]["prompt"] == "" and stored[0]["tool_categories"] == ["git"]
    assert stored[1]["enabled"] is False
