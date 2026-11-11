# SPDX-License-Identifier: MIT
"""tests/deploy/test_vault_setup_2026_11_10.py — « ./elpis vault setup » rejoué sans root dans une arborescence factice (ELPIS_PREFIXE_SYSTEME) : clé créée 0440, jamais remplacée, validée par le cœur (même règle que les services), refusée si invalide, dégénérée ou en lien ; unités et ./elpis start sans la clé hors de main et admin ; aide, usages et contrôles du doctor (session sans le groupe de la clé comprise)."""
from __future__ import annotations

import base64
import getpass
import json
import os
import pwd
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MOI = getpass.getuser()


def _existe(compte: str) -> bool:
    try:
        pwd.getpwnam(compte)
        return True
    except KeyError:
        return False


AUTRE = next((u for u in ("nobody", "daemon", "bin") if u != MOI and _existe(u)), None)


NODE = REPO / "node/bin/node"
# Bundle du core remplacé par le source du dépôt (tsx) : `vault check-key` est le vrai validateur.
TALON_CORE = f"""import {{ spawnSync }} from "node:child_process";
const r = spawnSync(process.execPath, [{json.dumps(str(REPO / "node_modules/tsx/dist/cli.mjs"))},
  {json.dumps(str(REPO / "apps/core/src/exploitation.ts"))}, ...process.argv.slice(2)], {{ stdio: "inherit" }});
process.exit(r.status ?? 1);
"""


@pytest.fixture
def depot(tmp_path):
    r = tmp_path / "elpis"
    for d in ("deploy/node", "logs/audit", "user_db/run", "apps/core/dist"):
        (r / d).mkdir(parents=True)
    for f in ("elpis", "deploy/node/node.env", "deploy/node/runtime.sh", "deploy/prerequis-apt.sh",
              "deploy/prerequis-apt.txt"):
        shutil.copy2(REPO / f, r / f)
    (r / "apps/core/dist/exploitation.mjs").write_text(TALON_CORE, encoding="utf-8")
    (tmp_path / "sys").mkdir()
    return r


def _sys(depot: Path) -> Path:
    return depot.parent / "sys"


def _env(depot: Path, **env: str) -> dict[str, str]:
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8",
         "ELPIS_PREFIXE_SYSTEME": str(_sys(depot)), "ELPIS_USER": MOI, "ELPIS_NODE": str(NODE), **env}
    return {k: v for k, v in e.items() if v != ""}


def _elpis(depot: Path, *args: str, **env: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(depot / "elpis"), *args], env=_env(depot, **env), capture_output=True,
                          text=True, timeout=60, cwd=str(depot), stdin=subprocess.DEVNULL)


def _mode(p: Path) -> str:
    return oct(p.stat().st_mode & 0o7777)[2:]


def _cle(depot: Path) -> Path:
    return _sys(depot) / "etc/elpis/vault.key"


def test_premier_passage_cle_creee_0440_en_base64(depot):
    r = _elpis(depot, "vault", "setup")
    assert r.returncode == 0, r.stderr
    assert "Clé du coffre en place" in r.stdout
    assert {p: _mode(_sys(depot) / p) for p in ("etc/elpis", "etc/elpis/vault.key")} == {
        "etc/elpis": "750", "etc/elpis/vault.key": "440"}
    texte = _cle(depot).read_text(encoding="ascii")
    assert re.fullmatch(r"[A-Za-z0-9+/]{43}=\n", texte)
    assert len(base64.b64decode(texte)) == 32
    assert not (_sys(depot) / "etc/elpis/audit.key").exists()


def test_second_passage_garde_la_cle_et_reapplique_les_droits(depot):
    assert _elpis(depot, "vault", "setup").returncode == 0
    avant = _cle(depot).read_text(encoding="ascii")
    _cle(depot).chmod(0o600)
    r = _elpis(depot, "vault", "setup")
    assert r.returncode == 0, r.stderr
    assert "déjà en place, gardée" in r.stdout
    assert _cle(depot).read_text(encoding="ascii") == avant
    assert _mode(_cle(depot)) == "440"


def test_cle_vide_remplacee_cle_invalide_ou_degeneree_refusee_intacte(depot):
    (_sys(depot) / "etc/elpis").mkdir(parents=True)
    _cle(depot).write_text("", encoding="ascii")
    assert _elpis(depot, "vault", "setup").returncode == 0
    assert len(base64.b64decode(_cle(depot).read_text(encoding="ascii"))) == 32
    for contenu, motif in (("pas une clé\n", "base64 canonique"),
                           (base64.b64encode(bytes(32)).decode() + "\n", "dégénérée"),
                           (base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=") + "\n", "base64 canonique")):
        _cle(depot).chmod(0o600)
        _cle(depot).write_text(contenu, encoding="utf-8")
        r = _elpis(depot, "vault", "setup")
        assert r.returncode != 0, contenu
        assert "clé du coffre invalide" in r.stderr and motif in r.stderr, r.stderr
        assert _cle(depot).read_text(encoding="utf-8") == contenu


def test_cle_hexadecimale_acceptee(depot):
    (_sys(depot) / "etc/elpis").mkdir(parents=True)
    cle = os.urandom(32).hex() + "\n"
    _cle(depot).write_text(cle, encoding="ascii")
    r = _elpis(depot, "vault", "setup")
    assert r.returncode == 0, r.stderr
    assert re.search(r"kid [0-9a-f]{8}", r.stdout)
    assert _cle(depot).read_text(encoding="ascii") == cle


def test_sans_core_construit_refus_clair(depot):
    (depot / "apps/core/dist/exploitation.mjs").unlink()
    r = _elpis(depot, "vault", "setup")
    assert r.returncode != 0 and "Core non construit" in r.stderr
    assert not _cle(depot).exists()


def test_cle_en_lien_refusee_sans_toucher_la_cible(depot, tmp_path):
    cible = tmp_path / "secret"
    cible.write_text("x" * 44, encoding="utf-8")
    cible.chmod(0o600)
    (_sys(depot) / "etc/elpis").mkdir(parents=True)
    _cle(depot).symlink_to(cible)
    r = _elpis(depot, "vault", "setup")
    assert r.returncode != 0
    assert "vault.key : lien symbolique" in r.stderr
    assert _mode(cible) == "600" and cible.read_text(encoding="utf-8") == "x" * 44


def test_conseil_de_rekey_si_cle_de_repli(depot):
    (depot / "user_db/.vault.key").write_text(base64.b64encode(os.urandom(32)).decode() + "\n", encoding="ascii")
    r = _elpis(depot, "vault", "setup")
    assert r.returncode == 0, r.stderr
    assert "./elpis vault rekey --from user_db/.vault.key" in r.stdout


@pytest.mark.skipif(AUTRE is None, reason="aucun autre compte local")
def test_compte_divergent_des_unites_refuse(depot):
    d = _sys(depot) / "etc/systemd/system"
    d.mkdir(parents=True)
    (d / "elpis-main.service").write_text(f"[Service]\nUser={AUTRE}\n", encoding="utf-8")
    r = _elpis(depot, "vault", "setup")
    assert r.returncode != 0
    assert f"Les services tournent sous {AUTRE}" in r.stderr
    assert not _cle(depot).exists()


def test_audit_setup_inchange_apres_factorisation_du_compte(depot):
    r = _elpis(depot, "audit", "setup")
    assert r.returncode == 0, r.stderr
    assert f"Journal de sécurité en place (compte {MOI})." in r.stdout
    assert _mode(_sys(depot) / "etc/elpis/audit.key") == "440"


def test_aide_et_usages(depot):
    aide = _elpis(depot, "help")
    assert "sudo ./elpis vault setup" in aide.stdout and "./elpis secret ls [--user COMPTE]" in aide.stdout
    assert "./elpis audit verify" in aide.stdout
    for args, attendu in ((("vault",), "Usage : sudo ./elpis vault setup"),
                          (("vault", "setup", "x"), "Usage : sudo ./elpis vault setup"),
                          (("secret",), "Usage : ./elpis secret ls"),
                          (("secret", "rm"), "Usage : ./elpis secret ls")):
        r = _elpis(depot, *args)
        assert r.returncode != 0 and attendu in r.stderr, (args, r.stderr)


def _fonctions(*noms: str) -> str:
    texte = (REPO / "elpis").read_text(encoding="utf-8").splitlines()
    sortie = []
    for nom in noms:
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    return "\n".join(sortie)


def _bash(depot: Path, fonctions: str, corps: str, **env: str) -> subprocess.CompletedProcess:
    """Fonctions extraites du script, avec les affichages et les variables de base."""
    tete = f"""set -uo pipefail
info() {{ printf '[elpis] %s\\n' "$*"; }}; ok() {{ printf '[ ok  ] %s\\n' "$*"; }}
warn() {{ printf '[warn ] %s\\n' "$*" >&2; }}; die() {{ printf '[err  ] %s\\n' "$*" >&2; exit 1; }}
SYS_PREFIXE="$ELPIS_PREFIXE_SYSTEME"; UNIT_PREFIX=elpis
ROOT={depot}; RUN_DIR="$ROOT/user_db/run"; LOG_DIR="$ROOT/logs"
"""
    return subprocess.run(["bash", "-c", tete + fonctions + "\n" + corps], env=_env(depot, **env),
                          capture_output=True, text=True, timeout=60, cwd=str(depot), stdin=subprocess.DEVNULL)


def _doctor(depot: Path, talon_core: str) -> subprocess.CompletedProcess:
    tete = f"""set -uo pipefail
info() {{ printf '[elpis] %s\\n' "$*"; }}; ok() {{ printf '[ ok  ] %s\\n' "$*"; }}
warn() {{ printf '[warn ] %s\\n' "$*" >&2; }}; die() {{ printf '[err  ] %s\\n' "$*" >&2; exit 1; }}
SYS_PREFIXE="$ELPIS_PREFIXE_SYSTEME"; VAULT_KEY_SYS="$SYS_PREFIXE/etc/elpis/vault.key"; UNIT_PREFIX=elpis
ROOT={depot}; CORE_DIST="$ROOT/apps/core/dist"
compte_services() {{ :; }}; groupe_propre() {{ return 0; }}; compte_lit() {{ return 0; }}
vault_core() {{ {talon_core}; }}
"""
    return subprocess.run(["bash", "-c", tete + _fonctions("doctor_coffre") + '\nbad=0; doctor_coffre; echo "bad=$bad"'],
                          env=_env(depot), capture_output=True, text=True, timeout=60, cwd=str(depot),
                          stdin=subprocess.DEVNULL)


def test_doctor_lit_les_lignes_du_core_et_compte_les_avertissements(depot):
    (depot / "apps/core/dist/exploitation.mjs").write_text("", encoding="utf-8")
    (depot / "config.json").write_text("{}", encoding="utf-8")
    r = _doctor(depot, "printf 'ok\\tcoffre (Secrets) : clé x (kid 12345678)\\nwarn\\tcoffre (Secrets) : 2 secret(s)\\n'")
    assert "[ ok  ] coffre (Secrets) : clé x (kid 12345678)" in r.stdout
    assert "[warn ] coffre (Secrets) : 2 secret(s)" in r.stderr
    assert "bad=1" in r.stdout
    (_sys(depot) / "etc/elpis").mkdir(parents=True)
    _cle(depot).write_text(base64.b64encode(os.urandom(32)).decode() + "\n", encoding="ascii")
    _cle(depot).chmod(0o644)
    r = _doctor(depot, ":")
    assert "attendu 440 root" in r.stderr and "bad=1" in r.stdout


def test_doctor_sans_core_non_verifie(depot):
    r = _doctor(depot, "echo 'ne doit pas être appelé'")
    assert "non vérifié (core non construit" in r.stdout and "bad=0" in r.stdout


def _unites(depot: Path, **env: str) -> dict[str, str]:
    """Unités rendues par `_render_units` (dépendances du rendu remplacées par des talons)."""
    talons = f"""
load_runtime() {{ :; }}; need_core() {{ :; }}; _db_local_unit() {{ :; }}; _https_enabled() {{ return 1; }}
svc_available() {{ :; }}
svc_spec() {{ SPEC_DIR="$ROOT"; SPEC_CMD=(/bin/true "$1"); SPEC_ENV=(A=1); }}
core_cmd() {{ [ "$*" = "config DB_PATH" ] && echo /srv/donnees/app.db; }}
SERVICES=(qdrant rag toolhost main admin browser); VAULT_KEY_SYS=/etc/elpis/vault.key
"""
    sortie = depot.parent / "unites"
    sortie.mkdir(exist_ok=True)
    r = _bash(depot, _fonctions("_render_units"), talons + f'_render_units "{sortie}" {MOI}', **env)
    assert r.returncode == 0, r.stderr
    return {f.name: f.read_text(encoding="utf-8") for f in sortie.iterdir()}


def test_unites_sans_la_cle_hors_de_main_et_admin(depot):
    u = _unites(depot)
    for s in ("qdrant", "rag", "toolhost", "browser"):
        texte = u[f"elpis-{s}.service"]
        assert "UnsetEnvironment=ELPIS_VAULT_KEY ELPIS_VAULT_KEY_PATH" in texte, s
        assert "InaccessiblePaths=-/etc/elpis/vault.key" in texte, s
        assert "InaccessiblePaths=-/srv/donnees/.vault.key" in texte, s
        assert texte.index("EnvironmentFile=") < texte.index("UnsetEnvironment="), s
    for s in ("main", "admin"):
        texte = u[f"elpis-{s}.service"]
        assert "UnsetEnvironment" not in texte and "InaccessiblePaths" not in texte, s


def test_start_retire_la_cle_de_l_environnement_hors_de_main_et_admin(depot, tmp_path):
    vu = tmp_path / "vu"
    vu.mkdir()
    ecrire = tmp_path / "ecrire.sh"
    ecrire.write_text('printf "%s" "${ELPIS_VAULT_KEY:-absente}" > "$1"\n', encoding="utf-8")
    talons = f"""
systemd_active() {{ return 1; }}; load_runtime() {{ :; }}; need_core() {{ :; }}; migrer_mcp() {{ :; }}
svc_available() {{ :; }}; pid_of() {{ return 1; }}; tourner_journal() {{ :; }}; attendre() {{ :; }}
attendre_sante() {{ :; }}; cmd_status() {{ :; }}; _https_enabled() {{ return 1; }}; svc_port() {{ echo 1; }}
svc_spec() {{ SPEC_DIR="$ROOT"; SPEC_LANCEUR=(); SPEC_ENV=(A=1); SPEC_CMD=(sh {ecrire} "{vu}/$1"); }}
SERVICES=(toolhost main browser); BIND_DEFAULT=127.0.0.1; MAIN_PORT=1; ADMIN_PORT=2
mkdir -p "$ROOT/deploy/node" && : > "$ROOT/deploy/node/relance.sh"
"""
    r = _bash(depot, _fonctions("cmd_start"), talons + "cmd_start; wait", ELPIS_VAULT_KEY="cle-de-test")
    assert r.returncode == 0, r.stderr
    assert {f.name: f.read_text(encoding="utf-8") for f in vu.iterdir()} == {
        "toolhost": "absente", "browser": "absente", "main": "cle-de-test"}


def test_doctor_session_sans_le_groupe_de_la_cle(depot, tmp_path):
    import grp
    faux = tmp_path / "bin"
    faux.mkdir()
    (faux / "id").write_text('#!/bin/bash\n[ "$*" = -Gn ] && { echo autre-groupe; exit 0; }\nexec /usr/bin/id "$@"\n',
                             encoding="utf-8")
    (faux / "id").chmod(0o755)
    d = _sys(depot) / "etc/elpis"
    d.mkdir(parents=True)
    _cle(depot).write_text(base64.b64encode(os.urandom(32)).decode() + "\n", encoding="ascii")
    _cle(depot).chmod(0o440)
    d.chmod(0o000)
    groupe = grp.getgrgid(os.getgid()).gr_name
    try:
        tete = f"""set -uo pipefail
info() {{ printf '[elpis] %s\\n' "$*"; }}; ok() {{ printf '[ ok  ] %s\\n' "$*"; }}
warn() {{ printf '[warn ] %s\\n' "$*" >&2; }}
SYS_PREFIXE="$ELPIS_PREFIXE_SYSTEME"; VAULT_KEY_SYS="$SYS_PREFIXE/etc/elpis/vault.key"; ROOT={depot}
CORE_DIST="$ROOT/apps/core/dist"; compte_services() {{ echo {MOI}; }}
vault_core() {{ echo "ne doit pas être appelé" >&2; }}
"""
        r = subprocess.run(["bash", "-c", tete + _fonctions("doctor_coffre") + '\nbad=0; doctor_coffre; echo "bad=$bad"'],
                           env=_env(depot, PATH=f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}"),
                           capture_output=True, text=True, timeout=60, cwd=str(depot), stdin=subprocess.DEVNULL)
    finally:
        d.chmod(0o750)
    assert "bad=1" in r.stdout, r.stdout + r.stderr
    assert f"sans le groupe {groupe}" in r.stderr and "sg " in r.stderr
    assert "ne doit pas être appelé" not in r.stderr
