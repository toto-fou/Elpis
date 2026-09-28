# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_frame_sig.py — signature de frame (dHash) + capture
brute (V1). Vérifie : format/déterminisme du dHash, tolérance au bruit mais
sensibilité au changement (base de l'« effet » et de l'« élagage »), présence de
``sig`` dans act_core, et capture brute (use_vision/use_tree=False) → 0 box + sig,
sans aucun appel agent /ui_tree.
"""
from __future__ import annotations

import io

from PIL import Image

from llm_core.tools import desktop_tools as dt


def _png(color=(30, 30, 30), size=(64, 48)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def _ham(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def _half_png() -> bytes:
    """Image mi-claire mi-sombre → dHash NON nul (sig distincte d'un aplat)."""
    im = Image.new("RGB", (64, 48), (0, 0, 0))
    for x in range(32):
        for y in range(48):
            im.putpixel((x, y), (240, 240, 240))
    b = io.BytesIO(); im.save(b, "PNG")
    return b.getvalue()


TGT = {"name": "t1", "agent_url": "http://a", "os": "linux"}


def test_frame_sig_format_and_determinism():
    s = dt._frame_sig(_png())
    assert len(s) == 16            # 64 bits → 16 hex
    int(s, 16)                     # hex valide
    assert dt._frame_sig(_png()) == s   # déterministe


def test_frame_sig_noise_tolerant_but_change_sensitive():
    base = _png((30, 30, 30))
    im = Image.open(io.BytesIO(base)).convert("RGB")
    im.putpixel((0, 0), (255, 255, 255))      # 1 pixel = bruit type curseur
    nb = io.BytesIO(); im.save(nb, "PNG")
    big = Image.new("RGB", (64, 48), (0, 0, 0))   # moitié claire → fort gradient
    for x in range(32):
        for y in range(48):
            big.putpixel((x, y), (240, 240, 240))
    bb = io.BytesIO(); big.save(bb, "PNG")
    noise = _ham(dt._frame_sig(base), dt._frame_sig(nb.getvalue()))
    change = _ham(dt._frame_sig(base), dt._frame_sig(bb.getvalue()))
    assert noise <= 4                  # un pixel ne bouge ~pas la signature
    assert change >= 4 and change > noise   # un vrai changement, si


def test_act_core_includes_sig(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": TGT)
    monkeypatch.setattr(dt, "_agent_req", lambda *a, **k: {"ok": True})
    monkeypatch.setattr(dt, "_grab", lambda tgt: (_png((12, 34, 56)), 64, 48))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok_x")
    res = dt.act_core("u", "t1", op="click", x=10, y=10)
    assert res["ok"] is True and res["frame_token"] == "tok_x"
    assert len(res["sig"]) == 16


def test_observe_raw_no_model_no_boxes_with_sig(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": TGT)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (_png((9, 9, 9)), 64, 48))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok_r")
    called = []
    monkeypatch.setattr(dt, "_agent_req",
                        lambda *a, **k: (called.append(a[1] if len(a) > 1 else a), {"ok": True})[1])
    res = dt.observe_core("u", "t1", "", use_vision=False, use_tree=False)
    assert res["ok"] is True
    assert res["count"] == 0 and res["elements"] == []
    assert len(res["sig"]) == 16
    assert called == []            # capture brute = aucun appel agent (/ui_tree)


# ── Mémo vision : pas de re-détection sur écran inchangé (P1.4) ───────────────
def _setup_vision(monkeypatch):
    dt._VISION_MEMO.clear()
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": TGT)
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    monkeypatch.setattr(dt._cfg, "VISION_ENDPOINT_URL", "http://vision")
    calls = {"n": 0}

    def fake_detect(png, **kw):
        calls["n"] += 1
        return [{"box": [1, 1, 10, 10], "label": "X", "confidence": 0.9}]
    monkeypatch.setattr(dt, "detect", fake_detect)
    return calls


def test_vision_memo_skips_detect_on_unchanged_screen(monkeypatch):
    calls = _setup_vision(monkeypatch)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (_png((20, 20, 20)), 64, 48))
    r1 = dt.observe_core("u", "t1", "", use_vision=True, use_tree=False)
    r2 = dt.observe_core("u", "t1", "", use_vision=True, use_tree=False)
    assert calls["n"] == 1                       # même écran → 1 seule détection
    assert r1["count"] == 1 and r2["count"] == 1  # mêmes boxes réutilisées

    monkeypatch.setattr(dt, "_grab", lambda tgt: (_half_png(), 64, 48))
    dt.observe_core("u", "t1", "", use_vision=True, use_tree=False)
    assert calls["n"] == 2                        # écran changé → re-détection


def test_prompt_detection_memoized_on_unchanged_screen(monkeypatch):
    # P4 — une détection CIBLÉE (prompt=) répétée sur écran figé est désormais
    # mémoïsée (clé (cible,prompt)) → 1 seule détection au lieu de 2.
    calls = _setup_vision(monkeypatch)
    dt._VISION_PROMPT_MEMO.clear()
    monkeypatch.setattr(dt, "_grab", lambda tgt: (_png((20, 20, 20)), 64, 48))
    dt.observe_core("u", "t1", "trouver Save", use_vision=True, use_tree=False)
    dt.observe_core("u", "t1", "trouver Save", use_vision=True, use_tree=False)
    assert calls["n"] == 1                       # même (sig,prompt) → memo hit
    # Un prompt DIFFÉRENT n'est pas servi par le memo précédent.
    dt.observe_core("u", "t1", "trouver Quitter", use_vision=True, use_tree=False)
    assert calls["n"] == 2
