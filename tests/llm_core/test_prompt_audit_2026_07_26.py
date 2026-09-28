# SPDX-License-Identifier: MIT
"""Régressions audit system-prompt 2026-07-26.

1. Incohérences factuelles : le <runtime_context> ne mentionne plus
   `git_repos/` (layout v15 = racine sandbox) et la ligne réseau reflète
   l'état RÉEL du profil (plus de « blocked by default » figé).
2. Manifeste des outils actifs : liste explicite injectée en tête du bloc
   opérationnel — un outil absent n'existe pas ce tour.
3. Anti-pollution AX memory : un site au signal insuffisant (auto-visité une
   fois par l'agent) n'est PAS injecté dans le prompt.
4. Full-EN : les fichiers prompts et les textes de fragments restent en
   anglais (pas de retour de chaînes françaises dans les surfaces modèle).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from llm_core.context import assembly as asm

ROOT = Path(__file__).resolve().parents[2]


# ── runtime_context : plus de git_repos/, réseau dynamique ───────────────

def test_runtime_context_no_git_repos_mention():
    ctx = asm.build_runtime_sandbox_context("alice")
    assert ctx and "<runtime_context>" in ctx
    assert "git_repos" not in ctx
    assert "blocked by default" not in ctx


def test_network_line_reflects_open_profile(monkeypatch):
    class _Prof:
        mode = "allowlist"

    class _Cfg:
        def get_profile(self, pid):
            return _Prof()

    import shared_infra.db as db
    import shared_infra.sandbox.executors as ex
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: {"id": 7}, raising=False)
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings",
                        lambda uid: {"network_profile_id": "web"}, raising=False)
    monkeypatch.setattr(ex, "load_admin_config", lambda: _Cfg(), raising=False)
    line = asm._network_status_line("alice")
    assert "OPEN" in line and "'web'" in line


def test_network_line_isolated_profile(monkeypatch):
    class _Prof:
        mode = "none"

    class _Cfg:
        def get_profile(self, pid):
            return _Prof()

    import shared_infra.db as db
    import shared_infra.sandbox.executors as ex
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: {"id": 7}, raising=False)
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {}, raising=False)
    monkeypatch.setattr(ex, "load_admin_config", lambda: _Cfg(), raising=False)
    line = asm._network_status_line("alice")
    assert "NONE" in line and "expected, not a bug" in line


def test_network_line_fail_open_neutral(monkeypatch):
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_user",
                        lambda u: (_ for _ in ()).throw(RuntimeError("db down")),
                        raising=False)
    line = asm._network_status_line("alice")
    assert "depends on the sandbox profile" in line


# ── manifeste des outils actifs ──────────────────────────────────────────

def test_manifest_lists_tools_grouped_and_sorted(monkeypatch):
    import llm_core._mcp_categories as cats
    monkeypatch.setattr(cats, "categorize",
                        lambda n: {"read_file": "fs", "git_inspect": "git",
                                   "pw_act": "browser"}.get(n, "other"))
    m = asm.build_active_tools_manifest(["pw_act", "git_inspect", "read_file"])
    assert m.startswith("# Active tools (this session)")
    assert "- fs: read_file" in m
    assert "- git: git_inspect" in m
    assert "- browser: pw_act" in m
    # Déterminisme (byte-stable pour le prefix-cache) : même entrée → même sortie,
    # quel que soit l'ordre d'arrivée des noms.
    m2 = asm.build_active_tools_manifest(["read_file", "pw_act", "git_inspect"])
    assert m == m2


def test_manifest_empty_when_no_tools():
    assert asm.build_active_tools_manifest([]) == ""
    assert asm.build_active_tools_manifest(None) == ""


# ── AX memory : gate de signal minimal ───────────────────────────────────

def test_ax_low_signal_site_not_injected(monkeypatch):
    from shared_infra.memory.ax import rendering as r
    monkeypatch.setattr(r, "_site_signal", lambda s: 1)
    monkeypatch.setattr(r, "AX_INJECT_MIN_SIGNAL", 3)
    assert r.render_site_contextual("www.iana.org") == ""


def test_ax_mature_site_still_injected(monkeypatch):
    from shared_infra.memory.ax import rendering as r
    monkeypatch.setattr(r, "_site_signal", lambda s: 10)
    monkeypatch.setattr(r, "AX_INJECT_MIN_SIGNAL", 3)
    called = {}
    monkeypatch.setattr(r, "render_full_dom_for_prompt",
                        lambda site, max_chars=6000, owner="": (called.setdefault("site", site), "RENDERED")[1])
    assert r.render_site_contextual("app.example.com") == "RENDERED"
    assert called["site"] == "app.example.com"


def test_ax_gate_disabled_via_zero(monkeypatch):
    from shared_infra.memory.ax import rendering as r
    monkeypatch.setattr(r, "AX_INJECT_MIN_SIGNAL", 0)
    monkeypatch.setattr(r, "_site_signal",
                        lambda s: (_ for _ in ()).throw(AssertionError("must not be called")))
    monkeypatch.setattr(r, "render_full_dom_for_prompt",
                        lambda site, max_chars=6000, owner="": "X")
    assert r.render_site_contextual("site") == "X"


# ── full-EN : pas de français dans les surfaces prompt ───────────────────

_ACCENTS = re.compile(r"[àâéèêëîïôùûç]", re.I)

# Exceptions FR VOLONTAIRES = les exemples QUOTÉS ("…" ou `…`) : démonstrations
# « réponds dans la langue de l'utilisateur » (FRAGMENT_MEMORY) et tics français
# bannis du socle ("N'hésitez pas à…"). 2026-08-16 : l'exemption passe du FICHIER
# entier (_ALLOWED_FR_FILES) au SPAN quoté — plus stricte (la prose de
# FRAGMENT_MEMORY redevient contrôlée) et plus précise. Le blanchiment se fait
# sur le texte ENTIER car un span quoté peut enjamber une fin de ligne ; les
# sauts de ligne sont préservés pour garder les numéros exacts. Un guillemet
# orphelin laisse la suite CONTRÔLÉE (fail-strict).
_QUOTED_SPANS = re.compile(r'"[^"]*"|`[^`]*`')


def _blank_quoted(text: str) -> str:
    return _QUOTED_SPANS.sub(
        lambda m: "".join(c if c == "\n" else " " for c in m.group(0)), text)


def test_prompt_files_are_english():
    for p in sorted((ROOT / "system_prompts").glob("*.md")):
        if p.name.startswith("_"):
            continue
        blanked = _blank_quoted(p.read_text(encoding="utf-8"))
        for i, line in enumerate(blanked.splitlines(), 1):
            assert not _ACCENTS.search(line), f"{p.name}:{i} contient du français : {line!r}"


def test_socle_has_arbitration_and_manifest_reference():
    socle = (ROOT / "system_prompts" / "CHATBOT_SYSTEM.md").read_text(encoding="utf-8")
    assert "accuracy > answering the request completely > brevity" in socle
    assert "# Active tools" in socle          # le socle pointe vers le manifeste


def test_fragment_tools_references_manifest():
    frag = (ROOT / "system_prompts" / "FRAGMENT_TOOLS.md").read_text(encoding="utf-8")
    assert "manifest" in frag
    assert "If a `todowrite` tool is available" not in frag
