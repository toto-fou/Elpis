# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_gardes_admin_2026_09_17.py — « Admin required » doit
vouloir dire ADMIN.

Constat 2026-09-16 : dix-sept routes d'administration testaient
``if not me["is_admin"]``. Or ``is_admin`` vaut 0 (utilisateur), 1 (admin) et
**2 (modérateur)** : 2 est vrai. Un modérateur pouvait donc créer/supprimer des
groupes, changer les groupes d'un compte (donc la visibilité des serveurs
d'inférence et le droit de charger les modèles, lot B4), supprimer un compte,
réinitialiser un mot de passe, lire et écrire ``config.json``, redémarrer
l'application, restaurer une sauvegarde…

Les routes volontairement ouvertes au personnel (compaction, métriques, logs,
mémoire AX) disent « Staff required » et gardent ``in (1, 2)`` : c'est le
message d'erreur qui fait foi, et le test ne vérifie QUE celles qui annoncent
« Admin required ».
"""
from __future__ import annotations

import pathlib
import re

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

RACINE = pathlib.Path(__file__).resolve().parents[2]
FICHIERS = sorted((RACINE / "shared_infra" / "routes" / "admin").glob("*.py")) + [
    RACINE / "shared_infra" / "routes" / "system.py",
    RACINE / "shared_infra" / "routes" / "_helpers.py",
]


@pytest.mark.parametrize("chemin", FICHIERS, ids=lambda p: p.name)
def test_aucune_garde_admin_ne_laisse_passer_un_moderateur(chemin):
    src = chemin.read_text(encoding="utf-8")
    fautifs = [n + 1 for n, ligne in enumerate(src.splitlines())
               if re.search(r'not me\["is_admin"\]', ligne)]
    assert not fautifs, (f"{chemin.name}: garde permissive ligne(s) {fautifs} — "
                         "``is_admin`` vaut 2 pour un modérateur")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.groups import create_group
    from shared_infra.accounts.users import create_user
    ids = {
        "admin": create_user("root", "pw-root-1", is_admin=1),
        "moderateur": create_user("mod", "pw-mod-11", is_admin=2),
        "alice": create_user("alice", "pw-alice-1"),
    }
    ids["groupe"] = create_group("dev")

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    import shared_infra.routes._helpers as helpers
    import shared_infra.routes.admin.groups as ag
    import shared_infra.routes.admin.users as au
    monkeypatch.setattr(helpers, "require_user_id", _fake_uid)
    monkeypatch.setattr(ag, "require_user_id", _fake_uid)
    monkeypatch.setattr(au, "require_user_id", _fake_uid)
    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.include_router(admin_router)
    return TestClient(app), ids


def _h(uid):
    return {"x-test-user": str(uid)}


ROUTES = [
    ("get", "/api/admin/groups", None),
    ("post", "/api/admin/groups", {"name": "intrus"}),
    ("put", "/api/admin/groups/{groupe}", {"name": "renomme"}),
    ("delete", "/api/admin/groups/{groupe}", None),
    ("put", "/api/admin/users/{alice}/groups", {"group_ids": []}),
    ("get", "/api/admin/users-with-groups", None),
    ("delete", "/api/admin/users/{alice}", None),
]


@pytest.mark.parametrize("methode,chemin,corps", ROUTES)
def test_un_moderateur_est_refuse_sur_les_routes_admin(client, methode, chemin, corps):
    tc, ids = client
    url = chemin.format(**ids)
    kw = {"json": corps} if corps is not None else {}
    assert getattr(tc, methode)(url, headers=_h(ids["moderateur"]), **kw).status_code == 403
    assert getattr(tc, methode)(url, headers=_h(ids["alice"]), **kw).status_code == 403
    # L'administrateur, lui, passe (le durcissement ne casse pas la fonction).
    assert getattr(tc, methode)(url, headers=_h(ids["admin"]), **kw).status_code == 200


def test_le_groupe_et_le_compte_sont_intacts_apres_les_refus(client):
    tc, ids = client
    from shared_infra.accounts.groups import list_groups
    from shared_infra.accounts.users import get_user_by_id
    tc.delete(f"/api/admin/groups/{ids['groupe']}", headers=_h(ids["moderateur"]))
    tc.delete(f"/api/admin/users/{ids['alice']}", headers=_h(ids["moderateur"]))
    assert any(g["id"] == ids["groupe"] for g in list_groups())
    assert get_user_by_id(ids["alice"])
