# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/git_ops.py — git d'une sandbox, exécuté par son agent
(L4.4, 2026-09-29).

Source unique des outils git de l'assistant et des routes Git de l'éditeur :
``run`` pour une commande locale, ``run_network`` pour clone, fetch, push et
ls-remote, par le relais authentifiant (``git_relay``), ``pull`` = fetch par
le relais puis fusion locale. git tourne dans le conteneur, sous l'UID de la
sandbox : l'hôte n'exécute plus rien sur un dépôt de l'utilisateur. Les
refus de l'agent remontent en ``AgentError``, ceux du relais en
``RelayRefused``.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from shared_infra.sandbox import git_relay
from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.git_relay import RelayRefused

logger = logging.getLogger("uvicorn.error")

#: Schémas relayés (smart HTTP) ; ``git://`` n'a ni authentification ni relais.
REMOTE_SCHEMES = ("http", "https")

# ``pull`` : fusion de ce que ``git pull`` fusionnerait, en tentatives
# successives (``--rebase`` avance d'abord en rapide, branche non née comprise).
_PULL_MODES = {"--ff-only": (("merge", "--ff-only"),),
               "--no-rebase": (("merge", "--no-edit"),),
               "--rebase": (("merge", "--ff-only"), ("rebase",))}


@dataclass
class GitResult:
    returncode: int
    stdout: str
    stderr: str
    truncated: bool = False
    timed_out: bool = False
    duration_ms: int = 0
    #: Requêtes refusées par le relais pendant l'opération (motifs) : un refus
    #: de politique, à ne pas confondre avec un échec d'authentification.
    refus: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.returncode == 0


async def run(agent: Any, cwd: str, args: Iterable[str], *, timeout_s: float = 60,
              max_out: int = 1 << 20, env: Optional[Dict[str, str]] = None,
              passive: bool = False) -> GitResult:
    """``git <args>`` dans ``cwd`` (relatif à /work). ``passive`` : sondage
    périodique (un conteneur arrêté n'est pas redémarré, ``container_down``)."""
    return GitResult(**await agent.git(cwd, list(args), timeout_s=timeout_s,
                                       max_out=max_out, env=env, passive=passive))


def connector_hosts(uid: int) -> set:
    """Hôtes des connecteurs du compte : permis malgré une adresse privée."""
    try:
        from shared_infra.git.connectors import list_connector_hosts
        return set(list_connector_hosts(int(uid)))
    except Exception:                                           # noqa: BLE001
        return set()


def remote_block_reason(url: str, uid: int) -> Optional[str]:
    """Garde anti-SSRF d'un dépôt distant (mode ``critical_only`` : le LAN est
    permis, boucle locale et métadonnées non ; connecteurs permis)."""
    from shared_infra.git.ssrf import block_remote_url_reason
    return block_remote_url_reason(url, allow_schemes=REMOTE_SCHEMES,
                                   allow_hosts=connector_hosts(uid), critical_only=True)


def _credential(uid: int, url: str) -> Tuple[str, str]:
    try:
        from shared_infra.git.resolver import resolve_git_credential
        cred = resolve_git_credential(int(uid), url) if uid else None
    except Exception:                                           # noqa: BLE001
        logger.warning("[git] connecteur non résolu pour %s", url, exc_info=True)
        cred = None
    if cred and cred.get("token"):
        return str(cred.get("username") or ""), str(cred["token"])
    return "", ""


_ANCIEN_FICHIER = ".git-credentials.json"
_anciens_vus: set = set()


async def import_legacy_credentials(agent: Any, uid: int) -> None:
    """Une fois par processus et par compte : l'ancien
    ``/work/.git-credentials.json`` importé dans les connecteurs, puis
    supprimé (avec sa trace ``.imported``) — lu et supprimé par l'agent.
    Agent injoignable : réessayé à l'opération suivante."""
    if not uid or uid in _anciens_vus:
        return
    try:
        lu = await agent.read(_ANCIEN_FICHIER, max_bytes=1 << 20)
    except AgentError as e:
        if e.code in ("not_found", "is_dir", "not_file", "too_large", "denied", "outside_root"):
            _anciens_vus.add(uid)
        return
    _anciens_vus.add(uid)
    from shared_infra.git.resolver import import_legacy_git_credentials
    await asyncio.to_thread(import_legacy_git_credentials, uid, lu.data)
    for nom in (_ANCIEN_FICHIER, _ANCIEN_FICHIER + ".imported"):
        try:
            await agent.fsop("remove", path=nom, missing_ok=True)
        except AgentError:
            logger.warning("[git] %s non supprimé (compte %s)", nom, uid)


async def remote_urls(agent: Any, cwd: str, remote: str, *, push: bool = False) -> List[str]:
    """URL(s) du remote ``remote`` (``--push`` : celles du push)."""
    r = await run(agent, cwd, ["remote", "get-url", "--all", *(["--push"] if push else []),
                               remote], timeout_s=10, max_out=1 << 16)
    return [u.strip() for u in r.stdout.splitlines() if u.strip()] if r.ok else []


async def remote_url(agent: Any, cwd: str, remote: str, *, push: bool = False) -> str:
    """URL unique du remote, ou ``RelayRefused`` (absent, ou plusieurs URL :
    le relais ne sert qu'un dépôt par opération)."""
    urls = await remote_urls(agent, cwd, remote, push=push)
    if not urls:
        raise RelayRefused("no_remote", f"Remote « {remote} » introuvable")
    if len(urls) > 1:
        raise RelayRefused("multiple_urls",
                           f"Remote « {remote} » : plusieurs URL, non prises en charge par le relais")
    return urls[0]


async def run_network(agent: Any, cwd: str, args: Iterable[str], *, uid: int, url: str,
                      push_refs: Optional[Iterable[str]] = None,
                      auth: Optional[Tuple[str, str]] = None, timeout_s: float = 120,
                      max_out: int = 1 << 20,
                      block_reason: Optional[Callable[[str, int], Optional[str]]] = None
                      ) -> GitResult:
    """Commande git réseau vers ``url`` seule, par le relais : fetch, clone et
    ls-remote (``push_refs`` absent) ou push des seules refs ``push_refs``.
    Authentification : ``auth`` (identifiant, jeton saisis) donné, sinon celle
    du connecteur de l'hôte ; aucune si aucun ne correspond. Les identifiants
    saisis ne partent qu'en réponse à une demande de l'amont (401), comme avec
    git : l'hôte pour lequel ils ont été tapés n'est pas connu ici."""
    garde = block_reason or remote_block_reason
    motif = await asyncio.to_thread(garde, url, uid)
    if motif:
        raise RelayRefused("blocked_remote", f"Dépôt refusé (anti-SSRF) : {motif}")
    git_relay.amont(url)                                # URL relayable, sinon RelayRefused
    await import_legacy_credentials(agent, uid)
    if auth and auth[1]:
        saisis, (user, token) = True, auth
    else:
        saisis, (user, token) = False, await asyncio.to_thread(_credential, uid, url)
    service = git_relay.UPLOAD if push_refs is None else git_relay.RECEIVE
    with git_relay.ticket(agent.relay_dir, uid=uid, url=url, service=service,
                          refs=push_refs or (), duree_s=timeout_s + 60,
                          auth=git_relay.basic_auth(user, token) if token else "",
                          auth_on_challenge=saisis,
                          garde=lambda: garde(url, uid)) as (relay, refus_relais):
        d = await agent.git(cwd, list(args), timeout_s=timeout_s, max_out=max_out,
                            relay=relay)
        refus = list(dict.fromkeys(refus_relais))
    r = GitResult(**d, refus=refus)
    if refus and not r.ok:
        r.stderr = (r.stderr.rstrip("\n") + "\n" + "\n".join(refus)).lstrip("\n")
    return r


async def pull(agent: Any, cwd: str, remote: str, branch: str = "", mode: str = "--ff-only",
               *, uid: int, timeout_s: float = 120, max_out: int = 1 << 20,
               **reseau: Any) -> GitResult:
    """``git pull`` : fetch par le relais, puis fusion locale de la branche
    demandée (``FETCH_HEAD``) ou de l'amont de la branche courante
    (``@{upstream}``) selon ``mode`` (``_PULL_MODES``). ``reseau`` : options
    de ``run_network`` (``auth``, ``block_reason``).

    ``remote`` « . » (branche qui suit une branche locale) : fusion seule,
    sans réseau, comme ``git pull``. Les sous-modules ne sont pas récupérés :
    leur fetch viserait un autre dépôt que celui du ticket (relecture L4.4)."""
    if mode not in _PULL_MODES:
        raise ValueError(f"git pull : mode non pris en charge {mode}")
    if remote == ".":
        f = GitResult(0, "", "")
    else:
        url = await remote_url(agent, cwd, remote)
        f = await run_network(agent, cwd, ["fetch", "--no-recurse-submodules", remote,
                                           *([branch] if branch else [])],
                              uid=uid, url=url, timeout_s=timeout_s, max_out=max_out, **reseau)
        if not f.ok:
            return f
    cible = "FETCH_HEAD" if branch else "@{upstream}"
    for suite in _PULL_MODES[mode]:
        last = await run(agent, cwd, [*suite, cible], timeout_s=timeout_s, max_out=max_out)
        if last.ok:
            break
    return GitResult(last.returncode, f.stdout + last.stdout, f.stderr + last.stderr,
                     f.truncated or last.truncated, last.timed_out,
                     f.duration_ms + last.duration_ms)


_NON_PARCOURUS = ("node_modules", "__pycache__", ".venv", "venv")


async def find_repos(agent: Any, *, depth: int = 3, limit: int = 50,
                     passive: bool = False) -> List[str]:
    """Dépôts (dossier qui contient ``.git``) jusqu'à ``depth`` niveaux sous
    /work, racine exclue ; un dépôt dans un dépôt n'est pas rendu. Chemins
    relatifs à /work, triés, ``limit`` au plus. ``passive`` : cf. ``run``."""
    liste = await agent.list("", depth=depth + 1, max_entries=20000, hidden=True,
                             prune=[".git"], exclude=list(_NON_PARCOURUS),
                             name_contains=".git", deadline_s=10, passive=passive)
    depots = sorted({e["path"].rsplit("/", 1)[0] for e in liste.entries
                     if "/" in e["path"] and e["path"].rsplit("/", 1)[1] == ".git"
                     and e["kind"] in ("dir", "file")})
    hauts = [d for d in depots if not any(d.startswith(o + "/") for o in depots)]
    return hauts[:limit]


__all__ = ["REMOTE_SCHEMES", "GitResult", "RelayRefused", "connector_hosts", "find_repos",
           "import_legacy_credentials", "pull", "remote_block_reason", "remote_url",
           "remote_urls", "run", "run_network"]
