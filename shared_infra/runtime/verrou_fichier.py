# SPDX-License-Identifier: MIT
"""shared_infra/runtime/verrou_fichier.py — verrou inter-processus elpis.verrou.v1.1, commun avec le core TS."""
from __future__ import annotations

import asyncio
import contextlib
import errno
import json
import logging
import math
import os
import secrets
import socket
import threading
import time
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple, Union

logger = logging.getLogger("uvicorn.error")

VERSION = 1
PEREMPTION_DEFAUT_S = 120.0
ILLISIBLE_S = 5.0
ATTENTE_MIN_S = 0.010
ATTENTE_MAX_S = 0.200
ATTENTE_SIGNALEE_S = 30.0
SUFFIXE_REPRISE = ".reprise"
SUFFIXE_PERIME = ".perime."
REPRISE_PEREMPTION_S = 10.0
REPRISE_ATTENTE_MIN_S = 0.001
REPRISE_ATTENTE_MAX_S = 0.020
_LECTURE_MAX = 4096
_ESSAIS = 8
_ILLISIBLES_MAX = 256
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)

Chemin = Union[str, "os.PathLike[str]"]

_processus: Optional[str] = None
_etat = threading.Lock()
_dernier_debut = 0
_debuts_tenus: set[int] = set()
_illisibles: Dict[Tuple[int, int, int], float] = {}
_machine: Optional[Tuple[str, str]] = None


class VerrouOccupe(TimeoutError):
    """Délai dépassé : le verrou reste tenu par un détenteur vivant."""


def definir_processus(nom: str) -> None:
    """Nom écrit dans le champ ``proc`` des verrous pris par ce processus."""
    global _processus
    _processus = str(nom or "").strip() or None


def nom_processus() -> str:
    """Nom déclaré, sinon ``APP_SERVICE`` ou ``APP_MODE``, sinon « python »."""
    return _processus or os.environ.get("APP_SERVICE") or os.environ.get("APP_MODE") or "python"


def chemin_verrou(ressource: Chemin, *, repertoire: bool = False) -> Path:
    """``R.lock`` à côté d'un fichier, ``R/.lock`` dans un répertoire."""
    p = Path(ressource)
    return p / ".lock" if repertoire else p.with_name(p.name + ".lock")


def pid_vivant(pid: int) -> bool:
    """Faux seulement quand ``kill(pid, 0)`` répond ESRCH."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _lire_texte(chemin: str) -> str:
    try:
        return Path(chemin).read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return ""


def identite_machine() -> Tuple[str, str, str]:
    """(hôte, identifiant de démarrage, espace de PID) de ce processus ; vides quand inconnus."""
    global _machine
    if _machine is None:
        try:
            nspid = os.readlink("/proc/self/ns/pid")
        except OSError:
            nspid = ""
        _machine = (_lire_texte("/proc/sys/kernel/random/boot_id"), nspid)
    return (socket.gethostname(), *_machine)


def _reserver_debut() -> int:
    """``debut`` strictement croissant dans le processus, noté comme tenu avant même la création du fichier."""
    global _dernier_debut
    with _etat:
        debut = max(int(time.time() * 1000), _dernier_debut + 1)
        _dernier_debut = debut
        _debuts_tenus.add(debut)
        return debut


def _liberer_debut(debut: int) -> None:
    with _etat:
        _debuts_tenus.discard(debut)


def _tenu_ici(debut: float) -> bool:
    with _etat:
        return debut in _debuts_tenus


def _apres_fork() -> None:
    """Dans l'enfant d'un fork : nouveau verrou d'état, aucun verrou de fichier tenu."""
    global _etat
    _etat = threading.Lock()
    _debuts_tenus.clear()


os.register_at_fork(after_in_child=_apres_fork)


def _illisible_depuis(cle: Tuple[int, int, int]) -> float:
    """Instant (monotone) où ce fichier illisible a été vu la première fois par ce processus."""
    maintenant = time.monotonic()
    with _etat:
        if len(_illisibles) >= _ILLISIBLES_MAX:
            for k in [k for k, t in _illisibles.items() if maintenant - t > 600]:
                del _illisibles[k]
            if len(_illisibles) >= _ILLISIBLES_MAX:
                _illisibles.clear()
        return _illisibles.setdefault(cle, maintenant)


@dataclass(frozen=True)
class _Etat:
    dev: int
    ino: int
    mtime_ns: int
    brut: bytes
    contenu: Optional[Dict[str, Any]]
    interdit: bool = False


def _nombre(x: object) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _decoder(brut: bytes) -> Optional[Dict[str, Any]]:
    """Contenu valide (champ facultatif mal typé = inconnu), ou ``None`` si un champ obligatoire est invalide."""
    try:
        d = json.loads(brut.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(d, dict) or type(d.get("v")) is not int or d["v"] != VERSION:
        return None
    pid = d.get("pid")
    if type(pid) is not int or not 0 < pid < 2 ** 31:
        return None
    if not isinstance(d.get("hote"), str) or not _nombre(d.get("debut")):
        return None
    for k in ("boot", "nspid"):
        if k in d and not isinstance(d[k], str):
            d[k] = ""
    if "peremption" in d and not _nombre(d["peremption"]):
        del d["peremption"]
    return d


def _lire(chemin: Path) -> Optional[_Etat]:
    """État du fichier, ``None`` s'il est absent ; une erreur d'E/S autre que « interdit » ou « lien » lève."""
    try:
        fd = os.open(chemin, os.O_RDONLY | _O_NOFOLLOW | _O_CLOEXEC)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if not isinstance(exc, PermissionError) and exc.errno != errno.ELOOP:
            raise
        try:
            st = os.lstat(chemin)
        except FileNotFoundError:
            return None
        return _Etat(st.st_dev, st.st_ino, st.st_mtime_ns, b"", None, isinstance(exc, PermissionError))
    try:
        st = os.fstat(fd)
        try:
            brut = os.read(fd, _LECTURE_MAX)
        except IsADirectoryError:
            brut = b""
    finally:
        os.close(fd)
    return _Etat(st.st_dev, st.st_ino, st.st_mtime_ns, brut, _decoder(brut))


def _meme_fichier(a: _Etat, b: _Etat) -> bool:
    return (a.dev, a.ino, a.mtime_ns, a.brut) == (b.dev, b.ino, b.mtime_ns, b.brut)


def _supprimer(chemin: Path) -> None:
    try:
        os.unlink(chemin)
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("[verrou] %s non supprimé : %r", chemin, exc)


def _ecrire_tout(fd: int, donnees: bytes) -> None:
    vue = memoryview(donnees)
    while vue:
        vue = vue[os.write(fd, vue):]


def _ligne(pid: int, debut: int, processus: str, peremption_s: float) -> bytes:
    hote, boot, nspid = identite_machine()
    return (json.dumps({"v": VERSION, "pid": pid, "hote": hote, "debut": debut, "proc": processus, "boot": boot,
                        "nspid": nspid, "peremption": int(peremption_s * 1000)},
                       ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _creer(chemin: Path, ligne: bytes, *, annexe: bool = False) -> bool:
    """Création exclusive portant ``ligne`` ; faux si le chemin existe, ou n'est plus notre fichier une fois écrit."""
    drapeaux = os.O_CREAT | os.O_EXCL | os.O_WRONLY | _O_NOFOLLOW | _O_CLOEXEC
    try:
        fd = os.open(chemin, drapeaux, 0o600)
    except FileExistsError:
        return False
    except FileNotFoundError:
        chemin.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(chemin, drapeaux, 0o600)
        except FileExistsError:
            return False
    ident: Optional[Tuple[int, int]] = None
    try:
        try:
            st = os.fstat(fd)
            ident = (st.st_dev, st.st_ino)
            _ecrire_tout(fd, ligne)
            if not annexe:
                os.fsync(fd)
            lie = os.fstat(fd).st_nlink > 0
        finally:
            os.close(fd)
    except BaseException:
        if ident is not None:
            with contextlib.suppress(OSError):
                _effacer_si(chemin, ident, annexe)
        raise
    try:
        st = os.lstat(chemin)
    except FileNotFoundError:
        return False
    return lie and (st.st_dev, st.st_ino) == ident


def _effacer_si(chemin: Path, ident: Tuple[int, int], annexe: bool) -> None:
    """Supprime ``chemin`` s'il est encore l'inode ``ident`` ; sous ``R.lock.reprise``, sauf pour la reprise même."""
    with contextlib.nullcontext() if annexe else _Reprise(chemin):
        st = os.lstat(chemin)
        if (st.st_dev, st.st_ino) == ident:
            _supprimer(chemin)


def _raison_perime(etat: _Etat, peremption_s: float, *, fixe: bool = False) -> Optional[str]:
    """Règles de péremption de la spec v1.1 (PID, redémarrage, âge du mtime, contenu illisible)."""
    age = time.time() - etat.mtime_ns / 1e9
    c = etat.contenu
    if etat.interdit:
        return "illisible pour ce compte et trop ancien" if age > peremption_s else None
    if c is None:
        vu = _illisible_depuis((etat.dev, etat.ino, etat.mtime_ns))
        return "contenu illisible" if age > ILLISIBLE_S or time.monotonic() - vu > ILLISIBLE_S else None
    limite = peremption_s if fixe else max(peremption_s, float(c.get("peremption") or 0) / 1000)
    hote, boot, nspid = identite_machine()
    if c["hote"] == hote:
        if boot and c.get("boot") and c["boot"] != boot:
            return "pris avant le redémarrage de la machine"
        if all(k not in c or c[k] == mien for k, mien in (("boot", boot), ("nspid", nspid))):
            if c["pid"] == os.getpid():
                if not _tenu_ici(c["debut"]):
                    return "pris par un processus précédent de même PID"
            elif not pid_vivant(c["pid"]):
                return f"pid {c['pid']} absent"
    if age > limite:
        return f"inchangé depuis plus de {limite:.0f} s ({c.get('proc')!s}, pid {c['pid']}, {c['hote']})"
    return None


class _Reprise:
    """``R.lock.reprise`` : sous lui seul, ``R.lock`` peut être supprimé (reprise d'un périmé ou rendu)."""

    def __init__(self, verrou: Path, processus: Optional[str] = None) -> None:
        self.chemin = verrou.with_name(verrou.name + SUFFIXE_REPRISE)
        self.processus = processus
        self._ligne = b""
        self._debut = 0

    def tenue(self) -> bool:
        """Notre reprise est-elle encore en place ? Revérifié juste avant de supprimer ``R.lock``."""
        try:
            etat = _lire(self.chemin)
        except OSError:
            return False
        return etat is not None and etat.brut == self._ligne

    def __enter__(self) -> "_Reprise":
        attente = REPRISE_ATTENTE_MIN_S
        while True:
            debut = _reserver_debut()
            ligne = _ligne(os.getpid(), debut, self.processus or nom_processus(), REPRISE_PEREMPTION_S)
            try:
                pris = _creer(self.chemin, ligne, annexe=True)
            except BaseException:
                _liberer_debut(debut)
                raise
            if pris:
                self._ligne, self._debut = ligne, debut
                return self
            _liberer_debut(debut)
            etat = _lire(self.chemin)
            if etat is not None and _raison_perime(etat, REPRISE_PEREMPTION_S, fixe=True) is not None:
                self._casser(etat)
                continue
            time.sleep(attente)
            attente = min(attente * 2, REPRISE_ATTENTE_MAX_S)

    def __exit__(self, *exc: object) -> None:
        try:
            etat = _lire(self.chemin)
            if etat is not None and etat.brut == self._ligne:
                _supprimer(self.chemin)
            else:
                logger.warning("[verrou] %s : reprise cassée par un autre processus avant d'être rendue", self.chemin)
        except OSError as e:
            logger.warning("[verrou] %s non rendue (%r) : périmée dans %.0f s", self.chemin, e, REPRISE_PEREMPTION_S)
        finally:
            _liberer_debut(self._debut)

    def _casser(self, etat: _Etat) -> None:
        """Faute de troisième niveau : renommage, relecture, suppression si identique, sinon remise en place."""
        deplace = self.chemin.with_name(self.chemin.name + SUFFIXE_PERIME + secrets.token_hex(6))
        try:
            os.rename(self.chemin, deplace)
        except FileNotFoundError:
            return
        try:
            relu = _lire(deplace)
        except OSError:
            relu = None
        if relu is not None and _meme_fichier(relu, etat):
            _supprimer(deplace)
            return
        try:
            os.link(deplace, self.chemin)
        except OSError:
            if not os.path.lexists(self.chemin):
                with contextlib.suppress(OSError):
                    os.rename(deplace, self.chemin)
                    return
            logger.warning("[verrou] %s : reprise vivante déplacée par erreur, non remise", self.chemin)
        _supprimer(deplace)


def _battre(chemin: Path, periode: float, arret: threading.Event, ligne: bytes) -> None:
    """Rafraîchit le mtime tant que le fichier porte ``ligne`` ; erreur passagère signalée puis réessayée."""
    signale = False
    while not arret.wait(periode):
        try:
            fd = os.open(chemin, os.O_RDONLY | _O_NOFOLLOW | _O_CLOEXEC)
        except (FileNotFoundError, NotADirectoryError):
            return
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                return
            signale = signale or _signaler_battement(chemin, exc)
            continue
        try:
            if os.read(fd, _LECTURE_MAX) != ligne:
                return
            os.utime(fd)
        except OSError as exc:
            signale = signale or _signaler_battement(chemin, exc)
        finally:
            os.close(fd)


def _signaler_battement(chemin: Path, exc: OSError) -> bool:
    logger.warning("[verrou] %s : battement en échec (%r), nouvel essai à la prochaine période", chemin, exc)
    return True


class VerrouFichier:
    """Verrou elpis.verrou.v1.1 sur ``chemin`` : non réentrant, une prise à la fois par instance."""

    def __init__(self, chemin: Chemin, *, delai: Optional[float] = None,
                 peremption: float = PEREMPTION_DEFAUT_S, processus: Optional[str] = None,
                 battement: bool = False) -> None:
        self.chemin = Path(chemin)
        self.delai = None if delai is None else max(0.0, float(delai))
        self.peremption = float(peremption)
        self.processus = processus
        self.battement = battement
        self._tenu: Optional[Tuple[int, int, bytes]] = None
        self._arreter: Optional[Callable[[], Any]] = None

    @property
    def tenu(self) -> bool:
        return self._tenu is not None

    def essayer(self) -> bool:
        """Une prise sans attente, reprise d'un verrou périmé comprise."""
        if self._tenu is not None:
            raise RuntimeError(f"verrou {self.chemin} déjà tenu par cette instance")
        for _ in range(_ESSAIS):
            if self._prendre():
                return True
            etat = _lire(self.chemin)
            if etat is None:
                continue
            raison = _raison_perime(etat, self.peremption)
            if raison is None:
                return False
            self._reprendre(etat, raison)
        return False

    def acquerir(self) -> None:
        """Prise avec attente de 10 ms doublée jusqu'à 200 ms ; ``VerrouOccupe`` au-delà du délai."""
        debut = time.monotonic()
        attente = ATTENTE_MIN_S
        signale = False
        while not self.essayer():
            reste = self._reste(debut)
            signale = signale or self._signaler_attente(debut)
            time.sleep(attente if reste is None else min(attente, reste))
            attente = min(attente * 2, ATTENTE_MAX_S)

    async def acquerir_async(self) -> None:
        """Comme ``acquerir``, sans bloquer la boucle ; une annulation ne laisse aucun verrou tenu."""
        debut = time.monotonic()
        attente = ATTENTE_MIN_S
        signale = False
        while not await self._essayer_async():
            reste = self._reste(debut)
            signale = signale or self._signaler_attente(debut)
            await asyncio.sleep(attente if reste is None else min(attente, reste))
            attente = min(attente * 2, ATTENTE_MAX_S)

    def rendre(self) -> None:
        """Sous ``R.lock.reprise`` : supprime le verrou s'il porte encore nos octets ; sinon avertit seulement."""
        tenu, self._tenu = self._tenu, None
        if tenu is None:
            return
        if self._arreter is not None:
            self._arreter()
            self._arreter = None
        pid, debut, ecrit = tenu
        if pid != os.getpid():
            return
        try:
            with _Reprise(self.chemin, self.processus) as reprise:
                etat = _lire(self.chemin)
                if etat is None or etat.brut != ecrit:
                    self._avertir_repris()
                elif reprise.tenue():
                    _supprimer(self.chemin)
                else:
                    logger.warning("[verrou] %s non rendu : reprise cassée par un autre processus", self.chemin)
        except OSError as exc:
            logger.warning("[verrou] %s non rendu : %r", self.chemin, exc)
        finally:
            _liberer_debut(debut)

    async def rendre_async(self) -> None:
        """``rendre`` hors de la boucle (la reprise peut attendre), mené à terme même si l'appelant est annulé."""
        await asyncio.shield(asyncio.get_running_loop().run_in_executor(None, self.rendre))

    def __enter__(self) -> "VerrouFichier":
        self.acquerir()
        return self

    def __exit__(self, *exc: object) -> None:
        self.rendre()

    async def __aenter__(self) -> "VerrouFichier":
        await self.acquerir_async()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.rendre_async()

    def _reste(self, debut: float) -> Optional[float]:
        if self.delai is None:
            return None
        reste = self.delai - (time.monotonic() - debut)
        if reste <= 0:
            raise VerrouOccupe(f"verrou {self.chemin} occupé depuis {self.delai:.1f} s")
        return reste

    def _signaler_attente(self, debut: float) -> bool:
        """Une fois par attente, passé 30 s : journalise qui tient le verrou."""
        if time.monotonic() - debut < ATTENTE_SIGNALEE_S:
            return False
        try:
            etat = _lire(self.chemin)
        except OSError:
            etat = None
        c = (etat.contenu if etat is not None else None) or {}
        logger.warning("[verrou] %s attendu depuis %.0f s : tenu par %s (pid %s, %s)", self.chemin,
                       time.monotonic() - debut, c.get("proc", "?"), c.get("pid", "?"), c.get("hote", "?"))
        return True

    async def _essayer_async(self) -> bool:
        tache = asyncio.get_running_loop().run_in_executor(None, self.essayer)
        try:
            return await asyncio.shield(tache)
        except asyncio.CancelledError:
            tache.add_done_callback(self._rendre_si_pris)
            raise

    def _rendre_si_pris(self, tache: "asyncio.Future[bool]") -> None:
        if tache.cancelled() or tache.exception() is not None or not tache.result():
            return
        try:
            tache.get_loop().run_in_executor(None, self.rendre)
        except RuntimeError:
            self.rendre()

    def _prendre(self) -> bool:
        debut = _reserver_debut()
        pid = os.getpid()
        ligne = _ligne(pid, debut, self.processus or nom_processus(), self.peremption)
        try:
            pris = _creer(self.chemin, ligne)
        except BaseException:
            _liberer_debut(debut)
            raise
        if not pris:
            _liberer_debut(debut)
            return False
        self._tenu = (pid, debut, ligne)
        if self.battement:
            try:
                arret = threading.Event()
                threading.Thread(target=_battre, args=(self.chemin, max(0.05, self.peremption / 3), arret, ligne),
                                 daemon=True, name=f"verrou-{self.chemin.name}").start()
                self._arreter = weakref.finalize(self, arret.set)
            except BaseException:
                self.rendre()
                raise
        return True

    def _reprendre(self, etat: _Etat, raison: str) -> None:
        with _Reprise(self.chemin, self.processus) as reprise:
            relu = _lire(self.chemin)
            if relu is None or not _meme_fichier(relu, etat) or not reprise.tenue():
                return
            _supprimer(self.chemin)
        niveau = logging.DEBUG if etat.contenu is None else logging.INFO
        logger.log(niveau, "[verrou] %s périmé repris : %s", self.chemin, raison)

    def _avertir_repris(self) -> None:
        logger.warning("[verrou] %s repris par un autre processus avant d'être rendu "
                       "(tenu au-delà de sa péremption ?)", self.chemin)


__all__ = [
    "ATTENTE_MAX_S", "ATTENTE_MIN_S", "ILLISIBLE_S", "PEREMPTION_DEFAUT_S", "REPRISE_PEREMPTION_S",
    "SUFFIXE_PERIME", "SUFFIXE_REPRISE", "VERSION", "VerrouFichier", "VerrouOccupe", "chemin_verrou",
    "definir_processus", "identite_machine", "nom_processus", "pid_vivant",
]
