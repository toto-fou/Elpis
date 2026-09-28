# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_skills_zip.py — P2/P3 : packaging .zip des Agent Skills
(import/export) + durcissement (anti zip-slip, caps, SKILL.md requis, name==dossier).
"""
from __future__ import annotations

import io
import os
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llm_core import skills as S  # noqa: E402
from llm_core.skills import (  # noqa: E402
    install_skill_zip, export_skill_zip, SkillExistsError, SkillSaveError, _scan_tree,
)

GOOD_MD = ("---\nname: pdf-processing\n"
           "description: Extract text from PDFs. Use for PDF tasks.\n---\n"
           "# PDF\nrun scripts/x.py\n")


def _zip(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


def test_install_roundtrip_and_rediscovery(tmp_path):
    blob = _zip({
        "pdf-processing/SKILL.md": GOOD_MD,
        "pdf-processing/scripts/x.py": "print('hi')\n",
        "pdf-processing/references/REFERENCE.md": "# ref\n",
    })
    dest = tmp_path / "global"
    assert install_skill_zip(blob, dest, source="global") == ["pdf-processing"]
    assert (dest / "pdf-processing" / "SKILL.md").is_file()
    assert (dest / "pdf-processing" / "scripts" / "x.py").is_file()
    specs = {s.name: s for s in _scan_tree(dest, "global")}
    assert specs["pdf-processing"].is_folder
    assert "scripts/x.py" in specs["pdf-processing"].files


def test_zip_slip_rejected(tmp_path):
    blob = _zip({"pdf-processing/SKILL.md": GOOD_MD,
                 "pdf-processing/../evil.txt": "x"})
    with pytest.raises(SkillSaveError):
        install_skill_zip(blob, tmp_path / "g")
    assert not (tmp_path / "evil.txt").exists()


def test_absolute_path_rejected(tmp_path):
    blob = _zip({"pdf-processing/SKILL.md": GOOD_MD, "/etc/evil": "x"})
    with pytest.raises(SkillSaveError):
        install_skill_zip(blob, tmp_path / "g")


def test_missing_skillmd_rejected(tmp_path):
    blob = _zip({"pdf-processing/notskill.md": "x"})
    with pytest.raises(SkillSaveError) as e:
        install_skill_zip(blob, tmp_path / "g")
    assert "SKILL.md" in str(e.value)


def test_name_must_match_dir(tmp_path):
    md = "---\nname: other-name\ndescription: a fine description here\n---\nbody\n"
    blob = _zip({"pdf-processing/SKILL.md": md})
    with pytest.raises(SkillSaveError) as e:
        install_skill_zip(blob, tmp_path / "g")
    assert "dossier" in str(e.value) or "conforme" in str(e.value)


def test_multiple_roots_rejected(tmp_path):
    blob = _zip({"a/SKILL.md": GOOD_MD, "b/SKILL.md": GOOD_MD})
    with pytest.raises(SkillSaveError):
        install_skill_zip(blob, tmp_path / "g")


def test_file_count_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "SKILL_ZIP_MAX_FILES", 3)
    files = {"pdf-processing/SKILL.md": GOOD_MD}
    for i in range(5):
        files[f"pdf-processing/f{i}.txt"] = "x"
    with pytest.raises(SkillSaveError) as e:
        install_skill_zip(_zip(files), tmp_path / "g")
    assert "fichiers" in str(e.value)


def test_zip_size_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "SKILL_ZIP_MAX_BYTES", 10)
    with pytest.raises(SkillSaveError):
        install_skill_zip(_zip({"pdf-processing/SKILL.md": GOOD_MD}), tmp_path / "g")


def test_export_then_install(tmp_path):
    sk = tmp_path / "src" / "pdf-processing"
    (sk / "scripts").mkdir(parents=True)
    (sk / "SKILL.md").write_text(GOOD_MD, encoding="utf-8")
    (sk / "scripts" / "x.py").write_text("print(1)\n", encoding="utf-8")
    spec = S.SkillSpec(name="pdf-processing", source="global", skill_dir=str(sk),
                       path=str(sk / "SKILL.md"), files=["scripts/x.py"])
    blob = export_skill_zip(spec)
    assert install_skill_zip(blob, tmp_path / "dest", source="global") == ["pdf-processing"]
    assert (tmp_path / "dest" / "pdf-processing" / "scripts" / "x.py").is_file()


def test_install_overwrites_existing(tmp_path):
    dest = tmp_path / "g"
    install_skill_zip(_zip({"pdf-processing/SKILL.md": GOOD_MD,
                            "pdf-processing/old.txt": "old"}), dest)
    # réinstalle sans old.txt (overwrite DEMANDÉ) → l'ancien ne subsiste pas
    install_skill_zip(_zip({"pdf-processing/SKILL.md": GOOD_MD}), dest, overwrite=True)
    assert (dest / "pdf-processing" / "SKILL.md").is_file()
    assert not (dest / "pdf-processing" / "old.txt").exists()


def test_install_refuses_existing_without_overwrite(tmp_path):
    dest = tmp_path / "g"
    install_skill_zip(_zip({"pdf-processing/SKILL.md": GOOD_MD,
                            "pdf-processing/keep.txt": "précieux"}), dest)
    with pytest.raises(SkillExistsError) as e:
        install_skill_zip(_zip({"pdf-processing/SKILL.md": GOOD_MD}), dest)
    assert e.value.names == ["pdf-processing"]
    assert "existe déjà" in str(e.value)
    # AUCUNE écriture : le contenu d'origine est intact.
    assert (dest / "pdf-processing" / "keep.txt").is_file()


def test_install_package_nested_and_tolerant(tmp_path):
    """Package multi-skills + sous-skills imbriqués (3 niveaux) + import tolérant
    (frontmatter mentionnant « claude ») + capture de fichiers bornée."""
    def md(n):
        return f"---\nname: {n}\ndescription: claude-flavored {n} skill\n---\nbody {n}\n"
    blob = _zip({
        "README.md": "stray top-level file (ignored)",
        "pkg/SKILL.md": md("pkg"),
        "pkg/util.txt": "u",
        "pkg/child/SKILL.md": md("child"),
        "pkg/child/scripts/x.py": "print(1)\n",
        "pkg/child/gc/SKILL.md": md("gc"),
        "solo/SKILL.md": md("solo"),
    })
    dest = tmp_path / "g"
    imported = install_skill_zip(blob, dest, source="global", strict=False)
    assert imported == ["pkg", "pkg/child", "pkg/child/gc", "solo"]
    assert (dest / "pkg/child/scripts/x.py").is_file()
    assert not (dest / "README.md").exists()        # fichier parasite racine ignoré

    specs = {s.id: s for s in _scan_tree(dest, "global")}
    assert set(specs) == {"pkg", "pkg/child", "pkg/child/gc", "solo"}
    assert specs["pkg/child"].parent_id == "pkg" and specs["pkg/child"].depth == 1
    assert specs["pkg/child/gc"].depth == 2
    assert specs["pkg"].files == ["util.txt"]       # capture bornée (exclut les enfants)


def test_install_tolerant_accepts_non_conformant(tmp_path):
    """Mode strict refuse un nom non conforme (majuscules) ; tolérant l'accepte."""
    blob = _zip({"MySkill/SKILL.md": "---\nname: MySkill\ndescription: x\n---\nb\n"})
    with pytest.raises(SkillSaveError):
        install_skill_zip(blob, tmp_path / "s", strict=True)
    assert install_skill_zip(blob, tmp_path / "t", strict=False) == ["MySkill"]


# ── Layout tolérant (contenu zippé sans dossier racine, casse mac/Windows) ──


def test_root_level_skillmd_wrapped(tmp_path):
    """LE cas utilisateur : zipper le CONTENU du dossier-skill (SKILL.md à la
    racine de l'archive) → ré-emballé sous le slug de son frontmatter."""
    blob = _zip({"SKILL.md": GOOD_MD, "scripts/x.py": "print(1)\n"})
    dest = tmp_path / "g"
    assert install_skill_zip(blob, dest, strict=False) == ["pdf-processing"]
    assert (dest / "pdf-processing" / "SKILL.md").is_file()
    assert (dest / "pdf-processing" / "scripts" / "x.py").is_file()
    assert {s.name for s in _scan_tree(dest, "global")} == {"pdf-processing"}


def test_root_level_accented_name_slugified(tmp_path):
    md = "---\nname: Mémo Équipe\ndescription: notes internes\n---\ncorps\n"
    assert install_skill_zip(_zip({"SKILL.md": md}), tmp_path / "g",
                             strict=False) == ["memo-equipe"]


def test_root_wrap_nests_subskills(tmp_path):
    md_child = "---\nname: child\ndescription: c\n---\nb\n"
    blob = _zip({"SKILL.md": GOOD_MD, "child/SKILL.md": md_child})
    imported = install_skill_zip(blob, tmp_path / "g", strict=False)
    assert imported == ["pdf-processing", "pdf-processing/child"]


def test_case_insensitive_skillmd_rescued(tmp_path):
    """Zip refait sous mac/Windows : ``Skill.md`` canonisé en ``SKILL.md``
    (sinon la découverte exact-case ne verrait jamais le skill)."""
    blob = _zip({"my-skill/Skill.md": "---\nname: my-skill\ndescription: d\n---\nb\n"})
    dest = tmp_path / "g"
    assert install_skill_zip(blob, dest, strict=False) == ["my-skill"]
    assert (dest / "my-skill" / "SKILL.md").is_file()
    assert {s.name for s in _scan_tree(dest, "global")} == {"my-skill"}


def test_case_rescue_skipped_when_exact_present(tmp_path):
    """Rescue-only : un ``docs/skill.md`` à côté d'un vrai SKILL.md reste un
    simple document (pas de sous-skill fantôme)."""
    blob = _zip({"pkg/SKILL.md": "---\nname: pkg\ndescription: d\n---\nb\n",
                 "pkg/docs/skill.md": "juste une doc\n"})
    dest = tmp_path / "g"
    assert install_skill_zip(blob, dest, strict=False) == ["pkg"]
    assert (dest / "pkg" / "docs" / "skill.md").is_file()      # casse intacte
    assert not (dest / "pkg" / "docs" / "SKILL.md").exists()


# ── Overwrite / durcissement ──


def test_symlinked_root_rejected_even_with_overwrite(tmp_path):
    dest = tmp_path / "g"
    dest.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (dest / "pdf-processing").symlink_to(outside)
    with pytest.raises(SkillSaveError) as e:
        install_skill_zip(_zip({"pdf-processing/SKILL.md": GOOD_MD}), dest, overwrite=True)
    assert "hors de la bibliothèque" in str(e.value)
    assert outside.exists()                                    # rien suivi/écrasé


def test_nul_byte_arcname_no_crash(tmp_path):
    """Un NUL dans un nom d'archive (zip FORGÉ au niveau octets) ne doit JAMAIS
    finir en ValueError/500 : soit le lecteur Python tronque au NUL (≥ 3.12),
    soit la garde de ``_zip_safe_members`` lève SkillSaveError (400)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("pdf-processing/SKILL.md", GOOD_MD)
        z.writestr("pdf-processing/xNy.txt", "x")
    blob = buf.getvalue().replace(b"pdf-processing/xNy.txt",
                                  b"pdf-processing/x\x00y.txt")
    try:
        install_skill_zip(blob, tmp_path / "g", strict=False)
    except SkillSaveError:
        pass  # refus propre — acceptable aussi


@pytest.mark.skipif(
    "SKILL_ZIP_MAX_BYTES" in os.environ or "SKILL_ZIP_MAX_UNCOMPRESSED" in os.environ,
    reason="caps surchargés par l'environnement")
def test_caps_defaults_aligned():
    """Cap compressé aligné sur le cap décompressé (même borne effective que
    l'import-dossier : 25 Mo)."""
    assert S.SKILL_ZIP_MAX_BYTES == 25 * 1024 * 1024
    assert S.SKILL_ZIP_MAX_UNCOMPRESSED == 25 * 1024 * 1024
