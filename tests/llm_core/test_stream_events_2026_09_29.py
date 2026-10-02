# SPDX-License-Identifier: MIT
"""Registre des événements du flux NDJSON (llm_core/engine/stream_events.py) :
rien n'est lu par l'interface, ni émis par la route ou le journal
d'exécution, hors registre ; chaque type a un émetteur, et un lecteur dans
l'interface ou une place dans NOT_DISPLAYED (2026-09-29)."""
from __future__ import annotations

import re
from pathlib import Path

from llm_core.engine.stream_events import LOOP_EVENTS, NOT_DISPLAYED, STREAM_EVENTS
from tests._sources import code_seul, source_flux_chat

ROOT = Path(__file__).resolve().parents[2]
# Émetteurs hors boucle : la route du tour (tous ses modules, où qu'ils
# vivent) et le journal d'exécution ; ceux de la boucle sont vérifiés par les
# goldens de test_event_contract.py.
JOURNAL = ROOT / "shared_infra" / "runtime" / "run_journal.py"


def _corps(src: str, entete: str) -> str:
    """Corps d'une fonction de premier niveau d'app-chat.js (indentation 4)."""
    debut = src.index(entete)
    return src[debut:src.index("\n    }\n", debut)]


def _lus_par_l_interface() -> set:
    src = (ROOT / "frontend" / "js" / "app-chat.js").read_text(encoding="utf-8")
    lus = set(re.findall(r"data\.type === '([a-z_]+)'",
                         _corps(src, "    async function handleStreamEvent(data) {")))
    lus |= set(re.findall(r"\bt === '([a-z_]+)'",
                          _corps(src, "    async function attachRun(")))
    return lus


def _emis_hors_boucle() -> set:
    code = source_flux_chat() + "\n" + code_seul(JOURNAL.read_text(encoding="utf-8"))
    return set(re.findall(r'"type": "([a-z_]+)"', code))


def test_groupes_inclus_dans_le_registre():
    assert LOOP_EVENTS <= STREAM_EVENTS.keys()
    assert NOT_DISPLAYED <= STREAM_EVENTS.keys()


def test_l_interface_ne_lit_que_des_types_du_registre():
    assert _lus_par_l_interface() - STREAM_EVENTS.keys() == set()


def test_route_et_journal_n_emettent_que_des_types_du_registre():
    emis = _emis_hors_boucle()
    # Garde contre un balayage vide (code déplacé hors des fichiers lus).
    assert {"final", "queue_status", "queue_cleared", "kv_cache"} <= emis
    assert emis - STREAM_EVENTS.keys() == set()


def test_chaque_type_est_cite_hors_du_registre():
    """Un type que plus aucun module Python ne cite n'est plus émis : le
    garder au registre (et son lecteur dans l'interface) est du code mort."""
    registre = ROOT / "llm_core" / "engine" / "stream_events.py"
    # Code seul : un type cité dans un commentaire n'a pas d'émetteur.
    src = "\n".join(code_seul(p.read_text(encoding="utf-8"))
                    for d in ("llm_core", "chatbot_app", "shared_infra")
                    for p in (ROOT / d).rglob("*.py") if p != registre)
    morts = {t for t in STREAM_EVENTS if f'"{t}"' not in src and f"'{t}'" not in src}
    assert morts == set(), f"{sorted(morts)} : plus aucun émetteur"


def test_chaque_type_a_un_lecteur_ou_est_declare_non_affiche():
    sans_lecteur = STREAM_EVENTS.keys() - _lus_par_l_interface() - NOT_DISPLAYED
    assert sans_lecteur == set(), (
        f"{sorted(sans_lecteur)} : ni lus par l'interface, ni dans NOT_DISPLAYED")
    assert not (NOT_DISPLAYED & _lus_par_l_interface()), "NOT_DISPLAYED périmé"
