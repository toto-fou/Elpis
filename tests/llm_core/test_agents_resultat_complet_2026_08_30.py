# SPDX-License-Identifier: MIT
"""Agents : résultat complet, budgets relevés, budget propre aux customs
(2026-08-30).

Le grief de départ : « les affichages dans la modale sont tronqués, alors
qu'il serait mieux de pouvoir voir les résultats complets d'un agent ».

L'asymétrie mesurée : ``_render_result`` renvoyait le texte final ENTIER au
modèle parent, tandis que l'humain n'en voyait que le reflet coupé à 1500 c
dans le déroulé — et ce texte complet n'était persisté NULLE PART. D'où le
champ ``result``, borné seulement par un garde-fou anti-mégaoctets.
"""
import re
from pathlib import Path

import pytest

from chatbot_app.routes.chats import _task_runs_for_persist
from llm_core._constants import (
    TASK_MAX_ITERS_CUSTOM,
    TASK_MAX_ITERS_EXPLORE,
    TASK_MAX_ITERS_IMPLEMENT,
    TASK_MAX_ITERS_PR,
    TASK_MAX_ITERS_VERIFY,
    TASK_MAX_ITERS_WEB,
    TASK_RESULT_PERSIST_CAP,
)
from llm_core.tools.task_tool import (
    _AGENTS,
    CUSTOM_AGENTS_MAX,
    CUSTOM_ITERS_MAX,
    _norm_max_iters,
    _specs_from_custom,
    validate_custom_agents,
)
from tests.llm_core.test_task_tool import FakeRunner, _factory

ROOT = Path(__file__).resolve().parents[2]


# ── Le résultat final, en entier ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_le_record_porte_le_resultat_final_entier(monkeypatch):
    # 5 000 c : bien au-delà des 1500 c auxquels le DÉROULÉ coupe la narration.
    long_result = "Rapport d'analyse.\n" + ("ligne de conclusion. " * 250)
    assert len(long_result) > 1500
    sink = {}
    handler, _ = _factory(monkeypatch, FakeRunner(final_text=long_result),
                          usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    run = sink["runs"][0]
    assert run["result"] == long_result, "le résultat doit être intégral"


@pytest.mark.asyncio
async def test_le_resultat_survit_a_la_persistance(monkeypatch):
    # ``_task_runs_for_persist`` ne strippe que ``tools`` : sans ce test, un
    # ajout futur à sa liste noire ferait disparaître le résultat au reload
    # sans que rien ne le signale.
    sink = {}
    handler, _ = _factory(monkeypatch, FakeRunner(final_text="mon rapport"),
                          usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    persisted = _task_runs_for_persist(sink["runs"])
    assert persisted[0]["result"] == "mon rapport"
    assert "tools" not in persisted[0]


@pytest.mark.asyncio
async def test_garde_fou_anti_megaoctets(monkeypatch):
    # Ce n'est PAS un affichage tronqué : c'est la borne qui empêche un enfant
    # pathologique de gonfler meta_json. Un rapport réel pèse quelques Ko.
    enorme = "x" * (TASK_RESULT_PERSIST_CAP + 5000)
    sink = {}
    handler, _ = _factory(monkeypatch, FakeRunner(final_text=enorme), usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert len(sink["runs"][0]["result"]) == TASK_RESULT_PERSIST_CAP


@pytest.mark.asyncio
async def test_run_annule_sans_resultat_ne_casse_rien(monkeypatch):
    # Le record est aussi poussé sur les chemins d'échec, où ``final_text``
    # vaut "" : la clé doit exister et être vide, pas manquer.
    sink = {}
    handler, _ = _factory(monkeypatch, FakeRunner(final_text=""), usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert sink["runs"][0]["result"] == ""


@pytest.mark.asyncio
async def test_levent_final_live_porte_le_resultat(monkeypatch):
    """Sans ``result`` dans le task_step final, le bloc n'apparaîtrait
    qu'après un RECHARGEMENT (seul le record persisté le porte) — soit
    exactement le symptôme que le correctif supprime."""
    vus = []

    async def _on_event(ev):
        vus.append(ev)

    long_result = "Conclusion.\n" + ("détail. " * 300)
    handler, _ = _factory(monkeypatch, FakeRunner(final_text=long_result),
                          on_event=_on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    finals = [e for e in vus
              if e.get("type") == "task_step" and e.get("status") == "final"]
    assert finals, "aucun task_step final émis"
    assert finals[-1]["result"] == long_result


def test_le_front_pose_le_resultat_sur_le_run():
    js = (ROOT / "frontend" / "js" / "app-chat.js").read_text(encoding="utf-8")
    assert "run.result = data.result;" in js


def test_la_modale_affiche_le_resultat_en_entier():
    html = (ROOT / "frontend" / "includes" / "modals"
            / "task_transcript.html").read_text(encoding="utf-8")
    assert 'data-task-result' in html
    # Rendu tel quel, sans slice ni line-clamp : c'est tout l'objet du bloc.
    bloc = html[html.index("data-task-result"):]
    bloc = bloc[:bloc.index("</div>", bloc.index("renderMarkdown(run.result)"))]
    assert "renderMarkdown(run.result)" in bloc
    assert "line-clamp" not in bloc and "slice(" not in bloc


# ── Budgets d'itérations relevés ──────────────────────────────────────────

@pytest.mark.parametrize("valeur, plancher, agent", [
    (TASK_MAX_ITERS_EXPLORE, 60, "explore"),
    (TASK_MAX_ITERS_IMPLEMENT, 100, "implement"),
    (TASK_MAX_ITERS_VERIFY, 60, "verify"),
    (TASK_MAX_ITERS_WEB, 60, "web"),
    (TASK_MAX_ITERS_PR, 40, "pr"),
    (TASK_MAX_ITERS_CUSTOM, 80, None),
])
def test_les_budgets_ont_ete_releves(valeur, plancher, agent):
    # Les enfants s'arrêtaient à un geste près et rendaient « je n'ai pas pu
    # terminer » ; le harnais PARENT, lui, tourne à 200 itérations.
    assert valeur >= plancher
    if agent:
        assert _AGENTS[agent].max_iters == valeur


def test_les_budgets_du_panneau_viennent_du_roster():
    # Doublon assumé avec test_child_tool_surface : ce fichier documente le
    # relèvement, et un budget périmé ment à l'utilisateur. Depuis la banque
    # d'agents (2026-09-11) le panneau ne code plus rien en dur : il lit
    # ``agent_templates()`` — c'est donc CE contrat qui doit suivre le roster.
    from llm_core.tools.task_tool import agent_templates
    budgets = {t["name"]: t["max_iters"] for t in agent_templates()}
    for name, spec in _AGENTS.items():
        assert budgets[name] == spec.max_iters, f"budget « {name} » périmé"
    html = (ROOT / "frontend" / "includes" / "modals"
            / "settings.html").read_text(encoding="utf-8")
    assert not re.search(r"— \d+ itérations\"", html), \
        "budget d'un intégré codé en dur dans le panneau : il dérivera"


# ── Budget propre à un agent custom ───────────────────────────────────────

def test_un_agent_custom_peut_porter_son_budget():
    out = validate_custom_agents([
        {"name": "audit", "prompt": "x", "tool_categories": ["fs"], "max_iters": 150}])
    assert out[0]["max_iters"] == 150
    assert _specs_from_custom(out)["audit"].max_iters == 150


def test_budget_absent_suit_le_defaut_et_ses_relevements():
    # La clé n'est PAS écrite quand l'agent n'en fixe pas : l'agent bénéficie
    # ainsi d'un relèvement futur du défaut sans être ré-enregistré.
    out = validate_custom_agents([
        {"name": "audit", "prompt": "x", "tool_categories": ["fs"]}])
    assert "max_iters" not in out[0]
    assert _specs_from_custom(out)["audit"].max_iters == TASK_MAX_ITERS_CUSTOM


@pytest.mark.parametrize("brut, attendu", [
    (99999, CUSTOM_ITERS_MAX),   # hors borne → clampé, pas refusé
    ("abc", None), (None, None), ("", None), (0, None), (-5, None),
    ("42", 42),                  # blob importé : chaîne numérique tolérée
])
def test_budget_hors_norme_clampe_ou_ignore_jamais_ne_refuse(brut, attendu):
    # Refuser ferait échouer le PUT sur le blob ENTIER — plus aucun réglage
    # enregistrable, sans issue par l'UI (même piège que _free_agent_name).
    assert _norm_max_iters(brut) == attendu


def test_le_catalogue_dagents_custom_a_ete_elargi():
    assert CUSTOM_AGENTS_MAX >= 30


def test_le_formulaire_expose_le_budget():
    html = (ROOT / "frontend" / "includes" / "modals"
            / "settings.html").read_text(encoding="utf-8")
    assert 'v-model="agentForm.max_iters"' in html
    js = (ROOT / "frontend" / "js" / "app-settings.js").read_text(encoding="utf-8")
    # Miroirs du serveur : une dérive silencieuse re-brident l'UI.
    assert f"const CUSTOM_AGENTS_MAX = {CUSTOM_AGENTS_MAX};" in js
    assert f"const CUSTOM_ITERS_MAX = {CUSTOM_ITERS_MAX};" in js
    # Exposé au template, sinon `:max` est undefined au rendu.
    assert re.search(r"return \{[\s\S]*CUSTOM_ITERS_MAX,", js)
