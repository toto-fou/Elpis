# SPDX-License-Identifier: MIT
"""
tests/chatbot/test_gen_presence_guard_2026_08_22.py — audit du harnais
2026-08-22, lot B (B1/B2/B3).

Trois propriétés de la route de flux, chacune correspondant à une panne
observable :

  B1  Une SEULE génération par conversation. Sans cette garde, une coupure
      réseau avant le premier outil suffisait à ce que le retry du client
      atterrisse sur un autre worker : deux runs, deux persistances, une
      perdue en conflit — et les outils déjà exécutés rejoués.
      Mais une PASSATION (éditer un message puis régénérer, qui envoie un
      Stop et re-POSTe aussitôt) doit continuer de passer.

  B1bis Un verrou réservé par le handler que ``gen()`` ne réclame jamais
      (client parti avant la première itération : le corps d'un générateur
      non démarré ne s'exécute pas) doit être relâché — sinon cette
      conversation répondrait 409 pour toujours.

  B3  La déconnexion détache le run dès qu'un outil a tourné : ce qui a écrit
      des fichiers ne se rejoue pas. Un tour de pur chat garde le contrat
      « fermer l'onglet arrête ».
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from chatbot_app.routes import chats as _chats
from shared_infra.routes import _state
from shared_infra.runtime import chat_locks


@pytest.fixture(autouse=True)
def _locks_isoles(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    _chats._pending_gen_locks.clear()
    _state._cancelled_chats.clear()
    yield
    _chats._pending_gen_locks.clear()
    _state._cancelled_chats.clear()


# ─────────────────────────────────────────────────────────────────────────────
#  B1 — une seule génération par conversation
# ─────────────────────────────────────────────────────────────────────────────
async def test_le_premier_tour_obtient_le_verrou():
    fd = await _chats._acquire_gen_presence(1, "chatA")
    assert fd is not None
    chat_locks.release(fd)


async def test_un_second_tour_concurrent_est_refuse():
    fd = await _chats._acquire_gen_presence(1, "chatA")
    assert fd is not None
    with pytest.raises(HTTPException) as exc:
        await _chats._acquire_gen_presence(1, "chatA")
    assert exc.value.status_code == 409
    assert exc.value.detail == "generation_running"
    chat_locks.release(fd)


async def test_deux_conversations_du_meme_user_cohabitent():
    fd1 = await _chats._acquire_gen_presence(1, "chatA")
    fd2 = await _chats._acquire_gen_presence(1, "chatB")
    assert fd1 is not None and fd2 is not None
    chat_locks.release(fd1)
    chat_locks.release(fd2)


async def test_deux_utilisateurs_sur_le_meme_id_de_chat_cohabitent():
    """La clé est (utilisateur, chat) : l'activité d'Alice ne doit jamais
    refuser un tour à Bob."""
    fd1 = await _chats._acquire_gen_presence(1, "meme-id")
    fd2 = await _chats._acquire_gen_presence(2, "meme-id")
    assert fd1 is not None and fd2 is not None
    chat_locks.release(fd1)
    chat_locks.release(fd2)


async def test_une_passation_apres_stop_est_attendue_pas_refusee(monkeypatch):
    """Éditer un message puis régénérer : le Stop est parti, l'ancien run
    déroule encore son annulation. Refuser ce geste serait une régression."""
    monkeypatch.setattr(_chats, "_HANDOVER_WAIT_S", 3.0)
    ancien = await _chats._acquire_gen_presence(1, "chatA")
    assert ancien is not None
    _state.mark_chat_cancelled(1, "chatA")      # Stop demandé

    async def _lache_apres_un_instant():
        await asyncio.sleep(0.4)
        chat_locks.release(ancien)

    asyncio.create_task(_lache_apres_un_instant())
    nouveau = await _chats._acquire_gen_presence(1, "chatA")
    assert nouveau is not None, "la régénération après édition a été refusée"
    chat_locks.release(nouveau)


async def test_la_passation_a_une_borne(monkeypatch):
    """Un run qui ne rend jamais la main ne doit pas faire attendre
    indéfiniment : au-delà de la borne, un 409 honnête."""
    monkeypatch.setattr(_chats, "_HANDOVER_WAIT_S", 0.5)
    ancien = await _chats._acquire_gen_presence(1, "chatA")
    _state.mark_chat_cancelled(1, "chatA")
    with pytest.raises(HTTPException) as exc:
        await _chats._acquire_gen_presence(1, "chatA")
    assert exc.value.status_code == 409
    chat_locks.release(ancien)


async def test_sans_stop_demande_le_refus_est_immediat(monkeypatch):
    """Pas de Stop en cours ⇒ ce n'est pas une passation : on ne fait pas
    poireauter l'utilisateur douze secondes pour lui dire non."""
    monkeypatch.setattr(_chats, "_HANDOVER_WAIT_S", 10.0)
    fd = await _chats._acquire_gen_presence(1, "chatA")
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    with pytest.raises(HTTPException):
        await _chats._acquire_gen_presence(1, "chatA")
    assert loop.time() - t0 < 1.0
    chat_locks.release(fd)


async def test_retry_du_client_apres_micro_coupure_nest_pas_refuse(monkeypatch):
    """Le scénario que la garde 409 aurait pu casser : aucune exécution
    d'outil, le flux se coupe, le client rejoue le tour 1,5 s plus tard sur un
    AUTRE worker pendant que le run mourant tient encore le verrou.

    La route marque désormais le chat comme annulé au moment où elle annule :
    le rejeu est donc traité comme une passation (attente de l'unwind) au lieu
    d'un refus sec."""
    monkeypatch.setattr(_chats, "_HANDOVER_WAIT_S", 3.0)
    mourant = await _chats._acquire_gen_presence(1, "chatA")
    assert mourant is not None

    # Ce que fait le ``finally`` de la route quand elle annule.
    _state.mark_chat_cancelled(1, "chatA")

    async def _unwind():
        await asyncio.sleep(0.3)
        chat_locks.release(mourant)

    asyncio.create_task(_unwind())
    rejeu = await _chats._acquire_gen_presence(1, "chatA")
    assert rejeu is not None, "le rejeu automatique du client a été refusé"
    chat_locks.release(rejeu)


async def test_verrouillage_indisponible_ne_bloque_pas_lapp(monkeypatch):
    """Fail-open historique : si le spool est inutilisable, on continue sans
    garde cross-worker plutôt que de refuser toute génération."""
    monkeypatch.setattr(chat_locks, "acquire", lambda *a, **k: None)
    monkeypatch.setattr(chat_locks, "is_held", lambda *a, **k: False)
    # Le fail-open se décide sur l'état du dossier de verrous (B1, 2026-09-25).
    monkeypatch.setattr(chat_locks, "lock_dir_usable", lambda: False, raising=False)
    assert await _chats._acquire_gen_presence(1, "chatA") is None


async def test_acquire_refuse_sur_dossier_sain_vaut_verrou_tenu(monkeypatch):
    """B1 (2026-09-25) — ``acquire`` refusé alors que le dossier est sain :
    c'est un verrou TENU (409), jamais un fail-open, même si une sonde
    ``is_held`` rendrait « libre » (détenteur qui relâche entre les deux)."""
    monkeypatch.setattr(chat_locks, "acquire", lambda *a, **k: None)
    monkeypatch.setattr(chat_locks, "is_held", lambda *a, **k: False)
    monkeypatch.setattr(chat_locks, "lock_dir_usable", lambda: True, raising=False)
    import pytest as _pt
    from fastapi import HTTPException as _HE
    with _pt.raises(_HE) as ei:
        await _chats._acquire_gen_presence(1, "chatA")
    assert ei.value.status_code == 409


# ─────────────────────────────────────────────────────────────────────────────
#  B1bis — un verrou réservé mais jamais réclamé finit par être relâché
# ─────────────────────────────────────────────────────────────────────────────
def test_verrou_reserve_non_reclame_est_relache(monkeypatch):
    import time as _t
    fd = chat_locks.acquire("gen", 5, "chatZ")
    assert fd is not None
    # Réservé il y a longtemps : ``gen()`` n'a jamais démarré (le client est
    # parti avant la première itération du générateur).
    _chats._pending_gen_locks[(5, "chatZ")] = (fd, _t.monotonic() - 10_000)

    _chats._sweep_pending_gen_locks()

    assert (5, "chatZ") not in _chats._pending_gen_locks
    assert not chat_locks.is_held("gen", 5, "chatZ"), (
        "le verrou est resté tenu : cette conversation répondrait 409 "
        "jusqu'à la mort du worker")


def test_verrou_reserve_recent_est_preserve():
    import time as _t
    fd = chat_locks.acquire("gen", 5, "chatZ")
    _chats._pending_gen_locks[(5, "chatZ")] = (fd, _t.monotonic())
    _chats._sweep_pending_gen_locks()
    assert (5, "chatZ") in _chats._pending_gen_locks, (
        "un verrou tout juste réservé a été balayé sous le nez de gen()")
    chat_locks.release(fd)
    _chats._pending_gen_locks.clear()


# ─────────────────────────────────────────────────────────────────────────────
#  B3 — quand détacher plutôt qu'annuler
# ─────────────────────────────────────────────────────────────────────────────
def test_un_tour_avec_outils_est_detache_meme_sans_reglage():
    assert _chats._should_detach_run(detach_enabled=False, task_done=False,
                                     user_stopped=False, tools_ran=True), (
        "une mission qui a écrit des fichiers serait tuée par une simple "
        "veille du portable")


def test_un_tour_sans_outil_garde_le_contrat_historique():
    assert not _chats._should_detach_run(detach_enabled=False, task_done=False,
                                         user_stopped=False, tools_ran=False)


def test_le_reglage_global_detache_tout():
    assert _chats._should_detach_run(detach_enabled=True, task_done=False,
                                     user_stopped=False, tools_ran=False)


def test_un_stop_explicite_nest_jamais_detache():
    assert not _chats._should_detach_run(detach_enabled=True, task_done=False,
                                         user_stopped=True, tools_ran=True), (
        "un Stop utilisateur doit arrêter, pas passer en arrière-plan")


def test_rien_a_detacher_si_le_worker_a_fini():
    assert not _chats._should_detach_run(detach_enabled=True, task_done=True,
                                         user_stopped=False, tools_ran=True)
