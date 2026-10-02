# SPDX-License-Identifier: MIT
"""tests/llm_core/test_child_tool_surface_2026_08_06.py — la surface d'outils
d'un sous-agent ne dépend PAS du panneau Outils du parent.

Symptôme signalé : « quand les outils locaux ne sont pas activés, les agents
n'ont pas leurs outils et ne font que des tool_help ». Le diagnostic (cf.
docs/outils-agents-bibliotheque-mcp-design-2026-08-06.md) :

- les agents INTÉGRÉS reconstruisent leur config MCP de zéro — un parent sans
  aucune catégorie cochée ne les ampute de rien. C'est l'invariant que ce
  module verrouille, de bout en bout : config posée par ``task_tool`` PUIS
  filtrage réel par ``_collect_mcp_tools`` ;
- le seul cas où une surface se réduisait à ``tool_help`` était une surface
  VIDE — un agent CUSTOM enregistré sans aucune catégorie. ``tool_help``
  retiré, un tel agent ne doit plus ouvrir de serveur local du tout (sinon
  ``_collect_mcp_tools`` lève « Impossible de se connecter » alors que la
  connexion, elle, a parfaitement marché).
"""
from __future__ import annotations

import pytest

import llm_core._chat_with_tools as cwt
import llm_core._mcp_categories as cats
from llm_core import _mcp_pool
from llm_core.engine import tool_catalog as _tool_catalog
from llm_core.tools import task_tool
from llm_core.tools.task_tool import _AGENTS, build_task_builtin_tool

pytestmark = pytest.mark.asyncio


# Catalogue local SIMULÉ : le serveur MCP local renvoie TOUJOURS tout, quel que
# soit le ``filter_categories`` du client (le filtrage est côté client). On y
# met l'union des allowlists intégrées + de quoi vérifier ce qui doit être exclu.
_CATALOGUE = {
    "read_file": "fs", "list_files": "fs", "code": "fs",
    "write_file": "fs", "edit_file": "fs", "manage_files": "fs",
    "execute_shell": "shell",
    "git_query": "git", "git_inspect": "git", "git_rf": "git",
    "git_start_work": "git", "git_commit": "git", "git_submit": "git",
    "git_action": "git", "git_abandon": "git",
    "pw_session": "browser", "pw_find": "browser", "pw_act": "browser",
    "pw_page": "browser", "pw_wait": "browser", "pw_expect": "browser",
    "pw_observe": "browser", "pw_chain": "browser",
    "generate_chart": "chart",
    "memory": "memory",
    "todowrite": "task",          # catégorie CACHÉE
}


class _FakePool:
    """Le serveur local, vu du client : tout le catalogue, à chaque connexion."""

    async def get_or_connect(self, cfg, resolve_client_fn=None):
        return object(), [
            {"name": n, "description": "", "inputSchema": {"type": "object"}}
            for n in _CATALOGUE
        ]


@pytest.fixture
def local_tools(monkeypatch):
    monkeypatch.setattr(cats, "categorize", lambda n: _CATALOGUE.get(n, "other"))
    monkeypatch.setattr(cats, "get_hidden_categories", lambda: ["task"])
    monkeypatch.setattr(cats, "manifest_source", lambda: "live")
    monkeypatch.setattr(_mcp_pool, "mcp_pool", _FakePool())


class _CaptureRunner:
    """Capture les kwargs passés au run de l'enfant (pas d'appel LLM)."""

    def __init__(self):
        self.calls = []

    async def __call__(self, messages, **kwargs):
        self.calls.append(kwargs)
        return "ok", [], {"input_tokens": 1, "output_tokens": 1}


def _spawn(monkeypatch, *, agent, parent_configs, custom_agents=None,
           user_mcp_configs=None):
    runner = _CaptureRunner()
    monkeypatch.setattr(cwt, "run_chat_multi_mcp", runner, raising=True)
    monkeypatch.setattr(cwt, "run_chat_multi_mcp_v2", runner, raising=True)
    bt = build_task_builtin_tool(
        parent_mcp_configs=parent_configs,
        parent_builtin_tools=None,
        username="u", chat_id="c", model="m",
        sampling_override=None, memory_enabled=False,
        is_cancelled=lambda: False, on_event=None,
        scheduling_mode="classic", usage_sink=None,
        custom_agents=custom_agents, user_mcp_configs=user_mcp_configs,
    )
    return runner, bt["task"]["handler"], agent


# Ce que le front envoie quand AUCUNE catégorie locale n'est cochée et que les
# sous-agents sont activés (cf. routes/chats.py, branche « Agents »).
_PARENT_SANS_OUTILS = [{
    "type": "stdio", "name": "Agents",
    "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": [],
}]


async def test_parent_sans_outils_ne_voit_que_les_categories_cachees(local_tools):
    """Le point de départ du symptôme : ce parent-là n'a effectivement qu'un
    outil. C'était ``tool_help`` + ``todowrite`` ; ``tool_help`` retiré, il ne
    reste que la todo-list — plus rien qui invite le modèle à s'occuper."""
    _map, payload, _h, _n = await _tool_catalog._collect_mcp_tools(
        _PARENT_SANS_OUTILS, None, None, memory_enabled=False)
    assert {t["function"]["name"] for t in payload} == {"todowrite"}


@pytest.mark.parametrize("agent", list(_AGENTS))
async def test_agent_integre_recoit_ses_categories_entieres(
        monkeypatch, local_tools, agent):
    """Bout en bout, parent SANS aucune catégorie cochée : l'enfant reçoit
    l'INTÉGRALITÉ des catégories pré-cochées de son type — exactement ce qu'un
    chat obtient en activant les mêmes toggles. Plus d'allowlist par outil : un
    agent amputé d'un geste s'arrête à un outil près et rend « je n'ai pas
    l'outil » au lieu d'une réponse."""
    runner, handler, _ = _spawn(monkeypatch, agent=agent,
                                parent_configs=_PARENT_SANS_OUTILS)
    await handler({"subagent_type": agent, "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    assert kw["allowed_tool_names"] is None, "plus d'allowlist par outil"

    _map, payload, _h, _n = await _tool_catalog._collect_mcp_tools(
        kw["mcp_configs"], kw.get("builtin_tools"), None,
        allowed_tool_names=kw["allowed_tool_names"],
        memory_enabled=kw["memory_enabled"],
        deny_tool_names=kw["deny_tool_names"],
    )
    exposed = {t["function"]["name"] for t in payload}
    cats = set(_AGENTS[agent].filter_categories)
    expected = {n for n, c in _CATALOGUE.items() if c in cats}
    assert exposed == expected, f"{agent} : surface {exposed}, attendu {expected}"
    # Une catégorie NON pré-cochée reste dehors (c'est là que vit la frontière).
    hors = {n for n, c in _CATALOGUE.items() if c not in cats and c != "task"}
    assert not (exposed & hors)
    # Aucune fuite par les catégories cachées : todowrite est dénié chez l'enfant.
    assert "todowrite" not in exposed


@pytest.mark.parametrize("agent", list(_AGENTS))
async def test_chaque_agent_a_une_surface_de_vrai_chat(local_tools, agent):
    """Garde-fou de la RÈGLE : un agent doit disposer d'un outillage complet,
    pas de deux ou trois outils. Le seuil est bas exprès — il n'attrape pas une
    surface un peu juste, il attrape un retour à l'allowlist nominative."""
    spec = _AGENTS[agent]
    cats = set(spec.filter_categories)
    n = len({t for t, c in _CATALOGUE.items() if c in cats})
    assert spec.allowed_tool_names is None, f"{agent} : allowlist par outil"
    assert n >= 10, f"{agent} : {n} outils seulement pour {sorted(cats)}"


async def test_agent_custom_sans_categorie_recoit_le_socle_par_defaut(
        monkeypatch, local_tools):
    """Un agent custom enregistré sans aucune catégorie ne part PAS les mains
    vides : il reçoit le socle de travail (fs/shell/git). Un agent sans outils
    n'est pas un agent — il lit sa mission et ne peut rien en faire."""
    from llm_core.tools.task_tool import CUSTOM_DEFAULT_CATEGORIES

    customs = [{"name": "redacteur", "description": "d", "prompt": "P.",
                "tool_categories": [], "mcp_server_ids": []}]
    runner, handler, _ = _spawn(monkeypatch, agent="redacteur",
                                parent_configs=_PARENT_SANS_OUTILS,
                                custom_agents=customs)
    await handler({"subagent_type": "redacteur", "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    assert kw["mcp_configs"][0]["filter_categories"] == CUSTOM_DEFAULT_CATEGORIES

    _map, payload, _h, _n = await _tool_catalog._collect_mcp_tools(
        kw["mcp_configs"], None, None,
        allowed_tool_names=kw["allowed_tool_names"],
        memory_enabled=kw["memory_enabled"],
        deny_tool_names=kw["deny_tool_names"],
    )
    exposed = {t["function"]["name"] for t in payload}
    assert {"read_file", "write_file", "execute_shell", "git_query"} <= exposed
    assert "todowrite" not in exposed


async def test_le_socle_par_defaut_est_ecrit_dans_lagent_pas_applique_en_douce():
    """``validate_custom_agents`` POSE le socle dans l'entrée enregistrée : la
    carte de l'agent l'affiche, et l'auteur peut le restreindre. Un défaut
    appliqué seulement au lancement serait invisible."""
    from llm_core.tools.task_tool import (
        CUSTOM_DEFAULT_CATEGORIES,
        validate_custom_agents,
    )
    out = validate_custom_agents([
        {"name": "redacteur", "prompt": "P.", "tool_categories": []},
    ])
    assert out[0]["tool_categories"] == CUSTOM_DEFAULT_CATEGORIES
    # Un choix EXPLICITE n'est jamais élargi.
    out = validate_custom_agents([
        {"name": "lecteur", "prompt": "P.", "tool_categories": ["fs"]},
    ])
    assert out[0]["tool_categories"] == ["fs"]
    # Ni un agent qui n'a QUE des serveurs MCP : sa surface est ailleurs.
    out = validate_custom_agents([
        {"name": "ci", "prompt": "P.", "tool_categories": [],
         "mcp_server_ids": ["shared:1"]},
    ])
    assert out[0]["tool_categories"] == []


async def test_agent_custom_sans_categorie_garde_ses_serveurs_mcp(monkeypatch):
    """…mais un agent custom qui n'a QUE des serveurs MCP externes les garde :
    c'est le serveur LOCAL qu'on supprime, pas la config entière."""
    servers = [{"id": "srv_b", "type": "sse", "name": "Jenkins", "url": "http://b"}]
    customs = [{"name": "ci", "description": "d", "prompt": "P.",
                "tool_categories": [], "mcp_server_ids": ["srv_b"]}]
    runner, handler, _ = _spawn(monkeypatch, agent="ci",
                                parent_configs=_PARENT_SANS_OUTILS,
                                custom_agents=customs, user_mcp_configs=servers)
    await handler({"subagent_type": "ci", "prompt": "p", "description": "d"})
    cfgs = runner.calls[0]["mcp_configs"]
    assert [c.get("id") for c in cfgs] == ["srv_b"]
    assert not any(c.get("command") == "DEFAULT_LOCAL_PYTHON" for c in cfgs)


async def test_agent_custom_dont_les_serveurs_ne_resolvent_plus_garde_des_outils(
        monkeypatch, local_tools):
    """Serveur dépublié/supprimé/masqué : l'agent ne tenait sa surface QUE de
    lui. Sans repli il partait avec ZÉRO outil et rendait quand même un rapport
    « completed » — une réponse inventée, présentée au parent comme un
    résultat. Il récupère le socle de travail."""
    from llm_core.tools.task_tool import CUSTOM_DEFAULT_CATEGORIES

    customs = [{"name": "ci", "description": "d", "prompt": "P.",
                "tool_categories": [], "mcp_server_ids": ["shared:3"]}]
    runner, handler, _ = _spawn(monkeypatch, agent="ci",
                                parent_configs=_PARENT_SANS_OUTILS,
                                custom_agents=customs,
                                user_mcp_configs=[])      # shared:3 introuvable
    await handler({"subagent_type": "ci", "prompt": "p", "description": "d"})
    cfgs = runner.calls[0]["mcp_configs"]
    assert cfgs and cfgs[0]["filter_categories"] == list(CUSTOM_DEFAULT_CATEGORIES)

    _map, payload, _h, _n = await _tool_catalog._collect_mcp_tools(
        cfgs, None, None, allowed_tool_names=runner.calls[0]["allowed_tool_names"],
        memory_enabled=False, deny_tool_names=runner.calls[0]["deny_tool_names"])
    assert {"read_file", "execute_shell"} <= {t["function"]["name"] for t in payload}


async def test_le_panneau_dit_la_vraie_surface_via_les_modeles():
    """Le panneau Paramètres → Agents annonçait la surface de chaque intégré
    dans un ``title=`` codé en dur, qui avait déjà dérivé une fois :
    l'utilisateur choisissait un agent sur une description fausse. Depuis la
    banque d'agents (2026-09-11) le panneau ne code plus rien : ses puces de
    catégories et son budget viennent de ``agent_templates()``. Le contrat à
    tenir est donc que ces modèles disent la surface RÉELLE, en CATÉGORIES
    (l'unité depuis 2026-08-06) — et qu'aucune infobulle en dur n'est revenue."""
    import re
    from pathlib import Path

    from llm_core.tools.task_tool import agent_templates

    tpl = {t["name"]: t for t in agent_templates()}
    assert set(tpl) == set(_AGENTS)
    for name, spec in _AGENTS.items():
        assert tpl[name]["tool_categories"] == list(spec.filter_categories), (
            f"modèle « {name} » : catégories {tpl[name]['tool_categories']} vs "
            f"réelles {spec.filter_categories}")
        assert tpl[name]["max_iters"] == spec.max_iters
        assert tpl[name]["prompt"], f"modèle « {name} » : persona vide"

    html = (Path(__file__).resolve().parents[2] / "frontend" / "includes"
            / "modals" / "settings.html").read_text(encoding="utf-8")
    assert not re.search(r'title="Outils : [^"]+ — \d+ itérations"', html), \
        "surface d'un intégré codée en dur dans le panneau : elle dérivera"
    assert "agentBank" in html and "loadAgentTemplates" in html


@pytest.mark.filterwarnings("ignore::pytest.PytestWarning")
async def test_task_tool_ne_construit_plus_de_serveur_local_vide():
    """Garde-fou de lecture : la condition qui supprime le serveur local doit
    distinguer ``None`` (pas de filtre) de ``[]`` (aucune catégorie)."""
    import inspect
    src = inspect.getsource(task_tool.build_task_builtin_tool)
    assert "if spec.filter_categories is None or spec.filter_categories:" in src
