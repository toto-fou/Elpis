# SPDX-License-Identifier: MIT
"""tests/llm_core/test_compaction_threshold_2026_08_21.py — « contexte max
avant compaction » choisi par l'utilisateur + protection du flux en cours.

Ce que ça couvre :

- ``llm_core.context.compaction_gate`` : les DEUX seuils (plafond TECHNIQUE
  ``usable`` inchangé, seuil EFFECTIF ``trigger``), les DEUX unités du réglage
  (% de la fenêtre / tokens, les tokens primant), leur coercition, et la
  résolution compte > instance > auto ;
- **parité stricte** : à seuil « auto » (0 ou 100), ``usable`` vaut au token
  près la formule historique — le refactor n'a rien déplacé. C'est le
  garde-fou anti-régression n°1, les deux copies qu'il remplace vivaient dans
  ``_chat_with_tools`` et ``conversation_compressor`` ;
- ``gate_tokens`` : le seuil du compte s'oppose à l'occupation à CHAQUE
  itération de la boucle outils (la porte est évaluée ENTRE deux appels
  d'outils, rien n'y est streamé) — sans quoi une mission de plusieurs heures,
  qui tient dans un SEUL tour, ne se compacterait jamais ;
- le cap de compactions PAR CONVERSATION réglé par le compte
  (``compression_max_rounds`` : 0 = auto, -1 = illimité) et sa remontée dans le
  budget de compactions du RUN ;
- la porte de ``maybe_compress_conversation`` avec ``trigger_tokens``, sa
  rétro-compatibilité (``None`` ⇒ comportement d'avant) et l'ANCRAGE de la
  compaction partielle sur le seuil qui a déclenché (sans quoi un seuil
  abaissé viserait une taille supérieure à l'occupation courante : no-op) ;
- ``/compact`` (``manual=True``) insensible au seuil, dans les deux sens ;
- le relais du réglage jusqu'à la boucle outils (les deux entrées).

Aucun réseau : /tokenize et le LLM de résumé sont monkeypatchés.
"""
from __future__ import annotations

import pytest

from llm_core.context.compaction_gate import (
    AUTO,
    MAX_ROUNDS_MAX,
    MAX_ROUNDS_UNLIMITED,
    PCT_MAX,
    PCT_MIN,
    RUN_COMPACTION_UNBOUNDED,
    TOKENS_MAX,
    TOKENS_MIN,
    CompactionThreshold,
    clamp_max_rounds,
    clamp_threshold_pct,
    clamp_threshold_tokens,
    compaction_gate,
    gate_tokens,
    resolve_max_rounds,
    resolve_threshold,
    run_compaction_budget,
    threshold_from,
    usable_window,
)


def _pct(v):
    return CompactionThreshold(pct=v)


def _tok(v):
    return CompactionThreshold(tokens=v)
from llm_core.conversation_compressor import maybe_compress_conversation

# Fenêtres réelles du parc : petite locale, 128k, 262k, 1M.
WINDOWS = (32_768, 131_072, 262_144, 1_048_576)


@pytest.fixture()
def cfg_neutre(monkeypatch):
    """Config de compaction déterministe (buffer auto, pas de défaut admin)."""
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "COMPACTION_BUFFER_TOKENS", 0, raising=False)
    monkeypatch.setattr(cfg, "COMPACTION_THRESHOLD_PCT", 0, raising=False)
    monkeypatch.setattr(cfg, "COMPACTION_PARTIAL_TARGET_RATIO", 0.6, raising=False)
    return cfg


def _usable_historique(ctx: int, thinking: bool = False, buffer_forced: int = 0) -> int:
    """LA formule d'avant, recopiée à la main depuis les deux appelants
    historiques. Si elle diverge de ``usable_window``, c'est une régression."""
    from llm_core._constants import effective_generation_cap
    buf = buffer_forced
    if buf <= 0:
        buf = min(20_000, int(ctx * 0.10))
    return ctx - effective_generation_cap(thinking, ctx) - buf


# ──────────────────────────────────────────────────────────────────────────
# 1. Parité stricte du plafond technique
# ──────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("ctx", WINDOWS)
@pytest.mark.parametrize("thinking", [False, True])
def test_usable_identique_a_la_formule_historique(cfg_neutre, ctx, thinking):
    assert usable_window(ctx, thinking) == _usable_historique(ctx, thinking)


@pytest.mark.parametrize("ctx", WINDOWS)
def test_usable_identique_avec_buffer_force(monkeypatch, cfg_neutre, ctx):
    """``llm.compaction.buffer_tokens`` explicite : même résultat qu'avant."""
    monkeypatch.setattr(cfg_neutre, "COMPACTION_BUFFER_TOKENS", 7_777, raising=False)
    assert usable_window(ctx, False) == _usable_historique(ctx, False, 7_777)


@pytest.mark.parametrize("ctx", WINDOWS)
@pytest.mark.parametrize("pct", [0, PCT_MAX])
def test_seuil_auto_vaut_le_plafond_technique(cfg_neutre, ctx, pct):
    """0 (auto) et 100 % donnent EXACTEMENT le comportement d'avant.

    ``min(usable, 100 % × n_ctx)`` vaut ``usable`` puisque ``usable ≤ n_ctx``
    par construction : aucun compte existant ne change de comportement."""
    g = compaction_gate(ctx, threshold=_pct(pct))
    assert g.usable_tokens == _usable_historique(ctx)
    assert g.trigger_tokens == g.usable_tokens
    assert g.is_user_threshold is False


# ──────────────────────────────────────────────────────────────────────────
# 2. Seuil effectif
# ──────────────────────────────────────────────────────────────────────────

def test_seuil_utilisateur_abaisse_la_porte(cfg_neutre):
    g = compaction_gate(262_144, threshold=_pct(70))
    assert g.usable_tokens == 225_760            # plafond technique inchangé
    assert g.trigger_tokens == int(262_144 * 0.70)
    assert g.trigger_tokens < g.usable_tokens
    assert g.is_user_threshold is True


def test_le_plafond_technique_gagne_toujours(cfg_neutre):
    """Sur une petite fenêtre, ``usable`` vaut déjà ~50 % du n_ctx : un seuil
    à 95 % ne doit PAS repousser la compaction au-delà du soutenable."""
    g = compaction_gate(32_768, threshold=_pct(95))
    assert g.trigger_tokens == g.usable_tokens == _usable_historique(32_768)
    assert g.is_user_threshold is False


def test_fenetre_inconnue_desarme_tout(cfg_neutre):
    """Cible distante sans n_ctx : rien à dimensionner, comme avant."""
    for ctx in (0, None, -1):
        g = compaction_gate(ctx, threshold=_pct(70))
        assert (g.usable_tokens, g.trigger_tokens) == (0, 0)
    assert gate_tokens(compaction_gate(0, threshold=_pct(70))) == 0


def test_seuil_ne_tombe_jamais_sous_le_plancher_de_generation(cfg_neutre):
    """Filet : 30 % d'une fenêtre minuscule ne doit pas laisser moins que de
    quoi tenir un tour."""
    from llm_core._constants import LLAMA_GEN_CAP_FLOOR
    g = compaction_gate(4_096, threshold=_pct(PCT_MIN))
    if g.usable_tokens > 0:
        assert g.trigger_tokens >= min(g.usable_tokens, LLAMA_GEN_CAP_FLOOR)


@pytest.mark.parametrize("brut,attendu", [
    (None, 0), (0, 0), (-5, 0), ("", 0), ("abc", 0), ({}, 0),
    (12, PCT_MIN), (30, 30), (70, 70), ("70", 70), (100, 100), (400, PCT_MAX),
])
def test_clamp_threshold_pct(brut, attendu):
    assert clamp_threshold_pct(brut) == attendu


def test_resolution_compte_puis_instance_puis_auto(monkeypatch, cfg_neutre):
    # Rien nulle part → auto.
    assert resolve_threshold(None) == AUTO
    assert resolve_threshold({}) == AUTO
    # Défaut d'instance seul.
    monkeypatch.setattr(cfg_neutre, "COMPACTION_THRESHOLD_PCT", 60, raising=False)
    assert resolve_threshold({}) == _pct(60)
    assert resolve_threshold({"compression_threshold_pct": 0}) == _pct(60)
    # Le choix du COMPTE prime sur le défaut d'instance.
    assert resolve_threshold({"compression_threshold_pct": 80}) == _pct(80)


def test_le_choix_du_compte_prime_EN_BLOC_sur_le_defaut_dinstance(monkeypatch, cfg_neutre):
    """Le piège de la résolution à deux unités : l'instance a un défaut en
    TOKENS, le compte a réglé un POURCENTAGE. Fusionner les deux sources champ
    par champ donnerait ``pct=60, tokens=80000`` — et les tokens primant, le
    compte recevrait le seuil de l'admin, l'inverse de ce qu'il a demandé. Le
    choix du compte se prend donc EN BLOC."""
    monkeypatch.setattr(cfg_neutre, "COMPACTION_THRESHOLD_TOKENS", 80_000, raising=False)
    assert resolve_threshold({"compression_threshold_pct": 60}) == _pct(60)
    # …et un compte muet hérite bien du défaut d'instance en tokens.
    assert resolve_threshold({}) == _tok(80_000)


# ──────────────────────────────────────────────────────────────────────────
# 2 bis. Seuil en TOKENS (deuxième unité)
# ──────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("brut,attendu", [
    (None, 0), (0, 0), (-5, 0), ("", 0), ("abc", 0), ({}, 0),
    (500, TOKENS_MIN), (2_048, 2_048), (80_000, 80_000), ("80000", 80_000),
    (9_000_000, TOKENS_MAX),
])
def test_clamp_threshold_tokens(brut, attendu):
    assert clamp_threshold_tokens(brut) == attendu


def test_seuil_en_tokens_arme_la_porte(cfg_neutre):
    """« Compacte à 80k » : le chiffre part tel quel, indépendamment de la
    taille de la fenêtre — c'est tout l'intérêt de cette unité."""
    g = compaction_gate(262_144, threshold=_tok(80_000))
    assert g.trigger_tokens == 80_000
    assert g.usable_tokens == 225_760       # plafond technique inchangé
    assert g.is_user_threshold is True
    assert g.describe() == "80000 tk"


def test_le_meme_seuil_en_tokens_sur_deux_fenetres(cfg_neutre):
    """80k reste 80k d'un modèle à l'autre — là où « 70 % » vaudrait 183k sur
    un 262k et 91k sur un 131k. C'est la raison d'être de l'unité."""
    assert compaction_gate(262_144, threshold=_tok(80_000)).trigger_tokens == 80_000
    assert compaction_gate(131_072, threshold=_tok(80_000)).trigger_tokens == 80_000


def test_seuil_en_tokens_borne_par_le_plafond_technique(cfg_neutre):
    """80k demandés sur une fenêtre 32k (plafond 16 385) : le plafond gagne.
    Le réglage devient inopérant, jamais dangereux."""
    g = compaction_gate(32_768, threshold=_tok(80_000))
    assert g.trigger_tokens == g.usable_tokens == _usable_historique(32_768)
    assert g.is_user_threshold is False


def test_les_tokens_priment_sur_le_pourcentage(cfg_neutre):
    """Les deux unités posées (settings bricolé à la main, ou migration) : les
    tokens gagnent — c'est l'expression la plus précise. L'interface, elle,
    n'écrit jamais les deux."""
    g = compaction_gate(262_144, threshold=CompactionThreshold(pct=90, tokens=20_000))
    assert g.trigger_tokens == 20_000
    assert g.threshold.mode == "tokens"


@pytest.mark.parametrize("thr,mode", [
    (AUTO, "auto"),
    (CompactionThreshold(pct=70), "pct"),
    (CompactionThreshold(tokens=80_000), "tokens"),
    (CompactionThreshold(pct=70, tokens=80_000), "tokens"),
])
def test_mode_du_seuil(thr, mode):
    assert thr.mode == mode
    assert thr.is_set is (mode != "auto")


def test_threshold_from_normalise_les_deux_unites():
    assert threshold_from("70", "abc") == _pct(70)
    assert threshold_from(12, 0) == _pct(PCT_MIN)      # % sous la borne
    assert threshold_from(0, 500) == _tok(TOKENS_MIN)  # tokens sous la borne
    assert threshold_from(None, None) == AUTO


@pytest.mark.asyncio
async def test_porte_du_compresseur_en_tokens(compr_env):
    """Bout de chaîne : un seuil en tokens franchit bien la porte de
    ``maybe_compress_conversation`` comme un seuil en %."""
    msgs = _conv(12)
    _, sous = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ko, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=80_000,
        real_tokens=70_000, auto_enabled=True)
    assert sous["reason"] == "threshold_not_reached"
    assert sous["trigger_tokens"] == 80_000

    _, sur = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ok, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=80_000,
        real_tokens=90_000, auto_enabled=True)
    assert sur.get("compressed") is True


# ──────────────────────────────────────────────────────────────────────────
# 3. Le seuil vaut EN COURS DE RUN
# ──────────────────────────────────────────────────────────────────────────

def test_le_seuil_du_compte_arme_a_toutes_les_iterations(cfg_neutre):
    """L'inverse de la règle d'origine, et c'est le but : la porte est évaluée
    entre deux appels d'outils (rien n'y est streamé), et une mission de
    plusieurs heures tient dans UN tour — « au tour suivant » y voudrait dire
    « jamais »."""
    g = compaction_gate(262_144, threshold=_pct(50))
    assert g.trigger_tokens < g.usable_tokens
    assert gate_tokens(g) == g.trigger_tokens


def test_sans_seuil_utilisateur_la_porte_ne_bouge_pas(cfg_neutre):
    """Seuil auto : la porte oppose le plafond technique — la boucle se
    comporte exactement comme avant."""
    g = compaction_gate(262_144, threshold=AUTO)
    assert gate_tokens(g) == g.usable_tokens


def test_la_boucle_utilise_gate_tokens(cfg_neutre):
    """Garde-fou source : la porte de la boucle DOIT passer par le helper —
    ré-inliner une comparaison sur ``usable`` ferait silencieusement sauter le
    réglage du compte, et aucun test fonctionnel ne le verrait à seuil
    « auto »."""
    from tests._sources import source_boucle
    src = source_boucle()
    assert "gate_tokens(_compr_gate)" in src
    assert "_occ >= _gate_tok" in src


# ──────────────────────────────────────────────────────────────────────────
# 3 bis. Combien de compactions
# ──────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("brut,attendu", [
    (None, 0), ("", 0), ("oui", 0), (0, 0), ("0", 0),          # illisible → auto
    (-1, MAX_ROUNDS_UNLIMITED), (-9, MAX_ROUNDS_UNLIMITED),    # tout négatif = illimité
    (1, 1), (24, 24), ("24", 24),
    (10_000, MAX_ROUNDS_MAX),                                  # borné
])
def test_coercition_du_cap(brut, attendu):
    assert clamp_max_rounds(brut) == attendu


def test_resolution_du_cap_par_compte():
    """None = rien de réglé (le défaut d'instance garde la main) ; 0 =
    illimité, dans la convention du compresseur."""
    assert resolve_max_rounds(None) is None
    assert resolve_max_rounds({}) is None
    assert resolve_max_rounds({"compression_max_rounds": 0}) is None
    assert resolve_max_rounds({"compression_max_rounds": -1}) == 0
    assert resolve_max_rounds({"compression_max_rounds": 30}) == 30
    assert resolve_max_rounds({"compression_max_rounds": 5_000}) == MAX_ROUNDS_MAX


def test_budget_de_compactions_du_run():
    """Sans choix du compte, le budget calculé par la boucle passe INTACT
    (défauts au chiffre près). Un cap réglé le relève quand il est plus haut,
    jamais l'inverse : le plafond de la boucle reste un plancher de sécurité."""
    assert run_compaction_budget(8) == 8
    assert run_compaction_budget(24) == 24
    assert run_compaction_budget(8, 40) == 40          # le compte veut plus
    assert run_compaction_budget(24, 3) == 24          # jamais moins
    assert run_compaction_budget(8, 0) == RUN_COMPACTION_UNBOUNDED   # illimité
    assert run_compaction_budget(0) == 1               # jamais zéro


def test_la_boucle_branche_le_cap_du_compte(cfg_neutre):
    """Garde-fou source : le cap doit atteindre le budget du RUN *et* les deux
    appels au compresseur. Oublier l'un des trois laisse un réglage qui a l'air
    de marcher — jusqu'à la mission longue, où il se tait."""
    from tests._sources import source_boucle
    src = source_boucle()
    assert "_run_budget(" in src
    assert src.count("max_rounds      = compaction_max_rounds") == 2


# ──────────────────────────────────────────────────────────────────────────
# 4. Porte de maybe_compress_conversation
# ──────────────────────────────────────────────────────────────────────────

def _conv(n_pairs: int, chars: int = 400) -> list:
    msgs = [{"role": "system", "content": "prompt système"}]
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"q{i} " + "x" * chars})
        msgs.append({"role": "assistant", "content": f"r{i} " + "y" * chars})
    return msgs


@pytest.fixture()
def compr_env(monkeypatch):
    """Compaction autorisée, /tokenize et LLM de résumé neutralisés."""
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


async def _llm_ko(*a, **k):
    raise AssertionError("aucun appel LLM ne doit partir")


async def _llm_ok(prompt, user_id="t", model_override=None):
    return "<context>résumé</context>\n<facts>ok</facts>", {"model": "fake"}


@pytest.mark.asyncio
async def test_occupation_sous_le_seuil_ne_declenche_rien(compr_env):
    msgs = _conv(12)
    _, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ko, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=183_500,
        real_tokens=100_000, auto_enabled=True)
    assert stats["reason"] == "threshold_not_reached"
    assert stats["trigger_tokens"] == 183_500
    assert stats["usable_tokens"] == 225_760


@pytest.mark.asyncio
async def test_entre_seuil_et_plafond_le_seuil_decide(compr_env):
    """Occupation à 200k, plafond technique 225k : SANS seuil rien ne part
    (comportement d'avant), AVEC seuil à 183k la compaction part."""
    msgs = _conv(12)
    _, sans = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ko, ctx_size_tokens=262_144,
        usable_tokens=225_760, real_tokens=200_000, auto_enabled=True)
    assert sans["reason"] == "threshold_not_reached"

    _, avec = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ok, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=183_500,
        real_tokens=200_000, auto_enabled=True)
    assert avec.get("compressed") is True


@pytest.mark.asyncio
async def test_trigger_none_reproduit_le_comportement_davant(compr_env):
    """Rétro-compatibilité : ``trigger_tokens=None`` ⇒ le plafond technique
    fait office de seuil. Même décision qu'un appel explicite au plafond."""
    msgs = _conv(12)
    kw = dict(ctx_size_tokens=262_144, usable_tokens=225_760, auto_enabled=True)
    _, a = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ko, real_tokens=200_000, **kw)
    _, b = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ko, real_tokens=200_000,
        trigger_tokens=225_760, **kw)
    assert a["reason"] == b["reason"] == "threshold_not_reached"
    assert a["occupancy_tokens"] == b["occupancy_tokens"]


@pytest.mark.asyncio
async def test_un_seuil_ne_repousse_jamais_la_compaction(compr_env):
    """Un ``trigger_tokens`` PLUS HAUT que le plafond est borné : on ne peut
    pas se servir du réglage pour dépasser ce que la fenêtre supporte."""
    msgs = _conv(12)
    _, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_llm_ok, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=900_000,
        real_tokens=226_000, auto_enabled=True)
    assert stats.get("compressed") is True


@pytest.mark.asyncio
async def test_cible_partielle_ancree_sur_le_seuil(compr_env, monkeypatch):
    """LE piège du seuil abaissé : viser ``usable × 0.6`` (135k) alors que
    l'occupation est à 200k et le seuil à 183k ne compacterait RIEN. La cible
    doit être ``trigger × 0.6``."""
    from llm_core.conversation_compressor import ConversationCompressor
    vu = {}

    async def _spy(self, messages, **kw):
        vu.update(kw)
        return messages, {"compressed": False, "reason": "nothing_to_compress"}

    monkeypatch.setattr(ConversationCompressor, "compress", _spy, raising=True)
    await maybe_compress_conversation(
        _conv(12), llama_chat_fn=_llm_ok, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=183_500,
        real_tokens=200_000, auto_enabled=True)
    assert vu["usable_tokens"] == 183_500, "cible ancrée sur le plafond technique"


@pytest.mark.asyncio
async def test_compaction_manuelle_insensible_au_seuil(compr_env, monkeypatch):
    """``/compact`` bypasse les seuils dans les deux sens : il part même sous
    le seuil, et un seuil abaissé ne change pas sa prise (``force=True`` ⇒
    l'ancre partielle n'est pas consultée)."""
    from llm_core.conversation_compressor import ConversationCompressor
    vu = {}

    async def _spy(self, messages, **kw):
        vu.update(kw)
        return messages, {"compressed": False, "reason": "nothing_to_compress"}

    monkeypatch.setattr(ConversationCompressor, "compress", _spy, raising=True)
    _, stats = await maybe_compress_conversation(
        _conv(12), llama_chat_fn=_llm_ok, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=183_500,
        real_tokens=1_000, manual=True, auto_enabled=False)
    assert stats["reason"] != "threshold_not_reached"
    assert vu["force"] is True


@pytest.mark.asyncio
async def test_seuil_ignore_quand_la_compaction_auto_est_coupee(compr_env):
    """Le seuil n'est pas un contournement de l'interrupteur : auto OFF ⇒
    rien ne part, quel que soit le réglage."""
    _, stats = await maybe_compress_conversation(
        _conv(12), llama_chat_fn=_llm_ko, ctx_size_tokens=262_144,
        usable_tokens=225_760, trigger_tokens=50_000,
        real_tokens=999_999, auto_enabled=False)
    assert stats["compressed"] is False and stats["reason"] == "disabled"


# ──────────────────────────────────────────────────────────────────────────
# 5. Câblage
# ──────────────────────────────────────────────────────────────────────────

def test_le_reglage_atteint_les_deux_entrees_de_la_boucle():
    import inspect

    from llm_core._chat_with_tools import run_chat_multi_mcp, run_chat_multi_mcp_v2
    for fn in (run_chat_multi_mcp, run_chat_multi_mcp_v2):
        assert "compaction_threshold" in inspect.signature(fn).parameters
    # …et v2 le RELAIE (un oubli ici ne casserait que le mode « optimized »).
    from tests._sources import source_fonction
    assert "compaction_threshold = compaction_threshold" in \
        source_fonction("run_chat_multi_mcp_v2")


def test_la_route_resout_le_seuil_et_le_propage():
    """Garde-fou source, même gabarit que ``compression_enabled`` : la route
    est la seule à connaître les settings du compte."""
    from tests._sources import source_flux_chat
    src = source_flux_chat()
    assert "_compaction_threshold = _resolve_thr(user_settings)" in src
    assert "compaction_threshold=_compaction_threshold" in src   # chemin outils
    assert "threshold=_compaction_threshold" in src              # chemin classic


# ──────────────────────────────────────────────────────────────────────────
# 6. Bout en bout — la BOUCLE réelle, hermétique (harnais ctx_scale)
# ──────────────────────────────────────────────────────────────────────────
#
# Les checks ci-dessus prouvent la géométrie ; ceux-ci prouvent le
# COMPORTEMENT observable : ce que la boucle envoie réellement au moteur,
# itération par itération. La fenêtre est 256k → plafond technique 225 760 tk.
# Un seuil à 50 % le ramène à 131 072 : entre les deux se trouve la « bande »
# où tout se joue.

from tests.llm_core.ctx_scale_harness import (  # noqa: E402
    CTX_256K,
    blob,
    compression_cfg,
    expected,
    hermetic_at_scale,
    patch_fake_tokenize,
    sse_final_scaled,
    sse_tool_call_scaled,
)
from tests.llm_core.goldens_harness import builtin_tools, sse_final  # noqa: E402

SOCLE_E2E = "SOCLE SEUIL — identité de test stable, ne pas reformuler."


@pytest.fixture(autouse=True)
def _purge_cache_nctx():
    """Le cache n_ctx est GLOBAL au process : purge avant/après, sinon
    l'échelle 256k fuit vers les autres tests."""
    import llm_core._model_info as mi
    mi._cached_context_size.clear()
    mi._cached_context_size_ts.clear()
    yield
    mi._cached_context_size.clear()
    mi._cached_context_size_ts.clear()


def _preload(chars_par_tour: int = 0) -> list:
    """Historique de départ : 4 échanges légers par défaut, ou 20 échanges
    ``chars_par_tour`` caractères chacun pour peser vraiment dans la fenêtre.

    Le poids compte : en TÊTE de tour il n'existe aucune mesure serveur, donc
    la porte s'appuie sur l'estimation du contenu réel — un préchargement
    symbolique ne franchirait aucun seuil, quel que soit le réglage."""
    msgs = [{"role": "system", "content": SOCLE_E2E}]
    if chars_par_tour <= 0:
        for i in range(4):
            msgs.append({"role": "user", "content": f"question {i} " + "q" * 400})
            msgs.append({"role": "assistant", "content": f"reponse {i} " + "r" * 400})
    else:
        for i in range(10):
            msgs.append({"role": "user", "content": blob(chars_par_tour, f"q{i}")})
            msgs.append({"role": "assistant", "content": blob(chars_par_tour, f"r{i}")})
    msgs.append({"role": "user", "content": "continue le travail outillé"})
    return msgs


async def _run_loop(monkeypatch, scripts, *, threshold=None, messages=None):
    import llm_core._chat_with_tools as _cwt
    fake = hermetic_at_scale(monkeypatch, scripts, CTX_256K)
    events: list = []

    async def _cb(evt):
        events.append(evt)

    final, _ev, _metrics = await _cwt.run_chat_multi_mcp(
        messages if messages is not None else _preload(),
        mcp_configs=[], builtin_tools=builtin_tools(),
        username="seuil", chat_id="seuil-chat", model="seuil-model",
        memory_enabled=False, on_event=_cb,
        compaction_threshold=threshold)
    return fake, events, final


@pytest.mark.asyncio
async def test_e2e_seuil_bas_compacte_en_tete_de_tour(monkeypatch):
    """Historique pesant ~140k tokens : SOUS le plafond technique (225 760)
    donc rien ne partait avant, AU-DESSUS du seuil du compte (131 072) donc la
    compaction part — et elle part en TÊTE de tour, avant le premier appel au
    moteur, donc avant qu'un seul token n'ait été streamé."""
    from llm_core.context.tokens import measured_prompt_tokens
    compression_cfg(monkeypatch, COMPACTION_THRESHOLD_PCT=0,
                    COMPACTION_THRESHOLD_TOKENS=0)
    patch_fake_tokenize(monkeypatch)
    assert expected(CTX_256K)["usable"] == 225_760

    msgs = _preload(chars_par_tour=23_000)
    poids = measured_prompt_tokens(msgs)
    # Le préchargement doit tomber DANS la bande : au-dessus du seuil du
    # compte, sous le plafond technique. Asserté pour que le test dise
    # pourquoi il casse si le ratio d'estimation bouge un jour.
    assert 131_072 <= poids < 225_760, poids

    fake, events, final = await _run_loop(monkeypatch, [
        # 1er payload = le RÉSUMEUR : la porte a ouvert AVANT tout appel de
        # boucle, la compaction s'est donc glissée en tête de tour.
        sse_final("<context>resume seuil bas.</context>"),
        sse_tool_call_scaled("zeta_echo", '{"msg": "apres"}', "e1",
                             prompt_tokens=90_000),
        sse_final_scaled("Terminé.", prompt_tokens=91_000),
    ], threshold=_pct(50), messages=msgs)

    assert final == "Terminé."
    assert len(fake.payloads) == 3, "résumeur INTERNE puis 2 tours de boucle"
    # Le PREMIER échange est bien celui du résumeur : chemin classic (pas de
    # tools), et les vieux tours y sont sérialisés.
    p_sum = fake.payloads[0]
    assert "tools" not in p_sum
    assert [m["role"] for m in p_sum["messages"]] == ["system", "user"]
    assert "<<HEAD q0>>" in p_sum["messages"][1]["content"]
    types = [e.get("type") for e in events]
    assert "compression_start" in types and "compression_done" in types
    # …et le premier appel de BOUCLE part déjà sur le contexte compacté.
    p_loop = fake.payloads[1]
    sys_msgs = [m for m in p_loop["messages"] if m["role"] == "system"]
    assert len(sys_msgs) == 1
    assert "[COMPRESSED_SUMMARY_V1]" in sys_msgs[0]["content"]
    assert "resume seuil bas" in sys_msgs[0]["content"]


@pytest.mark.asyncio
async def test_e2e_meme_occupation_sans_seuil_ne_compacte_pas(monkeypatch):
    """Le CONTRE-EXEMPLE du test précédent : mêmes 150k, seuil auto ⇒ rien.
    C'est la preuve que le réglage — et lui seul — a changé la décision."""
    compression_cfg(monkeypatch, COMPACTION_THRESHOLD_PCT=0,
                    COMPACTION_THRESHOLD_TOKENS=0)
    patch_fake_tokenize(monkeypatch)

    fake, events, final = await _run_loop(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "avant"}', "e1",
                             prompt_tokens=150_000),
        sse_final_scaled("Terminé.", prompt_tokens=151_000),
    ], threshold=AUTO, messages=_preload(chars_par_tour=23_000))

    assert final == "Terminé."
    assert len(fake.payloads) == 2, "aucun appel au résumeur"
    assert not [e for e in events if str(e.get("type", "")).startswith("compression")]


@pytest.mark.asyncio
async def test_e2e_le_seuil_du_compte_compacte_en_plein_run(monkeypatch, caplog):
    """LE test de la garantie demandée.

    iter 0 part à 100k (sous le seuil de 131 072) : rien. Le run gonfle et
    l'itération 1 se retrouve à 150k — AU-DESSUS du seuil, SOUS le plafond
    technique. La porte est évaluée ENTRE deux appels d'outils, rien n'est en
    train de streamer : la compaction part là, sans attendre le tour suivant.
    C'est ce qui permet à une mission de plusieurs heures — un seul tour de
    chat, des centaines d'itérations — de ne jamais saturer la fenêtre.
    """
    compression_cfg(monkeypatch, COMPACTION_THRESHOLD_PCT=0,
                    COMPACTION_THRESHOLD_TOKENS=0)
    patch_fake_tokenize(monkeypatch)

    with caplog.at_level("INFO", logger="uvicorn.error"):
        fake, events, final = await _run_loop(monkeypatch, [
            sse_tool_call_scaled("zeta_echo", '{"msg": "un"}', "e1",
                                 prompt_tokens=100_000),
            sse_tool_call_scaled("zeta_echo", '{"msg": "deux"}', "e2",
                                 prompt_tokens=150_000),
            sse_final("<context>resume seuil en plein run.</context>"),  # RÉSUMEUR
            sse_final_scaled("Terminé.", prompt_tokens=90_000),
        ], threshold=_pct(50))

    assert final == "Terminé."
    assert len(fake.payloads) == 4, \
        "le résumeur s'intercale entre deux appels d'outils"
    types = [e.get("type") for e in events]
    assert "compression_start" in types and "compression_done" in types
    # …et le déclenchement est TRACÉ comme venant du COMPTE, pas du plafond
    # technique. Sans cette assertion, le test passerait aussi si c'était le
    # plafond qui avait parlé — or il est à 225 760, très au-dessus.
    dits = [r for r in caplog.records
            if "compaction sur le seuil du compte" in r.getMessage()]
    assert len(dits) == 1, "le seuil du compte se dit UNE fois par run"
    assert "131072" in dits[0].getMessage().replace(" ", "")


@pytest.mark.asyncio
async def test_e2e_le_plafond_technique_reste_arme_en_plein_run(monkeypatch):
    """Le pendant du test précédent : le report n'est pas un abandon. Au
    plafond technique, la compaction part MÊME en plein run — c'est elle qui
    empêche la troncature."""
    compression_cfg(monkeypatch, COMPACTION_THRESHOLD_PCT=0,
                    COMPACTION_THRESHOLD_TOKENS=0)
    patch_fake_tokenize(monkeypatch)

    fake, events, final = await _run_loop(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "un"}', "e1",
                             prompt_tokens=100_000),
        # iter 1 : 230 000 ≥ usable 225 760 → on ne peut plus attendre.
        sse_tool_call_scaled("zeta_echo", '{"msg": "deux"}', "e2",
                             prompt_tokens=230_000),
        sse_final("<context>resume plafond atteint.</context>"),   # le RÉSUMEUR
        sse_final_scaled("Terminé.", prompt_tokens=90_000),
    ], threshold=_pct(50))

    assert final == "Terminé."
    assert len(fake.payloads) == 4, "le résumeur s'intercale bien en plein run"
    types = [e.get("type") for e in events]
    assert "compression_start" in types and "compression_done" in types


@pytest.mark.asyncio
async def test_e2e_seuil_en_tokens_compacte_en_tete_de_tour(monkeypatch):
    """La deuxième unité, bout en bout : « compacte à 100k » sur une fenêtre
    262k. Historique ~140k ⇒ au-dessus des 100k demandés, sous le plafond
    technique (225 760) : la compaction part en tête de tour."""
    from llm_core.context.tokens import measured_prompt_tokens
    compression_cfg(monkeypatch, COMPACTION_THRESHOLD_PCT=0,
                    COMPACTION_THRESHOLD_TOKENS=0)
    patch_fake_tokenize(monkeypatch)

    msgs = _preload(chars_par_tour=23_000)
    assert 100_000 <= measured_prompt_tokens(msgs) < 225_760

    fake, events, final = await _run_loop(monkeypatch, [
        sse_final("<context>resume seuil en tokens.</context>"),   # le RÉSUMEUR
        sse_tool_call_scaled("zeta_echo", '{"msg": "apres"}', "e1",
                             prompt_tokens=60_000),
        sse_final_scaled("Terminé.", prompt_tokens=61_000),
    ], threshold=_tok(100_000), messages=msgs)

    assert final == "Terminé."
    assert len(fake.payloads) == 3, "résumeur INTERNE puis 2 tours de boucle"
    types = [e.get("type") for e in events]
    assert "compression_start" in types and "compression_done" in types
    assert "<<HEAD q0>>" in fake.payloads[0]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_e2e_seuil_en_tokens_compacte_en_plein_run(monkeypatch, caplog):
    """Même règle qu'en pourcentage : l'unité ne change rien au moment du
    déclenchement. iter 0 à 60k (sous les 100k), iter 1 à 150k — au-dessus du
    seuil, sous le plafond technique ⇒ la compaction part en plein run."""
    compression_cfg(monkeypatch, COMPACTION_THRESHOLD_PCT=0,
                    COMPACTION_THRESHOLD_TOKENS=0)
    patch_fake_tokenize(monkeypatch)

    with caplog.at_level("INFO", logger="uvicorn.error"):
        fake, events, final = await _run_loop(monkeypatch, [
            sse_tool_call_scaled("zeta_echo", '{"msg": "un"}', "e1",
                                 prompt_tokens=60_000),
            sse_tool_call_scaled("zeta_echo", '{"msg": "deux"}', "e2",
                                 prompt_tokens=150_000),
            sse_final("<context>resume seuil en tokens, en plein run.</context>"),
            sse_final_scaled("Terminé.", prompt_tokens=55_000),
        ], threshold=_tok(100_000))

    assert final == "Terminé."
    assert len(fake.payloads) == 4
    types = [e.get("type") for e in events]
    assert "compression_start" in types and "compression_done" in types
    dits = [r for r in caplog.records
            if "compaction sur le seuil du compte" in r.getMessage()]
    assert len(dits) == 1 and "100000 tk" in dits[0].getMessage()
