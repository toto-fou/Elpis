# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_familles_rangement.py — le rangement par famille tient.

``shared_infra`` était rangé par COUCHE TECHNIQUE (``routes/``, ``db/``), si bien
qu'un même sujet vivait dans trois dossiers sans que rien ne le dise. Le
2026-09-04 la famille MCP a été regroupée dans ``shared_infra/mcp/``.

Un rangement ne tient que s'il se défend tout seul : sans ce fichier, le
prochain endpoint MCP repartirait dans ``routes/`` — c'est l'endroit où on
ajoute un endpoint quand on ne sait pas qu'une famille existe — et la
dispersion recommencerait, un fichier à la fois.

Ce test dit DEUX choses :
  1. la famille est complète et joignable sous son propre nom ;
  2. rien de MCP ne subsiste dans les couches techniques.
"""
from __future__ import annotations

from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[2]
SI = RACINE / "shared_infra"

# Familles regroupées à ce jour. Ajouter une entrée ici EN MÊME TEMPS que le
# dossier : c'est la liste que lit le prochain venu.
FAMILLES = {
    "mcp":           {"modules": {"families", "servers", "panel", "bridge"},
                      "motifs": ("mcp",)},
    "accounts":      {"modules": {"users", "groups", "passwd", "routes_auth",
                                  "routes_settings"},
                      "motifs": ("users", "groups", "auth", "settings")},
    "security":      {"modules": {"csrf", "deps", "encryption", "audit"},
                      "motifs": ("csrf", "encryption", "audit")},
    "sandbox":       {"modules": {"paths", "policy", "exec_bridge",
                                  "routes_files", "routes_git", "routes_snapshots",
                                  "routes_lifecycle", "filetypes", "office_convert",
                                  "office_preview", "routes_office"},
                      "motifs": ("sandbox",)},
    "git":           {"modules": {"detect", "resolver", "ssrf", "connectors", "routes"},
                      "motifs": ("git_connectors",)},
    "llm":           {"modules": {"connectors", "debug", "reasoning_control",
                                  "routes", "routes_connectors", "routes_queue"},
                      "motifs": ("llm", "llm_connectors", "queue_status")},
    "opencode":      {"modules": {"routes_cli", "routes_code", "store"},
                      "motifs": ("cli", "code")},
    "terminal":      {"modules": {"pty", "routes"},
                      "motifs": ("terminal", "pty")},
    # (2026-09-12) les scénarios rejouables du Studio sont partis : leurs
    # scripts vivent désormais sur la machine cible (desktop-agent/elpis_auto).
    "scheduling":    {"modules": {"cron_lock", "routines_scheduler", "routines_store",
                                  "routes_routines", "routes_cron", "routes_webhooks"},
                      "motifs": ("routines", "cron", "webhooks")},
    "observability": {"modules": {"access_logging", "tracing", "usage_ctx", "events_bus",
                                  "usage_store", "daily_reports_store",
                                  "tool_metrics_store", "routes_usage", "routes_events"},
                      "motifs": ("usage", "events", "metrics", "daily_reports",
                                 "access_logging", "agent_memory")},
    "memory":        {"modules": {"store", "routes", "routes_ax"},
                      "motifs": ("memory", "ax")},
    "notifications": {"modules": {"push", "store", "routes"},
                      "motifs": ("notifications",)},
    "runtime":       {"modules": {"pyruntime", "runtime_dir", "ordered_io",
                                  "cancel_bus", "chat_locks"},
                      "motifs": ()},
    "ops":           {"modules": {"maintenance", "backup_remote"},
                      "motifs": ()},
    "chat":          {"modules": {"store", "prompts_store", "routes_prompts",
                                  "routes_skills"},
                      "motifs": ("chats", "prompts", "skills")},
    "charts":        {"modules": {"routes"}, "motifs": ("charts",)},
    # ``anchors`` = mémoire des ancres du ciblage live (ex-cache d'actions des scénarios)
    "desktop":       {"modules": {"routes", "anchors"}, "motifs": ("desktop",)},
    # (2026-09-11, P4) ce que l'app et l'hôte d'outils partagent pour se parler
    "toolhost":      {"modules": {"client", "routes_internal"}, "motifs": ("internal",)},
    # (2026-09-28) skins (intégrés + plugins) et registre des mascottes
    "appearance":    {"modules": {"skins", "routes"}, "motifs": ("skins", "appearance")},
}


@pytest.mark.parametrize("famille", sorted(FAMILLES))
def test_la_famille_existe_et_est_complete(famille):
    dossier = SI / famille
    assert dossier.is_dir(), f"{dossier} manquant"
    assert (dossier / "__init__.py").is_file(), "une famille est un package"
    presents = {p.stem for p in dossier.glob("*.py") if p.stem != "__init__"}
    attendus = FAMILLES[famille]["modules"]
    manquants = attendus - presents
    assert not manquants, f"modules attendus absents de {famille}/ : {sorted(manquants)}"


@pytest.mark.parametrize("famille", sorted(FAMILLES))
def test_la_famille_ne_se_redisperse_pas_dans_les_couches(famille):
    """Aucun fichier de cette famille ne doit (re)vivre dans routes/ ou db/."""
    motifs = FAMILLES[famille]["motifs"]
    fautifs = []
    for couche in ("routes", "db"):
        for p in (SI / couche).rglob("*.py"):
            # ``db/_migrations/`` est une CHAÎNE ORDONNÉE, découverte par le nom
            # de fichier et rejouée dans l'ordre : une migration appartient à la
            # couche de persistance, jamais à une famille. La déplacer casserait
            # la séquence (``0001_rename_toolbox_to_mcp`` en parle mais ne
            # l'implémente pas).
            # ``routes/admin/`` est une SOUS-APPLICATION transverse : la console
            # d'administration touche à tout (métriques, comptes, moteurs) et
            # s'enregistre sur son propre ``admin_router``. La ranger par
            # famille l'éparpillerait sans rien clarifier — c'est le sujet
            # « administrer », pas le sujet « métriques ».
            if ("__pycache__" in p.parts or "_migrations" in p.parts
                    or "admin" in p.parts):
                continue
            nom = p.stem.lower()
            if any(nom == m or nom.startswith(m + "_") or nom.endswith("_" + m)
                   for m in motifs):
                fautifs.append(str(p.relative_to(RACINE)))
    assert not fautifs, (
        f"ces fichiers appartiennent à la famille « {famille} » et doivent vivre "
        f"dans shared_infra/{famille}/ : {fautifs}")


def test_la_famille_mcp_est_importable_sous_son_nom():
    """La surface publique de la famille, telle que le reste du code l'utilise."""
    from shared_infra.mcp import families, servers
    assert callable(families.opencode_families)
    assert isinstance(servers.ID_PREFIX, str) and servers.ID_PREFIX


@pytest.mark.parametrize("famille", sorted(FAMILLES))
def test_chaque_famille_se_documente(famille):
    """Un ``__init__.py`` vide ne dit pas ce que la famille recouvre — et c'est
    précisément ce qu'on cherchait à réparer. Le sien doit au moins nommer son
    sujet."""
    import ast
    src = (SI / famille / "__init__.py").read_text(encoding="utf-8")
    doc = ast.get_docstring(ast.parse(src)) or ""
    assert doc, f"{famille}/__init__.py sans docstring"
    assert len(doc) > 200, f"{famille}/__init__.py trop maigre pour situer la famille"


def test_les_couches_ne_gardent_que_le_transverse():
    """``routes/`` et ``db/`` ne doivent plus porter de métier : leur contenu est
    une liste COURTE et connue. Un fichier de plus ici est le premier pas de la
    re-dispersion."""
    routes = {p.stem for p in (SI / "routes").glob("*.py")}
    assert routes == {"__init__", "_state", "_helpers", "_legacy", "config",
                      "system", "tools"}, sorted(routes)
    db = {p.stem for p in (SI / "db").glob("*.py")}
    # ``_dialect`` et ``_schema`` (2026-09-26) : ce qui diffère d'un moteur à
    # l'autre et le schéma de référence
    # — de l'infrastructure de base, pas du métier (chantier multi-moteurs).
    # ``_server``, ``_pool``, ``_pg``, ``_mysql`` : adaptateurs des moteurs serveur.
    # ``transfer`` + ``__main__`` : copie entre moteurs et sa CLI (lot D).
    assert db == {"__init__", "__main__", "_connection", "_dialect", "_schema",
                  "_server", "_pool", "_pg", "_mysql", "transfer"}, sorted(db)


def test_les_routes_mcp_sont_bien_enregistrees():
    """Déplacer un module de routes casse leur enregistrement si l'import
    disparaît : les décorateurs ne s'exécutent qu'à l'import. On vérifie donc
    les CHEMINS servis, pas la présence du fichier."""
    import shared_infra.routes  # noqa: F401 — enregistre tout
    from shared_infra.mcp.bridge import MCP_PROXY_PREFIX
    from shared_infra.routes._state import router

    chemins = {getattr(r, "path", "") for r in router.routes}
    assert "/api/mcp/categories" in chemins        # panneau d'outils du chat
    assert "/api/mcp/shared-servers" in chemins    # bibliothèque partagée
    assert MCP_PROXY_PREFIX + "/{family}" in chemins   # relais opencode


def test_l_ordre_d_enregistrement_reste_pilote_par_routes():
    """Le code vit avec sa famille, mais l'ORDRE des routes reste décidé en un
    seul endroit. Si ``shared_infra/mcp/__init__.py`` importait lui-même ses
    modules de routes, il existerait un second chemin d'enregistrement,
    dépendant de qui importe quoi en premier."""
    src = (SI / "mcp" / "__init__.py").read_text(encoding="utf-8")
    code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
    for interdit in ("import panel", "import bridge"):
        assert interdit not in code, (
            f"shared_infra/mcp/__init__.py ne doit pas faire « {interdit} » : "
            "l'enregistrement des routes appartient à shared_infra/routes/__init__.py")
