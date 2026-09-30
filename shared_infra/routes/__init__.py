# SPDX-License-Identifier: MIT
"""
shared_infra.routes — composition des routes HTTP.

Ce package ne contient PLUS les endpoints eux-mêmes : depuis le rangement par
famille (2026-09-04), chaque module de routes vit avec son sujet
(``shared_infra/mcp/panel.py``, ``shared_infra/sandbox/routes_files.py``…).
Ne restent ici que les mécaniques qui n'appartiennent à aucune famille :

    _state.py     le ``router`` partagé, monté par l'app
    _helpers.py   helpers HTTP communs (auth, chemins, git…)
    _legacy.py    monolithe résiduel, en cours de démantèlement
    admin/        console d'administration (transverse par nature)
    config.py     /api/config
    system.py     /, /api/health, /api/public-config…
    tools.py      /api/tools — panneau d'outils

CE FICHIER RESTE LE CHEF D'ORCHESTRE. Les endpoints s'enregistrent sur le
routeur partagé au moment de l'IMPORT de leur module : l'ordre ci-dessous est
donc l'ordre d'enregistrement, et il est décidé ici, en un seul endroit. Une
famille n'importe jamais ses propres modules de routes depuis son ``__init__``
— il existerait alors un second chemin d'enregistrement, dépendant de qui
importe quoi en premier (cf. tests/shared_infra/test_familles_rangement.py).

Routes du chatbot
-----------------
Elles ne sont PAS importées au chargement : elles vivent dans
``chatbot_app.routes`` et sont enregistrées à la demande par
:func:`register_chatbot_routes`.

Surface d'import stable
-----------------------
- ``router``                          — APIRouter partagé monté par l'app
- ``admin_router``                    — APIRouter admin (monté selon APP_MODE)
- ``_terminals``, ``_kill_terminal``  — utilisés par le shutdown de l'app
- les symboles des modules listés dans ``_SUBMODULES`` (ré-export fidèle)
"""

import importlib

# ─────────────────────────────────────────────────────────────────────────────
# 1. INFRASTRUCTURE — l'import enregistre les routes. ``_state`` D'ABORD (il
#    porte le router partagé), puis les helpers, puis chaque famille.
# ─────────────────────────────────────────────────────────────────────────────
from shared_infra.routes import _state    # noqa: F401 — porte le router partagé
from shared_infra.routes import _helpers  # noqa: F401 — helpers auth/http/fichiers/git
from shared_infra.observability import events_bus  # noqa: F401 — bus SSE + scheduler + cache modèles
from shared_infra.terminal import pty     # noqa: F401 — infrastructure terminal/PTY
from shared_infra.routes import _legacy   # noqa: F401 — monolithe résiduel

# ── Familles ────────────────────────────────────────────────────────────────
from shared_infra.accounts import routes_auth      # noqa: F401 — /api/{me,login,logout}-lite
from shared_infra.sandbox import routes_snapshots  # noqa: F401 — /api/sandbox/snapshots/*
from shared_infra.sandbox import routes_lifecycle  # noqa: F401 — /api/sandbox/me + cycle de vie
from shared_infra.chat import routes_prompts       # noqa: F401 — /api/prompts/*
from shared_infra.mcp import panel as mcp_panel    # noqa: F401 — /api/mcp/*
from shared_infra.memory import routes as memory_routes  # noqa: F401 — /api/memory/*
from shared_infra.charts import routes as charts_routes  # noqa: F401 — /api/charts/*
from shared_infra.routes import system    # noqa: F401 — /, /api/{health,help,inbox,public-config,debug}
from shared_infra.chat import routes_skills        # noqa: F401 — /api/skills/*
from shared_infra.scheduling import routes_routines    # noqa: F401 — /api/routines/*
from shared_infra.scheduling import routes_webhooks    # noqa: F401 — /api/webhooks/* (HMAC public)
from shared_infra.notifications import routes as notifications_routes  # noqa: F401 — /api/notifications/*
from shared_infra.routes import tools     # noqa: F401 — /api/{tools,rag,playwright,diag}/*
from shared_infra.desktop import routes as desktop_routes  # noqa: F401 — /api/desktop/*
from shared_infra.voice import routes as voice_routes  # noqa: F401 — /api/voice/* (dictée + synthèse)
from shared_infra.accounts import routes_settings  # noqa: F401 — /api/{settings,users,avatars}/*
from shared_infra.appearance import routes as appearance_routes  # noqa: F401 — /api/skins/*
from shared_infra.llm import routes as llm_routes  # noqa: F401 — /api/llm/*
from shared_infra.terminal import routes as terminal_routes  # noqa: F401 — /api/terminal/*
from shared_infra.observability import routes_events  # noqa: F401 — /api/system-events (SSE)
from shared_infra.sandbox import routes_files      # noqa: F401 — /api/sandbox/* (fichiers)
from shared_infra.sandbox import routes_office     # noqa: F401 — /api/sandbox/office/* (aperçus Office/PDF)
from shared_infra.sandbox import routes_git        # noqa: F401 — /api/sandbox/git/*
from shared_infra.git import routes as git_routes  # noqa: F401 — /api/git/connectors/*
from shared_infra.llm import routes_connectors     # noqa: F401 — /api/llm/connectors/*
from shared_infra.routes import config    # noqa: F401 — /api/config (GET + PUT)
from shared_infra.opencode import routes_cli       # noqa: F401 — /api/cli/* (distribution LAN)
from shared_infra.mcp import bridge as mcp_bridge  # noqa: F401 — /api/mcp-bridge/*
from shared_infra.mcp import routes_openapi as mcp_openapi  # noqa: F401 — /api/tools/<famille>/* (EXT.5)
from shared_infra.mcp import routes_oauth as mcp_oauth  # noqa: F401 — /.well-known/*, /oauth/* (EXT.4)
from shared_infra.opencode import routes_code      # noqa: F401 — /api/code/* (sessions déportées)
from shared_infra.toolhost import routes_internal  # noqa: F401 — /api/internal/* (rappels de l'hôte d'outils)
from shared_infra.llm import routes_queue          # noqa: F401 — /api/llm/queue-status
from shared_infra.observability import routes_usage  # noqa: F401 — /api/usage/me
from shared_infra.observability import routes_runs  # noqa: F401 — /api/runs/* (L5.3)
from shared_infra.accounts import routes_tokens  # noqa: F401 — /api/tokens* (EXT.1)
from shared_infra.routes import admin as _admin_module  # noqa: F401 — endpoints admin

# Modules ré-exportés par la boucle du §3. ``admin`` en est volontairement
# absent : ses endpoints s'enregistrent sur ``admin_router``.
_SUBMODULES = (
    _state, _helpers, events_bus, pty, _legacy,
    routes_auth, routes_snapshots, routes_lifecycle, routes_prompts, mcp_panel,
    memory_routes, charts_routes, system, routes_skills, routes_routines,
    routes_webhooks, notifications_routes, tools,
    routes_settings, appearance_routes, llm_routes, terminal_routes, routes_events,
    routes_files, routes_git, routes_connectors, config, routes_queue,
    routes_usage, routes_runs, routes_tokens, routes_internal,
)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Enregistrement À LA DEMANDE des routes propres aux applicatifs.
#    Idempotent : Python met les modules en cache, les décorateurs @router
#    ne s'exécutent donc qu'une seule fois même si on rappelle ces fonctions.
# ─────────────────────────────────────────────────────────────────────────────
_CHATBOT_ROUTE_MODULES = (
    "chatbot_app.routes.saved_chats",   # /api/saved/chats/*
    "chatbot_app.routes.chats",         # /api/chat/* + /api/chat-saved-stream3
)


def register_chatbot_routes() -> None:
    """Enregistre les endpoints du chatbot sur le ``router`` partagé."""
    for mod in _CHATBOT_ROUTE_MODULES:
        importlib.import_module(mod)


# ─────────────────────────────────────────────────────────────────────────────
# 3. Ré-export fidèle de chaque symbole défini dans les modules ci-dessus.
#    Les noms préfixés d'un underscore sont inclus DÉLIBÉRÉMENT : un appelant
#    historique qui faisait ``from shared_infra.routes import _helper`` doit
#    continuer de marcher.
# ─────────────────────────────────────────────────────────────────────────────
for _mod in _SUBMODULES:
    for _name in dir(_mod):
        if _name.startswith("__"):
            continue
        globals()[_name] = getattr(_mod, _name)

# Ré-export explicite du router admin : ``from shared_infra.routes import admin_router``.
admin_router = _admin_module.admin_router  # noqa: F811

# Nettoyage des variables de boucle.
try:
    del _mod, _name
except NameError:
    pass
