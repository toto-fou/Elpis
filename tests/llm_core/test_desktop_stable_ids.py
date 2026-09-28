# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_stable_ids.py — P0 : id ``el_N`` STABLES entre deux
observations (anti index-drift). assign_stable_ids réutilise l'id précédent pour
un même runtime_id (UIA, intra-session) ou, à défaut, un même auto_id ; les
nouveaux éléments reçoivent un numéro frais MONOTONE (pas de collision). Et
resolve_element sait matcher par runtime_id (priorité 0).
"""
from __future__ import annotations

from llm_core import _desktop_session as ds


def test_stable_ids_reuse_by_runtime_id():
    t = "stbl1"
    e1 = [{"runtime_id": "1.1", "auto_id": "a", "label": "A"},
          {"runtime_id": "2.2", "auto_id": "b", "label": "B"}]
    ds.assign_stable_ids("u", t, e1)
    ds.register_desktop_observation("u", t, e1)
    ids1 = {e["runtime_id"]: e["id"] for e in e1}
    assert sorted(ids1.values()) == ["el_1", "el_2"]

    # 2ᵉ obs : B et A réordonnés + un nouveau C. B/A GARDENT leur id, C est frais.
    e2 = [{"runtime_id": "2.2", "auto_id": "b", "label": "B"},
          {"runtime_id": "3.3", "auto_id": "c", "label": "C"},
          {"runtime_id": "1.1", "auto_id": "a", "label": "A"}]
    ds.assign_stable_ids("u", t, e2)
    ids2 = {e["runtime_id"]: e["id"] for e in e2}
    assert ids2["2.2"] == ids1["2.2"]          # B stable malgré la re-numérotation
    assert ids2["1.1"] == ids1["1.1"]          # A stable
    assert ids2["3.3"] not in ids1.values()    # C : numéro frais, aucune collision
    assert ids2["3.3"] == "el_3"


def test_stable_ids_reuse_by_auto_id_when_no_runtime():
    t = "stbl2"
    e1 = [{"auto_id": "save", "label": "Save"}]
    ds.assign_stable_ids("u", t, e1)
    ds.register_desktop_observation("u", t, e1)
    first = e1[0]["id"]
    e2 = [{"label": "noise"}, {"auto_id": "save", "label": "Save"}]
    ds.assign_stable_ids("u", t, e2)
    saved = [e for e in e2 if e.get("auto_id") == "save"][0]
    assert saved["id"] == first                # ré-ancré par auto_id (faute de runtime_id)


def test_stable_ids_first_obs_numbers_from_one():
    t = "stbl_fresh"
    e = [{"runtime_id": "x"}, {"runtime_id": "y"}, {"auto_id": "z"}]
    ds.assign_stable_ids("u", t, e)
    assert [x["id"] for x in e] == ["el_1", "el_2", "el_3"]


def test_resolve_by_runtime_id():
    t = "stbl3"
    ds.register_desktop_observation("u", t, [
        {"id": "el_1", "runtime_id": "9.9", "label": "X", "center": [1, 1]},
        {"id": "el_2", "runtime_id": "8.8", "label": "Y", "center": [2, 2]},
    ])
    el = ds.resolve_element("u", t, runtime_id="8.8")
    assert el and el["id"] == "el_2"
