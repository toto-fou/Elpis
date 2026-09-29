# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_lean_v3.py — Vague 3 (cohérence outils desktop pour
modèles 30-129B) : déplace la charge du modèle vers l'agent/serveur.

  T1-A  indice d'action `do` (1 mot) calculé dans _merge_elements + survit à la
        compaction (réconcilie la guidance qui pointait `element.patterns`, retiré).
  T1-B  desktop_act RENVOIE une liste d'éléments fraîche (return_elements) →
        supprime le round-trip observe→act→observe.
  T1-C  op="click" auto-route vers le moteur sémantique (/element) quand un
        élément est résolu et qu'on est sur le chemin chat (semantic_click).
  T2-D  observe_core signale la troncature (total/truncated/note).
  T2-F  une query qui matche plusieurs éléments au même libellé → need_disambiguation.
  T4-J  garde-fou hard-stop anti-boucle (constante + détection répétée).

Aucun réseau : control-agent (_agent_req), cible (_resolve_target) et capture
(_grab/_save_frame) sont monkeypatchés.
"""
from __future__ import annotations

import json

import pytest

from llm_core import _desktop_session as ds
from llm_core.tools import desktop_tools as dt

FAKE_TGT = {"name": "t1", "agent_url": "http://agent", "os": "windows"}

# Un petit arbre a11y renvoyé par /ui_tree : un bouton (auto_id), une case à
# cocher (pattern toggle), un champ éditable (pattern value).
TREE = [
    {"role": "button",   "name": "Save",  "auto_id": "btnSave", "runtime_id": "1.1",
     "box": [10, 10, 90, 40], "patterns": ["invoke"], "states": ["enabled"]},
    {"role": "checkbox", "name": "Wrap",  "auto_id": "chkWrap", "runtime_id": "1.2",
     "box": [10, 50, 90, 80], "patterns": ["toggle"], "states": ["enabled"]},
    {"role": "edit",     "name": "Name",  "auto_id": "txtName", "runtime_id": "1.3",
     "box": [10, 90, 200, 120], "patterns": ["value"], "value": "", "states": ["enabled"]},
]


@pytest.fixture
def env(monkeypatch):
    """Stubs déterministes ; renvoie la liste des (endpoint, payload) vus."""
    seen = []

    def fake_agent_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen.append((endpoint, payload))
        if endpoint == "/ui_tree":
            return {"elements": TREE, "width": 1920, "height": 1080}
        if endpoint == "/element":
            return {"ok": True, "method": "click_input", "auto_id": (payload or {}).get("auto_id")}
        return {"ok": True}

    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (FAKE_TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_agent_req", fake_agent_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 1920, 1080))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok_abc")
    # Pas de vision : on reste sur l'arbre a11y pur (déterministe).
    monkeypatch.setattr(dt._cfg, "VISION_ENDPOINT_URL", "", raising=False)
    # Neutralise le cache d'ancres PARTAGÉ (table editor_action_cache) : sinon une
    # ancre épinglée par un autre test (même scope u::t1) tranche une query qu'on
    # veut tester comme ambiguë. (La déférence à l'ancre est testée explicitement
    # dans test_pinned_anchor_defers_disambiguation.)
    monkeypatch.setattr(ds, "_lookup_pinned_anchor", lambda *a, **k: None)
    monkeypatch.setattr(ds, "_learn_anchor", lambda *a, **k: None)
    return seen


# ── T1-A : indice d'action `do` ─────────────────────────────────────────────

def test_action_hint_mapping():
    h = dt._action_hint
    assert h("checkbox", ["toggle"]) == "toggle"
    assert h("tabitem", []) == "select"
    assert h("combobox", ["expandcollapse"]) == "expand"
    assert h("edit", ["value"]) == "set"
    assert h("button", ["invoke"]) == ""        # clic simple suffit → pas d'indice


def test_merge_elements_carries_do():
    merged = dt._merge_elements(TREE, [])
    by_label = {e["label"]: e for e in merged}
    assert by_label["Wrap"]["do"] == "toggle"
    assert by_label["Name"]["do"] == "set"
    assert by_label["Save"]["do"] == ""         # bouton : clic simple


def test_do_survives_compaction():
    from llm_core._chat_with_tools import _compact_desktop_elements
    from llm_core.context.pruning import _DESKTOP_EL_KEEP  # Phase 2 : extrait
    assert "do" in _DESKTOP_EL_KEEP
    payload = json.dumps({"ok": True, "elements": [
        {"id": "el_1", "label": "Wrap", "role": "checkbox", "center": [50, 65],
         "auto_id": "chkWrap", "do": "toggle", "box": [10, 50, 90, 80], "confidence": 1.0},
    ]})
    out = json.loads(_compact_desktop_elements(payload))
    el = out["elements"][0]
    assert el["do"] == "toggle"                 # gardé
    assert "box" not in el and "confidence" not in el   # élagués


# ── T1-C : auto-routage du clic ─────────────────────────────────────────────

def test_click_autoroutes_to_element_on_chat_path(env):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "role": "button", "auto_id": "btnSave",
         "center": [50, 25], "box": [10, 10, 90, 40], "source": "a11y"},
    ])
    dt.act_core("u", "t1", op="click", element_id="el_1",
                semantic_click=True, observe_after=False, return_elements=False)
    eps = [e for e, _ in env]
    assert "/element" in eps and "/click" not in eps   # re-résolution live UIA


def test_click_stays_coords_for_studio_path(env):
    # semantic_click=False (Studio/rejeu) → clic en coordonnées, comportement INCHANGÉ.
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "role": "button", "auto_id": "btnSave",
         "center": [50, 25], "box": [10, 10, 90, 40], "source": "a11y"},
    ])
    dt.act_core("u", "t1", op="click", element_id="el_1",
                semantic_click=False, observe_after=False)
    eps = [e for e, _ in env]
    assert "/click" in eps and "/element" not in eps


def test_click_without_anchor_stays_coords(env):
    # Élément résolu mais SANS auto_id/name (vision pure) → repli /click.
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "", "role": "", "auto_id": "",
         "center": [50, 25], "box": [10, 10, 90, 40], "source": "vision"},
    ])
    dt.act_core("u", "t1", op="click", element_id="el_1",
                semantic_click=True, observe_after=False)
    eps = [e for e, _ in env]
    assert "/click" in eps and "/element" not in eps


def test_double_click_stays_coords(env):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "role": "button", "auto_id": "btnSave",
         "center": [50, 25], "box": [10, 10, 90, 40], "source": "a11y"},
    ])
    dt.act_core("u", "t1", op="double_click", element_id="el_1",
                semantic_click=True, observe_after=False)
    eps = [e for e, _ in env]
    assert "/click" in eps and "/element" not in eps   # seul le clic SIMPLE gauche auto-route


# ── T1-B : act renvoie les éléments frais ───────────────────────────────────

def test_act_returns_fresh_elements(env):
    res = dt.act_core("u", "t1", op="click", x=50, y=25,
                      semantic_click=True, return_elements=True)
    assert res["ok"] is True
    assert isinstance(res.get("elements"), list) and res["elements"]
    # les ids sont ré-ancrés et le `do` est présent → enchaînable sans re-observe
    labels = {e["label"] for e in res["elements"]}
    assert "Save" in labels and "Wrap" in labels
    assert any(e.get("do") == "toggle" for e in res["elements"])


def test_act_without_return_elements_is_frame_only(env):
    res = dt.act_core("u", "t1", op="click", x=50, y=25,
                      semantic_click=False, return_elements=False, observe_after=True)
    assert res["ok"] is True
    assert "elements" not in res
    assert res.get("frame_token") == "tok_abc"          # frame seule (chemin Studio)


# ── T2-D : troncature signalée ──────────────────────────────────────────────

def test_observe_reports_truncation(env):
    res = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_elements=2)
    assert res["ok"] is True
    assert res["truncated"] is True
    assert res["total"] == 3 and res["count"] == 2
    assert "shown" in (res.get("note") or "")


def test_observe_no_truncation_when_under_cap(env):
    res = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_elements=80)
    assert res["truncated"] is False and res["total"] == res["count"] == 3


def test_observe_full_list_is_default(monkeypatch):
    # Retour de feedback : la troncature masquait des éléments → défaut = liste
    # COMPLÈTE (max_elements=0). >0 reste possible (opt-in, importance-aware).
    assert dt._cfg.DESKTOP_MAX_ELEMENTS == 0
    big = [{"role": "button", "name": "B%d" % i, "auto_id": "b%d" % i,
            "runtime_id": "1.%d" % i, "box": [0, i * 2, 10, i * 2 + 8]} for i in range(50)]
    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": FAKE_TGT if target in ("", "t1") else None)
    monkeypatch.setattr(dt, "_agent_req",
                        lambda tgt, ep, payload=None, method="POST", timeout=None:
                        ({"elements": big, "width": 1920, "height": 1080}
                         if ep == "/ui_tree" else {"ok": True}))
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 1920, 1080))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    monkeypatch.setattr(dt._cfg, "VISION_ENDPOINT_URL", "", raising=False)
    res0 = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_elements=0)
    assert res0["count"] == 50 and res0["truncated"] is False and res0["total"] == 50
    res10 = dt.observe_core("u", "t1", use_vision=False, use_tree=True, max_elements=10)
    assert res10["count"] == 10 and res10["truncated"] is True and res10["total"] == 50


@pytest.mark.asyncio
async def test_latest_desktop_observation_exempt_from_history_pruning(monkeypatch):
    # La perception desktop la PLUS RÉCENTE (le live screen) n'est JAMAIS
    # candidate à l'élagage fin de tour (harnais v4, M4) — sinon des éléments
    # disparaissent du contexte juste avant que le modèle agisse.
    import llm_core.context.pruning as _pruning
    from llm_core._chat_with_tools import _select_prune_keys

    async def _counts(messages, model_id=None):
        return [50_000] * len(messages)

    monkeypatch.setattr(_pruning, "count_messages_tokens_per_msg", _counts)
    big_obs = ('{"ok": true, "elements": ['
               + ",".join('{"id":"el_%d","label":"Item %d"}' % (i, i) for i in range(60))
               + ']}')
    msgs = [{"role": "user", "content": "go"}]
    for cid, blob_c in (("a", "x" * 1500), ("b", big_obs), ("c", "z" * 1500),
                        ("d", "w" * 1500), ("e", "v" * 1500), ("f", "u" * 1500)):
        msgs.append({"role": "assistant", "content": None,
                     "tool_calls": [{"id": cid, "type": "function",
                                     "function": {"name": "desktop_observe" if cid == "b" else "t",
                                                  "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": cid, "content": blob_c})
    keys = set(await _select_prune_keys(msgs, ctx_size=32_768))
    marked = {m["tool_call_id"] for m in msgs
              if m.get("role") == "tool" and _pruning._prune_key(m) in keys}
    assert "b" not in marked, "perception desktop la + récente : jamais élaguée"
    assert "a" in marked, "les anciennes sorties ordinaires partent, elles"


# ── T2-F : désambiguïsation d'une query ──────────────────────────────────────

def test_ambiguous_query_blocks_with_candidates(env):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "OK", "role": "button", "auto_id": "ok1", "center": [10, 10]},
        {"id": "el_2", "label": "OK", "role": "button", "auto_id": "ok2", "center": [10, 90]},
    ])
    res = dt.act_core("u", "t1", op="click", query="OK", semantic_click=True)
    assert res["ok"] is False and res["error"] == "need_disambiguation"
    assert len(res["candidates"]) == 2
    assert {c["id"] for c in res["candidates"]} == {"el_1", "el_2"}


def test_unique_query_resolves_normally(env):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "role": "button", "auto_id": "btnSave", "center": [10, 10]},
        {"id": "el_2", "label": "Cancel", "role": "button", "auto_id": "btnCancel", "center": [10, 90]},
    ])
    res = dt.act_core("u", "t1", op="click", query="Save",
                      semantic_click=True, observe_after=False)
    assert res["ok"] is True                       # pas d'ambiguïté → agit


def test_ambiguity_ignored_on_studio_path(env):
    # semantic_click=False (Studio/rejeu) : pas de blocage de désambiguïsation.
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "OK", "role": "button", "auto_id": "ok1", "center": [10, 10]},
        {"id": "el_2", "label": "OK", "role": "button", "auto_id": "ok2", "center": [10, 90]},
    ])
    res = dt.act_core("u", "t1", op="click", query="OK",
                      semantic_click=False, observe_after=False)
    assert res["ok"] is True


def test_pinned_anchor_defers_disambiguation(env, monkeypatch):
    # Une ancre épinglée (résolution apprise) pour la query tranche → on agit sur
    # l'ancre au lieu de redemander un id, même si 2 libellés identiques existent.
    monkeypatch.setattr(ds, "_lookup_pinned_anchor",
                        lambda username, target, q: "ok2" if q == "ok" else None)
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "OK", "role": "button", "auto_id": "ok1", "center": [10, 10]},
        {"id": "el_2", "label": "OK", "role": "button", "auto_id": "ok2", "center": [10, 90]},
    ])
    res = dt.act_core("u", "t1", op="click", query="OK",
                      semantic_click=True, observe_after=False)
    assert res["ok"] is True                       # ancre → pas de need_disambiguation


# ── T4-J : garde-fou hard-stop ──────────────────────────────────────────────

# ── T-FX : faux succès d'une saisie qui n'atterrit pas ──────────────────────

def test_type_no_effect_is_reported_as_failure(env, monkeypatch):
    # Écran RIGOUREUSEMENT identique avant/après une saisie substantielle → la
    # frappe n'a pas atterri (focus). On refuse le succès muet.
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "a" * 16)
    res = dt.act_core("u", "t1", op="type", text="def f():\n    return 42\n",
                      semantic_click=True, return_elements=True)
    assert res["ok"] is False and res["error"] == "type_no_effect"
    assert "set_value" in res.get("fix", "") or "click" in res.get("fix", "")


def test_type_with_visible_change_succeeds(env, monkeypatch):
    seq = iter(["a" * 16, "b" * 16])           # avant ≠ après → l'écran a changé
    monkeypatch.setattr(dt, "_frame_sig", lambda png: next(seq, "f" * 16))
    res = dt.act_core("u", "t1", op="type", text="def f():\n    return 42\n",
                      semantic_click=True, return_elements=True)
    assert res["ok"] is True


def test_short_type_not_flagged(env, monkeypatch):
    # Texte court : un dHash 8×8 peut ne pas bouger même si la frappe a marché →
    # on NE vérifie PAS (pas de faux négatif sur un succès réel).
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "a" * 16)
    res = dt.act_core("u", "t1", op="type", text="hi",
                      semantic_click=True, return_elements=True)
    assert res["ok"] is True


def test_type_no_effect_check_skipped_on_studio_path(env, monkeypatch):
    # semantic_click=False (Studio/rejeu, saisie pilotée par l'utilisateur) → pas
    # de capture avant-frappe ni de vérif → comportement inchangé.
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "a" * 16)
    res = dt.act_core("u", "t1", op="type", text="def f():\n    return 42\n",
                      semantic_click=False, return_elements=False, observe_after=False)
    assert res["ok"] is True


def test_cycle_hardstop_constant_and_detection():
    from llm_core._chat_with_tools import _CYCLE_HARDSTOP_MAX, _detect_action_cycle
    assert isinstance(_CYCLE_HARDSTOP_MAX, int) and _CYCLE_HARDSTOP_MAX >= 1
    # Deux séries identiques → deux détections distinctes (le buffer est vidé à
    # chaque fire), de quoi atteindre le hard-stop sur un modèle réellement coincé.
    buf, fires = [], 0
    for _ in range(_CYCLE_HARDSTOP_MAX * 3):
        if _detect_action_cycle(buf, "act|op=click,id=el_1|SIG"):
            fires += 1
    assert fires >= _CYCLE_HARDSTOP_MAX
