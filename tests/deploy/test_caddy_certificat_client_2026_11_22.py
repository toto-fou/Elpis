# SPDX-License-Identifier: MIT
"""tests/deploy/test_caddy_certificat_client_2026_11_22.py — bloc 2.c, install_caddy.sh avec le certificat de la PKI du client (--cert fullchain, --key) : fullchain servi tel quel, droits 0640, refus sans rien remplacer (certificat expiré, clé qui ne correspond pas), relance sans option, CA locale retirée, options de install.sh."""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "caddy" / "install_caddy.sh"


def _ok(*cmd: str) -> bool:
    return shutil.which(cmd[0]) is not None and subprocess.run(cmd, capture_output=True).returncode == 0


AVEC_ESPACE = (
    _ok("openssl", "version")
    and _ok("caddy", "version")
    and Path("/etc/caddy").is_dir()
    and _ok("unshare", "-rm", "sh", "-c", "mount --bind /etc/caddy /etc/caddy")
)
pytestmark = pytest.mark.skipif(not AVEC_ESPACE, reason="unshare, openssl, caddy ou /etc/caddy absents")


def _openssl(*args: str, cwd: Path) -> None:
    subprocess.run(["openssl", *args], cwd=cwd, check=True, capture_output=True)


def _cle(d: Path, nom: str) -> None:
    _openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f"{nom}.key", cwd=d)


def _ca(d: Path, nom: str) -> None:
    _cle(d, nom)
    _openssl("req", "-x509", "-new", "-key", f"{nom}.key", "-out", f"{nom}.crt", "-days", "30", "-subj", f"/CN={nom}",
             "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign", cwd=d)


def _feuille(d: Path, nom: str, ca: str, *extra: str) -> None:
    """Certificat serveur signé par `ca` ; `extra` : options de `openssl x509 -req` (dates)."""
    _cle(d, nom)
    _openssl("req", "-new", "-key", f"{nom}.key", "-out", f"{nom}.csr", "-subj", "/CN=elpis.test", cwd=d)
    (d / f"{nom}.ext").write_text("subjectAltName=DNS:elpis.test\nextendedKeyUsage=serverAuth\n")
    _openssl("x509", "-req", "-in", f"{nom}.csr", "-CA", f"{ca}.crt", "-CAkey", f"{ca}.key", "-CAcreateserial",
             "-days", "30", "-out", f"{nom}.crt", "-extfile", f"{nom}.ext", *extra, cwd=d)


def _expire(d: Path, nom: str, ca: str) -> None:
    """Certificat échu depuis longtemps, émis par `openssl ca` (dates imposées)."""
    _cle(d, nom)
    _openssl("req", "-new", "-key", f"{nom}.key", "-out", f"{nom}.csr", "-subj", "/CN=elpis.test", cwd=d)
    (d / "ca.cnf").write_text(
        f"[ca]\ndefault_ca=c\n[c]\ndatabase={d}/index\nnew_certs_dir={d}\nserial={d}/serial\n"
        f"default_md=sha256\npolicy=p\n[p]\ncommonName=supplied\n"
    )
    (d / "index").write_text("")
    (d / "serial").write_text("01\n")
    _openssl("ca", "-batch", "-config", "ca.cnf", "-cert", f"{ca}.crt", "-keyfile", f"{ca}.key", "-in", f"{nom}.csr",
             "-out", f"{nom}.crt", "-notext", "-startdate", "20200101000000Z", "-enddate", "20200102000000Z", cwd=d)


@pytest.fixture
def pki(tmp_path: Path) -> Path:
    d = tmp_path / "pki"
    d.mkdir()
    _ca(d, "racine")
    _feuille(d, "serveur", "racine")
    _ca(d, "autre")
    _cle(d, "inconnue")
    _expire(d, "echu", "racine")
    return d


@pytest.fixture
def etc(tmp_path: Path) -> Path:
    """/etc/caddy simulé, avec systemctl et hostname factices."""
    e = tmp_path / "etc-caddy"
    e.mkdir()
    outils = tmp_path / "outils"
    outils.mkdir()
    (outils / "systemctl").write_text('#!/bin/sh\necho "$*" >> "$JOURNAL_SYSTEMCTL"\n')
    (outils / "hostname").write_text('#!/bin/sh\n[ "$1" = "-I" ] && echo "192.0.2.10 " || echo "poste"\n')
    for f in outils.iterdir():
        f.chmod(0o755)
    return e


def _lancer(etc: Path, *args: Path | str, script: Path = SCRIPT) -> subprocess.CompletedProcess[str]:
    outils = etc.parent / "outils"
    return subprocess.run(
        ["unshare", "-rm", "sh", "-c", 'mount --bind "$0" /etc/caddy && exec bash "$@"', str(etc), str(script), *map(str, args)],
        capture_output=True, text=True,
        env={"PATH": f"{outils}:{os.environ['PATH']}", "HOME": str(etc), "XDG_DATA_HOME": str(etc / ".d"),
             "XDG_CONFIG_HOME": str(etc / ".c"), "JOURNAL_SYSTEMCTL": str(etc.parent / "systemctl.log")},
    )


def _etat(etc: Path) -> tuple[dict[str, bytes], str]:
    """Octets de tous les fichiers de /etc/caddy simulé, et journal de systemctl."""
    journal = etc.parent / "systemctl.log"
    return ({str(f): f.read_bytes() for f in sorted(etc.rglob("*")) if f.is_file()},
            journal.read_text() if journal.exists() else "")





def _fullchain(d: Path) -> None:
    """Fullchain du serveur : feuille puis intermédiaire (ici la racine de l'essai)."""
    (d / "fullchain.pem").write_text((d / "serveur.crt").read_text() + (d / "racine.crt").read_text())


def test_fullchain_servi_tel_quel_en_0640(pki: Path, etc: Path) -> None:
    _fullchain(pki)
    r = _lancer(etc, "--cert", pki / "fullchain.pem", "--key", pki / "serveur.key")
    assert r.returncode == 0, r.stdout + r.stderr
    p = etc / "elpis-pki"
    assert (p / "fullchain.pem").read_text() == (pki / "fullchain.pem").read_text()
    assert (p / "server.key").read_text() == (pki / "serveur.key").read_text()
    assert [stat.S_IMODE((p / n).stat().st_mode) for n in ("fullchain.pem", "server.key")] == [0o640, 0o640]
    assert (etc.parent / "systemctl.log").read_text() == "enable caddy\nrestart caddy\n"
    assert not any(f.stat().st_mode & 0o004 for f in p.iterdir() if f.is_file() and f.name != "client-pki")


def test_fichier_cert_et_cle_combines_jamais_lisible_de_tous(pki: Path, etc: Path) -> None:
    (pki / "combine.pem").write_text((pki / "serveur.crt").read_text() + (pki / "serveur.key").read_text())
    r = _lancer(etc, "--cert", pki / "combine.pem", "--key", pki / "serveur.key")
    assert r.returncode == 0, r.stdout + r.stderr
    assert stat.S_IMODE((etc / "elpis-pki" / "fullchain.pem").stat().st_mode) == 0o640


def test_certificat_expire_refuse(pki: Path, etc: Path) -> None:
    r = _lancer(etc, "--cert", pki / "echu.crt", "--key", pki / "echu.key")
    assert r.returncode != 0 and "expiré" in r.stderr
    assert not (etc / "elpis-pki").exists()


def test_cle_qui_ne_correspond_pas_refusee_par_caddy(pki: Path, etc: Path) -> None:
    r = _lancer(etc, "--cert", pki / "serveur.crt", "--key", pki / "inconnue.key")
    assert r.returncode != 0 and "Caddy refuse" in r.stderr
    assert not (etc / "elpis-pki" / "server.key").exists()


def test_refus_sur_installation_existante_ne_change_rien(pki: Path, etc: Path) -> None:
    assert _lancer(etc, "--cert", pki / "serveur.crt", "--key", pki / "serveur.key").returncode == 0
    avant = _etat(etc)
    for args in (("--cert", pki / "serveur.crt", "--key", pki / "inconnue.key"),
                 ("--cert", pki / "echu.crt", "--key", pki / "echu.key"),
                 ("--cert", pki / "absent.crt", "--key", pki / "serveur.key")):
        assert _lancer(etc, *args).returncode != 0
    assert _etat(etc) == avant


def test_relance_sans_option_garde_le_certificat_et_signale_les_sans_ignores(pki: Path, etc: Path) -> None:
    _lancer(etc, "--cert", pki / "serveur.crt", "--key", pki / "serveur.key")
    avant = _etat(etc)[0]
    r = _lancer(etc, "10.0.0.9")
    assert r.returncode == 0 and "SANs ignorés" in r.stdout
    assert {k: v for k, v in _etat(etc)[0].items() if "Caddyfile.bak" not in k} == {k: v for k, v in avant.items() if "Caddyfile.bak" not in k}


def test_ca_locale_retiree_apres_le_redemarrage(pki: Path, etc: Path) -> None:
    assert _lancer(etc).returncode == 0 and (etc / "elpis-pki" / "ca.key").exists()
    r = _lancer(etc, "--cert", pki / "serveur.crt", "--key", pki / "serveur.key")
    assert r.returncode == 0 and "CA locale retirée" in r.stdout
    assert not any((etc / "elpis-pki" / n).exists() for n in ("ca.crt", "ca.key", "ca.srl"))
    assert not (etc / "elpis-pki" / "server.crt").exists()
    (etc / "elpis-pki" / "ca.crt").write_text("reste")
    assert _lancer(etc).returncode == 0
    assert not (etc / "elpis-pki" / "ca.crt").exists()


def test_ancien_certificat_serveur_local_retire_avec_la_ca(pki: Path, etc: Path) -> None:
    assert _lancer(etc).returncode == 0 and (etc / "elpis-pki" / "server.crt").exists()
    assert _lancer(etc, "--cert", pki / "serveur.crt", "--key", pki / "serveur.key").returncode == 0
    assert not (etc / "elpis-pki" / "server.crt").exists()


def test_marque_deposee_comme_lien_remplacee_sans_suivre_le_lien(pki: Path, etc: Path, tmp_path: Path) -> None:
    cible = tmp_path / "cible"
    cible.write_text("intacte")
    (etc / "elpis-pki").mkdir()
    (etc / "elpis-pki" / "client-pki").symlink_to(cible)
    r = _lancer(etc, "--cert", pki / "serveur.crt", "--key", pki / "serveur.key")
    assert r.returncode == 0, r.stdout + r.stderr
    marque = etc / "elpis-pki" / "client-pki"
    assert not marque.is_symlink() and marque.read_text() == "" and cible.read_text() == "intacte"


def test_caddyfile_invalide_valide_avant_de_remplacer_le_vivant(etc: Path, tmp_path: Path) -> None:
    dossier = tmp_path / "copie"
    shutil.copytree(SCRIPT.parent, dossier, ignore=shutil.ignore_patterns("debs"))
    (dossier / "Caddyfile.template").write_text("{\n  directive_inconnue\n}\n")
    (etc / "Caddyfile").write_text("vivant\n")
    r = _lancer(etc, script=dossier / "install_caddy.sh")
    assert r.returncode != 0
    assert (etc / "Caddyfile").read_text() == "vivant\n"
    assert not (etc.parent / "systemctl.log").exists()


def test_installation_locale_inchangee_sans_option(etc: Path) -> None:
    r = _lancer(etc)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (etc / "elpis-pki" / "ca.crt").exists() and not (etc / "elpis-pki" / "client-pki").exists()


def test_options_incompletes_a_l_installateur_principal(pki: Path, tmp_path: Path) -> None:
    racine = Path(__file__).resolve().parents[2]
    for args in (["--caddy-key", str(pki / "serveur.key")], ["--caddy-cert", str(pki / "serveur.crt")], ["--caddy-cert"],
                 ["--caddy-cert", "absent.pem", "--caddy-key", str(pki / "serveur.key")]):
        r = subprocess.run(["bash", str(racine / "install.sh"), "--dry-run", *args], capture_output=True, text=True, cwd=tmp_path)
        assert r.returncode == 2, (args, r.stdout + r.stderr)
