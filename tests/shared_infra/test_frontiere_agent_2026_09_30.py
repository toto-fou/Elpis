# SPDX-License-Identifier: MIT
"""Frontière par l'agent (L4.6) : un seul UID écrit dans /work — l'hôte n'y
élargit plus rien, et la suppression d'un compte vide /work par le root du
conteneur quand l'hôte ne peut pas effacer ce qui appartient à son UID."""
from __future__ import annotations

import os
import shutil

import pytest

from shared_infra.routes.admin import users as admin_users
from shared_infra.sandbox.executors import _user_sandbox as us


def test_suppression_d_un_compte_videe_par_le_conteneur(tmp_path, monkeypatch):
    P = tmp_path / "alice"
    (P / "work" / "d").mkdir(parents=True)
    (P / "work" / "d" / "f").write_text("x")
    (P / "skills").mkdir()
    appels: list = []
    vrai = shutil.rmtree

    def rmtree(p, *a, **k):
        if (P / "work" / "d").exists():                # contenu à l'UID du conteneur
            raise PermissionError(13, "Permission denied", str(P / "work" / "d" / "f"))
        return vrai(p, *a, **k)

    async def purge(self):
        appels.append(self.sandbox_path)
        vrai(self.sandbox_path / "d")                  # ce que fait le root du conteneur
    monkeypatch.setattr(shutil, "rmtree", rmtree)
    monkeypatch.setattr(us.UserSandbox, "purge", purge)
    assert admin_users._supprimer_sandbox(7, "alice", P) == (True, None)
    assert appels == [P / "work"] and not P.exists()


def test_suppression_sans_contenu_etranger_ni_conteneur(tmp_path, monkeypatch):
    P = tmp_path / "bob"
    (P / "work").mkdir(parents=True)

    async def purge(self):                             # jamais appelé
        raise AssertionError("conteneur inutile")
    monkeypatch.setattr(us.UserSandbox, "purge", purge)
    assert admin_users._supprimer_sandbox(8, "bob", P) == (True, None)
    assert not P.exists()
    assert admin_users._supprimer_sandbox(8, "bob", P) == (False, None)


@pytest.mark.asyncio
async def test_purge_vide_work_par_le_root_puis_retire_le_conteneur(tmp_path):
    sb = us.UserSandbox.__new__(us.UserSandbox)
    sb.username, sb.user_id, sb.sandbox_path = "carol", 9, tmp_path / "work"
    vus: list = []

    class _Cli:
        async def call(self, *args, timeout=None):
            vus.append(list(args))
            return 0, b"", b""
    sb._cli = _Cli()

    async def en_marche():
        return us.SandboxStatus(exists=True, running=True, container_name=sb.container_name)

    async def detruire():
        vus.append(["destroy"])
    sb.ensure_running, sb.destroy = en_marche, detruire
    await sb.purge()
    # Processus du compte arrêtés d'abord (relecture finale), puis /work vidé.
    assert vus == [["exec", "-u", "0:0", "elpis-sb-carol", "pkill", "-KILL", "-U", "10001"],
                   ["exec", "-u", "0:0", "elpis-sb-carol", "find", "/work", "-xdev",
                    "-mindepth", "1", "-delete"], ["destroy"]]


def test_ecriture_neuve_en_0644_quel_que_soit_l_umask(tmp_path):
    from shared_infra.sandbox.agent import server as S
    ancien = os.umask(0)
    try:
        a = S.Agent(str(tmp_path))
        a.ecrire("d/n.txt", [b"x"], parents=True)
    finally:
        os.umask(ancien)
    assert os.stat(tmp_path / "d" / "n.txt").st_mode & 0o777 == 0o644
    assert os.stat(tmp_path / "d").st_mode & 0o777 == 0o755
