# SPDX-License-Identifier: MIT
"""Unités des helpers folder-aware de ``llm_core.skills`` (sans HTTP).

Couvre ce que les tests de routes ne voient pas directement : tie-break des
finders, containment de la purge cross-modèle, round-trip du rendu de
frontmatter (metadata imbriqué, clés inconnues), sémantique tri-état du
``domain`` à l'update in-place.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import llm_core.skills as sk
from llm_core._frontmatter import split_frontmatter


def _mk_folder(root: Path, rel: str, *, fm_extra: str = "", body: str = "corps",
               files: tuple = ()) -> Path:
    d = root / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {d.name}\ndescription: d-{d.name}\ntags: [t]\n{fm_extra}---\n\n{body}\n",
        encoding="utf-8")
    for f in files:
        p = d / f
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("echo ok\n", encoding="utf-8")
    return d


def _mk_legacy(root: Path, rel: str, *, body: str = "legacy") -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    name = p.stem
    p.write_text(f"---\nname: {name}\n---\n\n{body}\n", encoding="utf-8")
    return p


# ── _find_entry ────────────────────────────────────────────────────────────

def test_find_entry_qualified_then_name_then_slug(tmp_path):
    _mk_folder(tmp_path, "pkg")
    _mk_folder(tmp_path, "pkg/child")
    assert sk._find_entry(tmp_path, "user", "pkg/child").id == "pkg/child"
    assert sk._find_entry(tmp_path, "user", "child").id == "pkg/child"      # name de feuille
    assert sk._find_entry(tmp_path, "user", "Child").id == "pkg/child"      # slug du segment
    assert sk._find_entry(tmp_path, "user", "absent") is None


def test_find_entry_folder_wins_over_legacy_twin(tmp_path):
    _mk_legacy(tmp_path, "twin.md")
    _mk_folder(tmp_path, "twin")
    found = sk._find_entry(tmp_path, "user", "twin")
    assert found is not None and found.skill_dir, "le dossier doit gagner le tie"


# ── _purge_slug_entries ────────────────────────────────────────────────────

def test_purge_removes_other_copies_keeps_target_and_ancestors(tmp_path):
    keep_dir = _mk_folder(tmp_path, "dom/dup", files=("scripts/s.sh",))
    other_file = _mk_legacy(tmp_path, "dup.md")
    other_dir = _mk_folder(tmp_path, "elsewhere/dup")
    sk._purge_slug_entries(tmp_path, "dup", keep=keep_dir / "SKILL.md")
    assert (keep_dir / "SKILL.md").is_file()
    assert (keep_dir / "scripts/s.sh").is_file()
    assert not other_file.exists()
    assert not other_dir.exists()


def test_purge_never_removes_ancestor_of_keep(tmp_path):
    # Package « x » contenant un sous-skill « x » : purger le slug x en gardant
    # le sous-skill ne doit PAS rmtree le package (ancêtre du keep).
    pkg = _mk_folder(tmp_path, "x")
    child = _mk_folder(tmp_path, "x/x")
    sk._purge_slug_entries(tmp_path, "x", keep=child / "SKILL.md")
    assert (pkg / "SKILL.md").is_file()
    assert (child / "SKILL.md").is_file()


# ── _delete_slug_entries ───────────────────────────────────────────────────

def test_delete_qualified_targets_one_entry_only(tmp_path):
    _mk_folder(tmp_path, "p1")
    _mk_folder(tmp_path, "p1/run")
    _mk_folder(tmp_path, "p2")
    _mk_folder(tmp_path, "p2/run")
    assert sk._delete_slug_entries(tmp_path, "user", "p1/run") is True
    assert not (tmp_path / "p1/run").exists()
    assert (tmp_path / "p2/run/SKILL.md").is_file(), "l'homonyme d'un autre package est intact"


def test_delete_simple_slug_removes_all_models(tmp_path):
    _mk_legacy(tmp_path, "dup.md")
    _mk_folder(tmp_path, "dom/dup")
    assert sk._delete_slug_entries(tmp_path, "user", "dup") is True
    assert not (tmp_path / "dup.md").exists()
    assert not (tmp_path / "dom/dup").exists()


# ── _render_frontmatter / _update_skill_md_in_place ────────────────────────

def test_render_frontmatter_roundtrip_with_metadata_and_unknown_keys():
    fm = {"name": "x", "description": "desc", "tags": ["a", "b"],
          "license": "Apache-2.0", "compatibility": "curl",
          "allowed-tools": "shell", "custom-key": "v",
          "metadata": {"author": "acme", "version": "1.0"}}
    rendered = sk._render_frontmatter(fm) + "\ncorps\n"
    parsed, body = split_frontmatter(rendered)
    assert parsed["name"] == "x" and parsed["tags"] == ["a", "b"]
    assert parsed["license"] == "Apache-2.0"
    assert parsed["allowed-tools"] == "shell"
    assert parsed["custom-key"] == "v"
    assert parsed["metadata"] == {"author": "acme", "version": 1.0}
    assert body.strip() == "corps"


def test_render_frontmatter_flattens_newlines():
    # Même protection anti-injection que _render_skill_md : une valeur
    # multi-ligne ne doit pas fabriquer de fausses clés au re-parse.
    rendered = sk._render_frontmatter({"name": "x", "description": "hi\nname: forged"})
    parsed, _ = split_frontmatter(rendered + "\nb\n")
    assert parsed["name"] == "x"
    assert "forged" in parsed["description"]


@pytest.mark.parametrize("domain,expected", [
    (None, "keep-me"),     # None → clé existante intacte
    ("", None),            # ""   → surcharge retirée
    ("new-dom", "new-dom"),  # valeur → posée
])
def test_update_in_place_domain_tristate(tmp_path, domain, expected):
    d = _mk_folder(tmp_path, "tool", fm_extra="domain: keep-me\nlicense: MIT\n")
    sk._update_skill_md_in_place(d / "SKILL.md", name_slug="tool", description="d2",
                                 body="b2", tags=["t2"], domain=domain)
    fm, body = split_frontmatter((d / "SKILL.md").read_text(encoding="utf-8"))
    assert fm.get("domain") == expected if expected else "domain" not in fm
    assert fm["license"] == "MIT"          # clé non gérée préservée
    assert fm["description"] == "d2" and fm["tags"] == ["t2"]
    assert body.strip() == "b2"


# ── Writers (scope user : racine explicite, pas de monkeypatch) ────────────

def test_save_user_skill_creates_folder_format(tmp_path):
    dest = sk.save_user_skill(tmp_path, "My Skill", "d", "b", ["t"], "ops")
    assert dest == tmp_path / "ops/my-skill/SKILL.md"
    assert dest.is_file()
    fm, _ = split_frontmatter(dest.read_text(encoding="utf-8"))
    assert fm["name"] == "my-skill"


def test_save_user_skill_rename_folder_via_prev_name(tmp_path):
    _mk_folder(tmp_path, "oldy", files=("scripts/keep.sh",))
    dest = sk.save_user_skill(tmp_path, "newy", "d", "b", None, None, prev_name="oldy")
    assert dest == tmp_path / "newy/SKILL.md"
    assert (tmp_path / "newy/scripts/keep.sh").is_file()
    assert not (tmp_path / "oldy").exists()
    fm, _ = split_frontmatter(dest.read_text(encoding="utf-8"))
    assert fm["name"] == "newy"            # name réaligné sur le dossier


def test_save_user_skill_rename_subskill_stays_in_parent(tmp_path):
    _mk_folder(tmp_path, "pkg")
    _mk_folder(tmp_path, "pkg/child")
    dest = sk.save_user_skill(tmp_path, "renamed", "d", "b", None, None,
                              prev_name="pkg/child")
    assert dest == tmp_path / "pkg/renamed/SKILL.md"
    assert (tmp_path / "pkg/SKILL.md").is_file()
    assert not (tmp_path / "pkg/child").exists()
