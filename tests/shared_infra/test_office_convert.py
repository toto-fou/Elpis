# SPDX-License-Identifier: MIT
"""Conversion LibreOffice isolée des aperçus Office (sans LibreOffice réel).

Couvre la ligne de commande (prison, filtre forcé, environnement MINIMAL), le
choix d'isolation, les verrous flock multi-workers, l'arrêt de TOUT le groupe
de processus sur délai dépassé, et le comptage des pages.
Cf. docs/editor-office-preview-design-2026-09-15.md
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest

from shared_infra.sandbox import office_convert as oc
from shared_infra.sandbox.office_convert import OfficeError


@pytest.fixture(autouse=True)
def _locks(tmp_path, monkeypatch):
    monkeypatch.setattr(oc, "LOCK_DIR", tmp_path / "locks")


def test_argv_prison_filtre_force_et_sortie(tmp_path, monkeypatch):
    monkeypatch.setattr(oc.shutil, "which", lambda n: f"/usr/bin/{n}")
    monkeypatch.setattr(oc.bwrap, "binary", lambda: "/usr/bin/bwrap")     # poste sans bwrap
    argv = oc.build_argv(isolation="bwrap", soffice="/usr/lib/libreoffice/program/soffice",
                         profile_dir=tmp_path / "p", job_dir=tmp_path / "j", kind="docx",
                         in_name="in.docx", convert_to="pdf", timeout_s=60)
    assert argv[0] == "/usr/bin/prlimit" and "--cpu=150" in argv
    b = argv.index("/usr/bin/bwrap")
    jail = argv[b:]
    for opt in ("--unshare-all", "--die-with-parent", "--new-session"):
        assert opt in jail
    assert jail[jail.index("--ro-bind-try", jail.index("/etc/fonts") - 1):][:3] == ["--ro-bind-try", "/etc/fonts", "/etc/fonts"]
    assert "/etc/libreoffice" in jail                                     # sofficerc (sinon rc 134)
    i = jail.index("--bind")
    assert jail[i:i + 6] == ["--bind", str(tmp_path / "p"), "/profile", "--bind", str(tmp_path / "j"), "/job"]
    lo = argv[argv.index("/usr/lib/libreoffice/program/soffice"):]
    assert "--infilter=MS Word 2007 XML" in lo
    assert "-env:UserInstallation=file:///profile" in lo
    assert lo[-3:] == ["--outdir", "/job/out", "/job/in.docx"]
    assert "--headless" in lo and "--norestore" in lo


def test_argv_sans_prison_chemins_hote(tmp_path, monkeypatch):
    monkeypatch.setattr(oc.shutil, "which", lambda n: None)
    argv = oc.build_argv(isolation="none", soffice="/opt/lo/program/soffice",
                         profile_dir=tmp_path / "p", job_dir=tmp_path / "j", kind="xlsx",
                         in_name="in.xlsx", convert_to=oc.CSV_CONVERT, timeout_s=10)
    assert argv[0] == "/opt/lo/program/soffice"
    assert f"-env:UserInstallation=file://{tmp_path / 'p'}" in argv
    assert argv[-1] == f"{tmp_path / 'j'}/in.xlsx"
    assert "--infilter=Calc MS Excel 2007 XML" in argv and oc.CSV_CONVERT in argv


def test_install_hors_usr_montee_en_lecture_seule(monkeypatch):
    assert "/opt/lo" in oc._bwrap_base(oc._install_dirs("/opt/lo/program/soffice"))
    assert oc._bwrap_base(oc._install_dirs("/usr/lib/libreoffice/program/soffice")).count("/usr") == 2


def test_environnement_minimal_sans_secret(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "chut")
    monkeypatch.setenv("LOCAL_MCP_TOKEN", "jeton")
    for iso in ("bwrap", "none"):
        env = oc.child_env(iso, tmp_path / "p", tmp_path / "j")
        assert set(env) == {"PATH", "LANG", "HOME", "TMPDIR"}
        assert "chut" not in env.values() and "jeton" not in env.values()


def test_isolation_auto_exige_bwrap(monkeypatch):
    monkeypatch.setattr(oc, "cfg", lambda k, d=None: "auto" if k == "isolation" else d)
    monkeypatch.setattr(oc, "probe_bwrap", lambda force=False: False)
    with pytest.raises(OfficeError) as e:
        oc.isolation_mode()
    assert e.value.code == "isolation_unavailable" and e.value.status == 503
    monkeypatch.setattr(oc, "probe_bwrap", lambda force=False: True)
    assert oc.isolation_mode() == "bwrap"


def test_isolation_none_seulement_explicite(monkeypatch):
    monkeypatch.setattr(oc, "cfg", lambda k, d=None: "none" if k == "isolation" else d)
    monkeypatch.setattr(oc, "probe_bwrap", lambda force=False: pytest.fail("pas de sonde"))
    assert oc.isolation_mode() == "none"


def test_soffice_bin_resout_le_lien(tmp_path, monkeypatch):
    real = tmp_path / "program" / "soffice"
    real.parent.mkdir()
    real.write_text("#!/bin/sh\n")
    real.chmod(0o755)
    link = tmp_path / "soffice-link"
    os.symlink(real, link)
    monkeypatch.setenv("APP_SOFFICE_BIN", str(link))
    assert oc.soffice_bin() == str(real)
    monkeypatch.setenv("APP_SOFFICE_BIN", str(tmp_path / "absent"))
    assert oc.soffice_bin() == ""
    assert oc.lo_version_token("") == "none"
    assert len(oc.lo_version_token(str(real))) == 16


def test_verrou_exclusif_meme_process_et_liberation():
    a = oc.try_lock("slot-0")
    assert a is not None
    try:
        assert oc.try_lock("slot-0") is None           # un 2e fd du même process est refusé
        assert oc.try_lock("slot-1") is not None
    finally:
        oc.release_lock(a)
    b = oc.try_lock("slot-0")
    assert b is not None
    oc.release_lock(b)
    assert oc.try_lock("../evasion") is None and oc.try_lock("A B") is None


def test_acquire_first_prend_le_creneau_libre_puis_occupe():
    held = oc.try_lock("slot-0")

    async def go():
        fd, name = await oc.acquire_first(["slot-0", "slot-1"], time.monotonic() + 1)
        assert name == "slot-1"
        try:
            t0 = time.monotonic()
            with pytest.raises(OfficeError) as e:
                await oc.acquire_first(["slot-0", "slot-1"], time.monotonic() + 0.4)
            assert e.value.code == "busy" and e.value.status == 503
            assert time.monotonic() - t0 >= 0.3
        finally:
            oc.release_lock(fd)
    try:
        asyncio.run(go())
    finally:
        oc.release_lock(held)


def test_prune_lock_files_ne_touche_pas_un_verrou_tenu():
    held = oc.try_lock("key-" + "a" * 40)
    free = oc.try_lock("key-" + "b" * 40)
    oc.release_lock(free)
    old = time.time() - 3 * 86400
    for name in ("key-" + "a" * 40, "key-" + "b" * 40):
        os.utime(oc.LOCK_DIR / f"{name}.lock", (old, old))
    try:
        assert oc.prune_lock_files() == 1
        assert (oc.LOCK_DIR / ("key-" + "a" * 40 + ".lock")).exists()
        assert not (oc.LOCK_DIR / ("key-" + "b" * 40 + ".lock")).exists()
    finally:
        oc.release_lock(held)


def test_profil_seme_puis_verrou_residuel_retire(tmp_path):
    prof = tmp_path / "profiles" / "slot-0"
    oc.ensure_profile(prof)
    xcu = (prof / "user" / "registrymodifications.xcu").read_text()
    assert "MacroSecurityLevel" in xcu and "DisableMacrosExecution" in xcu
    (prof / ".lock").write_text("x")
    (prof / "user" / "garde.txt").write_text("conservé")
    oc.ensure_profile(prof)
    assert not (prof / ".lock").exists()
    assert (prof / "user" / "garde.txt").exists()          # profil chaud réutilisé


def _alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split()[2] != "Z"
    except OSError:
        return False


def test_delai_depasse_tue_tout_le_groupe(tmp_path):
    """Le « soffice » factice lance un enfant qui dort : les deux doivent mourir."""
    pidfile = tmp_path / "child.pid"
    script = tmp_path / "faux-soffice.sh"
    script.write_text(f"#!/bin/sh\nsleep 60 &\necho $! > {pidfile}\nsleep 60\n")
    script.chmod(0o755)
    job = tmp_path / "job"
    job.mkdir()

    async def go():
        with pytest.raises(OfficeError) as e:
            await oc.run_soffice([str(script)], {"PATH": "/usr/bin:/bin"}, cwd=job,
                                 log_path=job / "lo.log", timeout_s=1.0)
        return e.value
    t0 = time.monotonic()
    err = asyncio.run(go())
    assert err.code == "timeout" and err.status == 504
    assert time.monotonic() - t0 < 10
    child = int(pidfile.read_text())
    for _ in range(50):
        if not _alive(child):
            break
        time.sleep(0.05)
    assert not _alive(child), "l'enfant de soffice a survécu au délai"


def test_run_soffice_rend_le_code_et_journalise(tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    script = tmp_path / "ok.sh"
    script.write_text("#!/bin/sh\necho 'Writing sheet A -> /job/out/in-A.csv'\nexit 0\n")
    script.chmod(0o755)
    rc = asyncio.run(oc.run_soffice([str(script)], {"PATH": "/usr/bin:/bin"}, cwd=job,
                                    log_path=job / "lo.log", timeout_s=5))
    assert rc == 0 and "Writing sheet A" in (job / "lo.log").read_text()


def test_count_pdf_pages_coupures_de_bloc(tmp_path):
    body = b"%PDF-1.7\n" + b"".join(
        b"%d 0 obj<</Type/Page/Parent 2 0 R>>endobj\n" % i for i in range(7))
    body += b"2 0 obj<</Type /Pages/Kids[]/Count 7>>endobj\n%%EOF"
    p = tmp_path / "a.pdf"
    p.write_bytes(body)
    for bs in (7, 13, 33, 64, 1 << 20):
        assert oc.count_pdf_pages(p, block_size=bs) == 7, bs
    assert oc.count_pdf_pages(tmp_path / "absent.pdf") == 0
