# SPDX-License-Identifier: MIT
"""
llm_core/tools/_mcp_error_middleware.py — conformité MCP du flag ``isError``.

Contexte
--------
Le spec MCP (§Error Handling) demande que les *tool execution errors*
(input invalide, erreur métier) soient signalées avec ``isError: true`` dans
le résultat. Nos tools utilisent l'enveloppe applicative ``{ok:false, ...}``
produite par ``_toolkit.err()`` : c'est un retour NORMAL (pas une exception),
que FastMCP seul laisse en ``isError: false`` — un client MCP TIERS verrait
alors ces erreurs comme des succès.

Ce que fait ce middleware
-------------------------
Après l'exécution d'un tool, si le résultat est une enveloppe d'erreur
(``ok is False``), on le ré-émet en ``ToolError`` dont le message EST
l'enveloppe sérialisée. FastMCP construit alors un ``CallToolResult`` avec
``isError: true`` et l'enveloppe JSON dans ``content[0].text``.

On GARDE donc ``{ok:false}`` : l'enveloppe complète (error/message/fix/…)
reste le payload texte — exactement ce que lit l'app via
``engine.tool_dispatch.pick_tool_payload`` (``json.loads(item.text)``) et le
frontend (``_isErrorResult``). Seul le flag protocolaire change, au bénéfice
des clients MCP tiers.

Note : ``ToolResult`` (high-level FastMCP) n'expose pas de champ ``isError`` ;
lever une ``ToolError`` est la voie supportée pour l'armer. La perte du
``structuredContent`` sur le chemin d'erreur est sans impact ici (le payload
est lu depuis ``content[0].text``) et conforme au spec (les exemples d'erreur
du spec utilisent du contenu texte).
"""
from __future__ import annotations

import json
from typing import Any, Optional

from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware


def _error_envelope(result: Any) -> Optional[dict]:
    """Retourne l'enveloppe ``{ok:false,...}`` si le résultat en est une, sinon None."""
    sc = getattr(result, "structured_content", None)
    if isinstance(sc, dict) and sc.get("ok") is False:
        return sc
    # Fallback (dernier recours) : un tool qui renvoie le JSON en texte sans
    # structured_content. On ne parse que si ça ressemble à notre enveloppe.
    content = getattr(result, "content", None) or []
    if content:
        txt = getattr(content[0], "text", None)
        if isinstance(txt, str):
            s = txt.lstrip()
            if s.startswith("{") and '"ok"' in s:
                try:
                    parsed = json.loads(txt)
                except (ValueError, TypeError):
                    return None
                if isinstance(parsed, dict) and parsed.get("ok") is False:
                    return parsed
    return None


class OkFalseAsIsError(Middleware):
    """Arme ``isError: true`` pour toute enveloppe d'erreur ``{ok:false}``,
    en conservant l'enveloppe comme payload (cf. module docstring)."""

    async def on_call_tool(self, context, call_next):
        result = await call_next(context)
        env = _error_envelope(result)
        if env is not None:
            raise ToolError(json.dumps(env, ensure_ascii=False))
        return result
