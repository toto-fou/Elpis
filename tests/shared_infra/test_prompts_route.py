# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_prompts_route.py — API /api/prompts (E2E sur le routeur
partagé + vraie DB temp).

Le CONTRAT de charge utile compte autant que le statut : depuis la refonte de
l'onglet Réglages → Prompts (2026-08-16), la page affiche la date de sauvegarde,
trie dessus et cherche dans le contenu. Un ``SELECT`` resserré sur (id, title,
content) ferait disparaître la date de l'interface sans casser une seule route —
d'où ces tests.

Auth simulée en patchant ``require_user_id`` (pattern test_usage_route.py).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice") == 1
    assert create_user("bob", "pw-bob") == 2

    import shared_infra.chat.routes_prompts as prompts_mod

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(prompts_mod, "require_user_id", _fake_uid)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


ALICE = {"x-test-user": "1"}
BOB = {"x-test-user": "2"}


def _post(tc, titre, contenu, headers=ALICE):
    r = tc.post("/api/prompts", json={"title": titre, "content": contenu}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_auth_requise(client):
    assert client.get("/api/prompts").status_code == 401


def test_la_liste_porte_la_date_de_sauvegarde(client):
    """Sans ``created_at``, la colonne date et le tri de la page n'ont plus rien
    à afficher."""
    _post(client, "Analyse de logs", "Cherche les erreurs récurrentes.")
    item = client.get("/api/prompts", headers=ALICE).json()["items"][0]
    assert set(item) >= {"id", "title", "content", "created_at"}
    assert isinstance(item["created_at"], (int, float)) and item["created_at"] > 0


def test_le_contenu_integral_est_servi(client):
    """La page déplie le prompt en entier : pas de troncature côté serveur.

    (L'enregistrement ``strip()`` les bords — comportement voulu de la route —
    mais rien entre les deux.)"""
    long_texte = "Ligne %d.\n" * 40 % tuple(range(40))
    _post(client, "Long", long_texte)
    item = client.get("/api/prompts", headers=ALICE).json()["items"][0]
    assert item["content"] == long_texte.strip()
    assert item["content"].count("\n") == 39


def test_ordre_par_date_decroissante(client):
    for titre in ("premier", "deuxième", "troisième"):
        _post(client, titre, "corps de " + titre)
    titres = [i["title"] for i in client.get("/api/prompts", headers=ALICE).json()["items"]]
    assert titres == ["troisième", "deuxième", "premier"]


def test_titre_deduit_du_contenu_si_absent(client):
    r = client.post("/api/prompts", json={"content": "x" * 60}, headers=ALICE)
    assert r.status_code == 200
    item = client.get("/api/prompts", headers=ALICE).json()["items"][0]
    assert item["title"] == "x" * 30 + "..."


def test_contenu_vide_refuse(client):
    assert client.post("/api/prompts", json={"content": "   "}, headers=ALICE).status_code == 400


def test_liste_et_suppression_scopees_a_l_utilisateur(client):
    pid_alice = _post(client, "à alice", "privé", ALICE)
    _post(client, "à bob", "privé", BOB)

    assert [i["title"] for i in client.get("/api/prompts", headers=ALICE).json()["items"]] == ["à alice"]
    assert [i["title"] for i in client.get("/api/prompts", headers=BOB).json()["items"]] == ["à bob"]

    # Bob ne peut pas supprimer le prompt d'Alice.
    client.delete(f"/api/prompts/{pid_alice}", headers=BOB)
    assert [i["title"] for i in client.get("/api/prompts", headers=ALICE).json()["items"]] == ["à alice"]

    client.delete(f"/api/prompts/{pid_alice}", headers=ALICE)
    assert client.get("/api/prompts", headers=ALICE).json()["items"] == []
