# SPDX-License-Identifier: MIT
"""tests/chatbot/test_notice_roundtrip.py — le marqueur ``notice`` survit au
round-trip client.

Une notice (« Conversation compactée — contexte ≈ N tokens ») est écrite en base
par la compaction, relue au chargement du chat, puis RENVOYÉE par le client dans
le payload du tour suivant. Elle était alors jetée par le filtre de rôles
(``_CLIENT_ROLES``), et comme la persistance de fin de tour repart de la liste
filtrée, le marqueur disparaissait du fil au message suivant. Le code qui
préservait ses champs structurés (``kind``/``ts``/``round``/``tokens_after``/
``summary``) était, de ce fait, mort.

Ces tests ÉCHOUENT sur le code d'avant le correctif.

La contrepartie du fix est que ``msgs`` peut désormais se terminer par une
notice : la fusion « Continue », qui regardait ``msgs[-1]``, doit chercher le
dernier message NON-notice — sinon un Continue lancé juste après une compaction
laisse deux bulles assistant, exactement le défaut que cette fusion évite.
"""
from __future__ import annotations

import pytest

from chatbot_app.turn.history import (
    _CLIENT_ROLES,
    _expand_history_for_llm,
    _normalize_client_messages,
    _split_for_continue,
)


def _notice(**kw):
    base = {
        "role": "notice", "kind": "compaction", "ts": 1755300000.0, "round": 2,
        "tokens_after": 12345,
        "content": "Conversation compactée — contexte ≈ 12 345 tokens",
        "summary": "<summary>…</summary>",
    }
    base.update(kw)
    return base


# ── Le bug ───────────────────────────────────────────────────────────────

def test_la_notice_traverse_le_filtre_de_roles():
    """LE bug : le rôle était absent de la whitelist, la notice tombait."""
    assert "notice" in _CLIENT_ROLES
    filtres, _ = _normalize_client_messages([{"role": "user", "content": "salut"}, _notice()])
    assert [m["role"] for m in filtres] == ["user", "notice"]


def test_la_notice_est_dans_ce_qui_sera_persiste():
    """C'est la liste *persistables* qui est réécrite en base à la fin du
    tour : si la notice n'y est pas, elle est effacée du fil."""
    _, persistables = _normalize_client_messages([
        {"role": "user", "content": "salut"},
        {"role": "assistant", "content": "bonjour"},
        _notice(),
    ])
    assert [m["role"] for m in persistables] == ["user", "assistant", "notice"]


@pytest.mark.parametrize("champ,valeur", [
    ("kind", "compaction"), ("ts", 1755300000.0), ("round", 2),
    ("tokens_after", 12345), ("summary", "<summary>…</summary>"),
])
def test_les_champs_structures_sont_preserves(champ, valeur):
    """Ce sont eux qui font vivre l'accordéon de vérification et le
    « contexte ≈ N tokens » après un rechargement."""
    _, persistables = _normalize_client_messages([_notice(), {"role": "user", "content": "x"}])
    assert persistables[0][champ] == valeur


def test_le_contenu_de_la_notice_est_conserve():
    _, persistables = _normalize_client_messages([_notice(), {"role": "user", "content": "x"}])
    assert "compactée" in persistables[0]["content"]


def test_champ_absent_non_invente():
    """Une notice sans ``summary`` ne doit pas se voir attribuer un None."""
    n = _notice()
    del n["summary"]
    _, persistables = _normalize_client_messages([n, {"role": "user", "content": "x"}])
    assert "summary" not in persistables[0]


def test_deux_tours_consecutifs_apres_compaction():
    """Le scénario exact du bug, joué de bout en bout.

    Tour N : la compaction écrit la notice en base. Tour N+1 : le client
    renvoie le fil (notice comprise), le serveur normalise puis persiste
    ``msgs + [assistant]``. Tour N+2 : idem. Avant le correctif, la notice
    tombait dès la normalisation du tour N+1 et n'était donc plus jamais
    réécrite — elle disparaissait du fil.
    """
    # État en base après la compaction du tour N.
    en_base = [{"role": "user", "content": "q1"},
               {"role": "assistant", "content": "r1"},
               _notice()]

    for tour in ("q2", "q3"):
        payload = en_base + [{"role": "user", "content": tour}]
        _, msgs = _normalize_client_messages(payload)
        prev, avant, apres = _split_for_continue(msgs)   # pas un Continue
        assert prev == {}
        en_base = msgs + [{"role": "assistant", "content": "réponse " + tour}]

    roles = [m["role"] for m in en_base]
    assert roles.count("notice") == 1, "la notice a été perdue ou dupliquée"
    assert roles == ["user", "assistant", "notice",
                     "user", "assistant", "user", "assistant"]
    notice = next(m for m in en_base if m["role"] == "notice")
    assert notice["tokens_after"] == 12345      # champs intacts après 2 tours
    assert notice["round"] == 2


# ── La notice ne doit JAMAIS atteindre le modèle ─────────────────────────

def test_exclue_de_la_vue_llm():
    """Rôle inconnu côté template ⇒ 400 Jinja. L'exclusion existait déjà,
    ce test la verrouille maintenant que la notice arrive vraiment jusque-là.
    """
    out = _expand_history_for_llm([
        {"role": "user", "content": "salut"},
        {"role": "assistant", "content": "bonjour"},
        _notice(),
        {"role": "user", "content": "suite"},
    ])
    assert all(m["role"] != "notice" for m in out)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]


def test_aucun_champ_de_notice_ne_fuit_dans_la_vue_llm():
    out = _expand_history_for_llm([_notice(), {"role": "user", "content": "x"}])
    assert not any("tokens_after" in m or "kind" in m for m in out)


# ── Les rôles réellement invalides restent refusés ───────────────────────

@pytest.mark.parametrize("role", ["bogus", "", None, "function", "developer"])
def test_roles_inconnus_toujours_rejetes(role):
    filtres, _ = _normalize_client_messages([
        {"role": role, "content": "x"}, {"role": "user", "content": "ok"}])
    assert [m["role"] for m in filtres] == ["user"]


def test_contenu_de_type_invalide_rejete():
    filtres, _ = _normalize_client_messages([
        {"role": "user", "content": {"pas": "une string"}},
        {"role": "user", "content": "ok"}])
    assert len(filtres) == 1


def test_non_dicts_ignores():
    filtres, _ = _normalize_client_messages(["texte", None, 42, {"role": "user", "content": "ok"}])
    assert len(filtres) == 1


# ── Non-régression : les autres champs round-trippés ─────────────────────

def test_tool_history_et_compagnie_preserves():
    """Ne PAS stripper reste la règle : un strip effaçait l'historique
    d'outils des tours précédents à chaque persist."""
    _, persistables = _normalize_client_messages([{
        "role": "assistant", "content": "fait",
        "tool_history": [{"name": "read_file"}], "tool_history_delta": True,
        "thinking": "hmm", "images": [{"dataUrl": "data:,x"}],
    }])
    m = persistables[0]
    assert m["tool_history"] == [{"name": "read_file"}]
    assert m["tool_history_delta"] is True
    assert m["thinking"] == "hmm"
    assert m["images"] == [{"dataUrl": "data:,x"}]


def test_champ_tools_toujours_strippe():
    _, persistables = _normalize_client_messages([
        {"role": "assistant", "content": "x", "tools": ["fs"], "isTruncated": True}])
    assert "tools" not in persistables[0]


# ── La contrepartie : « Continue » après une compaction ──────────────────

def test_continue_trouve_lassistant_sous_la_notice():
    """Le cas que le fix CRÉE : une notice ferme le fil, la fusion doit
    quand même viser le dernier assistant."""
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "réponse tronquée"},
        _notice(),
    ]
    prev, avant, apres = _split_for_continue(msgs)
    assert prev["content"] == "réponse tronquée"
    assert [m["role"] for m in avant] == ["user"]
    assert [m["role"] for m in apres] == ["notice"]


def test_continue_sans_notice_inchange():
    msgs = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
    prev, avant, apres = _split_for_continue(msgs)
    assert prev["content"] == "a"
    assert [m["role"] for m in avant] == ["user"]
    assert apres == []


def test_continue_plusieurs_notices_en_queue():
    msgs = [{"role": "assistant", "content": "a"}, _notice(), _notice(round=3)]
    prev, avant, apres = _split_for_continue(msgs)
    assert prev["content"] == "a"
    assert avant == []
    assert len(apres) == 2


@pytest.mark.parametrize("msgs", [
    [],
    [_notice()],
    [{"role": "user", "content": "q"}],
    [{"role": "assistant", "content": "a"}, {"role": "user", "content": "q"}],
])
def test_continue_ne_fusionne_rien_hors_cas_nominal(msgs):
    """Pas d'assistant en queue ⇒ aucune fusion, et la liste d'origine est
    rendue telle quelle (l'appelant persiste alors ``msgs + [assistant]``)."""
    prev, avant, apres = _split_for_continue(msgs)
    assert prev == {}
    assert avant is msgs
    assert apres == []


def test_lordre_du_fil_est_preserve_apres_fusion():
    """La notice ne doit pas sauter dans le fil : on la replace APRÈS le
    message fusionné, à la position qu'elle occupait vis-à-vis de lui."""
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "tronqué"},
        _notice(),
    ]
    prev, avant, apres = _split_for_continue(msgs)
    fusionne = {"role": "assistant", "content": prev["content"] + " suite"}
    full = avant + [fusionne] + apres
    assert [m["role"] for m in full] == ["user", "assistant", "notice"]
    assert full[1]["content"] == "tronqué suite"
