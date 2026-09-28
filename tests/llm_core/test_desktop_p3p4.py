# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_p3p4.py — P3 (validation de coordonnées + désambig.
hors-écran) et P4 (gating vision). Tout testable hors Windows : ``_agent_req`` /
cible / vision monkeypatchés.
"""
from __future__ import annotations

import io

import pytest
from PIL import Image

from llm_core.tools import desktop_tools as dt
from llm_core import _desktop_session as ds

FAKE_TGT = {"name": "t1", "agent_url": "http://agent", "os": "windows"}


def _realpng(color=(40, 40, 40)):
    """Vrai PNG → _frame_sig produit une signature dHash stable (≠ b'PNG' bidon)."""
    b = io.BytesIO()
    Image.new("RGB", (64, 48), color).save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def agent(monkeypatch):
    seen = []
    resp = {"default": {"ok": True}}

    def fake_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen.append((endpoint, payload))
        return resp.get(endpoint, resp["default"])

    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (FAKE_TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_agent_req", fake_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 800, 600))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    return {"seen": seen, "resp": resp}


# ── P3 : bornage des coordonnées ──────────────────────────────────────────────
def test_act_rejects_out_of_bounds(agent):
    ds.set_screen_dims("u", "t1", 800, 600)
    res = dt.act_core("u", "t1", op="click", x=5000, y=20)
    assert res["ok"] is False and res["error"] == "point_out_of_bounds"
    assert agent["seen"] == []                 # rien envoyé à l'agent


def test_act_clamps_edge_overflow(agent):
    ds.set_screen_dims("u", "t1", 800, 600)
    res = dt.act_core("u", "t1", op="click", x=801, y=600)   # +1 px de bord → clamp
    assert res["ok"] is True
    ep, p = agent["seen"][0]
    assert ep == "/click" and p["x"] == 799 and p["y"] == 599


def test_act_lenient_without_known_dims(agent):
    ds._screen_dims.pop("u::t1", None)         # aucune capture connue
    res = dt.act_core("u", "t1", op="click", x=5000, y=20)
    assert res["ok"] is True                    # pas de borne haute → on laisse passer
    assert agent["seen"][0][1]["x"] == 5000


def test_act_rejects_negative_even_without_dims(agent):
    ds._screen_dims.pop("u::t1", None)
    res = dt.act_core("u", "t1", op="click", x=-50, y=10)
    assert res["ok"] is False and res["error"] == "point_out_of_bounds"


# ── P3 : désambiguïsation par état (hors-écran déprié) ────────────────────────
def test_pick_best_deprioritizes_offscreen():
    cands = [
        {"label": "OK", "role": "button", "states": ["offscreen"], "center": [0, 0]},
        {"label": "OK", "role": "button", "states": ["enabled"], "center": [10, 10]},
    ]
    best = ds._pick_best(cands, query="ok")
    assert best["states"] == ["enabled"]        # le doublon visible/actionnable gagne


# ── P4 : gating vision ────────────────────────────────────────────────────────
@pytest.fixture
def obs_env(monkeypatch):
    calls = {"detect": 0}
    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (FAKE_TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNGDATA", 800, 600))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")

    def fake_detect(*a, **k):
        calls["detect"] += 1
        return []
    monkeypatch.setattr(dt, "detect", fake_detect)
    monkeypatch.setattr(dt._cfg, "VISION_ENDPOINT_URL", "http://vision")
    monkeypatch.setattr(dt._cfg, "VISION_A11Y_SKIP_MIN", 12)
    dt._VISION_MEMO.clear()
    dt._A11Y_MEMO.clear()           # éviter la fuite inter-test (sig identique → memo-hit)
    return calls


def _tree(n):
    return {"ok": True, "elements": [
        {"role": "button", "name": f"b{i}", "rect": [i * 5, 0, 20, 10]} for i in range(n)]}


def test_vision_skipped_when_a11y_rich(monkeypatch, obs_env):
    monkeypatch.setattr(dt, "_agent_req", lambda tgt, ep, payload=None, **k: _tree(15))
    res = dt.observe_core("u", "t1", use_vision=True, use_tree=True)
    assert res["ok"] is True
    assert obs_env["detect"] == 0               # arbre riche + pas de prompt → vision sautée
    assert res["vision_used"] is False
    assert res["count"] >= 15


def test_vision_runs_when_a11y_sparse(monkeypatch, obs_env):
    monkeypatch.setattr(dt, "_agent_req", lambda tgt, ep, payload=None, **k: _tree(3))
    dt.observe_core("u", "t1", use_vision=True, use_tree=True)
    assert obs_env["detect"] == 1               # arbre maigre → filet vision actif


def test_vision_runs_with_explicit_prompt(monkeypatch, obs_env):
    monkeypatch.setattr(dt, "_agent_req", lambda tgt, ep, payload=None, **k: _tree(20))
    dt.observe_core("u", "t1", prompt="le bouton rouge", use_vision=True, use_tree=True)
    assert obs_env["detect"] == 1               # grounding explicite → vision même si a11y riche


def test_prompt_detection_memoized(monkeypatch, obs_env):
    # P4 — une requête CIBLÉE (prompt=) répétée sur écran figé (même dHash) réutilise
    # le memo ciblé → une SEULE détection vision (pas de re-paiement 0,5-2 s).
    monkeypatch.setattr(dt, "_agent_req", lambda tgt, ep, payload=None, **k: _tree(20))
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "abcdabcdabcdabcd")  # écran figé
    dt._VISION_PROMPT_MEMO.clear()

    def fake_detect(*a, **k):
        obs_env["detect"] += 1
        return [{"box": [1, 2, 3, 4], "label": "cible", "confidence": 0.9}]
    monkeypatch.setattr(dt, "detect", fake_detect)

    dt.observe_core("u", "t1", prompt="cible", use_vision=True, use_tree=True)
    dt.observe_core("u", "t1", prompt="cible", use_vision=True, use_tree=True)   # memo hit
    assert obs_env["detect"] == 1
    # Un prompt DIFFÉRENT n'est pas servi par le memo de « cible ».
    dt.observe_core("u", "t1", prompt="autre", use_vision=True, use_tree=True)
    assert obs_env["detect"] == 2


def test_prompt_memo_invalidated_after_act(monkeypatch, obs_env):
    # P4 — une action mutante purge le memo ciblé (l'écran a pu changer).
    monkeypatch.setattr(dt, "_agent_req", lambda tgt, ep, payload=None, **k: _tree(20))
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "abcdabcdabcdabcd")
    dt._VISION_PROMPT_MEMO.clear()

    def fake_detect(*a, **k):
        obs_env["detect"] += 1
        return [{"box": [1, 2, 3, 4], "label": "cible", "confidence": 0.9}]
    monkeypatch.setattr(dt, "detect", fake_detect)

    dt.observe_core("u", "t1", prompt="cible", use_vision=True, use_tree=True)
    dt._invalidate_a11y_memo("t1")              # comme après un act mutant
    dt.observe_core("u", "t1", prompt="cible", use_vision=True, use_tree=True)
    assert obs_env["detect"] == 2               # re-détecté (memo purgé)


# ── P1 : ops sémantiques (act_core → /element par control pattern) ────────────
def test_act_toggle_forwards_to_element(agent):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Wi-Fi", "auto_id": "wifiChk", "role": "checkbox",
         "center": [10, 10]}])
    res = dt.act_core("u", "t1", op="toggle", element_id="el_1")
    ep, p = agent["seen"][0]
    assert ep == "/element" and p["action"] == "toggle"
    assert p["auto_id"] == "wifiChk" and p["name"] == "Wi-Fi" and p["control_type"] == "checkbox"
    assert p["x"] == 10 and p["y"] == 10        # point de repli depuis l'élément résolu
    assert res["ok"] is True


def test_act_scroll_into_view_forwards(agent):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Ligne 99", "auto_id": "row99", "role": "listitem",
         "center": [5, 500]}])
    dt.act_core("u", "t1", op="scroll_into_view", element_id="el_1")
    ep, p = agent["seen"][0]
    assert ep == "/element" and p["action"] == "scroll_into_view" and p["auto_id"] == "row99"


def test_act_select_needs_target(agent):
    res = dt.act_core("u", "t1", op="select")   # ni id ni coords
    assert res["ok"] is False and res["error"] == "need_target"
    assert agent["seen"] == []


def test_act_expand_by_auto_id_direct(agent):
    # auto_id direct (cache vide) → l'agent re-cible en live, on forwarde tel quel
    res = dt.act_core("u", "t1", op="expand", auto_id="combo1")
    ep, p = agent["seen"][0]
    assert ep == "/element" and p["action"] == "expand" and p["auto_id"] == "combo1"
    assert res["ok"] is True


def test_act_set_value_by_element_id_resolves_auto_id(agent):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Port", "auto_id": "portField", "role": "textbox",
         "center": [4, 4]}])
    res = dt.act_core("u", "t1", op="set_value", element_id="el_1", text="8080")
    ep, p = agent["seen"][0]
    assert ep == "/set_value" and p["auto_id"] == "portField" and p["text"] == "8080"
    assert res["ok"] is True


# ── P13 : memo arbre a11y (clé dHash, TTL court) ──────────────────────────────
@pytest.fixture
def tree_env(monkeypatch):
    calls = {"tree": 0}

    def fake_req(tgt, ep, payload=None, method="POST", timeout=None):
        if ep == "/ui_tree":
            calls["tree"] += 1
            return _tree(15)
        return {"ok": True}

    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (FAKE_TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_agent_req", fake_req)
    _png = _realpng()
    monkeypatch.setattr(dt, "_grab", lambda tgt: (_png, 800, 600))   # même PNG → même dHash
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    monkeypatch.setattr(dt, "_A11Y_MEMO_TTL_S", 1.0)
    dt._A11Y_MEMO.clear()
    return calls


def test_a11y_memo_reuses_tree_on_same_sig(tree_env):
    dt.observe_core("u", "t1", use_vision=False, use_tree=True)
    dt.observe_core("u", "t1", use_vision=False, use_tree=True)
    assert tree_env["tree"] == 1               # 2ᵉ obs servie depuis le memo (même dHash)


def test_a11y_memo_invalidated_after_act(tree_env):
    dt.observe_core("u", "t1", use_vision=False, use_tree=True)   # tree=1, memo posé
    dt.act_core("u", "t1", op="click", x=10, y=10, observe_after=False)  # invalide le memo
    dt.observe_core("u", "t1", use_vision=False, use_tree=True)   # tree=2 (re-lecture)
    assert tree_env["tree"] == 2


def test_a11y_memo_off_when_ttl_zero(tree_env, monkeypatch):
    monkeypatch.setattr(dt, "_A11Y_MEMO_TTL_S", 0)
    dt._A11Y_MEMO.clear()
    dt.observe_core("u", "t1", use_vision=False, use_tree=True)
    dt.observe_core("u", "t1", use_vision=False, use_tree=True)
    assert tree_env["tree"] == 2               # désactivé → toujours re-lire
