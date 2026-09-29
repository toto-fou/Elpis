# SPDX-License-Identifier: MIT
"""Audit éditeur 2026-09-23 — disque, préconditions, écritures concurrentes.

TestClient sur le VRAI routeur ; les écritures passent par les VRAIS scripts
shell de ``exec_bridge`` (le conteneur est remplacé par ``sh`` lancé dans la
racine de travail), donc le lien symbolique, le dossier homonyme et
l'écrasement à la promotion d'un import sont vérifiés sur le script réel.

Couvre : E4, E5, E6, E7 (contrat), E17, E25, E26, E27, E28, E29, E30, et
l'historique de session (écritures + routes de lecture).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.sandbox.exec_bridge as xb
import shared_infra.sandbox.file_history as H
import shared_infra.sandbox.routes_files as sf
from shared_infra.routes._helpers import reset_sandbox_usage_cache
from shared_infra.sandbox.executors._base import ExecResult
from shared_infra.sandbox.executors._user_sandbox import SandboxStatus

pytestmark = pytest.mark.skipif(shutil.which("sh") is None, reason="requires POSIX sh")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class _LocalSB:
    """« Conteneur » local : ``sh`` lancé dans la racine de travail."""

    def __init__(self, root, env=None):
        self.root = root
        self.env = env
        self.cmds = []

    async def ensure_running(self):
        return SandboxStatus(exists=True, running=True, container_name="local")

    async def exec(self, cmd, stdin_bytes=None, timeout_s=60, **_kw):
        self.cmds.append(cmd)
        p = subprocess.run(cmd, cwd=self.root, input=stdin_bytes or b"",
                           capture_output=True, timeout=timeout_s, env=self.env)
        return ExecResult(returncode=p.returncode, stdout=p.stdout, stderr=p.stderr,
                          duration_s=0.0)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "work"
    root.mkdir()
    monkeypatch.setenv("APP_FILE_HISTORY_DIR", str(tmp_path / "hist"))
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path / "sbx"))
    # Session ouverte comme au login : sans elle, le premier ``record_write``
    # ré-entre dans le flock du compte (``current_session`` → ``start_session``)
    # et attend le délai de 5 s (fail-open) — défaut signalé à part.
    H.start_session(1)
    H.start_session(2)
    sb = _LocalSB(root)
    monkeypatch.setattr(xb, "_get_sandbox_for_user", lambda uid: sb)
    monkeypatch.setattr(xb, "_CONTAINER_ROOT", str(root))
    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    monkeypatch.setattr(sf, "get_user_settings", lambda uid: {"sandbox_quota_mb": 0})
    monkeypatch.setattr(sf, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(sf, "log_metric", lambda *a, **k: None)
    reset_sandbox_usage_cache()
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    yield TestClient(app), root, sb
    reset_sandbox_usage_cache()


def _save(client, **body):
    return client.post("/api/sandbox/save", json=body)


# ── /download : X-Sha256 / X-Size / X-Mtime décrivent les octets servis ─────

def test_download_expose_sha_taille_mtime(env):
    client, root, _ = env
    f = root / "a.txt"
    f.write_bytes(b"bonjour\r\n")
    r = client.get("/api/sandbox/download", params={"path": "a.txt"})
    assert r.status_code == 200
    assert r.content == b"bonjour\r\n"
    assert r.headers["X-Sha256"] == _sha(b"bonjour\r\n")
    assert r.headers["X-Size"] == "9"
    assert float(r.headers["X-Mtime"]) == f.stat().st_mtime
    assert "X-Sha256" in r.headers["Access-Control-Expose-Headers"]
    assert "attachment" in r.headers["content-disposition"]


def test_download_range_reste_servi_en_flux(env):
    client, root, _ = env
    (root / "b.bin").write_bytes(bytes(range(256)) * 40)
    r = client.get("/api/sandbox/download", params={"path": "b.bin"},
                   headers={"Range": "bytes=0-15"})
    assert r.status_code == 206
    assert r.content == bytes(range(16))
    assert "X-Sha256" not in r.headers


# ── /save : précondition par hash (E6) ──────────────────────────────────────

def test_save_sha_a_jour_passe_et_rend_sha_et_mtime(env):
    client, root, _ = env
    f = root / "a.py"
    f.write_text("v1")
    sha = client.get("/api/sandbox/download", params={"path": "a.py"}).headers["X-Sha256"]
    r = _save(client, path="a.py", content="v2", expected_sha256=sha)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["sha256"] == _sha(b"v2") and d["mtime"] == f.stat().st_mtime
    # Enregistrement suivant fondé sur le sha RENDU.
    r2 = _save(client, path="a.py", content="v3", expected_sha256=d["sha256"])
    assert r2.status_code == 200, r2.text
    assert f.read_text() == "v3"


def test_save_sha_perime_412_avec_etat_disque(env):
    client, root, _ = env
    f = root / "a.py"
    f.write_text("modifié ailleurs")
    r = _save(client, path="a.py", content="mon buffer", expected_sha256=_sha(b"v1"))
    assert r.status_code == 412
    d = r.json()["detail"]
    assert d["code"] == "conflict" and d["missing"] is False
    assert d["sha256"] == _sha("modifié ailleurs".encode())
    assert d["mtime"] == f.stat().st_mtime
    assert f.read_text() == "modifié ailleurs"


def test_save_sha_cp_p_meme_mtime_contenu_different_412(env):
    """``cp -p`` / ``touch -r`` : même mtime, autre contenu → refus (le mtime
    seul laissait passer, audit : « Reproduit : 200 »)."""
    client, root, _ = env
    f = root / "a.py"
    f.write_text("AAAA")
    st = f.stat()
    base_sha = _sha(b"AAAA")
    f.write_text("BBBB")
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert f.stat().st_mtime == st.st_mtime
    r = _save(client, path="a.py", content="mien", expected_sha256=base_sha,
              expected_mtime=st.st_mtime)
    assert r.status_code == 412
    assert f.read_text() == "BBBB"


def test_save_sha_fichier_disparu_412_missing(env):
    client, root, _ = env
    r = _save(client, path="parti.py", content="x", expected_sha256=_sha(b"x"))
    assert r.status_code == 412
    d = r.json()["detail"]
    assert d["missing"] is True and d["sha256"] is None and d["mtime"] is None


def test_save_sha_invalide_400(env):
    client, root, _ = env
    (root / "a.py").write_text("v1")
    r = _save(client, path="a.py", content="v2", expected_sha256="pas-un-hash")
    assert r.status_code == 400
    assert (root / "a.py").read_text() == "v1"


def test_save_mtime_seul_reste_supporte(env):
    client, root, _ = env
    f = root / "a.py"
    f.write_text("v1")
    r = _save(client, path="a.py", content="v2", expected_mtime=f.stat().st_mtime)
    assert r.status_code == 200, r.text


# ── /save : E25, E26, E27 ───────────────────────────────────────────────────

@pytest.mark.parametrize("precond", [False, True])
def test_save_vers_un_dossier_409_is_dir(env, precond):
    client, root, _ = env
    (root / "d").mkdir()
    body = {"path": "d", "content": "x"}
    if precond:
        body["expected_mtime"] = (root / "d").stat().st_mtime
    r = _save(client, **body)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "is_dir"
    assert list((root / "d").iterdir()) == []


def test_save_script_refuse_un_dossier_meme_sans_la_garde_de_route(env):
    """Re-vérification DANS le conteneur (``exit 21``) : un dossier créé
    entre la garde de route et le ``mv`` n'avale pas le fichier."""
    import asyncio

    from fastapi import HTTPException
    client, root, _ = env
    (root / "d").mkdir()
    with pytest.raises(HTTPException) as ei:
        asyncio.run(xb.sandbox_write_text(1, "d", "x"))
    assert ei.value.status_code == 409
    assert list((root / "d").iterdir()) == []


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignore les droits")
def test_save_stat_refuse_ne_saute_plus_la_precondition(env):
    client, root, _ = env
    d = root / "prive"
    d.mkdir()
    (d / "a.py").write_text("v1")
    d.chmod(0o000)
    try:
        r = _save(client, path="prive/a.py", content="v2", expected_mtime=123.0)
        assert r.status_code == 412
        assert r.json()["detail"].get("unreadable") is True
    finally:
        d.chmod(0o755)
    assert (d / "a.py").read_text() == "v1"


def test_save_chemin_sous_un_fichier_409_not_dir(env):
    client, root, _ = env
    (root / "f").write_text("x")
    r = _save(client, path="f/a.py", content="v", expected_mtime=1.0)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "not_dir"


def test_save_surrogate_isole_400(env):
    client, root, _ = env
    r = client.post("/api/sandbox/save",
                    content='{"path": "a.txt", "content": "x\\ud800y"}',
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    assert "non encodable" in r.json()["detail"]
    assert not (root / "a.txt").exists()


# ── E17 : lien symbolique ───────────────────────────────────────────────────

def test_save_lien_symbolique_ecrit_la_cible_et_garde_le_lien(env):
    client, root, _ = env
    (root / "real.txt").write_text("v1")
    (root / "real.txt").chmod(0o755)
    os.symlink("real.txt", root / "link.txt")
    r = _save(client, path="link.txt", content="v2")
    assert r.status_code == 200, r.text
    assert (root / "link.txt").is_symlink()
    assert os.readlink(root / "link.txt") == "real.txt"
    assert (root / "real.txt").read_text() == "v2"
    assert (root / "real.txt").stat().st_mode & 0o777 == 0o755    # mode gardé
    assert sorted(p.name for p in root.iterdir()) == ["link.txt", "real.txt"]


def test_ecriture_lien_hors_racine_refusee_dans_le_script(env, tmp_path):
    import asyncio

    from fastapi import HTTPException
    client, root, _ = env
    dehors = tmp_path / "dehors.txt"
    dehors.write_text("intact")
    os.symlink(str(dehors), root / "fuite.txt")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(xb.sandbox_write_text(1, "fuite.txt", "pwn"))
    assert ei.value.status_code == 403
    assert dehors.read_text() == "intact"


# ── E29 : temporaire nettoyé ────────────────────────────────────────────────

def test_ecriture_echouee_ne_laisse_pas_de_temporaire(env, tmp_path, monkeypatch):
    import asyncio

    from fastapi import HTTPException
    client, root, sb = env
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "mv").write_text("#!/bin/sh\necho 'mv en panne' >&2\nexit 1\n")
    (fake / "mv").chmod(0o755)
    sb.env = dict(os.environ, PATH=f"{fake}:{os.environ.get('PATH', '')}")
    (root / "a.txt").write_text("v1")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(xb.sandbox_write_text(1, "a.txt", "v2"))
    assert ei.value.status_code == 500
    assert sorted(p.name for p in root.iterdir()) == ["a.txt"]
    assert (root / "a.txt").read_text() == "v1"


def test_script_de_nettoyage_retire_le_seul_temporaire_exact(env):
    client, root, _ = env
    (root / "a.txt.tmp.TOK").write_text("orphelin")
    (root / "a.txt.tmp.AUTRE").write_text("à garder")
    p = subprocess.run(["sh", "-c", xb._WRITE_CLEANUP_SCRIPT, "_", "a.txt", str(root), "TOK"],
                       cwd=root, capture_output=True)
    assert p.returncode == 0, p.stderr
    assert sorted(x.name for x in root.iterdir()) == ["a.txt.tmp.AUTRE"]


# ── /check-mtimes (E5, E6, E30) ─────────────────────────────────────────────

def _check(client, files):
    r = client.post("/api/sandbox/check-mtimes", json={"files": files})
    assert r.status_code == 200, r.text
    return r.json()


def test_check_ecriture_a_03s_signalee(env):
    client, root, _ = env
    f = root / "a.py"
    f.write_text("v1")
    base = f.stat().st_mtime
    os.utime(f, (base + 0.3, base + 0.3))
    d = _check(client, [{"path": "a.py", "mtime": base}])
    assert len(d["stale"]) == 1
    s = d["stale"][0]
    assert s["path"] == "a.py" and abs(s["new_mtime"] - (base + 0.3)) < 1e-6
    assert s["size"] == 2 and s["sha256"] == _sha(b"v1")
    assert d["truncated"] is False


def test_check_a_jour_rien(env):
    client, root, _ = env
    f = root / "a.py"
    f.write_text("v1")
    d = _check(client, [{"path": "a.py", "mtime": f.stat().st_mtime, "size": 2,
                         "sha256": _sha(b"v1")}])
    assert d["stale"] == []


def test_check_taille_differente_meme_mtime(env):
    client, root, _ = env
    f = root / "a.py"
    f.write_text("v1 plus long")
    d = _check(client, [{"path": "a.py", "mtime": f.stat().st_mtime, "size": 2}])
    assert [s["path"] for s in d["stale"]] == ["a.py"]


def test_check_sha_different_meme_mtime_meme_taille(env):
    client, root, _ = env
    f = root / "a.py"
    f.write_text("BB")
    d = _check(client, [{"path": "a.py", "mtime": f.stat().st_mtime, "size": 2,
                         "sha256": _sha(b"AA")}])
    assert d["stale"][0]["sha256"] == _sha(b"BB")


def test_check_dossier_absent_et_troncature(env):
    client, root, _ = env
    (root / "d").mkdir()
    files = [{"path": "d", "mtime": 1.0}, {"path": "parti", "mtime": 1.0}]
    files += [{"path": f"x{i}", "mtime": 1.0} for i in range(600)]
    d = _check(client, files)
    assert d["truncated"] is True
    by = {s["path"]: s for s in d["stale"]}
    assert by["d"] == {"path": "d", "not_file": True}
    assert by["parti"] == {"path": "parti", "missing": True}
    assert len(d["stale"]) == 500          # seules les 500 premières traitées


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignore les droits")
def test_check_illisible_signale(env):
    client, root, _ = env
    d = root / "prive"
    d.mkdir()
    (d / "a.py").write_text("x")
    d.chmod(0o000)
    try:
        out = _check(client, [{"path": "prive/a.py", "mtime": 1.0}])
    finally:
        d.chmod(0o755)
    assert out["stale"] == [{"path": "prive/a.py", "unreadable": True}]


# ── Import chunké par-dessus un fichier existant (E4) ───────────────────────

def test_import_chunke_ecrase_un_fichier_existant(env):
    client, root, _ = env
    (root / "gros.bin").write_bytes(b"ancien")
    parts = [b"A" * 10, b"B" * 7]
    total = sum(len(p) for p in parts)
    for i, p in enumerate(parts):
        r = client.post("/api/sandbox/upload-chunk",
                        params={"path": "gros.bin", "index": i, "total": 2,
                                "size": total, "upload_id": "u1"}, content=p)
        assert r.status_code == 200, r.text
    d = r.json()
    assert d["done"] is True
    assert (root / "gros.bin").read_bytes() == b"".join(parts)
    assert d["sha256"] == _sha(b"".join(parts))
    assert [p.name for p in root.iterdir()] == ["gros.bin"]      # pas de .part
    ent = H.file_entry(1, "gros.bin")
    assert ent["original"]["sha"] == _sha(b"ancien")
    assert ent["versions"][-1]["source"] == "upload"


def test_rename_sans_overwrite_refuse_toujours(env):
    import asyncio

    from fastapi import HTTPException
    client, root, _ = env
    (root / "a").write_text("a")
    (root / "b").write_text("b")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(xb.sandbox_rename(1, "a", "b"))
    assert ei.value.status_code == 409
    (root / "d").mkdir()
    with pytest.raises(HTTPException) as ei:
        asyncio.run(xb.sandbox_rename(1, "a", "d", overwrite=True))
    assert ei.value.status_code == 409
    assert (root / "a").read_text() == "a" and list((root / "d").iterdir()) == []


# ── /replace (E28) ──────────────────────────────────────────────────────────

def test_replace_dedoublonne_sur_le_chemin_canonique(env):
    client, root, _ = env
    (root / "a.py").write_text("foo\n")
    (root / "s").mkdir()
    (root / "s" / "b.py").write_text("foo\n")
    r = client.post("/api/sandbox/replace", json={
        "query": "foo", "replacement": "xfoo",
        "paths": ["a.py", "./a.py", "s/b.py", "s//b.py", "./s/./b.py"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert (root / "a.py").read_text() == "xfoo\n"
    assert (root / "s" / "b.py").read_text() == "xfoo\n"
    assert d["total"] == 2
    f = {x["path"]: x for x in d["files"]}
    assert f["a.py"]["sha256"] == _sha(b"xfoo\n")
    assert f["a.py"]["mtime"] == (root / "a.py").stat().st_mtime
    assert H.file_entry(1, "a.py")["versions"][-1]["source"] == "replace"


# ── Historique : écritures notées + routes de lecture ───────────────────────

def test_historique_save_rename_delete_copy_upload(env):
    client, root, _ = env
    (root / "a.py").write_text("v0")
    assert _save(client, path="a.py", content="v1").status_code == 200
    assert _save(client, path="a.py", content="v2", source="restore").status_code == 200
    e = H.file_entry(1, "a.py")
    assert e["original"]["sha"] == _sha(b"v0")
    assert [v["source"] for v in e["versions"]] == ["editor", "restore"]

    assert client.post("/api/sandbox/rename",
                       json={"old_path": "a.py", "new_path": "b.py"}).status_code == 200
    assert H.file_entry(1, "a.py") is None
    assert H.file_entry(1, "b.py")["moved_from"] == "a.py"

    assert client.post("/api/sandbox/copy", json={"src": "b.py", "dst": "c.py"}).status_code == 200
    c = H.file_entry(1, "c.py")
    assert c["original"]["exists"] is False and c["versions"][-1]["sha"] == _sha(b"v2")

    assert client.delete("/api/sandbox/delete", params={"path": "b.py"}).status_code == 200
    b = H.file_entry(1, "b.py")
    assert b["versions"][-1]["exists"] is False

    r = client.post("/api/sandbox/upload", files=[("files", ("u.txt", b"up"))],
                    data={"paths": "u.txt"})
    assert r.status_code == 200, r.text
    assert r.json()["sha256s"]["u.txt"] == _sha(b"up")
    u = H.file_entry(1, "u.txt")
    assert u["original"]["exists"] is False and u["versions"][-1]["source"] == "upload"


def test_routes_historique(env):
    client, root, _ = env
    (root / "a.py").write_text("v0")
    _save(client, path="a.py", content="v1")
    info = client.get("/api/sandbox/history").json()
    assert info["session"] and [f["path"] for f in info["files"]] == ["a.py"]

    assert client.get("/api/sandbox/history/file", params={"path": "zz.py"}).status_code == 404
    ent = client.get("/api/sandbox/history/file", params={"path": "work/a.py"}).json()
    assert ent["path"] == "a.py"
    assert ent["current"] == {"exists": True, "sha256": _sha(b"v1"), "size": 2,
                              "mtime": (root / "a.py").stat().st_mtime}

    r = client.get("/api/sandbox/history/blob", params={"sha": ent["original"]["sha"]})
    assert r.status_code == 200 and r.content == b"v0"
    assert r.headers["content-type"].startswith("text/plain")
    assert r.headers["cache-control"] == "private, max-age=86400"
    assert client.get("/api/sandbox/history/blob", params={"sha": "0" * 64}).status_code == 404
    assert client.get("/api/sandbox/history/blob", params={"sha": "../x"}).status_code == 404


def test_blob_binaire_octet_stream(env):
    client, root, _ = env
    H.record_write(1, "img.bin", None, b"\xff\xfe\x00", "upload")
    sha = H.file_entry(1, "img.bin")["versions"][-1]["sha"]
    r = client.get("/api/sandbox/history/blob", params={"sha": sha})
    assert r.headers["content-type"] == "application/octet-stream"


def test_historique_isole_par_compte(env, monkeypatch):
    client, root, _ = env
    H.record_write(2, "secret.py", None, b"autre compte", "editor")
    sha = H.file_entry(2, "secret.py")["versions"][-1]["sha"]
    # Le client est le compte 1.
    assert client.get("/api/sandbox/history/blob", params={"sha": sha}).status_code == 404
    assert client.get("/api/sandbox/history/file",
                      params={"path": "secret.py"}).status_code == 404


# ── E7 : le verrou du fichier est bien pris par /save ───────────────────────

def test_save_prend_le_verrou_du_fichier(env, monkeypatch):
    client, root, _ = env
    seen = []
    real = sf.file_write_lock

    def _spy(path, *a, **k):
        seen.append(str(path))
        return real(path, *a, **k)

    monkeypatch.setattr(sf, "file_write_lock", _spy)
    (root / "a.py").write_text("v1")
    assert _save(client, path="a.py", content="v2").status_code == 200
    assert seen == [str((root / "a.py").resolve())]
