# SPDX-License-Identifier: MIT
"""Sauvegarde distante par rsync (2026-09-21, revu le même jour) : rsync
au-dessus de SSH, authentifié par MOT DE PASSE (adresse, port 22 par défaut,
utilisateur, dossier cible), + planification « toutes les N heures/jours ».

Le mot de passe passe par ``SSH_ASKPASS_REQUIRE=force`` (pas de sshpass sur la
VM). Deux vérifications de bout en bout :
  • un ``ssh`` DE TEST en tête du PATH contrôle l'environnement askpass, lit le
    mot de passe par le script askpass, puis exécute la commande distante en
    local — c'est un VRAI transfert rsync, seul le réseau est simulé ;
  • le VRAI ``sshd`` local (non root) : un mot de passe refusé échoue vite, avec
    un message lisible, sans invite bloquante.
"""
from __future__ import annotations

import os
import shutil
import socket
import stat
import subprocess
import time

import pytest

from shared_infra.ops import backup_remote as br


def _cfg(**over):
    c = br.normalize_remote_config({
        "enabled": True, "connector": "rsync", "host": "10.168.1.20",
        "user": "backup", "remote_path": "/srv/sauvegardes",
    })
    c.update(over)
    return c


@pytest.fixture
def pwd_path(tmp_path, monkeypatch):
    p = tmp_path / ".backup_rsync_password"
    monkeypatch.setattr(br, "RSYNC_PASSWORD_PATH", str(p))
    monkeypatch.setattr(br, "SEND_LOCK_PATH", str(tmp_path / ".backup_send.lock"))
    return p


# ── Configuration ────────────────────────────────────────────────────────────

def test_port_ssh_par_defaut_et_planification_par_defaut():
    c = _cfg()
    assert c["port"] == 22
    assert c["schedule_enabled"] is False and c["schedule_every"] == 1 and c["schedule_unit"] == "days"
    assert "rsync_module" not in c and "rsync_transport" not in c


def test_validation():
    assert br.validate_remote_config(_cfg()) == (True, "")
    for champ in ("host", "user", "remote_path"):
        assert not br.validate_remote_config(_cfg(**{champ: ""}))[0]


@pytest.mark.parametrize("champ,valeur", [
    ("host", "-oProxyCommand"), ("user", "-e"), ("host", "h;id"),
    ("remote_path", "/srv b"), ("remote_path", "/srv;rm"),
])
def test_validation_refuse_options_et_metacaracteres(champ, valeur):
    assert not br.validate_remote_config(_cfg(**{champ: valeur}))[0]


def test_argv_mot_de_passe_hors_argv(pwd_path):
    br.store_rsync_password("s3cret")
    argv = br.build_rsync_send_argv(_cfg(port=2222), "/tmp/b.zip", "backup_full_1.zip")
    e = argv[argv.index("-e") + 1]
    assert e.startswith("ssh -p 2222 ")
    assert "PubkeyAuthentication=no" in e and "NumberOfPasswordPrompts=1" in e
    assert "s3cret" not in " ".join(argv)
    assert "--partial" not in argv
    assert argv[argv.index("--") + 1:] == ["/tmp/b.zip",
                                           "backup@10.168.1.20:/srv/sauvegardes/backup_full_1.zip"]


def test_mot_de_passe_0600_retrait_et_saut_de_ligne(pwd_path):
    assert br.store_rsync_password("abc") is True
    assert stat.S_IMODE(os.stat(pwd_path).st_mode) == 0o600
    with pytest.raises(ValueError):
        br.store_rsync_password("a\nb")
    assert br.store_rsync_password("") is False and not pwd_path.exists()


# ── Planification ────────────────────────────────────────────────────────────

def test_prochain_envoi():
    base = {"enabled": True, "schedule_enabled": True, "schedule_every": 6, "schedule_unit": "hours"}
    assert br.next_run_at({**base, "schedule_enabled": False}) is None
    assert br.next_run_at({**base, "enabled": False}) is None
    assert br.next_run_at({**base, "last_send": {}}, now=500) == 500               # jamais : tout de suite
    assert br.next_run_at({**base, "last_send": {"at": 1000, "ok": True}}) == 1000 + 6 * 3600
    # Échec : nouvelle tentative au plus tard 1 h après.
    assert br.next_run_at({**base, "last_send": {"at": 1000, "ok": False}}) == 1000 + 3600
    jours = {**base, "schedule_every": 2, "schedule_unit": "days"}
    assert br.next_run_at({**jours, "last_send": {"at": 0 + 10, "ok": True}}) == 10 + 2 * 86400


async def test_boucle_envoie_seulement_a_l_echeance(monkeypatch):
    from shared_infra.ops import backup_scheduler as bs
    etat = {"cfg": _cfg(schedule_enabled=True, schedule_every=1, schedule_unit="hours",
                        last_send={"at": time.time(), "ok": True})}
    monkeypatch.setattr(br, "get_remote_config", lambda: etat["cfg"])
    envois = []

    async def _send(scope=None, *, trigger="manual"):
        envois.append(trigger)
        return {"ok": True, "filename": "f.zip"}
    monkeypatch.setattr(br, "run_send", _send)
    assert await bs.run_if_due() is False and envois == []
    etat["cfg"]["last_send"] = {"at": time.time() - 3700, "ok": True}
    assert await bs.run_if_due() is True and envois == ["schedule"]
    etat["cfg"]["schedule_enabled"] = False
    assert await bs.run_if_due() is False and envois == ["schedule"]


async def test_un_envoi_a_la_fois(pwd_path, monkeypatch):
    lock = br._SendLock()
    lock.__enter__()
    try:
        assert (await br.run_send())["error"] == "Un envoi est déjà en cours."
    finally:
        lock.__exit__(None, None, None)


# ── Bout en bout ─────────────────────────────────────────────────────────────

_FAUX_SSH = """#!/bin/sh
# ssh de TEST : exige l'environnement askpass, lit le mot de passe comme le
# ferait OpenSSH, puis exécute la commande distante EN LOCAL.
[ "$SSH_ASKPASS_REQUIRE" = force ] || { echo "askpass non forcé" >&2; exit 90; }
pwd=$("$SSH_ASKPASS" "backup@hote's password: ")
[ "$pwd" = "$ATTENDU" ] || { echo "Permission denied (password)." >&2; exit 255; }
# rsync appelle « ssh [options] -l utilisateur hôte commande… » : on saute
# les options, puis l'hôte, et on exécute la commande.
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-l) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
exec sh -c "$*"
"""


@pytest.fixture
def faux_ssh(tmp_path, monkeypatch):
    if not shutil.which("rsync"):
        pytest.skip("rsync absent")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "ssh").write_text(_FAUX_SSH)
    os.chmod(bindir / "ssh", 0o755)
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")
    monkeypatch.setenv("ATTENDU", "bon-mot-de-passe")
    return bindir


async def test_envoi_reel_rsync_par_mot_de_passe(tmp_path, monkeypatch, pwd_path, faux_ssh):
    dest = tmp_path / "depot"
    dest.mkdir()
    cfg = _cfg(host="hote", remote_path=str(dest), timeout_sec=30,
               known_hosts=str(tmp_path / "kh"))
    monkeypatch.setattr(br, "get_remote_config", lambda: cfg)
    monkeypatch.setattr(br, "_record_last_send", lambda *a, **k: None)
    import tempfile
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))  # script askpass observable
    src = tmp_path / "src.zip"
    src.write_bytes(b"PK\x03\x04archive")
    import shared_infra.routes._legacy as legacy
    monkeypatch.setattr(legacy, "_make_backup_zip", lambda scope: (str(src), "backup_full_1.zip"))

    assert (await br.run_test(cfg))["error"].startswith("Mot de passe absent")
    br.store_rsync_password("mauvais")
    res = await br.run_test(cfg)
    assert res == {"ok": False, "error": "Identifiants refusés (utilisateur ou mot de passe)."}
    br.store_rsync_password("bon-mot-de-passe")
    assert (await br.run_test(cfg)) == {"ok": True, "error": ""}
    res = await br.run_send("full")
    assert res["ok"] is True and res["filename"] == "backup_full_1.zip"
    assert (dest / "backup_full_1.zip").read_bytes() == b"PK\x03\x04archive"
    assert not src.exists()
    assert not list(tmp_path.glob("elpis_askpass_*"))        # script askpass supprimé


def _port_libre():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def test_vrai_sshd_mot_de_passe_refuse_sans_blocage(tmp_path, pwd_path):
    """Le vrai OpenSSH : l'askpass est bien consulté (pas d'invite sur un
    terminal) et un refus revient vite, traduit."""
    sshd = "/usr/sbin/sshd"
    if not (os.path.exists(sshd) and shutil.which("ssh-keygen") and shutil.which("rsync")):
        pytest.skip("sshd absent")
    hk = tmp_path / "hostkey"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(hk)], check=True)
    port = _port_libre()
    conf = tmp_path / "sshd_config"
    conf.write_text(f"Port {port}\nListenAddress 127.0.0.1\nHostKey {hk}\nUsePAM no\n"
                    f"PasswordAuthentication yes\nKbdInteractiveAuthentication no\n"
                    f"PubkeyAuthentication no\nPidFile {tmp_path / 'sshd.pid'}\n"
                    f"StrictModes no\n")
    proc = subprocess.Popen([sshd, "-D", "-f", str(conf), "-E", str(tmp_path / "sshd.log")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                if proc.poll() is not None:
                    pytest.skip("sshd non démarrable ici")
                time.sleep(0.1)
        br.store_rsync_password("pas-le-bon")
        cfg = _cfg(host="127.0.0.1", port=port, user=os.environ.get("USER", "mcp"),
                   remote_path=str(tmp_path), known_hosts=str(tmp_path / "kh"))
        t0 = time.monotonic()
        res = await br.run_test(cfg)
        assert res["ok"] is False
        assert res["error"] == "Identifiants refusés (utilisateur ou mot de passe)."
        assert time.monotonic() - t0 < 30
    finally:
        proc.terminate()
        proc.wait(timeout=5)
