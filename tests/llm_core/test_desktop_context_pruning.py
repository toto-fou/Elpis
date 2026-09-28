# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_context_pruning.py — élagage du contexte chat
pour les automatisations computer-use (lot « quick wins » fiabilité/coût).

Verrouille trois transformateurs purs du moteur :
  - ``_compact_desktop_elements`` : slim le tool_result perception (elements).
  - ``_prune_old_vision_frames``  : ne garde que les N dernières images base64.
  - ``_action_cycle_signature`` / ``_detect_action_cycle`` : anti-boucle.
"""
from __future__ import annotations

import copy
import json

from llm_core._chat_with_tools import (
    _compact_desktop_elements,
    _prune_old_vision_frames,
    _action_cycle_signature,
    _detect_action_cycle,
    _VISION_FRAME_PLACEHOLDER,
)


# ── _compact_desktop_elements ────────────────────────────────────────────────
def _observe_result():
    return json.dumps({
        "ok": True, "target": "vm1", "count": 2,
        "img_w": 1920, "img_h": 1080, "sig": "aaaaaaaaaaaaaaaa",
        "frame_token": "tok_abc", "vision_used": True, "tree_used": True,
        "note": None,
        "elements": [
            {"id": "el_0", "label": "Enregistrer", "role": "button",
             "center": [100, 200], "box": [90, 190, 120, 220], "auto_id": "saveBtn",
             "confidence": 0.97, "source": "a11y", "depth": 4,
             "states": ["enabled", "focusable", "invisible-x", "y", "z", "w", "extra"]},
            {"id": "el_1", "label": "Total", "role": "text",
             "center": [300, 400], "box": [280, 390, 360, 410], "value": "42,00 €",
             "confidence": 0.5, "source": "vision"},
        ],
    })


def test_compact_keeps_only_essential_element_fields():
    out = json.loads(_compact_desktop_elements(_observe_result()))
    e0 = out["elements"][0]
    assert set(e0) <= {"id", "label", "role", "center", "auto_id", "value", "states"}
    assert e0["id"] == "el_0" and e0["auto_id"] == "saveBtn"
    assert "box" not in e0 and "confidence" not in e0 and "source" not in e0 and "depth" not in e0
    assert len(e0["states"]) == 6                       # états capés à 6


def test_compact_drops_studio_frame_metadata():
    out = json.loads(_compact_desktop_elements(_observe_result()))
    for k in ("frame_token", "img_w", "img_h", "sig", "vision_used", "tree_used"):
        assert k not in out
    assert out["target"] == "vm1" and out["count"] == 2   # méta utile conservée


def test_compact_keeps_value_when_present():
    out = json.loads(_compact_desktop_elements(_observe_result()))
    assert out["elements"][1]["value"] == "42,00 €"


def test_compact_shrinks_payload():
    src = _observe_result()
    assert len(_compact_desktop_elements(src)) < len(src)


def test_compact_passthrough_on_non_desktop():
    assert _compact_desktop_elements("just a string") == "just a string"
    assert _compact_desktop_elements('{"ok":true,"data":1}') == '{"ok":true,"data":1}'
    assert _compact_desktop_elements('{"elements": "not a list"}') == '{"elements": "not a list"}'


def test_compact_does_not_mutate_or_crash_on_garbage():
    assert _compact_desktop_elements('{"elements": [oops not json') == '{"elements": [oops not json'
    assert _compact_desktop_elements(None) is None


# ── _prune_old_vision_frames ─────────────────────────────────────────────────
def _img_msg(tag):
    return {"role": "user", "content": [
        {"type": "text", "text": f"capture {tag}"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{tag*50}"}},
    ]}


def _history_with_frames(n):
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "go"}]
    for i in range(n):
        msgs.append({"role": "assistant", "content": "", "tool_calls": [
            {"id": f"c{i}", "type": "function", "function": {"name": "desktop_observe", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": "{}"})
        msgs.append(_img_msg(chr(ord("A") + i)))
    return msgs


def _img_count(m):
    c = m.get("content")
    return sum(1 for b in c if isinstance(b, dict) and b.get("type") == "image_url") \
        if isinstance(c, list) else 0


def test_prune_keeps_last_two_images():
    msgs = _history_with_frames(5)
    out = _prune_old_vision_frames(msgs, keep=2)
    kept = [m for m in out if _img_count(m)]
    assert len(kept) == 2
    # ce sont bien les 2 DERNIÈRES (D, E)
    assert any("data:image" in b.get("image_url", {}).get("url", "")
               for m in kept for b in m["content"] if isinstance(b, dict))


def test_prune_replaces_old_images_with_placeholder():
    msgs = _history_with_frames(4)
    out = _prune_old_vision_frames(msgs, keep=2)
    stripped = [m for m in out if isinstance(m.get("content"), list)
                and any(isinstance(b, dict) and b.get("text") == _VISION_FRAME_PLACEHOLDER
                        for b in m["content"])]
    assert len(stripped) == 2                       # A, B élidées
    # un message élidé garde son texte d'origine + le placeholder, plus d'image
    for m in stripped:
        assert _img_count(m) == 0


def test_prune_noop_when_few_images():
    msgs = _history_with_frames(2)
    assert _prune_old_vision_frames(msgs, keep=2) is msgs   # renvoyé tel quel


def test_prune_does_not_mutate_input():
    msgs = _history_with_frames(5)
    snap = copy.deepcopy(msgs)
    _prune_old_vision_frames(msgs, keep=2)
    assert msgs == snap, "la liste d'origine a été mutée"


def test_prune_keep_zero_strips_all():
    msgs = _history_with_frames(3)
    out = _prune_old_vision_frames(msgs, keep=0)
    assert all(_img_count(m) == 0 for m in out)


# ── détection de cycle ───────────────────────────────────────────────────────
def test_signature_stable_for_same_action_same_screen():
    a = _action_cycle_signature("desktop_act", {"op": "click", "id": "el_3"}, "SIG1")
    b = _action_cycle_signature("desktop_act", {"op": "click", "id": "el_3"}, "SIG1")
    assert a == b


def test_signature_differs_when_screen_changes():
    a = _action_cycle_signature("desktop_act", {"op": "click", "id": "el_3"}, "SIG1")
    b = _action_cycle_signature("desktop_act", {"op": "click", "id": "el_3"}, "SIG2")
    assert a != b                                   # l'écran a bougé → pas un cycle


def test_detect_cycle_after_threshold():
    buf: list[str] = []
    sig = _action_cycle_signature("desktop_act", {"op": "click", "id": "el_3"}, "SIG1")
    assert _detect_action_cycle(buf, sig) is False   # 1
    assert _detect_action_cycle(buf, sig) is False   # 2
    assert _detect_action_cycle(buf, sig) is True    # 3 → cycle
    assert buf == [], "le buffer est vidé après alerte (ne re-nudge pas en boucle)"


def test_progress_resets_cycle():
    buf: list[str] = []
    # même action mais l'écran CHANGE à chaque fois (sig différent) → jamais de cycle
    for i in range(5):
        sig = _action_cycle_signature("desktop_act", {"op": "click", "id": "el_3"}, f"SIG{i}")
        assert _detect_action_cycle(buf, sig) is False


def test_window_is_bounded():
    buf: list[str] = []
    for i in range(20):
        _detect_action_cycle(buf, f"uniq{i}", window=6)
    assert len(buf) <= 6


# ── P10 : cap desktop lu à l'APPEL (hot-reloadable) ──────────────────────────
def test_desktop_tool_result_cap_read_at_call(monkeypatch):
    from llm_core.context import pruning
    # Payload desktop volumineux (elements) au-delà d'un petit cap.
    big = json.dumps({"elements": [{"id": f"el_{i}", "label": "x" * 50,
                                    "role": "button", "center": [i, i]} for i in range(400)]})
    # Cap abaissé À CHAUD (config lue à l'appel, plus figée à l'import).
    monkeypatch.setattr(pruning._bk_config, "DESKTOP_TOOL_RESULT_MAX_CHARS", 8000, raising=False)
    out = pruning.prepare_tool_result_for_model("desktop_observe", big, ctx_tokens=8000)
    assert len(out) <= 8000 + 200        # borne respectée (marge note de troncature)
    # Cap large → pas de troncature (liste complète).
    monkeypatch.setattr(pruning._bk_config, "DESKTOP_TOOL_RESULT_MAX_CHARS", 200000, raising=False)
    out2 = pruning.prepare_tool_result_for_model("desktop_observe", big, ctx_tokens=200000)
    assert len(out2) > 8000


def test_chat_element_cap_optin(monkeypatch):
    from llm_core.tools import desktop_tools as dt
    # Défaut : 0 (liste complète, lean v3).
    monkeypatch.setattr(dt._cfg, "DESKTOP_MAX_ELEMENTS", 0, raising=False)
    monkeypatch.setattr(dt._cfg, "DESKTOP_MAX_ELEMENTS_CHAT", 0, raising=False)
    assert dt._chat_element_cap() == 0
    # Opt-in chat prime sur le défaut.
    monkeypatch.setattr(dt._cfg, "DESKTOP_MAX_ELEMENTS_CHAT", 50, raising=False)
    assert dt._chat_element_cap() == 50
    # Sans opt-in chat, retombe sur DESKTOP_MAX_ELEMENTS.
    monkeypatch.setattr(dt._cfg, "DESKTOP_MAX_ELEMENTS_CHAT", 0, raising=False)
    monkeypatch.setattr(dt._cfg, "DESKTOP_MAX_ELEMENTS", 120, raising=False)
    assert dt._chat_element_cap() == 120
