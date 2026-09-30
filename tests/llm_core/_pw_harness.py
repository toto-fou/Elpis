# SPDX-License-Identifier: MIT
"""Banc d'essai partagé pour les outils navigateur (``pw_*``).

Les outils sont des closures de ``firefox_tools.register(mcp)`` : on les
extrait via un faux MCP qui capture les fonctions décorées, et on remplace
``_req`` pour observer CE QUI PART vers le service Node — sans service Node,
sans navigateur.

Pourquoi un banc et pas un grep de source : la première salve de tests de
cette famille relisait le code (``assert 'if (selector or "")…' in src``).
Elle a validé un garde-fou qui, à l'exécution, levait un ``TypeError`` avant
de renvoyer quoi que ce soit. On exécute.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import pytest


class FakeMCP:
    """Capture chaque fonction ``@mcp.tool(..., name=...)`` sans FastMCP."""

    def __init__(self) -> None:
        self.tools: Dict[str, Any] = {}

    def tool(self, *dargs: Any, **dkw: Any):
        name = dkw.get("name")

        def deco(fn):
            self.tools[name or fn.__name__] = fn
            return fn

        return deco


@dataclass
class Sent:
    """Un appel sortant vers le service navigateur."""
    method: str
    endpoint: str
    body: Dict[str, Any] = field(default_factory=dict)
    params: Dict[str, Any] = field(default_factory=dict)

    @property
    def payload(self) -> Dict[str, Any]:
        """Corps JSON ou query-string, selon le verbe HTTP."""
        return self.body or self.params


class _Ctx:
    """Contexte FastMCP minimal — ``get_username`` retombe sur son défaut."""


CTX = _Ctx()


@pytest.fixture
def pw_env(monkeypatch):
    """(getter d'outil, journal des appels sortants).

    ``_AX_ENABLED`` est coupé : la mémoire AX ajoute des ``/smart_inspect``
    parasites qui n'ont rien à voir avec le geste testé.
    """
    from llm_core.tools import firefox_tools as ff

    mcp = FakeMCP()
    ff.register(mcp)
    sent: List[Sent] = []

    def fake_req(method, endpoint, json=None, params=None, timeout=None):
        sent.append(Sent(method, endpoint, dict(json or {}), dict(params or {})))
        return {"ok": True, "endpoint": endpoint}

    monkeypatch.setattr(ff, "_req", fake_req)
    monkeypatch.setattr(ff, "_AX_ENABLED", False)
    # Les sessions du banc appartiennent au compte du contexte (``guest``) :
    # depuis 2026-09-30, une session inconnue du registre est refusée.
    import llm_core._pw_session as _pws
    monkeypatch.setattr(_pws, "get_pw_session_owner", lambda sid: "guest")
    # ``observe=True`` par défaut sur pw_act rajoute un snapshot après chaque
    # action : hors sujet ici, et il masquerait l'appel qu'on veut lire.
    monkeypatch.setattr(ff, "_finish_act",
                        lambda result, session_id, observe, max_items=25: result)
    return (lambda name: mcp.tools[name]), sent


@pytest.fixture
def pw(pw_env):
    return pw_env[0]


@pytest.fixture
def sent(pw_env):
    return pw_env[1]
