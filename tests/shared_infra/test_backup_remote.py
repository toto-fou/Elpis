# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_backup_remote.py — envoi distant des sauvegardes.

Couvre les seams purs (normalisation, validation anti-injection, construction
d'argv sûre = BatchMode + clé + zéro shell) + le stockage 0600 de la clé + un
envoi « dossier monté » de bout en bout (copie réelle vers tmp).
"""
from __future__ import annotations

import os
import stat

import pytest

from shared_infra.ops import backup_remote as br


def _sftp_cfg(**over):
    base = br.normalize_remote_config({
        "connector": "sftp", "host": "10.168.1.20", "user": "backup",
        "remote_path": "/srv/backups/elpis", "port": 2222,
        "key_path": "/tmp/k", "known_hosts": "/tmp/kh",
    })
    base.update(over)
    return base


def test_normalize_defaults():
    c = br.normalize_remote_config({})
    assert c["connector"] == "sftp" and c["port"] == 22
    assert c["key_path"].endswith(".backup_ssh_key")
    assert c["last_send"]["ok"] is None


def test_validate_sftp_ok():
    ok, err = br.validate_remote_config(_sftp_cfg())
    assert ok and err == ""


@pytest.mark.parametrize("field,bad", [
    ("remote_path", "/srv; rm -rf /"),
    ("remote_path", "/srv $(reboot)"),
    ("host", "h && curl evil"),
    ("user", "u|sh"),
])
def test_validate_rejects_injection(field, bad):
    ok, _ = br.validate_remote_config(_sftp_cfg(**{field: bad}))
    assert not ok


def test_validate_bad_connector_and_scope():
    assert not br.validate_remote_config(_sftp_cfg(connector="ftp"))[0]
    assert not br.validate_remote_config(_sftp_cfg(scope="weird"))[0]


def test_validate_mounted():
    ok, _ = br.validate_remote_config(br.normalize_remote_config(
        {"connector": "mounted", "dest_path": "/mnt/nas/b"}))
    assert ok
    ok2, _ = br.validate_remote_config(br.normalize_remote_config(
        {"connector": "mounted", "dest_path": "/mnt/ nas"}))  # espace
    assert not ok2


def test_build_send_argv_safe():
    argv = br.build_send_argv(_sftp_cfg(), "/tmp/x.zip", "backup_full_1.zip")
    assert argv[0] == "scp"                       # pas de shell
    assert "BatchMode=yes" in argv
    assert "-i" in argv and "/tmp/k" in argv
    assert "-P" in argv and "2222" in argv
    assert argv[-1] == "backup@10.168.1.20:/srv/backups/elpis/backup_full_1.zip"


def test_build_test_argv_safe():
    argv = br.build_test_argv(_sftp_cfg())
    assert argv[0] == "ssh"
    assert argv[-2] == "backup@10.168.1.20"
    assert argv[-1] == "test -d /srv/backups/elpis && test -w /srv/backups/elpis"


def test_store_ssh_key_0600(tmp_path):
    kp = tmp_path / ".key"
    path = br.store_ssh_key("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n", str(kp))
    assert os.path.exists(path)
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600
    assert kp.read_text().endswith("\n")


def test_save_remote_config_preserves_last_send(monkeypatch):
    store = {"backup": {"remote": {"last_send": {"at": 123, "ok": True, "filename": "old.zip", "error": ""}}}}
    monkeypatch.setattr(br, "read_config_json", lambda: store)
    monkeypatch.setattr(br, "write_config_json", lambda full: store.update(full))
    saved = br.save_remote_config({"connector": "mounted", "dest_path": "/mnt/b", "enabled": True})
    assert saved["connector"] == "mounted" and saved["enabled"] is True
    # last_send préservé (l'UI ne l'envoie pas)
    assert store["backup"]["remote"]["last_send"]["filename"] == "old.zip"


async def test_run_send_mounted_copies_file(tmp_path, monkeypatch):
    dest = tmp_path / "nas"; dest.mkdir()
    src = tmp_path / "src.zip"; src.write_bytes(b"PK\x03\x04backup")
    cfg = br.normalize_remote_config(
        {"connector": "mounted", "dest_path": str(dest), "scope": "full"})
    monkeypatch.setattr(br, "get_remote_config", lambda: cfg)
    monkeypatch.setattr(br, "_record_last_send", lambda *a, **k: None)
    # _make_backup_zip est importé en différé depuis routes._legacy → on patche là.
    import shared_infra.routes._legacy as legacy
    monkeypatch.setattr(legacy, "_make_backup_zip", lambda scope: (str(src), "backup_full_1.zip"))

    res = await br.run_send("full")
    assert res["ok"] is True and res["filename"] == "backup_full_1.zip"
    assert (dest / "backup_full_1.zip").read_bytes() == b"PK\x03\x04backup"
    assert not src.exists()        # zip temporaire supprimé (try/finally)
    assert not (dest / "backup_full_1.zip.part").exists()  # dépôt atomique
