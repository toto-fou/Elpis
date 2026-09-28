# SPDX-License-Identifier: MIT
"""llm_core/tools/app_mcp.py — MCP INTERNE de l'app (``elpis-app``, 2026-09-12, P4).

Les familles liées au COMPTE (``memory``, ``todo``, ``chart``, ``skill`` =
bibliothèque de skills) écrivent dans la base de l'app : elles ne partent pas
sur un hôte d'outils distant. Quand ``mcp.json`` déclare une entrée
``role: app`` (``type: inprocess``), la boucle de chat les sert DEPUIS SON
PROPRE PROCESSUS, par le transport en mémoire de fastmcp — même protocole,
même injection d'identité (``_meta``), zéro réseau.

Une instance par ensemble de familles, construite à la demande et gardée pour
la vie du worker. Les outils sont les mêmes modules que sur le service
d'outils (``llm_core/tools/*``) ; l'enregistrement passe par
``server.local_mcp_server.register_families_on`` (annotations matérialisées,
famille notée, politique ``meta.policy``).
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Sequence, Tuple

logger = logging.getLogger("uvicorn.error")

_lock = threading.Lock()
_instances: Dict[Tuple[str, ...], Any] = {}


def get_app_mcp(families: Sequence[str], *, name: str = "elpis-app") -> Any:
    key = tuple(sorted({str(f).strip().lower() for f in (families or ()) if str(f).strip()}))
    with _lock:
        inst = _instances.get(key)
        if inst is not None:
            return inst
        import server.local_mcp_server as S
        inst = S.LocalToolsMCP(name)
        inst.add_middleware(S.ServerLoopCapture())
        inst.add_middleware(S.IdentityCapture())
        inst.add_middleware(S.ToolRateLimit())
        inst.add_middleware(S.OkFalseAsIsError())
        inst.add_middleware(S.TitleFiller())
        loaded = S.register_families_on(inst, list(key))
        logger.info("[app_mcp] MCP interne %s : familles %s", name, ", ".join(loaded) or "(aucune)")
        _instances[key] = inst
        return inst


def reset() -> None:
    with _lock:
        _instances.clear()
