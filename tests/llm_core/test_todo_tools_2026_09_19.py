# SPDX-License-Identifier: MIT
"""tests/llm_core/test_todo_tools_2026_09_19.py — todowrite fiable avec qwen.

Relevé réel (59 appels) : statut absent dans 19 appels (le défaut ``pending``
remettait à faire des tâches terminées), statut glissé dans ``priority`` dans 3,
liste identique renvoyée 9 fois. Cause : la grammaire llama.cpp impose les
champs FACULTATIFS dans l'ordre du schéma. Ces tests verrouillent :

- le schéma vu par le modèle : ``content`` + ``status`` obligatoires, ``status``
  énuméré, aucune clé en plus, plus de ``priority`` ;
- la validation souple : statut absent/inconnu HÉRITÉ, jamais régressé ;
- le résultat court (checklist canonique) et l'event UI qui garde la liste.
"""
from __future__ import annotations

import json

import pytest

from llm_core.tools import todo_tools
from llm_core.tools.todo_tools import build_result, _normalize


# ── Schéma vu par la grammaire ───────────────────────────────────────────────

async def test_schema_strict_pour_la_grammaire():
    from fastmcp import FastMCP
    mcp = FastMCP("t")
    todo_tools.register(mcp)
    tools = await mcp.list_tools()
    tool = next(t for t in tools if t.name == "todowrite")
    schema = tool.parameters
    item = schema["properties"]["todos"]["items"]
    # Inliné (pas de $ref) : llama.cpp le lit tel quel.
    assert item["type"] == "object"
    assert item["required"] == ["content", "status"]
    assert item["additionalProperties"] is False
    assert set(item["properties"]) == {"content", "status"}
    st = item["properties"]["status"]
    assert st["enum"] == ["pending", "in_progress", "completed", "cancelled"]
    assert "default" not in st


def test_schema_passe_le_nettoyeur_de_grammaire():
    from llm_core._mcp_wrappers import _sanitize_schema_for_grammar
    schema = todo_tools.TodoItem.model_json_schema()
    clean = _sanitize_schema_for_grammar(schema)
    assert clean["required"] == ["content", "status"]
    assert clean["additionalProperties"] is False
    assert clean["properties"]["status"]["enum"]


def test_validation_souple_malgre_le_schema_strict():
    # Connecteur sans grammaire : clé en plus et statut absent ne font pas
    # échouer la validation (ils sont traités par la normalisation).
    it = todo_tools.TodoItem.model_validate({"content": "a", "priority": "high"})
    assert it.content == "a" and it.status == ""
    assert todo_tools.TodoItem.model_validate("tâche simple").content == "tâche simple"


# ── Statut absent / cassé : hérité, jamais régressé ─────────────────────────

PREV = [
    {"content": "Créer l'arborescence", "status": "completed", "priority": "medium"},
    {"content": "Écrire le serveur", "status": "in_progress", "priority": "high"},
    {"content": "Lancer les tests", "status": "pending", "priority": "medium"},
]


def test_statut_absent_herite_de_la_liste_precedente():
    # Cas réel Qwen3.8 : tous les statuts omis au dernier appel.
    items = [{"content": t["content"]} for t in PREV]
    todos, notes = _normalize(items, PREV)
    assert [t["status"] for t in todos] == ["completed", "in_progress", "pending"]
    assert len(notes) == 3 and all("kept" in n for n in notes)


def test_statut_casse_dans_priority_nest_pas_une_regression():
    # {"content": ..., "priority": "high\", \"status\": \"completed"} : la
    # clé priority est ignorée, le statut manquant est hérité (pas « pending »).
    items = [{"content": "Créer l'arborescence",
              "priority": 'high", "status": "completed'}]
    todos, notes = _normalize(items, PREV)
    assert todos[0]["status"] == "completed"
    assert notes


def test_statut_inconnu_ou_synonyme():
    todos, notes = _normalize([{"content": "x", "status": "done"},
                               {"content": "y", "status": "IN-PROGRESS"},
                               {"content": "z", "status": "bizarre"}], [])
    assert [t["status"] for t in todos] == ["completed", "in_progress", "pending"]
    assert len(notes) == 1 and "unknown status 'bizarre'" in notes[0]


def test_heritage_par_libelle_puis_par_position():
    # Libellé reformulé, même longueur de liste → position.
    items = [{"content": "Créer l'arborescence du projet"},
             {"content": "Écrire le serveur", "status": "completed"},
             {"content": "Lancer les tests"}]
    todos, _ = _normalize(items, PREV)
    assert [t["status"] for t in todos] == ["completed", "completed", "pending"]
    # Priorité reprise de la liste précédente (affichage du panneau).
    assert todos[1]["priority"] == "high"


def test_nouveau_plan_de_meme_longueur_n_herite_de_rien():
    # Relecture 2026-09-19 : l'héritage par POSITION marquait « completed » un
    # plan entièrement nouveau envoyé sans statuts (liste soldée à tort).
    prev = [{"content": "A terminé", "status": "completed"},
            {"content": "B terminé", "status": "completed"}]
    todos, notes = _normalize(["Déployer sur la VM", "Écrire la doc"], prev)
    assert [t["status"] for t in todos] == ["pending", "pending"]
    r = build_result(["Déployer sur la VM", "Écrire la doc"], prev)
    assert r.remaining == 2 and "All tasks are closed." not in r.notes


def test_statut_null_herite_au_lieu_d_echouer():
    it = todo_tools.TodoItem.model_validate({"content": "Écrire le serveur", "status": None})
    todos, notes = _normalize([it.model_dump()], PREV)
    assert todos[0]["status"] == "in_progress" and notes


# ── Résultat court ───────────────────────────────────────────────────────────

def test_resultat_checklist_et_termine_maintenant():
    items = [{"content": "Créer l'arborescence", "status": "completed"},
             {"content": "Écrire le serveur", "status": "completed"},
             {"content": "Lancer les tests", "status": "in_progress"}]
    r = build_result(items, PREV)
    assert (r.done, r.total, r.remaining) == (2, 3, 1)
    assert r.in_progress == "Lancer les tests"
    assert r.completed_now == ["Écrire le serveur"]
    assert r.checklist.splitlines() == [
        "1. [completed] Créer l'arborescence",
        "2. [completed] Écrire le serveur",
        "3. [in_progress] Lancer les tests",
    ]
    assert r.notes == []


def test_liste_inchangee_signalee_sans_erreur():
    items = [{"content": t["content"], "status": t["status"]} for t in PREV]
    r = build_result(items, PREV)
    assert r.ok is True
    assert any("List unchanged" in n and "Écrire le serveur" in n for n in r.notes)


def test_plusieurs_en_cours_averti():
    r = build_result([{"content": "a", "status": "in_progress"},
                      {"content": "b", "status": "in_progress"}], [])
    assert any("exactly ONE" in n for n in r.notes)


def test_tout_termine():
    r = build_result([{"content": "a", "status": "completed"}], [])
    assert "All tasks are closed." in r.notes


def test_persistance_appelee_avec_la_liste_normalisee():
    seen = []
    r = build_result([{"content": "a", "status": "pending"}], [],
                     persisted_fn=lambda lst: seen.append(lst) or True)
    assert r.persisted is True and seen[0][0]["content"] == "a"


# ── Harnais : event UI complet, résultat modèle allégé ───────────────────────

async def test_execute_tool_batch_allege_le_resultat_vu_par_le_modele():
    from llm_core.engine.tool_exec import execute_tool_batch

    payload = build_result([{"content": "a", "status": "in_progress"}], []).model_dump()

    async def _exec_single(name, args, meta=None, **_cbs):
        return json.dumps(payload)

    events = []

    async def _on_event(ev):
        events.append(ev)

    async def _snap():
        pass

    results = await execute_tool_batch(
        [{"call_id": "1", "tool_name": "todowrite",
          "final_args": {"todos": [{"content": "a", "status": "in_progress"}]},
          "meta": None}],
        execute_single=_exec_single,
        record_metric=lambda *a, **k: None,
        is_tool_failure=lambda r: False,
        on_event=_on_event,
        username="u", chat_id="c1",
        on_cancel_snapshot=_snap,
        iteration=0,
    )
    ev = next(e for e in events if e.get("type") == "todo_updated")
    assert ev["todos"][0]["content"] == "a"            # le panneau garde tout
    seen = json.loads(results[0])
    assert "todos" not in seen                         # le modèle, non
    assert seen["checklist"] == "1. [in_progress] a"


@pytest.mark.parametrize("text", ["done", "Completed", "complete"])
def test_synonymes_de_termine(text):
    todos, notes = _normalize([{"content": "a", "status": text}], [])
    assert todos[0]["status"] == "completed" and not notes
