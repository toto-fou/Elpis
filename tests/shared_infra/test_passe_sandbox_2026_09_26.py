# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_passe_sandbox_2026_09_26.py — passe audit +
optimisation de la sandbox (2026-09-26).

Verrouille :
  • archives : extraction bornée (bombe tar) — le zip de dossier, plafonné,
    est produit par l'agent de la sandbox (test_archives_agent_2026_09_29) ;
  • paths : nom temporaire tronqué en octets, copie d'arbre atomique et sans
    suivi de lien ;
  • cycle de vie : cache par compte,
    verrou de cycle de vie sans fuite par boucle, 137 = redémarrage.
"""
from __future__ import annotations

import asyncio
import gc
import io
import os
import tarfile
import zipfile
from pathlib import Path

import pytest

# ── Archives ─────────────────────────────────────────────────────────────────

def _tar(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, data in members:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
    buf.seek(0)
    return buf


def test_extraction_bornee_refuse_la_bombe(tmp_path):
    from shared_infra.sandbox import routes_files as rf
    dest = tmp_path / "x"
    dest.mkdir()
    with pytest.raises(rf._ArchiveTooBig):
        rf._extract_tar_bounded(_tar([("a", b"0" * 2000), ("b", b"0" * 2000)]), dest,
                                max_total=3000, max_members=100)
    with pytest.raises(rf._ArchiveTooBig):
        rf._extract_tar_bounded(_tar([(f"f{i}", b"x") for i in range(20)]), dest,
                                max_total=10 ** 6, max_members=5)


def test_extraction_bornee_contenue(tmp_path):
    from shared_infra.sandbox import routes_files as rf
    dest = tmp_path / "x"
    dest.mkdir()
    n = rf._extract_tar_bounded(_tar([("ok/a.txt", b"A"), ("../evil", b"E"),
                                      ("/abs", b"B")]), dest,
                                max_total=10 ** 6, max_members=100)
    assert n == 1 and (dest / "ok" / "a.txt").read_bytes() == b"A"
    assert not (tmp_path / "evil").exists()


# ── paths ────────────────────────────────────────────────────────────────────

def test_nom_temporaire_tronque_en_octets(tmp_path):
    from shared_infra.sandbox.paths import _short_leaf, write_beneath
    leaf = "文" * 81                               # 243 octets : nom légal
    assert len(_short_leaf(leaf).encode()) <= 120
    assert write_beneath(tmp_path, leaf, b"ok") == 2
    assert (tmp_path / leaf).read_bytes() == b"ok"


def test_copie_d_arbre_liens_tels_quels_et_atomique(tmp_path):
    from shared_infra.sandbox.paths import copytree_beneath
    src = tmp_path / "src"
    (src / "d").mkdir(parents=True)
    (src / "d" / "f.txt").write_text("x")
    os.symlink("/etc/passwd", src / "lien")
    base = tmp_path / "base"
    base.mkdir()
    assert copytree_beneath(src, base, "copie") == 1
    assert (base / "copie" / "d" / "f.txt").read_text() == "x"
    assert os.readlink(base / "copie" / "lien") == "/etc/passwd"
    with pytest.raises(FileExistsError):
        copytree_beneath(src, base, "copie")
    (base / "fichier").write_text("occupé")
    with pytest.raises(FileExistsError):
        copytree_beneath(src, base, "fichier")
    assert not [p for p in base.iterdir() if p.name.endswith(".cptmp")]


def test_copie_d_arbre_echec_ne_laisse_rien(tmp_path, monkeypatch):
    from shared_infra.sandbox import paths
    src = tmp_path / "src"
    src.mkdir()
    for i in range(3):
        (src / f"f{i}").write_text("x")
    base = tmp_path / "base"
    base.mkdir()
    vrai = paths.write_beneath
    appels = {"n": 0}

    def casse(*a, **k):
        appels["n"] += 1
        if appels["n"] == 2:
            raise OSError("disque plein")
        return vrai(*a, **k)
    monkeypatch.setattr(paths, "write_beneath", casse)
    with pytest.raises(OSError):
        paths.copytree_beneath(src, base, "copie")
    assert list(base.iterdir()) == [], "arbre à moitié copié laissé en place"


# ── Cycle de vie ─────────────────────────────────────────────────────────────

def test_reset_cache_d_un_seul_compte():
    from shared_infra.sandbox.executors import _user_sandbox as us
    us._USER_SANDBOXES.clear()
    us._USER_SANDBOXES[(1, "alice")] = object()
    us._USER_SANDBOXES[(2, "bob")] = object()
    us.reset_user_sandbox_cache(1)
    assert list(us._USER_SANDBOXES) == [(2, "bob")]
    us.reset_user_sandbox_cache()
    assert us._USER_SANDBOXES == {}


def test_verrou_de_cycle_de_vie_ne_fuit_pas(tmp_path, monkeypatch):
    import shared_infra.config as cfg
    from shared_infra.sandbox.executors import _user_sandbox as us
    monkeypatch.setattr(cfg, "SANDBOX_DIR", tmp_path)

    async def prendre():
        async with us._lifecycle_lock(7):
            assert (tmp_path / ".lifecycle_locks" / "u7.lock").exists()

    avant = len(us._lifecycle_locks)
    for _ in range(20):                            # boucles éphémères (pont d'exec)
        loop = asyncio.new_event_loop()
        loop.run_until_complete(prendre())
        loop.close()
        del loop
    gc.collect()
    assert len(us._lifecycle_locks) <= avant + 1, "une entrée par boucle morte"


async def test_verrou_inter_process_serialise(tmp_path, monkeypatch):
    import fcntl

    import shared_infra.config as cfg
    from shared_infra.sandbox.executors import _user_sandbox as us
    monkeypatch.setattr(cfg, "SANDBOX_DIR", tmp_path)
    monkeypatch.setattr(us, "_LIFECYCLE_FLOCK_WAIT_S", 0.3)
    async with us._lifecycle_lock(9):
        # un « autre process » ne l'obtient pas pendant qu'on le tient
        fd = os.open(str(tmp_path / ".lifecycle_locks" / "u9.lock"), os.O_RDWR)
        try:
            with pytest.raises(OSError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)


async def test_conteneur_arrete_par_le_gc_est_redemarre(monkeypatch, tmp_path):
    from shared_infra.sandbox.executors import _user_sandbox as us
    sb = us.UserSandbox(1, "alice", tmp_path / "w")
    appels = []

    async def fausse_cli(*args, **kw):
        appels.append(args[0])
        if args[0] == "inspect":
            if "ExitCode" in args[2]:
                return 0, b"137|false", b""
            # Labels à jour : rien n'impose de le recréer.
            return 0, f"{us.netcfg_hash(sb.network_profile)}|{us.RUN_SPEC}".encode(), b""
        return 0, b"", b""

    async def create():
        appels.append("CREATE")
    monkeypatch.setattr(sb._cli, "call", fausse_cli)
    monkeypatch.setattr(sb, "_create", create)

    async def status():
        return us.SandboxStatus(exists=True, running=True)
    monkeypatch.setattr(sb, "status", status)
    await sb._ensure_running_locked(us.SandboxStatus(exists=True, running=False))
    assert "start" in appels and "rm" not in appels and "CREATE" not in appels


def test_deux_comptes_non_resolus_ne_partagent_pas_la_sandbox(tmp_path):
    """Id 0 (identité non résolue) : la clé porte aussi le nom — sinon le
    second compte recevait la sandbox, et le dossier, du premier."""
    from shared_infra.sandbox.executors import _user_sandbox as us
    us.reset_user_sandbox_cache()
    try:
        a = us.get_user_sandbox(0, "alice", tmp_path / "alice" / "work")
        b = us.get_user_sandbox(0, "bob", tmp_path / "bob" / "work")
        assert a is not b and b.sandbox_path == tmp_path / "bob" / "work"
        assert us.get_user_sandbox(0, "alice", tmp_path / "x") is a
    finally:
        us.reset_user_sandbox_cache()
