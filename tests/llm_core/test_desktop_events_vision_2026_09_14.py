# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_events_vision_2026_09_14.py — relecture du Studio du 14/09.

• Un libellé LU par la vision sur un contrôle sans nom UIA n'est pas une identité :
  l'élément reste ``unnamed`` (l'enregistreur vise le chemin, pas ``name="icône"``).
• L'événement ``tool_result`` d'un ``desktop_act`` porte ``desktop`` (sig + éléments
  allégés) hors de la coupe à 2000 caractères du champ ``result``.
"""
from __future__ import annotations

import json

from llm_core.tools import desktop_tools as dt


def test_libelle_vision_sur_controle_sans_nom_reste_unnamed():
    a11y = [{"box": [10, 10, 40, 40], "role": "button", "name": "", "auto_id": "", "depth": 1},
            {"box": [100, 10, 180, 40], "role": "button", "name": "Enregistrer", "auto_id": "", "depth": 1}]
    vision = [{"box": [10, 10, 40, 40], "label": "icône enregistrer", "confidence": 0.9},
              {"box": [100, 10, 180, 40], "label": "bouton", "confidence": 0.8}]
    out = dt._merge_elements(a11y, vision)
    icon = next(e for e in out if e["box"] == [10, 10, 40, 40])
    named = next(e for e in out if e["box"] == [100, 10, 180, 40])
    assert icon["label"] == "icône enregistrer", "le libellé reste lisible (modèle, affichage)"
    assert icon.get("unnamed") is True and icon.get("label_source") == "vision"
    assert named["label"] == "Enregistrer" and not named.get("unnamed"), "un vrai nom UIA n'est pas écrasé"


def test_evenement_desktop_hors_de_la_coupe():
    from llm_core._chat_with_tools import _desktop_event_extra
    els = [{"id": f"el_{i}", "label": f"Élément {i}", "role": "button", "auto_id": f"b{i}", "box": [i, i, i + 9, i + 9],
            "center": [i + 4, i + 4], "depth": 1, "value": "x" * 50, "confidence": 0.5} for i in range(80)]
    raw = json.dumps({"ok": True, "sig": "abcd", "elements": els})
    assert len(raw) > 2000, "le cas réel : le JSON dépasse la coupe du panneau"
    extra = _desktop_event_extra("desktop_act", raw)
    assert extra["sig"] == "abcd" and len(extra["elements"]) == 80
    assert set(extra["elements"][0]) <= set(("id", "label", "role", "auto_id", "box", "center", "depth", "unnamed",
                                             "source", "states", "patterns", "label_source")), "allégé"
    assert _desktop_event_extra("fs_read", raw) is None
    assert _desktop_event_extra("desktop_act", '{"ok": tr') is None
