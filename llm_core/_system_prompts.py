# SPDX-License-Identifier: MIT
"""
llm_core._system_prompts
========================

Centralized assembly of the system message sent to the LLM.

Pas de bloc « Tool Protocols »
------------------------------
Aucun texte de protocole par catégorie d'outils (shell, fs, git…) n'est
injecté : il ferait doublon avec les descriptions MCP (que le modèle comprend
déjà) et coûterait des tokens à chaque tour. Le cadrage propre aux capacités
actives passe par les fragments ``FRAGMENT_*`` (``build_capability_block``).

Côté chatbot, le prompt système de base est ``CHATBOT_SYSTEM.md``
(``config.SYSTEM_PROMPT_DEFAULT``), câblé dans ``chatbot_app/turn/preparation.py``.

Le message système (``assemble_system_messages``) assemble :

  1. Le prompt custom (déjà préfixé du défaut côté caller le cas échéant)
  2. Le snapshot mémoire long-terme (figé pour la session)
  3. Les skills (procédures) — index + corps matchés/épinglés

``active_mcp_servers`` est CONSERVÉ comme paramètre (ignoré) pour ne pas casser
les appelants existants — il ne pilote aucune injection.

Public API
----------
- ``assemble_system_messages(custom_sys, active_mcp_servers=None, ...) -> list``
    Retourne une liste d'au plus un ``{"role": "system", "content": ...}``.
- ``preview(...) -> str`` — même contenu en une string (endpoint debug).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger("uvicorn.error")

# Où vivent les fichiers de prompt (CHATBOT_SYSTEM, COMPRESSOR_SYSTEM,
# AX_MEMORY_HEADER). Conservé car l'admin et d'autres modules s'y réfèrent.
# Repo root = parents[1] (= racine du dépôt).
_SYSTEM_P_DIR = Path(__file__).resolve().parents[1] / "system_prompts"


# ─────────────────────────────────────────────────────────────────────────────
# Skills block — procedural memory injected deterministically
# ─────────────────────────────────────────────────────────────────────────────
#
# A "skill" is a markdown how-to (deploy via Jenkins, reset Qdrant, …) living in
# ``skills/`` (+ per-user ``<sandbox>/skills/``; ``skills/learned/`` is an admin
# staging area, NOT injected). See ``llm_core/skills.py``. We do NOT hand control
# to the model: the backend matches the latest user message against skill
# descriptions and injects the bodies of the top-N matches. As a safety net
# against a mis-match, we ALSO inject a lightweight index of EVERY (user+global)
# skill (name — description, ~1 line each), so the model knows a relevant skill
# exists even when auto-injection missed it — and can load its body on demand
# via the ``skill_get`` tool.

_SKILLS_HEADER = (
    "# Skills (known procedures)\n\n"
    "The index below lists ALL available pre-written procedures "
    "(name — description). When one matches the task, load its content with the "
    "`skill_get(name)` tool BEFORE acting — do not invent the steps. A skill "
    "marked \"files/scripts\" ships resources (scripts, references, templates): "
    "they live OUTSIDE the `/work` sandbox (a `skills/` folder in the sandbox "
    "is only a disposable mirror) — read one with "
    "`skill_read_file(name, path)` and run a script with "
    "`skill_run_script(name, script, args, env)` (do not use read_file / "
    "execute_shell for that, and do not copy the code out). Scripts execute "
    "FROM `/work`: pass your sandbox files in `args` exactly as you see them "
    "(relative paths resolve against `/work`), and script outputs land in "
    "`/work`."
)

# Header pour le mode "skills attachés" (sans index) : utilisé quand des skills
# sont épinglés directement sur un agent, hors routeur automatique.
_SKILLS_ATTACHED_HEADER = (
    "# Skills (procedures to apply)\n\n"
    "Procedures attached to this agent — apply them for this task."
)


def _user_skills_dir(user_id: Optional[int]):
    """Résout le STORE protégé des skills perso de l'utilisateur (HORS sandbox).

    La sandbox ne contient qu'une copie de travail (miroir ``<sandbox>/skills/``,
    cf. ``llm_core.skills.sync_user_skills_mirror``) — la lecture pour
    l'injection se fait toujours sur le store. Migre l'ancien emplacement
    sandbox à la première résolution. Best-effort : tout échec retourne
    ``None`` — on tombe alors sur les seuls skills global + learned.
    """
    if user_id is None:
        return None
    try:
        from llm_core.skills import ensure_user_skills_store
        from shared_infra.accounts.users import get_username_by_id
        from shared_infra.config import USER_SKILLS_DIR, safe_sandbox_name
        from shared_infra.routes._legacy import _get_sandbox_path
        username = get_username_by_id(user_id) or f"user_{user_id}"
        store = Path(USER_SKILLS_DIR) / safe_sandbox_name(username)
        try:
            sandbox = _get_sandbox_path(user_id)
        except Exception:
            sandbox = None
        return ensure_user_skills_store(store, sandbox)
    except Exception:
        pass
    return None


def _build_skills_block(
    last_user_text: Optional[str],
    user_id: Optional[int] = None,
    pinned_skills: Optional[Iterable[str]] = None,
    include_index: bool = True,
) -> Optional[str]:
    """Assemble the skills block: (optional index) + bodies of pinned + matched.

    Returns None when there's nothing to inject. Bodies injected, in order:
      1. ``pinned_skills`` — forced (``/skill`` chips, ou skills attachés à un agent).
      2. top-N auto-matched against ``last_user_text`` (deterministic).
    Deduplicated by name, capped by SKILLS_CHAR_BUDGET. Pinned skills bypass the
    relevance threshold.

    ``include_index`` : si True (défaut, mode routeur auto), on préfixe l'index
    complet de tous les skills (garde-fou anti mis-match). Si False (mode "skills
    attachés à un agent", hors routeur), on n'injecte QUE les corps épinglés sous
    un header dédié — pas d'index pour ne pas polluer.
    """
    try:
        from llm_core.skills import discover_skills
        from shared_infra import config as _cfg
    except Exception as e:                       # import/loader failure → degrade
        logger.debug("[skills] block disabled: %s", e)
        return None

    try:
        # ``include_learned=False`` : learned/ est un SAS de curation admin
        # (brouillons en attente de promotion). On ne l'injecte PAS dans le
        # prompt — sinon un learned non promu serait actif pour tous.
        skills = discover_skills(_user_skills_dir(user_id), include_learned=False)
    except Exception as e:
        logger.warning("[skills] discover failed: %s", e)
        return None
    if not skills:
        return None

    parts: List[str] = []
    if include_index:
        # Index léger — garde-fou anti mis-match, regroupé par domaine applicatif
        # (le sous-dossier d'où vient le skill). ``skills`` est déjà trié par
        # (domain, name) → on peut grouper en un passage. Borné par
        # ``SKILLS_INDEX_MAX`` (0 = illimité) pour que le coût ne croisse pas sans
        # plafond avec la taille de la bibliothèque.
        index_max = getattr(_cfg, "SKILLS_INDEX_MAX", 0)
        # Index = skills de NIVEAU-0 uniquement. Les sous-skills imbriqués se
        # chargent À LA DEMANDE via skill_get(parent/child) → contexte mince.
        top = [s for s in skills if getattr(s, "depth", 0) == 0]
        _with_children = {getattr(s, "parent_id", None) for s in skills if getattr(s, "parent_id", None)}
        indexed = top[:index_max] if index_max and index_max > 0 else top
        index_parts: List[str] = ["## Index"]
        current_domain = object()                    # sentinelle != toute str
        for s in indexed:
            if s.domain != current_domain:
                current_domain = s.domain
                index_parts.append(f"\n### {s.domain or 'General'}")
            # Marqueur : « sous-skills » si le skill a des enfants (à charger via
            # skill_get) ; sinon « fichiers/scripts » pour un Agent Skill dossier
            # qui embarque des ressources à lire/exécuter dans la sandbox.
            # Texte brut, sans émoji (préférence prompts, cf. test_no_emoji).
            if getattr(s, "id", s.name) in _with_children:
                marker = " · sub-skills (`skill_get`)"
            elif getattr(s, "is_folder", False) and s.files:
                marker = " · files/scripts"
            else:
                marker = ""
            index_parts.append(f"- **{s.name}** — {s.description or '(no description)'}{marker}")
        if len(indexed) < len(top):
            index_parts.append(f"\n_(+{len(top) - len(indexed)} more — `skill_get(name)`)_")
        _hdr = _SKILLS_HEADER
        try:
            from llm_core.context_config import CTX as _CTX
            _hdr = _CTX.override("skills.header", _hdr)
        except Exception:
            pass
        parts = [_hdr, "\n".join(index_parts)]

    # Corps injectés = UNIQUEMENT les skills ÉPINGLÉS (forcés par l'utilisateur
    # via /skill, ou attachés hors routeur). Modèle FULL-PULL (Anthropic) : les
    # skills simplement pertinents ne sont PAS injectés d'office — l'agent charge
    # la procédure à la demande via ``skill_get(name)`` (cf. header), et pour un
    # Agent Skill (dossier) lit/exécute ses fichiers via ``skill_read_file`` /
    # ``skill_run_script`` (les skills ne sont pas montés dans /work). Cela
    # garde le contexte mince et laisse le modèle décider. ``last_user_text`` ne
    # sert donc pas à pré-injecter des corps.
    by_key: Dict[str, Any] = {}
    for s in skills:
        by_key[s.name] = s                            # nom (rétro-compat)
    for s in skills:                                  # l'id qualifié prime
        by_key[getattr(s, "id", "") or s.name] = s
    ordered: List[Any] = []
    seen: set = set()
    for nm in (pinned_skills or []):
        sp = by_key.get(nm)
        _k = getattr(sp, "id", None) or (sp.name if sp else None)
        if sp and _k not in seen:
            ordered.append(sp)
            seen.add(_k)

    if ordered:
        budget = getattr(_cfg, "SKILLS_CHAR_BUDGET", 12000)
        used = 0
        body_blocks: List[str] = []
        for s in ordered:
            block = f"## {s.name}\n{s.body.strip()}"
            if budget and body_blocks and used + len(block) > budget:
                break                            # garde au moins le 1er (souvent un pin)
            if budget and len(block) > budget:
                # Un seul corps surdimensionné (gros skill ou pin) ne doit pas
                # déborder le budget : on le TRONQUE au lieu de l'injecter entier.
                block = block[:budget].rstrip() + "\n\n…[procedure truncated]"
            body_blocks.append(block)
            used += len(block)
        if body_blocks:
            if not include_index:                # mode "skills attachés" → header dédié
                parts.append(_SKILLS_ATTACHED_HEADER)
            parts.append("\n\n".join(body_blocks))

    if not parts:
        return None
    return "\n\n".join(parts)


# Bloc « lecture seule » du chat (commande « /plan »). EN, comme tout ce qui
# est destiné au modèle. Le texte SERVI vient de ``system_prompts/PLAN_MODE.md``
# (mtime-caché via _load_fragment, éditable à froid comme le socle et les
# fragments) ; cette constante n'est que le REPLI si le fichier manque
# (déploiement partiel) — courte et opérationnelle : ce qui est interdit, le
# détour par le shell fermé, la sortie attendue.
_PLAN_MODE_BLOCK = (
    "# Read-only mode (active)\n"
    "\n"
    "This conversation is in READ-ONLY mode. Investigate and plan; do not "
    "change anything.\n"
    "\n"
    "- Do NOT create, edit, move or delete files, and do not commit, push or "
    "revert anything.\n"
    "- Do NOT run commands that modify state — no writing through a shell "
    "redirect, no sed -i, tee, mv, rm, install or package manager, and no "
    "workaround of any kind for the restrictions above.\n"
    "- Reading, searching, inspecting and documentary lookups are expected: "
    "use them freely.\n"
    "- Your tool surface has already been reduced to read-only tools. Do not "
    "assume a missing tool is a temporary glitch — plan around it.\n"
    "\n"
    "Deliver a concrete plan: what you found, what you would change (file by "
    "file), in what order, and what could go wrong. Read-only mode is "
    "one-shot: it ends automatically once this reply is delivered — the next "
    "user message runs with full tools again."
)


def assemble_system_messages(
    custom_sys: str,
    active_mcp_servers: Optional[Iterable[Dict[str, Any]]] = None,  # deprecated/ignored
    last_user_text: Optional[str] = None,
    user_id: Optional[int] = None,
    pinned_skills: Optional[Iterable[str]] = None,
    memory_block: Optional[str] = None,
    today: Optional[str] = None,
    skills_enabled: bool = True,
    plan_mode: bool = False,
    model_label: Optional[str] = None,
) -> List[Dict[str, str]]:
    """Build the system message(s) to prepend to ``messages``.

    Single-message strategy (prefix-cache friendly)
    -----------------------------------------------
    On retourne **un seul** ``{"role": "system"}`` qui concatène les blocs
    dans un ordre figé :

        1. custom_sys           — figé pendant la session
        2. en-tête runtime      — "Today's date: …" (change 1×/jour) +
                                  "Backing model: …" (change au switch de
                                  modèle/connecteur — le socle y renvoie pour
                                  les questions d'identité)
        3. memory snapshot      — figé (capturé une fois par le MemoryManager)
        4. skills_index         — figé tant que l'arbo skills ne bouge pas
        5. skills_bodies        — **variable** (matching auto sur
                                  ``last_user_text``) → PLACÉS À LA FIN pour
                                  que tout ce qui précède reste prefix-cache
                                  stable.

    ``active_mcp_servers`` est ignoré (aucun bloc « Tool Protocols » — cf.
    docstring du module) ; le paramètre reste accepté pour compat.

    Retourne une liste d'au plus 1 dict ``{"role": "system", "content": ...}``,
    vide si rien à émettre.
    """
    parts: List[str] = []
    custom = (custom_sys or "").strip()
    if custom:
        parts.append(custom)

    # En-tête runtime — juste après le socle (avant mémoire/skills). Date :
    # change 1×/jour. Modèle : change au switch de modèle/connecteur — le socle
    # dit de répondre aux questions d'identité depuis cette ligne au lieu
    # d'halluciner un nom appris à l'entraînement (les modèles servis ici sont
    # interchangeables). Un seul « part » pour les deux (pas de séparateur
    # ``---`` entre eux) ; champs vides → lignes omises (pas de header orphelin).
    _runtime_lines = []
    t = (today or "").strip()
    if t:
        _runtime_lines.append(f"Today's date: {t}.")
    ml = (model_label or "").strip()
    if ml:
        _runtime_lines.append(f"Backing model: {ml}.")
    if _runtime_lines:
        parts.append("\n".join(_runtime_lines))

    # Mode lecture seule (« /plan ») — placé dans la partie STABLE du
    # préfixe, avant mémoire et skills. La surface d'outils est déjà réduite
    # en amont (seuls les outils annotés read-only survivent) et le manifeste
    # « # Active tools » le reflète : ce bloc dit l'INTENTION, pour que le
    # modèle propose un plan au lieu de buter sur des outils absents et de
    # chercher un détour (le shell est la tentation classique).
    if plan_mode:
        parts.append(_load_fragment("PLAN_MODE") or _PLAN_MODE_BLOCK)

    mem = (memory_block or "").strip()
    if mem:
        parts.append(mem)

    # ``skills_enabled`` gates the INDEX + header (they tell the model to call
    # skill_get/skill_read_file/skill_run_script — injecter ça quand la catégorie
    # d'outils « skill » est OFF est une instruction MORTE). Mais les corps de
    # skills ÉPINGLÉS (/skill) sont du texte AUTO-SUFFISANT (indépendant de
    # skill_get) : l'utilisateur les a explicitement forcés → on les injecte MÊME
    # catégorie OFF (avec le header « attachés », sans index, via include_index=
    # skills_enabled). Sans ça, épingler un skill sans activer la catégorie
    # (état par défaut) perdrait silencieusement la procédure demandée.
    # ``last_user_text is None`` sans skill épinglé = opt-out total (aucun bloc
    # skills).
    if (skills_enabled or pinned_skills) and (last_user_text is not None or pinned_skills):
        skills = _build_skills_block(last_user_text, user_id, pinned_skills,
                                     include_index=skills_enabled)
        if skills:
            # Placé EN DERNIER intentionnellement : la partie skills_bodies
            # peut varier (skills épinglés) → on la rejette en fin de système
            # prompt pour ne pas invalider tout le préfixe en amont. Le
            # ``n_cache_reuse`` côté payload (+ flag serveur ``--cache-reuse``)
            # absorbe ce diff via KV-shifting.
            parts.append(skills)

    if not parts:
        return []
    # Séparateur explicite type "horizontal rule" markdown : visible côté LLM,
    # déterministe côté hash. Éditable à froid (assembly.separator) ; défaut idem.
    _sep = "\n\n---\n\n"
    try:
        from llm_core.context_config import CTX as _CTX
        _sep = _CTX.override("assembly.separator", _sep)
    except Exception:
        pass
    return [{"role": "system", "content": _sep.join(parts)}]


def preview(
    custom_sys: str,
    active_mcp_servers: Optional[Iterable[Dict[str, Any]]] = None,  # deprecated/ignored
    last_user_text: Optional[str] = None,
    user_id: Optional[int] = None,
    pinned_skills: Optional[Iterable[str]] = None,
    memory_block: Optional[str] = None,
    today: Optional[str] = None,
) -> str:
    """Return the assembled prompt as one string for debug / inspection."""
    msgs = assemble_system_messages(custom_sys, active_mcp_servers,
                                    last_user_text, user_id, pinned_skills,
                                    memory_block, today)
    if not msgs:
        return ""
    sep = "\n\n" + ("=" * 60) + "\n\n"
    return sep.join(m["content"] for m in msgs)


# ─────────────────────────────────────────────────────────────────────────────
# Capability fragments — guides injectés SELON les outils actifs
# ─────────────────────────────────────────────────────────────────────────────
#
# Le socle (CHATBOT_SYSTEM.md) est AGNOSTIQUE aux capacités : il ne suppose ni
# sandbox ni outils, car une session peut être purement conversationnelle
# (chat-only). Tout le cadrage « tu peux agir / sandbox / posture
# réversible-destructeur » vit dans des fragments ``system_prompts/FRAGMENT_*.md``
# injectés UNIQUEMENT quand la capacité correspondante est active. Les capacités
# dérivent des catégories d'outils du tour (``_mcp_categories.categorize``),
# connues seulement dans ``run_chat_multi_mcp`` (chemin outillé) — d'où
# l'injection au prélude de la boucle
# (``context.assembly.assemble_operational_context``) et non dans l'assemblage
# initial.

# Catégories d'« action » : leur présence déclenche le cadrage outils/sandbox
# (FRAGMENT_TOOLS + runtime_context). Les catégories « douces » (chart/memory/rag)
# n'en font PAS partie → elles ne tirent NI FRAGMENT_TOOLS NI runtime_context, mais
# reçoivent quand même leur propre guide via l'étage « contenu » ci-dessous.
_ACTION_CATEGORIES = frozenset({"fs", "shell", "git", "desktop", "browser"})
# Catégories « fichier » : pilotent le runtime_context (sandbox fichiers/shell/git).
_FILE_CATEGORIES = frozenset({"fs", "shell", "git"})

# Étage ACTION — (catégories déclencheuses → stem spécialisé). Ordre = injection.
# Injecté SOUS FRAGMENT_TOOLS (donc seulement si une catégorie d'action est active).
_CAPABILITY_FRAGMENTS: List[Tuple[frozenset, str]] = [
    (_FILE_CATEGORIES,        "FRAGMENT_CODE"),
    (frozenset({"desktop"}),  "FRAGMENT_AUTOMATION"),
    (frozenset({"browser"}),  "FRAGMENT_WEB"),
]

# Étage CONTENU — capacités « douces » (graphiques, mémoire, RAG) : PAS des actions
# sandbox. Injectées INDÉPENDAMMENT des _ACTION_CATEGORIES → elles fournissent un
# guide quand leurs outils sont actifs (sinon une session « chart/memory/RAG seule »
# n'aurait aucun guide, ce qui contredit le socle), sans tirer FRAGMENT_TOOLS ni
# runtime_context. `chart`/`memory` viennent du registre MCP ; `rag` est synthétisée
# au tour (outils RAG = builtins, cf. context.assembly.assemble_operational_context).
_CONTENT_FRAGMENTS: List[Tuple[frozenset, str]] = [
    (frozenset({"chart"}),    "FRAGMENT_CHART"),
    (frozenset({"office"}),   "FRAGMENT_OFFICE"),
    (frozenset({"memory"}),   "FRAGMENT_MEMORY"),
    (frozenset({"rag"}),      "FRAGMENT_RAG"),
]

# Cache mtime des fragments (édition à chaud via l'admin, comme les autres prompts).
_FRAGMENT_CACHE: Dict[str, Tuple[float, str]] = {}


def _load_fragment(stem: str) -> str:
    """Lit ``system_prompts/<stem>.md`` (mtime-caché). "" si absent/illisible."""
    p = _SYSTEM_P_DIR / f"{stem}.md"
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return ""
    cached = _FRAGMENT_CACHE.get(stem)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        txt = p.read_text(encoding="utf-8").strip()
    except OSError:
        txt = ""
    _FRAGMENT_CACHE[stem] = (mtime, txt)
    return txt


def load_agent_persona(stem: str) -> str:
    """Persona d'un sous-agent ``task`` : lit ``system_prompts/<stem>.md``
    (mtime-caché). "" si absent. Utilisé par llm_core/tools/task_tool.py pour
    la tête système de l'enfant — elle REMPLACE le socle CHATBOT_SYSTEM."""
    return _load_fragment(stem)


def _manifest_fragments() -> Dict[str, str]:
    """``{catégorie: stem}`` déclarés par les entrées intégrées du manifeste
    (``x-elpis.prompt_fragments``, clés = familles OU catégories). Vide sans
    déclaration — les tables ci-dessus font alors foi. Stems restreints à un
    nom de fichier simple (``system_prompts/<stem>.md``)."""
    out: Dict[str, str] = {}
    try:
        from shared_infra.mcp.families import FAMILY_CATEGORY
        from shared_infra.mcp.manifest import load as _mf_load
        for e in _mf_load().builtins():
            for k, stem in (e.prompt_fragments or {}).items():
                stem = str(stem or "").strip()
                if not stem or "/" in stem or "\\" in stem or ".." in stem:
                    continue
                cat = FAMILY_CATEGORY.get(str(k).strip().lower(), str(k).strip().lower())
                out[cat] = stem
    except Exception:
        return {}
    return out


def _normalize_categories(active_categories: Optional[Iterable[str]]) -> set:
    return {str(c).strip().lower() for c in (active_categories or ()) if str(c).strip()}


def capability_wants_runtime_context(active_categories: Optional[Iterable[str]]) -> bool:
    """True si le runtime_context (sandbox fichiers/shell/git) est pertinent ce tour."""
    return bool(_normalize_categories(active_categories) & _FILE_CATEGORIES)


def build_capability_block(active_categories: Optional[Iterable[str]]) -> Optional[str]:
    """Assemble les fragments de capacité actifs, ou ``None``.

    Deux étages :

    - **ACTION** (``_ACTION_CATEGORIES`` = fs/shell/git/desktop/browser) : si l'un
      est actif, ``FRAGMENT_TOOLS`` (cadrage sandbox/agentique) + les fragments
      spécialisés (code / automation / web). Absent si aucune action → une session
      chat-only, ou seulement chart/memory/RAG, ne reçoit PAS ce cadrage.
    - **CONTENU** (``_CONTENT_FRAGMENTS`` = chart/memory/rag) : injecté
      INDÉPENDAMMENT, quand la catégorie « douce » correspondante est active — sans
      tirer FRAGMENT_TOOLS ni runtime_context.

    Ordre déterministe (action d'abord, puis contenu), déduplication. Renvoie
    ``None`` si rien à injecter. Best-effort : un fragment illisible est ignoré.
    """
    cats = _normalize_categories(active_categories)
    stems: List[str] = []
    # Fragments DÉCLARÉS par le manifeste ``mcp.json``
    # (``x-elpis.prompt_fragments`` : catégorie → stem) : surcharge des stems
    # ci-dessous pour une catégorie connue, ajout d'un fragment pour une
    # catégorie nouvelle (serveur déclaré, famille future). Une catégorie
    # d'action garde son étage (FRAGMENT_TOOLS + runtime_context).
    declared = _manifest_fragments()
    # Étage ACTION — seulement si une capacité d'action est active.
    if cats & _ACTION_CATEGORIES:
        stems.append("FRAGMENT_TOOLS")
        for trigger, stem in _CAPABILITY_FRAGMENTS:
            if cats & trigger:
                stem = next((declared[c] for c in sorted(cats & trigger) if c in declared), stem)
                if stem not in stems:
                    stems.append(stem)
    # Étage CONTENU — indépendant de l'étage action (pas de FRAGMENT_TOOLS tiré).
    for trigger, stem in _CONTENT_FRAGMENTS:
        if cats & trigger:
            stem = next((declared[c] for c in sorted(cats & trigger) if c in declared), stem)
            if stem not in stems:
                stems.append(stem)
    # Catégories déclarées SANS étage connu (nouvelle famille, serveur tiers).
    _known = _ACTION_CATEGORIES | {c for trig, _ in _CONTENT_FRAGMENTS for c in trig}
    for c in sorted(cats & set(declared) - _known):
        if declared[c] not in stems:
            stems.append(declared[c])
    blocks = [b for b in (_load_fragment(s) for s in stems) if b]
    if not blocks:
        return None
    return "\n\n".join(blocks)


def build_skills_index_block(user_id: Optional[int]) -> Optional[str]:
    """INDEX seul (header + catalogue), sans aucun corps de skill.

    Pour un contexte qui possède la catégorie d'outils ``skill`` mais qui ne
    passe pas par l'assemblage du chat — concrètement un SOUS-AGENT : il reçoit
    ``skill_get`` / ``skill_read_file`` / ``skill_run_script`` mais l'index, lui,
    est injecté par la route de chat. Sans lui l'enfant détient trois outils
    qu'il ne peut appeler qu'en devinant un nom : capacité annoncée par le
    manifeste ``# Active tools``, inutilisable en pratique.

    Aucun corps n'est injecté (modèle full-pull, comme le chat) : le coût est
    l'index, l'enfant tire la procédure qu'il veut avec ``skill_get(name)``.
    ``None`` si l'utilisateur n'a aucun skill visible.
    """
    return _build_skills_block(None, user_id=user_id, pinned_skills=None,
                               include_index=True)


def build_attached_skills_block(user_id: Optional[int],
                                skill_ids: Iterable[str]) -> Optional[str]:
    """Bloc « skills attachés » : corps complets des skills désignés, SANS index.

    Pour un agent qui tourne hors du chat (ex. run de routine) : il n'a ni
    l'index des skills ni — sauf catégorie d'outils « skill » activée —
    l'outil ``skill_get``, donc les procédures choisies doivent être injectées
    entières dans son message système. Réutilise ``_build_skills_block`` en
    mode épinglé (``include_index=False`` → header « procédures à appliquer ») :
    résolution par id qualifié (``pkg/child``) ou nom, user > global, learned
    exclu, budget ``SKILLS_CHAR_BUDGET``. Les ids inconnus (skill supprimé/
    renommé depuis la sélection) sont ignorés.

    Épingler un skill PRINCIPAL (paquet) embarque aussi ses sous-skills :
    chaque id est étendu à ses descendants (corps du parent d'abord, puis les
    enfants dans l'ordre de l'arbre) — « l'utilisateur choisit le paquet, le
    modèle applique la procédure qui convient ». Pour ne viser qu'un
    sous-skill précis, on épingle directement son id qualifié. Le budget
    SKILLS_CHAR_BUDGET borne le total (les corps excédentaires sont omis).

    Retourne None si aucun id ne résout (ou liste vide).
    """
    ids = [str(s).strip() for s in (skill_ids or []) if str(s).strip()]
    if not ids:
        return None
    # Expansion paquet → descendants. Best-effort : si la découverte échoue ici,
    # on passe les ids tels quels (_build_skills_block re-découvre de toute façon).
    try:
        from llm_core.skills import discover_skills
        specs = discover_skills(_user_skills_dir(user_id), include_learned=False)
        # Même résolution (et tie-breaking) que _build_skills_block :
        # nom d'abord, puis l'id qualifié prime.
        by_key: Dict[str, Any] = {}
        for sp in specs:
            by_key[sp.name] = sp
        for sp in specs:
            by_key[getattr(sp, "id", "") or sp.name] = sp
        expanded: List[str] = []
        for raw in ids:
            sp = by_key.get(raw)
            rid = (getattr(sp, "id", "") or sp.name) if sp is not None else raw
            if rid not in expanded:
                expanded.append(rid)
            if sp is None:
                continue
            prefix = rid + "/"
            # ``specs`` est trié par (domain, id) → les descendants sortent en
            # ordre d'arbre (DFS par id qualifié).
            for child in specs:
                cid = getattr(child, "id", "") or child.name
                if cid.startswith(prefix) and cid not in expanded:
                    expanded.append(cid)
        ids = expanded
    except Exception as e:                        # noqa: BLE001
        logger.debug("[skills] expansion paquet ignorée: %s", e)
    return _build_skills_block(None, user_id=user_id,
                               pinned_skills=ids, include_index=False)


def list_known_categories() -> List[str]:
    """List every ``.md`` file stem in system_prompts/ (hors ``_*``).

    Sert à l'endpoint admin d'inspection des prompts (CHATBOT_SYSTEM,
    FRAGMENT_*, COMPRESSOR_SYSTEM, …)."""
    if not _SYSTEM_P_DIR.is_dir():
        return []
    out = []
    for p in sorted(_SYSTEM_P_DIR.glob("*.md")):
        if p.stem.startswith("_"):     # _TEMPLATE.md and similar
            continue
        out.append(p.stem)
    return out
