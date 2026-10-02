# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_context_growth_regression.py — croissance du payload LLM
au fil des tours agentiques.

Bug racine « génération interrompue » (2026-07-27) : capture CUMULATIVE de la
tool_history (chaque bulle re-contenait l'historique des tours précédents)
× ré-expansion de CHAQUE bulle par la route ⇒ payload ×2 par tour (mesuré :
1, 7, 19, 43, 91, 187 messages sur 6 tours) ⇒ saturation n_ctx ⇒ chaque
génération coupée (finish=length).

Verrouille :
  • format DELTA : croissance strictement LINÉAIRE, même avec des ids de
    tool_calls IDENTIQUES d'un tour à l'autre (call_0_0… se répètent par
    construction — le marqueur delta doit interdire toute dédup) ;
  • format LEGACY (chats existants, fixtures générées avec l'ANCIENNE capture
    et l'ANCIENNE expansion) : la dédup par signatures composites ramène
    l'expansion à ~linéaire, chaque signature agentique émise UNE fois ;
  • chat mixte legacy → delta (déploiement du correctif en cours de chat).
"""
from __future__ import annotations

import json
from collections import Counter

from chatbot_app.turn.history import _expand_history_for_llm, _tool_entry_sigs

# ── Émulations de l'ANCIEN pipeline (fixtures legacy authentiques) ───────────

def _old_expand(messages):
    """Ancienne _expand_history_for_llm : expansion de CHAQUE bulle, sans
    dédup (reproduite ici pour générer des fixtures fidèles)."""
    out = []
    for m in messages:
        hist = m.get("tool_history") if m.get("role") == "assistant" else None
        if hist:
            for h in hist:
                e = {"role": h["role"]}
                if "content" in h:
                    e["content"] = h.get("content")
                if h.get("role") == "assistant" and h.get("tool_calls"):
                    e["tool_calls"] = h["tool_calls"]
                if h.get("role") == "tool" and h.get("tool_call_id"):
                    e["tool_call_id"] = h["tool_call_id"]
                out.append(e)
            if m.get("content"):
                out.append({"role": "assistant", "content": m["content"]})
        else:
            out.append({"role": m["role"], "content": m.get("content")})
    return out


def _old_capture(working):
    """Ancienne _capture_cumulative_tool_history (depuis le 1er message
    agentique, orphelin terminal retiré)."""
    first = next(
        (i for i, m in enumerate(working)
         if m.get("role") == "tool"
         or (m.get("role") == "assistant" and m.get("tool_calls"))),
        None,
    )
    if first is None:
        return []
    hist = [m for m in working[first:]
            if m.get("role") in ("assistant", "tool", "user")]
    while hist and hist[-1].get("role") == "assistant" and hist[-1].get("tool_calls"):
        hist.pop()
    return hist


def _turn_round(t, *, same_everything=False):
    """Un round d'outil du tour ``t``. ``same_everything`` reproduit le pire
    cas pour une dédup abusive : id, nom, arguments et résultat IDENTIQUES
    d'un tour à l'autre."""
    args = '{"path": "a.py"}' if same_everything else json.dumps({"path": f"f{t}.py"})
    res = '{"ok": true}' if same_everything else json.dumps({"ok": True, "turn": t})
    return [
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call_0_0", "type": "function",
            "function": {"name": "read_file", "arguments": args}}]},
        {"role": "tool", "tool_call_id": "call_0_0", "content": res},
    ]


def _build_delta_chat(n_turns, **round_kw):
    msgs = []
    for t in range(n_turns):
        msgs.append({"role": "user", "content": f"question {t}"})
        msgs.append({"role": "assistant", "content": f"réponse {t}",
                     "tool_history": _turn_round(t, **round_kw),
                     "tool_history_delta": True})
    return msgs


def _build_legacy_chat(n_turns):
    """Chat construit avec l'ANCIEN pipeline : à chaque tour, expansion
    complète (sans dédup) + capture cumulative persistée sur la bulle."""
    msgs = []
    for t in range(n_turns):
        msgs.append({"role": "user", "content": f"question {t}"})
        working = _old_expand(msgs) + _turn_round(t)
        msgs.append({"role": "assistant", "content": f"réponse {t}",
                     "tool_history": _old_capture(working)})
    return msgs


def _sizes_per_turn(msgs, expand):
    """len(payload) après chaque tour complet (préfixes de 2, 4, 6… messages)."""
    return [len(expand(msgs[:2 * k])) for k in range(1, len(msgs) // 2 + 1)]


# ── DELTA : croissance linéaire, marqueur = jamais de dédup ──────────────────

def test_delta_croissance_lineaire():
    msgs = _build_delta_chat(6)
    sizes = _sizes_per_turn(msgs, _expand_history_for_llm)
    diffs = [b - a for a, b in zip(sizes, sizes[1:])]
    # Chaque tour ajoute exactement : user + 2 entrées de round + assistant.
    assert diffs == [4] * 5, (sizes, diffs)


def test_delta_ids_identiques_jamais_dedupes():
    """Pire cas : id + nom + args + résultat identiques à CHAQUE tour (les ids
    fallback call_{iter}_{idx} se répètent réellement d'un run à l'autre).
    Le marqueur delta doit interdire la dédup — sinon des rounds réels
    disparaîtraient du payload."""
    msgs = _build_delta_chat(6, same_everything=True)
    out = _expand_history_for_llm(msgs)
    rounds = [m for m in out if m.get("role") == "assistant" and m.get("tool_calls")]
    results = [m for m in out if m.get("role") == "tool"]
    assert len(rounds) == 6 and len(results) == 6


# ── LEGACY : fixtures cumulatives → dédup, ~linéaire, signatures uniques ─────

def test_legacy_fixtures_explosent_sans_dedup():
    """Sanité des fixtures : l'ancienne expansion sur des captures cumulatives
    DOUBLE bien par tour (c'est le bug reproduit, pas le comportement visé)."""
    msgs = _build_legacy_chat(6)
    sizes = _sizes_per_turn(msgs, _old_expand)
    assert sizes[-1] > 3 * sizes[-2] / 2         # ≈ ×2 par tour (super-linéaire)
    assert sizes[-1] > 100                       # ordre de grandeur du bug mesuré


def test_legacy_dedup_ramene_a_lineaire():
    msgs = _build_legacy_chat(6)
    sizes = _sizes_per_turn(msgs, _expand_history_for_llm)
    diffs = [b - a for a, b in zip(sizes, sizes[1:])]
    # ~Linéaire : résidu borné (le texte assistant des tours passés peut
    # réapparaître une fois), jamais un doublement.
    assert max(diffs) <= 6, (sizes, diffs)
    out = _expand_history_for_llm(msgs)
    # Chaque signature agentique (round/résultat) émise EXACTEMENT une fois.
    cnt = Counter()
    for m in out:
        for s in _tool_entry_sigs(m):
            cnt[s] += 1
    assert cnt and max(cnt.values()) == 1, cnt.most_common(3)


def test_mixte_legacy_puis_delta():
    """Déploiement en cours de chat : tours legacy existants + nouveaux tours
    delta. Aucune signature dupliquée, tous les rounds présents."""
    msgs = _build_legacy_chat(4)
    for t in (4, 5):
        msgs.append({"role": "user", "content": f"question {t}"})
        msgs.append({"role": "assistant", "content": f"réponse {t}",
                     "tool_history": _turn_round(t),
                     "tool_history_delta": True})
    out = _expand_history_for_llm(msgs)
    cnt = Counter()
    for m in out:
        for s in _tool_entry_sigs(m):
            cnt[s] += 1
    assert max(cnt.values()) == 1
    # Les 6 résultats d'outils distincts sont tous là.
    tool_contents = {m.get("content") for m in out if m.get("role") == "tool"}
    assert {json.dumps({"ok": True, "turn": t}) for t in range(6)} <= tool_contents


def test_continue_fusionne_tronc_legacy_plus_delta():
    """Bulle issue d'un Continue AVANT/APRÈS déploiement : tronc legacy
    cumulatif + suffixe delta concaténés, NON marquée delta (règle de
    _merge_continue_tool_history). La dédup coupe le préfixe rejoué, garde
    le suffixe frais."""
    msgs = _build_legacy_chat(2)
    fresh = [
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call_0_0", "type": "function",
            "function": {"name": "write_file", "arguments": '{"path": "out.md"}'}}]},
        {"role": "tool", "tool_call_id": "call_0_0", "content": '{"written": true}'},
    ]
    last = msgs[-1]
    last["tool_history"] = list(last["tool_history"]) + fresh   # non marquée
    out = _expand_history_for_llm(msgs)
    cnt = Counter()
    for m in out:
        for s in _tool_entry_sigs(m):
            cnt[s] += 1
    assert max(cnt.values()) == 1
    assert any(m.get("role") == "tool" and m.get("content") == '{"written": true}'
               for m in out)
