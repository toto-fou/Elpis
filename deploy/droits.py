# SPDX-License-Identifier: MIT
"""deploy/droits.py — droits posés et secrets écrits par « sudo ./elpis service install » sans suivre de lien : entrée ouverte en O_PATH|O_NOFOLLOW sous le descripteur de son dossier, changée par ce descripteur si elle diffère."""
from __future__ import annotations

import contextlib
import fnmatch
import grp
import json
import os
import pwd
import re
import secrets
import stat
import sys

RACINE = os.geteuid() == 0
USAGE = """usage : droits.py arbre DOSSIER GROUPE FICHIERS DOSSIERS [--proprio COMPTE] [--comptes A,B] [--sauf MOTIF]...
                [--prive COMPTE:CHEMIN]...
          contenu de DOSSIER : GROUPE (et COMPTE), modes symboliques « g+rwX,o-rwx » (s : setgid des dossiers,
          « - » : inchangés ; setuid et setgid des fichiers toujours retirés) ; --comptes : entrées de ces comptes
          seulement ; --sauf : nom (motif) ou chemin absolu ni modifié ni parcouru ; --prive : chemin absolu et
          son contenu à COMPTE seul (go-rwx)
        droits.py fichiers DOSSIER PROPRIO GROUPE MODE MOTIF...
          fichiers ordinaires de DOSSIER nommés d'après un MOTIF : PROPRIO (« - » : gardé), GROUPE, MODE octal
        droits.py secret DOSSIER NOM
          secret aléatoire (ELPIS_ et 64 chiffres hexadécimaux, 0600) créé dans DOSSIER s'il manque ou fait moins de
          40 caractères ; un lien ou un fichier spécial à ce nom est refusé
        droits.py ranger BASE JETON
          secrets de l'objet JSON de l'entrée standard (deploy/configure.py --ranger-secrets) dans BASE/.session_secret,
          BASE/.encryption_key et JETON (0600) s'ils diffèrent ; un lien ou un fichier spécial est refusé
Hors de root : modes seulement. Fichier à plusieurs liens physiques : laissé, signalé. Code 1 au moindre refus."""
CLAUSE = re.compile(r"([ugo]+)([+-])([rwxXs]+)")


def modes(spec: str, mode: int, dossier: bool) -> int:
    """Mode après SPEC : octal exact, « - » (inchangé) ou clauses « g+rwX » (X : x des dossiers et des exécutables)."""
    if spec == "-":
        return mode
    if spec.isdigit():
        return int(spec, 8)
    for clause in spec.split(","):
        m = CLAUSE.fullmatch(clause)
        if m is None:
            raise SystemExit(f"droits.py : mode « {clause} » non compris")
        qui, op, droits = m.groups()
        bits = 0
        for q in qui:
            for d in droits:
                if d == "s":
                    bits |= {"u": stat.S_ISUID, "g": stat.S_ISGID}.get(q, 0) if dossier else 0
                elif d != "X" or dossier or mode & 0o111:
                    bits |= {"r": 4, "w": 2, "x": 1, "X": 1}[d] << {"u": 6, "g": 3, "o": 0}[q]
        mode = mode | bits if op == "+" else mode & ~bits
    return mode


def poser(dfd: int, nom: str, affiche: str, uid: int, gid: int, specs: tuple[str, str],
          comptes: set[int] | None, fichiers_seuls: bool = False) -> tuple[bool, bool]:
    """Entrée NOM du dossier DFD posée ; rend (réussi, à parcourir)."""
    try:
        fd = os.open(nom, os.O_PATH | os.O_NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return True, False
    try:
        st = os.fstat(fd)
        dossier = stat.S_ISDIR(st.st_mode)
        if not (stat.S_ISREG(st.st_mode) or (dossier and not fichiers_seuls)):
            return True, False
        if comptes is not None and st.st_uid not in comptes:
            return True, False
        if not dossier and st.st_nlink != 1:
            print(f"[warn ] {affiche} : plusieurs liens physiques, laissé tel quel (à vérifier).", file=sys.stderr)
            return False, False
        chemin = f"/proc/self/fd/{fd}"
        u, g = (st.st_uid if uid < 0 else uid), (st.st_gid if gid < 0 else gid)
        if RACINE and (u, g) != (st.st_uid, st.st_gid):
            os.chown(chemin, u, g)
        actuel = stat.S_IMODE(os.fstat(fd).st_mode)
        voulu = modes(specs[1] if dossier else specs[0], actuel, dossier) & (0o7777 if dossier else 0o1777)
        if voulu != actuel:
            os.chmod(chemin, voulu)
        return True, dossier
    except OSError as e:
        print(f"[warn ] {affiche} : {e.strerror} : droits non posés.", file=sys.stderr)
        return False, False
    finally:
        os.close(fd)


def ident(nom: str, base: type) -> int:
    """UID ou GID de NOM (« - » ou hors de root : -1, rien n'est changé)."""
    if nom == "-" or not RACINE:
        return -1
    return pwd.getpwnam(nom).pw_uid if base is pwd else grp.getgrnam(nom).gr_gid


def arbre(args: list[str]) -> bool:
    racine, groupe, spec_f, spec_d, *reste = args
    proprio, comptes, sauf, prives = "-", None, [], []
    while reste:
        option, valeur, *reste = reste
        if option == "--proprio":
            proprio = valeur
        elif option == "--prive":
            compte, _, chemin = valeur.partition(":")
            prives.append((os.path.normpath(chemin), ident(compte, pwd)))
        elif option == "--comptes":
            comptes = {pwd.getpwnam(c).pw_uid for c in valeur.replace(",", " ").split() if _existe(c)}
        elif option == "--sauf":
            sauf.append(os.path.normpath(valeur) if valeur.startswith("/") else valeur)
        else:
            raise SystemExit(USAGE)
    uid, gid, reussi = ident(proprio, pwd), ident(groupe, grp), True
    for chemin, dossiers, fichiers, dfd in os.fwalk(os.path.normpath(racine), follow_symlinks=False):
        for nom in list(dossiers) + fichiers:
            complet = os.path.join(chemin, nom)
            prive = next((u for c, u in prives if complet == c or complet.startswith(c + "/")), None)
            if any(complet == m if m.startswith("/") else fnmatch.fnmatchcase(nom, m) for m in sauf):
                parcourir = False
            elif prive is not None:
                ok, parcourir = poser(dfd, nom, complet, prive, gid, ("go-rwx", "go-rwxs"), None)
                reussi &= ok
            else:
                ok, parcourir = poser(dfd, nom, complet, uid, gid, (spec_f, spec_d), comptes)
                reussi &= ok
            if nom in dossiers and not parcourir:
                dossiers.remove(nom)
    return reussi


def fichiers(args: list[str]) -> bool:
    dossier, proprio, groupe, mode, *motifs = args
    try:
        dfd = os.open(dossier, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return True
    try:
        uid, gid, reussi = ident(proprio, pwd), ident(groupe, grp), True
        for nom in sorted(os.listdir(dfd)):
            if any(fnmatch.fnmatchcase(nom, m) for m in motifs):
                reussi &= poser(dfd, nom, os.path.join(dossier, nom), uid, gid, (mode, mode), None, True)[0]
        return reussi
    finally:
        os.close(dfd)


def _poser_texte(dossier: str, nom: str, texte_de) -> bool:
    """NOM de DOSSIER remplacé par texte_de(contenu actuel, None s'il manque) quand il rend un texte : temporaire au nom aléatoire (O_EXCL|O_NOFOLLOW, 0600) écrit, synchronisé, puis renommé ; lien ou fichier spécial : refusé, signalé."""
    dfd = os.open(dossier, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fd = os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        except FileNotFoundError:
            actuel = None
        except OSError:
            print(f"[warn ] {os.path.join(dossier, nom)} : lien ou fichier spécial, laissé (à vérifier).", file=sys.stderr)
            return False
        else:
            with os.fdopen(fd, "rb") as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    print(f"[warn ] {os.path.join(dossier, nom)} : fichier spécial, laissé (à vérifier).", file=sys.stderr)
                    return False
                actuel = f.read(65536).decode("utf-8", "replace")
        texte = texte_de(actuel)
        if texte is None:
            return True
        tmp = f".{nom}.{secrets.token_hex(8)}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(texte)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, nom, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp, dir_fd=dfd)
            raise
        return True
    finally:
        os.close(dfd)


def secret(args: list[str]) -> bool:
    dossier, nom = args
    return _poser_texte(dossier, nom, lambda a: None if a is not None and len(a.strip()) >= 40 else "ELPIS_" + secrets.token_hex(32))


def ranger(args: list[str]) -> bool:
    base, jeton = args
    valeurs = json.loads(sys.stdin.read() or "{}")
    cibles = {"app.session_secret": (base, ".session_secret"), "app.encryption_key": (base, ".encryption_key"),
              "rag.service_token": os.path.split(jeton)}
    reussi = True
    for cle, valeur in valeurs.items():
        if cle in cibles and isinstance(valeur, str) and valeur.strip():
            texte = valeur.strip() + "\n"
            try:
                reussi &= _poser_texte(*cibles[cle], lambda a, t=texte: None if a == t else t)
            except OSError as e:
                print(f"[warn ] {os.path.join(*cibles[cle])} : {e.strerror} : {cle} non écrit.", file=sys.stderr)
                reussi = False
    return reussi


def _existe(compte: str) -> bool:
    try:
        pwd.getpwnam(compte)
        return True
    except KeyError:
        return False


if __name__ == "__main__":
    commandes = {"arbre": (arbre, 4), "fichiers": (fichiers, 5), "secret": (secret, 2), "ranger": (ranger, 2)}
    if len(sys.argv) < 2 or sys.argv[1] not in commandes or len(sys.argv) - 2 < commandes[sys.argv[1]][1]:
        raise SystemExit(USAGE)
    sys.exit(0 if commandes[sys.argv[1]][0](sys.argv[2:]) else 1)
