# SPDX-License-Identifier: MIT
"""
tests/chatbot/test_reasoning_end_route_2026_08_22.py — bouton « Répondre
maintenant », voie NATIVE.

Le geste coupe le raisonnement pour passer à la réponse. Historiquement il
ANNULAIT la génération et relançait le tour avec le raisonnement en préfixe :
tout le prompt était ré-évalué — des dizaines de secondes sur un contexte long
(26 s mesurées pour 5 600 tokens) — pour obtenir une réponse que le modèle
était sur le point d'écrire.

llama-server sait le faire nativement depuis b10545 (vérifié en live :
``{"success":true}``, le raisonnement s'arrête, la réponse suit dans le MÊME
flux). Cette route est le relais.

Ce qui est verrouillé ici :
  - l'AUTORISATION est faite par la route (le magasin, lui, est indexé par
    conversation seule : le harnais ne connaît que le nom d'utilisateur, la
    route que l'identifiant numérique — les faire correspondre dans le
    magasin serait une source d'erreur silencieuse) ;
  - un refus du moteur est rendu comme un refus EXPLOITABLE (``ok: false``),
    pas comme une erreur : c'est ce qui permet au client de retomber sur son
    geste historique au lieu de rester coincé.
"""
from __future__ import annotations

import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from tests._routes_chat import monter_routes_chat


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw") == 1
    assert create_user("bob", "pw") == 2
    from shared_infra.chat.store import upsert_chat
    upsert_chat(1, "c-alice", "T", [{"role": "user", "content": "x"}], 10.0)

    from shared_infra.llm import reasoning_control as rc
    monkeypatch.setattr(rc, "DIR", str(tmp_path / "rctl"))

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    return TestClient(monter_routes_chat(monkeypatch, _fake_uid))


_H = {"x-test-user": "1"}
_URL = "/api/chat/reasoning-end"


def test_sans_chat_id_rien_ne_part(client):
    assert client.post(_URL, json={}, headers=_H).json() == {"ok": False,
                                                             "reason": "no_chat"}


def test_un_chat_qui_nest_pas_le_sien_est_refuse(client):
    """Le magasin est indexé par CONVERSATION : c'est ici, et seulement ici,
    que l'appartenance est vérifiée."""
    r = client.post(_URL, json={"chat_id": "c-alice"},
                    headers={"x-test-user": "2"})
    assert r.status_code == 404


def test_sans_raisonnement_en_cours_le_client_peut_se_replier(client):
    """``ok: false`` et non une erreur : le bouton doit pouvoir retomber sur
    son geste historique."""
    r = client.post(_URL, json={"chat_id": "c-alice"}, headers=_H)
    assert r.status_code == 200
    assert r.json() == {"ok": False, "reason": "no_active_completion"}


def test_la_demande_part_au_moteur_avec_le_bon_identifiant(client, monkeypatch):
    from shared_infra.llm import reasoning_control as rc
    rc.note_completion("c-alice", "cmpl-77", "mon-modele")

    vus = {}

    async def _fake_end(client_, base, completion_id, model=""):
        vus["id"], vus["model"], vus["base"] = completion_id, model, base
        return True

    import llm_core.providers.llama_stream as ls
    monkeypatch.setattr(ls, "end_reasoning", _fake_end)

    r = client.post(_URL, json={"chat_id": "c-alice"}, headers=_H)
    assert r.json() == {"ok": True, "reason": ""}
    assert vus["id"] == "cmpl-77" and vus["model"] == "mon-modele"
    assert not vus["base"].endswith("/v1"), (
        "la racine du serveur doit être dérivée de LLAMA_URL, pas son "
        "chemin de complétion")


def test_un_refus_du_moteur_reste_exploitable(client, monkeypatch):
    from shared_infra.llm import reasoning_control as rc
    rc.note_completion("c-alice", "cmpl-77", "m")

    async def _fake_end(*a, **k):
        return False

    import llm_core.providers.llama_stream as ls
    monkeypatch.setattr(ls, "end_reasoning", _fake_end)
    assert client.post(_URL, json={"chat_id": "c-alice"},
                       headers=_H).json() == {"ok": False,
                                              "reason": "engine_refused"}


def test_le_reglage_coupe_la_voie_native(client, monkeypatch):
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "LLAMA_REASONING_CONTROL", False)
    assert client.post(_URL, json={"chat_id": "c-alice"},
                       headers=_H).json()["reason"] == "disabled"


# ─────────────────────────────────────────────────────────────────────────────
#  Magasin partagé
# ─────────────────────────────────────────────────────────────────────────────
def test_le_magasin_survit_dun_worker_a_lautre(tmp_path, monkeypatch):
    """C'est tout l'intérêt : le clic peut atterrir sur un worker qui n'a
    jamais vu la génération."""
    from shared_infra.llm import reasoning_control as rc
    monkeypatch.setattr(rc, "DIR", str(tmp_path / "rctl"))
    rc.note_completion("c1", "cmpl-1", "m")
    assert rc.get_completion("c1")["completion_id"] == "cmpl-1"
    assert rc.get_completion("c2") is None
    rc.clear_completion("c1")
    assert rc.get_completion("c1") is None


def test_une_entree_perimee_est_ignoree(tmp_path, monkeypatch):
    """Une complétion terminée n'est plus contrôlable : agir sur elle
    donnerait un faux positif à l'utilisateur."""
    from shared_infra.llm import reasoning_control as rc
    monkeypatch.setattr(rc, "DIR", str(tmp_path / "rctl"))
    monkeypatch.setattr(rc, "ENTRY_TTL_S", 0.0)
    rc.note_completion("c1", "cmpl-1", "m")
    time.sleep(0.01)
    assert rc.get_completion("c1") is None


def test_le_nom_de_fichier_ne_revele_pas_la_conversation(tmp_path, monkeypatch):
    """``/tmp`` est partagé par tous les comptes de la machine."""
    from shared_infra.llm import reasoning_control as rc
    monkeypatch.setattr(rc, "DIR", str(tmp_path / "rctl"))
    rc.note_completion("mon-chat-secret", "cmpl-1", "m")
    noms = [p.name for p in (tmp_path / "rctl").iterdir()]
    assert noms and all("mon-chat-secret" not in n for n in noms)
