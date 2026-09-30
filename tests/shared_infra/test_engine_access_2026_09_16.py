# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_engine_access_2026_09_16.py — lot B4 : visibilité des
serveurs d'inférence et droit de gérer les modèles, par utilisateur et groupe.

Décisions utilisateur verrouillées ici :
  D2  accès à tout par défaut ; dès qu'une liste est posée, SEULEMENT ces
      serveurs ; liste propre > union des groupes > tous.
  D5  un administrateur voit et utilise tout.
  D7  gérer les modèles : autorisé par défaut, réglable par compte ou groupe.
Plus : connecteur personnel = propriétaire seul ; clé purgée à la suppression
d'un connecteur (liste vidée = AUCUN serveur, jamais « tout ») ; lecture en
échec = aucune restriction (fail-open documenté).
"""
from __future__ import annotations

import importlib
import sqlite3
import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from shared_infra.llm import engine_access as ea


# ─────────────────────────────────────────────────────────────────────────────
#  Résolution PURE
# ─────────────────────────────────────────────────────────────────────────────
def _pol(keys=None, manage=None):
    return {"engine_keys": keys, "can_manage_models": manage}


def test_sans_aucune_regle_tout_est_ouvert():
    r = ea.resolve_access(None, [], is_admin=False)
    assert r["engine_keys"] is None and r["engine_source"] == "default"
    assert r["can_manage_models"] is True and r["manage_source"] == "default"


def test_liste_propre_seulement_ces_serveurs():
    r = ea.resolve_access(_pol(["builtin"]), [_pol(["conn:2"])], is_admin=False)
    assert r["engine_keys"] == frozenset({"builtin"}) and r["engine_source"] == "user"


def test_union_des_groupes_sans_liste_propre():
    r = ea.resolve_access(_pol(), [_pol(["conn:1"]), _pol(None), _pol(["conn:2", "conn:1"])],
                          is_admin=False)
    assert r["engine_keys"] == frozenset({"conn:1", "conn:2"}) and r["engine_source"] == "groups"


def test_groupes_sans_liste_ne_restreignent_rien():
    r = ea.resolve_access(None, [_pol(None, False)], is_admin=False)
    assert r["engine_keys"] is None and r["engine_source"] == "default"


def test_liste_vide_aucun_serveur():
    assert ea.resolve_access(_pol([]), [], is_admin=False)["engine_keys"] == frozenset()


def test_etoile_rend_tout_meme_si_un_groupe_restreint():
    r = ea.resolve_access(_pol(["*"]), [_pol(["conn:1"])], is_admin=False)
    assert r["engine_keys"] is None and r["engine_source"] == "user"
    r = ea.resolve_access(None, [_pol(["conn:1"]), _pol(["*"])], is_admin=False)
    assert r["engine_keys"] is None


def test_admin_voit_tout_et_gere_les_modeles():
    r = ea.resolve_access(_pol([], False), [_pol([], False)], is_admin=True)
    assert r["engine_keys"] is None and r["can_manage_models"] is True
    assert r["engine_source"] == r["manage_source"] == "admin"


@pytest.mark.parametrize("user,groups,attendu,source", [
    (None, [], True, "default"),
    (False, [True], False, "user"),
    (True, [False], True, "user"),
    (None, [False, None], False, "groups"),
    (None, [False, True], True, "groups"),
    (None, [None, None], True, "default"),
])
def test_matrice_gestion_des_modeles(user, groups, attendu, source):
    r = ea.resolve_access(_pol(None, user), [_pol(None, g) for g in groups], is_admin=False)
    assert r["can_manage_models"] is attendu and r["manage_source"] == source


@pytest.mark.parametrize("key,attendu", [
    ("builtin", ("builtin", None)), ("conn:12", ("conn", 12)), (" conn:3 ", ("conn", 3)),
    ("conn:0", None), ("conn:-1", None), ("conn:x", None), ("*", None), ("", None),
    (None, None), (3, None), ("builtin2", None),
])
def test_parse_key(key, attendu):
    assert ea.parse_key(key) == attendu


# ─────────────────────────────────────────────────────────────────────────────
#  Base réelle (fichier temporaire, migrations comprises)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    ea.invalidate_cache()
    from shared_infra.accounts.groups import create_group, set_user_groups
    from shared_infra.accounts.users import create_user
    from shared_infra.llm import connectors as lc
    ids = {
        "admin": create_user("root", "pw-root-1", is_admin=1),
        "alice": create_user("alice", "pw-alice-1"),
        "bob": create_user("bob", "pw-bob-1"),
    }
    ids["g_dev"] = create_group("dev")
    ids["g_ops"] = create_group("ops")
    set_user_groups(ids["alice"], [ids["g_dev"], ids["g_ops"]])
    ids["s1"] = lc.create_connector(scope="shared", provider_type="llamacpp", wire="openai",
                                    base_url="http://a:8080", label="Serveur A")
    ids["s2"] = lc.create_connector(scope="shared", provider_type="vllm", wire="openai",
                                    base_url="http://b:8000/v1", label="Serveur B")
    ids["p_bob"] = lc.create_connector(scope="user", owner_user_id=ids["bob"],
                                       provider_type="openai", wire="openai",
                                       base_url="https://api.openai.com/v1", label="Perso bob")
    yield ids
    ea.invalidate_cache()


def test_stockage_aller_retour_et_suppression_de_ligne(base):
    assert ea.get_policy("user", base["alice"]) == _pol()
    ea.set_policy("user", base["alice"], engine_keys=["builtin", "builtin", "conn:1"],
                  can_manage_models=False)
    assert ea.get_policy("user", base["alice"]) == _pol(["builtin", "conn:1"], False)
    ea.set_policy("user", base["alice"], engine_keys=None, can_manage_models=None)
    from shared_infra.db._connection import db_conn
    with db_conn() as c:
        assert c.execute("SELECT COUNT(*) FROM llm_engine_policies").fetchone()[0] == 0


def test_normalisation_refuse_les_cles_invalides_et_inconnues(base):
    with pytest.raises(ValueError, match="invalides"):
        ea.normalize_engine_keys(["builtin", "conn:abc"])
    with pytest.raises(ValueError, match="inconnus"):
        ea.normalize_engine_keys([f"conn:{base['s1']}", "conn:9999"])
    # Un connecteur PERSONNEL n'a rien à faire dans une liste d'administration.
    with pytest.raises(ValueError, match="inconnus"):
        ea.normalize_engine_keys([f"conn:{base['p_bob']}"])
    with pytest.raises(ValueError):
        ea.normalize_engine_keys("builtin")
    assert ea.normalize_engine_keys(["*", f"conn:{base['s2']}", "*"]) == ["*", f"conn:{base['s2']}"]
    assert ea.normalize_engine_keys(None) is None
    assert ea.normalize_engine_keys([]) == []


def test_utilisation_selon_liste_propre_et_groupes(base):
    s1, s2 = ea.connector_key(base["s1"]), ea.connector_key(base["s2"])
    alice, bob = base["alice"], base["bob"]
    # Défaut : tout.
    assert ea.effective_engine_keys(alice) is None
    assert ea.can_use_engine(alice, "builtin") and ea.can_use_engine(alice, s2)
    # Groupes : union dev ∪ ops.
    ea.set_policy("group", base["g_dev"], engine_keys=[s1], can_manage_models=None)
    ea.set_policy("group", base["g_ops"], engine_keys=["builtin"], can_manage_models=None)
    assert ea.effective_engine_keys(alice) == frozenset({s1, "builtin"})
    assert ea.can_use_engine(alice, s1) and ea.can_use_engine(alice, "builtin")
    assert not ea.can_use_engine(alice, s2)
    # Bob n'est dans aucun groupe : toujours tout.
    assert ea.can_use_engine(bob, s2)
    # Liste propre : prime sur les groupes.
    ea.set_policy("user", alice, engine_keys=[s2], can_manage_models=None)
    assert ea.effective_engine_keys(alice) == frozenset({s2})
    assert not ea.can_use_engine(alice, "builtin") and ea.can_use_engine(alice, s2)


def test_connecteur_personnel_proprietaire_seul_meme_restreint(base):
    pk = ea.connector_key(base["p_bob"])
    ea.set_policy("user", base["bob"], engine_keys=[], can_manage_models=None)
    assert ea.can_use_engine(base["bob"], pk) is True
    assert ea.can_use_engine(base["alice"], pk) is False
    # Même un admin n'utilise pas le connecteur personnel d'autrui.
    assert ea.can_use_engine(base["admin"], pk) is False


def test_admin_contourne_les_listes(base):
    ea.set_policy("user", base["admin"], engine_keys=[], can_manage_models=False)
    assert ea.effective_engine_keys(base["admin"]) is None
    assert ea.can_use_engine(base["admin"], "builtin")
    assert ea.can_manage_models(base["admin"]) is True
    # L'appelant qui connaît déjà le rôle peut le passer (pas de relecture).
    assert ea.can_manage_models(base["alice"], is_admin=True) is True


def test_cles_invalides_ou_connecteur_absent_refuses(base):
    for k in ("", "conn:9999", "conn:x", "*", None):
        assert ea.can_use_engine(base["alice"], k) is False


def test_gestion_des_modeles_utilisateur_et_groupes(base):
    alice = base["alice"]
    assert ea.can_manage_models(alice) is True
    ea.set_policy("group", base["g_dev"], engine_keys=None, can_manage_models=False)
    assert ea.can_manage_models(alice) is False
    ea.set_policy("group", base["g_ops"], engine_keys=None, can_manage_models=True)
    assert ea.can_manage_models(alice) is True
    ea.set_policy("user", alice, engine_keys=None, can_manage_models=False)
    assert ea.can_manage_models(alice) is False


def test_filtre_des_connecteurs(base):
    from shared_infra.llm import connectors as lc
    rows = lc.list_shared_connectors() + lc.list_user_connectors(base["bob"])
    ea.set_policy("user", base["bob"], engine_keys=[ea.connector_key(base["s2"])],
                  can_manage_models=None)
    kept = {r["id"] for r in ea.filter_shared_connectors(base["bob"], rows)}
    assert kept == {base["s2"], base["p_bob"]}
    # Un personnel d'un AUTRE compte ne passe jamais.
    kept_alice = {r["id"] for r in ea.filter_shared_connectors(base["alice"], rows)}
    assert base["p_bob"] not in kept_alice and {base["s1"], base["s2"]} <= kept_alice


def test_purge_d_un_connecteur_liste_videe_reste_vide(base):
    s1 = ea.connector_key(base["s1"])
    ea.set_policy("user", base["alice"], engine_keys=[s1], can_manage_models=True)
    ea.set_policy("group", base["g_dev"], engine_keys=[s1, "builtin"], can_manage_models=None)
    assert ea.purge_engine_key(s1) == 2
    assert ea.get_policy("user", base["alice"]) == _pol([], True)
    assert ea.get_policy("group", base["g_dev"])["engine_keys"] == ["builtin"]
    # Liste vidée = AUCUN serveur, pas « tout ».
    assert ea.effective_engine_keys(base["alice"]) == frozenset()
    assert ea.purge_engine_key("n'importe quoi") == 0


def test_suppression_compte_et_groupe_purge_les_politiques(base):
    from shared_infra.accounts.groups import delete_group
    from shared_infra.accounts.users import delete_user_full
    ea.set_policy("user", base["bob"], engine_keys=["builtin"], can_manage_models=None)
    ea.set_policy("group", base["g_ops"], engine_keys=["builtin"], can_manage_models=None)
    assert delete_user_full(base["bob"]) and delete_group(base["g_ops"])
    assert ea.list_policies() == {}


def test_cache_invalide_par_ecriture_et_borne_par_ttl(base, monkeypatch):
    alice = base["alice"]
    assert ea.effective_engine_keys(alice) is None          # contexte mis en cache
    # Écriture DIRECTE en base (= autre worker) : invisible tant que le TTL court…
    from shared_infra.db._connection import db_conn
    with db_conn() as c:
        c.execute("INSERT INTO llm_engine_policies VALUES('user', ?, '[]', NULL, ?)",
                  (alice, time.time()))
        c.commit()
    assert ea.effective_engine_keys(alice) is None
    # … puis prise en compte après expiration.
    monkeypatch.setattr(ea, "_TTL_S", 0.0)
    assert ea.effective_engine_keys(alice) == frozenset()
    monkeypatch.setattr(ea, "_TTL_S", 60.0)
    # Écriture par l'API du module : effet IMMÉDIAT dans ce process.
    ea.set_policy("user", alice, engine_keys=["builtin"], can_manage_models=None)
    assert ea.effective_engine_keys(alice) == frozenset({"builtin"})


def test_lecture_en_echec_aucune_restriction(base, monkeypatch):
    ea.set_policy("user", base["alice"], engine_keys=[], can_manage_models=False)
    ea.invalidate_cache()

    class _Boom:
        def __enter__(self):
            raise sqlite3.OperationalError("database is locked")

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(ea, "db_conn", lambda: _Boom())
    assert ea.effective_engine_keys(base["alice"]) is None
    assert ea.can_manage_models(base["alice"]) is True
    assert ea.can_use_engine(base["alice"], "builtin") is True


def test_options_integre_et_partages_seulement(base):
    opts = ea.list_engine_options()
    keys = [o["key"] for o in opts]
    assert keys[0] == "builtin"
    assert set(keys[1:]) == {ea.connector_key(base["s1"]), ea.connector_key(base["s2"])}


def test_describe_users_une_ligne_par_compte(base):
    from shared_infra.accounts.groups import get_all_users_with_groups
    ea.set_policy("group", base["g_dev"], engine_keys=["builtin"], can_manage_models=False)
    users = get_all_users_with_groups()
    ea.describe_users(users)
    by = {u["username"]: u for u in users}
    a = by["alice"]
    assert a["llm_engine_keys"] is None and a["llm_can_manage_models"] is None
    assert a["llm_effective_engine_keys"] == ["builtin"] and a["llm_engine_source"] == "groups"
    assert a["llm_effective_can_manage_models"] is False and a["llm_manage_source"] == "groups"
    assert by["root"]["llm_engine_source"] == "admin"
    assert by["bob"]["llm_effective_engine_keys"] is None


# ─────────────────────────────────────────────────────────────────────────────
#  Routes d'administration
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def client(base, monkeypatch):
    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    import shared_infra.routes._helpers as helpers
    import shared_infra.routes.admin.groups as ag
    import shared_infra.routes.admin.llm_connectors as alc
    import shared_infra.routes.admin.users as au
    monkeypatch.setattr(helpers, "require_user_id", _fake_uid)
    monkeypatch.setattr(au, "require_user_id", _fake_uid)
    monkeypatch.setattr(ag, "require_user_id", _fake_uid)
    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.include_router(admin_router)
    return TestClient(app), base, alc


def _h(uid):
    return {"x-test-user": str(uid)}


NEW_ROUTES = [
    ("get", "/api/admin/llm/engine-options", None),
    ("get", "/api/admin/users/{alice}/llm-access", None),
    ("put", "/api/admin/users/{alice}/llm-access", {"engine_keys": ["builtin"]}),
    ("get", "/api/admin/groups/{g_dev}/llm-access", None),
    ("put", "/api/admin/groups/{g_dev}/llm-access", {"can_manage_models": False}),
]


@pytest.mark.parametrize("method,path,body", NEW_ROUTES)
def test_routes_reservees_aux_admins(client, method, path, body):
    tc, ids, _ = client
    url = path.format(**ids)
    kw = {"json": body} if body is not None else {}
    r = getattr(tc, method)(url, headers=_h(ids["alice"]), **kw)
    assert r.status_code == 403
    assert ea.list_policies() == {}


def test_put_utilisateur_valide_et_conserve_le_champ_absent(client):
    tc, ids, _ = client
    url = f"/api/admin/users/{ids['alice']}/llm-access"
    r = tc.put(url, headers=_h(ids["admin"]),
               json={"engine_keys": [f"conn:{ids['s1']}"], "can_manage_models": False})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["engine_keys"] == [f"conn:{ids['s1']}"] and d["can_manage_models"] is False
    assert d["effective_engine_keys"] == [f"conn:{ids['s1']}"] and d["engine_source"] == "user"
    # Champ absent = inchangé.
    r = tc.put(url, headers=_h(ids["admin"]), json={"can_manage_models": None})
    assert r.json()["engine_keys"] == [f"conn:{ids['s1']}"]
    assert r.json()["can_manage_models"] is None
    assert tc.get(url, headers=_h(ids["admin"])).json()["effective_can_manage_models"] is True


@pytest.mark.parametrize("body", [
    {"engine_keys": ["conn:9999"]},
    {"engine_keys": ["nope"]},
    {"engine_keys": "builtin"},
    {"can_manage_models": 1},
    {"can_manage_models": "true"},
    ["builtin"],
])
def test_put_refuse_les_corps_invalides(client, body):
    tc, ids, _ = client
    r = tc.put(f"/api/admin/users/{ids['alice']}/llm-access", headers=_h(ids["admin"]), json=body)
    assert r.status_code == 400
    assert ea.list_policies() == {}


def test_cibles_inconnues_404(client):
    tc, ids, _ = client
    assert tc.get("/api/admin/users/999/llm-access", headers=_h(ids["admin"])).status_code == 404
    assert tc.put("/api/admin/users/999/llm-access", headers=_h(ids["admin"]),
                  json={"engine_keys": None}).status_code == 404
    assert tc.get("/api/admin/groups/999/llm-access", headers=_h(ids["admin"])).status_code == 404
    assert tc.put("/api/admin/groups/999/llm-access", headers=_h(ids["admin"]),
                  json={"engine_keys": None}).status_code == 404


def test_groupe_liste_et_heritage_visible_cote_membre(client):
    tc, ids, _ = client
    r = tc.put(f"/api/admin/groups/{ids['g_dev']}/llm-access", headers=_h(ids["admin"]),
               json={"engine_keys": ["builtin"], "can_manage_models": False})
    assert r.status_code == 200 and r.json()["engine_keys"] == ["builtin"]
    groups = tc.get("/api/admin/groups", headers=_h(ids["admin"])).json()["groups"]
    dev = next(g for g in groups if g["id"] == ids["g_dev"])
    assert dev["llm_engine_keys"] == ["builtin"] and dev["llm_can_manage_models"] is False
    view = tc.get(f"/api/admin/users/{ids['alice']}/llm-access", headers=_h(ids["admin"])).json()
    assert view["engine_source"] == "groups" and view["effective_engine_keys"] == ["builtin"]
    assert view["manage_source"] == "groups" and view["effective_can_manage_models"] is False


def test_changer_les_groupes_invalide_le_cache(client):
    tc, ids, _ = client
    ea.set_policy("group", ids["g_dev"], engine_keys=["builtin"], can_manage_models=None)
    assert ea.effective_engine_keys(ids["bob"]) is None                # en cache
    r = tc.put(f"/api/admin/users/{ids['bob']}/groups", headers=_h(ids["admin"]),
               json={"group_ids": [ids["g_dev"]]})
    assert r.status_code == 200
    assert ea.effective_engine_keys(ids["bob"]) == frozenset({"builtin"})


def test_options_de_serveurs(client):
    tc, ids, _ = client
    d = tc.get("/api/admin/llm/engine-options", headers=_h(ids["admin"])).json()
    assert [e["key"] for e in d["engines"]][0] == "builtin"
    assert f"conn:{ids['p_bob']}" not in [e["key"] for e in d["engines"]]


def test_suppression_d_un_connecteur_partage_purge_les_listes(client):
    tc, ids, alc = client
    s1 = f"conn:{ids['s1']}"
    ea.set_policy("user", ids["alice"], engine_keys=[s1, "builtin"], can_manage_models=None)
    r = tc.delete(f"/api/admin/llm/connectors/{ids['s1']}", headers=_h(ids["admin"]))
    assert r.status_code == 200, r.text
    assert ea.get_policy("user", ids["alice"])["engine_keys"] == ["builtin"]


# ─────────────────────────────────────────────────────────────────────────────
#  Migration 0018
# ─────────────────────────────────────────────────────────────────────────────
def _mig():
    return importlib.import_module("shared_infra.db._migrations.0018_llm_engine_policies")


def test_migration_base_neuve_idempotente_et_contrainte():
    c = sqlite3.connect(":memory:")
    _mig().migrate(c)
    _mig().migrate(c)
    cols = {r[1] for r in c.execute("PRAGMA table_info(llm_engine_policies)")}
    assert cols == {"principal_type", "principal_id", "engine_keys",
                    "can_manage_models", "updated_at"}
    c.execute("INSERT INTO llm_engine_policies VALUES('user', 1, NULL, NULL, 0)")
    with pytest.raises(sqlite3.IntegrityError):
        c.execute("INSERT INTO llm_engine_policies VALUES('role', 1, NULL, NULL, 0)")
    with pytest.raises(sqlite3.IntegrityError):
        c.execute("INSERT INTO llm_engine_policies VALUES('user', 1, '[]', NULL, 0)")


@pytest.mark.sqlite_only   # rejoue une migration historique sur le fichier SQLite
def test_migration_sur_base_existante_garde_les_donnees(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    from shared_infra.db._migrations import run_pending
    path = tmp_path / "old.db"
    monkeypatch.setattr(legacy, "DB_PATH", str(path))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    uid = create_user("ancien", "pw-ancien-1")
    # Simule une base d'AVANT le lot : table absente, migration non taggée.
    c = sqlite3.connect(str(path))
    c.execute("DROP TABLE llm_engine_policies")
    c.execute("DELETE FROM schema_migrations WHERE name='0018_llm_engine_policies'")
    c.commit()
    assert run_pending(c) >= 1
    assert c.execute("SELECT COUNT(*) FROM llm_engine_policies").fetchone()[0] == 0
    assert c.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()[0] == "ancien"
    assert run_pending(c) == 0
    c.close()


def test_liste_admin_des_comptes_porte_l_acces(client, monkeypatch):
    tc, ids, _ = client
    import shared_infra.routes.admin.users as au
    monkeypatch.setattr(au, "sandbox_usage_bytes", lambda *a, **k: 0)
    ea.set_policy("user", ids["bob"], engine_keys=["builtin"], can_manage_models=False)
    r = tc.get("/api/admin/users-with-groups", headers=_h(ids["admin"]))
    assert r.status_code == 200, r.text
    by = {u["username"]: u for u in r.json()["users"]}
    assert by["bob"]["llm_engine_keys"] == ["builtin"]
    assert by["bob"]["llm_effective_can_manage_models"] is False
    assert by["alice"]["llm_engine_source"] == "default"
    assert "_settings" not in by["bob"]
