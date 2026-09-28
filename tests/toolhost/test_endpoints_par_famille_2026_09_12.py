# SPDX-License-Identifier: MIT
"""Un serveur MCP = une entrée = un endpoint (2026-09-12).

Ce que ces tests verrouillent, et pourquoi :

* **Retirer l'entrée retire les outils.** C'est la demande : plus aucune liste à
  éditer ailleurs. Une régression ici se verrait seulement à l'usage, un outil
  manquant sans le moindre message.
* **Une clé de pool par entrée.** Sans le nom d'entrée dans la clé, les dix
  entrées intégrées se seraient fondues en une seule connexion (la première
  gagnante) et neuf familles auraient disparu en silence.
* **Les trois transports.** ``/mcp/<famille>``, ``/sse/<famille>`` et
  ``python -m toolhost --stdio --families <famille>`` doivent rester joignables
  par n'importe quel applicatif MCP.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from shared_infra.mcp import manifest as M


def _doc(**servers):
    return {"version": 1,
            "toolHosts": {"main": {"url": "http://127.0.0.1:8765", "token": "svc"}},
            "mcpServers": servers}


def _fam_entry(fam, **xe):
    x = {"role": "toolhost", "host": "main", "families": [fam]}
    x.update(xe)
    return {"type": "http", "url": f"http://127.0.0.1:8765/mcp/{fam}",
            "headers": {"Authorization": "Bearer svc"}, "x-elpis": x}


@pytest.fixture
def manifest(tmp_path, monkeypatch):
    def _write(doc):
        p = tmp_path / "mcp.json"
        p.write_text(json.dumps(doc), encoding="utf-8")
        monkeypatch.setenv("APP_MCP_MANIFEST", str(p))
        return M.reload()
    yield _write
    M.reload()


@pytest.fixture
def trois_familles(manifest):
    return manifest(_doc(**{
        "elpis-fs": _fam_entry("fs"),
        "elpis-git": _fam_entry("git", opencode={"publish": True}),
        "elpis-shell": _fam_entry("shell"),
        "elpis-memory": {"type": "inprocess",
                         "x-elpis": {"role": "app", "families": ["memory"]}},
    }))


# ── 1. Une entrée = une config de pool ──────────────────────────────────────

def test_une_entree_par_famille_donne_une_config_par_entree(trois_familles):
    m = trois_familles
    assert [e.name for e in m.toolhosts()] == ["elpis-fs", "elpis-git", "elpis-shell"]
    assert [e.name for e in m.apps()] == ["elpis-memory"]
    assert m.toolhost_families() == ["fs", "shell", "git"]        # ordre canonique
    assert m.families() == ["fs", "shell", "git", "memory"]       # union, hôte local
    cfgs = M.builtin_client_cfgs(["fs"])
    assert [c["manifest"] for c in cfgs] == ["elpis-fs", "elpis-git", "elpis-shell", "elpis-memory"]
    assert [c["families"] for c in cfgs] == [["fs"], ["git"], ["shell"], ["memory"]]
    assert all(c["filter_categories"] == ["fs"] for c in cfgs)
    assert all(c["identity"] == "meta" for c in cfgs)


def test_retirer_une_entree_retire_ses_outils(manifest):
    """Le geste demandé : on enlève l'entrée, la famille disparaît."""
    m = manifest(_doc(**{"elpis-fs": _fam_entry("fs"), "elpis-git": _fam_entry("git")}))
    assert m.families() == ["fs", "git"]
    assert {c["manifest"] for c in M.builtin_client_cfgs(None)} == {"elpis-fs", "elpis-git"}
    m = manifest(_doc(**{"elpis-fs": _fam_entry("fs")}))
    assert m.families() == ["fs"]
    assert {c["manifest"] for c in M.builtin_client_cfgs(None)} == {"elpis-fs"}
    # ``enabled: false`` = le même effet sans supprimer la déclaration
    doc = _doc(**{"elpis-fs": _fam_entry("fs"), "elpis-git": _fam_entry("git")})
    doc["mcpServers"]["elpis-git"]["enabled"] = False
    m = manifest(doc)
    assert m.families() == ["fs"] and [e.name for e in m.toolhosts()] == ["elpis-fs"]


def test_les_cles_de_pool_sont_distinctes_par_entree(trois_familles):
    from llm_core._mcp_pool import MCPConnectionPool
    keys = [MCPConnectionPool._make_key(c) for c in M.builtin_client_cfgs(["fs"])]
    assert len(set(keys)) == len(keys)
    # ``filter_categories`` reste côté client : il ne doit PAS ouvrir une
    # seconde session vers le même endpoint.
    assert keys == [MCPConnectionPool._make_key(c) for c in M.builtin_client_cfgs(["git"])]
    # La sentinelle NUE (appelants historiques) garde son ancienne clé.
    assert MCPConnectionPool._make_key({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON"}) \
        != keys[0]


# ── 2. Repli stdio dérivé ───────────────────────────────────────────────────

def test_repli_stdio_derive_par_famille(trois_familles):
    fb = trois_familles.get("elpis-git").fallback
    assert fb["args"] == ["-m", "toolhost", "--stdio", "--families", "git"]
    assert fb["env"]["LOCAL_MCP_TRANSPORT"] == "stdio"
    assert Path(fb["command"]).name.startswith("python")


def test_repli_refusable_et_surchargeable(manifest):
    m = manifest(_doc(**{
        "sans": _fam_entry("fs", fallback=False),
        "perso": _fam_entry("git", fallback={"command": "/bin/mcp", "args": ["--x"]}),
    }))
    assert m.get("sans").fallback is None and m.warnings == []
    assert m.get("perso").fallback["command"] == "/bin/mcp"


# ── 3. Résolution du client : chaque entrée son endpoint ────────────────────

def test_resolution_du_client_suit_le_nom_d_entree(trois_familles, monkeypatch):
    import llm_core._mcp_wrappers as w
    monkeypatch.setattr(w, "_shared_service_reachable", lambda url, timeout=1.0: True)
    cli = w._resolve_mcp_client({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON",
                                 "manifest": "elpis-git"})
    assert isinstance(cli, w.MCPStreamableHTTPWrapper)
    assert cli.url == "http://127.0.0.1:8765/mcp/git"
    # Entrée inconnue ou sentinelle nue → première entrée toolhost déclarée.
    for cfg in ({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON"},
                {"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON", "manifest": "absente"}):
        assert w._resolve_mcp_client(cfg).url == "http://127.0.0.1:8765/mcp/fs"


def test_une_entree_injoignable_retombe_sur_son_stdio(trois_familles, monkeypatch):
    import llm_core._mcp_wrappers as w
    monkeypatch.setattr(w, "_shared_service_reachable", lambda url, timeout=1.0: False)
    cli = w._resolve_mcp_client({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON",
                                 "manifest": "elpis-git"})
    assert isinstance(cli, w.MCPStdioWrapper)
    # Le lanceur enveloppe la commande dans un ``sh -c "cd <racine> && exec …"``.
    assert cli.params.args[0] == "-c"
    assert cli.params.args[1].endswith("-m toolhost --stdio --families git")


# ── 4. Normalisation vers un autre applicatif ───────────────────────────────

def test_export_pour_un_applicatif_tiers(trois_familles):
    m = trois_familles
    base = m.host_base_url()
    assert base == "http://127.0.0.1:8765" and m.mcp_base_url() == "http://127.0.0.1:8765/mcp"
    http = M.export_servers(m.toolhosts(), base_url=base, transport="http", token="svc")
    assert http["mcpServers"]["elpis-git"] == {
        "type": "http", "url": "http://127.0.0.1:8765/mcp/git",
        "headers": {"Authorization": "Bearer svc"}}
    sse = M.export_servers(m.toolhosts(), base_url=base, transport="sse")
    assert sse["mcpServers"]["elpis-git"]["url"] == "http://127.0.0.1:8765/sse/git"
    assert "headers" not in sse["mcpServers"]["elpis-git"]       # jeton non demandé
    stdio = M.export_servers(m.toolhosts(), transport="stdio")
    assert stdio["mcpServers"]["elpis-git"]["args"][-1] == "git"
    assert stdio["mcpServers"]["elpis-git"]["type"] == "stdio"


def test_service_upstream_rend_la_base_de_l_hote(trois_familles):
    """Le relais ``/api/mcp-bridge/<famille>`` et opencode attendent la BASE
    (``…/mcp``), pas l'URL d'une famille."""
    assert M.service_upstream() == ("http://127.0.0.1:8765/mcp", "svc")


def test_opencode_publie_les_familles_marquees(trois_familles):
    from shared_infra.mcp.families import opencode_families
    assert trois_familles.opencode_families() == ["git"]
    assert opencode_families() == ["git"]


def test_opencode_ne_publie_jamais_fs_ni_shell(manifest):
    m = manifest(_doc(**{
        "elpis-fs": _fam_entry("fs", opencode={"publish": True}),
        "elpis-shell": _fam_entry("shell", opencode={"publish": True}),
        "elpis-skill-run": _fam_entry("skill_run", opencode={"publish": True}),
        "elpis-git": _fam_entry("git", opencode={"publish": True}),
    }))
    assert m.opencode_families() == ["git"]


# ── 4 bis. Surcharges héritées : sur TOUTES les entrées ─────────────────────

def test_local_mcp_url_reecrit_toutes_les_entrees(manifest, monkeypatch):
    """``./elpis start`` exporte ``LOCAL_MCP_URL=…/mcp``. Ne réécrire que
    la PREMIÈRE entrée l'aurait pointée sur l'endpoint « toutes familles » : elle
    aurait rendu tout le catalogue pendant que les autres rendaient le leur —
    des outils en double, sans le moindre message."""
    monkeypatch.setenv("LOCAL_MCP_URL", "http://10.0.0.9:8765/mcp")
    monkeypatch.setenv("LOCAL_MCP_TOKEN", "svc-env")
    m = manifest(_doc(**{"elpis-fs": _fam_entry("fs"), "elpis-git": _fam_entry("git")}))
    assert [(e.name, e.url) for e in m.toolhosts()] == [
        ("elpis-fs", "http://10.0.0.9:8765/mcp/fs"),
        ("elpis-git", "http://10.0.0.9:8765/mcp/git")]
    assert {e.token for e in m.toolhosts()} == {"svc-env"}
    assert M.service_upstream() == ("http://10.0.0.9:8765/mcp", "svc-env")
    monkeypatch.setenv("LOCAL_MCP_URL", "https://vm-outils/sse")
    m = manifest(_doc(**{"elpis-git": _fam_entry("git")}))
    e = m.get("elpis-git")
    assert e.url == "https://vm-outils/sse/git" and e.type == "sse"


def test_local_mcp_tool_families_retire_les_entrees(manifest, monkeypatch):
    monkeypatch.setenv("LOCAL_MCP_TOOL_FAMILIES", "git")
    m = manifest(_doc(**{
        "elpis-fs": _fam_entry("fs"), "elpis-git": _fam_entry("git"),
        "elpis-memory": {"type": "inprocess", "x-elpis": {"role": "app", "families": ["memory"]}},
    }))
    assert [e.name for e in m.builtins()] == ["elpis-git"] and m.families() == ["git"]


# ── 5. Portée par famille sur les deux bases ────────────────────────────────

def test_portee_par_famille_sur_http_et_sse():
    import asyncio
    import server.local_mcp_server as S
    seen = {}

    async def app(scope, receive, send):
        seen["path"] = scope["path"]
        seen["family"] = S.path_family()

    mw = S.FamilyScopeASGI(app, bases=("/mcp", "/sse"))

    def call(path):
        seen.clear()
        S._REQ_FAMILY.set(None)
        asyncio.run(mw({"type": "http", "path": path}, None, None))
        return seen.get("path"), seen.get("family")

    assert call("/mcp/git") == ("/mcp", "git")
    assert call("/sse/git") == ("/sse", "git")
    assert call("/mcp") == ("/mcp", None)
    assert call("/sse") == ("/sse", None)
    assert call("/messages/") == ("/messages/", None)    # POST SSE : hors portée
    assert call("/api/sandbox/tree") == ("/api/sandbox/tree", None)

    # Famille inconnue : 404, jamais « toutes les familles ».
    sent = []

    async def send(msg):
        sent.append(msg)
    seen.clear()
    S._REQ_FAMILY.set(None)
    asyncio.run(mw({"type": "http", "path": "/sse/inconnue"}, None, send))
    assert sent[0]["status"] == 404 and "path" not in seen


def test_cli_families():
    from toolhost.__main__ import _parse_families
    assert _parse_families(["--stdio", "--families", "fs,git"]) == "fs,git"
    assert _parse_families(["--family=git"]) == "git"
    assert _parse_families(["--stdio"]) is None


# ── 6. L'hôte sert HTTP et SSE en même temps ────────────────────────────────

def test_l_hote_sert_http_et_sse(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from toolhost import config as TC
    tc = TC.ToolhostConfig(host="127.0.0.1", port=1, transport="streamable-http",
                           transports=["http", "sse"], token="svc",
                           families=["fs", "git"], sandbox_dir=str(tmp_path / "sb"),
                           db_path=str(tmp_path / "th.db"), source="file")
    monkeypatch.setenv("LOCAL_MCP_TOKEN", "svc")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "th.db"))
    from toolhost.app import build_app
    _env = dict(os.environ)
    try:
        app = build_app(tc)
    finally:
        os.environ.clear(); os.environ.update(_env)
    from shared_infra.accounts import identity as I
    hdrs = {"Authorization": "Bearer svc",
            I.IDENTITY_HEADER: I.sign(I.Identity(user_id=7, username="hugo"), "svc")}
    with TestClient(app) as c:
        h = c.get("/health").json()
        assert h["transports"] == ["http", "sse"] and h["sse_path"] == "/sse"
        m = c.get("/manifest", headers=hdrs).json()
        assert m["endpoints"]["git"]["http"].endswith("/mcp/git")
        assert m["endpoints"]["git"]["sse"].endswith("/sse/git")
        assert m["endpoints"]["git"]["stdio"]["args"][-1] == "git"
        assert m["mcpServers"]["elpis-git"]["url"].endswith("/mcp/git")
        sse = c.get("/manifest?transport=sse", headers=hdrs).json()
        assert sse["mcpServers"]["elpis-git"]["url"].endswith("/sse/git")
        # Les deux transports passent la porte de l'hôte (FastMCP a la sienne) :
        # ni l'un ni l'autre ne doit tomber sur le refus d'identité.
        for p in ("/mcp", "/sse", "/mcp/git", "/sse/git"):
            r = c.post(p, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
            assert "enveloppe" not in r.text, p


# ── 7. Pré-chauffage : toutes les entrées, pas seulement la première ────────

def test_le_prechauffage_couvre_toutes_les_entrees(trois_familles):
    import shared_infra.mcp.panel as panel
    cfgs = panel._builtin_prewarm_cfgs()
    assert [c.get("manifest") for c in cfgs] == \
        ["elpis-fs", "elpis-git", "elpis-shell", "elpis-memory"]
