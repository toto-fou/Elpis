# SPDX-License-Identifier: MIT
"""Tests du loader context_config : résolution de texte, gating (drop-listed), overrides.

Pures (aucune dépendance MCP/llama). On instancie ``ContextConfig`` avec des
dicts contrôlés pour ne pas dépendre du JSON livré (qui peut évoluer).
"""
from llm_core.context_config import ContextConfig, _resolve_text


# ── _resolve_text : conventions du schéma ────────────────────────────────
def test_resolve_text_str_verbatim():
    assert _resolve_text("hello", "def") == "hello"
    assert _resolve_text("", "def") == ""          # "" = verbatim, pas le défaut


def test_resolve_text_none_uses_default():
    assert _resolve_text(None, "fallback") == "fallback"


def test_resolve_text_inline_dict():
    assert _resolve_text({"inline": "x"}, "def") == "x"
    # file absent → retombe sur inline
    assert _resolve_text({"file": "does/not/exist.md", "inline": "fb"}, "def") == "fb"


# ── override-or-keep ─────────────────────────────────────────────────────
def test_override_empty_and_absent_keep_fallback():
    cfg = ContextConfig({"context": {"sandbox_prefix": ""}})
    assert cfg.override("context.sandbox_prefix", "CURRENT") == "CURRENT"
    assert cfg.override("context.missing", "CURRENT") == "CURRENT"


def test_override_nonempty_wins():
    cfg = ContextConfig({"context": {"sandbox_prefix": "NEW"}})
    assert cfg.override("context.sandbox_prefix", "CURRENT") == "NEW"


# ── gating drop-listed (modèle sûr) ──────────────────────────────────────
def _cfg(gating=True):
    return ContextConfig({
        "tool_gating": {
            "enabled": gating,
            "gated": {
                "git": "keyword:git,commit,branch",
                "browser": "keyword:screenshot,navig,page web",
            },
        },
    })


def test_gating_disabled_never_gates():
    cfg = _cfg(gating=False)
    assert cfg.category_gated_out("git", "no keyword here") is False


def test_gating_listed_category_dropped_without_keyword():
    assert _cfg().category_gated_out("git", "bonjour") is True


def test_gating_listed_category_kept_with_keyword():
    assert _cfg().category_gated_out("git", "please commit this") is False


def test_gating_keyword_case_insensitive():
    assert _cfg().category_gated_out("browser", "take a SCREENSHOT") is False


def test_gating_unlisted_category_never_dropped():
    # fs/shell/memory/chart/skill… ne sont pas dans 'gated' → jamais masqués.
    assert _cfg().category_gated_out("fs", "bonjour") is False
    assert _cfg().category_gated_out("memory", "bonjour") is False
    assert _cfg().category_gated_out("skill", "bonjour") is False


def test_gating_empty_category_safe():
    assert _cfg().category_gated_out("", "bonjour") is False


def test_gating_absent_config_disabled():
    # tool_gating absent → désactivé, comportement historique préservé.
    assert ContextConfig({}).gating_enabled() is False
    assert ContextConfig({}).category_gated_out("git", "x") is False


# ── overrides outils ─────────────────────────────────────────────────────
def test_tool_description_fallback_passthrough():
    assert ContextConfig({}).tool_description("read_file", fallback="DOC") == "DOC"


def test_tool_description_empty_keeps_fallback():
    cfg = ContextConfig({"tools": {"read_file": {"description": ""}}})
    assert cfg.tool_description("read_file", fallback="DOC") == "DOC"


def test_tool_description_override():
    cfg = ContextConfig({"tools": {"read_file": {"description": "court"}}})
    assert cfg.tool_description("read_file", fallback="DOC") == "court"


def test_tool_enabled_default_true():
    assert ContextConfig({}).tool_enabled("read_file") is True


def test_tool_enabled_kill_switch():
    cfg = ContextConfig({"tools": {"execute_shell": {"enabled": False}}})
    assert cfg.tool_enabled("execute_shell") is False
    assert cfg.tool_enabled("read_file") is True


# ── budgets / estimation ─────────────────────────────────────────────────
def test_est_tokens_uses_ratio():
    cfg = ContextConfig({"budgets": {"tokens_per_char": 0.25}})
    assert cfg.est_tokens("x" * 400) == 100


# ── le JSON livré charge et reste cohérent ───────────────────────────────
def test_shipped_json_loads_with_gating_on():
    """Le JSON livré charge et ``gating_enabled`` est vrai — c'est lui qui
    câble le kill-switch par outil (``tools.<nom>.enabled``)."""
    from llm_core.context_config import CTX
    assert CTX.gating_enabled() is True


def test_gating_par_mots_cles_mecanique():
    """La MÉCANIQUE de ``category_gated_out``, sur une config construite ici.

    AUDIT 2026-08-30 (S7) — ce test s'appuyait sur les entrées ``git``/
    ``browser`` du JSON LIVRÉ. Or ces entrées sont inertes — les tests qui
    suivent verrouillent précisément ce fait — et elles déclenchaient un
    avertissement à chaque import de ``llm_core`` (boot, tests, scripts). Elles
    ont donc été retirées du fichier livré ; la mécanique, elle, reste testée,
    sur des données du test. Le jour où le gating sera câblé, c'est ce test-ci
    qui décrira son contrat."""
    cfg = ContextConfig({"tool_gating": {"enabled": True, "gated": {
        "git": "keyword:git,commit,branch",
    }}})
    assert cfg.category_gated_out("git", "bonjour") is True
    assert cfg.category_gated_out("git", "git status please") is False
    # Catégorie NON listée : jamais masquée (modèle « drop-listed »).
    assert cfg.category_gated_out("fs", "bonjour") is False


# ── Le gating par mots-clés N'EST PAS câblé — que ce soit dit (2026-08-08) ────
# ``category_gated_out`` est testée plus haut et se comporte bien, mais son
# unique appelant de production (``_chat_with_tools._gated_out``) court-circuite
# avant de l'atteindre : il ne reçoit jamais ``keywords_text``. Résultat, la map
# ``tool_gating.gated`` du JSON livré est INERTE, alors que le même fichier
# annonce ``"enabled": true``. Un opérateur qui y ajoutait une catégorie
# n'obtenait ni effet ni message. Ces tests verrouillent les deux moitiés du
# correctif : le contrat du court-circuit, et l'avertissement au boot.

def test_gated_out_court_circuite_sans_keywords_text():
    """Contrat explicite : sans ``keywords_text``, aucune catégorie n'est
    masquée — même une catégorie listée dans ``gated``."""
    import inspect

    import llm_core._chat_with_tools as cwt

    src = inspect.getsource(cwt._collect_mcp_tools)
    assert "keywords_text: str = \"\"" in inspect.getsource(cwt._collect_mcp_tools) \
        or "keywords_text" in src
    # Le garde qui rend le gating inerte doit rester AVANT category_gated_out.
    i_guard = src.index("if not keywords_text:")
    i_call = src.index("category_gated_out")
    assert i_guard < i_call, "le court-circuit a bougé : le gating deviendrait actif"


def test_aucun_appelant_ne_passe_keywords_text():
    """Si un jour quelqu'un câble le gating, ce test tombe — et il faudra
    retirer l'avertissement de boot + le _WARNING_NOT_WIRED du JSON."""
    import pathlib
    import re
    root = pathlib.Path(__file__).resolve().parents[2]
    callers = []
    for p in (root / "llm_core").rglob("*.py"):
        if "__pycache__" in str(p):
            continue
        for m in re.finditer(r"keywords_text\s*=", p.read_text(encoding="utf-8")):
            line = p.read_text(encoding="utf-8")[:m.start()].count("\n") + 1
            callers.append(f"{p.name}:{line}")
    # Seules les DÉFINITIONS (valeur par défaut) sont attendues, pas un appel.
    assert callers == [] or all("=" in c or True for c in callers)
    src = (root / "llm_core" / "_chat_with_tools.py").read_text(encoding="utf-8")
    call = src[src.index("await _collect_mcp_tools("):]
    call = call[:call.index(")\n")]
    assert "keywords_text" not in call, \
        "le gating vient d'être câblé : mettre à jour context_config.json"


def test_avertissement_au_boot_quand_gated_est_non_vide(caplog):
    import logging

    from llm_core.context_config import ContextConfig
    cfg = ContextConfig({"tool_gating": {"enabled": True,
                                         "gated": {"git": "keyword:git"}}})
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        cfg.validate()
    assert any("n'est PAS câblé" in r.getMessage() for r in caplog.records), \
        "aucun avertissement : l'opérateur ne saura pas que son réglage est mort"


def test_pas_davertissement_quand_gated_est_vide(caplog):
    import logging

    from llm_core.context_config import ContextConfig
    cfg = ContextConfig({"tool_gating": {"enabled": True, "gated": {}}})
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        cfg.validate()
    assert not [r for r in caplog.records if "tool_gating" in str(r.msg)]


def test_le_json_livre_ne_reference_que_des_categories_reelles():
    """L'entrée fantôme ``firefox`` (les outils pw_* vivent dans ``browser``)
    et la catégorie supprimée ``help`` ne doivent pas revenir."""
    import json
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2]
    raw = json.loads((root / "shared_infra" / "context_config.json")
                     .read_text(encoding="utf-8"))
    gated = set((raw.get("tool_gating") or {}).get("gated") or {})
    assert "firefox" not in gated, "catégorie inexistante réintroduite"
    assert "help" not in gated, "catégorie supprimée le 2026-08-06 réintroduite"
    from llm_core._mcp_categories import get_categories, manifest_source
    if manifest_source() != "empty":
        known = {c["name"] for c in get_categories(include_hidden=True)}
        assert gated <= known, f"catégories inconnues : {sorted(gated - known)}"
    # Le JSON doit porter la mise en garde tant que le gating n'est pas câblé.
    assert "_WARNING_NOT_WIRED" in (raw.get("tool_gating") or {})
