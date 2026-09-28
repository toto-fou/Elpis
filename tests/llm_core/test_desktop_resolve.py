# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_resolve.py — résolution d'élément désambiguïsée (P1.1).

``resolve_element`` lit le cache d'observation (register_desktop_observation) et
choisit : auto_id > element_id > label EXACT > substring DÉPARTAGÉ (rôle +
proximité à la box enregistrée) au lieu du « premier match gagne ».
"""
from __future__ import annotations

from llm_core import _desktop_session as ds


def _obs(els):
    ds.register_desktop_observation("u", "vm1", els)


def test_exact_label_wins_over_substring():
    _obs([
        {"id": "el_1", "label": "Save As", "role": "menuitem", "center": [10, 10]},
        {"id": "el_2", "label": "Save", "role": "button", "center": [20, 20]},
    ])
    assert ds.resolve_element("u", "vm1", query="Save")["id"] == "el_2"


def test_substring_disambiguated_by_role_and_proximity():
    _obs([
        {"id": "el_1", "label": "Save document", "role": "menuitem", "center": [500, 500]},
        {"id": "el_2", "label": "Save draft", "role": "button", "center": [100, 100]},
    ])
    # ancre enregistrée : un BOUTON près de (110,110) → el_2, pas el_1 (le premier).
    e = ds.resolve_element("u", "vm1", query="Save", near=(110.0, 110.0), role="button")
    assert e["id"] == "el_2"


def test_auto_id_takes_priority():
    _obs([
        {"id": "el_1", "label": "X", "role": "button", "auto_id": "saveBtn", "center": [1, 1]},
        {"id": "el_2", "label": "Save", "role": "button", "center": [2, 2]},
    ])
    assert ds.resolve_element("u", "vm1", auto_id="saveBtn", query="Save")["id"] == "el_1"


# ── A2 : _resolve_element_impl remonte la MÉTHODE de résolution ──────────────

def test_resolve_impl_reports_method(monkeypatch):
    # Cache d'ancres neutralisé → méthodes déterministes (sinon un run précédent
    # pourrait épingler "save" et renvoyer cache_pin au lieu d'exact_label).
    monkeypatch.setattr(ds, "_lookup_pinned_anchor", lambda u, t, q: None)
    monkeypatch.setattr(ds, "_learn_anchor", lambda *a, **k: None)
    _obs([
        {"id": "el_1", "label": "Save", "role": "button", "auto_id": "saveBtn",
         "runtime_id": "42.1", "center": [1, 1]},
        {"id": "el_2", "label": "Save As", "role": "menuitem", "center": [2, 2]},
    ])
    assert ds._resolve_element_impl("u", "vm1", runtime_id="42.1")[1] == "runtime_id"
    assert ds._resolve_element_impl("u", "vm1", auto_id="saveBtn")[1] == "auto_id"
    assert ds._resolve_element_impl("u", "vm1", element_id="el_2")[1] == "element_id"
    assert ds._resolve_element_impl("u", "vm1", query="Save")[1] == "exact_label"
    assert ds._resolve_element_impl("u", "vm1", query="Sav")[1] == "substring"
    assert ds._resolve_element_impl("u", "vm1", query="zzz") == (None, "")


def test_resolve_impl_cache_pin(monkeypatch):
    monkeypatch.setattr(ds, "_lookup_pinned_anchor", lambda u, t, q: "saveBtn")
    _obs([{"id": "el_1", "label": "Save now", "role": "button",
           "auto_id": "saveBtn", "center": [1, 1]}])
    el, method = ds._resolve_element_impl("u", "vm1", query="save")
    assert method == "cache_pin" and el["id"] == "el_1"


def test_resolve_element_wrapper_returns_element_only():
    # Rétro-compat : le wrapper public renvoie toujours l'élément seul.
    _obs([{"id": "el_1", "label": "OK", "role": "button", "center": [5, 5]}])
    assert ds.resolve_element("u", "vm1", element_id="el_1")["id"] == "el_1"
