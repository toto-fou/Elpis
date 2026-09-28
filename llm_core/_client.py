# SPDX-License-Identifier: MIT
"""
backend.services._client — Shared httpx.AsyncClient for llama-server.

Why a shared client instead of one per request
----------------------------------------------
1. KEEP-ALIVE: TCP connections are reused across requests. llama-server
   can associate a connection with a slot and reuse the KV cache of a
   common prefix → skips the system-prompt re-prefill (~800 tokens
   times N calls = seconds of saved latency).

2. CONNECTION POOL: ``max_connections`` caps concurrency toward
   llama-server. With ``-np 4`` we have 4 slots and 4 connections max.

3. CANCELLATION: ``async with client.stream(...)`` creates a per-request
   stream. Exiting the context manager (break, exception, CancelledError)
   closes THIS stream without affecting other in-flight requests on the
   same client. llama-server detects the disconnect and stops decoding.

WARNING: do NOT call ``client.aclose()`` outside the FastAPI shutdown
lifespan. The old code used ``Connection: close`` + ``max_keepalive=0`` to
force aggressive RSTs on cancel; with keep-alive, cancel just closes the
HTTP stream, not the TCP connection — sufficient because llama-server
detects client disconnect via socket polling.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from typing import Optional

import httpx

from shared_infra.config import LLAMA_MAX_CONCURRENCY, LLAMA_TIMEOUT_SEC


_llm_client: Optional[httpx.AsyncClient] = None
# Connecteurs LLM : un client par base_url cloud/distant, pour isoler le pool de
# connexions de chaque fournisseur du pool (petit) du llama-server local — un
# fournisseur lent ne doit pas saturer les keepalives réservés au local.
_clients_by_base: "OrderedDict[str, httpx.AsyncClient]" = OrderedDict()
# Borne du nombre de clients dédiés gardés en vie (audit long-run 2026-08-21).
# Le dict croissait sans limite : une clé par base_url VUE. En usage normal il
# y a une poignée de connecteurs, mais rien ne l'imposait — un worker qui vit
# désormais indéfiniment (recyclage gunicorn désactivé) accumulait un pool de
# connexions httpx par URL rencontrée, y compris les éphémères (tests d'un
# connecteur, URL corrigée après une faute de frappe). Éviction LRU : le
# client le moins récemment utilisé est FERMÉ, pas seulement oublié — sans
# ``aclose()`` ses sockets keep-alive restaient ouvertes jusqu'au GC.
_MAX_DEDICATED_CLIENTS = 16
_pending_closes: set = set()      # réfs fortes des fermetures en vol
_llm_client_limits = httpx.Limits(
    max_keepalive_connections=LLAMA_MAX_CONCURRENCY,  # 1 keepalive par slot
    max_connections=LLAMA_MAX_CONCURRENCY + 2,        # marge pour health checks
    keepalive_expiry=300,                             # 5min idle avant fermeture
)
# Timeouts EXPLICITES (ne pas repasser en ``timeout=None`` : un llama-server figé
# bloquerait alors un agent/slot indéfiniment — cf. audit agents §A2).
#  - ``read`` = LLAMA_TIMEOUT_SEC : garde d'INACTIVITÉ inter-chunk. En streaming,
#    httpx lève ``ReadTimeout`` si aucun token n'arrive pendant ce délai → un run
#    d'agent (même avec ``budget.timeout_s=0``) ne peut pas se figer pour toujours.
#  - ``connect`` court : llama-server injoignable → échec rapide (pas 600s).
_llm_client_timeout = httpx.Timeout(LLAMA_TIMEOUT_SEC, connect=15.0)

# ── Read-timeout de STREAMING adapté à la fenêtre du modèle ──────────────────
# Entre le POST et le premier chunk SSE, llama-server ne publie RIEN pendant
# tout le prompt processing : cette phase silencieuse est exposée en un seul
# read httpx. Sur une grande fenêtre (n_ctx 256k) à ~100-340 tk/s de prefill,
# elle dépasse LLAMA_TIMEOUT_SEC (600 s) → ReadTimeout à 10 min, re-POST,
# re-prefill… jusqu'à LLMFailure : c'était une cause de coupure des runs
# longs. Le read du flux est donc dimensionné sur le pire prefill plausible
# du modèle (plancher de débit conservateur), borné à 1 h. Contre-partie
# assumée : un vrai gel inter-token est détecté plus tard sur les grands
# modèles — préférable à un run tué par son propre prompt.
_PREFILL_TPS_FLOOR = 100.0
_STREAM_READ_MAX_S = 3600.0


def stream_timeout_for_ctx(ctx_size: Optional[int]) -> httpx.Timeout:
    """Timeout httpx pour UN appel de streaming, read élargi selon n_ctx."""
    read_s = float(LLAMA_TIMEOUT_SEC)
    if ctx_size and ctx_size > 0:
        read_s = max(read_s,
                     min(_STREAM_READ_MAX_S, float(ctx_size) / _PREFILL_TPS_FLOOR))
    return httpx.Timeout(LLAMA_TIMEOUT_SEC, connect=15.0, read=read_s)


def _new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=_llm_client_timeout,
        limits=_llm_client_limits,
        http2=False,  # llama-server HTTP/1.1 ; clouds OK en 1.1 aussi
    )


def _get_llm_client(base_url: Optional[str] = None) -> httpx.AsyncClient:
    """Retourne un client HTTP pour les appels LLM.

    ``base_url`` None/vide ⇒ client partagé historique (llama-server local) —
    comportement strictement inchangé. Sinon ⇒ client dédié (mémoïsé) au
    fournisseur distant. Créé paresseusement (event loop absent à l'import)."""
    global _llm_client
    if not base_url:
        if _llm_client is None or _llm_client.is_closed:
            _llm_client = _new_client()
        return _llm_client
    key = base_url.strip().rstrip("/")
    c = _clients_by_base.get(key)
    if c is None or c.is_closed:
        c = _new_client()
        _clients_by_base[key] = c
        _evict_dedicated_clients()
    _clients_by_base.move_to_end(key)   # marque « récemment utilisé »
    return c


def _evict_dedicated_clients() -> None:
    """Ferme les clients dédiés au-delà de ``_MAX_DEDICATED_CLIENTS`` (LRU).

    ``aclose()`` est une coroutine et on est ici en contexte SYNCHRONE
    (``_get_llm_client`` est appelé depuis du code sync comme async) : on
    planifie la fermeture sur la boucle si elle tourne, sinon on se contente
    de retirer l'entrée — sans boucle, il n'y a de toute façon pas de
    connexion en vol à fermer proprement."""
    while len(_clients_by_base) > _MAX_DEDICATED_CLIENTS:
        _old_key, _old = _clients_by_base.popitem(last=False)   # le plus ancien
        if _old.is_closed:
            continue
        try:
            # Référence GARDÉE : asyncio ne tient qu'une réf faible sur une
            # task, une fermeture planifiée puis ramassée ne s'exécuterait
            # jamais (et la socket resterait ouverte — l'inverse du but).
            _t = asyncio.get_running_loop().create_task(_aclose_quietly(_old))
            _pending_closes.add(_t)
            _t.add_done_callback(_pending_closes.discard)
        except RuntimeError:
            pass    # pas de boucle : rien à fermer proprement


async def _aclose_quietly(c: httpx.AsyncClient) -> None:
    try:
        await c.aclose()
    except Exception:
        pass


async def close_llm_client():
    """À appeler au shutdown du serveur FastAPI (lifespan)."""
    global _llm_client
    if _llm_client and not _llm_client.is_closed:
        await _llm_client.aclose()
        _llm_client = None
    for c in list(_clients_by_base.values()):
        try:
            if not c.is_closed:
                await c.aclose()
        except Exception:
            pass
    _clients_by_base.clear()
