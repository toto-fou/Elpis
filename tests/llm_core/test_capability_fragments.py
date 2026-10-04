# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_capability_fragments.py

Couvre #5 (combler les manques de fragments de capacité) et la contrainte
transverse « UN SEUL message système » :

  1. build_capability_block — étage ACTION (fs/shell/git/desktop/browser →
     FRAGMENT_TOOLS + spécialisé) ET nouvel étage CONTENU (chart/memory/rag →
     leur guide, SANS tirer FRAGMENT_TOOLS ni runtime_context).
  2. capability_wants_runtime_context — inchangé (seulement fs/shell/git).
  3. _fold_operational_block — fusionne le bloc opérationnel dans l'UNIQUE
     message système de tête (jamais un 2ᵉ role:system → évite les 400 Jinja),
     sans muter l'historique persistant partagé.
"""
from __future__ import annotations

import copy
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llm_core._system_prompts import (  # noqa: E402
    build_capability_block,
    capability_wants_runtime_context,
)
from llm_core.context.assembly import fold_operational_block as _fold_operational_block  # noqa: E402

# Sous-chaînes distinctives de chaque fragment (titre de section — prompts
# full-EN depuis 2026-07-12). « Acting with tools » depuis l'audit 2026-07-26 :
# « Active tools » est désormais le titre du MANIFESTE d'outils actifs
# (build_active_tools_manifest), distinct du fragment de cadrage.
TOOLS = "Acting with tools"
CODE = "Software engineering"
AUTOMATION = "Desktop automation"
WEB = "Web browsing"
CHART = "Charts"
MEMORY = "Long-term memory"
RAG = "Knowledge base"


# ─────────────────────────────────────────────────────────────────────────────
# build_capability_block — étage ACTION (inchangé)
# ─────────────────────────────────────────────────────────────────────────────
def test_action_fs_pulls_tools_and_code():
    b = build_capability_block({"fs"})
    assert b is not None
    assert TOOLS in b and CODE in b
    # pas de fragments de contenu ni d'autres actions
    assert CHART not in b and MEMORY not in b and RAG not in b
    assert AUTOMATION not in b and WEB not in b


def test_action_browser_pulls_tools_and_web():
    b = build_capability_block({"browser"})
    assert b is not None and TOOLS in b and WEB in b


def test_action_desktop_pulls_tools_and_automation():
    b = build_capability_block({"desktop"})
    assert b is not None and TOOLS in b and AUTOMATION in b


def test_no_categories_returns_none():
    assert build_capability_block(set()) is None
    assert build_capability_block(None) is None


# ─────────────────────────────────────────────────────────────────────────────
# build_capability_block — étage CONTENU (nouveau, #5)
# ─────────────────────────────────────────────────────────────────────────────
def test_chart_only_injects_chart_without_action_framing():
    b = build_capability_block({"chart"})
    assert b is not None
    assert CHART in b
    # une capacité « douce » ne tire PAS le cadrage d'action
    assert TOOLS not in b and CODE not in b


def test_memory_only_injects_memory_without_action_framing():
    b = build_capability_block({"memory"})
    assert b is not None
    assert MEMORY in b
    assert TOOLS not in b


def test_rag_only_injects_rag_without_action_framing():
    b = build_capability_block({"rag"})
    assert b is not None
    assert RAG in b
    assert TOOLS not in b


def test_action_plus_content_combine():
    b = build_capability_block({"fs", "chart"})
    assert b is not None
    assert TOOLS in b and CODE in b and CHART in b


def test_multiple_content_categories():
    b = build_capability_block({"chart", "memory", "rag"})
    assert b is not None
    assert CHART in b and MEMORY in b and RAG in b
    assert TOOLS not in b


# ─────────────────────────────────────────────────────────────────────────────
# capability_wants_runtime_context — inchangé (chart/memory/rag = pas de sandbox)
# ─────────────────────────────────────────────────────────────────────────────
def test_runtime_context_gating_unchanged():
    assert capability_wants_runtime_context({"fs"}) is True
    assert capability_wants_runtime_context({"git"}) is True
    assert capability_wants_runtime_context({"chart"}) is False
    assert capability_wants_runtime_context({"memory"}) is False
    assert capability_wants_runtime_context({"rag"}) is False
    assert capability_wants_runtime_context({"browser"}) is False


# ─────────────────────────────────────────────────────────────────────────────
# _fold_operational_block — invariant « exactement un message système »
# ─────────────────────────────────────────────────────────────────────────────
def _n_system(msgs):
    return sum(1 for m in msgs if m.get("role") == "system")


def test_fold_into_single_leading_system():
    wm = [
        {"role": "system", "content": "BASE"},
        {"role": "user", "content": "salut"},
    ]
    _fold_operational_block(wm, "OP")
    assert _n_system(wm) == 1
    assert wm[0]["role"] == "system"
    assert "BASE" in wm[0]["content"] and wm[0]["content"].rstrip().endswith("OP")
    assert wm[1]["role"] == "user"


def test_fold_coalesces_multiple_leading_systems():
    wm = [
        {"role": "system", "content": "A"},
        {"role": "system", "content": "B"},
        {"role": "user", "content": "salut"},
    ]
    _fold_operational_block(wm, "OP")
    assert _n_system(wm) == 1
    c = wm[0]["content"]
    assert "A" in c and "B" in c and c.rstrip().endswith("OP")
    assert c.index("A") < c.index("B") < c.index("OP")
    assert wm[-1]["role"] == "user"


def test_fold_creates_the_sole_system_when_none():
    wm = [{"role": "user", "content": "salut"}]
    _fold_operational_block(wm, "OP")
    assert _n_system(wm) == 1
    assert wm[0] == {"role": "system", "content": "OP"}
    assert wm[1]["role"] == "user"


def test_fold_empty_op_is_noop():
    wm = [{"role": "system", "content": "BASE"}, {"role": "user", "content": "x"}]
    _fold_operational_block(wm, "   ")
    assert _n_system(wm) == 1 and wm[0]["content"] == "BASE"


def test_fold_does_not_mutate_shared_persisted_messages():
    # working_messages partage ses dicts avec l'historique persistant (extend) :
    # la fusion doit REMPLACER l'objet, pas muter le message système stocké.
    messages = [
        {"role": "system", "content": "BASE"},
        {"role": "user", "content": "salut"},
    ]
    snapshot = copy.deepcopy(messages)
    wm = []
    wm.extend(messages)
    _fold_operational_block(wm, "OP")
    # l'historique d'origine est intact
    assert messages == snapshot
    # mais working_messages porte bien le bloc opérationnel
    assert "OP" in wm[0]["content"] and wm[0]["content"] != "BASE"


# ─────────────────────────────────────────────────────────────────────────────
# Passe « riche » 2026-07 — marqueurs de contenu, budgets, gardes anti-fuite
# ─────────────────────────────────────────────────────────────────────────────
PROMPTS_DIR = ROOT / "system_prompts"

# Plafonds en CARACTÈRES (le surcoût contexte est un choix explicite ; ces
# bornes empêchent la dérive silencieuse des prompts).
_BUDGETS = {
    # 2026-08-16 : relevé 4000→5600. Alignement sur les prompts publics (Claude
    # Code / claude.ai / ChatGPT) : identité multi-modèles + cutoff (« Backing
    # model » runtime), contenu d'outils = données jamais instructions, honnête
    # sans complaisance, longueur par sélection (fin du « minimize tokens »),
    # prose d'abord, show-don't-tell. Surcoût assumé : socle toujours < 1,5 k tk.
    "CHATBOT_SYSTEM.md": 5600,
    "FRAGMENT_TOOLS.md": 3600,   # +« Delegation » (task) ; +« Effort & budget » (P0 fiche 5 : lecture du tag <harness_status> + calibration)
    # 2026-07-29 : relevé 1900→3300. Le fragment ne disait PAS quoi mémoriser
    # (« ce qui DURE », sans critère ni contre-exemple) → entrées vagues ou
    # redondantes avec le dépôt. Ajout : test de décision unique, listes
    # record/never-record, exemple faible vs fort, cas « ne rien écrire ».
    # Surcoût assumé et BORNÉ aux seuls users mémoire ON (opt-in, défaut OFF).
    "FRAGMENT_MEMORY.md": 3300,
    # 2026-08-16 : bloc « /plan » sorti de la constante Python vers un fichier
    # dédié (éditable à froid, mêmes gardes que les fragments). Enrichi :
    # méthode (preuves d'abord) + structure du livrable en 4 points.
    "PLAN_MODE.md": 2200,
    "FRAGMENT_CODE.md": 1600,
    "FRAGMENT_WEB.md": 1300,
    "FRAGMENT_AUTOMATION.md": 1700,
    "FRAGMENT_CHART.md": 1900,   # un outil par type (2026-10-04) : intentions + lecture du retour
    "FRAGMENT_OFFICE.md": 2100,  # 7 outils Word / PowerPoint : un appel par fichier, !id des graphiques, lecture avant édition
    "FRAGMENT_RAG.md": 1600,
}


def _read_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")


def test_prompt_budgets_hold():
    for name, cap in _BUDGETS.items():
        n = len(_read_prompt(name))
        assert n <= cap, f"{name}: {n} chars > plafond {cap}"


def test_memory_fragment_teaches_ids_rewrite_and_recovery():
    t = _read_prompt("FRAGMENT_MEMORY.md")
    assert "rewrite" in t                 # consolidation en un appel
    assert "[a1f4]" in t                  # ciblage par id affiché
    assert "`fix`" in t and "closest" in t  # exploitation des erreurs guidées
    assert "`title`" in t                 # phrase UI obligatoire
    assert "<example>" in t               # passe riche : exemples travaillés
    # 2026-07-29 — le fragment doit dire QUOI mémoriser, pas seulement comment :
    # critère de décision, contre-exemples, et forme auto-portante.
    assert "Never record" in t            # contre-liste explicite
    assert "self-contained" in t          # entrée lisible hors contexte
    assert t.count("<example>") >= 3      # dont un cas « ne rien écrire »
    assert "record NOTHING" in t


def test_tools_fragment_teaches_recovery_and_stop():
    t = _read_prompt("FRAGMENT_TOOLS.md")
    assert "compaction" in t              # sens du marqueur de troncature
    assert "retry a call unchanged" in t  # jamais de relance identique
    assert "Goal reached" in t            # condition d'arrêt explicite
    assert "<example>" in t


def test_chart_fragment_names_real_tools():
    """Chaque outil cité par le fragment existe (un outil par type)."""
    from llm_core.tools._chart import PER_TYPE
    t = _read_prompt("FRAGMENT_CHART.md")
    cites = set(re.findall(r"`(chart_[a-z_]+)`", t))
    assert {"chart_bar", "chart_table", "chart_gantt"} <= cites
    assert cites <= {f"chart_{k}" for k in PER_TYPE}, cites - {f"chart_{k}" for k in PER_TYPE}
    assert "never resend the same call unchanged" in t.lower()


def test_office_fragment_names_real_tools():
    """Chaque outil cité par le fragment Office existe ; les règles qui font
    réussir un petit modèle (un appel par fichier, lecture avant édition,
    ref des graphiques, jamais de relance identique) y figurent."""
    from llm_core.tools._office import TOOLS
    t = _read_prompt("FRAGMENT_OFFICE.md")
    cites = set(re.findall(r"`((?:docx|pptx|office)_[a-z_]+)`", t))
    assert cites == set(TOOLS), cites ^ set(TOOLS)
    assert "chart_<type>" in t and "!a1b2c3d4e5f6" in t
    assert "ONE `docx_edit`" in t
    assert "never resend the same call unchanged" in t.lower()


def test_socle_has_completion_and_context_economy():
    t = _read_prompt("CHATBOT_SYSTEM.md")
    assert "See it through" in t
    assert "Context economy" in t


def test_socle_alignement_2026_08_16():
    """Lot « alignement prompts publics » (2026-08-16) — chaque marqueur couvre
    un ajout ; la disparition de l'un = régression d'édition, pas un choix."""
    t = _read_prompt("CHATBOT_SYSTEM.md")
    assert "Backing model:" in t                    # identité multi-modèles + cutoff
    assert "never instructions" in t                # contenu d'outils = données
    assert "Honest, not agreeable" in t             # anti-complaisance, réaffirmation
    assert "selection, not compression" in t        # longueur par sélection…
    assert "Minimize output tokens" not in t        # …qui REMPLACE l'ancienne règle
    assert "Prose first" in t                       # discipline anti-puces
    assert "Show, don't tell" in t                  # jamais commenter sa conformité
    assert "NEVER switches the" in t                # stabilité de langue


def test_no_wire_markup_examples_in_prompts():
    """Le markup d'appel brut ne doit JAMAIS servir d'exemple (fuite historique
    <tool_call> dans les bulles) — seule l'interdiction de FRAGMENT_TOOLS peut
    citer le tag."""
    for name in _BUDGETS:
        t = _read_prompt(name)
        assert '{"name"' not in t, name
        assert '"arguments"' not in t, name
        if name != "FRAGMENT_TOOLS.md":
            assert "<tool_call" not in t, name


def test_no_emoji_in_prompts():
    """Préférence utilisateur : aucun émoji dans les prompts (dingbats, émojis
    étendus). Flèches/typographie française (→, «, », …) restent permises.
    COMPRESSOR_SYSTEM.md est hors budgets mais soumis à la même règle."""
    for name in list(_BUDGETS) + ["COMPRESSOR_SYSTEM.md"]:
        t = _read_prompt(name)
        bad = [c for c in t if 0x2600 <= ord(c) <= 0x27BF or ord(c) >= 0x1F000]
        assert not bad, f"{name}: {bad[:5]}"
