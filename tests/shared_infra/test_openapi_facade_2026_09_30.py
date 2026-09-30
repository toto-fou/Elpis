# SPDX-License-Identifier: MIT
"""Façade OpenAPI des outils (EXT.5, 2026-09-30).

Ce que ce fichier verrouille :
  • la spec 3.1 est générée depuis ``tools/list`` : un ``POST /<outil>`` par
    outil (parité), ``$defs`` remontés en composants SANS collision entre
    outils, ``$ref`` réécrits, résultat « enveloppé » de FastMCP déplié ;
  • authentification par jeton d'outils ``ept_`` SEUL (ni cookie, ni ``pcr_``),
    façade coupée par l'admin = 404 partout ;
  • portée = familles exposables ∩ politique ∩ jeton, 404 sans oracle
    (les familles de l'app ne sortent jamais ; ``browser`` seulement coché) ;
  • arguments validés (422), identité = PROPRIÉTAIRE du jeton (le corps ne
    peut pas la choisir), échec d'outil = 200 ``ok: false``, transport = 502,
    concurrence bornée = 429 ;
  • aucune route existante sous ``/api/tools`` n'est capturée.
"""
from __future__ import annotations

import sys
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from mcp.types import CallToolResult, TextContent, Tool, ToolAnnotations

# Vrais modules chargés AVANT que la fixture ne substitue un faux ``tokens`` :
# sinon ``routes_tokens`` (importé par ``shared_infra.routes``) se lierait au
# faux pour toute la session de test et casserait d'autres fichiers.
import shared_infra.accounts.tokens  # noqa: F401
import shared_infra.routes  # noqa: F401 — enregistre tout
from shared_infra.mcp import openapi as oa

_ERR_ENVELOPE = {"type": "object", "properties": {"ok": {"const": False}, "error": {"type": "string"}}}

TOOLS = {
    "git": [
        Tool(name="git_status", title="État du dépôt", description="Statut git.",
             inputSchema={"type": "object",
                          "properties": {"path": {"type": "string"},
                                         "opts": {"$ref": "#/$defs/Opts"}},
                          "required": ["path"],
                          "$defs": {"Opts": {"type": "object",
                                             "properties": {"short": {"type": "boolean"}}}}},
             outputSchema={"type": "object", "properties": {"branch": {"type": "string"}}},
             annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False)),
        Tool(name="git_log", description="Historique.",
             inputSchema={"type": "object",
                          "properties": {"opts": {"$ref": "#/$defs/Opts"}},
                          "$defs": {"Opts": {"type": "object",
                                             "properties": {"limit": {"type": "integer"}}}}},
             outputSchema={"type": "object", "x-fastmcp-wrap-result": True,
                           "properties": {"result": {"type": "array",
                                                     "items": {"type": "string"}}},
                           "required": ["result"]}),
    ],
    "shell": [
        Tool(name="execute_shell", description="Commande.",
             inputSchema={"type": "object", "properties": {"command": {"type": "string"}},
                          "required": ["command"], "additionalProperties": True}),
    ],
    "skill_run": [
        Tool(name="skill_run_script", description="Script de skill.",
             inputSchema={"type": "object", "properties": {}}),
    ],
    "browser": [
        Tool(name="pw_goto", description="Ouvre une page.",
             inputSchema={"type": "object", "properties": {"url": {"type": "string"}},
                          "required": ["url"]}),
    ],
}


class _Pool:
    """Pool MCP simulé : observe exactement ce que la façade envoie."""

    def __init__(self):
        self.calls: list = []
        self.result = CallToolResult(content=[TextContent(type="text", text='{"ok": true}')],
                                     structuredContent={"branch": "main"})
        self.error: BaseException | None = None
        self.connect_error: BaseException | None = None

    async def get_or_connect(self, cfg, resolve_client_fn=None):
        if self.connect_error:
            raise self.connect_error
        return object(), list(TOOLS.get(cfg["families"][0], []))

    async def call_tool(self, cfg, name, arguments, resolve_client_fn=None, meta=None,
                        exec_timeout_s=None, queue_timeout_s=None, **_kw):
        self.calls.append({"family": cfg["families"][0], "name": name,
                           "arguments": arguments, "meta": meta, "timeout": exec_timeout_s})
        if self.error:
            raise self.error
        return self.result


@pytest.fixture()
def env(monkeypatch):
    oa.clear_cache()
    state = {
        "policy": {"tools_enabled": True, "tools_families": ["fs", "shell", "git", "desktop",
                                                             "skill_run", "browser"],
                   "max_days": 90, "max_per_user": 20},
        "tokens": {"ept_bon": {"id": 7, "user_id": 3, "username": "alice", "kind": "tools",
                               "families": ["git", "shell", "browser", "memory", "skill_run"]}},
        "resolved": [], "touched": [],
    }
    fake = types.ModuleType("shared_infra.accounts.tokens")

    def resolve(token, kinds=("tools",)):
        state["resolved"].append((token, tuple(kinds)))
        info = state["tokens"].get(token)
        return dict(info) if info and info["kind"] in kinds else None

    fake.resolve = resolve
    fake.policy = lambda: dict(state["policy"])
    fake.touch_last_used = lambda token_id: state["touched"].append(token_id)
    monkeypatch.setitem(sys.modules, "shared_infra.accounts.tokens", fake)
    import shared_infra.accounts as accounts_pkg
    monkeypatch.setattr(accounts_pkg, "tokens", fake, raising=False)

    monkeypatch.setattr(oa, "family_cfg", lambda fam: {"type": "stdio", "name": f"elpis-{fam}",
                                                       "families": [fam]})
    pool = _Pool()
    import llm_core._mcp_pool as mp
    monkeypatch.setattr(mp, "mcp_pool", pool)

    import shared_infra.mcp.routes_openapi as ro
    monkeypatch.setattr(ro, "_in_flight", {})
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), state, pool


H = {"Authorization": "Bearer ept_bon"}


# ── Génération ───────────────────────────────────────────────────────────────

def test_spec_31_parite_et_composants(env):
    c, _state, _pool = env
    r = c.get("/api/tools/git/openapi.json", headers=H)
    assert r.status_code == 200, r.text
    spec = r.json()
    assert spec["openapi"] == "3.1.0"
    assert set(spec["paths"]) == {"/" + t.name for t in TOOLS["git"]}          # parité tools/list
    assert spec["servers"][0]["url"].endswith("/api/tools/git")
    op = spec["paths"]["/git_status"]["post"]
    assert op["operationId"] == "git_status" and op["summary"] == "État du dépôt"
    assert op["x-elpis-annotations"] == {"readOnlyHint": True, "destructiveHint": False}
    assert set(op["responses"]) >= {"200", "401", "404", "422", "429", "502"}
    schemas = spec["components"]["schemas"]
    # Deux outils déclarent un « Opts » différent : aucun n'écrase l'autre.
    assert schemas["git_status.Opts"]["properties"] == {"short": {"type": "boolean"}}
    assert schemas["git_log.Opts"]["properties"] == {"limit": {"type": "integer"}}
    corps = schemas["git_status.input"]
    assert corps["properties"]["opts"] == {"$ref": "#/components/schemas/git_status.Opts"}
    assert "$defs" not in corps
    # Résultat enveloppé de FastMCP : la spec décrit la valeur elle-même.
    assert schemas["git_log.out.output"] == {"type": "array", "items": {"type": "string"}}
    for s in schemas.values():
        Draft202012Validator.check_schema(s)
    # Tous les $ref pointent sur un composant existant.
    import json
    for ref in {p.split('"')[0] for p in json.dumps(spec).split('"$ref": "')[1:]}:
        assert ref.startswith("#/components/"), ref
        kind, name = ref.split("/")[2:4]
        assert name in spec["components"][kind], ref


# ── Authentification ─────────────────────────────────────────────────────────

def test_sans_jeton_401_avec_defi(env):
    c, _s, _p = env
    r = c.get("/api/tools/git/openapi.json")
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"


def test_jeton_invalide_ou_pcr_refuse(env):
    c, state, _p = env
    state["tokens"]["pcr_opencode"] = {"id": 8, "user_id": 3, "username": "alice",
                                       "kind": "opencode", "families": ["git"]}
    for jeton in ("ept_inconnu", "pcr_opencode", "n_importe_quoi"):
        r = c.get("/api/tools/git/openapi.json", headers={"Authorization": f"Bearer {jeton}"})
        assert r.status_code == 401, jeton
    # Un pcr_ n'est même pas soumis à la résolution des jetons d'outils.
    assert all(t.startswith("ept_") for t, _k in state["resolved"])
    assert all(k == ("tools",) for _t, k in state["resolved"])


def test_cookie_de_session_ne_suffit_pas(env):
    c, _s, _p = env
    c.cookies.set("session", "une-session-valide")
    assert c.post("/api/tools/git/git_status", json={"path": "."}).status_code == 401


def test_facade_coupee_par_l_admin_404_partout(env):
    c, state, pool = env
    state["policy"]["tools_enabled"] = False
    assert c.get("/api/tools/git/openapi.json", headers=H).status_code == 404
    assert c.post("/api/tools/git/git_status", headers=H, json={"path": "."}).status_code == 404
    assert c.get("/api/tools/git/openapi.json").status_code == 404        # même sans jeton
    assert pool.calls == []


# ── Portée ───────────────────────────────────────────────────────────────────

def test_browser_expose_s_il_est_coche(env):
    """browser : exposé depuis la garde du service navigateur, si le jeton
    l'a coché et que la politique le permet."""
    c, state, _pool = env
    r = c.get("/api/tools/browser/openapi.json", headers=H)
    assert r.status_code == 200 and set(r.json()["paths"]) == {"/pw_goto"}
    state["policy"]["tools_families"] = ["git", "shell", "skill_run"]
    assert c.get("/api/tools/browser/openapi.json", headers=H).status_code == 404


@pytest.mark.parametrize("famille", ["fs", "desktop", "memory", "chart", "inconnue"])
def test_hors_portee_404(env, famille):
    """fs, desktop : non cochées sur le jeton ; memory/chart : familles de
    l'app, jamais exposées même cochées."""
    c, _s, pool = env
    assert c.get(f"/api/tools/{famille}/openapi.json", headers=H).status_code == 404
    assert c.post(f"/api/tools/{famille}/x", headers=H, json={}).status_code == 404
    assert pool.calls == []


def test_politique_admin_retire_une_famille(env):
    c, state, _p = env
    state["policy"]["tools_families"] = ["shell"]
    assert c.get("/api/tools/git/openapi.json", headers=H).status_code == 404
    assert c.get("/api/tools/shell/openapi.json", headers=H).status_code == 200


def test_outil_inconnu_404(env):
    c, _s, pool = env
    assert c.post("/api/tools/git/execute_shell", headers=H, json={}).status_code == 404
    assert pool.calls == []


# ── Appel ────────────────────────────────────────────────────────────────────

def test_arguments_invalides_422(env):
    c, _s, pool = env
    r = c.post("/api/tools/git/git_status", headers=H, json={"path": 3})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "path"
    r = c.post("/api/tools/git/git_status", headers=H, json={})
    assert r.status_code == 422 and "path" in r.json()["errors"][0]["message"]
    assert c.post("/api/tools/git/git_status", headers=H, json=[1]).status_code == 422
    assert c.post("/api/tools/git/git_status", headers={**H, "content-type": "application/json"},
                  content=b"{pas du json").status_code == 422
    assert pool.calls == []


def test_appel_au_nom_du_proprietaire(env):
    c, state, pool = env
    r = c.post("/api/tools/shell/execute_shell", headers=H,
               json={"command": "ls", "username": "bob", "user_id": 1})
    assert r.status_code == 200, r.text
    (call,) = pool.calls
    assert call["name"] == "execute_shell" and call["family"] == "shell"
    # Identité = propriétaire du jeton ; les champs homonymes du corps restent
    # de simples arguments, jamais l'identité.
    assert call["meta"]["username"] == "alice" and call["meta"]["user_id"] == "3"
    assert "chat_id" not in call["meta"]
    assert call["arguments"]["username"] == "bob"
    assert call["timeout"] and call["timeout"] >= 600          # délai propre au shell
    assert state["touched"] == [7]


def test_reponse_structuree_et_enveloppe_depliee(env):
    c, _s, pool = env
    assert c.post("/api/tools/git/git_status", headers=H,
                  json={"path": "."}).json() == {"branch": "main"}
    pool.result = CallToolResult(content=[TextContent(type="text", text='{"result": ["a"]}')],
                                 structuredContent={"result": ["a", "b"]})
    assert c.post("/api/tools/git/git_log", headers=H, json={}).json() == ["a", "b"]
    pool.result = CallToolResult(content=[TextContent(type="text", text="texte brut")])
    assert c.post("/api/tools/skill_run/skill_run_script", headers=H,
                  json={}).json() == {"text": "texte brut"}


def test_echec_d_outil_200_ok_false(env):
    c, _s, pool = env
    pool.result = CallToolResult(isError=True, content=[TextContent(
        type="text", text='{"ok": false, "error": "not_a_repo", "fix": "git init"}')])
    r = c.post("/api/tools/git/git_status", headers=H, json={"path": "."})
    assert r.status_code == 200
    assert r.json() == {"ok": False, "error": "not_a_repo", "fix": "git init"}


def test_erreur_levee_par_l_outil_reste_un_echec_d_outil(env):
    c, _s, pool = env
    pool.error = ValueError("argument refusé par le serveur")
    r = c.post("/api/tools/git/git_status", headers=H, json={"path": "."})
    assert r.status_code == 200 and r.json()["ok"] is False
    assert "refusé" in r.json()["error"]


def test_transport_502(env):
    c, _s, pool = env
    pool.error = ConnectionRefusedError("service arrêté")
    assert c.post("/api/tools/git/git_status", headers=H, json={"path": "."}).status_code == 502
    oa.clear_cache()
    pool.connect_error = OSError("injoignable")
    assert c.get("/api/tools/git/openapi.json", headers=H).status_code == 502


def test_concurrence_par_compte_429(env, monkeypatch):
    c, _s, pool = env
    import shared_infra.mcp.routes_openapi as ro
    monkeypatch.setattr(ro, "_in_flight", {3: ro.MAX_CONCURRENT_PER_USER})
    r = c.post("/api/tools/git/git_status", headers=H, json={"path": "."})
    assert r.status_code == 429 and r.headers["retry-after"]
    assert pool.calls == []
    # Un autre compte n'est pas concerné, et le compteur retombe après l'appel.
    monkeypatch.setattr(ro, "_in_flight", {})
    assert c.post("/api/tools/git/git_status", headers=H, json={"path": "."}).status_code == 200
    assert ro._in_flight == {}


def test_service_sature_429(env):
    c, _s, pool = env
    from llm_core._mcp_pool import MCPQueueSaturated
    pool.error = MCPQueueSaturated("file pleine")
    assert c.post("/api/tools/git/git_status", headers=H, json={"path": "."}).status_code == 429


# ── Routes ───────────────────────────────────────────────────────────────────

def test_ne_capture_pas_les_routes_existantes_sous_api_tools():
    from starlette.routing import Match

    from shared_infra.routes._state import router

    def premier(path, methode):
        scope = {"type": "http", "path": path, "method": methode}
        for r in router.routes:
            m, _ = r.matches(scope)
            if m == Match.FULL:
                return r
        return None

    for p in ("/api/tools/extract-text", "/api/tools/parse-file"):
        assert premier(p, "POST").endpoint.__module__ == "shared_infra.routes.tools", p
    assert premier("/api/tools/git/git_status", "POST").endpoint.__module__ \
        == "shared_infra.mcp.routes_openapi"
    assert premier("/api/tools/git/openapi.json", "GET").endpoint.__module__ \
        == "shared_infra.mcp.routes_openapi"


def test_entree_multi_familles_filtree_par_categorie():
    """Manifeste synthétisé (une seule entrée pour toutes les familles) : la
    liste contient tout le service ; la famille est retrouvée par catégorie,
    et ``skill_run`` ne récupère pas la bibliothèque de skills (app)."""
    def outil(nom, cat):
        return {"name": nom, "meta": {"category": cat}, "inputSchema": {"type": "object"}}
    tous = [outil("git_status", "git"), outil("execute_shell", "shell"),
            outil("skill_run_script", "skill"), outil("skill_save", "skill"),
            outil("memory_save", "memory")]
    cfg = {"families": ["fs", "shell", "git", "skill", "skill_run", "memory"]}
    assert [t["name"] for t in oa._filter_family("git", tous, cfg)] == ["git_status"]
    assert [t["name"] for t in oa._filter_family("skill_run", tous, cfg)] == ["skill_run_script"]
    assert oa._filter_family("fs", tous, cfg) == []
    # Entrée d'UNE famille : le service a déjà restreint la liste.
    assert oa._filter_family("git", tous[:1], {"families": ["git"]}) == tous[:1]


def test_corps_trop_volumineux_413(env):
    c, _s, pool = env
    gros = {"command": "x" * (9 * 1024 * 1024)}
    assert c.post("/api/tools/shell/execute_shell", headers=H, json=gros).status_code == 413
    assert pool.calls == []


def test_hote_non_reconnu_url_relative(env, monkeypatch):
    """Un en-tête Host non reconnu ne fait pas échouer la spec : URL relative."""
    from fastapi import HTTPException

    import shared_infra.opencode.routes_cli as rc

    def refuse(_req):
        raise HTTPException(400, "Hôte invalide")
    monkeypatch.setattr(rc, "_app_url", refuse)
    c, _s, _p = env
    r = c.get("/api/tools/git/openapi.json", headers=H)
    assert r.status_code == 200 and r.json()["servers"][0]["url"] == "/api/tools/git"
