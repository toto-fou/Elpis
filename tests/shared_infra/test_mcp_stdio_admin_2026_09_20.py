# SPDX-License-Identifier: MIT
"""
Serveur MCP perso ``stdio`` = commande exécutée sur l'HÔTE (hors sandbox).
Avant le 2026-09-20, les gardes « modification / suppression réservées aux
administrateurs » ne couvraient que les entrées EXISTANTES : tout compte
pouvait en AJOUTER une avec une commande libre → exécution de code arbitraire
sur le serveur. Ici : refus à l'ajout, neutralisation à la résolution.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def ms(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "cle-de-test-mcp-stdio")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    return importlib.import_module("shared_infra.mcp.servers")


def _stdio(**over):
    d = {"id": "s1", "name": "Local", "type": "stdio", "command": "python3 -c 'print(1)'",
         "visible": True}
    d.update(over)
    return d


def _http(**over):
    d = {"id": "h1", "name": "Wiki", "type": "http", "url": "http://w/mcp", "visible": True}
    d.update(over)
    return d


# ── À l'enregistrement ──────────────────────────────────────────────────────

def test_ajout_stdio_refuse_a_un_non_admin(ms):
    with pytest.raises(ms.StdioNotAllowed):
        ms.merge_personal_mcp([], [_stdio()], allow_stdio=False)


def test_ajout_stdio_accepte_pour_un_admin(ms):
    out = ms.merge_personal_mcp([], [_stdio()], allow_stdio=True)
    assert out and out[0]["type"] == "stdio" and out[0]["command"].startswith("python3")


def test_le_type_est_normalise_avant_la_garde(ms):
    # « STDIO » ou «  stdio  » ne contournent pas la garde.
    with pytest.raises(ms.StdioNotAllowed):
        ms.merge_personal_mcp([], [_stdio(type="  STDIO ")], allow_stdio=False)


def test_les_autres_types_restent_libres_pour_un_non_admin(ms):
    out = ms.merge_personal_mcp([], [_http(), _http(id="h2", type="sse")], allow_stdio=False)
    assert [s["type"] for s in out] == ["http", "sse"]


def test_une_entree_stdio_existante_est_conservee_pour_un_non_admin(ms):
    # Un non-admin ne peut ni modifier ni retirer une entrée existante : la
    # fusion doit donc passer (sinon il ne peut plus enregistrer AUCUN réglage).
    old = ms.merge_personal_mcp([], [_stdio()], allow_stdio=True)
    out = ms.merge_personal_mcp(old, [_stdio(), _http()], allow_stdio=False)
    assert [s["id"] for s in out] == ["s1", "h1"]


def test_la_valeur_par_defaut_refuse_stdio(ms):
    # 2026-09-21 : refus PAR DÉFAUT. Un appelant qui oublie le drapeau (les
    # sous-agents de routine l'oubliaient) ne fait plus rien exécuter.
    with pytest.raises(ms.StdioNotAllowed):
        ms.merge_personal_mcp([], [_stdio()])
    assert ms.personal_to_config(_stdio()) == {}
    assert ms.resolve_for_agents({"mcp_servers": [_stdio(), _http()]}) \
        == [ms.personal_to_config(_http())]
    assert ms.resolve_personal({"mcp_servers": [_stdio()]}, "s1") is None


def test_un_serveur_existant_ne_devient_pas_stdio_sans_droit(ms):
    # Le modérateur passe la garde de modification de la route : la fusion
    # doit refuser elle-même la conversion http → stdio.
    old = ms.merge_personal_mcp([], [_http()], allow_stdio=False)
    with pytest.raises(ms.StdioNotAllowed):
        ms.merge_personal_mcp(old, [_stdio(id="h1")], allow_stdio=False)


def test_la_commande_dune_entree_stdio_existante_est_figee_sans_droit(ms):
    old = ms.merge_personal_mcp([], [_stdio()], allow_stdio=True)
    with pytest.raises(ms.StdioNotAllowed):
        ms.merge_personal_mcp(old, [_stdio(command="sh -c id")], allow_stdio=False)
    # Renvoyée à l'identique (re-PUT du blob entier) : acceptée.
    assert ms.merge_personal_mcp(old, [_stdio()], allow_stdio=False)[0]["type"] == "stdio"


# ── À la résolution ─────────────────────────────────────────────────────────

def test_personal_to_config_neutralise_stdio_sans_droit(ms):
    assert ms.personal_to_config(_stdio(), allow_stdio=False) == {}
    assert ms.personal_to_config(_stdio(), allow_stdio=True)["command"].startswith("python3")


def test_personal_to_config_laisse_passer_http_sans_droit(ms):
    assert ms.personal_to_config(_http(), allow_stdio=False)["url"] == "http://w/mcp"


def test_resolve_personal_stdio_non_admin_donne_none(ms):
    settings = {"mcp_servers": [_stdio(), _http()]}
    assert ms.resolve_personal(settings, "s1", allow_stdio=False) is None
    assert ms.resolve_personal(settings, "s1", allow_stdio=True)["type"] == "stdio"
    assert ms.resolve_personal(settings, "h1", allow_stdio=False)["type"] == "http"


def test_resolve_for_agents_ecarte_stdio_non_admin(ms):
    settings = {"mcp_servers": [_stdio(), _http()], "shared_mcp_visible": []}
    assert [c["id"] for c in ms.resolve_for_agents(settings, allow_stdio=False)] == ["h1"]
    assert [c["id"] for c in ms.resolve_for_agents(settings, allow_stdio=True)] == ["s1", "h1"]


# ── Chemins d'exécution : chat, agents, routines ─────────────────────────────

def test_chat_stdio_allowed_for_exige_admin_plein(ms, monkeypatch):
    from chatbot_app.routes import chats
    rows = {1: {"is_admin": 1}, 2: {"is_admin": 2}, 3: {"is_admin": 0}}
    monkeypatch.setattr("shared_infra.accounts.users.get_user_by_id", lambda uid: rows.get(uid))
    assert chats._stdio_allowed_for(1) is True
    assert chats._stdio_allowed_for(2) is False    # modérateur : non
    assert chats._stdio_allowed_for(3) is False
    assert chats._stdio_allowed_for(99) is False   # inconnu : non
    assert chats._stdio_allowed_for("x") is False  # invalide : non, sans exception


def test_agent_mcp_configs_sans_user_id_n_expose_jamais_stdio(ms):
    from chatbot_app.routes import chats
    settings = {"mcp_servers": [_stdio(), _http()], "shared_mcp_visible": []}
    assert [c["id"] for c in chats._agent_mcp_configs(settings)] == ["h1"]


def test_routine_rehydrate_ecarte_stdio_du_proprietaire_non_admin(ms):
    from shared_infra.scheduling.routines_scheduler import _rehydrate_mcp_secrets
    settings = {"mcp_servers": [_stdio(), _http()], "shared_mcp_visible": []}
    snapshot = [{"id": "s1", "name": "Local", "type": "stdio"}, {"id": "h1", "name": "Wiki", "type": "http"}]
    assert [c["id"] for c in _rehydrate_mcp_secrets(snapshot, settings)] == ["h1"]
    assert [c["id"] for c in _rehydrate_mcp_secrets(snapshot, settings, allow_stdio=True)] == ["s1", "h1"]


# ── Routes : enregistrement (PUT /api/settings) et sonde (POST /api/mcp/test) ─

import contextvars

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

_CUR = contextvars.ContextVar("uid", default=None)


@pytest.fixture()
def rclient(ms, monkeypatch):
    import shared_infra.accounts.routes_settings as rs
    import shared_infra.mcp.panel as panel
    store: dict = {}
    who = {"admin": 1}

    def _uid(request):
        uid = _CUR.get()
        if not uid:
            raise HTTPException(401, "Authentification requise")
        return uid

    monkeypatch.setattr(rs, "require_user_id", _uid)
    monkeypatch.setattr(rs, "get_user_settings", lambda uid: dict(store.get(uid) or {}))
    monkeypatch.setattr(rs, "update_user_settings", lambda uid, s: store.__setitem__(uid, dict(s)))

    def _merge(uid, mutate, _st=store):
        s = dict(_st.get(uid) or {}); mutate(s); _st[uid] = dict(s); return dict(s)
    monkeypatch.setattr(rs, "merge_user_settings", _merge)
    monkeypatch.setattr(rs, "get_username_by_id", lambda uid: str(uid))
    monkeypatch.setattr(rs, "read_config_json", lambda: {})
    monkeypatch.setattr(rs, "get_user_by_id", lambda uid: {"is_admin": who["admin"]})
    monkeypatch.setattr(panel, "require_user_id", _uid)
    monkeypatch.setattr(panel, "get_user_by_id", lambda uid: {"is_admin": who["admin"]})
    # La sonde relit les réglages perso par un import local → patch à la source.
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings",
                        lambda uid: dict(store.get(uid) or {}))
    probed: dict = {}

    async def _fake_probe(cfg):
        probed.update(cfg); return {"ok": True, "tools": [], "ms": 1}
    monkeypatch.setattr(panel, "_probe_mcp", _fake_probe)

    from shared_infra.routes._state import router
    app = FastAPI()

    @app.middleware("http")
    async def _inject(request: Request, call_next):
        tok = _CUR.set(request.headers.get("x-test-user") or None)
        try:
            return await call_next(request)
        finally:
            _CUR.reset(tok)
    app.include_router(router)
    return TestClient(app), who, store, probed


_H = {"x-test-user": "7"}


def test_put_settings_ajout_stdio_par_un_non_admin_403(rclient):
    c, who, store, _ = rclient
    who["admin"] = 0
    r = c.put("/api/settings", headers=_H, json={"mcp_servers": [_stdio()]})
    assert r.status_code == 403 and "administrateurs" in r.json()["detail"]
    assert not (store.get("7") or {}).get("mcp_servers")


def test_put_settings_moderateur_pas_davantage(rclient):
    c, who, _, _ = rclient
    who["admin"] = 2
    assert c.put("/api/settings", headers=_H, json={"mcp_servers": [_stdio()]}).status_code == 403


def test_put_settings_admin_enregistre_stdio(rclient):
    c, who, store, _ = rclient
    who["admin"] = 1
    r = c.put("/api/settings", headers=_H, json={"mcp_servers": [_stdio()]})
    assert r.status_code == 200, r.text
    assert store["7"]["mcp_servers"][0]["type"] == "stdio"


def test_put_settings_non_admin_garde_ses_autres_reglages(rclient):
    # Une entrée stdio EXISTANTE (héritée) ne bloque pas les autres enregistrements.
    c, who, store, _ = rclient
    who["admin"] = 1
    assert c.put("/api/settings", headers=_H, json={"mcp_servers": [_stdio()]}).status_code == 200
    who["admin"] = 0
    r = c.put("/api/settings", headers=_H, json={"mcp_servers": [_stdio()], "theme": "dark"})
    assert r.status_code == 200, r.text


def test_sonde_stdio_perso_refusee_au_non_admin(rclient):
    c, who, _, probed = rclient
    who["admin"] = 0
    r = c.post("/api/mcp/test", headers=_H, json={"type": "stdio", "command": "id", "name": "x"})
    assert r.status_code == 403
    assert not probed, "la commande ne doit jamais être lancée"


def test_sonde_stdio_perso_passe_pour_ladmin(rclient):
    c, who, _, probed = rclient
    who["admin"] = 1
    r = c.post("/api/mcp/test", headers=_H, json={"type": "stdio", "command": "id", "name": "x"})
    assert r.status_code == 200, r.text
    assert probed.get("command") == "id"


def test_sonde_http_perso_libre_pour_tous(rclient):
    c, who, _, probed = rclient
    who["admin"] = 0
    r = c.post("/api/mcp/test", headers=_H, json={"type": "http", "url": "http://w/mcp", "name": "x"})
    assert r.status_code == 200, r.text and probed.get("url") == "http://w/mcp"


# ── Audit 2026-09-21 : références seulement (S1, S2, S3) ─────────────────────

def test_routine_une_commande_postee_sans_correspondance_est_jetee(ms):
    """S1 : une entrée ``stdio`` postée dans une routine, qui ne correspond à
    aucun serveur de l'utilisateur, partait telle quelle vers le spawn."""
    from shared_infra.scheduling.routines_scheduler import _rehydrate_mcp_secrets
    snap = [{"type": "stdio", "name": "zz", "command": "sh -c 'id > /tmp/x'"},
            {"type": "http", "name": "yy", "url": "http://10.0.0.5:8080/mcp"}]
    assert _rehydrate_mcp_secrets(snap, {"mcp_servers": []}, allow_stdio=True) == []


def test_routine_la_sentinelle_est_reconstruite(ms):
    from shared_infra.scheduling.routines_scheduler import _rehydrate_mcp_secrets
    snap = [{"type": "sse", "command": "DEFAULT_LOCAL_PYTHON", "name": "Outils Locaux",
             "url": "http://interne/", "headers": {"X": "1"},
             "families": ["desktop"], "filter_categories": ["fs"]}]
    assert _rehydrate_mcp_secrets(snap, {}) == [{
        "type": "stdio", "name": "Outils Locaux",
        "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]}]


def test_routine_enregistree_ne_garde_que_des_references(ms):
    from shared_infra.scheduling.routes_routines import _mcp_refs
    out = _mcp_refs([
        {"type": "stdio", "name": "Outils Locaux", "command": "DEFAULT_LOCAL_PYTHON",
         "filter_categories": ["fs"], "url": "http://x"},
        {"id": "h1", "name": "Wiki", "type": "http", "url": "http://interne",
         "command": "sh", "headers": {"A": "b"}},
        {"id": "shared:3", "name": "Lib", "type": "http", "shared": True},
        {"type": "stdio", "command": "sh -c id"},
        "pas un objet",
    ])
    assert out == [
        {"type": "stdio", "name": "Outils Locaux", "command": "DEFAULT_LOCAL_PYTHON",
         "filter_categories": ["fs"]},
        {"id": "h1", "name": "Wiki", "type": "http"},
        {"id": "shared:3", "shared": True, "name": "Lib", "type": "http"},
    ]


def test_routine_sous_agents_passent_le_drapeau_stdio():
    """S3 : ``resolve_for_agents`` était appelé sans ``allow_stdio`` dans les
    routines (défaut permissif à l'époque)."""
    import inspect
    from shared_infra.scheduling import routines_scheduler
    src = inspect.getsource(routines_scheduler.execute_routine_run)
    assert "resolve_for_agents, user_settings, allow_stdio=_stdio_ok" in src


def test_chat_entree_outils_locaux_reconstruite(ms):
    """S2 : ``type``/``url``/``headers``/``families`` du client ne passent plus."""
    ref = ms.client_builtin_ref({
        "type": "inprocess", "command": "DEFAULT_LOCAL_PYTHON", "name": "Outils Locaux",
        "url": "http://10.0.0.5/", "headers": {"A": "b"}, "families": ["shell"],
        "manifest": "elpis-memory", "filter_categories": ["fs", 3]})
    assert ref == {"type": "stdio", "name": "Outils Locaux",
                   "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]}
    assert ms.client_builtin_ref({"type": "stdio", "command": "sh"}) is None


@pytest.fixture(autouse=True)
def _sans_garde_ssrf(monkeypatch):
    """Hôtes factices (``http://w``) : la garde SSRF des MCP perso
    (audit 2026-09-22, H7) a ses propres tests."""
    import shared_infra.mcp.servers as _srv
    monkeypatch.setattr(_srv, "personal_url_block_reason", lambda url: None)
