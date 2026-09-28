# SPDX-License-Identifier: MIT
"""Manifeste ``mcp.json`` (2026-09-11) — chargement, substitution, synthèse,
compatibilité et propriétés de sécurité.

Ces tests posent ``APP_MCP_MANIFEST`` sur un fichier temporaire : la suite
tourne par défaut SANS fichier (mode synthèse, cf. tests/conftest.py)."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from shared_infra import config as cfg
from shared_infra.mcp import manifest as M


@pytest.fixture
def manifest_file(tmp_path, monkeypatch):
    def _write(doc, name="mcp.json"):
        p = tmp_path / name
        p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setenv("APP_MCP_MANIFEST", str(p))
        M.reload()
        return p
    yield _write
    M.reload()


def _doc(**extra):
    base = {
        "version": 1,
        "mcpServers": {
            "elpis-tools": {
                "type": "http", "url": "http://127.0.0.1:8765/mcp",
                "headers": {"Authorization": "Bearer ${env:T_MCP_TOKEN}"},
                "description": "Outils intégrés",
                "x-elpis": {"role": "toolhost", "families": ["fs", "git", "browser"],
                            "default_on": ["fs"],
                            "opencode": {"families": ["git", "browser", "fs"]},
                            "fallback": {"command": "${python}", "args": ["x.py"]}},
            },
        },
    }
    base["mcpServers"].update(extra)
    return base


# ── Chargement fichier ───────────────────────────────────────────────────────

def test_fichier_charge_et_substitue(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "svc-123")
    manifest_file(_doc())
    m = M.load()
    assert m.source == "file" and not m.errors
    th = m.toolhost()
    assert th is not None and th.name == "elpis-tools"
    assert th.token == "svc-123"
    assert th.families == ["fs", "git", "browser"]
    assert th.fallback["command"] == (os.sys.executable or "python3")
    assert M.service_upstream() == ("http://127.0.0.1:8765/mcp", "svc-123")


def test_substitution_file_et_root(tmp_path, manifest_file, monkeypatch):
    tok = tmp_path / "tok"
    tok.write_text("abc\n", encoding="utf-8")
    doc = _doc()
    doc["mcpServers"]["elpis-tools"]["headers"] = {"Authorization": f"Bearer ${{file:{tok}}}"}
    manifest_file(doc)
    assert M.load().toolhost().token == "abc"
    assert M.substitute("${root}/x").endswith("/x")


def test_variable_absente_donne_vide_et_avertit(manifest_file, monkeypatch):
    monkeypatch.delenv("T_MCP_TOKEN", raising=False)
    manifest_file(_doc())
    m = M.load()
    assert m.toolhost().token == ""
    assert any("T_MCP_TOKEN" in w for w in m.warnings)
    # sans jeton de service : rien à relayer (invariant fs/shell)
    assert M.service_upstream() == (None, "")


def test_default_on_et_categories(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    manifest_file(_doc())
    m = M.load()
    assert m.default_on_categories() == {"fs"}
    # todo → catégorie ``task``
    doc = _doc(); doc["mcpServers"]["elpis-tools"]["x-elpis"]["families"] = ["todo", "fs"]
    doc["mcpServers"]["elpis-tools"]["x-elpis"]["default_on"] = ["todo"]
    manifest_file(doc)
    assert M.load().default_on_categories() == {"task"}


def test_opencode_familles_exclusion_invariante(manifest_file, monkeypatch):
    """``fs`` demandée pour opencode dans le fichier : REFUSÉE (règle
    utilisateur : fs/shell jamais exposées à opencode)."""
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    monkeypatch.delenv("LOCAL_MCP_OPENCODE_FAMILIES", raising=False)
    manifest_file(_doc())
    assert M.load().opencode_families() == ["git", "browser"]
    from shared_infra.mcp.families import opencode_families
    assert opencode_families() == ["git", "browser"]


def test_env_prime_sur_le_fichier(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    monkeypatch.setenv("LOCAL_MCP_URL", "http://10.0.0.5:9000/mcp")
    monkeypatch.setenv("LOCAL_MCP_TOKEN", "env-tok")
    monkeypatch.setenv("LOCAL_MCP_TOOL_FAMILIES", "git")
    manifest_file(_doc())
    th = M.load().toolhost()
    assert th.url == "http://10.0.0.5:9000/mcp" and th.token == "env-tok"
    assert th.families == ["git"]
    assert th.probe_before_use is False            # explicite = de confiance


def test_sonde_loopback_avec_repli_pas_distant(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    monkeypatch.delenv("LOCAL_MCP_URL", raising=False)
    manifest_file(_doc())
    assert M.load().toolhost().probe_before_use is True
    doc = _doc(); doc["mcpServers"]["elpis-tools"]["url"] = "http://vm-outils:8765/mcp"
    manifest_file(doc)
    th = M.load().toolhost()
    assert th.probe_before_use is False and th.fallback   # distant : jamais sondé


# ── Serveurs externes déclarés ───────────────────────────────────────────────

def test_externe_declare_resolu_par_le_serveur(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    manifest_file(_doc(weather={"type": "http", "url": "http://10.0.0.12:9100/mcp",
                                "headers": {"Authorization": "Bearer w"},
                                "description": "Météo",
                                "x-elpis": {"default_on": True, "opencode": {"publish": True}}}))
    m = M.load()
    assert [e.name for e in m.externals()] == ["weather"]
    assert m.default_on_externals() == ["weather"]
    c = M.resolve_external_cfg("weather")
    assert c["type"] == "http" and c["url"].startswith("http://10.0.0.12") \
        and c["headers"]["Authorization"] == "Bearer w" and c["identity"] == "token"
    assert M.resolve_external_cfg("elpis-tools") is None      # intégré : sentinelle
    assert M.resolve_external_cfg("inconnu") is None
    from shared_infra.mcp.local_registry import opencode_local_servers
    assert [d["name"] for d in opencode_local_servers()] == ["weather"]


def test_externe_ne_recoit_jamais_identity_meta(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    manifest_file(_doc(evil={"type": "http", "url": "http://x/mcp",
                             "x-elpis": {"identity": "meta"}}))
    m = M.load()
    assert m.get("evil").identity == "token"
    assert any("identity=meta refusée" in w for w in m.warnings)


def test_entree_desactivee_et_stdio_sans_command(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    manifest_file(_doc(off={"type": "http", "url": "http://x/mcp", "enabled": False},
                       bad={"type": "stdio"}))
    m = M.load()
    assert "bad" not in m.servers
    assert m.get("off").enabled is False and M.resolve_external_cfg("off") is None
    assert [e.name for e in m.externals()] == []


def test_famille_inconnue_ignoree_jamais_de_module_arbitraire(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    doc = _doc(); doc["mcpServers"]["elpis-tools"]["x-elpis"]["families"] = ["fs", "os.system"]
    manifest_file(doc)
    m = M.load()
    assert m.toolhost().families == ["fs"]
    assert any("os.system" in w for w in m.warnings)


# ── Fichier cassé / schéma ───────────────────────────────────────────────────

def test_fichier_illisible_repli_synthese_sans_perdre_les_outils(tmp_path, monkeypatch):
    p = tmp_path / "mcp.json"; p.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("APP_MCP_MANIFEST", str(p))
    m = M.reload()
    assert m.source == "synthesized" and m.errors and m.toolhost() is not None
    M.reload()


def test_schema_signale_une_erreur_sans_bloquer(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    doc = _doc(); doc["mcpServers"]["elpis-tools"]["x-elpis"]["role"] = "pirate"
    manifest_file(doc)
    m = M.load()
    assert m.source == "file" and m.errors                 # schéma : enum violée
    assert m.toolhost() is None                            # rôle inconnu → external


def test_racine_servers_vscode_acceptee(manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    doc = _doc(); doc["servers"] = doc.pop("mcpServers")
    manifest_file(doc)
    assert M.load().toolhost() is not None


# ── Synthèse (aucun fichier) = comportement hérité ───────────────────────────

def test_synthese_reflete_la_config_heritee(monkeypatch):
    monkeypatch.setenv("APP_MCP_MANIFEST", "/nonexistent/mcp.json")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:8765/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_IS_DERIVED", True)
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "svc")
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOOL_FAMILIES", "all,-desktop")
    monkeypatch.delenv("LOCAL_MCP_TOOL_FAMILIES", raising=False)
    m = M.load()
    th = m.toolhost()
    assert m.source == "synthesized" and th.url == "http://127.0.0.1:8765/mcp"
    assert th.token == "svc" and th.probe_before_use is True
    assert "desktop" not in th.families and "fs" in th.families
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL_IS_DERIVED", False)
    assert M.load().toolhost().probe_before_use is False


def test_synthese_reverse_mcp_local_servers_avec_depreciation(monkeypatch):
    monkeypatch.setenv("APP_MCP_MANIFEST", "/nonexistent/mcp.json")
    monkeypatch.setattr(cfg, "LOCAL_MCP_SERVERS_RAW", {
        "weather": {"transport": "streamable-http", "url": "http://127.0.0.1:9100/mcp",
                    "expose_opencode": True},
        "notes": {"transport": "stdio", "command": "python", "args": ["n.py"]},
    })
    m = M.load()
    assert {e.name for e in m.externals()} == {"weather", "notes"}
    assert m.get("weather").opencode_publish is True
    assert any("déprécié" in w for w in m.warnings)


def test_builtin_client_cfg_garde_la_sentinelle(monkeypatch):
    c = M.builtin_client_cfg(["fs", "git"])
    assert c["type"] == "stdio" and c["command"] == "DEFAULT_LOCAL_PYTHON"
    assert c["filter_categories"] == ["fs", "git"] and c["identity"] == "meta"


def test_le_manifeste_de_reference_du_depot_est_valide():
    """(2026-09-12) UNE entrée par famille : chacune a son endpoint, et la
    retirer suffit à retirer ses outils. Aucune entrée ne doit servir deux
    familles — sinon deux endpoints rendraient les mêmes outils."""
    p = Path(__file__).resolve().parents[2] / "mcp.example.json"
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert M.validate_raw(raw) == []
    srv = raw["mcpServers"]
    seen = []
    for name, spec in srv.items():
        xe = spec["x-elpis"]
        assert len(xe["families"]) == 1, f"{name} sert plusieurs familles"
        assert xe["families"][0] not in seen, f"{xe['families'][0]} servie deux fois"
        seen.append(xe["families"][0])
        assert xe.get("default_on") in (None, [], False)   # décision 2026-07-13
        if xe["role"] == "toolhost":
            assert spec["url"].endswith("/mcp/" + xe["families"][0])
            assert "Bearer ${file:" in spec["headers"]["Authorization"]
        else:
            assert spec["type"] == "inprocess"
    from shared_infra.mcp.families import FAMILY_NAMES
    assert sorted(seen) == sorted(FAMILY_NAMES)
    assert [n for n, s in srv.items() if s["x-elpis"].get("opencode", {}).get("publish")] \
        == ["elpis-git", "elpis-browser", "elpis-desktop"]


# ── Routes (panneau + admin) ─────────────────────────────────────────────────

@pytest.fixture
def routes_client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import shared_infra.mcp.panel as panel
    from shared_infra.routes._state import router
    from shared_infra.routes.admin._state import admin_router
    monkeypatch.setattr(panel, "require_user_id", lambda request: 1)
    monkeypatch.setattr(panel, "_require_admin", lambda request: 1)
    app = FastAPI()
    app.include_router(router)
    app.include_router(admin_router)
    return TestClient(app)


def test_route_manifest_servers_ne_divulgue_ni_url_ni_entetes(routes_client, manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    manifest_file(_doc(weather={"type": "http", "url": "http://10.0.0.12:9100/mcp",
                                "headers": {"Authorization": "Bearer w"},
                                "description": "Météo", "x-elpis": {"default_on": True}},
                       off={"type": "http", "url": "http://x/mcp", "enabled": False}))
    r = routes_client.get("/api/mcp/manifest-servers")
    assert r.status_code == 200
    srv = r.json()["servers"]
    assert [s["name"] for s in srv] == ["weather"]          # intégré et désactivé exclus
    assert srv[0]["default_on"] is True and "url" not in srv[0] and "headers" not in srv[0]


def test_route_admin_manifest_masque_les_jetons_et_sonde(routes_client, manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "super-secret")
    doc = _doc(); doc["mcpServers"]["elpis-tools"]["url"] = "http://127.0.0.1:1/mcp"
    manifest_file(doc)
    r = routes_client.get("/api/admin/mcp/manifest")
    assert r.status_code == 200
    m = r.json()["manifest"]
    assert "super-secret" not in r.text
    row = m["servers"][0]
    assert row["name"] == "elpis-tools" and row["has_token"] is True
    assert row["reachable"] is False and row["fallback"] is True
    assert m["source"] == "file" and m["manifest_path"]


def test_route_admin_reload_relit_le_fichier(routes_client, manifest_file, monkeypatch):
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    p = manifest_file(_doc())
    assert [s["name"] for s in routes_client.get("/api/admin/mcp/manifest").json()["manifest"]["servers"]] == ["elpis-tools"]
    doc = _doc(weather={"type": "http", "url": "http://10.0.0.12:9100/mcp"})
    p.write_text(json.dumps(doc), encoding="utf-8")
    os.utime(p, (p.stat().st_atime, p.stat().st_mtime + 5))
    r = routes_client.post("/api/admin/mcp/manifest/reload")
    assert r.status_code == 200 and set(r.json()["servers"]) == {"elpis-tools", "weather"}


# ── Route de chat : plus de serveurs synthétiques, une seule règle ───────────

def test_la_route_de_chat_joint_le_toolhost_du_manifeste():
    src = (Path(__file__).resolve().parents[2] / "chatbot_app" / "routes" / "chats.py").read_text(encoding="utf-8")
    assert "builtin_client_cfg" in src
    for ghost in ('"name": "Mémoire"', '"name": "Agents"', '"name": "Tâches"'):
        assert ghost not in src, f"serveur synthétique encore fabriqué : {ghost}"
    # les entrées ``manifest`` envoyées par le navigateur sont résolues par le serveur
    assert "resolve_external_cfg" in src and '"mf:" + str(_srv["manifest"])' in src


def test_socle_des_agents_custom_suit_default_on(manifest_file, monkeypatch):
    from llm_core.tools.task_tool import custom_default_categories, CUSTOM_DEFAULT_CATEGORIES
    monkeypatch.setenv("APP_MCP_MANIFEST", "/nonexistent/mcp.json")
    assert custom_default_categories() == list(CUSTOM_DEFAULT_CATEGORIES)
    monkeypatch.setenv("T_MCP_TOKEN", "t")
    doc = _doc(); doc["mcpServers"]["elpis-tools"]["x-elpis"]["default_on"] = ["git", "browser"]
    manifest_file(doc)
    assert custom_default_categories() == ["browser", "git"]
