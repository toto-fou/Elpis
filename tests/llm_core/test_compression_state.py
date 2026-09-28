# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_compression_state.py — état PERSISTANT de compression
(round / covered_turns / résumé), cap par conversation, gardes qualité.

Couvre :
- round-trip du marqueur META (build_state_system_message / extract) + compat
  d'un résumé V1 SANS ligne META ;
- apply_persisted_state : drop cohérent des tours couverts, fallback no-drop,
  idempotence, insertion après le bloc system ;
- maybe_compress_conversation (règle unique M3 : occupation ≥ usable,
  fournie ici via ``_TRIG``) : cap COMPRESSION_MAX_PER_CHAT (event
  ``compression_capped``), event interne ``compression_state`` + stats
  ``new_state``/``round``, cumul de covered_turns sur 2 rounds ;
- gardes qualité de compress() : rollback no_token_gain, rollback
  summary_invalid_format (les deux comptent comme « tentatives » → cooldown) ;
- ``manual=True`` bypasse les seuils ; ``precomputed_tokens_before`` évite le
  double comptage ; ``count_exact=False`` (cible cloud) → heuristique flaggée.

Aucun réseau : /tokenize (count_tokens_for_messages) et le LLM de résumé
(llama_chat_fn) sont monkeypatchés.
"""
from __future__ import annotations

import pytest

from llm_core.conversation_compressor import (
    ConversationCompressor,
    _count_turns,
    _extract_previous_summary,
    _format_summary_as_system_message,
    _strip_summary_messages,
    _strip_summary_span,
    apply_persisted_state,
    build_state_system_message,
    compression_was_attempted,
    extract_compression_state,
    is_summary_carrier,
    maybe_compress_conversation,
)


# ──────────────────────────────────────────────────────────────────────────
# Helpers / fixtures
# ──────────────────────────────────────────────────────────────────────────

def _conv(n_pairs: int, chars: int = 200, with_system: bool = True) -> list:
    """n_pairs échanges user/assistant (= 2×n_pairs tours), contenu dodu."""
    msgs = [{"role": "system", "content": "prompt système"}] if with_system else []
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"question {i} " + "x" * chars})
        msgs.append({"role": "assistant", "content": f"réponse {i} " + "y" * chars})
    return msgs


async def _fake_llama_small(prompt, user_id="t", model_override=None):
    return "<context>résumé compact</context>\n<facts>ok</facts>", {"model": "fake"}


# Harnais v4 (M3) : plus de règles en tours — un appel AUTO ne compresse que
# si l'occupation ≥ usable. ``_TRIG`` fournit une occupation réelle au
# plafond : la porte est ACQUISE, le test exerce la mécanique aval (état,
# cap, cumul, gardes). usable(32k) = 32768 − 13107 (gen cap) − 3276 (buffer).
CTX_TEST = 32_768
_TRIG = dict(ctx_size_tokens=CTX_TEST, real_tokens=999_999)


@pytest.fixture()
def compr_cfg(monkeypatch):
    """Config compression déterministe + reload disk neutralisé (sinon le
    reload rechargerait les valeurs réelles PAR-DESSUS les monkeypatchs)."""
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "reload_compression_config_from_disk",
                        lambda force=False: False)
    monkeypatch.setattr(cfg, "COMPRESSION_ENABLED", True)
    monkeypatch.setattr(cfg, "COMPRESSION_KEEP_RECENT", 2)
    monkeypatch.setattr(cfg, "COMPRESSION_KEEP_BRIDGE", 1)
    monkeypatch.setattr(cfg, "COMPRESSION_EXTERNAL_MODEL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_ENDPOINT_URL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_ENDPOINT_MODEL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_ENDPOINT_TIMEOUT_SEC", 30)
    monkeypatch.setattr(cfg, "COMPRESSION_MAX_PER_CHAT", 2)
    monkeypatch.setattr(cfg, "COMPACTION_BUFFER_TOKENS", 0, raising=False)
    monkeypatch.setattr(cfg, "COMPACTION_PARTIAL_TARGET_RATIO", 0.6, raising=False)
    return cfg


@pytest.fixture()
def fake_tokenize(monkeypatch):
    """/tokenize déterministe : ~chars/3, avec compteur d'appels."""
    import llm_core._llama_http as lh
    calls = []

    async def _count(messages, model_id=None, timeout=None):
        calls.append(len(messages))
        total = 0
        for m in messages:
            c = m.get("content") or ""
            if isinstance(c, str):
                total += len(c)
        return max(1, total // 3)

    monkeypatch.setattr(lh, "count_tokens_for_messages", _count)
    return calls


# ──────────────────────────────────────────────────────────────────────────
# Marqueur META — round-trip + compat V1
# ──────────────────────────────────────────────────────────────────────────

def test_meta_roundtrip():
    msg = build_state_system_message("<context>abc</context>", 2, 17, turns_compressed=8)
    assert msg["role"] == "system"
    assert msg["content"].startswith("[COMPRESSION_META v=1 round=2 covered_turns=17]")
    st = extract_compression_state([{"role": "user", "content": "x"}, msg])
    # v3 : ``ledger_block`` ("" ici, aucun artefact) fait partie du contrat.
    assert st == {"round": 2, "covered_turns": 17,
                  "summary_xml": "<context>abc</context>", "ledger_block": ""}


def test_extract_v1_sans_meta_defensif():
    legacy = _format_summary_as_system_message("<context>vieux</context>", 5)
    st = extract_compression_state([legacy])
    assert st == {"round": 1, "covered_turns": 0,
                  "summary_xml": "<context>vieux</context>", "ledger_block": ""}


def test_extract_none_sans_resume():
    assert extract_compression_state(_conv(3)) is None
    assert extract_compression_state([]) is None


# ──────────────────────────────────────────────────────────────────────────
# apply_persisted_state
# ──────────────────────────────────────────────────────────────────────────

def test_apply_drop_coherent(compr_cfg):
    msgs = _conv(12)   # 24 tours
    st = {"round": 1, "covered_turns": 4, "summary_xml": "<context>s</context>"}
    out, st2 = apply_persisted_state(msgs, st)
    assert st2["applied_drop"] is True
    # system d'origine conservé, résumé inséré juste après
    assert out[0]["content"] == "prompt système"
    assert "[COMPRESSION_META v=1 round=1 covered_turns=4]" in out[1]["content"]
    # 4 tours (= 2 paires user/assistant) droppés
    non_system = [m for m in out if m["role"] != "system"]
    assert non_system[0]["content"].startswith("question 2 ")
    assert _count_turns(non_system) == 24 - 4


def test_apply_drop_partiel_si_incoherent(compr_cfg):
    """Historique incohérent (covered > total − keep : retry, édition) :
    drop PARTIEL de ce qui peut l'être — l'ancien fallback tout-ou-rien
    renvoyait résumé + tours couverts EN DOUBLE à chaque requête."""
    msgs = _conv(3)   # 6 tours, keep=2+1 → droppable = 3
    st = {"round": 1, "covered_turns": 5, "summary_xml": "<context>s</context>"}
    out, st2 = apply_persisted_state(msgs, st)
    assert st2["applied_drop"] is True
    assert st2["applied_drop_turns"] == 3          # min(5, 6−3)
    non_system = [m for m in out if m["role"] != "system"]
    assert _count_turns(non_system) == 3           # zones bridge+recent intactes
    assert any("[COMPRESSED_SUMMARY_V1]" in (m.get("content") or "")
               for m in out if m["role"] == "system")


def test_apply_aucun_drop_si_historique_trop_court(compr_cfg):
    """total ≤ keep : rien de droppable — résumé injecté seul (ex-fallback)."""
    msgs = _conv(1)   # 2 tours ≤ keep(3)
    st = {"round": 1, "covered_turns": 5, "summary_xml": "<context>s</context>"}
    out, st2 = apply_persisted_state(msgs, st)
    assert st2["applied_drop"] is False
    assert st2["applied_drop_turns"] == 0
    assert _count_turns([m for m in out if m["role"] != "system"]) == 2


async def test_cumul_covered_apres_drop_partiel(compr_cfg, fake_tokenize):
    """Après un drop partiel, le cumul repose sur ``applied_drop_turns`` :
    les tours couverts NON droppés sont re-comptés dans turns_compressed —
    couverts exactement une fois (covered peut donc rétrécir après une
    édition d'historique : sémantique voulue)."""
    msgs = _conv(9)   # 18 tours, covered persisté 17 (> 18−3) → partiel
    st = {"round": 1, "covered_turns": 17, "summary_xml": "<context>a</context>"}
    applied, st2 = apply_persisted_state(msgs, st)
    assert st2["applied_drop_turns"] == 15          # min(17, 18−3)
    # La boucle outils fait grossir la conversation APRÈS le drop.
    applied = applied + _conv(4, with_system=False)  # +8 tours
    _, stats = await maybe_compress_conversation(
        applied, llama_chat_fn=_fake_llama_small, prev_state=st2, **_TRIG)
    assert stats["compressed"] is True
    ns = stats["new_state"]
    assert ns["covered_turns"] == 15 + stats["turns_compressed"]


def test_apply_idempotent(compr_cfg):
    msgs = _conv(10)
    st = {"round": 1, "covered_turns": 2, "summary_xml": "<context>s</context>"}
    out1, st1 = apply_persisted_state(msgs, st)
    out2, _ = apply_persisted_state(out1, st1)
    n_summaries = sum(1 for m in out2 if m["role"] == "system"
                      and "[COMPRESSED_SUMMARY_V1]" in (m.get("content") or ""))
    assert n_summaries == 1


def test_apply_sans_state_noop():
    msgs = _conv(3)
    out, st = apply_persisted_state(msgs, None)
    assert out == msgs and st is None


# ──────────────────────────────────────────────────────────────────────────
# Cap par conversation
# ──────────────────────────────────────────────────────────────────────────

async def test_cap_bloque_et_emet_capped(compr_cfg, fake_tokenize):
    msgs = _conv(10)   # 20 tours ≥ trigger 6 → should_compress dirait oui
    evs = []

    async def on_ev(e):
        evs.append(e)

    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, on_event=on_ev,
        prev_state={"round": 2, "covered_turns": 8, "summary_xml": "<context>x</context>"},
        **_TRIG,
    )
    assert out == msgs
    assert stats["compressed"] is False
    assert stats["reason"] == "max_rounds_reached"
    assert stats["round"] == 2 and stats["max"] == 2
    capped = [e for e in evs if e.get("type") == "compression_capped"]
    assert len(capped) == 1 and capped[0]["round"] == 2 and capped[0]["max"] == 2
    # Aucune compression_start émise (le cap coupe AVANT le signal UI).
    assert not any(e.get("type") == "compression_start" for e in evs)


async def test_cap_zero_illimite(compr_cfg, fake_tokenize, monkeypatch):
    monkeypatch.setattr(compr_cfg, "COMPRESSION_MAX_PER_CHAT", 0)
    msgs = _conv(10)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small,
        prev_state={"round": 7, "covered_turns": 8, "summary_xml": "<context>x</context>"},
        **_TRIG,
    )
    assert stats["compressed"] is True   # pas de cap


# ──────────────────────────────────────────────────────────────────────────
# Succès : event compression_state, round, cumul covered sur 2 rounds
# ──────────────────────────────────────────────────────────────────────────

async def test_round1_emet_state(compr_cfg, fake_tokenize):
    msgs = _conv(10)   # 20 tours
    evs = []

    async def on_ev(e):
        evs.append(e)

    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, on_event=on_ev, **_TRIG)
    assert stats["compressed"] is True
    assert stats["round"] == 1 and stats["max_rounds"] == 2
    st_evs = [e for e in evs if e.get("type") == "compression_state"]
    assert len(st_evs) == 1
    st = st_evs[0]
    # 20 tours − keep(2+1) = 17 compressés, couverts par le résumé
    assert st["round"] == 1
    assert st["covered_turns"] == stats["turns_compressed"] == 17
    assert "<context>" in st["summary_xml"]
    # Contrat = exactement ce que la persistance consomme (pas de champ mort).
    assert "tokens_after" not in st
    assert stats["new_state"]["round"] == 1


async def test_round2_cumule_covered(compr_cfg, fake_tokenize):
    # Round 1
    msgs = _conv(10)
    _, stats1 = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, **_TRIG)
    st1 = dict(stats1["new_state"])
    # Persist + nouveau tour : le client renvoie TOUT l'historique + 4 paires
    msgs2 = _conv(14)
    applied, st1b = apply_persisted_state(msgs2, st1)
    assert st1b["applied_drop"] is True
    # Round 2
    evs = []

    async def on_ev(e):
        evs.append(e)

    _, stats2 = await maybe_compress_conversation(
        applied, llama_chat_fn=_fake_llama_small, on_event=on_ev,
        prev_state=st1b, **_TRIG)
    assert stats2["compressed"] is True
    assert stats2["round"] == 2
    st2 = stats2["new_state"]
    # covered cumule : les 17 du round 1 + les tours compressés du round 2
    assert st2["covered_turns"] == 17 + stats2["turns_compressed"]
    assert st2["covered_turns"] > 17


# ──────────────────────────────────────────────────────────────────────────
# Gardes qualité de compress()
# ──────────────────────────────────────────────────────────────────────────

async def test_no_gain_rollback(compr_cfg, fake_tokenize):
    async def fat_llama(prompt, user_id="t", model_override=None):
        return "<context>" + "z" * 50_000 + "</context>", {"model": "fake"}

    msgs = _conv(10, chars=30)   # zone compressible LÉGÈRE → résumé plus gros
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fat_llama, **_TRIG)
    assert out == msgs
    assert stats["compressed"] is False
    assert stats["reason"] == "no_token_gain"
    assert stats["tokens_after"] >= stats["tokens_before"]
    assert compression_was_attempted(stats) is True   # → cooldown appliqué


async def test_summary_without_tags_is_coerced(compr_cfg, fake_tokenize):
    """Un résumé sans balise XML n'est PLUS rejeté (l'ancien rollback
    summary_invalid_format faisait que le bouton manuel n'aboutissait JAMAIS
    sur les modèles qui ne rendent pas les balises). On l'enveloppe dans
    <context> → compression appliquée + flag summary_coerced ; le garde
    no-gain reste la vraie sécurité."""
    async def narrative_llama(prompt, user_id="t", model_override=None):
        return "Résumé narratif dense sans balise : faits, état, actions concrètes.", {"model": "fake"}

    msgs = _conv(10)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=narrative_llama, **_TRIG)
    assert stats["compressed"] is True
    assert stats.get("summary_coerced") is True
    summ = _extract_previous_summary(out) or ""
    assert "<context>" in summ  # narratif enveloppé → parsable


async def test_reasoning_block_stripped_before_validation(compr_cfg, fake_tokenize):
    """Un fine-tune « reasoning » émet <think>…</think> avant le résumé balisé :
    le raisonnement est retiré, les balises restent → PAS de coerce."""
    async def thinking_llama(prompt, user_id="t", model_override=None):
        return ("<think>Je réfléchis longuement à la structure du résumé...</think>\n"
                "<context>vrai résumé structuré</context>\n<facts>- a : b</facts>"), {"model": "fake"}

    msgs = _conv(10)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=thinking_llama, **_TRIG)
    assert stats["compressed"] is True
    assert stats.get("summary_coerced") is False
    summ = _extract_previous_summary(out) or ""
    assert "<context>vrai résumé structuré</context>" in summ
    assert "<think>" not in summ  # raisonnement retiré du résumé persisté


async def test_reasoning_only_is_too_short(compr_cfg, fake_tokenize):
    """Si le modèle ne produit QUE du raisonnement (réponse coupée par le cap),
    le strip laisse un texte vide → summary_too_short (pas de faux résumé)."""
    async def all_think_llama(prompt, user_id="t", model_override=None):
        return "<think>" + "raisonnement " * 50 + "</think>", {"model": "fake"}

    msgs = _conv(10)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=all_think_llama, **_TRIG)
    assert out == msgs
    assert stats["compressed"] is False
    assert stats["reason"] == "summary_too_short"


# ──────────────────────────────────────────────────────────────────────────
# Manuel (force) + comptage
# ──────────────────────────────────────────────────────────────────────────

async def test_manual_bypasse_seuils(compr_cfg, fake_tokenize):
    """Occupation réelle SOUS usable → l'auto refuse ; /compact (manuel)
    compresse quand même (acte explicite de l'utilisateur)."""
    msgs = _conv(5)   # 10 tours > keep(3) → matière à compresser
    out_auto, stats_auto = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small,
        ctx_size_tokens=CTX_TEST, real_tokens=1_000)
    assert stats_auto["reason"] == "threshold_not_reached"
    out_man, stats_man = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, manual=True)
    assert stats_man["compressed"] is True


async def test_manual_respecte_cap(compr_cfg, fake_tokenize):
    msgs = _conv(10)
    _, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, manual=True,
        prev_state={"round": 2, "covered_turns": 5, "summary_xml": "<context>x</context>"},
    )
    assert stats["reason"] == "max_rounds_reached"


async def test_precomputed_before_deux_comptages(compr_cfg, fake_tokenize):
    """Avant le fix : 3 comptages /tokenize par cycle (maybe + compress before
    + after). Maintenant : 2 (before réutilisé, after obligatoire)."""
    msgs = _conv(10)
    fake_tokenize.clear()
    _, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, **_TRIG)
    assert stats["compressed"] is True
    assert len(fake_tokenize) == 2


async def test_count_exact_false_pour_cible_distante(compr_cfg, fake_tokenize, monkeypatch):
    class _RemoteTarget:
        # Fournisseur NON llama.cpp : ni /tokenize local, ni celui du
        # connecteur (2026-09-16 : le comptage exact suit le serveur cible).
        is_local_llamacpp = False
        is_llamacpp = False

    import llm_core._target as tgt
    monkeypatch.setattr(tgt, "current_target", lambda: _RemoteTarget())
    msgs = _conv(10)
    fake_tokenize.clear()
    _, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, **_TRIG)
    assert stats["compressed"] is True
    assert stats["tokens_estimated"] is True
    assert fake_tokenize == []   # AUCUN /tokenize (heuristique directe)


# ──────────────────────────────────────────────────────────────────────────
# extra_fixed_tokens — surcoût fixe (schéma tools) : porte, stats, no-gain
# ──────────────────────────────────────────────────────────────────────────

async def test_extra_fixed_tokens_bascule_la_porte(compr_cfg, fake_tokenize):
    """Brut sous usable, brut + surcoût au-dessus → la règle unique doit
    s'ouvrir : le schéma tools occupe réellement le contexte. (Chemin sans
    mesure réelle : estimation ratio puis confirmation exacte.)"""
    msgs = _conv(10, chars=200)   # ~1.4K tokens bruts (fake /tokenize chars//3)

    _, s0 = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, ctx_size_tokens=CTX_TEST)
    assert s0["reason"] == "threshold_not_reached"

    _, s1 = await maybe_compress_conversation(
        msgs, llama_chat_fn=_fake_llama_small, ctx_size_tokens=CTX_TEST,
        extra_fixed_tokens=15_500)
    assert s1["compressed"] is True


async def test_extra_fixed_tokens_stats_symetriques(compr_cfg, fake_tokenize):
    """Le surcoût s'ajoute SYMÉTRIQUEMENT à tokens_before/after (affichage
    cohérent avec la jauge) ; tokens_saved (différence) est invariant ; le
    widget (compression_start.tokens) raconte le même chiffre que les stats."""
    _, s0 = await maybe_compress_conversation(
        _conv(10), llama_chat_fn=_fake_llama_small, **_TRIG)
    assert s0["compressed"] is True

    evs = []

    async def on_ev(e):
        evs.append(e)

    _, s1 = await maybe_compress_conversation(
        _conv(10), llama_chat_fn=_fake_llama_small, on_event=on_ev,
        extra_fixed_tokens=1_000, **_TRIG)
    assert s1["compressed"] is True
    assert s1["tokens_before"] == s0["tokens_before"] + 1_000
    assert s1["tokens_after"] == s0["tokens_after"] + 1_000
    assert s1["tokens_saved"] == s0["tokens_saved"]
    start = [e for e in evs if e.get("type") == "compression_start"][0]
    assert start["tokens"] == s1["tokens_before"]


async def test_no_gain_rollback_insensible_au_surcout(compr_cfg, fake_tokenize):
    """Le surcoût fixe ne doit PAS masquer (ni provoquer) un no-gain : la
    garde compare des totaux également gonflés — différence inchangée."""
    async def fat_llama(prompt, user_id="t", model_override=None):
        return "<context>" + "z" * 50_000 + "</context>", {"model": "fake"}

    msgs = _conv(10, chars=30)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=fat_llama, extra_fixed_tokens=5_000, **_TRIG)
    assert out == msgs
    assert stats["reason"] == "no_token_gain"


async def test_count_exact_ajoute_forfait_image(compr_cfg, fake_tokenize):
    """Le compte EXACT du compresseur ajoute le forfait image par-dessus le
    texte (même règle que la jauge) — un chat multimodal ne sous-estime plus
    son occupation côté porte de compression."""
    from llm_core.conversation_compressor import _count_tokens_async_ex
    from llm_core._token_estimate import image_token_cost

    msgs = [{"role": "user", "content": [
        {"type": "text", "text": "regarde cette capture"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,xxx"}},
    ]}]
    n, est = await _count_tokens_async_ex(msgs, None)
    assert est is False
    assert n >= image_token_cost()


async def test_count_heuristique_pas_de_double_forfait(compr_cfg, monkeypatch):
    """Chemin heuristique (pas de /tokenize) : est_tokens_message inclut déjà
    le forfait image — _count_tokens_async_ex ne doit PAS le cumuler."""
    import llm_core._llama_http as lh

    async def _none(messages, model_id=None, timeout=None):
        return None

    monkeypatch.setattr(lh, "count_tokens_for_messages", _none)
    from llm_core.conversation_compressor import _count_tokens_async_ex, _estimate_tokens

    msgs = [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "x"}}]}]
    n, est = await _count_tokens_async_ex(msgs, None)
    assert est is True
    assert n == _estimate_tokens(msgs)


# ──────────────────────────────────────────────────────────────────────────
# Régression F1 — le résumé fusionné dans la tête ne doit JAMAIS emporter le
# socle : span-strip (compresseur) + fold-skip (_fold_operational_block)
# ──────────────────────────────────────────────────────────────────────────

def _state_content(summary="<context>x</context>", round_no=1, covered=3) -> str:
    return build_state_system_message(summary, round_no, covered)["content"]


def test_strip_span_tete_fold():
    merged = "SOCLE" + "\n\n---\n\n" + _state_content()
    assert _strip_summary_span(merged) == "SOCLE"


def test_strip_span_tete_coalesce():
    # Jointure « \n\n » (celle de _coalesce_system_messages à l'envoi).
    merged = "SOCLE\n\n" + _state_content()
    assert _strip_summary_span(merged) == "SOCLE"


def test_strip_span_bloc_au_milieu_preserve_la_suite():
    merged = "SOCLE\n\n---\n\n" + _state_content() + "\n\n---\n\nOP_BLOCK"
    assert _strip_summary_span(merged) == "SOCLE\n\n---\n\nOP_BLOCK"


def test_strip_span_porteur_seul_devient_vide():
    assert _strip_summary_span(_state_content()) == ""


def test_strip_span_start_sans_end_coupe_a_la_fin():
    merged = "SOCLE\n\n---\n\n[COMPRESSED_SUMMARY_V1]\ncorrompu sans marqueur de fin"
    assert _strip_summary_span(merged) == "SOCLE"


def test_strip_span_resume_contenant_le_separateur():
    # Un résumé qui contient lui-même « \n\n---\n\n » ne perturbe pas le strip
    # (les bornes sont cherchées par marqueurs, pas par split).
    merged = "SOCLE\n\n---\n\n" + _state_content("<context>a\n\n---\n\nb</context>")
    assert _strip_summary_span(merged) == "SOCLE"


def test_strip_summary_messages_fusionne_garde_socle():
    merged = {"role": "system", "content": "SOCLE\n\n---\n\n" + _state_content()}
    out = _strip_summary_messages([merged, {"role": "user", "content": "u"}])
    assert [m.get("role") for m in out] == ["system", "user"]
    assert out[0]["content"] == "SOCLE"
    # Pas de mutation : le dict d'origine est intact (refs partagées).
    assert merged["content"].startswith("SOCLE\n\n---")


def test_is_summary_carrier():
    assert is_summary_carrier(build_state_system_message("<context>s</context>", 1, 2))
    assert not is_summary_carrier({"role": "system", "content": "socle"})
    assert not is_summary_carrier({"role": "user",
                                   "content": "[COMPRESSED_SUMMARY_V1] cité"})
    assert not is_summary_carrier({"role": "system", "content": None})


def test_fold_preserve_porteur_de_resume(compr_cfg):
    """Le fold ne fusionne pas le porteur d'état : socle et résumé restent
    deux messages system distincts (le scénario du bug : chat rechargé)."""
    from llm_core._chat_with_tools import _fold_operational_block
    msgs = _conv(8)
    st = {"round": 1, "covered_turns": 2, "summary_xml": "<context>s</context>"}
    out, _ = apply_persisted_state(msgs, st)
    _fold_operational_block(out, "OP_BLOCK")
    systems = [m for m in out if m["role"] == "system"]
    assert len(systems) == 2
    head, carrier = systems
    assert "prompt système" in head["content"] and "OP_BLOCK" in head["content"]
    assert "[COMPRESSED_SUMMARY_V1]" not in head["content"]
    assert "[COMPRESSED_SUMMARY_V1]" in carrier["content"]


async def test_recompression_apres_fold_preserve_socle(compr_cfg, fake_tokenize):
    """Scénario complet du bug : état persisté ré-appliqué + fold opérationnel
    + recompression en boucle → le socle (identité + bloc opérationnel) doit
    SURVIVRE et un seul porteur (le nouveau résumé) doit rester."""
    from llm_core._chat_with_tools import _fold_operational_block
    msgs = _conv(14)   # 28 tours
    st = {"round": 1, "covered_turns": 4, "summary_xml": "<context>ancien</context>"}
    out, st2 = apply_persisted_state(msgs, st)
    _fold_operational_block(out, "RUNTIME_CTX_ET_FRAGMENTS")

    compressed, stats = await maybe_compress_conversation(
        out, llama_chat_fn=_fake_llama_small, prev_state=st2, **_TRIG)
    assert stats["compressed"] is True
    assert stats["round"] == 2
    assert stats["had_previous_summary"] is True   # l'ancien résumé a nourri le merge

    systems = [m for m in compressed if m["role"] == "system"]
    head = systems[0]
    assert "prompt système" in head["content"]
    assert "RUNTIME_CTX_ET_FRAGMENTS" in head["content"]
    carriers = [m for m in systems
                if "[COMPRESSED_SUMMARY_V1]" in (m.get("content") or "")]
    assert len(carriers) == 1


async def test_recompression_tete_fusionnee_heritee_span_strip(compr_cfg, fake_tokenize):
    """Défense en profondeur : contenu HÉRITÉ où socle + résumé sont déjà
    fusionnés dans un même message system → la recompression retire le span
    résumé et conserve le socle (avant : message entier jeté)."""
    msgs = _conv(14, with_system=False)
    merged = {"role": "system",
              "content": "SOCLE IDENTITÉ\n\n---\n\n" + _state_content("<context>ancien</context>")}
    conv = [merged] + msgs

    compressed, stats = await maybe_compress_conversation(
        conv, llama_chat_fn=_fake_llama_small,
        prev_state={"round": 1, "covered_turns": 0,
                    "summary_xml": "<context>ancien</context>"}, **_TRIG)
    assert stats["compressed"] is True
    head = compressed[0]
    assert head["role"] == "system"
    assert "SOCLE IDENTITÉ" in head["content"]
    assert "[COMPRESSED_SUMMARY_V1]" not in head["content"]
    # Le socle strippé n'a pas muté l'objet d'origine (refs partagées).
    assert "[COMPRESSED_SUMMARY_V1]" in merged["content"]


async def test_cap_max_tokens_si_signature_le_permet(compr_cfg, fake_tokenize):
    """Le chemin self/external plafonne la SORTIE du résumeur (UX 2026-07-25 :
    résumé court) : si le llama_chat injecté accepte ``sampling_override``,
    compress() passe {"max_tokens": 4096} — sinon (fakes historiques) l'appel
    reste inchangé (détection de signature, cf. test précédents sans kwarg)."""
    seen = {}

    async def capped_llama(prompt, user_id="t", model_override=None,
                           sampling_override=None):
        seen["sampling"] = sampling_override
        return "<context>résumé compact</context>\n<facts>ok</facts>", {"model": "fake"}

    _, stats = await maybe_compress_conversation(
        _conv(10), llama_chat_fn=capped_llama, **_TRIG)
    assert stats["compressed"] is True
    assert seen["sampling"] == {"max_tokens": 4096}


# ──────────────────────────────────────────────────────────────────────────
# M5 — format ANCRÉ + update-merge (harnais v4)
# ──────────────────────────────────────────────────────────────────────────

async def test_resume_ancre_accepte_sans_coerce(compr_cfg, fake_tokenize):
    """Un résumé aux sections ancrées « ## … » est la forme NOMINALE (M5) :
    accepté tel quel, pas de coerce <context>."""
    async def anchored_llama(prompt, user_id="t", model_override=None):
        return ("## Goal\nMigrer le pipeline.\n\n## Progress\n### Done\n"
                "- Etape 1 livree\n\n## Next Steps\n- Etape 2"), {"model": "fake"}

    msgs = _conv(10)
    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=anchored_llama, **_TRIG)
    assert stats["compressed"] is True
    assert stats.get("summary_coerced") is False
    summ = _extract_previous_summary(out) or ""
    assert "## Goal" in summ and "## Next Steps" in summ


async def test_recompression_update_merge_ancre(compr_cfg, fake_tokenize):
    """Round 2 : l'ancien résumé est fourni au résumeur dans
    ``<anchored_summary>`` avec l'instruction d'UPDATE (fusion), plus de
    régénération aveugle — le prompt du résumeur en fait foi."""
    seen = {}

    async def recording_llama(prompt, user_id="t", model_override=None):
        seen["user_payload"] = prompt[-1]["content"]
        return ("## Goal\nSuite du travail.\n\n## Critical Context\n"
                "- fusion effectuee"), {"model": "fake"}

    # Round 1.
    _, s1 = await maybe_compress_conversation(
        _conv(10), llama_chat_fn=recording_llama, **_TRIG)
    assert s1["compressed"] is True
    st1 = dict(s1["new_state"])

    # Round 2 sur l'historique ré-appliqué + nouveaux tours.
    applied, st1b = apply_persisted_state(_conv(14), st1)
    _, s2 = await maybe_compress_conversation(
        applied, llama_chat_fn=recording_llama, prev_state=st1b, **_TRIG)
    assert s2["compressed"] is True
    payload = seen["user_payload"]
    assert payload.startswith("<anchored_summary>\n")
    assert "## Goal\nSuite du travail." in payload or "## Goal" in payload, \
        "l'ancien résumé ancré est fourni tel quel"
    assert "Update the anchored summary above" in payload
    assert "Output the FULL updated summary" in payload
