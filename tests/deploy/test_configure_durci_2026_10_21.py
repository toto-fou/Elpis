# SPDX-License-Identifier: MIT
"""tests/deploy/test_configure_durci_2026_10_21.py — ./elpis configure : domaine et e-mail ACME validés avant le Caddyfile, commandes sudo en argv ; ./elpis lit .env comme des données."""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def conf(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("elpis_configure_durci", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "USER_DB", tmp_path / "user_db")
    return mod


@pytest.mark.parametrize("valeur", ["elpis.example.com", "elpis", "192.0.2.20", "a-b.c1.example.org", "xn--bcher-kva.example",
                                    "bücher.example", "elpis.example.com."])
def test_domaines_valides(conf, valeur):
    assert conf.valid_domain(valeur) is None


@pytest.mark.parametrize("valeur", ["", "a b.example.com", "elpis.example.com\nreverse_proxy evil:80", "elpis{.example.com}",
                                    "-tiret.example.com", "evil.example.com/../x", "a..b", "::1", "x;y.example", "x" * 64 + ".fr",
                                    "https://elpis.example.com"])
def test_domaines_refuses(conf, valeur):
    assert conf.valid_domain(valeur)


@pytest.mark.parametrize("valeur", ["admin@example.com", "prenom.nom+elpis@sub.example.org"])
def test_emails_valides(conf, valeur):
    assert conf.valid_email(valeur) is None


@pytest.mark.parametrize("valeur", ["", "admin", "admin@example", "a b@example.com", "admin@example.com}\n\tfoo", "a@b@c.fr",
                                    "admin@exa mple.com"])
def test_emails_refuses(conf, valeur):
    assert conf.valid_email(valeur)


def _caddy_factice(monkeypatch, conf, tmp_path):
    appels: list = []
    monkeypatch.setattr(conf.shutil, "which", lambda nom: "/usr/bin/caddy")
    monkeypatch.setattr(conf, "sudo_prefix", lambda: ["sudo"])
    monkeypatch.setattr(conf.subprocess, "run", lambda cmd, *a, **k: appels.append(cmd) or subprocess.CompletedProcess(cmd, 0))
    (tmp_path / "deploy/caddy").mkdir(parents=True)
    shutil.copy2(REPO / "deploy/caddy/Caddyfile.acme.template", tmp_path / "deploy/caddy/Caddyfile.acme.template")
    return appels


def test_apply_https_refuse_un_domaine_ou_un_email_piege_sans_rien_ecrire(conf, monkeypatch, tmp_path):
    appels = _caddy_factice(monkeypatch, conf, tmp_path)
    conf.apply_https({"mode": "acme", "domain": "x.example\nreverse_proxy evil:80", "email": ""})
    conf.apply_https({"mode": "acme", "domain": "elpis.example.com", "email": "a@b.fr}\n\tfoo"})
    assert appels == [] and not (tmp_path / "user_db/run/Caddyfile.acme").exists()


def test_apply_https_acme_lance_trois_commandes_sans_sh_c(conf, monkeypatch, tmp_path):
    appels = _caddy_factice(monkeypatch, conf, tmp_path)
    conf.apply_https({"mode": "acme", "domain": "elpis.example.com", "email": "admin@example.com"})
    assert [c[1] for c in appels] == ["install", "caddy", "systemctl"] and all(c[0] == "sudo" for c in appels)
    assert all("sh" not in c[:3] and "-c" not in c for c in appels)
    corps = (tmp_path / "user_db/run/Caddyfile.acme").read_text(encoding="utf-8")
    assert "elpis.example.com" in corps and "email admin@example.com" in corps


def test_apply_https_s_arrete_a_la_premiere_commande_en_echec(conf, monkeypatch, tmp_path):
    appels = _caddy_factice(monkeypatch, conf, tmp_path)
    monkeypatch.setattr(conf.subprocess, "run", lambda cmd, *a, **k: appels.append(cmd) or subprocess.CompletedProcess(cmd, 1 if "validate" in cmd else 0))
    conf.apply_https({"mode": "acme", "domain": "elpis.example.com", "email": ""})
    assert [c[1] for c in appels] == ["install", "caddy"]


def test_step_access_acme_refuse_un_domaine_invalide(conf, monkeypatch):
    import argparse
    class Arguments(argparse.Namespace):
        def __getattr__(self, nom):
            return None
    a = Arguments(https="acme", domain="evil host", acme_email="", host="")
    monkeypatch.setattr(conf, "port_in_use", lambda p: False)
    with pytest.raises(SystemExit) as e:
        conf.step_access(conf.Prompter(False), a, {}, {})
    assert e.value.code == 2


def test_aucun_sh_c_dans_configure():
    source = (REPO / "deploy/configure.py").read_text(encoding="utf-8")
    assert not re.search(r'"sh",\s*"-c"|shell\s*=\s*True|os\.system\(', source)


# ── ./elpis lit .env comme des données ───────────────────────────────────────
@pytest.fixture
def racine(tmp_path):
    r = tmp_path / "elpis"
    for d in ("deploy/node", "deploy/toolhost", "apps/core/dist", "apps/toolhost/dist", "venv/bin", "rag_app", "user_db/run"):
        (r / d).mkdir(parents=True)
    for f in ("elpis", "deploy/node/node.env", "deploy/node/runtime.sh", "deploy/node/relance.sh", "deploy/prerequis-apt.sh",
              "deploy/prerequis-apt.txt"):
        shutil.copy2(REPO / f, r / f)
    (r / "venv/bin/python").symlink_to(sys.executable)
    (r / "venv/bin/uvicorn").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (r / "venv/bin/uvicorn").chmod(0o755)
    (r / "config.json").write_text("{}", encoding="utf-8")
    (r / "apps/core/dist/main.mjs").write_text("", encoding="utf-8")
    (r / "apps/toolhost/dist/main.mjs").write_text("", encoding="utf-8")
    node = r / "faux-node"
    node.write_text('#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\nexit 0\n', encoding="utf-8")
    node.chmod(0o755)
    return r


def _elpis(racine: Path, *args: str) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(racine), "LANG": "C.UTF-8",
           "ELPIS_NODE": str(racine / "faux-node")}
    return subprocess.run(["bash", str(racine / "elpis"), *args], env=env, capture_output=True, text=True, timeout=120,
                          cwd=racine)


def test_env_lu_comme_des_donnees_aucune_substitution_ni_commande(racine):
    (racine / ".env").write_text(
        "# commentaire\n"
        "APP_SANDBOX_DIR=/tmp/sb-donnees-1\n"
        "INJECTION=$(touch marqueur-sous-shell)\n"
        "`touch marqueur-backticks`\n"
        "touch marqueur-commande; =x\n"
        "export ELPIS_AUTRE=\"valeur $(touch marqueur-guillemets)\"\n"
        "1MAUVAISE=x\n"
        "CLE AVEC ESPACE=x\n"
        "SANS_FIN_DE_LIGNE=ok", encoding="utf-8")
    r = _elpis(racine, "service", "print")
    assert r.returncode == 0, r.stderr
    assert not list(racine.glob("marqueur-*"))
    assert 'Environment="APP_SANDBOX_DIR=/tmp/sb-donnees-1"' in r.stdout.splitlines()


@pytest.mark.parametrize("ligne,attendu", [("APP_SANDBOX_DIR='/tmp/sb-q1'   # dossier\n", "/tmp/sb-q1"),
                                           ('APP_SANDBOX_DIR="/tmp/sb-q2"\r\n', "/tmp/sb-q2"),
                                           ("APP_SANDBOX_DIR=/tmp/sb-q3 # sans guillemets\n", "/tmp/sb-q3"),
                                           ("export APP_SANDBOX_DIR=/tmp/sb-q4\n", "/tmp/sb-q4"),
                                           ('APP_SANDBOX_DIR="/tmp/a $HOME"\n', "/tmp/a $HOME")])
def test_env_valeurs_entre_guillemets_et_commentaires_de_fin(racine, ligne, attendu):
    (racine / ".env").write_text(ligne, encoding="utf-8")
    assert f'Environment="APP_SANDBOX_DIR={attendu}"' in _elpis(racine, "service", "print").stdout.splitlines()


def test_charger_env_n_utilise_plus_source_et_doctor_n_evalue_plus():
    texte = (REPO / "elpis").read_text(encoding="utf-8")
    assert not re.search(r"^\s*(\.|source)\s+\"\$ROOT/\.env\"", texte, re.M)
    doctor = texte[texte.index("cmd_doctor() {"):]
    doctor = doctor[:doctor.index("\n}\n")]
    assert not re.search(r"\beval\b", doctor)


def test_service_install_avertit_pour_le_groupe_docker():
    texte = (REPO / "elpis").read_text(encoding="utf-8")
    assert "Le groupe docker équivaut à root sur l'hôte" in texte and "SECURITY.md" in texte
