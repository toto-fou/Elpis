# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_events.py — bus pub/sub in-process du live OCR.

``OcrEventBus`` remplace le bus multi-worker per-user du chatbot : fan-out
asyncio mono-process, publication non bloquante (drop si abonné saturé),
générateur SSE (enveloppe ``{"type":"ocr","data":…}``, keepalive ``: ping``,
désabonnement garanti à la fermeture).
"""
from __future__ import annotations

import asyncio
import json

import pytest

from rag_app.ocr import events as E


async def test_publish_atteint_tous_les_abonnes():
    bus = E.OcrEventBus()
    q1, q2 = bus.subscribe(), bus.subscribe()
    assert bus.subscriber_count == 2
    bus.publish({"kind": "progress", "doc": "d1"})
    assert q1.get_nowait() == {"kind": "progress", "doc": "d1"}
    assert q2.get_nowait() == {"kind": "progress", "doc": "d1"}
    bus.unsubscribe(q1)
    bus.publish({"kind": "text"})
    assert q1.empty()                       # désabonné : plus rien ne tombe
    assert q2.get_nowait() == {"kind": "text"}
    bus.unsubscribe(q2)
    assert bus.subscriber_count == 0
    bus.unsubscribe(q2)                     # idempotent (discard)


async def test_publish_sans_abonne_ne_leve_pas():
    E.OcrEventBus().publish({"kind": "progress"})   # no-op silencieux


async def test_listen_enveloppe_sse():
    bus = E.OcrEventBus()
    gen = bus.listen()
    task = asyncio.create_task(gen.__anext__())
    await asyncio.sleep(0)                  # le générateur s'abonne et attend
    assert bus.subscriber_count == 1
    bus.publish({"kind": "job_done", "doc": "d1", "status": "done"})
    line = await asyncio.wait_for(task, 5)
    assert line.startswith("data: ") and line.endswith("\n\n")
    payload = json.loads(line[len("data: "):])
    assert payload == {"type": "ocr",
                       "data": {"kind": "job_done", "doc": "d1",
                                "status": "done"}}
    await gen.aclose()
    assert bus.subscriber_count == 0        # désabonné au close


async def test_listen_ping_sur_inactivite(monkeypatch):
    monkeypatch.setattr(E, "_PING_SEC", 0.05)
    bus = E.OcrEventBus()
    gen = bus.listen()
    line = await asyncio.wait_for(gen.__anext__(), 5)
    assert line == ": ping\n\n"             # keepalive, pas un event
    # un event après le ping sort normalement
    task = asyncio.create_task(gen.__anext__())
    await asyncio.sleep(0)
    bus.publish({"kind": "queue"})
    line2 = await asyncio.wait_for(task, 5)
    assert line2.startswith("data: ")
    await gen.aclose()
    assert bus.subscriber_count == 0


async def test_listen_annulation_desabonne():
    """Starlette ANNULE le générateur à la déconnexion du client : le
    finally doit désabonner (pas de fuite d'abonnés fantômes)."""
    bus = E.OcrEventBus()
    gen = bus.listen()
    task = asyncio.create_task(gen.__anext__())
    await asyncio.sleep(0)
    assert bus.subscriber_count == 1
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    await gen.aclose()
    assert bus.subscriber_count == 0


async def test_queue_pleine_resync_sans_bloquer(monkeypatch):
    """Abonné saturé : publish ne lève ni ne bloque jamais le job émetteur ;
    l'arriéré est jeté et remplacé par un marqueur de RESYNC (passe RAG 2 :
    un ``job_done`` perdu laissait l'UI sur « en cours »), puis le flux
    reprend normalement."""
    monkeypatch.setattr(E, "_QUEUE_MAX", 2)   # lu au subscribe (maxsize)
    bus = E.OcrEventBus()
    q = bus.subscribe()
    for i in range(3):
        bus.publish({"kind": "text", "i": i})   # jamais d'exception
    assert q.qsize() == 1 and q.get_nowait() is E._RESYNC
    bus.publish({"kind": "job_done", "i": 9})
    assert q.get_nowait()["i"] == 9


async def test_listen_emet_resync(monkeypatch):
    monkeypatch.setattr(E, "_QUEUE_MAX", 1)
    bus = E.OcrEventBus()
    q = bus.subscribe()
    bus.publish({"kind": "a"})
    bus.publish({"kind": "b"})                  # déborde → resync
    gen = bus.listen(q)
    line = await asyncio.wait_for(gen.__anext__(), 2)
    assert line == 'data: {"type": "resync"}\n\n'
    await gen.aclose()
    assert bus.subscriber_count == 0


def test_plafond_d_abonnes(monkeypatch):
    monkeypatch.setattr(E, "MAX_SUBSCRIBERS", 2)
    bus = E.OcrEventBus()
    bus.subscribe(); bus.subscribe()
    with pytest.raises(E.TooManySubscribers):
        bus.subscribe()
