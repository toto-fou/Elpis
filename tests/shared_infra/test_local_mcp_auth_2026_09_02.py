# SPDX-License-Identifier: MIT
"""Serveur MCP local : auth Bearer RÉELLE + familles optionnelles (2026-09-02).

Remplace ``test_local_mcp_no_fake_auth.py`` (2026-07-29), qui verrouillait
l'ABSENCE de jeton après le retrait d'un ``LOCAL_MCP_TOKEN`` fantôme (envoyé,
jamais vérifié). Le contrat est désormais l'inverse — et VÉRIFIABLE :

* le serveur porte un ``StaticTokenVerifier`` (transports HTTP) dès qu'un jeton
  est configuré ; le client de l'app envoie le jeton de SERVICE en Bearer,
  et SEULEMENT s'il est configuré ;
* un jeton CLIENT (``LOCAL_MCP_CLIENT_TOKENS``) est LIÉ à un compte : l'identité
  vient du jeton, le ``meta`` auto-déclaré est ignoré ;
* sans aucun jeton, le service refuse de se lier hors loopback ;
* les familles d'outils sont optionnelles (``LOCAL_MCP_TOOL_FAMILIES``).
"""
from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="module")
def srv():
    """Le module serveur (import unique ; crée l'instance FastMCP, aucun run)."""
    return importlib.import_module("server.local_mcp_server")


# ── Table de jetons + vérificateur ──────────────────────────────────────────

def test_table_de_jetons_service_et_clients(srv):
    table = srv.build_token_table("svc-secret", {"t-alice": "alice", "t-bob": "bob"})
    assert table["svc-secret"]["trusted_meta"] is True
    assert table["svc-secret"]["client_id"] == "elpis-app"
    assert table["t-alice"] == {"client_id": "ext:alice", "scopes": ["local-tools"],
                                "username": "alice", "trusted_meta": False}
    assert set(table) == {"svc-secret", "t-alice", "t-bob"}


def test_jeton_client_identique_au_service_ignore(srv):
    """Un jeton client qui réutilise la valeur du jeton de service ne doit pas
    rétrograder ce dernier en identité fixe ni le rendre ambigu."""
    table = srv.build_token_table("same", {"same": "mallory"})
    assert table["same"]["trusted_meta"] is True and "username" not in table["same"]


def test_verificateur_accepte_les_bons_jetons_et_rejette_le_reste(srv):
    from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
    v = StaticTokenVerifier(tokens=srv.build_token_table("svc", {"t1": "alice"}),
                            required_scopes=[srv.SCOPE_LOCAL_TOOLS])
    ok_svc = asyncio.run(v.verify_token("svc"))
    ok_cli = asyncio.run(v.verify_token("t1"))
    assert ok_svc is not None and ok_svc.claims["trusted_meta"] is True
    assert ok_cli is not None and ok_cli.claims["username"] == "alice"
    assert asyncio.run(v.verify_token("nope")) is None
    assert asyncio.run(v.verify_token("")) is None


def test_le_serveur_verifie_reellement(srv):
    """Le contrôle est côté SERVEUR (StaticTokenVerifier), pas un simple
    en-tête envoyé dans le vide — c'était le défaut du jeton de 2026-07."""
    src = (ROOT / "server" / "local_mcp_server.py").read_text(encoding="utf-8")
    assert "StaticTokenVerifier" in src
    assert "LocalToolsMCP(MCP_NAME, auth=_AUTH," in src
    assert srv.bind_allowed("127.0.0.1", False)
    assert srv.bind_allowed("localhost", False)
    assert not srv.bind_allowed("0.0.0.0", False)
    assert not srv.bind_allowed("10.168.1.10", False)
    assert srv.bind_allowed("0.0.0.0", True)


# ── Client de l'app : Bearer seulement si le jeton de service est configuré ──

def _resolve_local(monkeypatch, token: str):
    import llm_core._mcp_wrappers as w
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", token)
    # (2026-09-05) La résolution lit l'URL À CHAUD sur ``shared_infra.config``
    # (le registre local la rend durable). URL EXPLICITE (is_derived=False) =
    # de confiance, aucune sonde de joignabilité.
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:8765/sse")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_IS_DERIVED", False)
    return w._resolve_mcp_client({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON"})


def test_client_envoie_le_bearer_si_configure(monkeypatch):
    c = _resolve_local(monkeypatch, "svc-secret")
    assert c.headers == {"Authorization": "Bearer svc-secret"}


def test_client_sans_jeton_sans_en_tete(monkeypatch):
    c = _resolve_local(monkeypatch, "")
    assert c.headers is None


def test_client_url_mcp_prend_le_transport_http_streamable(monkeypatch):
    """``LOCAL_MCP_URL=…/mcp`` → HTTP streamable (le transport d'opencode) :
    un seul service pour l'app et les clients externes."""
    import llm_core._mcp_wrappers as w
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "svc")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:8765/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_IS_DERIVED", False)
    c = w._resolve_mcp_client({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON"})
    assert isinstance(c, w.MCPStreamableHTTPWrapper)
    assert c.headers == {"Authorization": "Bearer svc"}


# ── Identité : le jeton client prime sur le meta ────────────────────────────

def _ctx_with_meta(username: str):
    return SimpleNamespace(request_context=SimpleNamespace(meta={"username": username}))


def _patch_token(monkeypatch, tok):
    import fastmcp.server.dependencies as deps

    import llm_core.tools._toolkit as tk
    monkeypatch.setattr(deps, "get_access_token", lambda: tok)
    return tk


def test_identite_du_jeton_client_prime_sur_le_meta(monkeypatch):
    tk = _patch_token(monkeypatch, SimpleNamespace(
        client_id="ext:bob", claims={"username": "bob", "trusted_meta": False}))
    assert tk.get_username(_ctx_with_meta("alice")) == "bob"


def test_jeton_de_service_laisse_le_meta_faire_autorite(monkeypatch):
    tk = _patch_token(monkeypatch, SimpleNamespace(
        client_id="elpis-app", claims={"trusted_meta": True}))
    assert tk.get_username(_ctx_with_meta("alice")) == "alice"


def test_sans_jeton_le_meta_puis_le_repli(monkeypatch):
    tk = _patch_token(monkeypatch, None)
    assert tk.get_username(_ctx_with_meta("alice")) == "alice"
    assert tk.get_username(None, "carol") == "carol"
    assert tk.get_username(None) == "guest"


# ── Familles optionnelles ───────────────────────────────────────────────────

def test_selection_des_familles(srv):
    allf = list(srv._FAMILY_NAMES)
    assert srv.selected_families(None) == allf
    assert srv.selected_families("all") == allf
    assert srv.selected_families("git, fs") == ["fs", "git"]          # ordre canonique
    assert srv.selected_families("all,-desktop,-browser") == [n for n in allf
                                                              if n not in ("desktop", "browser")]
    assert srv.selected_families("-shell") == [n for n in allf if n != "shell"]
    assert srv.selected_families("fs,inconnue") == ["fs"]           # inconnue ignorée


def test_config_client_tokens_parse():
    from shared_infra.config import _parse_client_tokens
    assert _parse_client_tokens("t1:alice, t2:bob,,broken", None) == {"t1": "alice", "t2": "bob"}
    assert _parse_client_tokens("", {"t3": "carol", "": "x", "t4": ""}) == {"t3": "carol"}
    assert _parse_client_tokens(None, None) == {}


# ── Passe 8 (relecture adversariale de la phase 1) ──────────────────────────

def test_jetons_clients_sans_jeton_de_service_refuses(srv):
    """B3 — sinon le vérificateur est armé alors que le client de l'app
    n'envoie de Bearer que si LOCAL_MCP_TOKEN est posé : 401 pour tous."""
    assert srv.token_config_error("", {"t1": "alice"})
    assert srv.token_config_error("svc", {"t1": "alice"}) is None
    assert srv.token_config_error("", {}) is None


def test_familles_toutes_inconnues_retombent_sur_toutes(srv):
    """B13 — ``filesystem`` (faute de frappe) enregistrait ZÉRO outil."""
    assert srv.selected_families("filesystem") == list(srv._FAMILY_NAMES)
    assert srv.selected_families("filesystem,-desktop") == [n for n in srv._FAMILY_NAMES if n != "desktop"]
    assert srv.selected_families("fs,filesystem") == ["fs"]


def test_memory_tools_prend_l_identite_du_jeton(monkeypatch):
    """B1 — ``memory``/``session_search`` avaient leur propre lecture du meta,
    hors du chemin jeton : un client externe ``alice`` lisait la mémoire et
    l'historique de ``bob`` en déclarant ``_meta.username``."""
    import llm_core.tools.memory_tools as mt
    tk = _patch_token(monkeypatch, SimpleNamespace(
        client_id="ext:alice", claims={"username": "alice", "trusted_meta": False}))
    user, chat = mt._identity(SimpleNamespace(request_context=SimpleNamespace(
        meta={"username": "bob", "chat_id": "c-bob"})))
    assert user == "alice"
    # Jeton de service : le meta fait autorité.
    _patch_token(monkeypatch, SimpleNamespace(client_id="elpis-app", claims={"trusted_meta": True}))
    user, chat = mt._identity(SimpleNamespace(request_context=SimpleNamespace(
        meta={"username": "bob", "chat_id": "c-bob"})))
    assert (user, chat) == ("bob", "c-bob")


def test_reglages_service_env_puis_config(monkeypatch, srv):
    """B2 + registre (2026-09-05) — host/port honorés ; le SERVICE ne passe en
    réseau que sur un signal EXPLICITE : URL ``mcp.local_url`` (exposée en
    ``LOCAL_MCP_URL_EXPLICIT``) ou registre. ⚠ La simple URL DÉRIVÉE
    (``LOCAL_MCP_URL``, désormais streamable-http par défaut) NE doit PAS
    transformer le sous-process stdio d'un worker."""
    import shared_infra.config as cfg
    for k in ("LOCAL_MCP_TRANSPORT", "LOCAL_MCP_HOST", "LOCAL_MCP_PORT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_EXPLICIT", "")
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW", None)
    monkeypatch.setattr(cfg, "LOCAL_MCP_HOST", "0.0.0.0")
    monkeypatch.setattr(cfg, "LOCAL_MCP_PORT", 9001)
    # URL DÉRIVÉE présente mais AUCUN signal explicite → on reste stdio.
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:9001/mcp")
    assert srv._service_settings() == ("stdio", "0.0.0.0", 9001)
    # URL EXPLICITE → son transport (déduit du suffixe).
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_EXPLICIT", "http://127.0.0.1:9001/sse")
    assert srv._service_settings() == ("sse", "0.0.0.0", 9001)
    # Registre seul suffit aussi (opt-in par config.json).
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_EXPLICIT", "")
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW",
                        {"local-tools": {"transport": "streamable-http"}})
    assert srv._service_settings()[0] == "streamable-http"
    monkeypatch.setenv("LOCAL_MCP_TRANSPORT", "stdio")                 # l'env prime
    assert srv._service_settings()[0] == "stdio"


# ── Clients opencode : jeton elpis-remote + familles cachées (2026-09-03) ───

def test_jeton_elpis_remote_verifie_en_base(monkeypatch, srv):
    """Le jeton ``pcr_…`` du plugin /remote vaut Bearer : identité = compte
    lié (table ``code_remote_tokens``), jamais le ``meta`` ; ``client_kind``
    déclenche le masquage des familles. Un ``pcr_`` inconnu est refusé."""
    monkeypatch.setattr(srv, "remote_token_lookup",
                        lambda tok: "hugo" if tok == "pcr_bon" else None)
    srv._remote_token_cache.clear()
    v = srv._make_verifier(srv.build_token_table("svc", {"t1": "alice"}))
    ok = asyncio.run(v.verify_token("pcr_bon"))
    assert ok is not None
    assert ok.client_id == "opencode:hugo"
    assert ok.claims["username"] == "hugo" and ok.claims["trusted_meta"] is False
    assert ok.claims["client_kind"] == "opencode"
    assert asyncio.run(v.verify_token("pcr_inconnu")) is None
    assert asyncio.run(v.verify_token("svc")).claims["trusted_meta"] is True   # table statique intacte
    assert asyncio.run(v.verify_token("t1")).claims["username"] == "alice"
    # L'identité outil suit le jeton (même chemin que les jetons clients).
    import fastmcp.server.dependencies as deps

    import llm_core.tools._toolkit as tk
    monkeypatch.setattr(deps, "get_access_token", lambda: ok)
    assert tk.get_username(_ctx_with_meta("mallory")) == "hugo"


def test_cache_des_jetons_elpis_remote(monkeypatch, srv):
    calls = []
    monkeypatch.setattr(srv, "remote_token_lookup", lambda tok: calls.append(tok) or "alice")
    srv._remote_token_cache.clear()
    assert srv._remote_token_cached("pcr_x")["username"] == "alice"
    assert srv._remote_token_cached("pcr_x")["username"] == "alice"
    assert calls == ["pcr_x"]                       # une seule lecture en base


def test_familles_exposees_a_opencode_par_defaut(srv):
    """Liste d'INCLUSION : une famille ajoutée demain n'atterrit pas d'office
    chez tous les utilisateurs d'opencode — il faut la nommer."""
    from shared_infra.mcp.families import opencode_families
    assert opencode_families() == ["git", "browser", "desktop"]
    assert opencode_families("all") == ["git", "chart", "memory", "skill", "todo",
                                        "browser", "desktop"]          # fs/shell soustraites
    assert opencode_families("git,fs,shell") == ["git"]
    assert opencode_families("") == []
    assert set(srv.OPENCODE_FAMILIES) | set(srv.OPENCODE_EXCLUDED_FAMILIES) == set(srv._FAMILY_NAMES)


def test_filtre_familles_liste_et_appel(monkeypatch, srv):
    """Politique CÔTÉ SERVEUR : list_tools filtré ET call_tool refusé pour un
    client opencode ; l'app (jeton de service) et un client configuré à la
    main voient tout."""
    import fastmcp.server.dependencies as deps
    monkeypatch.setattr(srv, "OPENCODE_FAMILIES", {"memory"})
    monkeypatch.setitem(srv.TOOL_FAMILY_OF, "write_file", "fs")
    monkeypatch.setitem(srv.TOOL_FAMILY_OF, "execute_shell", "shell")
    monkeypatch.setitem(srv.TOOL_FAMILY_OF, "memory", "memory")
    tools = [SimpleNamespace(name=n) for n in ("write_file", "execute_shell", "memory")]
    mw = srv.FamilyVisibility()

    async def _next(_ctx):
        return list(tools)

    async def _called(_ctx):
        return "ok"

    def _as(tok):
        monkeypatch.setattr(deps, "get_access_token", lambda: tok)

    oc = SimpleNamespace(client_id="opencode:hugo", claims={"username": "hugo", "client_kind": "opencode"})
    app = SimpleNamespace(client_id="elpis-app", claims={"trusted_meta": True})
    ext = SimpleNamespace(client_id="ext:alice", claims={"username": "alice", "trusted_meta": False})
    _as(oc)
    assert [t.name for t in asyncio.run(mw.on_list_tools(None, _next))] == ["memory"]
    from fastmcp.exceptions import ToolError
    with pytest.raises(ToolError):
        asyncio.run(mw.on_call_tool(SimpleNamespace(message=SimpleNamespace(name="write_file")), _called))
    assert asyncio.run(mw.on_call_tool(SimpleNamespace(message=SimpleNamespace(name="memory")), _called)) == "ok"
    for tok in (app, ext, None):
        _as(tok)
        assert len(asyncio.run(mw.on_list_tools(None, _next))) == 3
        assert asyncio.run(mw.on_call_tool(SimpleNamespace(message=SimpleNamespace(name="execute_shell")), _called)) == "ok"


def test_portee_par_chemin_restreint_a_une_famille(monkeypatch, srv):
    """``…/mcp/<famille>`` : une entrée MCP par famille côté opencode. La portée
    RESTREINT (elle n'ouvre jamais ce que le jeton n'a pas le droit de voir)."""
    import fastmcp.server.dependencies as deps
    monkeypatch.setattr(deps, "get_access_token", lambda: None)
    monkeypatch.setattr(srv, "OPENCODE_FAMILIES", {"git", "browser"})
    monkeypatch.setitem(srv.TOOL_FAMILY_OF, "git_status", "git")
    monkeypatch.setitem(srv.TOOL_FAMILY_OF, "pw_find", "browser")
    monkeypatch.setitem(srv.TOOL_FAMILY_OF, "write_file", "fs")
    tools = [SimpleNamespace(name=n) for n in ("git_status", "pw_find", "write_file")]
    mw = srv.FamilyVisibility()

    async def _next(_ctx):
        return list(tools)

    async def _called(_ctx):
        return "ok"

    tok = srv._REQ_FAMILY.set("git")
    try:
        assert [t.name for t in asyncio.run(mw.on_list_tools(None, _next))] == ["git_status"]
        from fastmcp.exceptions import ToolError
        with pytest.raises(ToolError):
            asyncio.run(mw.on_call_tool(SimpleNamespace(message=SimpleNamespace(name="pw_find")), _called))
    finally:
        srv._REQ_FAMILY.reset(tok)
    # Hors portée : tout ce que le client a le droit de voir
    assert len(asyncio.run(mw.on_list_tools(None, _next))) == 3
    # Un client opencode sur l'URL d'une famille QU'IL N'A PAS le droit de voir
    monkeypatch.setattr(deps, "get_access_token", lambda: SimpleNamespace(
        client_id="opencode:hugo", claims={"username": "hugo", "client_kind": "opencode"}))
    tok = srv._REQ_FAMILY.set("fs")
    try:
        assert asyncio.run(mw.on_list_tools(None, _next)) == []
    finally:
        srv._REQ_FAMILY.reset(tok)


def test_middleware_asgi_de_portee(srv):
    """Réécriture du chemin + famille posée ; famille inconnue → 404 (une URL
    mal tapée ne doit pas rendre TOUS les outils)."""
    seen = {}

    async def _app(scope, receive, send):
        seen["path"] = scope["path"]
        seen["family"] = srv.path_family()

    mw = srv.FamilyScopeASGI(_app, base_path="/mcp")
    asyncio.run(mw({"type": "http", "path": "/mcp/git"}, None, None))
    assert seen == {"path": "/mcp", "family": "git"}
    seen.clear()
    asyncio.run(mw({"type": "http", "path": "/mcp"}, None, None))
    assert seen["path"] == "/mcp" and seen["family"] is None      # endpoint « tout » (l'app)

    sent = []

    async def _send(msg):
        sent.append(msg)

    seen.clear()
    asyncio.run(mw({"type": "http", "path": "/mcp/inconnue"}, None, _send))
    assert seen == {} and sent[0]["status"] == 404


def test_chaque_outil_enregistre_porte_sa_famille(srv):
    """La carte outil → famille est posée au passage du décorateur (clé du
    masquage) : toutes les familles chargées y figurent, fs/shell compris."""
    srv.register_all_tools()
    fams = set(srv.TOOL_FAMILY_OF.values())
    assert {"fs", "shell", "memory"} <= fams
    assert srv.TOOL_FAMILY_OF.get("write_file") == "fs"
    assert srv.TOOL_FAMILY_OF.get("execute_shell") == "shell"
