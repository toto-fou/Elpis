# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_skills_folder.py — P0 du chantier "vrais skills" :
découverte du modèle DOSSIER (Agent Skill) + frontmatter metadata imbriqué +
validation conforme au spec, sans casser le modèle legacy mono-fichier.
"""
from __future__ import annotations

import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llm_core import _skill_validate as V  # noqa: E402
from llm_core._frontmatter import split_frontmatter  # noqa: E402
from llm_core.skills import _scan_tree  # noqa: E402


def _w(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8")


# ── frontmatter imbriqué (metadata:) ────────────────────────────────
def test_frontmatter_nested_metadata():
    fm, body = split_frontmatter(
        "---\nname: x\ndescription: d\nmetadata:\n  author: me\n  version: \"1.0\"\n---\nbody\n"
    )
    assert fm["name"] == "x"
    assert isinstance(fm["metadata"], dict)
    assert fm["metadata"]["author"] == "me"
    assert str(fm["metadata"]["version"]) == "1.0"
    assert body.strip() == "body"


# ── validation spec ─────────────────────────────────────────────────
def test_validate_name_rules():
    assert V.validate_name("pdf-processing", dir_name="pdf-processing") == []
    assert V.validate_name("PDF", dir_name="PDF")                      # majuscules → erreur
    assert V.validate_name("pdf--x", dir_name="pdf--x")               # '--' → erreur
    assert V.validate_name("-pdf", dir_name="-pdf")                   # '-' en tête → erreur
    assert any("réservé" in e for e in V.validate_name("claude-x", dir_name="claude-x"))
    assert any("dossier" in e for e in V.validate_name("foo", dir_name="bar"))


def test_validate_description_rules():
    assert V.validate_description("ok") == []
    assert any("non vide" in e for e in V.validate_description(""))
    assert any("1024" in e for e in V.validate_description("x" * 1025))


# ── découverte dossier + legacy ─────────────────────────────────────
def test_folder_and_legacy_discovery(tmp_path):
    sk = tmp_path / "pdf-processing"
    _w(sk / "SKILL.md", """
        ---
        name: pdf-processing
        description: Extract text from PDFs. Use when handling PDF files.
        license: Apache-2.0
        compatibility: Requires python
        metadata:
          author: acme
          version: "1.0"
        ---
        # PDF
        Run scripts/extract.py to extract.
    """)
    _w(sk / "scripts" / "extract.py", "print('hi')\n")
    _w(sk / "references" / "REFERENCE.md", "# ref\n")

    _w(tmp_path / "legacy-skill.md", """
        ---
        name: legacy-skill
        description: a legacy single-file skill
        ---
        do the thing
    """)

    specs = _scan_tree(tmp_path, "global")
    by = {s.name: s for s in specs}

    assert "pdf-processing" in by and "legacy-skill" in by
    f = by["pdf-processing"]
    assert f.is_folder is True
    assert f.license == "Apache-2.0"
    assert f.compatibility == "Requires python"
    assert f.metadata.get("author") == "acme"
    assert "scripts/extract.py" in f.files
    assert "references/REFERENCE.md" in f.files
    # le REFERENCE.md bundlé n'est PAS un skill indépendant
    assert "REFERENCE" not in by
    # legacy reste mono-fichier
    assert by["legacy-skill"].is_folder is False


def test_template_and_hidden_dirs_skipped(tmp_path):
    _w(tmp_path / "_draft" / "SKILL.md", "---\nname: _draft\ndescription: d\n---\nx\n")
    _w(tmp_path / ".hidden" / "SKILL.md", "---\nname: hidden\ndescription: d\n---\nx\n")
    specs = _scan_tree(tmp_path, "global")
    assert specs == []


