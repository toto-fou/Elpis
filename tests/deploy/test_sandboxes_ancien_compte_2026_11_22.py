# SPDX-License-Identifier: MIT
"""tests/deploy/test_sandboxes_ancien_compte_2026_11_22.py — un compte par service : dossier des sandboxes à l'hôte d'outils seul (ce qu'un ancien compte unique ou les services y ont laissé compris, sans écriture du groupe, chaque /work et les liens intacts, dossier de l'agent sans son contenu, instantanés à part, un compte nommé « work » compris), historique des fichiers et cache des aperçus privés à l'hôte d'outils, mémoire déplacée dans user_db/memoire, second passage sans effet, retour au compte unique ; rôle de root simulé pour deploy/droits.py, propriétaires tenus dans une table."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import (
    GROUPE,
    INSTALLE_SEPARE,
    MOI,
    TALONS,
    TRACE_DROITS,
    _droits,
    _etat,
    _harnais,
    _mode,
    _sys,
    _trace,
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
    """Sandboxes d'un compte unique : celles de _etat (skills d'alice : le miroir de son magasin), mémoire (et l'ancienne d'un autre compte), ancien magasin de skills d'un compte sans magasin, marqueurs (l'un à root), dossier de l'agent garni, instantanés (dossier de root), compte nommé « work », relais ouvert au groupe (avec un « .elpis-agent »), verrous avec un « work », cache d'aperçus, historique des fichiers, cache des graphiques et verrous Office dans run/, /work à l'UID du conteneur, trois liens plantés (dont un /work)."""
    _etat(depot)
    sb = depot / "user_sandboxes"
    for d in ("alice/memory/scopes/abc", "bob/work", "bob/.memory", "work/work", "_snapshots/alice", "_snapshots/work",
              ".elpis-relay/.elpis-agent", ".write_locks/work", f".office-cache/u/alice/{CLE}", ".supprime-3-1/memory",
              "../user_db/file_history/1", "../user_db/run/charts/alice", "../user_db/run/office_locks", "dan/skills/s"):
        (sb / d).mkdir(parents=True, exist_ok=True)
    for f in ("alice/memory/USER.md", "alice/memory/scopes/abc/MEMORY.md", "alice/.work-modes-v1", "alice/.work-migrated",
              "alice/.elpis-agent/browser-ca.crt", "bob/.memory/MEMORY.md", "work/.work-migrated", "work/work/w",
              "_snapshots/alice/1.tar.zst", "_snapshots/work/1.tar.zst", f".office-cache/u/alice/{CLE}/manifest.json",
              "bob/work/w", ".supprime-3-1/memory/USER.md", "../user_db/file_history/1/index.json", ".write_locks/work/f",
              "../user_db/run/charts/alice/abc.json", "../user_db/run/office_locks/key-a.lock", "dan/skills/s/SKILL.md"):
        (sb / f).write_text("x", encoding="utf-8")
        (sb / f).chmod(0o660)
    for d in (".elpis-relay/.elpis-agent", ".write_locks/work", "../user_db/run/charts", "../user_db/run/charts/alice"):
        (sb / d).chmod(0o2770)
    (sb / ".elpis-relay").chmod(0o2775)
    (sb / "alice/.elpis-agent/browser-ca.crt").chmod(0o644)
    dehors = depot.parent / "dehors"
    (dehors / "s").mkdir(parents=True)
    (sb / "alice/memory/lien").symlink_to(depot.parent / "cible")
    (sb / "bob/skills").symlink_to(dehors)
    (sb / "eve").mkdir()
    (sb / "eve/work").symlink_to(dehors)
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
    assert (depot / "user_skills/dan/s/SKILL.md").read_text(encoding="utf-8") == "x" and not (sb / "dan/skills").exists()
    assert (sb / "alice/skills/s.md").exists() and (sb / "bob/skills").is_symlink()
    ecarte = [p for p in (sb / "eve").iterdir()]
    assert len(ecarte) == 1 and ecarte[0].name.startswith(".ecarte-") and ecarte[0].is_symlink() and not (sb / "eve/work").exists()
    assert "mis à part sous .ecarte-" in r.stderr
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
                "bob/skills": (MOI, GROUPE), ".write_locks/work/f": (hote, donnees), ".elpis-relay/.elpis-agent": (hote, donnees)}
    assert {p: _proprio(depot, sb / p) for p in attendus} == attendus
    modes = {"": "2750", "alice": "2750", "alice/.elpis-agent": "1707", "alice/.elpis-agent/browser-ca.crt": "644",
             "alice/.work-modes-v1": "640", "alice/skills/s.md": "640", "work": "2750", "_snapshots": "2750",
             "_snapshots/work": "2750", "_snapshots/work/1.tar.zst": "640", ".elpis-relay": "755", ".office-cache": "700",
             f".office-cache/u/alice/{CLE}": "700", f".office-cache/u/alice/{CLE}/manifest.json": "600",
             ".elpis-relay/.elpis-agent": "755", ".write_locks/work": "2750", ".write_locks/work/f": "640"}
    assert {p: _mode(sb / p) for p in modes} == modes
    db = depot / "user_db"
    assert {p: (_mode(db / p), _proprio(depot, db / p)[0]) for p in ("file_history", "file_history/1", "file_history/1/index.json")} == {
        "file_history": ("700", hote), "file_history/1": ("700", hote), "file_history/1/index.json": ("600", hote)}
    graphiques = ("run/charts", "run/charts/alice", "run/charts/alice/abc.json", "run/office_locks", "run/office_locks/key-a.lock")
    assert {p: (_mode(db / p), _proprio(depot, db / p)) for p in graphiques} == {
        "run/charts": ("2750", ("elpis-main", donnees)), "run/charts/alice": ("2750", ("elpis-main", donnees)),
        "run/charts/alice/abc.json": ("640", ("elpis-main", donnees)), "run/office_locks": ("700", (hote, donnees)),
        "run/office_locks/key-a.lock": ("600", (hote, donnees))}
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
        dans_work = p.split("/")[1:2] == ["work"] and not p.startswith(("_snapshots", "."))
        assert _proprio(depot, sb / p)[0] == (str(SANDBOX_UID) if dans_work else MOI), p
    assert _proprio(depot, sb / "alice/.elpis-agent") == (MOI, GROUPE) and _mode(sb / "alice/.elpis-agent") == "1707"
    assert _proprio(depot, db / "file_history/1/index.json")[0] == MOI
    assert [_proprio(depot, db / p)[0] for p in ("run/charts", "run/charts/alice/abc.json")] == [MOI, MOI]
    assert _mode(db / "run/charts") == "700"
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
    assert f"{mem}/carol/memory existe déjà" in r.stderr and f"Mémoire laissée dans {sb}/dan/memory (lien ou fichier, pas un dossier)" in r.stdout
    assert "dan/memory" not in r.stderr
    assert (sb / "_snapshots/memory").exists() and not (mem / "_snapshots").exists() and not (mem / "eve").exists()
    assert list(cible.iterdir()) == [] and (sb / "dan/memory").is_symlink()
    assert _droits("memoire", str(depot / "absent"), str(mem)).returncode == 0


def test_memoire_vers_une_destination_laissee_vide_ou_d_un_compte_en_tiret_bas(depot):
    sb, mem = depot / "user_sandboxes", depot / "user_db/memoire"
    for c in ("alice", "bob", "_x"):
        (sb / c / "memory").mkdir(parents=True)
        (sb / c / "memory/USER.md").write_text(c, encoding="utf-8")
    (mem / "alice/memory").mkdir(parents=True)
    (mem / "bob/memory").mkdir(parents=True)
    (mem / "bob/memory/.audit.jsonl").write_text("", encoding="utf-8")
    r = _droits("memoire", str(sb), str(mem))
    assert r.returncode == 1 and f"{mem}/bob/memory existe déjà" in r.stderr, r.stdout + r.stderr
    assert [(mem / c / "memory/USER.md").read_text(encoding="utf-8") for c in ("alice", "_x")] == ["alice", "_x"]
    assert not (sb / "alice/memory").exists() and not (sb / "_x/memory").exists()
    assert (sb / "bob/memory/USER.md").exists() and [p.name for p in (mem / "bob/memory").iterdir()] == [".audit.jsonl"]


def test_memoire_vers_un_autre_systeme_de_fichiers_destination_vide_gardee(tmp_path):
    ailleurs = Path("/dev/shm")
    if not ailleurs.is_dir() or os.stat(ailleurs).st_dev == os.stat(tmp_path).st_dev:
        pytest.skip("pas de second système de fichiers")
    mem = Path(tempfile.mkdtemp(dir=ailleurs))
    try:
        (tmp_path / "sb/alice/memory").mkdir(parents=True)
        (mem / "alice/memory").mkdir(parents=True)
        r = _droits("memoire", str(tmp_path / "sb"), str(mem))
        assert r.returncode == 1 and "autre système de fichiers" in r.stderr, r.stdout + r.stderr
        assert (mem / "alice/memory").is_dir() and (tmp_path / "sb/alice/memory").is_dir()
    finally:
        shutil.rmtree(mem)


def test_memoire_qu_un_service_peut_changer_deplacee_skills_laisses_avec_un_avis(depot):
    sb, mem, magasin = depot / "user_sandboxes", depot / "user_db/memoire", depot / "user_skills"
    for d in ("alice/memory", "bob/memory", "carol/skills/s"):
        (sb / d).mkdir(parents=True)
    (sb / "bob/memory").chmod(0o777)
    services = {**os.environ, "ELPIS_DROITS_SERVICES": MOI}
    lancer = lambda *a: subprocess.run(["python3", "-I", str(_cs.REPO / "deploy/droits.py"), *a],  # noqa: E731
                                       capture_output=True, text=True, timeout=60, env=services)
    r = lancer("memoire", str(sb), str(mem), MOI, GROUPE, MOI)
    assert r.returncode == 0 and "Mémoire de bob déplacée" in r.stdout, r.stdout + r.stderr
    assert (mem / "alice/memory").is_dir() and not (sb / "bob/memory").exists() and _mode(mem / "bob/memory") == "2770"
    r = lancer("skills", str(sb), str(magasin))
    assert r.returncode == 0 and r.stderr == "", r.stdout + r.stderr
    assert f"Skills laissés dans {sb}/carol/skills (dossier qu'un service peut modifier, ou qui n'est pas un compte)" in r.stdout
    assert (sb / "carol/skills/s").is_dir() and not (magasin / "carol").exists()


def test_skills_d_avant_le_magasin_repris_sans_suivre_de_lien(tmp_path):
    sb, magasin, dehors = tmp_path / "sb", tmp_path / "user_skills", tmp_path / "dehors"
    for d in ("alice/skills/s", "bob/skills/s", "carol", "_snapshots/skills", ".supprime-1-2/skills", "dan"):
        (sb / d).mkdir(parents=True)
    (sb / "alice/skills/s/SKILL.md").write_text("a", encoding="utf-8")
    (magasin / "bob").mkdir(parents=True)
    dehors.mkdir()
    (sb / "carol/skills").symlink_to(dehors)
    r = _droits("skills", str(sb), str(magasin))
    assert r.returncode == 0 and f"Skills laissés dans {sb}/carol/skills (lien ou fichier, pas un dossier)" in r.stdout, r.stdout + r.stderr
    assert (magasin / "alice/s/SKILL.md").read_text(encoding="utf-8") == "a" and not (sb / "alice/skills").exists()
    assert (sb / "bob/skills/s").is_dir() and list((magasin / "bob").iterdir()) == []
    assert (sb / "carol/skills").is_symlink() and list(dehors.iterdir()) == []
    assert (sb / "_snapshots/skills").is_dir() and (sb / ".supprime-1-2/skills").is_dir()
    assert sorted(p.name for p in magasin.iterdir()) == ["alice", "bob"]


def test_entrees_qui_ne_sont_pas_des_dossiers_mises_a_part_sans_etre_suivies(tmp_path):
    sb, dehors = tmp_path / "sb", tmp_path / "dehors"
    for d in ("alice", "bob/work", ".supprime-3-1", "_snapshots/bob/sous", "_snapshots/alice", ".write_locks", "frank"):
        (sb / d).mkdir(parents=True)
    (sb / "_snapshots/bob/b.json").write_text("{}", encoding="utf-8")
    dehors.mkdir()
    (dehors / "f").write_text("intact", encoding="utf-8")
    (sb / "alice/work").symlink_to(dehors)
    (sb / "alice/.elpis-agent").write_text("fichier", encoding="utf-8")
    (sb / "carol").symlink_to(sb / "bob")
    (sb / "note").write_text("n", encoding="utf-8")
    long = "é" * 120
    (sb / long).write_text("l", encoding="utf-8")
    (sb / ".elpis-relay").symlink_to(dehors)
    for d in (".supprime-3-1/work", "_snapshots/work", ".write_locks/work", "frank/work"):
        (sb / d).symlink_to(dehors)
    (sb / "_snapshots/carol").symlink_to("bob")
    (sb / "_snapshots/alice/aaaa.json").symlink_to("../bob/b.json")
    (sb / "_snapshots/alice/.elpis_restore_incomplete").symlink_to("../../../dehors/f")
    (sb / "frank").chmod(0o555)
    try:
        r = _droits("ecarter", str(sb))
    finally:
        (sb / "frank").chmod(0o755)
    assert r.returncode == 1 and f"{sb}/frank/work" in r.stderr and "refusé" in r.stderr, r.stdout + r.stderr
    a_part = lambda d: {p.name.split("-", 3)[3]: p for p in d.iterdir() if p.name.startswith(".ecarte-")}  # noqa: E731
    racine, alice, instantanes = a_part(sb), a_part(sb / "alice"), a_part(sb / "_snapshots")
    assert sorted(racine) == [".elpis-relay", "carol", "note", long[:115]] and sorted(alice) == [".elpis-agent", "work"]
    assert all(len(os.fsencode(p.name)) <= 255 for p in racine.values()) and not (sb / long).exists()
    assert [racine[n].is_symlink() for n in (".elpis-relay", "carol", "note")] == [True, True, False]
    assert alice["work"].is_symlink() and alice[".elpis-agent"].read_text(encoding="utf-8") == "fichier"
    assert sorted(a_part(sb / ".supprime-3-1")) == ["work"] and not (sb / "carol").exists() and not (sb / "alice/work").exists()
    assert sorted(instantanes) == ["carol", "work"] and instantanes["carol"].is_symlink() and (sb / "_snapshots/bob").is_dir()
    assert sorted(a_part(sb / "_snapshots/alice")) == [".elpis_restore_incomplete", "aaaa.json"]
    assert sorted(p.name for p in (sb / "_snapshots/bob").iterdir()) == ["b.json", "sous"]
    assert (sb / ".write_locks/work").is_symlink() and (sb / "bob/work").is_dir() and (sb / "frank/work").is_symlink()
    assert (dehors / "f").read_text(encoding="utf-8") == "intact" and r.stderr.count("mis à part sous .ecarte-") == 11
    (sb / "frank/work").unlink()
    avant = sorted(str(p.relative_to(sb)) for p in sb.rglob("*"))
    r = _droits("ecarter", str(sb))
    assert r.returncode == 0 and r.stderr == "" and sorted(str(p.relative_to(sb)) for p in sb.rglob("*")) == avant


def test_start_deplace_la_memoire_seulement_main_et_console_arretes(depot):
    sb = depot / "user_sandboxes"
    (sb / "alice/memory").mkdir(parents=True)
    (sb / "alice/memory/USER.md").write_text("m", encoding="utf-8")
    talons = ('refuser_racine_separee() { :; }; systemd_active() { return 1; }; need_core() { :; }; migrer_mcp() { :; }\n'
              'load_runtime() { SANDBOX_DIR="$ROOT/user_sandboxes"; }; attendre_sante() { :; }; cmd_status() { :; }\n'
              'core_cmd() { [ "$*" != "config MEMORY_DIR" ] || echo "$ROOT/user_db/memoire"; }; _https_enabled() { :; }; SERVICES=()\n')
    r = _harnais(depot, talons + 'pid_of() { [ "$1" = admin ] && echo 4242; }\ncmd_start')
    assert r.returncode == 0 and (sb / "alice/memory/USER.md").exists(), r.stdout + r.stderr
    r = _harnais(depot, talons + 'pid_of() { return 1; }\ncmd_start')
    assert r.returncode == 0, r.stdout + r.stderr
    assert (depot / "user_db/memoire/alice/memory/USER.md").read_text(encoding="utf-8") == "m"
    assert not (sb / "alice/memory").exists() and "Mémoire de alice déplacée" in r.stdout


def test_mise_a_jour_sous_systemd_compte_unique_memoire_deplacee_services_arretes(depot):
    sb = depot / "user_sandboxes"
    (sb / "alice/memory").mkdir(parents=True)
    (sb / "alice/memory/USER.md").write_text("m", encoding="utf-8")
    _unite_bloc4(depot)
    corps = ('sudo() { trace "$*"; [ ! -e "$ROOT/user_db/memoire/alice/memory" ] || trace "mémoire déplacée"; }\n'
             'core_cmd() { [ "$*" != "config MEMORY_DIR" ] || echo "$ROOT/user_db/memoire"; }\n'
             'SANDBOX_DIR="$ROOT/user_sandboxes"; relancer_unites')
    r = _harnais(depot, corps)
    assert r.returncode == 0, r.stdout + r.stderr
    t = _trace(depot)
    arret, depart = t.index("systemctl stop elpis.target"), t.index("systemctl start elpis.target")
    deplace = next(i for i, l in enumerate(t) if l.startswith(f"runuser -u {MOI} -- python3 -I ") and " memoire " in l)
    assert arret < deplace < depart and t[depart + 1:] == ["mémoire déplacée"], t
    (_sys(depot) / "etc/trace").write_text("", encoding="utf-8")
    (_sys(depot) / "etc/systemd/system/elpis-main.service").write_text('[Service]\nEnvironment="ELPIS_COMPTES=separes"\n',
                                                                       encoding="utf-8")
    assert _harnais(depot, corps).returncode == 0 and _trace(depot) == ["systemctl restart elpis.target", "mémoire déplacée"]


def test_mise_a_jour_lancee_par_un_autre_compte_que_les_unites_laisse_la_memoire(depot):
    sb = depot / "user_sandboxes"
    (sb / "alice/memory").mkdir(parents=True)
    (sb / "alice/memory/USER.md").write_text("m", encoding="utf-8")
    _unite_bloc4(depot)
    base = ('sudo() { trace "$*"; }\ncore_cmd() { [ "$*" != "config MEMORY_DIR" ] || echo "$ROOT/user_db/memoire"; }\n'
            'SANDBOX_DIR="$ROOT/user_sandboxes"\n')
    r = _harnais(depot, base + 'id() { case "$*" in -u) echo 1234 ;; -un) echo autre ;; *) command id "$@" ;; esac; }\nrelancer_unites')
    assert r.returncode == 0 and _trace(depot) == ["systemctl stop elpis.target", "systemctl start elpis.target"], r.stderr
    assert (sb / "alice/memory/USER.md").exists() and not (depot / "user_db/memoire/alice").exists()
    r = _harnais(depot, base + f'id() {{ case "$*" in -u) echo 1234 ;; -un) echo {MOI} ;; *) command id "$@" ;; esac; }}\n'
                 'relancer_unites')
    assert r.returncode == 0 and (depot / "user_db/memoire/alice/memory/USER.md").exists(), r.stdout + r.stderr


def test_memoire_d_une_installation_separee_d_avant_rendue_a_main(depot):
    """Unités d'avant le dossier de la mémoire : SANDBOXES/<compte>/memory à main, ouverte au groupe des données (et une autre à l'hôte d'outils) ; déplacée et donnée à main, jamais laissée à un autre service."""
    _unite_bloc4(depot)
    _etat(depot)
    assert _harnais(depot, INSTALLE_SEPARE).returncode == 0
    sb, mem = depot / "user_sandboxes", depot / "user_db/memoire"
    for d in ("alice/memory/scopes", "bob/memory"):
        (sb / d).mkdir(parents=True)
    for f in ("alice/memory/USER.md", "alice/memory/scopes/MEMORY.md", "bob/memory/USER.md", "bob/memory/root.md"):
        (sb / f).write_text("m", encoding="utf-8")
        (sb / f).chmod(0o660)
    for d in ("alice/memory", "alice/memory/scopes", "bob/memory"):
        (sb / d).chmod(0o2770)
    _table(depot).write_text("{}", encoding="utf-8")
    (depot.parent / "faux_root.py").write_text(FAUX_ROOT, encoding="utf-8")
    _aux_services(depot, {"alice/memory": "elpis-main", "alice/memory/USER.md": "elpis-main",
                          "alice/memory/scopes": "elpis-main", "bob/memory": "elpis-toolhost", "bob/memory/USER.md": "elpis-toolhost"})
    table = json.loads(_table(depot).read_text(encoding="utf-8"))
    st = os.lstat(sb / "bob/memory/root.md")
    table[f"{st.st_dev}:{st.st_ino}"] = [0, 0]
    _table(depot).write_text(json.dumps(table), encoding="utf-8")
    r = _simule(depot, 'MODE_COMPTES=separes; chemins_separes; deplacer_memoire "$SANDBOX_DIR" "$(fixe APP_MEMORY_DIR)" "" "$MOI"')
    assert r.returncode == 0 and "Mémoire de alice déplacée" in r.stdout and "Mémoire de bob déplacée" in r.stdout, r.stderr
    assert f"{mem}/bob/memory/root.md : à un autre compte (uid 0), laissé tel quel" in r.stderr
    assert _proprio(depot, mem / "bob/memory/root.md") == ("root", "root")
    assert not (sb / "alice/memory").exists() and not (sb / "bob/memory").exists()
    rendus = ("alice/memory", "alice/memory/USER.md", "alice/memory/scopes", "alice/memory/scopes/MEMORY.md",
              "bob/memory", "bob/memory/USER.md")
    assert {p: _proprio(depot, mem / p) for p in rendus} == dict.fromkeys(rendus, ("elpis-main", "elpis-donnees"))
    assert {p: _mode(mem / p) for p in rendus} == {"alice/memory": "2770", "alice/memory/USER.md": "660",
                                                  "alice/memory/scopes": "2770", "alice/memory/scopes/MEMORY.md": "660",
                                                  "bob/memory": "2770", "bob/memory/USER.md": "660"}


def test_conteneurs_des_sandboxes_arretes_a_l_installation_separee(depot):
    _unite_bloc4(depot)
    _etat(depot)
    sb = depot / "user_sandboxes"
    a, b, c, d, e, f = ("a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64, "f" * 64)
    docker = ('docker() {\n    trace "docker $*"\n    case "$1" in\n'
              f'        ps) printf "%s\\n" {a} zz {b} {c} {d} {e} {f} ;;\n'
              f'        inspect) case "${{*: -1}}" in {a}) echo "$SANDBOX_DIR/alice/work" ;; {b}) echo /ailleurs/work ;;\n'
              f'            {c}) echo "$SANDBOX_DIR/../etc/work" ;; {d}) printf "%s\\n%s\\n" "$SANDBOX_DIR/x/work" "$SANDBOX_DIR/y/work" ;;\n'
              f'            {e}) echo "$SANDBOX_DIR/./bob/work" ;; {f}) echo "$SANDBOX_DIR/carol/work" ;; esac ;;\n'
              f'        stop) [ "${{*: -1}}" != {f} ] ;;\n'
              '        kill) return 1 ;;\n'
              '    esac\n}\n')
    r = _harnais(depot, docker + 'SANDBOX_DIR="$ROOT/user_sandboxes"; arreter_conteneurs_bacs "$SANDBOX_DIR"; echo "rc=$?"')
    assert "rc=1" in r.stdout and "1 conteneur(s) de sandbox arrêté(s)" in r.stdout, r.stdout + r.stderr
    assert f"Conteneur de sandbox {f[:12]} non arrêté" in r.stderr
    actes = [l for l in _trace(depot) if l.startswith(("docker stop", "docker kill", "docker rm"))]
    assert actes == [f"docker stop -t 10 {a}", f"docker stop -t 10 {f}", f"docker kill {f}"], actes
    assert "docker ps -q --no-trunc --filter label=elpis.user_id" in _trace(depot)
    r = _harnais(depot, 'arreter_conteneurs_bacs() { trace "arreter $*"; return 1; }\n' + INSTALLE_SEPARE)
    assert r.returncode == 0 and f"arreter {sb}" in _trace(depot), r.stdout + r.stderr
    assert "Conteneurs des sandboxes pas tous arrêtés" in r.stderr


def test_retour_au_compte_unique_rend_aussi_les_dossiers_hors_du_depot(depot):
    _etat(depot)
    hist, office = depot.parent / "historique", depot.parent / "apercus"
    for d in (hist, office):
        d.mkdir()
        d.chmod(0o700)
    r = _harnais(depot, 'rendre_dossiers_separes "$MOI" ""', TALONS + TRACE_DROITS, APP_FILE_HISTORY_DIR=str(hist),
                 APP_OFFICE_CACHE_DIR=str(office))
    assert r.returncode == 0, r.stdout + r.stderr
    for d in (hist, office):
        assert any(l.startswith(f"droits dossier {d} 00700 {MOI} ") for l in _trace(depot)), _trace(depot)


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
