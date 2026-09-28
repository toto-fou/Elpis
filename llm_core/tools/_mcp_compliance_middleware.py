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

Ajoutés une seule fois au niveau du serveur (server/local_mcp_server.py) →
couvrent tous les tools et tous les transports, sans toucher aux tools.
"""
from __future__ import annotations

import os
from collections import defaultdict
from typing import Optional

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
