# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_vague5_2026_08_23.py — vague 5 des constats confirmés
(bureau + balayage du code mort).

Constats traités : 7, 14, 25, 34, 40, 48, 56, 61, 62, 63, 65.

Les tests de code mort ne prouvent pas un comportement : ils empêchent la
RÉINTRODUCTION. C'est leur seul rôle, et il est réel — trois des symboles
retirés ici étaient des doublons PÉRIMÉS dont le nom, plus simple que celui du
remplaçant vivant, invitait à les rebrancher.
"""
from __future__ import annotations

import ast
import functools
import inspect
import pathlib
import subprocess

import pytest

_RACINE = pathlib.Path(__file__).resolve().parents[2]


# Périmètre : le CODE DU DÉPÔT. Ni ``venv`` (fastmcp expose son propre
# ``get_tool_catalog``), ni ``docs`` (les rapports d'audit nomment forcément
# les symboles retirés), ni les caches.
_PERIMETRE = ("llm_core", "shared_infra", "chatbot_app", "rag_app", "server",
              "tests", "frontend")


@functools.lru_cache(maxsize=1)
def _index_des_noms() -> dict:
    """{symbole → [emplacements]} pour TOUT le dépôt, construit UNE fois.

    Ne compte que les usages RÉELS (Name / Attribute / import) : ni les
    chaînes, ni les commentaires, ni les docstrings — sans quoi la note qui
    EXPLIQUE une suppression déclencherait le test qu'elle documente."""
    idx: dict = {}
    for racine in _PERIMETRE:
        for f in (_RACINE / racine).rglob("*.py"):
            if "__pycache__" in f.parts:
                continue
            try:
                arbre = ast.parse(f.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, SyntaxError):
                continue
            for n in ast.walk(arbre):
                nom = None
                if isinstance(n, ast.Name):
                    nom = n.id
                elif isinstance(n, ast.Attribute):
                    nom = n.attr
                elif isinstance(n, ast.alias):
                    nom = n.name
                if nom:
                    idx.setdefault(nom, []).append(
                        f"{f.relative_to(_RACINE)}:{getattr(n, 'lineno', '?')}")
    return idx


def _occurrences(symbole: str) -> list:
    return _index_des_noms().get(symbole, [])


# ── 62. desktop_screenshot ne lève plus NameError ─────────────────────────

def test_desktop_screenshot_na_plus_de_variable_libre():
    """``username`` n'était ni paramètre, ni local, ni global : Python le
    résolvait en global à l'exécution et levait NameError — APRÈS ``_grab()``,
    donc la capture était prise sur la VM puis perdue. L'outil était
    inutilisable à 100 % dès qu'on l'exposait."""
    from llm_core.tools import desktop_tools as D
    arbre = ast.parse(pathlib.Path(D.__file__).read_text(encoding="utf-8"))
    fn = next(n for n in ast.walk(arbre)
              if isinstance(n, ast.FunctionDef) and n.name == "screenshot")
    lus = {n.id for n in ast.walk(fn)
           if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    assert "username" not in lus, "``username`` est de nouveau lu sans exister"
    ecrits = {n.id for n in ast.walk(fn)
              if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    assert "_username" in ecrits


def test_lautre_outil_brut_du_meme_bloc_est_sain():
    """``inspect`` partage la garde d'exposition : on vérifie qu'il n'a pas
    le même vice."""
    from llm_core.tools import desktop_tools as D
    arbre = ast.parse(pathlib.Path(D.__file__).read_text(encoding="utf-8"))
    for nom in ("screenshot", "inspect"):
        fn = next((n for n in ast.walk(arbre)
                   if isinstance(n, ast.FunctionDef) and n.name == nom), None)
        if fn is None:
            continue
        args = {a.arg for a in fn.args.args}
        ecrits = {n.id for n in ast.walk(fn)
                  if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
        lus = {n.id for n in ast.walk(fn)
               if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
        libres = ({"username"} & lus) - args - ecrits
        assert not libres, f"{nom} : variables libres {libres}"


# ── 63. Un échec de sonde n'est jamais un verdict ────────────────────────

def _err_agent():
    return {"ok": False, "error": "agent_unreachable",
            "message": "la VM ne répond pas", "retryable": False}


@pytest.fixture
def _sonde_ko(monkeypatch):
    from llm_core import _desktop_replay as R
    appels = {"n": 0}

    def _probe(username, target, **kw):
        appels["n"] += 1
        return _err_agent()

    monkeypatch.setattr(R, "probe_tree_core", _probe)
    monkeypatch.setattr(R, "resolve_element", lambda *a, **k: None)
    monkeypatch.setattr(R, "_self_heal_allow", lambda t: False)
    monkeypatch.setattr(R, "_sleep_ms", lambda ms: None)
    return R, appels


def test_element_gone_ne_se_declare_pas_satisfait_sur_une_sonde_ko(_sonde_ko):
    """LE constat : ``found == present`` comparait ``False == False`` et
    rendait « satisfait » au PREMIER tour, en 0 ms. Le pas suivant du scénario
    cliquait aux coordonnées d'une boîte de dialogue toujours à l'écran."""
    R, _ = _sonde_ko
    ok, _ms = R.wait_element("alice", "vm1", "Enregistrement en cours",
                             present=False, timeout_ms=120, poll_ms=10)
    assert ok is False, (
        "un agent injoignable est encore lu comme une preuve de disparition")


def test_le_cas_present_true_reste_inchange(_sonde_ko):
    R, _ = _sonde_ko
    ok, _ms = R.wait_element("alice", "vm1", "Bouton", present=True,
                             timeout_ms=120, poll_ms=10)
    assert ok is False


def test_wait_value_a_la_meme_garde(_sonde_ko, monkeypatch):
    R, _ = _sonde_ko
    monkeypatch.setattr(R, "_read_element_value", lambda *a, **k: "")
    ok, _ms = R.wait_value("alice", "vm1", "Champ", "attendu", present=False,
                           timeout_ms=120, poll_ms=10)
    assert ok is False


def test_wait_count_ne_compte_pas_zero_sur_une_sonde_ko(_sonde_ko):
    """Il rendait ``cnt=0`` et satisfaisait donc tout « <= N »."""
    R, _ = _sonde_ko
    ok, _ms = R.wait_count("alice", "vm1", "", "row", "<=", 3,
                           timeout_ms=120, poll_ms=10)
    assert ok is False


def test_les_quatre_attentes_partagent_la_meme_garde():
    from llm_core import _desktop_replay as R
    for nom in ("wait_element", "wait_value", "wait_state", "wait_count"):
        src = inspect.getsource(getattr(R, nom))
        assert "_sonde_ok(" in src, f"{nom} n'a pas la garde"


# ── 7. Le sérialiseur PARTAGÉ existe pour de bon ─────────────────────────

def test_limport_mort_a_disparu():
    from llm_core import _llama_http as H
    src = "\n".join(l for l in inspect.getsource(H).splitlines()
                    if not l.strip().startswith("#"))
    assert "_chat_with_tools import _message_text_for_tokenize" not in src, (
        "l'import d'un symbole INEXISTANT est de retour : le branchement "
        "primaire serait de nouveau inatteignable")


def test_la_recette_est_bien_partagee():
    """Ce que les docstrings promettaient depuis le début."""
    from llm_core import _llama_http as H
    from llm_core.context.tokens import message_text_for_tokenize
    assert "message_text_for_tokenize" in inspect.getsource(
        H.count_tokens_for_messages)
    m = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "c0", "type": "function",
        "function": {"name": "write_file", "arguments": '{"a":1}'}}]}
    txt = message_text_for_tokenize(m)
    assert "write_file" in txt and '{"a":1}' in txt


# ── Code mort : 14, 25, 34, 40, 48, 56, 61, 65 ──────────────────────────

@pytest.mark.parametrize("symbole", [
    # 14 — réflexion / splitter
    "annotate_thinking_tokens",
    # 25 — _chat_classic
    "run_chat_with_forced_tool", "run_chat_with_open_tools",
    "_build_forced_tool_metrics", "_default_stops",
    "_DEFAULT_STOP_SEQUENCES_TUPLE",
    # 34 — registre de catégories
    "get_tool_catalog",
    # 48 — git_tools
    "_build_compare_url", "_open_pr_github", "_open_pr_gitlab",
    "_load_git_credentials", "_basic_auth_header", "_http_json",
    "GIT_CREDENTIALS_FILE",
    # 56 — skills
    "_find_global_file", "_find_learned_file", "_remove_slug_copies",
    "find_user_skill", "save_user_skill_from_md", "build_skill_tree",
    # 61 — pont d'exécution / toolkit
    "_NoToolsExecutorConfigured", "set_heartbeat_hook", "_HEARTBEAT_HOOK",
    "clip_lines", "LINES_BUDGET",
    # 65 — bureau
    "unregister_desktop_frame_owner",
])
def test_le_symbole_mort_nest_pas_revenu(symbole):
    trouves = _occurrences(symbole)
    assert not trouves, f"{symbole} est de retour : {trouves[:5]}"


def test_le_module_fairshare_a_disparu():
    """168 lignes + 24 tests verts sur du code que RIEN n'exécutait — une
    couverture qui masquait le constat au lieu de l'infirmer. Sa clé de
    configuration entrait en plus en collision avec ``llm.scheduling_mode``,
    dont le domaine de valeurs est incompatible."""
    assert not (_RACINE / "llm_core/_scheduling/_fairshare.py").exists()
    assert not (_RACINE / "tests/llm_core/test_fairshare.py").exists()
    assert not _occurrences("FairShareScheduler")


def test_les_modules_touches_simportent_toujours():
    """Filet : une suppression trop large casse à l'import, pas au test."""
    import importlib
    for m in ("llm_core._chat_classic", "llm_core.skills",
              "llm_core._mcp_categories", "llm_core.tools.git_tools",
              "llm_core.tools._exec_bridge", "llm_core.tools._toolkit",
              "llm_core._think_tokens", "llm_core._stream_tag_parser",
              "llm_core._desktop_session", "llm_core._llama_http"):
        importlib.import_module(m)


def test_le_parametre_mort_du_repli_de_reprise_a_disparu():
    from llm_core import _chat_with_tools as W
    sig = inspect.signature(W._resume_cut_stream)
    assert "tag_splitter" not in sig.parameters, (
        "le paramètre était transmis mais jamais utilisé : la fonction crée "
        "son propre splitter (correct — le rejeu repart de l'octet 0)")


def test_le_commentaire_perime_sur_start_in_think_a_disparu():
    from llm_core import _chat_with_tools as W
    # Commentaires retirés : la note qui EXPLIQUE le retrait cite la phrase.
    src = "\n".join(l for l in inspect.getsource(W).splitlines()
                    if not l.strip().startswith("#"))
    assert "ThinkTagSplitter(start_in_think=True)" not in src, (
        "le commentaire affirme de nouveau que la continuation est routée en "
        "raisonnement — c'est faux depuis le changement de repli de reprise")


# ── 25 (suite). Le réglage inerte est enfin ANNONCÉ comme tel ───────────

def test_le_reglage_stop_nest_plus_annonce_cable():
    import json
    d = json.loads((_RACINE / "shared_infra/context_config.json")
                   .read_text(encoding="utf-8"))

    def _listes(n):
        if isinstance(n, dict):
            for k, v in n.items():
                if k == "wired" and isinstance(v, list):
                    yield v
                yield from _listes(v)
        elif isinstance(n, list):
            for v in n:
                yield from _listes(v)

    for lst in _listes(d):
        assert "model_profiles.stop" not in lst, (
            "le fichier annonce encore ce réglage « câblé » alors qu'aucune "
            "requête n'emporte de stop sequence")
    note = (d.get("model_profiles", {}).get("default", {}) or {}).get("_comment", "")
    assert "INERTE" in note


# ── Bilan mesurable du balayage ─────────────────────────────────────────

def test_le_fichier_chat_classic_a_bien_maigri():
    """~550 lignes retirées sur 1 533 (36 %) — relues à chaque audit et
    considérées comme du contrat vivant."""
    n = len((_RACINE / "llm_core/_chat_classic.py")
            .read_text(encoding="utf-8").splitlines())
    assert n < 1100, f"{n} lignes — le code mort est revenu ?"
