# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_vague1_2026_08_23.py — vague 1 des constats confirmés
(boucle agentique + fenêtre de contexte).

Constats traités : 2, 3/50, 4, 6, 8, 10, 49, 51, 52, 53.
"""
from __future__ import annotations

import inspect
import json
import re

import pytest

from tests._sources import compter_appels, source_boucle, source_fonction

# ── 2. Le plafond de tool_history voit les ARGUMENTS ────────────────────────

def _hist_lourd(n=200, taille=200_000):
    h = []
    for i in range(n):
        h.append({"role": "assistant", "content": None, "tool_calls": [{
            "id": f"c{i}", "type": "function",
            "function": {"name": "write_file",
                         "arguments": json.dumps({"path": f"/work/f{i}.py",
                                                  "content": "X" * taille})}}]})
        h.append({"role": "tool", "tool_call_id": f"c{i}", "content": "ok"})
    return h


def test_la_pesee_compte_les_arguments_des_tool_calls():
    from llm_core.engine.run import _tool_msg_weight
    m = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "c0", "type": "function",
        "function": {"name": "write_file", "arguments": '{"content": "%s"}' % ("X" * 5000)}}]}
    assert _tool_msg_weight(m) > 5000, \
        "un assistant.tool_calls pèse encore 4 octets (json.dumps(None))"


def test_le_plafond_agit_vraiment_sur_un_historique_massif():
    """PROUVÉ dans l'audit : 40 Mo réels, 1 200 « vus », cap no-op."""
    from llm_core.engine.run import RUN_TOOL_HISTORY_MAX_BYTES, _cap_run_tool_history
    hist = _hist_lourd()
    reel_avant = len(json.dumps(hist, ensure_ascii=False))
    assert reel_avant > 4 * RUN_TOOL_HISTORY_MAX_BYTES, "prémisse : historique massif"

    out = _cap_run_tool_history(hist)
    assert out is not hist, "le cap a rendu l'objet d'entrée — il n'a rien fait"
    reel_apres = len(json.dumps(out, ensure_ascii=False))
    assert reel_apres < reel_avant / 4, \
        f"élagage insuffisant : {reel_avant} → {reel_apres}"


def test_le_plafond_preserve_lappariement_et_le_json():
    """Les ``id``/``name`` restent (un « Continuer » les ré-expanse), et les
    arguments élagués restent du JSON VALIDE — certains gabarits les reparsent."""
    from llm_core.engine.run import _cap_run_tool_history
    out = _cap_run_tool_history(_hist_lourd())
    ids_calls = [c["id"] for m in out if m.get("tool_calls") for c in m["tool_calls"]]
    ids_res = [m["tool_call_id"] for m in out if m.get("role") == "tool"]
    assert len(ids_calls) == 200 and sorted(ids_calls) == sorted(ids_res)
    for m in out:
        for c in (m.get("tool_calls") or []):
            assert c["function"]["name"] == "write_file"
            json.loads(c["function"]["arguments"])       # lève si cassé


def test_la_queue_reste_intacte():
    """Le travail RÉCENT — le seul que le modèle relira — n'est pas touché."""
    from llm_core.engine.run import _cap_run_tool_history
    hist = _hist_lourd()
    out = _cap_run_tool_history(hist)
    assert out[-1] == hist[-1]
    dernier_call = [m for m in out if m.get("tool_calls")][-1]
    assert "_elided" not in dernier_call["tool_calls"][0]["function"]["arguments"]


# ── 3 / 50. La frame vision est ÉPHÉMÈRE ───────────────────────────────────

def test_la_frame_vision_porte_le_marqueur_ephemere():
    src = source_boucle()
    i = src.index("_pending_vision_msgs.append({")
    bloc = src[i:i + 1400]
    assert '"_ephemeral": True' in bloc, \
        "la frame vision est encore comptée comme un VRAI tour utilisateur"


def test_une_frame_vision_ne_vole_plus_lancre_de_tache():
    """``task_anchor_index`` = dernier ``role:user`` NON éphémère. Sans le
    marqueur, la légende de screenshot devenait l'ancre et l'énoncé de la
    mission devenait droppable par le budget dur (régression P0-2)."""
    from llm_core.context.pruning import protected_indices, task_anchor_index
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "MISSION: migre la base"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "desktop_observe", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "ok"},
        {"role": "user", "content": [{"type": "text", "text": "capture"}],
         "_ephemeral": True},
    ]
    assert task_anchor_index(msgs) == 1
    assert 1 in protected_indices(msgs)

    sans_marqueur = [dict(m) for m in msgs]
    sans_marqueur[-1].pop("_ephemeral")
    assert task_anchor_index(sans_marqueur) == 4, "prémisse invalidée"


def test_une_frame_vision_ne_gonfle_plus_le_compte_de_tours():
    from llm_core.conversation_compressor import _count_turns
    base = [
        {"role": "user", "content": "m"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "desktop_observe", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "ok"},
    ]
    frame = {"role": "user", "content": [{"type": "text", "text": "f"}],
             "_ephemeral": True}
    assert _count_turns(base) == _count_turns(base + [frame])


# ── 51. Le découpage en tours ignore les nudges éphémères ──────────────────

def test_le_decoupage_et_le_comptage_voient_le_meme_nombre_de_tours():
    """Invariant : les quatre fonctions de tour du module doivent s'accorder.
    ``_split_by_turn_index`` était la seule à compter les éphémères."""
    from llm_core.conversation_compressor import (
        _count_turns,
        _split_by_turn_index,
    )
    msgs = [{"role": "system", "content": "s"}]
    for k in range(20):
        msgs += [
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": f"c{k}", "type": "function",
                 "function": {"name": "read_file", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": f"c{k}", "content": "r"},
            {"role": "user", "content": f"<harness_status>{k}</harness_status>",
             "_ephemeral": True},
        ]
    _sys, to_compress, bridge, recent = _split_by_turn_index(
        msgs, keep_recent_turns=6, keep_bridge_turns=3)

    cycles_gardes = sum(1 for m in (bridge + recent) if m.get("tool_calls"))
    assert cycles_gardes == 9, (
        f"la fenêtre récente configurée (6+3 tours) n'en protège que "
        f"{cycles_gardes} — les nudges éphémères la font fondre")


def test_la_zone_protegee_est_la_meme_sans_les_nudges():
    """Contrôle : avec ou sans nudges, la configuration doit donner la même
    quantité de TRAVAIL protégé."""
    from llm_core.conversation_compressor import _split_by_turn_index

    def _construire(avec_nudges):
        m = [{"role": "system", "content": "s"}]
        for k in range(20):
            m += [
                {"role": "assistant", "content": None, "tool_calls": [
                    {"id": f"c{k}", "type": "function",
                     "function": {"name": "read_file", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": f"c{k}", "content": "r"},
            ]
            if avec_nudges:
                m.append({"role": "user", "content": "<hs>", "_ephemeral": True})
        return m

    def _cycles(msgs):
        _s, _c, b, r = _split_by_turn_index(msgs, keep_recent_turns=6,
                                            keep_bridge_turns=3)
        return sum(1 for x in (b + r) if x.get("tool_calls"))

    assert _cycles(_construire(True)) == _cycles(_construire(False))


# ── 52. Un seul ratio chars/token pour la porte de compaction ──────────────

def test_le_compresseur_compte_avec_le_modele(monkeypatch):
    """La boucle passait ``model_id``, le compresseur jamais : 27 % d'écart
    mesuré sur la MÊME occupation, comparée au MÊME seuil."""
    from llm_core.context import tokens as T
    T._measured_ratio.clear()
    try:
        T.note_real_usage("qwen3-coder-30b", 260_000, 100_000)   # ratio 2.6
        assert round(T.measured_chars_per_token("qwen3-coder-30b"), 2) == 2.6
        # Le repli du process n'est plus figé sur l'amorce froide.
        assert round(T.measured_chars_per_token(None), 2) == 2.6

        msgs = [{"role": "user", "content": "X" * 400_000}]
        boucle = T.measured_prompt_tokens(msgs, model_id="qwen3-coder-30b")

        from llm_core.conversation_compressor import _estimate_tokens
        compresseur = _estimate_tokens(msgs, "qwen3-coder-30b")
        assert boucle == compresseur, (
            f"les deux estimations divergent : boucle={boucle} "
            f"compresseur={compresseur}")
    finally:
        T._measured_ratio.clear()


def test_la_porte_du_compresseur_recoit_le_modele():
    from llm_core import conversation_compressor as C
    src = inspect.getsource(C.maybe_compress_conversation)
    i = src.index("_occ = measured_prompt_tokens(")
    assert "model_id=(_model_for_count or None)" in src[i:i + 200]


# ── 49. Le mémo de comptage ne rend plus le compte d'un AUTRE message ──────

def test_deux_assistants_a_tool_calls_ont_des_signatures_distinctes():
    """Le cas prouvé : ``content=None`` ⇒ ``id(None)``, constante du process.
    Seul ``n_tc`` distinguait alors deux messages complètement différents."""
    from llm_core.context.tokens import _memo_signature
    a = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "c0", "type": "function",
        "function": {"name": "write_file", "arguments": "A" * 400}}]}
    b = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "c0", "type": "function",
        "function": {"name": "write_file", "arguments": "B" * 3}}]}
    assert _memo_signature(a, "m") != _memo_signature(b, "m")


def test_le_memo_survit_a_une_adresse_recyclee():
    """Reproduction du mécanisme : on force la MÊME clé ``id`` pour deux
    messages différents et on vérifie que le compte du mort n'est pas rendu."""
    from llm_core.context import tokens as T
    T._MSG_TOKEN_MEMO.clear()
    lourd = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "c0", "type": "function",
        "function": {"name": "write_file", "arguments": "A" * 400}}]}
    T._memo_store(lourd, "m", 441)
    leger = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "c0", "type": "function",
        "function": {"name": "write_file", "arguments": "B" * 3}}]}
    # Adresse recyclée : on range l'entrée du mort sous l'id du vivant.
    T._MSG_TOKEN_MEMO[id(leger)] = T._MSG_TOKEN_MEMO.pop(id(lourd))
    assert T._memo_lookup(leger, "m") is None, \
        "le compte d'un message MORT a été rendu (441 tokens au lieu de 43)"
    T._MSG_TOKEN_MEMO.clear()


def test_le_memo_reste_efficace_sur_un_message_inchange():
    """La correction ne doit pas désarmer le mémo : c'est un chemin chaud."""
    from llm_core.context import tokens as T
    T._MSG_TOKEN_MEMO.clear()
    m = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "c0", "type": "function",
        "function": {"name": "write_file", "arguments": "A" * 400}}]}
    T._memo_store(m, "mod", 123)
    assert T._memo_lookup(m, "mod") == 123
    m["tool_calls"][0]["function"]["arguments"] = "A" * 401
    assert T._memo_lookup(m, "mod") is None, "une MUTATION doit invalider"
    T._MSG_TOKEN_MEMO.clear()


# ── 6. Un run outillé qui échoue est compté ────────────────────────────────

def test_le_retour_derreur_enregistre_son_usage():
    src = source_boucle()
    i = src.index("return _partial_text, rec.events, _err_metrics")
    amont = src[max(0, i - 1600):i]
    assert "record_turn_usage(" in amont, (
        "le retour d'échec ne journalise toujours rien — un run de 3 h qui "
        "meurt disparaît des compteurs")
    assert 'status="aborted"' in amont


def test_les_trois_retours_enregistrent_tous():
    # Trois sorties du run (ok / tool_limit / échec) + l'enveloppe qui
    # enregistre un run annulé : quatre appels dans toute la boucle.
    assert compter_appels("record_turn_usage") == 4, \
        "les trois sorties (ok / tool_limit / échec) et l'annulation doivent enregistrer"


# ── 8. Une génération coupée ne fait pas exécuter un appel tronqué ─────────

def test_une_coupure_par_plafond_ninterdit_pas_la_recuperation_seulement():
    src = source_fonction("_llama_chat_with_tools_stream")
    i = src.index("_recovered = _recover_tool_calls_from_reasoning(")
    amont = src[max(0, i - 1600):i]
    assert '_tronque = (str(finish_reason or "") == "length")' in amont
    assert "and not _tronque" in amont, \
        "la promotion depuis le reasoning s'applique encore à un flux coupé"


def test_les_regex_de_secours_acceptent_bien_un_bloc_non_ferme():
    """Prémisse du constat : c'est cette tolérance qui rendait la promotion
    dangereuse sur un ``finish=length``."""
    from llm_core._tool_parsing import extract_tool_calls
    coupe = ('<function=write_file><parameter=path>/work/a.py</parameter>'
             '<parameter=content>def f():\n    return 1\n# le fichier est coup')
    res = extract_tool_calls(coupe)
    assert res and res[0][0] == "write_file"
    assert not res[0][1]["content"].endswith("\n"), "bloc tronqué, comme attendu"


# ── 10. La 2e reprise de prose garde sa frontière ──────────────────────────

def _rejouer_frontiere(segments):
    """Rejoue la logique de frontière de la boucle sur N segments."""
    from llm_core.engine.resume import _resume_prefix_join
    accumule = None
    for brut in segments:
        raw_exact = brut
        iter_clean = brut.strip()
        if accumule:
            iter_clean = accumule + iter_clean
        exact_strip = (raw_exact or "").strip()
        cr_raw = iter_clean
        if (iter_clean and raw_exact and exact_strip
                and iter_clean.rstrip().endswith(exact_strip)):
            cr_raw = _resume_prefix_join(iter_clean, raw_exact)
        accumule = cr_raw
    return accumule


def test_la_deuxieme_frontiere_de_reprise_garde_son_espace():
    """Segments du constat : « …en trois » puis « parties distinctes. » puis
    « Voici la suite. » donnait « distinctes.Voici »."""
    final = _rejouer_frontiere(["Je vais le faire en trois ",
                                "parties distinctes. ",
                                "Voici la suite."])
    assert final == "Je vais le faire en trois parties distinctes. Voici la suite.", \
        repr(final)


def test_la_garde_de_frontiere_teste_le_suffixe_pas_legalite():
    src = source_boucle()
    i = src.index("_cr_raw = _iter_clean or")
    bloc = src[i:i + 1600]
    assert "_raw_content_exact.strip() == _iter_clean.strip()" not in bloc, \
        "l'égalité stricte est de retour : fausse dès la 2e reprise"
    assert "_iter_clean.rstrip().endswith(_exact_strip)" in bloc


# ── 4. La compaction in-run passe par le sémaphore ─────────────────────────

def test_les_quatre_appels_llm_de_la_boucle_prennent_un_slot():
    src = source_boucle()
    assert "async def llm_slot(ctx" in src
    assert src.count("async with llm_slot(ctx):") == 2, \
        "les deux compactions in-run POSTent encore hors de tout slot"
    # 3 = l'appel outillé, le tour de synthèse et le helper ``llm_slot``
    # lui-même, tous via le gestionnaire du SERVEUR de la cible
    # (``engine_semaphore``) : ``LLM_SEMAPHORE`` pour l'intégré, celui du
    # connecteur llama.cpp sinon.
    assert src.count("async with engine_semaphore().acquire_for(") == 3, \
        "l'appel outillé et le tour de synthèse doivent garder leur acquire"


async def test_le_slot_est_un_no_op_en_mode_classic():
    """En classic, le caller tient déjà le sémaphore : le re-prendre serait un
    interblocage à concurrency=1."""
    bloc = source_fonction("llm_slot")
    assert "if ctx.inline_semaphore:" in bloc
    assert re.search(r"else:\s*\n\s*yield", bloc), "le mode classic doit céder sans slot"


# ── 53. L'import mort a disparu ────────────────────────────────────────────

def test_approx_prompt_tokens_nest_plus_importe_par_pruning():
    from llm_core.context import pruning as P
    # Commentaires retirés : la note qui EXPLIQUE le retrait nomme le symbole.
    src = "\n".join(l for l in inspect.getsource(P).splitlines()
                    if not l.strip().startswith("#"))
    assert "approx_prompt_tokens" not in src, (
        "l'import mort invite à réintroduire le ratio figé 3.3 dans une "
        "décision de budget")
    assert "count_messages_tokens_per_msg" in src
