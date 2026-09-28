# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_skills_fullpull_injection.py — P1 : modèle d'injection
FULL-PULL. Seul l'index (name+description, marqueur « fichiers/scripts » pour
les skills à fichiers) est injecté ; les corps ne sont injectés QUE pour les
skills épinglés.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llm_core import skills as S  # noqa: E402
from llm_core._system_prompts import (  # noqa: E402
    _build_skills_block,
    build_attached_skills_block,
)


def _spec(name, desc, body, *, domain="", folder=False, files=None):
    return S.SkillSpec(
        name=name, description=desc, body=body, domain=domain,
        skill_dir=("/x/" + name) if folder else None, files=files or [],
    )


def _specs():
    return [
        _spec("pdf-processing", "Extract text from PDFs", "BODY-PDF",
              folder=True, files=["scripts/extract.py"]),
        _spec("legacy-skill", "A legacy how-to", "BODY-LEGACY"),
    ]


def test_index_only_no_auto_bodies(monkeypatch):
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _specs())
    out = _build_skills_block("please extract a pdf now", user_id=None, pinned_skills=None)
    assert out and "## Index" in out
    assert "pdf-processing" in out and "legacy-skill" in out
    assert "· files/scripts" in out          # marqueur skill-à-fichiers (sans émoji)
    # Full-pull : AUCUN corps auto-injecté (même si la requête matche).
    assert "BODY-PDF" not in out
    assert "BODY-LEGACY" not in out


def test_pinned_bodies_injected(monkeypatch):
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _specs())
    out = _build_skills_block("whatever", user_id=None, pinned_skills=["legacy-skill"])
    assert "BODY-LEGACY" in out              # épinglé → corps injecté
    assert "BODY-PDF" not in out             # non épinglé → pas injecté


def _pkg_specs():
    """Package + sous-skill (modèle post-migration jenkins)."""
    pkg = S.SkillSpec(name="jenkins", description="Ops Jenkins", body="BODY-PKG",
                      domain="jenkins", skill_dir="/x/jenkins")
    pkg.id, pkg.parent_id, pkg.depth = "jenkins", None, 0
    child = S.SkillSpec(name="jenkins-deploy", description="Déployer via Jenkins",
                        body="BODY-CHILD", domain="jenkins",
                        skill_dir="/x/jenkins/jenkins-deploy",
                        files=["scripts/deploy.sh"])
    child.id, child.parent_id, child.depth = "jenkins/jenkins-deploy", "jenkins", 1
    return [pkg, child]


def test_package_index_marker_and_subskills_not_listed(monkeypatch):
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    out = _build_skills_block("déployer via jenkins", user_id=None, pinned_skills=None)
    assert "**jenkins**" in out
    assert "· sub-skills" in out              # marqueur « contient des sous-skills »
    # Seuls les depth-0 sont indexés : le sous-skill ne fait pas d'entrée d'index.
    assert "**jenkins-deploy**" not in out
    assert "BODY-PKG" not in out and "BODY-CHILD" not in out


def test_pin_by_leaf_name_resolves_subskill(monkeypatch):
    # Les pins existants (« jenkins-deploy ») doivent survivre à la mise en
    # package : résolution par name de feuille, pas seulement par id qualifié.
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    out = _build_skills_block("whatever", user_id=None, pinned_skills=["jenkins-deploy"])
    assert "BODY-CHILD" in out
    assert "BODY-PKG" not in out


# ── build_attached_skills_block (skills attachés à une routine/agent headless) ─

def test_attached_block_bodies_without_index(monkeypatch):
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    out = build_attached_skills_block(None, ["jenkins/jenkins-deploy"])
    assert out and "BODY-CHILD" in out
    assert "## Index" not in out                 # mode attaché : pas d'index
    assert "procedures to apply" in out          # header dédié
    assert "BODY-PKG" not in out


def test_attached_block_unknown_ids_ignored(monkeypatch):
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    # Aucun id ne résout (skill supprimé/renommé) → rien à injecter.
    assert build_attached_skills_block(None, ["ghost"]) is None
    # Mélange : l'inconnu est ignoré, le connu est injecté.
    out = build_attached_skills_block(None, ["ghost", "jenkins"])
    assert out and "BODY-PKG" in out


def test_attached_block_empty_input(monkeypatch):
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    assert build_attached_skills_block(None, []) is None
    assert build_attached_skills_block(None, ["   "]) is None
    assert build_attached_skills_block(None, None) is None


def test_attached_block_excludes_learned(monkeypatch):
    # Même règle que l'injection chat : learned/ est un SAS admin, jamais actif.
    seen = {}

    def _fake(user_dir=None, include_learned=True):
        seen["include_learned"] = include_learned
        return _pkg_specs()

    monkeypatch.setattr(S, "discover_skills", _fake)
    build_attached_skills_block(None, ["jenkins"])
    assert seen["include_learned"] is False


def test_attached_block_parent_pin_expands_to_children(monkeypatch):
    """Épingler le skill PRINCIPAL embarque ses sous-skills (parent d'abord) —
    « l'utilisateur choisit le paquet, le modèle applique ce qui convient »."""
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    out = build_attached_skills_block(None, ["jenkins"])
    assert "BODY-PKG" in out and "BODY-CHILD" in out
    assert out.index("BODY-PKG") < out.index("BODY-CHILD")


def test_attached_block_child_pin_stays_targeted(monkeypatch):
    """Épingler un sous-skill précis n'aspire NI le parent NI les frères."""
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    out = build_attached_skills_block(None, ["jenkins/jenkins-deploy"])
    assert "BODY-CHILD" in out
    assert "BODY-PKG" not in out


def test_attached_block_parent_plus_child_dedup(monkeypatch):
    """Parent + sous-skill épinglés ensemble : chaque corps une seule fois."""
    monkeypatch.setattr(S, "discover_skills", lambda *a, **k: _pkg_specs())
    out = build_attached_skills_block(None, ["jenkins", "jenkins/jenkins-deploy"])
    assert out.count("BODY-PKG") == 1
    assert out.count("BODY-CHILD") == 1
