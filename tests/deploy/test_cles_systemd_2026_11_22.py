# SPDX-License-Identifier: MIT
"""tests/deploy/test_cles_systemd_2026_11_22.py — bloc 6, clés de la plateforme remises par systemd (un compte par service, systemd 250 ou plus) : systemd-creds et systemd-run simulés ; rendu par unité, rangement depuis les fichiers du bloc 5 (sources retirées après relecture, liens et autres comptes refusés), second passage, retour à un compte, systemd trop ancien, commandes de root par une unité transitoire, setup sans fichier en clair, config.json rangé en deux temps."""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import sys
from pathlib import Path

import pytest

from tests.deploy import test_comptes_separes_2026_11_21 as _cs, test_configure_comptes_separes_2026_11_21 as _cc
from tests.deploy.test_comptes_separes_2026_11_21 import (
    INSTALLE_SEPARE,
    MOI,
    TALONS,
    _etat,
    _executable,
    _harnais,
    _mode,
    _sys,
    _trace,
    _unite,
    _unite_bloc4,
)

depot = _cs.depot
conf = _cc.conf
FORT, ranger = _cc.FORT, _cc.ranger
REPO = Path(__file__).resolve().parents[2]

# systemd-creds simulé : chiffré = en-tête portant le nom, puis le clair en base64 ; déchiffrement refusé sous un autre nom.
FAUX_CREDS = r'''#!/usr/bin/env python3
import base64, os, sys
args = sys.argv[1:]
with open(os.environ["FAUX_CREDS_TRACE"], "a", encoding="utf-8") as f:
    f.write(" ".join(args) + "\n")
verbe = args[0]
if verbe in os.environ.get("FAUX_CREDS_ECHEC", "").split(","):
    sys.stderr.write("échec simulé\n")
    sys.exit(1)
nom = next(a.split("=", 1)[1] for a in args if a.startswith("--name="))
pos = [a for a in args[1:] if not a.startswith("--")]
entree, sortie = pos[0], (pos[1] if len(pos) > 1 else "-")
donnees = sys.stdin.buffer.read() if entree == "-" else open(entree, "rb").read()
if verbe == "encrypt":
    blob = b"FAUXCREDS " + nom.encode() + b"\n" + base64.b64encode(donnees) + b"\n"
else:
    tete, _, corps = donnees.partition(b"\n")
    if tete != b"FAUXCREDS " + nom.encode():
        sys.stderr.write("nom ou clé différents\n")
        sys.exit(1)
    blob = base64.b64decode(corps)
if sortie == "-":
    sys.stdout.buffer.write(blob)
else:
    with open(sortie, "wb") as f:
        f.write(blob)
'''

# systemd-run simulé : argv noté, unité transitoire rejouée (fichier d'environnement, credentials dans FAUX_RUN_CREDS, « $$ » rendu « $ »).
FAUX_RUN = r'''#!/usr/bin/env python3
import json, os, re, shutil, subprocess, sys
args = sys.argv[1:]
i = args.index("--")
opts, cmd = args[:i], args[i + 1:]
props, unite, it = [], None, iter(opts)
for a in it:
    if a == "-p":
        props.append(next(it))
    elif a.startswith("--unit="):
        unite = a[7:]
creds = os.path.join(os.environ["FAUX_RUN_CREDS"], unite + ".service")
os.makedirs(creds)
ici = lambda v: v.replace("/run/credentials/", os.environ["FAUX_RUN_CREDS"] + "/")
env, cwd, fichier_env = {}, "/", ""
for p in props:
    k, _, v = p.partition("=")
    if k == "EnvironmentFile":
        fichier_env = open(v, encoding="utf-8").read()
        for l in fichier_env.splitlines():
            m = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"', l)
            env[m[1]] = re.sub(r"\\(.)", r"\1", m[2])
    elif k == "Environment":
        n, _, val = v.partition("=")
        env[n] = ici(val)
    elif k == "WorkingDirectory":
        cwd = v
    elif k in ("LoadCredentialEncrypted", "LoadCredential"):
        n, _, chemin = v.partition(":")
        if k == "LoadCredential":
            shutil.copyfile(chemin, os.path.join(creds, n))
        else:
            with open(os.path.join(creds, n), "wb") as f:
                f.write(subprocess.run(["systemd-creds", "decrypt", f"--name={n}", chemin, "-"], capture_output=True, check=True).stdout)
with open(os.environ["FAUX_RUN_TRACE"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": args, "env": fichier_env}) + "\n")
sys.exit(subprocess.run([ici(c.replace("$$", "$")) for c in cmd], env=env, cwd=cwd).returncode)
'''

# Mode des clés remises par systemd : systemd 257 annoncé (l'arborescence factice ne lit jamais le systemd de la machine).
CREDS = TALONS + "version_systemd() { echo 257; }\n"
VAULT = base64.b64encode(bytes(range(32))).decode() + "\n"
FERNET = base64.urlsafe_b64encode(bytes(range(1, 33))).decode()
SESSION = "ELPIS_" + "b" * 64
JOURNAL = "a" * 64


def _faux(depot: Path) -> dict[str, str]:
    """systemd-creds et systemd-run simulés en tête du PATH ; leurs journaux et le dossier des credentials dans l'arborescence factice."""
    s = _sys(depot)
    faux = s / "bin"
    faux.mkdir(exist_ok=True)
    _executable(faux / "systemd-creds", FAUX_CREDS)
    _executable(faux / "systemd-run", FAUX_RUN)
    (s / "run").mkdir(exist_ok=True)
    (s / "credentials-run").mkdir(exist_ok=True)
    return {"PATH": f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}", "FAUX_CREDS_TRACE": str(s / "creds.trace"),
            "FAUX_RUN_TRACE": str(s / "run.trace"), "FAUX_RUN_CREDS": str(s / "credentials-run")}


def _chiffre(nom: str, clair: str) -> bytes:
    return b"FAUXCREDS " + nom.encode() + b"\n" + base64.b64encode(clair.encode()) + b"\n"


def _clair(chemin: Path) -> str:
    tete, _, corps = chemin.read_bytes().partition(b"\n")
    return base64.b64decode(corps).decode()


def _magasin(depot: Path) -> Path:
    return _sys(depot) / "etc/elpis/credentials"


def _poser(depot: Path, **cles: str) -> Path:
    m = _magasin(depot)
    m.mkdir(parents=True, exist_ok=True)
    m.chmod(0o700)
    for nom, clair in cles.items():
        (m / nom.replace("_", ".")).write_bytes(_chiffre(nom.replace("_", "."), clair))
        (m / nom.replace("_", ".")).chmod(0o600)
    return m


def _sources(depot: Path) -> dict[str, Path]:
    """Clés du bloc 5 en clair : coffre et journal dans /etc/elpis (0440), clé de chiffrement et secret de session dans user_db (0640)."""
    etc = _sys(depot) / "etc/elpis"
    etc.mkdir(parents=True, exist_ok=True)
    db = depot / "user_db"
    f = {"vault.key": (etc / "vault.key", VAULT), "audit.key": (etc / "audit.key", JOURNAL),
         "encryption.key": (db / ".encryption_key", FERNET), "session.secret": (db / ".session_secret", SESSION)}
    for chemin, texte in f.values():
        if chemin.exists():
            chemin.chmod(0o600)
        chemin.write_text(texte, encoding="utf-8")
        chemin.chmod(0o440 if chemin.parent == etc else 0o640)
    return {n: p for n, (p, _) in f.items()}


def _lignes(depot: Path, nom: str) -> list[str]:
    p = _sys(depot) / nom
    return p.read_text(encoding="utf-8").splitlines() if p.exists() else []


def _print(depot: Path, version: str = "257", **env: str) -> dict[str, str]:
    """Unités rendues par « service print » sous ce compte, systemd VERSION annoncé, magasin de l'arborescence factice."""
    node = _executable(depot / "faux-node", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\nexit 0\n')
    (depot / "rag_app/qdrant").mkdir(exist_ok=True)
    _executable(depot / "rag_app/qdrant/qdrant", "#!/bin/sh\nexit 0\n")
    r = _harnais(depot, "dossier_ferme() { return 1; }\ncmd_service print", talons=f"version_systemd() {{ echo {version}; }}\n",
                 ELPIS_USER=MOI, ELPIS_NODE=str(node), **_faux(depot), **env)
    assert r.returncode == 0, r.stderr
    return {m[1]: m[2] for m in re.finditer(r"^### (\S+)\n(.*?)(?=^### |\Z)", r.stdout, re.S | re.M)}


def _credentials(texte: str) -> set[str]:
    return set(re.findall(r"^LoadCredentialEncrypted=([a-z.]+):", texte, re.M))


# Rendu : chaque unité ne reçoit que ses clés, présentes ; la variable pointe vers %d.
def test_unites_ne_portent_que_leurs_cles_presentes(depot):
    m = _poser(depot, vault_key=VAULT, encryption_key=FERNET, session_secret=SESSION, audit_key=JOURNAL)
    u = _print(depot)
    toutes = {"vault.key", "encryption.key", "session.secret", "audit.key"}
    for s in ("main", "admin"):
        lignes = u[f"elpis-{s}.service"].splitlines()
        assert _credentials(u[f"elpis-{s}.service"]) == toutes, s
        for nom, var in (("vault.key", "ELPIS_VAULT_KEY_PATH"), ("encryption.key", "APP_ENCRYPTION_KEY_PATH"),
                         ("session.secret", "APP_SESSION_SECRET_FILE"), ("audit.key", "ELPIS_AUDIT_KEY_PATH")):
            assert f"LoadCredentialEncrypted={nom}:{m}/{nom}" in lignes and f'Environment="{var}=%d/{nom}"' in lignes, (s, nom)
    assert _credentials(u["elpis-toolhost.service"]) == {"audit.key"}
    assert not re.search(r'^Environment="(ELPIS_VAULT_KEY_PATH|APP_ENCRYPTION_KEY_PATH|APP_SESSION_SECRET_FILE)=', u["elpis-toolhost.service"], re.M)
    assert not _credentials(u["elpis-rag.service"]) and not _credentials(u["elpis-qdrant.service"])
    (m / "vault.key").unlink()
    (m / "session.secret").unlink()
    assert _credentials(_print(depot)["elpis-main.service"]) == {"encryption.key", "audit.key"}



def test_jeton_du_rag_remis_au_rag_seul(depot):
    m = _poser(depot, vault_key=VAULT, audit_key=JOURNAL, rag_token="jeton\n")
    u = _print(depot)
    for s in ("main", "admin"):
        lignes = u[f"elpis-{s}.service"].splitlines()
        assert f"LoadCredentialEncrypted=rag.token:{m}/rag.token" in lignes and 'Environment="RAG_SERVICE_TOKEN_FILE=%d/rag.token"' in lignes
        assert [l for l in lignes if "RAG_SERVICE_TOKEN_FILE" in l] == ['Environment="RAG_SERVICE_TOKEN_FILE=%d/rag.token"'], s
    rag = u["elpis-rag.service"].splitlines()
    assert _credentials(u["elpis-rag.service"]) == {"rag.token"}
    assert [l for l in rag if "RAG_SERVICE_TOKEN_FILE" in l] == ['Environment="RAG_SERVICE_TOKEN_FILE=%d/rag.token"']
    assert "rag.token" not in u["elpis-toolhost.service"] and "rag.token" not in u["elpis-qdrant.service"]


def test_jeton_du_rag_repris_de_ses_fichiers(depot):
    etc, db = _sys(depot) / "etc/elpis", depot / "user_db"
    etc.mkdir(parents=True)
    (etc / "rag.token").write_text("jeton-bloc5\n", encoding="utf-8")
    (etc / "rag.token").chmod(0o440)
    corps = 'MODE_COMPTES=separes; BASE_DONNEES="$ROOT/user_db"; jeton_rag "$MOI"; echo "rc=$?"'
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert "rc=0" in r.stdout and _clair(_magasin(depot) / "rag.token") == "jeton-bloc5\n", r.stdout + r.stderr
    assert not (etc / "rag.token").exists() and "ranger_secrets" in "\n".join(_trace(depot))
    # Jeton réécrit par ./elpis configure dans user_db (à l'opérateur) : il l'emporte, puis il est retiré.
    (db / ".rag_service_token").write_text("jeton-configure\n", encoding="utf-8")
    (db / ".rag_service_token").chmod(0o600)
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert "rc=0" in r.stdout and _clair(_magasin(depot) / "rag.token") == "jeton-configure\n"
    assert not (db / ".rag_service_token").exists()
    (_magasin(depot) / "rag.token").unlink()
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert re.fullmatch(r"ELPIS_[0-9a-f]{64}\n", _clair(_magasin(depot) / "rag.token")), r.stderr


@pytest.mark.parametrize("version,env", [("249", {}), ("257", {"ELPIS_COMPTE_UNIQUE": "1"})])
def test_sans_cles_systemd_unites_du_bloc5(depot, version, env):
    _poser(depot, vault_key=VAULT, audit_key=JOURNAL)
    u = _print(depot, version, **env)
    assert not any(_credentials(t) or "%d/" in t for t in u.values()), version
    if version == "249":
        assert f'Environment="RAG_SERVICE_TOKEN_FILE={_sys(depot)}/etc/elpis/rag.token"' in u["elpis-main.service"].splitlines()


# Rangement : chaque source du bloc 5 chiffrée par un tube, relue, puis retirée ; second passage sans rien changer.
def test_sources_du_bloc5_chiffrees_puis_retirees(depot):
    src = _sources(depot)
    corps = 'BASE_DONNEES="$ROOT/user_db"; cles_vers_systemd "$MOI" ""; echo "rc=$?"'
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert "rc=0" in r.stdout, r.stdout + r.stderr
    m = _magasin(depot)
    assert _mode(m) == "700" and sorted(p.name for p in m.iterdir()) == ["audit.key", "encryption.key", "session.secret", "vault.key"]
    for nom, clair in (("vault.key", VAULT), ("encryption.key", FERNET), ("session.secret", SESSION), ("audit.key", JOURNAL)):
        assert (m / nom).read_bytes() == _chiffre(nom, clair) and _mode(m / nom) == "600", nom
        assert not src[nom].exists(), nom
    trace = _lignes(depot, "creds.trace")
    chiffres = [l for l in trace if l.startswith("encrypt ")]
    assert len(chiffres) == 4 and all(re.fullmatch(rf"encrypt --name=(\S+) --with-key=auto - {re.escape(str(m))}/\.\1\.[0-9a-f]{{16}}", l)
                                      for l in chiffres), chiffres
    assert all(v.strip() not in "\n".join(trace) for v in (VAULT, FERNET, SESSION, JOURNAL))
    assert "Copie hors de la machine (support hors ligne) : sudo systemd-creds decrypt --name=vault.key" in r.stdout
    avant = {p.name: p.stat().st_ctime_ns for p in m.iterdir()}
    (_sys(depot) / "creds.trace").unlink()
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert "rc=0" in r.stdout and not [l for l in _lignes(depot, "creds.trace") if l.startswith("encrypt")]
    assert {p.name: p.stat().st_ctime_ns for p in m.iterdir()} == avant and "Copie" not in r.stdout


def test_sources_liens_et_autres_comptes_refusees(depot):
    src = _sources(depot)
    cible = depot.parent / "cible"
    cible.write_text("hôte", encoding="utf-8")
    src["encryption.key"].unlink()
    src["encryption.key"].symlink_to(cible)
    r = _harnais(depot, 'BASE_DONNEES="$ROOT/user_db"; cles_vers_systemd personne-ici ""; echo "rc=$?"', CREDS, **_faux(depot))
    assert "rc=1" in r.stdout, r.stdout + r.stderr
    assert f"{src['session.secret']} ignoré (à {MOI}, en 640, 1 lien(s)" in r.stderr
    assert f"{src['encryption.key']} : lien ou fichier spécial : ignoré" in r.stderr
    assert cible.read_text(encoding="utf-8") == "hôte" and src["encryption.key"].is_symlink()
    assert src["vault.key"].read_text(encoding="utf-8") == VAULT and src["session.secret"].exists()
    # Ni reprise ni clé neuve à la place d'une source refusée : rien ne remplace en silence la clé de l'opérateur.
    assert list(_magasin(depot).iterdir()) == [] and src["audit.key"].read_text(encoding="utf-8") == JOURNAL


def test_cle_de_repli_seule_devient_la_cle(depot):
    (_sys(depot) / "etc/elpis").mkdir(parents=True)
    repli = depot / "user_db/.vault.key"
    repli.write_text(VAULT, encoding="utf-8")
    repli.chmod(0o600)
    r = _harnais(depot, 'BASE_DONNEES="$ROOT/user_db"; cles_vers_systemd "$MOI" ""', CREDS, **_faux(depot))
    assert _clair(_magasin(depot) / "vault.key") == VAULT and not repli.exists(), r.stderr
    # Avec /etc/elpis/vault.key, la clé de repli reste, pour vault rekey --from.
    (_magasin(depot) / "vault.key").unlink()
    repli.write_text("autre", encoding="utf-8")
    _sources(depot)
    _harnais(depot, 'BASE_DONNEES="$ROOT/user_db"; cles_vers_systemd "$MOI" ""', CREDS, **_faux(depot))
    assert _clair(_magasin(depot) / "vault.key") == VAULT and repli.read_text(encoding="utf-8") == "autre"


def test_source_differente_d_une_cle_en_service_laissee(depot):
    _poser(depot, vault_key="clé en service\n")
    src = _sources(depot)
    r = _harnais(depot, 'BASE_DONNEES="$ROOT/user_db"; cles_vers_systemd "$MOI" ""; echo "rc=$?"', CREDS, **_faux(depot))
    assert "rc=1" in r.stdout and "diffère de la clé vault.key en service" in r.stderr
    assert src["vault.key"].exists() and _clair(_magasin(depot) / "vault.key") == "clé en service\n"
    # Clé illisible (TPM changé) : la source la remplace.
    (_magasin(depot) / "vault.key").write_bytes(_chiffre("autre.nom", "x"))
    r = _harnais(depot, 'BASE_DONNEES="$ROOT/user_db"; cles_vers_systemd "$MOI" ""; echo "rc=$?"', CREDS, **_faux(depot))
    assert "rc=0" in r.stdout and "illisible par systemd-creds" in r.stderr
    assert _clair(_magasin(depot) / "vault.key") == VAULT and not src["vault.key"].exists()


def test_echec_de_relecture_garde_la_source(depot):
    src = _sources(depot)
    r = _harnais(depot, 'BASE_DONNEES="$ROOT/user_db"; cles_vers_systemd "$MOI" ""; echo "rc=$?"', CREDS,
                 **{**_faux(depot), "FAUX_CREDS_ECHEC": "decrypt"})
    assert "rc=1" in r.stdout and all(p.exists() for p in src.values())
    assert [p.name for p in _magasin(depot).iterdir()] == []


def test_installation_separee_range_les_cles_avant_les_unites(depot):
    _unite_bloc4(depot)
    _etat(depot)
    src = _sources(depot)
    r = _harnais(depot, INSTALLE_SEPARE, CREDS, **_faux(depot))
    assert r.returncode == 0, r.stdout + r.stderr
    t = _trace(depot)
    assert t.index(next(l for l in t if l.startswith("cmd_stop"))) < t.index(f"render separes {MOI}")
    assert sorted(p.name for p in _magasin(depot).iterdir()) == ["audit.key", "encryption.key", "rag.token", "session.secret", "vault.key"]
    assert not any(p.exists() for p in src.values()) and _clair(_magasin(depot) / "rag.token") == "r" * 43 + "\n"
    assert not (_sys(depot) / "etc/elpis/rag.token").exists() and not (depot / "user_db/.rag_service_token").exists()
    avant = {p.name: p.stat().st_ctime_ns for p in _magasin(depot).iterdir()}
    r = _harnais(depot, INSTALLE_SEPARE, CREDS, **_faux(depot))
    assert r.returncode == 0 and {p.name: p.stat().st_ctime_ns for p in _magasin(depot).iterdir()} == avant


# Retour à un compte et retrait des services : chaque clé rendue à son fichier du compte unique, magasin retiré.
def test_retour_au_compte_unique_rend_les_fichiers(depot):
    _unite_bloc4(depot)
    _poser(depot, vault_key=VAULT, encryption_key=FERNET, session_secret=SESSION, audit_key=JOURNAL, rag_token="jeton-rag\n")
    r = _harnais(depot, INSTALLE_SEPARE, CREDS, ELPIS_COMPTE_UNIQUE="1", **_faux(depot))
    assert r.returncode == 0, r.stdout + r.stderr
    etc, db = _sys(depot) / "etc/elpis", depot / "user_db"
    attendus = {etc / "vault.key": (VAULT, "440"), etc / "audit.key": (JOURNAL, "440"), db / ".encryption_key": (FERNET, "600"),
                db / ".session_secret": (SESSION, "600"), db / ".rag_service_token": ("jeton-rag\n", "600")}
    assert {p: (p.read_text(encoding="utf-8"), _mode(p)) for p in attendus} == attendus
    assert not _magasin(depot).exists() and "rendues à leurs fichiers" in r.stdout
    r = _harnais(depot, INSTALLE_SEPARE, CREDS, ELPIS_COMPTE_UNIQUE="1", **_faux(depot))
    assert r.returncode == 0 and {p: (p.read_text(encoding="utf-8"), _mode(p)) for p in attendus} == attendus


def test_retrait_des_services_rend_les_cles_a_l_operateur(depot):
    _poser(depot, vault_key=VAULT, encryption_key=FERNET, session_secret=SESSION, audit_key=JOURNAL)
    db = depot / "user_db"
    (db / ".session_secret").write_text("différent", encoding="utf-8")
    corps = 'cles_au_retrait; echo "rc=$?"'
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert "rc=1" in r.stdout and "diffère de la clé session.secret : laissés tous deux" in r.stderr
    assert sorted(p.name for p in _magasin(depot).iterdir()) == ["session.secret"]
    (db / ".session_secret").unlink()
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert "rc=0" in r.stdout and not _magasin(depot).exists(), r.stderr
    assert {p: _mode(p) for p in (db / ".encryption_key", db / ".session_secret", _sys(depot) / "etc/elpis/vault.key")} == {
        db / ".encryption_key": "600", db / ".session_secret": "600", _sys(depot) / "etc/elpis/vault.key": "440"}
    assert (db / ".session_secret").read_text(encoding="utf-8") == SESSION
    assert "rc=0" in _harnais(depot, corps, CREDS, **_faux(depot)).stdout
    assert "cles_au_retrait" in (REPO / "elpis").read_text(encoding="utf-8").split("remove)", 1)[1].split(";;", 1)[0]


def test_systemd_trop_ancien_garde_les_fichiers_du_bloc5(depot):
    _unite_bloc4(depot)
    _etat(depot)
    src = _sources(depot)
    r = _harnais(depot, INSTALLE_SEPARE, TALONS + "version_systemd() { echo 249; }\n", **_faux(depot))
    assert r.returncode == 0, r.stdout + r.stderr
    assert all(p.exists() for p in src.values()) and not _magasin(depot).exists()
    assert not _lignes(depot, "creds.trace") and not _lignes(depot, "run.trace")


# Commandes de root : une unité transitoire de la console, aucune valeur sur la ligne de commande, code rendu.
def _env_secret(depot: Path) -> None:
    (depot / ".env").write_text("SECRET_X=valeur-tres-secrete\n", encoding="utf-8")
    (depot / ".env").chmod(0o600)


def test_commandes_de_root_par_une_unite_transitoire(depot):
    _unite(depot, "main", "elpis-main", "separes")
    m = _poser(depot, vault_key=VAULT, audit_key=JOURNAL)
    _env_secret(depot)
    corps = ("app_console --env ELPIS_CFG_LLM_API_KEY='cle-api-secrete' sh -c "
             "'cat \"$ELPIS_VAULT_KEY_PATH\"; echo \"x=$SECRET_X k=$ELPIS_CFG_LLM_API_KEY u=$USER\"; exit 3'; echo \"rc=$?\"")
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    assert "rc=3" in r.stdout and VAULT.strip() in r.stdout, r.stdout + r.stderr
    assert "x=valeur-tres-secrete k=cle-api-secrete u=elpis-admin" in r.stdout
    (appel,) = [json.loads(l) for l in _lignes(depot, "run.trace")]
    argv = appel["argv"]
    unite = next(a[7:] for a in argv if a.startswith("--unit="))
    assert re.fullmatch(r"elpis-cli-\d+-[0-9a-f]{8}", unite)
    for a in ("--wait", "--pipe", "--collect", "--quiet", "--uid=elpis-admin", "--gid=elpis-donnees"):
        assert a in argv, a
    props = [argv[i + 1] for i, a in enumerate(argv) if a == "-p"]
    for p in (f"LoadCredentialEncrypted=vault.key:{m}/vault.key", f"LoadCredentialEncrypted=audit.key:{m}/audit.key",
              f"Environment=ELPIS_VAULT_KEY_PATH=/run/credentials/{unite}.service/vault.key", "NoNewPrivileges=yes", "UMask=0007",
              f"WorkingDirectory={depot}", "ProtectSystem=strict", f"ReadWritePaths=-{depot}/user_db"):
        assert p in props, p
    assert not any("encryption.key" in p or "session.secret" in p for p in props)
    assert all(s not in " ".join(argv) for s in ("valeur-tres-secrete", "cle-api-secrete", VAULT.strip()))
    assert 'SECRET_X="valeur-tres-secrete"' in appel["env"] and "ELPIS_VAULT_KEY_PATH" not in appel["env"]
    env_fichier = next(p.split("=", 1)[1] for p in props if p.startswith("EnvironmentFile="))
    assert env_fichier.startswith(f"{_sys(depot)}/run/elpis-cli.") and not os.path.exists(env_fichier)
    assert f"systemctl stop --no-block -- {unite}.service" in _trace(depot)
    assert not [l for l in _trace(depot) if l.startswith("runuser")]


def test_terminal_par_un_nouveau_pseudo_terminal_filtre(depot):
    _unite(depot, "main", "elpis-main", "separes")
    r = _harnais(depot, "app_console --terminal printf 'a\\033[2Jb\\033]52;c;QQ==\\007c\\n'", CREDS, **_faux(depot))
    (appel,) = [json.loads(l) for l in _lignes(depot, "run.trace")]
    assert "--pty" in appel["argv"] and "--pipe" not in appel["argv"]
    assert "a\x1b[2Jbc" in r.stdout and "52;c" not in r.stdout, r.stdout


def test_ancienne_cle_remise_par_systemd_au_rekey(depot):
    for s in ("main", "admin"):
        _unite(depot, s, f"elpis-{s}", "separes")
    _poser(depot, vault_key=VAULT)
    ancienne = depot / "user_db/.vault.key"
    ancienne.write_text("ancienne-cle\n", encoding="utf-8")
    ancienne.chmod(0o600)
    (depot / "apps/core/dist/exploitation.mjs").write_text("", encoding="utf-8")
    node = _executable(depot / "faux-node", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\n'
                       'shift; echo "args=$*"; cat "$4"\n')
    talons = CREDS + f'need_exploitation() {{ :; }}\nnode_bin() {{ echo "{node}"; }}\n'
    r = _harnais(depot, 'cmd_vault rekey --from user_db/.vault.key; echo "rc=$?"', talons, **_faux(depot))
    assert "ancienne-cle" in r.stdout and "rc=0" in r.stdout, r.stdout + r.stderr
    (appel,) = [json.loads(l) for l in _lignes(depot, "run.trace")]
    argv = appel["argv"]
    unite = next(a[7:] for a in argv if a.startswith("--unit="))
    assert any(re.fullmatch(rf"LoadCredential=vault-ancienne\.key:{re.escape(str(_sys(depot)))}/run/elpis-cli\.\w+/vault-ancienne\.key", a)
               for a in argv)
    assert f"/run/credentials/{unite}.service/vault-ancienne.key" in argv and str(ancienne) not in argv
    assert ancienne.read_text(encoding="utf-8") == "ancienne-cle\n"
    # Ancienne clé d'un autre compte que root ou l'opérateur : refusée, rien n'est lancé.
    (_sys(depot) / "run.trace").unlink()
    r = _harnais(depot, 'cmd_vault rekey --from user_db/.vault.key; echo "rc=$?"', talons, SUDO_USER="personne-ici", **_faux(depot))
    assert "rc=2" in r.stdout and f"{ancienne} ignoré" in r.stderr and not _lignes(depot, "run.trace")


def test_commandes_de_l_operateur_demandent_sudo(depot):
    (_sys(depot) / "etc/systemd/system/elpis-main.service").write_text(
        '[Service]\nUser=elpis-main\nEnvironment="ELPIS_COMPTES=separes"\nLoadCredentialEncrypted=vault.key:/x/vault.key\n'
        'LoadCredentialEncrypted=audit.key:/x/audit.key\n', encoding="utf-8")
    talons = CREDS + "need_exploitation() { :; }\ncore_cmd() { echo \"core $*\"; }\n"
    for corps, attendu in (("cmd_vault status", "lancez sudo ./elpis vault status"),
                           ("cmd_secret ls", "lancez sudo ./elpis secret ls"),
                           ("cmd_audit verify --from 2026-01-01", "lancez sudo ./elpis audit verify --from 2026-01-01")):
        r = _harnais(depot, corps, talons, FAUX_UID="1000")
        assert r.returncode != 0 and attendu in r.stderr and "core " not in r.stdout, (corps, r.stderr)
    r = _harnais(depot, "cmd_audit verify --key /srv/copie.key", talons, FAUX_UID="1000")
    assert "core audit verify --key /srv/copie.key" in r.stdout, r.stderr


# vault setup et audit setup : clé créée en mémoire et chiffrée, aucun fichier en clair, commande de copie affichée.
def _setup(depot: Path) -> str:
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    passwd = _sys(depot) / "etc/passwd"
    passwd.write_text(passwd.read_text(encoding="utf-8") + "elpis-main:x:990:990::/nonexistent:/usr/sbin/nologin\n",
                      encoding="utf-8")
    (depot / "apps/core/dist/exploitation.mjs").write_text("", encoding="utf-8")
    node = _executable(depot / "faux-node", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\n'
                       '[ "$2 $3" = "vault check-key" ] && { cat > /dev/null; echo "kid 0123abcd"; }\nexit 0\n')
    # audit setup réel (celui de TALONS retiré), sous un compte ordinaire : droits contrôlés par leur mode seul.
    talons = CREDS.replace('audit_setup() { trace audit_setup "$1" "$MODE_COMPTES"; mkdir -p "$SYS_PREFIXE/etc/elpis"; }\n', "")
    return talons + f'node_bin() {{ echo "{node}"; }}\naudit_deplacer() {{ :; }}\n'


def test_setup_sans_fichier_en_clair(depot):
    talons = _setup(depot)
    assert "audit_setup() { trace" not in talons
    r = _harnais(depot, "cmd_vault setup", talons, FAUX_UID="1000", **_faux(depot))
    assert r.returncode == 0, r.stdout + r.stderr
    etc = _sys(depot) / "etc/elpis"
    assert not (etc / "vault.key").exists() and re.fullmatch(r"[A-Za-z0-9+/]{43}=\n", _clair(_magasin(depot) / "vault.key"))
    assert "kid 0123abcd" in r.stdout and f"sudo systemd-creds decrypt --name=vault.key {_magasin(depot)}/vault.key FICHIER" in r.stdout
    assert [l for l in _lignes(depot, "creds.trace") if l.startswith("encrypt")][0].startswith("encrypt --name=vault.key --with-key=auto - ")
    r = _harnais(depot, "cmd_audit setup", talons, FAUX_UID="1000", **_faux(depot))
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (etc / "audit.key").exists() and re.fullmatch(r"[0-9a-f]{64}", _clair(_magasin(depot) / "audit.key"))
    assert f"sudo systemd-creds decrypt --name=audit.key {_magasin(depot)}/audit.key FICHIER" in r.stdout
    assert sorted(p.name for p in _magasin(depot).iterdir()) == ["audit.key", "vault.key"]
    # Une clé en clair d'avant est validée, chiffrée, puis retirée ; ouverte en écriture à d'autres, elle est refusée et rien n'est créé.
    (_magasin(depot) / "vault.key").unlink()
    (etc / "vault.key").write_text(VAULT, encoding="utf-8")
    (etc / "vault.key").chmod(0o664)
    r = _harnais(depot, "cmd_vault setup", talons, FAUX_UID="1000", **_faux(depot))
    assert r.returncode != 0 and "en 664" in r.stderr and not (_magasin(depot) / "vault.key").exists()
    (etc / "vault.key").chmod(0o600)
    r = _harnais(depot, "cmd_vault setup", talons, FAUX_UID="1000", **_faux(depot))
    assert r.returncode == 0, r.stdout + r.stderr
    assert _clair(_magasin(depot) / "vault.key") == VAULT and not (etc / "vault.key").exists()


# config.json rangé en deux temps : un échec entre les deux laisse la valeur dans config.json.
def test_config_json_range_en_deux_temps(depot):
    _unite(depot, "main", "elpis-main", "separes")
    shutil.copy2(REPO / "deploy/configure.py", depot / "deploy/configure.py")
    (depot / "config.json").write_text(json.dumps({"app": {"session_secret": "s" * 48, "encryption_key": "cle-heritee"},
                                                   "rag": {"service_token": "jeton-du-rag"}}), encoding="utf-8")
    (depot / "config.json").chmod(0o600)
    etc = _sys(depot) / "etc/elpis"
    etc.mkdir(parents=True)
    corps = (f'PY="{sys.executable}"; MODE_COMPTES=separes; BASE_DONNEES="$ROOT/user_db"; magasin_cles\n'
             f'ranger_secrets "{etc}/rag.token" elpis-admin; echo "rc=$?"')
    talons = CREDS.replace('ranger_secrets() { trace ranger_secrets "$@"; }\n', "")
    r = _harnais(depot, corps, talons, **{**_faux(depot), "FAUX_CREDS_ECHEC": "encrypt"})
    assert "rc=1" in r.stdout and "pas tous écrits" in r.stderr, r.stdout + r.stderr
    cfg = json.loads((depot / "config.json").read_text(encoding="utf-8"))
    assert cfg == {"app": {"session_secret": "s" * 48, "encryption_key": "cle-heritee"}, "rag": {"service_token": "jeton-du-rag"}}
    assert not (etc / "rag.token").exists()
    r = _harnais(depot, corps, talons, **_faux(depot))
    assert "rc=0" in r.stdout, r.stdout + r.stderr
    assert json.loads((depot / "config.json").read_text(encoding="utf-8")) == {"app": {}, "rag": {}}
    assert _clair(_magasin(depot) / "session.secret") == "s" * 48 + "\n" and _clair(_magasin(depot) / "encryption.key") == "cle-heritee\n"
    assert _clair(_magasin(depot) / "rag.token") == "jeton-du-rag\n" and not (etc / "rag.token").exists()
    assert all("s" * 48 not in a and "cle-heritee" not in a for l in _lignes(depot, "run.trace") for a in json.loads(l)["argv"])


# Doctor : version, clés lisibles, portées par les seules unités qui s'en servent, aucune copie en clair.
def test_doctor_des_cles_remises_par_systemd(depot):
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    unites = _sys(depot) / "etc/systemd/system"
    with (unites / "elpis-toolhost.service").open("a", encoding="utf-8") as f:
        f.write("LoadCredentialEncrypted=vault.key:/x/vault.key\n")
    _poser(depot, vault_key=VAULT, encryption_key=FERNET, session_secret=SESSION)
    (_magasin(depot) / "audit.key").write_bytes(_chiffre("autre", "x"))
    (depot / "user_db/.encryption_key").write_text(FERNET, encoding="utf-8")
    corps = 'bad=0; chemins_separes; doctor_cles_systemd; echo "bad=$bad"'
    r = _harnais(depot, corps, CREDS, **_faux(depot))
    sortie = r.stdout + r.stderr
    assert "clés de la plateforme remises par systemd 257" in sortie
    assert "clé audit.key illisible par systemd-creds" in sortie and "unité toolhost : clé vault.key remise à tort" in sortie
    assert "unité main sans la clé vault.key" in sortie and f"clé en clair restée : {depot}/user_db/.encryption_key" in sortie
    # Clé illisible 1, jeton du RAG absent 1, main et la console sans leurs 4 clés, l'hôte d'outils 2 (clé à tort, clé du journal absente), copie en clair 1.
    assert re.search(r"bad=([0-9]+)", r.stdout)[1] == str(1 + 1 + 4 + 4 + 2 + 1), sortie
    r = _harnais(depot, corps, TALONS + "version_systemd() { echo 249; }\n", **_faux(depot))
    assert "systemd 249 : 250 ou plus et systemd-creds" in r.stderr and "bad=1" in r.stdout


# deploy/configure.py --ranger-secrets en deux temps : --garder ne retire rien ; --retirer n'ôte que les clés données, si elles n'ont pas changé.


def _retirer(conf, monkeypatch, entree: bytes, *cles: str, terminal: bool = False) -> int:
    import io

    class Entree:
        buffer = io.BytesIO(entree)

    monkeypatch.setattr(conf.sys, "stdin", Entree())
    monkeypatch.setattr(conf.os, "isatty", lambda fd: terminal)
    return conf.main(["--ranger-secrets", "--retirer", *cles])


def test_ranger_secrets_en_deux_temps(conf, tmp_path, monkeypatch, capfd):
    cfg = {"app": {"session_secret": FORT, "encryption_key": "cle-heritee", "name": "x"}, "rag": {"service_token": "jeton-0123"}}
    (tmp_path / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    (tmp_path / "config.json").chmod(0o640)
    bak = tmp_path / "config.json.bak"
    bak.write_text(json.dumps(cfg), encoding="utf-8")
    bak.chmod(0o600)
    avant = (tmp_path / "config.json").read_text(encoding="utf-8")
    code, sortie = ranger(conf, "--garder")
    assert code == 0 and json.loads(sortie) == {"app.session_secret": FORT, "app.encryption_key": "cle-heritee",
                                                "rag.service_token": "jeton-0123"}
    assert (tmp_path / "config.json").read_text(encoding="utf-8") == avant and json.loads(bak.read_text(encoding="utf-8")) == cfg
    # Jeton changé entre les deux temps : il reste (code 1), la copie perd les clés données ; clé non donnée laissée, valeur d'exemple retirée.
    change = json.loads(avant)
    change["rag"]["service_token"] = "jeton-neuf"
    (tmp_path / "config.json").write_text(json.dumps(change), encoding="utf-8")
    code = _retirer(conf, monkeypatch, sortie.encode(), "app.session_secret", "app.encryption_key", "rag.service_token")
    assert code == 1 and "rag.service_token a changé depuis son rangement" in capfd.readouterr().err
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8")) == {"app": {"name": "x"}, "rag": {"service_token": "jeton-neuf"}}
    assert json.loads(bak.read_text(encoding="utf-8")) == {"app": {"name": "x"}, "rag": {}}
    (tmp_path / "config.json").write_text(json.dumps({"app": {"session_secret": "changeme", "encryption_key": "k"}}), encoding="utf-8")
    assert _retirer(conf, monkeypatch, b"{}", "app.session_secret") == 0
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8")) == {"app": {"encryption_key": "k"}}
    assert FORT not in "".join(capfd.readouterr())


def test_ranger_secrets_second_temps_refus(conf, tmp_path, monkeypatch, capfd):
    (tmp_path / "config.json").write_text(json.dumps({"app": {"session_secret": FORT}}), encoding="utf-8")
    assert _retirer(conf, monkeypatch, b"{}", "app.autre") == 2
    assert _retirer(conf, monkeypatch, b"{}", "app.session_secret", terminal=True) == 2
    assert _retirer(conf, monkeypatch, b"pas du json", "app.session_secret") == 2
    monkeypatch.setattr(conf.os, "geteuid", lambda: os.getuid() + 1)
    assert _retirer(conf, monkeypatch, json.dumps({"app.session_secret": FORT}).encode(), "app.session_secret") == 2
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8")) == {"app": {"session_secret": FORT}}
