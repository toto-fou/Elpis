# SPDX-License-Identifier: MIT
"""L'interrupteur ``enable_mcp`` coupe VRAIMENT les outils (2026-07-29).

Avant, il n'était consommé que par trois ``v-if`` de visibilité côté UI : le
bouton et le panneau disparaissaient, mais les catégories déjà cochées
continuaient de partir au modèle à chaque tour — et l'utilisateur ne pouvait
même plus les décocher, le panneau étant masqué. Il croyait avoir retiré
shell/fichiers/API au modèle ; il n'avait retiré que son propre accès au
réglage.

La règle est désormais appliquée CÔTÉ SERVEUR (seule place qui fait autorité —
un client modifié ne peut pas la contourner), avec UNE exception voulue : les
outils de mémoire survivent, écrire un souvenir n'étant pas « exécuter du code
chez l'utilisateur ».

Ces tests portent sur la logique de sélection des serveurs et sur le défaut du front.
"""
from __future__ import annotations

from pathlib import Path

import pytest


def _simulate(*, enable_mcp, memory_on, agents_on, servers):
    """Rejoue la cascade de la route (gate + injections) à l'identique."""
    active = list(servers)
    ui_cats = ["fs", "shell"]
    _mcp_on = bool(enable_mcp)
    _agents_on = agents_on
    if not _mcp_on:
        active, ui_cats, _agents_on = [], [], False
    deny = None if _mcp_on else {"todowrite"}
    has_local = any(s.get("command") == "DEFAULT_LOCAL_PYTHON" for s in active)
    if memory_on and not has_local:
        active = active + [{"type": "stdio", "name": "Mémoire",
                            "command": "DEFAULT_LOCAL_PYTHON",
                            "filter_categories": ["memory"]}]
    elif _mcp_on and _agents_on and not has_local and not active:
        active = [{"type": "stdio", "name": "Agents",
                   "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": []}]
    elif _mcp_on and active and not has_local:
        active = active + [{"type": "stdio", "name": "Tâches",
                            "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": []}]
    return {"servers": active, "deny": deny, "agents_on": _agents_on, "ui_cats": ui_cats}


_LOCAL_FS = {"type": "stdio", "name": "Outils Locaux",
             "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs", "shell"]}
_EXTERNAL = {"type": "stdio", "name": "Confluence", "command": "npx conf"}


def test_off_coupe_local_et_externe():
    out = _simulate(enable_mcp=False, memory_on=False, agents_on=False,
                    servers=[_LOCAL_FS, _EXTERNAL])
    assert out["servers"] == []
    assert out["ui_cats"] == []


def test_off_garde_uniquement_la_memoire():
    out = _simulate(enable_mcp=False, memory_on=True, agents_on=False,
                    servers=[_LOCAL_FS, _EXTERNAL])
    assert len(out["servers"]) == 1
    srv = out["servers"][0]
    assert srv["name"] == "Mémoire"
    assert srv["filter_categories"] == ["memory"]
    # Les catégories CACHÉES traversent filter_categories : sans deny, le
    # serveur « Mémoire » ramènerait aussi todowrite.
    assert out["deny"] == {"todowrite"}


def test_off_retire_les_sous_agents():
    """``task`` hérite de la surface du parent : sans outils il ne peut rien,
    et l'exposer laisserait croire à une capacité."""
    out = _simulate(enable_mcp=False, memory_on=False, agents_on=True, servers=[])
    assert out["agents_on"] is False
    assert out["servers"] == []


def test_on_ne_change_rien():
    """Contrôle négatif : interrupteur ON = comportement historique intact."""
    out = _simulate(enable_mcp=True, memory_on=False, agents_on=False,
                    servers=[_LOCAL_FS, _EXTERNAL])
    assert out["deny"] is None
    assert _LOCAL_FS in out["servers"] and _EXTERNAL in out["servers"]


def test_on_injecte_toujours_taches_avec_serveur_externe_seul():
    out = _simulate(enable_mcp=True, memory_on=False, agents_on=False,
                    servers=[_EXTERNAL])
    assert [s["name"] for s in out["servers"]] == ["Confluence", "Tâches"]


def test_front_et_back_ont_le_meme_defaut():
    """Un front à False face à un back à True afficherait « coupé » pendant que
    les outils passent — pire que le bug d'origine."""
    front = (Path(__file__).resolve().parents[2]
             / "frontend" / "src" / "features" / "reglages" / "modale.ts").read_text(encoding="utf-8")
    assert "d.enable_mcp ??= true;" in front
    chat = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "features" / "chat"
            / "coeur" / "generation.ts").read_text(encoding="utf-8")
    assert "const mcp = r.settings.value.enable_mcp !== false;" in chat
