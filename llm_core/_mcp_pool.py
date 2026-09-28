# SPDX-License-Identifier: MIT
# backend/mcp_pool.py
"""
Pool de connexions MCP persistantes.

Résout le problème de latence: au lieu de spawner un nouveau subprocess
(ou ouvrir une nouvelle connexion SSE) + handshake + list_tools à chaque
message, les connexions sont maintenues en vie et les définitions d'outils
sont mises en cache avec un TTL configurable.

Usage:
    from shared_infra.mcp_pool import mcp_pool

    # Dans run_chat_multi_mcp:
    client, tools = await mcp_pool.get_or_connect(cfg)
    # client est un MCPStdioWrapper/MCPSSEWrapper déjà initialisé
    # tools est la liste des outils (cachée pendant TOOLS_CACHE_TTL_SEC)

    # Au shutdown de l'app (routes.py ou main.py):
    await mcp_pool.close_all()
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from shared_infra.config import TOOLS_CACHE_TTL_SEC

logger = logging.getLogger("uvicorn.error")

# Sentinelle de commande identifiant le serveur d'OUTILS LOCAUX partagé.
# TOUTES les configs locales la portent : le pré-warm (``name="Outils
# Locaux (admin scan)"``, sans filtre), le chat (``name="Outils Locaux"``
# + ``filter_categories`` choisis par l'user) et les pipelines. Elles
# pointent toutes vers le MÊME backend (service SSE partagé si
# ``LOCAL_MCP_URL`` est défini, sinon un sous-process stdio par worker).
#
# Conséquences pour le pool :
#   • Elles DOIVENT se résoudre à UNE seule entrée (cf. ``_make_key``) :
#     ``filter_categories`` est appliqué CÔTÉ CLIENT (le serveur renvoie
#     toujours l'ensemble complet des outils), donc une entrée par combo
#     de catégories ne ferait qu'ouvrir des connexions redondantes vers le
#     même serveur — et l'éviction d'un combo finissait par écraser le
#     registre de catégories partagé (cf. ``_connect_new``).
#   • L'entrée est PERSISTANTE (cf. ``_periodic_cleanup``) : le service
#     partagé est toujours up, l'auto-destruction par inactivité n'a donc
#     aucun intérêt sur lui et provoquait churn + perte des catégories.
_LOCAL_TOOLS_COMMAND = "DEFAULT_LOCAL_PYTHON"

# Borne du handshake d'une connexion MCP (spawn + initialize + list_tools).
# Sans elle, une connexion vers un serveur qui repart (ou sature) pendait
# jusqu'au timeout d'OUTIL de l'appelant, lequel ANNULE la coroutine — chemin
# sur lequel le nettoyage ne passait pas (cf. _connect_new).
MCP_HANDSHAKE_TIMEOUT_S = float(os.environ.get("MCP_HANDSHAKE_TIMEOUT_S", "30"))


def _is_local_tools_cfg(cfg: Dict[str, Any]) -> bool:
    """True si ``cfg`` cible un service d'outils INTÉGRÉ : le service partagé
    (sentinelle) ou, (2026-09-12, P4), le MCP interne de l'app
    (``type: inprocess``, entrée ``role: app`` du manifeste)."""
    if cfg.get("type", "sse") == "inprocess":
        return True
    return cfg.get("type", "sse") == "stdio" and cfg.get("command", "") == _LOCAL_TOOLS_COMMAND


# ── Reconnexion + rejeu : à quelles erreurs a-t-on le DROIT de retenter ? ────
#
# AUDIT 2026-08-22 (C1) — le ``except Exception`` du chemin d'appel traitait
# TOUTE erreur comme une panne de transport : il fermait l'entrée (partagée par
# tous les utilisateurs de ce worker !), reconnectait, puis RÉ-EXÉCUTAIT
# l'outil. Or la plupart des erreurs qui remontent d'un ``call_tool`` ne sont
# pas des pannes de tuyau mais des réponses JSON-RPC parfaitement livrées :
# une ``McpError`` — celle que lève par exemple le limiteur de débit
# ``ToolRateLimit`` du serveur d'outils locaux, atteignable dès qu'un lot de
# huit outils part en parallèle — arrivait ainsi à détruire la session de tout
# le monde et à rejouer l'outil. Sur un outil MUTANT (shell, écriture, commit)
# ce rejeu applique l'effet DEUX FOIS.
#
# On ne reconnecte donc que sur une vraie rupture de tuyau, et on ne rejoue
# JAMAIS un outil dont on ne sait pas s'il a déjà agi.
_TRANSPORT_ERROR_NAMES = frozenset({
    "ClosedResourceError", "BrokenResourceError", "EndOfStream",
    "ConnectionError", "ConnectionResetError", "ConnectionAbortedError",
    "BrokenPipeError", "EOFError", "IncompleteRead",
    "ReadError", "WriteError", "RemoteProtocolError", "LocalProtocolError",
    "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout",
    "ConnectError", "TransportError", "NetworkError",
    "ServerDisconnectedError", "ClientConnectorError",
    "TimeoutError",
})


def _mcp_error_code_msg(exc: BaseException):
    """(code, message) d'une ``McpError`` du SDK, sinon (None, "")."""
    if type(exc).__name__ != "McpError":
        return None, ""
    _err = getattr(exc, "error", None)
    return getattr(_err, "code", None), str(getattr(_err, "message", "") or exc)


def _is_session_gone(exc: BaseException) -> bool:
    """Le serveur ne connaît plus notre session (streamable HTTP : 404 sur
    l'identifiant de session → le SDK rend ``McpError(32600, "Session
    terminated")``). La requête n'a PAS été exécutée : la rejouer sur une
    session neuve est sûr, même pour un outil mutant."""
    code, msg = _mcp_error_code_msg(exc)
    return code == 32600 and "session terminated" in msg.lower()


def _is_transport_error(exc: BaseException) -> bool:
    """L'erreur vient-elle du TUYAU (et non d'une réponse du serveur) ?

    On raisonne sur les NOMS de classes plutôt que sur des imports : les
    transports en jeu (anyio, httpx, httpcore, mcp) ne sont pas tous
    disponibles selon la configuration, et un import optionnel qui échoue
    ferait silencieusement retomber tout le monde dans le cas « transport ».
    Les ``ExceptionGroup`` d'anyio sont dépliés — c'est sous cette forme que
    les erreurs de transport MCP remontent la plupart du temps.

    AUDIT 2026-09-25 — deux ``McpError`` sont des pannes de TUYAU, pas des
    réponses du serveur : « Connection closed » (``CONNECTION_CLOSED``,
    -32000 : flux fermé en plein appel) et « Session terminated » (session
    inconnue du serveur, typiquement après son redémarrage). Classées
    « serveur », elles laissaient l'entrée PARTAGÉE marquée saine : tous les
    outils intégrés échouaient pour tous les utilisateurs du worker jusqu'au
    rafraîchissement TTL (6 min).
    """
    seen = 0
    stack = [exc]
    while stack and seen < 64:
        cur = stack.pop()
        seen += 1
        if cur is None:
            continue
        if type(cur).__name__ in _TRANSPORT_ERROR_NAMES:
            return True
        _code, _msg = _mcp_error_code_msg(cur)
        # -32000 SEUL ne suffit pas : c'est aussi le code du limiteur de débit
        # FastMCP (``RateLimitError``), de « Permission denied » et de
        # « Request timeout » — des RÉPONSES du serveur. Les classer
        # « transport » reconnectait l'entrée partagée et rejouait l'outil
        # (régression C1). Seul le message exact du SDK désigne le tuyau.
        if (_code == -32000 and _msg.strip().lower() == "connection closed") \
                or _is_session_gone(cur):
            return True
        subs = getattr(cur, "exceptions", None)
        if isinstance(subs, (list, tuple)):
            stack.extend(subs)
        if cur.__cause__ is not None:
            stack.append(cur.__cause__)
        if cur.__context__ is not None and cur.__context__ is not cur.__cause__:
            stack.append(cur.__context__)
    return False


# Kwargs acceptés par ``client.call_tool``, mémoïsés par CLASSE de wrapper.
# Même principe (et même raison d'être) que ``_mcp_wrappers._session_supports``,
# appliqué un cran plus haut : ici c'est le WRAPPER qu'on interroge, pas la
# session MCP. ``inspect.signature`` sur chaque appel d'outil se paierait des
# milliers de fois sur une mission longue.
_CLIENT_CALL_KWARGS_CACHE: Dict[str, frozenset] = {}


def _call_accepts_kwarg(client: Any, kwarg: str) -> bool:
    fn = getattr(client, "call_tool", None)
    if fn is None:
        return False
    key = f"{type(client).__module__}.{type(client).__qualname__}"
    names = _CLIENT_CALL_KWARGS_CACHE.get(key)
    if names is None:
        try:
            import inspect
            params = inspect.signature(fn).parameters
            if any(p.kind is inspect.Parameter.VAR_KEYWORD
                   for p in params.values()):
                names = frozenset({"meta", "progress_callback", "log_callback"})
            else:
                names = frozenset(params)
        except (TypeError, ValueError):
            # Signature illisible (builtin, mock exotique) : rester PERMISSIF,
            # comme l'ancien repli qui tentait l'appel complet.
            names = frozenset({"meta", "progress_callback", "log_callback"})
        _CLIENT_CALL_KWARGS_CACHE[key] = names
    return kwarg in names


def _is_replay_safe(tool_name: str) -> bool:
    """Peut-on rejouer cet outil après une reconnexion, sans risque de doublon ?

    Non pour tout ce qui MUTE : les préfixes déjà déclarés « sériels » (écriture,
    git, sandbox, mémoire, sous-agents…) plus le shell, qui n'y figure pas
    (il se parallélise) mais dont un rejeu relancerait la commande.
    """
    name = (tool_name or "").strip()
    if not name:
        return False
    # (2026-09-11, P2) politique déclarée par le serveur (``meta.policy``)
    try:
        from llm_core._mcp_categories import tool_policy as _tool_policy
        pol = _tool_policy(name)
        if "replay_safe" in pol:
            return bool(pol["replay_safe"])
        if "serial" in pol and pol["serial"]:
            return False
    except Exception:                                           # noqa: BLE001
        pass
    try:
        from llm_core._constants import LLAMA_TOOL_SERIAL_PREFIXES
    except Exception:                                           # noqa: BLE001
        LLAMA_TOOL_SERIAL_PREFIXES = ()                         # noqa: N806
    if name.startswith(tuple(LLAMA_TOOL_SERIAL_PREFIXES)):
        return False
    return not name.startswith(("execute_shell", "shell_", "run_", "desktop_",
                                "pw_", "browser_"))


@dataclass
class _PoolEntry:
    """Une connexion MCP maintenue en vie dans le pool."""
    key: str
    client: Any                         # MCPStdioWrapper | MCPSSEWrapper
    tools: List[Any] = field(default_factory=list)
    # AUDIT 2026-08-30 (S8) — base de temps MONOTONIC (ex-``time.time()``).
    # Ces deux champs ne servent QUE des durées (TTL du cache d'outils, seuil
    # d'inactivité, ``idle_sec``/``tools_age_sec`` du diagnostic) et ne sont
    # jamais persistés ni affichés en date absolue : un recalage NTP ou un
    # changement d'heure déconnectait des entrées vivantes, ou au contraire
    # gardait des entrées mortes une heure de plus. Tous les sites du fichier
    # sont sur la même base — ne JAMAIS y mêler un ``time.time()`` : les deux
    # sont soustraits l'un de l'autre (cf. ``elapsed_ms``).
    tools_fetched_at: float = 0.0       # instant monotonic du dernier list_tools()
    last_used_at: float = 0.0           # instant monotonic du dernier appel
    # ``lock`` = verrou de CYCLE DE VIE (connexion, refresh des outils,
    # fermeture). Pour un transport SÉRIEL (stdio) il verrouille AUSSI l'appel
    # — un subprocess, un pipe : deux appels concurrents s'y désynchroniseraient.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Concurrence des APPELS pour un transport qui la supporte (service SSE/HTTP
    # partagé). 1 ⇒ sériel, l'appel passe par ``lock`` (comportement historique).
    max_concurrency: int = 1
    call_sem: Optional[asyncio.Semaphore] = None
    # Part de concurrence par UTILISATEUR sur une entrée partagée (cf.
    # ``_user_share``) : empêche un compte de monopoliser le serveur d'outils
    # locaux, que tous les utilisateurs du worker se partagent.
    user_sems: Dict[str, asyncio.Semaphore] = field(default_factory=dict)
    inflight: int = 0                   # appels en vol (transport concurrent)
    healthy: bool = True
    # Entrée "épinglée" : jamais fermée par le nettoyage périodique
    # (``_periodic_cleanup``). Réservé au serveur d'outils locaux partagé,
    # toujours actif — l'auto-destruction par inactivité y est inutile et
    # nuisible (cf. _LOCAL_TOOLS_COMMAND).
    persistent: bool = False
    _connect_task: Optional[asyncio.Task] = field(default=None, repr=False)

    @property
    def busy(self) -> bool:
        """Entrée en cours d'utilisation (appel en vol ou opération de cycle
        de vie) — le nettoyage périodique doit la sauter."""
        return self.lock.locked() or self.inflight > 0


# Wrappers dont chaque requête voyage de façon indépendante (requête HTTP,
# POST SSE, appel en mémoire) : une réponse abandonnée ne peut décaler aucune
# autre. Tout le reste (stdio, wrappers tiers inconnus) est traité en SÉRIEL.
_CORRELATED_TRANSPORTS = frozenset({
    "MCPSSEWrapper", "MCPStreamableHTTPWrapper", "MCPInProcessWrapper",
})


def _abort_poisons_entry(client: Any) -> bool:
    """Un appel ABANDONNÉ (timeout d'exécution, annulation / Stop) rend-il
    l'entrée suspecte au point de la reconnecter ?

    AUDIT 2026-09-24 (point 2) — avant, TOUT abandon marquait l'entrée
    unhealthy, quel que soit le transport. Or l'entrée du serveur d'outils
    locaux est UNIQUE pour tout le worker : le Stop d'UN utilisateur forçait
    une reconnexion, dont la fermeture prend l'exclusivité (10 s) puis FORCE —
    les appels en vol des AUTRES utilisateurs étaient coupés net.

    - transport corrélé (SSE / HTTP / en mémoire) : la réponse tardive de
      l'appel abandonné est simplement écartée par son identifiant de
      requête ; la connexion reste saine → on n'y touche pas ;
    - stdio (et wrappers inconnus, par prudence) : UN sous-process, appels
      sérialisés — l'outil abandonné tourne peut-être encore et bloquera les
      suivants ; la reconnexion tue ce sous-process, et personne d'autre n'a
      d'appel en vol dessus (verrou exclusif) → on garde le marquage.
    """
    return type(client).__name__ not in _CORRELATED_TRANSPORTS


def _transport_concurrency(client: Any) -> int:
    """Nombre d'appels simultanés qu'un transport MCP tolère.

    stdio = UN subprocess, UN pipe : les appels DOIVENT se sérialiser (une
    réponse en retard décalerait les suivantes). SSE/HTTP = requêtes
    indépendantes vers un service partagé, qui peut en traiter plusieurs.

    L'enjeu est réel (audit 2026-08-01, P1-5) : ``execute_tool_batch``
    parallélise soigneusement les outils non-mutants, mais TOUS les outils
    locaux (fs, git, rag, skills…) se résolvent à UNE SEULE entrée de pool.
    Avec un verrou exclusif sur l'appel, ce parallélisme était intégralement
    annulé — cinq ``read_file`` d'un même tour s'exécutaient en file. Le
    commentaire qui justifiait la sérialisation (« correct pour un MCP
    stdio ») ne vaut plus dès que ``LOCAL_MCP_URL`` est posé : le serveur
    d'outils locaux est alors un service SSE partagé.
    """
    if client is None:
        return 1
    if type(client).__name__ not in _CORRELATED_TRANSPORTS:
        return 1                      # stdio & wrappers tiers : sériel, sûr
    try:
        from llm_core._constants import LLAMA_TOOL_PARALLELISM
        return max(1, int(LLAMA_TOOL_PARALLELISM))
    except Exception:
        return 1


def _username_of(meta: Optional[Dict[str, Any]]) -> Optional[str]:
    """Utilisateur à l'origine de l'appel, tel que porté par le meta MCP."""
    if isinstance(meta, dict):
        u = meta.get("username")
        if u:
            return str(u)
    return None


def _user_share(entry: "_PoolEntry", username: Optional[str]) -> Optional[asyncio.Semaphore]:
    """Part de concurrence réservée à UN utilisateur sur une entrée partagée.

    AUDIT 2026-08-22 (D5) — l'entrée du serveur d'outils locaux est
    délibérément UNIQUE pour tout le worker (cf. _LOCAL_TOOLS_COMMAND) : tous
    les utilisateurs y passent. Son seul garde-fou était un sémaphore global de
    huit places, sans notion d'appelant. Un lot de huit ``execute_shell`` —
    dont le délai de garde est de dix minutes — pouvait donc occuper les huit
    places pendant dix minutes, et tous les autres utilisateurs du worker
    attendaient là, sans borne, pour un simple ``read_file``. On réserve donc à
    chaque utilisateur au plus la moitié des places : un compte ne peut plus
    prendre toute la largeur, et le sémaphore global continue de plafonner le
    total.
    """
    if not username or entry.max_concurrency <= 1:
        return None
    per_user = max(1, entry.max_concurrency // 2)
    sem = entry.user_sems.get(username)
    if sem is None:
        sem = asyncio.Semaphore(per_user)
        # Borne du registre : un worker voit un nombre modeste de comptes, mais
        # rien ne garantit qu'il soit fini dans le temps.
        if len(entry.user_sems) >= 256:
            for _k in [k for k, v in entry.user_sems.items()
                       if getattr(v, "_value", 0) >= per_user][:128]:
                entry.user_sems.pop(_k, None)
        entry.user_sems[username] = sem
    return sem


class MCPQueueSaturated(RuntimeError):
    """L'appel n'a PAS été exécuté : l'attente en file (sémaphore d'entrée)
    a dépassé sa borne. À distinguer d'un vrai timeout d'exécution — le
    message d'erreur renvoyé au modèle ne doit pas accuser l'outil.

    AUDIT 2026-08-31 — avant, l'attente en file était FACTURÉE au budget de
    timeout de l'outil (le ``wait_for`` du harnais englobait l'acquisition) :
    sous saturation multi-utilisateur, un ``read_file`` « expirait » sans
    avoir jamais été exécuté, avec un diagnostic qui poussait le modèle à
    relancer — et re-queuer."""


@contextlib.asynccontextmanager
async def _call_guard_bounded(entry: "_PoolEntry", username: Optional[str],
                              queue_timeout_s: Optional[float]):
    """``_call_guard`` avec acquisition BORNÉE.

    ``queue_timeout_s=None`` = comportement historique (attente illimitée).
    Sinon, une attente en file au-delà de la borne lève ``MCPQueueSaturated``
    SANS avoir exécuté quoi que ce soit. L'annulation de l'acquisition en
    cours (wait_for) libère proprement les sous-verrous déjà pris : le corps
    du générateur déroule ses ``async with`` internes."""
    guard = _call_guard(entry, username)
    if queue_timeout_s is None:
        async with guard:
            yield
        return
    try:
        await asyncio.wait_for(guard.__aenter__(), timeout=queue_timeout_s)
    except asyncio.TimeoutError:
        raise MCPQueueSaturated(
            f"file d'attente d'outils saturée (> {queue_timeout_s:.0f}s) — "
            "l'appel n'a pas été exécuté") from None
    try:
        yield
    except BaseException as e:
        if not await guard.__aexit__(type(e), e, e.__traceback__):
            raise
    else:
        await guard.__aexit__(None, None, None)


@contextlib.asynccontextmanager
async def _call_guard(entry: "_PoolEntry", username: Optional[str] = None):
    """Garde de CONCURRENCE autour d'un ``call_tool``.

    - transport sériel (stdio) : verrou exclusif ``entry.lock`` — strictement
      le comportement historique (BUG FIX C5) ;
    - transport concurrent (SSE/HTTP) : part par utilisateur (cf.
      ``_user_share``) PUIS sémaphore global borné, avec compteur d'appels en
      vol que les opérations de cycle de vie drainent avant de fermer.
    """
    if entry.max_concurrency <= 1 or entry.call_sem is None:
        async with entry.lock:
            yield
        return
    _ushare = _user_share(entry, username)
    if _ushare is None:
        async with entry.call_sem:
            entry.inflight += 1
            try:
                yield
            finally:
                entry.inflight -= 1
        return
    async with _ushare:
        async with entry.call_sem:
            entry.inflight += 1
            try:
                yield
            finally:
                entry.inflight -= 1


async def _acquire_exclusive(entry: "_PoolEntry", timeout: float) -> Optional[int]:
    """Prend l'exclusivité sur ``entry`` (cycle de vie) et renvoie le nombre de
    permis de sémaphore acquis, ou ``None`` si le délai expire.

    Pour un transport concurrent, l'exclusivité = ``lock`` + TOUS les permis :
    tant qu'ils ne sont pas tous pris, un appel peut être en vol et fermer le
    client provoquerait un use-after-close (le défaut que le verrou exclusif
    historique évitait). L'appelant DOIT appeler ``_release_exclusive``.
    """
    _t0 = time.monotonic()
    try:
        await asyncio.wait_for(entry.lock.acquire(), timeout=timeout)
    except asyncio.TimeoutError:
        return None
    if entry.max_concurrency <= 1 or entry.call_sem is None:
        return 0
    taken = 0
    try:
        for _ in range(entry.max_concurrency):
            _left = timeout - (time.monotonic() - _t0)
            if _left <= 0:
                raise asyncio.TimeoutError
            await asyncio.wait_for(entry.call_sem.acquire(), timeout=_left)
            taken += 1
    except BaseException as e:
        # AUDIT 2026-09-24 (point 5) — ``BaseException`` et non plus le seul
        # TimeoutError : une ANNULATION pendant l'attente des permis laissait
        # le verrou et les permis déjà pris TENUS à jamais — l'entrée était
        # bloquée pour tous (cycle de vie ET appels).
        for _ in range(taken):
            entry.call_sem.release()
        entry.lock.release()
        if isinstance(e, asyncio.TimeoutError):
            return None
        raise
    return taken


def _release_exclusive(entry: "_PoolEntry", taken: Optional[int]) -> None:
    if taken is None:
        return
    if entry.call_sem is not None:
        for _ in range(taken):
            entry.call_sem.release()
    if entry.lock.locked():
        entry.lock.release()


class _EntryEvicted(RuntimeError):
    """L'entrée du pool a été fermée entre sa lecture et l'acquisition de sa
    garde (cleanup / invalidate / reset concurrent).

    AUDIT 2026-08-23 — c'est une sentinelle INTERNE, pas une panne : la requête
    n'a jamais quitté le process. Fabriquée en ``RuntimeError`` nue, elle
    tombait du mauvais côté du filtre transport et partait vers le modèle comme
    « échec côté SERVEUR » — un lot de 8 outils parallèles remontait 7 erreurs
    parasites « entry évincée avant l'appel » — tout en remettant ``healthy =
    True`` sur une entrée qui ne nous appartient plus.
    """


class MCPConnectionPool:
    """
    Pool singleton de connexions MCP persistantes.

    Fonctionnalités :
    ─────────────────
    • Connexions maintenues en vie entre les requêtes
    • Cache des outils avec TTL (TOOLS_CACHE_TTL_SEC, défaut 360s)
    • Reconnexion automatique en cas d'échec
    • Verrou par entrée pour éviter les connexions concurrentes au même serveur
    • Nettoyage des connexions inactives (idle cleanup)
    """

    # Durée d'inactivité avant fermeture automatique d'une connexion (10 min)
    IDLE_TIMEOUT_SEC = 600.0
    # Intervalle du nettoyage périodique
    _CLEANUP_INTERVAL_SEC = 120.0

    def __init__(self):
        self._pool: Dict[str, _PoolEntry] = {}
        # MAJ-6 — le lock global n'est PLUS créé à l'import (le singleton est
        # instancié au chargement du module, hors de toute boucle asyncio). Un
        # ``asyncio.Lock()`` se lie à la boucle de sa 1re utilisation ; créé ici
        # puis utilisé depuis une autre boucle (tests, ré-``asyncio.run`` après
        # shutdown), il levait « got Future attached to a different loop ». On le
        # crée donc paresseusement, lié à la boucle courante (cf. _global_lock).
        self._global_lock_obj: Optional[asyncio.Lock] = None
        self._global_lock_loop: Optional[asyncio.AbstractEventLoop] = None
        # AUDIT 2026-08-31 — verrous de (re)connexion PAR CLÉ. Le verrou
        # GLOBAL était tenu pendant tout le cycle fermeture (drain 10 s) +
        # spawn/handshake (30 s) + list_tools (30 s) d'UNE connexion : le pool
        # étant un singleton partagé par tous les utilisateurs du worker, la
        # (re)connexion d'un seul serveur MCP — worker froid, éviction après
        # 10 min d'inactivité, serveur injoignable — gelait l'entrée de TOUS
        # les tours (``_collect_mcp_tools`` → ``get_or_connect``). Les cycles
        # de vie se sérialisent désormais par serveur, plus entre serveurs.
        self._key_locks: Dict[str, asyncio.Lock] = {}
        self._key_locks_loop: Optional[asyncio.AbstractEventLoop] = None
        self._cleanup_task: Optional[asyncio.Task] = None
        self._closed = False
        # Fermetures détachées en cours (cf. _close_entry_unsafe) : référence
        # forte, retirée d'elle-même à la fin de la tâche.
        self._closing_tasks: set = set()

    @property
    def _global_lock(self) -> asyncio.Lock:
        """Lock global créé paresseusement et lié à la boucle courante."""
        loop = asyncio.get_event_loop()
        if self._global_lock_obj is None or self._global_lock_loop is not loop:
            self._global_lock_obj = asyncio.Lock()
            self._global_lock_loop = loop
        return self._global_lock_obj

    def _key_lock(self, key: str) -> asyncio.Lock:
        """Verrou de cycle de vie d'UNE clé, lié à la boucle courante.

        Création synchrone (atomique sur la boucle) — même contrat de
        re-liaison que ``_global_lock`` pour les tests qui ré-``asyncio.run``.
        """
        loop = asyncio.get_event_loop()
        if self._key_locks_loop is not loop:
            self._key_locks = {}
            self._key_locks_loop = loop
        lk = self._key_locks.get(key)
        if lk is None:
            lk = self._key_locks[key] = asyncio.Lock()
        return lk

    # ── Clé unique pour un serveur MCP ───────────────────────────────────────

    @staticmethod
    def _auth_fingerprint(cfg: Dict[str, Any]) -> str:
        """Empreinte stable des éléments d'AUTH d'une config MCP.

        Inclut ``headers`` / ``authorization`` / ``basic_auth`` / ``env`` —
        tout ce qui change l'identité de la connexion. Deux configs identiques
        sauf l'auth produisent des empreintes différentes → entrées pool
        distinctes (MAJ-3).

        ``env`` (2026-08-30) : c'est par là qu'un serveur stdio reçoit son
        jeton. Sans lui dans l'empreinte, deux connecteurs de même commande
        mais de comptes différents auraient partagé UN sous-processus — donc
        les identifiants du premier arrivé, exactement la fuite que MAJ-3
        avait fermée côté HTTP.
        """
        material = {
            "headers": cfg.get("headers"),
            "authorization": cfg.get("authorization"),
            "basic_auth": cfg.get("basic_auth"),
            "env": cfg.get("env"),
        }
        try:
            raw = json.dumps(material, sort_keys=True, default=str)
        except Exception:
            raw = repr(material)
        return hashlib.sha256(raw.encode()).hexdigest()[:12]

    @staticmethod
    def _make_key(cfg: Dict[str, Any]) -> str:
        """
        Génère une clé unique et stable pour une config MCP.
        Basée sur type + command (stdio) ou type + url (sse).
        """
        ctype = cfg.get("type", "sse")
        if ctype == "inprocess":
            # MCP interne de l'app : UNE entrée par nom d'entrée du manifeste
            # (``filter_categories`` côté client, comme la sentinelle).
            parts = [ctype, str(cfg.get("manifest") or cfg.get("name") or "elpis-app")]
        elif ctype == "stdio":
            # Serveur d'outils locaux partagé : TOUTES les configs locales
            # (pré-warm sans filtre, chat avec filtre, pipelines…) ciblent le
            # même backend. On les fond en UNE seule clé en ignorant ``name``
            # et ``filter_categories`` (purement côté client). Sinon chaque
            # combo de catégories ouvrait une connexion distincte vers le même
            # service et l'éviction d'un combo pouvait écraser le registre de
            # catégories partagé. Voir _LOCAL_TOOLS_COMMAND.
            if cfg.get("command", "") == _LOCAL_TOOLS_COMMAND:
                # (2026-09-12) Une entrée de manifeste = un endpoint = une
                # session : le NOM d'entrée entre dans la clé. Sans lui, les dix
                # entrées intégrées se seraient fondues en une seule connexion
                # (la première gagnante), et neuf familles d'outils auraient
                # disparu en silence. La sentinelle NUE garde l'ancienne clé.
                parts = [ctype, _LOCAL_TOOLS_COMMAND]
                _mf_name = str(cfg.get("manifest") or "").strip()
                if _mf_name:
                    parts.append(_mf_name)
            else:
                # command + filter_categories définissent un processus unique
                parts = [
                    ctype,
                    cfg.get("command", ""),
                    cfg.get("name", ""),
                    json.dumps(sorted(cfg.get("filter_categories", []))),
                    # MAJ-3 — l'auth fait partie de l'identité de connexion :
                    # deux configs même command/name mais credentials distincts
                    # ne doivent PAS partager la même entrée pool.
                    MCPConnectionPool._auth_fingerprint(cfg),
                ]
        else:
            # MAJ-3 — pour SSE/HTTP, hacher l'URL SEULE faisait que deux users avec
            # la même URL (ex. Jenkins) mais des ``basic_auth``/``authorization``
            # différents partageaient UNE connexion → le 2e réutilisait la
            # session authentifiée avec les credentials du 1er (fuite cross-user).
            # On inclut donc une empreinte de l'auth/headers dans la clé.
            parts = [ctype, cfg.get("url", ""),
                     MCPConnectionPool._auth_fingerprint(cfg)]
        raw = "|".join(parts)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    # ── API publique ─────────────────────────────────────────────────────────

    async def get_or_connect(
        self,
        cfg: Dict[str, Any],
        resolve_client_fn=None,
    ) -> Tuple[Any, List[Any]]:
        """
        Retourne (client, tools) pour la config donnée.

        - Si une connexion saine existe dans le pool → la réutilise
        - Si les outils sont en cache et le TTL n'est pas expiré → skip list_tools()
        - Sinon → crée la connexion, list les outils, met en cache

        resolve_client_fn: callable(cfg) -> MCPStdioWrapper|MCPSSEWrapper|None
            Fonction qui crée un nouveau wrapper client (importée de services.py
            pour éviter les imports circulaires).

        BUG FIX #17 — locking propre : avant, on lisait `entry.healthy` HORS
        verrou puis on utilisait entry.client. Deux requêtes parallèles
        pouvaient toutes deux passer ce check, puis l'une marquer
        healthy=False pendant que l'autre lisait entry.client → use-after-
        free virtuel. Maintenant : prise rapide du verrou par-entrée pour
        chaque opération sur entry, et la lecture de entry.client se fait
        sous ce verrou. Le _global_lock n'est utilisé QUE pour la création
        d'une nouvelle entrée (dict-level mutation).
        """
        if self._closed:
            raise RuntimeError("MCPConnectionPool est fermé.")

        key = self._make_key(cfg)

        # Lancer le cleanup périodique si pas encore actif
        self._ensure_cleanup_running()

        # Fast path: entrée existante et saine.
        # On lit entry de façon optimiste mais on prend son lock
        # avant toute opération sur ses champs mutables.
        entry = self._pool.get(key)
        if entry:
            async with entry.lock:
                # Re-check sous verrou : entry peut avoir été marquée
                # unhealthy ou fermée par une coroutine concurrente.
                if entry.healthy and self._pool.get(key) is entry:
                    entry.last_used_at = time.monotonic()
                    if self._tools_expired(entry):
                        try:
                            # AUDIT 2026-09-25 — borné comme au handshake :
                            # sans borne, un serveur figé (flux SSE mort, stdio
                            # bloqué) suspendait le début de tour ET, verrou
                            # d'entrée tenu, tous les autres appels de l'entrée.
                            entry.tools = await asyncio.wait_for(
                                entry.client.list_tools(),
                                timeout=MCP_HANDSHAKE_TIMEOUT_S)
                            entry.tools_fetched_at = time.monotonic()
                            logger.info(
                                f"[MCP_POOL] Outils rafraîchis pour '{cfg.get('name', key)}' "
                                f"({len(entry.tools)} outils)"
                            )
                        except Exception as e:
                            logger.warning(
                                f"[MCP_POOL] Échec rafraîchissement outils '{cfg.get('name', key)}': {e}"
                            )
                            entry.healthy = False
                            # Tomber dans le slow path ci-dessous
                        else:
                            return entry.client, entry.tools
                    else:
                        return entry.client, entry.tools

        # Slow path: nouvelle connexion ou reconnexion — sérialisée PAR CLÉ
        # (AUDIT 2026-08-31, cf. _key_lock) : deux serveurs distincts se
        # connectent en parallèle, seul le MÊME serveur se sérialise.
        async with self._key_lock(key):
            # Double-check après le lock de clé
            entry = self._pool.get(key)
            if entry and entry.healthy:
                entry.last_used_at = time.monotonic()
                return entry.client, entry.tools

            return await self._connect_new(key, cfg, resolve_client_fn)

    async def call_tool(
        self,
        cfg: Dict[str, Any],
        tool_name: str,
        arguments: dict,
        resolve_client_fn=None,
        meta: Optional[Dict[str, Any]] = None,
        progress_callback: Optional[Callable] = None,
        log_callback: Optional[Callable] = None,
        exec_timeout_s: Optional[float] = None,
        queue_timeout_s: Optional[float] = None,
    ) -> Any:
        """
        Appelle un outil via le pool. Gère la reconnexion automatique
        si l'appel échoue (processus crashé, connexion perdue).

        AUDIT 2026-08-31 — ``exec_timeout_s`` borne l'EXÉCUTION seule (le
        ``wait_for`` posé par l'appelant englobait aussi l'attente du
        sémaphore d'entrée : sous saturation, un outil « expirait » sans
        avoir été exécuté). ``queue_timeout_s`` borne l'attente en file et
        lève ``MCPQueueSaturated`` — une erreur distincte, jamais imputée à
        l'outil. Un timeout d'EXÉCUTION remonte en ``asyncio.TimeoutError``
        sans reconnexion+replay ici ; sur un transport stdio il marque en plus
        l'entrée unhealthy (le prochain appel reconnectera) — pas sur un
        transport corrélé (cf. ``_abort_poisons_entry``, audit 2026-09-24).

        v17.20+ (Phase 2b) — ``meta`` est transmis comme MCP request meta
        (cf. mcp >= 1.19.0 ``ClientSession.call_tool(..., meta=...)``).
        C'est out-of-band : ne traverse pas les arguments → invisible au LLM.
        Utilisé pour passer identité (``{"username": ..., "chat_id": ...}``)
        sans pollution du schema.

        v18 (Tier 1 MCP best practices) — ``progress_callback`` et
        ``log_callback`` reçoivent les notifications MCP natives émises
        par le tool serveur via ``ctx.report_progress()`` / ``ctx.info()``.
        Le wrapper sous-jacent (MCPStdio/MCPSSEWrapper) gère le routing
        per-call. None = silencieux (comportement legacy).

        BUG FIX #19 — entre `entry = self._pool.get(key)` et l'appel à
        `entry.client.call_tool`, un autre coroutine pouvait faire
        invalidate() → entry fermée mais référencée. Maintenant : on
        retient le client local sous verrou puis on relâche pour
        l'appel (qui peut être long), et en cas d'erreur on revérifie
        que c'est toujours notre entry qui est dans le pool avant de
        marquer unhealthy.
        """
        key = self._make_key(cfg)
        entry = self._pool.get(key)

        if not entry or not entry.healthy:
            # AUDIT 2026-08-31 (passe 2) — depuis que le budget d'exécution
            # vit DANS call_tool (exec_timeout_s), cette (re)connexion n'était
            # plus sous AUCUNE borne côté appelant : serveur injoignable +
            # plusieurs waiters empilés sur le même _key_lock = attente bien
            # au-delà du timeout de l'outil, sans jamais produire l'erreur
            # JSON que le modèle sait interpréter. Même borne que la file
            # (queue_timeout_s) : l'appel n'a PAS été exécuté, l'annulation
            # du handshake en cours est propre (cf. C3 dans _connect_new).
            try:
                if queue_timeout_s is not None:
                    client, _ = await asyncio.wait_for(
                        self.get_or_connect(cfg, resolve_client_fn),
                        timeout=queue_timeout_s)
                else:
                    client, _ = await self.get_or_connect(cfg, resolve_client_fn)
            except asyncio.TimeoutError:
                raise MCPQueueSaturated(
                    f"(re)connexion à '{cfg.get('name', key)}' trop longue "
                    f"(> {queue_timeout_s:.0f}s) — l'appel n'a pas été exécuté"
                ) from None
            entry = self._pool.get(key)
            if not entry:
                # _connect_new a échoué silencieusement → bubble up
                raise RuntimeError(
                    f"MCP '{cfg.get('name', key)}' indisponible après reconnexion."
                )

        # BUG FIX C5 (complet) — la garde couvre TOUT l'appel, pas seulement le
        # snapshot du client. Avant, le lock n'était pris que pour copier
        # ``entry.client`` puis relâché : ``_close_entry`` / ``_periodic_cleanup``
        # pouvaient alors fermer le client EN PLEIN appel (use-after-close →
        # erreur transport parasite + reconnexion). Les chemins de fermeture
        # prennent désormais l'EXCLUSIVITÉ (``_acquire_exclusive``), qui draine
        # les appels en vol quel que soit le mode.
        #
        # Mode de la garde selon le TRANSPORT (audit 2026-08-01, P1-5) :
        #   • stdio  → verrou exclusif, appels sérialisés (un pipe, une réponse
        #     à la fois) : comportement historique intact ;
        #   • SSE/HTTP → sémaphore borné : le service d'outils locaux partagé
        #     traite plusieurs appels de front. C'est ce qui rend enfin EFFECTIF
        #     le parallélisme d'``execute_tool_batch`` — auparavant annulé, tous
        #     les outils locaux partageant une seule entrée de pool.
        #
        # NB : ne PAS ré-acquérir la garde dans le bloc ``except`` — asyncio.Lock
        # n'est pas réentrant, ce serait un deadlock. La reconnexion + retry se
        # font APRÈS la sortie du ``async with``.
        _call_err = None
        async with _call_guard_bounded(entry, _username_of(meta), queue_timeout_s):
            # MAJ-1 — re-vérification sous garde. ``entry`` a été lu hors garde ;
            # entre cette lecture et son acquisition, une coro concurrente
            # (cleanup / invalidate / reset) a pu fermer cette entrée et la
            # retirer du pool → son client est mort. On aligne sur le pattern de
            # get_or_connect : si ce n'est plus notre entrée saine, on retombe
            # sur le slow path (reconnexion) sans toucher au client fermé
            # (use-after-close).
            if self._pool.get(key) is not entry or not entry.healthy:
                _call_err = _EntryEvicted("entry évincée avant l'appel")
            else:
                client_local = entry.client
                try:
                    _coro = self._call_with_meta(
                        client_local, tool_name, arguments, meta,
                        progress_callback=progress_callback,
                        log_callback=log_callback,
                    )
                    result = (await asyncio.wait_for(_coro, timeout=exec_timeout_s)
                              if exec_timeout_s is not None else await _coro)
                    entry.last_used_at = time.monotonic()
                    return result
                except asyncio.TimeoutError:
                    # Budget d'exécution épuisé (queue NON comptée) : transport
                    # désynchronisé (la réponse peut arriver en retard) →
                    # unhealthy, et l'erreur remonte TELLE QUELLE à l'appelant
                    # (message « l'outil n'a pas répondu » du harnais) — pas de
                    # reconnexion+replay dans ce tour.
                    # AUDIT 2026-09-24 (point 2) — seulement si le transport
                    # peut réellement en souffrir (cf. _abort_poisons_entry).
                    if (self._pool.get(key) is entry
                            and _abort_poisons_entry(client_local)):
                        entry.healthy = False
                    raise
                except asyncio.CancelledError:
                    # Un TIMEOUT d'outil (asyncio.wait_for côté boucle) ANNULE cet
                    # appel EN VOL : la requête stdio/SSE a été coupée, la réponse
                    # correspondante peut arriver en retard et DÉCALER les appels
                    # suivants sur ce même pipe. ``except Exception`` ne rattrape
                    # PAS CancelledError (BaseException en 3.8+) → l'entrée restait
                    # ``healthy=True`` sur un transport désynchronisé. On la marque
                    # unhealthy AVANT de propager pour forcer une reconnexion propre
                    # au prochain call_tool. (On ne reconnecte pas ici : l'appelant
                    # est en cours d'annulation.)
                    # AUDIT 2026-09-24 (point 2) — stdio seulement : sur un
                    # transport corrélé (le serveur d'outils locaux partagé), le
                    # Stop d'un utilisateur coupait les appels des autres.
                    if (self._pool.get(key) is entry
                            and _abort_poisons_entry(client_local)):
                        entry.healthy = False
                    raise
                except Exception as e:
                    _call_err = e
                    # On détient déjà entry.lock — marquage direct, sans re-acquire.
                    if self._pool.get(key) is entry:
                        entry.healthy = False

        # Hors du ``async with`` (lock relâché) : reconnexion + retry.
        #
        # AUDIT 2026-08-22 (C1) — filtre AVANT de toucher à l'entrée. Deux
        # questions, deux refus possibles :
        #   1. est-ce vraiment le TUYAU qui a lâché ? Sinon (McpError,
        #      rate-limit, erreur applicative du serveur) l'entrée est saine :
        #      la détruire punirait tous les autres utilisateurs du worker —
        #      la fermeture prend l'exclusivité et draine leurs appels en vol —
        #      pour une erreur qui doit simplement remonter comme erreur
        #      d'outil (``pick_tool_payload`` sait l'emballer) ;
        #   2. l'outil est-il rejouable ? Une rupture de tuyau peut survenir
        #      APRÈS que le serveur a exécuté l'outil et pendant l'envoi de sa
        #      réponse : rejouer un shell ou une écriture appliquerait l'effet
        #      deux fois. On reconnecte alors pour assainir l'entrée, mais on
        #      remonte l'erreur au lieu de rejouer.
        # Entrée évincée : la requête n'est JAMAIS partie. On reconnecte et on
        # rejoue — inconditionnellement sûr, y compris pour un outil mutant,
        # puisqu'aucun effet n'a pu être appliqué.
        _evincee = isinstance(_call_err, _EntryEvicted)
        # Session inconnue du serveur : la requête n'est jamais arrivée à
        # l'outil — même traitement qu'une entrée évincée (rejeu sûr).
        if not _evincee and _call_err is not None and _is_session_gone(_call_err):
            _evincee = True
        _transport = True if _evincee else (
            _is_transport_error(_call_err) if _call_err is not None else True)
        if not _transport:
            if self._pool.get(key) is entry:
                entry.healthy = True        # l'entrée n'est pas en cause
            logger.info(
                "[MCP_POOL] call_tool '%s' sur '%s' a échoué côté SERVEUR "
                "(%s: %s) — remonté comme erreur d'outil, connexion conservée.",
                tool_name, cfg.get("name", key),
                type(_call_err).__name__, _call_err)
            raise _call_err
        logger.warning(
            f"[MCP_POOL] Erreur call_tool '{tool_name}' sur "
            f"'{cfg.get('name', key)}': {_call_err}. Tentative de reconnexion…"
        )
        # AUDIT 2026-08-23 — relire le pool AVANT de reconnecter.
        #
        # Chaque appelant en échec appelait ``_reconnect`` sans vérifier si
        # l'entrée avait DÉJÀ été remplacée entre-temps. Or ``_reconnect`` prend
        # le verrou GLOBAL du pool puis ``_connect_new``, qui commence par
        # fermer l'entrée (jusqu'à 10 s de drainage) avant un handshake borné à
        # 30 s. Le serveur d'outils locaux étant une entrée UNIQUE partagée par
        # tout le worker, UNE coupure de tuyau pendant un lot parallèle
        # produisait autant de cycles fermeture+connexion qu'il y avait
        # d'appels en échec — tous sérialisés sous le verrou global, donc
        # bloquant aussi toute connexion d'un autre serveur MCP. Mesuré :
        # 4 connexions ouvertes et 4 fermées là où une seule suffisait, chacune
        # détruisant celle que la précédente venait d'obtenir, avec à chaque
        # fois un ``ingest_tools`` et une réécriture du cache disque des
        # catégories. En repli stdio, chaque itération SPAWNE en plus un
        # sous-process complet puis le tue.
        _cur = self._pool.get(key)
        if _cur is not None and _cur is not entry and getattr(_cur, "healthy", False):
            logger.info(
                "[MCP_POOL] '%s' a déjà été reconnecté par un autre appel — "
                "on se rattache à l'entrée saine au lieu de la remplacer.",
                cfg.get("name", key))
        else:
            # Même borne que la (re)connexion d'entrée (passe 2 2026-08-31) :
            # sans elle, le retry après coupure de tuyau attendait le verrou
            # de clé + le cycle fermeture/handshake sans budget.
            try:
                if queue_timeout_s is not None:
                    await asyncio.wait_for(
                        self._reconnect(key, cfg, resolve_client_fn),
                        timeout=queue_timeout_s)
                else:
                    await self._reconnect(key, cfg, resolve_client_fn)
            except asyncio.TimeoutError:
                raise MCPQueueSaturated(
                    f"(re)connexion à '{cfg.get('name', key)}' trop longue "
                    f"(> {queue_timeout_s:.0f}s) — l'outil n'a pas été rejoué"
                ) from _call_err
        if not _evincee and not _is_replay_safe(tool_name):
            logger.warning(
                "[MCP_POOL] '%s' NON rejoué après reconnexion (outil mutant : "
                "l'effet a peut-être déjà été appliqué avant la coupure).",
                tool_name)
            raise _call_err

        # MAJ-2 — le retry s'exécute SOUS le verrou de la nouvelle entrée (avant,
        # il tournait hors lock → contournait la sérialisation BUG-FIX-C5 : un
        # appel concurrent sur le même serveur pouvait écraser le slot de routing
        # des logs du wrapper, MAJ-4). On marque aussi la nouvelle entrée
        # unhealthy si le retry échoue, au lieu de la laisser saine en apparence.
        new_entry = self._pool.get(key)
        if new_entry is None:
            raise RuntimeError(
                f"MCP '{cfg.get('name', key)}' indisponible après reconnexion."
            )
        async with _call_guard_bounded(new_entry, _username_of(meta), queue_timeout_s):
            try:
                _coro = self._call_with_meta(
                    new_entry.client, tool_name, arguments, meta,
                    progress_callback=progress_callback,
                    log_callback=log_callback,
                )
                result = (await asyncio.wait_for(_coro, timeout=exec_timeout_s)
                          if exec_timeout_s is not None else await _coro)
                new_entry.last_used_at = time.monotonic()
                return result
            # Même tri qu'au premier essai : seule une rupture de TRANSPORT
            # (ou un abandon qui désynchronise stdio) empoisonne l'entrée
            # PARTAGÉE. Avant, n'importe quelle erreur (rate-limit serveur,
            # timeout HTTP) forçait une reconnexion qui coupait les appels en
            # vol des autres utilisateurs (passe robustesse 2026-09-24).
            except (asyncio.TimeoutError, asyncio.CancelledError):
                if (self._pool.get(key) is new_entry
                        and _abort_poisons_entry(new_entry.client)):
                    new_entry.healthy = False
                raise
            except Exception as e:
                if self._pool.get(key) is new_entry and _is_transport_error(e):
                    new_entry.healthy = False
                raise

    @staticmethod
    async def _call_with_meta(client, tool_name, arguments, meta,
                              progress_callback=None, log_callback=None):
        """Helper qui forward meta + callbacks au wrapper.

        v18 — Les wrappers (MCPStdioWrapper / MCPSSEWrapper) acceptent
        désormais ``progress_callback`` et ``log_callback``. On les
        passe via try/except pour rester compat avec d'éventuels
        wrappers tiers qui ne les supportent pas — best-effort
        degradation.
        """
        # AUDIT 2026-08-22 (C1) — les kwargs acceptés sont DÉDUITS de la
        # signature, jamais découverts en rattrapant un ``TypeError``.
        # L'ancien repli ne pouvait pas distinguer « ce wrapper ne connaît pas
        # ce kwarg » d'un ``TypeError`` levé par le CORPS de l'outil : dans le
        # second cas il rappelait ``call_tool`` — jusqu'à trois exécutions du
        # même outil, mutations comprises. Même correction que celle appliquée
        # aux wrappers le 2026-08-21, ici sur le chemin du pool.
        kwargs: Dict[str, Any] = {}
        if meta:
            kwargs["meta"] = meta
        if progress_callback is not None:
            kwargs["progress_callback"] = progress_callback
        if log_callback is not None:
            kwargs["log_callback"] = log_callback
        if kwargs:
            kwargs = {k: v for k, v in kwargs.items()
                      if _call_accepts_kwarg(client, k)}
        if kwargs:
            return await client.call_tool(tool_name, arguments, **kwargs)
        return await client.call_tool(tool_name, arguments)

    async def invalidate(self, cfg: Dict[str, Any]) -> None:
        """Ferme et supprime une connexion du pool."""
        key = self._make_key(cfg)
        await self._close_entry(key)

    async def close_all(self) -> None:
        """Ferme toutes les connexions. Appeler au shutdown de l'app."""
        self._closed = True
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()

        keys = list(self._pool.keys())
        for key in keys:
            await self._close_entry(key)
        logger.info(f"[MCP_POOL] Pool fermé ({len(keys)} connexion(s) libérée(s)).")

    async def reset(self, *, keep_persistent: bool = True) -> None:
        """Ferme les connexions SANS marquer le pool comme fermé.

        Contrairement à close_all(), le pool reste utilisable après reset().
        Les prochains appels à get_or_connect() recréeront les connexions
        à la demande. Ceci évite le problème du singleton remplacé :
        les modules qui ont importé `mcp_pool` gardent la même référence.

        AUDIT 2026-08-23 — les entrées PERSISTANTES sont épargnées par défaut.
        La seule qui l'est aujourd'hui est le serveur d'outils LOCAUX
        (fs/shell/git), délibérément unique pour tout le worker : tous les
        utilisateurs y passent. Un reset la tuait — et
        ``_close_entry_unsafe`` FORCE au bout de 10 s, « le subprocess sera
        tué » : la sauvegarde de réglages MCP d'un utilisateur arrachait donc
        le ``execute_shell`` en vol d'un autre, et faisait stalle 10 s la
        requête de celui qui sauvegardait. Or cette entrée ne dépend d'AUCUNE
        configuration utilisateur : elle vient du code. Le nettoyage
        périodique applique déjà exactement ce filtre.
        Le rappel explicite ``keep_persistent=False`` reste possible pour un
        vrai recyclage complet.
        """
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            self._cleanup_task = None

        keys = [k for k, e in self._pool.items()
                if keep_persistent is False or not e.persistent]
        gardees = len(self._pool) - len(keys)
        for key in keys:
            await self._close_entry(key)

        # Réactiver le pool s'il avait été fermé par close_all()
        self._closed = False
        logger.info(
            f"[MCP_POOL] Pool reset ({len(keys)} connexion(s) libérée(s), "
            f"{gardees} persistante(s) conservée(s)).")


    # ── Internals ────────────────────────────────────────────────────────────

    def _tools_expired(self, entry: _PoolEntry) -> bool:
        if not entry.tools_fetched_at:
            return True
        return (time.monotonic() - entry.tools_fetched_at) > TOOLS_CACHE_TTL_SEC

    async def _connect_new(
        self,
        key: str,
        cfg: Dict[str, Any],
        resolve_client_fn,
    ) -> Tuple[Any, List[Any]]:
        """Crée une nouvelle connexion et l'ajoute au pool."""
        # Fermer l'ancienne entrée si elle existe
        if key in self._pool:
            await self._close_entry_unsafe(key)

        if not resolve_client_fn:
            raise RuntimeError("resolve_client_fn requis pour créer une connexion MCP.")

        client = resolve_client_fn(cfg)
        if not client:
            raise RuntimeError(f"Config MCP invalide: {cfg.get('name', '?')}")

        # AUDIT 2026-08-30 (S8) — monotonic comme le ``now`` du _PoolEntry
        # construit plus bas : ``elapsed_ms`` les soustrait l'un de l'autre.
        t0 = time.monotonic()
        try:
            # __aenter__ spawn le processus + handshake MCP.
            #
            # AUDIT 2026-08-22 (C3) — deux protections :
            #   • ``except BaseException`` : le cleanup DOIT aussi tourner sur
            #     une ANNULATION. Le timeout d'outil de la boucle
            #     (``asyncio.wait_for``) annule cette coroutine ; avec un
            #     ``except Exception``, le ``__aexit__`` était sauté et le
            #     sous-process (ou le flux SSE + son groupe de tâches anyio)
            #     restait orphelin — un de plus à chaque reconnexion avortée,
            #     pour toute la vie du worker (le recyclage étant désactivé).
            #   • une borne propre sur le handshake : ni ``__aenter__`` ni
            #     ``list_tools`` n'en avaient, la seule était celle de
            #     l'appelant, c'est-à-dire justement l'annulation ci-dessus.
            await asyncio.wait_for(client.__aenter__(),
                                   timeout=MCP_HANDSHAKE_TIMEOUT_S)
            tools = await asyncio.wait_for(client.list_tools(),
                                           timeout=MCP_HANDSHAKE_TIMEOUT_S)
        except BaseException as e:
            try:
                await client.__aexit__(None, None, None)
            except BaseException:                               # noqa: BLE001
                pass
            if isinstance(e, asyncio.CancelledError):
                raise
            raise RuntimeError(
                f"Échec connexion MCP '{cfg.get('name', '?')}': {e}"
            ) from e

        now = time.monotonic()
        _is_local = _is_local_tools_cfg(cfg)
        _conc = _transport_concurrency(client)
        entry = _PoolEntry(
            key=key,
            client=client,
            tools=tools,
            tools_fetched_at=now,
            last_used_at=now,
            healthy=True,
            persistent=_is_local,
            max_concurrency=_conc,
            call_sem=(asyncio.Semaphore(_conc) if _conc > 1 else None),
        )
        self._pool[key] = entry

        # Synchronise le registre de catégories — mais UNIQUEMENT depuis le
        # serveur d'outils LOCAUX. Le panneau latéral des catégories (cf.
        # /api/mcp/categories) est le panneau des outils locaux (fs/git/shell/
        # …) ; les serveurs MCP externes/custom sont gérés à part (active_mcp_ids)
        # et ne doivent PAS l'alimenter.
        #
        # Bug corrigé : on ré-ingérait avant l'UNION des outils de TOUTES les
        # entrées vivantes du pool, puis on écrasait le cache cross-worker sur
        # disque. Un worker dont la 1re connexion était un serveur externe (ou
        # qui ré-ingérait après éviction des entrées locales par inactivité)
        # réécrivait donc le cache partagé SANS les catégories locales → les
        # bascules locales disparaissaient du chat pour TOUS les workers.
        #
        # Désormais : on n'ingère QUE lors de la (re)connexion du serveur local,
        # et on ingère l'ensemble COMPLET des outils de CETTE connexion (faisant
        # autorité — ``filter_categories`` est côté client, le serveur renvoie
        # toujours tout). Combiné à l'épinglage de l'entrée locale, le registre
        # reste stable et n'est jamais écrasé par un serveur externe.
        # Best-effort — un échec ici ne doit jamais casser la connexion.
        if _is_local:
            try:
                from llm_core import _mcp_categories as _mcp_cats
                # (2026-09-12, P4) une SOURCE par service intégré (service
                # partagé, MCP interne) : le registre est l'UNION des sources.
                _mcp_cats.ingest_tools(tools, source=key)
            except Exception:
                logger.debug("[MCP_POOL] category registry ingest skipped", exc_info=True)

        elapsed_ms = round((now - t0) * 1000)
        logger.info(
            f"[MCP_POOL] Connecté '{cfg.get('name', '?')}' en {elapsed_ms}ms "
            f"({len(tools)} outils). Clé={key}"
        )

        return client, tools

    async def _reconnect(
        self,
        key: str,
        cfg: Dict[str, Any],
        resolve_client_fn,
    ) -> Tuple[Any, List[Any]]:
        """Ferme l'ancienne connexion et en crée une nouvelle."""
        async with self._key_lock(key):
            logger.info(f"[MCP_POOL] Reconnexion '{cfg.get('name', '?')}'…")
            return await self._connect_new(key, cfg, resolve_client_fn)

    async def _close_entry(self, key: str) -> None:
        async with self._key_lock(key):
            await self._close_entry_unsafe(key)

    async def _close_entry_unsafe(self, key: str) -> None:
        """Ferme une entrée sans prendre le lock de clé (appelant doit le détenir).

        BUG FIX C5 — attend la fin du call_tool actif avant de fermer.
        Avant, _close_entry_unsafe pop l'entry du dict puis appelait
        directement `client.__aexit__` sans regarder si une coroutine
        externe était en train d'utiliser ce client (via le snapshot
        sous lock dans call_tool). Le client.__aexit__ tue le subprocess
        MCP → le call_tool en cours plante avec une erreur transport.

        Maintenant : on prend le lock par-entrée AVANT de fermer pour
        s'assurer qu'aucune coro n'est en plein usage du client. Le
        timeout 10s est un filet de sécurité — on ne veut pas bloquer
        un shutdown indéfiniment si un call_tool est gelé. Au-delà du
        timeout, on force la fermeture (le call_tool plantera mais on
        n'a pas le choix).
        """
        entry = self._pool.pop(key, None)
        if not entry:
            return
        # AUDIT 2026-09-24 (point 5) — l'entrée est déjà RETIRÉE du pool :
        # plus personne d'autre ne la fermera. Une annulation de l'appelant
        # (Stop, timeout d'outil de la boucle) pendant le drainage laissait le
        # client JAMAIS fermé — sous-process stdio orphelin, session HTTP
        # pendante. Le drainage + la fermeture tournent donc dans une tâche
        # DÉTACHÉE et abritée (``shield``) : l'appelant peut être annulé, la
        # fermeture va à son terme. Référence forte gardée dans
        # ``_closing_tasks`` (une tâche sans référence peut être ramassée).
        closer = asyncio.ensure_future(self._drain_and_close(key, entry))
        self._closing_tasks.add(closer)
        closer.add_done_callback(self._closing_tasks.discard)
        await asyncio.shield(closer)

    async def _drain_and_close(self, key: str, entry: "_PoolEntry") -> None:
        """Draine les appels en vol de ``entry`` (borne 10 s) puis ferme son
        client. Toujours lancée en tâche détachée (cf. _close_entry_unsafe)."""
        # Attendre que TOUS les appels en vol soient terminés (ou timeout).
        _taken = await _acquire_exclusive(entry, timeout=10.0)
        if _taken is None:
            logger.warning(
                f"[MCP_POOL] Fermeture forcée de {key} après timeout — "
                "un call_tool était bloqué. Le subprocess sera tué."
            )
            try:
                await entry.client.__aexit__(None, None, None)
            except Exception as e:
                logger.debug(f"[MCP_POOL] Erreur fermeture forcée {key}: {e}")
            return
        try:
            await entry.client.__aexit__(None, None, None)
        except Exception as e:
            logger.debug(f"[MCP_POOL] Erreur fermeture {key}: {e}")
        finally:
            _release_exclusive(entry, _taken)

    # ── Cleanup périodique des connexions inactives ───────────────────────────

    def _ensure_cleanup_running(self):
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._periodic_cleanup())

    async def _periodic_cleanup(self):
        """Ferme les connexions inactives depuis plus de IDLE_TIMEOUT_SEC.

        BUG FIX #18 — le cleanup vérifie last_used_at mais ne checkait
        pas si entry.lock était verrouillé. Une requête en cours a un
        last_used_at qui vient d'être mis à jour, mais entre la mise à
        jour et l'appel call_tool effectif il y a une fenêtre où le
        cleanup pouvait fermer le client. Maintenant : tentative de
        prendre le lock par-entrée en non-bloquant ; si verrouillé,
        on skip cette entrée pour ce cycle (sera réévaluée au cycle
        suivant). Garantit qu'aucune fermeture ne se fait pendant un
        appel actif.
        """
        while not self._closed:
            try:
                await asyncio.sleep(self._CLEANUP_INTERVAL_SEC)
                now = time.monotonic()
                # Construire la liste des candidates SANS prendre les locks
                # (lecture des champs est atomique en Python).
                candidates = [
                    (key, entry) for key, entry in self._pool.items()
                    if not entry.persistent
                    and entry.last_used_at and (now - entry.last_used_at) > self.IDLE_TIMEOUT_SEC
                ]
                for key, entry in candidates:
                    # ``busy`` couvre les DEUX modes : verrou de cycle de vie
                    # tenu (stdio/appel sériel) ET appels en vol côté sémaphore
                    # (transport concurrent) — sans le second, une entrée SSE
                    # occupée aurait paru libre.
                    if entry.busy:
                        logger.debug(
                            f"[MCP_POOL] Skip cleanup de {key} : connexion en usage"
                        )
                        continue
                    # ORDRE DE VERROUS COHÉRENT — verrou de CLÉ puis
                    # entry.lock, comme tous les autres chemins de cycle de vie
                    # (get_or_connect slow-path, _close_entry, _reconnect —
                    # AUDIT 2026-08-31 : le verrou GLOBAL a cédé la place aux
                    # verrous par clé, cf. _key_lock). MAJ-5 préservée :
                    # l'entrée est retirée du pool SOUS le verrou de clé AVANT
                    # la fermeture → un call_tool concurrent voit
                    # ``self._pool.get(key) is not entry`` (MAJ-1) et
                    # reconnecte, jamais le client en cours de fermeture.
                    acquired: Optional[int] = None
                    try:
                        async with self._key_lock(key):
                            if self._pool.get(key) is not entry:
                                continue
                            if (time.monotonic() - entry.last_used_at) <= self.IDLE_TIMEOUT_SEC:
                                continue
                            acquired = await _acquire_exclusive(entry, timeout=0.1)
                            if acquired is None:
                                continue
                            self._pool.pop(key, None)
                        # Fermeture HORS global_lock (le pool n'est plus figé),
                        # sous exclusivité déjà tenue.
                        logger.info(f"[MCP_POOL] Fermeture connexion inactive: {key}")
                        try:
                            await entry.client.__aexit__(None, None, None)
                        except Exception as e:
                            logger.debug(f"[MCP_POOL] Erreur fermeture {key}: {e}")
                    finally:
                        _release_exclusive(entry, acquired)
                    # AUDIT 2026-09-01 (passe 6, B10) — évince AUSSI le verrou
                    # de cette clé : ``_key_locks`` (clé = serveur × user ×
                    # empreinte d'auth, cardinalité monotone au fil des
                    # rotations de credentials) ne se vidait JAMAIS dans un
                    # process qui vit des semaines (max_requests=0 par défaut).
                    # Sûr : séquence synchrone sur la boucle (pas d'await entre
                    # le test et le pop), et uniquement si le verrou est LIBRE
                    # ET SANS ATTENDEUR. (passe 7, R3) ``locked()`` ne suffit
                    # pas : ``Lock.release()`` pose ``_locked=False`` puis
                    # réveille le 1er attendeur, qui ne repose ``_locked=True``
                    # qu'à SA reprise — entre les deux, un janitor ordonnancé
                    # verrait un verrou « libre » avec une file non vide, le
                    # retirerait, et un ``_key_lock(key)`` suivant créerait un
                    # second verrou → deux sections critiques sur la même clé.
                    # ``_waiters`` est privé mais stable (CPython 3.8 → 3.13).
                    # Un ``_key_lock(key)`` ultérieur en recrée un.
                    _lk = self._key_locks.get(key)
                    if (_lk is not None and not _lk.locked()
                            and not getattr(_lk, "_waiters", None)):
                        self._key_locks.pop(key, None)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[MCP_POOL] Erreur cleanup: {e}")


# ── Singleton ────────────────────────────────────────────────────────────────
mcp_pool = MCPConnectionPool()
