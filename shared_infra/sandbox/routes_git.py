# SPDX-License-Identifier: MIT
"""
backend.routes.sandbox_git — Per-user git operations on sandbox sub-repos.

Each subfolder of a user's sandbox can be an independent Git repo. Every
endpoint takes a ``repo`` parameter (relative to the sandbox root) so a user
can keep several projects side-by-side. ``_depot`` falls back to the
sandbox root if it is itself a repo, which keeps the legacy single-repo UX
working unchanged.

Endpoint groups (see ``@router`` decorators below)
--------------------------------------------------
Discovery
- GET    /api/sandbox/git/repos
- GET    /api/sandbox/git/status
- GET    /api/sandbox/git/branches
- GET    /api/sandbox/git/log
- GET    /api/sandbox/git/diff
- GET    /api/sandbox/git/tree
- GET    /api/sandbox/git/commit-diff
- GET    /api/sandbox/git/show-file

Setup
- POST   /api/sandbox/git/init
- POST   /api/sandbox/git/clone

Index management
- POST   /api/sandbox/git/stage
- POST   /api/sandbox/git/unstage
- POST   /api/sandbox/git/discard
- POST   /api/sandbox/git/commit

Remote sync
- POST   /api/sandbox/git/push
- POST   /api/sandbox/git/pull
- POST   /api/sandbox/git/fetch
- POST   /api/sandbox/git/remote
- POST   /api/sandbox/git/config

Branching / history rewriting
- POST   /api/sandbox/git/checkout
- POST   /api/sandbox/git/merge
- POST   /api/sandbox/git/merge-abort
- POST   /api/sandbox/git/merge-resolve
- GET    /api/sandbox/git/merge-preview
- POST   /api/sandbox/git/rebase
- POST   /api/sandbox/git/stash
- POST   /api/sandbox/git/restore-commit
- POST   /api/sandbox/git/revert-last

Exécution (L4.4, 2026-09-29)
----------------------------
git tourne dans la sandbox, par son agent (``git_ops``) : chemins relatifs à
/work, jamais un chemin de l'hôte ; ce qu'un dépôt fait exécuter (filtres,
pilotes) reste dans le conteneur. Réseau (clone, fetch, pull, push) par le
relais authentifiant (``git_relay``) : l'identifiant du connecteur n'entre
jamais dans la sandbox, un push ne touche que les refs de la route.
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any, List, NamedTuple, Optional, Set, Tuple
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from shared_infra.accounts.users import get_username_by_id

# Git repos live in the WORK root (``P/work``, bind-mounted as ``/work``),
# NOT in the per-user root ``P`` (which also holds skills/.memory, outside
# the mount). Seulement pour le calcul lexical des chemins reçus.
from shared_infra.routes._helpers import TREE_MAX_ENTRIES, _get_work_path
from shared_infra.routes._state import router
from shared_infra.sandbox import git_ops
from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.exec_bridge import agent_for, agent_http
from shared_infra.sandbox.git_ops import GitResult, RelayRefused
from shared_infra.sandbox.paths import SandboxPathError, lexical_rel
from shared_infra.security.deps import require_user_id

_SORTIE = 8 << 20                     # sortie gardée d'une commande git (diff, show…)


# ── Valeurs utilisateur passées à git (audit 2026-09-22, H4) ──────────────
# Une valeur qui commence par « - » est lue par git comme une OPTION :
# ``hash=--output=/chemin`` écrivait un fichier sur l'hôte (show/log),
# ``branch=--exec=cmd`` lançait une commande au ``rebase``. Tout nom de
# branche, remote ou commit venu du client passe donc par ces gardes.
_REF_RE = re.compile(r"[A-Za-z0-9._/@~^+\-]{1,255}")
_HASH_RE = re.compile(r"[0-9a-fA-F]{4,64}")


def _ref_arg(value, what: str = "Référence") -> str:
    v = value.strip() if isinstance(value, str) else ""
    if not v or v.startswith("-") or not _REF_RE.fullmatch(v):
        raise HTTPException(400, f"{what} invalide")
    return v


def _hash_arg(value) -> str:
    v = value.strip() if isinstance(value, str) else ""
    if not _HASH_RE.fullmatch(v):
        raise HTTPException(400, "Hash invalide")
    return v


def _paths_arg(paths) -> list:
    if not isinstance(paths, list) or not all(isinstance(p, str) and p for p in paths):
        raise HTTPException(400, "paths : liste de chemins")
    return paths


# ─────────────────────────────────────────────────────────────────────────────
# Dépôts distants (anti-SSRF)
# ─────────────────────────────────────────────────────────────────────────────
# Une URL de remote n'est suivie que par le relais (``git_ops.run_network``),
# qui refait la garde à chaque opération : ``.git/config`` modifié depuis la
# sandbox n'y change rien. ``_validate_git_url`` donne la même réponse dès la
# saisie (clone, remote add / set-url).


def _validate_git_url(url: str, uid: int = 0) -> None:
    """403 si ``url`` n'est pas un dépôt distant permis (garde de ``git_ops`` :
    HTTP(S), boucle locale et métadonnées refusées, LAN et connecteurs du
    compte permis)."""
    if not url or not isinstance(url, str):
        raise HTTPException(400, "URL manquante")
    reason = git_ops.remote_block_reason(url, uid)
    if reason:
        raise HTTPException(403, f"URL refusée (anti-SSRF) : {reason}")


# ─────────────────────────────────────────────────────────────────────────────
# Dépôt d'une requête et commandes git, par l'agent de la sandbox
# ─────────────────────────────────────────────────────────────────────────────
class _Depot(NamedTuple):
    """Un dépôt du compte : l'agent de sa sandbox, et son chemin relatif à
    /work (``""`` : la racine)."""
    uid: int
    agent: Any
    rel: str


def _rel(uid: int, chemin: str) -> str:
    """Chemin relatif à /work d'un chemin reçu, sans lire le disque (``~`` est
    un nom, comme dans l'explorateur) ; hors de la sandbox : 403."""
    try:
        return lexical_rel(_get_work_path(uid), chemin, tilde=False)
    except SandboxPathError:
        raise HTTPException(403, "Chemin hors sandbox") from None


async def _relaye(coro):
    """``await coro`` ; refus du relais ou de l'agent en ``HTTPException``."""
    try:
        return await coro
    except RelayRefused as e:
        raise HTTPException(403 if e.code == "blocked_remote" else 400, e.message) from None
    except AgentError as e:
        raise agent_http(e, "Git") from None


async def _depot(uid: int, repo_rel: str, *, passive: bool = False) -> _Depot:
    """Le dépôt ``repo_rel`` du compte, ou la racine si ``repo_rel`` est vide
    et qu'elle en est un : 400 (pas un dépôt), 403 (hors sandbox), 404.
    ``passive`` (rafraîchissement de l'éditeur) : conteneur arrêté → 503,
    sans le redémarrer."""
    agent = agent_for(uid)
    rel = _rel(uid, repo_rel) if repo_rel else ""
    dossier, marque = await _relaye(agent.stat([rel, f"{rel}/.git" if rel else ".git"],
                                               passive=passive))
    if dossier.get("outside") or dossier.get("error") == "outside_root":
        raise HTTPException(403, "Chemin hors sandbox")
    if dossier.get("kind") != "dir":
        raise HTTPException(404, f"Dossier introuvable : {repo_rel}")
    if marque.get("kind") in ("missing", "error"):
        raise HTTPException(400, f"'{repo_rel}' n'est pas un dépôt Git" if repo_rel
                            else "Paramètre 'repo' requis (chemin du dépôt)")
    return _Depot(uid, agent, rel)


async def _git(d: _Depot, *args: str, timeout: float = 30, passive: bool = False) -> GitResult:
    """``git <args>`` dans le dépôt ; échéance → 504. ``passive`` : cf. ``_depot``."""
    r = await _relaye(git_ops.run(d.agent, d.rel, args, timeout_s=timeout, max_out=_SORTIE,
                                  passive=passive))
    if r.timed_out:
        raise HTTPException(504, f"git {args[0]} : délai dépassé")
    return r


def _auth(data: dict) -> Optional[Tuple[str, str]]:
    """Identifiants donnés dans la requête : prioritaires sur le connecteur."""
    jeton = (data.get("cred_token") or "").strip()
    return ((data.get("cred_user") or "").strip(), jeton) if jeton else None


def _refus_relais(r: GitResult) -> None:
    """Requête refusée par le relais (politique, et non authentification) :
    409 avec les seuls motifs du relais. Le message de git (« HTTP 403 »)
    faisait ouvrir la saisie d'identifiants à l'éditeur, en boucle
    (relecture L4.4)."""
    if r.refus and not r.ok:
        raise HTTPException(409, "\n".join(r.refus)[:500])


async def _reseau(d: _Depot, args: List[str], *, url: str, data: dict,
                  push_refs: Optional[Set[str]] = None, timeout: float = 60) -> GitResult:
    """Commande réseau vers ``url`` par le relais (identifiants : ``_auth``,
    sinon le connecteur) ; échéance → 504, refus du relais → 409."""
    r = await _relaye(git_ops.run_network(
        d.agent, d.rel, args, uid=d.uid, url=url, push_refs=push_refs, auth=_auth(data),
        timeout_s=timeout, max_out=_SORTIE))
    if r.timed_out:
        raise HTTPException(504, f"git {args[0]} : délai dépassé")
    _refus_relais(r)
    return r


# Porcelaine de ``git push --dry-run --porcelain`` : « <drapeau>\t<src>:<dst>\t… ».
# Drapeaux mis à jour : avance rapide « », forcé « + », nouveau « * ».
_PUSH_MAJ = (" ", "+", "*")


def _refs_porcelaine(sortie: str) -> Tuple[Set[str], List[str]]:
    """(refs mises à jour, refs supprimées) d'un ``push --dry-run --porcelain``."""
    refs: Set[str] = set()
    suppressions: List[str] = []
    for ligne in sortie.splitlines():
        if len(ligne) > 2 and ligne[1] == "\t" and ligne[0] in (*_PUSH_MAJ, "-"):
            dst = ligne[2:].split("\t", 1)[0].rpartition(":")[2]
            if not dst.startswith("refs/"):
                continue
            if ligne[0] == "-":
                suppressions.append(dst)
            else:
                refs.add(dst)
    return refs, suppressions


async def _refs_du_push(d: _Depot, args: List[str], *, url: str, data: dict) -> Set[str]:
    """Refs que ``git push <args>`` mettrait à jour, d'après git lui-même
    (``--dry-run --porcelain``, qui ne lit que la liste des refs de l'amont) :
    ``push.followTags``, ``remote.<r>.push`` et ``push.default`` sont suivis
    comme avant L4.4 (relecture). Le relais n'en laisse passer aucune autre,
    ni aucune suppression."""
    essai = await _reseau(d, ["push", "--dry-run", "--porcelain", *args], url=url,
                          data=data, push_refs=set())
    if essai.returncode not in (0, 1):                   # 1 : une ref serait refusée
        err = (essai.stderr or essai.stdout or "").strip()
        raise HTTPException(400, err[:500])
    refs, suppressions = _refs_porcelaine(essai.stdout)
    if suppressions:
        raise HTTPException(409, "Relais Git : suppression de "
                            + ", ".join(suppressions[:5]) + " refusée")
    return refs


async def _remote_suivi(d: _Depot) -> str:
    """Remote de la branche courante (``branch.<b>.remote``), sinon origin.
    « . » : la branche suit une branche locale (fusion sans réseau)."""
    b = (await _git(d, "branch", "--show-current")).stdout.strip()
    if b:
        r = await _git(d, "config", "--get", f"branch.{b}.remote")
        nom = r.stdout.strip()
        if r.ok and nom == ".":
            return "."
        if r.ok and nom:
            return _ref_arg(nom, "Remote de la branche")
    return "origin"


async def _mode_pull(d: _Depot, rebase: bool) -> str:
    """« Pull (rebase) » : rebase. « Pull » : ce que ferait ``git pull`` avec
    la configuration du dépôt (``pull.rebase``, ``pull.ff``) ; par défaut,
    avance rapide seule."""
    if rebase:
        return "--rebase"
    r = await _git(d, "config", "--get", "pull.rebase")
    valeur = r.stdout.strip().lower() if r.ok else ""
    if valeur in ("true", "merges", "interactive", "i", "m", "1", "yes", "on"):
        return "--rebase"
    if valeur in ("false", "0", "no", "off"):
        return "--no-rebase"
    ff = await _git(d, "config", "--get", "pull.ff")
    if ff.ok and ff.stdout.strip().lower() in ("false", "0", "no", "off", "true", "1", "yes", "on"):
        return "--no-rebase"
    return "--ff-only"


def _dans_depot(d: _Depot, p: str) -> Optional[str]:
    """``p`` (relatif au dépôt) en chemin relatif à /work, s'il reste dans le
    dépôt (``..`` résolu sur le texte) ; sinon ``None``."""
    if not p or p.startswith("/") or "\x00" in p:
        return None
    parties: List[str] = []
    for c in p.split("/"):
        if c in ("", "."):
            continue
        if c == "..":
            if not parties:
                return None
            parties.pop()
        else:
            parties.append(c)
    if not parties:
        return None
    return "/".join([d.rel, *parties] if d.rel else parties)


# Arbre d'un dépôt : ni liens suivis ni entrées cachées (l'agent parcourt en
# ``lstat`` et garde tout sous /work), profondeur bornée.
_TREE_MAX_DEPTH = 40


async def _branches_courantes(agent: Any, depots: List[str]) -> dict:
    """Branche courante de chaque dépôt : ``.git/HEAD`` lus en une requête,
    ``git branch --show-current`` quand HEAD n'est pas un fichier du dépôt
    (``.git`` fichier : worktree, sous-module)."""
    tetes = {p: f"{p}/.git/HEAD" if p else ".git/HEAD" for p in depots}
    lus = await agent.read_many(list(tetes.values()), max_file=4096, max_total=1 << 20,
                                passive=True)
    rendu = {}
    for p, f in tetes.items():
        brut = lus.get(f)
        if brut is not None:
            t = brut.decode("utf-8", "replace").strip()
            rendu[p] = t[len("ref: refs/heads/"):] if t.startswith("ref: refs/heads/") else ""
        else:
            r = await git_ops.run(agent, p, ["branch", "--show-current"], timeout_s=10,
                                  max_out=4096, passive=True)
            rendu[p] = r.stdout.strip() if r.ok else ""
    return rendu


@router.get("/api/sandbox/git/repos")
async def api_git_repos(request: Request):
    """Dépôts de la sandbox (dossier qui contient ``.git``) : la racine, puis
    ceux des deux premiers niveaux, hors dossiers cachés et liens. Appelée au
    retour sur la fenêtre : sondée en passif (conteneur arrêté → 503, sans le
    redémarrer)."""
    uid = require_user_id(request)
    agent = agent_for(uid)
    try:
        (racine,) = await agent.stat([".git"], passive=True)
        depots = [p for p in await git_ops.find_repos(agent, depth=2, limit=500, passive=True)
                  if not any(c.startswith(".") for c in p.split("/"))]
        if racine.get("kind") in ("dir", "file"):
            depots.insert(0, "")
        branches = await _branches_courantes(agent, depots)
    except AgentError as e:
        raise agent_http(e, "Dépôts Git") from None
    nom_racine = _get_work_path(uid).name
    return {"repos": [{"path": p or ".", "name": p.rsplit("/", 1)[-1] if p else nom_racine,
                       "branch": branches.get(p) or "(HEAD)"} for p in depots]}


@router.get("/api/sandbox/git/status")
async def api_git_status(request: Request):
    uid = require_user_id(request)
    repo_rel = request.query_params.get("repo", "")
    # Rafraîchi après chaque enregistrement et au retour sur la fenêtre :
    # appels passifs (conteneur arrêté → 503, ni redémarré ni compté actif).
    try:
        d = await _depot(uid, repo_rel, passive=True)
    except HTTPException as e:
        if e.status_code in (400, 403, 404):             # pas un dépôt (agent joint)
            return {"is_repo": False}
        raise
    # Commandes en lecture seule, indépendantes : lancées ensemble.
    branch_r, ab, st, remote_r, ns, ns2 = await asyncio.gather(*(
        _git(d, *args, passive=True) for args in (
            ("branch", "--show-current"),
            ("rev-list", "--left-right", "--count", "HEAD...@{upstream}"),
            ("status", "--porcelain=v1", "-uall"),
            ("remote", "get-url", "origin"),
            ("diff", "--cached", "--numstat"),
            ("diff", "--numstat"))))
    branch = branch_r.stdout.strip() or "(HEAD détaché)"
    # Ahead/behind
    ahead, behind = 0, 0
    if ab.returncode == 0:
        parts = ab.stdout.strip().split()
        if len(parts) == 2:
            ahead, behind = int(parts[0]), int(parts[1])
    # Porcelain status
    staged: List[dict] = []
    modified: List[dict] = []
    untracked: List[dict] = []
    conflicted: List[dict] = []
    for line in st.stdout.splitlines():
        if len(line) < 4:
            continue
        x, y = line[0], line[1]
        fpath = line[3:]
        if " -> " in fpath:
            fpath = fpath.split(" -> ")[-1]
        # Conflit de fusion (UU, AA, DD, AU, UA, DU, UD) : ni indexé ni
        # modifié — l'éditeur le résout fichier par fichier.
        if x == "U" or y == "U" or line[:2] in ("AA", "DD"):
            conflicted.append({"path": fpath, "status": line[:2]})
            continue
        if x in ("A", "M", "D", "R", "C"):
            staged.append({"path": fpath, "status": x})
        if y in ("M", "D"):
            modified.append({"path": fpath, "status": y})
        elif y == "?" and x == "?":
            untracked.append({"path": fpath})
    # Remote URL
    remote_url = remote_r.stdout.strip() if remote_r.returncode == 0 else ""
    # Per-file line stats (numstat)
    _numstat_staged = {}
    for line in ns.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            add = parts[0] if parts[0] != "-" else "0"
            rem = parts[1] if parts[1] != "-" else "0"
            _numstat_staged[parts[2]] = {"add": int(add), "del": int(rem)}
    _numstat_unstaged = {}
    for line in ns2.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            add = parts[0] if parts[0] != "-" else "0"
            rem = parts[1] if parts[1] != "-" else "0"
            _numstat_unstaged[parts[2]] = {"add": int(add), "del": int(rem)}
    for f in staged:
        ns_data = _numstat_staged.get(f["path"], {})
        f["add"] = ns_data.get("add", 0)
        f["del"] = ns_data.get("del", 0)
    for f in modified:
        ns_data = _numstat_unstaged.get(f["path"], {})
        f["add"] = ns_data.get("add", 0)
        f["del"] = ns_data.get("del", 0)
    return {
        "is_repo": True,
        "repo": repo_rel or ".",
        "branch": branch,
        "ahead": ahead, "behind": behind,
        "remote_url": remote_url,
        "staged": staged, "modified": modified, "untracked": untracked,
        "conflicted": conflicted, "truncated": st.truncated,
    }


@router.get("/api/sandbox/git/branches")
async def api_git_branches(request: Request):
    uid = require_user_id(request)
    d = await _depot(uid, request.query_params.get("repo", ""))
    r = await _git(d, "branch", "--format=%(refname:short)|%(HEAD)")
    local = []
    current = ""
    for line in r.stdout.splitlines():
        parts = line.split("|")
        name = parts[0].strip()
        if len(parts) > 1 and parts[1].strip() == "*":
            current = name
        local.append(name)
    if not current:
        bc = await _git(d, "branch", "--show-current")
        current = bc.stdout.strip()
    rr = await _git(d, "branch", "-r", "--format=%(refname:short)")
    remote = [b.strip() for b in rr.stdout.splitlines() if b.strip() and "HEAD" not in b]
    return {"current": current, "local": local, "remote": remote}


@router.get("/api/sandbox/git/log")
async def api_git_log(request: Request):
    uid = require_user_id(request)
    d = await _depot(uid, request.query_params.get("repo", ""))
    try:
        n = max(1, min(int(request.query_params.get("n", "30")), 100))
    except ValueError:
        raise HTTPException(400, "n invalide")
    r = await _git(d, "log", f"-{n}", "--format=%H|%h|%an|%ae|%at|%s")
    commits = []
    for line in r.stdout.splitlines():
        parts = line.split("|", 5)
        if len(parts) >= 6:
            commits.append({
                "hash": parts[0], "short": parts[1],
                "author": parts[2], "email": parts[3],
                "timestamp": int(parts[4]), "message": parts[5],
            })
    return {"commits": commits}


@router.get("/api/sandbox/git/diff")
async def api_git_diff(request: Request):
    uid = require_user_id(request)
    d = await _depot(uid, request.query_params.get("repo", ""))
    file_path = request.query_params.get("path", "")
    is_staged = request.query_params.get("staged", "") == "1"
    args = ["diff", "--no-color"]
    if is_staged:
        args.append("--cached")
    if file_path:
        args.extend(["--", file_path])
    r = await _git(d, *args)
    return {"diff": r.stdout, "truncated": r.truncated}


@router.post("/api/sandbox/git/init")
async def api_git_init(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    dir_name = (data.get("dir") or "").strip()
    d = _Depot(uid, agent_for(uid), _rel(uid, dir_name) if dir_name else "")
    if d.rel:
        await _relaye(d.agent.fsop("mkdir", path=d.rel, parents=True))
    r = await _git(d, "init")
    if r.returncode != 0:
        raise HTTPException(500, r.stderr.strip())
    uname = (data.get("user_name") or "").strip()
    email = (data.get("user_email") or "").strip()
    if uname:
        await _git(d, "config", "user.name", uname)
    if email:
        await _git(d, "config", "user.email", email)
    return {"ok": True, "repo": dir_name or ".", "message": r.stdout.strip()}


@router.post("/api/sandbox/git/clone")
async def api_git_clone(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    url = (data.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "URL requise")
    # Garde anti-SSRF dès la saisie (le relais la refait) ; DNS et base : hors boucle.
    await asyncio.to_thread(_validate_git_url, url, uid)
    # Determine target directory name
    dir_name = (data.get("dir") or "").strip()
    if not dir_name:
        # Extract repo name from URL: "https://…/my-repo.git" → "my-repo"
        match = re.search(r'/([^/]+?)(?:\.git)?/?$', url)
        dir_name = match.group(1) if match else "repo"
    # Un seul composant, sous la racine de travail.
    if "/" in dir_name or "\\" in dir_name or ".." in dir_name.split("/"):
        raise HTTPException(400, "Nom de dossier invalide")
    racine = _Depot(uid, agent_for(uid), "")
    rel = _rel(uid, dir_name)
    if not rel:
        raise HTTPException(400, "Nom de dossier invalide")
    # Refuse if target already exists and is not empty
    (cible,) = await _relaye(racine.agent.stat([rel]))
    existait = cible.get("kind") != "missing"
    if existait and (cible.get("kind") != "dir" or (await _relaye(racine.agent.list(
            rel, depth=1, max_entries=1, hidden=True))).entries):
        raise HTTPException(409, f"Le dossier '{dir_name}' existe déjà et n'est pas vide")
    try:
        r = await _reseau(racine, ["clone", "--progress", "--", url, rel], url=url, data=data,
                          timeout=120)
        if r.returncode != 0:
            err = (r.stderr or r.stdout or "").strip()
            raise HTTPException(400, err[:500])
    except HTTPException:
        # Échec, délai dépassé (git tué à l'échéance ne nettoie rien) ou refus :
        # le clone partiel est retiré, sinon le nouvel essai répondrait 409.
        if not existait:
            try:
                await racine.agent.fsop("remove", path=rel, recursive=True, missing_ok=True)
            except AgentError:
                pass
        raise
    # AUDIT 2026-08-02 — si l'utilisateur a fourni des creds EXPLICITES au clone
    # (champ token du dialogue, override), on les PERSISTE keyés sur le host de
    # l'URL → push/pull/PR et clones futurs les réutilisent sans nouvelle saisie
    # (plus besoin de créer/matcher un connecteur à la main).
    _saved = False
    if (data.get("cred_token") or "").strip():
        def _save_clone_cred():
            try:
                from shared_infra.git.resolver import save_git_credential
                return bool(save_git_credential(
                    int(uid), url, (data.get("cred_user") or "").strip(),
                    (data.get("cred_token") or "").strip(),
                    (data.get("provider_type") or "").strip()))
            except Exception:
                return False
        _saved = await asyncio.to_thread(_save_clone_cred)
    return {"ok": True, "repo": dir_name, "message": f"Cloné dans {dir_name}/",
            "credentials_saved": _saved}


@router.post("/api/sandbox/git/stage")
async def api_git_stage(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    paths = _paths_arg(data.get("paths") or [])
    if not paths:
        r = await _git(d, "add", "-A")
    else:
        r = await _git(d, "add", "--", *paths)
    if r.returncode != 0:
        raise HTTPException(400, r.stderr.strip())
    return {"ok": True}


@router.post("/api/sandbox/git/unstage")
async def api_git_unstage(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    paths = _paths_arg(data.get("paths") or [])
    if not paths:
        r = await _git(d, "reset", "HEAD")
    else:
        r = await _git(d, "reset", "HEAD", "--", *paths)
    if r.returncode != 0:
        raise HTTPException(400, r.stderr.strip())
    return {"ok": True}


@router.post("/api/sandbox/git/discard")
async def api_git_discard(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    paths = data.get("paths", [])
    if not paths:
        # Discard ALL: restore tracked + remove untracked
        await _git(d, "checkout", "--", ".")
        await _git(d, "clean", "-fd")
    else:
        for p in _paths_arg(paths):
            cible = _dans_depot(d, p)
            if cible is None:
                continue
            # Try git checkout (works for tracked modified files)
            r = await _git(d, "checkout", "--", p)
            if r.returncode != 0 and await _parents_sans_lien(d, cible):
                # Non suivi ou nouveau : retiré (un lien : lui-même).
                await _relaye(d.agent.fsop("remove", path=cible, recursive=True,
                                           missing_ok=True))
    return {"ok": True}


async def _parents_sans_lien(d: _Depot, cible: str) -> bool:
    """Aucun dossier entre le dépôt et ``cible`` n'est un lien : l'agent suit
    les liens des dossiers parents, un « lnk/fichier » aurait été supprimé
    hors du dépôt (relecture L4.4)."""
    base = f"{d.rel}/" if d.rel else ""
    parties = cible[len(base):].split("/")[:-1]
    parents = [base + "/".join(parties[:i + 1]) for i in range(len(parties))]
    if not parents:
        return True
    entrees = await _relaye(d.agent.stat(parents))
    return all(e.get("kind") == "dir" and not e.get("link") for e in entrees)


@router.post("/api/sandbox/git/commit")
async def api_git_commit(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    message = (data.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "Message requis")
    username = get_username_by_id(uid) or "user"
    r = await _git(d, "commit", "-m", message, "--author", f"{username} <{username}@elpis>")
    if r.returncode != 0:
        err = r.stderr.strip() or r.stdout.strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": r.stdout.strip()[:200]}


@router.post("/api/sandbox/git/push")
async def api_git_push(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    remote = _ref_arg(data.get("remote") or "origin", "Remote")
    branch = _ref_arg(data["branch"], "Branche") if data.get("branch") else ""
    url = await _relaye(git_ops.remote_url(d.agent, d.rel, remote, push=True))
    args = ["--force-with-lease"] if data.get("force", False) else []
    args += ["--end-of-options", remote] + ([branch] if branch else [])
    # Le relais ne laisse passer que ces refs (ni suppression, ni autre).
    refs = await _refs_du_push(d, args, url=url, data=data)
    if not refs:
        return {"ok": True, "message": "Déjà à jour"}
    r = await _reseau(d, ["push", *args], url=url, data=data, push_refs=refs)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stderr or r.stdout).strip()[:200]}


@router.post("/api/sandbox/git/pull")
async def api_git_pull(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    # Fetch du remote de la branche par le relais, puis fusion locale de son
    # amont, selon le bouton et la configuration du dépôt (``_mode_pull``).
    mode = await _mode_pull(d, bool(data.get("rebase", False)))
    r = await _relaye(git_ops.pull(d.agent, d.rel, await _remote_suivi(d), "", mode, uid=uid,
                                   timeout_s=60, max_out=_SORTIE, auth=_auth(data)))
    if r.timed_out:
        raise HTTPException(504, "git pull : délai dépassé")
    _refus_relais(r)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stdout or r.stderr).strip()[:200]}


@router.post("/api/sandbox/git/fetch")
async def api_git_fetch(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    # ``fetch --all --prune`` : chaque remote HTTP(S) par le relais, un ticket
    # chacun ; les autres (chemin local, ssh…) ne passent pas par Elpis.
    ignores = []
    for nom in (await _git(d, "remote")).stdout.split():
        urls = [] if nom.startswith("-") or not _REF_RE.fullmatch(nom) else \
            await _relaye(git_ops.remote_urls(d.agent, d.rel, nom))
        if len(urls) != 1 or urlsplit(urls[0]).scheme not in git_ops.REMOTE_SCHEMES:
            ignores.append(nom)
            continue
        # Sans identifiants saisis (plusieurs hôtes possibles : ils ne sont
        # tapés que pour un push ou un pull) ni sous-modules (autres dépôts
        # que celui du ticket).
        r = await _reseau(d, ["fetch", "--prune", "--no-recurse-submodules",
                              "--end-of-options", nom], url=urls[0], data={})
        if r.returncode != 0:
            raise HTTPException(400, (r.stderr or "").strip()[:300])
    return {"ok": True, **({"skipped": ignores} if ignores else {})}


@router.post("/api/sandbox/git/checkout")
async def api_git_checkout(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    branch = _ref_arg(data.get("branch"), "Branche")
    create = data.get("create", False)
    # ``-b`` prend l'argument suivant pour nom : ``-b --end-of-options x``
    # créait « --end-of-options » (bouton cassé depuis 8218cc0). ``_ref_arg``
    # refuse déjà un nom qui commence par « - ».
    args = ["checkout", "-b", branch] if create else ["checkout", "--end-of-options", branch]
    r = await _git(d, *args)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stderr or r.stdout).strip()[:200]}


@router.post("/api/sandbox/git/merge")
async def api_git_merge(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    branch = _ref_arg(data.get("branch"), "Branche")
    strategy = data.get("strategy", "")  # "", "theirs", "ours"
    args = ["merge", "--no-edit"]
    if strategy in ("theirs", "ours"):
        args += ["-X", strategy]
    args += ["--end-of-options", branch]
    r = await _git(d, *args)
    if r.returncode == 0:
        return {"ok": True, "conflicts": False, "message": r.stdout.strip()[:200]}
    # Check for conflicts
    st = await _git(d, "status", "--porcelain=v1")
    conflicted = []
    for line in st.stdout.splitlines():
        if len(line) >= 4 and line[0] == 'U' or (len(line) >= 4 and line[1] == 'U') or line[:2] in ('AA', 'DD'):
            fpath = line[3:]
            conflicted.append(fpath)
    if conflicted:
        return {"ok": False, "conflicts": True, "conflicted_files": conflicted,
                "message": f"{len(conflicted)} fichier(s) en conflit"}
    # Non-conflict error
    err = (r.stderr or r.stdout or "").strip()
    # Abort the failed merge to leave repo clean
    await _git(d, "merge", "--abort")
    raise HTTPException(400, err[:500])


@router.post("/api/sandbox/git/merge-abort")
async def api_git_merge_abort(request: Request):
    """Abort an in-progress merge."""
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    r = await _git(d, "merge", "--abort")
    if r.returncode != 0:
        # Fallback: hard reset
        await _git(d, "reset", "--hard", "HEAD")
    return {"ok": True}


@router.post("/api/sandbox/git/merge-resolve")
async def api_git_merge_resolve(request: Request):
    """Resolve merge conflicts with a strategy."""
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    strategy = data.get("strategy", "theirs")  # "theirs" or "ours"
    if strategy not in ("ours", "theirs"):
        raise HTTPException(400, "strategy : ours ou theirs")
    files = data.get("files") or []  # empty = all conflicted
    if not isinstance(files, list) or not all(isinstance(f, str) and f for f in files):
        raise HTTPException(400, "files : liste de chemins")
    if not files:
        # Resolve all conflicted files
        st = await _git(d, "status", "--porcelain=v1")
        for line in st.stdout.splitlines():
            if len(line) >= 4 and (line[0] == 'U' or line[1] == 'U' or line[:2] in ('AA', 'DD')):
                files.append(line[3:])
    for f in files:
        await _git(d, "checkout", f"--{strategy}", "--", f)
        await _git(d, "add", "--", f)
    # Auto-commit if all conflicts resolved
    st2 = await _git(d, "status", "--porcelain=v1")
    still_conflicted = any(
        (len(l) >= 4 and (l[0] == 'U' or l[1] == 'U' or l[:2] in ('AA', 'DD')))
        for l in st2.stdout.splitlines()
    )
    if not still_conflicted:
        username = get_username_by_id(uid) or "user"
        await _git(d, "commit", "--no-edit", "--author", f"{username} <{username}@elpis>")
    return {"ok": True, "resolved": len(files),
            "all_resolved": not still_conflicted}


@router.get("/api/sandbox/git/merge-preview")
async def api_git_merge_preview(request: Request):
    """Preview what merging a branch would change."""
    uid = require_user_id(request)
    d = await _depot(uid, request.query_params.get("repo", ""))
    branch = _ref_arg(request.query_params.get("branch"), "Branche")
    # Commits that would be merged
    r_log = await _git(d, "log", "--oneline", f"HEAD..{branch}", "--format=%h|%s|%an")
    commits = []
    for line in r_log.stdout.strip().splitlines():
        parts = line.split("|", 2)
        if len(parts) >= 3:
            commits.append({"short": parts[0], "message": parts[1], "author": parts[2]})
    # File changes (numstat)
    r_stat = await _git(d, "diff", "--numstat", f"HEAD...{branch}")
    files: List[dict] = []
    for line in r_stat.stdout.strip().splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            add = int(parts[0]) if parts[0] != "-" else 0
            rem = int(parts[1]) if parts[1] != "-" else 0
            files.append({"path": parts[2], "add": add, "del": rem})
    # Summary
    total_add = sum(f["add"] for f in files)
    total_del = sum(f["del"] for f in files)
    return {
        "branch": branch,
        "commits": commits,
        "files": files,
        "total_add": total_add,
        "total_del": total_del,
    }


@router.post("/api/sandbox/git/rebase")
async def api_git_rebase(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    branch = (data.get("branch") or "").strip()
    abort = data.get("abort", False)
    cont = data.get("continue", False)
    if abort:
        r = await _git(d, "rebase", "--abort")
    elif cont:
        r = await _git(d, "rebase", "--continue")
    elif branch:
        r = await _git(d, "rebase", "--end-of-options", _ref_arg(branch, "Branche"))
    else:
        raise HTTPException(400, "Branche requise")
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stdout or r.stderr).strip()[:200]}


@router.post("/api/sandbox/git/stash")
async def api_git_stash(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    action = data.get("action", "push")
    if action == "push":
        msg = data.get("message", "")
        args = ["stash", "push"]
        if msg:
            args.extend(["-m", msg])
        r = await _git(d, *args)
    elif action == "pop":
        r = await _git(d, "stash", "pop")
    elif action == "list":
        r = await _git(d, "stash", "list")
        return {"ok": True, "stashes": r.stdout.strip().splitlines()}
    elif action == "drop":
        r = await _git(d, "stash", "drop")
    else:
        raise HTTPException(400, "Action invalide")
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stdout or r.stderr).strip()[:200]}


@router.post("/api/sandbox/git/remote")
async def api_git_remote(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    url = (data.get("url") or "").strip()
    name = _ref_arg(data.get("name") or "origin", "Nom de remote")
    if not url:
        raise HTTPException(400, "URL requise")
    # Même garde que le relais, dès la saisie (DNS et base : hors boucle).
    await asyncio.to_thread(_validate_git_url, url, uid)
    r = await _git(d, "remote", "set-url", name, url)
    if r.returncode != 0:
        r = await _git(d, "remote", "add", name, url)
    if r.returncode != 0:
        raise HTTPException(400, (r.stderr or "").strip()[:300])
    return {"ok": True}


@router.post("/api/sandbox/git/config")
async def api_git_config(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    for key in ("user.name", "user.email"):
        val = (data.get(key) or "").strip()
        if val:
            await _git(d, "config", key, val)
    return {"ok": True}


@router.get("/api/sandbox/git/tree")
async def api_git_tree(request: Request):
    """File tree of a specific repo : liste de l'agent (liens ni listés ni
    suivis, entrées cachées exclues, profondeur ``_TREE_MAX_DEPTH`` + 1).
    Rafraîchi au retour sur la fenêtre : dépôt sondé en passif."""
    from shared_infra.sandbox.routes_files import _arbre
    uid = require_user_id(request)
    d = await _depot(uid, request.query_params.get("repo", ""), passive=True)
    liste = await _relaye(d.agent.list(d.rel, depth=_TREE_MAX_DEPTH + 1, hidden=False,
                                       max_entries=TREE_MAX_ENTRIES, passive=True))
    n = len(d.rel) + 1 if d.rel else 0
    return {"items": _arbre([{**e, "path": e["path"][n:]} for e in liste.entries]),
            "truncated": liste.truncated}


@router.get("/api/sandbox/git/commit-diff")
async def api_git_commit_diff(request: Request):
    """Show the diff of a specific commit + list of changed files."""
    uid = require_user_id(request)
    d = await _depot(uid, request.query_params.get("repo", ""))
    h = _hash_arg(request.query_params.get("hash", ""))
    # Changed files with status
    r_files = await _git(d, "diff-tree", "--root", "--no-commit-id", "-r", "--name-status",
                         "--end-of-options", h)
    files = []
    for line in r_files.stdout.strip().splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2:
            files.append({"status": parts[0], "path": parts[1]})
    # Full diff
    r2 = await _git(d, "show", "--no-color", "--format=", "--end-of-options", h)
    diff = r2.stdout if r2.returncode == 0 else ""
    # Commit info
    r_info = await _git(d, "log", "-1", "--format=%s|%an|%at", "--end-of-options", h)
    msg, author, ts = "", "", 0
    if r_info.returncode == 0:
        parts = r_info.stdout.strip().split("|", 2)
        if len(parts) >= 3:
            msg, author, ts = parts[0], parts[1], int(parts[2])
    return {"files": files, "diff": diff, "message": msg, "author": author, "timestamp": ts,
            "truncated": r2.truncated or r_files.truncated}


@router.get("/api/sandbox/git/show-file")
async def api_git_show_file(request: Request):
    """Show file content at a specific commit."""
    uid = require_user_id(request)
    d = await _depot(uid, request.query_params.get("repo", ""))
    h = request.query_params.get("hash", "")
    fpath = request.query_params.get("path", "")
    if not h or not fpath:
        raise HTTPException(400, "hash et path requis")
    r = await _git(d, "show", "--end-of-options", f"{_ref_arg(h, 'Hash')}:{fpath}")
    if r.returncode != 0:
        raise HTTPException(404, r.stderr.strip()[:200])
    if r.truncated:
        raise HTTPException(413, f"Fichier de plus de {_SORTIE >> 20} Mio : non affiché")
    return {"content": r.stdout}


@router.post("/api/sandbox/git/restore-commit")
async def api_git_restore_commit(request: Request):
    """Restore the repo to a specific commit by creating a revert/reset."""
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    h = _hash_arg(data.get("hash"))
    force = bool(data.get("force"))
    # Save current HEAD as a safety reference (renvoyé pour permettre revert-last).
    cur = await _git(d, "rev-parse", "HEAD")
    cur_hash = cur.stdout.strip() if cur.returncode == 0 else ""
    if not cur_hash:
        # HEAD non né (aucun commit) : il ne peut exister aucun commit cible à
        # restaurer, et le « commit de secours » laisserait HEAD dans un état
        # incohérent. On refuse explicitement plutôt que d'écraser à l'aveugle.
        raise HTTPException(400, "Dépôt sans commit : rien à restaurer.")
    # GARDE dirty-tree : ``checkout <hash> -- .`` écrase les fichiers suivis par la
    # version du commit, ce qui détruirait IRRÉMÉDIABLEMENT toute modif non commitée
    # de l'arbre de travail (aucun stash interne). On refuse par défaut (409) et, si
    # l'utilisateur confirme (force=true), on sauvegarde l'arbre courant dans un tag
    # de secours AVANT d'écraser, pour que rien ne soit perdu.
    st = await _git(d, "status", "--porcelain=v1", "-uall")
    if st.returncode != 0:
        # Fail-closed : si on ne peut pas déterminer l'état de l'arbre, ne JAMAIS
        # écraser à l'aveugle — on refuse plutôt que de risquer une perte de données.
        raise HTTPException(
            500,
            "Impossible de vérifier l'état de l'arbre de travail ; restauration annulée : "
            + (st.stderr or "").strip()[:200],
        )
    dirty = bool(st.stdout.strip())
    backup_ref = ""
    if dirty:
        if not force:
            raise HTTPException(
                409,
                "L'arbre de travail contient des modifications non commitées qui "
                "seraient écrasées par la restauration. Commitez-les, annulez-les, "
                "ou confirmez la restauration (force) — une sauvegarde sera créée.",
            )
        # force=true : capturer l'état courant (suivi + non suivi) dans un commit de
        # secours non destructif, taggé, puis revenir à l'état initial avant restauration.
        backup_ref = f"restore-backup-{int(time.time())}"
        username = get_username_by_id(uid) or "user"
        author = f"{username} <{username}@elpis>"
        await _git(d, "add", "-A")
        bk = await _git(d, "commit", "-m", f"Sauvegarde avant restauration vers {h[:8]}",
                        "--author", author, "--allow-empty", "--no-verify")
        if bk.returncode == 0:
            # Taguer ce commit de secours puis défaire le commit (garder l'historique
            # propre) — le tag conserve l'arbre, rien n'est perdu.
            await _git(d, "tag", backup_ref)
            # Reset MIXED (PAS --soft) : ramène HEAD *et l'index* à cur_hash, ce qui
            # DÉSINDEXE les fichiers non suivis ajoutés par ``add -A`` ci-dessus.
            # Avec --soft, l'index gardait ces fichiers stagés et le commit de
            # restauration final les embarquait → fuite de fichiers non suivis dans
            # l'historique (restauration non fidèle au commit cible).
            await _git(d, "reset", cur_hash)
        else:
            # Impossible de sauvegarder : on n'écrase RIEN, on remonte l'erreur.
            raise HTTPException(
                500,
                "Échec de la sauvegarde de l'arbre de travail ; restauration annulée : "
                + (bk.stderr or "").strip()[:200],
            )
    # Use git checkout of all files from that commit + new commit
    r = await _git(d, "checkout", h, "--", ".")
    if r.returncode != 0:
        raise HTTPException(400, (r.stderr or "").strip()[:300])
    username = get_username_by_id(uid) or "user"
    r2 = await _git(d, "commit", "-m", f"Restauration vers {h[:8]}",
                    "--author", f"{username} <{username}@elpis>", "--allow-empty")
    msg = r2.stdout.strip()[:200] if r2.returncode == 0 else "Fichiers restaurés (non commité)"
    return {"ok": True, "message": msg, "previous_head": cur_hash, "backup_ref": backup_ref}


@router.post("/api/sandbox/git/revert-last")
async def api_git_revert_last(request: Request):
    """Revert the last commit (undo a restoration)."""
    uid = require_user_id(request)
    data = await request.json()
    d = await _depot(uid, data.get("repo", ""))
    r = await _git(d, "revert", "HEAD", "--no-edit")
    if r.returncode != 0:
        # Try reset if revert fails (e.g. merge conflicts)
        err = (r.stderr or "").strip()
        await _git(d, "revert", "--abort")
        raise HTTPException(400, err[:300])
    return {"ok": True, "message": (r.stdout or "").strip()[:200]}
