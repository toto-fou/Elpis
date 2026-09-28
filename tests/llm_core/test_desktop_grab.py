# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_grab.py — robustesse de la capture d'écran.

La RETRANSMISSION transitoire (backend de capture momentanément indisponible
juste après l'ouverture d'une app) est désormais gérée en amont par
``_agent_req`` (endpoint /screenshot idempotent → rejoué selon
``desktop.transport_retries``), plus par une boucle locale à ``_grab``. Ici on
vérifie donc que ``_grab`` transmet fidèlement le résultat d'``_agent_req`` :
image → (png, w, h) ; erreur → err() inchangée, sans re-tentative propre.
La logique de retry transport a sa propre vérif : test_desktop_transport_retry.py.
"""
from __future__ import annotations

from llm_core.tools import desktop_tools as dt

# 1×1 PNG transparent valide.
_PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


def test_grab_returns_image_tuple(monkeypatch):
    calls = {"n": 0}

    def fake_req(target, endpoint, payload=None, method="POST", timeout=None):
        calls["n"] += 1
        assert endpoint == "/screenshot"
        return {"image": _PNG_B64, "width": 1, "height": 1}

    monkeypatch.setattr(dt, "_agent_req", fake_req)
    out = dt._grab({"name": "vm1"})
    assert isinstance(out, tuple) and out[1] == 1 and out[2] == 1
    assert calls["n"] == 1, "un seul appel : le retry transport vit dans _agent_req"


def test_grab_passes_through_error(monkeypatch):
    calls = {"n": 0}

    def fake_req(target, endpoint, payload=None, method="POST", timeout=None):
        calls["n"] += 1
        return {"error": "agent_unreachable", "message": "down", "retryable": True}

    monkeypatch.setattr(dt, "_agent_req", fake_req)
    out = dt._grab({"name": "vm1"})
    assert isinstance(out, dict) and out.get("error") == "agent_unreachable"
    assert calls["n"] == 1, "_grab ne retente plus : il transmet l'err() d'_agent_req"


def test_grab_sends_configured_format(monkeypatch):
    # P3 — _grab envoie le format config (jpeg + quality) dans le body /screenshot.
    monkeypatch.setattr(dt._cfg, "DESKTOP_SCREENSHOT_FORMAT", "jpeg", raising=False)
    monkeypatch.setattr(dt._cfg, "DESKTOP_SCREENSHOT_QUALITY", 70, raising=False)
    seen = {}

    def fake_req(target, endpoint, payload=None, method="POST", timeout=None):
        seen["endpoint"] = endpoint
        seen["payload"] = payload
        return {"image": _PNG_B64, "width": 1, "height": 1}

    monkeypatch.setattr(dt, "_agent_req", fake_req)
    dt._grab({"name": "vm1"})
    assert seen["endpoint"] == "/screenshot"
    assert seen["payload"]["format"] == "jpeg" and seen["payload"]["quality"] == 70


def test_grab_fmt_png_overrides_config(monkeypatch):
    # fmt='png' (chemin OCR) FORCE le PNG même si la config demande du JPEG.
    monkeypatch.setattr(dt._cfg, "DESKTOP_SCREENSHOT_FORMAT", "jpeg", raising=False)
    seen = {}

    def fake_req(target, endpoint, payload=None, method="POST", timeout=None):
        seen["payload"] = payload
        return {"image": _PNG_B64, "width": 1, "height": 1}

    monkeypatch.setattr(dt, "_agent_req", fake_req)
    dt._grab({"name": "vm1"}, fmt="png")
    # quality est toujours joint (l'agent l'ignore hors JPEG) ; c'est le FORMAT qui compte.
    assert seen["payload"]["format"] == "png"
