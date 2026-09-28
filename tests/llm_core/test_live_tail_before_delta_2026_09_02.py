# SPDX-License-Identifier: MIT
"""Queue de la narration pré-outil relâchée au PREMIER ``tool_call_delta``
(2026-09-02).

La fenêtre de retenue de l'émission directe (``_LIVE_HOLDBACK_CHARS`` = 48)
n'était relâchée qu'en fin d'itération, juste avant l'event ``tool_call`` :
pendant toute la génération des arguments de l'appel (plusieurs secondes pour
un ``write_file``), la fin de la phrase manquait à l'écran, puis surgissait
d'un coup AVEC l'appel. Au premier delta d'appel, le modèle a fini sa prose :
la queue part immédiatement.
"""
from __future__ import annotations

import json

from tests.llm_core.goldens_harness import sse_final, sse_tool_call
from tests.llm_core.test_event_contract import _collect

NARRATION = ("Je vais d'abord lire le fichier de configuration pour vérifier "
             "la valeur du drapeau de débogage avant de le corriger.")


def _sse_content(text: str, chunk: int = 20) -> list:
    out = []
    for i in range(0, len(text), chunk):
        out.append("data: " + json.dumps({"choices": [{"delta": {"content": text[i:i + chunk]}}]}))
    return out


async def test_queue_emise_au_premier_delta_pas_avec_le_tool_call(monkeypatch):
    seen, final, _m = await _collect(monkeypatch, [
        _sse_content(NARRATION) + sse_tool_call("zeta_echo", '{"msg": "ping"}'),
        sse_final("Terminé."),
    ])
    types = [e.get("type") for e in seen]
    i_delta = types.index("tool_call_delta")
    i_call = types.index("tool_call")
    assert i_delta < i_call

    # Toute la narration est partie AVANT le premier delta …
    before = "".join(e.get("text", "") for e in seen[:i_delta]
                     if e.get("type") == "content_token")
    assert before.strip() == NARRATION
    # … et plus rien ne traîne entre le delta et l'appel (la queue ne surgit
    # plus « avec » le tool_call).
    between = "".join(e.get("text", "") for e in seen[i_delta:i_call]
                      if e.get("type") == "content_token")
    assert between.strip() == ""
    assert final == "Terminé."


async def test_sans_delta_la_queue_part_toujours_avant_le_tool_call(monkeypatch):
    """Régression : sans texte, rien à relâcher ; avec texte, la queue reste
    émise avant ``tool_call`` (chemin de fin d'itération inchangé)."""
    seen, _final, _m = await _collect(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "ping"}'),
        sse_final("Fin."),
    ])
    types = [e.get("type") for e in seen]
    assert "content_token" not in types[:types.index("tool_call")]
