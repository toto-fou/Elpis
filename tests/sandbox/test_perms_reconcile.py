# SPDX-License-Identifier: MIT
"""Droits de /work rendus à l'UID du conteneur (``UserSandbox._reconcile_work_modes``,
L4.6) : un seul UID écrit dans /work, plus d'élargissement. Par le root du
conteneur (``docker exec -u 0:0``) : ``/work`` lui-même à chaque premier
passage du processus, tout l'arbre hérité de l'élargissement une fois par
compte (marqueur côté hôte, à ``P``).

Testé au niveau de la méthode avec un faux CLI docker — sans Docker.
"""
import types

import pytest

from shared_infra.sandbox.executors._user_sandbox import _MODES_MARKER, UserSandbox


class _FakeCli:
    """Enregistre les sous-commandes ``docker`` ; rend (rc, out, err)."""

    def __init__(self, rc: int = 0):
        self.calls: list[list[str]] = []
        self.rc = rc

    async def call(self, *args, timeout=None):
        self.calls.append([str(a) for a in args])
        return (self.rc, b"", b"" if self.rc == 0 else b"boom")


def _mk(work_dir, rc: int = 0, exec_user: str = "") -> UserSandbox:
    # Sans __init__ (lecture de config) : seulement ce que la méthode lit.
    sb = UserSandbox.__new__(UserSandbox)
    sb.username = "tester"
    sb.sandbox_path = work_dir
    sb._cli = _FakeCli(rc=rc)
    sb._modes_verified = False
    sb.cfg = types.SimpleNamespace(exec_user=exec_user)
    return sb


@pytest.mark.asyncio
async def test_premier_passage_rend_tout_l_arbre_a_l_uid_du_conteneur(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    sb = _mk(work)

    await sb._reconcile_work_modes()

    (call,) = sb._cli.calls
    assert call[:4] == ["exec", "-u", "0:0", "elpis-sb-tester"]
    script, owner, tout = call[call.index("-c") + 1], call[-2], call[-1]
    assert (owner, tout) == ("10001:10001", "1")
    assert 'chown "$1" /work && chmod 0755 /work' in script
    assert 'chown -R "$1" /work; chmod -R go-w /work' in script
    assert (tmp_path / _MODES_MARKER).exists()      # à P, hors du montage


@pytest.mark.asyncio
async def test_ensuite_la_racine_seulement_et_l_utilisateur_configure(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    (tmp_path / _MODES_MARKER).write_text("1", encoding="utf-8")
    sb = _mk(work, exec_user="1234:1234")

    await sb._reconcile_work_modes()
    await sb._reconcile_work_modes()                 # une fois par processus

    (call,) = sb._cli.calls
    assert call[-2:] == ["1234:1234", "0"]


@pytest.mark.asyncio
async def test_un_echec_ne_pose_pas_le_marqueur(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    sb = _mk(work, rc=1)

    await sb._reconcile_work_modes()

    assert not (tmp_path / _MODES_MARKER).exists()   # le processus suivant réessaie


def test_marqueurs_reserves_hors_du_montage():
    """Le marqueur est déclaré dans ``executors`` et ``paths`` : même nom, et
    lui comme ceux de l'ancien élargissement restent à ``P`` (la migration
    work-subdir ne les déplace pas dans /work)."""
    from shared_infra.sandbox.paths import _MODES_MARKER as _PATHS_MARKER, _PERMS_MARKER_LEGACY, _WORK_RESERVED
    assert _MODES_MARKER == _PATHS_MARKER
    assert _MODES_MARKER in _WORK_RESERVED
    assert all(n in _WORK_RESERVED for n in _PERMS_MARKER_LEGACY)
