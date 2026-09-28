# SPDX-License-Identifier: MIT
"""
Validation stricte llama-server (≥ b10545) : les *_last_n NÉGATIFS sont
rejetés en 400 (« Value must be between 0 <= value <= 2147483647 »), alors
que « -1 = tout le contexte » est la convention historique de llama.cpp —
les /props des anciens builds annonçaient même -1 comme défaut de
dry_penalty_last_n. Régression vécue : cache props rempli sous l'ancien
binaire → swap de llama-server → tous les tours échouaient en
« Le modèle a refusé la requête telle qu'elle a été construite ».

resolve_sampling traduit désormais la convention (négatif → INT32_MAX,
même effet : le serveur borne au contexte) quelle que soit la source
(props/cache, profil de tâche, override utilisateur). Hors-ligne : on mocke
`_get_cached_props` (cf. suite llm_core).
"""

import llm_core._llm_params as P


async def _props(monkeypatch, values):
    async def _fake_props(_model_id):
        return dict(values)
    monkeypatch.setattr(P, "_get_cached_props", _fake_props)


async def test_props_moins_un_traduits_en_int32max(monkeypatch):
    # Le cas réel : props hérités d'un ancien llama-server (dry_penalty_last_n
    # -1 était son défaut), rejoués contre un build à validation stricte.
    await _props(monkeypatch, {
        "temperature": 0.8,
        "repeat_last_n": -1,
        "dry_penalty_last_n": -1,
        "dry_multiplier": 0.0,
    })

    out = await P.resolve_sampling("m", task="tools")

    assert out["repeat_last_n"] == P._INT32_MAX
    assert out["dry_penalty_last_n"] == P._INT32_MAX
    # Les autres clés passent inchangées.
    assert out["temperature"] == 0.8
    assert out["dry_multiplier"] == 0.0


async def test_valeurs_positives_intactes(monkeypatch):
    await _props(monkeypatch, {"repeat_last_n": 64, "dry_penalty_last_n": 64})

    out = await P.resolve_sampling("m", task="chat")

    assert out["repeat_last_n"] == 64
    assert out["dry_penalty_last_n"] == 64


async def test_override_utilisateur_moins_un_traduit_aussi(monkeypatch):
    # _sanitize_override ACCEPTE -1 (convention UI/API conservée) ; c'est la
    # résolution finale qui traduit pour le wire.
    await _props(monkeypatch, {"repeat_last_n": 64})

    out = await P.resolve_sampling(
        "m", task="chat", request_override={"repeat_last_n": -1},
    )

    assert out["repeat_last_n"] == P._INT32_MAX
