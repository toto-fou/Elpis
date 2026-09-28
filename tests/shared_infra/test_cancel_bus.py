# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_cancel_bus.py — annulation de chat CROSS-WORKER.

Contexte du bug corrigé : ``_cancelled_chats`` / ``_active_chat_tasks`` sont
par-process, mais gunicorn tourne avec plusieurs workers et ``reuse_port`` (pas
d'affinité). Le POST /api/chat/cancel atterrissait donc presque toujours sur un
worker qui n'exécute rien : flag posé dans le mauvais registre, génération
poursuivie ailleurs, tour persisté malgré l'« annulé » affiché côté UI.

Ces tests simulent DEUX workers en pilotant le fichier de spool à la main : le
worker A publie, le worker B applique (c'est ce que fait son tailer).
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest

from shared_infra.runtime import cancel_bus
from shared_infra.routes import _state


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Spool dédié au test + registres par-process remis à zéro."""
    monkeypatch.setattr(cancel_bus, "CANCEL_FILE", tmp_path / "cancel.jsonl")
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    _state._cleared_at.clear()
    yield
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    _state._cleared_at.clear()


def _spool_lines():
    p = cancel_bus.CANCEL_FILE
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


# ─── Publication ─────────────────────────────────────────────────────────────

def test_mark_chat_cancelled_publie_sur_le_bus():
    """Un Stop reçu par n'importe quel worker doit être DIFFUSÉ, sinon les
    autres process n'en sauront jamais rien."""
    _state.mark_chat_cancelled(7, "chatA")
    assert _state.is_chat_cancelled(7, "chatA")          # appliqué en local
    assert _spool_lines() == [                            # …et diffusé
        {"uid": 7, "cid": "chatA", "ts": _spool_lines()[0]["ts"]}
    ]


def test_application_distante_ne_reemet_pas():
    """Le worker qui APPLIQUE une demande reçue ne doit pas la republier —
    sinon les N workers s'entre-rediffusent en boucle."""
    _state.apply_remote_cancellation(7, "chatA", time.time())
    assert _state.is_chat_cancelled(7, "chatA")
    assert _spool_lines() == []


def test_publication_survit_a_un_spool_inaccessible(monkeypatch):
    """/tmp plein ou non inscriptible : le Stop LOCAL doit rester effectif."""
    def _boom(*a, **kw):
        raise OSError("disque plein")
    monkeypatch.setattr(cancel_bus.os, "open", _boom)
    _state.mark_chat_cancelled(7, "chatA")               # ne lève pas
    assert _state.is_chat_cancelled(7, "chatA")


# ─── Application côté worker qui streame ─────────────────────────────────────

@pytest.mark.asyncio
async def test_worker_distant_annule_la_task_locale():
    """Le cœur du fix : worker A reçoit le Stop, worker B tient la task."""
    started = asyncio.Event()

    async def _generation():
        started.set()
        await asyncio.sleep(30)          # « génération » en cours

    task = asyncio.create_task(_generation())
    await started.wait()
    _state.register_chat_task(7, task, "chatA")

    # Worker A : reçoit le POST /api/chat/cancel, publie.
    ts = cancel_bus.publish_cancel(7, "chatA")
    # Worker B : son tailer lit la ligne et l'applique.
    _state.apply_remote_cancellation(7, "chatA", ts)

    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()
    assert _state.is_chat_cancelled(7, "chatA")


@pytest.mark.asyncio
async def test_annulation_ciblee_epargne_les_autres_chats():
    """Multi-onglets : annuler chatA ne doit pas tuer chatB."""
    async def _gen():
        await asyncio.sleep(30)

    tA, tB = asyncio.create_task(_gen()), asyncio.create_task(_gen())
    await asyncio.sleep(0)
    _state.register_chat_task(7, tA, "chatA")
    _state.register_chat_task(7, tB, "chatB")

    _state.apply_remote_cancellation(7, "chatA", time.time())
    await asyncio.sleep(0)

    assert tA.cancelling() or tA.cancelled() or tA.done()
    assert not tB.done()
    assert not _state.is_chat_cancelled(7, "chatB")
    tB.cancel()


# ─── Garde anti-écho ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_echo_perime_ne_tue_pas_la_generation_suivante():
    """Le worker émetteur reçoit SON PROPRE écho ~100 ms plus tard. Si une
    nouvelle génération a démarré entre-temps sur ce chat, ré-appliquer la
    vieille demande la tuerait à la naissance."""
    ts_stop = cancel_bus.publish_cancel(7, "chatA")

    # Nouvelle génération sur le même chat : le flag est remis à zéro.
    _state.clear_chat_cancellation(7, "chatA")
    async def _gen():
        await asyncio.sleep(30)
    task = asyncio.create_task(_gen())
    await asyncio.sleep(0)
    _state.register_chat_task(7, task, "chatA")

    # L'écho du Stop PRÉCÉDENT arrive maintenant.
    _state.apply_remote_cancellation(7, "chatA", ts_stop)
    await asyncio.sleep(0)

    assert not task.done(), "l'écho périmé a tué la nouvelle génération"
    assert not _state.is_chat_cancelled(7, "chatA")
    task.cancel()


def test_echo_tardif_ne_refuit_pas_dans_le_registre():
    """Après la fin d'un tour, unregister purge le flag. Un écho tardif ne
    doit pas le réinjecter : ce serait la fuite lente (set non borné, sans
    reaper) que unregister_chat_task corrige."""
    ts = cancel_bus.publish_cancel(7, "chatA")
    _state.unregister_chat_task(7, "chatA")
    _state.apply_remote_cancellation(7, "chatA", ts)
    assert (7, "chatA") not in _state._cancelled_chats


def test_borne_du_dictionnaire_de_resets():
    """_cleared_at n'a pas de reaper : il doit s'auto-borner."""
    for i in range(_state._CLEARED_MAX * 2):
        _state.clear_chat_cancellation(i, f"chat{i}")
    assert len(_state._cleared_at) <= _state._CLEARED_MAX


# ─── Tailer ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_tailer_applique_les_lignes_ecrites_apres_son_demarrage():
    """Bout en bout : le tailer d'un worker consomme le spool et applique."""
    seen = []
    # Le tailer part de la FIN du fichier : une demande antérieure au boot du
    # worker concerne une génération déjà morte, on ne la rejoue pas.
    cancel_bus.publish_cancel(1, "vieux")
    task = asyncio.create_task(
        cancel_bus._tail_loop(lambda u, c, t: seen.append((u, c))))
    await asyncio.sleep(0.15)

    cancel_bus.publish_cancel(7, "chatA")
    cancel_bus.publish_cancel(8, "chatB")
    await asyncio.sleep(0.3)

    task.cancel()
    assert (7, "chatA") in seen and (8, "chatB") in seen
    assert (1, "vieux") not in seen


# ─── Annulation d'un SOUS-AGENT (kind="child", 2026-07-30) ──────────────────
# Le ✕ par-agent posait son flag dans le seul worker qui recevait le POST,
# alors que l'enfant tourne dans celui qui tient le stream : avec N workers il
# n'agissait qu'une fois sur N, l'API répondant malgré tout « cancelled » —
# exactement le bug que ce bus avait déjà réglé pour le Stop du chat.

def test_publish_child_cancel_ecrit_une_ligne_typee():
    ts = cancel_bus.publish_child_cancel("alice", "t1-abc")
    assert _spool_lines() == [
        {"kind": "child", "user": "alice", "child": "t1-abc", "ts": ts}
    ]


@pytest.mark.asyncio
async def test_tailer_route_les_enfants_sans_toucher_au_chat_parent():
    """LA propriété critique : une annulation d'enfant ne doit JAMAIS passer
    par ``apply_fn`` — elle tuerait le tour parent, l'inverse exact de ce que
    le ✕ par-agent doit faire (le parent continue sans le rapport)."""
    chats, children = [], []
    task = asyncio.create_task(cancel_bus._tail_loop(
        lambda u, c, t: chats.append((u, c)),
        lambda user, child, t: children.append((user, child)),
    ))
    await asyncio.sleep(0.15)

    cancel_bus.publish_child_cancel("alice", "t1-abc")
    cancel_bus.publish_cancel(7, "chatA")
    await asyncio.sleep(0.3)
    task.cancel()

    assert children == [("alice", "t1-abc")]
    assert chats == [(7, "chatA")], "une ligne enfant a été traitée comme un chat"


@pytest.mark.asyncio
async def test_tailer_sans_applicateur_enfant_ignore_ces_lignes():
    """Compat : un appelant qui ne fournit pas ``child_apply_fn`` (ancien
    câblage) ne doit pas voir ces lignes atterrir dans ``apply_fn``."""
    chats = []
    task = asyncio.create_task(
        cancel_bus._tail_loop(lambda u, c, t: chats.append((u, c))))
    await asyncio.sleep(0.15)
    cancel_bus.publish_child_cancel("alice", "t1-abc")
    cancel_bus.publish_cancel(7, "chatA")
    await asyncio.sleep(0.3)
    task.cancel()
    assert chats == [(7, "chatA")]


def test_cancel_child_diffuse_et_epargne_le_parent():
    """``cancel_child`` applique en local PUIS diffuse ; le registre de chats
    reste intact (le tour parent survit)."""
    import llm_core.tools.task_tool as T
    T._ACTIVE_CHILDREN[("alice", "t1-abc")] = {"agent": "explore"}
    try:
        assert T.cancel_child("alice", "t1-abc") is True
        assert ("alice", "t1-abc") in T._CANCELLED_CHILDREN
        assert _spool_lines()[0]["kind"] == "child"
        assert not _state._cancelled_chats
    finally:
        T._ACTIVE_CHILDREN.clear()
        T._CANCELLED_CHILDREN.clear()


def test_cancel_child_diffuse_meme_si_l_enfant_est_ailleurs():
    """Cas NOMINAL en multi-worker : l'enfant n'est pas ici. La demande doit
    partir quand même — sinon le ✕ ne fait rien (le bug corrigé)."""
    import llm_core.tools.task_tool as T
    assert T.cancel_child("alice", "t9-zzz") is False   # inconnu ICI
    assert _spool_lines()[0]["child"] == "t9-zzz"       # …mais diffusé


def test_apply_child_cancel_ne_marque_que_les_enfants_actifs_ici():
    """Un flag « au cas où » ne serait jamais nettoyé (seul le ``finally`` d'un
    run le retire) : un écho reçu pour un enfant d'un autre worker doit rester
    sans trace locale."""
    import llm_core.tools.task_tool as T
    T._CANCELLED_CHILDREN.clear()
    assert T.apply_child_cancel("alice", "t-inconnu") is False
    assert not T._CANCELLED_CHILDREN


@pytest.mark.asyncio
async def test_tailer_survit_aux_lignes_corrompues():
    """Une ligne tronquée (rotation, crash d'écriture) ne doit pas arrêter le
    tailer : les demandes suivantes doivent continuer de passer."""
    seen = []
    task = asyncio.create_task(
        cancel_bus._tail_loop(lambda u, c, t: seen.append((u, c))))
    await asyncio.sleep(0.15)

    with open(cancel_bus.CANCEL_FILE, "a") as f:
        f.write('{"uid": 1, "cid": "tron\n')      # JSON invalide
        f.write('{"cid": "sans_uid"}\n')          # champ manquant
    await asyncio.sleep(0.2)
    cancel_bus.publish_cancel(9, "chatOK")
    await asyncio.sleep(0.3)

    task.cancel()
    assert seen == [(9, "chatOK")]
