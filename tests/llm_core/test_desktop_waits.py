# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_waits.py — attentes intelligentes du rejeu (action →
vérification d'événement fiable).

Toutes les sondes (grab/observe/resolve/read) sont monkeypatchées et le TEMPS est
factice (``_sleep_ms`` avance une horloge) → les attentes se terminent
instantanément et de façon déterministe, sans agent ni modèle réels.
"""
from __future__ import annotations

import pytest

from llm_core import _desktop_replay as dr

EL = {"center": [10, 20], "label": "Dialog"}
HEXA = "aaaaaaaaaaaaaaaa"


@pytest.fixture
def wh(monkeypatch):
    clock = {"t": 0}
    st = {
        "clock": clock,
        "grab_fn": lambda: HEXA,        # signature dHash (hex valide) ; constante = stable
        "resolve_fn": lambda: None,     # élément résolu (dict avec center) ou None
        "text_fn": lambda: "",          # texte OCR
        "elements_fn": lambda: [],      # éléments observés (pour wait_appear)
        "observe_calls": [],            # sondes arbre (probe) + observes vision
        "grab_calls": 0,                # P1 : aucune sonde d'attente ne doit grabber
        "vision_done": False,
        "act": [],
    }

    def now():
        return clock["t"]

    def sleep(ms):
        clock["t"] += max(0, int(ms))

    def grab(u, t=""):
        st["grab_calls"] += 1
        return {"ok": True, "sig": st["grab_fn"]()}

    def probe(u, t="", scope=""):
        # Sonde arbre-seul (P1) : PAS de screenshot, PAS de vision.
        st["observe_calls"].append({"use_vision": False, "prompt": "", "probe": True})
        return {"ok": True, "elements": st["elements_fn"]()}

    def observe(u, t="", prompt="", use_vision=True, use_tree=True, max_elements=80, **kw):
        st["observe_calls"].append({"use_vision": use_vision, "prompt": prompt})
        if use_vision:
            st["vision_done"] = True
        return {"ok": True, "elements": st["elements_fn"]()}

    def resolve(u, t="", element_id=None, query=None, **kw):
        return st["resolve_fn"]()

    def read(u, t="", *a, **k):
        return {"ok": True, "text": st["text_fn"]()}

    def act(u, t="", **kw):
        st["act"].append(kw)
        return {"ok": True, "op": kw.get("op"), "frame_token": "tok"}

    monkeypatch.setattr(dr, "_now_ms", now)
    monkeypatch.setattr(dr, "_sleep_ms", sleep)
    monkeypatch.setattr(dr, "grab_core", grab)
    monkeypatch.setattr(dr, "probe_tree_core", probe)
    monkeypatch.setattr(dr, "observe_core", observe)
    monkeypatch.setattr(dr, "resolve_element", resolve)
    monkeypatch.setattr(dr, "read_text_core", read)
    monkeypatch.setattr(dr, "act_core", act)
    return st


# ── clamp 1,5 s → 5 min (défaut 30 s) ───────────────────────────────────────
def test_clamp_timeout():
    assert dr._clamp_timeout(None) == 30_000            # défaut quand non précisé
    assert dr._clamp_timeout(10_000) == 10_000          # > plancher → conservé
    assert dr._clamp_timeout(500) == 1_500              # plancher fast-fail 1,5 s
    assert dr._clamp_timeout(60_000) == 60_000
    assert dr._clamp_timeout(9_999_999) == 300_000      # plafond 5 min
    assert dr._clamp_timeout("nope") == 30_000


# ── wait_stable ─────────────────────────────────────────────────────────────
def test_wait_stable_settles(wh):
    sigs = iter(["0000000000000000", "ffffffffffffffff", HEXA])
    wh["grab_fn"] = lambda: next(sigs, HEXA)
    waited = dr.wait_stable("u", "vm1", timeout_ms=30_000)
    assert 0 < waited < 30_000                          # s'est stabilisé avant le délai


def test_wait_stable_times_out_if_never_stable(wh):
    cnt = {"i": 0}

    def flip():
        cnt["i"] += 1
        return "ffffffffffffffff" if cnt["i"] % 2 else "0000000000000000"
    wh["grab_fn"] = flip
    waited = dr.wait_stable("u", "vm1", timeout_ms=3_000)
    assert waited >= 2_500                               # a attendu ~le budget, sans boucler à l'infini


# ── wait_element ────────────────────────────────────────────────────────────
def test_wait_element_present_appears(wh):
    seq = iter([None, None, EL])
    wh["resolve_fn"] = lambda: next(seq, EL)
    ok, waited = dr.wait_element("u", "vm1", "Dialog", present=True, timeout_ms=30_000)
    assert ok is True and waited > 0
    # P1 : la sonde d'attente lit l'arbre (probe_tree_core), JAMAIS de screenshot.
    assert wh["grab_calls"] == 0
    assert all(c.get("probe") for c in wh["observe_calls"])   # que des sondes arbre


def test_wait_element_absent_when_disappears(wh):
    seq = iter([EL, EL, None])
    wh["resolve_fn"] = lambda: next(seq, None)
    ok, _ = dr.wait_element("u", "vm1", "Splash", present=False, timeout_ms=30_000)
    assert ok is True


def test_wait_element_self_heal_at_deadline(wh):
    # a11y ne trouve jamais ; seule la passe VISION (en fin de budget) résout.
    wh["resolve_fn"] = lambda: EL if wh["vision_done"] else None
    ok, _ = dr.wait_element("u", "vm1", "Dialog", present=True, timeout_ms=2_000)
    assert ok is True
    assert any(c["use_vision"] for c in wh["observe_calls"])     # une passe vision a eu lieu
    assert wh["observe_calls"][-1]["prompt"] == "Dialog"


def test_wait_element_never_found_fails(wh):
    wh["resolve_fn"] = lambda: None
    ok, waited = dr.wait_element("u", "vm1", "Ghost", present=True, timeout_ms=2_000)
    assert ok is False and waited >= 2_000


# ── wait_text ───────────────────────────────────────────────────────────────
def test_wait_text_present(wh):
    seq = iter(["", "", "Prêt à l'emploi"])
    wh["text_fn"] = lambda: next(seq, "Prêt à l'emploi")
    wh["grab_fn"] = lambda: ""        # écran « qui bouge » → OCR à chaque sonde
    ok, _ = dr.wait_text("u", "vm1", "prêt", present=True, timeout_ms=30_000)
    assert ok is True


def test_wait_text_gone(wh):
    seq = iter(["Chargement…", "Chargement…", "Accueil"])
    wh["text_fn"] = lambda: next(seq, "Accueil")
    wh["grab_fn"] = lambda: ""
    ok, _ = dr.wait_text("u", "vm1", "Chargement", present=False, timeout_ms=30_000)
    assert ok is True


def test_wait_text_skips_ocr_on_static_screen(wh):
    # Écran FIGÉ (signature constante) → l'OCR coûteux n'est fait qu'UNE fois.
    ocr = {"n": 0}

    def text():
        ocr["n"] += 1
        return "rien d'utile ici"
    wh["text_fn"] = text
    wh["grab_fn"] = lambda: "aaaaaaaaaaaaaaaa"
    ok, _ = dr.wait_text("u", "vm1", "introuvable", present=True, timeout_ms=3_000)
    assert ok is False
    assert ocr["n"] == 1, "écran inchangé → OCR réutilisé (un seul appel)"


# ── wait_appear (nouvelle fenêtre / éléments) ───────────────────────────────
def test_wait_appear_new_window(wh):
    seq = iter([[], [], [{"label": "Bloc-notes", "role": "window"}]])
    wh["elements_fn"] = lambda: next(seq, [{"label": "Bloc-notes", "role": "window"}])
    ok, waited = dr.wait_appear("u", "vm1", set(), timeout_ms=30_000)
    assert ok is True and waited > 0


def test_wait_appear_timeout_when_nothing_new(wh):
    base = {dr._el_key({"label": "Bureau", "role": "pane"})}
    wh["elements_fn"] = lambda: [{"label": "Bureau", "role": "pane"}]   # rien d'inédit
    ok, waited = dr.wait_appear("u", "vm1", base, timeout_ms=2_000)
    assert ok is False and waited >= 2_000


def test_wait_appear_min_new_elements(wh):
    new_els = [{"label": "A", "role": "button"}, {"label": "B", "role": "button"},
               {"label": "C", "role": "button"}]                       # pas de fenêtre mais ≥3 inédits
    wh["elements_fn"] = lambda: new_els
    ok, _ = dr.wait_appear("u", "vm1", set(), timeout_ms=30_000)
    assert ok is True


def test_replay_appear_baseline_then_window(wh):
    calls = {"n": 0}

    def els():
        calls["n"] += 1
        if calls["n"] == 1:                       # baseline (observe AVANT l'action)
            return [{"label": "Bureau", "role": "pane"}]
        return [{"label": "Bureau", "role": "pane"}, {"label": "Éditeur", "role": "window"}]
    wh["elements_fn"] = els
    steps = [{"op": "double_click", "anchor": {"x": 5, "y": 5}, "args": {},
              "expect": {"kind": "appear"}, "timeout_ms": 60_000}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1
    assert out["results"][0]["expect"] == "appear"
    assert wh["act"], "l'action a bien été exécutée"


# ── check_expect (dispatch) ─────────────────────────────────────────────────
def test_check_expect_none_and_stable(wh):
    ok, waited, detail = dr.check_expect("u", "vm1", {"kind": "none"}, 30_000)
    assert ok is True and waited == 0 and detail == "none"
    ok, _, detail = dr.check_expect("u", "vm1", {"kind": "stable"}, 30_000)
    assert ok is True and detail == "stable"


def test_check_expect_element(wh):
    seq = iter([None, EL])
    wh["resolve_fn"] = lambda: next(seq, EL)
    ok, _, detail = dr.check_expect("u", "vm1", {"kind": "element", "query": "Dialog"}, 30_000)
    assert ok is True and "element" in detail and "Dialog" in detail


# ── replay : un pas honore son expect + timeout ─────────────────────────────
def test_replay_step_passes_when_expect_met(wh):
    seq = iter([None, EL])
    wh["resolve_fn"] = lambda: next(seq, EL)
    steps = [{"op": "click", "anchor": {"x": 5, "y": 5}, "args": {},
              "expect": {"kind": "element", "query": "Dialog"}, "timeout_ms": 60_000}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1 and out["failed"] == 0
    r = out["results"][0]
    assert r["status"] == "passed" and r["waited_ms"] > 0 and "element" in r["expect"]
    assert wh["act"] and wh["act"][0]["op"] == "click"          # l'action a bien eu lieu


def test_replay_step_fails_on_expect_timeout(wh):
    wh["resolve_fn"] = lambda: None                              # l'événement n'arrive jamais
    steps = [{"op": "click", "anchor": {"x": 5, "y": 5}, "args": {},
              "expect": {"kind": "element", "query": "Ghost"}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["failed"] == 1
    r = out["results"][0]
    assert r["status"] == "failed" and r["error"].startswith("expect_timeout")
    assert wh["act"], "l'action est exécutée ; seule la VÉRIFICATION échoue"


def test_replay_default_expect_is_stable(wh):
    # pas sans expect → attente par défaut = stabilité (grab constant → OK).
    steps = [{"op": "click", "anchor": {"x": 5, "y": 5}, "args": {}}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1
    assert out["results"][0]["expect"] == "stable"


# ── _value_matches / _count_ok (helpers purs) ────────────────────────────────
def test_value_matches_substring_insensitive():
    assert dr._value_matches("Total : 42,00 €", "42,00", False) is True
    assert dr._value_matches("Total : 42,00 €", "TOTAL", False) is True   # casse ignorée
    assert dr._value_matches("Total : 42,00 €", "99", False) is False


def test_value_matches_empty_needle_means_non_empty():
    assert dr._value_matches("quoi que ce soit", "", False) is True
    assert dr._value_matches("   ", "", False) is False                   # blanc = vide


def test_value_matches_regex_and_bad_regex():
    assert dr._value_matches("ref AB-1234", r"AB-\d{4}", True) is True
    assert dr._value_matches("ref AB-12", r"AB-\d{4}", True) is False
    assert dr._value_matches("a(b", "a(b", True) is True                  # regex invalide → littéral


def test_count_ok_operators():
    assert dr._count_ok(3, "==", 3) is True
    assert dr._count_ok(3, ">=", 2) is True
    assert dr._count_ok(3, "<=", 3) is True
    assert dr._count_ok(3, ">", 3) is False
    assert dr._count_ok(1, "<", 3) is True
    assert dr._count_ok(3, "bogus", 3) is True                           # défaut ==


# ── wait_value (valeur a11y puis repli OCR) ──────────────────────────────────
def test_wait_value_matches_a11y_value(wh):
    seq = iter([{"id": "el_1", "value": "0,00 €"}, {"id": "el_1", "value": "42,00 €"}])
    wh["resolve_fn"] = lambda: next(seq, {"id": "el_1", "value": "42,00 €"})
    ok, waited = dr.wait_value("u", "vm1", "Total", "42,00", present=True, timeout_ms=30_000)
    assert ok is True and waited > 0


def test_wait_value_ocr_fallback(wh):
    # l'élément n'expose PAS de value a11y → on lit l'OCR ciblé sur sa box.
    wh["resolve_fn"] = lambda: {"id": "el_7"}
    wh["text_fn"] = lambda: "Solde : 1 337"
    ok, _ = dr.wait_value("u", "vm1", "Solde", "1 337", present=True, timeout_ms=30_000)
    assert ok is True


def test_wait_value_regex(wh):
    wh["resolve_fn"] = lambda: {"id": "el_1", "value": "Commande N°2026-0042"}
    ok, _ = dr.wait_value("u", "vm1", "Commande", r"N°\d{4}-\d{4}", present=True,
                          cmp="regex", timeout_ms=30_000)
    assert ok is True


def test_wait_value_exact_vs_partiel(wh):
    wh["resolve_fn"] = lambda: {"id": "el_1", "value": "OK partiel"}
    # exact : « ok » ≠ « OK partiel » → non satisfait
    assert dr.wait_value("u", "vm1", "Etat", "ok", present=True, cmp="exact", timeout_ms=1_000)[0] is False
    # partiel (défaut) : « ok » ⊂ « OK partiel » → satisfait
    assert dr.wait_value("u", "vm1", "Etat", "ok", present=True, cmp="partiel", timeout_ms=1_000)[0] is True


def test_wait_value_gone(wh):
    seq = iter([{"id": "el_1", "value": "Erreur"}, {"id": "el_1", "value": ""}])
    wh["resolve_fn"] = lambda: next(seq, {"id": "el_1", "value": ""})
    ok, _ = dr.wait_value("u", "vm1", "Champ", "Erreur", present=False, timeout_ms=30_000)
    assert ok is True


def test_wait_value_timeout_when_never_matches(wh):
    wh["resolve_fn"] = lambda: {"id": "el_1", "value": "0,00 €"}
    ok, waited = dr.wait_value("u", "vm1", "Total", "42,00", present=True, timeout_ms=2_000)
    assert ok is False and waited >= 2_000


def test_wait_value_does_not_use_vision(wh):
    wh["resolve_fn"] = lambda: {"id": "el_1", "value": "42"}
    dr.wait_value("u", "vm1", "Total", "42", present=True, timeout_ms=30_000)
    assert wh["observe_calls"] and not any(c["use_vision"] for c in wh["observe_calls"])


# ── wait_state (états a11y : checked/enabled/selected…) ──────────────────────
def test_wait_state_checked(wh):
    seq = iter([{"id": "el_1", "states": ["enabled"]},
                {"id": "el_1", "states": ["enabled", "checked"]}])
    wh["resolve_fn"] = lambda: next(seq, {"id": "el_1", "states": ["enabled", "checked"]})
    ok, waited = dr.wait_state("u", "vm1", "Activer", "checked", timeout_ms=30_000)
    assert ok is True and waited > 0


def test_wait_state_timeout(wh):
    wh["resolve_fn"] = lambda: {"id": "el_1", "states": ["enabled"]}
    ok, waited = dr.wait_state("u", "vm1", "Case", "checked", timeout_ms=2_000)
    assert ok is False and waited >= 2_000


# ── wait_count (cardinalité d'un jeu d'éléments) ─────────────────────────────
def test_wait_count_ge(wh):
    rows = [{"label": "Ligne 1", "role": "row"}, {"label": "Ligne 2", "role": "row"},
            {"label": "Ligne 3", "role": "row"}, {"label": "Entête", "role": "header"}]
    seq = iter([[], rows])
    wh["elements_fn"] = lambda: next(seq, rows)
    ok, waited = dr.wait_count("u", "vm1", "Ligne", "row", ">=", 3, timeout_ms=30_000)
    assert ok is True and waited > 0


def test_wait_count_by_role_only(wh):
    els = [{"label": "x", "role": "button"}, {"label": "y", "role": "button"},
           {"label": "z", "role": "text"}]
    wh["elements_fn"] = lambda: els
    ok, _ = dr.wait_count("u", "vm1", "", "button", "==", 2, timeout_ms=30_000)
    assert ok is True


def test_wait_count_timeout(wh):
    wh["elements_fn"] = lambda: [{"label": "Ligne 1", "role": "row"}]
    ok, waited = dr.wait_count("u", "vm1", "Ligne", "row", ">=", 3, timeout_ms=2_000)
    assert ok is False and waited >= 2_000


# ── check_expect : dispatch value / state / count ────────────────────────────
def test_check_expect_value_dispatch(wh):
    seq = iter([{"id": "el_1", "value": "…"}, {"id": "el_1", "value": "Terminé"}])
    wh["resolve_fn"] = lambda: next(seq, {"id": "el_1", "value": "Terminé"})
    ok, _, detail = dr.check_expect(
        "u", "vm1", {"kind": "value", "query": "Statut", "expected": "Terminé"}, 30_000)
    assert ok is True and detail.startswith("value") and "Terminé" in detail


def test_check_expect_state_dispatch(wh):
    wh["resolve_fn"] = lambda: {"id": "el_1", "states": ["enabled", "selected"]}
    ok, _, detail = dr.check_expect(
        "u", "vm1", {"kind": "state", "query": "Onglet", "state": "selected"}, 30_000)
    assert ok is True and "state" in detail and "selected" in detail


def test_check_expect_count_dispatch(wh):
    els = [{"label": "Mail 1", "role": "row"}, {"label": "Mail 2", "role": "row"}]
    wh["elements_fn"] = lambda: els
    ok, _, detail = dr.check_expect(
        "u", "vm1",
        {"kind": "count", "query": "Mail", "role": "row", "op": ">=", "count": 2}, 30_000)
    assert ok is True and detail.startswith("count")


def test_replay_step_with_value_expect(wh):
    seq = iter([{"id": "el_1", "value": "0"}, {"id": "el_1", "value": "42,00 €"}])
    wh["resolve_fn"] = lambda: next(seq, {"id": "el_1", "value": "42,00 €"})
    steps = [{"op": "type", "anchor": {"x": 5, "y": 5}, "args": {"text": "42"},
              "expect": {"kind": "value", "query": "Total", "expected": "42,00"},
              "timeout_ms": 60_000}]
    out = dr.replay_scenario(steps, "u", "vm1")
    assert out["passed"] == 1 and out["failed"] == 0
    assert out["results"][0]["expect"].startswith("value")
