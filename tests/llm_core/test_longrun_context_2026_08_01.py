# SPDX-License-Identifier: MIT
"""tests/llm_core/test_longrun_context_2026_08_01.py — verrouillage de l'audit
« tuyauterie contexte / injection / format / tool calls » (2026-08-01).

Chaque test vise UN défaut nommé de l'audit, et échouerait sur le code d'avant.
Le fil rouge : le pipeline était dimensionné pour « un tour = un aller-retour »
alors qu'une mission longue est UN tour de plusieurs centaines d'itérations.

  P0-1 élagage intra-run          → apply_prune_marks / already_marked
  P0-2 ancre de tâche protégée    → task_anchor_index / protected_indices
  P0-3 n_ctx par cible            → resolve_context_window
  P0-4 compteurs de série         → réarmement (couvert e2e par la boucle)
  P1-5 parallélisme MCP           → _transport_concurrency / _call_guard
  P1-6 tours éphémères            → _count_turns / select_prune_keys
  P1-7 plafond dur annoncé        → _harness_status_line
"""
from __future__ import annotations

import asyncio
import copy

import pytest

from llm_core.context import pruning as _pruning
from llm_core.context.pruning import (
    PRUNE_CLEARED_MARKER,
    _prune_key,
    apply_prune_marks,
    effective_keep_recent,
    ephemeral,
    is_ephemeral,
    protected_indices,
    strip_internal_keys,
    task_anchor_index,
)


# ── P0-1 — élagage intra-run ────────────────────────────────────────────────

def test_apply_prune_marks_ne_mute_pas_et_efface_les_bonnes_sorties():
    msgs = [
        {"role": "user", "content": "va"},
        {"role": "assistant", "tool_calls": [{"id": "c1", "type": "function",
                                              "function": {"name": "t", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "AAAA" * 100},
        {"role": "tool", "tool_call_id": "c2", "content": "BBBB" * 100},
    ]
    snapshot = copy.deepcopy(msgs)
    key = _prune_key(msgs[2])
    out = apply_prune_marks(msgs, {key})

    assert msgs == snapshot, "l'entrée ne doit JAMAIS être mutée (dicts partagés)"
    assert out[2]["content"] == PRUNE_CLEARED_MARKER
    assert out[3]["content"] == msgs[3]["content"], "seule la clé marquée est effacée"
    # tool_call_id préservé → la paire tool_call ↔ result reste appariée.
    assert out[2]["tool_call_id"] == "c1"


def test_apply_prune_marks_sans_cles_renvoie_la_liste_telle_quelle():
    msgs = [{"role": "tool", "tool_call_id": "c1", "content": "x"}]
    assert apply_prune_marks(msgs, None) is msgs
    assert apply_prune_marks(msgs, set()) is msgs


@pytest.mark.asyncio
async def test_select_prune_keys_monotone_via_already_marked(monkeypatch):
    """P0-1 — la monotonie ne peut plus reposer sur « le contenu VAUT déjà le
    marqueur » : pendant un run, ``working_messages`` porte encore le contenu
    PLEIN (on ne le mute jamais). Sans ``already_marked``, la seconde passe
    re-sélectionnait les mêmes sorties à l'infini."""
    async def fake_counts(messages, model_id=None):
        return [3_000] * len(messages)
    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", fake_counts)

    msgs = [{"role": "system", "content": "s"},
            {"role": "user", "content": "go"}]
    for i in range(12):
        msgs.append({"role": "assistant", "content": "",
                     "tool_calls": [{"id": f"c{i}", "type": "function",
                                     "function": {"name": "t", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": "x" * 9000})

    first = await _pruning.select_prune_keys(msgs, ctx_size=32_768)
    assert first, "sanity : la 1re passe doit sélectionner"

    # 2e passe SANS mémoire : re-propose exactement les mêmes clés (le défaut).
    again = await _pruning.select_prune_keys(msgs, ctx_size=32_768)
    assert set(again) == set(first)

    # 2e passe AVEC mémoire : la monotonie coupe → plus rien de neuf.
    after = await _pruning.select_prune_keys(
        msgs, ctx_size=32_768, already_marked=set(first))
    assert not set(after) - set(first), \
        "une clé déjà marquée doit borner la sélection (monotonie)"


# ── P0-2 — l'ancre de tâche n'est pas jetable ───────────────────────────────

def test_task_anchor_est_le_dernier_user_pas_le_premier():
    """Le premier message d'un chat n'est PAS la mission courante. Protéger la
    tête ferait l'inverse du but : le budget, forcé de trouver ses tokens
    ailleurs, mangerait la VRAIE demande pour garder une phrase obsolète."""
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "vieille question sans rapport"},
        {"role": "assistant", "content": "réponse"},
        {"role": "user", "content": "LA MISSION"},
        {"role": "assistant", "content": "ok"},
    ]
    assert msgs[task_anchor_index(msgs)]["content"] == "LA MISSION"


def test_task_anchor_ignore_les_nudges_ephemeres():
    """Les nudges du harnais sont des ``role:user`` — s'ils comptaient comme
    ancre, le harnais protégerait son propre message au lieu de la demande."""
    msgs = [
        {"role": "user", "content": "LA MISSION"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "t", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "out"},
        ephemeral("user", "<harness_status>budget…</harness_status>"),
    ]
    assert msgs[task_anchor_index(msgs)]["content"] == "LA MISSION"


def test_protected_indices_relache_une_ancre_trop_lourde():
    """Garde-fou : une pièce jointe géante collée dans la demande ne doit pas
    rendre le fit insoluble — mieux vaut perdre l'ancre que ne rien envoyer."""
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "énorme"}]
    per_msg = [10, 900]
    assert 1 in protected_indices(msgs, per_msg, budget=10_000)   # 9 % du budget
    assert 1 not in protected_indices(msgs, per_msg, budget=1_000)  # 90 % → relâchée


def test_protected_indices_couvre_system_et_epingles():
    msgs = [{"role": "system", "content": "s"},
            {"role": "user", "content": "u"},
            {"role": "assistant", "content": "a", "_pinned": True}]
    prot = protected_indices(msgs)
    assert 0 in prot and 2 in prot


@pytest.mark.asyncio
async def test_budget_dur_ne_jette_jamais_la_demande_courante(monkeypatch):
    """Le symptôme le plus coûteux de l'audit : après quelques dizaines de
    cycles d'outils, la demande sort de la queue protégée et devient droppable
    — l'agent garde son dernier ``grep`` et a oublié ce qu'on lui demande."""
    async def fake_counts(messages, model_id=None):
        return [10 if m.get("role") == "system" else 500 for m in messages]
    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", fake_counts)

    msgs = [{"role": "system", "content": "SYS"},
            {"role": "user", "content": "LA MISSION"}]
    for i in range(40):                       # la boucle empile ses cycles
        msgs.append({"role": "assistant", "content": f"étape {i}"})

    out = await _pruning.enforce_context_budget(msgs, ctx_size=12_000,
                                                model_id="m", gen_cap_tokens=0)
    contents = [m.get("content") for m in out]
    assert len(out) < len(msgs), "sanity : le budget doit avoir élagué"
    assert "LA MISSION" in contents, "la demande courante n'est jamais jetable"


# ── P0-3 — fenêtre de contexte par cible ────────────────────────────────────

@pytest.mark.asyncio
async def test_resolve_context_window_cible_locale_delegue(monkeypatch):
    """Cible locale : comportement historique STRICTEMENT inchangé."""
    import llm_core._ctx_window as cw
    import llm_core._model_info as mi

    async def fake_size(model_id=""):
        return 262_144
    monkeypatch.setattr(mi, "get_model_context_size", fake_size)

    class _T:
        is_local_llamacpp = True
    assert await cw.resolve_context_window("qwen3", target=_T()) == 262_144


@pytest.mark.asyncio
async def test_resolve_context_window_cible_distante_famille_connue():
    """Sans ça, un connecteur cloud renvoyait 0 → compaction, élagage ET budget
    tous inertes, plus un cap d'émission bloqué à son plancher (2 400 tk)."""
    import llm_core._ctx_window as cw
    cw.invalidate_cache()

    class _T:
        is_local_llamacpp = False
        connector_id = None
        model = "claude-sonnet-5"
    assert await cw.resolve_context_window("claude-sonnet-5", target=_T()) == 200_000

    class _T2(_T):
        model = "anthropic/claude-opus-5"
    assert await cw.resolve_context_window("anthropic/claude-opus-5", target=_T2()) == 200_000


@pytest.mark.asyncio
async def test_resolve_context_window_inconnue_reste_zero():
    """Modèle inconnu ⇒ 0 : on dégrade, mais on n'INVENTE pas une fenêtre
    (une valeur trop haute ferait refuser la requête par le fournisseur)."""
    import llm_core._ctx_window as cw
    cw.invalidate_cache()

    class _T:
        is_local_llamacpp = False
        connector_id = None
        model = "modele-maison-v1"
    assert await cw.resolve_context_window("modele-maison-v1", target=_T()) == 0


# ── P1-6 — messages de contrôle éphémères ───────────────────────────────────

def test_ephemeral_nest_pas_un_tour():
    """``covered_turns`` sur-comptait à la compaction : au tour suivant,
    l'historique re-expansé ne contient plus ces nudges et
    ``_drop_leading_turns`` jetait autant de VRAIS tours en trop."""
    from llm_core.conversation_compressor import _count_turns

    base = [{"role": "user", "content": "q1"},
            {"role": "assistant", "content": "r1"}]
    assert _count_turns(base) == 2
    with_nudges = base + [ephemeral("user", "<harness_status>…</harness_status>"),
                          ephemeral("user", "[SYSTEM] relance compacte")]
    assert _count_turns(with_nudges) == 2, \
        "les nudges du harnais ne créent pas de tours"


def test_strip_internal_keys_retire_les_champs_de_harnais():
    """Un champ inconnu dans un message = 400 chez un fournisseur strict."""
    msgs = [ephemeral("user", "x"), {"role": "user", "content": "y"}]
    out = strip_internal_keys(msgs)
    assert out[0] == {"role": "user", "content": "x"}
    assert "_ephemeral" not in out[0]
    assert out[1] is msgs[1], "les messages sains passent par référence (zéro coût)"
    assert is_ephemeral(msgs[0]), "l'original garde sa marque (vue de la boucle)"


# ── P1-7 — le plafond dur est annoncé au modèle ─────────────────────────────

def test_harness_status_annonce_le_plafond_dur():
    """Le modèle planifiait contre un budget d'étapes qui n'était pas celui
    qui allait l'arrêter : en cascade d'échecs, c'est le plafond DUR qui
    termine le tour, et il n'en entendait jamais parler."""
    from llm_core._chat_with_tools import _harness_status_line

    # Loin des deux limites → silence (le harnais ne bavarde pas).
    assert _harness_status_line(3, 200, hard_left=300) is None
    # Plafond dur proche → alerte dédiée, distincte du budget d'étapes.
    line = _harness_status_line(3, 200, hard_left=2)
    assert line and "Failed-call ceiling" in line
    assert "NOT the step budget" in line, "la cause annoncée doit être la vraie"


def test_harness_status_budget_detapes_inchange():
    from llm_core._chat_with_tools import _harness_status_line
    line = _harness_status_line(100, 200, hard_left=300)
    assert line and "100/200" in line


# ── P1-5 — parallélisme des appels d'outils ─────────────────────────────────

def test_transport_concurrency_stdio_serialise():
    """stdio = un subprocess, un pipe : les appels DOIVENT rester sériels."""
    from llm_core._mcp_pool import _transport_concurrency

    class MCPStdioWrapper:      # nom = discriminant (pas d'import lourd)
        pass
    assert _transport_concurrency(MCPStdioWrapper()) == 1
    assert _transport_concurrency(None) == 1


def test_transport_concurrency_sse_parallelise():
    """Service SSE partagé : c'est ce qui rend enfin EFFECTIF le parallélisme
    d'``execute_tool_batch`` — auparavant annulé par le verrou exclusif, tous
    les outils locaux partageant une seule entrée de pool."""
    from llm_core._mcp_pool import _transport_concurrency
    from llm_core._constants import LLAMA_TOOL_PARALLELISM

    class MCPSSEWrapper:
        pass
    assert _transport_concurrency(MCPSSEWrapper()) == max(1, LLAMA_TOOL_PARALLELISM)

    # Le transport HTTP streamable est lui aussi un service distant : oublier ce
    # nom l'aurait fait retomber en SÉRIE, sans le moindre signal.
    class MCPStreamableHTTPWrapper:
        pass
    assert (_transport_concurrency(MCPStreamableHTTPWrapper())
            == max(1, LLAMA_TOOL_PARALLELISM))


@pytest.mark.asyncio
async def test_call_guard_sse_laisse_passer_en_parallele():
    from llm_core._mcp_pool import _PoolEntry, _call_guard

    entry = _PoolEntry(key="k", client=object(), max_concurrency=4,
                       call_sem=asyncio.Semaphore(4))
    peak = {"n": 0}

    async def _one():
        async with _call_guard(entry):
            entry_n = entry.inflight
            peak["n"] = max(peak["n"], entry_n)
            await asyncio.sleep(0.02)

    await asyncio.gather(*(_one() for _ in range(4)))
    assert peak["n"] > 1, "les appels doivent se recouvrir sur un transport concurrent"
    assert entry.inflight == 0, "compteur rendu à zéro"


@pytest.mark.asyncio
async def test_call_guard_stdio_serialise_vraiment():
    from llm_core._mcp_pool import _PoolEntry, _call_guard

    entry = _PoolEntry(key="k", client=object(), max_concurrency=1)
    concurrent = {"n": 0, "peak": 0}

    async def _one():
        async with _call_guard(entry):
            concurrent["n"] += 1
            concurrent["peak"] = max(concurrent["peak"], concurrent["n"])
            await asyncio.sleep(0.01)
            concurrent["n"] -= 1

    await asyncio.gather(*(_one() for _ in range(4)))
    assert concurrent["peak"] == 1, "stdio doit rester strictement sériel"


@pytest.mark.asyncio
async def test_acquire_exclusive_attend_les_appels_en_vol():
    """La fermeture ne doit JAMAIS tuer le client sous un appel en cours
    (use-after-close) — c'est la garantie que le verrou exclusif historique
    apportait et que le sémaphore doit reproduire."""
    from llm_core._mcp_pool import _PoolEntry, _call_guard, _acquire_exclusive, _release_exclusive

    entry = _PoolEntry(key="k", client=object(), max_concurrency=3,
                       call_sem=asyncio.Semaphore(3))
    released = asyncio.Event()

    async def _long_call():
        async with _call_guard(entry):
            await asyncio.sleep(0.05)
            released.set()

    task = asyncio.create_task(_long_call())
    await asyncio.sleep(0.005)                     # laisse l'appel démarrer
    assert entry.busy, "une entrée avec un appel en vol est occupée"

    taken = await _acquire_exclusive(entry, timeout=2.0)
    assert taken == 3, "l'exclusivité prend TOUS les permis"
    assert released.is_set(), "…et n'est obtenue qu'après la fin de l'appel"
    _release_exclusive(entry, taken)
    await task
    assert not entry.busy


@pytest.mark.asyncio
async def test_acquire_exclusive_timeout_rend_les_permis():
    """Un échec d'acquisition ne doit pas fuiter de permis (sinon l'entrée
    devient inutilisable pour toujours)."""
    from llm_core._mcp_pool import _PoolEntry, _call_guard, _acquire_exclusive

    entry = _PoolEntry(key="k", client=object(), max_concurrency=2,
                       call_sem=asyncio.Semaphore(2))

    async def _stuck():
        async with _call_guard(entry):
            await asyncio.sleep(0.5)

    task = asyncio.create_task(_stuck())
    await asyncio.sleep(0.005)
    assert await _acquire_exclusive(entry, timeout=0.05) is None
    assert not entry.lock.locked(), "le verrou de cycle de vie est rendu"
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    # Les 2 permis sont de nouveau disponibles.
    assert await _acquire_exclusive(entry, timeout=1.0) == 2


# ── keep_recent adaptatif ───────────────────────────────────────────────────

def test_effective_keep_recent_borne_les_conversations_courtes():
    """16 en ABSOLU protégeait la liste entière d'un échange court : plus rien
    n'était retirable et le budget dur ne pouvait plus faire son travail."""
    assert effective_keep_recent(15) == 6          # plancher
    assert effective_keep_recent(30) == 10         # un tiers
    assert effective_keep_recent(200) == 16        # plafond agentique


# ── Garde-fou de plomberie ──────────────────────────────────────────────────

def test_les_deux_entrees_de_boucle_ont_la_meme_signature():
    """``run_chat_multi_mcp_v2`` est l'alias « optimized » — la route choisit
    l'un ou l'autre selon le mode d'ordonnancement.

    Un paramètre ajouté à la boucle et oublié dans l'alias ne dégrade pas :
    il lève un ``TypeError`` à l'appel, et seulement pour les déploiements en
    mode optimized. C'est exactement ce qui est arrivé en ajoutant
    ``prune_keys``. On visse donc l'égalité des signatures plutôt que de
    compter sur la relecture.
    """
    import inspect
    from llm_core._chat_with_tools import run_chat_multi_mcp, run_chat_multi_mcp_v2

    base = set(inspect.signature(run_chat_multi_mcp).parameters) - {"_inline_semaphore"}
    alias = set(inspect.signature(run_chat_multi_mcp_v2).parameters)
    assert base == alias, (
        f"signatures désynchronisées — manquants dans v2 : {sorted(base - alias)}, "
        f"en trop : {sorted(alias - base)}")


# ── Compaction automatique : contrat de l'interrupteur ──────────────────────

@pytest.mark.asyncio
async def test_compression_refusee_quand_auto_desactive():
    """``auto_enabled=False`` ⇒ aucune compaction AUTO, aucun appel LLM.

    ``auto_enabled`` est, par contrat, une décision DÉJÀ résolue par
    l'appelant (interrupteur maître admin ET opt-in per-user) : la boucle la
    relaie telle quelle et ne doit jamais la forcer."""
    from llm_core.conversation_compressor import maybe_compress_conversation

    msgs = [{"role": "user", "content": "x" * 5000} for _ in range(30)]

    async def _never(*a, **k):
        raise AssertionError("aucun appel LLM ne doit partir")

    out, stats = await maybe_compress_conversation(
        msgs, llama_chat_fn=_never, ctx_size_tokens=8192,
        usable_tokens=100, auto_enabled=False)
    assert stats.get("compressed") is False
    assert out is msgs


def test_la_boucle_ne_force_jamais_auto_enabled():
    """Garde-fou : ``auto_enabled=True`` court-circuite TOUT, y compris le
    kill-switch admin. La boucle doit relayer la décision de l'appelant, pas
    la recalculer (défaut introduit puis corrigé pendant l'audit)."""
    import inspect
    from llm_core import _chat_with_tools as cwt

    src = inspect.getsource(cwt.run_chat_multi_mcp)
    assert "auto_enabled    = compression_enabled" in src
    assert "auto_enabled    = True" not in src
