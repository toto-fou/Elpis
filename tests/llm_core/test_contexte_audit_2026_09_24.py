# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_contexte_audit_2026_09_24.py — gestion de contexte,
audit du cœur du harnais du 2026-09-24.

Un test de non-régression par constat corrigé :
  n° 8  — budget dur : retrait par groupes atomiques (assistant + ses tools) ;
  n° 16 — un ``user`` ouvre toujours la conversation (budget dur, filet
          sanitize, compaction partielle) sans fausser ``covered_turns`` ;
  n° 3  — entrée du résumeur bornée en TOTAL ;
  tokens : CJK pondéré (4), repli par message au ratio du modèle (5),
           ratio non pollué par les images (6) ;
  sanitize : appels sans id appariés, appels sans réponse retirés (7).
"""
from __future__ import annotations

import pytest

import llm_core.context.pruning as _pruning
import llm_core.context.tokens as tok
from llm_core.context.pruning import (
    enforce_context_budget,
    sanitize_message_history,
)
from llm_core.context.compression.serializer import (
    compute_serializer_total_budget_tokens,
    serialize_for_compression,
)
from llm_core.conversation_compressor import (
    ConversationCompressor,
    _count_turns,
    _pin_task_anchor,
)


def _tc(cid, name="read_file"):
    tc = {"type": "function", "function": {"name": name, "arguments": "{}"}}
    if cid is not None:
        tc["id"] = cid
    return tc


def _overhead_for_budget(budget, ctx=100_000):
    """Surcoût fixe qui ramène le budget du fit à ``budget`` (réserve de
    génération réelle, cap de génération nul)."""
    return ctx - _pruning.BUDGET.reserve_tokens(ctx, 0) - budget


def _first_non_system(msgs):
    return next(m for m in msgs if m.get("role") != "system")


# ─────────────────────────────────────────────────────────────────────────────
#  n° 8 — budget dur : jamais un assistant retiré sans ses tool_results
# ─────────────────────────────────────────────────────────────────────────────
def _batch_history():
    """sys, u0, a0, u1 (ancre), assistant(8 appels parallèles), 8 tools.

    13 messages → queue protégée = 6 → ``keep_tail_from`` = 7 : la queue
    commence au 3ᵉ résultat du lot, l'assistant (indice 4) et les deux
    premiers résultats sont AVANT elle."""
    msgs = [{"role": "system", "content": "SYS"},
            {"role": "user", "content": "vieille question"},
            {"role": "assistant", "content": "vieille réponse"},
            {"role": "user", "content": "lis ces huit fichiers"},
            {"role": "assistant", "content": None,
             "tool_calls": [_tc(f"c{i}") for i in range(8)]}]
    msgs += [{"role": "tool", "tool_call_id": f"c{i}", "content": f"obs {i}"}
             for i in range(8)]
    return msgs


async def test_budget_dur_ne_separe_pas_un_lot_parallele_de_son_assistant(monkeypatch):
    msgs = _batch_history()
    assert _pruning.effective_keep_recent(len(msgs)) == 6   # prémisse

    async def _counts(messages, model_id=None):
        return [2_000] * len(messages)

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _counts)
    stats: dict = {}
    # 26 000 tk pour un budget de 20 000 : seuls u0 + a0 (4 000) sont
    # retirables — le lot déborde dans la queue, il reste entier.
    out = await enforce_context_budget(
        msgs, 100_000, model_id="m", gen_cap_tokens=0, stats_out=stats,
        fixed_overhead_tokens=_overhead_for_budget(20_000))
    tools_out = [m for m in out if m.get("role") == "tool"]
    assert len(tools_out) == 8, (
        "des observations de la queue protégée ont disparu : l'assistant du "
        "lot a été retiré et sanitize les a jetées comme orphelines")
    assert any(m.get("tool_calls") for m in out)
    # Le seul retirable (u0 + a0) ne suffit pas : c'est dit à l'appelant, avec
    # un total qui ne compte plus ce qui est parti.
    assert stats.get("over_reason") == "tail_too_heavy"
    assert stats["estimated"] == 2_000 * (len(msgs) - 2)


async def test_budget_dur_retire_un_lot_entier_et_decompte_ses_tools(monkeypatch):
    """Lot ENTIÈREMENT hors queue : il part d'un bloc, résultats compris, et
    le total décompté les inclut (sinon le fit retirait des tours de trop)."""
    msgs = [{"role": "system", "content": "SYS"},
            {"role": "user", "content": "mission"},
            {"role": "assistant", "content": None,
             "tool_calls": [_tc("a"), _tc("b")]},
            {"role": "tool", "tool_call_id": "a", "content": "A"},
            {"role": "tool", "tool_call_id": "b", "content": "B"}]
    for i in range(12):
        msgs.append({"role": "assistant", "content": None,
                     "tool_calls": [_tc(f"k{i}")]})
        msgs.append({"role": "tool", "tool_call_id": f"k{i}", "content": "x"})

    async def _counts(messages, model_id=None):
        return [1_000 if m.get("tool_call_id") in ("a", "b") else 10
                for m in messages]

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _counts)
    # 2 270 tk pour un budget de 1 000 : le lot (a, b) pèse 2 010 et suffit.
    stats: dict = {}
    out = await enforce_context_budget(
        msgs, 100_000, model_id="m", gen_cap_tokens=0, stats_out=stats,
        fixed_overhead_tokens=_overhead_for_budget(1_000))
    assert "over_budget" not in stats
    ids = {m.get("tool_call_id") for m in out if m.get("role") == "tool"}
    assert "a" not in ids and "b" not in ids
    assert all(f"k{i}" in ids for i in range(12)), "un seul groupe devait partir"
    assert out[1]["content"] == "mission", "l'ancre de tâche reste protégée"


# ─────────────────────────────────────────────────────────────────────────────
#  n° 16 — un ``user`` suit toujours les ``system``
# ─────────────────────────────────────────────────────────────────────────────
async def test_budget_dur_ne_laisse_pas_une_reponse_en_tete(monkeypatch):
    msgs = [{"role": "system", "content": "SYS"}]
    for i in range(20):
        msgs.append({"role": "user" if i % 2 == 0 else "assistant",
                     "content": f"m{i}"})

    async def _counts(messages, model_id=None):
        return [10 if m.get("role") == "system" else 300 for m in messages]

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _counts)
    # Dépassement de ~80 tk : un seul retrait (m0, une question) suffirait.
    out = await enforce_context_budget(msgs, 12_000, model_id="m",
                                       gen_cap_tokens=0,
                                       fixed_overhead_tokens=3_000)
    first = _first_non_system(out)
    # Retrait jusqu'au filigrane bas (hystérésis, AUDIT 2026-09-25) : la tête
    # tombe plus loin que m2, mais elle reste ALIGNÉE sur une question suivie
    # de sa réponse.
    i = out.index(first)
    assert first["role"] == "user" and out[i + 1]["role"] == "assistant", (
        "une réponse est restée seule en tête : 500 sur Gemma/Mistral")
    assert int(first["content"][1:]) % 2 == 0
    assert not any(m.get("_ephemeral") for m in out), (
        "la tête s'aligne par le retrait de la réponse orpheline, sans ancre")


def test_sanitize_pose_un_user_quand_un_assistant_ouvre_la_conversation():
    msgs = [{"role": "system", "content": "SYS"},
            {"role": "assistant", "content": None, "tool_calls": [_tc("c1")]},
            {"role": "tool", "tool_call_id": "c1", "content": "ok"},
            {"role": "user", "content": "et maintenant ?"}]
    out = sanitize_message_history(msgs)
    assert [m["role"] for m in out][:3] == ["system", "user", "assistant"]
    assert out[1].get("_ephemeral") and not out[1].get("_task_anchor"), (
        "l'ancre de raccord n'est pas l'énoncé : elle ne doit pas voler la "
        "protection de la vraie demande (task_anchor_index)")
    assert sanitize_message_history(out) == out, "idempotente (préfixe KV)"
    assert _pruning.task_anchor_index(out) == 4


def test_pin_de_raccord_quand_la_fenetre_conservee_commence_par_un_assistant():
    kept = [{"role": "assistant", "content": "réponse 1"},
            {"role": "user", "content": "question 2"},
            {"role": "assistant", "content": "réponse 2"}]
    out = _pin_task_anchor(kept, [{"role": "user", "content": "question 1"}])
    assert len(out) == 1 and out[0]["role"] == "user"
    assert out[0].get("_ephemeral") and not out[0].get("_task_anchor")
    assert _count_turns(out + kept) == _count_turns(kept), (
        "le raccord compté comme un tour fausserait covered_turns")


async def test_compaction_partielle_impaire_rend_un_user_en_tete(monkeypatch):
    """``_n_take`` impair sur un échange user↔assistant : la coupe tombe entre
    une question et sa réponse. La sortie doit quand même ouvrir sur un user,
    et ``turns_compressed`` rester le compte exact des tours résumés."""
    from shared_infra import config as _cfg
    monkeypatch.setattr(_cfg, "COMPACTION_PARTIAL_TARGET_RATIO", 0.5,
                        raising=False)

    async def _counts(messages, model_id=None):
        return [1_000] * len(messages)

    monkeypatch.setattr(tok, "count_messages_tokens_per_msg", _counts)

    async def _fake_llm(messages, **kwargs):
        return ("## Contexte\nDes échanges anciens.\n## Fait\nRien.", {})

    msgs = [{"role": "system", "content": "SYS"}]
    for i in range(60):
        msgs.append({"role": "user" if i % 2 == 0 else "assistant",
                     "content": f"m{i}"})
    c = ConversationCompressor(_fake_llm, keep_recent_turns=6,
                               keep_bridge_turns=3)
    before = 60_000
    # excès = 2 500 tk → trois groupes de 1 000 : u0, a0, u1 (impair).
    usable = int((before - 2_500) / 0.5)
    out, stats = await c.compress(
        msgs, precomputed_tokens_before=(before, True), count_exact=False,
        usable_tokens=usable)
    assert stats.get("compressed"), stats
    assert stats["turns_compressed"] == 3
    first = _first_non_system(out)
    assert first["role"] == "user", [m["role"] for m in out[:5]]
    assert first.get("_ephemeral"), "raccord éphémère, jamais persisté"
    assert out[out.index(first) + 1]["content"] == "m3"


# ─────────────────────────────────────────────────────────────────────────────
#  n° 3 — entrée du résumeur bornée en TOTAL
# ─────────────────────────────────────────────────────────────────────────────
def test_plafond_total_du_resumeur():
    assert compute_serializer_total_budget_tokens(None) == 4_096
    assert compute_serializer_total_budget_tokens(16_000) == 8_000


def test_serialisation_respecte_le_plafond_total_et_garde_les_courts():
    msgs = [{"role": "tool", "tool_call_id": f"t{i}", "content": "y" * 5_000}
            for i in range(200)]
    msgs.insert(100, {"role": "user", "content": "COURT-ET-ENTIER"})
    txt = serialize_for_compression(msgs, max_chars_per_msg=2_000,
                                    max_total_chars=40_000)
    assert len(txt) <= 40_000
    assert "COURT-ET-ENTIER" in txt, "un message court passe entier"
    assert "[TOOL:tool]" in txt


def test_serialisation_sans_plafond_inchangee():
    msgs = [{"role": "user", "content": "x" * 50} for _ in range(10)]
    assert serialize_for_compression(msgs) == \
        serialize_for_compression(msgs, max_total_chars=1_000_000)


async def test_la_compaction_borne_lentree_du_resumeur(monkeypatch):
    import llm_core
    seen = {}

    async def _ctx(model):
        return 8_192

    monkeypatch.setattr(llm_core, "get_model_context_size", _ctx, raising=False)

    async def _fake_llm(messages, **kwargs):
        seen["payload"] = messages[-1]["content"]
        return ("## Contexte\nRésumé.\n## Fait\nRien.", {})

    msgs = [{"role": "system", "content": "SYS"}]
    for i in range(200):
        msgs.append({"role": "user" if i % 2 == 0 else "assistant",
                     "content": f"m{i} " + "z" * 3_000})
    c = ConversationCompressor(_fake_llm, keep_recent_turns=6,
                               keep_bridge_turns=3)
    await c.compress(msgs, precomputed_tokens_before=(200_000, True),
                     count_exact=False, force=True)
    # 8 192 × 0.5 = 4 096 tk ; avant : 191 messages × 600 tk ≈ 115 k tk.
    assert len(seen["payload"]) <= tok.tokens_to_chars(4_096) + 100


# ─────────────────────────────────────────────────────────────────────────────
#  Tokens — n° 4, 5, 6
# ─────────────────────────────────────────────────────────────────────────────
def test_cjk_compte_environ_un_token_par_caractere():
    assert tok.est_tokens_text("a" * 330) == 100          # ASCII inchangé
    assert tok.est_tokens_text("é" * 330) == 100          # accents inchangés
    assert tok.est_tokens_text("中" * 1_000) >= 900       # avant : 303
    assert tok.est_tokens_message({"role": "user", "content": "한" * 500}) >= 450


def test_mesure_cjk_acceptee(monkeypatch):
    monkeypatch.setattr(tok, "_measured_ratio", {})
    # Prompt chinois : 1 000 caractères facturés 1 400 tokens.
    chars = tok.payload_chars([{"role": "user", "content": "中" * 1_000}])
    tok.note_real_usage("qwen", chars, 1_400)
    r = tok.measured_chars_per_token("qwen")
    assert r != tok.CHARS_PER_TOKEN, "mesure réelle jetée en silence"
    assert tok.measured_prompt_tokens(
        [{"role": "user", "content": "中" * 1_000}], model_id="qwen") >= 1_300
    # Une mesure brute à 1.2 chars/token (vieux vocabulaire) n'est plus jetée.
    tok.note_real_usage("vieux", 1_200, 1_000)
    assert tok.measured_chars_per_token("vieux") == pytest.approx(1.2)


def test_mesure_avec_images_ne_touche_pas_le_ratio(monkeypatch):
    monkeypatch.setattr(tok, "_measured_ratio", {})
    msgs = [{"role": "user", "content": [
        {"type": "text", "text": "x" * 3_000},
        {"type": "image_url", "image_url": {"url": "data:"}}]}]
    assert tok.count_image_blocks(msgs) == 1
    # 3 000 chars, 2 000 tokens dont ~1 000 d'image : ratio apparent 1.5.
    tok.note_real_usage("vl", tok.payload_chars(msgs), 2_000,
                        n_images=tok.count_image_blocks(msgs))
    assert tok.measured_chars_per_token("vl") == tok.CHARS_PER_TOKEN
    tok.note_real_usage("vl", 3_600, 1_000)
    assert tok.measured_chars_per_token("vl") == pytest.approx(3.6)


async def test_repli_par_message_au_ratio_du_modele(monkeypatch):
    monkeypatch.setattr(tok, "_measured_ratio", {"m": 2.0, "": 5.0})

    async def _down(text, model_id=None, timeout=None):
        return None

    monkeypatch.setattr(tok, "count_tokens_exact", _down)
    counts = await tok.count_messages_tokens_per_msg(
        [{"role": "user", "content": "q" * 1_000}], "m")
    assert counts == [tok.MSG_OVERHEAD_TOKENS + 500], (
        "repli au ratio moyen du process (clé \"\") au lieu de celui du modèle")


# ─────────────────────────────────────────────────────────────────────────────
#  n° 7 — sanitize : appariement des appels sans id, appels sans réponse
# ─────────────────────────────────────────────────────────────────────────────
def test_resultat_dun_appel_sans_id_nest_plus_orphelin():
    msgs = [{"role": "user", "content": "go"},
            {"role": "assistant", "content": None,
             "tool_calls": [_tc(None), _tc(None, "grep")]},
            {"role": "tool", "content": "R1"},
            {"role": "tool", "tool_call_id": "inconnu", "content": "R2"}]
    out = sanitize_message_history(msgs)
    calls = out[1]["tool_calls"]
    tools = [m for m in out if m["role"] == "tool"]
    assert [t["content"] for t in tools] == ["R1", "R2"]
    assert [t["tool_call_id"] for t in tools] == [c["id"] for c in calls]
    assert sanitize_message_history(out) == out


def test_appel_sans_reponse_retire_de_lassistant():
    msgs = [{"role": "user", "content": "go"},
            {"role": "assistant", "content": "je lis",
             "tool_calls": [_tc("a"), _tc("b")]},
            {"role": "tool", "tool_call_id": "a", "content": "A"},
            {"role": "user", "content": "suite"},
            {"role": "assistant", "content": None, "tool_calls": [_tc("z")]}]
    out = sanitize_message_history(msgs)
    assert [c["id"] for c in out[1]["tool_calls"]] == ["a"]
    assert out[1]["content"] == "je lis"
    last = out[-1]
    assert last["role"] == "assistant" and "tool_calls" not in last
    assert last["content"] == ""
    assert sanitize_message_history(out) == out
