# SPDX-License-Identifier: MIT
"""rag_app.ocr.events — bus pub/sub in-process pour le live OCR (SSE).

Remplace le bus multi-worker per-user du chatbot (``pipeline_events``) :
rag_app tourne en UN process uvicorn et n'a pas d'utilisateurs — un simple
fan-out asyncio suffit. Chaque abonné (connexion SSE) a sa Queue bornée ;
``publish`` est synchrone et ne bloque JAMAIS un job (file pleine → drop,
le live est du sucre, l'état de vérité reste meta.json).

Wire : ``data: {"type": "ocr", "data": {…}}`` — même enveloppe que le bus
du chatbot, le vocabulaire ``data.kind`` est documenté dans ``jobs``.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator, Dict, Set

# Une page dense peut émettre beaucoup de deltas ; 1000 events de marge
# absorbe un abonné lent sans gonfler la RAM (drop au-delà).
_QUEUE_MAX = 1000

# Keepalive du flux SSE : un commentaire toutes les N secondes maintient la
# connexion à travers les proxys (Caddy) sans réveiller le client.
_PING_SEC = 15


# Plafond d'abonnés simultanés (onglets ouverts) : au-delà, 503 — chaque
# abonné porte une file de 1000 events en RAM.
MAX_SUBSCRIBERS = 32

# Marqueur interne : l'abonné a perdu des events (file pleine) — le client
# reçoit ``{"type": "resync"}`` et relit l'état complet (liste, file, doc).
_RESYNC = object()


class TooManySubscribers(RuntimeError):
    """Plafond d'abonnés SSE atteint."""


class OcrEventBus:
    """Fan-out mono-process : N abonnés SSE, publication non bloquante."""

    def __init__(self) -> None:
        self._subs: Set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        """:raises TooManySubscribers: plafond ``MAX_SUBSCRIBERS`` atteint."""
        if len(self._subs) >= MAX_SUBSCRIBERS:
            raise TooManySubscribers(
                f"Trop de flux live ouverts ({MAX_SUBSCRIBERS} max).")
        q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)

    def publish(self, data: Dict) -> None:
        """Publie vers tous les abonnés — jamais bloquant pour l'émetteur.

        Abonné saturé : son arriéré est JETÉ et remplacé par un marqueur de
        resynchronisation (avant, l'event était simplement perdu — un
        ``job_done`` manqué laissait l'UI sur « en cours » jusqu'au
        rechargement).
        """
        for q in list(self._subs):
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                while True:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                try:
                    q.put_nowait(_RESYNC)
                except asyncio.QueueFull:   # pragma: no cover — vidée juste avant
                    pass

    async def listen(self, q: "asyncio.Queue | None" = None) -> AsyncIterator[str]:
        """Générateur de lignes SSE (``data: {...}\\n\\n`` + pings).

        ``q`` : file obtenue par :meth:`subscribe` (la route s'abonne AVANT de
        répondre pour pouvoir renvoyer 503) ; sinon abonnement ici.
        Starlette annule le générateur à la déconnexion du client → le
        ``finally`` désabonne, pas de fuite.
        """
        if q is None:
            q = self.subscribe()
        try:
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=_PING_SEC)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if data is _RESYNC:
                    yield 'data: {"type": "resync"}\n\n'
                    continue
                payload = json.dumps({"type": "ocr", "data": data},
                                     ensure_ascii=False)
                yield f"data: {payload}\n\n"
        finally:
            self.unsubscribe(q)


# Bus unique du service (module-level, comme ``engine`` dans app.py).
bus = OcrEventBus()
