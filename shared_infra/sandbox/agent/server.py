#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/agent/server.py — agent de la sandbox (L4, 2026-09-29).

Exécute DANS le conteneur de l'utilisateur les opérations sur ``/work`` que
l'hôte lui demande, pour que l'hôte ne touche plus lui-même au contenu de la
sandbox. HTTP/1.1 sur un socket unix (``/run/elpis/agent.sock``, dossier
monté que l'hôte joint). Bibliothèque standard seule, Python ≥ 3.9 : il tourne
sous le ``python3 -I -S`` de l'image, monté en lecture seule depuis
l'application et démarré à la demande par l'hôte (``docker exec -d``, UID du
conteneur, sans capacités). Sa version est l'empreinte de ce fichier : l'hôte
relance un agent d'une autre version.

L'agent n'a pas plus de droits que les processus du conteneur (même UID) : il
ne vérifie donc pas qui l'appelle. Chemins relatifs à la racine (``/work``,
préfixe accepté), en UTF-8 ; « .. », chemins absolus et NUL refusés, ``\\``
est un caractère comme un autre. Les liens sont suivis tant qu'ils restent
sous la racine (``outside_root`` sinon : l'API ne parle que de ``/work``) ;
``remove``, ``rename`` et ``copy`` traitent le dernier composant comme
lui-même.

API — corps et réponses JSON, erreurs ``{"error": code, "message": …}`` ;
corps de requête par Content-Length seulement :

  GET  /v1/hello
  POST /v1/stat   {"paths": [...], "hash": bool, "hash_max": n}
                  → {"entries": [...]} ; une entrée en échec : kind "error"
  GET  /v1/read   ?path= &offset= &length= &max= &expect_size= &expect_mtime_ns=
                  → octets, en-tête X-Elpis-Stat
  POST /v1/list   {"path", "depth", "max_entries", "hidden", "prune": [motifs],
                   "exclude": [motifs], "deadline_s", "name_contains"}  → NDJSON, dernière
                   ligne {"done": true, …}
  POST /v1/grep   {"paths": [...], "needle", "ignore_case", "max_file_bytes",
                   "max_hits", "files_only", "width", "deadline_s", "regex",
                   "context", "max_line"} → {"file", "line", "col", "text"
                   [, "match_start", "match_end"]}  → NDJSON {"file", "line", "text"}, dernière
                   ligne {"done": true, …}
  PUT  /v1/write  ?path= &mode= &parents=1 &if_absent=1 &if_sha256= &if_mtime_ns=
                  (corps = contenu)  → {"size", "sha256", "mtime_ns", "created"}
  PUT  /v1/append ?path= &parents=1 &truncate=1 (corps = morceau) → {"size"}
  POST /v1/fsop   {"op": "mkdir|remove|rename|copy|chmod|clear|du", ...}
  POST /v1/readmany {"paths": [...], "max_file", "max_total"} → NDJSON
                  {"path", "b64"} ou {"path", "skip": code}, dans l'ordre, arrêté
                  avant de dépasser max_total ; dernière ligne {"done": true}
  POST /v1/changes/begin {"skip": [noms], "max_entries", "deadline_s"}
                  → {"id", "complete", "files"} (relevé avant une commande)
  POST /v1/changes/end {"id", "max_files", "max_bytes", "max_file"} → NDJSON
                  {"path", "change", "before", "after"} ({"b64"} ou {"state"}),
                  dernière ligne {"done": true, "total", "complete"}
  POST /v1/shutdown {"if_version": v}
"""
from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import fnmatch
import hashlib
import json
import os
import re
import secrets
import shutil
import socketserver
import stat
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from typing import Any, Dict, Iterable, Iterator, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

with open(__file__, "rb") as _f:
    VERSION = hashlib.sha256(_f.read()).hexdigest()[:16]

_BLOC = 1 << 20                      # lecture/écriture par blocs de 1 Mio
_MAX_JSON = 4 << 20                  # corps JSON d'une requête
_MAX_LECTURE = 64 << 20              # read sans « max » explicite
_MAX_ECRITURE = 1 << 30              # write sans « max » explicite
_MODE_FICHIER, _MODE_DOSSIER = 0o666, 0o777   # umask 0 : l'hôte y accède encore
_ACTIVITE_S = 10                     # mtime de la racine = activité (GC d'inactivité)
_RELEVE_GARDE = 512 * 1024           # relevé : contenu gardé par fichier
_RELEVE_CACHE = 24 << 20             # relevé : contenus gardés en tout
_RELEVES_OUVERTS = 16                # relevés ouverts en même temps
_RELEVE_DUREE_S = 3600               # un relevé jamais clos est oublié
_PROFONDEUR_MAX = 4096               # list : profondeur (au-delà, PATH_MAX)
_SIGNE_S = 2.0                       # flux NDJSON : signe de vie au moins toutes les 2 s
_INCONNU, _TROP_GROS = object(), object()
Cle = Tuple[int, int, int]           # (mtime_ns, taille, inode)


class Refus(Exception):
    """Requête refusée : statut HTTP, code stable, message, données en plus."""

    def __init__(self, statut: int, code: str, message: str = "", **extra: Any) -> None:
        super().__init__(message or code)
        self.statut, self.code, self.message, self.extra = statut, code, message or code, extra


_ERRNO = {errno.ENOENT: (404, "not_found"), errno.EACCES: (403, "denied"),
          errno.EPERM: (403, "denied"), errno.EROFS: (403, "read_only"),
          errno.EEXIST: (409, "exists"), errno.EISDIR: (409, "is_dir"),
          errno.ENOTDIR: (409, "not_dir"), errno.ENOTEMPTY: (409, "not_empty"),
          errno.ELOOP: (409, "loop"), errno.EXDEV: (409, "cross_device"),
          errno.EINVAL: (400, "invalid"), errno.ENAMETOOLONG: (400, "name_too_long"),
          errno.ENOSPC: (507, "no_space"), errno.EDQUOT: (507, "no_space")}


def _refus_os(e: OSError) -> Refus:
    statut, code = _ERRNO.get(e.errno or 0, (500, "io_error"))
    return Refus(statut, code, e.strerror or str(e))


def normaliser(chemin: Any) -> str:
    """Chemin relatif à la racine, sans « . » ni séparateur superflu ; ``""``
    = la racine. Refuse « .. », un chemin absolu hors ``/work``, NUL et un nom
    qui n'est pas de l'UTF-8."""
    if chemin is None:
        return ""
    if not isinstance(chemin, str):
        raise Refus(400, "bad_path", "chemin : chaîne attendue")
    if "\x00" in chemin:
        raise Refus(400, "bad_path", "caractère NUL dans le chemin")
    try:
        chemin.encode("utf-8")
    except UnicodeEncodeError:
        raise Refus(400, "bad_path", "chemin non UTF-8") from None
    s = chemin
    if s == "/work" or s.startswith("/work/"):
        s = s[5:]
    elif s.startswith("/"):
        raise Refus(400, "bad_path", "chemin absolu hors de /work")
    parties = [p for p in s.split("/") if p not in ("", ".")]
    if ".." in parties:
        raise Refus(400, "bad_path", "« .. » refusé")
    return "/".join(parties)


def _entier(q: Dict[str, str], cle: str, defaut: Optional[int] = None,
            mini: Optional[int] = 0) -> Optional[int]:
    v = q.get(cle)
    if v in (None, ""):
        return defaut
    try:
        n = int(v)
    except ValueError:
        raise Refus(400, "bad_request", f"{cle} : entier attendu") from None
    if mini is not None and n < mini:
        raise Refus(400, "bad_request", f"{cle} : au moins {mini}")
    return n


def _vrai(v: Any) -> bool:
    return v in (True, 1, "1", "true", "yes")


def _mode(v: Any) -> int:
    """Droits demandés : entier, ou chaîne octale (``"644"``). Jamais de bit
    setuid, setgid ni sticky."""
    if isinstance(v, bool):
        raise Refus(400, "bad_request", "mode : entier ou chaîne octale")
    try:
        n = v if isinstance(v, int) else int(str(v), 8)
    except ValueError:
        raise Refus(400, "bad_request", "mode : entier ou chaîne octale") from None
    return n & 0o777


def _nom_provisoire(dossier: str) -> str:
    """Court quel que soit le nom final (un nom long ferait ENAMETOOLONG)."""
    return os.path.join(dossier, f".elpis-tmp-{secrets.token_hex(8)}")


def _sha256_fd(fd: int) -> str:
    h = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        b = os.read(fd, _BLOC)
        if not b:
            return h.hexdigest()
        h.update(b)


def _sha256_chemin(p: str) -> str:
    fd = _ouvrir_fichier(p)
    try:
        return _sha256_fd(fd)
    finally:
        os.close(fd)


def _est_dossier(p: str) -> bool:
    """Vrai dossier (un lien vers un dossier n'en est pas un)."""
    try:
        return stat.S_ISDIR(os.lstat(p).st_mode)
    except FileNotFoundError:
        return False


def _ouvrir_fichier(p: str) -> int:
    """fd d'un fichier ORDINAIRE (O_NONBLOCK : une FIFO ne bloque pas)."""
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as e:
        raise _refus_os(e) from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refus(409, "not_file", "pas un fichier ordinaire")
    return fd


_OCTETS_TEXTE = frozenset(range(32, 127)) | {7, 8, 9, 10, 11, 12, 13, 27}


def _est_texte(debut: bytes) -> bool:
    """Début de fichier plausible pour du texte : pas de NUL, moins de 30 %
    d'octets de contrôle (même règle que les outils de l'hôte)."""
    if not debut:
        return True
    if b"\x00" in debut:
        return False
    autres = sum(1 for b in debut if b not in _OCTETS_TEXTE and b < 128)
    return autres / len(debut) < 0.30


def _genre(mode: int) -> str:
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "link"
    return "other"


def _creer_dossier(p: str, parents: bool = True) -> None:
    """Crée ``p`` (et ses parents manquants) : chaque dossier CRÉÉ reçoit
    ``_MODE_DOSSIER``, quel que soit l'umask du processus."""
    manquants = []
    d = p
    while parents and not os.path.isdir(d):
        manquants.append(d)
        haut = os.path.dirname(d)
        if haut == d:
            break
        d = haut
    for d in reversed(manquants or [p]):
        try:
            os.mkdir(d, _MODE_DOSSIER)
        except FileExistsError:
            if parents:
                continue
            raise
        os.chmod(d, _MODE_DOSSIER)
    if not os.path.isdir(p):
        raise FileExistsError(errno.EEXIST, "pas un dossier", p)


def _elargir(p: str) -> None:
    """Droits de ``p`` (et de son contenu) élargis pour l'autre UID : fichiers
    0666, dossiers 0777, bits x gardés, bits spéciaux retirés ; aucun lien
    suivi."""
    st = os.lstat(p)
    if stat.S_ISREG(st.st_mode):
        os.chmod(p, (stat.S_IMODE(st.st_mode) & 0o777) | 0o666)
    if not stat.S_ISDIR(st.st_mode):
        return
    os.chmod(p, 0o777)
    for racine, dossiers, fichiers in os.walk(p):        # les liens ne sont pas descendus
        for nom in dossiers + fichiers:
            q = os.path.join(racine, nom)
            s = os.lstat(q)
            if stat.S_ISDIR(s.st_mode):
                os.chmod(q, 0o777)
            elif stat.S_ISREG(s.st_mode):
                os.chmod(q, (stat.S_IMODE(s.st_mode) & 0o777) | 0o666)


def _supprimer(p: str) -> None:
    """Supprime ``p`` : un dossier récursivement, un lien comme lui-même."""
    if _est_dossier(p):
        shutil.rmtree(p)                                 # ne suit aucun lien
    else:
        os.unlink(p)


class Agent:
    """Les opérations, sans rien du transport HTTP."""

    def __init__(self, racine: str) -> None:
        self.racine = os.path.realpath(racine)
        # Vérification des préconditions + remplacement : atomiques entre
        # deux requêtes de l'hôte (le fichier provisoire s'écrit hors verrou).
        self._verrou = threading.Lock()
        self._activite = 0.0
        # Relevés avant / après une commande : contenus des petits fichiers
        # texte (mémoire du conteneur), relus quand leur clé de stat change.
        self._verrou_releve = threading.Lock()
        self._contenus: Dict[str, Tuple[Cle, bytes]] = {}
        self._octets_gardes = 0
        self._releves: Dict[str, tuple] = {}

    def chemin(self, rel: str) -> str:
        return os.path.join(self.racine, rel) if rel else self.racine

    def reel(self, rel: str) -> str:
        """Chemin résolu, liens suivis : il doit rester sous la racine."""
        p = os.path.realpath(self.chemin(rel))
        if p != self.racine and not p.startswith(self.racine + os.sep):
            raise Refus(403, "outside_root", "un lien sort de /work")
        return p

    def entree(self, rel: str) -> str:
        """Le dernier composant tel quel (un lien reste un lien), ses dossiers
        parents résolus et contenus."""
        if not rel:
            return self.racine
        parent, nom = os.path.split(rel)
        return os.path.join(self.reel(parent), nom)

    def signaler_activite(self) -> None:
        """Le ramasse-miettes d'inactivité lit le mtime de la racine."""
        maintenant = time.monotonic()
        if maintenant - self._activite >= _ACTIVITE_S:
            self._activite = maintenant
            try:
                os.utime(self.racine)
            except OSError:
                pass

    # ── lecture ────────────────────────────────────────────────────────────
    def stat(self, rel: str, hacher: bool = False, hash_max: int = 64 << 20) -> Dict[str, Any]:
        p = self.entree(rel)
        try:
            lst = os.lstat(p)
        except FileNotFoundError:
            return {"path": rel, "kind": "missing"}
        lien = stat.S_ISLNK(lst.st_mode)
        d: Dict[str, Any] = {"path": rel, "link": lien}
        if lien:
            d["target"] = os.readlink(p)
            try:
                p = self.reel(rel)
            except Refus:
                d.update(kind="link", outside=True)      # hors de /work : non suivi
                return d
        try:
            st = os.stat(p) if lien else lst
        except OSError:
            d["kind"] = "link"                           # lien cassé
            return d
        d.update(kind=_genre(st.st_mode), size=st.st_size, mtime_ns=st.st_mtime_ns,
                 mode=stat.S_IMODE(st.st_mode), ino=st.st_ino, dev=st.st_dev)
        if hacher and d["kind"] == "file" and st.st_size <= hash_max:
            d["sha256"] = _sha256_chemin(p)
        return d

    def stat_lot(self, chemins: Iterable[Any], hacher: bool, hash_max: int) -> list:
        """Une entrée illisible n'emporte pas le lot."""
        rendu = []
        for c in chemins:
            try:
                rendu.append(self.stat(normaliser(c), hacher, hash_max))
            except (Refus, OSError) as e:
                r = e if isinstance(e, Refus) else _refus_os(e)
                rendu.append({"path": c if isinstance(c, str) else "", "kind": "error",
                              "error": r.code, "message": r.message})
        return rendu

    def lister(self, rel: str, profondeur: int, max_entrees: int, caches: bool,
               elaguer: Iterable[str], delai_s: float,
               exclure: Iterable[str] = (), contient: str = "") -> Iterator[Dict[str, Any]]:
        """Arborescence sous ``rel``. ``exclure`` : motifs (fnmatch) sur le
        nom ou le chemin relatif au dossier listé — ni rendu ni descendu ;
        ``elaguer`` : motifs sur le nom des dossiers rendus mais non
        descendus ; ``contient`` : seules les entrées dont le nom le contient
        (sans casse) sont rendues, tout est parcouru."""
        base = self.reel(rel)
        exclure = tuple(exclure)
        try:
            est_dossier = stat.S_ISDIR(os.stat(base).st_mode)
        except OSError as e:
            raise _refus_os(e) from None
        if not est_dossier:
            raise Refus(409, "not_dir", "pas un dossier")
        elaguer = tuple(elaguer)
        contient = contient.lower()
        echeance = time.monotonic() + delai_s
        pile = [(base, rel, 1)]
        n = erreurs = illisibles = 0
        tronque = False
        signe = time.monotonic()
        premier = True
        while pile and not tronque:
            if time.monotonic() - signe > _SIGNE_S:
                signe = time.monotonic()
                yield {"tick": True}
            dossier, drel, niveau = pile.pop()
            if premier:                                  # le dossier demandé lui-même
                premier = False                          # illisible : refus, pas une liste vide
                try:
                    os.close(os.open(dossier, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC))
                except OSError as e:
                    raise _refus_os(e) from None
            try:
                with os.scandir(dossier) as it:
                    for entree in it:
                        if not caches and entree.name.startswith("."):
                            continue
                        try:
                            entree.name.encode("utf-8")
                        except UnicodeEncodeError:
                            illisibles += 1              # nom non UTF-8 : ni montré ni suivi
                            continue
                        if n >= max_entrees or time.monotonic() > echeance:
                            tronque = True
                            break
                        try:
                            st = entree.stat(follow_symlinks=False)
                        except OSError:
                            erreurs += 1
                            continue
                        erel = f"{drel}/{entree.name}" if drel else entree.name
                        if exclure:
                            sous = erel[len(rel) + 1:] if rel else erel
                            if any(fnmatch.fnmatchcase(entree.name, m) or fnmatch.fnmatchcase(sous, m)
                                   for m in exclure):
                                continue
                        genre = _genre(st.st_mode)
                        if not contient or contient in entree.name.lower():
                            yield {"path": erel, "kind": genre, "size": st.st_size,
                                   "mtime_ns": st.st_mtime_ns, "mode": stat.S_IMODE(st.st_mode)}
                            n += 1
                        if genre == "dir" and niveau < profondeur and not any(
                                fnmatch.fnmatchcase(entree.name, m) for m in elaguer):
                            pile.append((entree.path, erel, niveau + 1))
            except OSError:
                erreurs += 1
        yield {"done": True, "truncated": tronque, "errors": erreurs,
               "undecodable": illisibles, "count": n}

    def grep(self, chemins: Iterable[Any], aiguille: str, casse: bool, max_octets: int,
             max_trouves: int, largeur: int = 260, fichiers_seuls: bool = False,
             delai_s: float = 600.0, motif: Optional["re.Pattern[str]"] = None,
             contexte: int = 0, max_ligne: int = 20000) -> Iterator[Dict[str, Any]]:
        """Lignes de ``chemins`` (fichiers ordinaires) qui contiennent
        ``aiguille`` — ou où ``motif`` (expression régulière) trouve — ;
        découpe au seul ``\\n`` (comme ``grep -n``), ``col`` = début de la
        première correspondance. ``contexte`` : ``text`` réduit à ``contexte``
        caractères autour d'elle, positions ``match_start``/``match_end`` dans
        ``text`` ; en expression régulière, une ligne de plus de ``max_ligne``
        caractères est sautée. Fichiers trop gros ou binaires sautés et
        comptés. ``fichiers_seuls`` : un ``{"file"}`` par fichier trouvé
        (comme ``grep -l``). Au-delà de ``delai_s`` : arrêt, ``timed_out``."""
        cherche = aiguille if casse else aiguille.lower()
        trouves = gros = binaires = 0
        signe = time.monotonic()
        echeance = signe + delai_s

        def bilan(**en_plus: Any) -> Dict[str, Any]:
            return {"done": True, "hits_truncated": False, "skipped_large": gros,
                    "skipped_binary": binaires, **en_plus}
        for c in chemins:
            if time.monotonic() > echeance:
                yield bilan(timed_out=True)
                return
            if time.monotonic() - signe > _SIGNE_S:
                signe = time.monotonic()
                yield {"tick": True}                     # longue recherche sans résultat
            rel = normaliser(c)
            try:
                fd = _ouvrir_fichier(self.reel(rel))
            except Refus:
                continue                                 # disparu, lien, spécial
            try:
                if os.fstat(fd).st_size > max_octets:
                    gros += 1
                    continue
                with os.fdopen(os.dup(fd), "rb") as f:
                    if not _est_texte(f.read(8192)):
                        binaires += 1
                        continue
                    f.seek(0)
                    for i, brut in enumerate(f, 1):
                        if (i & 255) == 0 and time.monotonic() > echeance:
                            yield bilan(timed_out=True)
                            return
                        ligne = brut.rstrip(b"\n").rstrip(b"\r").decode("utf-8", "replace")
                        if motif is not None:
                            m = motif.search(ligne) if len(ligne) <= max_ligne else None
                            if m is None:
                                continue
                            debut, fin = m.start(), m.end()
                        else:
                            debut = (ligne if casse else ligne.lower()).find(cherche)
                            if debut < 0:
                                continue
                            fin = debut + len(cherche)
                        trouves += 1
                        if fichiers_seuls:
                            yield {"file": rel}
                        elif contexte:
                            d = max(0, debut - contexte)
                            yield {"file": rel, "line": i, "col": debut + 1,
                                   "text": ligne[d:fin + contexte],
                                   "match_start": debut - d, "match_end": fin - d}
                        else:
                            yield {"file": rel, "line": i, "col": debut + 1,
                                   "text": ligne if len(ligne) <= largeur else ligne[:largeur] + "…"}
                        if trouves >= max_trouves:
                            yield bilan(hits_truncated=True)
                            return
                        if fichiers_seuls:
                            break
            except OSError:
                continue
            finally:
                os.close(fd)
        yield bilan()

    def lire_plusieurs(self, chemins: Iterable[Any], max_fichier: int,
                       max_total: int) -> Iterator[Dict[str, Any]]:
        """Contenu des fichiers ordinaires de ``chemins``, dans l'ordre (liens
        suivis sous la racine) : ``{"path", "b64"}``, sinon ``{"path",
        "skip": code}`` (absent, spécial, hors racine, plus de
        ``max_fichier`` octets). S'arrête avant le fichier qui dépasserait
        ``max_total`` : l'hôte redemande la suite."""
        reste = max_total
        for c in chemins:
            demande = c if isinstance(c, str) else ""    # rendu tel que demandé
            try:
                fd = _ouvrir_fichier(self.reel(normaliser(c)))
            except Refus as r:
                yield {"path": demande, "skip": r.code}
                continue
            try:
                with os.fdopen(fd, "rb") as f:
                    taille = os.fstat(f.fileno()).st_size
                    data = f.read(min(max_fichier, reste) + 1) if taille <= max_fichier else b""
            except OSError as e:
                yield {"path": demande, "skip": _refus_os(e).code}
                continue
            if taille > max_fichier or len(data) > max_fichier:
                yield {"path": demande, "skip": "too_large"}
                continue
            if taille > reste or len(data) > reste:
                break
            reste -= len(data)
            yield {"path": demande, "b64": base64.b64encode(data).decode("ascii")}
        yield {"done": True}

    # ── écriture ───────────────────────────────────────────────────────────
    def ecrire(self, rel: str, corps: Iterable[bytes], *, mode: Any = None,
               parents: bool = False, si_absent: bool = False, si_sha256: str = "",
               si_mtime_ns: Optional[int] = None) -> Dict[str, Any]:
        """Contenu écrit dans un fichier provisoire (synchronisé sur disque),
        puis préconditions vérifiées et remplacement fait sous verrou."""
        if not rel:
            raise Refus(400, "bad_path", "chemin de fichier requis")
        p = self.reel(rel)                               # écrit à travers un lien
        dossier = os.path.dirname(p)
        droits = None if mode in (None, "", "keep") else _mode(mode)
        try:
            if parents:
                _creer_dossier(dossier)
            tmp = _nom_provisoire(dossier)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        except OSError as e:
            raise _refus_os(e) from None
        try:
            try:
                h, taille = hashlib.sha256(), 0
                for bloc in corps:
                    h.update(bloc)
                    taille += len(bloc)
                    vue = memoryview(bloc)
                    while vue:
                        vue = vue[os.write(fd, vue):]
                os.fsync(fd)
            finally:
                os.close(fd)
            with self._verrou:
                try:
                    ancien: Optional[os.stat_result] = os.stat(p)
                except FileNotFoundError:
                    ancien = None
                if ancien is not None and not stat.S_ISREG(ancien.st_mode):
                    if stat.S_ISDIR(ancien.st_mode):
                        raise Refus(409, "is_dir", "un dossier porte ce nom")
                    raise Refus(409, "not_file", "pas un fichier ordinaire")
                if si_absent and ancien is not None:
                    raise Refus(412, "exists", "le fichier existe déjà")
                if (si_sha256 or si_mtime_ns is not None) and ancien is None:
                    raise Refus(412, "changed", "le fichier n'existe plus")
                if ancien is not None and si_mtime_ns is not None \
                        and ancien.st_mtime_ns != si_mtime_ns:
                    raise Refus(412, "changed", "fichier modifié entre-temps",
                                mtime_ns=ancien.st_mtime_ns)
                if ancien is not None and si_sha256:
                    courant = _sha256_chemin(p)
                    if courant != si_sha256:
                        raise Refus(412, "changed", "contenu modifié entre-temps", sha256=courant)
                if droits is None:                       # garde le mode, sans bit spécial
                    droits = stat.S_IMODE(ancien.st_mode) & 0o777 if ancien else _MODE_FICHIER
                os.chmod(tmp, droits)
                os.replace(tmp, p)
                st = os.stat(p)
        except BaseException as e:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            if isinstance(e, OSError):
                raise _refus_os(e) from None
            raise
        return {"size": st.st_size, "sha256": h.hexdigest(), "mtime_ns": st.st_mtime_ns,
                "created": ancien is None, "written": taille}

    def ajouter(self, rel: str, corps: Iterable[bytes], *, parents: bool = False,
                tronquer: bool = False) -> Dict[str, Any]:
        """Ajoute ``corps`` à la fin du fichier ``rel`` (``tronquer`` : le crée
        ou le vide d'abord ; sinon il doit exister — un import annulé entre
        deux morceaux ne renaît pas). Pour l'import par morceaux dans un
        fichier provisoire, promu ensuite par ``rename`` : pas de
        remplacement atomique ici."""
        if not rel:
            raise Refus(400, "bad_path", "chemin de fichier requis")
        p = self.reel(rel)
        try:
            if parents:
                _creer_dossier(os.path.dirname(p))
            drapeaux = os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW
            fd = os.open(p, drapeaux | (os.O_CREAT | os.O_TRUNC if tronquer else os.O_APPEND),
                         _MODE_FICHIER)
        except OSError as e:
            raise _refus_os(e) from None
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise Refus(409, "not_file", "pas un fichier ordinaire")
            if tronquer:
                os.fchmod(fd, _MODE_FICHIER)             # quel que soit l'umask
            for bloc in corps:
                vue = memoryview(bloc)
                while vue:
                    vue = vue[os.write(fd, vue):]
            taille = os.fstat(fd).st_size
        except OSError as e:
            raise _refus_os(e) from None
        finally:
            os.close(fd)
        return {"size": taille}

    def fsop(self, d: Dict[str, Any]) -> Dict[str, Any]:
        op = d.get("op")
        try:
            if op == "mkdir":
                p = self.reel(normaliser(d.get("path")))
                _creer_dossier(p, parents=_vrai(d.get("parents", True)))
                return {"ok": True}
            if op == "remove":
                rel = normaliser(d.get("path"))
                if not rel:
                    raise Refus(400, "bad_path", "la racine ne se supprime pas")
                p = self.entree(rel)
                if not os.path.lexists(p):
                    if _vrai(d.get("missing_ok")):
                        return {"ok": True, "removed": 0}
                    raise Refus(404, "not_found", "introuvable")
                if _est_dossier(p) and not _vrai(d.get("recursive")):
                    os.rmdir(p)
                else:
                    _supprimer(p)
                return {"ok": True, "removed": 1}
            if op == "du":                               # taille d'un fichier ou d'un arbre
                return self._taille(self.entree(normaliser(d.get("path"))),
                                    max(0.1, min(float(d.get("deadline_s") or 10), 60.0)))
            if op == "clear":                            # tout /work, pas /work lui-même
                n = 0
                with os.scandir(self.racine) as it:
                    noms = [e.name for e in it]
                for nom in noms:
                    try:
                        _supprimer(os.path.join(self.racine, nom))
                        n += 1
                    except FileNotFoundError:
                        continue
                return {"ok": True, "removed": n}
            if op in ("rename", "copy"):
                return self._deplacer(op, normaliser(d.get("src")), normaliser(d.get("dst")),
                                      _vrai(d.get("overwrite")), _vrai(d.get("parents")),
                                      op == "copy" and _vrai(d.get("follow")),
                                      op == "copy" and _vrai(d.get("widen")))
            if op == "chmod":
                if "mode" not in d:
                    raise Refus(400, "bad_request", "chmod : mode requis")
                os.chmod(self.reel(normaliser(d.get("path"))), _mode(d["mode"]))
                return {"ok": True}
        except OSError as e:
            raise _refus_os(e) from None
        raise Refus(400, "bad_request", f"opération inconnue : {op!r}")

    def _taille(self, p: str, delai_s: float) -> Dict[str, Any]:
        """Octets de ``p`` (lstat : un lien compte pour lui-même, n'est pas
        suivi) et de son contenu ; ``complete`` à faux si le délai a coupé."""
        st = os.lstat(p)
        if not stat.S_ISDIR(st.st_mode):
            return {"ok": True, "bytes": st.st_size, "entries": 1, "complete": True}
        total = n = 0
        echeance = time.monotonic() + delai_s
        pile = [p]
        while pile:
            if time.monotonic() > echeance:
                return {"ok": True, "bytes": total, "entries": n, "complete": False}
            try:
                with os.scandir(pile.pop()) as it:
                    for e in it:
                        try:
                            s = e.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        n += 1
                        if stat.S_ISDIR(s.st_mode):
                            pile.append(e.path)
                        else:
                            total += s.st_size
            except OSError:
                continue
        return {"ok": True, "bytes": total, "entries": n, "complete": True}

    def _deplacer(self, op: str, src: str, dst: str, ecraser: bool, parents: bool,
                  suivre: bool = False, elargir: bool = False) -> Dict[str, Any]:
        """``rename`` ou ``copy``, sans suivre de lien à la destination. Un
        dossier n'est jamais remplacé, ni rien par un dossier : seul un
        fichier ou un lien est écrasé (``ecraser``), d'un coup. ``suivre``
        (copie) : une source qui est un lien est copiée depuis sa cible, sous
        la racine. ``elargir`` (copie) : droits de la copie élargis pour
        l'autre UID tant que l'hôte accède à /work."""
        if not src or not dst:
            raise Refus(400, "bad_path", "src et dst requis, hors racine")
        ps, pd = (self.reel(src) if suivre else self.entree(src)), self.entree(dst)
        os.lstat(ps)                                     # source absente : 404
        if ps == pd:
            return {"ok": True}
        if (pd + os.sep).startswith(ps + os.sep) or (ps + os.sep).startswith(pd + os.sep):
            raise Refus(409, "inside", "l'un est dans l'autre")
        if parents:
            _creer_dossier(os.path.dirname(pd))
        if os.path.lexists(pd):
            if not ecraser:
                raise Refus(409, "exists", "la destination existe")
            if _est_dossier(pd):
                raise Refus(409, "is_dir", "un dossier n'est jamais remplacé")
            if _est_dossier(ps):
                raise Refus(409, "exists", "un dossier ne remplace pas un fichier")
        if op == "rename":
            os.rename(ps, pd)
            return {"ok": True}
        tmp = _nom_provisoire(os.path.dirname(pd))
        try:
            if os.path.islink(ps):
                os.symlink(os.readlink(ps), tmp)
            elif _est_dossier(ps):
                shutil.copytree(ps, tmp, symlinks=True)
            else:
                shutil.copy2(ps, tmp)
            if elargir:
                _elargir(tmp)
            os.replace(tmp, pd)                          # un dossier apparu entre-temps : refus
        except BaseException:
            if os.path.lexists(tmp):
                _supprimer(tmp)
            raise
        return {"ok": True}


    # ── relevé avant / après une commande ──────────────────────────────────
    def _parcourir(self, sautes: frozenset, max_entrees: int, delai_s: float
                   ) -> Tuple[Dict[str, Cle], bool]:
        """{rel: (mtime_ns, taille, inode)} des fichiers ordinaires sous la
        racine ; bool : parcours complet. Aucun lien suivi ; dossiers nommés
        dans ``sautes`` et noms non UTF-8 ignorés."""
        vus: Dict[str, Cle] = {}
        echeance = time.monotonic() + delai_s
        n = 0
        pile = [(self.racine, "")]
        while pile:
            if time.monotonic() > echeance:
                return vus, False
            dossier, drel = pile.pop()
            try:
                with os.scandir(dossier) as it:
                    for e in it:
                        n += 1
                        if n > max_entrees or (n & 255) == 0 and time.monotonic() > echeance:
                            return vus, False
                        try:
                            e.name.encode("utf-8")
                            st = e.stat(follow_symlinks=False)
                        except (UnicodeEncodeError, OSError):
                            continue
                        rel = f"{drel}/{e.name}" if drel else e.name
                        if stat.S_ISDIR(st.st_mode):
                            if e.name not in sautes:
                                pile.append((e.path, rel))
                        elif stat.S_ISREG(st.st_mode):
                            vus[rel] = (st.st_mtime_ns, st.st_size, st.st_ino)
            except OSError:
                continue
        return vus, True

    def _lire_borne(self, rel: str, limite: int) -> Optional[bytes]:
        """Octets du fichier ordinaire ``rel`` ; ``None`` : absent, spécial,
        illisible ou plus de ``limite`` octets."""
        try:
            fd = _ouvrir_fichier(self.reel(rel))
        except Refus:
            return None
        try:
            with os.fdopen(fd, "rb") as f:
                data = f.read(limite + 1)
        except OSError:
            return None
        return data if len(data) <= limite else None

    def _rafraichir(self, vus: Dict[str, Cle]) -> None:
        """Contenus gardés : relus quand leur clé change, oubliés pour les
        fichiers disparus ; bornés par ``_RELEVE_CACHE``."""
        c = self._contenus
        for rel in [r for r in c if r not in vus]:
            self._octets_gardes -= len(c.pop(rel)[1])
        for rel, cle in vus.items():
            vu = c.get(rel)
            if vu is not None:
                if vu[0] == cle:
                    continue
                self._octets_gardes -= len(c.pop(rel)[1])
            if cle[1] > _RELEVE_GARDE or self._octets_gardes + cle[1] > _RELEVE_CACHE:
                continue
            data = self._lire_borne(rel, _RELEVE_GARDE)
            if data is None or b"\x00" in data[:8192]:
                continue
            c[rel] = (cle, data)
            self._octets_gardes += len(data)

    def releve_debut(self, sautes: Iterable[str], max_entrees: int,
                     delai_s: float) -> Dict[str, Any]:
        """Relevé AVANT une commande : clés de stat gardées sous un
        identifiant ; contenus des petits fichiers texte mis à jour."""
        sautes = frozenset(sautes)
        with self._verrou_releve:
            vus, complet = self._parcourir(sautes, max_entrees, delai_s)
            self._rafraichir(vus)
            ident = secrets.token_hex(8)
            maintenant = time.monotonic()
            for k in [k for k, v in self._releves.items() if maintenant - v[5] > _RELEVE_DUREE_S]:
                del self._releves[k]
            self._releves[ident] = (vus, complet, sautes, max_entrees, delai_s, maintenant)
            while len(self._releves) > _RELEVES_OUVERTS:
                del self._releves[next(iter(self._releves))]     # le plus ancien
        return {"id": ident, "complete": complet, "files": len(vus)}

    def releve_fin(self, ident: str, max_fichiers: int, max_octets: int,
                   max_fichier: int) -> Iterator[Dict[str, Any]]:
        """Fichiers créés, modifiés ou supprimés depuis ``releve_debut`` :
        contenu d'avant (gardé, si sa clé n'a pas bougé) et d'après (relu),
        ``max_octets`` en tout ; au-delà, l'état seul."""
        with self._verrou_releve:
            debut = self._releves.pop(ident, None)
            if debut is None:
                raise Refus(404, "not_found", "relevé inconnu ou expiré")
            avant, complet_avant, sautes, max_entrees, delai_s, _t = debut
            apres, complet = self._parcourir(sautes, max_entrees, delai_s)
            changes = []
            for rel, cle in apres.items():
                ancienne = avant.get(rel)
                if ancienne is None:
                    if complet_avant:                     # sinon : hors du premier parcours
                        changes.append((rel, "created"))
                elif ancienne != cle:
                    changes.append((rel, "modified"))
            if complet and complet_avant:
                changes.extend((rel, "deleted") for rel in avant if rel not in apres)
            changes.sort()
            budget = max_octets

            def etat(x: Any, trop: str) -> Dict[str, Any]:
                nonlocal budget
                if x is None:
                    return {"state": "absent"}
                if x is _INCONNU or x is _TROP_GROS:
                    return {"state": "unknown" if x is _INCONNU else "too_big"}
                if len(x) > budget:
                    return {"state": trop}
                budget -= len(x)
                return {"b64": base64.b64encode(x).decode("ascii")}

            rendu = []
            for rel, genre in changes[:max_fichiers]:
                vu = self._contenus.get(rel)
                av: Any = (None if genre == "created"
                           else vu[1] if vu is not None and vu[0] == avant.get(rel) else _INCONNU)
                ap: Any = None
                if genre != "deleted":
                    ap = (_TROP_GROS if apres[rel][1] > max_fichier
                          else self._lire_borne(rel, max_fichier))
                    if ap is None:
                        continue                          # disparu ou illisible
                if isinstance(av, bytes) and isinstance(ap, bytes) and av == ap:
                    continue                              # touché, contenu identique
                rendu.append({"path": rel, "change": genre, "before": etat(av, "unknown"),
                              "after": etat(ap, "too_big")})
            self._rafraichir(apres)
        yield from rendu
        yield {"done": True, "total": len(changes), "complete": complet and complet_avant}

class _Gestionnaire(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 600                                        # connexion inactive
    server: "_Serveur"
    _entetes_partis = False
    _corps_lu = False

    # socket unix : pas d'adresse de client ; pas de journal par requête.
    def address_string(self) -> str:
        return "hôte"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass

    def end_headers(self) -> None:
        self._entetes_partis = True
        super().end_headers()

    def do_GET(self) -> None:
        self._traiter()

    def do_POST(self) -> None:
        self._traiter()

    def do_PUT(self) -> None:
        self._traiter()

    def _traiter(self) -> None:
        self._entetes_partis = False
        self._corps_lu = self.command == "GET"
        agent = self.server.agent
        agent.signaler_activite()
        try:
            url = urlsplit(self.path)
            q = {k: v[-1] for k, v in parse_qs(url.query, keep_blank_values=True,
                                                errors="surrogateescape").items()}
            self._router(agent, url.path, q)
        except Refus as r:
            self._echec(r)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (ValueError, TypeError) as e:             # paramètre mal formé
            self._echec(Refus(400, "bad_request", str(e)))
        except Exception as e:                           # noqa: BLE001 — jamais tuer l'agent
            self._echec(Refus(500, "internal", f"{type(e).__name__}: {e}"))

    def _router(self, agent: Agent, route: str, q: Dict[str, str]) -> None:
        cle = (self.command, route)
        if cle == ("GET", "/v1/hello"):
            self._json(200, {"agent": "elpis", "version": VERSION, "pid": os.getpid(),
                             "uid": os.getuid(), "root": agent.racine,
                             "python": sys.version.split()[0]})
        elif cle == ("POST", "/v1/stat"):
            d = self._corps_json()
            chemins = d.get("paths") or []
            if not isinstance(chemins, list) or len(chemins) > 10000:
                raise Refus(400, "bad_request", "paths : liste de 10 000 chemins au plus")
            self._json(200, {"entries": agent.stat_lot(
                chemins, _vrai(d.get("hash")), int(d.get("hash_max") or 64 << 20))})
        elif cle == ("GET", "/v1/read"):
            self._lire(agent, q)
        elif cle == ("POST", "/v1/list"):
            d = self._corps_json()
            elaguer, exclure = d.get("prune") or [], d.get("exclude") or []
            if not isinstance(elaguer, list) or not isinstance(exclure, list):
                raise Refus(400, "bad_request", "prune, exclude : listes attendues")
            lignes = agent.lister(
                normaliser(d.get("path")), max(1, min(int(d.get("depth") or 1), _PROFONDEUR_MAX)),
                max(1, min(int(d.get("max_entries") or 20000), 200000)),
                _vrai(d.get("hidden", True)), [str(x) for x in elaguer],
                float(d.get("deadline_s") or 30), [str(x) for x in exclure],
                str(d.get("name_contains") or ""))
            premiere = next(lignes)                      # un refus part AVANT l'en-tête 200
            self._ndjson(premiere, lignes)
        elif cle == ("POST", "/v1/grep"):
            d = self._corps_json()
            chemins = d.get("paths") or []
            if not isinstance(chemins, list) or len(chemins) > 100000:
                raise Refus(400, "bad_request", "paths : liste de 100 000 fichiers au plus")
            aiguille = str(d.get("needle") or "")
            if not aiguille:
                raise Refus(400, "bad_request", "needle requis")
            casse = not _vrai(d.get("ignore_case", True))
            motif = None
            if _vrai(d.get("regex")):
                try:
                    motif = re.compile(aiguille, 0 if casse else re.IGNORECASE)
                except (re.error, RecursionError) as e:
                    raise Refus(400, "bad_regex", str(e)[:200]) from None
            self._ndjson({"started": True}, agent.grep(
                chemins, aiguille, casse,
                int(d.get("max_file_bytes") or 20 << 20), max(1, int(d.get("max_hits") or 2000)),
                largeur=max(40, min(int(d.get("width") or 260), 4096)),
                fichiers_seuls=_vrai(d.get("files_only")),
                delai_s=max(0.1, min(float(d.get("deadline_s") or 600), 600.0)),
                motif=motif, contexte=max(0, min(int(d.get("context") or 0), 1000)),
                max_ligne=max(1, int(d.get("max_line") or 20000))))
        elif cle == ("POST", "/v1/readmany"):
            d = self._corps_json()
            chemins = d.get("paths") or []
            if not isinstance(chemins, list) or len(chemins) > 10000:
                raise Refus(400, "bad_request", "paths : liste de 10 000 fichiers au plus")
            self._ndjson({"started": True}, agent.lire_plusieurs(
                chemins, max(0, int(d.get("max_file") or 1 << 20)),
                max(0, int(d.get("max_total") or 32 << 20))))
        elif cle == ("PUT", "/v1/write"):
            self._json(200, agent.ecrire(
                normaliser(q.get("path")), self._corps(_entier(q, "max", _MAX_ECRITURE)),
                mode=q.get("mode"), parents=_vrai(q.get("parents")),
                si_absent=_vrai(q.get("if_absent")), si_sha256=q.get("if_sha256") or "",
                si_mtime_ns=_entier(q, "if_mtime_ns", mini=None)))
        elif cle == ("PUT", "/v1/append"):
            self._json(200, agent.ajouter(
                normaliser(q.get("path")), self._corps(_entier(q, "max", _MAX_ECRITURE)),
                parents=_vrai(q.get("parents")), tronquer=_vrai(q.get("truncate"))))
        elif cle == ("POST", "/v1/fsop"):
            self._json(200, agent.fsop(self._corps_json()))
        elif cle == ("POST", "/v1/changes/begin"):
            d = self._corps_json()
            sautes = d.get("skip") or []
            if not isinstance(sautes, list):
                raise Refus(400, "bad_request", "skip : liste attendue")
            self._json(200, agent.releve_debut(
                [str(x) for x in sautes], max(1, min(int(d.get("max_entries") or 20000), 200000)),
                max(0.1, min(float(d.get("deadline_s") or 1.5), 30.0))))
        elif cle == ("POST", "/v1/changes/end"):
            d = self._corps_json()
            lignes = agent.releve_fin(
                str(d.get("id") or ""), max(0, min(int(d.get("max_files") or 200), 5000)),
                max(0, int(d.get("max_bytes") or 32 << 20)), max(0, int(d.get("max_file") or 5 << 20)))
            premiere = next(lignes)                      # relevé inconnu : refus AVANT l'en-tête 200
            self._ndjson(premiere, lignes)
        elif cle == ("POST", "/v1/shutdown"):
            attendue = self._corps_json().get("if_version")
            if attendue and attendue != VERSION:         # déjà remplacé par un autre
                raise Refus(409, "changed", "version différente", version=VERSION)
            self._json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            raise Refus(404, "unknown_route", f"{self.command} {route}")

    # ── corps ──────────────────────────────────────────────────────────────
    def _corps(self, limite: Optional[int]) -> Iterator[bytes]:
        """Corps de la requête par blocs ; Content-Length obligatoire."""
        if self.headers.get("Transfer-Encoding"):
            raise Refus(411, "length_required", "Content-Length requis")
        reste = int(self.headers.get("Content-Length") or 0)
        if limite is not None and reste > limite:
            raise Refus(413, "too_large", "corps trop volumineux", max=limite)
        while reste:
            b = self.rfile.read(min(reste, _BLOC))
            if not b:
                raise Refus(400, "bad_request", "corps tronqué")
            reste -= len(b)
            yield b
        self._corps_lu = True

    def _corps_json(self) -> Dict[str, Any]:
        brut = b"".join(self._corps(_MAX_JSON))
        try:
            d = json.loads(brut or b"{}")
        except (ValueError, RecursionError):
            raise Refus(400, "bad_request", "JSON invalide") from None
        if not isinstance(d, dict):
            raise Refus(400, "bad_request", "objet JSON attendu")
        return d

    # ── réponses ───────────────────────────────────────────────────────────
    def _json(self, statut: int, obj: Dict[str, Any]) -> None:
        brut = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(statut)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(brut)))
        if not self._corps_lu:
            self.send_header("Connection", "close")      # corps non lu : flux désynchronisé
            self.close_connection = True
        self.end_headers()
        self.wfile.write(brut)

    def _echec(self, r: Refus) -> None:
        if self._entetes_partis:                         # une réponse est déjà partie :
            self.close_connection = True                 # le client verra un flux coupé
            return
        self._json(r.statut, {"error": r.code, "message": r.message, **r.extra})

    def _ndjson(self, premiere: Dict[str, Any], suite: Iterator[Dict[str, Any]]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        tampon: list = []
        taille = 0

        def vider() -> None:
            nonlocal tampon, taille
            if tampon:
                b = b"".join(tampon)
                self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b))
                tampon, taille = [], 0

        def lignes() -> Iterator[Dict[str, Any]]:
            yield premiere
            try:
                yield from suite
            except Refus as r:                           # en cours de flux : dernière ligne
                yield {"error": r.code, "message": r.message}
            except Exception as e:                       # noqa: BLE001
                yield {"error": "internal", "message": f"{type(e).__name__}: {e}"}
        vide = time.monotonic()
        for obj in lignes():
            b = json.dumps(obj, separators=(",", ":")).encode() + b"\n"
            tampon.append(b)
            taille += len(b)
            if taille >= 65536 or time.monotonic() - vide >= 1.0:
                vider()
                vide = time.monotonic()
        vider()
        self.wfile.write(b"0\r\n\r\n")

    def _lire(self, agent: Agent, q: Dict[str, str]) -> None:
        fd = _ouvrir_fichier(agent.reel(normaliser(q.get("path"))))
        try:
            st = os.fstat(fd)
            infos = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "ino": st.st_ino,
                     "dev": st.st_dev, "mode": stat.S_IMODE(st.st_mode)}
            if (_entier(q, "expect_size") not in (None, st.st_size)
                    or _entier(q, "expect_mtime_ns", mini=None) not in (None, st.st_mtime_ns)):
                raise Refus(412, "changed", "fichier modifié entre-temps", stat=infos)
            debut = min(_entier(q, "offset", 0) or 0, st.st_size)
            n = st.st_size - debut
            longueur = _entier(q, "length")
            if longueur is not None:
                n = min(n, longueur)
            maxi = _entier(q, "max", _MAX_LECTURE)
            if maxi is not None and n > maxi:
                raise Refus(413, "too_large", "fichier trop volumineux", stat=infos, max=maxi)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(n))
            self.send_header("X-Elpis-Stat", json.dumps(infos))
            self.end_headers()
            os.lseek(fd, debut, os.SEEK_SET)
            while n:
                b = os.read(fd, min(n, _BLOC))
                if not b:                                # tronqué entre-temps : le client
                    self.close_connection = True         # voit un corps incomplet
                    return
                self.wfile.write(b)
                n -= len(b)
        finally:
            os.close(fd)


class _Serveur(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, chemin_socket: str, agent: Agent) -> None:
        self.agent = agent
        super().__init__(chemin_socket, _Gestionnaire)
        os.chmod(chemin_socket, 0o666)                   # l'hôte n'a pas l'UID du conteneur


def servir(racine: str, chemin_socket: str) -> _Serveur:
    """Serveur lié à ``chemin_socket`` (remplace un socket orphelin) ; à faire
    tourner par ``serve_forever``. L'appelant tient le verrou d'instance."""
    try:
        os.unlink(chemin_socket)
    except FileNotFoundError:
        pass
    return _Serveur(chemin_socket, Agent(racine))


def _verrou_instance(dossier: str, attente_s: float) -> Optional[int]:
    """fd du verrou d'instance, ou ``None`` si un autre agent le garde. Un
    agent qui s'arrête le tient jusqu'à la fin de son processus : on attend."""
    chemin = os.path.join(dossier, "agent.lock")
    try:
        fd = os.open(chemin, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o666)
    except PermissionError:                              # laissé par un autre UID
        os.unlink(chemin)
        fd = os.open(chemin, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o666)
    echeance = time.monotonic() + attente_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if time.monotonic() > echeance:
                os.close(fd)
                return None
            time.sleep(0.05)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Agent de la sandbox Elpis")
    ap.add_argument("--root", default="/work")
    ap.add_argument("--socket", default="/run/elpis/agent.sock")
    ap.add_argument("--lock-wait", type=float, default=10.0,
                    help="attente du verrou d'instance (s) : un agent qui s'arrête le tient encore")
    args = ap.parse_args(argv)
    os.umask(0)                                          # fichiers 0666 / dossiers 0777
    if _verrou_instance(os.path.dirname(args.socket), args.lock_wait) is None:
        return 0
    # Le socket reste en place à l'arrêt : le suivant le remplace (servir).
    servir(args.root, args.socket).serve_forever(poll_interval=0.2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
