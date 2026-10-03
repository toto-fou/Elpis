# SPDX-License-Identifier: MIT
"""Plafond d'appels simultanés du service d'outils (lot 3, 2026-10-03).

Avant : aucun plafond ; les outils synchrones partageaient les 40 threads anyio
avec les routes HTTP du service, et un seul compte pouvait les occuper tous.
"""
from __future__ import annotations

import asyncio
import time

from fastmcp import Client, FastMCP

from llm_core.tools._mcp_compliance_middleware import ToolConcurrencyLimit


def _serveur(limite: ToolConcurrencyLimit, duree: float = 0.3) -> FastMCP:
    mcp = FastMCP("t")
    mcp.add_middleware(limite)

    @mcp.tool
    async def lent() -> dict:
        await asyncio.sleep(duree)
        return {"ok": True}

    @mcp.tool
    def bloquant() -> dict:
        time.sleep(duree)
        return {"ok": True}

    return mcp


async def _appel(c: Client, user: str = "", outil: str = "lent"):
    meta = {"username": user} if user else None
    return await c.call_tool(outil, {}, raise_on_error=False, meta=meta)


async def test_au_dela_du_plafond_global_l_appel_attend_puis_echoue():
    limite = ToolConcurrencyLimit(max_total=2, max_per_user=0, wait_s=0.1, threads=0)
    async with Client(_serveur(limite)) as c:
        r = await asyncio.gather(*(_appel(c) for _ in range(3)))
    erreurs = [x for x in r if x.is_error]
    assert len(erreurs) == 1
    assert "busy" in erreurs[0].content[0].text
    assert limite._running == 0 and limite._waiting == 0


async def test_l_attente_bornee_suffit_quand_un_appel_se_libere():
    limite = ToolConcurrencyLimit(max_total=1, max_per_user=0, wait_s=5, threads=0)
    async with Client(_serveur(limite, duree=0.2)) as c:
        t0 = time.monotonic()
        r = await asyncio.gather(_appel(c), _appel(c))
        duree = time.monotonic() - t0
    assert not any(x.is_error for x in r)
    assert duree >= 0.4                       # le second a attendu le premier


async def test_plafond_par_compte_n_affecte_pas_les_autres():
    limite = ToolConcurrencyLimit(max_total=10, max_per_user=1, wait_s=0.1, threads=0)
    async with Client(_serveur(limite)) as c:
        r = await asyncio.gather(_appel(c, "alice"), _appel(c, "alice"), _appel(c, "bob"))
    assert [x.is_error for x in r].count(True) == 1
    assert r[2].is_error is False             # bob passe
    assert "this account" in [x for x in r if x.is_error][0].content[0].text


async def test_sans_identite_seul_le_plafond_global_compte():
    limite = ToolConcurrencyLimit(max_total=10, max_per_user=1, wait_s=0.1, threads=0)
    async with Client(_serveur(limite)) as c:
        r = await asyncio.gather(_appel(c), _appel(c), _appel(c))
    assert not any(x.is_error for x in r)


async def test_file_pleine_refus_immediat():
    limite = ToolConcurrencyLimit(max_total=1, max_per_user=0, wait_s=5, threads=0)
    limite._queue_max = 1
    async with Client(_serveur(limite, duree=0.4)) as c:
        t0 = time.monotonic()
        r = await asyncio.gather(_appel(c), _appel(c), _appel(c))
        assert time.monotonic() - t0 < 1.5
    assert [x.is_error for x in r].count(True) == 1


async def test_pool_de_threads_dimensionne_et_outils_synchrones_paralleles():
    import anyio.to_thread

    limite = ToolConcurrencyLimit(max_total=0, max_per_user=0, threads=50)
    async with Client(_serveur(limite, duree=0.3)) as c:
        t0 = time.monotonic()
        r = await asyncio.gather(*(_appel(c, outil="bloquant") for _ in range(45)))
        duree = time.monotonic() - t0
    assert not any(x.is_error for x in r)
    assert anyio.to_thread.current_default_thread_limiter().total_tokens == 50
    assert duree < 0.6                        # 45 > 40 : tous en parallèle


def test_service_reel_porte_le_plafond():
    import server.local_mcp_server as S

    assert any(isinstance(m, ToolConcurrencyLimit) for m in S.mcp.middleware)


async def test_un_compte_ne_remplit_pas_la_file_des_autres():
    """Relecture 2026-10-03 : les appels d'alice bloqués par SON plafond
    remplissaient la file commune, et carol était refusée sans attendre."""
    limite = ToolConcurrencyLimit(max_total=2, max_per_user=1, wait_s=2, threads=0)
    limite._queue_max = 4
    async with Client(_serveur(limite, duree=0.3)) as c:
        alice = [asyncio.ensure_future(_appel(c, "alice")) for _ in range(5)]
        bob = asyncio.ensure_future(_appel(c, "bob"))
        await asyncio.sleep(0.1)
        assert limite._waiting_by_user.get("alice") == 1     # 1 en cours, 1 en file
        carol = await _appel(c, "carol")                     # attend la place de bob
        r_alice = await asyncio.gather(*alice)
        await bob
    assert carol.is_error is False
    assert [x.is_error for x in r_alice].count(True) == 3    # refusés tout de suite
    assert limite._waiting == 0 and limite._waiting_by_user == {}
