# SPDX-License-Identifier: MIT
"""
Transport MCP « HTTP streamable » (POST /mcp) — résolution, en-têtes, clé de pool.

Le standard MCP courant expose /mcp en HTTP streamable ; l'app ne parlait que
SSE et stdio, et pointer un serveur récent dessus renvoyait 405.
"""
from pathlib import Path

import pytest


def _wrappers():
    import llm_core._mcp_wrappers as W
    return W


# ── 1. Résolution du transport ───────────────────────────────────────────────

def test_type_http_donne_le_wrapper_streamable():
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "http", "url": "http://h/mcp"})
    assert type(c).__name__ == "MCPStreamableHTTPWrapper"


def test_alias_streamable_http_accepte():
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "streamable-http", "url": "http://h/mcp"})
    assert type(c).__name__ == "MCPStreamableHTTPWrapper"


def test_type_sse_reste_sur_le_wrapper_sse():
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "sse", "url": "http://h/sse"})
    assert type(c).__name__ == "MCPSSEWrapper"


def test_url_vide_refusee():
    W = _wrappers()
    assert W._resolve_mcp_client({"type": "http", "url": ""}) is None


# ── 2. En-têtes d'authentification ───────────────────────────────────────────

def test_authorization_brut_pose_len_tete():
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "http", "url": "http://h/mcp",
                               "authorization": "Bearer jeton"})
    assert c.headers == {"Authorization": "Bearer jeton"}


def test_basic_auth_encode_en_base64():
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "http", "url": "http://h/mcp",
                               "basic_auth": {"username": "u", "password": "p"}})
    assert c.headers["Authorization"].startswith("Basic ")


def test_headers_custom_transmis():
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "http", "url": "http://h/mcp",
                               "headers": {"X-Api-Key": "k"}})
    assert c.headers == {"X-Api-Key": "k"}


def test_sans_auth_headers_reste_none():
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "http", "url": "http://h/mcp"})
    assert c.headers is None


# ── 3. Identité de connexion dans le pool ────────────────────────────────────

def test_sse_et_http_sur_la_meme_url_ne_partagent_pas_la_connexion():
    """Sans ``ctype`` dans la clé, activer les deux transports sur une même URL
    ferait resservir la session de l'autre — donc le mauvais protocole."""
    from llm_core._mcp_pool import MCPConnectionPool as P
    base = {"url": "http://h/mcp", "authorization": "Bearer a"}
    assert (P._make_key({**base, "type": "sse"})
            != P._make_key({**base, "type": "http"}))


def test_deux_jetons_distincts_ne_partagent_pas_la_connexion():
    from llm_core._mcp_pool import MCPConnectionPool as P
    base = {"type": "http", "url": "http://h/mcp"}
    assert (P._make_key({**base, "authorization": "Bearer a"})
            != P._make_key({**base, "authorization": "Bearer b"}))


# ── 4. Pas de repli NON AUTHENTIFIÉ ──────────────────────────────────────────

def test_aucun_repli_sans_en_tete_dans_le_source():
    """Un ``except TypeError`` qui rejouerait ``sse_client(url)`` sans en-têtes
    partirait NON AUTHENTIFIÉ vers un serveur que l'utilisateur croit
    authentifié : le 401 se lirait « serveur en panne » au lieu de « le jeton
    n'est jamais parti ». Motif fail-open — il ne doit pas revenir."""
    src = (Path(__file__).resolve().parents[2]
           / "llm_core" / "_mcp_wrappers.py").read_text(encoding="utf-8")
    assert "except TypeError:\n                self.ctx = sse_client(self.url)" not in src
    assert "sse_client(self.url, headers=self.headers)" in src


# ── 5. L'échec de connexion reste attrapable par l'appelant ──────────────────

@pytest.mark.asyncio
async def test_echec_remonte_en_exception_pas_en_cancelled():
    """``streamablehttp_client`` enfouit l'erreur réelle dans le task group de
    son générateur : l'appelant ne recevait qu'un ``CancelledError``, qui n'est
    PAS une ``Exception`` et traversait donc le ``except Exception`` de
    ``_chat_with_tools`` — avortant tout le tour au lieu de signaler ce seul
    serveur."""
    W = _wrappers()
    c = W._resolve_mcp_client({"type": "http", "url": "http://127.0.0.1:1/mcp"})
    # pytest.raises(Exception) ne rattraperait PAS un CancelledError : c'est
    # tout l'objet du test.
    with pytest.raises(Exception) as ei:
        async with c:
            pass
    assert "MCP HTTP" in str(ei.value), "le message doit nommer l'URL en cause"
