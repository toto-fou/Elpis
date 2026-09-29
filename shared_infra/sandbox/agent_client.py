# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/agent_client.py — côté hôte de l'agent de la sandbox
(L4, 2026-09-29).

L'agent (``shared_infra/sandbox/agent/server.py``) tourne DANS le conteneur ;
l'hôte le joint en HTTP sur ``<P>/.elpis-agent/agent.sock``, dossier du compte
monté sur ``/run/elpis``. Le conteneur écrit dans ce dossier : le socket est
saisi sans suivre de lien (``O_PATH | O_NOFOLLOW``), vérifié (``S_ISSOCK``) et
joint par ``/proc/self/fd/N``. Un lien posé là par la sandbox ne détourne donc
pas l'hôte vers un autre socket ; un faux agent, lui, ne ment que sur le
contenu de la sandbox, que ses processus modifient déjà. Toute réponse est
tenue pour non fiable : tailles bornées (le worker sert tous les comptes),
jamais un chemin de l'hôte tiré d'une réponse.

Démarrage à la demande, un seul à la fois : socket absent ou muet → conteneur
démarré au besoin, puis agent lancé par ``UserSandbox.start_agent`` (agent
figé : remplacé). Un démarrage raté est mémorisé 30 s. Un agent d'une autre
version (empreinte de ``server.py``) est arrêté et relancé, une fois par
client : après une mise à jour du code, l'agent en marche date d'avant.

Un client httpx par opération (0,02 ms avec un contexte TLS partagé) : rien
de lié à une boucle d'événements n'est gardé hors du verrou de démarrage,
créé par boucle.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import ssl
import stat
import time
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, AsyncIterator, Dict, Iterable, List, Optional, Tuple, Union

import httpx

from shared_infra.sandbox.agent import server as _serveur

logger = logging.getLogger("uvicorn.error")

AGENT_DIR = Path(_serveur.__file__).resolve().parent
AGENT_MOUNT = "/opt/elpis/agent"                # AGENT_DIR, monté en lecture seule
AGENT_RUN_DIR = ".elpis-agent"                  # <P>/.elpis-agent monté sur /run/elpis
AGENT_SOCKET = "/run/elpis/agent.sock"

_VERSION_ATTENDUE = _serveur.VERSION            # empreinte de server.py, à l'import
_TLS = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)  # jamais servi (http://)
_DEMARRAGE_S = 10.0
_ECHEC_S = 30.0                                 # démarrage raté : mémorisé
_SONDE_S = 2.0                                  # hello, lecture comprise
_PETIT = 1 << 16                                # hello, write, fsop, erreurs
_DELAI_TOTAL_S = 600.0                          # une opération, flux compris
_LIGNE_MAX = 1 << 15                            # une ligne NDJSON
_EN_TETES = {"Accept-Encoding": "identity"}     # aucun corps compressé à décoder


class AgentError(Exception):
    """Refus ou panne : ``code`` stable (``not_found``, ``changed``,
    ``too_large``, ``agent_unavailable``…), statut HTTP (0 = transport),
    données du refus (``sha256`` courant, ``stat``…)."""

    def __init__(self, code: str, message: str = "", status: int = 0,
                 data: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(f"{code}: {message}" if message else code)
        self.code, self.message, self.status, self.data = code, message, status, data or {}


class _Absent(Exception):
    """Pas de socket d'agent à cet endroit."""


@dataclass
class AgentRead:
    data: bytes
    stat: Dict[str, Any]


@dataclass
class AgentListing:
    entries: List[Dict[str, Any]]
    truncated: bool
    errors: int


class AgentClient:
    """L'agent d'UNE sandbox. ``sandbox`` : ``sandbox_path`` (``P/work``),
    ``ensure_running()``, ``start_agent(replace=…)`` — ``UserSandbox``."""

    def __init__(self, sandbox: Any) -> None:
        self._sb = sandbox
        self.socket_path = Path(sandbox.sandbox_path).parent / AGENT_RUN_DIR / "agent.sock"
        self._version_ok = False
        self._relance = False
        self._echec_jusqua = 0.0
        self._verrous: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = \
            weakref.WeakKeyDictionary()

    # ── opérations ─────────────────────────────────────────────────────────
    async def hello(self) -> Dict[str, Any]:
        return await self._json("GET", "/v1/hello", maxi=_PETIT)

    async def stat(self, paths: Iterable[str], *, hash: bool = False,
                   hash_max: int = 64 << 20) -> List[Dict[str, Any]]:
        chemins = list(paths)
        # L'agent renvoie chaque chemin tel quel (échappé : ≤ 6 octets par
        # caractère) avec ~300 octets d'attributs.
        maxi = _PETIT + sum(6 * len(c) + 512 for c in chemins)
        d = await self._json("POST", "/v1/stat", maxi=maxi, json={
            "paths": chemins, "hash": hash, "hash_max": hash_max})
        return list(d.get("entries") or [])

    async def read(self, path: str, *, offset: int = 0, length: Optional[int] = None,
                   max_bytes: int = 64 << 20, expect_size: Optional[int] = None,
                   expect_mtime_ns: Optional[int] = None) -> AgentRead:
        params: Dict[str, Any] = {"path": _chemin(path), "offset": offset, "max": max_bytes}
        for cle, val in (("length", length), ("expect_size", expect_size),
                         ("expect_mtime_ns", expect_mtime_ns)):
            if val is not None:
                params[cle] = val
        async with self._flux("GET", "/v1/read", params=params) as r:
            data = await _borne(r, max_bytes)
            try:
                infos = json.loads(r.headers.get("x-elpis-stat") or "{}")
            except (ValueError, RecursionError):
                infos = {}
            return AgentRead(data, infos if isinstance(infos, dict) else {})

    async def list(self, path: str = "", *, depth: int = 1, max_entries: int = 20000,
                   hidden: bool = True, prune: Iterable[str] = (), exclude: Iterable[str] = (),
                   deadline_s: float = 30.0) -> AgentListing:
        entries: List[Dict[str, Any]] = []
        async with self._flux("POST", "/v1/list", json={
                "path": path, "depth": depth, "max_entries": max_entries, "hidden": hidden,
                "prune": list(prune), "exclude": list(exclude), "deadline_s": deadline_s}) as r:
            async for obj in _lignes(r, (1 << 20) + max_entries * 1024):
                if "error" in obj:
                    raise AgentError(str(obj["error"]), str(obj.get("message") or ""))
                if obj.get("done"):
                    return AgentListing(entries, bool(obj.get("truncated")),
                                        int(obj.get("errors") or 0))
                if len(entries) >= max_entries:
                    raise AgentError("bad_response", "plus d'entrées que demandé")
                if not _rel_sous(obj.get("path"), path):
                    raise AgentError("bad_response", "chemin hors de la liste demandée")
                entries.append(obj)
        raise AgentError("bad_response", "liste interrompue")

    async def grep(self, paths: Iterable[str], needle: str, *, ignore_case: bool = True,
                   max_file_bytes: int = 20 << 20, max_hits: int = 2000,
                   files_only: bool = False) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """(lignes trouvées, bilan : ``hits_truncated``, ``skipped_large``,
        ``skipped_binary``) dans les fichiers ``paths`` ; ``files_only`` : un
        ``{"file"}`` par fichier trouvé."""
        chemins = list(paths)
        demandes = set(chemins)
        trouves: List[Dict[str, Any]] = []
        async with self._flux("POST", "/v1/grep", json={
                "paths": chemins, "needle": needle, "ignore_case": ignore_case,
                "max_file_bytes": max_file_bytes, "max_hits": max_hits,
                "files_only": files_only}) as r:
            async for obj in _lignes(r, (1 << 20) + max_hits * 2048):
                if "error" in obj:
                    raise AgentError(str(obj["error"]), str(obj.get("message") or ""))
                if obj.get("done"):
                    return trouves, obj
                if "file" in obj:
                    if len(trouves) >= max_hits:
                        raise AgentError("bad_response", "plus de lignes que demandé")
                    if obj["file"] not in demandes:
                        raise AgentError("bad_response", "fichier non demandé")
                    trouves.append(obj)
        raise AgentError("bad_response", "recherche interrompue")

    async def read_many(self, paths: Iterable[str], *, max_file: int = 1 << 20,
                        max_total: int = 32 << 20) -> Dict[str, Optional[bytes]]:
        """{chemin: octets, ou ``None`` : absent, spécial, trop gros} des
        premiers fichiers de ``paths``, en un appel ; l'agent s'arrête avant de
        dépasser ``max_total`` (les chemins absents du résultat sont à
        redemander)."""
        chemins = [_chemin(p) for p in paths]
        demandes = set(chemins)
        rendu: Dict[str, Optional[bytes]] = {}
        maxi = (1 << 20) + len(chemins) * 1024 + max_total * 4 // 3
        async with self._flux("POST", "/v1/readmany", json={
                "paths": chemins, "max_file": max_file, "max_total": max_total}) as r:
            async for obj in _lignes(r, maxi, _LIGNE_MAX + max_file * 4 // 3):
                if "error" in obj:
                    raise AgentError(str(obj["error"]), str(obj.get("message") or ""))
                if obj.get("done"):
                    return rendu
                if obj.get("started"):
                    continue
                p = obj.get("path")
                if p not in demandes or p in rendu:
                    raise AgentError("bad_response", "fichier non demandé")
                b64 = obj.get("b64")
                if not isinstance(b64, str):
                    rendu[p] = None
                    continue
                try:
                    data = base64.b64decode(b64, validate=True)
                except ValueError:
                    raise AgentError("bad_response", "base64 invalide") from None
                if len(data) > max_file:
                    raise AgentError("bad_response", "fichier plus gros que demandé")
                rendu[p] = data
        raise AgentError("bad_response", "lecture interrompue")

    async def write(self, path: str, data: Union[bytes, IO[bytes]], *,
                    mode: Optional[str] = None, parents: bool = False,
                    if_absent: bool = False, if_sha256: Optional[str] = None,
                    if_mtime_ns: Optional[int] = None) -> Dict[str, Any]:
        """Écriture atomique ; préconditions vérifiées par l'agent au moment du
        remplacement : ``AgentError`` ``changed`` / ``exists`` (412).
        ``data`` : octets, ou fichier ouvert envoyé par blocs depuis sa
        position (jamais chargé en entier)."""
        corps: Any
        if isinstance(data, (bytes, bytearray, memoryview)):
            corps = bytes(data)
            taille = len(corps)
        else:
            debut = data.tell()
            taille = data.seek(0, os.SEEK_END) - debut
            data.seek(debut)
            corps = _par_blocs(data, taille)
        params: Dict[str, Any] = {"path": _chemin(path), "max": taille}
        if mode is not None:
            params["mode"] = mode
        if parents:
            params["parents"] = 1
        if if_absent:
            params["if_absent"] = 1
        if if_sha256:
            params["if_sha256"] = if_sha256
        if if_mtime_ns is not None:
            params["if_mtime_ns"] = if_mtime_ns
        return await self._json("PUT", "/v1/write", maxi=_PETIT, params=params, content=corps,
                                headers={"Content-Length": str(taille)})

    async def changes_begin(self, skip: Iterable[str], *, max_entries: int = 20000,
                            deadline_s: float = 1.5) -> Dict[str, Any]:
        """Relevé avant une commande : ``{"id", "complete", "files"}``."""
        return await self._json("POST", "/v1/changes/begin", maxi=_PETIT, json={
            "skip": list(skip), "max_entries": max_entries, "deadline_s": deadline_s})

    async def changes_end(self, ident: str, *, max_files: int = 200,
                          max_bytes: int = 32 << 20, max_file: int = 5 << 20
                          ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """(fichiers changés depuis ``changes_begin``, bilan ``total`` /
        ``complete``) ; contenus ``{"b64"}``, sinon ``{"state"}``."""
        vus: List[Dict[str, Any]] = []
        maxi = (1 << 20) + max_files * 2048 + max_bytes * 4 // 3
        ligne = _LIGNE_MAX + 2 * (max_file * 4 // 3 + 4)
        async with self._flux("POST", "/v1/changes/end", json={
                "id": ident, "max_files": max_files, "max_bytes": max_bytes,
                "max_file": max_file}) as r:
            async for obj in _lignes(r, maxi, ligne):
                if "error" in obj:
                    raise AgentError(str(obj["error"]), str(obj.get("message") or ""))
                if obj.get("done"):
                    return vus, obj
                if len(vus) >= max_files:
                    raise AgentError("bad_response", "plus de fichiers que demandé")
                if not _rel_sous(obj.get("path"), ""):
                    raise AgentError("bad_response", "chemin de relevé invalide")
                vus.append(obj)
        raise AgentError("bad_response", "relevé interrompu")

    async def fsop(self, op: str, **args: Any) -> Dict[str, Any]:
        """``mkdir``, ``remove``, ``rename``, ``copy``, ``chmod``."""
        return await self._json("POST", "/v1/fsop", maxi=_PETIT, json={"op": op, **args})

    # ── transport ──────────────────────────────────────────────────────────
    async def _json(self, methode: str, route: str, *, maxi: int, **kw: Any) -> Dict[str, Any]:
        async with self._flux(methode, route, **kw) as r:
            brut = await _borne(r, maxi)
        d = _objet(brut)
        if d is None:
            raise AgentError("bad_response", "objet JSON attendu")
        return d

    @contextlib.asynccontextmanager
    async def _flux(self, methode: str, route: str, **kw: Any) -> AsyncIterator[httpx.Response]:
        """Réponse (≥ 400 : ``AgentError``) d'un agent démarré au besoin et
        de la bonne version. Un échec de CONNEXION (requête pas envoyée) est
        réessayé après démarrage ; rien d'autre."""
        if not self._version_ok and route != "/v1/hello":
            await self._verifier_version()
        en_tetes = dict(_EN_TETES, **kw.pop("headers", {}))
        if "json" in kw:                                 # échappé : un nom non UTF-8 part
            kw["content"] = json.dumps(kw.pop("json"), separators=(",", ":")).encode()
            en_tetes["Content-Type"] = "application/json"   # (et l'agent le refuse)
        # Borne TOTALE de l'opération, lecture du flux comprise (un agent qui
        # répond au compte-gouttes ne retient pas le thread de l'outil).
        try:
            async with asyncio.timeout(_DELAI_TOTAL_S):
                for essai in (1, 2):
                    rendu = False
                    try:
                        async with self._connexion() as c, \
                                c.stream(methode, route, headers=en_tetes, **kw) as r:
                            if r.status_code >= 400:
                                await _refus(r)
                            rendu = True
                            yield r
                        return
                    except _Absent:
                        if essai == 2:
                            raise AgentError("agent_unavailable", "aucun agent à joindre") from None
                        await self._demarrer()
                    except httpx.TransportError as e:            # corps incomplet compris
                        if isinstance(e, httpx.TimeoutException):
                            self._version_ok = False             # re-sonder au prochain appel
                            raise AgentError("timeout", f"agent muet : {type(e).__name__}") from None
                        if isinstance(e, httpx.ConnectError) and not rendu and essai == 1:
                            await self._demarrer()
                            continue
                        raise AgentError("transport", f"{type(e).__name__}: {e}") from None
        except TimeoutError:
            self._version_ok = False
            raise AgentError("timeout", f"opération de plus de {_DELAI_TOTAL_S:.0f} s") from None

    @contextlib.asynccontextmanager
    async def _connexion(self) -> AsyncIterator[httpx.AsyncClient]:
        try:
            fd = os.open(self.socket_path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            raise _Absent() from None
        try:
            if not stat.S_ISSOCK(os.fstat(fd).st_mode):
                raise _Absent()                          # lien, fichier… : pas l'agent
            transport = httpx.AsyncHTTPTransport(uds=f"/proc/self/fd/{fd}", verify=_TLS)
            async with httpx.AsyncClient(transport=transport, base_url="http://agent",
                                         timeout=httpx.Timeout(60, connect=5)) as c:
                yield c
        finally:
            os.close(fd)

    async def _sonder(self) -> Tuple[Optional[Dict[str, Any]], bool]:
        """(``hello``, figé) sans démarrage : ``(None, False)`` si personne
        n'écoute, ``(None, True)`` si un processus écoute sans répondre."""
        async def appel() -> Optional[Dict[str, Any]]:
            async with self._connexion() as c, \
                    c.stream("GET", "/v1/hello", headers=_EN_TETES) as r:
                if r.status_code != 200:
                    return None
                return _objet(await _borne(r, _PETIT))
        try:
            return await asyncio.wait_for(appel(), _SONDE_S), False
        except (_Absent, httpx.ConnectError):
            return None, False
        except (asyncio.TimeoutError, httpx.HTTPError, AgentError):
            return None, True

    def _verrou(self) -> asyncio.Lock:
        boucle = asyncio.get_running_loop()
        v = self._verrous.get(boucle)
        if v is None:
            v = self._verrous[boucle] = asyncio.Lock()
        return v

    async def _demarrer(self) -> Dict[str, Any]:
        async with self._verrou():
            d, fige = await self._sonder()               # un autre l'a peut-être fait
            if d is not None:
                return d
            if time.monotonic() < self._echec_jusqua:
                raise AgentError("agent_unavailable", "démarrage échoué il y a peu")
            try:
                st = await self._sb.ensure_running()
            except Exception as e:                       # noqa: BLE001 — image absente, Docker arrêté…
                raise AgentError("container_down", str(e)[:300]) from e
            if not getattr(st, "running", False):
                raise AgentError("container_down", "le conteneur de la sandbox ne tourne pas")
            await self._sb.start_agent(replace=fige)
            echeance = time.monotonic() + _DEMARRAGE_S
            while True:
                d, _fige = await self._sonder()
                if d is not None:
                    return d
                if time.monotonic() > echeance:
                    self._echec_jusqua = time.monotonic() + _ECHEC_S
                    raise AgentError("agent_unavailable",
                                     "l'agent n'a pas démarré (python3 absent de l'image ?)")
                await asyncio.sleep(0.05)

    async def _verifier_version(self) -> None:
        d = (await self._sonder())[0] or await self._demarrer()
        async with self._verrou():
            if self._version_ok:                         # vérifiée entre-temps
                return
            if d.get("version") != _VERSION_ATTENDUE and not self._relance:
                self._relance = True                     # une fois : pas de boucle
                logger.info("[agent] %s : version %.32s, attendue %s → relance",
                            self.socket_path, d.get("version"), _VERSION_ATTENDUE)
                with contextlib.suppress(_Absent, httpx.HTTPError):
                    async with self._connexion() as c:
                        # Refusé si un autre processus l'a déjà remplacé.
                        await c.post("/v1/shutdown", json={"if_version": d.get("version")},
                                     timeout=_SONDE_S)
                for _ in range(100):                     # ≤ 5 s : l'ancien lâche son socket
                    if (await self._sonder())[0] is None:
                        break
                    await asyncio.sleep(0.05)
        if not self._version_ok:
            d = (await self._sonder())[0] or await self._demarrer()
            if d.get("version") != _VERSION_ATTENDUE:
                logger.warning("[agent] %s : version %.32s, attendue %s (code mis à jour "
                               "sans redémarrage de l'app ?)", self.socket_path,
                               d.get("version"), _VERSION_ATTENDUE)
            self._version_ok = True


def _chemin(p: str) -> str:
    """Un chemin passé dans l'URL : de l'UTF-8 (l'agent refuse le reste)."""
    try:
        p.encode("utf-8")
    except UnicodeEncodeError:
        raise AgentError("bad_path", "chemin non UTF-8") from None
    return p


def _rel_sous(p: Any, base: str) -> bool:
    """``p`` (chemin rendu par l'agent) : relatif, normalisé, sous ``base``."""
    if not isinstance(p, str) or not p or "\x00" in p or p.startswith("/"):
        return False
    if any(c in ("", ".", "..") for c in p.split("/")):
        return False
    return not base or p.startswith(base.rstrip("/") + "/")


def _objet(brut: bytes) -> Optional[Dict[str, Any]]:
    try:
        d = json.loads(brut)
    except (ValueError, RecursionError):
        return None
    return d if isinstance(d, dict) else None


async def _par_blocs(f: IO[bytes], taille: int, bloc: int = 1 << 20) -> AsyncIterator[bytes]:
    """``taille`` octets de ``f`` par blocs : corps de requête en flux (sa
    longueur est annoncée par ``Content-Length``)."""
    reste = taille
    while reste > 0:
        b = f.read(min(bloc, reste))
        if not b:
            return
        reste -= len(b)
        yield b


async def _borne(r: httpx.Response, maxi: int) -> bytes:
    """Corps brut entier, jamais plus de ``maxi`` octets."""
    morceaux, n = [], 0
    async for b in r.aiter_raw():
        n += len(b)
        if n > maxi:
            raise AgentError("too_large", f"réponse de plus de {maxi} octets")
        morceaux.append(b)
    return b"".join(morceaux)


async def _lignes(r: httpx.Response, maxi: int,
                  ligne_max: int = _LIGNE_MAX) -> AsyncIterator[Dict[str, Any]]:
    """Objets d'un flux NDJSON : lignes et total bornés, signes de vie
    (``{"tick"}``) ignorés ; chaque octet n'est parcouru qu'une fois."""
    tampon, total = bytearray(), 0
    async for b in r.aiter_raw():
        total += len(b)
        if total > maxi:
            raise AgentError("too_large", f"réponse de plus de {maxi} octets")
        depuis = len(tampon)
        tampon += b
        debut = 0
        i = tampon.find(b"\n", depuis)
        while i >= 0:
            if i - debut > ligne_max:
                raise AgentError("bad_response", "ligne NDJSON trop longue")
            ligne = bytes(tampon[debut:i])
            debut = i + 1
            if ligne.strip():
                obj = _objet(ligne)
                if obj is None:
                    raise AgentError("bad_response", "ligne NDJSON invalide")
                if "tick" not in obj:
                    yield obj
            i = tampon.find(b"\n", debut)
        if debut:
            del tampon[:debut]
        if len(tampon) > ligne_max:
            raise AgentError("bad_response", "ligne NDJSON trop longue")


async def _refus(r: httpx.Response) -> None:
    brut = b""
    with contextlib.suppress(AgentError):
        brut = await _borne(r, _PETIT)
    d = _objet(brut) or {}
    raise AgentError(str(d.get("error") or f"http_{r.status_code}")[:64],
                     str(d.get("message") or "")[:500], r.status_code, d)


__all__ = ["AGENT_DIR", "AGENT_MOUNT", "AGENT_RUN_DIR", "AGENT_SOCKET", "AgentClient",
           "AgentError", "AgentListing", "AgentRead"]
