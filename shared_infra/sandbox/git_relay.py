# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/git_relay.py — relais Git authentifiant (L4.4, D5).

git tourne dans la sandbox. Pour une opération réseau lancée par Elpis (outil
de l'assistant, bouton de l'éditeur), l'hôte délivre un ticket : compte,
amont (schéma, hôte, dépôt), service Git, refs permises au push, échéance.
L'agent relaie le trafic de CETTE commande jusqu'ici (``_Relais`` de
``agent/server.py``) ; le relais n'accepte que le protocole Git « smart
HTTP » de ce dépôt, ajoute l'authentification du connecteur et parle à
l'amont. L'identifiant n'entre jamais dans la sandbox ; le terminal n'a pas
accès au relais (pas de ticket).

Un socket par processus de l'app (``<SANDBOX_DIR>/.elpis-relay/<pid>.sock``,
dossier monté en lecture seule sur ``/run/elpis-relay``), démarré au premier
ticket. Le ticket est un jeton aléatoire gardé en mémoire par le processus
qui le délivre et le vérifie, révoqué à la fin de l'opération. Tout ce qui
vient du conteneur est tenu pour non fiable : chemin et service comparés au
ticket, en-têtes filtrés, commandes du push lues avant d'être relayées.
"""
from __future__ import annotations

import base64
import contextlib
import functools
import logging
import os
import re
import secrets
import socketserver
import ssl
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Callable, Dict, FrozenSet, Iterable, Iterator, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("uvicorn.error")

UPLOAD, RECEIVE = "git-upload-pack", "git-receive-pack"
_PREAMBULE = re.compile(rb"ELPIS-RELAY/1 ([A-Za-z0-9_-]{20,128})\r\n")
_COMMANDES_MAX = 1 << 20              # début d'un push lu avant relais (commandes)
_CONNEXIONS_MAX = 8                   # requêtes servies en même temps, par ticket
_ENTETES_REQUETE = frozenset({"accept", "accept-encoding", "accept-language", "content-type",
                              "content-encoding", "git-protocol", "user-agent", "pragma"})
_ENTETES_REPONSE = frozenset({"content-type", "content-encoding", "content-length",
                              "cache-control", "expires", "pragma", "location",
                              "www-authenticate"})
_SEGMENT_INTERDIT = re.compile(r"(^|/)(\.|\.\.|%2e|%2e%2e|\.%2e|%2e\.)(/|$)", re.IGNORECASE)


class RelayRefused(Exception):
    """Opération réseau refusée avant tout transfert (URL, schéma, dépôt)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


@dataclass
class _Ticket:
    uid: int
    amont: str                        # « https://hote[:port] »
    depot: str                        # « /org/depot », sans « .git » ni « / » final
    service: str                      # UPLOAD ou RECEIVE
    refs: FrozenSet[str]              # refs permises au push
    auth: str                         # valeur d'Authorization, ou ""
    garde: Callable[[], Optional[str]]  # garde anti-SSRF, refaite à chaque requête
    echeance: float
    refus: List[str] = field(default_factory=list)
    actives: int = 0


class _Registre:
    def __init__(self) -> None:
        self._verrou = threading.Lock()
        self._tickets: Dict[str, _Ticket] = {}

    def ajouter(self, t: _Ticket) -> str:
        jeton = secrets.token_urlsafe(32)
        with self._verrou:
            maintenant = time.monotonic()
            for k in [k for k, v in self._tickets.items() if v.echeance < maintenant]:
                del self._tickets[k]
            self._tickets[jeton] = t
        return jeton

    def retirer(self, jeton: str) -> None:
        with self._verrou:
            self._tickets.pop(jeton, None)

    def entrer(self, jeton: str) -> Optional[_Ticket]:
        """Le ticket valide de ``jeton``, une requête de plus comptée ; ``None``
        s'il est inconnu, échu, ou à sa limite de requêtes simultanées."""
        with self._verrou:
            t = self._tickets.get(jeton)
            if t is None or t.echeance < time.monotonic() or t.actives >= _CONNEXIONS_MAX:
                return None
            t.actives += 1
            return t

    def sortir(self, t: _Ticket) -> None:
        with self._verrou:
            t.actives -= 1


_registre = _Registre()


@functools.lru_cache(maxsize=1)
def _tls() -> ssl.SSLContext:
    """Magasin du système (PKI interne), plus la CA donnée à git sur l'hôte."""
    ctx = ssl.create_default_context()
    if os.environ.get("GIT_SSL_CAINFO"):
        ctx.load_verify_locations(cafile=os.environ["GIT_SSL_CAINFO"])
    if os.environ.get("GIT_SSL_CAPATH"):
        ctx.load_verify_locations(capath=os.environ["GIT_SSL_CAPATH"])
    return ctx


def _sous(chemin: str, depot: str, suite: str) -> bool:
    return chemin in (depot + suite, depot + ".git" + suite)


class _Refus(Exception):
    def __init__(self, statut: int, message: str) -> None:
        super().__init__(message)
        self.statut, self.message = statut, message


def _commandes_push(corps: Iterator[bytes], permises: FrozenSet[str]) -> Iterator[bytes]:
    """Le corps d'un ``git-receive-pack``, relu jusqu'à la fin de la liste
    des commandes : chaque ref mise à jour doit être permise par le ticket,
    aucune n'est supprimée. Rendu tel quel ensuite."""
    tampon = bytearray()

    def exiger(n: int) -> None:
        while len(tampon) < n:
            b = next(corps, None)
            if b is None:
                raise _Refus(400, "Relais Git : corps de push tronqué")
            tampon.extend(b)

    pos = 0
    while True:
        exiger(pos + 4)
        try:
            n = int(bytes(tampon[pos:pos + 4]), 16)
        except ValueError:
            raise _Refus(400, "Relais Git : push mal formé") from None
        if n == 0:
            break
        if n < 5 or pos + n > _COMMANDES_MAX:
            raise _Refus(400, "Relais Git : push mal formé")
        exiger(pos + n)
        ligne = bytes(tampon[pos + 4:pos + n]).split(b"\0", 1)[0].rstrip(b"\n")
        pos += n
        if ligne.startswith(b"shallow "):
            continue
        parts = ligne.split(b" ")
        if len(parts) != 3:
            raise _Refus(400, "Relais Git : push signé ou mal formé, non relayé")
        ref = parts[2].decode("utf-8", "replace")
        if not parts[1].strip(b"0"):
            raise _Refus(403, f"Relais Git : suppression de {ref} refusée")
        if ref not in permises:
            raise _Refus(403, f"Relais Git : push vers {ref} hors de l'opération autorisée")
    yield bytes(tampon)
    yield from corps


class _Gestionnaire(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 60                                        # lecture de la requête
    server: "_Serveur"
    ticket: Optional[_Ticket] = None

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def handle(self) -> None:
        m = _PREAMBULE.fullmatch(self.rfile.readline(256))
        self.ticket = _registre.entrer(m.group(1).decode("ascii")) if m else None
        if self.ticket is None:
            return                                      # fermé sans réponse
        try:
            self.close_connection = True
            self.handle_one_request()
        finally:
            _registre.sortir(self.ticket)

    def do_GET(self) -> None:
        self._relayer()

    def do_POST(self) -> None:
        self._relayer()

    def _relayer(self) -> None:
        t = self.ticket
        assert t is not None
        chemin, _, requete = self.path.partition("?")
        if self.command == "GET":
            permis = requete == f"service={t.service}" and _sous(chemin, t.depot, "/info/refs")
        else:
            permis = not requete and _sous(chemin, t.depot, "/" + t.service)
        try:
            if not permis:
                raise _Refus(403, "Relais Git : requête hors de l'opération autorisée")
            motif = t.garde()
            if motif:
                raise _Refus(403, f"Relais Git : dépôt refusé ({motif})")
            corps: Optional[Iterator[bytes]] = None
            entetes = {k: v for k, v in self.headers.items() if k.lower() in _ENTETES_REQUETE}
            if self.command == "POST":
                corps, longueur = self._corps()
                if longueur is not None:
                    entetes["Content-Length"] = str(longueur)
                if t.service == RECEIVE:
                    if self.headers.get("Content-Encoding", "identity") != "identity":
                        raise _Refus(415, "Relais Git : push compressé non relayé")
                    corps = _commandes_push(corps, t.refs)
                    corps = _amorce(corps)              # refus levé ici, avant l'amont
            if t.auth:
                entetes["Authorization"] = t.auth
            self._amont(t, entetes, corps)
        except _Refus as r:
            t.refus.append(r.message)
            with contextlib.suppress(OSError):
                self._repondre(r.statut, r.message)
        except OSError:                                 # git parti en cours de route
            pass

    def _corps(self):
        """(itérateur du corps de la requête, longueur annoncée ou ``None``)."""
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            return self._blocs(), None
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0:
            raise _Refus(400, "Relais Git : Content-Length invalide")

        def lire() -> Iterator[bytes]:
            reste = n
            while reste:
                b = self.rfile.read(min(reste, 1 << 16))
                if not b:
                    return
                reste -= len(b)
                yield b
        return lire(), n

    def _blocs(self) -> Iterator[bytes]:
        while True:
            taille = self.rfile.readline(64).split(b";", 1)[0].strip()
            try:
                n = int(taille, 16)
            except ValueError:
                return
            if n == 0:
                while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                    pass
                return
            while n:
                b = self.rfile.read(min(n, 1 << 16))
                if not b:
                    return
                n -= len(b)
                yield b
            self.rfile.readline(4)

    def _amont(self, t: _Ticket, entetes: Dict[str, str], corps: Optional[Iterator[bytes]]) -> None:
        envoye = False
        try:
            with httpx.Client(verify=_tls(), follow_redirects=False,
                              timeout=httpx.Timeout(300, connect=30)) as c:
                req = c.build_request(self.command, t.amont + self.path, headers=entetes,
                                      content=corps)
                r = c.send(req, stream=True)
                try:
                    self.send_response(r.status_code)
                    envoye = True
                    for k, v in r.headers.multi_items():
                        if k.lower() in _ENTETES_REPONSE:
                            self.send_header(k, v)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for b in r.iter_raw():
                        self.wfile.write(b)
                finally:
                    r.close()
        except httpx.HTTPError as e:
            motif = f"Relais Git : amont injoignable ({type(e).__name__})"
            t.refus.append(motif)
            if not envoye:
                self._repondre(502, motif)

    def _repondre(self, statut: int, message: str) -> None:
        corps = (message + "\n").encode("utf-8")
        self.send_response(statut)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(corps)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(corps)


def _amorce(it: Iterator[bytes]) -> Iterator[bytes]:
    """Exécute l'itérateur jusqu'à son premier bloc (ses contrôles lèvent
    ici), puis le rend entier."""
    premier = next(it, None)

    def suite() -> Iterator[bytes]:
        if premier is not None:
            yield premier
        yield from it
    return suite()


class _Serveur(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def handle_error(self, request: object, client_address: object) -> None:
        logger.debug("[git-relay] requête abandonnée", exc_info=True)

    def __init__(self, dossier: Path) -> None:
        self.nom = f"{os.getpid()}.sock"
        self.pid = os.getpid()
        super().__init__(self.nom, _Gestionnaire, bind_and_activate=False)
        # Lié par le dossier ouvert : chemin court quelle que soit sa longueur.
        fd = os.open(dossier, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            court = f"/proc/self/fd/{fd}/{self.nom}"
            with contextlib.suppress(FileNotFoundError):
                os.unlink(court)
            self.socket.bind(court)
            os.chmod(court, 0o666)                      # UID du conteneur
        finally:
            os.close(fd)
        self.server_activate()


_serveurs: Dict[str, _Serveur] = {}
_verrou_serveurs = threading.Lock()


def _nettoyer(dossier: Path) -> None:
    """Sockets laissés par des processus de l'app qui ne tournent plus."""
    for p in dossier.glob("*.sock"):
        try:
            pid = int(p.stem)
            if pid != os.getpid():
                os.kill(pid, 0)
        except ProcessLookupError:
            with contextlib.suppress(OSError):
                p.unlink()
        except (ValueError, PermissionError):
            continue


def serveur(dossier: Path) -> str:
    """Nom du socket du relais de ce processus dans ``dossier`` (démarré au
    besoin)."""
    cle = str(dossier)
    with _verrou_serveurs:
        srv = _serveurs.get(cle)
        if srv is not None and srv.pid == os.getpid():
            return srv.nom
        dossier.mkdir(mode=0o755, exist_ok=True)
        os.chmod(dossier, 0o755)
        _nettoyer(dossier)
        srv = _serveurs[cle] = _Serveur(dossier)
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.5},
                         daemon=True, name="git-relay").start()
        return srv.nom


def amont(url: str) -> tuple:
    """(``schéma://hôte[:port]``, dépôt, origine réécrite par l'agent) d'une
    URL de dépôt, ou ``RelayRefused``."""
    try:
        p = urlsplit((url or "").strip())
        port = p.port
    except ValueError:
        raise RelayRefused("malformed_url", "URL de dépôt mal formée") from None
    if p.scheme not in ("http", "https"):
        raise RelayRefused("scheme_not_relayed",
                           f"Schéma « {p.scheme or '?'} » : seul Git sur HTTP(S) passe par le relais.")
    if p.username or p.password or not p.hostname or p.query or p.fragment:
        raise RelayRefused("malformed_url", "URL de dépôt invalide (identifiants, requête ou hôte)")
    depot = p.path.rstrip("/")
    if depot.endswith(".git"):
        depot = depot[:-4]
    if not depot or _SEGMENT_INTERDIT.search(depot) or any(c in depot for c in "\\\x00\r\n\t "):
        raise RelayRefused("malformed_url", "Chemin de dépôt invalide")
    hote = p.hostname.lower()
    hote = f"[{hote}]" if ":" in hote else hote
    netloc = f"{hote}:{port}" if port else hote
    # Origine telle qu'écrite dans l'URL : ``insteadOf`` compare des préfixes,
    # casse comprise.
    return f"{p.scheme}://{netloc}", depot, f"{p.scheme}://{p.netloc}/"


def basic_auth(username: str, token: str) -> str:
    """``Basic`` de l'identifiant (le jeton s'il est vide) et du jeton, comme
    git le construit à partir d'un identifiant."""
    brut = f"{username or token}:{token}".encode("utf-8")
    return "Basic " + base64.b64encode(brut).decode("ascii")


@contextlib.contextmanager
def ticket(dossier: Path, *, uid: int, url: str, service: str, refs: Iterable[str] = (),
           auth: str = "", garde: Callable[[], Optional[str]] = lambda: None,
           duree_s: float = 600) -> Iterator[Tuple[Dict[str, str], List[str]]]:
    """Ticket d'une opération : (spécification ``relay`` à passer à l'agent
    — ``socket``, ``ticket``, ``origin`` —, motifs des requêtes refusées par
    le relais, pour le message d'erreur)."""
    if service not in (UPLOAD, RECEIVE):
        raise ValueError(service)
    base, depot, origine = amont(url)
    t = _Ticket(uid=uid, amont=base, depot=depot, service=service, refs=frozenset(refs),
                auth=auth, garde=garde, echeance=time.monotonic() + duree_s)
    nom = serveur(dossier)
    jeton = _registre.ajouter(t)
    try:
        yield {"socket": nom, "ticket": jeton, "origin": origine}, t.refus
    finally:
        _registre.retirer(jeton)


__all__ = ["RECEIVE", "UPLOAD", "RelayRefused", "amont", "basic_auth", "serveur", "ticket"]
