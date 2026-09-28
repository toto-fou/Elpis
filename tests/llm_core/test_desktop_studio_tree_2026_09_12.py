# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_studio_tree_2026_09_12.py — l'arbre que le Studio
reçoit doit permettre de viser CE QU'ON VOIT :

  • un nœud sans nom garde un libellé (rôle) pour le modèle texte, mais porte
    ``unnamed: True`` — le Studio ne fabrique jamais ``name="group"`` avec ;
  • le Studio demande un plafond de nœuds plus haut que le chat (``max_nodes``),
    l'éventail par nœud suit, et le memo d'arbre ne mélange pas les plafonds ;
  • plafond atteint = feuilles manquantes → ``tree_capped`` + note, pas le silence.
"""
from __future__ import annotations

import pytest

from llm_core.tools import desktop_tools as dt

FAKE_TGT = {"name": "t1", "agent_url": "http://agent", "os": "windows"}


def _tree(n):
    out = [{"role": "window", "name": "winapptest", "auto_id": "", "runtime_id": "0",
            "box": [0, 0, 800, 600], "depth": 0}]
    for i in range(1, n):
        out.append({"role": "group" if i % 2 else "button", "name": "" if i % 3 else "OK",
                    "auto_id": "", "runtime_id": str(i), "box": [i, i, i + 20, i + 10], "depth": 1})
    return out


@pytest.fixture
def env(monkeypatch):
    seen = []

    def fake_agent_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen.append((endpoint, dict(payload or {})))
        if endpoint == "/ui_tree":
            mx = int((payload or {}).get("max_nodes") or 400)
            return {"elements": _tree(min(mx, 900)), "width": 800, "height": 600}
        return {"ok": True}

    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": FAKE_TGT if target in ("", "t1") else None)
    monkeypatch.setattr(dt, "_agent_req", fake_agent_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 800, 600))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    monkeypatch.setattr(dt._cfg, "VISION_ENDPOINT_URL", "", raising=False)
    monkeypatch.setattr(dt, "_A11Y_MEMO_TTL_S", 5.0)     # memo actif, quel que soit l'env de test
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "0" * 16)   # écran « figé » (b"PNG" n'est pas une image)
    dt._A11Y_MEMO.clear()
    return seen


def test_un_noeud_sans_nom_est_marque_unnamed(env):
    res = dt.observe_core("u", "t1", use_vision=False, use_tree=True)
    els = res["elements"]
    win = next(e for e in els if e["role"] == "window")
    assert win["label"] == "winapptest" and "unnamed" not in win
    grp = next(e for e in els if e["role"] == "group" and e["label"] == "group")
    assert grp["unnamed"] is True, "libellé recopié du rôle → marqué, jamais pris pour un nom"
    named = next(e for e in els if e["label"] == "OK")
    assert "unnamed" not in named


def test_le_chat_garde_son_plafond_et_le_studio_demande_plus(env):
    dt.observe_core("u", "t1", use_vision=False, use_tree=True)
    ep, body = env[-1]
    assert ep == "/ui_tree" and body["max_nodes"] == dt._UI_TREE_MAX_NODES and "fanout" not in body
    dt._A11Y_MEMO.clear()
    res = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_nodes=2000)
    ep, body = env[-1]
    assert body["max_nodes"] == 2000 and body["fanout"] == 400
    assert res["count"] == 900 and res["tree_capped"] is False and res["tree_nodes"] == 900


def test_plafond_atteint_signale_les_feuilles_manquantes(env):
    res = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_nodes=500)
    assert res["tree_capped"] is True and res["tree_nodes"] == 500
    assert "tronqué" in (res.get("note") or "")
    ok = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_nodes=2000)
    assert ok["tree_capped"] is False and "tronqué" not in (ok.get("note") or "")


def test_le_memo_d_arbre_ne_melange_pas_les_plafonds(env):
    a = dt.observe_core("u", "t1", use_vision=False, use_tree=True)            # 400 nœuds
    b = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_nodes=2000)
    assert a["count"] == dt._UI_TREE_MAX_NODES and b["count"] == 900
    assert len([1 for ep, _ in env if ep == "/ui_tree"]) == 2, "deux plafonds = deux arbres, pas un memo partagé"
    c = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_nodes=2000)
    assert c["count"] == 900 and len([1 for ep, _ in env if ep == "/ui_tree"]) == 2, "même plafond, écran figé → memo"
