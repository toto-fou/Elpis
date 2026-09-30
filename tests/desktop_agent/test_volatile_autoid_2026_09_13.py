# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_volatile_autoid_2026_09_13.py — auto_id « view_N »
volatils (Chromium/WebView2 : Edge, Chrome, Electron). Ils sont réassignés à
chaque relance : le runtime les traite comme un INDICE (pas une correspondance
qui prime), les suggère jamais comme identité, et ne les met pas dans le libellé.
Vu sur la VM : un wait sur `auto_id="view_3"` d'Edge cassait au replay. Backend factice.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_AGENT = str(Path(__file__).resolve().parents[2] / "desktop-agent")
if _AGENT not in sys.path:
    sys.path.insert(0, _AGENT)

from elpis_auto import Session, Target  # noqa: E402
from elpis_auto.session import _anchorable, _volatile_id, node_identity  # noqa: E402
from test_elpis_auto import FakeBackend, _calls, _node  # noqa: E402


def test_detection_view_n():
    assert _volatile_id("view_3") and _volatile_id("view_1021") and _volatile_id("VIEW_9")
    assert not _volatile_id("okBtn") and not _volatile_id("") and not _volatile_id("viewport") and not _volatile_id("view_")


def EDGE(maximered=True):
    # au replay : view_3 existe mais désigne un AUTRE contrôle ; le bouton attendu
    # « Agrandir » est devenu « Restaurer » (fenêtre maximisée) sous un autre id.
    return [
        _node("window", "Nouvel onglet - Microsoft Edge", 0, 0, 1600, 1000, auto_id=""),
        _node("button", "Réduire", 1462, 0, 46, 40, auto_id="view_2"),
        _node("button", "Restaurer" if maximered else "Agrandir", 1508, 0, 46, 40, auto_id="view_4"),
        _node("button", "Recharger", 20, 60, 30, 30, auto_id="view_3"),   # view_3 réutilisé ailleurs !
        _node("textbox", "Barre d’adresse et de recherche", 300, 55, 900, 30, auto_id="view_1021"),
    ]


@pytest.fixture
def s(tmp_path):
    return Session(backend=FakeBackend(nodes=EDGE()), report_dir=str(tmp_path), name="edge", settle=0, timeout=0.3)


def test_view_n_ne_prime_pas_sur_le_nom(s):
    # cible enregistrée : auto_id volatil + nom + rôle. view_3 pointe un AUTRE contrôle
    # au replay → on ne doit PAS le renvoyer ; ici « Agrandir » a disparu → introuvable
    # (plutôt que cliquer « Recharger » par un id réutilisé).
    n = s.find(Target.of(auto_id="view_3", name="Agrandir", role="button"))
    assert n is None, "id volatil réutilisé + nom absent → introuvable, pas le mauvais contrôle"
    # avec le bon nom présent, l'id volatil qui matche le bon contrôle est accepté
    n2 = s.find(Target.of(auto_id="view_4", name="Restaurer", role="button"))
    assert n2 is not None and n2["name"] == "Restaurer" and s.resolved_by == "auto_id"


def test_view_n_seul_reste_un_repli(s):
    # sans nom, un auto_id volatil sert quand même (rien de mieux)
    n = s.find(Target.of(auto_id="view_1021"))
    assert n is not None and n["name"].startswith("Barre")


def test_repli_sur_le_nom_quand_view_n_a_bouge(tmp_path):
    # la barre d'adresse : nom stable, id volatil view_1021 → si l'id a bougé, le nom sauve
    nodes = EDGE()
    nodes[4]["auto_id"] = "view_2048"   # l'id a changé au replay
    s = Session(backend=FakeBackend(nodes=nodes), report_dir=str(tmp_path), name="edge", settle=0, timeout=0.3)
    n = s.find(Target.of(auto_id="view_1021", name="Barre d’adresse et de recherche", role="textbox"))
    assert n is not None and s.resolved_by == "name", "id volatil absent → retrouvé par le nom"


def test_node_identity_evite_view_n():
    nodes = EDGE()
    addr = nodes[4]
    ident = node_identity(nodes, addr)
    assert ident == {"name": "Barre d’adresse et de recherche", "role": "textbox"}, "suggère le nom, pas view_1021"
    assert not _anchorable(nodes, {"auto_id": "view_9", "name": "", "role": "button"})


def test_label_prefere_le_nom(s):
    assert Target.of(auto_id="view_3", name="Agrandir", role="button").label() == "« Agrandir » (button)"
    assert Target.of(auto_id="view_3").label() == "#view_3", "sans nom : l'id volatil reste le libellé"
    assert Target.of(auto_id="okBtn").label() == "#okBtn"
