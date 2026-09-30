# SPDX-License-Identifier: MIT
"""Regression tests locking the fs_tools path-helper behavior after the
rewire onto shared_infra.sandbox.paths. These assert the contract callers
depend on: _rel returns the path relative to the sandbox, without reading
the disk (raising ValueError on escape), _to_container renders the /work view.
"""
import pytest

from llm_core.tools import fs_tools


def test_check_regex_safe_blocks_redos_allows_normal():
    import re
    # Signatures ReDoS (quantificateur imbriqué) → re.error (captée par les handlers existants)
    for bad in ["(a+)+", "(.*)*", "(x+)*y"]:
        with pytest.raises(re.error):
            fs_tools._check_regex_safe(bad)
    # motif absurdement long → rejeté
    with pytest.raises(re.error):
        fs_tools._check_regex_safe("a" * 2001)
    # motifs LÉGITIMES → aucune exception (pas de faux positif)
    for ok in ["foo.*bar", "(a|b)+", r"\bword\b", "(abc)+def", "", None]:
        fs_tools._check_regex_safe(ok)


def test_rel_relative(tmp_path):
    assert fs_tools._rel(tmp_path / "alice", "src/main.py") == "src/main.py"


def test_rel_container_forms_equivalent(tmp_path):
    base = tmp_path / "alice"
    for form in ("/work/src/x", "work/src/x", "./work/src/x", "src/x", str(base / "src/x")):
        assert fs_tools._rel(base, form) == "src/x"


def test_rel_strips_overquoting(tmp_path):
    assert fs_tools._rel(tmp_path / "alice", '"src/x"') == "src/x"


def test_rel_escape_raises_valueerror(tmp_path):
    base = tmp_path / "alice"
    for bad in ("../alice2/secret", "/etc/passwd", "a/../../bob", "/work/../x",
                str(tmp_path / "alice2" / "x")):
        with pytest.raises(ValueError):
            fs_tools._rel(base, bad)


def test_rel_empty_raises(tmp_path):
    with pytest.raises(ValueError):
        fs_tools._rel(tmp_path / "alice", "")


def test_rel_null_byte_and_control_raise(tmp_path):
    for bad in ("a\x00b", "a\x01b", "a\nb"):
        with pytest.raises(ValueError):
            fs_tools._rel(tmp_path / "alice", bad)


def test_rel_ne_lit_pas_le_disque(tmp_path):
    """Un lien reste tel quel : c'est l'agent qui le résout, sous /work."""
    import os
    base = tmp_path / "alice"
    base.mkdir()
    os.symlink(tmp_path, base / "lien")
    assert fs_tools._rel(base, "lien/x") == "lien/x"
    assert fs_tools._to_container(base / "lien" / "x", base) == "/work/lien/x"


def test_to_container_roundtrip(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    assert fs_tools._to_container(base / "src/x.py", base) == "/work/src/x.py"
    assert fs_tools._to_container(base, base) == "/work"
