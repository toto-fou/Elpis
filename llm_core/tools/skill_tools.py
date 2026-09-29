# SPDX-License-Identifier: MIT
# tools/skill_tools.py
"""
Skills — procedural memory the agent can WRITE.

A "skill" is a markdown how-to (deploy via Jenkins, reset Qdrant, …). The
*loading* of skills is deterministic and handled by the backend: it matches
the user's request against skill descriptions and injects the relevant bodies
into the system prompt (see ``llm_core/_system_prompts.py`` and
``llm_core/skills.py``). This module gives the agent two complementary capabilities:
  - ``skill_save`` — SAVE a new skill after solving a novel, reusable procedure;
  - ``skill_get``  — LOAD the full body of a skill the model only saw in the
    index (the deterministic injection only details the top matches).

``skill_save`` writes to the caller's OWN sandbox (source ``user``): the skill
becomes routable for that user's future sessions only, and is NEVER injected
into another user's prompt (audit CRIT-1). An admin can later promote a
personal/curated skill to the shared ``skills/`` library from the skills admin
UI (``POST /api/skills/promote`` works on the ``learned`` staging area).

Category travels in the protocol via ``tags`` + ``meta`` (FastMCP-native),
exactly like the other tool modules — no manifest, no wrapper.

NB : pas de ``from __future__ import annotations`` ici — comme les autres
modules ``tools/*_tools.py``. FastMCP/pydantic doit résoudre les annotations
des paramètres @mcp.tool à la définition ; en mode PEP 563 (strings), les
forward refs ``Optional[...]`` sont ré-évaluées dans un mauvais namespace au
build du schéma → NameError.
"""
import asyncio
import os
import re
from pathlib import Path
from typing import Any, List, Optional, Union

from fastmcp import Context, FastMCP
from pydantic import Field

from ._models import AskUserResult, ErrEnvelope, SkillFileResult, SkillGetResult, SkillRunResult, SkillSaveResult
from ._toolkit import _read_meta_field, as_list, as_str, get_username, tool_kw_mutating, tool_kw_readonly, with_policy


def _user_sandbox_dir(username: str) -> Path:
    """Racine PAR-UTILISATEUR ``P = <SANDBOX_DIR>/<safe_user>`` — où vit le
    store-miroir ``skills/`` (HORS du mont ``/work`` désormais)."""
    from shared_infra.config import SANDBOX_DIR, safe_sandbox_name
    base = Path(os.environ.get("APP_SANDBOX_DIR") or str(SANDBOX_DIR)).resolve()
    return base / safe_sandbox_name(username)


def _user_work_dir(username: str) -> Path:
    """Racine de TRAVAIL ``P/work`` (montée sur ``/work``) — sandbox_root pour
    exécuter les scripts de skills dans le conteneur du user."""
    from shared_infra.sandbox import ensure_work_subdir
    return ensure_work_subdir(_user_sandbox_dir(username))


def _resolve_skill_spec(username: str, name: str):
    """Résout un skill par name dans les skills VISIBLES par l'appelant
    (perso > global ; learned exclu = sas admin). Renvoie ``(spec | None)``.
    Mêmes règles de matching que ``skill_get`` (id qualifié, name exact, slug)."""
    from llm_core.skills import discover_skills, slugify_name
    skills = discover_skills(_user_skills_dir(username), include_learned=False)
    want = as_str(name)
    want_slug = slugify_name(want)
    return (next((s for s in skills if getattr(s, "id", s.name) == want), None)
            or next((s for s in skills if s.name == want), None)
            or next((s for s in skills if slugify_name(s.name) == want_slug), None))


def _safe_skill_file(skill_dir: Path, rel: str) -> Path:
    """Résout ``rel`` SOUS ``skill_dir`` (containment via resolve+relative_to).
    Rejette ``..``/absolu/symlink-out/octet nul."""
    raw = as_str(rel).strip().lstrip("/")
    if not raw or "\x00" in raw:
        raise ValueError("chemin requis")
    base = Path(skill_dir).resolve()
    target = (base / raw).resolve()
    if target != base and base not in target.parents:
        raise ValueError("chemin hors du dossier du skill")
    return target


# Caps for the file-read / script-run tools (skills no longer live on the
# sandbox FS, so reads/exec go through these tools).
_SKILL_FILE_READ_CAP = 256 * 1024            # 256 KB returned to the model
_SKILL_RUN_MAX_BYTES = 8 * 1024 * 1024       # max staged skill-dir size
_SKILL_RUN_MAX_OUTPUT = 64 * 1024            # stdout/stderr cap
_SKILL_RUN_DEFAULT_TIMEOUT = 60
_SKILL_RUN_MAX_TIMEOUT = 300
# ask_user — bornes du questionnaire. Nommées (et citées dans la description du
# paramètre + le `warning` du résultat) : elles mordaient en silence, le modèle
# croyait avoir posé 10 questions et attendait 10 réponses.
_ASK_MAX_QUESTIONS = 8
_ASK_MAX_OPTIONS = 12
_ASK_MAX_Q_CHARS = 300
_ASK_MAX_OPT_CHARS = 120
# Interpreters actually present in the sandbox image (elpis/sandbox): python3,
# bash, node, perl. NB: ruby is NOT installed → no `.rb` mapping (would fail
# rc 127 at runtime; better to reject up-front with skill_run_unsupported).
_SKILL_INTERP = {
    ".py": "python3", ".sh": "bash", ".bash": "bash",
    ".js": "node", ".mjs": "node", ".pl": "perl",
}
# skill_run_script env passthrough — the documented knobs of bundled scripts
# (APPLY, RERUN_FAILED, TOP…). Uppercase-only keys; the denylist keeps the
# exec wrapper itself (PATH lookup of bash/timeout, HOME=/work) intact —
# the sandbox stays the security boundary, this only protects the plumbing.
_SKILL_RUN_MAX_ENV = 16
_SKILL_ENV_VAL_CAP = 4096
_SKILL_ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_SKILL_ENV_DENYLIST = frozenset(
    {"PATH", "HOME", "IFS", "ENV", "BASH_ENV", "SHELL", "SKILL_DIR"})


def _SKILL_ENV_DENIED(key: str) -> bool:
    return key in _SKILL_ENV_DENYLIST or key.startswith("LD_")


def _user_skills_dir(username: str) -> Path:
    """STORE protégé des skills perso de l'appelant — HORS sandbox.

    Le modèle n'a aucun accès direct au store (ni fs ni shell) : la sandbox ne
    contient qu'une COPIE de travail ``<sandbox>/skills/`` (miroir régénéré par
    ``sync_user_skills_mirror``, jetable). Doit pointer exactement là où le
    backend lit les skills perso (``_system_prompts._user_skills_dir`` /
    ``routes/skills.py``) pour que le skill sauvé soit ré-injecté dans les
    prochaines sessions du MÊME user — et de lui seul. Migre l'ancien
    emplacement sandbox à la première résolution.
    """
    from llm_core.skills import ensure_user_skills_store
    from shared_infra.config import USER_SKILLS_DIR, safe_sandbox_name
    base = Path(os.environ.get("APP_USER_SKILLS_DIR") or str(USER_SKILLS_DIR)).resolve()
    return ensure_user_skills_store(base / safe_sandbox_name(username),
                                    _user_sandbox_dir(username))

# ── Category descriptor ──────────────────────────────────────────────
CATEGORY: dict[str, Any] = {
    "name":   "skill",
    "label":  "Skills",
    "icon":   "ph-graduation-cap",
    "color":  "violet",
    "hidden": False,
}

_TOOL_KW_MUT = tool_kw_mutating(CATEGORY, serial=True)
_TOOL_KW_RO  = tool_kw_readonly(CATEGORY)

_MAX_NAME_LEN = 80
_MAX_DESC_LEN = 300
_MAX_BODY_LEN = 20000


# ── Registration ─────────────────────────────────────────────────────
def register_library(mcp: FastMCP) -> None:
    """Bibliothèque de skills (famille ``skill``, liée au COMPTE) : ``skill_save``,
    ``skill_add_file``, ``skill_get``, ``skill_read_file`` et ``ask_user``. Aucune
    racine sandbox nécessaire (skills dans le magasin de l'app, résolus par
    ``llm_core.skills``). (2026-09-12, P4) séparée de ``skill_run_script``, qui
    s'exécute DANS LE SANDBOX (famille ``skill_run``, hôte d'outils)."""

    @mcp.tool(**_TOOL_KW_MUT)
    async def skill_save(
        ctx: Context,
        name: str = Field(
            description="Short kebab-case identifier, e.g. 'deploy-jenkins'. "
                        "Slugified for the filename."),
        description: str = Field(
            description="One keyword-rich sentence — this is what the router "
                        "matches future requests against. Be specific."),
        body: str = Field(
            description="The procedure itself, in markdown. Concrete steps, "
                        "exact commands, real paths. Self-contained."),
        tags: Optional[list[str]] = Field(
            default=None,
            description="Optional extra keywords for matching (e.g. "
                        "['jenkins', 'ci', 'deploy'])."),
        domain: Optional[str] = Field(
            default=None,
            description="Optional applicative domain — files the skill under "
                        "skills/learned/<domain>/ (e.g. 'jenkins', 'qdrant'). "
                        "Mirrors how curated skills are grouped by app."),
    ) -> Union[SkillSaveResult, ErrEnvelope]:
        """Save a reusable procedure as a PERSONAL skill for future reuse.

WHEN: you just worked out HOW to accomplish a non-trivial, generalizable
procedure on some software (deploy, reset, build, configure …) that is likely
to come up again. NOT for one-off answers, facts, or trivial single commands.

The skill is saved to YOUR protected personal skill store — host-side,
OUTSIDE the /work sandbox (any ``skills/`` folder visible in the sandbox is
only a disposable mirror) — and becomes routable for YOUR future sessions
only: next time a similar request arrives, the backend injects this procedure
automatically. It is NOT shared with other users (an agent saving a skill
must not be able to inject content into someone else's prompt — see audit
CRIT-1). An admin can later promote a personal skill to the curated, shared
library from the skills admin UI.

Example:
    skill_save(
        name="reset-qdrant",
        description="Réinitialiser la base vectorielle Qdrant à zéro",
        body="## Étapes\\n1. Arrêter le service…\\n2. …",
        tags=["qdrant", "vectordb", "reset"])

A personal skill may override a curated one of the same name (user > global)."""
        from llm_core.skills import SkillSaveError, save_user_skill

        clean_name = as_str(name)[:_MAX_NAME_LEN]
        clean_desc = as_str(description)[:_MAX_DESC_LEN]
        clean_body = as_str(body)[:_MAX_BODY_LEN]
        clean_tags = [as_str(t) for t in as_list(tags) if as_str(t)]
        clean_domain = as_str(domain)[:_MAX_NAME_LEN] or None

        username = get_username(ctx)
        try:
            user_skills_dir = _user_skills_dir(username)
            path = save_user_skill(user_skills_dir, clean_name, clean_desc,
                                   clean_body, clean_tags, clean_domain)
        except SkillSaveError as e:
            return ErrEnvelope(
                error="skill_save_rejected",
                message=str(e),
                fix="Check name (non-empty) and body (non-empty procedure).",
            )
        except Exception as e:                       # pragma: no cover (disk/io)
            return ErrEnvelope(
                error="skill_save_failed",
                message=f"write failed: {e}",
                retryable=True,
            )

        # Miroir sandbox rafraîchi (copie de travail visible par fs/shell).
        from llm_core.skills import sync_user_skills_mirror
        sync_user_skills_mirror(user_skills_dir, _user_sandbox_dir(username))

        await ctx.info(f"skill_save: personal skill written to {path}")
        return SkillSaveResult(
            # Dossier-skill : le name est le DOSSIER (path = <slug>/SKILL.md) —
            # path.stem donnerait « SKILL ». Legacy : stem du fichier.
            name=(path.parent.name if path.name == "SKILL.md" else path.stem),
            path=str(path),
            source="user",
            domain=clean_domain or "",
            description=clean_desc,
            tags=clean_tags,
            note="Personal skill saved (visible in your future sessions). "
                 "An admin can promote it to the curated shared library.",
        )

    @mcp.tool(**_TOOL_KW_MUT)
    async def skill_add_file(
        ctx: Context,
        name: str = Field(
            description="Name (slug) of an EXISTING personal skill, e.g. "
                        "'reset-qdrant' (qualified id 'pkg/child' accepted)."),
        path: str = Field(
            description="Path RELATIVE to the skill folder, e.g. "
                        "'scripts/run.sh' or 'references/notes.md'. "
                        "No '..', no hidden segments, not SKILL.md."),
        content: str = Field(
            description="Full UTF-8 text content of the file."),
    ) -> Union[SkillSaveResult, ErrEnvelope]:
        """Bundle a file (script, reference, template) into an existing personal skill.

WHEN: right after skill_save, to attach the scripts/references the procedure
mentions. Writes into the PROTECTED skills store (outside the sandbox) — do
NOT use write_file for this: the sandbox copy (``skills/…``) is a disposable
mirror, regenerated from the store, so anything written there directly is
lost. Reference the file in the skill body by relative path (e.g.
``scripts/run.sh``); at usage time skill_get tells where to read/execute it."""
        from llm_core.skills import SkillSaveError, add_user_skill_file, sync_user_skills_mirror

        username = get_username(ctx)
        try:
            store = _user_skills_dir(username)
            target = add_user_skill_file(store, as_str(name), as_str(path),
                                         as_str(content))
        except SkillSaveError as e:
            return ErrEnvelope(
                error="skill_add_file_rejected",
                message=str(e),
                fix="Check name (existing personal skill, created via skill_save) "
                    "and path (relative, e.g. scripts/run.sh).",
            )
        except Exception as e:                       # pragma: no cover (disk/io)
            return ErrEnvelope(
                error="skill_add_file_failed",
                message=f"write failed: {e}",
                retryable=True,
            )

        sync_user_skills_mirror(store, _user_sandbox_dir(username))
        # AUDIT 2026-08-23 — chemin relatif au DOSSIER DU SKILL, pas au STORE.
        # ``target.relative_to(store)`` porte le préfixe ``[<domaine>/]<slug>/``,
        # alors que ``skill_read_file`` et ``skill_run_script`` résolvent leur
        # paramètre SOUS ``spec.skill_dir`` via ``_safe_skill_file`` : le
        # préfixe était compté deux fois et le chemin annoncé n'existait
        # jamais. Le modèle suivait la consigne qu'on venait de lui donner,
        # récoltait ``skill_file_not_found``, et devait rappeler ``skill_get``
        # pour deviner — une à deux itérations perdues par fichier groupé, sur
        # un budget compté pour un sous-agent. C'est exactement la valeur que
        # ``skill_get`` publie dans ``files``.
        rel_in_skill = as_str(path).replace("\\", "/").strip().lstrip("/")
        await ctx.info(f"skill_add_file: {rel_in_skill} written to user store")
        return SkillSaveResult(
            name=as_str(name),
            path=str(target),
            source="user",
            domain="",
            description="",
            tags=[],
            note=f"File bundled into skill '{as_str(name)}' (protected store, "
                 f"outside /work). At usage time: `skill_read_file('"
                 f"{as_str(name)}', '{rel_in_skill}')` to read it, "
                 f"`skill_run_script(...)` to execute it if it is a script.",
        )

    @mcp.tool(**with_policy(_TOOL_KW_RO, deny_for=["subagent", "routine"]))
    async def ask_user(
        ctx: Context,
        questions: list = Field(
            description=f'1 to {_ASK_MAX_QUESTIONS} questions, each '
                        '{"q": "question text", '
                        '"options": ["suggested choice", …] (may be empty = '
                        'free-text answer), "multi": true if several choices '
                        "are valid}. The user ALWAYS gets a free-text field on "
                        "top of the options. Write questions and options in "
                        "the user's language. Anything past these bounds is "
                        f"dropped before display (max {_ASK_MAX_OPTIONS} options "
                        f"per question, {_ASK_MAX_Q_CHARS} chars per question, "
                        f"{_ASK_MAX_OPT_CHARS} per option) — the result then "
                        "carries a `warning` saying what was left out."),
    ) -> Union[AskUserResult, ErrEnvelope]:
        """Display an interactive questionnaire ABOVE the user's prompt bar.

WHEN: you need several pieces of information from the user (interview, scoping,
preference gathering — e.g. building a skill). Instead of asking questions in
plain text one message at a time, call this tool ONCE with all the questions of
the round: the UI walks the user through them one by one (clickable options +
free-text field) and their combined answers arrive as the NEXT user message.

AFTER the call: end your turn IMMEDIATELY with one short sentence inviting the
user to answer below — do NOT repeat the questions in text."""
        raw = as_list(questions)
        items = []
        # Les bornes ci-dessous MORDENT en silence dans l'historique : on les
        # collecte pour les rendre au modèle (cf. `warning` du résultat).
        _clipped: List[str] = []
        if len(raw) > _ASK_MAX_QUESTIONS:
            _clipped.append(f"{len(raw) - _ASK_MAX_QUESTIONS} question(s) dropped "
                            f"(max {_ASK_MAX_QUESTIONS})")
        for x in raw[:_ASK_MAX_QUESTIONS]:
            if not isinstance(x, dict):
                continue
            _q_raw = as_str(x.get("q") or x.get("question"))
            q = _q_raw[:_ASK_MAX_Q_CHARS].strip()
            if not q:
                continue
            if len(_q_raw) > _ASK_MAX_Q_CHARS:
                _clipped.append(f"question text cut at {_ASK_MAX_Q_CHARS} chars")
            _opts_raw = [as_str(o) for o in as_list(x.get("options")) if as_str(o)]
            if len(_opts_raw) > _ASK_MAX_OPTIONS:
                _clipped.append(f"{len(_opts_raw) - _ASK_MAX_OPTIONS} option(s) dropped "
                                f"on {q[:40]!r} (max {_ASK_MAX_OPTIONS})")
            opts = [o[:_ASK_MAX_OPT_CHARS] for o in _opts_raw[:_ASK_MAX_OPTIONS]]
            items.append({"q": q, "options": opts, "multi": bool(x.get("multi"))})
        if not items:
            return ErrEnvelope(
                error="ask_user_rejected",
                message="no valid question",
                fix='Pass questions=[{"q": "…", "options": ["…"], "multi": false}, …] '
                    "(1 to 8 questions, non-empty q).",
            )
        await ctx.info(f"ask_user: questionnaire of {len(items)} question(s) displayed")
        # The frontend intercepts the tool_call EVENT (name + args) to render
        # the panel — this result only steers the model.
        return AskUserResult(
            count=len(items),
            note="Questionnaire displayed to the user above their prompt bar. "
                 "End your turn NOW with one short sentence (e.g. « Réponds au "
                 "questionnaire ci-dessous 👇 ») without repeating the "
                 "questions; the answers arrive in the next user message.",
            warning=("Input clipped before display — " + "; ".join(_clipped) +
                     ". Only what is listed in `count` was actually shown.")
                    if _clipped else None,
        )

    @mcp.tool(**_TOOL_KW_RO)
    async def skill_get(
        ctx: Context,
        name: str = Field(
            description="The skill name exactly as it appears in the skills "
                        "index (e.g. 'jenkins-deploy')."),
    ) -> Union[SkillGetResult, ErrEnvelope]:
        """Load the FULL body (the step-by-step procedure) of a known skill.

WHEN: the skills index lists a procedure that fits the task but whose body was
NOT auto-injected (only the top matches are detailed). Call this to fetch the
exact steps BEFORE acting — do not reconstruct the procedure from memory.

Resolves over the skills visible to you (your personal skills + the curated
global library; the per-user precedence applies). Returns an error if no skill
matches the given name.

Skills live in a protected store OUTSIDE the /work sandbox (a `skills/`
folder seen in the sandbox is only a disposable mirror — do not edit it): to
READ a bundled reference/script use skill_read_file(name, path); to RUN a
bundled script use skill_run_script(name, script)."""
        from llm_core.skills import discover_skills, slugify_name

        username = get_username(ctx)
        try:
            # Même vue que l'index injecté (learned exclu : c'est un sas admin).
            # AUDIT 2026-09-01 (passe 5, B13) — scan potentiel de tout l'arbre
            # sur miss de cache : hors de la boucle du serveur MCP partagé.
            skills = await asyncio.to_thread(
                discover_skills, _user_skills_dir(username), include_learned=False)
        except Exception as e:                       # pragma: no cover (disk/io)
            return ErrEnvelope(
                error="skill_get_failed",
                message=f"read failed: {e}",
                retryable=True,
            )

        want = as_str(name)
        want_slug = slugify_name(want)
        # Match par id QUALIFIÉ (``pkg/child``) d'abord, puis name exact (rétro-
        # compat), puis slug. discover_skills applique déjà user>learned>global.
        spec = (next((s for s in skills if getattr(s, "id", s.name) == want), None)
                or next((s for s in skills if s.name == want), None)
                or next((s for s in skills if slugify_name(s.name) == want_slug), None))
        if spec is None:
            return ErrEnvelope(
                error="skill_not_found",
                message=f"no skill named '{want}'.",
                fix="Use a name present in the skills index.",
            )

        note = None
        if spec.is_folder and spec.files:
            note = (
                "Ce skill embarque des fichiers (champ `files`). Lis-en un avec "
                f"`skill_read_file('{spec.name}', '<chemin>')` et exécute un "
                f"script avec `skill_run_script('{spec.name}', 'scripts/<x>.py')`"
                " — les fichiers ne sont PAS dans /work, n'essaie pas read_file/"
                "execute_shell dessus."
            )
        # Sous-skills imbriqués : signale-les pour navigation à la demande.
        _spec_id = getattr(spec, "id", spec.name)
        _children = [s for s in skills if getattr(s, "parent_id", None) == _spec_id]
        if _children:
            _kids = ", ".join(f"`{getattr(c, 'id', c.name)}`" for c in _children)
            _cnote = f"Sous-skills (charge-les via skill_get) : {_kids}."
            note = (note + "\n" + _cnote) if note else _cnote
        await ctx.info(f"skill_get: loaded '{spec.name}' ({len(spec.body)} chars, "
                       f"{'folder' if spec.is_folder else 'file'})")
        return SkillGetResult(
            name=spec.name,
            body=spec.body,
            description=spec.description or "",
            domain=spec.domain or "",
            tags=list(spec.tags),
            source=spec.source,
            is_folder=spec.is_folder,
            files=(list(spec.files) or None),
            sandbox_path=None,
            note=note,
        )

    @mcp.tool(**_TOOL_KW_RO)
    async def skill_read_file(
        ctx: Context,
        name: str = Field(
            description="Skill name exactly as in the skills index (e.g. "
                        "'jenkins-deploy'); qualified id 'pkg/child' accepted."),
        path: str = Field(
            description="Bundled file path RELATIVE to the skill folder, e.g. "
                        "'references/notes.md' or 'scripts/run.py'. From the "
                        "skill's `files` list. No '..', no absolute path."),
    ) -> Union[SkillFileResult, ErrEnvelope]:
        """Read ONE bundled file of a skill (a reference, template, or script source).

WHEN: skill_get showed the skill ships files (📦) and you need the content of
one — a reference to follow, or a script's source to inspect. Skills are NOT on
the sandbox filesystem, so this tool (not read_file) is how you read them."""
        username = get_username(ctx)
        try:
            # (passe 5, B13) — résolution = discover potentiel : thread.
            spec = await asyncio.to_thread(_resolve_skill_spec, username, name)
        except Exception as e:                       # pragma: no cover (disk/io)
            return ErrEnvelope(error="skill_read_failed",
                               message=f"read failed: {e}", retryable=True)
        if spec is None:
            return ErrEnvelope(
                error="skill_not_found",
                message=f"no skill named '{as_str(name)}'.",
                fix="Use a name present in the skills index.")
        # Only a real Agent-Skill DIRECTORY has bundled files. For a legacy
        # mono-file skill (skill_dir=None) we do NOT fall back to spec.path.parent
        # — that is the shared domain dir and would expose SIBLING skills' files
        # (skill_run_script doesn't do this fallback either). The body is already
        # returned by skill_get.
        skill_dir = spec.skill_dir
        if not skill_dir:
            return ErrEnvelope(
                error="skill_no_files",
                message="ce skill n'embarque aucun fichier.",
                fix="skill_get(name) already returns its body (SKILL.md).")
        try:
            target = _safe_skill_file(Path(skill_dir), path)
        except ValueError as e:
            return ErrEnvelope(
                error="skill_read_rejected", message=str(e),
                fix="path relatif au dossier du skill (ex. 'scripts/run.py'), "
                    "issu de la liste `files` de skill_get.")
        if not target.is_file():
            return ErrEnvelope(
                error="skill_file_not_found",
                message=f"fichier introuvable : {as_str(path)}",
                fix="Use a path listed in `files` (skill_get).")
        def _read_capped():
            # AUDIT 2026-09-01 (passe 5, B13) — avant : ``read_bytes()``
            # chargeait le fichier ENTIER en RAM avant le cap. Lecture BORNÉE,
            # en thread (la boucle du MCP partagé sert TOUS les utilisateurs).
            sz = target.stat().st_size
            with open(target, "rb") as fh:
                return sz, fh.read(_SKILL_FILE_READ_CAP).decode("utf-8", errors="replace")
        try:
            size, content = await asyncio.to_thread(_read_capped)
        except OSError as e:                          # pragma: no cover (disk/io)
            return ErrEnvelope(error="skill_read_failed",
                               message=f"read failed: {e}", retryable=True)
        await ctx.info(f"skill_read_file: {spec.name}/{as_str(path)} ({size} bytes)")
        return SkillFileResult(
            name=spec.name, path=as_str(path), content=content,
            size=size, truncated=size > _SKILL_FILE_READ_CAP)



def register_run(mcp: FastMCP) -> None:
    """Exécution d'un script de skill DANS LE SANDBOX (famille ``skill_run``) —
    portable avec l'hôte d'outils. Le skill lui-même est lu dans le miroir
    ``<sandbox>/<compte>/skills`` (poussé par l'app sur un hôte distant)."""

    # AUDIT 2026-09-25 — délai du harnais > délai maximal du script (+ mise en
    # place et grâce ``-k 5``) : sans lui, le défaut global (300 s) égalait le
    # maximum du script — le harnais coupait avant, le modèle recevait un
    # « timeout » opaque au lieu de stdout/stderr, et un nouvel essai lançait
    # une seconde copie pendant que la première tournait encore.
    @mcp.tool(**with_policy(_TOOL_KW_MUT, timeout_s=_SKILL_RUN_MAX_TIMEOUT + 30))
    async def skill_run_script(
        ctx: Context,
        name: str = Field(
            description="Skill name exactly as in the skills index; qualified "
                        "id 'pkg/child' accepted."),
        script: str = Field(
            description="Bundled SCRIPT path RELATIVE to the skill folder, e.g. "
                        "'scripts/run.py'. Must end in a supported extension: "
                        ".py .sh .bash .js .pl."),
        args: Optional[list] = Field(
            default=None,
            description="Optional list of string arguments passed to the script. "
                        "Relative paths resolve against /work (your sandbox "
                        "working dir), so pass sandbox files as you see them: "
                        "'src/main.py', 'tests/', '/work/data.csv'."),
        env: Optional[dict] = Field(
            default=None,
            description="Optional environment variables for the script (the "
                        "skill's documented knobs, e.g. {'APPLY': '1'}). Keys "
                        "must be UPPER_SNAKE_CASE; PATH/HOME/LD_* are rejected."),
        timeout_sec: Optional[int] = Field(
            default=None,
            description="Optional wall-clock timeout (default 60s, max 300s)."),
    ) -> Union[SkillRunResult, ErrEnvelope]:
        """Execute a bundled SCRIPT of a skill inside your sandbox container.

WHEN: skill_get / skill_read_file show the skill ships a runnable script
(scripts/…) the procedure tells you to run. The skill's files are staged into
an ephemeral dir OUTSIDE /work (exported as $SKILL_DIR, removed afterwards)
and the script runs as the sandbox user (UID 10001) FROM /work: relative
paths in `args` resolve against /work, and files the script writes
(results/, .venv/, profile.out…) land in /work where you can read them.
Supported interpreters: .py→python3, .sh/.bash→bash, .js→node, .pl→perl."""
        username = get_username(ctx)
        try:
            spec = _resolve_skill_spec(username, name)
        except Exception as e:                       # pragma: no cover (disk/io)
            return ErrEnvelope(error="skill_run_failed",
                               message=f"resolution failed: {e}", retryable=True)
        if spec is None:
            return ErrEnvelope(
                error="skill_not_found",
                message=f"no skill named '{as_str(name)}'.",
                fix="Use a name present in the skills index.")
        skill_dir = spec.skill_dir
        if not skill_dir or not Path(skill_dir).is_dir():
            return ErrEnvelope(
                error="skill_no_files",
                message="this skill bundles no executable scripts.",
                fix="skill_get(name) renvoie le corps (SKILL.md) du skill.")
        rel = as_str(script).strip().lstrip("/")
        try:
            target = _safe_skill_file(Path(skill_dir), rel)
        except ValueError as e:
            return ErrEnvelope(
                error="skill_run_rejected", message=str(e),
                fix="script relatif au dossier du skill, ex. 'scripts/run.py'.")
        if not target.is_file():
            return ErrEnvelope(
                error="skill_script_not_found",
                message=f"script introuvable : {rel}",
                fix="Utilise un chemin de `files` (skill_get) en .py/.sh/.js…")
        interp = _SKILL_INTERP.get(target.suffix.lower())
        if not interp:
            return ErrEnvelope(
                error="skill_run_unsupported",
                message=f"unsupported script type: {target.suffix or '(no extension)'}",
                fix="Supported extensions: .py .sh .bash .js .pl.")

        # Stage the WHOLE skill dir (sibling files may be referenced) as a tar
        # streamed over stdin; the in-container runner extracts it to an
        # ephemeral /tmp dir, runs the script there, and removes it. The size
        # scan + tar build (up to _SKILL_RUN_MAX_BYTES of disk I/O) run in a
        # thread so the MCP event loop is never blocked.
        import asyncio as _aio
        import io as _io
        import tarfile as _tf
        skill_path = Path(skill_dir)

        def _build_tar():
            try:
                total = sum(f.stat().st_size for f in skill_path.rglob("*") if f.is_file())
            except OSError:
                total = 0
            if total > _SKILL_RUN_MAX_BYTES:
                return None, total
            buf = _io.BytesIO()
            with _tf.open(fileobj=buf, mode="w") as tar:
                tar.add(str(skill_path), arcname=".")
            return buf.getvalue(), total

        try:
            tar_bytes, total = await _aio.to_thread(_build_tar)
        except Exception as e:                       # pragma: no cover (disk/io)
            return ErrEnvelope(error="skill_run_failed",
                               message=f"staging failed: {e}", retryable=True)
        if tar_bytes is None:
            return ErrEnvelope(
                error="skill_run_too_large",
                message=f"dossier du skill trop volumineux ({total} octets) pour le staging.",
                fix=f"Shrink the bundled files (limit ~{_SKILL_RUN_MAX_BYTES} bytes).")

        # Defensive: when a fixture/closure calls this directly and omits `args`,
        # the pydantic Field default isn't resolved → `args` is a FieldInfo, not
        # None. Treat anything that isn't a real list/tuple/str as "no args".
        arg_list = ([as_str(a) for a in as_list(args)]
                    if isinstance(args, (list, tuple, str)) else [])
        env_map: dict[str, str] = {}
        if isinstance(env, dict):
            if len(env) > _SKILL_RUN_MAX_ENV:
                return ErrEnvelope(
                    error="skill_run_rejected",
                    message=f"too many env vars ({len(env)} > {_SKILL_RUN_MAX_ENV}).",
                    fix="Pass only the knobs documented by the skill.")
            for k, v in env.items():
                key = as_str(k)
                if not _SKILL_ENV_KEY_RE.match(key) or _SKILL_ENV_DENIED(key):
                    return ErrEnvelope(
                        error="skill_run_rejected",
                        message=f"env var refusée : {key!r}",
                        fix="UPPER_SNAKE_CASE only; PATH/HOME/IFS/ENV/BASH_ENV/"
                            "SHELL/LD_* cannot be overridden.")
                env_map[key] = as_str(v)[:_SKILL_ENV_VAL_CAP]
        try:
            to = int(timeout_sec) if timeout_sec else _SKILL_RUN_DEFAULT_TIMEOUT
        except (TypeError, ValueError):
            to = _SKILL_RUN_DEFAULT_TIMEOUT
        to = max(1, min(to, _SKILL_RUN_MAX_TIMEOUT))

        # ``$1``=interp ``$2``=script-rel, rest=args. tar (stdin) is consumed by
        # the extract; the script's own stdin is /dev/null. The EXIT trap (set
        # right after mktemp) cleans up even when `timeout -k 5` SIGTERMs the
        # run — without it, a timed-out script leaks /tmp/.skill-run.* dirs.
        # cwd is /work, NOT the staging dir: relative sandbox paths passed as
        # args must resolve, and outputs (results/, .venv/…) must survive the
        # trap. The script itself is addressed absolutely inside the staging
        # dir ($d/$r) so $(dirname "$0") still reaches its sibling files.
        runner = (
            'i="$1"; r="$2"; shift 2; '
            'd=$(mktemp -d /tmp/.skill-run.XXXXXX) || exit 96; '
            'trap \'cd /; rm -rf "$d"\' EXIT; '
            'tar -xf - -C "$d" || exit 95; '
            'cd /work || exit 94; '
            'SKILL_DIR="$d" "$i" "$d/$r" "$@" </dev/null; rc=$?; '
            'cd /; rm -rf "$d"; trap - EXIT; exit $rc'
        )
        tokens = ["bash", "-c", runner, "skill_run", interp, rel, *arg_list]
        sandbox_root = _user_work_dir(username)

        from llm_core.tools._exec_bridge import run_shell_via_executor, user_id_for
        # (2026-09-11, P3) sortie en direct comme ``execute_shell`` : le chat
        # pose ``live_shell: "1"`` dans le meta MCP ; le front rend les
        # ``shell_output`` au step par ``call_id`` quel que soit l'outil.
        _live = (_read_meta_field(ctx, "live_shell") == "1")
        # Fichiers de /work modifiés par le script : historique + diffs du
        # chat (2026-09-26). Parcours hors boucle.
        from llm_core.tools._work_changes import WorkChanges, attach_any, uid_for
        _wc = WorkChanges(uid_for(username), username, sandbox_root, "shell")
        await _aio.to_thread(_wc.__enter__)
        try:
            res = await _aio.to_thread(
                run_shell_via_executor,
                tokens=tokens, workdir_host=sandbox_root, sandbox_root=sandbox_root,
                env_extra=env_map, timeout_s=to, max_output=_SKILL_RUN_MAX_OUTPUT,
                stdin_bytes=tar_bytes, user_id=user_id_for(username),
                username=username, audit_kind="tools.skill_run", ctx=ctx,
                stream_live=_live,
            )
        except Exception as e:
            return ErrEnvelope(error="skill_run_failed",
                               message=f"execution failed: {e}", retryable=True)
        finally:
            await _aio.to_thread(_wc.__exit__, None, None, None)

        rc = int(res.get("returncode", -1))
        note = None
        if rc == 124:
            note = f"Script interrompu (timeout {to}s)."
        elif rc in (95, 96):
            note = "Skill staging into the container failed (retry)."
        elif rc == 94:
            note = "/work indisponible dans le conteneur (sandbox à recréer ?)."
        await ctx.info(f"skill_run_script: {spec.name}/{rel} rc={rc}")
        # ``ok`` reflects the script's exit code (rc==0) — same convention as
        # execute_shell. The model must not read a crashed/timed-out script as
        # success; stdout/stderr/note carry the detail either way.
        return attach_any(_wc, SkillRunResult(
            ok=(rc == 0),
            name=spec.name, script=rel, returncode=rc,
            stdout=as_str(res.get("stdout", "")), stderr=as_str(res.get("stderr", "")),
            truncated=bool(res.get("truncated", False)), note=note))


def register(mcp: FastMCP) -> None:
    """Les six outils (compat : un seul service qui porte les deux familles)."""
    register_library(mcp)
    register_run(mcp)
