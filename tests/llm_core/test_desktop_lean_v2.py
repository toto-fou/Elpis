# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_lean_v2.py — Vague 2 (efficacité contexte 30-129B) :

  B1 — docstrings desktop allégées (envoyées à CHAQUE tour dans le schéma d'outils).
  B2 — troncature des éléments perçus IMPORTANCE-AWARE (auto_id/nommé d'abord).
  B3 — surface d'outils LEAN : desktop_screenshot/desktop_inspect masqués par défaut.

Aucun réseau / agent : on enregistre les tools dans un faux MCP et on inspecte.
"""
from __future__ import annotations

import pytest

from llm_core.tools import desktop_tools as dt


class _FakeMCP:
    """Capture (nom → fonction) des tools enregistrés via @mcp.tool(...)."""
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        name = kw.get("name")
        def _deco(fn):
            self.tools[name] = fn
            return fn
        return _deco


def _register(monkeypatch, expose_raw=False):
    monkeypatch.setattr(dt._cfg, "DESKTOP_EXPOSE_RAW_TOOLS", expose_raw, raising=False)
    mcp = _FakeMCP()
    dt.register(mcp)
    return mcp


# ── B3 : surface d'outils par défaut ────────────────────────────────────────

def test_raw_tools_hidden_by_default(monkeypatch):
    mcp = _register(monkeypatch, expose_raw=False)
    assert "desktop_screenshot" not in mcp.tools
    assert "desktop_inspect" not in mcp.tools
    # Les outils essentiels restent exposés.
    for t in ("desktop_observe", "desktop_act", "desktop_wait", "desktop_launch",
              "desktop_read", "desktop_session", "desktop_clipboard"):
        assert t in mcp.tools, "manque " + t


def test_raw_tools_exposed_when_flag_on(monkeypatch):
    mcp = _register(monkeypatch, expose_raw=True)
    assert "desktop_screenshot" in mcp.tools
    assert "desktop_inspect" in mcp.tools


def test_default_surface_is_lean(monkeypatch):
    # 13 tools définis → 11 exposés par défaut (screenshot/inspect masqués ;
    # desktop_shell exposé PAR DÉFAUT comme execute_shell — décision 2026-07-15 ;
    # + desktop_windows/desktop_focus pour la gestion de fenêtres ;
    # + desktop_run_automation (2026-09-13 : scripts du Studio sur N cibles, routines).
    monkeypatch.setattr(dt._cfg, "DESKTOP_DISABLE_SHELL", False, raising=False)
    mcp = _register(monkeypatch, expose_raw=False)
    assert len(mcp.tools) == 11
    assert "desktop_shell" in mcp.tools and "desktop_run_automation" in mcp.tools


# ── B1 : docstrings allégées (budget) mais guidage clé conservé ─────────────

def test_act_docstring_is_lean(monkeypatch):
    doc = _register(monkeypatch).tools["desktop_act"].__doc__ or ""
    # Budget anti-régression : la version verbeuse d'origine faisait ~2,4 Ko de
    # prose (renvoyée à CHAQUE tour) ; on borne pour éviter qu'elle ne regonfle.
    assert len(doc) < 1850, "docstring desktop_act trop longue (%d)" % len(doc)
    # Guidage à FORTE valeur conservé : ciblage par id, feedback resolved_by, et le
    # seul cas où le verbe diffère du clic (set_value pour un champ).
    assert "element_id" in doc
    assert "resolved_by" in doc            # A2 visible au modèle
    assert "set_value" in doc and "click" in doc
    # T1-C : l'énumération verbeuse des ops sémantiques (toggle/check/uncheck/select/
    # expand/collapse/scroll_into_view) n'est PLUS exposée — le clic auto-route vers
    # le bon pattern, donc le modèle n'a plus à choisir parmi 12 verbes.
    assert "scroll_into_view" not in doc
    assert "uncheck" not in doc
    # La prose verbeuse retirée n'est plus là.
    assert "pan east = drag from right to left" not in doc


def test_observe_keeps_loop_fewshot(monkeypatch):
    # D1 : l'exemplaire de boucle reste visible (in-schema, lean).
    doc = _register(monkeypatch).tools["desktop_observe"].__doc__ or ""
    assert "desktop_launch" in doc and "desktop_wait" in doc
    assert "desktop_observe" in doc


# ── B2 : importance d'un élément + troncature qui garde l'actionnable ────────

def test_element_importance_scoring():
    imp = dt._element_importance
    assert imp({"auto_id": "x", "label": "Save", "source": "a11y"}) == 5   # auto_id+nom
    assert imp({"label": "Save", "source": "a11y"}) == 2                    # nommé a11y
    assert imp({"label": "Save", "source": "vision"}) == 3                  # nommé vision
    assert imp({"source": "vision"}) == 1                                   # vision anonyme
    assert imp({"source": "a11y"}) == 0                                     # décor anonyme


def test_truncation_keeps_actionable_over_decorative():
    # 80 décoratifs (score 0) + 1 bouton actionnable en DERNIÈRE position.
    els = [{"id": "d%d" % i, "source": "a11y"} for i in range(80)]
    els.append({"id": "btn", "auto_id": "saveBtn", "label": "Save", "source": "a11y"})
    kept = sorted(els, key=dt._element_importance, reverse=True)[:80]
    ids = {e["id"] for e in kept}
    assert "btn" in ids        # survit malgré 80 décoratifs (l'ancien tri le coupait)


def test_truncation_stable_within_tier():
    # À importance égale, l'ordre de lecture (arbre) est préservé (tri stable).
    els = [{"id": "a", "label": "A", "source": "a11y"},
           {"id": "b", "label": "B", "source": "a11y"}]
    kept = sorted(els, key=dt._element_importance, reverse=True)
    assert [e["id"] for e in kept] == ["a", "b"]
