# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_system_events_queue_full.py

Sur saturation de queue, ``SystemEvents.broadcast`` retirait le client du
registre — mais son ``listen()`` restait bloqué à jamais sur ``await q.get()``
(plus personne ne pousse). Le ``finally`` ne s'exécutait donc jamais, et comme
``EventSourceResponse`` envoie ses propres pings toutes les 15 s, le navigateur
ne voyait AUCUNE erreur : ni ``onerror``, ni reconnexion. Logs serveur et badge
de notifications gelés jusqu'à un rechargement manuel.

Un client saturé doit soit repartir (en perdant des événements anciens), soit
être fermé PROPREMENT pour que le navigateur reconnecte. Jamais rester
silencieusement sourd. Régression du finding E5 de l'audit 2026-08-01.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from shared_infra.observability.events_bus import SystemEvents


def _drain_available(gen_queue) -> list:
    out = []
    while True:
        try:
            out.append(gen_queue.get_nowait())
        except asyncio.QueueEmpty:
            return out


def test_client_sature_reste_inscrit_et_recoit_a_nouveau():
    async def scenario():
        bus = SystemEvents()
        agen = bus.listen(is_staff=True, user_id=1)
        # Démarre le générateur : il s'inscrit puis attend sur q.get().
        first = asyncio.create_task(agen.__anext__())
        await asyncio.sleep(0)
        assert len(bus.clients) == 1
        q = next(iter(bus.clients))

        # Sature la queue SANS que le client consomme.
        for i in range(bus.QUEUE_MAX_SIZE + 5):
            await bus._fanout({"type": "log", "level": "info",
                                 "message": f"m{i}"})

        assert len(bus.clients) == 1, (
            "le client a été désinscrit sur QueueFull : son listen() reste "
            "bloqué pour toujours et le navigateur ne le sait jamais"
        )

        # Un nouvel événement doit encore lui parvenir.
        await bus._fanout({"type": "log", "level": "info",
                             "message": "APRES-SATURATION"})
        received = "".join(json.dumps(m) for m in _drain_available(q))
        assert "APRES-SATURATION" in received, (
            "le client saturé ne reçoit plus rien — il est sourd à vie"
        )

        first.cancel()
        try:
            await first
        except (asyncio.CancelledError, StopAsyncIteration):
            pass
        await agen.aclose()

    asyncio.run(scenario())


def test_sentinelle_de_fermeture_termine_le_flux():
    """Si le client ne peut vraiment pas être réalimenté, la sentinelle doit
    terminer ``listen`` (donc exécuter son ``finally`` et fermer la réponse SSE)
    plutôt que de le laisser pendre."""
    async def scenario():
        from shared_infra.observability import events_bus as eb

        bus = eb.SystemEvents()
        agen = bus.listen(is_staff=True, user_id=1)
        first = asyncio.create_task(agen.__anext__())
        await asyncio.sleep(0)
        q = next(iter(bus.clients))

        first.cancel()
        try:
            await first
        except (asyncio.CancelledError, StopAsyncIteration):
            pass

        # Nouveau générateur propre pour observer la sentinelle.
        agen2 = bus.listen(is_staff=True, user_id=1)
        t = asyncio.create_task(agen2.__anext__())
        await asyncio.sleep(0)
        q2 = [x for x in bus.clients if x is not q][0]
        q2.put_nowait(eb._CLIENT_CLOSED)

        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(t, timeout=2.0)
        # Le finally a bien tourné : le client est désinscrit.
        assert q2 not in bus.clients

    asyncio.run(scenario())
