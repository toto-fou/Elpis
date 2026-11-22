# SPDX-License-Identifier: MIT
"""deploy/droits.py — droits posés et secrets écrits par root (« sudo ./elpis service install ») sans suivre de lien : dossier ouvert composant par composant depuis « / », entrées changées par descripteur."""
from __future__ import annotations

import base64
import contextlib
import errno
import fnmatch
import grp
import json
import os
import pwd
import re
import secrets
import signal
import stat
import subprocess
import sys
import time

RACINE = os.geteuid() == 0
USAGE = """usage : droits.py arbre DOSSIER GROUPE FICHIERS DOSSIERS [--proprio COMPTE] [--comptes A,B] [--comptes-dossiers A,B]
                [--sauf MOTIF]... [--prive COMPTE:CHEMIN]... [--regle COMPTE:GROUPE:FICHIERS:DOSSIERS:CHEMIN]... [--sous BASE]
          contenu de DOSSIER (sans franchir de point de montage) : GROUPE (et COMPTE), modes symboliques « g+rwX,o-rwx »
          (s : setgid des dossiers, « - » : inchangés ; setuid et setgid des fichiers toujours retirés) ; --comptes : entrées
          de ces comptes seulement (--comptes-dossiers : dossiers seulement) ; une entrée de root n'est donnée à un autre
          compte qu'avec --avec-root ou root dans --comptes ; --sauf : nom (motif) ou chemin absolu ni modifié ni parcouru ; --prive :
          chemin absolu et son contenu à COMPTE seul (go-rwx) ; --regle : chemin absolu et son contenu à COMPTE (« - » :
          gardé) et GROUPE, en FICHIERS et DOSSIERS
        droits.py dossier CHEMIN MODE PROPRIO GROUPE [--admis A,B] [--creer] [--sous BASE] [--groupe-racine G]
          dossier CHEMIN (créé s'il manque avec --creer) mis à PROPRIO:GROUPE en MODE ; refusé si c'est un lien, s'il
          appartient à un compte hors de root, PROPRIO et --admis, s'il est à root sans le groupe G, ou à root, non vide
          et à céder sous un parent ouvert en écriture (sauf parent de PROPRIO que nul autre ne peut écrire)
        droits.py fichiers DOSSIER PROPRIO GROUPE MODE MOTIF... [--comptes A,B] [--avec-root]
          fichiers ordinaires de DOSSIER nommés d'après un MOTIF : PROPRIO (« - » : gardé), GROUPE, MODE octal
        droits.py secret DOSSIER NOM
          secret aléatoire (ELPIS_ et 64 chiffres hexadécimaux, 0600) créé dans DOSSIER s'il manque ou fait moins de
          40 caractères ; un lien ou un fichier spécial à ce nom est refusé
        droits.py ranger BASE JETON [--magasin MAGASIN]
          secrets de l'objet JSON de l'entrée standard (deploy/configure.py --ranger-secrets --garder) dans
          BASE/.session_secret, BASE/.encryption_key et JETON (0600) s'ils diffèrent, ou avec --magasin, secret de session,
          clé de chiffrement, jeton du RAG et clé d'API de Qdrant (sans fichier : laissée sinon) en clés de systemd ; un lien ou un fichier spécial est refusé ; sortie : les clés de
          config.json à retirer (écrites, ou sans valeur retenue), une par ligne
        droits.py reprendre DOSSIER NOM COMPTE CIBLE
          contenu de DOSSIER/NOM, fichier ordinaire de COMPTE à un seul lien que nul autre ne peut écrire, écrit dans
          CIBLE (0600), puis NOM retiré ; code 2 si NOM est refusé
        droits.py retirer DOSSIER NOM...
          fichiers NOM de DOSSIER retirés (dossier atteint sans suivre de lien)
        droits.py sur FICHIER [--proprio A,B]
          code 0 si FICHIER manque, ou est un fichier ordinaire à un seul lien, à l'un des comptes, qu'aucun compte des
          services ne peut écrire ni remplacer
        droits.py pid DOSSIER NOM
          numéro de processus du fichier NOM de DOSSIER (fichier ordinaire, chiffres seuls), lu sans suivre de lien ni
          attendre ; code 1 sinon
        droits.py filtre [--tui]
          entrée standard recopiée sur la sortie, en une passe : séquences OSC, DCS, APC, PM et SOS, C1 (UTF-8 ou bruts)
          retirés, autres caractères de contrôle remplacés par « ? » ; sans --tui, séquences d'échappement retirées
          sauf les couleurs (CSI … m) ; --tui : CSI gardées (écran de l'assistant)
        droits.py journal [--suivre] [--lignes N] FICHIER...
          N (50) dernières lignes de chaque FICHIER (1 Mio au plus), lu sans suivre de lien ni attendre, fichier
          ordinaire seulement, filtré comme « filtre » ; --suivre : la suite, fichier rouvert de même s'il est remplacé
        droits.py mdp-base DOSSIER NOM PROPRIO [--admis COMPTE]...
          mot de passe de la base locale (48 chiffres hexadécimaux) écrit sur la sortie : lu sans suivre de lien dans un
          fichier ordinaire à un seul lien de PROPRIO, de root ou d'un compte admis, ou créé (0600, à PROPRIO) s'il manque
          ou est vide ; autre contenu : refusé
        droits.py cle MAGASIN NOM [--source FICHIER] [--proprio A,B] [--min N] [--creer GENRE] [--source-gagne] [--copie]
          clé NOM du magasin de systemd (systemd-creds encrypt --name=NOM --with-key=auto, clair par un tube, 0600 root,
          déchiffrée et comparée avant d'être renommée) : reprise de FICHIER (fichier ordinaire à un seul lien d'un des
          comptes, sans écriture d'autrui, N caractères au moins), qui est retiré ensuite ; FICHIER différent d'une clé en
          service : laissés tous deux (sauf --source-gagne) ; sinon clé gardée, sinon créée sans FICHIER refusé (GENRE :
          coffre, fernet, session, journal, jeton, qdrant) ; --copie : commande de copie hors de la machine affichée quand la clé change
        droits.py cle-rendre MAGASIN NOM CIBLE PROPRIO GROUPE MODE [--remplacer]
          clé NOM déchiffrée dans CIBLE (temporaire exclusif, PROPRIO:GROUPE, MODE octal) si CIBLE manque ou est la même,
          relue, puis retirée du magasin ; CIBLE « - » : clé retirée seulement ; CIBLE différente : laissées toutes deux
          (--remplacer : CIBLE remplacée par la clé en service, signalé)
        droits.py cle-etat MAGASIN NOM...
          une ligne par clé : « NOM ok LONGUEUR », « NOM absent » ou « NOM illisible » (jamais le contenu)
        droits.py copier FICHIER DOSSIER NOM [--proprio A,B]
          FICHIER (fichier ordinaire à un seul lien d'un des comptes, 4 Kio au plus), lu sans suivre de lien, recopié dans
          DOSSIER/NOM (0600, création exclusive)
Comptes des services : ELPIS_DROITS_SERVICES (et groupes en plus : ELPIS_DROITS_GROUPES) ; tout dossier au-dessus
d'un dossier traité (au-dessus de BASE avec --sous) doit leur être fermé en écriture (sticky bit : entrée suivante
hors de leurs comptes). Hors de root : modes seulement. Fichier à plusieurs liens physiques : laissé, signalé.
Code 1 au moindre refus."""
CLAUSE = re.compile(r"([ugo]+)([+-])([rwxXs]+)")


MDP_BASE = re.compile(r"[0-9a-f]{48}")
NOM_CLE = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}")
# Secrets de config.json rangés en clés de systemd (ranger --magasin) ; les autres vont à leurs fichiers.
VERS_CLES = {"app.session_secret": "session.secret", "app.encryption_key": "encryption.key", "rag.service_token": "rag.token",
             "rag.qdrant_api_key": "qdrant.key"}
SECRETS_CONFIG = ("app.session_secret", "app.encryption_key", "rag.service_token", "rag.qdrant_api_key")


class Refus(Exception):
    """Chemin refusé (lien, dossier ouvert aux services, point de montage d'un service…) ; le message dit pourquoi."""


def _dire(*textes: object, file=None) -> None:
    """print sans caractère de contrôle (C0 sauf tabulation, DEL, C1, fins de ligne des noms) : un nom choisi par un service n'ajoute ni ligne ni séquence au terminal ou au journal."""
    texte = " ".join(map(str, textes))
    print("".join(c if c == "\t" or c.isprintable() else "?" for c in texte), file=file)


def _uids(noms: str) -> set[int]:
    vus = set()
    for nom in noms.replace(",", " ").split():
        with contextlib.suppress(KeyError):
            vus.add(pwd.getpwnam(nom).pw_uid)
    return vus


def _services() -> tuple[set[int], set[int]]:
    """UID des comptes des services et GID de leurs groupes (primaires, membres, ELPIS_DROITS_GROUPES)."""
    noms = os.environ.get("ELPIS_DROITS_SERVICES", "").replace(",", " ").split()
    uids, gids = set(), set()
    for nom in noms:
        with contextlib.suppress(KeyError):
            p = pwd.getpwnam(nom)
            uids.add(p.pw_uid)
            gids.add(p.pw_gid)
    for g in grp.getgrall():
        if any(m in noms for m in g.gr_mem):
            gids.add(g.gr_gid)
    for nom in os.environ.get("ELPIS_DROITS_GROUPES", "").replace(",", " ").split():
        with contextlib.suppress(KeyError):
            gids.add(grp.getgrnam(nom).gr_gid)
    return uids, gids


UIDS_SERVICES, GIDS_SERVICES = _services()


def ecrivable_par_services(st: os.stat_result) -> bool:
    """Vrai si un compte des services peut changer cette entrée : propriétaire, écriture de son groupe, ou de tous."""
    return (st.st_uid in UIDS_SERVICES or bool(st.st_mode & 0o020 and st.st_gid in GIDS_SERVICES)
            or bool(st.st_mode & 0o002))


def a_lui_seul(st: os.stat_result, nom: str) -> bool:
    """Vrai si seul le compte NOM peut écrire ce dossier : à lui, fermé aux autres, son groupe privé (sans autre compte) s'il l'écrit."""
    try:
        p, g = pwd.getpwnam(nom), grp.getgrgid(st.st_gid)
    except KeyError:
        return False
    prive = st.st_gid == p.pw_gid and set(g.gr_mem) <= {nom} and not any(
        q.pw_gid == st.st_gid and q.pw_name != nom for q in pwd.getpwall())
    return st.st_uid == p.pw_uid and not st.st_mode & 0o002 and (not st.st_mode & 0o020 or prive)


def _net(chemin: str) -> str:
    """CHEMIN sans « / » final ni double (« . » et « .. » restent : refusés à l'ouverture)."""
    return "/" + "/".join(p for p in chemin.split("/") if p) if chemin.startswith("/") else chemin


def _sous(chemin: str, base: str | None) -> bool:
    return base is not None and (chemin == base or chemin.startswith(base.rstrip("/") + "/"))


def _ouvrir(chemin: str, strict: bool, sous: str | None, creer: int | None) -> tuple[int, os.stat_result]:
    """(fd O_PATH du dossier CHEMIN, état de son parent), ouvert composant par composant depuis « / » sans suivre de lien."""
    if not chemin.startswith("/") or "\0" in chemin or any(p in (".", "..") for p in chemin.split("/")):
        raise Refus("chemin relatif, avec . ou ..")
    fd = os.open("/", os.O_PATH | os.O_DIRECTORY)
    st_parent = st = os.fstat(fd)
    courant = "/"
    try:
        parties = [p for p in chemin.split("/") if p]
        for i, nom in enumerate(parties):
            ici = os.path.join(courant, nom)
            try:
                try:
                    nfd = os.open(nom, os.O_PATH | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=fd)
                except FileNotFoundError:
                    if creer is None or i < len(parties) - 1:
                        raise
                    os.mkdir(nom, creer, dir_fd=fd)
                    _dire(f"[elpis] Dossier {chemin} créé.")
                    nfd = os.open(nom, os.O_PATH | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=fd)
            except NotADirectoryError:
                raise Refus(f"{ici} : lien symbolique ou fichier") from None
            except OSError as e:
                if e.errno == errno.ELOOP:
                    raise Refus(f"{ici} : lien symbolique") from None
                raise
            st = os.fstat(nfd)
            refus = ""
            if strict and not _sous(courant, sous) and ecrivable_par_services(st_parent) and not (
                    st_parent.st_mode & stat.S_ISVTX and st_parent.st_uid not in UIDS_SERVICES
                    and st.st_uid not in UIDS_SERVICES):
                refus = f"{courant} modifiable par un compte des services"
            elif st.st_dev != st_parent.st_dev and st.st_uid in UIDS_SERVICES:
                refus = f"{ici} : point de montage d'un compte des services"
            if refus:
                os.close(nfd)
                raise Refus(refus)
            os.close(fd)
            fd, courant = nfd, ici
            if i < len(parties) - 1:
                st_parent = st
        return fd, st_parent
    except BaseException:
        os.close(fd)
        raise


def ouvrir_dossier(chemin: str, *, strict: bool = True, sous: str | None = None, creer: int | None = None) -> int:
    """fd O_PATH du dossier CHEMIN ouvert sans suivre de lien ; strict : composant remplaçable par un compte des services (au-dessus de SOUS) refusé ; creer : mode du dossier final s'il manque."""
    return _ouvrir(chemin, strict, sous, creer)[0]


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
          comptes: set[int] | None, fichiers_seuls: bool = False, dev: int | None = None,
          comptes_dossiers: frozenset[int] = frozenset(), ceder_root: bool = False) -> tuple[bool, bool]:
    """Entrée NOM du dossier DFD posée (sur le périphérique DEV seulement, entrées des COMPTES seulement, une entrée de root cédée à UID avec CEDER_ROOT seulement) ; rend (réussi, à parcourir)."""
    try:
        fd = os.open(nom, os.O_PATH | os.O_NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return True, False
    try:
        st = os.fstat(fd)
        dossier = stat.S_ISDIR(st.st_mode)
        if not (stat.S_ISREG(st.st_mode) or (dossier and not fichiers_seuls)):
            return True, False
        if dev is not None and st.st_dev != dev:
            _dire(f"[warn ] {affiche} : autre système de fichiers, laissé tel quel (à vérifier).", file=sys.stderr)
            return True, False
        if comptes is not None and st.st_uid not in comptes and not (dossier and st.st_uid in comptes_dossiers):
            return True, dossier
        if not dossier and st.st_nlink != 1:
            _dire(f"[warn ] {affiche} : plusieurs liens physiques, laissé tel quel (à vérifier).", file=sys.stderr)
            return False, False
        chemin = f"/proc/self/fd/{fd}"
        u = st.st_uid if uid < 0 or (st.st_uid == 0 and not (ceder_root or (dossier and 0 in comptes_dossiers))) else uid
        g = st.st_gid if gid < 0 else gid
        if RACINE and (u, g) != (st.st_uid, st.st_gid):
            os.chown(chemin, u, g)
        actuel = stat.S_IMODE(os.fstat(fd).st_mode)
        voulu = modes(specs[1] if dossier else specs[0], actuel, dossier) & (0o7777 if dossier else 0o1777)
        if voulu != actuel:
            os.chmod(chemin, voulu)
        return True, dossier
    except OSError as e:
        _dire(f"[warn ] {affiche} : {e.strerror} : droits non posés.", file=sys.stderr)
        return False, False
    finally:
        os.close(fd)


def ident(nom: str, base: type) -> int:
    """UID ou GID de NOM (« - » ou hors de root : -1, rien n'est changé)."""
    if nom == "-" or not RACINE:
        return -1
    return pwd.getpwnam(nom).pw_uid if base is pwd else grp.getgrnam(nom).gr_gid


def _options(reste: list[str], connues: set[str], drapeaux: set[str] = frozenset()) -> dict[str, list[str]]:
    vues: dict[str, list[str]] = {}
    while reste:
        option = reste.pop(0)
        if option in drapeaux:
            vues.setdefault(option, []).append("")
        elif option in connues and reste:
            vues.setdefault(option, []).append(reste.pop(0))
        else:
            raise SystemExit(USAGE)
    return vues


def _refus(chemin: str, e: BaseException) -> bool:
    texte = str(e) if isinstance(e, Refus) else (e.strerror or str(e))
    _dire(f"[warn ] {chemin} : {texte} : refusé, rien n'y est posé (à vérifier).", file=sys.stderr)
    return False


def arbre(args: list[str]) -> bool:
    racine, groupe, spec_f, spec_d, *reste = args
    o = _options(reste, {"--proprio", "--comptes", "--comptes-dossiers", "--sauf", "--prive", "--regle", "--sous"},
                 {"--avec-root"})
    racine = _net(racine)
    regles = []
    for v in o.get("--prive", []):
        compte, _, chemin = v.partition(":")
        regles.append((os.path.normpath(chemin), compte, "-", "go-rwx", "go-rwxs"))
    for v in o.get("--regle", []):
        compte, g, sf, sd, chemin = v.split(":", 4)
        regles.append((os.path.normpath(chemin), compte, g, sf, sd))
    regles = [(c, ident(a, pwd), ident(g, grp) if g != "-" else -2, sf, sd) for c, a, g, sf, sd in regles]
    comptes = _uids(",".join(o["--comptes"])) if "--comptes" in o else None
    ceder = "--avec-root" in o or (comptes is not None and 0 in comptes)
    comptes_dossiers = frozenset(_uids(",".join(o.get("--comptes-dossiers", []))))
    sauf = [os.path.normpath(v) if v.startswith("/") else v for v in o.get("--sauf", [])]
    uid, gid, reussi = ident((o.get("--proprio") or ["-"])[-1], pwd), ident(groupe, grp), True
    try:
        fd = ouvrir_dossier(racine, sous=(o.get("--sous") or [None])[-1])
    except FileNotFoundError:
        return True
    except (Refus, OSError) as e:
        return _refus(racine, e)
    try:
        dev = os.fstat(fd).st_dev
        for chemin, dossiers, fichiers, dfd in os.fwalk(".", dir_fd=fd, follow_symlinks=False):
            base = os.path.normpath(os.path.join(racine, chemin))
            for nom in list(dossiers) + fichiers:
                complet = os.path.join(base, nom)
                regle = next((r for r in regles if complet == r[0] or complet.startswith(r[0] + "/")), None)
                if any(complet == m if m.startswith("/") else fnmatch.fnmatchcase(nom, m) for m in sauf):
                    parcourir = False
                elif regle is not None:
                    _, ru, rg, sf, sd = regle
                    elig = None if comptes is None else comptes | ({ru} if ru >= 0 else set())
                    ok, parcourir = poser(dfd, nom, complet, ru, gid if rg == -2 else rg, (sf, sd), elig, dev=dev,
                                          comptes_dossiers=comptes_dossiers, ceder_root=ceder)
                    reussi &= ok
                else:
                    ok, parcourir = poser(dfd, nom, complet, uid, gid, (spec_f, spec_d), comptes, dev=dev,
                                          comptes_dossiers=comptes_dossiers, ceder_root=ceder)
                    reussi &= ok
                if nom in dossiers and not parcourir:
                    dossiers.remove(nom)
    finally:
        os.close(fd)
    return reussi


def dossier(args: list[str]) -> bool:
    chemin, mode, proprio, groupe, *reste = args
    o = _options(reste, {"--admis", "--sous", "--groupe-racine"}, {"--creer"})
    admis = {"root", proprio, *",".join(o.get("--admis", [])).replace(",", " ").split()}
    if not RACINE:
        admis.add(pwd.getpwuid(os.geteuid()).pw_name)
    chemin = _net(chemin)
    try:
        fd, parent = _ouvrir(chemin, True, (o.get("--sous") or [None])[-1], int(mode, 8) if "--creer" in o else None)
    except (Refus, OSError) as e:
        if isinstance(e, FileNotFoundError):
            return _refus(chemin, Refus("absent"))
        return _refus(chemin, e if isinstance(e, Refus) else Refus(f"lien symbolique, fichier ou dossier déplacé ({e.strerror})"))
    try:
        st = os.fstat(fd)
        try:
            p = pwd.getpwuid(st.st_uid).pw_name
        except KeyError:
            p = str(st.st_uid)
        if p not in admis:
            _dire(f"[warn ] {chemin} appartient à {p}, pas à {proprio} : refusé (services sous {p} : ELPIS_USER={p} ; "
                  f"passage à {proprio} : sudo ELPIS_USER={proprio} ./elpis service install).", file=sys.stderr)
            return False
        exige = (o.get("--groupe-racine") or [""])[-1]
        if exige and p == "root" and st.st_gid != next((g.gr_gid for g in grp.getgrall() if g.gr_name == exige), None):
            _dire(f"[warn ] {chemin} : à root sans le groupe {exige} (dossier hors du dépôt à préparer par "
                  f"l'administrateur : root:{exige}, 2770) : refusé.", file=sys.stderr)
            return False
        if p == "root" and proprio != "root":
            lu = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
            try:
                plein = bool(os.listdir(lu))
            finally:
                os.close(lu)
            if plein and parent.st_mode & 0o022 and not a_lui_seul(parent, proprio):
                _dire(f"[warn ] {chemin} : dossier de root non vide à céder à {proprio} : refusé (à vérifier).",
                      file=sys.stderr)
                return False
        lien = f"/proc/self/fd/{fd}"
        uid, gid = ident(proprio, pwd), ident(groupe, grp)
        if RACINE and (uid, gid) != (st.st_uid, st.st_gid):
            os.chown(lien, uid, gid)
        if stat.S_IMODE(os.fstat(fd).st_mode) != int(mode, 8):
            os.chmod(lien, int(mode, 8))
        return True
    except OSError as e:
        _dire(f"[warn ] {chemin} : {e.strerror} : droits non posés.", file=sys.stderr)
        return False
    finally:
        os.close(fd)


def fichiers(args: list[str]) -> bool:
    dossier_, proprio, groupe, mode, *motifs = args
    comptes, ceder = None, "--avec-root" in motifs
    motifs = [m for m in motifs if m != "--avec-root"]
    if "--comptes" in motifs:
        i = motifs.index("--comptes")
        comptes, motifs = _uids(motifs[i + 1] if i + 1 < len(motifs) else ""), motifs[:i] + motifs[i + 2:]
        ceder = ceder or 0 in comptes
    try:
        dfd = ouvrir_dossier(_net(dossier_))
    except FileNotFoundError:
        return True
    except (Refus, OSError) as e:
        return _refus(dossier_, e)
    try:
        lu = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=dfd)
        try:
            noms = sorted(os.listdir(lu))
        finally:
            os.close(lu)
        uid, gid, reussi = ident(proprio, pwd), ident(groupe, grp), True
        for nom in noms:
            if any(fnmatch.fnmatchcase(nom, m) for m in motifs):
                elig = None if comptes is None else comptes | ({uid} if uid >= 0 else set())
                reussi &= poser(dfd, nom, os.path.join(dossier_, nom), uid, gid, (mode, mode), elig, True,
                                ceder_root=ceder)[0]
        return reussi
    finally:
        os.close(dfd)


def _poser_texte(dossier_: str, nom: str, texte_de) -> bool:
    """NOM de DOSSIER remplacé par texte_de(contenu actuel, None s'il manque) quand il rend un texte : temporaire au nom aléatoire (O_EXCL|O_NOFOLLOW, 0600) écrit, synchronisé, puis renommé ; lien ou fichier spécial : refusé, signalé."""
    try:
        dfd = ouvrir_dossier(_net(dossier_))
    except (Refus, OSError) as e:
        if isinstance(e, FileNotFoundError):
            raise
        return _refus(dossier_, e)
    try:
        try:
            fd = os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        except FileNotFoundError:
            actuel = None
        except OSError:
            _dire(f"[warn ] {os.path.join(dossier_, nom)} : lien ou fichier spécial, laissé (à vérifier).", file=sys.stderr)
            return False
        else:
            with os.fdopen(fd, "rb") as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    _dire(f"[warn ] {os.path.join(dossier_, nom)} : fichier spécial, laissé (à vérifier).", file=sys.stderr)
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
    dossier_, nom = args
    return _poser_texte(dossier_, nom, lambda a: None if a is not None and len(a.strip()) >= 40 else "ELPIS_" + secrets.token_hex(32))


def ranger(args: list[str]) -> bool:
    base, jeton, *reste = args
    magasin = (_options(reste, {"--magasin"}).get("--magasin") or [None])[-1]
    valeurs = json.loads(sys.stdin.read() or "{}")
    valeurs = valeurs if isinstance(valeurs, dict) else {}
    cibles = {"app.session_secret": (base, ".session_secret"), "app.encryption_key": (base, ".encryption_key"),
              "rag.service_token": os.path.split(jeton)}
    reussi, a_retirer = True, []
    for cle_config in SECRETS_CONFIG:
        valeur = valeurs.get(cle_config)
        if not (isinstance(valeur, str) and valeur.strip()):
            a_retirer.append(cle_config)
            continue
        texte = valeur.strip() + "\n"
        if cle_config not in cibles and not (magasin and cle_config in VERS_CLES):
            continue
        try:
            if magasin and cle_config in VERS_CLES:
                ecrit = _poser_cle(magasin, VERS_CLES[cle_config], texte.encode())
            else:
                ecrit = _poser_texte(*cibles[cle_config], lambda a, t=texte: None if a == t else t)
        except OSError as e:
            _dire(f"[warn ] {os.path.join(*cibles[cle_config])} : {e.strerror} : {cle_config} non écrit.", file=sys.stderr)
            ecrit = False
        if ecrit:
            a_retirer.append(cle_config)
        reussi &= ecrit
    print("\n".join(a_retirer))
    return reussi


class Illisible(Exception):
    """Clé du magasin que systemd-creds ne déchiffre plus (TPM ou clé de l'hôte changés, nom différent)."""


def _creds(*args: str, entree: bytes = b"") -> subprocess.CompletedProcess:
    """systemd-creds ARGUMENTS : le clair passe par un tube, jamais par la ligne de commande ni par un fichier."""
    try:
        return subprocess.run(["systemd-creds", *args], input=entree, capture_output=True, timeout=120, check=False)
    except subprocess.TimeoutExpired:
        raise OSError(errno.ETIMEDOUT, "systemd-creds sans réponse") from None


def _motif(r: subprocess.CompletedProcess) -> str:
    return (r.stderr.decode("utf-8", "replace").strip().splitlines() or [f"code {r.returncode}"])[-1]


def _dechiffrer(magasin: str, nom: str) -> bytes:
    r = _creds("decrypt", f"--name={nom}", os.path.join(magasin, nom), "-")
    if r.returncode != 0:
        raise Illisible(_motif(r))
    return r.stdout


def _fsync_dossier(dfd: int) -> None:
    lu = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=dfd)
    try:
        os.fsync(lu)
    finally:
        os.close(lu)


def _cle_presente(dfd: int, nom: str) -> bool:
    try:
        st = os.stat(nom, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(st.st_mode):
        raise Refus(f"{nom} : lien ou fichier spécial dans le magasin")
    return True


def _chiffrer(magasin: str, dfd: int, nom: str, clair: bytes) -> None:
    """Clé NOM posée : chiffrée par systemd-creds dans un temporaire du magasin, mise à 0600 root, déchiffrée et comparée, puis renommée ; rien de laissé en cas d'échec."""
    tmp = f".{nom}.{secrets.token_hex(8)}"
    try:
        r = _creds("encrypt", f"--name={nom}", "--with-key=auto", "-", os.path.join(magasin, tmp), entree=clair)
        if r.returncode != 0:
            raise OSError(errno.EIO, f"systemd-creds encrypt : {_motif(r)}")
        fd = os.open(tmp, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError(errno.EINVAL, "fichier spécial")
            if RACINE:
                os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        r = _creds("decrypt", f"--name={nom}", os.path.join(magasin, tmp), "-")
        if r.returncode != 0 or r.stdout != clair:
            raise OSError(errno.EIO, "relecture par systemd-creds decrypt différente")
        os.replace(tmp, nom, src_dir_fd=dfd, dst_dir_fd=dfd)
        _fsync_dossier(dfd)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp, dir_fd=dfd)
        raise


def _poser_cle(magasin: str, nom: str, clair: bytes) -> bool:
    """Clé NOM du magasin mise à CLAIR si elle manque, diffère ou ne se déchiffre plus ; vrai si elle le vaut."""
    try:
        dfd = ouvrir_dossier(_net(magasin))
    except (Refus, OSError) as e:
        return _refus(magasin, e)
    try:
        if _cle_presente(dfd, nom):
            with contextlib.suppress(Illisible):
                if _dechiffrer(magasin, nom) == clair:
                    return True
        _chiffrer(magasin, dfd, nom, clair)
        return True
    except (Refus, OSError) as e:
        return _refus(os.path.join(magasin, nom), e)
    finally:
        os.close(dfd)


def _octets_cle() -> bytes:
    """32 octets aléatoires, jamais un seul octet répété (refusé par la règle du coffre)."""
    while len(set(octets := os.urandom(32))) == 1:
        pass
    return octets


# Clés créées au format que leur code crée : vault setup (base64), Fernet.generateKey(), secret de session et jeton du RAG (droits.py secret), audit setup ; clé d'API de Qdrant : 48 caractères aléatoires.
GENRES = {"coffre": lambda: base64.b64encode(_octets_cle()) + b"\n", "fernet": lambda: base64.urlsafe_b64encode(os.urandom(32)),
          "session": lambda: b"ELPIS_" + secrets.token_hex(32).encode(), "journal": lambda: secrets.token_hex(32).encode(),
          "jeton": lambda: b"ELPIS_" + secrets.token_hex(32).encode() + b"\n", "qdrant": lambda: secrets.token_hex(24).encode()}


def _lire_source(chemin: str, proprios: set[int], minimum: int, taille: int = 65536):
    """Source en clair CHEMIN lue sans suivre de lien : (descripteur de son dossier, nom, état, contenu), None si absente, False si refusée (signalé)."""
    tete, nom = os.path.split(_net(chemin))
    try:
        dfd = ouvrir_dossier(tete)
    except FileNotFoundError:
        return None
    except (Refus, OSError) as e:
        _refus(chemin, e)
        return False
    try:
        fd = os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
    except OSError as e:
        os.close(dfd)
        if isinstance(e, FileNotFoundError):
            return None
        _dire(f"[warn ] {chemin} : lien ou fichier spécial : ignoré (à vérifier, puis à retirer).", file=sys.stderr)
        return False
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        conforme = (stat.S_ISREG(st.st_mode) and st.st_uid in proprios and st.st_nlink == 1
                    and not st.st_mode & 0o022 and st.st_size <= taille)
        contenu = f.read(taille + 1) if conforme else b""
    if not conforme or len(contenu) > taille:
        try:
            qui = pwd.getpwuid(st.st_uid).pw_name
        except KeyError:
            qui = str(st.st_uid)
        _dire(f"[warn ] {chemin} ignoré (à {qui}, en {stat.S_IMODE(st.st_mode):o}, {st.st_nlink} lien(s) : seul un fichier "
              "ordinaire à un seul lien de root, de l'opérateur ou d'un ancien compte unique, sans écriture d'autrui, est "
              "lu) : à vérifier.", file=sys.stderr)
        os.close(dfd)
        return False
    if len(contenu.strip()) < max(1, minimum):
        _dire(f"[warn ] {chemin} : vide ou trop court : ignoré (à vérifier).", file=sys.stderr)
        os.close(dfd)
        return False
    return dfd, nom, st, contenu


def _retirer_source(dfd: int, nom: str, st: os.stat_result, chemin: str) -> bool:
    """Source en clair retirée si c'est encore le fichier lu (même inode) ; vrai si elle n'y est plus."""
    try:
        vu = os.stat(nom, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        return True
    if (vu.st_dev, vu.st_ino) != (st.st_dev, st.st_ino):
        _dire(f"[warn ] {chemin} : remplacé pendant la reprise : laissé (à vérifier).", file=sys.stderr)
        return False
    os.unlink(nom, dir_fd=dfd)
    return True


def cle(args: list[str]) -> bool:
    magasin, nom, *reste = args
    o = _options(reste, {"--source", "--proprio", "--min", "--creer"}, {"--source-gagne", "--copie"})
    genre = (o.get("--creer") or [None])[-1]
    if not NOM_CLE.fullmatch(nom) or (genre is not None and genre not in GENRES):
        raise SystemExit(USAGE)
    magasin = _net(magasin)
    chemin_cle = os.path.join(magasin, nom)
    copie = f"[elpis] Copie hors de la machine (support hors ligne) : sudo systemd-creds decrypt --name={nom} {chemin_cle} FICHIER"
    try:
        dfd = ouvrir_dossier(magasin)
    except (Refus, OSError) as e:
        return _refus(magasin, e)
    source = None
    try:
        present = _cle_presente(dfd, nom)
        if "--source" in o:
            source = _lire_source(o["--source"][-1], _uids(",".join(o.get("--proprio", ["root"]))),
                                  int((o.get("--min") or ["1"])[-1]))
        if source:
            sdfd, snom, sst, clair = source
            src, actuel = o["--source"][-1], None
            if present:
                try:
                    actuel = _dechiffrer(magasin, nom)
                except Illisible as e:
                    _dire(f"[warn ] {chemin_cle} : illisible par systemd-creds ({e}) : remplacée par {src}.", file=sys.stderr)
            if actuel is not None and actuel != clair and "--source-gagne" not in o:
                _dire(f"[warn ] {src} diffère de la clé {nom} en service ({chemin_cle}) : laissés tous deux ; gardez la bonne "
                      "(copie hors de la machine d'abord), retirez l'autre, puis relancez sudo ./elpis service install.",
                      file=sys.stderr)
                return False
            if actuel != clair:
                _chiffrer(magasin, dfd, nom, clair)
                _dire(f"[elpis] {src} chiffré par systemd-creds : {chemin_cle}.")
                if "--copie" in o:
                    _dire(copie)
            if not _retirer_source(sdfd, snom, sst, src):
                return False
            _dire(f"[elpis] {src} retiré : plus de copie en clair sur cette machine.")
            return True
        if present:
            try:
                _dechiffrer(magasin, nom)
            except Illisible as e:
                _dire(f"[warn ] {chemin_cle} : illisible par systemd-creds ({e}) : remettez sa copie hors de la machine à son "
                      "emplacement d'avant (docs/operations.md, « Platform keys »), puis relancez sudo ./elpis service install.",
                      file=sys.stderr)
                return False
        elif genre is not None and source is None:
            _chiffrer(magasin, dfd, nom, GENRES[genre]())
            _dire(f"[elpis] Clé {nom} créée, chiffrée par systemd-creds : {chemin_cle}.")
            if "--copie" in o:
                _dire(copie)
        return source is not False
    except (Refus, OSError) as e:
        return _refus(chemin_cle, e)
    finally:
        if source:
            os.close(source[0])
        os.close(dfd)


def _poser_clair(cible: str, clair: bytes, proprio: str, groupe: str, mode: int, nom_cle: str, remplacer: bool = False) -> bool:
    """CIBLE posée à CLAIR (temporaire exclusif à PROPRIO:GROUPE en MODE, relue) si elle manque, gardée (droits reposés) si elle le vaut ; différente : laissée, signalée (REMPLACER : remplacée) ; lien ou fichier spécial : laissé, signalé."""
    tete, nom = os.path.split(_net(cible))
    try:
        dfd = ouvrir_dossier(tete)
    except (Refus, OSError) as e:
        return _refus(cible, e)
    try:
        uid, gid = ident(proprio, pwd), ident(groupe, grp)
        try:
            fd = os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        except FileNotFoundError:
            fd = None
        except OSError:
            _dire(f"[warn ] {cible} : lien ou fichier spécial : laissé, clé {nom_cle} gardée (à vérifier).", file=sys.stderr)
            return False
        if fd is not None:
            with os.fdopen(fd, "rb") as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    _dire(f"[warn ] {cible} : fichier spécial : laissé, clé {nom_cle} gardée (à vérifier).", file=sys.stderr)
                    return False
                if f.read(65537) == clair:
                    if RACINE:
                        os.fchown(f.fileno(), uid, gid)
                    os.fchmod(f.fileno(), mode)
                    return True
            if not remplacer:
                _dire(f"[warn ] {cible} existe et diffère de la clé {nom_cle} : laissés tous deux (à vérifier).", file=sys.stderr)
                return False
            _dire(f"[warn ] {cible} différait de la clé {nom_cle} en service : remplacé par elle.", file=sys.stderr)
        tmp = f".{nom}.{secrets.token_hex(8)}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(clair)
                f.flush()
                if RACINE:
                    os.fchown(f.fileno(), uid, gid)
                os.fchmod(f.fileno(), mode)
                os.fsync(f.fileno())
            os.replace(tmp, nom, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp, dir_fd=dfd)
            raise
        with os.fdopen(os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd), "rb") as f:
            if f.read(65537) != clair:
                _dire(f"[warn ] {cible} : relu différent de la clé {nom_cle} : clé gardée (à vérifier).", file=sys.stderr)
                return False
        _fsync_dossier(dfd)
        return True
    finally:
        os.close(dfd)


def cle_rendre(args: list[str]) -> bool:
    magasin, nom, cible, proprio, groupe, mode, *reste = args
    if not NOM_CLE.fullmatch(nom) or not re.fullmatch(r"0?[0-7]{3}", mode) or reste not in ([], ["--remplacer"]):
        raise SystemExit(USAGE)
    magasin = _net(magasin)
    try:
        dfd = ouvrir_dossier(magasin)
    except FileNotFoundError:
        return True
    except (Refus, OSError) as e:
        return _refus(magasin, e)
    try:
        if not _cle_presente(dfd, nom):
            return True
        if cible != "-":
            try:
                clair = _dechiffrer(magasin, nom)
            except Illisible as e:
                _dire(f"[warn ] {os.path.join(magasin, nom)} : illisible par systemd-creds ({e}) : gardée ; remettez sa copie "
                      f"hors de la machine à {cible}.", file=sys.stderr)
                return False
            if not _poser_clair(cible, clair, proprio, groupe, int(mode, 8), nom, bool(reste)):
                return False
        os.unlink(nom, dir_fd=dfd)
        _dire(f"[elpis] Clé {nom} " + (f"rendue à {cible} ({mode}), " if cible != "-" else "") + f"retirée de {magasin}.")
        return True
    except (Refus, OSError) as e:
        return _refus(os.path.join(magasin, nom), e)
    finally:
        os.close(dfd)


def cle_etat(args: list[str]) -> bool:
    magasin, *noms = args
    if not all(NOM_CLE.fullmatch(n) for n in noms):
        raise SystemExit(USAGE)
    magasin = _net(magasin)
    try:
        dfd = ouvrir_dossier(magasin)
    except FileNotFoundError:
        dfd = None
    except (Refus, OSError) as e:
        return _refus(magasin, e)
    try:
        for nom in noms:
            try:
                if dfd is None or not _cle_presente(dfd, nom):
                    print(f"{nom} absent")
                    continue
                print(f"{nom} ok {len(_dechiffrer(magasin, nom).strip())}")
            except (Refus, Illisible, OSError):
                print(f"{nom} illisible")
        return True
    finally:
        if dfd is not None:
            os.close(dfd)


def copier(args: list[str]) -> bool:
    source, dossier_, nom, *reste = args
    lu = _lire_source(source, _uids(",".join(_options(reste, {"--proprio"}).get("--proprio", ["root"]))), 1, 4096)
    if not lu:
        if lu is None:
            _dire(f"[warn ] {source} : absent.", file=sys.stderr)
        return False
    os.close(lu[0])
    try:
        dfd = ouvrir_dossier(_net(dossier_))
    except (Refus, OSError) as e:
        return _refus(dossier_, e)
    try:
        with os.fdopen(os.open(nom, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd), "wb") as f:
            f.write(lu[3])
        return True
    finally:
        os.close(dfd)


def reprendre(args: list[str]) -> int:
    """Code 0 : repris ; 2 : NOM refusé (signalé) ; 1 : échec."""
    dossier_, nom, compte, cible = args
    try:
        dfd = ouvrir_dossier(_net(dossier_), strict=False)
    except FileNotFoundError:
        return 0
    except (Refus, OSError) as e:
        _refus(dossier_, e)
        return 1
    try:
        try:
            fd = os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        except FileNotFoundError:
            return 0
        except OSError:
            _dire(f"[warn ] {os.path.join(dossier_, nom)} : lien ou fichier spécial : ignoré (à vérifier, puis à retirer).",
                  file=sys.stderr)
            return 2
        with os.fdopen(fd, "rb") as f:
            st = os.fstat(f.fileno())
            attendu = _uids(compte)
            if not (stat.S_ISREG(st.st_mode) and st.st_uid in attendu and st.st_nlink == 1 and not st.st_mode & 0o022
                    and st.st_size <= 4096):
                try:
                    qui = pwd.getpwuid(st.st_uid).pw_name
                except KeyError:
                    qui = str(st.st_uid)
                _dire(f"[warn ] {os.path.join(dossier_, nom)} ignoré (à {qui}, en {stat.S_IMODE(st.st_mode):o}, "
                      f"{st.st_nlink} lien(s) : seul un fichier de {compte}, sans écriture d'autrui, remplace le jeton du "
                      "RAG) : à vérifier, puis à retirer.", file=sys.stderr)
                return 2
            texte = f.read(4096).decode("utf-8", "replace").strip()
        if not texte:
            return 2
        if not _poser_texte(*os.path.split(cible), lambda a, t=texte + "\n": None if a == t else t):
            return 1
        os.unlink(nom, dir_fd=dfd)
        return 0
    finally:
        os.close(dfd)


def retirer(args: list[str]) -> bool:
    dossier_, *noms = args
    try:
        dfd = ouvrir_dossier(_net(dossier_), strict=False)
    except FileNotFoundError:
        return True
    except (Refus, OSError) as e:
        return _refus(dossier_, e)
    try:
        for nom in noms:
            with contextlib.suppress(FileNotFoundError, IsADirectoryError):
                os.unlink(nom, dir_fd=dfd)
        return True
    finally:
        os.close(dfd)


def sur(args: list[str]) -> bool:
    chemin, *reste = args
    o = _options(reste, {"--proprio"})
    attendus = _uids(",".join(o.get("--proprio", []))) if "--proprio" in o else None
    tete, nom = os.path.split(_net(chemin))
    try:
        dfd = ouvrir_dossier(tete)
    except (Refus, OSError) as e:
        return _refus(chemin, e)
    try:
        try:
            st = os.stat(nom, dir_fd=dfd, follow_symlinks=False)
        except FileNotFoundError:
            return True
        if ecrivable_par_services(os.fstat(dfd)) and not os.fstat(dfd).st_mode & stat.S_ISVTX:
            return _refus(chemin, Refus(f"{tete} modifiable par un compte des services"))
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or ecrivable_par_services(st) \
                or (attendus is not None and st.st_uid not in attendus):
            return _refus(chemin, Refus("lien, fichier spécial, plusieurs liens, compte inattendu ou modifiable par "
                                        "un compte des services"))
        return True
    finally:
        os.close(dfd)


# Texte sûr : ASCII imprimable (tabulation et sauts de ligne compris), puis un caractère UTF-8 hors C1 à la fois (aucune alternative répétée).
ASCII_SUR = re.compile(rb"[\t\n\r\x20-\x7e]+")
UTF8_SUR = re.compile(rb"\xc2[\xa0-\xbf]|[\xc3-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}"
                      rb"|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2}")


def fin_sure(d: bytes, i: int) -> int:
    """Fin de la suite de texte sûr qui commence en I (I s'il n'y en a pas)."""
    while m := ASCII_SUR.match(d, i) or UTF8_SUR.match(d, i):
        i = m.end()
    return i

DEBUT_UTF8 = re.compile(rb"[\xc2-\xdf]|[\xe0-\xef][\x80-\xbf]?|[\xf0-\xf4][\x80-\xbf]{0,2}")
SGR = re.compile(rb"\x1b\[[0-9;]*m")


class Filtre:
    """Flux d'un compte vers le terminal ou le journal de root, en une seule passe (rien de retiré ne se recolle) ; état gardé d'un morceau à l'autre."""

    def __init__(self, tui: bool = False) -> None:
        self.tui, self.etat, self.seq, self.huit, self.reste = tui, "texte", bytearray(), False, b""

    def __call__(self, donnees: bytes, fin: bool = False) -> bytes:
        d, self.reste = self.reste + donnees, b""
        sortie, i, n = bytearray(), 0, len(d)
        while i < n:
            c = d[i]
            if self.etat == "texte":
                j = fin_sure(d, i)
                if j > i:
                    sortie += d[i:j]
                    i = j
                elif not fin and n - i < 4 and DEBUT_UTF8.fullmatch(d, i):
                    self.reste = d[i:]
                    break
                elif c == 0x1B:
                    self.etat, i = "esc", i + 1
                elif c == 0xC2 and i + 1 < n and 0x80 <= d[i + 1] <= 0x9F:
                    self._c1(d[i + 1], sortie)
                    i += 2
                elif 0x80 <= c <= 0x9F:
                    self._c1(c, sortie)
                    i += 1
                else:
                    sortie += bytes([c]) if self.tui and c in (0x07, 0x08) else b"?"
                    i += 1
            elif self.etat == "esc":
                if c == 0x5B:
                    self.etat, self.seq, self.huit, i = "csi", bytearray(b"\x1b["), False, i + 1
                elif c in b"]P_^X":
                    self.etat, i = "chaine", i + 1
                elif 0x20 <= c <= 0x2F:
                    self.etat, self.seq, i = "inter", bytearray(b"\x1b" + bytes([c])), i + 1
                elif 0x30 <= c <= 0x7E:
                    if self.tui and c != 0x5A:
                        sortie += b"\x1b" + bytes([c])
                    self.etat, i = "texte", i + 1
                else:
                    self.etat = "texte"
            elif self.etat == "inter":
                if 0x20 <= c <= 0x2F and len(self.seq) < 8:
                    self.seq.append(c)
                    i += 1
                else:
                    if 0x30 <= c <= 0x7E:
                        if self.tui:
                            sortie += self.seq + bytes([c])
                        i += 1
                    self.etat = "texte"
            elif self.etat == "csi":
                if 0x20 <= c <= 0x3F and len(self.seq) < 64:
                    self.seq.append(c)
                    i += 1
                else:
                    if 0x40 <= c <= 0x7E:
                        self.seq.append(c)
                        if not self.huit and (self.tui or SGR.fullmatch(self.seq)):
                            sortie += self.seq
                        i += 1
                    self.etat = "texte"
            elif self.etat == "chaine":
                if c in (0x07, 0x9C):
                    self.etat, i = "texte", i + 1
                elif c == 0x1B:
                    self.etat, i = "chaine_esc", i + 1
                elif c == 0x0A:
                    self.etat = "texte"
                elif c == 0xC2 and i + 1 < n and d[i + 1] == 0x9C:
                    self.etat, i = "texte", i + 2
                elif c == 0xC2 and i + 1 >= n and not fin:
                    self.reste = d[i:]
                    break
                else:
                    i += 1
            else:
                self.etat = "texte" if c == 0x5C else "esc"
                i += c == 0x5C
        if fin:
            sortie += b"?" * len(self.reste)
            self.reste, self.etat = b"", "texte"
        return bytes(sortie)

    def _c1(self, c: int, sortie: bytearray) -> None:
        if c == 0x9B:
            self.etat, self.seq, self.huit = "csi", bytearray(b"\x1b["), True
        elif c in (0x90, 0x98, 0x9D, 0x9E, 0x9F):
            self.etat = "chaine"
        else:
            sortie += b"?"


def _ecrire(fd: int, donnees: bytes) -> None:
    while donnees:
        donnees = donnees[os.write(fd, donnees):]


def filtre(args: list[str]) -> bool:
    """filtre [--tui] : entrée standard filtrée (Filtre) vers la sortie, morceau par morceau (une invite sans fin de ligne passe aussitôt) ; Ctrl-C ignoré : le flux va jusqu'à sa fin."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    f = Filtre("--tui" in args)
    try:
        while d := os.read(0, 65536):
            _ecrire(1, f(d))
        _ecrire(1, f(b"", fin=True))
    except BrokenPipeError:
        pass
    return True


def _ouvrir_journal(chemin: str) -> tuple[int, os.stat_result] | None:
    """Journal ouvert sans suivre de lien ni attendre (ni FIFO ni périphérique), fichier ordinaire seulement."""
    try:
        fd = os.open(chemin, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        return None
    return fd, st


def journal(args: list[str]) -> bool:
    """journal [--suivre] [--lignes N] FICHIER... : fin de chaque journal (N lignes, 1 Mio lu au plus) filtrée ; refusé (lien, FIFO, périphérique) : signalé ; --suivre : la suite toutes les demi-secondes."""
    suivre, lignes, chemins, reste = False, 50, [], list(args)
    while reste:
        a = reste.pop(0)
        if a == "--suivre":
            suivre = True
        elif a == "--lignes" and reste and reste[0].isdigit():
            lignes = max(1, int(reste.pop(0)))
        else:
            chemins.append(a)
    f, ouverts, ok, dernier = Filtre(), {}, True, None
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    for c in chemins:
        o = _ouvrir_journal(c)
        if o is None:
            _dire(f"[warn ] {c} : absent, lien ou fichier spécial : non lu.", file=sys.stderr)
            ok = False
            continue
        fd, st = o
        debut = max(0, st.st_size - (1 << 20))
        texte = os.pread(fd, st.st_size - debut, debut)
        if len(chemins) > 1:
            _ecrire(1, f(f"==> {c} <==\n".encode("utf-8", "replace")))
        _ecrire(1, f(b"".join(texte.splitlines(keepends=True)[-lignes:])))
        ouverts[c], dernier = [fd, st.st_ino, debut + len(texte)], c
    while suivre:
        time.sleep(0.5)
        for c in chemins:
            o = ouverts.get(c)
            try:
                vu = os.lstat(c)
            except OSError:
                continue
            if o is None or vu.st_ino != o[1]:
                if o is not None:
                    os.close(o[0])
                n = _ouvrir_journal(c)
                if n is None:
                    ouverts.pop(c, None)
                    continue
                o = ouverts[c] = [n[0], n[1].st_ino, 0]
            taille = os.fstat(o[0]).st_size
            if taille < o[2]:
                o[2] = 0
            if taille > o[2]:
                texte = os.pread(o[0], min(taille - o[2], 1 << 20), o[2])
                o[2] += len(texte)
                if len(chemins) > 1 and dernier != c:
                    _ecrire(1, f(f"\n==> {c} <==\n".encode("utf-8", "replace")))
                _ecrire(1, f(texte))
                dernier = c
    return ok


def pid(args: list[str]) -> bool:
    """pid DOSSIER NOM : numéro de processus écrit par un service, lu sans suivre de lien ni attendre (ni FIFO ni /dev/zero), chiffres seuls."""
    try:
        dfd = ouvrir_dossier(_net(args[0]), strict=False)
        try:
            fd = os.open(args[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        finally:
            os.close(dfd)
        with os.fdopen(fd, "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                return False
            texte = f.read(33).decode("ascii", "replace").strip()
    except (Refus, OSError):
        return False
    if not re.fullmatch(r"[0-9]{1,9}", texte):
        return False
    print(texte)
    return True


def mdp_base(args: list[str]) -> bool:
    """mdp-base DOSSIER NOM PROPRIO [--admis COMPTE]... : mot de passe de la base locale lu par descripteur et vérifié, ou créé (0600, PROPRIO) ; jamais de chmod, chown ni lecture au travers d'un lien."""
    dossier_, nom, proprio = args[0], args[1], args[2]
    opts = _options(args[3:], {"--admis"})
    chemin = os.path.join(dossier_, nom)
    try:
        dfd = ouvrir_dossier(_net(dossier_), strict=False)
    except (Refus, OSError) as e:
        return _refus(dossier_, e)
    try:
        admis = {0} | _uids(" ".join([proprio, *opts.get("--admis", [])]))
        try:
            fd = os.open(nom, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        except FileNotFoundError:
            texte = ""
        except OSError as e:
            return _refus(chemin, Refus(f"lien symbolique ou fichier spécial ({e.strerror})"))
        else:
            with os.fdopen(fd, "rb") as f:
                st = os.fstat(f.fileno())
                if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid not in admis:
                    return _refus(chemin, Refus("fichier spécial, plusieurs liens ou propriétaire inattendu"))
                texte = f.read(4096).decode("ascii", "replace").strip()
        if texte:
            if not MDP_BASE.fullmatch(texte):
                return _refus(chemin, Refus("contenu non conforme (48 chiffres hexadécimaux attendus) : retirez-le pour en générer un"))
            print(texte)
            return True
        texte = secrets.token_hex(24)
        tmp = f".{nom}.{secrets.token_hex(8)}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as f:
                f.write(texte + "\n")
                f.flush()
                if RACINE:
                    compte = pwd.getpwnam(proprio)
                    os.fchown(f.fileno(), compte.pw_uid, compte.pw_gid)
                os.fsync(f.fileno())
            os.replace(tmp, nom, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp, dir_fd=dfd)
            raise
        print(texte)
        return True
    finally:
        os.close(dfd)


if __name__ == "__main__":
    commandes = {"arbre": (arbre, 4), "dossier": (dossier, 4), "fichiers": (fichiers, 5), "secret": (secret, 2),
                 "ranger": (ranger, 2), "reprendre": (reprendre, 4), "retirer": (retirer, 1), "sur": (sur, 1),
                 "pid": (pid, 2), "mdp-base": (mdp_base, 3), "filtre": (filtre, 0), "journal": (journal, 1),
                 "cle": (cle, 2), "cle-rendre": (cle_rendre, 6), "cle-etat": (cle_etat, 1), "copier": (copier, 3)}
    if len(sys.argv) < 2 or sys.argv[1] not in commandes or len(sys.argv) - 2 < commandes[sys.argv[1]][1]:
        raise SystemExit(USAGE)
    code = commandes[sys.argv[1]][0](sys.argv[2:])
    sys.exit(code if isinstance(code, int) and not isinstance(code, bool) else (0 if code else 1))
