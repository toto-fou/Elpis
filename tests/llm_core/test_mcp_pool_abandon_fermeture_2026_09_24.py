# SPDX-License-Identifier: MIT
"""AUDIT 2026-09-24 — pool MCP : abandon d'appel et fermeture annulée.

Point 2 : un appel abandonné (Stop / timeout d'exécution) ne marque l'entrée
unhealthy que sur un transport SÉRIEL (stdio). Sur un transport corrélé
(SSE / HTTP / en mémoire) — le serveur d'outils locaux, entrée UNIQUE du
worker — le Stop d'un utilisateur forçait une reconnexion qui coupait les
appels en vol des autres.

Point 5 : ``_close_entry_unsafe`` retire l'entrée du pool AVANT de drainer ;
une annulation de l'appelant pendant le drainage laissait le client jamais
fermé, et ``_acquire_exclusive`` gardait verrou + permis tenus.
"""
from __future__ import annotations

import asyncio

import pytest

import llm_core._mcp_pool as mp


class _Client:
    def __init__(self, delay=30.0):
        self.delay = delay
        self.closed = 0

    async def call_tool(self, _name, _args):
        await asyncio.sleep(self.delay)
        return "ok"

    async def __aexit__(self, *_a):
        self.closed += 1


class MCPSSEWrapper(_Client):
    """Même NOM de classe que le wrapper réel : c'est lui que le pool lit."""


def _pool(client, *, concurrent):
    pool = mp.MCPConnectionPool()
    cfg = {"type": "stdio", "command": "stub", "name": "stub"}
    key = pool._make_key(cfg)
    entry = mp._PoolEntry(key=key, client=client, healthy=True,
                          tools_fetched_at=1.0, last_used_at=1.0)
    if concurrent:
        entry.max_concurrency = 4
        entry.call_sem = asyncio.Semaphore(4)
    pool._pool[key] = entry
    return pool, cfg, entry


@pytest.mark.asyncio
async def test_stop_sur_transport_correle_garde_l_entree_saine():
    pool, cfg, entry = _pool(MCPSSEWrapper(), concurrent=True)
    t = asyncio.ensure_future(pool.call_tool(cfg, "x", {}))
    await asyncio.sleep(0.02)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert entry.healthy is True
    assert pool._pool.get(entry.key) is entry


@pytest.mark.asyncio
async def test_timeout_sur_transport_correle_garde_l_entree_saine():
    pool, cfg, entry = _pool(MCPSSEWrapper(), concurrent=True)
    with pytest.raises(asyncio.TimeoutError):
        await pool.call_tool(cfg, "x", {}, exec_timeout_s=0.02)
    assert entry.healthy is True


@pytest.mark.asyncio
async def test_stop_sur_stdio_marque_toujours_unhealthy():
    pool, cfg, entry = _pool(_Client(), concurrent=False)
    t = asyncio.ensure_future(pool.call_tool(cfg, "x", {}))
    await asyncio.sleep(0.02)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert entry.healthy is False


@pytest.mark.asyncio
async def test_acquire_exclusive_annule_rend_verrou_et_permis():
    entry = mp._PoolEntry(key="k", client=None)
    entry.max_concurrency = 2
    entry.call_sem = asyncio.Semaphore(2)
    await entry.call_sem.acquire()            # un appel en vol
    t = asyncio.ensure_future(mp._acquire_exclusive(entry, timeout=5.0))
    await asyncio.sleep(0.02)                 # lock + 1 permis pris, attend le 2e
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert not entry.lock.locked()
    entry.call_sem.release()
    assert entry.call_sem._value == 2


@pytest.mark.asyncio
async def test_fermeture_annulee_ferme_quand_meme_le_client():
    client = _Client()
    pool, cfg, entry = _pool(client, concurrent=False)
    await entry.lock.acquire()                # un appel stdio en vol
    t = asyncio.ensure_future(pool._close_entry_unsafe(entry.key))
    await asyncio.sleep(0.02)
    t.cancel()                                # l'appelant est annulé (Stop)
    with pytest.raises(asyncio.CancelledError):
        await t
    assert entry.key not in pool._pool
    assert client.closed == 0                 # drainage en cours…
    entry.lock.release()                      # …l'appel en vol se termine
    for _ in range(50):
        if client.closed:
            break
        await asyncio.sleep(0.01)
    assert client.closed == 1                 # fermé malgré l'annulation
    assert not entry.lock.locked()
    assert not pool._closing_tasks
