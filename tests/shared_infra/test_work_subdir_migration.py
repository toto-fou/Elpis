# SPDX-License-Identifier: MIT
"""Tests for ``shared_infra.sandbox.ensure_work_subdir`` — the one-time
migration that moves a user's legacy flat sandbox layout into a ``work/``
subdir so that ``skills``/``.memory`` (and the rest of the reserved set) stay
OUTSIDE the bind-mounted ``/work``.

Covers: new-user create, idempotency, reserved-set preservation,
``.git-credentials.json`` riding along, resume-after-interruption, the
collision guard, and real cross-process concurrency (the ``flock``).
"""
import multiprocessing as mp
from pathlib import Path

from shared_infra.sandbox import ensure_work_subdir
from shared_infra.sandbox.paths import _WORK_MARKER, _WORK_RESERVED


def _seed(p: Path, names):
    p.mkdir(parents=True, exist_ok=True)
    for n in names:
        if n.endswith("/"):
            d = p / n.rstrip("/")
            d.mkdir(parents=True, exist_ok=True)
            (d / "child.txt").write_text("x")
        else:
            (p / n).write_text(f"content-of-{n}")


def test_new_user_creates_empty_work(tmp_path):
    P = tmp_path / "alice"           # does NOT exist yet
    work = ensure_work_subdir(P)
    assert work == P / "work"
    assert work.is_dir()
    assert (P / _WORK_MARKER).is_file()
    # nothing to migrate → work is empty (apart from being a dir)
    assert list(work.iterdir()) == []


def test_migrates_flat_layout_preserving_reserved(tmp_path):
    P = tmp_path / "bob"
    # real work files + a hidden env dotfile + the reserved siblings.
    _seed(P, ["main.py", "data.csv", ".bashrc", ".git-credentials.json",
              "src/", "skills/", ".memory/", ".skills-mirror.tmp/"])
    # sanity: reserved dirs got a child via _seed
    (P / "skills" / "ma-proc").mkdir(parents=True)
    (P / ".memory" / "MEMORY.md").write_text("souvenir")

    work = ensure_work_subdir(P)

    # Reserved siblings stay at P (NOT inside work/).
    for name in ("skills", ".memory", ".skills-mirror.tmp"):
        assert (P / name).exists()
        assert not (work / name).exists()
    assert (P / ".memory" / "MEMORY.md").read_text() == "souvenir"

    # Real files AND .git-credentials.json moved into work/.
    for name in ("main.py", "data.csv", ".bashrc", ".git-credentials.json", "src"):
        assert (work / name).exists(), name
        assert not (P / name).exists(), name
    assert (work / "src" / "child.txt").read_text() == "x"
    assert (work / "main.py").read_text() == "content-of-main.py"


def test_idempotent(tmp_path):
    P = tmp_path / "carol"
    _seed(P, ["a.txt", "b.txt"])
    ensure_work_subdir(P)
    # mutate work/ then call again — must be a no-op (marker present).
    (P / "work" / "a.txt").write_text("EDITED")
    (P / "work" / "new-after.txt").write_text("kept")
    work2 = ensure_work_subdir(P)
    assert (work2 / "a.txt").read_text() == "EDITED"
    assert (work2 / "new-after.txt").read_text() == "kept"
    # no stray re-creation of the originals at P
    assert not (P / "a.txt").exists()


def test_marker_written_last_and_resume(tmp_path):
    """Simulate an interrupted run: work/ exists with a SUBSET already moved
    and NO marker. The next call must move only the remainder and never
    overwrite an already-moved entry."""
    P = tmp_path / "dave"
    _seed(P, ["one.txt", "two.txt", "three.txt"])
    # Hand-simulate a partial migration: move only one.txt, no marker.
    work = P / "work"
    work.mkdir()
    (P / "one.txt").rename(work / "one.txt")
    (work / "one.txt").write_text("ALREADY-MOVED")   # must NOT be overwritten
    assert not (P / _WORK_MARKER).exists()

    ensure_work_subdir(P)

    assert (work / "one.txt").read_text() == "ALREADY-MOVED"   # untouched
    assert (work / "two.txt").read_text() == "content-of-two.txt"
    assert (work / "three.txt").read_text() == "content-of-three.txt"
    assert (P / _WORK_MARKER).is_file()
    assert not (P / "two.txt").exists()


def test_collision_guard_does_not_destroy_data(tmp_path):
    """If ``P/work`` pre-exists as a FILE (not a dir) and there is no marker,
    abort without moving/destroying anything."""
    P = tmp_path / "erin"
    _seed(P, ["keep.txt"])
    (P / "work").write_text("i am a file, not a dir")   # pathological

    ensure_work_subdir(P)

    # Aborted: the file is intact, the real file stays at P, no marker.
    assert (P / "work").is_file()
    assert (P / "work").read_text() == "i am a file, not a dir"
    assert (P / "keep.txt").read_text() == "content-of-keep.txt"
    assert not (P / _WORK_MARKER).exists()


def test_reserved_set_contains_expected(tmp_path):
    # Lock the security-critical reserved names so a future edit can't silently
    # start exposing skills/memory inside /work again.
    for name in ("work", "skills", ".memory", ".sandboxd", ".skills-mirror.tmp"):
        assert name in _WORK_RESERVED


def _worker(p_str):
    # Module-level for picklability (fork). Each process migrates the SAME P.
    ensure_work_subdir(Path(p_str))


def test_concurrent_migration_single_mover(tmp_path):
    P = tmp_path / "frank"
    files = [f"f{i}.txt" for i in range(12)]
    _seed(P, files)

    ctx = mp.get_context("fork")
    procs = [ctx.Process(target=_worker, args=(str(P),)) for _ in range(5)]
    for pr in procs:
        pr.start()
    for pr in procs:
        pr.join(timeout=30)
        assert pr.exitcode == 0

    work = P / "work"
    # Every file moved exactly once into work/, none left at P, marker present.
    for n in files:
        assert (work / n).read_text() == f"content-of-{n}"
        assert not (P / n).exists()
    assert (P / _WORK_MARKER).is_file()
    # No duplication / leftovers at the root beyond the reserved bookkeeping.
    leftovers = {e.name for e in P.iterdir()} - _WORK_RESERVED
    assert leftovers == set(), leftovers
