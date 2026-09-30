# SPDX-License-Identifier: MIT
"""Familles d'outils MCP — table et grammaire PARTAGÉES (2026-09-03).

Le service (``server/local_mcp_server.py``) enregistre les familles ; la route
de config opencode (``shared_infra/opencode/routes_cli.py``) doit annoncer EXACTEMENT
les mêmes noms, puisqu'ils deviennent des URL (``…/mcp/<famille>``) et des noms
de serveurs MCP côté client. Tant que les deux listes vivaient chacune de leur
côté, ajouter une famille demandait deux gestes et un oubli ne se voyait que
sur le poste de l'utilisateur. Ce module est la source unique.

Données pures : aucun import lourd (ni fastmcp, ni la config à l'import) — il
est chargé aussi bien par le sous-process MCP que par les workers FastAPI.
"""
from __future__ import annotations

import os
from typing import Callable, List, Optional, Set

#   (nom, module ``register``, ``register`` attend la racine sandbox ?)
TOOL_FAMILIES = (
    ("fs",      "llm_core.tools.fs_tools",      True),
    ("shell",   "llm_core.tools.shell_tools",   True),
    ("git",     "llm_core.tools.git_tools",     True),
    ("chart",   "llm_core.tools.chart_tools",   True),
    ("memory",  "llm_core.tools.memory_tools",  True),
    ("skill",   "llm_core.tools.skill_tools",   False),
    # (2026-09-12, P4) ``skill_run_script`` = exécution DANS LE SANDBOX (hôte
    # d'outils) ; le reste de la bibliothèque de skills = liée au compte (app).
    # Même module, deux fonctions d'enregistrement (cf. FAMILY_REGISTER_FN).
    ("skill_run", "llm_core.tools.skill_tools", False),
    ("todo",    "llm_core.tools.todo_tools",    False),
    ("browser", "llm_core.tools.firefox_tools", False),
    ("desktop", "llm_core.tools.desktop_tools", False),
)
FAMILY_NAMES = tuple(f[0] for f in TOOL_FAMILIES)


def is_family_name(segment: object) -> bool:
    """Segment d'URL = nom de famille CONNU (``skill_run`` compris : un
    contrôle ``isalnum`` le refusait). Ni ``/``, ni ``..``, ni nom inventé."""
    return isinstance(segment, str) and segment in FAMILY_NAMES

# Fonction d'enregistrement d'une famille dans son module (défaut ``register``).
FAMILY_REGISTER_FN = {"skill": "register_library", "skill_run": "register_run"}

# Familles liées au SANDBOX (portables avec l'hôte d'outils) vs liées à l'APP
# (base des comptes : mémoire, todo, graphiques, bibliothèque de skills).
SANDBOX_FAMILIES = ("fs", "shell", "git", "skill_run", "browser", "desktop")
APP_FAMILIES = ("chart", "memory", "skill", "todo")

# Famille → identifiant de CATÉGORIE porté par les outils (tags/meta, lus par
# ``llm_core._mcp_categories``). Identique au nom de famille partout SAUF pour
# ``todo``, dont les outils sont taggés ``task``. Sert à savoir si une famille
# est réellement enregistrée sur le service (liste vivante) avant de l'annoncer
# dans un ``opencode.json`` — vérifié module par module le 2026-09-03.
FAMILY_CATEGORY = {
    "fs": "fs", "shell": "shell", "git": "git", "chart": "chart",
    "memory": "memory", "skill": "skill", "skill_run": "skill", "todo": "task",
    "browser": "browser", "desktop": "desktop",
}

# Familles exposées à opencode SOUS FORME DE SERVEURS MCP SÉPARÉS (une bascule
# chacune dans son TUI). Défaut volontairement court : opencode a déjà ses
# outils fichiers/shell/todo, et l'intérêt des nôtres là-bas est ce qu'il n'a
# pas — le dépôt Git de l'app, le navigateur piloté et le contrôle d'écran.
DEFAULT_OPENCODE_FAMILIES = "git,browser,desktop"
# Familles TOUJOURS refusées à ces clients, même si quelqu'un devine leur URL
# (RÈGLE utilisateur : nos fs/shell agissent sur le sandbox de l'hôte).
DEFAULT_OPENCODE_EXCLUDE = "fs,shell,skill_run"


def _warn(warn: Optional[Callable[[str], None]], msg: str) -> None:
    if warn is not None:
        warn(msg)


def parse_families(raw: Optional[str], *, warn: Optional[Callable[[str], None]] = None) -> List[str]:
    """``LOCAL_MCP_TOOL_FAMILIES`` → liste ordonnée (ordre canonique).

    ``all`` / vide → toutes ; ``a,b`` → celles-là ; ``all,-x`` ou ``-x`` seul →
    toutes sauf ``x``. Noms inconnus ignorés (avertissement), jamais d'erreur :
    une faute de frappe ne doit pas empêcher le service de démarrer.
    """
    toks = [t.strip().lower() for t in (raw or "").split(",") if t.strip()]
    if not toks:
        return list(FAMILY_NAMES)
    excluded = {t[1:] for t in toks if t.startswith("-")}
    included = [t for t in toks if not t.startswith("-") and t != "all"]
    for u in [t for t in (included + sorted(excluded)) if t not in FAMILY_NAMES]:
        _warn(warn, f"famille d'outils inconnue ignorée : {u!r}")
    known_included = [n for n in FAMILY_NAMES if n in included]
    if included and not known_included and "all" not in toks:
        # Une liste composée UNIQUEMENT de noms inconnus (``filesystem``)
        # enregistrait ZÉRO outil, en silence.
        _warn(warn, f"aucune famille connue dans {raw!r} → toutes les familles")
    base = list(FAMILY_NAMES) if ("all" in toks or not known_included) else known_included
    return [n for n in base if n not in excluded]


def parse_family_set(raw: Optional[str], *, warn: Optional[Callable[[str], None]] = None) -> Set[str]:
    """Liste simple de familles (pas de ``all``, pas de soustraction) — les
    noms inconnus sont ignorés avec un avertissement."""
    out: Set[str] = set()
    for t in (raw or "").split(","):
        t = t.strip().lower().lstrip("-")
        if not t:
            continue
        if t in FAMILY_NAMES:
            out.add(t)
        else:
            _warn(warn, f"famille inconnue ignorée : {t!r}")
    return out


def _setting(name: str, default: str) -> str:
    """Environnement d'abord, puis ``shared_infra.config`` (le service MCP peut
    tourner sans la config de l'app), puis le défaut."""
    env = os.environ.get(name)
    if env is not None:
        return env
    try:
        from shared_infra import config as _cfg
        val = getattr(_cfg, name, None)
        if val is not None:
            return str(val)
    except Exception:
        pass
    return default


def opencode_families(include_raw: Optional[str] = None,
                      exclude_raw: Optional[str] = None,
                      *, warn: Optional[Callable[[str], None]] = None,
                      use_manifest: bool = True) -> List[str]:
    """Familles exposées aux clients opencode, dans l'ordre canonique.

    Liste d'INCLUSION (``LOCAL_MCP_OPENCODE_FAMILIES``) moins les exclusions
    (``LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES``). L'inclusion plutôt que la seule
    exclusion est délibérée : une famille ajoutée demain n'atterrit pas d'office
    chez tous les utilisateurs d'opencode — il faut la nommer.

    (2026-09-11) Quand un manifeste ``mcp.json`` est PRÉSENT et qu'aucune
    inclusion n'est imposée (argument ou env), c'est lui qui fait foi —
    l'exclusion invariante fs/shell s'applique toujours. ``use_manifest=False`` :
    résolution héritée seule (utilisée par la SYNTHÈSE du manifeste, pour ne pas
    boucler).

    (2026-09-12) Avec UNE ENTRÉE PAR FAMILLE, la déclaration naturelle est
    ``x-elpis.opencode.publish: true`` sur l'entrée concernée ; la forme héritée
    ``x-elpis.opencode.families`` (entrée monolithique) reste lue.
    """
    if include_raw is None and use_manifest and os.environ.get("LOCAL_MCP_OPENCODE_FAMILIES") is None:
        try:
            from shared_infra.mcp import manifest as _mf
            _m = _mf.load()
            if _m.source == "file" and _m.toolhost() is not None:
                return _m.opencode_families()
        except Exception:
            pass
    if include_raw is None:
        include_raw = _setting("LOCAL_MCP_OPENCODE_FAMILIES", DEFAULT_OPENCODE_FAMILIES)
    if exclude_raw is None:
        exclude_raw = _setting("LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES", DEFAULT_OPENCODE_EXCLUDE)
    inc = parse_families(include_raw, warn=warn) if (include_raw or "").strip() else []
    exc = parse_family_set(exclude_raw, warn=warn)
    return [n for n in inc if n not in exc]
