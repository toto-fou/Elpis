# SPDX-License-Identifier: MIT
"""tests/llm_core/test_prune_marks.py — élagage FIN DE TOUR à marques
persistées (harnais v4, M4, 2026-07-28). Remplace les tests des vagues par
itération (``compact_tool_results``, supprimé).

Le modèle : ``select_prune_keys`` (unités TOKENS, comptes exacts LRU)
sélectionne en fin de tour les vieilles sorties d'outils ; leurs clés
(``_prune_key``) sont persistées dans ``chats.meta_json["ctx_pruned_keys"]``
et le rendu (``_expand_history_for_llm``) remplace le contenu ENTIER par
``PRUNE_CLEARED_MARKER`` — monotone inter-tours, stockage intact.

Couvre : fenêtre protégée 20 %·n_ctx exacte (décision user), 2 derniers
tours jamais candidats, desktop récent + outils ``skill*`` protégés, gain
minimal, arrêt à la première marque (monotonie) et à la frontière d'un
résumé, rendu du marqueur à l'expansion, fusion/déduplication/cap FIFO en
meta_json.

Aucun réseau : comptes par message monkeypatchés ; DB temporaire pour le
helper meta_json.
"""
from __future__ import annotations

import copy
import json

import pytest

from llm_core.context import pruning as _pruning
from llm_core.context.pruning import (
    PRUNE_CLEARED_MARKER,
    _prune_key,
    select_prune_keys,
)
from tests.llm_core.ctx_scale_harness import (
    CTX_1M,
    CTX_256K,
    desktop_round,
    expected,
    scale_param,
    shell_round,
)


def _patch_counts(monkeypatch, per_msg_tokens: int):
    async def _counts(messages, model_id=None):
        return [per_msg_tokens] * len(messages)
    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _counts)


def _conv_tools(n_rounds: int, chars: int = 600) -> list:
    msgs = [{"role": "system", "content": "socle"},
            {"role": "user", "content": "longue tache"}]
    for i in range(n_rounds):
        msgs += shell_round(i, chars)
    return msgs


# ── Sélection : fenêtre 20 %·n_ctx, bord exact ─────────────────────────────

@scale_param
async def test_selection_protect_20_pourcent_exacte(ctx, monkeypatch):
    """Fenêtre protégée = 20 % du n_ctx TOTAL (décision user 2026-07-28) :
    à 10 000 tokens par sortie, exactement ⌊protect/10 000⌋ sorties récentes
    restent pleines parmi les candidates — le reste est marqué."""
    E = expected(ctx)
    tok = 10_000
    _patch_counts(monkeypatch, tok)
    n_rounds = {CTX_256K: 20, CTX_1M: 40}[ctx]
    msgs = _conv_tools(n_rounds)
    snapshot = copy.deepcopy(msgs)

    keys = await select_prune_keys(msgs, ctx_size=ctx)
    assert msgs == snapshot, "sélection pure — jamais de mutation"

    # Candidats = tout sauf les 2 derniers tours ; protégés = fenêtre tokens.
    n_candidates = n_rounds - 2
    n_protected = E["prune_protect_tokens"] // tok
    want = {f"c{i}" for i in range(n_candidates - n_protected)}
    got = set()
    for m in msgs:
        if m.get("role") == "tool" and _prune_key(m) in set(keys):
            got.add(m["tool_call_id"])
    assert got == want, (got, n_candidates, n_protected)
    # Gain de la passe ≥ min_tokens par construction (sanity).
    assert len(keys) * tok >= E["prune_min_tokens"]


async def test_deux_derniers_tours_jamais_candidats(monkeypatch):
    _patch_counts(monkeypatch, 50_000)   # énormes → tout serait pris sinon
    msgs = _conv_tools(6)
    keys = set(await select_prune_keys(msgs, ctx_size=32_768))
    marked = {m["tool_call_id"] for m in msgs
              if m.get("role") == "tool" and _prune_key(m) in keys}
    assert "c5" not in marked and "c4" not in marked, \
        "les sorties des 2 derniers tours ne sont jamais candidates"
    assert marked, "les tours plus anciens, eux, sont marqués"


async def test_desktop_recent_et_skill_proteges(monkeypatch):
    _patch_counts(monkeypatch, 50_000)
    msgs = [{"role": "system", "content": "socle"},
            {"role": "user", "content": "go"}]
    msgs += shell_round(0, 600)
    # Sortie d'un outil skill_* (protégée quel que soit son âge).
    msgs += [{"role": "assistant", "content": None,
              "tool_calls": [{"id": "sk1", "type": "function",
                              "function": {"name": "skill_load",
                                           "arguments": "{}"}}]},
             {"role": "tool", "tool_call_id": "sk1",
              "content": "instructions du skill " + "s" * 400}]
    msgs += desktop_round(1)          # perception desktop LA plus récente
    for i in range(2, 8):
        msgs += shell_round(i, 600)

    keys = set(await select_prune_keys(msgs, ctx_size=32_768))
    marked = {m["tool_call_id"] for m in msgs
              if m.get("role") == "tool" and _prune_key(m) in keys}
    assert "sk1" not in marked, "sorties skill* jamais élaguées (contrat skills)"
    assert "c1" not in marked, "la perception desktop la plus récente est protégée"
    assert "c0" in marked, "les voisins non protégés partent, eux"


async def test_min_tokens_refuse_les_miettes(monkeypatch):
    _patch_counts(monkeypatch, 100)   # candidats minuscules
    msgs = _conv_tools(10)
    keys = await select_prune_keys(msgs, ctx_size=262_144)
    assert keys == [], "gain < min_tokens → on n'invalide pas le KV pour rien"


async def test_stop_a_la_premiere_marque_monotonie(monkeypatch):
    """Le parcours arrière s'arrête à la première sortie DÉJÀ rendue comme
    marqueur : tout ce qui est plus ancien est déjà marqué (monotonie) —
    aucune re-sélection en amont."""
    _patch_counts(monkeypatch, 50_000)
    msgs = _conv_tools(10)
    # c3 arrive déjà RENDUE comme marqueur (tour précédent).
    for m in msgs:
        if m.get("role") == "tool" and m.get("tool_call_id") == "c3":
            m["content"] = PRUNE_CLEARED_MARKER
    keys = set(await select_prune_keys(msgs, ctx_size=32_768))
    marked = {m["tool_call_id"] for m in msgs
              if m.get("role") == "tool" and _prune_key(m) in keys}
    assert all(cid not in marked for cid in ("c0", "c1", "c2", "c3")), \
        "rien n'est re-sélectionné en amont d'une marque existante"
    assert marked <= {"c4", "c5", "c6", "c7"}


async def test_frontiere_resume_de_compaction(monkeypatch):
    """Les sorties antérieures au dernier résumé de compaction sont déjà
    couvertes par lui — jamais candidates."""
    _patch_counts(monkeypatch, 50_000)
    msgs = _conv_tools(3)
    msgs.append({"role": "system",
                 "content": "[COMPRESSED_SUMMARY_V1]\nresume\n[/COMPRESSED_SUMMARY_V1]"})
    for i in range(3, 9):
        msgs += shell_round(i, 600)
    keys = set(await select_prune_keys(msgs, ctx_size=32_768))
    marked = {m["tool_call_id"] for m in msgs
              if m.get("role") == "tool" and _prune_key(m) in keys}
    assert all(cid not in marked for cid in ("c0", "c1", "c2")), \
        "avant la frontière du résumé : couvert, jamais re-marqué"
    assert marked, "après la frontière, la sélection opère normalement"


# ── Rendu : marqueur plein à l'expansion, stockage intact ──────────────────

def test_rendu_expansion_marqueur_plein():
    from chatbot_app.routes.chats import _expand_history_for_llm

    full_content = "resultat volumineux " + "x" * 500
    bubble = {
        "role": "assistant", "content": "fin du tour",
        "tool_history_delta": True,
        "tool_history": [
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "d1", "type": "function",
                 "function": {"name": "execute_shell", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "d1", "content": full_content},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "d2", "type": "function",
                 "function": {"name": "execute_shell", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "d2", "content": "recent " * 40},
        ],
    }
    key = _prune_key(bubble["tool_history"][1])
    ui = [{"role": "user", "content": "go"}, bubble]

    out = _expand_history_for_llm(ui, pruned_keys={key})
    tools = [m for m in out if m["role"] == "tool"]
    assert tools[0]["content"] == PRUNE_CLEARED_MARKER, \
        "la sortie marquée est rendue comme marqueur PLEIN"
    assert tools[1]["content"].startswith("recent"), "les autres restent pleines"
    # STOCKAGE intact : la bulle n'est jamais mutée.
    assert bubble["tool_history"][1]["content"] == full_content

    # Sans clés → rendu historique inchangé.
    out2 = _expand_history_for_llm(ui)
    assert [m for m in out2 if m["role"] == "tool"][0]["content"] == full_content


# ── Persistance meta_json : fusion, dédup, cap FIFO ────────────────────────

def test_meta_json_fusion_dedup_cap(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    uid = create_user("alice", "pw-alice")
    from shared_infra.chat.store import add_chat_pruned_keys, get_chat, upsert_chat
    upsert_chat(uid, "chat1", "t", [{"role": "user", "content": "x"}], 1.0)

    assert add_chat_pruned_keys(uid, "chat1", ["k1", "k2"]) is True
    assert add_chat_pruned_keys(uid, "chat1", ["k2", "k3"]) is True   # dédup
    assert get_chat(uid, "chat1")["ctx_pruned_keys"] == ["k1", "k2", "k3"]

    # Cap FIFO : les plus VIEILLES clés sortent (leurs tours finissent de
    # toute façon couverts par un résumé de compaction).
    add_chat_pruned_keys(uid, "chat1", [f"n{i}" for i in range(6)], cap=5)
    assert get_chat(uid, "chat1")["ctx_pruned_keys"] == \
        ["n1", "n2", "n3", "n4", "n5"]

    assert add_chat_pruned_keys(uid, "inconnu", ["k"]) is False
