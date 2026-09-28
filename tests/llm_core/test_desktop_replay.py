# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_replay.py — exécuteur de rejeu (Phase 4).

observe_core / act_core / resolve_element sont monkeypatchés → aucun agent ni
modèle de vision réel. Couvre : re-ancrage déterministe (a11y), auto-réparation
(vision) quand l'ancre manque, repli coords, ops sans point, et échec d'action.
"""
from __future__ import annotations

import pytest

from llm_core import _desktop_replay as dr


@pytest.fixture
def harness(monkeypatch):
    state = {"observe": [], "act": [], "resolve_queue": [], "resolve_calls": []}

    def fake_observe(username, target, prompt="", use_vision=True, use_tree=True, max_elements=80, **kw):
        state["observe"].append({"prompt": prompt, "use_vision": use_vision})
        return {"ok": True, "elements": [], "frame_token": "f"}

    # P1 : les sondes d'attente/résolution lisent l'arbre via probe_tree_core (pas
    # de screenshot). Une sonde arbre EST une lecture a11y → même liste ``observe``
    # (use_vision False), pour que les assertions « N lectures a11y » restent justes.
    def fake_probe(username, target, scope=""):
        state["observe"].append({"prompt": "", "use_vision": False, "probe": True})
        return {"ok": True, "elements": [], "frame_token": None}

    def fake_resolve(username, target, element_id=None, query=None, auto_id=None,
                     near=None, role=None, **_):
        state["resolve_calls"].append({"element_id": element_id, "query": query, "auto_id": auto_id})
        if state["resolve_queue"]:
            return state["resolve_queue"].pop(0)
        return None

    def fake_act(username, target, **kw):
        state["act"].append(kw)
        return {"ok": True, "op": kw.get("op"), "frame_token": "tok", "img_w": 1920, "img_h": 1080}

    # Sondes des attentes : grab (signature constante → l'écran est « stable »)
    # et OCR vide. Horloge factice : _sleep_ms avance le temps → les attentes
    # (stabilité par défaut) se terminent vite et sans I/O réelle.
    clock = {"t": 0}
    monkeypatch.setattr(dr, "grab_core", lambda u, t="": {"ok": True, "sig": "aaaaaaaaaaaaaaaa"})
    monkeypatch.setattr(dr, "read_text_core", lambda u, t="", *a, **k: {"ok": True, "text": ""})
    monkeypatch.setattr(dr, "_now_ms", lambda: clock["t"])
    monkeypatch.setattr(dr, "_sleep_ms", lambda ms: clock.__setitem__("t", clock["t"] + max(0, int(ms))))

    monkeypatch.setattr(dr, "observe_core", fake_observe)
    monkeypatch.setattr(dr, "probe_tree_core", fake_probe)
    monkeypatch.setattr(dr, "resolve_element", fake_resolve)
    monkeypatch.setattr(dr, "act_core", fake_act)
    state["clock"] = clock
    return state


EL = {"id": "el_1", "label": "Save", "role": "button", "center": [35, 30]}


def test_deterministic_anchor_by_label(harness):
    harness["resolve_queue"] = [EL]          # a11y trouve direct
    steps = [{"op": "click", "anchor": {"label": "Save", "role": "button"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1 and out["failed"] == 0
    r = out["results"][0]
    assert r["status"] == "passed" and r["healed"] is False
    # act appelé avec le centre résolu
    assert harness["act"][0]["op"] == "click"
    assert harness["act"][0]["x"] == 35 and harness["act"][0]["y"] == 30
    # une seule observe a11y (pas de vision)
    assert len(harness["observe"]) == 1 and harness["observe"][0]["use_vision"] is False


def test_self_heal_with_vision(harness):
    # 1er resolve (a11y) → None ; 2e resolve (après observe vision) → EL.
    harness["resolve_queue"] = [None, EL]
    steps = [{"op": "click", "anchor": {"label": "Save"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1", self_heal=True)
    r = out["results"][0]
    assert r["status"] == "passed" and r["healed"] is True
    # 2 observes : a11y puis vision (prompt = label)
    assert len(harness["observe"]) == 2
    assert harness["observe"][1]["use_vision"] is True
    assert harness["observe"][1]["prompt"] == "Save"


def test_unresolved_anchor_fails(harness):
    harness["resolve_queue"] = []            # jamais trouvé, pas de coords
    steps = [{"op": "click", "anchor": {"label": "Ghost"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["failed"] == 1
    assert out["results"][0]["status"] == "failed"
    assert out["results"][0]["error"] == "anchor_unresolved"
    assert harness["act"] == []              # aucune action tentée


def test_self_heal_summary_healed_count(harness):
    # 2 pas : le 1er est réparé par vision (healed), le 2e passe direct.
    harness["resolve_queue"] = [None, EL, EL]      # p1: a11y None → vision EL ; p2: a11y EL
    steps = [{"op": "click", "anchor": {"label": "Save"}, "args": {}},
             {"op": "click", "anchor": {"label": "OK"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1", self_heal=True)
    assert out["passed"] == 2
    assert out["healed"] == 1                       # récap : 1 pas réparé
    assert out["heal_budget_exhausted"] is False


def test_self_heal_budget_exhausted(harness, monkeypatch):
    # Budget self-heal = 1 : le 1er pas consomme la passe vision (échoue quand même),
    # le 2e ne peut PLUS se réparer → erreur enrichie « budget self-heal épuisé ».
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "DESKTOP_REPLAY_SELF_HEAL_MAX", 1, raising=False)
    harness["resolve_queue"] = []                  # jamais résolu (ni a11y ni vision)
    steps = [{"op": "click", "anchor": {"label": "A"}, "args": {}},
             {"op": "click", "anchor": {"label": "B"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1", self_heal=True)
    assert out["failed"] == 2
    assert out["heal_budget_exhausted"] is True
    # Le 2e pas (self-heal refusée) porte le motif enrichi ; le 1er a consommé la passe.
    assert "budget self-heal épuisé" in (out["results"][1]["error"] or "")


def test_self_heal_max_configurable(harness, monkeypatch):
    # Cap 0 → aucune passe vision autorisée, même avec self_heal=True.
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "DESKTOP_REPLAY_SELF_HEAL_MAX", 0, raising=False)
    harness["resolve_queue"] = [None]              # a11y None ; vision interdite
    steps = [{"op": "click", "anchor": {"label": "Save"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1", self_heal=True)
    assert out["failed"] == 1
    # aucune observe VISION n'a eu lieu (que la sonde a11y).
    assert all(not c["use_vision"] for c in harness["observe"])


def test_coords_fallback_no_observe(harness):
    steps = [{"op": "click", "anchor": {"x": 600, "y": 400}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1
    assert harness["act"][0]["x"] == 600 and harness["act"][0]["y"] == 400
    assert harness["observe"] == []          # coords directes → pas d'observe


def test_non_point_op_skips_resolve(harness):
    steps = [{"op": "type", "anchor": {}, "args": {"text": "bonjour"}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1
    assert harness["act"][0]["op"] == "type" and harness["act"][0]["text"] == "bonjour"
    assert "x" not in harness["act"][0]
    assert harness["resolve_calls"] == []    # pas de point à résoudre


def test_act_failure_marks_step_failed(harness, monkeypatch):
    harness["resolve_queue"] = [EL]
    monkeypatch.setattr(dr, "act_core",
                        lambda u, t, **kw: {"ok": False, "error": "agent_unreachable"})
    steps = [{"op": "click", "anchor": {"label": "Save"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["failed"] == 1
    assert out["results"][0]["status"] == "failed"
    assert out["results"][0]["error"] == "agent_unreachable"


def test_on_step_callback_invoked_per_step(harness):
    harness["resolve_queue"] = [EL, EL]
    seen = []
    steps = [
        {"op": "click", "anchor": {"label": "Save"}, "args": {}},
        {"op": "type", "anchor": {}, "args": {"text": "x"}},
    ]
    dr.replay_scenario(steps, "u", "vm1", on_step=lambda rec: seen.append(rec["step_index"]))
    assert seen == [0, 1]


# ── Politique d'échec : retry / abort / from_step (P0.1) ──────────────────────
def test_retry_succeeds_on_second_attempt(harness, monkeypatch):
    harness["resolve_queue"] = [EL, EL]      # une résolution par tentative
    calls = {"n": 0}

    def flaky_act(u, t, **kw):
        calls["n"] += 1
        if calls["n"] == 1:                  # 1ʳᵉ tentative KO (transitoire)…
            return {"ok": False, "error": "agent_timeout"}
        return {"ok": True, "op": kw.get("op"), "frame_token": "tok"}
    monkeypatch.setattr(dr, "act_core", flaky_act)

    steps = [{"op": "click", "anchor": {"label": "Save"}, "args": {}, "retry": 1}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1 and out["failed"] == 0
    assert out["results"][0]["attempts"] == 2 and out["results"][0]["status"] == "passed"


def test_abort_skips_remaining_steps(harness, monkeypatch):
    harness["resolve_queue"] = [EL, EL, EL]
    seq = {"n": 0}

    def act(u, t, **kw):
        seq["n"] += 1
        if seq["n"] == 2:                    # le 2e pas casse
            return {"ok": False, "error": "boom"}
        return {"ok": True, "op": kw.get("op"), "frame_token": "tok"}
    monkeypatch.setattr(dr, "act_core", act)

    steps = [
        {"op": "click", "anchor": {"label": "Save"}, "args": {}},
        {"op": "click", "anchor": {"label": "Save"}, "args": {}, "on_error": "abort"},
        {"op": "click", "anchor": {"label": "Save"}, "args": {}},
    ]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1 and out["failed"] == 1 and out["skipped"] == 1
    assert out["aborted"] is True
    assert [r["status"] for r in out["results"]] == ["passed", "failed", "skipped"]
    assert seq["n"] == 2                      # le 3e pas n'a jamais agi (sauté)


def test_from_step_resumes_midway(harness):
    harness["resolve_queue"] = [EL, EL, EL]
    steps = [
        {"op": "click", "anchor": {"label": "Save"}, "args": {}},
        {"op": "click", "anchor": {"label": "Save"}, "args": {}},
        {"op": "click", "anchor": {"label": "Save"}, "args": {}},
    ]
    out = dr.replay_scenario(steps, "u", "vm1", from_step=1)
    assert out["from_step"] == 1 and out["total"] == 3
    assert out["skipped"] == 1               # le pas 0, non rejoué
    assert out["passed"] == 2 and out["failed"] == 0
    assert [r["step_index"] for r in out["results"]] == [1, 2]
    assert len(harness["act"]) == 2          # seuls les pas 1 et 2 ont agi


# ── C2 : budget de SELF-HEAL vision PAR RUN ──────────────────────────────────

def test_self_heal_live_path_never_capped():
    # Hors rejeu (cible jamais "begin") → self-heal JAMAIS bornée (chemin live
    # desktop_wait) : sinon le budget fuiterait sur les attentes interactives.
    assert dr._self_heal_allow("liveTarget") is True


def test_self_heal_budget_exhausts_then_resets():
    cap = dr._self_heal_cap()                     # budget effectif (config, défaut 10)
    dr._self_heal_begin("t2")
    allowed = sum(1 for _ in range(cap + 5) if dr._self_heal_allow("t2"))
    assert allowed == cap                         # exactement le budget, pas plus
    assert dr._self_heal_allow("t2") is False     # épuisé
    dr._self_heal_end("t2")
    assert dr._self_heal_allow("t2") is True       # cible nettoyée → redevient live


def test_self_heal_budget_caps_vision_in_replay(harness, monkeypatch):
    # Budget = 1 (config) : sur 2 pas qui ratent l'a11y, UNE seule self-heal vision
    # permise ; le 2e pas retombe sur ses coords brutes (pas de 2e passe coûteuse).
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "DESKTOP_REPLAY_SELF_HEAL_MAX", 1, raising=False)
    harness["resolve_queue"] = [None, EL, None]   # p1 a11y✗ → vision✓ ; p2 a11y✗ → coords
    steps = [
        {"op": "click", "anchor": {"label": "A"}, "args": {}},
        {"op": "click", "anchor": {"label": "B", "x": 5, "y": 6}, "args": {}},
    ]
    out = dr.replay_scenario(steps, "u", "vm1", self_heal=True)
    assert out["passed"] == 2
    vision_observes = [o for o in harness["observe"] if o["use_vision"]]
    assert len(vision_observes) == 1              # la 2e self-heal a été coupée par le budget
    assert "vm1" not in dr._self_heal_left         # pas de fuite après le run


# ── Arrêt coopératif du rejeu (« Arrêter ») ─────────────────────────────────

def test_sleep_ms_raises_when_aborted():
    import pytest as _pt
    dr._set_abort_check(lambda: True)
    try:
        with _pt.raises(dr.ReplayAborted):
            dr._sleep_ms(1)
    finally:
        dr._clear_abort_check()
    # sans annulation : ne lève pas.
    dr._set_abort_check(lambda: False)
    dr._sleep_ms(0)
    dr._clear_abort_check()
    dr._sleep_ms(0)            # check absent → ne lève pas non plus


def test_replay_cancelled_between_steps(harness):
    harness["resolve_queue"] = [EL, EL, EL]
    calls = {"n": 0}
    def abort():                                   # False au 1er pas, True ensuite
        calls["n"] += 1
        return calls["n"] >= 2
    steps = [{"op": "click", "anchor": {"label": "Save"}, "args": {}} for _ in range(3)]
    out = dr.replay_scenario(steps, "u", "vm1", should_abort=abort)
    assert out["cancelled"] is True
    assert out["passed"] == 1                       # seul le 1er pas a joué
    assert out["skipped"] == 2                       # les 2 suivants sautés
    assert len(harness["act"]) == 1                  # une seule action exécutée


def test_replay_not_cancelled_without_abort(harness):
    harness["resolve_queue"] = [EL, EL]
    steps = [{"op": "click", "anchor": {"label": "Save"}, "args": {}} for _ in range(2)]
    out = dr.replay_scenario(steps, "u", "vm1")      # should_abort=None
    assert out["cancelled"] is False and out["passed"] == 2


def test_replay_semantic_op_threads_anchor(harness):
    # Une op SÉMANTIQUE (toggle) rejoue en threadant l'ancre (auto_id/nom/rôle)
    # vers act_core — pas de point requis (l'agent re-résout par auto_id).
    steps = [{"op": "toggle", "anchor": {"auto_id": "chk1", "label": "Wifi", "role": "checkbox"}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1
    kw = harness["act"][0]
    assert kw["op"] == "toggle" and kw["auto_id"] == "chk1" and kw["name"] == "Wifi"


def test_uia_click_skips_anchor_probe(harness):
    # P1-é2 : un clic ancré auto_id → invoke par id, coords ENREGISTRÉES en repli,
    # SANS sonder l'arbre pour se résoudre (l'expect « stable » ne lit pas l'arbre
    # non plus). Aucune lecture a11y ne doit avoir lieu pour ce pas.
    steps = [{"op": "click",
              "anchor": {"auto_id": "okBtn", "label": "OK", "role": "button", "center": [12, 34]},
              "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1
    kw = harness["act"][0]
    assert kw["op"] == "invoke" and kw["auto_id"] == "okBtn"
    assert kw["x"] == 12 and kw["y"] == 34            # coords enregistrées en repli
    assert harness["resolve_calls"] == []             # aucune résolution
    assert harness["observe"] == []                   # AUCUNE sonde arbre pour ce pas


# ── « Texte partiel » : modes de comparaison Texte/Valeur ───────────────────

def test_text_cmp_modes():
    assert dr._text_cmp("Hello World", "world", "partiel") is True
    assert dr._text_cmp("Hello World", "world", "exact") is False
    assert dr._text_cmp("  Hello  ", "hello", "exact") is True       # normalisé
    assert dr._text_cmp("abc123", r"\d+", "regex") is True
    assert dr._text_cmp("anything", "", "partiel") is True            # needle vide → non vide
    assert dr._text_cmp("", "x", "partiel") is False


def test_expect_cmp_resolution():
    assert dr._expect_cmp({"cmp": "exact"}) == "exact"
    assert dr._expect_cmp({"match": True}) == "regex"                 # ancien booléen
    assert dr._expect_cmp({}) == "partiel"
    # rétro-compat de _value_matches avec un booléen
    assert dr._value_matches("4.2", r"\d", True) is True
    assert dr._value_matches("hello", "ell", False) is True
