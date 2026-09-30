# SPDX-License-Identifier: MIT
"""
shared_infra.observability.usage_ctx — Qui consomme, pour le compte de quoi.

Pourquoi ce module existe
=========================
Historiquement, la consommation de tokens était mesurée **par l'appelant** :
la route de chat lisait les métriques du tour et les journalisait. Or seul
l'appelant interactif était instrumenté. Résultat : tout ce qui tourne sans
navigateur — routines planifiées, webhooks entrants, sous-agents — brûlait des
tokens qu'aucune vue ne voyait. « Le suivi hors heures de bureau n'est pas
assuré » n'était pas un manque de widget : c'était le point de mesure placé au
mauvais étage.

On inverse donc la responsabilité : **la boucle mesure, l'appelant se nomme.**
Chaque point d'entrée ouvre un ``usage_scope(...)`` qui dit qui il est ; la
boucle LLM, elle, appelle ``record_turn_usage()`` en fin de tour, sans rien
savoir de son appelant. Un chemin qui oublierait d'ouvrir un scope ne disparaît
pas des vues : il y apparaît en ``source="unknown"`` — visible, donc corrigeable.

Propagation
===========
Un ``ContextVar`` suit naturellement ``await``, ``asyncio.create_task`` (le
contexte est copié à la création de la tâche) et ``asyncio.to_thread``. Les
sous-agents, lancés en tâches filles, héritent donc du scope parent : ils
ouvrent leur propre scope imbriqué (``source="subagent"``, ``parent_id`` =
l'origine du tour parent) pour rester rattachables à la conversation qui les a
déclenchés.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Dict, Iterator, Optional

logger = logging.getLogger("uvicorn.error")


@dataclass(frozen=True)
class UsageContext:
    """Identité de l'appelant courant, du point de vue de la consommation."""
    source: str = "unknown"
    user_id: Optional[int] = None
    origin_id: str = ""      # chat_id, clé de run de routine, id d'enfant…
    parent_id: str = ""      # tour parent (sous-agents)


_UNKNOWN = UsageContext()          # figé : un seul défaut partagé sans risque
_CTX: ContextVar[UsageContext] = ContextVar("usage_ctx", default=_UNKNOWN)


def current_usage_ctx() -> UsageContext:
    return _CTX.get()


@contextlib.contextmanager
def usage_scope(
    source: str,
    *,
    user_id: Optional[int] = None,
    origin_id: str = "",
    parent_id: str = "",
    inherit_user: bool = True,
) -> Iterator[UsageContext]:
    """Déclare l'appelant pour la durée du bloc.

    ``inherit_user`` : un scope imbriqué qui ne connaît pas l'ID (un sous-agent
    ne manipule qu'un username) garde celui du parent plutôt que de retomber
    sur ``None`` — la conso resterait sinon non attribuée. Sans ``origin_id``,
    le scope garde l'origine (et le parent) de l'appelant : une compaction
    reste rattachée à la conversation qu'elle résume.
    """
    prev = _CTX.get()
    ctx = UsageContext(
        source=(source or "unknown").strip() or "unknown",
        user_id=user_id if user_id is not None else (prev.user_id if inherit_user else None),
        origin_id=str(origin_id or prev.origin_id or ""),
        parent_id=str(parent_id or ("" if origin_id else prev.parent_id) or ""),
    )
    token = _CTX.set(ctx)
    try:
        yield ctx
    finally:
        _CTX.reset(token)


def set_usage_context(
    source: str,
    *,
    user_id: Optional[int] = None,
    origin_id: str = "",
    parent_id: str = "",
):
    """Pose le scope sans bloc ``with``, pour les fonctions trop longues à
    ré-indenter. Même idiome que ``set_llm_target`` : le contexte est isolé par
    tâche de requête, il meurt avec elle — pas de fuite entre utilisateurs.
    Retourne le token (``reset`` possible, rarement utile)."""
    return _CTX.set(UsageContext(
        source=(source or "unknown").strip() or "unknown",
        user_id=user_id,
        origin_id=str(origin_id or ""),
        parent_id=str(parent_id or ""),
    ))


def normalize_usage(usage: Any) -> Dict[str, int]:
    """Extrait les compteurs réels d'un ``usage`` backend (forme OpenAI).

    ``cache_read_input_tokens`` / ``cache_creation_input_tokens`` sont posés
    en amont : par ``providers/anthropic.py`` (NON inclus dans
    ``prompt_tokens``) et, pour llama.cpp et les moteurs compatibles, par
    ``providers/llamacpp.py`` (jetons repris du cache KV, INCLUS dans
    ``prompt_tokens``) — gardés à part dans les deux cas.
    """
    u = usage if isinstance(usage, dict) else {}

    def _n(key: str) -> int:
        try:
            v = int(u.get(key) or 0)
        except (TypeError, ValueError):
            return 0
        return v if v > 0 else 0

    det = u.get("completion_tokens_details")
    reasoning = 0
    if isinstance(det, dict):
        try:
            reasoning = max(0, int(det.get("reasoning_tokens") or 0))
        except (TypeError, ValueError):
            reasoning = 0
    return {
        "input_tokens": _n("prompt_tokens") or _n("input_tokens"),
        "output_tokens": _n("completion_tokens") or _n("output_tokens"),
        "cache_read_tokens": _n("cache_read_input_tokens"),
        "cache_creation_tokens": _n("cache_creation_input_tokens"),
        # Part de raisonnement DÉCLARÉE par le backend (o-series, vLLM…) —
        # sous-ensemble de ``output_tokens``, jamais additionnée à lui. Les
        # appelants qui la mesurent eux-mêmes (llama.cpp reste muet) la
        # passent explicitement et priment sur cette lecture.
        "thinking_tokens": reasoning,
    }


def record_turn_usage(
    *,
    usage: Any = None,
    model: str = "",
    path: str = "",
    connector: str = "",
    duration_ms: Any = 0,
    iterations: Any = 0,
    status: str = "ok",
    error_kind: str = "",
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    submitted_tokens: Optional[int] = None,
    thinking_tokens: Optional[int] = None,
) -> bool:
    """Enregistre UN tour LLM dans le registre, avec le contexte courant.

    ``input_tokens``/``output_tokens`` explicites priment sur ``usage`` : en
    mode outils, le tour cumule plusieurs requêtes et la boucle possède déjà
    les totaux (``cumul_in``/``cumul_out``), qui sont la vérité de facturation.

    ``thinking_tokens`` : part de RAISONNEMENT, sous-ensemble de la sortie (elle
    n'y est pas ajoutée). Mesurée par la boucle (cf. ``llm_core._think_tokens``)
    parce qu'aucun backend local ne la déclare ; le paramètre explicite prime
    donc sur ce que ``usage`` pourrait en dire.

    ``connector`` vide : clé du moteur visé par l'appel en cours
    (``llm_core.engines.current_engine``). Le tour est aussi versé à
    l'exécution courante (``runs``), dont il porte l'identifiant.

    Best-effort de bout en bout : jamais d'exception vers la boucle de chat.
    """
    try:
        from shared_infra.observability.runs import current_run
        from shared_infra.observability.usage_store import record_usage
    except Exception:
        return False
    ctx = _CTX.get()
    if not connector:
        connector = _engine_key()
    norm = normalize_usage(usage)
    in_t = norm["input_tokens"] if input_tokens is None else max(0, int(input_tokens or 0))
    out_t = norm["output_tokens"] if output_tokens is None else max(0, int(output_tokens or 0))
    think_t = norm["thinking_tokens"] if thinking_tokens is None \
        else max(0, int(thinking_tokens or 0))
    # Invariant du registre : réflexion ⊆ sortie. Une mesure estimée trop
    # généreuse rendrait « réponse = sortie − réflexion » négative dans les vues.
    if out_t:
        think_t = min(think_t, out_t)
    run = current_run()
    if run is not None:
        run.add_usage(source=ctx.source, status=status, input_tokens=in_t,
                      output_tokens=out_t, cache_read_tokens=norm["cache_read_tokens"],
                      cache_creation_tokens=norm["cache_creation_tokens"],
                      thinking_tokens=think_t, error_kind=error_kind)
    kwargs = dict(
        run_id=run.id if run is not None else "",
        user_id=ctx.user_id,
        source=ctx.source,
        origin_id=ctx.origin_id,
        parent_id=ctx.parent_id,
        model=model,
        connector=connector,
        path=path,
        input_tokens=in_t,
        output_tokens=out_t,
        submitted_tokens=in_t if submitted_tokens is None else submitted_tokens,
        thinking_tokens=think_t,
        cache_read_tokens=norm["cache_read_tokens"],
        cache_creation_tokens=norm["cache_creation_tokens"],
        duration_ms=duration_ms,
        iterations=iterations,
        status=status,
        error_kind=error_kind,
    )
    # AUDIT 2026-09-25 — appelé depuis la boucle d'événements (fin de tour de
    # chat, compresseur, sous-agents), l'INSERT SQLite synchrone pouvait geler
    # TOUT le worker jusqu'au ``busy_timeout`` (10 s) sous contention du verrou
    # WAL — au moment précis où le client attend son dernier event. Le
    # contexte (qui consomme) est déjà lu ci-dessus : l'écriture seule part
    # dans un thread, sans attente. Hors boucle (tests, threads) : synchrone.
    try:
        _loop = asyncio.get_running_loop()
    except RuntimeError:
        _loop = None
    if _loop is not None:
        try:
            _loop.run_in_executor(None, _record_usage_quiet, record_usage, kwargs)
            return True
        except RuntimeError:            # boucle en fermeture : repli synchrone
            pass
    return _record_usage_quiet(record_usage, kwargs)


def _engine_key() -> str:
    """``builtin``, ``conn:<id>`` ou ``url:<racine>`` : le moteur de l'appel."""
    try:
        from llm_core.engines import current_engine
        return str(current_engine().key or "")
    except Exception:                                           # noqa: BLE001
        return ""


def _record_usage_quiet(record_usage, kwargs) -> bool:
    try:
        return bool(record_usage(**kwargs))
    except Exception:
        logger.debug("[usage] record_turn_usage failed (non-fatal)", exc_info=True)
        return False
