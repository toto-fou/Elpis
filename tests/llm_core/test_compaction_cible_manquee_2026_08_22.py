# SPDX-License-Identifier: MIT
"""tests/llm_core/test_compaction_cible_manquee_2026_08_22.py — la compaction
dit désormais si elle a ATTEINT sa cible, et la boucle en tient compte.

Le trou comblé
--------------
La compaction partielle vise ``seuil × ratio``. Personne ne vérifiait qu'elle
y arrivait. Mesuré en production le 2026-08-22 sur un run d'outils (fenêtre
65 536, réflexion active) : seuil 34 407 tk, cible 20 644 tk, atteint
30 833 tk — 10 189 tk d'écart. Cause : les 9 tours protégés (6 récents +
3 de transition) portaient 79 % du poids, et sur une boucle agentique un
« tour » vaut un cycle d'outil. La compaction repartait donc toutes les
trois minutes pour 50 s d'appel LLM et 3 k tokens récupérés, jusqu'à épuiser
le cap de la conversation — après quoi il ne reste que le budget dur, qui
JETTE au lieu de résumer.

Ce que ces tests verrouillent :

  1. ``target_after_tokens`` / ``zone_tokens`` / ``target_reached`` sont
     exposés — l'écart devient mesurable au lieu d'être invisible ;
  2. une compaction qui récupère moins de la MOITIÉ de l'excès demandé pose
     ``defer_retry`` ; une qui atteint sa cible ne le pose pas ;
  3. une zone compressible plus légère que le résumé qui la remplacerait est
     abandonnée AVANT l'appel LLM (``gain_too_small``) — c'est la garde
     no-gain existante, avancée de 50 s ;
  4. le déclencheur MANUEL et le rattrapage « contexte dépassé » restent
     dispensés de cette garde ;
  5. la boucle outils consulte bien ``defer_retry`` pour espacer les
     tentatives, et invalide l'ancre d'occupation après la compaction de
     rattrapage.

Aucun réseau : /tokenize et le LLM de résumé sont monkeypatchés.
"""
from __future__ import annotations

import inspect

import pytest

from llm_core.conversation_compressor import maybe_compress_conversation


# ─────────────────────────────────────────────────────────────────────────────
#  Environnement : compaction autorisée, /tokenize et résumeur neutralisés
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture()
def env(monkeypatch):
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "reload_compression_config_from_disk",
                        lambda force=False: False)
    monkeypatch.setattr(cfg, "COMPRESSION_ENABLED", True)
    monkeypatch.setattr(cfg, "COMPRESSION_KEEP_RECENT", 2)
    monkeypatch.setattr(cfg, "COMPRESSION_KEEP_BRIDGE", 1)
    monkeypatch.setattr(cfg, "COMPRESSION_EXTERNAL_MODEL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_ENDPOINT_URL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_ENDPOINT_MODEL", "")
    monkeypatch.setattr(cfg, "COMPRESSION_MAX_PER_CHAT", 0)
    monkeypatch.setattr(cfg, "COMPACTION_BUFFER_TOKENS", 0, raising=False)
    monkeypatch.setattr(cfg, "COMPACTION_THRESHOLD_PCT", 0, raising=False)
    monkeypatch.setattr(cfg, "COMPACTION_PARTIAL_TARGET_RATIO", 0.6, raising=False)

    import llm_core._llama_http as lh

    async def _count(messages, model_id=None, timeout=None):
        total = sum(len(m.get("content") or "") for m in messages
                    if isinstance(m.get("content"), str))
        return max(1, total // 3)

    monkeypatch.setattr(lh, "count_tokens_for_messages", _count, raising=False)
    return cfg


async def _resume_court(prompt, user_id="t", model_override=None):
    return "## Goal\nrésumé bref\n## Progress\nfait", {"model": "fake"}


async def _jamais_appele(*a, **k):
    raise AssertionError(
        "un appel LLM est parti alors que la zone ne valait pas son résumé")


def _bloc(n, chars):
    """``n`` messages alternés user/assistant de ``chars`` caractères.

    ⚠ Un « tour » au sens du découpage vaut ICI un message : un ``user`` ouvre
    un tour, et un ``assistant`` qui ne suit pas un résultat d'outil aussi.
    Avec ``keep_recent=2`` + ``keep_bridge=1``, ce sont donc les 3 DERNIERS
    messages qui sont protégés — c'est la transposition, à l'échelle du test,
    des 9 cycles d'outils protégés en production.
    """
    return [
        {"role": "user" if i % 2 == 0 else "assistant",
         "content": f"m{i} " + "x" * chars}
        for i in range(n)
    ]


# ─────────────────────────────────────────────────────────────────────────────
#  1-2 — la cible est mesurée, et son échec se dit
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_cible_manquee_quand_les_tours_proteges_portent_le_poids(env):
    """Reproduction du cas de production : la tête est maigre, la queue —
    protégée — est énorme. La compaction aboutit mais ne ramène pas
    l'occupation sous la cible, et le dit."""
    # 6 vieux messages légers (la seule matière compressible, ≈ 5 500 tk)
    # derrière 3 messages récents énormes (≈ 27 000 tk) : les protégés
    # portent 83 % du poids, exactement la forme mesurée en production.
    msgs = _bloc(6, 3_000) + _bloc(3, 30_000)
    _, st = await maybe_compress_conversation(
        msgs, llama_chat_fn=_resume_court, ctx_size_tokens=131_072,
        usable_tokens=34_000, real_tokens=36_000, auto_enabled=True)

    assert st["compressed"] is True
    assert st["target_after_tokens"] == 20_400, "cible = seuil × 0,6"
    assert st["target_reached"] is False
    assert st["tokens_after"] > st["target_after_tokens"]
    assert st["defer_retry"] is True, (
        "une compaction qui laisse l'occupation très au-dessus de sa cible "
        "doit espacer la suivante, sinon elle repart toutes les trois minutes")
    assert st["zone_tokens"] > 0, "le poids de la zone compressible est exposé"


@pytest.mark.asyncio
async def test_cible_atteinte_ne_differe_rien(env):
    """Le cas nominal : le gros de l'historique est compressible. La cible est
    atteinte, rien n'est différé — sans quoi le correctif brimerait la
    compaction qui fonctionne."""
    msgs = _bloc(20, 6_000) + _bloc(3, 300)
    _, st = await maybe_compress_conversation(
        msgs, llama_chat_fn=_resume_court, ctx_size_tokens=131_072,
        usable_tokens=40_000, real_tokens=41_000, auto_enabled=True)

    assert st["compressed"] is True
    assert st["tokens_after"] <= st["target_after_tokens"]
    assert st["target_reached"] is True
    assert not st.get("defer_retry")


# ─────────────────────────────────────────────────────────────────────────────
#  3-4 — zone plus légère que son résumé : renoncer AVANT l'appel
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_zone_plus_legere_que_son_resume_aucun_appel_llm(env):
    """La garde no-gain existait déjà — mais après 50 s de génération. Ici on
    renonce avant, sur le seul poids de la zone."""
    msgs = _bloc(4, 300) + _bloc(3, 30_000)
    _, st = await maybe_compress_conversation(
        msgs, llama_chat_fn=_jamais_appele, ctx_size_tokens=131_072,
        usable_tokens=40_000, real_tokens=41_000, auto_enabled=True)

    assert st["compressed"] is False
    assert st["reason"] == "gain_too_small"
    assert st["defer_retry"] is True
    assert st["zone_tokens"] > 0


@pytest.mark.asyncio
async def test_le_rattrapage_contexte_depasse_tente_quand_meme(env):
    """Le serveur vient de refuser : toute marge est bonne à prendre, la
    garde ne doit pas s'interposer."""
    msgs = _bloc(4, 300) + _bloc(3, 30_000)
    _, st = await maybe_compress_conversation(
        msgs, llama_chat_fn=_resume_court, ctx_size_tokens=131_072,
        usable_tokens=40_000, triggered_by_overflow=True, auto_enabled=True)
    assert st.get("reason") != "gain_too_small"


@pytest.mark.asyncio
async def test_la_compaction_manuelle_tente_quand_meme(env):
    """/compact est un ordre explicite de l'utilisateur."""
    msgs = _bloc(4, 300) + _bloc(3, 30_000)
    _, st = await maybe_compress_conversation(
        msgs, llama_chat_fn=_resume_court, ctx_size_tokens=131_072,
        usable_tokens=40_000, manual=True, auto_enabled=True)
    assert st.get("reason") != "gain_too_small"


# ─────────────────────────────────────────────────────────────────────────────
#  5 — la boucle outils consomme le signal
# ─────────────────────────────────────────────────────────────────────────────
def _source_boucle() -> str:
    import llm_core._chat_with_tools as cwt
    return inspect.getsource(cwt)


def test_la_boucle_espace_les_tentatives_sur_defer_retry():
    src = _source_boucle()
    i = src.index("_compr_fail_streak = (")
    seg = src[i - 1200:i + 400]
    assert "defer_retry" in seg, (
        "la boucle remet le compteur d'échecs à zéro sur toute compaction "
        "« réussie » : une compaction qui n'approche pas sa cible repartirait "
        "à l'itération suivante, pour le même prix et le même résultat")


def test_le_rattrapage_overflow_invalide_lancre_doccupation():
    src = _source_boucle()
    i = src.index("triggered_by_overflow = True")
    seg = src[i:i + 3000]
    assert "_occ_anchor_tok = None" in seg, (
        "sans cette invalidation, l'itération suivante rapporte l'occupation "
        "d'AVANT la compaction — marquée « mesure réelle », donc dispensée de "
        "confirmation exacte — et recompacte pour rien juste après un overflow")


def test_lentree_de_controle_du_raisonnement_meurt_avec_le_flux():
    src = _source_boucle()
    i = src.index("_sse = await consume_llama_sse(")
    seg = src[i:i + 3000]
    assert "clear_completion" in seg, (
        "sans ce retrait, l'entrée survit à son TTL de 15 min et « Répondre "
        "maintenant » vise une complétion déjà terminée")
