# SPDX-License-Identifier: MIT
"""Mode plan ONE-SHOT — la décision de sortie automatique (2026-08-16).

« /plan » couvre UN tour abouti : le plan rendu, le serveur coupe le mode
lui-même (``set_chat_plan_mode(False)`` + ``plan_mode_done`` dans le 'final').
La décision vit dans ``_plan_mode_should_end`` (module-level, testable — même
convention que ``_split_for_continue``) ; ces tests verrouillent sa matrice.

Le point de sûreté central : une TRONCATURE ne coupe PAS le mode — le
« Continuer » doit reprendre EN mode plan, sinon la fin du plan repartirait
avec les outils d'écriture sous un témoin qui annonce l'inverse.
"""
from __future__ import annotations

import pytest

from chatbot_app.routes.chats import _plan_mode_should_end


def test_tour_abouti_coupe_le_mode():
    assert _plan_mode_should_end(True, True, False, {"truncated": False}) is True


def test_metrics_absentes_coupe_quand_meme():
    """Un connecteur sans metrics ne doit pas rendre le mode immortel."""
    assert _plan_mode_should_end(True, True, False, None) is True


def test_hors_mode_plan_jamais():
    assert _plan_mode_should_end(False, True, False, {}) is False


@pytest.mark.parametrize("metrics", [
    {"truncated": True},
    {"tool_limit_reached": True},
    {"truncated": True, "tool_limit_reached": True},
])
def test_troncature_garde_le_mode(metrics):
    """LE cas de sûreté : plan coupé par le plafond → le Continue doit
    repartir SANS outils d'écriture, donc le mode reste posé en base."""
    assert _plan_mode_should_end(True, True, False, metrics) is False


def test_persist_en_echec_garde_le_mode():
    """Conflit optimiste = un tour concurrent écrit sur ce chat : on ne mute
    pas son meta_json sous lui."""
    assert _plan_mode_should_end(True, False, False, {}) is False


def test_ephemere_ne_touche_pas_la_base():
    assert _plan_mode_should_end(True, True, True, {}) is False


def test_la_route_relaie_la_decision():
    """Garde anti-dérive : le bloc appelant existe bien dans la route (un
    refactor qui perdrait l'appel rendrait le mode permanent en silence)."""
    import inspect

    import chatbot_app.routes.chats as c
    src = inspect.getsource(c)
    assert "_plan_mode_should_end(_plan_mode, _persisted, ephemeral, metrics)" in src
    assert '"plan_mode_done": True' in src
