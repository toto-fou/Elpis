# SPDX-License-Identifier: MIT
"""tests/llm_core/test_outil_inconnu_relance_2026_10_03.py — appel écrit en
texte vers un outil inexistant : relance bornée, prose légitime intacte."""
from __future__ import annotations

from tests.llm_core.goldens_harness import jouer_tour, sse_final, sse_text

FANTOME = '{"name": "outil_fantome", "arguments": {"x": 1}}'


async def test_relances_bornees_puis_reponse_finale(monkeypatch):
    """Un modèle qui insiste ne consomme pas le budget : deux relances, puis
    la boucle s'arrête (le 4e script n'est jamais lu)."""
    fake, ev, final, _m = await jouer_tour(monkeypatch, [
        sse_text(FANTOME), sse_text(FANTOME), sse_text(FANTOME),
        sse_final("Jamais lu."),
    ])
    assert len(fake.payloads) == 3
    assert "outil_fantome" not in final
    relances = [m for m in fake.payloads[-1]["messages"]
                if m["role"] == "user" and "`outil_fantome`" in (m.get("content") or "")]
    assert len(relances) == 2


async def test_prose_autour_de_l_appel_gardee_sans_relance(monkeypatch):
    """Une prose légitime autour du JSON n'est pas une tentative d'appel
    pure : elle reste la réponse, sans relance."""
    texte = "Voici l'exemple demandé :\n" + FANTOME + "\nC'est tout."
    fake, ev, final, _m = await jouer_tour(monkeypatch, [
        sse_final(texte), sse_final("Jamais lu."),
    ])
    assert len(fake.payloads) == 1
    assert "Voici l'exemple demandé" in final
