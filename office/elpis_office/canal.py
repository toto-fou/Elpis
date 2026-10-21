# SPDX-License-Identifier: MIT
"""office/elpis_office/canal.py — worker des outils Office : appels de l'hôte d'outils (stdin), réponses et rappels vers lui (descripteur 3) pour les fichiers, graphiques et conversions.

stdout et stderr ne portent que du journal : un ``print`` ne peut pas corrompre le canal.

Un cadre est un en-tête JSON (UTF-8) suivi d'un corps binaire facultatif, chacun précédé de sa longueur
sur 4 octets (big-endian). L'hôte envoie ``appel``, ``reponse`` (à un rappel) et ``annuler`` ; le worker
envoie ``pret``, ``rappel`` et ``resultat``. Plusieurs appels courent en parallèle, un rappel porte
l'identifiant de son appel (``id``) et le sien (``rid``).
"""
from __future__ import annotations

import itertools
import json
import logging
import os
import struct
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, BinaryIO, Callable, Dict, List, Optional, Tuple

from . import TOOLS, Env, OfficeError, executer
from .commun import Ecrit

VERSION = 1
MAX_ENTETE = 64 << 20
MAX_CORPS = 2 << 30
CONTENU_VIDE = b""

logger = logging.getLogger("uvicorn.error")
_LONGUEUR = struct.Struct(">I")
FD_PROTOCOLE = 3


class Annule(OfficeError):
    """L'hôte a annulé l'appel (Stop) ou fermé le canal."""

    def __init__(self, message: str = "the call was cancelled") -> None:
        super().__init__(message, fix="read the file again before retrying", code="cancelled")


def _lire_exact(flux: BinaryIO, n: int) -> bytes:
    brut = flux.read(n)
    if len(brut) != n:
        raise EOFError("canal fermé au milieu d'un cadre")
    return brut


def lire_cadre(flux: BinaryIO) -> Optional[Tuple[Dict[str, Any], bytes]]:
    """Le cadre suivant ; ``None`` à la fermeture propre du flux."""
    debut = flux.read(_LONGUEUR.size)
    if not debut:
        return None
    if len(debut) != _LONGUEUR.size:
        raise EOFError("canal fermé au milieu d'un cadre")
    n = _LONGUEUR.unpack(debut)[0]
    if n > MAX_ENTETE:
        raise ValueError(f"en-tête de {n} octets refusé")
    entete = json.loads(_lire_exact(flux, n).decode("utf-8"))
    m = _LONGUEUR.unpack(_lire_exact(flux, _LONGUEUR.size))[0]
    if m > MAX_CORPS:
        raise ValueError(f"corps de {m} octets refusé")
    return entete, (_lire_exact(flux, m) if m else CONTENU_VIDE)


class Sortie:
    """Écriture des cadres, sérialisée entre les threads."""

    def __init__(self, flux: BinaryIO) -> None:
        self._flux = flux
        self._verrou = threading.Lock()

    def envoyer(self, entete: Dict[str, Any], corps: bytes = CONTENU_VIDE) -> None:
        brut = json.dumps(entete, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        with self._verrou:
            self._flux.write(_LONGUEUR.pack(len(brut)) + brut + _LONGUEUR.pack(len(corps)))
            if corps:
                self._flux.write(corps)
            self._flux.flush()


class _Attente:
    def __init__(self) -> None:
        self.evenement = threading.Event()
        self.valeur: Dict[str, Any] = {}
        self.corps = CONTENU_VIDE
        self.erreur: Optional[Dict[str, Any]] = None


def _exception(erreur: Dict[str, Any]) -> Exception:
    """Refus de l'hôte à un rappel → l'exception que le moteur sait présenter."""
    genre = str(erreur.get("genre") or "")
    message = str(erreur.get("message") or "")
    if genre == "introuvable":
        return FileNotFoundError(message)
    if genre == "dossier":
        return IsADirectoryError(message)
    if genre == "valeur":
        return ValueError(message)
    if genre == "office":
        return OfficeError(message, fix=str(erreur.get("fix") or ""), code=str(erreur.get("code") or "invalid_request"),
                           retryable=bool(erreur.get("retryable")))
    if genre == "annule":
        return Annule(message or "appel annulé")
    return RuntimeError(message or "erreur de l'hôte d'outils")


class Canal:
    """Rappels synchrones d'un appel vers l'hôte, réponses reçues par le thread de lecture."""

    def __init__(self, sortie: Sortie) -> None:
        self._sortie = sortie
        self._verrou = threading.Lock()
        self._attentes: Dict[Tuple[int, int], _Attente] = {}
        self._annules: set = set()
        self._rid = itertools.count(1)
        self._ferme = False

    def rappeler(self, aid: int, op: str, args: Dict[str, Any], corps: bytes = CONTENU_VIDE) -> Tuple[Dict[str, Any], bytes]:
        attente = _Attente()
        with self._verrou:
            if self._ferme or aid in self._annules:
                raise Annule("appel annulé")
            rid = next(self._rid)
            self._attentes[(aid, rid)] = attente
        try:
            self._sortie.envoyer({"type": "rappel", "id": aid, "rid": rid, "op": op, "args": args}, corps)
            attente.evenement.wait()
        finally:
            with self._verrou:
                self._attentes.pop((aid, rid), None)
        if attente.erreur is not None:
            raise _exception(attente.erreur)
        return attente.valeur, attente.corps

    def repondre(self, entete: Dict[str, Any], corps: bytes) -> None:
        with self._verrou:
            attente = self._attentes.get((int(entete.get("id", 0)), int(entete.get("rid", 0))))
        if attente is None:
            return
        if entete.get("ok"):
            attente.valeur = entete.get("valeur") or {}
            attente.corps = corps
        else:
            attente.erreur = entete.get("erreur") or {"genre": "interne", "message": "rappel refusé"}
        attente.evenement.set()

    def annuler(self, aid: int) -> None:
        with self._verrou:
            self._annules.add(aid)
            concernees = [a for (i, _), a in self._attentes.items() if i == aid]
        for a in concernees:
            a.erreur = {"genre": "annule", "message": "appel annulé"}
            a.evenement.set()

    def oublier(self, aid: int) -> None:
        with self._verrou:
            self._annules.discard(aid)

    def fermer(self) -> None:
        with self._verrou:
            self._ferme = True
            toutes = list(self._attentes.values())
        for a in toutes:
            a.erreur = {"genre": "annule", "message": "canal fermé"}
            a.evenement.set()


def to_container(rel: str) -> str:
    """Vue conteneur d'un chemin relatif à la sandbox (``src/x`` → ``/work/src/x``)."""
    r = (rel or "").strip().strip("/")
    return "/work" if r in ("", ".") else f"/work/{r}"


class EspaceCanal:
    """``commun.Espace`` d'un appel : fichiers lus et écrits par l'hôte, dans la sandbox du compte."""

    def __init__(self, canal: Canal, aid: int) -> None:
        self._canal = canal
        self._aid = aid

    def afficher(self, rel: str) -> str:
        return to_container(rel)

    def lire(self, rel: str, max_bytes: int) -> bytes:
        return self._canal.rappeler(self._aid, "lire", {"chemin": rel, "max_octets": max_bytes})[1]

    def ecrire(self, rel: str, data: bytes, attendu: Optional[str] = None) -> Ecrit:
        v, _ = self._canal.rappeler(self._aid, "ecrire", {"chemin": rel, "attendu": attendu}, data)
        return Ecrit(path=str(v["path"]), old_sha256=str(v["old_sha256"]), new_sha256=str(v["new_sha256"]),
                     size=int(v["size"]), history_kept=bool(v["history_kept"]))


def _env(canal: Canal, aid: int, contexte: Dict[str, Any]) -> Env:
    def graphique(gid: str) -> Optional[Dict[str, Any]]:
        v, _ = canal.rappeler(aid, "graphique", {"id": gid})
        option = v.get("option")
        return option if isinstance(option, dict) else None

    def convertir(data: bytes, ext: str, fmt: str) -> bytes:
        return canal.rappeler(aid, "convertir", {"ext": ext, "fmt": fmt}, data)[1]

    def svg_png(svgs: List[str]) -> List[bytes]:
        v, corps = canal.rappeler(aid, "svg_png", {"svgs": svgs})
        pngs, debut = [], 0
        for taille in v.get("tailles") or []:
            pngs.append(corps[debut:debut + int(taille)])
            debut += int(taille)
        return pngs

    def echarts_svg(options: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        v, _ = canal.rappeler(aid, "echarts_svg", {"options": options})
        return list(v.get("sorties") or [])

    return Env(
        espace=EspaceCanal(canal, aid),
        graphique=graphique,
        convertir=convertir if contexte.get("convertir") else None,
        svg_png=svg_png if contexte.get("svg_png") else None,
        echarts_svg=echarts_svg if contexte.get("echarts_svg") else None,
        session=contexte.get("session"),
    )


def _traiter(canal: Canal, sortie: Sortie, entete: Dict[str, Any]) -> None:
    aid = int(entete["id"])
    outil = str(entete.get("outil") or "")
    try:
        if outil not in TOOLS:
            valeur: Dict[str, Any] = {"ok": False, "error": "unknown_tool", "message": f"unknown office tool: {outil}"}
        else:
            valeur = executer(outil, dict(entete.get("args") or {}), _env(canal, aid, dict(entete.get("contexte") or {})))
        sortie.envoyer({"type": "resultat", "id": aid, "valeur": valeur})
    except Exception as e:  # noqa: BLE001 — un appel ne doit jamais tuer le worker
        logger.exception("[office] %s : résultat non transmis", outil)
        try:
            sortie.envoyer({"type": "echec", "id": aid, "message": f"{type(e).__name__}: {e}"})
        except OSError:
            pass
    finally:
        canal.oublier(aid)


def servir(entree: BinaryIO, sortie_flux: BinaryIO, paralleles: int = 8, sortir: Callable[[int], Any] = os._exit) -> None:
    """Boucle du worker : annonce, puis cadres de l'hôte jusqu'à la fermeture de l'entrée."""
    sortie = Sortie(sortie_flux)
    canal = Canal(sortie)
    sortie.envoyer({"type": "pret", "version": VERSION, "outils": sorted(TOOLS)})
    code = 0
    with ThreadPoolExecutor(max_workers=max(1, paralleles), thread_name_prefix="office") as pool:
        try:
            while True:
                cadre = lire_cadre(entree)
                if cadre is None:
                    break
                entete, corps = cadre
                genre = entete.get("type")
                if genre == "appel":
                    pool.submit(_traiter, canal, sortie, entete)
                elif genre == "reponse":
                    canal.repondre(entete, corps)
                elif genre == "annuler":
                    canal.annuler(int(entete.get("id", 0)))
                else:
                    logger.warning("[office] cadre inconnu ignoré : %r", genre)
        except (EOFError, ValueError, OSError) as e:
            logger.error("[office] canal rompu : %r", e)
            code = 1
        finally:
            canal.fermer()
    sortir(code)


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        protocole = os.fdopen(FD_PROTOCOLE, "wb")
    except OSError:
        logger.error("[office] descripteur %d absent : le worker se lance par l'hôte d'outils", FD_PROTOCOLE)
        sys.exit(2)
    os.set_inheritable(FD_PROTOCOLE, False)
    try:
        paralleles = int(os.environ.get("ELPIS_OFFICE_PARALLELE", "") or 8)
    except ValueError:
        paralleles = 8
    servir(sys.stdin.buffer, protocole, paralleles)
