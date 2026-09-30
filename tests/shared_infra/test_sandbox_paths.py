# SPDX-License-Identifier: MIT
"""Chemins d'une sandbox côté hôte : normalisation LEXICALE (``lexical_rel``,
``strip_work_prefix``, ``to_container``). Les liens sont résolus par l'agent
du conteneur (L4) ; ici, seul le texte du chemin compte."""
import pytest

from shared_infra.sandbox.paths import (
    CONTAINER_ROOT,
    SandboxPathError,
    lexical_rel,
    strip_work_prefix,
    to_container,
)


# ── strip_work_prefix / to_container ─────────────────────────────────────
@pytest.mark.parametrize("raw", ["/work", "work", "./work", "  /work  "])
def test_strip_work_prefix_roots(raw):
    assert strip_work_prefix(raw) == ""


@pytest.mark.parametrize("raw", ["/work/src/x.py", "work/src/x.py", "./work/src/x.py"])
def test_strip_work_prefix_children(raw):
    assert strip_work_prefix(raw) == "src/x.py"


def test_strip_work_prefix_passthrough():
    assert strip_work_prefix("src/x.py") == "src/x.py"
    assert strip_work_prefix("") == ""
    # a path that merely CONTAINS 'work' is not a prefix match
    assert strip_work_prefix("workshop/x") == "workshop/x"


def test_to_container():
    assert to_container("") == CONTAINER_ROOT
    assert to_container(".") == CONTAINER_ROOT
    assert to_container("src/x") == "/work/src/x"
    assert to_container("/src/x") == "/work/src/x"


# ── lexical_rel : formes équivalentes, racine ─────────────────────────────
def test_container_view_forms_are_equivalent(tmp_path):
    forms = {lexical_rel(tmp_path, p) for p in ("/work/src/x", "work/src/x", "./work/src/x", "src/x")}
    assert forms == {"src/x"}


@pytest.mark.parametrize("p", ["", "/work", "work", "./work", "."])
def test_root_forms(tmp_path, p):
    assert lexical_rel(tmp_path, p) == ""


def test_host_path_under_the_root(tmp_path):
    assert lexical_rel(tmp_path, str(tmp_path / "a" / "b")) == "a/b"


# ── lexical_rel : sorties refusées ───────────────────────────────────────
def test_root_disallowed_when_requested(tmp_path):
    with pytest.raises(SandboxPathError):
        lexical_rel(tmp_path, "/work", allow_root=False)


@pytest.mark.parametrize("bad", ["../bob/secret", "/work/../bob", "a/../../bob", ".."])
def test_reject_parent_escape(tmp_path, bad):
    with pytest.raises(SandboxPathError):
        lexical_rel(tmp_path, bad)


def test_reject_sibling_prefix(tmp_path):
    # The classic startswith() bug: base 'alice' must not admit 'alice2'.
    base = tmp_path / "alice"
    with pytest.raises(SandboxPathError):
        lexical_rel(base, str(tmp_path / "alice2" / "secret"))


def test_reject_absolute_outside(tmp_path):
    with pytest.raises(SandboxPathError):
        lexical_rel(tmp_path, "/etc/passwd")


def test_reject_null_byte(tmp_path):
    with pytest.raises(SandboxPathError):
        lexical_rel(tmp_path, "a\x00b")


def test_strip_work_prefix_not_idempotent_for_work_folder():
    # The trap that broke chunked upload: strip is single-pass, so applying it
    # twice to a real 'work/...' folder over-strips. Routes must strip exactly
    # ONCE (pass the original rel_path to the helpers).
    assert strip_work_prefix("work/work/f") == "work/f"           # one strip
    assert strip_work_prefix(strip_work_prefix("work/work/f")) == "f"  # two = wrong


# ── ``~`` : la racine pour le modèle, un nom pour l'éditeur ──────────────
def test_tilde_maps_to_sandbox_root(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "hosthome"))   # jamais le HOME de l'hôte
    assert lexical_rel(tmp_path, "~") == ""
    assert lexical_rel(tmp_path, "~/notes/a.txt") == "notes/a.txt"
    assert lexical_rel(tmp_path, "~/notes/a.txt", tilde=False) == "~/notes/a.txt"


def test_tilde_user_stays_literal(tmp_path):
    # ``~bob`` n'est PAS un raccourci home : nom de fichier littéral.
    assert lexical_rel(tmp_path, "~bob/x") == "~bob/x"


def test_tilde_escape_still_rejected(tmp_path):
    with pytest.raises(SandboxPathError):
        lexical_rel(tmp_path, "~/../../etc/passwd")
