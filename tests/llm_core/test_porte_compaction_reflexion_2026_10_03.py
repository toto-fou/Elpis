# SPDX-License-Identifier: MIT
"""tests/llm_core/test_porte_compaction_reflexion_2026_10_03.py — sur le chemin
sans outils, la porte de compaction reçoit le vrai ``thinking_mode``, comme le
budget dur et la porte de la boucle outils."""
from __future__ import annotations


def test_la_porte_classique_recoit_le_vrai_mode_reflexion():
    """Garde-fou source, même gabarit que le seuil du compte : la porte du
    chemin classique reçoit ``thinking_mode`` comme le budget dur."""
    from tests._sources import source_flux_chat
    src = source_flux_chat()
    appel = src[src.index("_cl_gate = _cgate("):]
    appel = appel[:appel.index(")") + 1]
    assert "thinking_mode=thinking_mode" in appel
    assert "thinking_mode=False" not in appel

