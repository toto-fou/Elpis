# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_prompt_reality_2026_07_31.py — audit « limites fantômes ».

Ce que le modèle LIT doit correspondre à ce que le runtime FAIT. Une contrainte
annoncée mais inexistante coûte autant qu'un bug : le modèle s'auto-bride
(« commit non exposé » alors que ``git_commit`` existe), plafonne trop tôt
(« default 30s » quand le vrai défaut est 120), ou appelle un outil supprimé
(``stat_path``, ``mode="mkdir"``) et brûle des itérations sur un refus.

Les dérives corrigées le 2026-07-31, verrouillées ici :
  1. chiffres de ``tool_help`` recopiés à la main → dérivés des constantes ;
  2. entrées d'aide pour des outils DISPARUS (stat_path / code_outline /
     code_navigate), encore citées en ``related`` par des entrées actives ;
  3. ``write_file(mode="mkdir")`` documenté alors que le schéma le refuse ;
  4. ``git_query`` annoncé à 13 actions, ``repos`` absent — celle-là même que
     le ``<runtime_context>`` recommande ;
  5. « Commit / push are intentionally NOT exposed » alors que git_commit /
     git_submit / git_start_work / git_abandon sont enregistrés ;
  6. ``<task_env>`` « Always use absolute paths » contre le
     ``<runtime_context>`` relatif fusionné dans le MÊME message système ;
  7. tour de synthèse imputant toujours l'arrêt au budget d'étapes.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

import llm_core.tools.fs_tools as fs_tools
import llm_core.tools.git_tools as git_tools
import llm_core.tools.shell_tools as shell_tools

# Surfaces et fragments dérivent du registre des catégories : le vrai.
pytestmark = pytest.mark.usefixtures("real_tool_registry")

ROOT = Path(__file__).resolve().parents[2]
PROMPTS_DIR = ROOT / "system_prompts"


class _FakeMCP:
    """Le vrai FastMCP échoue à l'introspection des closures dans ce sandbox
    (cf. tests/llm_core/test_fs_consolidation.py) — on ne veut ici que les NOMS."""

    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[kw.get("name") or fn.__name__] = fn
            return fn
        return deco


@pytest.fixture(scope="module")
def registered(tmp_path_factory):
    """Outils réellement enregistrés côté fs / shell / git (nom → callable)."""
    base = tmp_path_factory.mktemp("sandboxes")
    mcp = _FakeMCP()
    fs_tools.register(mcp, base)
    shell_tools.register(mcp, base)
    git_tools.register(mcp, base)
    return mcp.tools


# ── 1. Les chiffres annoncés = les constantes ────────────────────────────
#
# Le catalogue ``tool_help`` (une prose recopiée à la main, source de F1→F6) a
# été SUPPRIMÉ le 2026-08-06 avec l'outil lui-même. Les tests 1 à 5 qui le
# verrouillaient sont partis avec ; ne subsistent que ceux dont la surface
# lue par le modèle est la docstring de l'outil ou son code.

def test_shell_docstring_numbers_match_constants(registered):
    """La docstring de l'outil est désormais la SEULE surface d'aide lue par le
    modèle : les bornes qu'elle annonce doivent être les vraies constantes."""
    import inspect

    assert "execute_shell" in registered
    doc = inspect.getdoc(registered["execute_shell"]) or ""
    assert f"default {shell_tools.DEFAULT_TIMEOUT_S}" in doc, doc
    assert f"1..{shell_tools.MAX_TIMEOUT_S}" in doc, doc


def test_write_file_invalid_mode_hint_does_not_send_back_to_mkdir():
    src = (ROOT / "llm_core" / "tools" / "fs_tools.py").read_text(encoding="utf-8")
    assert 'hint="Use: write|append|mkdir|b64"' not in src


def test_tool_help_is_really_gone():
    """Retrait 2026-08-06 : l'outil consommait un schéma à CHAQUE tour de CHAQUE
    chat, et son catalogue avait déjà dérivé six fois. Surtout, il était le seul
    occupant restant d'une surface d'outils VIDE — un chat sans catégorie cochée
    ou un agent custom sans catégorie ne voyait que lui, et le modèle l'appelait
    en boucle faute d'autre chose à faire."""
    import importlib

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("llm_core.tools.help_tools")

    server_src = (ROOT / "server" / "local_mcp_server.py").read_text(encoding="utf-8")
    assert "help_tools" not in server_src

    from llm_core._mcp_categories import _STATIC_DISPLAY
    assert "help" not in _STATIC_DISPLAY


# ── 6. Chemins : une seule règle, celle du runtime_context ───────────────

def test_task_env_does_not_contradict_the_sandbox_path_rule():
    from llm_core.context.assembly import build_runtime_sandbox_context
    from llm_core.tools.task_tool import _AGENTS, _child_env_block

    ctx = build_runtime_sandbox_context("golden")
    assert "all relative to your sandbox root" in ctx.lower()
    for spec in _AGENTS.values():
        block = _child_env_block(spec, 1800)
        assert "absolute" not in block.lower(), block


def _builtin_persona_stems():
    """Stems des personas intégrées, DÉRIVÉS du registre — une liste en dur
    devient muette dès que le casting bouge (c'est ce qui s'est produit à la
    refonte du 2026-08-04 : ``general`` supprimé, trois agents ajoutés)."""
    from llm_core.tools.task_tool import _AGENTS
    return [s.persona_stem for s in _AGENTS.values() if s.persona_stem]


def _builtin_agent_names():
    from llm_core.tools.task_tool import _AGENTS
    return list(_AGENTS)


def _sandbox_persona_stems():
    """Celles dont l'enfant travaille dans le bac à sable (fs/git/shell) : ce
    sont elles qui tirent le bloc de chemins RELATIFS."""
    from llm_core.tools.task_tool import _AGENTS
    return [s.persona_stem for s in _AGENTS.values()
            if s.persona_stem and {"fs", "git", "shell"} & set(s.filter_categories or ())]


@pytest.mark.parametrize("stem", _builtin_persona_stems())
def test_persona_never_contains_the_runtime_context_tag(stem):
    """PIÈGE : ``assemble_operational_context`` saute l'injection du bloc si un
    message system porte DÉJÀ le littéral ``<runtime_context>`` (garde
    ``_already_has_ctx``, fail-open pour l'orchestrateur). Une persona qui
    *cite* la balise — même entre backticks, même pour y renvoyer — supprime
    donc le vrai bloc : l'enfant perd toute sa règle de chemins. Écrire la
    règle en clair, jamais le nom de la balise."""
    txt = (PROMPTS_DIR / f"{stem}.md").read_text(encoding="utf-8")
    assert "<runtime_context>" not in txt, stem


def test_child_head_really_carries_the_sandbox_path_rule():
    """Vérification de BOUT EN BOUT : on assemble la tête réellement envoyée à
    l'enfant (persona + <task_env> + fold) et on exige le bloc de chemins."""
    from llm_core.context.assembly import assemble_operational_context
    from llm_core.tools.task_tool import _AGENTS, _child_env_block, load_agent_persona

    spec = _AGENTS["explore"]
    sys_txt = (load_agent_persona(spec.persona_stem) + "\n\n"
               + _child_env_block(spec, 1800)).strip()
    # La surface vient des CATÉGORIES (plus d'allowlist par outil) — c'est elle
    # que le manifeste ``# Active tools`` doit annoncer à l'enfant.
    surface = sorted(_child_surface("explore"))
    assert surface, "surface d'explore vide"
    head = assemble_operational_context(
        [{"role": "system", "content": sys_txt},
         {"role": "user", "content": "go"}],
        allowed_tool_names=surface,
        username="audit",
    )[0]["content"]
    assert "PATHS — all relative" in head, "le <runtime_context> a été évincé"
    assert "# Active tools (this session)" in head
    # Le manifeste liste bien la catégorie ENTIÈRE, y compris les outils
    # d'écriture que la persona s'interdit — c'est ce qui rend l'interdit lisible.
    assert "write_file" in head and "git_commit" in head


@pytest.mark.parametrize("stem", _sandbox_persona_stems())
def test_sandbox_agent_personas_never_demand_absolute_paths(stem):
    """Les personas sandbox (fs/git) tirent le bloc de chemins RELATIFS. Une
    mention de « absolute » n'est acceptable que NIÉE (« never rewrite it into
    an absolute system path ») — jamais comme consigne.
    ``AGENT_TASK_WEB`` et FRAGMENT_AUTOMATION sont HORS périmètre : côté VM
    desktop, les chemins absolus sont la bonne réponse."""
    txt = (PROMPTS_DIR / f"{stem}.md").read_text(encoding="utf-8").lower()
    for sentence in re.split(r"(?<=[.;])\s+", txt):
        if "absolute" not in sentence:
            continue
        assert any(neg in sentence for neg in ("never", " not ", "no ")), (
            f"{stem} exige des chemins absolus : {sentence.strip()!r}"
        )


def test_tools_fragment_states_no_unfounded_batch_cap():
    txt = (PROMPTS_DIR / "FRAGMENT_TOOLS.md").read_text(encoding="utf-8")
    assert "~4 calls per batch" not in txt
    assert "serializes the mutating ones" in txt


# ── 7. La cause d'arrêt annoncée est la vraie ────────────────────────────

def test_wrapup_variants_do_not_all_blame_the_step_budget():
    from llm_core.engine.run_exit import _MAX_STEPS_WRAPUP, _WRAPUP_BY_KIND

    assert set(_WRAPUP_BY_KIND) == {"wallclock", "ctx_saturated", "gen_cap", "hard"}
    for kind, txt in _WRAPUP_BY_KIND.items():
        assert "TEXT ONLY" in txt, kind
        assert "Do not attempt any tool call." in txt, kind
        assert "step budget was NOT" in txt or "not on the step budget" in txt, kind
    assert "MAXIMUM STEPS REACHED" in _MAX_STEPS_WRAPUP


def test_compact_retry_does_not_assert_a_context_limit():
    """Le déclencheur est ``finish_reason == 'length'`` : plafond de génération
    OU fenêtre pleine. Trancher pour la seconde était une cause inventée."""
    from tests._sources import source_boucle
    src = source_boucle()
    assert "cut off by the context limit" not in src
    assert "generation hit its length limit" in src


# ── ask_user : les bornes réelles sont annoncées ET signalées ────────────

def test_ask_user_bounds_are_documented_and_reported():
    import inspect

    import llm_core.tools.skill_tools as st
    from llm_core.tools._models import AskUserResult

    src = inspect.getsource(st)
    assert "_ASK_MAX_QUESTIONS" in src and "raw[:8]" not in src
    assert "warning" in AskUserResult.model_fields


# ── Personas d'agents : la section « Your tools » dit la vérité ──────────

def _child_surface(agent) -> set:
    """Outils que l'enfant reçoit RÉELLEMENT, dérivés du registre.

    Depuis 2026-08-06 un agent reçoit ses CATÉGORIES entières (plus d'allowlist
    par outil) : la surface est l'union de ``filter_categories``, moins le deny
    dur. ``memory`` est neutralisé par ``memory_enabled=False`` côté enfant."""
    from llm_core._mcp_categories import all_tool_names, categorize
    from llm_core.tools.task_tool import _AGENTS, _DENY_BASE

    spec = _AGENTS[agent]
    cats = set(spec.filter_categories or ())
    return {t for t in all_tool_names(include_hidden=True)
            if categorize(t) in cats and t not in _DENY_BASE}


@pytest.mark.parametrize("agent", _builtin_agent_names())
def test_persona_ne_promet_aucun_outil_que_lenfant_na_pas(agent):
    """Une persona ne doit JAMAIS nommer un outil absent de la surface réelle.

    Le sens de ce test a changé avec le modèle : tant que les agents avaient une
    allowlist de 6 à 9 outils, on exigeait que la persona les nomme TOUS. Ils
    reçoivent maintenant des catégories entières (17 à 19 outils) — l'inventaire
    exhaustif, c'est le manifeste ``# Active tools`` injecté dans le MÊME message
    système, et la persona n'est plus qu'un guide.

    Le risque a donc changé de côté : une persona qui promet ``stat_path`` ou un
    outil d'une catégorie non pré-cochée envoie l'enfant sur un appel rejeté et
    lui brûle une itération. C'est ce que ce test attrape.
    """
    from llm_core._mcp_categories import all_tool_names, registry_source
    from llm_core.tools.task_tool import _AGENTS, load_agent_persona

    if registry_source() == "empty":
        pytest.skip("registre de catégories vide — surface réelle indéterminable")

    spec = _AGENTS[agent]
    txt = load_agent_persona(spec.persona_stem)
    assert txt, f"persona {spec.persona_stem} introuvable"

    surface = _child_surface(agent)
    assert surface, f"{agent} : surface vide, le test ne vérifie rien"

    # Tout nom d'outil CONNU du registre cité en `backticks` par la persona.
    known = set(all_tool_names(include_hidden=True))
    cited = {t for t in known if re.search(r"`" + re.escape(t) + r"[`(\s]", txt)}
    phantom = sorted(cited - surface)
    assert not phantom, (
        f"{spec.persona_stem} nomme {phantom}, que l'enfant NE REÇOIT PAS "
        f"(catégories {spec.filter_categories}) — chaque appel sera rejeté")


@pytest.mark.parametrize("agent", _builtin_agent_names())
def test_persona_nomme_les_outils_quelle_sinterdit(agent):
    """Les frontières ne sont plus structurelles : un agent en « lecture seule »
    DÉTIENT les outils d'écriture de sa catégorie. Sa persona doit donc les
    nommer pour les refuser — sinon elle contredit le manifeste ``# Active
    tools`` du même message, et le modèle tranche au hasard.

    On ne vérifie que les interdits que la persona s'impose déjà en prose : si
    elle écrit « READ-ONLY » ou « you do NOT commit », les outils concernés
    qu'elle possède doivent apparaître nommément.
    """
    from llm_core._mcp_categories import registry_source
    from llm_core.tools.task_tool import _AGENTS, load_agent_persona

    if registry_source() == "empty":
        pytest.skip("registre de catégories vide")

    spec = _AGENTS[agent]
    txt = load_agent_persona(spec.persona_stem)
    surface = _child_surface(agent)
    low = txt.lower()

    # (déclencheur en prose, outils que l'agent doit alors nommer)
    RULES = [
        (("read-only", "never modify a file", "never modify the code"),
         {"write_file", "edit_file", "manage_files", "git_write"}),
        (("do not commit", "do not push", "never commit"),
         {"git_commit", "git_submit"}),
    ]
    for triggers, tools in RULES:
        if not any(tr in low for tr in triggers):
            continue
        owned = tools & surface
        missing = sorted(
            t for t in owned
            if not re.search(r"`" + re.escape(t) + r"[`(\s]", txt))
        assert not missing, (
            f"{spec.persona_stem} s'interdit une capacité mais ne nomme pas "
            f"{missing}, qu'elle possède pourtant — le manifeste # Active tools "
            f"les liste, la persona doit dire explicitement de ne pas s'en servir")


# ── Le navigateur de l'agent web : partagé, pas neuf ─────────────────────

def test_web_persona_ne_promet_pas_un_navigateur_neuf():
    """La persona ``web`` annonçait « You start from a FRESH browser context:
    no shared login, no cookies from the chat ». C'est l'inverse du runtime :
    ``pw_session`` est IDEMPOTENT PAR UTILISATEUR (``owner`` = username dans
    firefox_tools) — ``start`` réutilise l'instance du compte et ouvre un
    NOUVEL ONGLET (``reused=true``), la mémoire AX peut y ré-injecter des
    identifiants enregistrés, et ``task_tool`` s'interdit explicitement tout
    teardown en fin d'enfant pour cette raison. Un agent qui se croit anonyme
    agit dans la session authentifiée de l'utilisateur sans le savoir."""
    import inspect

    import llm_core.tools.firefox_tools as ff
    from llm_core.tools.task_tool import load_agent_persona

    src = inspect.getsource(ff)
    assert "IDEMPOTENT PER USER" in src, (
        "le contrat de pw_session a changé — revérifier ce que dit la persona")

    txt = load_agent_persona("AGENT_TASK_WEB")
    low = txt.lower()
    assert "fresh browser context" not in low
    assert "no cookies from the chat" not in low
    # …et elle dit la vérité utile : instance partagée, réutilisée, à ne pas fermer.
    assert "one instance per user" in low
    assert "reuses" in low
    for op in ('action="stop"', 'action="cleanup"'):
        assert op in txt, f"la persona doit interdire pw_session {op}"
