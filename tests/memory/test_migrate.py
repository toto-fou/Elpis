# SPDX-License-Identifier: MIT
"""Relocation best-effort de l'ancien store ``.memory`` → ``memory`` (host-owned).

L'ancien ``{sandbox}/{user}/.memory`` était owned UID 10001 (ancien mont) → le
serveur MCP hôte (1000) ne pouvait plus prendre son lock. On bascule vers
``{sandbox}/{user}/memory`` (créé par l'hôte → lui appartient).
"""
from __future__ import annotations

from llm_core.memory._migrate import migrate_legacy_memory
from llm_core.memory._scope import MEMORY_SUBDIR, LEGACY_MEMORY_SUBDIR


def test_creates_memory_dir_when_no_legacy(tmp_path):
    new = migrate_legacy_memory(tmp_path, "alice")
    assert new == tmp_path / "alice" / MEMORY_SUBDIR
    assert new.is_dir()
    assert not (tmp_path / "alice" / LEGACY_MEMORY_SUBDIR).exists()


def test_migrates_legacy_content_once(tmp_path):
    old = tmp_path / "bob" / LEGACY_MEMORY_SUBDIR
    (old / "scopes" / "deadbeef0000").mkdir(parents=True)
    (old / "USER.md").write_text("profil bob", encoding="utf-8")
    (old / "MEMORY.md").write_text("note bob", encoding="utf-8")
    (old / "scopes" / "deadbeef0000" / "MEMORY.md").write_text("scoped", encoding="utf-8")

    new = migrate_legacy_memory(tmp_path, "bob")
    assert new == tmp_path / "bob" / MEMORY_SUBDIR
    assert (new / "USER.md").read_text(encoding="utf-8") == "profil bob"
    assert (new / "MEMORY.md").read_text(encoding="utf-8") == "note bob"
    assert (new / "scopes" / "deadbeef0000" / "MEMORY.md").read_text(encoding="utf-8") == "scoped"


def test_idempotent_does_not_clobber_current(tmp_path):
    # 'memory' existe déjà (contenu courant) → un vieux .memory ne l'écrase PAS.
    new = tmp_path / "carol" / MEMORY_SUBDIR
    new.mkdir(parents=True)
    (new / "USER.md").write_text("courant", encoding="utf-8")
    old = tmp_path / "carol" / LEGACY_MEMORY_SUBDIR
    old.mkdir(parents=True)
    (old / "USER.md").write_text("ancien", encoding="utf-8")

    out = migrate_legacy_memory(tmp_path, "carol")
    assert out == new
    assert (new / "USER.md").read_text(encoding="utf-8") == "courant"


def test_safe_username_applied(tmp_path):
    new = migrate_legacy_memory(tmp_path, "Jean.Dupont")
    assert new == tmp_path / "JeanDupont" / MEMORY_SUBDIR
    assert new.is_dir()
