# SPDX-License-Identifier: MIT
"""
Régressions — audit round 10 (2026-07-05), côté llm_core.

  - F11 : <think> NON fermé (raisonnement tronqué au cap) retiré avant coerce.
  - F13 : corps d'un skill ÉPINGLÉ injecté même si la catégorie « skill » est OFF.
  - F3  : la recherche de code ne suit pas les symlinks sortant de la sandbox.
  - F12 : apply_rag ne plante pas sur un dernier message user MULTIMODAL.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


# ── F11 — think non fermé retiré ─────────────────────────────────────────────
def _strip_think(text: str) -> str:
    """Réplique la séquence strip+cut de ConversationCompressor.compress()."""
    from llm_core.conversation_compressor import _RE_THINK_BLOCK, _RE_THINK_OPEN
    t = _RE_THINK_BLOCK.sub("", text or "").strip()
    m = _RE_THINK_OPEN.search(t)
    if m is not None:
        t = t[:m.start()].strip()
    return t


def test_f11_closed_think_stripped_summary_kept():
    s = "<think>raisonnement</think>\n<context>vrai résumé assez long ici</context>"
    out = _strip_think(s)
    assert "<context>" in out and "raisonnement" not in out


def test_f11_unclosed_think_truncated_to_empty():
    # Réponse coupée par le cap EN PLEIN <think> (pas de fermeture) → tout retiré
    # → retombe sur summary_too_short (rollback) plutôt que coercé en résumé.
    s = "<think>un très long raisonnement jamais terminé car coupé au cap max_tokens"
    assert _strip_think(s) == ""


def test_f11_unclosed_think_after_partial_summary_keeps_prefix():
    s = "Résumé partiel déjà écrit.\n<think>puis un raisonnement tronqué…"
    assert _strip_think(s) == "Résumé partiel déjà écrit."


# ── F13 — skill épinglé injecté même catégorie OFF ───────────────────────────
def test_f13_pinned_skill_body_injected_when_category_off():
    from llm_core import skills as S
    from llm_core._system_prompts import assemble_system_messages

    spec = S.SkillSpec(name="deploy", description="Procédure de déploiement",
                       body="BODY-DEPLOY-STEP-1-2-3", domain="", files=[])
    import unittest.mock as mock
    with mock.patch.object(S, "discover_skills", lambda *a, **k: [spec]):
        # skills_enabled=False (catégorie « skill » OFF) MAIS skill épinglé :
        msgs = assemble_system_messages(
            "socle", pinned_skills=["deploy"], skills_enabled=False)
        blob = "\n".join(m["content"] for m in msgs)
        assert "BODY-DEPLOY-STEP-1-2-3" in blob      # corps épinglé présent
        assert "## Index" not in blob                # mais PAS l'index (gaté OFF)


def test_f13_no_pin_and_category_off_injects_nothing():
    from llm_core import skills as S
    from llm_core._system_prompts import assemble_system_messages
    spec = S.SkillSpec(name="deploy", description="d", body="BODY-X", domain="", files=[])
    import unittest.mock as mock
    with mock.patch.object(S, "discover_skills", lambda *a, **k: [spec]):
        msgs = assemble_system_messages(
            "socle", last_user_text="deploy something", skills_enabled=False)
        blob = "\n".join(m["content"] for m in msgs)
        assert "BODY-X" not in blob and "## Index" not in blob


# ── F3 — liens sortants jamais suivis par la recherche de code ───────────────
def test_f3_la_recherche_de_code_ne_suit_pas_un_lien_sortant(tmp_path, monkeypatch):
    from llm_core.tools import fs_tools

    class _MCP:
        tools: dict = {}

        def tool(self, **kw):
            def deco(fn):
                self.tools[fn.__name__] = fn
                return fn
            return deco
    base = tmp_path / "sandboxes"
    root = base / "guest" / "work"
    root.mkdir(parents=True)
    ailleurs = tmp_path / "ailleurs"
    ailleurs.mkdir()
    (ailleurs / "hors.py").write_text("KEY = 2\n")
    (root / "real.py").write_text("KEY = 1\n")
    os.symlink(ailleurs / "hors.py", root / "leak.py")
    (root / "d").mkdir()
    os.symlink(ailleurs, root / "d" / "escape")
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _MCP()
    fs_tools.register(mcp, base)
    r = mcp.tools["code"](None, action="references", symbol="KEY")
    assert r["ok"] and [h["file"] for h in r["matches"]] == ["real.py"], r


# ── F12 — apply_rag robuste au content multimodal ────────────────────────────
def test_f12_apply_rag_no_crash_on_multimodal_last_message(monkeypatch):
    import llm_core._rag as R
    # Service CONFIGURÉ (pour atteindre l'extraction de la query) + call_tool
    # neutralisé : on isole l'ancien point de crash (.strip() sur une liste).
    monkeypatch.setattr(R, "is_configured", lambda: True, raising=False)

    def _boom(*a, **k):
        raise R.RagServiceError("service down (test)")
    monkeypatch.setattr(R, "call_tool", _boom, raising=False)

    messages = [{"role": "user", "content": [
        {"type": "text", "text": "analyse ce doc"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
    ]}]
    out, meta = R.apply_rag(messages)     # ne doit PAS lever AttributeError
    # La query « analyse ce doc » a été extraite → on a bien tenté l'appel (KO).
    assert out == messages and meta.get("used") is False
