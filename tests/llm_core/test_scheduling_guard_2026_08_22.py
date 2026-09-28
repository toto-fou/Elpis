# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_scheduling_guard_2026_08_22.py — audit du harnais
2026-08-22, lot D (D1/D2).

Le garde d'ordonnancement décide de qui parle au llama-server. Deux défauts :

  D1  il était pris pour TOUTES les cibles — une mission de six heures sur un
      connecteur distant tenait l'exclusivité du modèle LOCAL sans jamais
      envoyer un octet au moteur local, et bloquait tout le monde ;
  D2  l'attente derrière un modèle occupé était muette et sans issue : ni
      compte rendu, ni possibilité d'abandonner.

Ces tests remplacent les deux verrous par des doublures : ce qu'on vérifie
ici, c'est la MÉCANIQUE du garde (qui il prend, ce qu'il annonce, ce qu'il
fait sur un Stop), pas l'arbitrage des verrous eux-mêmes.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from llm_core._scheduling import _guard


def _FakeTarget(local: bool):
    """Cible réelle (2026-09-16) : le garde dérive désormais le SERVEUR de la
    cible (``llm_core.engines``), plus seulement ``is_local_llamacpp``.
    ``local=False`` = fournisseur cloud, qui ne prend aucun verrou."""
    from llm_core._target import LlmTarget
    if local:
        return LlmTarget()
    return LlmTarget(wire="anthropic", provider_type="anthropic",
                     base_url="https://api.anthropic.com", api_key="k",
                     connector_id=9, is_default=False)


class _SpyLock:
    """Doublure de verrou : note ses prises et peut faire attendre."""

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.acquisitions = 0
        self.releases = 0
        self.cancelled_while_waiting = False

    @asynccontextmanager
    async def acquire_for(self, model, priority="high"):
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            # C'est ici que les vraies implémentations décrémentent leur
            # inscription « high en attente » : le test vérifie qu'on leur
            # laisse la main pour le faire.
            self.cancelled_while_waiting = True
            raise
        self.acquisitions += 1
        try:
            yield
        finally:
            self.releases += 1


def _install(monkeypatch, excl, sem, mode="classic"):
    monkeypatch.setattr(_guard, "MODEL_EXCLUSIVITY", excl)
    monkeypatch.setattr(_guard, "LLM_SEMAPHORE", sem)
    monkeypatch.setattr(_guard, "resolve_scheduling_mode", lambda: mode)
    monkeypatch.setattr(_guard._breaker, "allow", lambda m: None)
    # ``since_generation`` (audit 2026-08-23) : le garde le passe pour ne pas
    # effacer un échec enregistré PENDANT le corps qu'il enveloppe.
    monkeypatch.setattr(_guard._breaker, "record_success",
                        lambda m, since_generation=None: None)
    monkeypatch.setattr(_guard._breaker, "record_failure", lambda m: None)
    monkeypatch.setattr(_guard._breaker, "generation", lambda m: 0)


# ─────────────────────────────────────────────────────────────────────────────
#  D1 — une cible distante ne consomme pas l'ordonnanceur local
# ─────────────────────────────────────────────────────────────────────────────
async def test_cible_distante_ne_prend_aucun_verrou_local(monkeypatch):
    excl, sem = _SpyLock(), _SpyLock()
    _install(monkeypatch, excl, sem)

    async with _guard.llm_scheduling_guard("claude-opus", use_mcp_path=True,
                                           target=_FakeTarget(local=False)):
        pass

    assert excl.acquisitions == 0, (
        "un run sur connecteur distant tient l'exclusivité du modèle LOCAL")
    assert sem.acquisitions == 0


async def test_cible_locale_prend_bien_les_deux_niveaux(monkeypatch):
    excl, sem = _SpyLock(), _SpyLock()
    _install(monkeypatch, excl, sem)

    async with _guard.llm_scheduling_guard("qwen", use_mcp_path=False,
                                           target=_FakeTarget(local=True)):
        pass

    assert (excl.acquisitions, sem.acquisitions) == (1, 1)
    assert (excl.releases, sem.releases) == (1, 1)


async def test_cible_absente_garde_le_comportement_historique(monkeypatch):
    """Les appelants qui ne passent pas de cible (routines, rejeux) ne
    doivent RIEN voir changer."""
    excl, sem = _SpyLock(), _SpyLock()
    _install(monkeypatch, excl, sem)

    async with _guard.llm_scheduling_guard("qwen", use_mcp_path=False):
        pass

    assert (excl.acquisitions, sem.acquisitions) == (1, 1)


async def test_mode_optimise_ne_prend_pas_le_semaphore(monkeypatch):
    excl, sem = _SpyLock(), _SpyLock()
    _install(monkeypatch, excl, sem, mode="optimized")

    async with _guard.llm_scheduling_guard("qwen", use_mcp_path=True,
                                           target=_FakeTarget(local=True)):
        pass

    assert excl.acquisitions == 1
    assert sem.acquisitions == 0, "le mode optimisé gère son sémaphore lui-même"


# ─────────────────────────────────────────────────────────────────────────────
#  D2 — l'attente se voit et s'abandonne
# ─────────────────────────────────────────────────────────────────────────────
async def test_lattente_est_rapportee(monkeypatch):
    excl, sem = _SpyLock(delay=0.6), _SpyLock()
    _install(monkeypatch, excl, sem)
    monkeypatch.setattr(_guard, "WAIT_REPORT_FIRST_S", 0.1)
    monkeypatch.setattr(_guard, "WAIT_REPORT_PERIOD_S", 0.1)

    vus = []

    async def _on_wait(waited):
        vus.append(waited)

    async with _guard.llm_scheduling_guard("qwen", use_mcp_path=False,
                                           target=_FakeTarget(local=True),
                                           on_wait=_on_wait):
        pass

    assert vus, ("l'utilisateur n'a reçu AUCUN signe pendant l'attente d'un "
                 "modèle occupé")
    assert vus == sorted(vus), "le temps d'attente annoncé doit croître"


async def test_pas_de_bruit_quand_le_verrou_est_libre(monkeypatch):
    """Le cas nominal — modèle libre — ne doit produire aucun message."""
    excl, sem = _SpyLock(), _SpyLock()
    _install(monkeypatch, excl, sem)
    monkeypatch.setattr(_guard, "WAIT_REPORT_FIRST_S", 0.1)

    vus = []

    async def _on_wait(waited):
        vus.append(waited)

    async with _guard.llm_scheduling_guard("qwen", use_mcp_path=False,
                                           target=_FakeTarget(local=True),
                                           on_wait=_on_wait):
        pass

    assert vus == []


async def test_stop_pendant_lattente_libere_proprement(monkeypatch):
    excl, sem = _SpyLock(delay=5.0), _SpyLock()
    _install(monkeypatch, excl, sem)

    stop = {"demande": False}

    async def _run():
        async with _guard.llm_scheduling_guard(
                "qwen", use_mcp_path=False, target=_FakeTarget(local=True),
                cancel_probe=lambda: stop["demande"]):
            pass

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.3)
    assert not task.done(), "le garde n'a pas attendu le verrou"
    stop["demande"] = True

    with pytest.raises(_guard.LLMQueueAborted):
        await asyncio.wait_for(task, timeout=5)

    assert excl.cancelled_while_waiting, (
        "l'acquisition n'a pas été déroulée : le compteur « high en attente » "
        "resterait en l'air et gèlerait les acquisitions de fond")
    assert excl.acquisitions == 0


async def test_le_verrou_est_relache_meme_si_le_corps_leve(monkeypatch):
    excl, sem = _SpyLock(), _SpyLock()
    _install(monkeypatch, excl, sem)

    class _Boom(Exception):
        pass

    with pytest.raises(_Boom):
        async with _guard.llm_scheduling_guard("qwen", use_mcp_path=False,
                                               target=_FakeTarget(local=True)):
            raise _Boom()

    assert (excl.releases, sem.releases) == (1, 1), (
        "une erreur de génération laisse le modèle verrouillé")


async def test_une_annulation_traverse_le_garde(monkeypatch):
    """Un Stop PENDANT la génération (et non pendant l'attente) doit rester
    une annulation ordinaire, pas être transformé en abandon de file."""
    excl, sem = _SpyLock(), _SpyLock()
    _install(monkeypatch, excl, sem)

    async def _run():
        async with _guard.llm_scheduling_guard("qwen", use_mcp_path=False,
                                               target=_FakeTarget(local=True)):
            await asyncio.sleep(10)

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (excl.releases, sem.releases) == (1, 1)
