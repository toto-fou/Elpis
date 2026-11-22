# SPDX-License-Identifier: MIT
"""tests/deploy/test_sandboxes_ancien_compte_2026_11_22.py — un compte par service : dossier des sandboxes à l'hôte d'outils seul (ce qu'un ancien compte unique ou les services y ont laissé compris, sans écriture du groupe, chaque /work et les liens intacts, dossier de l'agent sans son contenu, instantanés à part, un compte nommé « work » compris), historique des fichiers et cache des aperçus privés à l'hôte d'outils, mémoire déplacée dans user_db/memoire, second passage sans effet, retour au compte unique ; rôle de root simulé pour deploy/droits.py, propriétaires tenus dans une table."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import (
    GROUPE,
    INSTALLE_SEPARE,
    MOI,
    TALONS,
    _droits,
    _etat,
    _harnais,
    _mode,
    _sys,
    _unite_bloc4,
)

depot = _cs.depot

# deploy/droits.py sous un root simulé : comptes et groupes de la base factice, propriétaires de la table FAUX_PROPRIOS (périphérique:inode → uid, gid ; sinon ceux du disque) mis à jour par chown et fchown, modes posés pour de vrai.
FAUX_ROOT = r'''
import grp, json, os, pwd, runpy, sys
etc, table = os.environ["FAUX_ETC"], os.environ["FAUX_PROPRIOS"]
def lire(nom):
    with open(os.path.join(etc, nom), encoding="utf-8") as f:
        return [l.rstrip("\n").split(":") for l in f if l.strip()]
comptes = [pwd.struct_passwd((n, x, int(u), int(g), c, h, s)) for n, x, u, g, c, h, s in lire("passwd")]
groupes = [grp.struct_group((n, x, int(g), [m for m in ms.split(",") if m])) for n, x, g, ms in lire("group")]
def chercher(liste, champ, v):
    for e in liste:
        if getattr(e, champ) == v:
            return e
    raise KeyError(v)
pwd.getpwnam, pwd.getpwuid = (lambda n: chercher(comptes, "pw_name", n)), (lambda u: chercher(comptes, "pw_uid", u))
grp.getgrnam, grp.getgrgid = (lambda n: chercher(groupes, "gr_name", n)), (lambda g: chercher(groupes, "gr_gid", g))
pwd.getpwall, grp.getgrall = (lambda: comptes), (lambda: groupes)
with open(table, encoding="utf-8") as f:
    proprios = json.load(f)
vrai_fstat = os.fstat
def fstat(fd):
    st = vrai_fstat(fd)
    u, g = proprios.get(f"{st.st_dev}:{st.st_ino}", (st.st_uid, st.st_gid))
    return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, u, g, st.st_size,
                           int(st.st_atime), int(st.st_mtime), int(st.st_ctime)))
def changer(st, u, g):
    cle = f"{st.st_dev}:{st.st_ino}"
    vu = proprios.get(cle, (st.st_uid, st.st_gid))
    proprios[cle] = [vu[0] if u == -1 else u, vu[1] if g == -1 else g]
os.fstat, os.geteuid = fstat, (lambda: 0)
os.chown = lambda chemin, u, g, **_: changer(os.stat(chemin), u, g)
os.fchown = lambda fd, u, g: changer(vrai_fstat(fd), u, g)
sys.argv = sys.argv[1:]
try:
    runpy.run_path(sys.argv[0], run_name="__main__")
finally:
    with open(table, "w", encoding="utf-8") as f:
        json.dump(proprios, f)
'''
# Chaque appel de deploy/droits.py par poser_droits passe par FAUX_ROOT.
RACINE_SIMULEE = (TALONS + 'eval "$(declare -f poser_droits | sed \'s|python3 -I |FAUX_ETC="$SYS_PREFIXE/etc" python3 -I "$FAUX_RACINE" |\')"\n'
                  'declare -f poser_droits | grep -q FAUX_RACINE || exit 97\n')
DROITS_SEPARES = ('MODE_COMPTES=separes; chemins_separes; deplacer_memoire "$SANDBOX_DIR" "$(fixe APP_MEMORY_DIR)"\n'
                  'droits_separes "$ROOT/user_db" "$MOI" ""')
DROITS_UNIQUE = 'MODE_COMPTES=unique; chemins_separes; droits_unique "$ROOT/user_db" "$MOI" ""'
SANDBOX_UID = 10001
CLE = "a" * 40


def _table(depot: Path) -> Path:
    return depot.parent / "proprios.json"


def _noms(depot: Path, base: str) -> dict[int, str]:
    lignes = (_sys(depot) / "etc" / base).read_text(encoding="utf-8").splitlines()
    return {int(l.split(":")[2]): l.split(":")[0] for l in lignes if l}


def _proprio(depot: Path, p: Path) -> tuple[str, str]:
    """(compte, groupe) de P (sans suivre de lien) : ceux de la table, sinon ceux du disque."""
    st = os.lstat(p)
    u, g = json.loads(_table(depot).read_text(encoding="utf-8")).get(f"{st.st_dev}:{st.st_ino}", [st.st_uid, st.st_gid])
    return _noms(depot, "passwd").get(u, str(u)), _noms(depot, "group").get(g, str(g))


def _releve(depot: Path) -> dict[str, tuple]:
    """Mode, propriétaire et ctime de chaque entrée des sandboxes et de user_db (dossiers compris), sans suivre de lien."""
    entrees = [depot / "user_sandboxes", depot / "user_db"]
    for racine in list(entrees):
        for d, dossiers, fichiers in os.walk(racine):
            entrees += [Path(d) / n for n in dossiers + fichiers]
    return {str(p.relative_to(depot)): (os.lstat(p).st_mode, _proprio(depot, p), os.lstat(p).st_ctime_ns) for p in entrees}


def _bacs(depot: Path) -> Path:
    """Sandboxes d'un compte unique : celles de _etat, mémoire (et l'ancienne d'un autre compte), marqueurs (l'un à root), dossier de l'agent garni, instantanés (dossier de root), compte nommé « work », relais ouvert au groupe, cache d'aperçus, historique des fichiers, /work à l'UID du conteneur, deux liens plantés."""
    _etat(depot)
    sb = depot / "user_sandboxes"
    for d in ("alice/memory/scopes/abc", "bob/work", "bob/.memory", "work/work", "_snapshots/alice", "_snapshots/work",
              ".elpis-relay", f".office-cache/u/alice/{CLE}", ".supprime-3-1/memory", "../user_db/file_history/1"):
        (sb / d).mkdir(parents=True, exist_ok=True)
    for f in ("alice/memory/USER.md", "alice/memory/scopes/abc/MEMORY.md", "alice/.work-modes-v1", "alice/.work-migrated",
              "alice/.elpis-agent/browser-ca.crt", "bob/.memory/MEMORY.md", "work/.work-migrated", "work/work/w",
              "_snapshots/alice/1.tar.zst", "_snapshots/work/1.tar.zst", f".office-cache/u/alice/{CLE}/manifest.json",
              "bob/work/w", ".supprime-3-1/memory/USER.md", "../user_db/file_history/1/index.json"):
        (sb / f).write_text("x", encoding="utf-8")
        (sb / f).chmod(0o660)
    (sb / ".elpis-relay").chmod(0o2775)
    (sb / "alice/.elpis-agent/browser-ca.crt").chmod(0o644)
    dehors = depot.parent / "dehors"
    (dehors / "s").mkdir(parents=True)
    (sb / "alice/memory/lien").symlink_to(depot.parent / "cible")
    (sb / "bob/skills").symlink_to(dehors)
    proprios = {}
    for p in ("alice/work", "alice/work/projet", "alice/work/projet/f", "bob/work", "bob/work/w", "work/work", "work/work/w"):
        proprios[p] = [SANDBOX_UID, SANDBOX_UID]
    for p in ("alice/.work-migrated", "_snapshots"):
        proprios[p] = [0, 0]
    table = {f"{os.lstat(sb / p).st_dev}:{os.lstat(sb / p).st_ino}": v for p, v in proprios.items()}
    _table(depot).write_text(json.dumps(table), encoding="utf-8")
    (depot.parent / "faux_root.py").write_text(FAUX_ROOT, encoding="utf-8")
    return sb


def _aux_services(depot: Path, entrees: dict[str, str]) -> None:
    """Entrées des sandboxes laissées par un service (CHEMIN → compte) : propriétaire noté dans la table, groupe des données."""
    uids = {n: u for u, n in _noms(depot, "passwd").items()}
    gid = {n: g for g, n in _noms(depot, "group").items()}["elpis-donnees"]
    table = json.loads(_table(depot).read_text(encoding="utf-8"))
    for p, compte in entrees.items():
        st = os.lstat(depot / "user_sandboxes" / p)
        table[f"{st.st_dev}:{st.st_ino}"] = [uids[compte], gid]
    _table(depot).write_text(json.dumps(table), encoding="utf-8")


def _simule(depot: Path, corps: str):
    return _harnais(depot, corps, RACINE_SIMULEE, FAUX_RACINE=str(depot.parent / "faux_root.py"),
                    FAUX_PROPRIOS=str(_table(depot)))


def test_sandboxes_d_un_ancien_compte_donnees_a_l_hote_d_outils(depot):
    """Comptes créés par une installation sans root (modes seuls), puis l'étape des droits sous root, deux fois, puis le retour à un compte."""
    _unite_bloc4(depot)
    sb = _bacs(depot)
    mem = depot / "user_db/memoire"
    dehors, cible = depot.parent / "dehors", depot.parent / "cible"
    intacts = {p: (os.lstat(p).st_mode, os.lstat(p).st_ctime_ns) for p in (
        sb / "alice/work", sb / "alice/work/projet/f", sb / "bob/work/w", sb / "work/work/w", sb / "bob/skills",
        sb / "alice/.elpis-agent/browser-ca.crt", dehors, dehors / "s", cible)}
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0 and "Mémoire de alice déplacée" in r.stdout and "Mémoire de bob déplacée" in r.stdout, r.stderr
    _aux_services(depot, {"alice/skills": "elpis-main", "alice/skills/s.md": "elpis-main", "work/.work-migrated": "elpis-admin"})
    r = _simule(depot, DROITS_SEPARES)
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (sb / "alice/memory").exists() and not (sb / "bob/.memory").exists()
    assert (mem / "alice/memory/lien").is_symlink() and (mem / "bob/.memory/MEMORY.md").read_text(encoding="utf-8") == "x"
    assert (sb / ".supprime-3-1/memory/USER.md").exists()
    hote, donnees = "elpis-toolhost", "elpis-donnees"
    attendus = {"": (hote, donnees), "alice": (hote, donnees), "alice/.elpis-agent": (hote, donnees),
                "alice/.elpis-agent/browser-ca.crt": (MOI, GROUPE), "alice/.work-modes-v1": (hote, donnees),
                "alice/.work-migrated": ("root", "root"), "alice/skills": (hote, donnees), "alice/skills/s.md": (hote, donnees),
                "bob": (hote, donnees), "work": (hote, donnees), "work/.work-migrated": (hote, donnees),
                "_snapshots": (hote, donnees), "_snapshots/alice/1.tar.zst": (hote, donnees),
                "_snapshots/work/1.tar.zst": (hote, donnees), ".elpis-relay": (hote, donnees), ".supprime-3-1": (hote, donnees),
                f".office-cache/u/alice/{CLE}/manifest.json": (hote, donnees),
                "alice/work": (str(SANDBOX_UID), str(SANDBOX_UID)), "alice/work/projet/f": (str(SANDBOX_UID), str(SANDBOX_UID)),
                "bob/work/w": (str(SANDBOX_UID), str(SANDBOX_UID)), "work/work/w": (str(SANDBOX_UID), str(SANDBOX_UID)),
                "bob/skills": (MOI, GROUPE)}
    assert {p: _proprio(depot, sb / p) for p in attendus} == attendus
    modes = {"": "2750", "alice": "2750", "alice/.elpis-agent": "1777", "alice/.elpis-agent/browser-ca.crt": "644",
             "alice/.work-modes-v1": "640", "alice/skills/s.md": "640", "work": "2750", "_snapshots": "2750",
             "_snapshots/work": "2750", "_snapshots/work/1.tar.zst": "640", ".elpis-relay": "755", ".office-cache": "700",
             f".office-cache/u/alice/{CLE}": "700", f".office-cache/u/alice/{CLE}/manifest.json": "600"}
    assert {p: _mode(sb / p) for p in modes} == modes
    db = depot / "user_db"
    assert {p: (_mode(db / p), _proprio(depot, db / p)[0]) for p in ("file_history", "file_history/1", "file_history/1/index.json")} == {
        "file_history": ("700", hote), "file_history/1": ("700", hote), "file_history/1/index.json": ("600", hote)}
    assert {p: _mode(mem / p) for p in ("", "alice", "alice/memory", "alice/memory/USER.md")} == {
        "": "2770", "alice": "2770", "alice/memory": "2770", "alice/memory/USER.md": "660"}
    assert {p: (os.lstat(p).st_mode, os.lstat(p).st_ctime_ns) for p in intacts} == intacts
    assert _proprio(depot, cible) == (MOI, GROUPE) and _proprio(depot, dehors / "s") == (MOI, GROUPE)
    avant = _releve(depot)
    r = _simule(depot, DROITS_SEPARES)
    assert r.returncode == 0 and "Mémoire" not in r.stdout, r.stdout + r.stderr
    assert _releve(depot) == avant
    r = _simule(depot, DROITS_UNIQUE)
    assert r.returncode == 0, r.stdout + r.stderr
    for p in attendus:
        dans_work = p.split("/")[1:2] == ["work"] and not p.startswith("_snapshots")
        assert _proprio(depot, sb / p)[0] == (str(SANDBOX_UID) if dans_work else MOI), p
    assert _proprio(depot, sb / "alice/.elpis-agent") == (MOI, GROUPE) and _mode(sb / "alice/.elpis-agent") == "1777"
    assert _proprio(depot, db / "file_history/1/index.json")[0] == MOI
    assert {p: (os.lstat(p).st_mode, os.lstat(p).st_ctime_ns) for p in intacts} == intacts


def test_memoire_deplacee_sans_lien_suivi_ni_ecrasement(depot):
    sb, mem = depot / "user_sandboxes", depot / "user_db/memoire"
    for d in ("alice/memory", "bob/.memory", "carol/memory", "carol/.memory", "_snapshots/memory", "dan", "lien-ailleurs"):
        (sb / d).mkdir(parents=True)
    for f in ("alice/memory/USER.md", "bob/.memory/MEMORY.md", "carol/memory/USER.md", "carol/.memory/MEMORY.md"):
        (sb / f).write_text(f, encoding="utf-8")
    (mem / "carol/memory").mkdir(parents=True)
    (mem / "carol/memory/USER.md").write_text("déjà là", encoding="utf-8")
    cible = depot.parent / "cible"
    cible.mkdir()
    (sb / "dan/memory").symlink_to(cible)
    (sb / "eve").symlink_to(cible)
    r = _droits("memoire", str(sb), str(mem))
    assert r.returncode == 1, r.stdout + r.stderr
    assert (mem / "alice/memory/USER.md").read_text(encoding="utf-8") == "alice/memory/USER.md"
    assert (mem / "bob/.memory/MEMORY.md").read_text(encoding="utf-8") == "bob/.memory/MEMORY.md"
    assert (mem / "carol/memory/USER.md").read_text(encoding="utf-8") == "déjà là" and (sb / "carol/memory/USER.md").exists()
    assert (sb / "carol/.memory").exists() and not (mem / "carol/.memory").exists()
    assert f"{mem}/carol/memory existe déjà" in r.stderr and f"{sb}/dan/memory : lien ou fichier" in r.stderr
    assert (sb / "_snapshots/memory").exists() and not (mem / "_snapshots").exists() and not (mem / "eve").exists()
    assert list(cible.iterdir()) == [] and (sb / "dan/memory").is_symlink()
    assert _droits("memoire", str(depot / "absent"), str(mem)).returncode == 0


def test_memoire_deplacee_avant_le_demarrage_seulement_vers_le_defaut(depot):
    sb = depot / "user_sandboxes"
    (sb / "alice/memory").mkdir(parents=True)
    (sb / "alice/memory/USER.md").write_text("m", encoding="utf-8")
    corps = 'deplacer_memoire "$ROOT/user_sandboxes" "$ROOT/ailleurs"; deplacer_memoire "$ROOT/user_sandboxes" "$ROOT/user_db/memoire" "$MOI"'
    r = _harnais(depot, corps)
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (depot / "ailleurs").exists() and (depot / "user_db/memoire/alice/memory/USER.md").read_text(encoding="utf-8") == "m"
    assert any(l.startswith(f"runuser -u {MOI} -- python3 -I {depot}/deploy/droits.py memoire ") for l in _cs._trace(depot))


def test_memoire_dans_le_dossier_des_sandboxes_refusee_en_mode_separe(depot):
    node = _cs._executable(depot / "faux-node", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\nexit 0\n')
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8", "ELPIS_USER": MOI,
           "ELPIS_NODE": str(node)}
    lancer = lambda: subprocess.run(["bash", str(depot / "elpis"), "service", "print"], env=env, capture_output=True,  # noqa: E731
                                    text=True, timeout=120, cwd=str(depot), stdin=subprocess.DEVNULL)
    r = lancer()
    assert r.returncode == 0 and f"APP_MEMORY_DIR={depot}/user_db/memoire" in r.stdout, r.stderr
    (depot / ".env").write_text("APP_MEMORY_DIR=user_sandboxes/memoire\n", encoding="utf-8")
    (depot / ".env").chmod(0o600)
    r = lancer()
    assert r.returncode != 0 and f"APP_MEMORY_DIR ({depot}/user_sandboxes/memoire) est dans le dossier des sandboxes" in r.stderr


def test_motifs_relatifs_ancres_a_leur_profondeur(tmp_path):
    for d in ("memory", "a/memory/m", "a/b/memory", "work", "a/work", "a/b/work"):
        (tmp_path / d).mkdir(parents=True, exist_ok=True)
    fichiers = ("memory/f", "a/memory/m/f", "a/b/memory/f", "work/f", "a/work/f", "a/b/work/f", "a/autre")
    for f in fichiers:
        (tmp_path / f).write_text("f", encoding="utf-8")
        (tmp_path / f).chmod(0o600)
    r = _droits("arbre", str(tmp_path), "-", "0644", "-", "--regle", "-:-:0640:-:*/memory", "--sauf", "*/work")
    assert r.returncode == 0, r.stderr
    assert {f: _mode(tmp_path / f) for f in fichiers} == {
        "memory/f": "644", "a/memory/m/f": "640", "a/b/memory/f": "644", "work/f": "644", "a/work/f": "600",
        "a/b/work/f": "644", "a/autre": "644"}
    for motif in ("../x", "*/./memory", "a//memory", ""):
        r = _droits("arbre", str(tmp_path), "-", "-", "-", "--regle", f"-:-:0640:-:{motif}")
        assert r.returncode != 0 and "non compris" in r.stderr, motif
    r = _droits("arbre", str(tmp_path), "-", "-", "-", "--sauf", "a/../work")
    assert r.returncode != 0 and "non compris" in r.stderr
