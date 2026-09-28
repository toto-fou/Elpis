# SPDX-License-Identifier: MIT
"""Regression tests locking the fs_tools path-helper behavior after the
rewire onto shared_infra.sandbox.paths. These assert the contract callers
depend on did NOT change: _safe_path returns a contained host Path (raising
ValueError on escape), _to_container renders the /work view.
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


def test_safe_path_relative(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    p = fs_tools._safe_path("src/main.py", base)
    assert p == (base / "src/main.py").resolve()


def test_safe_path_container_forms_equivalent(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    target = (base / "src/x").resolve()
    for form in ("/work/src/x", "work/src/x", "./work/src/x", "src/x"):
        assert fs_tools._safe_path(form, base) == target


def test_safe_path_strips_overquoting(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    assert fs_tools._safe_path('"src/x"', base) == (base / "src/x").resolve()


def test_safe_path_escape_raises_valueerror(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    (tmp_path / "alice2").mkdir()
    for bad in ("../alice2/secret", "/etc/passwd", "a/../../bob", "/work/../x"):
        with pytest.raises(ValueError):
            fs_tools._safe_path(bad, base)


def test_safe_path_empty_raises(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    with pytest.raises(ValueError):
        fs_tools._safe_path("", base)


def test_safe_path_null_byte_raises(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    with pytest.raises(ValueError):
        fs_tools._safe_path("a\x00b", base)


def test_to_container_roundtrip(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    assert fs_tools._to_container(base / "src/x.py", base) == "/work/src/x.py"
    assert fs_tools._to_container(base, base) == "/work"
