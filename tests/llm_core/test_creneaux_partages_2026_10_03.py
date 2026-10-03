# SPDX-License-Identifier: MIT
"""Créneaux du llama-server communs à tous les process (lot 3, 2026-10-03).

Avant : chaque worker gardait ``max(1, slots // workers)`` — sept workers sur
quatre créneaux lançaient sept générations, trois workers en laissaient un
inutilisé. Désormais un créneau = un fichier verrouillé partagé par tous les
process (``llm_core/_scheduling/_shared_slots.py``).
"""
from __future__ import annotations

import asyncio
import multiprocessing
import os
import time

import pytest

from llm_core._scheduling import _shared_slots as S


@pytest.fixture(autouse=True)
def _dossier_propre(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "SLOT_DIR", tmp_path / "llm_slots")
    monkeypatch.setattr(S, "_checked", (None, False, 0.0))
    monkeypatch.setattr(S, "_noted", {})
    monkeypatch.setattr(S, "POLL_S", 0.02)


def _enfant(slot_dir, cap, n, actifs, pic, verrou):
    from llm_core._scheduling import _shared_slots as S
    S.SLOT_DIR = slot_dir
    S.POLL_S = 0.02

    async def une():
        slot = await S.acquire("builtin", "", cap)
        with verrou:
            actifs.value += 1
            pic.value = max(pic.value, actifs.value)
        await asyncio.sleep(0.15)
        with verrou:
            actifs.value -= 1
        slot.release()

    async def tout():
        await asyncio.gather(*(une() for _ in range(n)))

    asyncio.run(tout())


def test_le_plafond_tient_entre_plusieurs_process():
    """Trois process × trois générations sur deux créneaux : jamais plus de
    deux à la fois, et toutes finissent."""
    ctx = multiprocessing.get_context("spawn")
    actifs, pic, verrou = ctx.Value("i", 0), ctx.Value("i", 0), ctx.Lock()
    procs = [ctx.Process(target=_enfant, args=(S.SLOT_DIR, 2, 3, actifs, pic, verrou))
             for _ in range(3)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(60)
    assert [p.exitcode for p in procs] == [0, 0, 0]
    assert pic.value == 2
    assert actifs.value == 0


@pytest.mark.asyncio
async def test_un_process_prend_tous_les_creneaux_libres():
    """Le repli arithmétique donnait 1 créneau sur 4 à chacun de 3 workers ;
    un worker seul doit pouvoir prendre les quatre."""
    slots = [await S.acquire("builtin", "", 4) for _ in range(4)]
    assert all(s is not None for s in slots)
    assert S.busy("builtin", "", 4) == 4
    attente = asyncio.ensure_future(S.acquire("builtin", "", 4))
    await asyncio.sleep(0.1)
    assert not attente.done()                       # le cinquième attend
    slots[0].release()
    cinquieme = await asyncio.wait_for(attente, 2)
    for s in slots[1:] + [cinquieme]:
        s.release()
    assert S.busy("builtin", "", 4) == 0


@pytest.mark.asyncio
async def test_high_passe_avant_low_dans_un_process():
    tenu = await S.acquire("builtin", "", 1)
    ordre = []

    async def attendre(prio):
        slot = await S.acquire("builtin", "", 1, priority=prio)
        ordre.append(prio)
        slot.release()

    low = asyncio.ensure_future(attendre("low"))
    await asyncio.sleep(0.05)
    high = asyncio.ensure_future(attendre("high"))    # arrivé APRÈS le low
    await asyncio.sleep(0.05)
    tenu.release()
    await asyncio.wait_for(asyncio.gather(low, high), 3)
    assert ordre == ["high", "low"]


@pytest.mark.asyncio
async def test_low_jamais_affame_par_des_high_en_continu():
    """Des chats arrivent sans cesse dans le même process : passé le plafond
    d'attente, la tâche de fond prend rang à son heure d'arrivée."""
    fini = False

    async def chats():
        while not fini:
            slot = await S.acquire("builtin", "", 1, priority="high")
            await asyncio.sleep(0.03)
            slot.release()

    flot = [asyncio.ensure_future(chats()) for _ in range(2)]
    await asyncio.sleep(0.05)
    t0 = time.monotonic()
    try:
        slot = await asyncio.wait_for(
            S.acquire("builtin", "", 1, priority="low", low_cap_s=0.3), 3)
        assert time.monotonic() - t0 >= 0.3
        slot.release()
    finally:
        fini = True
        await asyncio.gather(*flot)


@pytest.mark.asyncio
async def test_low_cede_a_un_high_qui_attend_ailleurs():
    """Un ``high`` qui attend dans un AUTRE process tient ``<clé>.high`` en
    partagé : un ``low`` ne prend pas le créneau libre, sauf au-delà du
    plafond d'attente."""
    S.available()
    drapeau = S._flag_high(S.SLOT_DIR / f"{S._key('builtin', '')}.high")
    assert drapeau is not None
    try:
        low = asyncio.ensure_future(S.acquire("builtin", "", 1, priority="low", low_cap_s=5))
        await asyncio.sleep(0.2)
        assert not low.done()
    finally:
        os.close(drapeau)
    slot = await asyncio.wait_for(low, 2)
    slot.release()

    drapeau = S._flag_high(S.SLOT_DIR / f"{S._key('builtin', '')}.high")
    try:
        t0 = time.monotonic()
        slot = await asyncio.wait_for(
            S.acquire("builtin", "", 1, priority="low", low_cap_s=0.2), 2)
        assert time.monotonic() - t0 >= 0.2         # plafond : passe quand même
        slot.release()
    finally:
        os.close(drapeau)


@pytest.mark.asyncio
async def test_annulation_pendant_l_attente_ne_garde_rien():
    tenu = await S.acquire("builtin", "", 1)
    attente = asyncio.ensure_future(S.acquire("builtin", "", 1, priority="high"))
    await asyncio.sleep(0.1)
    attente.cancel()
    with pytest.raises(asyncio.CancelledError):
        await attente
    assert S._queues == {}
    tenu.release()
    slot = await asyncio.wait_for(S.acquire("builtin", "", 1), 1)
    slot.release()


@pytest.mark.asyncio
async def test_cles_independantes_par_serveur_et_modele():
    a = await S.acquire("builtin", "m1", 1)
    b = await asyncio.wait_for(S.acquire("builtin", "m2", 1), 1)
    c = await asyncio.wait_for(S.acquire("conn:7", "m1", 1), 1)
    for s in (a, b, c):
        s.release()


@pytest.mark.asyncio
async def test_capacite_notee_borne_un_process_qui_ne_l_a_pas_lue():
    """Un process qui n'a pas pu lire ``/props`` (repli : 4) ne dépasse pas
    le ``-np`` noté par les autres (1)."""
    S.note_capacity("builtin", 1)
    tenu = await S.acquire("builtin", "", 4)
    attente = asyncio.ensure_future(S.acquire("builtin", "", 4))
    await asyncio.sleep(0.1)
    assert not attente.done()
    tenu.release()
    (await asyncio.wait_for(attente, 1)).release()


@pytest.mark.asyncio
async def test_dossier_d_un_autre_compte_repli(monkeypatch):
    vrai = os.geteuid()
    monkeypatch.setattr(S.os, "geteuid", lambda: vrai + 1)
    assert S.available() is False
    assert await S.acquire("builtin", "", 1) is None
    assert S.busy("builtin", "", 1) == 0


# ── Gestionnaire (deux workers simulés) ─────────────────────────────────────

@pytest.fixture()
def deux_workers(monkeypatch):
    import llm_core._model_info as _mi
    from llm_core._scheduling._concurrency import LLMConcurrencyManager

    monkeypatch.setattr(_mi, "_cached_total_slots", 2)
    monkeypatch.setenv("APP_WORKERS_EFFECTIVE", "2")
    return (LLMConcurrencyManager(max_models=1, max_conversations_per_model=2),
            LLMConcurrencyManager(max_models=1, max_conversations_per_model=2))


async def _tenir(mgr, model, actifs, liberer):
    async with mgr.acquire_for(model):
        actifs.append(1)
        await liberer.wait()


@pytest.mark.asyncio
async def test_un_worker_seul_prend_les_deux_creneaux_et_l_autre_attend(deux_workers):
    w1, w2 = deux_workers
    actifs, liberer = [], asyncio.Event()
    tenus = [asyncio.ensure_future(_tenir(w1, "m", actifs, liberer)) for _ in range(2)]
    await asyncio.sleep(0.1)
    assert len(actifs) == 2                          # repli 2 // 2 : un seul
    assert w2.locked_for("m")                        # la file voit les autres process
    assert w2.get_stats()["active_models"] == []
    attente = asyncio.ensure_future(_tenir(w2, "m", actifs, liberer))
    await asyncio.sleep(0.1)
    assert len(actifs) == 2
    liberer.set()
    await asyncio.wait_for(asyncio.gather(*tenus, attente), 3)
    assert len(actifs) == 3
    assert w1._active == {} and w2._active == {}


@pytest.mark.asyncio
async def test_sans_modele_et_modele_nomme_partagent_le_serveur(deux_workers):
    """``model=None`` et un nom explicite visent le même llama-server
    mono-modèle : mêmes créneaux."""
    w1, w2 = deux_workers
    actifs, liberer = [], asyncio.Event()
    tenus = [asyncio.ensure_future(_tenir(w1, None, actifs, liberer)) for _ in range(2)]
    await asyncio.sleep(0.1)
    attente = asyncio.ensure_future(_tenir(w2, "qwen", actifs, liberer))
    await asyncio.sleep(0.1)
    assert len(actifs) == 2
    liberer.set()
    await asyncio.wait_for(asyncio.gather(*tenus, attente), 3)


@pytest.mark.asyncio
async def test_annulation_en_phase_3_rend_tout(deux_workers):
    w1, w2 = deux_workers
    actifs, liberer = [], asyncio.Event()
    tenus = [asyncio.ensure_future(_tenir(w1, "m", actifs, liberer)) for _ in range(2)]
    await asyncio.sleep(0.1)
    attente = asyncio.ensure_future(_tenir(w2, "m", actifs, liberer))
    await asyncio.sleep(0.1)
    attente.cancel()
    with pytest.raises(asyncio.CancelledError):
        await attente
    assert w2._active == {}                          # slot modèle et sémaphore rendus
    liberer.set()
    await asyncio.wait_for(asyncio.gather(*tenus), 3)


@pytest.mark.asyncio
async def test_annulation_quand_l_entree_aboutit_rend_le_verrou():
    """L'entrée réussit dans le même tour de boucle que l'annulation de
    l'appelant : la sortie doit quand même être appelée."""
    from llm_core._scheduling._guard import _reported_acquire

    class Verrou:
        entrees = sorties = 0

        async def __aenter__(self):
            Verrou.entrees += 1
            return self

        async def __aexit__(self, *exc):
            Verrou.sorties += 1
            return False

    async def appelant():
        async with _reported_acquire(Verrou(), model="m", on_wait=None, cancel_probe=None,
                                     first_delay=3, period=10):
            await asyncio.sleep(10)

    t = asyncio.ensure_future(appelant())
    await asyncio.sleep(0)                           # l'appelant attend l'entrée
    t.cancel()                                       # … qui aboutit au même tour
    with pytest.raises(asyncio.CancelledError):
        await t
    assert Verrou.entrees == 1
    assert Verrou.sorties == 1
