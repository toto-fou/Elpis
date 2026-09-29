# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_model_load_progress_route_2026_08_22.py — la route
qui remplace la roue par un pourcentage.

Le sélecteur de modèles affichait ``ph-spinner-gap animate-spin`` pendant tout
un chargement : une roue tourne aussi bien pour trois secondes que pour trois
minutes, et ne dit ni où on en est, ni si quelque chose avance encore. Le
moteur connaît le pourcentage exact et l'émet toutes les 200 ms
(``/models/sse``) ; ``GET /api/llm/models/load-progress`` le relaie au client.

Ce que ces tests verrouillent :

  1. le flux relaie la progression puis se clôt sur ``done`` ;
  2. ⚠ contrat de RÉTROCOMPATIBILITÉ : un moteur trop ancien reçoit un
     ``{"supported": false}`` explicite et le flux se ferme — le client garde
     sa roue au lieu d'attendre des événements qui ne viendront jamais ;
  3. ``model_id`` est obligatoire (400) ;
  4. la route est AUTHENTIFIÉE ;
  5. le flux est décoratif : la fin du chargement reste établie par le
     sondage de statut du client, donc un suivi qui échoue n'empêche rien.

Aucun réseau : ``watch_load`` est simulé.
"""
from __future__ import annotations

import json

import pytest

from llm_core.providers import llama_caps as lc


def _evenements(corps: str):
    """Lignes ``data:`` d'un flux SSE → liste d'objets."""
    return [json.loads(l[5:].strip())
            for l in corps.splitlines() if l.startswith("data:")]


@pytest.fixture()
def client(monkeypatch):
    """Application FastAPI minimale portant la seule route testée."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import shared_infra.llm.routes as rl

    monkeypatch.setattr(rl, "require_user_id", lambda request: 1, raising=True)
    app = FastAPI()
    app.include_router(rl.router)
    return TestClient(app)


def _moteur(monkeypatch, *, recent=True):
    async def _caps(base_url="", force=False):
        return lc.EngineCaps(known=True,
                             build=lc.MIN_BUILD_MODELS_SSE if recent else 9000,
                             is_router=True)

    monkeypatch.setattr(lc, "engine_caps", _caps, raising=True)


# ─────────────────────────────────────────────────────────────────────────────
#  1 — la progression est relayée
# ─────────────────────────────────────────────────────────────────────────────
def test_la_progression_est_relayee_puis_le_flux_se_clot(client, monkeypatch):
    _moteur(monkeypatch)
    from llm_core.providers import llama_models as lm

    async def _faux_suivi(model, base_url="", on_progress=None, *, timeout_s=0):
        for pct in (0.0, 40.0, 100.0):
            await on_progress("text_model", pct, ["text_model"])
        return True

    monkeypatch.setattr(lm, "watch_load", _faux_suivi, raising=True)

    r = client.get("/api/llm/models/load-progress?model_id=m1")
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]

    evts = _evenements(r.text)
    assert [e.get("pct") for e in evts if "pct" in e] == [0.0, 40.0, 100.0]
    assert evts[0]["stage"] == "text_model"
    assert evts[-1] == {"done": True, "loaded": True}


def test_une_etape_sans_pourcentage_passe_quand_meme(client, monkeypatch):
    """⚠ Le moteur émet des messages d'étape SANS ``value`` : les jeter
    priverait le client du nom de l'étape en cours."""
    _moteur(monkeypatch)
    from llm_core.providers import llama_models as lm

    async def _faux_suivi(model, base_url="", on_progress=None, *, timeout_s=0):
        await on_progress("mmproj_model", None, ["text_model", "mmproj_model"])
        return True

    monkeypatch.setattr(lm, "watch_load", _faux_suivi, raising=True)
    evts = _evenements(client.get("/api/llm/models/load-progress?model_id=m1").text)
    assert evts[0]["pct"] is None
    assert evts[0]["stage"] == "mmproj_model"
    assert evts[0]["stages"] == ["text_model", "mmproj_model"]


# ─────────────────────────────────────────────────────────────────────────────
#  2 — rétrocompatibilité : le refus est EXPLICITE
# ─────────────────────────────────────────────────────────────────────────────
def test_moteur_ancien_le_client_est_prevenu_et_garde_sa_roue(client,
                                                              monkeypatch):
    _moteur(monkeypatch, recent=False)
    from llm_core.providers import llama_models as lm

    async def _jamais(*a, **k):
        raise AssertionError("aucun suivi ne doit être ouvert")

    monkeypatch.setattr(lm, "watch_load", _jamais, raising=True)

    r = client.get("/api/llm/models/load-progress?model_id=m1")
    assert r.status_code == 200
    assert _evenements(r.text) == [{"supported": False}], (
        "sans ce refus explicite, le client attendrait un flux muet jusqu'à "
        "son délai — la roue ne repartirait jamais")


def test_un_suivi_impossible_ne_casse_rien(client, monkeypatch):
    """Le flux est DÉCORATIF : ``watch_load`` qui rend ``None`` (moteur hors
    routeur, délai dépassé) doit se solder par une fin propre, pas par une
    erreur — le sondage de statut du client fait foi."""
    _moteur(monkeypatch)
    from llm_core.providers import llama_models as lm

    async def _rien(model, base_url="", on_progress=None, *, timeout_s=0):
        return None

    monkeypatch.setattr(lm, "watch_load", _rien, raising=True)
    evts = _evenements(client.get("/api/llm/models/load-progress?model_id=m1").text)
    assert evts == [{"done": True, "loaded": None}]


# ─────────────────────────────────────────────────────────────────────────────
#  3-4 — garde-fous
# ─────────────────────────────────────────────────────────────────────────────
def test_model_id_obligatoire(client, monkeypatch):
    _moteur(monkeypatch)
    assert client.get("/api/llm/models/load-progress").status_code == 400
    assert client.get("/api/llm/models/load-progress?model_id=  ").status_code == 400


def test_la_route_est_authentifiee(monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    import shared_infra.llm.routes as rl

    def _refus(request):
        raise HTTPException(status_code=401, detail="non connecté")

    monkeypatch.setattr(rl, "require_user_id", _refus, raising=True)
    app = FastAPI()
    app.include_router(rl.router)
    r = TestClient(app).get("/api/llm/models/load-progress?model_id=m1")
    assert r.status_code == 401
