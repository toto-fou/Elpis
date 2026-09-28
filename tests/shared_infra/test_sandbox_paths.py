# SPDX-License-Identifier: MIT
"""Property/fuzz tests for the unified sandbox path resolver.

These freeze the containment semantics BEFORE any caller is rewired onto
resolve_under() — the migration plan's explicit precondition.
"""
import pytest

from shared_infra.sandbox.paths import (
    CONTAINER_ROOT,
    ResolvedPath,
    SandboxPathError,
    resolve_under,
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


# ── resolve_under: happy paths ───────────────────────────────────────────
def test_resolve_simple(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    r = resolve_under(base, "src/main.py")
    assert isinstance(r, ResolvedPath)
    assert r.rel == "src/main.py"
    assert r.host == (base / "src/main.py").resolve()
    assert r.container == "/work/src/main.py"
    assert r.is_root is False


def test_container_view_forms_are_equivalent(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    forms = [resolve_under(base, p) for p in ("/work/src/x", "work/src/x", "./work/src/x", "src/x")]
    assert all(f == forms[0] for f in forms)
    assert forms[0].rel == "src/x"


@pytest.mark.parametrize("p", ["", "/work", "work", "./work", "."])
def test_resolve_root_forms(tmp_path, p):
    base = tmp_path / "alice"
    base.mkdir()
    r = resolve_under(base, p)
    assert r.rel == "" and r.is_root
    assert r.container == CONTAINER_ROOT
    assert r.host == base.resolve()


def test_nonexistent_write_target_ok(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    r = resolve_under(base, "new/dir/file.txt")
    assert r.rel == "new/dir/file.txt"
    assert base.resolve() in r.host.parents


# ── resolve_under: escapes are rejected ──────────────────────────────────
def test_root_disallowed_when_requested(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    with pytest.raises(SandboxPathError):
        resolve_under(base, "/work", allow_root=False)


@pytest.mark.parametrize("bad", ["../bob/secret", "/work/../bob", "a/../../bob", ".."])
def test_reject_parent_escape(tmp_path, bad):
    base = tmp_path / "alice"
    base.mkdir()
    with pytest.raises(SandboxPathError):
        resolve_under(base, bad)


def test_reject_sibling_prefix(tmp_path):
    # The classic startswith() bug: base 'alice' must not admit 'alice2'.
    base = tmp_path / "alice"
    base.mkdir()
    (tmp_path / "alice2").mkdir()
    with pytest.raises(SandboxPathError):
        resolve_under(base, "../alice2/secret")


def test_reject_absolute_outside(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    with pytest.raises(SandboxPathError):
        resolve_under(base, "/etc/passwd")


def test_reject_null_byte(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    with pytest.raises(SandboxPathError):
        resolve_under(base, "a\x00b")


def test_strip_work_prefix_not_idempotent_for_work_folder():
    # The trap that broke chunked upload: strip is single-pass, so applying it
    # twice to a real 'work/...' folder over-strips. Routes must strip exactly
    # ONCE (pass the original rel_path to the _sandbox_exec helpers).
    assert strip_work_prefix("work/work/f") == "work/f"           # one strip
    assert strip_work_prefix(strip_work_prefix("work/work/f")) == "f"  # two = wrong


@pytest.mark.parametrize("rel", ["report.csv", "dir/x.bin", "work/report.csv",
                                 "work/work/report.csv", "/work/y.bin"])
def test_chunk_upload_single_strip_consistency(tmp_path, rel):
    # After the fix, the chunk route passes the ORIGINAL rel_path (+ ".part")
    # to the helpers. The host check uses strip_work_prefix(rel). All three
    # (host target, container final, container tmp) must agree on one file.
    root = tmp_path / "alice"
    rel_norm = strip_work_prefix(rel)                  # host safe basis
    host_target = (root / rel_norm)
    final_container = strip_work_prefix(rel)           # helper single-strip on rel
    tmp_container = strip_work_prefix(rel + ".part")   # helper single-strip on rel+".part"
    assert (root / final_container) == host_target
    assert tmp_container == final_container + ".part"  # tmp & final in the same dir


def test_reject_symlink_out(tmp_path):
    # A symlink inside the sandbox pointing OUT must not be a containment hole:
    # resolve() follows it to the target, which is then rejected.
    base = tmp_path / "alice"
    base.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("top secret")
    (base / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(SandboxPathError):
        resolve_under(base, "link/secret.txt")


# ── AUDIT 2026-06 — ``~`` mappé sur la racine sandbox (plus d'expanduser) ──

def test_tilde_maps_to_sandbox_root(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    r = resolve_under(base, "~")
    assert r.rel == "" and r.is_root


def test_tilde_slash_maps_inside_sandbox(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    r = resolve_under(base, "~/notes/a.txt")
    assert r.rel == "notes/a.txt"
    assert r.host == (base / "notes/a.txt").resolve()


def test_tilde_user_stays_literal(tmp_path):
    # ``~bob`` n'est PAS un raccourci home : nom de fichier littéral.
    base = tmp_path / "alice"
    base.mkdir()
    r = resolve_under(base, "~bob/x")
    assert r.rel == "~bob/x"


def test_tilde_never_reaches_host_home(tmp_path, monkeypatch):
    # Même avec un HOME hôte valide, ``~`` ne doit JAMAIS s'y résoudre.
    base = tmp_path / "alice"
    base.mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "hosthome"))
    r = resolve_under(base, "~/f.txt")
    assert str(r.host).startswith(str(base.resolve()))


def test_tilde_escape_still_rejected(tmp_path):
    base = tmp_path / "alice"
    base.mkdir()
    with pytest.raises(SandboxPathError):
        resolve_under(base, "~/../../etc/passwd")
