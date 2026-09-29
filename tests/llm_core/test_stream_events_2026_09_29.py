# SPDX-License-Identifier: MIT
"""Registre des événements du flux NDJSON (llm_core/engine/stream_events.py) :
rien n'est émis ni lu hors registre, et chaque type a un lecteur dans
l'interface ou figure dans NOT_DISPLAYED (2026-09-29)."""
from __future__ import annotations

import re
from pathlib import Path

from llm_core.engine.stream_events import LOOP_EVENTS, NOT_DISPLAYED, STREAM_EVENTS

ROOT = Path(__file__).resolve().parents[2]


def _lus_par_l_interface() -> set:
    src = (ROOT / "frontend" / "js" / "app-chat.js").read_text(encoding="utf-8")
    debut = src.index("    async function handleStreamEvent(data) {")
    fin = src.index("\n    }\n", debut)
    lus = set(re.findall(r"data\.type === '([a-z_]+)'", src[debut:fin]))
    lus |= set(re.findall(r"\bt === '([a-z_]+)'", src))          # boucle de lecture
    return lus


def _emis_par_la_route() -> set:
    src = (ROOT / "chatbot_app" / "routes" / "chats.py").read_text(encoding="utf-8")
    return set(re.findall(r'"type": "([a-z_]+)"', src))


def test_groupes_inclus_dans_le_registre():
    assert LOOP_EVENTS <= STREAM_EVENTS.keys()
    assert NOT_DISPLAYED <= STREAM_EVENTS.keys()


def test_l_interface_ne_lit_que_des_types_du_registre():
    assert _lus_par_l_interface() - STREAM_EVENTS.keys() == set()


def test_la_route_n_emet_que_des_types_du_registre():
    assert _emis_par_la_route() - STREAM_EVENTS.keys() == set()


def test_chaque_type_a_un_lecteur_ou_est_declare_non_affiche():
    sans_lecteur = STREAM_EVENTS.keys() - _lus_par_l_interface() - NOT_DISPLAYED
    assert sans_lecteur == set(), (
        f"{sorted(sans_lecteur)} : ni lus par l'interface, ni dans NOT_DISPLAYED")
    assert not (NOT_DISPLAYED & _lus_par_l_interface()), "NOT_DISPLAYED périmé"
