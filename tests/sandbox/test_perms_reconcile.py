# SPDX-License-Identifier: MIT
"""Auto-reconcile cross-UID perms on /work (``UserSandbox._reconcile_work_perms``).

Host (operator UID, e.g. 1000) and the per-user container (UID 10001) share no
group, so a container-created dir at the default group-writable mode is NOT
writable by the host fs tools. ``umask 0000`` fixes NEW writes; this one-time
repair makes the PRE-EXISTING backlog other-writable via ``chmod -R o+rwX
/work`` run as container root (``docker exec -u 0:0``), gated by a host-side
marker so the costly recursive chmod runs once per sandbox.

Tested at the method layer with a fake docker CLI — no Docker required.
"""
import pytest

from shared_infra.sandbox.executors._user_sandbox import UserSandbox, _PERMS_MARKER


class _FakeCli:
    """Records ``docker`` subcommands; returns a canned (rc, out, err)."""

    def __init__(self, rc: int = 0):
        self.calls: list[list[str]] = []
        self.rc = rc

    async def call(self, *args, timeout=None):
        self.calls.append([str(a) for a in args])
        return (self.rc, b"", b"" if self.rc == 0 else b"boom")


def _mk(work_dir, rc: int = 0) -> UserSandbox:
    # Bypass __init__ (config I/O) — set only what the method touches.
    sb = UserSandbox.__new__(UserSandbox)
    sb.username = "tester"
    sb.sandbox_path = work_dir
    sb._cli = _FakeCli(rc=rc)
    sb._perms_reconciled = False
    return sb


@pytest.mark.asyncio
async def test_reconcile_issues_chmod_orwx_as_container_root(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    sb = _mk(work)

    await sb._reconcile_work_perms()

    assert len(sb._cli.calls) == 1, "exactly one docker exec expected"
    call = sb._cli.calls[0]
    # Runs as container root (UID 0) so it can chmod paths the host doesn't own.
    assert call[:4] == ["exec", "-u", "0:0", "elpis-sb-tester"]
    joined = " ".join(call)
    assert "chmod -R o+rwX /work" in joined, joined
    # Marker written host-side at P (= work.parent), outside the mount.
    assert (tmp_path / _PERMS_MARKER).exists()


@pytest.mark.asyncio
async def test_reconcile_skips_when_marker_present(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    (tmp_path / _PERMS_MARKER).write_text("1", encoding="utf-8")
    sb = _mk(work)

    await sb._reconcile_work_perms()

    assert sb._cli.calls == [], "must not chmod again once the marker exists"


@pytest.mark.asyncio
async def test_reconcile_runs_once_per_process(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    sb = _mk(work)

    await sb._reconcile_work_perms()
    await sb._reconcile_work_perms()  # second call short-circuits on the flag

    assert len(sb._cli.calls) == 1


def test_marker_name_is_shared_by_both_modules():
    """Le marqueur est déclaré DEUX fois (executors + sandbox.paths) : s'ils
    divergent, ``paths`` ne réserve plus le nom réellement écrit et le fichier
    descend dans ``P/work`` — exposé au modèle, et la passe one-shot se
    re-déclenche à chaque migration."""
    from shared_infra.sandbox.paths import _PERMS_MARKER as _PATHS_MARKER
    assert _PERMS_MARKER == _PATHS_MARKER


def test_every_marker_generation_stays_out_of_the_work_subdir():
    """Bumper le marqueur re-déclenche la réparation une fois par sandbox ;
    les générations précédentes doivent RESTER réservées, sinon la migration
    work-subdir les déplacerait dans ``P/work`` (visibles/supprimables depuis
    le conteneur)."""
    from shared_infra.sandbox.paths import (
        _PERMS_MARKER as _cur, _PERMS_MARKER_LEGACY as _legacy, _WORK_RESERVED,
    )
    assert _cur in _WORK_RESERVED
    for name in _legacy:
        assert name in _WORK_RESERVED, f"marqueur legacy {name} non réservé"
    assert _cur not in _legacy, "la génération courante ne peut pas être legacy"


@pytest.mark.asyncio
async def test_reconcile_failure_leaves_no_marker_so_next_process_retries(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    sb = _mk(work, rc=1)  # docker exec fails

    await sb._reconcile_work_perms()

    assert not (tmp_path / _PERMS_MARKER).exists(), (
        "a failed repair must not write the marker — the next process retries"
    )
