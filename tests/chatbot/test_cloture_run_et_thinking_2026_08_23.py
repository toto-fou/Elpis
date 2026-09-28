# SPDX-License-Identifier: MIT
"""
tests/chatbot/test_cloture_run_et_thinking_2026_08_23.py — audit du cœur
2026-08-23.

Deux propriétés de la route de flux qu'aucun test n'atteignait, parce que le
code vivait dans le ``finally`` d'un générateur imbriqué dans le handler :

  1. CLÔTURE — un tour qui se termine NORMALEMENT ne doit ni annuler ni le
     DIRE aux autres workers. ``_should_detach_run`` rend False dans deux cas
     opposés (déconnexion sans détachement, et fin normale) : sans garde, la
     fin normale tombait dans le chemin « annulation », posait le flag et le
     publiait sur le bus inter-worker. Or ``clear_chat_cancellation`` est
     purement local — rien ne diffuse le retrait. Le flag restait donc collé
     sur les N-1 autres workers jusqu'au TTL d'une heure : sonde précoce du
     tour suivant neutralisée, garde de présence qui prend ce flag pour la
     preuve d'un Stop (12 s de passation au lieu d'un 409 immédiat), et une
     ligne de spool d'annulation par tour RÉUSSI.

  2. RAISONNEMENT — il n'est pas retenu en base (seule exception assumée :
     ``resume_thinking``). ``upsert_chat`` ne nettoyait que le champ de
     PREMIER niveau ; la copie posée par ``calculate_metrics`` et par la
     boucle d'outils dans ``metrics["thinking"]`` passait entière, jusqu'à
     ``THINKING_HISTORY_MAX_CHARS`` (400 000 caractères) par message —
     re-sérialisés et réécrits à chaque tour, ``messages_json`` étant
     reconstruit en entier.
"""
from __future__ import annotations

import asyncio

import pytest

from chatbot_app.routes import chats as _chats
from shared_infra.runtime import chat_locks
from shared_infra.routes import _state


@pytest.fixture(autouse=True)
def _etat_isole(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    yield
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()


@pytest.fixture
def _bus_espionne(monkeypatch):
    """Le bus est le seul canal visible des autres workers : on compte ce qui
    y part, pas seulement l'état local."""
    publie: list[tuple] = []
    monkeypatch.setattr(_state, "_publish_cancel",
                        lambda uid, cid, *a, **k: publie.append((uid, cid)))
    return publie


# ── 1. Clôture d'un run ──────────────────────────────────────────────────────

async def test_fin_normale_n_annule_rien_et_ne_publie_rien(_bus_espionne):
    """Le cas de très loin le plus fréquent : le worker a fini, le flux se
    ferme. Rien ne doit sortir vers les autres workers."""
    async def _worker():
        return "fini"

    task = asyncio.create_task(_worker())
    await task
    _state.register_chat_task(7, task, "chatN")

    await _chats._cloturer_run(task, 7, "chatN")

    assert not _state.is_chat_cancelled(7, "chatN"), \
        "un tour réussi a été marqué comme annulé"
    assert _bus_espionne == [], \
        f"un tour réussi a diffusé une annulation aux autres workers : {_bus_espionne}"
    assert _state.get_active_chat_task(7, "chatN") is None, \
        "le verrou de présence n'a pas été rendu à la fin du tour"


async def test_deconnexion_sur_worker_vivant_annule_et_le_dit(_bus_espionne):
    """L'autre entrée du même code : le client est parti, le worker travaille
    encore. Là, l'annulation ET sa diffusion sont exactement ce qu'on veut."""
    demarre = asyncio.Event()

    async def _worker():
        demarre.set()
        await asyncio.sleep(60)

    task = asyncio.create_task(_worker())
    await demarre.wait()
    _state.register_chat_task(7, task, "chatD")

    await _chats._cloturer_run(task, 7, "chatD")

    assert task.cancelled() or task.done()
    assert _bus_espionne == [(7, "chatD")], \
        "la déconnexion doit être annoncée aux autres workers"
    # Le flag LOCAL, lui, est repurgé par ``unregister_chat_task`` — le worker
    # est mort, il n'a plus rien à observer. Ce qui compte est parti sur le bus.
    assert _state.get_active_chat_task(7, "chatD") is None


async def test_worker_qui_ne_deroule_pas_garde_sa_presence(_bus_espionne):
    """Un outil parti pour plusieurs minutes ne déroule pas en 10 s : on ne
    déclare pas la conversation libre tant que le fantôme y travaille."""
    monte = asyncio.Event()

    async def _worker():
        monte.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            await asyncio.sleep(0.3)   # unwind lent (outil en vol)
            raise

    task = asyncio.create_task(_worker())
    await monte.wait()
    _state.register_chat_task(7, task, "chatL")

    async def _cloture_rapide(t, u, c):
        """Même code, borne d'attente raccourcie pour le test."""
        vrai = asyncio.wait_for

        async def _court(aw, timeout=None):
            return await vrai(aw, timeout=0.05)

        asyncio.wait_for = _court
        try:
            await _chats._cloturer_run(t, u, c)
        finally:
            asyncio.wait_for = vrai

    await _cloture_rapide(task, 7, "chatL")

    assert _state.get_active_chat_task(7, "chatL") is task, \
        "présence relâchée alors que le worker travaillait encore"
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)   # laisser courir le done_callback
    assert _state.get_active_chat_task(7, "chatL") is None, \
        "présence jamais rendue après la fin réelle du worker"


# ── 2. Le raisonnement ne survit pas à la persistance ────────────────────────

def _un_utilisateur(nom: str) -> int:
    """La base est partagée par la session de test : un nom par cas."""
    from shared_infra.accounts.users import create_user
    return create_user(nom, "motdepasse")


def test_le_raisonnement_niche_dans_les_metriques_est_retire():
    """Le seul écrit-chemin des messages doit nettoyer les DEUX emplacements —
    y compris pour ``PUT /save-messages``, où le front renvoie ``m.metrics``
    tel qu'il l'a reçu de l'événement final."""
    from shared_infra.chat.store import upsert_chat, get_chat
    uid = _un_utilisateur("cloture1")

    messages = [
        {"role": "user", "content": "salut"},
        {"role": "assistant", "content": "ok",
         "thinking": "PREMIER-NIVEAU",
         "metrics": {"tokens": 12, "thinking": "A" * 5000},
         "resume_thinking": "SUFFIXE-UTILE"},
    ]
    assert upsert_chat(uid, "c-think-1", "titre", messages, 100.0) is True
    relu = get_chat(uid, "c-think-1")["messages"]

    assert "thinking" not in relu[1], "le champ de premier niveau a survécu"
    assert "thinking" not in relu[1]["metrics"], \
        "le raisonnement a été persisté via metrics.thinking"
    assert relu[1]["metrics"]["tokens"] == 12, "les autres métriques ont été perdues"
    assert relu[1]["resume_thinking"] == "SUFFIXE-UTILE", \
        "l'exception resume_thinking doit continuer de passer"


def test_le_nettoyage_ne_modifie_pas_la_liste_de_l_appelant():
    """L'appelant garde souvent la liste en main (l'event NDJSON final porte les
    métriques COMPLÈTES) : le nettoyage doit copier, pas muter en place."""
    from shared_infra.chat.store import upsert_chat
    uid = _un_utilisateur("cloture2")

    metriques = {"tokens": 3, "thinking": "VIVANT"}
    messages = [{"role": "assistant", "content": "ok", "metrics": metriques}]
    assert upsert_chat(uid, "c-think-2", "titre", messages, 100.0) is True

    assert metriques["thinking"] == "VIVANT", \
        "upsert_chat a muté les métriques de l'appelant"
    assert messages[0]["metrics"] is metriques
