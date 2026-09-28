# SPDX-License-Identifier: MIT
"""tests/llm_core/test_slots_idle_moteur_muet_2026_08_23.py — ne plus attendre
un moteur qui ne répond pas.

Constaté en production le 2026-08-22 :
``POST /api/llm/models/unload → 200 (334396 ms)``. Soit 300 s passées dans
``wait_for_slots_idle`` à sonder un llama-server muet, puis le déchargement.
Pendant ce temps le client, lui, abandonne son sondage à 120 s et affiche
« Timeout — vérifiez le serveur » : la roue du sélecteur tourne dans le vide et
l'interface ment pendant plus de trois minutes.

Attendre l'inactivité d'un moteur INJOIGNABLE n'a aucun sens : il ne traite
rien, et rien ne viendra le confirmer. On renonce donc au bout de quelques
sondes muettes — l'appelant force alors l'opération, ce qui est le bon choix.

Ce que ces tests verrouillent :

  1. moteur muet ⇒ renoncement RAPIDE (pas ``max_wait_sec``) ;
  2. le renoncement rend ``False`` — l'appelant sait qu'il force ;
  3. moteur qui répond « inactif » ⇒ ``True`` immédiat, inchangé ;
  4. ⚠ un ROUTEUR répond ``{"status":"ok"}`` sans ``slots_processing`` : le
     défaut vaut « inactif », et c'est délibéré ;
  5. moteur occupé PUIS inactif ⇒ on attend vraiment (le compteur de sondes
     muettes ne doit pas déclencher sur un moteur qui répond) ;
  6. un moteur muet PUIS de nouveau joignable remet le compteur à zéro.
"""
from __future__ import annotations

import time

import pytest

import llm_core._model_lifecycle as ml


@pytest.fixture(autouse=True)
def sondes_rapides(monkeypatch):
    """Aucune attente réelle : on ne teste que la logique de décision."""
    async def _sleep(_s):
        return None

    monkeypatch.setattr(ml.asyncio, "sleep", _sleep, raising=True)


def _brancher(monkeypatch, reponses_health, metrics=None):
    """``reponses_health`` : liste consommée à chaque sonde (``None`` = muet)."""
    seq = list(reponses_health)
    appels = {"health": 0, "metrics": 0}

    async def _get(path, timeout=None):
        appels["health"] += 1
        return seq.pop(0) if seq else None

    async def _get_text(path, timeout=None):
        appels["metrics"] += 1
        return metrics

    monkeypatch.setattr(ml, "_llama_get", _get, raising=True)
    monkeypatch.setattr(ml, "_llama_get_text", _get_text, raising=True)
    return appels


# ─────────────────────────────────────────────────────────────────────────────
#  1-2 — moteur muet : renoncement rapide
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_moteur_muet_on_renonce_vite(monkeypatch):
    appels = _brancher(monkeypatch, [None] * 50)
    t0 = time.monotonic()
    res = await ml.wait_for_slots_idle(max_wait_sec=300.0, poll_interval=2.0)
    assert res is False
    assert appels["health"] == ml.SLOTS_PROBE_MAX_UNREACHABLE, (
        f"{appels['health']} sondes au lieu de {ml.SLOTS_PROBE_MAX_UNREACHABLE} "
        f"— on épuiserait de nouveau les 300 s")
    assert (time.monotonic() - t0) < 5


# ─────────────────────────────────────────────────────────────────────────────
#  3-4 — moteur qui répond
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_moteur_inactif_repond_tout_de_suite(monkeypatch):
    appels = _brancher(monkeypatch, [{"slots_processing": 0}])
    assert await ml.wait_for_slots_idle() is True
    assert appels["health"] == 1


@pytest.mark.asyncio
async def test_routeur_sans_champ_de_slots_vaut_inactif(monkeypatch):
    """⚠ Propriété DÉLIBÉRÉE : un llama-server en mode routeur répond
    ``{"status":"ok"}`` sans ``slots_processing`` — il n'expose pas ses slots
    sans nom de modèle. Le défaut à 0 vaut « inactif » ; l'exclusivité de
    modèle protège déjà les flux en cours."""
    _brancher(monkeypatch, [{"status": "ok"}])
    assert await ml.wait_for_slots_idle() is True


# ─────────────────────────────────────────────────────────────────────────────
#  5-6 — le compteur ne se déclenche que sur du SILENCE
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_moteur_occupe_puis_inactif_on_attend_vraiment(monkeypatch):
    appels = _brancher(monkeypatch, [
        {"slots_processing": 2}, {"slots_processing": 1},
        {"slots_processing": 1}, {"slots_processing": 0},
    ])
    assert await ml.wait_for_slots_idle() is True
    assert appels["health"] == 4, (
        "un moteur qui RÉPOND « occupé » ne doit jamais compter comme muet")


@pytest.mark.asyncio
async def test_un_silence_passager_ne_fait_pas_renoncer(monkeypatch):
    """Deux sondes muettes puis une réponse : le compteur repart de zéro.
    Sans ça, un hoquet réseau ferait forcer un déchargement en pleine
    génération."""
    appels = _brancher(monkeypatch, [
        None, None, {"slots_processing": 1}, None, None, {"slots_processing": 0},
    ])
    assert await ml.wait_for_slots_idle() is True
    assert appels["health"] == 6


@pytest.mark.asyncio
async def test_le_repli_metrics_compte_comme_joignable(monkeypatch):
    """``/health`` muet mais ``/metrics`` qui répond : le moteur est bien là,
    on ne renonce pas."""
    _brancher(monkeypatch, [None] * 50,
              metrics="llamacpp:requests_processing 0\n")
    assert await ml.wait_for_slots_idle() is True
