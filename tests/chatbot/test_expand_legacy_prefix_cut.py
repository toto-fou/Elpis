# SPDX-License-Identifier: MIT
"""tests/chatbot/test_expand_legacy_prefix_cut.py

``_expand_history_for_llm`` coupe le préfixe déjà émis d'une ``tool_history``
LEGACY (cumulative) à partir de signatures composites. Les ids de repli des
providers sont DÉTERMINISTES et se répètent d'un tour à l'autre
(``providers/llamacpp.py`` émet ``call_{i}`` indexé sur la position dans la
réponse), donc un outil idempotent rappelé avec les mêmes arguments — ``ls``,
``git status``, ``read_file`` — reproduit une signature déjà vue.

Le piège : cette entrée « déjà vue » peut apparaître APRÈS du travail frais.
Une coupe qui retient le DERNIER index vu saute alors par-dessus le travail
neuf. Elle peut aussi tomber pile entre un ``assistant.tool_calls`` et son
résultat, laissant un message ``tool`` orphelin — que le provider rejette
en 400 (« génération interrompue »). Régression du finding C3 de l'audit
2026-08-01.
"""
from __future__ import annotations

from chatbot_app.routes.chats import _expand_history_for_llm


def _tc(call_id: str, name: str, args: str) -> dict:
    return {"role": "assistant", "content": "",
            "tool_calls": [{"id": call_id, "type": "function",
                            "function": {"name": name, "arguments": args}}]}


def _res(call_id: str, content: str) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": content}


def _assert_no_orphan_tool(out: list) -> None:
    """Contrat provider : un message ``tool`` suit son ``assistant.tool_calls``
    — soit directement, soit derrière d'autres ``tool`` du MÊME bloc."""
    current_block: set = set()
    for i, m in enumerate(out):
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            current_block = {tc.get("id") for tc in m["tool_calls"]}
        elif role == "tool":
            assert m.get("tool_call_id") in current_block, (
                f"message {i} : résultat d'outil orphelin "
                f"({m.get('tool_call_id')!r}) — son assistant.tool_calls ne le "
                f"précède pas dans le même bloc → 400 provider"
            )
        else:
            current_block = set()


def test_collision_apres_travail_frais_ne_coupe_pas_le_travail_frais():
    """Tour 2 : l'agent fait d'abord un ``deploy`` FRAIS, puis rejoue ``ls``
    à l'identique (même id de repli, mêmes arguments, même sortie).

    L'entrée collisionnée est donc APRÈS le travail frais : retenir le dernier
    index vu place la coupe au-delà de ``deploy``, qui disparaît de la vue du
    modèle.
    """
    hist_tour1 = [
        _tc("call_0", "ls", '{"path":"/work"}'),
        _res("call_0", "a.txt\nb.txt"),
    ]
    hist_tour2 = hist_tour1 + [
        # travail FRAIS du tour 2
        _tc("call_1", "deploy", '{"env":"prod"}'),
        _res("call_1", "deployed"),
        # puis un `ls` rejoué à l'identique → signature déjà vue, EN QUEUE
        _tc("call_0", "ls", '{"path":"/work"}'),
        _res("call_0", "a.txt\nb.txt"),
    ]

    messages = [
        {"role": "user", "content": "étape 1"},
        {"role": "assistant", "content": "fait", "tool_history": hist_tour1},
        {"role": "user", "content": "étape 2"},
        {"role": "assistant", "content": "fini", "tool_history": hist_tour2},
    ]

    out = _expand_history_for_llm(messages)
    blob = repr(out)

    assert "deploy" in blob, (
        "le travail FRAIS du tour 2 a été coupé : la coupe a sauté par-dessus "
        "parce qu'un `ls` rejoué à l'identique se trouvait plus loin"
    )
    _assert_no_orphan_tool(out)


def test_coupe_entre_un_appel_et_son_resultat():
    """L'appel est rejoué à l'identique mais son RÉSULTAT diffère (fichier
    modifié entre-temps) : la signature de l'appel est vue, celle du résultat
    non → la coupe tombe pile entre les deux et émet un ``tool`` orphelin."""
    hist_tour1 = [
        _tc("call_0", "read_file", '{"path":"/work/a.txt"}'),
        _res("call_0", "ancien-contenu"),
    ]
    hist_tour2 = hist_tour1 + [
        _tc("call_0", "read_file", '{"path":"/work/a.txt"}'),
        _res("call_0", "NOUVEAU-contenu"),
    ]
    messages = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "x", "tool_history": hist_tour1},
        {"role": "user", "content": "b"},
        {"role": "assistant", "content": "y", "tool_history": hist_tour2},
    ]

    out = _expand_history_for_llm(messages)
    _assert_no_orphan_tool(out)


def test_delta_non_affecte():
    """Le format DELTA est expansé intégralement, sans passer par la coupe."""
    hist = [
        _tc("call_0", "ls", "{}"),
        _res("call_0", "out"),
    ]
    messages = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "x",
         "tool_history": hist, "tool_history_delta": True},
    ]
    out = _expand_history_for_llm(messages)
    assert any(m.get("role") == "tool" for m in out)
    _assert_no_orphan_tool(out)


def test_prefixe_contigu_toujours_coupe():
    """Garde-fou anti-régression inverse : quand le préfixe rejoué est bien en
    tête et contigu, il DOIT toujours être coupé (sinon le payload double à
    chaque tour, le défaut que cette dédup existe pour corriger)."""
    hist_tour1 = [
        _tc("call_0", "ls", '{"path":"/work"}'),
        _res("call_0", "a.txt"),
    ]
    hist_tour2 = hist_tour1 + [
        _tc("call_1", "deploy", '{"env":"prod"}'),
        _res("call_1", "deployed"),
    ]
    messages = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "x", "tool_history": hist_tour1},
        {"role": "user", "content": "b"},
        {"role": "assistant", "content": "y", "tool_history": hist_tour2},
    ]
    out = _expand_history_for_llm(messages)
    # `ls` n'est émis qu'UNE fois au total (tour 1), pas re-émis par le tour 2.
    n_ls = sum(1 for m in out
               if m.get("role") == "assistant"
               and any((tc.get("function") or {}).get("name") == "ls"
                       for tc in (m.get("tool_calls") or [])))
    assert n_ls == 1, f"le préfixe contigu n'a pas été coupé (ls émis {n_ls}×)"
    _assert_no_orphan_tool(out)
