# SPDX-License-Identifier: MIT
"""tests/llm_core/test_tool_timeout.py — borne dure par appel d'outil MCP.

Avant : ``_execute_single_tool_call`` → ``mcp_pool.call_tool`` sans limite ;
un serveur MCP suspendu gelait le tour (et son ``entry.lock``) jusqu'à
l'annulation utilisateur.

AUDIT 2026-08-31 — le chronomètre vit désormais DANS ``call_tool``
(``exec_timeout_s``), démarré APRÈS l'acquisition du sémaphore d'entrée :
l'attente en file n'est plus facturée au budget de l'outil (elle a sa propre
borne, ``queue_timeout_s`` → ``MCPQueueSaturated``). Contrat côté harnais :

- ``asyncio.TimeoutError`` (exécution) → enveloppe d'erreur ORDINAIRE
  ``{"ok": false, "error": "timeout"}`` (le modèle la voit, la boucle
  continue, itération non productive) ;
- ``MCPQueueSaturated`` (file) → erreur DISTINCTE, jamais imputée à l'outil ;
- override par-outil ``tools.<name>.timeout_s`` (context_config) prioritaire
  sur le défaut global ``LLAMA_TOOL_TIMEOUT_S`` ;
- l'annulation utilisateur (CancelledError) TRAVERSE (jamais convertie en
  enveloppe) — le partiel/anti-rejeu en dépend ;
- les builtin handlers (in-process) ne sont PAS bornés (inchangé).
"""
from __future__ import annotations

import asyncio
import json

import pytest

import llm_core._chat_with_tools as cwt
import llm_core._mcp_pool as mp


async def _slow_call_tool(*_a, exec_timeout_s=None, **_k):
    # Mock du POOL : honore le contrat ``exec_timeout_s`` (le vrai call_tool
    # borne l'exécution en interne — testé plus bas sur le pool réel).
    if exec_timeout_s is not None:
        await asyncio.sleep(exec_timeout_s)
        raise asyncio.TimeoutError()
    await asyncio.sleep(30)


async def _quick_call_tool(*_a, **_k):
    return {"ok": True, "data": "vite"}


@pytest.fixture()
def cfg_map():
    return {"outil_lent": {"type": "stdio", "command": "x", "name": "srv"}}


@pytest.mark.asyncio
async def test_timeout_enveloppe_erreur_ordinaire(monkeypatch, cfg_map):
    monkeypatch.setattr(cwt.mcp_pool, "call_tool", _slow_call_tool)
    monkeypatch.setattr(cwt, "LLAMA_TOOL_TIMEOUT_S", 0.05)
    res = await cwt._execute_single_tool_call("outil_lent", {}, cfg_map, {})
    parsed = json.loads(res)
    assert parsed["ok"] is False and parsed["error"] == "timeout"
    assert "outil_lent" in parsed["message"]
    # Classée échec d'OUTIL → l'itération ne compte pas comme productive.
    assert cwt._result_is_tool_failure(res) is True


@pytest.mark.asyncio
async def test_override_par_outil_prioritaire(monkeypatch, cfg_map):
    monkeypatch.setattr(cwt.mcp_pool, "call_tool", _slow_call_tool)
    monkeypatch.setattr(cwt, "LLAMA_TOOL_TIMEOUT_S", 3600)   # défaut énorme
    from llm_core.context_config import CTX
    monkeypatch.setitem(CTX._raw, "tools", {"outil_lent": {"timeout_s": 0.05}})
    res = await cwt._execute_single_tool_call("outil_lent", {}, cfg_map, {})
    assert json.loads(res)["error"] == "timeout"              # l'override gagne


@pytest.mark.asyncio
async def test_pas_de_timeout_appel_rapide(monkeypatch, cfg_map):
    monkeypatch.setattr(cwt.mcp_pool, "call_tool", _quick_call_tool)
    monkeypatch.setattr(cwt, "LLAMA_TOOL_TIMEOUT_S", 5)
    res = await cwt._execute_single_tool_call("outil_lent", {}, cfg_map, {})
    assert "timeout" not in res and "vite" in res


@pytest.mark.asyncio
async def test_annulation_utilisateur_traverse(monkeypatch, cfg_map):
    """CancelledError ne doit JAMAIS devenir une enveloppe d'erreur : les
    snapshots partiels et l'anti-rejeu de « Continuer » dépendent de sa
    propagation."""
    monkeypatch.setattr(cwt.mcp_pool, "call_tool", _slow_call_tool)
    monkeypatch.setattr(cwt, "LLAMA_TOOL_TIMEOUT_S", 30)
    task = asyncio.ensure_future(
        cwt._execute_single_tool_call("outil_lent", {}, cfg_map, {})
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_defauts_par_outil_pw_wait_et_desktop_shell():
    # Bornes par-outil dédiées : une attente/commande longue légitime ne doit pas
    # mourir en « timeout outil » au défaut global (300s).
    assert cwt._tool_timeout_s("pw_wait") == 330.0
    assert cwt._tool_timeout_s("desktop_shell") == 610.0
    assert cwt._tool_timeout_s("execute_shell") == 610.0


# ── Pool RÉEL : chronomètre interne + borne de file (AUDIT 2026-08-31) ────


class _StubClient:
    """Client MCP minimal : call_tool contrôlé par le test."""
    def __init__(self, delay=0.0, result="ok"):
        self.delay = delay
        self.result = result
        self.calls = 0

    async def call_tool(self, _name, _args):
        self.calls += 1
        await asyncio.sleep(self.delay)
        return self.result


def _pool_with_entry(client, *, serial=True):
    pool = mp.MCPConnectionPool()
    cfg = {"type": "stdio", "command": "stub-cmd", "name": "stub"}
    key = pool._make_key(cfg)
    entry = mp._PoolEntry(key=key, client=client, healthy=True,
                          tools_fetched_at=1.0, last_used_at=1.0)
    if not serial:
        entry.max_concurrency = 2
        entry.call_sem = asyncio.Semaphore(2)
    pool._pool[key] = entry
    return pool, cfg, entry


@pytest.mark.asyncio
async def test_pool_exec_timeout_interne():
    """Le budget d'exécution est appliqué PAR LE POOL, entrée marquée
    unhealthy, et l'erreur remonte en TimeoutError SANS reconnexion+replay."""
    client = _StubClient(delay=30)
    pool, cfg, entry = _pool_with_entry(client)
    with pytest.raises(asyncio.TimeoutError):
        await pool.call_tool(cfg, "outil_lent", {}, exec_timeout_s=0.05)
    assert entry.healthy is False
    assert client.calls == 1          # pas de replay


@pytest.mark.asyncio
async def test_pool_queue_saturee_erreur_distincte():
    """L'attente en file n'est PAS facturée au budget d'exécution : un appel
    coincé derrière un autre lève MCPQueueSaturated (jamais exécuté)."""
    client = _StubClient(delay=0.5)
    pool, cfg, entry = _pool_with_entry(client)   # sériel : entry.lock
    t1 = asyncio.ensure_future(
        pool.call_tool(cfg, "outil_a", {}, exec_timeout_s=5.0))
    await asyncio.sleep(0.05)                     # t1 tient le verrou
    with pytest.raises(mp.MCPQueueSaturated):
        await pool.call_tool(cfg, "outil_b", {}, exec_timeout_s=5.0,
                             queue_timeout_s=0.05)
    assert client.calls == 1                      # outil_b JAMAIS exécuté
    assert await t1 == "ok"                       # t1 n'a pas été perturbé
    assert entry.healthy is True


@pytest.mark.asyncio
async def test_pool_reconnexion_bornee(monkeypatch):
    """Régression passe 2 — la (re)connexion d'entrée de call_tool doit être
    bornée par queue_timeout_s : un serveur injoignable ne doit plus faire
    attendre l'appelant au-delà du budget, et l'erreur est MCPQueueSaturated
    (l'outil n'a jamais été exécuté)."""
    client = _StubClient()
    pool, cfg, entry = _pool_with_entry(client)
    entry.healthy = False                      # force le chemin (re)connexion

    async def _hang(*_a, **_k):
        await asyncio.sleep(30)

    monkeypatch.setattr(pool, "get_or_connect", _hang)
    with pytest.raises(mp.MCPQueueSaturated):
        await pool.call_tool(cfg, "outil", {}, exec_timeout_s=5.0,
                             queue_timeout_s=0.05)
    assert client.calls == 0                   # jamais exécuté


@pytest.mark.asyncio
async def test_pool_attente_en_file_non_facturee():
    """Un appel qui attend en file plus longtemps que son budget d'EXÉCUTION
    réussit quand même : le chrono ne démarre qu'à l'acquisition."""
    client = _StubClient(delay=0.2)
    pool, cfg, _ = _pool_with_entry(client)
    t1 = asyncio.ensure_future(
        pool.call_tool(cfg, "outil_a", {}, exec_timeout_s=5.0))
    await asyncio.sleep(0.05)
    # Budget d'exécution 0.3 s < attente en file (~0.15 s restants) + exec
    # 0.2 s : sous l'ancien wait_for externe, cet appel expirait.
    res = await pool.call_tool(cfg, "outil_b", {}, exec_timeout_s=0.3,
                               queue_timeout_s=10.0)
    assert res == "ok"
    assert await t1 == "ok"


@pytest.mark.asyncio
async def test_resolution_timeout_config():
    from llm_core.context_config import CTX
    # Sans override → défaut global.
    assert cwt._tool_timeout_s("inconnu") == float(cwt.LLAMA_TOOL_TIMEOUT_S)
    # Valeur invalide dans le JSON → ignorée (défaut global).
    CTX._raw.setdefault("tools", {})["cassé"] = {"timeout_s": "abc"}
    try:
        assert cwt._tool_timeout_s("cassé") == float(cwt.LLAMA_TOOL_TIMEOUT_S)
    finally:
        CTX._raw["tools"].pop("cassé", None)
