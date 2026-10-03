# SPDX-License-Identifier: MIT
"""
backend.services._scheduling._guard — Two-level scheduling context manager.

Combines the two scheduling primitives into a single ``async with`` block
that the chat / pipeline call sites use:

    async with llm_scheduling_guard(model, use_mcp_path=True):
        # safe to call llama-server; this block holds the model lock
        # AND (if not in optimized MCP path) the per-model semaphore.
        ...

What it does
------------
1. Takes ``MODEL_EXCLUSIVITY`` for the target model with the requested
   priority (``high`` for chats, ``low`` for pipelines). This blocks
   model switches while a stream is in flight, while letting same-model
   requests run in parallel.

2. Optionally takes ``LLM_SEMAPHORE`` for per-model parallelism. Skipped
   when ``use_mcp_path`` is True and the resolved scheduling mode is
   ``optimized``: in that mode the multi-MCP runner takes the semaphore
   inline around each LLM call (slot freed during tool execution).

Also defines ``_emit`` — a tiny safe wrapper around the optional
``on_event`` callback used by every streaming code path. Lives here
because it's a pure utility called by ``_chat_with_tools`` (which itself
imports from this module).
"""
from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable, Dict, Optional

import httpx

from llm_core._capabilities import resolve_scheduling_mode
from llm_core._scheduling import _breaker
from llm_core._scheduling._concurrency import LLM_SEMAPHORE
from llm_core._scheduling._locks import MODEL_EXCLUSIVITY

# Échecs de TRANSPORT (llama-server down/figé) qui alimentent le disjoncteur.
# Les autres erreurs (métier, validation, annulation) ne comptent PAS.
_BREAKER_TRANSPORT_ERRORS = (
    httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.PoolTimeout,
)

# Type alias historically defined in _legacy.py — kept here so ``OnEvent``
# remains importable from ``backend.services``.
OnEvent = Optional[Callable[[Dict[str, Any]], Awaitable[None]]]

# Cadence du compte rendu d'attente (cf. _reported_acquire) : un premier
# message assez tôt pour que l'écran ne reste pas muet, puis un rappel
# régulier — l'attente derrière une mission longue se compte en heures.
WAIT_REPORT_FIRST_S = 3.0
WAIT_REPORT_PERIOD_S = 10.0


class LLMQueueAborted(Exception):
    """L'attente d'un modèle occupé a été interrompue à la demande de l'user."""


@asynccontextmanager
async def _reported_acquire(cm, *, model: Optional[str], on_wait, cancel_probe,
                            first_delay: float, period: float):
    """Entre dans ``cm`` en RENDANT COMPTE de l'attente, et en l'abandonnant
    si l'utilisateur le demande.

    AUDIT 2026-08-22 (D2) — l'acquisition de l'exclusivité modèle n'avait ni
    borne, ni voix. Un utilisateur qui demandait un AUTRE modèle pendant qu'une
    mission autonome tenait le modèle courant restait suspendu — sans message,
    sans position, sans échéance, et sans moyen d'abandonner : ni le timeout
    gunicorn (le worker n'est pas bloqué, il attend), ni le Stop (qui ne
    regardait pas cette attente) ne le sortaient de là. Le run en cours, lui,
    n'est jamais préempté : le lui retirer forcerait un rechargement de modèle
    et détruirait son cache KV — c'est justement ce que l'exclusivité protège.
    """
    enter_task = asyncio.ensure_future(cm.__aenter__())
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    next_report = first_delay
    try:
        while True:
            done, _ = await asyncio.wait({enter_task}, timeout=0.25)
            if done:
                break
            waited = loop.time() - t0
            if cancel_probe is not None:
                try:
                    aborted = bool(cancel_probe())
                except Exception:                               # noqa: BLE001
                    aborted = False
                if aborted:
                    enter_task.cancel()
                    # On attend l'unwind : les deux implémentations de verrou
                    # décrémentent leur inscription « high en attente » dans un
                    # ``except BaseException`` — ne pas l'attendre laisserait ce
                    # compteur en l'air et gèlerait les acquisitions « low ».
                    await asyncio.wait({enter_task}, timeout=5.0)
                    raise LLMQueueAborted(
                        "attente du modèle interrompue à votre demande")
            if on_wait is not None and waited >= next_report:
                next_report = waited + period
                try:
                    await on_wait(waited)
                except Exception:                               # noqa: BLE001
                    pass
        exc = enter_task.exception()
        if exc is not None:
            raise exc
    except BaseException:
        if not enter_task.done():
            enter_task.cancel()
            await asyncio.wait({enter_task}, timeout=5.0)
        # L'entrée a pu ABOUTIR dans le même tour de boucle que l'annulation
        # (ou que l'abandon) : sans sortie, le verrou restait pris — et un
        # créneau partagé l'est pour tous les process de la machine.
        if enter_task.done() and not enter_task.cancelled() \
                and enter_task.exception() is None:
            try:
                await cm.__aexit__(None, None, None)
            except Exception:                                   # noqa: BLE001
                pass
        raise
    try:
        yield
    except BaseException:
        if not await cm.__aexit__(*sys.exc_info()):
            raise
    else:
        await cm.__aexit__(None, None, None)


@asynccontextmanager
async def llm_scheduling_guard(
    model: Optional[str],
    use_mcp_path: bool,
    priority: str = "high",
    *,
    target: Any = None,
    on_wait: Optional[Callable[[float], Awaitable[None]]] = None,
    cancel_probe: Optional[Callable[[], bool]] = None,
):
    """Context manager 2 niveaux qui gère le scheduling LLM complet.

    Niveau 1 — ``MODEL_EXCLUSIVITY`` :
        Empêche un switch de modèle côté llama-server pendant qu'une
        génération est en cours. Les requêtes sur le MÊME modèle se
        parallélisent ; celles sur des modèles DIFFÉRENTS sont mises
        en file jusqu'à ce que le modèle actif soit totalement libre.

        La priorité (``high`` / ``low``) départage les acquires en
        attente : un ``high`` (chat user) passe avant un ``low``
        (pipeline batch) même s'il est arrivé plus tard. Les acquires
        actifs ne sont jamais interrompus — c'est une garantie d'ORDRE,
        pas de préemption.

    Niveau 2 — ``LLM_SEMAPHORE`` (dans certains modes) :
        Limite le nombre d'appels LLM simultanés par modèle au nombre
        de slots. En mode "optimized" sur chemin MCP, ce niveau est
        délégué à ``run_chat_multi_mcp_v2`` qui prend le sémaphore
        INLINE autour de chaque appel LLM seulement (pas pendant les
        tool calls).

    :param priority: "high" pour les chats interactifs (défaut),
                     "low" pour les pipelines / runs agentic.

    Utilisation :

        async with llm_scheduling_guard(model, use_mcp_path=True, priority="low"):
            # sécurisé contre les switches de modèle + les saturations,
            # cède la main au chat si nécessaire
            ...
    """
    # Disjoncteur LLM (fail-safe) : si llama-server est jugé down (échecs transport
    # consécutifs), on échoue VITE ici au lieu d'acquérir un slot puis d'attendre le
    # read-timeout. ``allow`` ne lève que LLMCircuitOpen (capté par les routes comme
    # une erreur de génération) ; tout bug interne du breaker laisse passer.
    # AUDIT 2026-08-22 (D1) — ORDONNANCEUR = RESSOURCE LOCALE. Les deux
    # niveaux (exclusivité de modèle, parallélisme par slots) et le disjoncteur
    # décrivent UN llama-server : un seul modèle en VRAM, ``-np`` slots, une
    # santé de transport. Une cible distante (Anthropic, OpenAI, vLLM…) n'a
    # rien de tout cela — l'y soumettre faisait tenir l'exclusivité du modèle
    # LOCAL, pendant des heures, à un run qui n'envoie pas un octet au moteur
    # local : tous les utilisateurs locaux étaient bloqués derrière un run
    # cloud (et une panne côté cloud ouvrait le disjoncteur local).
    #
    # AUDIT 2026-09-16 — « locale » devient « PROPRE AU SERVEUR ». Un
    # connecteur llama.cpp a désormais son propre ordonnanceur (exclusivité,
    # slots, disjoncteur — cf. ``_scheduling._engines``) ; seules les cibles
    # qui ne sont pas llama.cpp (cloud, vLLM, générique) sautent toujours les
    # deux niveaux.
    from llm_core._scheduling._engines import breaker_key, scheduling_for
    from llm_core.engines import current_engine, engine_for_target
    _engine = engine_for_target(target) if target is not None else current_engine()
    if not _engine.is_llamacpp:
        yield
        return
    # Intégré : les singletons de CE module (points d'injection historiques,
    # remplacés tels quels par les tests) ; connecteur : sa paire dédiée.
    if _engine.is_builtin:
        _excl_lock, _sem_mgr = MODEL_EXCLUSIVITY, LLM_SEMAPHORE
    else:
        _excl_lock, _sem_mgr = scheduling_for(_engine)
    _bkey = breaker_key(_engine, model, target)

    _breaker.allow(_bkey)
    # AUDIT 2026-08-23 — les chemins de génération ne LÈVENT pas d'httpx brut
    # (classic RETOURNE son erreur, le chemin outils lève un LLMFailure que la
    # boucle attrape) : ils nourrissent désormais le disjoncteur eux-mêmes.
    # On mémorise la génération d'AVANT pour que le ``record_success`` du
    # ``finally`` — qui voit un tour « réussi » dans les deux cas — n'efface
    # pas la panne que le tour vient d'enregistrer.
    _breaker_gen = _breaker.generation(_bkey)
    _llm_ok = False
    try:
        _excl = _excl_lock.acquire_for(model, priority=priority)
        async with _reported_acquire(
                _excl, model=model, on_wait=on_wait, cancel_probe=cancel_probe,
                first_delay=WAIT_REPORT_FIRST_S, period=WAIT_REPORT_PERIOD_S):
            mode = resolve_scheduling_mode()
            if use_mcp_path and mode == "optimized":
                # v2 gère son propre sémaphore ; ne pas wrapper ici.
                yield
            else:
                _sem = _sem_mgr.acquire_for(model, priority=priority)
                async with _reported_acquire(
                        _sem, model=model, on_wait=on_wait,
                        cancel_probe=cancel_probe,
                        first_delay=WAIT_REPORT_FIRST_S,
                        period=WAIT_REPORT_PERIOD_S):
                    yield
        _llm_ok = True
    except _BREAKER_TRANSPORT_ERRORS:
        # llama-server down/figé → alimente le disjoncteur, puis propage.
        _breaker.record_failure(_bkey)
        raise
    finally:
        # Succès (génération terminée sans erreur transport) → reset du compteur.
        # NB : on ne traite PAS CancelledError / erreurs métier comme une panne LLM.
        if _llm_ok:
            _breaker.record_success(_bkey, since_generation=_breaker_gen)

async def _emit(on_event: OnEvent, ev: Dict[str, Any]) -> None:
    if not on_event:
        return
    try:
        await on_event(ev)
    except Exception:
        return
