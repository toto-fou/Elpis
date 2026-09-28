# SPDX-License-Identifier: MIT
"""Registre des serveurs MCP locaux + résolution DURABLE (2026-09-05).

Régression corrigée : ``opencode.json`` revenait SANS bloc ``mcp`` après tout
redémarrage qui ne repassait pas par ``./elpis start`` — l'URL et le jeton
du service partagé n'existaient qu'en variables d'env. Ces tests verrouillent :

  1. le jeton de service se résout depuis le FICHIER persistant (survie au
     redémarrage), avec la priorité env > config > fichier ;
  2. l'URL du service se DÉRIVE du descripteur intégré quand rien ne la pose,
     et une URL explicite (env/config) reste prioritaire et « de confiance » ;
  3. ``service_upstream`` n'expose rien sans jeton (invariant de sécurité
     fs/shell) ;
  4. un serveur MCP local ADDITIONNEL déclaré en JSON (réseau) est publié à
     opencode ; un stdio ne l'est pas ; un descripteur incohérent est ignoré ;
  5. le pool d'outils de l'app retombe sur stdio si l'URL dérivée est
     injoignable (les outils du chat ne tombent jamais).
"""
from __future__ import annotations

import importlib

import pytest

from shared_infra import config as cfg
from shared_infra.mcp import local_registry as reg


# ── 1. Jeton : env > config > fichier ────────────────────────────────────────
def test_token_from_file_when_env_and_config_absent(tmp_path, monkeypatch):
    f = tmp_path / ".local_mcp_token"
    f.write_text("tok-from-file\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN_FILE", f)
    assert cfg._read_local_mcp_token_file() == "tok-from-file"


def test_token_file_missing_is_empty_not_error(tmp_path, monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN_FILE", tmp_path / "nope")
    assert cfg._read_local_mcp_token_file() == ""


# ── 2. Descripteur intégré + dérivation d'URL ────────────────────────────────
def test_builtin_defaults_streamable_http(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW", None)
    monkeypatch.setattr(cfg, "LOCAL_MCP_HOST", "127.0.0.1")
    monkeypatch.setattr(cfg, "LOCAL_MCP_PORT", 8765)
    d = cfg._builtin_local_mcp()
    assert d["transport"] == "streamable-http" and d["mount"] == "/mcp"
    assert cfg._builtin_local_mcp_url() == "http://127.0.0.1:8765/mcp"


def test_builtin_override_from_config(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW",
                        {"local-tools": {"transport": "sse", "port": 9000}})
    monkeypatch.setattr(cfg, "LOCAL_MCP_HOST", "127.0.0.1")
    monkeypatch.setattr(cfg, "LOCAL_MCP_PORT", 8765)
    d = cfg._builtin_local_mcp()
    assert d["transport"] == "sse" and d["mount"] == "/sse" and d["port"] == 9000
    assert cfg._builtin_local_mcp_url() == "http://127.0.0.1:9000/sse"


def test_builtin_stdio_has_no_url(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW",
                        {"local-tools": {"transport": "stdio"}})
    assert cfg._builtin_local_mcp()["transport"] == "stdio"
    assert cfg._builtin_local_mcp_url() == ""


def test_http_alias_normalized(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW",
                        {"local-tools": {"transport": "http"}})
    assert cfg._builtin_local_mcp()["transport"] == "streamable-http"


# ── 3. service_upstream : invariant de sécurité ──────────────────────────────
def test_service_upstream_requires_url_and_token(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:8765/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "")
    assert reg.service_upstream() == (None, "")          # pas de jeton → rien
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "svc")
    assert reg.service_upstream() == ("http://127.0.0.1:8765/mcp", "svc")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "")
    assert reg.service_upstream() == (None, "")          # pas d'URL → rien


def test_bridge_upstream_uses_service_upstream(monkeypatch):
    from shared_infra.mcp import bridge
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:8765/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "svc")
    assert bridge._upstream_base() == "http://127.0.0.1:8765/mcp"
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "")
    assert bridge._upstream_base() is None


# ── 4. Serveurs locaux additionnels ──────────────────────────────────────────
def test_extra_remote_server_published_stdio_not(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW", {
        "weather": {"transport": "streamable-http", "url": "http://127.0.0.1:9100/mcp",
                    "headers": {"X-Api": "k"}, "expose_opencode": True},
        "localonly": {"transport": "stdio", "command": "python", "args": ["/x.py"],
                      "expose_opencode": True},
        "hidden": {"transport": "streamable-http", "url": "http://127.0.0.1:9200/mcp"},
    })
    names = list(reg.local_servers())
    assert {"local-tools", "weather", "localonly", "hidden"} <= set(names)
    pub = {d["name"] for d in reg.opencode_local_servers()}
    assert pub == {"weather"}                       # stdio + non-exposé exclus
    entry = reg.opencode_entry_for(reg.local_servers()["weather"])
    assert entry == {"type": "remote", "url": "http://127.0.0.1:9100/mcp",
                     "enabled": True, "headers": {"X-Api": "k"}}


def test_incoherent_descriptor_dropped(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW", {
        "no-url":  {"transport": "sse", "expose_opencode": True},       # réseau sans url
        "no-cmd":  {"transport": "stdio", "expose_opencode": True},     # stdio sans command
        "bad":     "not-a-dict",
    })
    servers = reg.local_servers()
    assert set(servers) == {"local-tools"}          # aucune entrée bancale retenue


def test_local_tools_override_does_not_duplicate(monkeypatch):
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW",
                        {"local-tools": {"transport": "streamable-http"}})
    assert list(reg.local_servers()).count("local-tools") == 1


# ── 5. Sonde de joignabilité + repli stdio ───────────────────────────────────
def test_reachable_false_on_dead_port():
    from llm_core import _mcp_wrappers as w
    assert w._shared_service_reachable("http://127.0.0.1:1/mcp", timeout=0.2) is False


def test_pool_falls_back_to_stdio_when_derived_url_unreachable(monkeypatch):
    from llm_core import _mcp_wrappers as w
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:1/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_IS_DERIVED", True)
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "svc")
    cli = w._resolve_mcp_client({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON"})
    assert type(cli).__name__ == "MCPStdioWrapper"


def test_pool_trusts_explicit_url_without_probe(monkeypatch):
    """URL EXPLICITE (non dérivée) : on s'y fie même si le port ne répond pas
    (le script de lancement garantit le service) — sinon on paierait une sonde
    à chaque résolution en fonctionnement normal."""
    from llm_core import _mcp_wrappers as w
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:1/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_IS_DERIVED", False)
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "svc")
    cli = w._resolve_mcp_client({"type": "stdio", "command": "DEFAULT_LOCAL_PYTHON"})
    assert type(cli).__name__ == "MCPStreamableHTTPWrapper"


def test_external_servers_untouched(monkeypatch):
    """Un connecteur MCP EXTERNE (type sse avec URL, pas DEFAULT_LOCAL_PYTHON)
    n'est pas concerné par le registre local — il continue d'être résolu tel
    quel."""
    from llm_core import _mcp_wrappers as w
    cli = w._resolve_mcp_client({"type": "sse", "url": "http://ext.example/sse"})
    assert type(cli).__name__ == "MCPSSEWrapper"
