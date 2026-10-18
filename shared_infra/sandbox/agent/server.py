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
                  → {"entries": [...]} ; une entrée en échec : kind "error" ; kind
                  "other" (fichier spécial) : "special" = fifo, socket, char_device
                  ou block_device (S_IFMT, fichier jamais ouvert)
  GET  /v1/read   ?path= &offset= &length= &max= &expect_size= &expect_mtime_ns=
                  &expect_ino=  → octets, en-tête X-Elpis-Stat
  POST /v1/list   {"path", "depth", "max_entries", "hidden", "prune": [motifs],
                   "exclude": [motifs], "deadline_s", "name_contains", "kinds": [genres],
                   "name_glob"}  → NDJSON {"path", "kind", "size", "mtime_ns", "mode"
                   [, "special"]}, dernière ligne {"done": true, …}
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
  POST /v1/changes/begin {"skip": [noms], "max_entries", "deadline_s", "all_kinds"}
                  → {"id", "complete", "files"} (relevé avant une commande ;
                  all_kinds : liens et fichiers spéciaux aussi, jamais suivis)
  POST /v1/changes/end {"id", "max_files", "max_bytes", "max_file"} → NDJSON
                  {"path", "change", "before", "after"} ({"b64"} ou {"state"}) ;
                  lien ou fichier spécial (all_kinds) : en plus "kind", et
                  before/after = {"kind"[, "target"]} ou {"state": "absent"} ;
                  dernière ligne {"done": true, "total", "complete"}
  POST /v1/git    {"cwd", "args": [...], "timeout_s", "max_out", "env": {…},
                   "relay": {"socket", "ticket", "origin"}}
                  → {"returncode", "stdout", "stderr", "truncated", "timed_out",
                  "duration_ms"} ; git durci (_GIT_CONFIG), sortie en UTF-8
                  (octets invalides remplacés) ; « relay » : réseau par le
                  relais de l'hôte, le temps de la commande (cf. _Relais)
  POST /v1/archive {"paths": [...], "base", "prefix", "format": "zip|tgz|raw",
                   "dirs", "walk", "strict", "max_bytes", "max_files", "deadline_s"}
                  → trames (octet de genre, longueur sur 4 octets, corps) : J
                  {"start", "files", "dirs", "bytes", "truncated"}, puis D (octets
                  de l'archive) et J {"progress"} ; en ``raw``, J {"entry", "kind",
                  "size", "mtime_ns", "mode"} avant les octets de chaque fichier ;
                  dernière trame J {"done", "files", "bytes", "skipped", …} ou
                  {"error"}. ``strict`` : au-delà des bornes, 413 avant tout octet.
  PUT  /v1/extract ?path= &keep= &leave= &max_bytes= &max_file= &max_members=
                  (corps = archive tar, gzip ou non) → {"files", "dirs", "bytes",
                  "omitted", "conflicts"} : le contenu de path est remplacé
  POST /v1/jobs/start {"id", "command", "cwd", "env", "label", "wake_on", "chain_depth"}
                  → {"id", "pid", "state", "log", "started_at", "wake_on"} : job de
                  fond (``bash -c`` en nouvelle session, sortie dans .bg/job-<id>.log,
                  code dans .bg/job-<id>.exit) ; chain_depth (profondeur du tour qui
                  le lance, facultative) gardée dans sa fiche et écrite dans chacun de
                  ses événements, absente sinon ; 409 job_exists, 403 outside_root,
                  400 bad_request, 429 too_many_jobs
  POST /v1/jobs/kill {"id", "signal": "TERM|KILL|INT", "grace_s", "by", "purge"}
                  → {"id", "killed_pids", "state", "exit_code", "signal"} : groupe
                  et processus marqués ELPIS_JOB_ID ; 409 job_not_running
  GET  /v1/jobs/status ?id=  → {"jobs": [{"id", "state", "pid", "alive", "runtime_s",
                  "log_bytes", "log_lines", "last_line", "wake_on", "fired",
                  "exit_code", "signal", "started_at", "ended_at", "disarmed"}]} (sans
                  id : tous) ; disarmed : regex retirées, [{"spec", "reason"}]
  GET  /v1/jobs/list  → même forme, fiches de .bg/ inconnues comprises
  POST /v1/jobs/watch {"since_seq", "wait_s"} → NDJSON : {"tick"} au moins toutes
                  les 2 s, les événements de seq > since_seq (jobs-events.ndjson),
                  dernière ligne {"done", "last_seq", "running", "reset"}
  POST /v1/shutdown {"if_version": v}

En-tête ``X-Elpis-Passive: 1`` : requête de l'hôte qui ne compte pas comme une
activité de la sandbox (sondage périodique de l'éditeur, veille des jobs).
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import errno
import fcntl
import fnmatch
import gzip
import hashlib
import io
import json
import os
import re
import secrets
import select
import shutil
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
import zlib
from collections import deque
from http.server import BaseHTTPRequestHandler
from typing import Any, Dict, Iterable, Iterator, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

with open(__file__, "rb") as _f:
    VERSION = hashlib.sha256(_f.read()).hexdigest()[:16]

_BLOC = 1 << 20                      # lecture/écriture par blocs de 1 Mio
_MAX_JSON = 4 << 20                  # corps JSON d'une requête
_MAX_LECTURE = 64 << 20              # read sans « max » explicite
_MAX_ECRITURE = 1 << 30              # write sans « max » explicite
_MODE_FICHIER, _MODE_DOSSIER = 0o644, 0o755   # créations, quel que soit l'umask
_ACTIVITE_S = 10                     # mtime de la racine = activité (GC d'inactivité)
_RELEVE_GARDE = 512 * 1024           # relevé : contenu gardé par fichier
_RELEVE_CACHE = 24 << 20             # relevé : contenus gardés en tout
_RELEVES_OUVERTS = 16                # relevés ouverts en même temps
_RELEVE_DUREE_S = 3600               # un relevé jamais clos est oublié
_CIBLE_RELEVEE = 256                 # relevé : texte d'un lien gardé (au-delà : début + empreinte)
_PROFONDEUR_MAX = 4096               # list : profondeur (au-delà, PATH_MAX)
_SIGNE_S = 2.0                       # flux NDJSON : signe de vie au moins toutes les 2 s
_PROGRES_S = 0.5                     # archive : progression au moins toutes les 0,5 s
_OMIS_DETAILLES = 100                # archive : entrées omises détaillées dans le bilan
_OMIS_OCTETS = 64 << 10              # archive : leur poids en JSON (trame de fin bornée)
_ENTETE_TAR_MAX = 1 << 20            # extraction : en-tête pax ou nom long GNU
_PROVISOIRE_VIEUX_S = 3600           # extraction : provisoire d'un agent mort, retiré
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
          errno.ENOSPC: (507, "no_space"), errno.EDQUOT: (507, "no_space"),
          errno.ENXIO: (409, "not_file"), errno.ESTALE: (409, "changed")}


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


@contextlib.contextmanager
def _dossier_et_fd(p: str, attendu: Optional[Tuple[int, int]]) -> Iterator[Tuple[int, Any]]:
    """(descripteur, ``os.scandir``) du dossier ``p`` ouvert SANS suivre de
    lien, puis comparé (``st_dev``, ``st_ino``) à ce que le parcours a relevé :
    un dossier remplacé entre le relevé et l'ouverture — par un lien
    (``ELOOP``) ou par un autre dossier (``ESTALE``) — n'est pas parcouru. Les
    entrées sont relatives au descripteur : ``entree.path`` vaut
    ``entree.name``, ``entree.stat`` reste dans ce dossier."""
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if attendu is not None:
            vu = os.fstat(fd)
            if (vu.st_dev, vu.st_ino) != attendu:
                raise OSError(errno.ESTALE, "dossier remplacé pendant le parcours")
        with os.scandir(fd) as it:
            yield fd, it
    finally:
        os.close(fd)


@contextlib.contextmanager
def _dossier_sans_lien(p: str, attendu: Optional[Tuple[int, int]]) -> Iterator[Any]:
    """``_dossier_et_fd`` sans le descripteur."""
    with _dossier_et_fd(p, attendu) as (_fd, it):
        yield it


def _cible_relevee(cible: str) -> str:
    """Texte d'un lien pour le relevé : au-delà de ``_CIBLE_RELEVEE``, son début et une empreinte."""
    if len(cible) <= _CIBLE_RELEVEE:
        return cible
    empreinte = hashlib.sha256(cible.encode("utf-8", "surrogateescape")).hexdigest()[:16]
    return f"{cible[:_CIBLE_RELEVEE]}…#{empreinte}"


def _etat_autre(v: Optional[Tuple[str, str]]) -> Dict[str, Any]:
    """État relevé d'un lien ou d'un fichier spécial : genre (et texte du lien) ou absent."""
    if v is None:
        return {"state": "absent"}
    if v[0] != "link":
        return {"kind": v[0]}
    return {"kind": "link", "target": v[1].encode("utf-8", "surrogateescape").decode("utf-8", "replace")}


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


_SPECIAUX = {stat.S_IFIFO: "fifo", stat.S_IFSOCK: "socket", stat.S_IFCHR: "char_device",
             stat.S_IFBLK: "block_device"}


def _special(mode: int) -> Optional[str]:
    """Genre exact d'un fichier spécial, lu dans ``S_IFMT`` (jamais ouvert) ; ``None`` sinon."""
    return _SPECIAUX.get(stat.S_IFMT(mode))


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


def _copier_entree(src: str, dst: str) -> None:
    """Copie d'une entrée qui n'est ni un dossier ni un lien, comme ``cp -a`` :
    fichier ordinaire (contenu, droits, dates), FIFO et socket recréés ;
    un périphérique est laissé de côté (jamais de nœud créé dans /work)."""
    st = os.lstat(src)
    if stat.S_ISREG(st.st_mode):
        shutil.copy2(src, dst)
    elif stat.S_ISFIFO(st.st_mode) or stat.S_ISSOCK(st.st_mode):
        os.mknod(dst, stat.S_IFMT(st.st_mode) | stat.S_IMODE(st.st_mode))
        os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False)


def _supprimer(p: str) -> None:
    """Supprime ``p`` : un dossier récursivement, un lien comme lui-même."""
    if _est_dossier(p):
        shutil.rmtree(p)                                 # ne suit aucun lien
    else:
        os.unlink(p)


def _supprimer_obstine(p: str) -> None:
    """``_supprimer``, puis un second essai après avoir rendu inscriptibles
    les dossiers de l'arbre (cache Go en 0555, dossier sans ``w``…) : le
    conteneur en est propriétaire, il peut rétablir ses droits."""
    try:
        _supprimer(p)
        return
    except PermissionError:
        if not _est_dossier(p):
            raise
    pile = [p]
    while pile:                                          # droits rétablis AVANT d'y
        dossier = pile.pop()                             # descendre (dossier en 0300)
        try:
            st = os.lstat(dossier)
            if not stat.S_ISDIR(st.st_mode):
                continue
            os.chmod(dossier, stat.S_IMODE(st.st_mode) | stat.S_IRWXU)
            with os.scandir(dossier) as it:
                pile.extend(e.path for e in it if e.is_dir(follow_symlinks=False))
        except OSError:
            continue
    _supprimer(p)


def _nom_libre(dossier: str, nom: str, suffixe: str) -> str:
    """``dossier/nom.suffixe-<hex>`` : un nom qui n'existe pas encore, sous
    la limite de 255 octets d'un nom (le nom d'origine est raccourci)."""
    fin = f".{suffixe}-{secrets.token_hex(4)}"
    base = nom.encode("utf-8", "surrogateescape")[:255 - len(fin.encode())]
    return os.path.join(dossier, base.decode("utf-8", "ignore") + fin)


def _nom_simple(v: Any) -> str:
    """Un nom d'entrée (un seul composant), ou ``""``."""
    nom = normaliser(v or "")
    if "/" in nom:
        raise Refus(400, "bad_path", "un nom sans « / » attendu")
    return nom


# ── archives ───────────────────────────────────────────────────────────────
class _Sortie:
    """Réponse en trames, en HTTP chunked : ``D`` (octets de l'archive,
    regroupés par blocs de 1 Mio) ou ``J`` (un objet JSON) ; genre sur un
    octet, longueur sur quatre (gros-boutiste), corps."""

    def __init__(self, wfile: Any) -> None:
        self._w = wfile
        self._tampon = bytearray()
        self.terminee = False

    def write(self, b: Any) -> int:
        # Réponse finie (bilan, erreur ou client parti) : ce qu'écrirait encore
        # un finaliseur (répertoire central d'un zip abandonné, fin d'un gzip)
        # n'a plus sa place — après la dernière trame, il casserait la connexion.
        if self.terminee:
            return len(b)
        self._tampon += b
        if len(self._tampon) >= _BLOC:
            self._vider()
        return len(b)

    def flush(self) -> None:
        pass

    def close(self) -> None:                              # zipfile : rien à fermer ici
        pass

    def json(self, obj: Dict[str, Any]) -> None:
        self._vider()
        self._trame(b"J", json.dumps(obj, separators=(",", ":")).encode())

    def fermer(self) -> None:
        self._vider()
        self.terminee = True
        self._w.write(b"0\r\n\r\n")

    def abandonner(self) -> None:
        """Client parti : plus rien n'est écrit."""
        self._tampon.clear()
        self.terminee = True

    def _vider(self) -> None:
        if self._tampon:
            self._trame(b"D", bytes(self._tampon))
            self._tampon.clear()

    def _trame(self, genre: bytes, corps: bytes) -> None:
        if self.terminee:                                # cf. ``write``
            return
        t = genre + len(corps).to_bytes(4, "big") + corps
        self._w.write(b"%x\r\n%s\r\n" % (len(t), t))


def _copier(fd: int, dest: Any, taille: int) -> Tuple[int, Optional[str]]:
    """Au plus ``taille`` octets de ``fd`` vers ``dest`` : (nombre copié,
    ``None`` si tout y est, sinon le code : ``changed`` pour un fichier
    raccourci pendant la lecture, celui de l'erreur de lecture sinon). Une
    erreur de lecture n'arrête que ce fichier, pas l'archive."""
    n = 0
    while n < taille:
        try:
            b = os.read(fd, min(_BLOC, taille - n))
        except OSError as e:
            return n, _refus_os(e).code
        if not b:
            return n, "changed"
        dest.write(b)
        n += len(b)
    return n, None


class _Exact(io.RawIOBase):
    """``taille`` octets exactement de ``fd`` (en-tête tar déjà écrit) : un
    fichier raccourci entre-temps est complété par des octets nuls
    (``complete`` à faux)."""

    def __init__(self, fd: int, taille: int) -> None:
        self._fd, self._reste = fd, taille
        self.erreur: Optional[str] = None

    @property
    def complete(self) -> bool:
        return self.erreur is None

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        n, lu = min(len(b), self._reste), 0         # toujours n octets : tarfile
        while lu < n and self.complete:              # refuse une lecture courte
            try:
                morceau = os.read(self._fd, n - lu)
            except OSError as e:                     # l'entrée est complétée,
                self.erreur = _refus_os(e).code      # l'archive continue
                break
            if not morceau:
                self.erreur = "changed"
                break
            b[lu:lu + len(morceau)] = morceau
            lu += len(morceau)
        b[lu:n] = bytes(n - lu)
        self._reste -= n
        return n


def _decalage(t: float, decalages: Optional[list]) -> Optional[int]:
    """Décalage de l'heure locale de l'HÔTE à l'instant ``t`` : ``decalages``
    = [[borne, secondes], …], le décalage valant AVANT sa borne, la dernière
    borne ``None`` (``_offset_segments`` de l'hôte)."""
    if not decalages:
        return None
    for borne, sec in decalages:
        if borne is None or t < borne:
            return int(sec)
    return int(decalages[-1][1])


def _date_zip(t: float, decalages: Optional[list] = None) -> Tuple[int, int, int, int, int, int]:
    """Date d'une entrée zip, bornée à la plage du format (1980-2107). Le zip
    note l'heure LOCALE sans fuseau : celle de l'hôte (le conteneur vit en
    UTC, les fichiers paraissaient une ou deux heures plus vieux)."""
    try:
        sec = _decalage(t, decalages)
        brut = time.gmtime(t + sec)[:6] if sec is not None else time.localtime(t)[:6]
    except (OverflowError, ValueError, OSError):         # date hors de portée
        brut = (2107, 12, 31, 23, 59, 58) if t > 0 else (1980, 1, 1, 0, 0, 0)
    a, mo, j, h, mi, s = min(max(brut, (1980, 1, 1, 0, 0, 0)), (2107, 12, 31, 23, 59, 58))
    return a, mo, j, h, mi, s


class _Zip:
    def __init__(self, sortie: _Sortie, decalages: Optional[list] = None) -> None:
        self._zf = zipfile.ZipFile(sortie, "w", zipfile.ZIP_DEFLATED)
        self._decalages = decalages

    def dossier(self, nom: str, st: os.stat_result) -> None:
        zi = zipfile.ZipInfo(nom + "/", _date_zip(st.st_mtime, self._decalages))
        zi.external_attr = (stat.S_IFDIR | stat.S_IMODE(st.st_mode)) << 16 | 0x10
        self._zf.writestr(zi, b"")

    def fichier(self, nom: str, st: os.stat_result, fd: int) -> Tuple[int, Optional[str]]:
        zi = zipfile.ZipInfo(nom, _date_zip(st.st_mtime, self._decalages))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = (st.st_mode & 0xFFFF) << 16
        with self._zf.open(zi, "w", force_zip64=st.st_size >= zipfile.ZIP64_LIMIT) as w:
            return _copier(fd, w, st.st_size)

    def fermer(self) -> None:
        self._zf.close()


class _Tar:
    def __init__(self, sortie: _Sortie, decalages: Optional[list] = None) -> None:
        self._gz = gzip.GzipFile(fileobj=sortie, mode="wb", compresslevel=6)
        self._tf = tarfile.open(fileobj=self._gz, mode="w|",   # noqa: SIM115 — fermé par fermer()
                                format=tarfile.PAX_FORMAT)

    def _info(self, nom: str, st: os.stat_result) -> tarfile.TarInfo:
        ti = tarfile.TarInfo(nom)
        ti.mode, ti.mtime = stat.S_IMODE(st.st_mode), int(st.st_mtime)
        return ti

    def dossier(self, nom: str, st: os.stat_result) -> None:
        ti = self._info(nom, st)
        ti.type = tarfile.DIRTYPE
        self._tf.addfile(ti)

    def fichier(self, nom: str, st: os.stat_result, fd: int) -> Tuple[int, Optional[str]]:
        ti = self._info(nom, st)
        ti.size = st.st_size
        src = _Exact(fd, st.st_size)
        self._tf.addfile(ti, src)
        return st.st_size, src.erreur

    def fermer(self) -> None:
        self._tf.close()
        self._gz.close()


class _Brut:
    """Chaque entrée en trame ``J {"entry"}``, suivie des octets d'un fichier ;
    un fichier dont tous les octets n'ont pu être lus est suivi d'une trame
    ``J {"incomplete": nom, "code": code}`` (pas « error » : le client y lit
    la fin de l'archive en échec)."""

    def __init__(self, sortie: _Sortie, decalages: Optional[list] = None) -> None:
        self._s = sortie

    def _entree(self, nom: str, genre: str, st: os.stat_result) -> None:
        self._s.json({"entry": nom, "kind": genre, "size": st.st_size if genre == "file" else 0,
                      "mtime_ns": st.st_mtime_ns, "mode": stat.S_IMODE(st.st_mode)})

    def dossier(self, nom: str, st: os.stat_result) -> None:
        self._entree(nom, "dir", st)

    def fichier(self, nom: str, st: os.stat_result, fd: int) -> Tuple[int, Optional[str]]:
        self._entree(nom, "file", st)
        n, erreur = _copier(fd, self._s, st.st_size)
        if erreur:
            self._s.json({"incomplete": nom, "code": erreur, "bytes": n})
        return n, erreur

    def fermer(self) -> None:
        pass


_FORMATS: Dict[str, Any] = {"zip": _Zip, "tgz": _Tar, "raw": _Brut}


def _args_archive(d: Dict[str, Any]) -> Dict[str, Any]:
    chemins = d.get("paths", [""])
    if not isinstance(chemins, list) or not chemins or len(chemins) > 10000:
        raise Refus(400, "bad_request", "paths : liste de 1 à 10 000 chemins")
    genre = d.get("format") or "zip"
    if genre not in _FORMATS:
        raise Refus(400, "bad_request", f"format inconnu : {genre!r}")
    prefixe = normaliser(d.get("prefix") or "")
    return {"paths": chemins, "base": normaliser(d.get("base") or ""),
            "prefix": prefixe + "/" if prefixe else "", "format": genre,
            "dirs": _vrai(d.get("dirs")), "walk": _vrai(d.get("walk", True)),
            "strict": _vrai(d.get("strict", True)),
            "max_bytes": max(0, int(d.get("max_bytes") or 1 << 30)),
            "max_files": max(0, int(d.get("max_files") or 20000)),
            "deadline_s": max(0.1, min(float(d.get("deadline_s") or 30), 300.0)),
            "utc_offsets": _decalages_valides(d.get("utc_offsets"))}


def _decalages_valides(v: Any) -> Optional[list]:
    """Table des décalages horaires de l'hôte, ou ``None`` (heure du conteneur)."""
    if not isinstance(v, list) or not 0 < len(v) <= 256:
        return None
    rendu = []
    for x in v:
        if (not isinstance(x, list) or len(x) != 2 or isinstance(x[1], bool)
                or not isinstance(x[1], int) or abs(x[1]) > 86400
                or not (x[0] is None or isinstance(x[0], int) and not isinstance(x[0], bool))):
            return None
        rendu.append([x[0], x[1]])
    return rendu if rendu[-1][0] is None else None


class _InfoBornee(tarfile.TarInfo):
    """En-têtes étendus (pax, noms longs GNU) bornés AVANT d'être lus :
    ``tarfile`` les garde entiers en mémoire (256 Mio annoncés dans une
    archive de 255 Ko : l'agent tué par la limite mémoire du conteneur)."""

    def _compter(self, tf: Any, quoi: str) -> None:
        # Borne par en-tête ET en tout : 200 en-têtes globaux de 1 Mio chacun
        # s'empilaient en mémoire (relecture finale).
        total = getattr(tf, "_elpis_entetes", 0) + self.size
        tf._elpis_entetes = total
        if self.size > _ENTETE_TAR_MAX or total > 4 * _ENTETE_TAR_MAX:
            raise tarfile.HeaderError(f"{quoi} trop grand")

    def _proc_pax(self, tf: Any) -> Any:
        self._compter(tf, "en-tête pax")
        return super()._proc_pax(tf)                     # type: ignore[misc]

    def _proc_gnulong(self, tf: Any) -> Any:
        self._compter(tf, "nom long")
        return super()._proc_gnulong(tf)                 # type: ignore[misc]

    # Fichiers « sparse » (GNU ou pax) refusés : leur carte n'est pas bornée.
    def _proc_sparse(self, tf: Any) -> Any:
        raise tarfile.HeaderError("fichier sparse refusé")

    def _proc_gnusparse_00(self, *a: Any) -> Any:
        raise tarfile.HeaderError("fichier sparse refusé")

    def _proc_gnusparse_01(self, *a: Any) -> Any:
        raise tarfile.HeaderError("fichier sparse refusé")

    def _proc_gnusparse_10(self, *a: Any) -> Any:
        raise tarfile.HeaderError("fichier sparse refusé")


def _retirer_provisoires_vieux(dossier: str) -> None:
    """``.elpis-tmp-*`` de plus d'une heure laissés dans ``dossier`` par un
    agent mort en pleine extraction (quota, instantanés, exports)."""
    limite = time.time() - _PROVISOIRE_VIEUX_S
    with contextlib.suppress(OSError), os.scandir(dossier) as it:
        vieux = [e.path for e in it if e.name.startswith(".elpis-tmp-")
                 and e.is_dir(follow_symlinks=False)
                 and e.stat(follow_symlinks=False).st_mtime < limite]
    for p in vieux:
        with contextlib.suppress(OSError):
            _supprimer_obstine(p)


class _Lecteur(io.RawIOBase):
    """Les blocs du corps de la requête, lus comme un fichier."""

    def __init__(self, blocs: Iterable[bytes]) -> None:
        self._blocs, self._bloc, self._pos = iter(blocs), b"", 0

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        if self._pos >= len(self._bloc):
            self._bloc, self._pos = next(self._blocs, b""), 0
        n = min(len(b), len(self._bloc) - self._pos)
        b[:n] = memoryview(self._bloc)[self._pos:self._pos + n]
        self._pos += n
        return n


class Agent:
    """Les opérations, sans rien du transport HTTP."""

    def __init__(self, racine: str, relais: str = "", config_git: str = "") -> None:
        self.racine = os.path.realpath(racine)
        self.relais = relais or RELAIS_DOSSIER
        self.config_git = config_git
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
        self.jobs = _Jobs(self)

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
        if _special(st.st_mode):
            d["special"] = _special(st.st_mode)
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
               exclure: Iterable[str] = (), contient: str = "",
               genres: Iterable[str] = (), motif: str = "") -> Iterator[Dict[str, Any]]:
        """Arborescence sous ``rel``. ``exclure`` : motifs (fnmatch) sur le
        nom ou le chemin relatif au dossier listé — ni rendu ni descendu ;
        ``elaguer`` : motifs sur le nom des dossiers rendus mais non
        descendus. Filtres de rendu (tout est parcouru ; seules les entrées
        rendues comptent dans ``max_entrees``) : ``contient`` (nom qui le
        contient, sans casse), ``genres`` (``file``, ``dir``, ``link``,
        ``other``), ``motif`` (nom qui correspond, fnmatch)."""
        base = self.reel(rel)
        exclure = tuple(exclure)
        try:
            st_base = os.stat(base)
        except OSError as e:
            raise _refus_os(e) from None
        if not stat.S_ISDIR(st_base.st_mode):
            raise Refus(409, "not_dir", "pas un dossier")
        elaguer = tuple(elaguer)
        contient = contient.lower()
        genres = frozenset(genres)
        echeance = time.monotonic() + delai_s
        pile = [(base, rel, 1, (st_base.st_dev, st_base.st_ino))]
        n = erreurs = illisibles = 0
        tronque = False
        signe = time.monotonic()
        premier = True
        while pile and not tronque:
            if time.monotonic() - signe > _SIGNE_S:
                signe = time.monotonic()
                yield {"tick": True}
            dossier, drel, niveau, attendu = pile.pop()
            try:
                with _dossier_sans_lien(dossier, attendu) as it:
                    premier = False
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
                        if ((not contient or contient in entree.name.lower())
                                and (not genres or genre in genres)
                                and (not motif or fnmatch.fnmatchcase(entree.name, motif))):
                            vu = {"path": erel, "kind": genre, "size": st.st_size,
                                  "mtime_ns": st.st_mtime_ns, "mode": stat.S_IMODE(st.st_mode)}
                            if _special(st.st_mode):
                                vu["special"] = _special(st.st_mode)
                            yield vu
                            n += 1
                        if genre == "dir" and niveau < profondeur and not any(
                                fnmatch.fnmatchcase(entree.name, m) for m in elaguer):
                            pile.append((os.path.join(dossier, entree.name), erel, niveau + 1,
                                         (st.st_dev, st.st_ino)))
            except OSError as e:
                if premier:                              # le dossier demandé lui-même
                    raise _refus_os(e) from None         # illisible : refus, pas une liste vide
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
            # O_NONBLOCK : une FIFO à ce nom ne bloque pas le fil (ENXIO) ;
            # sans effet sur un fichier ordinaire.
            drapeaux = os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
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
                # Au mieux, comme ``rm -rf /work/* || true`` : ce qui ne se
                # supprime pas est compté, le reste est supprimé.
                n = echecs = 0
                with os.scandir(self.racine) as it:
                    noms = [e.name for e in it]
                for nom in noms:
                    q = os.path.join(self.racine, nom)
                    if _est_dossier(q):
                        shutil.rmtree(q, ignore_errors=True)
                    else:
                        with contextlib.suppress(OSError):
                            os.unlink(q)
                    if os.path.lexists(q):
                        echecs += 1
                    else:
                        n += 1
                return {"ok": True, "removed": n, "failed": echecs}
            if op in ("rename", "copy"):
                return self._deplacer(op, normaliser(d.get("src")), normaliser(d.get("dst")),
                                      _vrai(d.get("overwrite")), _vrai(d.get("parents")),
                                      op == "copy" and _vrai(d.get("follow")))
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
        pile = [(p, (st.st_dev, st.st_ino))]
        while pile:
            if time.monotonic() > echeance:
                return {"ok": True, "bytes": total, "entries": n, "complete": False}
            dossier, attendu = pile.pop()
            try:
                with _dossier_sans_lien(dossier, attendu) as it:
                    for e in it:
                        try:
                            s = e.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        n += 1
                        if stat.S_ISDIR(s.st_mode):
                            pile.append((os.path.join(dossier, e.name), (s.st_dev, s.st_ino)))
                        else:
                            total += s.st_size
            except OSError:
                continue
        return {"ok": True, "bytes": total, "entries": n, "complete": True}

    def _deplacer(self, op: str, src: str, dst: str, ecraser: bool, parents: bool,
                  suivre: bool = False) -> Dict[str, Any]:
        """``rename`` ou ``copy``, sans suivre de lien à la destination. Un
        dossier n'est jamais remplacé, ni rien par un dossier : seul un
        fichier ou un lien est écrasé (``ecraser``), d'un coup. ``suivre``
        (copie) : une source qui est un lien est copiée depuis sa cible, sous
        la racine."""
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
                shutil.copytree(ps, tmp, symlinks=True, copy_function=_copier_entree)
            else:
                _copier_entree(ps, tmp)
                if not os.path.lexists(tmp):
                    raise Refus(409, "not_file", "un périphérique ne se copie pas")
            os.replace(tmp, pd)                          # un dossier apparu entre-temps : refus
        except BaseException:
            if os.path.lexists(tmp):
                _supprimer(tmp)
            raise
        return {"ok": True}


    # ── relevé avant / après une commande ──────────────────────────────────
    def _parcourir(self, sautes: frozenset, max_entrees: int, delai_s: float, tous: bool = False
                   ) -> Tuple[Dict[str, Cle], Dict[str, Tuple[str, str]], bool]:
        """{rel: (mtime_ns, taille, inode)} des fichiers ordinaires sous la
        racine ; avec ``tous``, {rel: (genre, texte du lien)} des liens et
        fichiers spéciaux ; bool : parcours complet. Aucun lien suivi (ni lu
        au-delà de son texte) ; dossiers nommés dans ``sautes`` et noms non
        UTF-8 ignorés ; ``max_entrees`` compte toutes les entrées."""
        vus: Dict[str, Cle] = {}
        autres: Dict[str, Tuple[str, str]] = {}
        echeance = time.monotonic() + delai_s
        n = 0
        pile: list[Tuple[str, str, Optional[Tuple[int, int]]]] = [(self.racine, "", None)]
        while pile:
            if time.monotonic() > echeance:
                return vus, autres, False
            dossier, drel, attendu = pile.pop()
            try:
                with _dossier_et_fd(dossier, attendu) as (fd, it):
                    for e in it:
                        n += 1
                        if n > max_entrees or (n & 255) == 0 and time.monotonic() > echeance:
                            return vus, autres, False
                        try:
                            e.name.encode("utf-8")
                            st = e.stat(follow_symlinks=False)
                        except (UnicodeEncodeError, OSError):
                            continue
                        rel = f"{drel}/{e.name}" if drel else e.name
                        if stat.S_ISDIR(st.st_mode):
                            if e.name not in sautes:
                                pile.append((os.path.join(dossier, e.name), rel,
                                             (st.st_dev, st.st_ino)))
                        elif stat.S_ISREG(st.st_mode):
                            vus[rel] = (st.st_mtime_ns, st.st_size, st.st_ino)
                        elif tous and stat.S_ISLNK(st.st_mode):
                            with contextlib.suppress(OSError):
                                autres[rel] = ("link", _cible_relevee(os.readlink(e.name, dir_fd=fd)))
                        elif tous:
                            autres[rel] = (_special(st.st_mode) or "other", "")
            except OSError:
                continue
        return vus, autres, True

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
                     delai_s: float, tous: bool = False) -> Dict[str, Any]:
        """Relevé AVANT une commande : clés de stat (et, avec ``tous``, liens
        et fichiers spéciaux) gardées sous un identifiant ; contenus des
        petits fichiers texte mis à jour."""
        sautes = frozenset(sautes)
        with self._verrou_releve:
            vus, autres, complet = self._parcourir(sautes, max_entrees, delai_s, tous)
            self._rafraichir(vus)
            ident = secrets.token_hex(8)
            maintenant = time.monotonic()
            for k in [k for k, v in self._releves.items() if maintenant - v[-1] > _RELEVE_DUREE_S]:
                del self._releves[k]
            self._releves[ident] = (vus, autres, complet, sautes, max_entrees, delai_s, tous, maintenant)
            while len(self._releves) > _RELEVES_OUVERTS:
                del self._releves[next(iter(self._releves))]     # le plus ancien
        return {"id": ident, "complete": complet, "files": len(vus)}

    def releve_fin(self, ident: str, max_fichiers: int, max_octets: int,
                   max_fichier: int) -> Iterator[Dict[str, Any]]:
        """Fichiers créés, modifiés ou supprimés depuis ``releve_debut`` :
        contenu d'avant (gardé, si sa clé n'a pas bougé) et d'après (relu),
        ``max_octets`` en tout ; au-delà, l'état seul. Liens et fichiers
        spéciaux (``tous``) : genre et texte du lien d'avant et d'après."""
        with self._verrou_releve:
            debut = self._releves.pop(ident, None)
            if debut is None:
                raise Refus(404, "not_found", "relevé inconnu ou expiré")
            avant, autres_avant, complet_avant, sautes, max_entrees, delai_s, tous, _t = debut
            apres, autres_apres, complet = self._parcourir(sautes, max_entrees, delai_s, tous)
            changes = []
            for vus_avant, vus_apres, autre in ((avant, apres, False), (autres_avant, autres_apres, True)):
                for rel, cle in vus_apres.items():
                    ancienne = vus_avant.get(rel)
                    if ancienne is None:
                        if complet_avant:                 # sinon : hors du premier parcours
                            changes.append((rel, "created", autre))
                    elif ancienne != cle:
                        changes.append((rel, "modified", autre))
                if complet and complet_avant:
                    changes.extend((rel, "deleted", autre) for rel in vus_avant if rel not in vus_apres)
            changes.sort(key=lambda x: (x[0], x[2]))      # même chemin : le fichier, puis le lien
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
            for rel, genre, autre in changes[:max_fichiers]:
                if autre:
                    av_, ap_ = autres_avant.get(rel), autres_apres.get(rel)
                    rendu.append({"path": rel, "change": genre, "kind": (ap_ or av_ or ("other",))[0],
                                  "before": _etat_autre(av_), "after": _etat_autre(ap_)})
                    continue
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
    # ── git ────────────────────────────────────────────────────────────────
    def git(self, d: Dict[str, Any]) -> Dict[str, Any]:
        args = d.get("args")
        if (not isinstance(args, list) or not args or len(args) > 4096
                or not all(isinstance(a, str) and "\0" not in a for a in args)):
            raise Refus(400, "bad_request", "args : liste de chaînes sans NUL")
        args = _neutraliser_diff_externe(args)
        cwd = self.reel(normaliser(d.get("cwd")))
        if not _est_dossier(cwd):
            raise Refus(404, "not_found", "dossier de travail absent")
        delai_s = max(0.1, min(float(d.get("timeout_s") or 60), _GIT_DELAI_MAX_S))
        maxi = max(1, min(int(d.get("max_out") or 1 << 20), _GIT_SORTIE_MAX))
        env = _env_git(d.get("env"), self.config_git, self.racine)
        # LFS : un objet absent du cache local n'est jamais téléchargé au
        # checkout (le filtre joindrait l'amont LFS hors du relais) ; le fichier
        # reste alors un pointeur, sans faire échouer la commande (pull du
        # même dépôt, relecture L4.4). Présent dans le cache : restitué.
        config = list(_GIT_CONFIG) + [("lfs.skipdownloaderrors", "true")]
        relais = None
        with contextlib.ExitStack() as pile:
            if d.get("relay"):
                relais = pile.enter_context(_Relais(self.relais, d["relay"]))
                config.append((f"url.{relais.prefixe}.insteadOf", relais.origine))
                env.update(GIT_ALLOW_PROTOCOL="http", GIT_LFS_SKIP_SMUDGE="1")
                # Écoute locale de l'agent : jamais par un proxy (celui d'un
                # profil réseau, ou ``http.proxy`` de /work/.gitconfig), qui
                # ne joindrait pas la boucle locale du conteneur. git passe
                # ``NO_PROXY`` à curl, proxy de config compris.
                sans = ",".join(filter(None, (env.get("NO_PROXY") or env.get("no_proxy"),
                                              "127.0.0.1")))
                env["NO_PROXY"] = env["no_proxy"] = sans
            for i, (k, v) in enumerate(config):
                env[f"GIT_CONFIG_KEY_{i}"], env[f"GIT_CONFIG_VALUE_{i}"] = k, v
            env["GIT_CONFIG_COUNT"] = str(len(config))
            res = _executer(["git", *args], cwd, env, delai_s, maxi)
        if relais is not None:
            for k in ("stdout", "stderr"):
                res[k] = res[k].replace(relais.prefixe, relais.origine)
            self._remettre_origine(cwd, env, relais)
        return res

    def _remettre_origine(self, cwd: str, env: Dict[str, str], relais: "_Relais") -> None:
        """``FETCH_HEAD`` garde l'URL de la commande : celle du relais y
        redevient celle du dépôt (messages de ``git merge FETCH_HEAD``)."""
        r = _executer(["git", "rev-parse", "--absolute-git-dir"], cwd, env, 10.0, 4096)
        if r["returncode"] != 0:
            return
        p = os.path.realpath(os.path.join(r["stdout"].strip(), "FETCH_HEAD"))
        if not p.startswith(self.racine + os.sep):
            return
        avant, apres = relais.prefixe.encode(), relais.origine.encode()
        try:
            fd = _ouvrir_fichier(p)
        except Refus:
            return
        with os.fdopen(fd, "rb") as f:
            brut = f.read(_GIT_SORTIE_MAX + 1)
        if len(brut) > _GIT_SORTIE_MAX or avant not in brut:
            return
        tmp = _nom_provisoire(os.path.dirname(p))
        try:
            with open(tmp, "xb") as f:
                f.write(brut.replace(avant, apres))
            os.replace(tmp, p)
        except OSError:
            with contextlib.suppress(OSError):
                os.unlink(tmp)


    # ── archives ───────────────────────────────────────────────────────────
    def entrees_archive(self, a: Dict[str, Any], omettre: Any
                        ) -> Iterator[Tuple[str, str, os.stat_result]]:
        """(nom dans l'archive, chemin, stat) : fichiers ordinaires — et
        dossiers si ``dirs`` — des chemins demandés, dans leur ordre, puis par
        nom ; noms relatifs à ``base``. Un chemin demandé qui est un lien sous
        la racine est suivi ; dans un dossier parcouru (``walk``), liens,
        fichiers spéciaux et noms non UTF-8 sont omis : ``omettre(nom, code)``."""
        base, vus = a["base"], set()
        for c in a["paths"]:
            rel = normaliser(c)
            if base and rel != base and not rel.startswith(base + "/"):
                raise Refus(400, "bad_path", "chemin hors de la base de l'archive")
            nom = rel[len(base):].lstrip("/") if base else rel
            if (nom, rel) in vus:
                continue
            vus.add((nom, rel))
            try:
                p = self.reel(rel)
                st = os.stat(p)
            except Refus as r:
                omettre(nom or rel, r.code)
                continue
            except OSError as e:
                omettre(nom or rel, _refus_os(e).code)
                continue
            if stat.S_ISREG(st.st_mode):
                yield nom or os.path.basename(p), p, st
            elif not stat.S_ISDIR(st.st_mode):
                omettre(nom, "special")
            elif not a["walk"]:
                omettre(nom, "is_dir")
            else:
                if nom and a["dirs"]:
                    yield nom, p, st
                yield from self._sous_arbre(p, nom, st, a["dirs"], omettre)

    def _sous_arbre(self, p: str, nom: str, st0: os.stat_result, dossiers: bool, omettre: Any
                    ) -> Iterator[Tuple[str, str, os.stat_result]]:
        pile = [(p, nom, (st0.st_dev, st0.st_ino))]
        while pile:
            dossier, dnom, attendu = pile.pop()
            # Ouvert sans suivre de lien, puis comparé à ce que le parcours a
            # vu : un dossier remplacé entre-temps par un lien (ou un parent
            # échangé) n'est pas suivi.
            try:
                fd = os.open(dossier, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            except OSError as err:
                omettre(dnom or ".", "changed" if err.errno == errno.ELOOP else _refus_os(err).code)
                continue
            enfants: list = []
            try:
                vu = os.fstat(fd)
                if (vu.st_dev, vu.st_ino) != attendu:
                    omettre(dnom or ".", "changed")
                    continue
                with os.scandir(fd) as it:
                    for e in sorted(it, key=lambda x: x.name):
                        # stat relatif au fd du dossier : tant qu'il est ouvert
                        try:
                            enfants.append((e.name, e.stat(follow_symlinks=False), None))
                        except OSError as x:
                            enfants.append((e.name, None, _refus_os(x).code))
            except OSError as err:
                omettre(dnom or ".", _refus_os(err).code)
                continue
            finally:
                os.close(fd)
            sous = []
            for nom_e, st, code in enfants:
                try:
                    nom_e.encode("utf-8")
                except UnicodeEncodeError:
                    omettre(f"{dnom}/{nom_e.encode('utf-8', 'surrogateescape').decode('utf-8', 'replace')}",
                            "undecodable")
                    continue
                enom = f"{dnom}/{nom_e}" if dnom else nom_e
                chemin = os.path.join(dossier, nom_e)
                if st is None:
                    omettre(enom, code or "io_error")
                    continue
                if stat.S_ISDIR(st.st_mode):
                    if dossiers:
                        yield enom, chemin, st
                    sous.append((chemin, enom, (st.st_dev, st.st_ino)))
                elif stat.S_ISREG(st.st_mode):
                    yield enom, chemin, st
                else:
                    omettre(enom, "link" if stat.S_ISLNK(st.st_mode) else "special")
            pile.extend(reversed(sous))

    def plan_archive(self, a: Dict[str, Any]) -> Dict[str, Any]:
        """Ce que l'archive contiendra : ``files``, ``dirs``, ``bytes`` ;
        au-delà des bornes (entrées, octets) ou du délai : refus si
        ``strict``, sinon ``truncated``."""
        fichiers = dossiers = octets = 0
        tronque = False
        echeance = time.monotonic() + a["deadline_s"]
        for _nom, p, st in self.entrees_archive(a, lambda *_: None):
            # Liste explicite de fichiers (téléchargement de plusieurs
            # fichiers) : un fichier illisible n'est pas compté, pour qu'une
            # sélection toute illisible soit refusée avant d'envoyer un zip
            # vide (relecture L4.5).
            if not a["walk"] and stat.S_ISREG(st.st_mode) and not os.access(p, os.R_OK):
                continue
            if time.monotonic() > echeance:
                if a["strict"]:
                    raise Refus(504, "timeout", "parcours de l'arborescence trop long")
                tronque = True
                break
            est_fichier = stat.S_ISREG(st.st_mode)
            if (fichiers + dossiers >= a["max_files"]
                    or est_fichier and octets + st.st_size > a["max_bytes"]):
                if a["strict"]:
                    raise Refus(413, "too_large", "archive trop volumineuse",
                                max_files=a["max_files"], max_bytes=a["max_bytes"])
                tronque = True
                break
            if est_fichier:
                fichiers, octets = fichiers + 1, octets + st.st_size
            else:
                dossiers += 1
        return {"start": True, "files": fichiers, "dirs": dossiers, "bytes": octets,
                "truncated": tronque}

    def ecrire_archive(self, sortie: _Sortie, a: Dict[str, Any], plan: Dict[str, Any]
                       ) -> Dict[str, Any]:
        """L'archive dans ``sortie`` (mêmes bornes que le plan), progression
        toutes les ``_PROGRES_S`` ; rend le bilan. Chaque fichier est lu sur
        son inode ouvert sans suivre de lien."""
        omis: list = []
        n_omis = poids_omis = 0

        def omettre(nom: str, code: str) -> None:
            # Détail borné en nombre ET en octets JSON (un nom non ASCII
            # s'échappe en 6 à 12 octets par caractère) : la trame de fin
            # doit rester sous la limite du client.
            nonlocal n_omis, poids_omis
            n_omis += 1
            entree = {"path": nom[:512], "error": code}
            poids = len(json.dumps(entree, separators=(",", ":")))
            if len(omis) < _OMIS_DETAILLES and poids_omis + poids <= _OMIS_OCTETS:
                omis.append(entree)
                poids_omis += poids
        ecrivain = _FORMATS[a["format"]](sortie, a.get("utc_offsets"))
        fichiers = dossiers = octets = 0
        tronque = bool(plan["truncated"])
        signe = time.monotonic()
        prefixe = a["prefix"]
        for nom, p, st in self.entrees_archive(a, omettre):
            if fichiers + dossiers >= a["max_files"] or tronque and fichiers + dossiers >= \
                    plan["files"] + plan["dirs"]:
                if a["strict"]:
                    raise Refus(413, "too_large", "archive trop volumineuse")
                tronque = True
                break
            if stat.S_ISDIR(st.st_mode):
                ecrivain.dossier(prefixe + nom, st)
                dossiers += 1
                continue
            try:
                fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
            except OSError as e:
                omettre(nom, "changed" if e.errno == errno.ELOOP else _refus_os(e).code)
                continue
            try:
                vu = os.fstat(fd)
                if not stat.S_ISREG(vu.st_mode):
                    omettre(nom, "special")
                    continue
                if octets + vu.st_size > a["max_bytes"]:
                    if a["strict"]:
                        raise Refus(413, "too_large", "archive trop volumineuse")
                    tronque = True
                    break
                n, erreur = ecrivain.fichier(prefixe + nom, vu, fd)
            finally:
                os.close(fd)
            if erreur:
                omettre(nom, erreur)                     # raccourci ou illisible en cours
            fichiers, octets = fichiers + 1, octets + n
            if time.monotonic() - signe >= _PROGRES_S:
                signe = time.monotonic()
                sortie.json({"progress": True, "files": fichiers, "dirs": dossiers,
                             "bytes": octets, "current": nom[:512]})
        ecrivain.fermer()
        return {"done": True, "files": fichiers, "dirs": dossiers, "bytes": octets,
                "truncated": tronque, "omitted": n_omis, "skipped": omis}

    def extraire(self, rel: str, corps: Iterable[bytes], *, garder: str, laisser: str,
                 max_octets: int, max_fichier: int, max_membres: int) -> Dict[str, Any]:
        """Remplace le contenu du dossier ``rel`` par une archive tar (gzip ou
        non) reçue en flux. Extraite d'abord dans un dossier provisoire :
        fichiers ordinaires et dossiers seulement, noms contenus, bornes
        vérifiées avant de toucher au contenu. Puis, sous verrou, l'ancien
        contenu est supprimé — ou déplacé dans ``garder`` — sauf les entrées
        dont le nom correspond au motif ``laisser``."""
        cible = self.reel(rel)
        if not _est_dossier(cible):
            raise Refus(409, "not_dir", "pas un dossier")
        _retirer_provisoires_vieux(cible)
        tmp = _nom_provisoire(cible)
        try:
            _creer_dossier(tmp, parents=False)
            bilan = self._extraire_dans(tmp, corps, max_octets, max_fichier, max_membres)
            with self._verrou:
                places = self._remplacer(cible, tmp, garder, laisser)
            bilan["conflicts"] += len(places)
            bilan["conflict_paths"] = places[:50]
        except OSError as e:
            raise _refus_os(e) from None
        finally:
            if os.path.lexists(tmp):
                shutil.rmtree(tmp, ignore_errors=True)
        return bilan

    def _extraire_dans(self, dest: str, corps: Iterable[bytes], max_octets: int,
                       max_fichier: int, max_membres: int) -> Dict[str, Any]:
        n = d = total = membres = omis = conflits = 0
        dates = []
        racine_dest = os.path.realpath(dest) + os.sep
        try:
            with tarfile.open(fileobj=_Lecteur(corps), mode="r|*", tarinfo=_InfoBornee) as tf:
                for m in tf:
                    membres += 1
                    if membres > max_membres:
                        raise Refus(413, "too_large", "trop d'entrées", limit="count",
                                    max=max_membres)
                    parties = [x for x in m.name.split("/") if x not in ("", ".")]
                    if (not parties or ".." in parties or m.name.startswith("/")
                            or "\x00" in m.name or not (m.isfile() or m.isdir())):
                        omis += 1                        # lien, fichier spécial, nom hors de dest
                        continue
                    try:
                        m.name.encode("utf-8")
                    except UnicodeEncodeError:
                        omis += 1
                        continue
                    p = os.path.join(dest, *parties)
                    if m.isdir():
                        try:
                            _creer_dossier(p)
                        except OSError:
                            conflits += 1                # un fichier porte déjà ce nom
                            continue
                        dates.append((p, m.mtime))
                        d += 1
                        continue
                    if m.size < 0:
                        raise Refus(400, "bad_archive", "taille de membre négative")
                    if m.size > max_fichier:
                        raise Refus(413, "too_large", "fichier trop volumineux", limit="member",
                                    max=max_fichier)
                    total += m.size
                    if total > max_octets:
                        raise Refus(413, "too_large", "archive trop volumineuse", limit="total",
                                    max=max_octets)
                    try:
                        _creer_dossier(os.path.dirname(p))
                        # Un dossier du provisoire remplacé par un lien depuis la
                        # sandbox ne mène pas l'écriture ailleurs.
                        if not (os.path.realpath(os.path.dirname(p)) + os.sep).startswith(racine_dest):
                            raise FileExistsError(p)
                        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
                                     | os.O_CLOEXEC, 0o600)
                    except OSError:
                        conflits += 1
                        continue
                    try:
                        src = tf.extractfile(m)
                        while src is not None:
                            b = src.read(_BLOC)
                            if not b:
                                break
                            vue = memoryview(b)
                            while vue:
                                vue = vue[os.write(fd, vue):]
                        # Quel que soit l'umask ; exécutable : tous les bits x.
                        os.fchmod(fd, _MODE_FICHIER | (0o111 if m.mode & 0o111 else 0))
                        try:
                            os.utime(fd, (m.mtime, m.mtime))
                        except (OverflowError, ValueError):
                            pass
                    finally:
                        os.close(fd)
                    n += 1
        except (tarfile.TarError, EOFError, zlib.error) as e:
            raise Refus(400, "bad_archive", f"archive illisible : {e}"[:300]) from None
        for p, t in reversed(dates):                     # dossiers après leur contenu
            try:
                os.utime(p, (t, t))
            except (OSError, OverflowError, ValueError):
                pass
        return {"files": n, "dirs": d, "bytes": total, "omitted": omis, "conflicts": conflits}

    def _remplacer(self, cible: str, tmp: str, garder: str, laisser: str) -> list:
        """Contenu de ``cible`` remplacé par celui de ``tmp``, entrée par
        entrée, sans s'arrêter en chemin : rend ce qui n'a pas pu être fait
        tel quel (« ancien → mis de côté », « nouveau → placé sous un autre
        nom », ou un nom seul si rien n'a pu être fait).

        (Relecture L4.5) Une ancienne entrée qu'on ne pouvait effacer qu'en
        partie (dossier de l'hôte, cache en lecture seule) gardait son nom :
        la nouvelle entrée repartait avec le provisoire, perdue, et la
        restauration se disait réussie. L'ancienne est désormais effacée
        après avoir rétabli ses droits, sinon mise de côté ; la nouvelle n'est
        jamais perdue."""
        nom_tmp = os.path.basename(tmp)
        anciens = [n for n in os.listdir(cible)
                   if n != nom_tmp and not (laisser and fnmatch.fnmatchcase(n, laisser))]
        if garder:
            dossier = os.path.join(cible, garder)
            _creer_dossier(dossier, parents=False)       # déjà là : refus, rien de touché
        ecarts: list = []
        for n in anciens:
            p = os.path.join(cible, n)
            try:
                if garder:
                    os.rename(p, os.path.join(dossier, n))
                else:
                    _supprimer_obstine(p)
            except FileNotFoundError:
                pass
            except OSError:
                if os.path.lexists(p):                   # le reste libère le nom
                    a_cote = _nom_libre(cible, n, "elpis-ancien")
                    try:
                        os.rename(p, a_cote)
                        ecarts.append(f"{n} → {os.path.basename(a_cote)}")
                    except OSError:
                        ecarts.append(n)
        for n in os.listdir(tmp):
            src, dst = os.path.join(tmp, n), os.path.join(cible, n)
            try:
                if os.path.lexists(dst):
                    raise FileExistsError(n)
                os.rename(src, dst)
            except OSError:
                a_cote = _nom_libre(cible, n, "elpis-restaure")
                try:
                    os.rename(src, a_cote)               # jamais perdu avec le provisoire
                    ecarts.append(f"{n} → {os.path.basename(a_cote)}")
                except OSError:
                    ecarts.append(n)
        return ecarts


# ── git ───────────────────────────────────────────────────────────────────
# Clés imposées à chaque git de l'agent (portée « command », au-dessus de la
# config du dépôt et de /work/.gitconfig) : ni hook, ni moniteur, ni
# signature, ni identifiants demandés ; ``safe.directory`` : dépôts écrits
# par l'ancien git de l'hôte (autre UID). Les réglages exécutables qu'on peut
# vider sans casser git (``core.sshCommand``, les éditeurs, ``gpg.program``)
# le sont ici : un ``.git/config`` hostile ne les lance plus.
_GIT_CONFIG = (("core.hooksPath", "/dev/null"), ("core.fsmonitor", "false"),
               ("credential.helper", ""), ("core.askPass", ""), ("core.pager", "cat"),
               ("commit.gpgsign", "false"), ("tag.gpgsign", "false"),
               ("core.sshCommand", ""), ("core.editor", ""), ("sequence.editor", ""),
               ("gpg.program", ""), ("gpg.ssh.program", ""),
               ("safe.directory", "*"),
               # Dépôts créés par l'ancien git de l'hôte : ``core.sharedRepository
               # = 0666`` gravé dans leur config rouvrait .git à tous (relecture).
               ("core.sharedRepository", "false"))
# ``diff.external`` et ``diff.<pilote>.textconv`` lancent un programme au diff,
# mais un ``diff.external`` VIDE en config casse TOUT diff (git tente une
# commande vide) : git n'offre aucune valeur « désactivé », seule l'option
# ``--no-ext-diff`` / ``--no-textconv`` le fait. L'agent les injecte donc après
# la sous-commande qui rend un diff. LIMITE : les pilotes NOMMÉS de filtre
# (``filter.<n>.clean/smudge/process``) n'ont pas de joker ; ils exigent que
# l'agent écrive lui-même ``.gitattributes`` ET ``.git/config``, or clone
# n'importe pas la config du distant et ``git_write`` refuse d'écrire dans
# ``.git``.
_GIT_SOUS_CMD_DIFF = frozenset({"diff", "log", "show", "whatchanged", "format-patch",
                                "range-diff", "diff-tree", "diff-index", "diff-files"})
_GIT_GLOBALES_VALEUR = frozenset({"-c", "-C", "--git-dir", "--work-tree", "--namespace",
                                  "--exec-path", "--config-env"})


def _neutraliser_diff_externe(args: list) -> list:
    """``--no-ext-diff --no-textconv`` après la sous-commande qui rend un diff
    (``diff.external`` n'a pas de désactivation en config)."""
    i = 0
    while i < len(args):
        a = args[i]
        if a in _GIT_GLOBALES_VALEUR:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        if a in _GIT_SOUS_CMD_DIFF:
            return [*args[: i + 1], "--no-ext-diff", "--no-textconv", *args[i + 1:]]
        return args
    return args
# Portée « system » (la plus basse) : identité par défaut des commits, puis
# la config de l'image.
_GIT_SYSTEME = "[user]\n\tname = Elpis\n\temail = elpis@localhost\n[include]\n\tpath = /etc/gitconfig\n"
_GIT_ENV_PERMIS = frozenset({"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
                             "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE"})
_GIT_SORTIE_MAX = 16 << 20                # sortie gardée, par flux
_GIT_DELAI_MAX_S = 590.0                  # sous le délai total du client (600 s)
RELAIS_DOSSIER = "/run/elpis-relay"       # sockets du relais Git de l'hôte (lecture seule)
_RELAIS_CONNEXIONS = 8                    # connexions relayées en même temps, par commande
_NOM_SOCKET_RELAIS = re.compile(r"[0-9]{1,10}\.sock")
_TICKET = re.compile(r"[A-Za-z0-9_-]{20,128}")
_ORIGINE = re.compile(r"https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?/")


def _env_git(extra: Any, config_systeme: str, racine: str) -> Dict[str, str]:
    # HOME : la racine, comme dans le conteneur (config globale /work/.gitconfig).
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("GIT_") and k != "XDG_CONFIG_HOME"}
    env["HOME"] = racine
    if extra:
        if not isinstance(extra, dict):
            raise Refus(400, "bad_request", "env : objet attendu")
        for k, v in extra.items():
            if k not in _GIT_ENV_PERMIS or not isinstance(v, str) or "\0" in v:
                raise Refus(400, "bad_request", f"env : {k} refusée")
            env[k] = v
    env.update(GIT_TERMINAL_PROMPT="0", GIT_EDITOR="true", GIT_PAGER="cat")
    if config_systeme:
        env["GIT_CONFIG_SYSTEM"] = config_systeme
    return env


def _executer(argv: list, cwd: str, env: Dict[str, str], delai_s: float,
              maxi: int) -> Dict[str, Any]:
    """``argv`` sans shell ; ``maxi`` octets gardés par flux (le reste est lu
    et jeté) ; à la fin, ce qui reste du groupe de processus est tué."""
    debut = time.monotonic()
    try:
        p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True, umask=0o022)
    except OSError as e:
        raise Refus(500, "exec_failed", f"{argv[0]} : {e.strerror or e}") from None
    gardes: Dict[str, Tuple[bytes, bool]] = {}

    def lire(nom: str, f: Any) -> None:
        garde, total = bytearray(), 0
        with f:
            for b in iter(lambda: f.read1(1 << 16), b""):
                total += len(b)
                if len(garde) < maxi:
                    garde += b[:maxi - len(garde)]
        gardes[nom] = (bytes(garde), total > maxi)

    fils = [threading.Thread(target=lire, args=(n, f), daemon=True)
            for n, f in (("stdout", p.stdout), ("stderr", p.stderr))]
    for t in fils:
        t.start()
    try:
        rc, expire = p.wait(timeout=delai_s), False
    except subprocess.TimeoutExpired:
        rc, expire = 124, True
    with contextlib.suppress(OSError):
        os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    for t in fils:
        t.join(5)
    out, t1 = gardes.get("stdout", (b"", False))
    err, t2 = gardes.get("stderr", (b"", False))
    return {"returncode": rc, "timed_out": expire, "truncated": t1 or t2,
            "stdout": out.decode("utf-8", "replace"), "stderr": err.decode("utf-8", "replace"),
            "duration_ms": int((time.monotonic() - debut) * 1000)}


class _Relais:
    """Réseau d'UNE commande git : ``127.0.0.1:<port éphémère>`` du conteneur
    vers le socket du relais de l'hôte, chaque connexion précédée d'une ligne
    qui porte le ticket de l'opération (ni argv, ni environnement, ni URL).
    L'hôte n'accepte que le trafic Git que ce ticket permet, vers son amont."""

    def __init__(self, dossier: str, spec: Any) -> None:
        if not isinstance(spec, dict):
            raise Refus(400, "bad_request", "relay : objet attendu")
        nom, ticket, origine = (str(spec.get(k) or "") for k in ("socket", "ticket", "origin"))
        if (not _NOM_SOCKET_RELAIS.fullmatch(nom) or not _TICKET.fullmatch(ticket)
                or not _ORIGINE.fullmatch(origine)):
            raise Refus(400, "bad_request", "relay : socket, ticket ou origin invalide")
        self._dossier, self._nom, self.origine = dossier, nom, origine
        self._entete = f"ELPIS-RELAY/1 {ticket}\r\n".encode()
        self._ouvertes: set = set()
        self._actives = 0
        self._verrou = threading.Lock()
        self._ecoute = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._ecoute.bind(("127.0.0.1", 0))
        self._ecoute.listen(16)
        self.prefixe = "http://127.0.0.1:%d/" % self._ecoute.getsockname()[1]
        threading.Thread(target=self._accepter, daemon=True).start()

    def __enter__(self) -> "_Relais":
        return self

    def __exit__(self, *exc: Any) -> None:
        with self._verrou:
            for s in (self._ecoute, *self._ouvertes):
                with contextlib.suppress(OSError):
                    s.shutdown(socket.SHUT_RDWR)          # réveille accept et recv
        self._ecoute.close()

    def _accepter(self) -> None:
        while True:
            try:
                c, _ = self._ecoute.accept()
            except OSError:
                return
            with self._verrou:
                libre = self._actives < _RELAIS_CONNEXIONS
                self._actives += libre
            if not libre:
                c.close()
                continue
            try:
                threading.Thread(target=self._relayer, args=(c,), daemon=True).start()
            except RuntimeError:                         # plus de fil : place rendue
                self._liberer()
                c.close()

    def _liberer(self) -> None:
        with self._verrou:
            self._actives -= 1

    def _relayer(self, c: socket.socket) -> None:
        try:
            h = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        except OSError:                                  # plus de descripteur
            self._liberer()
            c.close()
            return
        with c, h:
            with self._verrou:
                self._ouvertes.update((c, h))
            try:
                # Chemin court quelle que soit la longueur du dossier.
                fd = os.open(self._dossier, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
                try:
                    h.connect(f"/proc/self/fd/{fd}/{self._nom}")
                finally:
                    os.close(fd)
                h.sendall(self._entete)
                t = threading.Thread(target=_pomper, args=(c, h), daemon=True)
                t.start()
                _pomper(h, c)
                t.join()
            except OSError:
                pass
            finally:
                with self._verrou:
                    self._ouvertes.difference_update((c, h))
                    self._actives -= 1


def _pomper(de: socket.socket, vers: socket.socket) -> None:
    with contextlib.suppress(OSError):
        for b in iter(lambda: de.recv(1 << 16), b""):
            vers.sendall(b)
    with contextlib.suppress(OSError):
        vers.shutdown(socket.SHUT_WR)


def _ecrire_config_git(dossier: str) -> str:
    """Config « system » des git de l'agent, dans le dossier de son socket."""
    chemin = os.path.join(dossier, "gitconfig")
    tmp = _nom_provisoire(dossier)
    try:
        with open(tmp, "x", encoding="utf-8") as f:
            f.write(_GIT_SYSTEME)
        os.replace(tmp, chemin)
        return chemin
    except OSError:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        return ""


# ── jobs de fond (shell_job) ───────────────────────────────────────────────
_JOB_ID = re.compile(r"j-[0-9a-f]{8}")
_JOB_FICHE = re.compile(r"job-(j-[0-9a-f]{8})\.json")
_JOBS_BG = ".bg"                          # fichiers des jobs, à plat
_JOBS_EVENEMENTS = "jobs-events.ndjson"
_JOBS_VIVANTS_MAX = 16                    # jobs vivants par conteneur
_JOBS_PROFONDEUR_MAX = 1000               # chain_depth reçu de l'hôte, au plus
_JOBS_TOUR_S = 0.5                        # superviseur : un tour toutes les 0,5 s
_JOBS_BATTEMENT_S = 600.0                 # fiche touchée tant que le job tourne (GC d'inactivité)
_JOBS_JOURNAL_MAX = 512 << 20             # au-delà : journal ramené à sa tête
_JOBS_JOURNAL_TETE = 1 << 20
_JOBS_BUDGET_S = 0.05                     # lecture du journal : temps par job et par tour
_JOBS_MORCEAU = 1 << 20                   # morceau lu quand les lignes sont seulement comptées
_JOBS_MORCEAU_LENT = 64 << 10             # morceau lu quand chaque ligne passe par Python
_JOBS_LOT_REGEX = 40 << 10                # lot du trieur : sa requête tient dans un tube vide
_JOBS_REGEX_VUE = 1024                    # caractères d'une ligne testés par une regex
_JOBS_REGEX_LIBRES = 2                    # quantificateurs non bornés par regex
_JOBS_REGEX_MAX_S = 2.0                   # lot sans réponse : trieur tué, regex désarmées
_JOBS_TRIEURS_MAX = 16                    # processus de regex vivants
_JOBS_REPRISE_TEST = 16 << 20             # reprise : fin du journal retestée (match, regex)
_JOBS_LIGNE_TEST = 4096                   # ligne coupée avant match / regex
_JOBS_LIGNE_VUE = 200                     # ligne coupée pour l'affichage
_JOBS_QUEUE = 20                          # lignes de fin dans un événement
_JOBS_CONTEXTE = 5                        # match / regex : lignes avant et après
_JOBS_APRES_S = 1.0                       # attente des lignes d'après
_JOBS_EVENEMENT_MAX = 4096                # événement sérialisé, en octets
_JOBS_GARDES = 1000                       # événements gardés (mémoire et fichier)
_JOBS_VEILLE_LOT = 256                    # événements par réponse de watch
_JOBS_VEILLE_MAX_S = 25.0
_JOBS_GROUPE_S = 0.2                      # watch : fenêtre de regroupement
_JOBS_GRACE_MAX_S = 30.0
_JOBS_COMMANDE_MAX = 100_000
_JOBS_DECLENCHEURS_MAX = 6
_JOBS_MOTIF_MAX = 2000
_JOBS_ENV_MAX = 128
_JOBS_BORNES = {"port": (1, 65535), "idle": (10, 3600), "timeout": (1, 86400)}
_CLE_ENV = re.compile(r"[A-Z_][A-Z0-9_]*")
_REDOS = re.compile(r"\([^()]*[+*][^()]*\)[+*]")   # verifierRegexSure de l'hôte d'outils
_TERMINAUX = frozenset({"exited", "killed", "lost", "failed"})
_SIGNAUX = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL, "INT": signal.SIGINT}
_PROC = "/proc"
_BASH = shutil.which("bash") or "/bin/bash"
# La commande arrive en $0 et le fichier .exit en $1 : ni l'une ni l'autre n'est interpolée.
_ENVELOPPE = ('"$BASH" -c -- "$0"; rc=$?; printf \'%s\\n\' "$rc" > "$1.tmp" '
              '&& PATH=/usr/local/bin:/usr/bin:/bin mv -f -- "$1.tmp" "$1"; exit "$rc"')
# Trieur : par requête, l'indice de la première ligne trouvée par chaque motif (-1 : aucune).
_TRIEUR = """
import base64, json, re, sys
for requete in iter(sys.stdin.buffer.readline, b""):
    d = json.loads(requete)
    lignes = [x[:d["t"]].rstrip(b"\\r").decode("utf-8", "replace")[:d["v"]]
              for x in base64.b64decode(d["l"]).split(b"\\n")]
    rendu = []
    for motif in d["p"]:
        r = re.compile(motif)
        rendu.append(next((i for i, t in enumerate(lignes) if r.search(t)), -1))
    sys.stdout.buffer.write(json.dumps(rendu).encode() + b"\\n")
    sys.stdout.buffer.flush()
"""


def _lire_petit(p: str, maxi: int, fin: bool = False) -> Optional[bytes]:
    """Début (ou fin, lignes entières) d'un fichier ordinaire, lien non suivi ; ``None`` sinon."""
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return None
        debut = max(0, st.st_size - maxi) if fin else 0
        morceaux, pos = [], debut
        while pos - debut < maxi:
            b = os.pread(fd, min(maxi - (pos - debut), _BLOC), pos)
            if not b:
                break
            morceaux.append(b)
            pos += len(b)
        brut = b"".join(morceaux)
        return brut[brut.find(b"\n") + 1:] if debut else brut
    except OSError:
        return None
    finally:
        os.close(fd)


def _stat_processus(pid: int) -> Optional[Tuple[str, int, int]]:
    """(état, groupe, starttime) d'après /proc/<pid>/stat ; ``None`` si le processus n'existe pas."""
    try:
        with open(f"{_PROC}/{pid}/stat", "rb") as f:
            b = f.read()
        champs = b[b.rindex(b")") + 2:].split()
        return champs[0].decode("ascii", "replace"), int(champs[2]), int(champs[19])
    except (OSError, ValueError, IndexError):
        return None


def _processus() -> Iterator[Tuple[int, int]]:
    """(pid, groupe) des processus vivants, zombies exclus."""
    try:
        noms = os.listdir(_PROC)
    except OSError:
        return
    for nom in noms:
        if nom.isdigit():
            s = _stat_processus(int(nom))
            if s is not None and s[0] not in ("Z", "X", "x"):
                yield int(nom), s[1]


def _porte_marqueur(pid: int, marqueur: bytes) -> bool:
    try:
        with open(f"{_PROC}/{pid}/environ", "rb") as f:
            return marqueur in b"\0" + f.read(1 << 20)
    except OSError:
        return False


def _ports_en_ecoute() -> frozenset:
    """Ports TCP en écoute (état 0A) d'après /proc/net/tcp et tcp6."""
    ports = set()
    for nom in ("tcp", "tcp6"):
        try:
            with open(f"{_PROC}/net/{nom}", "rb") as f:
                lignes = f.read(16 << 20).splitlines()[1:]
        except OSError:
            continue
        for ligne in lignes:
            c = ligne.split()
            if len(c) > 3 and c[3] == b"0A":
                with contextlib.suppress(ValueError, IndexError):
                    ports.add(int(c[1].rsplit(b":", 1)[1], 16))
    return frozenset(ports)


def _vue(brut: bytes) -> str:
    """Ligne pour l'affichage : ce qui suit le dernier retour chariot, 200 caractères au plus."""
    brut = brut.rstrip(b"\r")
    s = brut[brut.rfind(b"\r") + 1:][:_JOBS_LIGNE_VUE * 4].decode("utf-8", "replace")
    return s if len(s) <= _JOBS_LIGNE_VUE else s[:_JOBS_LIGNE_VUE - 1] + "…"


def _nom_signal(code: Optional[int]) -> Optional[str]:
    try:
        return signal.Signals(code - 128).name if code is not None and code > 128 else None
    except ValueError:
        return None


def _entier_sur(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _reel_sur(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _env_job(extra: Any, racine: str, ident: str) -> Dict[str, str]:
    """Environnement de l'agent, HOME, ``env`` vérifié (règles d'execute_shell), marqueur ELPIS_JOB_ID."""
    env = dict(os.environ)
    env["HOME"] = racine
    if extra is not None:
        if not isinstance(extra, dict) or len(extra) > _JOBS_ENV_MAX:
            raise Refus(400, "bad_request", f"env : objet de {_JOBS_ENV_MAX} variables au plus")
        for k, v in extra.items():
            if (not _CLE_ENV.fullmatch(k) or len(k) > 64 or not isinstance(v, str)
                    or len(v) > 4000 or "\0" in v):
                raise Refus(400, "bad_request", f"env : {k[:64]} refusée")
            env[k] = v
    env["ELPIS_JOB_ID"] = ident
    return env


def _borner_evenement(e: Dict[str, Any]) -> None:
    """Événement sérialisé sous ``_JOBS_EVENEMENT_MAX`` : fin du journal, puis contexte, raccourcis."""
    def taille() -> int:
        return len(json.dumps(e, separators=(",", ":"))) + 16      # seq à venir
    while taille() > _JOBS_EVENEMENT_MAX and e["tail"]:
        e["tail"].pop(0)
    while taille() > _JOBS_EVENEMENT_MAX and e["context"]:
        e["context"].pop(0 if len(e["context"]) % 2 else -1)
    if taille() > _JOBS_EVENEMENT_MAX and e["line"]:
        e["line"] = e["line"][:_JOBS_LIGNE_VUE // 4]


def _quantificateurs_libres(motif: str) -> int:
    """Quantificateurs non bornés (*, +, {n,}) d'une regex, hors classes et échappements ; *? ou *+ en est un seul."""
    n = i = 0
    while i < len(motif):
        c = motif[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            i += 2 if motif[i + 1:i + 2] == "^" else 1
            i += 1 if motif[i:i + 1] == "]" else 0      # « ] » en tête de classe : littéral
            while i < len(motif) and motif[i] != "]":
                i += 2 if motif[i] == "\\" else 1
            i += 1
            continue
        m = re.match(r"\{[0-9]*,\}", motif[i:]) if c == "{" else None
        if c in "*+" or m:
            n += 1
            i += m.end() if m else 1
            i += 1 if motif[i:i + 1] in ("?", "+") else 0
            continue
        i += 1
    return n


class _Trieur:
    """Processus à part (``python3 -I -S``) où sont évaluées les regex d'un job : une regex lente n'y fige que lui."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen([sys.executable or "python3", "-I", "-S", "-c", _TRIEUR],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        self._tampon = b""
        for f in (self.proc.stdin, self.proc.stdout):
            if f is not None:
                os.set_blocking(f.fileno(), False)

    def demander(self, motifs: list, octets: bytes) -> None:
        """Une requête, écrite d'un coup dans le tube vide (jamais d'attente) ; sinon OSError."""
        requete = json.dumps({"p": motifs, "t": _JOBS_LIGNE_TEST, "v": _JOBS_REGEX_VUE,
                              "l": base64.b64encode(octets).decode("ascii")}).encode() + b"\n"
        if self.proc.stdin is None or os.write(self.proc.stdin.fileno(), requete) != len(requete):
            raise OSError(errno.EAGAIN, "requête du trieur tronquée")

    def reponse(self, attente: float) -> Optional[list]:
        """Réponse à la requête en cours, ou ``None`` si elle n'est pas là au bout d'``attente`` secondes."""
        if self.proc.stdout is None:
            raise OSError(errno.EPIPE, "trieur sans sortie")
        fd = self.proc.stdout.fileno()
        fin = time.monotonic() + attente
        veille = select.poll()                           # poll : aucune borne sur le numéro du descripteur
        veille.register(fd, select.POLLIN)
        while b"\n" not in self._tampon:
            if not veille.poll(max(0, int((fin - time.monotonic()) * 1000))):
                return None
            b = os.read(fd, 1 << 16)
            if not b:
                raise OSError(errno.EPIPE, "trieur arrêté")
            self._tampon += b
        ligne, _, self._tampon = self._tampon.partition(b"\n")
        rendu = json.loads(ligne)
        if not isinstance(rendu, list):
            raise ValueError("réponse du trieur invalide")
        return rendu

    def fermer(self) -> None:
        with contextlib.suppress(OSError):
            self.proc.kill()
        with contextlib.suppress(OSError, subprocess.TimeoutExpired):
            self.proc.wait(2)
        for f in (self.proc.stdin, self.proc.stdout):
            if f is not None:
                with contextlib.suppress(OSError):
                    f.close()


class _Job:
    """Un job de fond : sa fiche (``job-<id>.json``) et l'état de sa surveillance."""

    CHAMPS = ("id", "pid", "starttime", "command", "cwd", "label", "wake_on", "created_at",
              "started_at", "state", "ended_at", "exit_code", "signal", "fired", "chain_depth")

    def __init__(self, ident: str) -> None:
        self.id = ident
        self.pid = self.starttime = 0
        self.command = self.cwd = self.label = ""
        self.wake_on: list = []
        self.created_at = self.started_at = 0.0
        self.ended_at: Optional[float] = None
        self.state = "running"
        self.exit_code: Optional[int] = None
        self.signal: Optional[str] = None
        self.fired: list = []
        self.chain_depth: Optional[int] = None           # profondeur du tour qui l'a lancé (hôte)
        self.declencheurs: list = []                     # (entrée, genre, valeur)
        self.proc: Optional[subprocess.Popen] = None     # lancé par CET agent
        self.fd: Optional[int] = None                    # journal, en lecture
        self.pos = self.taille = self.lignes = self.test_depuis = 0
        self.partiel = self.partiel_fin = b""            # ligne en cours : tête (tests), fin (affichage)
        self.derniers: deque = deque(maxlen=_JOBS_QUEUE)
        self.attentes: list = []                         # match / regex qui attendent leurs lignes d'après
        self.desarmes: list = []                         # regex retirées : {"spec", "reason"}
        self.trieur: Optional[_Trieur] = None            # processus de ses regex
        self.lot: Optional[tuple] = None                 # (octets, envoi, entrées) en attente du trieur
        self.fin: Optional[tuple] = None                 # fin constatée, journal pas encore rattrapé
        self.fin_pos = 0
        self.t0 = self.sortie = self.battement = time.monotonic()
        self.arret = False

    @classmethod
    def depuis(cls, d: Dict[str, Any]) -> "_Job":
        """Fiche relue, types vérifiés : le code de /work peut l'avoir réécrite."""
        j = cls(d["id"])
        j.pid, j.starttime = _entier_sur(d.get("pid")) or 0, _entier_sur(d.get("starttime")) or 0
        j.command, j.cwd, j.label = (str(d.get(k) or "")[:_JOBS_COMMANDE_MAX]
                                     for k in ("command", "cwd", "label"))
        for k in ("wake_on", "fired"):
            v = d.get(k)
            setattr(j, k, [s for s in v if isinstance(s, str)][:16] if isinstance(v, list) else [])
        j.created_at = _reel_sur(d.get("created_at")) or 0.0
        j.started_at = _reel_sur(d.get("started_at")) or j.created_at
        j.ended_at = _reel_sur(d.get("ended_at"))
        j.state = d["state"] if isinstance(d.get("state"), str) and d["state"] in _TERMINAUX else "running"
        j.exit_code = _entier_sur(d.get("exit_code"))
        j.signal = d["signal"] if isinstance(d.get("signal"), str) else None
        p = _entier_sur(d.get("chain_depth"))
        j.chain_depth = p if p is not None and 0 <= p <= _JOBS_PROFONDEUR_MAX else None
        j.lignes, j.taille = _entier_sur(d.get("log_lines")) or 0, _entier_sur(d.get("log_bytes")) or 0
        v = d.get("disarmed")
        j.desarmes = [{"spec": x["spec"], "reason": str(x.get("reason") or "")[:80]} for x in v
                      if isinstance(x, dict) and isinstance(x.get("spec"), str)][:16] if isinstance(v, list) else []
        j.t0 = time.monotonic() - max(0.0, time.time() - j.started_at)
        return j

    def fiche(self) -> Dict[str, Any]:
        return {**{k: getattr(self, k) for k in self.CHAMPS},
                "log_lines": self.nb_lignes(), "log_bytes": self.taille, "disarmed": self.desarmes}

    def duree(self) -> float:
        if self.ended_at is not None:
            return max(0.0, self.ended_at - self.started_at)
        return max(0.0, time.monotonic() - self.t0)

    def nb_lignes(self) -> int:
        return self.lignes + (1 if self.partiel else 0)

    def queue(self) -> list:
        """Fin du journal (ligne en cours comprise), 20 lignes au plus."""
        q = list(self.derniers)
        if self.partiel:
            q.append(_vue(self.partiel_fin))
        return q[-_JOBS_QUEUE:]


class _Jobs:
    """Jobs de fond du conteneur (shell_job) : lancement, superviseur, événements, arrêt, reprise."""

    def __init__(self, agent: Agent) -> None:
        self.agent = agent
        self._jv = threading.RLock()                     # les jobs et leur état
        self._ev = threading.Condition()                 # les événements ; réveille les watch
        self._jobs: Dict[str, _Job] = {}
        self._evenements: deque = deque(maxlen=_JOBS_GARDES)
        self._seq = self._lignes_fichier = 0
        self._fil: Optional[threading.Thread] = None
        self._arret = threading.Event()

    # ── chemins et entrées ─────────────────────────────────────────────────
    def _bg(self, creer: bool = False) -> str:
        """Le dossier .bg, vrai dossier sous la racine, créé au besoin."""
        p = os.path.join(self.agent.racine, _JOBS_BG)
        if creer:
            try:
                os.mkdir(p, _MODE_DOSSIER)
            except FileExistsError:
                pass
            except OSError as e:
                raise _refus_os(e) from None
        if not _est_dossier(p):
            raise Refus(409, "not_dir", ".bg absent, ou qui n'est pas un dossier")
        return p

    def _fichier(self, ident: str, ext: str) -> str:
        return os.path.join(self.agent.racine, _JOBS_BG, f"job-{ident}.{ext}")

    def _ident(self, v: Any) -> str:
        if not isinstance(v, str) or not _JOB_ID.fullmatch(v):
            raise Refus(400, "bad_request", "id : « j- » suivi de 8 chiffres hexadécimaux")
        return v

    def _rel_confine(self, v: Any) -> str:
        """Chemin relatif à la racine ; « .. », absolu hors /work ou lien qui sort : outside_root."""
        if isinstance(v, str) and (".." in v.split("/") or (
                v.startswith("/") and v != "/work" and not v.startswith("/work/"))):
            raise Refus(403, "outside_root", "chemin hors de /work")
        rel = normaliser(v)
        self.agent.reel(rel)
        return rel

    def _declencheur(self, s: str) -> Tuple[str, str, Any]:
        """(entrée, genre, valeur) d'une entrée de wake_on vérifiée (grammaire de la SPEC §1)."""
        if s == "exit":
            return s, s, None
        genre, _, val = s.partition(":")
        if genre == "match" and val and len(val) <= _JOBS_MOTIF_MAX:
            return s, genre, val
        if genre == "regex" and val:
            if len(val) > _JOBS_MOTIF_MAX or _REDOS.search(val):
                raise Refus(400, "bad_request", "regex: too long, or nested quantifier (catastrophic backtracking)")
            if _quantificateurs_libres(val) > _JOBS_REGEX_LIBRES:
                raise Refus(400, "bad_request",
                            f"regex: at most {_JOBS_REGEX_LIBRES} unbounded quantifiers (*, +, {{n,}})")
            try:
                return s, genre, re.compile(val)
            except (re.error, RecursionError, OverflowError) as e:
                raise Refus(400, "bad_request", f"invalid regex: {str(e)[:200]}") from None
        if genre in _JOBS_BORNES and re.fullmatch(r"[0-9]{1,6}", val):
            mini, maxi = _JOBS_BORNES[genre]
            if mini <= int(val) <= maxi:
                return s, genre, int(val)
        if genre == "file" and val:
            rel = self._rel_confine(val)
            if rel:
                return s, genre, rel
        raise Refus(400, "bad_request", f"wake_on: invalid entry '{s[:80]}'")

    def _declencheurs(self, v: Any) -> list:
        """wake_on vérifié, sans doublon, « exit » toujours armé et en tête."""
        if v is None:
            v = []
        if not isinstance(v, list) or not all(isinstance(s, str) and "\0" not in s for s in v):
            raise Refus(400, "bad_request", "wake_on: list of strings expected")
        entrees = list(dict.fromkeys(["exit", *v]))
        if len(entrees) > _JOBS_DECLENCHEURS_MAX + 1:
            raise Refus(400, "bad_request", f"wake_on: at most {_JOBS_DECLENCHEURS_MAX} entries")
        return [self._declencheur(s) for s in entrees]

    def _existe(self, rel: str) -> bool:
        try:
            return os.path.exists(self.agent.reel(rel))
        except Refus:
            return False

    # ── fiches et journaux ─────────────────────────────────────────────────
    def _ecrire_fiche(self, job: _Job) -> None:
        """``job-<id>.json`` écrit de façon atomique ; une panne est ignorée (la mémoire fait foi)."""
        try:
            bg = self._bg(creer=True)
        except Refus:
            return
        tmp = _nom_provisoire(bg)
        try:
            with open(tmp, "x", encoding="ascii") as f:
                json.dump(job.fiche(), f, separators=(",", ":"))
            os.replace(tmp, os.path.join(bg, f"job-{job.id}.json"))
            job.battement = time.monotonic()
        except (OSError, ValueError):
            with contextlib.suppress(OSError):
                os.unlink(tmp)

    def _toucher(self, job: _Job) -> None:
        """Battement : la fiche d'un job qui tourne reste récente pour le GC d'inactivité."""
        job.battement = time.monotonic()
        with contextlib.suppress(OSError, Refus):
            self._bg()
            os.utime(self._fichier(job.id, "json"), follow_symlinks=False)

    def _job_du_disque(self, ident: str) -> Optional[_Job]:
        """Fiche relue et vérifiée ; ``None`` si elle manque ou ne tient pas."""
        b = _lire_petit(self._fichier(ident, "json"), 1 << 20)
        try:
            d = json.loads(b) if b else None
        except (ValueError, RecursionError):
            return None
        if not isinstance(d, dict) or d.get("id") != ident:
            return None
        job = _Job.depuis(d)
        for s in job.wake_on:
            with contextlib.suppress(Refus):
                job.declencheurs.append(self._declencheur(s))
        return job

    def _ouvrir_journal(self, job: _Job) -> None:
        try:
            fd = os.open(self._fichier(job.id, "log"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        except OSError:
            return
        if stat.S_ISREG(os.fstat(fd).st_mode):
            job.fd = fd
        else:
            os.close(fd)

    def _fermer_journal(self, job: _Job) -> None:
        if job.fd is not None:
            with contextlib.suppress(OSError):
                os.close(job.fd)
            job.fd = None

    def _queue_disque(self, job: _Job) -> None:
        """Job fini relu : taille et dernières lignes du journal (le compte de lignes vient de la fiche)."""
        with contextlib.suppress(OSError):
            job.taille = os.stat(self._fichier(job.id, "log"), follow_symlinks=False).st_size
        b = _lire_petit(self._fichier(job.id, "log"), 16 << 10, fin=True) or b""
        for brut in b.rstrip(b"\n").split(b"\n")[-_JOBS_QUEUE:] if b else []:
            job.derniers.append(_vue(brut))

    def _lire_journal(self, job: _Job, budget_s: Optional[float], tester: bool = True) -> None:
        """Journal lu dans le budget du tour (``None`` : jusqu'au bout) ; les regex vont au trieur du job."""
        if job.fd is None:
            return
        if budget_s is None:
            with contextlib.suppress(OSError):
                job.taille = os.fstat(job.fd).st_size
        if job.taille < job.pos:                         # tronqué par le code de /work
            self._fermer_trieur(job)
            job.pos, job.partiel, job.partiel_fin = job.taille, b"", b""
        if not tester:
            self._fermer_trieur(job)                     # arrêt : le lot en cours est relu sans regex
        echeance = None if budget_s is None else time.monotonic() + budget_s
        limite = min(job.taille, job.fin_pos) if job.fin is not None else job.taille
        while echeance is None or time.monotonic() < echeance:
            if job.lot is not None and not self._recevoir(job, echeance):
                return
            if job.pos >= limite:
                return
            armes = self._armes(job) if tester else []
            regex = [x for x in armes if x[1] == "regex"]
            morceau = (_JOBS_LOT_REGEX if regex else
                       _JOBS_MORCEAU_LENT if armes or self._attend_apres(job) else _JOBS_MORCEAU)
            try:
                b = os.pread(job.fd, min(limite - job.pos, morceau), job.pos)
            except OSError:
                return
            if not b:
                return
            dernier = b.rfind(b"\n")
            if regex and dernier >= 0 and job.pos + len(b) > job.test_depuis:
                if not self._envoyer(job, regex, b, dernier):
                    return                               # aucun trieur libre : le morceau attend
                continue
            job.pos += len(b)
            self._ajouter(job, b, {}, tester)

    def _armes(self, job: _Job) -> list:
        """match / regex encore armés : ni déclenchés ni désarmés."""
        hors = set(job.fired) | {d["spec"] for d in job.desarmes}
        return [(s, g, v) for s, g, v in job.declencheurs if g in ("match", "regex") and s not in hors]

    def _attend_apres(self, job: _Job) -> bool:
        return any(len(a["apres"]) < _JOBS_CONTEXTE for a in job.attentes)

    def _envoyer(self, job: _Job, regex: list, b: bytes, dernier: int) -> bool:
        """Lignes complètes du morceau envoyées au trieur du job ; ``False`` si aucun trieur n'est libre."""
        specs = [x[0] for x in regex]
        try:
            if job.trieur is None:
                if sum(j.trieur is not None for j in self._jobs.values()) >= _JOBS_TRIEURS_MAX:
                    return False
                job.trieur = _Trieur()
            job.trieur.demander([x[2].pattern for x in regex], job.partiel + b[:dernier])
        except (OSError, ValueError, subprocess.SubprocessError):
            self._desarmer(job, specs, "regex disarmed: evaluator failed")
            return True                                  # le morceau est relu sans ces regex
        job.lot = (b, time.monotonic(), specs)
        return True

    def _recevoir(self, job: _Job, echeance: Optional[float]) -> bool:
        """Réponse du trieur au lot en cours, lignes traitées ; ``False`` tant qu'elle n'est pas là."""
        assert job.lot is not None
        b, envoi, specs = job.lot
        panne = None
        try:
            attente = 0.0 if echeance is None else max(0.0, echeance - time.monotonic())
            rendu = job.trieur.reponse(attente) if job.trieur is not None else None
        except (OSError, ValueError):
            rendu, panne = None, "regex disarmed: evaluator failed"
        if rendu is None:
            if panne is None and time.monotonic() - envoi < _JOBS_REGEX_MAX_S:
                return False
            self._desarmer(job, specs, panne or "regex disarmed: too slow")
            return True                                  # le lot est relu sans ces regex : aucune ligne perdue
        job.lot = None
        touches = {s: k for s, k in zip(specs, rendu) if _entier_sur(k) is not None and k >= 0}
        job.pos += len(b)
        self._ajouter(job, b, touches, True)
        if not any(g == "regex" for _, g, _ in self._armes(job)):
            self._fermer_trieur(job)
        return True

    def _desarmer(self, job: _Job, specs: list, raison: str) -> None:
        """Regex retirées du job (trieur trop lent ou en panne), raison gardée dans la fiche et l'état."""
        for spec in specs:
            if all(d["spec"] != spec for d in job.desarmes):
                job.desarmes.append({"spec": spec, "reason": raison})
        self._fermer_trieur(job)
        self._ecrire_fiche(job)

    def _fermer_trieur(self, job: _Job) -> None:
        """Trieur du job tué ; un lot en attente sera relu (sa position n'a pas avancé)."""
        if job.trieur is not None:
            job.trieur.fermer()
            job.trieur = None
        job.lot = None

    def _ajouter(self, job: _Job, b: bytes, touches: Dict[str, int], tester: bool) -> None:
        """Un morceau du journal : lignes passées une à une s'il y a de quoi tester, sinon seulement comptées."""
        litteraux = ([(s, v) for s, g, v in self._armes(job) if g == "match"]
                     if tester and job.pos > job.test_depuis else [])
        dernier = b.rfind(b"\n")
        if dernier < 0:
            self._prolonger(job, b)
            return
        if litteraux and all("\ufffd" not in v for _, v in litteraux):
            vu = job.partiel + b                         # aucun texte cherché dans le morceau : comptage seul
            if not any(v.encode() in vu for _, v in litteraux):
                litteraux = []
        if litteraux or touches or self._attend_apres(job):
            par_ligne: Dict[int, list] = {}
            for spec, k in touches.items():
                par_ligne.setdefault(k, []).append(spec)
            lignes = b[:dernier].split(b"\n")
            lignes[0] = job.partiel + lignes[0][:_JOBS_LIGNE_TEST]
            for k, brut in enumerate(lignes):
                self._ligne(job, brut[:_JOBS_LIGNE_TEST], litteraux, par_ligne.get(k, []))
        else:
            job.lignes += b.count(b"\n")
            debut = dernier
            for _ in range(_JOBS_QUEUE):
                debut = b.rfind(b"\n", 0, debut)
                if debut < 0:
                    break
            bloc = job.partiel + b[:dernier] if debut < 0 else b[debut + 1:dernier]
            for brut in bloc.split(b"\n")[-_JOBS_QUEUE:]:
                job.derniers.append(_vue(brut[:_JOBS_LIGNE_TEST]))
        job.partiel = job.partiel_fin = b""
        self._prolonger(job, b[dernier + 1:])

    def _prolonger(self, job: _Job, b: bytes) -> None:
        if len(job.partiel) < _JOBS_LIGNE_TEST:
            job.partiel += b[:_JOBS_LIGNE_TEST - len(job.partiel)]
        job.partiel_fin = (job.partiel_fin + b[-1024:])[-1024:]

    def _ligne(self, job: _Job, brut: bytes, litteraux: list, regex: list) -> None:
        """Une ligne complète : lignes d'après des correspondances en attente, puis match (ici) et regex (trieur)."""
        job.lignes += 1
        vue = _vue(brut)
        for a in job.attentes:
            if len(a["apres"]) < _JOBS_CONTEXTE:
                a["apres"].append(vue)
        trouves = list(regex)
        if litteraux:
            texte = brut.rstrip(b"\r").decode("utf-8", "replace")
            trouves += [s for s, v in litteraux if v in texte]
        for spec in trouves:
            if spec not in job.fired:
                job.fired.append(spec)
                job.attentes.append({"spec": spec, "genre": spec.partition(":")[0], "ligne": vue, "apres": [],
                                     "avant": list(job.derniers)[-_JOBS_CONTEXTE:],
                                     "echeance": time.monotonic() + _JOBS_APRES_S})
        job.derniers.append(vue)

    def _vider_attentes(self, job: _Job, forcer: bool) -> None:
        """Événements match/regex dont les lignes d'après sont là, ou dont l'attente a expiré."""
        maintenant = time.monotonic()
        restent: list = []
        prets: list = []
        for a in job.attentes:
            pret = forcer or len(a["apres"]) >= _JOBS_CONTEXTE or maintenant >= a["echeance"]
            (prets if pret else restent).append(a)
        job.attentes = restent
        for a in prets:
            self._evenement(job, a["genre"], a["spec"], encore=job.state == "running" and job.fin is None,
                            ligne=a["ligne"],
                            contexte=[*a["avant"], a["ligne"], *a["apres"]])
        if prets:
            self._ecrire_fiche(job)

    def _rotation(self, job: _Job) -> None:
        """Journal de plus de 512 Mo ramené à sa tête (1 Mo), suivie d'une ligne qui le dit."""
        lecture = job.fd
        try:
            st = os.fstat(lecture) if lecture is not None else None
            if lecture is None or st is None or st.st_size <= _JOBS_JOURNAL_MAX:
                return
            fd = os.open(self._fichier(job.id, "log"), os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            return
        self._fermer_trieur(job)                         # un lot en cours ne tient plus : relu après
        try:
            vu = os.fstat(fd)
            if (vu.st_dev, vu.st_ino) != (st.st_dev, st.st_ino):
                return                                   # remplacé : plus le journal du job
            tete = os.pread(lecture, _JOBS_JOURNAL_TETE, 0)
            marque = b"" if not tete or tete.endswith(b"\n") else b"\n"
            marque += b"[elpis: log truncated, %d bytes dropped]\n" % (st.st_size - len(tete))
            os.ftruncate(fd, len(tete))
            os.write(fd, marque)
        except OSError:
            return
        finally:
            os.close(fd)
        job.pos = job.taille = len(tete) + len(marque)
        job.lignes = (tete + marque).count(b"\n")
        job.partiel = job.partiel_fin = b""
        job.derniers.clear()
        job.derniers.append(_vue(marque.strip(b"\n")))

    # ── événements ─────────────────────────────────────────────────────────
    def _evenement(self, job: _Job, trigger: str, spec: Optional[str], encore: bool,
                   ligne: Optional[str] = None, contexte: Optional[list] = None,
                   par: Optional[str] = None) -> None:
        e = {"seq": 0, "job_id": job.id, "ts": round(time.time(), 3), "trigger": trigger, "spec": spec,
             "state": job.state, "exit_code": job.exit_code, "signal": job.signal,
             "duration_s": round(job.duree(), 1), "line": ligne, "context": contexte, "tail": job.queue(),
             "log_lines": job.nb_lignes(), "log_bytes": job.taille, "by": par, "still_running": encore}
        if job.chain_depth is not None:
            e["chain_depth"] = job.chain_depth
        _borner_evenement(e)
        with self._ev:
            self._seq += 1
            e["seq"] = self._seq
            self._evenements.append(e)
            self._consigner(e)
            self._ev.notify_all()

    def _consigner(self, e: Dict[str, Any]) -> None:
        """Ligne ajoutée à jobs-events.ndjson, réécrit avec les derniers gardés quand il déborde."""
        try:
            bg = self._bg(creer=True)
            chemin = os.path.join(bg, _JOBS_EVENEMENTS)
            if self._lignes_fichier < _JOBS_GARDES + _JOBS_GARDES // 5:
                fd = os.open(chemin, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
                             _MODE_FICHIER)
                try:
                    os.write(fd, json.dumps(e, separators=(",", ":")).encode() + b"\n")
                finally:
                    os.close(fd)
                self._lignes_fichier += 1
                return
            tmp = _nom_provisoire(bg)
            try:
                with open(tmp, "x", encoding="ascii") as f:
                    f.writelines(json.dumps(x, separators=(",", ":")) + "\n" for x in self._evenements)
                os.replace(tmp, chemin)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(tmp)
            self._lignes_fichier = len(self._evenements)
        except (OSError, Refus):
            pass                                         # gardé en mémoire : watch le rend quand même

    def _relire_evenements(self, bg: str) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, list]]:
        """jobs-events.ndjson relu : seq continué, derniers gardés ; fins et déclenchements par job."""
        evenements = []
        for ligne in (_lire_petit(os.path.join(bg, _JOBS_EVENEMENTS), 8 << 20, fin=True) or b"").split(b"\n"):
            try:
                e = json.loads(ligne)
            except (ValueError, RecursionError):
                continue
            if (isinstance(e, dict) and (_entier_sur(e.get("seq")) or 0) > 0
                    and isinstance(e.get("job_id"), str) and _JOB_ID.fullmatch(e["job_id"])):
                evenements.append(e)
        fins: Dict[str, Dict[str, Any]] = {}
        declenches: Dict[str, list] = {}
        for e in evenements:
            if e.get("trigger") in ("exit", "lost", "killed"):
                fins[e["job_id"]] = e
            if isinstance(e.get("spec"), str):
                declenches.setdefault(e["job_id"], []).append(e["spec"])
        with self._ev:
            self._seq = max([self._seq, *(e["seq"] for e in evenements)])
            self._evenements.extend(evenements[-_JOBS_GARDES:])
            self._lignes_fichier = len(evenements)
        return fins, declenches

    # ── superviseur ────────────────────────────────────────────────────────
    def _demarrer_superviseur(self) -> None:
        if self._fil is None and not self._arret.is_set():
            self._fil = threading.Thread(target=self._superviser, name="elpis-jobs", daemon=True)
            self._fil.start()

    def _superviser(self) -> None:
        """Toutes les 0,5 s : fin et déclencheurs de TOUS les jobs, puis leurs journaux, chacun dans son budget."""
        while not self._arret.wait(_JOBS_TOUR_S):
            with self._jv:
                suivis = [j for j in self._jobs.values() if j.state == "running" and not j.arret]
                if not suivis and not any(j.arret for j in self._jobs.values()):
                    self._fil = None
                    return
                ports = _ports_en_ecoute() if any(
                    g == "port" and s not in j.fired for j in suivis for s, g, _ in j.declencheurs) else frozenset()
                for job in suivis:
                    try:
                        self._evaluer(job, ports)
                    except Exception:                    # noqa: BLE001 — un job en panne n'arrête pas les autres
                        continue
                for job in suivis:
                    try:
                        self._avancer(job)
                    except Exception:                    # noqa: BLE001
                        continue

    def _vivant(self, job: _Job) -> bool:
        if job.proc is not None:
            return job.proc.poll() is None
        s = _stat_processus(job.pid) if job.pid > 0 else None
        return s is not None and s[2] == job.starttime and s[0] not in ("Z", "X", "x")

    def _fin(self, job: _Job) -> Optional[Tuple[str, Optional[int], Optional[str]]]:
        """(état, code, signal) d'un job fini, ``None`` s'il tourne ; ni .exit ni code connu : lost."""
        if self._vivant(job):
            return None
        b = _lire_petit(self._fichier(job.id, "exit"), 32)
        code = int(b) if b and re.fullmatch(rb"[0-9]{1,3}\s*", b) else None
        if code is None and job.proc is not None and job.proc.returncode is not None:
            rc = job.proc.returncode
            code = rc if rc >= 0 else 128 - rc
        if code is None:
            return "lost", None, None
        return "exited", code, _nom_signal(code)

    def _evaluer(self, job: _Job, ports: frozenset) -> None:
        """Phase 1, sans lire le journal : fin, taille (idle), port, fichier, idle, timeout, battement."""
        fin = self._fin(job) if job.fin is None else None
        if job.fd is not None:
            with contextlib.suppress(OSError):
                taille = os.fstat(job.fd).st_size
                if taille > job.taille:                  # idle : sortie vue grandir
                    job.sortie = time.monotonic()
                job.taille = taille
        if fin is not None:
            job.fin, job.fin_pos = fin, job.taille       # clos quand le journal est rattrapé jusque-là
        if job.fin is not None:
            return
        maintenant = time.monotonic()
        for spec, genre, val in job.declencheurs:
            if spec not in job.fired and (
                    (genre == "port" and val in ports)
                    or (genre == "file" and self._existe(val))
                    or (genre == "idle" and maintenant - job.sortie >= val)
                    or (genre == "timeout" and maintenant - job.t0 >= val)):
                job.fired.append(spec)
                self._evenement(job, genre, spec, encore=True)
                self._ecrire_fiche(job)
        if maintenant - job.battement >= _JOBS_BATTEMENT_S:
            self._toucher(job)

    def _avancer(self, job: _Job) -> None:
        """Phase 2 : journal lu dans le budget, correspondances mûres émises, puis fin ou rotation."""
        self._lire_journal(job, _JOBS_BUDGET_S)
        self._vider_attentes(job, forcer=False)
        if job.fin is None:
            self._rotation(job)
        elif job.lot is None and job.pos >= min(job.taille, job.fin_pos):
            self._clore(job, *job.fin)

    def _clore(self, job: _Job, etat: str, code: Optional[int], sig: Optional[str]) -> None:
        """Fin constatée : état, correspondances en attente, événement exit ou lost, fiche, journal fermé."""
        fin = time.time()
        if etat == "exited":
            with contextlib.suppress(OSError):
                fin = min(fin, os.stat(self._fichier(job.id, "exit"), follow_symlinks=False).st_mtime)
            if "exit" not in job.fired:
                job.fired.append("exit")
        job.state, job.exit_code, job.signal, job.ended_at = etat, code, sig, round(fin, 3)
        self._vider_attentes(job, forcer=True)
        self._fermer_trieur(job)
        self._rotation(job)
        self._evenement(job, "exit" if etat == "exited" else "lost", "exit" if etat == "exited" else None,
                        encore=False)
        self._ecrire_fiche(job)
        self._fermer_journal(job)

    # ── routes ─────────────────────────────────────────────────────────────
    def lancer(self, d: Dict[str, Any]) -> Dict[str, Any]:
        """POST /v1/jobs/start : la commande, en tâche de fond surveillée."""
        ident = self._ident(d.get("id"))
        commande = d.get("command")
        if (not isinstance(commande, str) or not commande.strip() or "\0" in commande
                or len(commande) > _JOBS_COMMANDE_MAX):
            raise Refus(400, "bad_request", f"command : non vide, sans NUL, {_JOBS_COMMANDE_MAX} caractères au plus")
        rel = self._rel_confine(d.get("cwd"))
        cwd = self.agent.reel(rel)
        if not os.path.isdir(cwd):
            raise Refus(404, "not_found", "dossier de travail absent")
        env = _env_job(d.get("env"), self.agent.racine, ident)
        etiquette = d.get("label")
        if not isinstance(etiquette, str) or not etiquette:
            etiquette = commande[:40]
        declencheurs = self._declencheurs(d.get("wake_on"))
        profondeur = d.get("chain_depth")
        if profondeur is not None and not (_entier_sur(profondeur) is not None
                                           and 0 <= profondeur <= _JOBS_PROFONDEUR_MAX):
            raise Refus(400, "bad_request", f"chain_depth : entier de 0 à {_JOBS_PROFONDEUR_MAX}")
        with self._jv:
            bg = self._bg(creer=True)
            if ident in self._jobs or any(os.path.lexists(self._fichier(ident, x)) for x in ("json", "log")):
                raise Refus(409, "job_exists", "job déjà connu")
            if sum(j.state == "running" for j in self._jobs.values()) >= _JOBS_VIVANTS_MAX:
                raise Refus(429, "too_many_jobs", f"{_JOBS_VIVANTS_MAX} jobs vivants au plus",
                            max=_JOBS_VIVANTS_MAX)
            for ext in ("exit", "exit.tmp"):
                with contextlib.suppress(OSError):
                    os.unlink(self._fichier(ident, ext))
            journal = os.path.join(bg, f"job-{ident}.log")
            try:
                ecriture = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_NOFOLLOW
                                   | os.O_CLOEXEC, _MODE_FICHIER)
            except OSError as e:
                raise _refus_os(e) from None
            job = _Job(ident)
            job.created_at = round(time.time(), 3)
            try:
                job.fd = os.open(journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                job.proc = subprocess.Popen(
                    [_BASH, "-c", _ENVELOPPE, commande, os.path.join(bg, f"job-{ident}.exit")],
                    cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=ecriture, stderr=ecriture,
                    start_new_session=True, umask=0o022)
            except (OSError, ValueError) as e:
                self._fermer_journal(job)
                with contextlib.suppress(OSError):
                    os.unlink(journal)
                raise Refus(500, "exec_failed", f"lancement du job : {e}"[:300]) from None
            finally:
                os.close(ecriture)
            job.t0 = job.sortie = time.monotonic()
            job.started_at = round(time.time(), 3)
            job.pid = job.proc.pid
            job.starttime = (_stat_processus(job.pid) or ("", 0, 0))[2]
            job.command, job.cwd, job.label = commande, rel, etiquette[:60].replace("\0", "")
            job.declencheurs = declencheurs
            job.wake_on = [x[0] for x in declencheurs]
            job.chain_depth = profondeur
            self._jobs[ident] = job
            self._ecrire_fiche(job)
            self._demarrer_superviseur()
            return {"id": ident, "pid": job.pid, "state": "running", "log": f"{_JOBS_BG}/job-{ident}.log",
                    "started_at": job.started_at, "wake_on": list(job.wake_on)}

    def arreter(self, d: Dict[str, Any]) -> Dict[str, Any]:
        """POST /v1/jobs/kill : groupe et processus marqués arrêtés, événement killed ; purge au besoin."""
        ident = self._ident(d.get("id"))
        nom = str(d.get("signal") or "TERM").upper()
        par = d.get("by") or "agent"
        if nom not in _SIGNAUX or par not in ("agent", "user", "core"):
            raise Refus(400, "bad_request", "signal : TERM, KILL ou INT ; by : agent, user ou core")
        grace = max(0.0, min(float(d.get("grace_s", 5)), _JOBS_GRACE_MAX_S))
        purge = _vrai(d.get("purge"))
        with self._jv:
            job = self._jobs.get(ident)
            if job is None:
                with contextlib.suppress(Refus):
                    self._bg()
                    job = self._job_du_disque(ident)
            if job is None and purge:                    # fiche disparue : marqués balayés, fichiers retirés
                job = _Job(ident)
                job.state = "lost"
            if job is None:
                raise Refus(404, "job_not_found", "job inconnu")
            if job.arret:
                raise Refus(409, "busy", "arrêt déjà en cours")
            actif = job.state == "running"
            groupe = job.pid if actif and self._vivant(job) else 0
            job.arret = True
        try:
            tues = self._tuer(job, groupe, _SIGNAUX[nom], grace)
        except BaseException:
            with self._jv:
                job.arret = False
            raise
        with self._jv:
            job.arret = False                            # sous le verrou : le superviseur ne la clôt pas
            if actif:
                fin = self._fin(job) or ("", None, None)
                self._lire_journal(job, None, tester=False)
                job.state, job.ended_at = "killed", round(time.time(), 3)
                job.exit_code, job.signal = fin[1], fin[2] or "SIG" + nom
                self._vider_attentes(job, forcer=True)
                self._evenement(job, "killed", None, encore=False, par=par)
                self._ecrire_fiche(job)
                self._fermer_journal(job)
            elif not tues and not purge:
                raise Refus(409, "job_not_running", "job déjà fini", state=job.state)
            rendu = {"id": job.id, "killed_pids": tues, "state": job.state, "exit_code": job.exit_code,
                     "signal": job.signal}
            if purge:
                self._purger(job)
            return rendu

    def _tuer(self, job: _Job, groupe: int, sig: int, grace: float) -> list:
        """Signal au groupe et aux processus marqués (sortis du groupe par setsid), KILL après la grâce."""
        marqueur = b"\0ELPIS_JOB_ID=" + job.id.encode() + b"\0"
        moi = os.getpid()

        def membres() -> Dict[int, int]:
            return {pid: g for pid, g in _processus()
                    if pid != moi and ((groupe and g == groupe) or _porte_marqueur(pid, marqueur))}

        def signaler(cibles: Dict[int, int], s: int) -> None:
            if groupe:
                with contextlib.suppress(OSError):
                    os.killpg(groupe, s)
            for pid, g in cibles.items():
                if not groupe or g != groupe:
                    with contextlib.suppress(OSError):
                        os.kill(pid, s)

        restants = membres()
        touches = set(restants)
        signaler(restants, sig)
        echeance, essais = time.monotonic() + grace, 0
        while restants and essais < 40:
            time.sleep(0.05)
            if job.proc is not None:
                job.proc.poll()                          # l'enveloppe, enfant de l'agent : récoltée
            restants = membres()
            touches.update(restants)
            if restants and time.monotonic() >= echeance:
                signaler(restants, signal.SIGKILL)
                essais += 1
        return sorted(touches)

    def _purger(self, job: _Job) -> None:
        """``.bg/job-<id>.*`` retirés, job oublié (conversation supprimée, JB-20)."""
        self._fermer_trieur(job)
        self._fermer_journal(job)
        with contextlib.suppress(Refus):
            self._bg()
            for ext in ("log", "json", "exit", "exit.tmp"):
                with contextlib.suppress(OSError):
                    os.unlink(self._fichier(job.id, ext))
        self._jobs.pop(job.id, None)

    def _resume(self, job: _Job) -> Dict[str, Any]:
        return {"id": job.id, "state": job.state, "pid": job.pid,
                "alive": job.state == "running" and self._vivant(job), "runtime_s": round(job.duree(), 1),
                "log_bytes": job.taille, "log_lines": job.nb_lignes(), "last_line": (job.queue() or [""])[-1],
                "wake_on": list(job.wake_on), "fired": list(job.fired), "exit_code": job.exit_code,
                "signal": job.signal, "started_at": job.started_at, "ended_at": job.ended_at,
                "disarmed": [dict(d) for d in job.desarmes]}

    def etat(self, ident: str) -> Dict[str, Any]:
        """GET /v1/jobs/status : un job, ou tous ceux que l'agent suit."""
        with self._jv:
            if not ident:
                return {"jobs": [self._resume(j) for j in self._jobs.values()]}
            job = self._jobs.get(self._ident(ident))
            if job is None:
                raise Refus(404, "job_not_found", "job inconnu")
            return {"jobs": [self._resume(job)]}

    def liste(self) -> Dict[str, Any]:
        """GET /v1/jobs/list : les jobs suivis, et les fiches de .bg qu'il ne connaît pas."""
        with self._jv:
            rendu = [self._resume(j) for j in self._jobs.values()]
            connus = set(self._jobs)
        try:
            noms = sorted(n for n in os.listdir(self._bg()) if _JOB_FICHE.fullmatch(n))[:_JOBS_GARDES]
        except (OSError, Refus):
            noms = []
        for nom in noms:
            m = _JOB_FICHE.fullmatch(nom)
            job = self._job_du_disque(m.group(1)) if m and m.group(1) not in connus else None
            if job is not None:
                self._queue_disque(job)
                rendu.append(self._resume(job))
        return {"jobs": rendu}

    def _depuis(self, depuis: int) -> Tuple[list, int]:
        """Événements de seq > depuis (un lot au plus) et le dernier seq qu'ils couvrent ; sous ``_ev``."""
        nouveaux = [e for e in self._evenements if e["seq"] > depuis][:_JOBS_VEILLE_LOT]
        return nouveaux, nouveaux[-1]["seq"] if len(nouveaux) == _JOBS_VEILLE_LOT else self._seq

    def veiller(self, depuis: int, attente_s: float) -> Iterator[Dict[str, Any]]:
        """POST /v1/jobs/watch : événements de seq > depuis dès qu'il y en a, signes de vie, bilan."""
        echeance = signe = time.monotonic()
        echeance += attente_s
        with self._ev:
            reset = depuis > self._seq
            nouveaux, dernier = self._depuis(0 if reset else depuis)
        if reset:
            depuis = 0
        attendu = False
        while not nouveaux and not self._arret.is_set() and time.monotonic() < echeance:
            if time.monotonic() - signe >= _SIGNE_S:
                signe = time.monotonic()
                yield {"tick": True}
            with self._ev:
                self._ev.wait(max(0.0, min(echeance, signe + _SIGNE_S) - time.monotonic()))
                nouveaux, dernier = self._depuis(depuis)
            attendu = True
        if nouveaux and attendu:
            time.sleep(_JOBS_GROUPE_S)                   # les événements proches partent ensemble
            with self._ev:
                nouveaux, dernier = self._depuis(depuis)
        yield from nouveaux
        with self._jv:
            vivants = sum(j.state == "running" for j in self._jobs.values())
        yield {"done": True, "last_seq": dernier, "running": vivants, "reset": reset}

    # ── cycle de vie ───────────────────────────────────────────────────────
    def reprendre(self) -> None:
        """Agent (re)lancé : seq continué ; job vivant (starttime vérifié) suivi, sinon exit (.exit) ou lost."""
        try:
            bg = self._bg()
            noms = sorted(n for n in os.listdir(bg) if _JOB_FICHE.fullmatch(n))[:_JOBS_GARDES]
        except (OSError, Refus):
            return
        fins, declenches = self._relire_evenements(bg)
        with self._jv:
            for nom in noms:
                m = _JOB_FICHE.fullmatch(nom)
                job = self._job_du_disque(m.group(1)) if m and m.group(1) not in self._jobs else None
                if job is None:
                    continue
                self._jobs[job.id] = job
                job.fired += [s for s in dict.fromkeys(declenches.get(job.id, ())) if s not in job.fired]
                fin = fins.get(job.id)
                if job.state == "running" and fin is not None:     # événement émis, fiche en retard
                    job.state = fin["state"] if isinstance(fin.get("state"), str) and fin["state"] in _TERMINAUX \
                        else "lost"
                    job.exit_code, job.ended_at = _entier_sur(fin.get("exit_code")), _reel_sur(fin.get("ts"))
                    job.signal = fin["signal"] if isinstance(fin.get("signal"), str) else None
                    self._ecrire_fiche(job)
                if job.state != "running":
                    self._queue_disque(job)
                    continue
                self._ouvrir_journal(job)                # relu depuis le début : lignes recomptées
                job.lignes = 0
                if job.fd is not None:
                    st = os.fstat(job.fd)
                    job.taille, job.test_depuis = st.st_size, max(0, st.st_size - _JOBS_REPRISE_TEST)
                    job.sortie = time.monotonic() - max(0.0, time.time() - st.st_mtime)
            if any(j.state == "running" for j in self._jobs.values()):
                self._demarrer_superviseur()

    def fermer(self) -> None:
        """Arrêt de l'agent : superviseur et watch arrêtés ; les jobs, eux, continuent."""
        self._arret.set()
        with self._ev:
            self._ev.notify_all()
        fil = self._fil
        if fil is not None:
            fil.join(5)
        with self._jv:
            for job in self._jobs.values():
                self._fermer_trieur(job)
                self._fermer_journal(job)


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
        if self.headers.get("X-Elpis-Passive") != "1":
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
            genres = d.get("kinds") or []
            if not all(isinstance(x, list) for x in (elaguer, exclure, genres)):
                raise Refus(400, "bad_request", "prune, exclude, kinds : listes attendues")
            lignes = agent.lister(
                normaliser(d.get("path")), max(1, min(int(d.get("depth") or 1), _PROFONDEUR_MAX)),
                max(1, min(int(d.get("max_entries") or 20000), 200000)),
                _vrai(d.get("hidden", True)), [str(x) for x in elaguer],
                float(d.get("deadline_s") or 30), [str(x) for x in exclure],
                str(d.get("name_contains") or ""), [str(x) for x in genres],
                str(d.get("name_glob") or ""))
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
                max(0.1, min(float(d.get("deadline_s") or 1.5), 30.0)), _vrai(d.get("all_kinds"))))
        elif cle == ("POST", "/v1/changes/end"):
            d = self._corps_json()
            lignes = agent.releve_fin(
                str(d.get("id") or ""), max(0, min(int(d.get("max_files") or 200), 5000)),
                max(0, int(d.get("max_bytes") or 32 << 20)), max(0, int(d.get("max_file") or 5 << 20)))
            premiere = next(lignes)                      # relevé inconnu : refus AVANT l'en-tête 200
            self._ndjson(premiere, lignes)
        elif cle == ("POST", "/v1/git"):
            self._json(200, agent.git(self._corps_json()))
        elif cle == ("POST", "/v1/archive"):
            a = _args_archive(self._corps_json())
            plan = agent.plan_archive(a)                 # un refus part AVANT l'en-tête 200
            self._trames(plan, lambda sortie: agent.ecrire_archive(sortie, a, plan))
        elif cle == ("PUT", "/v1/extract"):
            corps = self._corps(_entier(q, "max"))
            try:
                self._json(200, agent.extraire(
                    normaliser(q.get("path")), corps, garder=_nom_simple(q.get("keep")),
                    laisser=q.get("leave") or "", max_octets=_entier(q, "max_bytes", 1 << 30) or 0,
                    max_fichier=_entier(q, "max_file", 1 << 30) or 0,
                    max_membres=_entier(q, "max_members", 100000) or 0))
            except Refus:
                for _bloc in corps:                      # lu jusqu'au bout : l'erreur part
                    pass                                 # sur une connexion synchronisée
                raise
        elif cle == ("POST", "/v1/jobs/start"):
            self._json(200, agent.jobs.lancer(self._corps_json()))
        elif cle == ("POST", "/v1/jobs/kill"):
            self._json(200, agent.jobs.arreter(self._corps_json()))
        elif cle == ("GET", "/v1/jobs/status"):
            self._json(200, agent.jobs.etat(q.get("id") or ""))
        elif cle == ("GET", "/v1/jobs/list"):
            self._json(200, agent.jobs.liste())
        elif cle == ("POST", "/v1/jobs/watch"):
            d = self._corps_json()
            depuis = d.get("since_seq") or 0
            if isinstance(depuis, bool) or not isinstance(depuis, int) or depuis < 0:
                raise Refus(400, "bad_request", "since_seq : entier positif")
            attente = max(0.0, min(float(d.get("wait_s", _JOBS_VEILLE_MAX_S)), _JOBS_VEILLE_MAX_S))
            self._ndjson({"tick": True}, agent.jobs.veiller(depuis, attente))
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

    def _trames(self, debut: Dict[str, Any], ecrire: Any) -> None:
        """Réponse en trames (``_Sortie``) : ``debut``, ce qu'écrit
        ``ecrire(sortie)``, puis le bilan qu'elle rend — ou, en cours de flux,
        une dernière trame ``{"error"}``."""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-elpis-frames")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        sortie = _Sortie(self.wfile)
        sortie.json(debut)
        try:
            fin = ecrire(sortie)
        except (BrokenPipeError, ConnectionResetError):
            sortie.abandonner()                          # rien de plus sur ce socket
            raise
        except Refus as r:
            fin = {"error": r.code, "message": r.message}
        except OSError as e:
            refus = _refus_os(e)
            fin = {"error": refus.code, "message": refus.message}
        except Exception as e:                           # noqa: BLE001
            fin = {"error": "internal", "message": f"{type(e).__name__}: {e}"}
        sortie.json(fin)
        sortie.fermer()

    def _lire(self, agent: Agent, q: Dict[str, str]) -> None:
        fd = _ouvrir_fichier(agent.reel(normaliser(q.get("path"))))
        try:
            st = os.fstat(fd)
            infos = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "ino": st.st_ino,
                     "dev": st.st_dev, "mode": stat.S_IMODE(st.st_mode)}
            if (_entier(q, "expect_size") not in (None, st.st_size)
                    or _entier(q, "expect_mtime_ns", mini=None) not in (None, st.st_mtime_ns)
                    or _entier(q, "expect_ino") not in (None, st.st_ino)):
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

    def server_close(self) -> None:
        super().server_close()
        self.agent.jobs.fermer()


def servir(racine: str, chemin_socket: str, relais: str = "") -> _Serveur:
    """Serveur lié à ``chemin_socket`` (remplace un socket orphelin) ; à faire
    tourner par ``serve_forever``. L'appelant tient le verrou d'instance.
    ``relais`` : dossier des sockets du relais Git de l'hôte."""
    try:
        os.unlink(chemin_socket)
    except FileNotFoundError:
        pass
    config_git = _ecrire_config_git(os.path.dirname(chemin_socket) or ".")
    serveur = _Serveur(chemin_socket, Agent(racine, relais, config_git))
    serveur.agent.jobs.reprendre()                       # jobs d'un agent précédent : suivis, finis ou perdus
    return serveur


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
    ap.add_argument("--relay-dir", default=RELAIS_DOSSIER)
    ap.add_argument("--lock-wait", type=float, default=10.0,
                    help="attente du verrou d'instance (s) : un agent qui s'arrête le tient encore")
    args = ap.parse_args(argv)
    os.umask(0o022)                                      # un seul UID écrit dans /work
    if _verrou_instance(os.path.dirname(args.socket), args.lock_wait) is None:
        return 0
    # Le socket reste en place à l'arrêt : le suivant le remplace (servir).
    serveur = servir(args.root, args.socket, args.relay_dir)
    try:
        serveur.serve_forever(poll_interval=0.2)
    finally:
        serveur.server_close()                           # superviseur arrêté entre deux tours
    return 0


if __name__ == "__main__":
    sys.exit(main())
