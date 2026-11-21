# SPDX-License-Identifier: MIT
"""deploy/droits.py — droits posés et secrets écrits par root (« sudo ./elpis service install ») sans suivre de lien : dossier ouvert composant par composant depuis « / », entrées changées par descripteur."""
from __future__ import annotations

import contextlib
import errno
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
          et à céder sous un parent ouvert en écriture
        droits.py fichiers DOSSIER PROPRIO GROUPE MODE MOTIF... [--comptes A,B] [--avec-root]
          fichiers ordinaires de DOSSIER nommés d'après un MOTIF : PROPRIO (« - » : gardé), GROUPE, MODE octal
        droits.py secret DOSSIER NOM
          secret aléatoire (ELPIS_ et 64 chiffres hexadécimaux, 0600) créé dans DOSSIER s'il manque ou fait moins de
          40 caractères ; un lien ou un fichier spécial à ce nom est refusé
        droits.py ranger BASE JETON
          secrets de l'objet JSON de l'entrée standard (deploy/configure.py --ranger-secrets) dans BASE/.session_secret,
          BASE/.encryption_key et JETON (0600) s'ils diffèrent ; un lien ou un fichier spécial est refusé
        droits.py reprendre DOSSIER NOM COMPTE CIBLE
          contenu de DOSSIER/NOM, fichier ordinaire de COMPTE à un seul lien que nul autre ne peut écrire, écrit dans
          CIBLE (0600), puis NOM retiré ; code 2 si NOM est refusé
        droits.py retirer DOSSIER NOM...
          fichiers NOM de DOSSIER retirés (dossier atteint sans suivre de lien)
        droits.py sur FICHIER [--proprio A,B]
          code 0 si FICHIER manque, ou est un fichier ordinaire à un seul lien, à l'un des comptes, qu'aucun compte des
          services ne peut écrire ni remplacer
Comptes des services : ELPIS_DROITS_SERVICES (et groupes en plus : ELPIS_DROITS_GROUPES) ; tout dossier au-dessus
d'un dossier traité (au-dessus de BASE avec --sous) doit leur être fermé en écriture (sticky bit : entrée suivante
hors de leurs comptes). Hors de root : modes seulement. Fichier à plusieurs liens physiques : laissé, signalé.
Code 1 au moindre refus."""
CLAUSE = re.compile(r"([ugo]+)([+-])([rwxXs]+)")


class Refus(Exception):
    """Chemin refusé (lien, dossier ouvert aux services, point de montage d'un service…) ; le message dit pourquoi."""


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
                    print(f"[elpis] Dossier {chemin} créé.")
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
            print(f"[warn ] {affiche} : autre système de fichiers, laissé tel quel (à vérifier).", file=sys.stderr)
            return True, False
        if comptes is not None and st.st_uid not in comptes and not (dossier and st.st_uid in comptes_dossiers):
            return True, dossier
        if not dossier and st.st_nlink != 1:
            print(f"[warn ] {affiche} : plusieurs liens physiques, laissé tel quel (à vérifier).", file=sys.stderr)
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
        print(f"[warn ] {affiche} : {e.strerror} : droits non posés.", file=sys.stderr)
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
    print(f"[warn ] {chemin} : {texte} : refusé, rien n'y est posé (à vérifier).", file=sys.stderr)
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
            print(f"[warn ] {chemin} appartient à {p}, pas à {proprio} : refusé (services sous {p} : ELPIS_USER={p} ; "
                  f"passage à {proprio} : sudo ELPIS_USER={proprio} ./elpis service install).", file=sys.stderr)
            return False
        exige = (o.get("--groupe-racine") or [""])[-1]
        if exige and p == "root" and st.st_gid != next((g.gr_gid for g in grp.getgrall() if g.gr_name == exige), None):
            print(f"[warn ] {chemin} : à root sans le groupe {exige} (dossier hors du dépôt à préparer par "
                  f"l'administrateur : root:{exige}, 2770) : refusé.", file=sys.stderr)
            return False
        if p == "root" and proprio != "root":
            lu = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
            try:
                plein = bool(os.listdir(lu))
            finally:
                os.close(lu)
            if plein and parent.st_mode & 0o022:
                print(f"[warn ] {chemin} : dossier de root non vide à céder à {proprio} : refusé (à vérifier).",
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
        print(f"[warn ] {chemin} : {e.strerror} : droits non posés.", file=sys.stderr)
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
            print(f"[warn ] {os.path.join(dossier_, nom)} : lien ou fichier spécial, laissé (à vérifier).", file=sys.stderr)
            return False
        else:
            with os.fdopen(fd, "rb") as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    print(f"[warn ] {os.path.join(dossier_, nom)} : fichier spécial, laissé (à vérifier).", file=sys.stderr)
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
            print(f"[warn ] {os.path.join(dossier_, nom)} : lien ou fichier spécial : ignoré (à vérifier, puis à retirer).",
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
                print(f"[warn ] {os.path.join(dossier_, nom)} ignoré (à {qui}, en {stat.S_IMODE(st.st_mode):o}, "
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


if __name__ == "__main__":
    commandes = {"arbre": (arbre, 4), "dossier": (dossier, 4), "fichiers": (fichiers, 5), "secret": (secret, 2),
                 "ranger": (ranger, 2), "reprendre": (reprendre, 4), "retirer": (retirer, 1), "sur": (sur, 1)}
    if len(sys.argv) < 2 or sys.argv[1] not in commandes or len(sys.argv) - 2 < commandes[sys.argv[1]][1]:
        raise SystemExit(USAGE)
    code = commandes[sys.argv[1]][0](sys.argv[2:])
    sys.exit(code if isinstance(code, int) and not isinstance(code, bool) else (0 if code else 1))
