# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_action_cache.py — intégration du cache d'actions
dans ``resolve_element`` : apprentissage de l'auto_id stable + résolution
« cache-first » déterministe (mémoire inter-session, anti-flapping).
"""
from __future__ import annotations

import pytest

from llm_core import _desktop_session as ds


@pytest.fixture
def db(tmp_path, monkeypatch):
    """DB temp + tables scénarios + memo d'écriture vierge."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    import shared_infra.desktop.anchors as scenarios
    scenarios.init_action_cache_db()
    ds._anchor_write_memo.clear()
    return scenarios


def test_query_resolution_learns_auto_id(db):
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_1", "label": "Envoyer", "role": "button", "auto_id": "sendBtn", "center": [10, 10]},
    ])
    e = ds.resolve_element("u", "vm1", query="Envoyer")
    assert e["auto_id"] == "sendBtn"
    rec = db.lookup_action_anchor("u::vm1", "envoyer")
    assert rec is not None and rec["auto_id"] == "sendBtn"


def test_pin_beats_first_match_on_next_observation(db):
    # 1) apprentissage : l'ancre stable « L » est épinglée pour « envoyer ».
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_late", "label": "Envoyer", "role": "button", "auto_id": "L", "center": [9, 9]},
    ])
    ds.resolve_element("u", "vm1", query="Envoyer")

    # 2) nouvel écran : 2 sous-chaînes équivalentes ; sans cache le PREMIER
    #    (el_first / « F ») gagnerait. Le pin doit ramener el_late / « L ».
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_first", "label": "Envoyer X", "role": "button", "auto_id": "F", "center": [1, 1]},
        {"id": "el_late",  "label": "Envoyer Y", "role": "button", "auto_id": "L", "center": [2, 2]},
    ])
    e = ds.resolve_element("u", "vm1", query="Envoyer")
    assert e["auto_id"] == "L", "le cache doit ré-épingler le même contrôle"


def test_without_pin_first_match_wins(db):
    # Contrôle : même écran ambigu mais AUCUN apprentissage préalable (cible vm2).
    ds.register_desktop_observation("u", "vm2", [
        {"id": "el_first", "label": "Envoyer X", "role": "button", "auto_id": "F", "center": [1, 1]},
        {"id": "el_late",  "label": "Envoyer Y", "role": "button", "auto_id": "L", "center": [2, 2]},
    ])
    e = ds.resolve_element("u", "vm2", query="Envoyer")
    assert e["auto_id"] == "F", "sans pin → premier match (comportement de base)"


def test_stale_pin_falls_back(db):
    # apprend « L » puis l'auto_id « L » pointe vers un contrôle dont le label ne
    # contient PLUS la requête (réattribué) → on ignore le pin et on retombe sur
    # la résolution normale (el_first / « F »).
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_late", "label": "Envoyer", "role": "button", "auto_id": "L", "center": [9, 9]},
    ])
    ds.resolve_element("u", "vm1", query="Envoyer")
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_first", "label": "Envoyer X", "role": "button", "auto_id": "F", "center": [1, 1]},
        {"id": "el_stale", "label": "Annuler",   "role": "button", "auto_id": "L", "center": [2, 2]},
    ])
    e = ds.resolve_element("u", "vm1", query="Envoyer")
    assert e["auto_id"] == "F", "pin incohérent (label changé) → fallback"


def test_explicit_role_hint_bypasses_pin(db):
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_late", "label": "Envoyer", "role": "button", "auto_id": "L", "center": [9, 9]},
    ])
    ds.resolve_element("u", "vm1", query="Envoyer")
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_first", "label": "Envoyer X", "role": "button", "auto_id": "F", "center": [1, 1]},
        {"id": "el_late",  "label": "Envoyer Y", "role": "button", "auto_id": "L", "center": [2, 2]},
    ])
    # un désambiguïsateur explicite (role) doit primer sur le pin → 1er bouton.
    e = ds.resolve_element("u", "vm1", query="Envoyer", role="button")
    assert e["auto_id"] == "F"


def test_no_auto_id_means_no_learning(db):
    ds.register_desktop_observation("u", "vm1", [
        {"id": "el_1", "label": "Cliquer", "role": "button", "center": [1, 1]},   # pas d'auto_id
    ])
    ds.resolve_element("u", "vm1", query="Cliquer")
    assert db.lookup_action_anchor("u::vm1", "cliquer") is None
