# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_compaction_user_anchor_2026_08_22.py — « Le modèle a
refusé la requête telle qu'elle a été construite », 2ᵉ occurrence.

Panne observée en production (chat ``ornith-1.0-9b``, journal ``llm_calls``
16786→16790) : une mission agentique de 54 messages est compactée en cours de
run ; l'historique reconstruit ne contient plus AUCUN message ``user`` —
seulement ``system`` puis quatorze paires (assistant, tool). llama-server
répond 500 quatre fois (l'appel + les trois relances de hoquet), puis le filet
d'aplatissement produit quatorze messages ``assistant`` CONSÉCUTIFS terminés
par un assistant, que les builds récents refusent en 400 : c'est ce 400 que
l'utilisateur lit.

Cause racine : un « tour » au sens du compresseur s'ouvre aussi sur un
assistant qui appelle un outil. Sur une boucle agentique — un seul ``user``
pour cinquante cycles d'outils — la fenêtre conservée ne contient que des
paires (assistant, tool) et l'énoncé de la mission part au résumé. Le modèle
perd du même coup ce qu'on lui demandait.

Les tests ci-dessous verrouillent les trois étages du correctif :
  1. la compaction ré-épingle l'ancre de tâche (et ne fausse pas
     ``covered_turns`` en le faisant) ;
  2. ``sanitize_message_history`` refuse de laisser passer un historique
     sans ``user`` — filet commun à tous les chemins de réduction ;
  3. l'aplatissement produit une forme conversationnelle stricte.
"""
from __future__ import annotations

import pytest

from llm_core._chat_with_tools import _flatten_tool_messages
from llm_core.context.pruning import (
    sanitize_message_history,
    task_anchor_index,
)
from llm_core.conversation_compressor import (
    ConversationCompressor,
    _anchor_pin,
    _count_turns,
    _pin_task_anchor,
    _split_by_turn_index,
)

_MISSION = ("Le but est de tester sur un long run les tools pour voir si le "
            "harness tient la route.")


def _mission_history(cycles: int = 20):
    """1 system + 1 user + ``cycles`` × (assistant tool_call, tool result)."""
    msgs = [{"role": "system", "content": "socle"},
            {"role": "user", "content": _MISSION}]
    for i in range(cycles):
        msgs.append({
            "role": "assistant", "content": None,
            "tool_calls": [{"id": f"c{i}", "type": "function",
                            "function": {"name": "execute_shell",
                                         "arguments": "{}"}}],
        })
        msgs.append({"role": "tool", "tool_call_id": f"c{i}",
                     "content": f"résultat {i} " + "x" * 200})
    return msgs


# ─────────────────────────────────────────────────────────────────────────────
#  1 — la compaction ré-épingle l'énoncé de la mission
# ─────────────────────────────────────────────────────────────────────────────
def test_la_fenetre_conservee_perd_bien_lenonce_sans_correctif():
    """Le mécanisme de la panne, isolé : sur une boucle agentique la zone
    « recent » ne contient QUE des paires (assistant, tool)."""
    _sys, to_compress, bridge, recent = _split_by_turn_index(
        _mission_history(), keep_recent_turns=6, keep_bridge_turns=3)
    assert any(m.get("role") == "user" for m in to_compress)
    assert not any(m.get("role") == "user" for m in bridge + recent), (
        "prémisse du test caduque : la fenêtre conservée porte déjà un user")


async def test_la_compaction_rend_toujours_un_historique_avec_un_user():
    async def _fake_llm(messages, **kwargs):
        return ("## Contexte\nMission de test du harnais.\n"
                "## Fait\nVingt cycles d'outils exécutés.", {})

    c = ConversationCompressor(_fake_llm, keep_recent_turns=6,
                               keep_bridge_turns=3)
    out, stats = await c.compress(
        _mission_history(),
        precomputed_tokens_before=(50_000, True),
        count_exact=False,
    )
    assert stats.get("compressed"), stats
    users = [m for m in out if m.get("role") == "user"]
    assert users, (
        "historique compacté sans aucun message user : les gabarits à "
        "alternance stricte répondent 500 au rendu et le modèle a oublié "
        "ce qu'on lui demande")
    assert _MISSION in str(users[0].get("content")), (
        "l'ancre posée ne porte pas l'énoncé réel de la mission")
    # Elle est posée juste après le résumé, donc AVANT les tours conservés.
    assert out.index(users[0]) < len(out) - 1


def test_lancre_repinglee_ne_compte_pas_comme_un_tour():
    """Sinon ``covered_turns`` sur-compte et ``_drop_leading_turns`` jette un
    vrai tour EN TROP à chaque round, au tour suivant."""
    base = [{"role": "user", "content": "vraie demande"},
            {"role": "assistant", "content": "réponse"}]
    assert _count_turns(base + [_anchor_pin("mission")]) == _count_turns(base)


def test_lancre_deja_presente_ne_declenche_aucun_epinglage():
    kept = [{"role": "user", "content": "demande"},
            {"role": "assistant", "content": "ok"}]
    assert _pin_task_anchor(kept, [{"role": "user", "content": "vieux"}]) == []


def test_un_round_suivant_reconnait_lancre_au_lieu_de_la_remplacer():
    """2ᵉ compaction du même run : l'ancre épinglée au round 1 est repartie au
    résumé. Elle doit être RECONNUE comme source (l'énoncé survit) et non
    remplacée par le texte de repli."""
    pin = _anchor_pin(_MISSION)
    out = _pin_task_anchor([{"role": "assistant", "content": "suite"}], [pin])
    assert out and _MISSION in out[0]["content"]


def test_sans_aucune_ancre_nulle_part_un_repli_est_pose():
    out = _pin_task_anchor([{"role": "assistant", "content": "suite"}], [])
    assert out and out[0]["role"] == "user" and out[0]["content"].strip()


def test_le_budget_dur_protege_lancre_repinglee():
    msgs = [{"role": "system", "content": "s"}, _anchor_pin(_MISSION),
            {"role": "assistant", "content": "a"}]
    assert task_anchor_index(msgs) == 1, (
        "l'ancre ré-épinglée n'est pas protégée par le budget dur : elle "
        "serait la première jetée, et on retombe sur la panne d'origine")


# ─────────────────────────────────────────────────────────────────────────────
#  2 — filet universel : jamais d'historique sans ``user``
# ─────────────────────────────────────────────────────────────────────────────
def test_sanitize_pose_une_ancre_quand_lhistorique_na_plus_de_user():
    msgs = [{"role": "system", "content": "socle"},
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "c1", "type": "function",
                             "function": {"name": "read_file",
                                          "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "ok"}]
    out = sanitize_message_history(msgs)
    roles = [m["role"] for m in out]
    assert "user" in roles
    assert roles.index("user") == 1, "l'ancre doit suivre le bloc system"
    assert out[1].get("_ephemeral"), (
        "une ancre synthétique persistée fausserait le comptage des tours")


def test_sanitize_reste_idempotente_avec_lancre():
    msgs = [{"role": "system", "content": "socle"},
            {"role": "assistant", "content": "a"}]
    once = sanitize_message_history(msgs)
    assert sanitize_message_history(once) == once, (
        "l'ancre est re-posée à chaque passe : le préfixe KV bougerait à "
        "chaque tour")


def test_sanitize_ne_touche_pas_un_historique_sans_echange():
    msgs = [{"role": "system", "content": "socle"}]
    assert sanitize_message_history(msgs) == msgs


def test_sanitize_ne_touche_pas_un_historique_normal():
    msgs = [{"role": "system", "content": "s"},
            {"role": "user", "content": "salut"},
            {"role": "assistant", "content": "bonjour"}]
    assert sanitize_message_history(msgs) == msgs


# ─────────────────────────────────────────────────────────────────────────────
#  3 — l'aplatissement de secours doit être ACCEPTÉ par le moteur
# ─────────────────────────────────────────────────────────────────────────────
def _flat(cycles: int = 5):
    return _flatten_tool_messages(_mission_history(cycles))


def test_laplatissement_ne_termine_jamais_par_un_assistant():
    """Un assistant final est lu comme un « prefill » à continuer par les
    llama-server récents ; deux à la queue = 400 sec — donc la voie de
    récupération du run échouait à tous les coups."""
    out = _flat()
    assert out[-1]["role"] != "assistant"


def test_laplatissement_nempile_jamais_deux_messages_du_meme_role():
    roles = [m["role"] for m in _flat() if m["role"] != "system"]
    assert all(a != b for a, b in zip(roles, roles[1:])), roles


def test_laplatissement_ne_laisse_ni_tool_ni_tool_calls():
    out = _flat()
    assert all(m["role"] != "tool" and not m.get("tool_calls") for m in out)


def test_laplatissement_conserve_lenonce_et_les_resultats():
    out = _flat(3)
    joined = "\n".join(str(m.get("content") or "") for m in out)
    assert _MISSION in joined
    assert "résultat 2" in joined
    assert "execute_shell" in joined


def test_laplatissement_dun_historique_sans_user_en_fabrique_un():
    out = _flatten_tool_messages([
        {"role": "system", "content": "socle"},
        {"role": "assistant", "content": "réponse seule"},
    ])
    assert any(m["role"] == "user" for m in out)
    assert out[-1]["role"] == "user"


@pytest.mark.parametrize("cycles", [1, 5, 20])
def test_laplatissement_est_stable_quelle_que_soit_la_longueur(cycles):
    out = _flat(cycles)
    assert out[0]["role"] == "system"
    assert out[-1]["role"] != "assistant"
    assert any(m["role"] == "user" for m in out)


# ─────────────────────────────────────────────────────────────────────────────
#  4 — filets de FORME au point d'envoi (llm_core/providers/llamacpp.py)
#
#  Les deux refus ci-dessous ont été REJOUÉS contre llama-server b10545 avec
#  les payloads réels du run mort (journal ``llm_calls`` 16789 et 16790) :
#     500 server_error … raise_exception('No user query found in messages.')
#     400 invalid_request_error: Cannot have 2 or more assistant messages at
#         the end of the list.
#  Les mêmes payloads normalisés par ``build_llama_payload`` passent en 200.
#  Ces filets vivent au point d'envoi parce que la queue de REPRISE est
#  ajoutée APRÈS la vue d'envoi : un correctif posé plus haut ne la couvre pas.
# ─────────────────────────────────────────────────────────────────────────────
from llm_core.providers.llamacpp import (  # noqa: E402
    _coalesce_trailing_assistants,
    _ensure_user_query,
)


def test_le_point_denvoi_garantit_une_requete_utilisateur():
    msgs = [{"role": "system", "content": "socle"},
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "c1", "type": "function",
                             "function": {"name": "f", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "ok"}]
    out = _ensure_user_query(msgs)
    assert [m["role"] for m in out][:2] == ["system", "user"]


def test_le_point_denvoi_ne_touche_pas_un_historique_normal():
    msgs = [{"role": "system", "content": "s"},
            {"role": "user", "content": "salut"},
            {"role": "assistant", "content": "bonjour"}]
    assert _ensure_user_query(msgs) is msgs
    assert _coalesce_trailing_assistants(msgs) is msgs


def test_le_point_denvoi_ne_fabrique_rien_sans_echange():
    msgs = [{"role": "system", "content": "socle"}]
    assert _ensure_user_query(msgs) is msgs


def test_deux_assistants_en_queue_sont_fusionnes():
    msgs = [{"role": "user", "content": "q"},
            {"role": "assistant", "content": "un"},
            {"role": "assistant", "content": "deux"}]
    out = _coalesce_trailing_assistants(msgs)
    assert len(out) == 2
    assert out[-1]["content"] == "un\n\ndeux"


def test_la_fusion_preserve_les_cles_de_reprise():
    """``reasoning_content`` porte la reprise native : le perdre ferait
    repartir le raisonnement de zéro."""
    msgs = [{"role": "user", "content": "q"},
            {"role": "assistant", "content": "texte"},
            {"role": "assistant", "content": "",
             "reasoning_content": "je réfléchis"}]
    out = _coalesce_trailing_assistants(msgs)
    assert len(out) == 2
    assert out[-1]["reasoning_content"] == "je réfléchis"


def test_un_seul_assistant_final_est_laisse_intact():
    """C'est la forme du prefill que le serveur ATTEND (reprise) — y toucher
    casserait « Continuer »."""
    msgs = [{"role": "user", "content": "q"},
            {"role": "assistant", "content": "",
             "reasoning_content": "en cours"}]
    assert _coalesce_trailing_assistants(msgs) is msgs


def test_laplatissement_patche_passe_les_deux_filets():
    """Bout en bout : la sortie du filet d'aplatissement ne doit déclencher
    AUCUNE correction au point d'envoi (elle est déjà conforme)."""
    flat = _flatten_tool_messages(_mission_history(4))
    assert _ensure_user_query(flat) is flat
    assert _coalesce_trailing_assistants(flat) is flat
