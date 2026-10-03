# SPDX-License-Identifier: MIT
"""
llm_core/tools/_mcp_compliance_middleware.py — middlewares de conformité MCP.

Couvre les points #2 et #3 de docs/mcp-compliance-2026-06-05.md :

  #2  ToolRateLimit — rate-limit des invocations de tools. Le spec MCP
      (§Security, « Servers MUST: Rate limit tool invocations ») l'exige.
      Token-bucket par **(utilisateur, tool)** ; l'identité est extraite
      best-effort du ``_meta`` out-of-band (fallback per-tool si absente).
      Backstop anti-runaway, large par défaut (n'impacte pas l'usage normal).
      Configurable / désactivable par env.

  #3  TitleFiller — remplit le ``title`` d'affichage manquant d'un tool à
      partir d'un Title-Case de son ``name`` (le spec rend ``title`` optionnel
      mais recommandé pour l'affichage ; la plupart de nos tools l'omettaient).

  ToolConcurrencyLimit — appels simultanés plafonnés (au total et par compte),
      attente bornée puis erreur claire ; dimensionne aussi le pool de threads
      où tournent les outils synchrones (2026-10-03).

Ajoutés une seule fois au niveau du serveur (server/local_mcp_server.py) →
couvrent tous les tools et tous les transports, sans toucher aux tools.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import defaultdict
from typing import Dict, Optional

from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware
from fastmcp.server.middleware.rate_limiting import (
    RateLimitError,
    TokenBucketRateLimiter,
)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


# ── #2 — rate limiting ───────────────────────────────────────────────
# Large par défaut : un appel de tool est I/O-bound (fs/subprocess/réseau),
# bien plus lent que 20/s pour un MÊME (user, tool). C'est un garde-fou
# anti-emballement, pas un throttle de l'usage légitime. RPS<=0 → désactivé.
RATE_RPS = _env_float("MCP_TOOL_RATE_LIMIT_RPS", 20.0)
RATE_BURST = _env_int("MCP_TOOL_RATE_LIMIT_BURST", 0) or int(max(1.0, RATE_RPS) * 2)


def _user_from_ctx(context) -> Optional[str]:
    """Extraction défensive du username depuis le ``_meta`` de la requête.

    AUDIT 2026-08-23 — ce helper ne lisait QUE ``context.message.meta``, et
    rendait donc ``None`` à tous les coups : depuis fastmcp 2.14,
    ``_call_tool_middleware`` RECONSTRUIT le message
    (``CallToolRequestParams(name=…, arguments=…)``) sans ``_meta``, quoi que
    le client ait envoyé. Le seau de jetons devenait ``"*::<tool>"`` — un seul
    pour TOUS les comptes, alors que la classe annonce « par (utilisateur,
    tool) » : la rafale d'un compte faisait alors refuser l'outil aux autres.

    L'identité arrive bien, mais par l'autre chemin —
    ``ctx.request_context.meta`` — celui qu'utilisent déjà ``get_username`` et
    tout le reste de la couche outils. On le lit d'abord, et on garde
    ``context.message.meta`` en repli pour une release qui propagerait le meta.
    """
    try:
        # (2026-09-02) client EXTERNE authentifié par jeton : le seau est
        # celui du compte lié au jeton, pas du meta auto-déclaré.
        from llm_core.tools._toolkit import _read_meta_field, _token_identity
        _tid = _token_identity()
        if _tid:
            return _tid
        fctx = getattr(context, "fastmcp_context", None)
        if fctx is not None:
            v = _read_meta_field(fctx, "username")
            if v:
                return v
        msg = getattr(context, "message", None)
        meta = getattr(msg, "meta", None)
        if meta is None:
            return None
        v = meta.get("username") if isinstance(meta, dict) else getattr(meta, "username", None)
        return str(v) if v else None
    except Exception:
        return None


class ToolRateLimit(Middleware):
    """Token-bucket par (utilisateur, tool). Lève ``RateLimitError`` (erreur
    protocole MCP) au-delà du débit. Désactivé si ``rps <= 0``."""

    def __init__(self, rps: float = RATE_RPS, burst: int = RATE_BURST):
        self._rps = rps
        self._burst = max(1, int(burst))
        self._buckets = defaultdict(
            lambda: TokenBucketRateLimiter(self._burst, self._rps)
        )

    async def on_call_tool(self, context, call_next):
        if self._rps > 0:
            user = _user_from_ctx(context) or "*"
            tool = getattr(getattr(context, "message", None), "name", "?")
            if not await self._buckets[f"{user}::{tool}"].consume():
                raise RateLimitError(f"Rate limit exceeded for tool {tool!r}")
        return await call_next(context)


# ── Concurrence du service d'outils (2026-10-03) ─────────────────────
# Les outils synchrones (``execute_shell``, git, fichiers…) tournent dans le
# pool de threads anyio de la boucle, 40 par défaut et PARTAGÉ avec les routes
# HTTP synchrones du service (API sandbox de l'éditeur) et la vérification des
# jetons. Sans plafond, quarante ``execute_shell`` longs (jusqu'à 610 s)
# figeaient tout le service, et un seul compte pouvait les lancer. Le plafond
# global reste sous la taille du pool pour garder des threads à ces routes.
TOOL_THREADS = _env_int("MCP_TOOL_THREADS", 64)
CONC_MAX = _env_int("MCP_TOOL_MAX_CONCURRENT", 48)
CONC_PER_USER = _env_int("MCP_TOOL_MAX_CONCURRENT_PER_USER", 12)
# Attente courte : l'app n'annonce pas l'abandon d'un appel (Stop, délai) au
# service, et un appel encore en file partirait quand même à sa place.
CONC_WAIT_S = _env_float("MCP_TOOL_QUEUE_WAIT_S", 30.0)
_POOL_MARGIN = 8
_POLL_S = 0.05

logger = logging.getLogger("uvicorn.error")


def apply_thread_pool_size(threads: int = TOOL_THREADS) -> None:
    """Pose la taille du pool de threads anyio de la boucle COURANTE (il y en a
    un par boucle). ``threads <= 0`` : défaut d'anyio gardé."""
    if threads <= 0:
        return
    import anyio.to_thread
    limiter = anyio.to_thread.current_default_thread_limiter()
    if limiter.total_tokens != threads:
        limiter.total_tokens = threads


class ToolConcurrencyLimit(Middleware):
    """Plafonne les appels d'outils simultanés : ``max_total`` au total,
    ``max_per_user`` par compte (sans identité : le total seul). Au-delà,
    l'appel attend au plus ``wait_s`` dans une file bornée (deux fois le total,
    et ``max_per_user`` appels en attente par compte : un compte ne remplit pas
    la file des autres), puis échoue avec une erreur d'outil lisible par le
    modèle. ``<= 0`` désactive un plafond.

    Compteurs simples sondés sur la boucle plutôt qu'un sémaphore asyncio :
    l'instance est posée une fois sur le service et ne doit pas se lier à une
    boucle (les tests en ouvrent plusieurs)."""

    def __init__(self, max_total: int = CONC_MAX, max_per_user: int = CONC_PER_USER,
                 wait_s: float = CONC_WAIT_S, threads: int = TOOL_THREADS):
        self._max_total = max_total
        self._max_user = max_per_user
        self._wait_s = max(0.0, wait_s)
        self._threads = threads
        self._queue_max = 2 * max_total if max_total > 0 else 256
        self._running = 0
        self._by_user: Dict[str, int] = {}
        self._waiting = 0
        self._waiting_by_user: Dict[str, int] = {}
        self._sized_loop: Optional[int] = None
        if threads > 0 and max_total > threads - _POOL_MARGIN:
            logger.warning("[toolhost] MCP_TOOL_MAX_CONCURRENT=%d laisse moins de %d threads sur %d "
                           "aux routes du service", max_total, _POOL_MARGIN, threads)

    def _free(self, user: str) -> bool:
        if self._max_total > 0 and self._running >= self._max_total:
            return False
        return not (user and self._max_user > 0 and self._by_user.get(user, 0) >= self._max_user)

    def _busy(self, user: str) -> str:
        if user and self._max_user > 0 and self._by_user.get(user, 0) >= self._max_user:
            return (f"Too many tool calls running for this account ({self._max_user} at once); "
                    "wait for the running ones (e.g. a long execute_shell) to finish, then retry.")
        return (f"Tool host busy ({self._running} tool calls running for all users); "
                "retry in a moment.")

    async def on_call_tool(self, context, call_next):
        loop_id = id(asyncio.get_running_loop())
        if self._sized_loop != loop_id:
            self._sized_loop = loop_id
            apply_thread_pool_size(self._threads)
        if self._max_total <= 0 and self._max_user <= 0:
            return await call_next(context)
        user = _user_from_ctx(context) or ""
        if not self._free(user):
            queued = self._waiting_by_user.get(user, 0) if user else 0
            if self._waiting >= self._queue_max or (
                    user and self._max_user > 0 and queued >= self._max_user):
                raise ToolError(self._busy(user))
            self._waiting += 1
            if user:
                self._waiting_by_user[user] = queued + 1
            deadline = time.monotonic() + self._wait_s
            try:
                while not self._free(user):
                    if time.monotonic() >= deadline:
                        raise ToolError(self._busy(user))
                    await asyncio.sleep(_POLL_S)
            finally:
                self._waiting -= 1
                if user:
                    left = self._waiting_by_user.get(user, 0) - 1
                    if left > 0:
                        self._waiting_by_user[user] = left
                    else:
                        self._waiting_by_user.pop(user, None)
        self._running += 1
        if user:
            self._by_user[user] = self._by_user.get(user, 0) + 1
        try:
            return await call_next(context)
        finally:
            self._running -= 1
            if user:
                left = self._by_user.get(user, 0) - 1
                if left > 0:
                    self._by_user[user] = left
                else:
                    self._by_user.pop(user, None)


# ── #3 — title filler ────────────────────────────────────────────────
def _titleize(name: str) -> str:
    return (name or "").replace("_", " ").strip().title() or (name or "")


class TitleFiller(Middleware):
    """Remplit le ``title`` d'affichage manquant (Title-Case du ``name``).
    Idempotent ; n'écrase jamais un title déjà défini."""

    async def on_list_tools(self, context, call_next):
        tools = await call_next(context)
        for t in tools:
            try:
                # Un titre peut venir du champ `title` OU de `annotations.title`
                # (to_mcp_tool utilise le 1er, sinon le 2nd). On ne remplit QUE
                # si aucun des deux n'est défini — sinon on écraserait un titre
                # explicite fourni par le tool.
                ann = getattr(t, "annotations", None)
                has_title = bool(getattr(t, "title", None)) or bool(
                    ann is not None and getattr(ann, "title", None)
                )
                if not has_title:
                    t.title = _titleize(getattr(t, "name", "") or "")
            except Exception:
                pass
        return tools
