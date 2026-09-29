# SPDX-License-Identifier: MIT
"""
backend.routes.sandbox_git — Per-user git operations on sandbox sub-repos.

Each subfolder of a user's sandbox can be an independent Git repo. Every
endpoint takes a ``repo`` parameter (relative to the sandbox root) so a user
can keep several projects side-by-side. ``_git_resolve_repo_or_root`` falls
back to the sandbox root if it is itself a repo, which keeps the legacy
single-repo UX working unchanged.

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

Module-level helpers (still in ``_legacy``)
-------------------------------------------
``_git_run``, ``_git_run_with_creds``, ``_git_resolve_repo``,
``_git_resolve_repo_or_root`` are imported from ``backend.routes._helpers``;
``_get_sandbox_path`` likewise. Splitting them off further is a separate
refactor (they are used by tests and by ``admin.py``).
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from pathlib import Path

from fastapi import HTTPException, Request

from shared_infra.accounts.users import get_username_by_id

# Helpers shared with ``_legacy``. Live mutables (locks, dicts) need the
# module reference so we read the current value, not a snapshot.
from shared_infra.routes._helpers import (
    _get_work_path,
    _git_resolve_repo,
    _git_resolve_repo_or_root,
    _git_run,
    _git_run_with_creds,
    _path_inside,
)
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

# Local aliases for the helpers most-used by the route bodies. Importing
# them as plain names keeps the route bodies readable and matches the
# original ``_legacy`` source verbatim.
_git_run = _git_run
_git_run_with_creds = _git_run_with_creds  # initialized after first import
_git_resolve_repo = _git_resolve_repo
_git_resolve_repo_or_root = _git_resolve_repo_or_root
# Git repos live in the WORK root (``P/work``, bind-mounted as ``/work``),
# NOT in the per-user root ``P`` (which also holds skills/.memory, outside
# the mount).
_get_work_path = _get_work_path


# AUDIT 2026-08-31 (passe 4, B1) — ``_git_run`` est un ``subprocess.run``
# SYNCHRONE (clone jusqu'à 120 s, push/pull 60 s) : appelé depuis une route
# ``async def``, il gèle la boucle du worker entier (chat, SSE, Stop). Les
# routes de LECTURE sont ``def`` (threadpool Starlette) ; les routes
# MUTANTES doivent rester ``async`` (``await request.json()``) → tout appel
# git y passe par ces wrappers ``to_thread``.
async def _agit(repo_dir, *args, **kw):
    return await asyncio.to_thread(_git_run, repo_dir, *args, **kw)


async def _agit_creds(repo_dir, *args, **kw):
    return await asyncio.to_thread(_git_run_with_creds, repo_dir, *args, **kw)


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
# SECURITY FIX #K + #L — Validation des URLs remote/clone (anti-SSRF)
# ─────────────────────────────────────────────────────────────────────────────
# Avant : ``url = data.get("url")`` était passé tel quel à git clone /
# git remote set-url. Or git accepte des schémas qui sortent du modèle
# "fetch depuis Internet" :
#   - file:///etc/passwd  → lit des fichiers locaux dans le repo
#   - http://127.0.0.1:6379 → scanne Redis / autres services locaux
#   - http://169.254.169.254/  → metadata AWS / GCP / Azure
#   - http://[private-LAN-IP]/... → pivot LAN
#   - ssh://git@internal-host/  → idem
#
# Le filtrage minimal acceptable :
#   - schemas autorisés : http, https, git (le smart protocol)
#   - hostname résolu : refuser loopback, link-local, multicast, et toute
#     plage privée (RFC1918, ULA IPv6, etc.). Le ``is_global`` du module
#     ipaddress couvre tout ça en un check.
#   - hostname non-IP : on autorise (DNS public), mais on refuse les
#     suffixes locaux (.local, .internal, .lan, .home, .corp).
# Les déploiements legacy qui veulent cloner depuis un Gitea/Gitlab
# interne devront ajouter une exception via la config. Pour l'instant,
# défaut sécurisé. Le user qui veut cloner un repo public n'est pas
# impacté ; le user qui voulait file:// ou pivot interne l'est.
# AUDIT 2026-08-02 — source UNIQUE des schémas de remote git, partagée avec
# ``llm_core.tools.git_tools`` (qui divergeait en https-only) via ``ssrf``.
from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES as _ALLOWED_GIT_SCHEMES

_BLOCKED_HOST_SUFFIXES = (".local", ".internal", ".lan", ".home", ".corp", ".intranet")
# Hostnames littéraux qui résolvent vers loopback / réseau local sans
# qu'on les attrape via ``ipaddress.ip_address`` (qui ne parse que les
# IPs numériques). Inutile de tenter une résolution DNS ici — coût +
# DNS rebinding. On bloque les noms les plus courants.
_BLOCKED_HOST_LITERALS = frozenset({"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"})


def _conn_hosts(uid) -> set:
    """Hosts de connecteurs enregistrés par ce user → allowlist SSRF (self-hosted)."""
    try:
        from shared_infra.git.connectors import list_connector_hosts
        return set(list_connector_hosts(int(uid)))
    except Exception:
        return set()


def _resolved_push_creds(uid, repo, data) -> tuple:
    """``(username, token)`` pour push/pull. Un ``cred_user``/``cred_token``
    explicite dans le body prime (override) ; sinon on résout depuis les
    Connecteurs Git par le remote ``origin`` (remplace l'ancien fichier sandbox)."""
    cu = (data.get("cred_user") or "").strip()
    ct = (data.get("cred_token") or "").strip()
    if cu and ct:
        return cu, ct
    try:
        r = _git_run(repo, "remote", "get-url", "origin", timeout=5)
        out = (getattr(r, "stdout", "") or "").strip()
        url = out.splitlines()[0] if (getattr(r, "returncode", 1) == 0 and out) else ""
        if url:
            from shared_infra.git.resolver import import_legacy_git_credentials, resolve_git_credential
            import_legacy_git_credentials(int(uid), _get_work_path(int(uid)))
            cred = resolve_git_credential(int(uid), url)
            if cred and cred.get("token"):
                return cred.get("username", ""), cred["token"]
    except Exception:
        pass
    return "", ""


def _validate_git_url(url: str, allow_hosts=()) -> None:
    """Raises HTTPException(403) si *url* est dangereuse pour git (anti-SSRF).

    Délègue au validateur UNIFIÉ ``shared_infra.git.ssrf`` (même implémentation
    que le chemin MCP). Schémas autorisés : http/https/git. ``allow_hosts`` =
    connecteurs self-hosted enregistrés.

    AUDIT 2026-08-02 — mode ``critical_only`` : l'app est déployée sur un RÉSEAU
    LOCAL et les dépôts vivent sur le LAN (ex. ``git.example.lan``). Bloquer tout
    IP privée était de la friction pure (impossible de cloner/rebase son propre
    repo). On ne bloque donc plus que les cibles SSRF à haute valeur — loopback
    (services locaux) et link-local ``169.254`` (metadata cloud) — et on AUTORISE
    le LAN privé et les hosts internes. Le DNS-rebinding vers loopback/link-local
    reste attrapé. (Les API PR de ``git_connectors`` gardent, elles, le strict.)
    """
    if not url or not isinstance(url, str):
        raise HTTPException(400, "URL manquante")
    from shared_infra.git.ssrf import block_remote_url_reason
    reason = block_remote_url_reason(url, allow_schemes=_ALLOWED_GIT_SCHEMES,
                                     allow_hosts=allow_hosts, critical_only=True)
    if reason:
        raise HTTPException(403, f"URL refusée (anti-SSRF) : {reason}")


def _validate_all_remote_urls(repo_dir, allow_hosts=()) -> None:
    """SECURITY FIX #L bis — pre-fetch/pull/push hook.

    L'utilisateur peut éditer ``.git/config`` directement via les
    endpoints sandbox de fichiers (read/write arbitrary content sous
    sa sandbox), puis appeler ``git fetch`` → exfiltration via une URL
    qui aurait été refusée par ``_validate_git_url`` au moment du
    ``remote set-url``. Pour fermer ce vecteur, on liste TOUS les
    remotes configurés AVANT chaque opération réseau et on les passe
    par le même filtre. Coût : un ``git config --get-regexp`` (~5ms).

    En cas d'URL invalide, on raise 403 avec le nom du remote fautif
    pour aider l'opérateur à diagnostiquer.
    """
    r = _git_run(repo_dir, "config", "--get-regexp", r"^remote\..*\.url$")
    if r.returncode != 0:
        return
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        key, _, val = line.partition(" ")
        url = val.strip()
        if not url:
            continue
        try:
            _validate_git_url(url, allow_hosts=allow_hosts)
        except HTTPException as exc:
            raise HTTPException(
                exc.status_code,
                f"Remote {key} : {exc.detail}",
            )


async def _grant_after_git(uid: int, sb, repo) -> None:
    """Re-align ownership/perms after a host-side git op that rewrote the
    working tree (pull/checkout/merge/discard/merge-abort/resolve).

    The git subsystem runs on the HOST (operator UID, e.g. 1000), so files git
    just wrote/restored are host-owned at git's default modes (0644) — the
    container (UID 10001) then gets 'permission denied' editing them ("j'ai
    pull mais je ne peux plus éditer"). ``sandbox_grant_access`` grants rwX to
    both UIDs (+ a ``default`` ACL so subsequent host-side git writes inherit
    it) and chowns to 10001 cosmetically — exactly what ``init``/``clone``
    already do. Best-effort: ``sandbox_grant_access`` swallows its own errors
    and git has already succeeded, so this never disrupts the response."""
    from shared_infra.sandbox.exec_bridge import sandbox_grant_access
    try:
        rel = repo.resolve().relative_to(sb.resolve()).as_posix()
    except Exception:
        rel = ""
    await sandbox_grant_access(int(uid), "" if rel == "." else rel)


# ─────────────────────────────────────────────────────────────────────────────
#  Parcours d'arborescence — helpers DURCIS (audit 2026-08-08)
# ─────────────────────────────────────────────────────────────────────────────
# Ces deux helpers portent le durcissement que ``_helpers._build_file_tree``
# avait déjà reçu (correctif F6) et qui manquait ici. Deux défauts mesurés :
#
#  * ``entry.is_dir()`` / ``entry.stat()`` / ``Path.exists()`` DÉRÉFÉRENCENT les
#    symlinks. Un ``ln -s /un/dossier/hote x`` posé depuis le terminal sandbox
#    faisait donc lister l'arborescence HÔTE (noms + tailles) par
#    ``/git/tree``, et ``_git_run`` tournait dans un dépôt hors sandbox via
#    ``/git/repos``.
#  * ``Path.exists()`` n'avale que ENOENT/ENOTDIR/EBADF/ELOOP : un
#    ``ln -s /root x`` faisait REMONTER EACCES → HTTP 500 DÉFINITIF sur
#    ``/git/repos`` (route appelée à chaque ouverture de l'éditeur, donc
#    panneau Git mort). Idem ``ln -s . loop`` → OSError ELOOP sur ``/git/tree``.
#
# Règle : on ne suit AUCUN lien, on confirme le containment sur le chemin
# RÉSOLU, on borne la profondeur, et toute erreur FS fait sauter l'entrée au
# lieu de casser la réponse.
_TREE_MAX_DEPTH = 40


def _has_git_dir(p: Path) -> bool:
    """``p/.git`` existe-t-il ? Toute erreur FS (EACCES sur un lien vers un
    dossier hôte non lisible…) vaut « non » — jamais une 500."""
    try:
        return (p / ".git").exists()
    except OSError:
        return False


def _real_subdirs(p: Path) -> "list[Path]":
    """Sous-dossiers RÉELS de ``p`` (ni symlinks, ni entrées cachées), triés.
    Liste vide sur toute erreur FS."""
    out: "list[Path]" = []
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    if e.name.startswith("."):
                        continue
                    if e.is_symlink() or not e.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                out.append(Path(e.path))
    except OSError:
        return []
    return sorted(out)


@router.get("/api/sandbox/git/repos")
def api_git_repos(request: Request):
    """Scan sandbox for all git repositories (directories containing .git)."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repos = []
    # Check root
    if _has_git_dir(sb):
        r = _git_run(sb, "branch", "--show-current")
        repos.append({"path": ".", "name": sb.name, "branch": r.stdout.strip() or "(HEAD)"})
    # Scan subdirectories (max 2 levels deep). Symlinks exclus (cf. bloc
    # ci-dessus) : sans ça ``_git_run`` s'exécutait dans un dépôt HORS sandbox.
    for depth1 in _real_subdirs(sb):
        if _has_git_dir(depth1):
            r = _git_run(depth1, "branch", "--show-current")
            repos.append({
                "path": depth1.name,
                "name": depth1.name,
                "branch": r.stdout.strip() or "(HEAD)",
            })
            continue
        # Check one more level
        for depth2 in _real_subdirs(depth1):
            if _has_git_dir(depth2):
                rel = str(depth2.relative_to(sb))
                r = _git_run(depth2, "branch", "--show-current")
                repos.append({
                    "path": rel,
                    "name": depth2.name,
                    "branch": r.stdout.strip() or "(HEAD)",
                })
    return {"repos": repos}


@router.get("/api/sandbox/git/status")
def api_git_status(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo_rel = request.query_params.get("repo", "")
    try:
        repo = _git_resolve_repo_or_root(sb, repo_rel)
    except HTTPException:
        return {"is_repo": False}
    # Current branch
    branch_r = _git_run(repo, "branch", "--show-current")
    branch = branch_r.stdout.strip() or "(HEAD détaché)"
    # Ahead/behind
    ahead, behind = 0, 0
    ab = _git_run(repo, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
    if ab.returncode == 0:
        parts = ab.stdout.strip().split()
        if len(parts) == 2:
            ahead, behind = int(parts[0]), int(parts[1])
    # Porcelain status
    st = _git_run(repo, "status", "--porcelain=v1", "-uall")
    staged, modified, untracked, conflicted = [], [], [], []
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
    remote_r = _git_run(repo, "remote", "get-url", "origin")
    remote_url = remote_r.stdout.strip() if remote_r.returncode == 0 else ""
    # Per-file line stats (numstat)
    _numstat_staged = {}
    ns = _git_run(repo, "diff", "--cached", "--numstat")
    for line in ns.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            add = parts[0] if parts[0] != "-" else "0"
            rem = parts[1] if parts[1] != "-" else "0"
            _numstat_staged[parts[2]] = {"add": int(add), "del": int(rem)}
    _numstat_unstaged = {}
    ns2 = _git_run(repo, "diff", "--numstat")
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
        "conflicted": conflicted,
    }


@router.get("/api/sandbox/git/branches")
def api_git_branches(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo = _git_resolve_repo_or_root(sb, request.query_params.get("repo", ""))
    r = _git_run(repo, "branch", "--format=%(refname:short)|%(HEAD)")
    local = []
    current = ""
    for line in r.stdout.splitlines():
        parts = line.split("|")
        name = parts[0].strip()
        if len(parts) > 1 and parts[1].strip() == "*":
            current = name
        local.append(name)
    if not current:
        bc = _git_run(repo, "branch", "--show-current")
        current = bc.stdout.strip()
    rr = _git_run(repo, "branch", "-r", "--format=%(refname:short)")
    remote = [b.strip() for b in rr.stdout.splitlines() if b.strip() and "HEAD" not in b]
    return {"current": current, "local": local, "remote": remote}


@router.get("/api/sandbox/git/log")
def api_git_log(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo = _git_resolve_repo_or_root(sb, request.query_params.get("repo", ""))
    try:
        n = max(1, min(int(request.query_params.get("n", "30")), 100))
    except ValueError:
        raise HTTPException(400, "n invalide")
    r = _git_run(repo, "log", f"-{n}", "--format=%H|%h|%an|%ae|%at|%s")
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
def api_git_diff(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo = _git_resolve_repo_or_root(sb, request.query_params.get("repo", ""))
    file_path = request.query_params.get("path", "")
    is_staged = request.query_params.get("staged", "") == "1"
    args = ["diff", "--no-color"]
    if is_staged:
        args.append("--cached")
    if file_path:
        args.extend(["--", file_path])
    r = _git_run(repo, *args)
    return {"diff": r.stdout}


@router.post("/api/sandbox/git/init")
async def api_git_init(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    dir_name = (data.get("dir") or "").strip()
    if dir_name:
        target = (sb / dir_name).resolve()
        # Containment robuste (relative_to) — startswith est vulnérable au préfixe
        # frère (/sb/al vs /sb/alice) ; parité avec api_git_clone (_path_inside).
        if not _path_inside(target, sb):
            raise HTTPException(403, "Chemin hors sandbox")
        target.mkdir(parents=True, exist_ok=True)
    else:
        target = sb
    r = await _agit(target, "init")
    if r.returncode != 0:
        raise HTTPException(500, r.stderr.strip())
    uname = (data.get("user_name") or "").strip()
    email = (data.get("user_email") or "").strip()
    if uname:
        await _agit(target, "config", "user.name", uname)
    if email:
        await _agit(target, "config", "user.email", email)
    # init crée .git côté HÔTE (UID app) ; on pose l'ACL default sur le repo pour
    # que les fichiers réécrits ENSUITE par le git host-side (checkout/pull/merge)
    # restent éditables par le user in-container (UID 10001).
    from shared_infra.sandbox.exec_bridge import sandbox_grant_access
    await sandbox_grant_access(int(uid), dir_name or "")
    return {"ok": True, "repo": dir_name or ".", "message": r.stdout.strip()}


@router.post("/api/sandbox/git/clone")
async def api_git_clone(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    url = (data.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "URL requise")
    # SECURITY FIX #K — anti-SSRF + anti-file:// (cf. _validate_git_url).
    # ``_conn_hosts`` lit la DB → hors boucle (passe 4, B1).
    _validate_git_url(url, allow_hosts=await asyncio.to_thread(_conn_hosts, uid))
    # Determine target directory name
    dir_name = (data.get("dir") or "").strip()
    if not dir_name:
        # Extract repo name from URL: "https://…/my-repo.git" → "my-repo"
        import re as _re_git
        match = _re_git.search(r'/([^/]+?)(?:\.git)?/?$', url)
        dir_name = match.group(1) if match else "repo"
    # SECURITY FIX #K — défensif : refuser un ``dir`` contenant des
    # caractères de séparation ou ``..`` AVANT toute résolution.
    # Sinon, un dir_name comme "../alice2/poc" sur un sandbox
    # ``/sandbox/al`` produisait une cible ``/sandbox/alice2/poc``
    # qui passait l'ancien check ``startswith("/sandbox/al")``
    # (préfixe commun) — écriture cross-user. Le nouveau check via
    # ``_path_inside`` est lui-même robuste, mais bloquer en amont
    # rend l'intention claire et économise un resolve() en cas
    # d'abus évident.
    if "/" in dir_name or "\\" in dir_name or ".." in dir_name.split("/"):
        raise HTTPException(400, "Nom de dossier invalide")
    target = (sb / dir_name).resolve()
    # SECURITY FIX #K — remplace ``startswith`` (préfixe commun bug) par
    # ``_path_inside`` qui s'appuie sur ``Path.relative_to``. Cf. les
    # autres routes sandbox déjà migrées.
    if not _path_inside(target, sb):
        raise HTTPException(403, "Chemin hors sandbox")
    # Refuse if target already exists and is not empty
    if target.exists() and any(target.iterdir()):
        raise HTTPException(409, f"Le dossier '{dir_name}' existe déjà et n'est pas vide")
    target.mkdir(parents=True, exist_ok=True)
    # Credentials : connecteur correspondant à l'URL de clone (ou body override).
    cu = (data.get("cred_user") or "").strip()
    ct = (data.get("cred_token") or "").strip()
    if not ct:                                       # pas de token override → résoudre
        def _resolve_clone_cred():
            # DB + fichiers legacy → thread (passe 4, B1).
            try:
                from shared_infra.git.resolver import import_legacy_git_credentials, resolve_git_credential
                import_legacy_git_credentials(int(uid), sb)
                return resolve_git_credential(int(uid), url)
            except Exception:
                return None
        cred = await asyncio.to_thread(_resolve_clone_cred)
        if cred and cred.get("token"):
            cu, ct = cred.get("username", ""), cred["token"]
    if ct:                                           # token seul suffit (askpass gère)
        r = await _agit_creds(sb, "clone", "--progress", url, str(target),
                              username=cu, token=ct, timeout=120)
    else:
        r = await _agit(sb, "clone", "--progress", url, str(target), timeout=120)
    if r.returncode != 0:
        # Clean up failed clone — rmtree peut être long sur repo déjà partiellement cloné.
        if target.exists():
            await asyncio.to_thread(shutil.rmtree, target, ignore_errors=True)
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    # Le clone tourne côté HÔTE (UID app) → le dossier appartient à l'app, pas au
    # user in-container (UID 10001) qui ne peut alors NI l'éditer NI le supprimer.
    # On ré-aligne sur le modèle 10001 (ACL + chown) pour le rendre éditable.
    from shared_infra.sandbox.exec_bridge import sandbox_grant_access
    await sandbox_grant_access(int(uid), dir_name)
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
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    paths = _paths_arg(data.get("paths") or [])
    if not paths:
        r = await _agit(repo, "add", "-A")
    else:
        r = await _agit(repo, "add", "--", *paths)
    if r.returncode != 0:
        raise HTTPException(400, r.stderr.strip())
    return {"ok": True}


@router.post("/api/sandbox/git/unstage")
async def api_git_unstage(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    paths = _paths_arg(data.get("paths") or [])
    if not paths:
        r = await _agit(repo, "reset", "HEAD")
    else:
        r = await _agit(repo, "reset", "HEAD", "--", *paths)
    if r.returncode != 0:
        raise HTTPException(400, r.stderr.strip())
    return {"ok": True}


@router.post("/api/sandbox/git/discard")
async def api_git_discard(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    paths = data.get("paths", [])
    if not paths:
        # Discard ALL: restore tracked + remove untracked
        await _agit(repo, "checkout", "--", ".")
        await _agit(repo, "clean", "-fd")
    else:
        for p in paths:
            target = (repo / p).resolve()
            if not _path_inside(target, repo):     # containment robuste (cf. api_git_clone)
                continue
            # Try git checkout (works for tracked modified files)
            r = await _agit(repo, "checkout", "--", p)
            if r.returncode != 0:
                # Untracked or new file: remove manually — async-safe.
                if target.is_dir():
                    await asyncio.to_thread(shutil.rmtree, target, ignore_errors=True)
                elif target.is_file():
                    target.unlink(missing_ok=True)
    await _grant_after_git(uid, sb, repo)
    return {"ok": True}


@router.post("/api/sandbox/git/commit")
async def api_git_commit(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    message = (data.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "Message requis")
    username = get_username_by_id(uid) or "user"
    r = await _agit(repo, "commit", "-m", message,
                    "--author", f"{username} <{username}@elpis>")
    if r.returncode != 0:
        err = r.stderr.strip() or r.stdout.strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": r.stdout.strip()[:200]}


@router.post("/api/sandbox/git/push")
async def api_git_push(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    # SECURITY FIX #L bis — couvre l'édition directe de .git/config
    # via l'API sandbox de fichiers (vecteur qui bypassait #L sur le
    # endpoint /api/sandbox/git/remote). Helper sync (git config + DB) →
    # thread (passe 4, B1).
    hosts = await asyncio.to_thread(_conn_hosts, uid)
    await asyncio.to_thread(_validate_all_remote_urls, repo, hosts)
    remote = _ref_arg(data.get("remote") or "origin", "Remote")
    branch = _ref_arg(data["branch"], "Branche") if data.get("branch") else ""
    force = data.get("force", False)
    # Credentials : Connecteurs Git (résolus par le remote) ; body = override.
    cred_user, cred_token = await asyncio.to_thread(_resolved_push_creds, uid, repo, data)
    args = ["push"]
    if force:
        args.append("--force-with-lease")
    args += ["--end-of-options", remote] + ([branch] if branch else [])
    if cred_token:
        r = await _agit_creds(repo, *args, username=cred_user, token=cred_token)
    else:
        r = await _agit(repo, *args, timeout=60)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stderr or r.stdout).strip()[:200]}


@router.post("/api/sandbox/git/pull")
async def api_git_pull(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    # SECURITY FIX #L bis — cf. push.
    hosts = await asyncio.to_thread(_conn_hosts, uid)
    await asyncio.to_thread(_validate_all_remote_urls, repo, hosts)
    rebase = data.get("rebase", False)
    cred_user, cred_token = await asyncio.to_thread(_resolved_push_creds, uid, repo, data)
    args = ["pull"]
    if rebase:
        args.append("--rebase")
    if cred_token:
        r = await _agit_creds(repo, *args, username=cred_user, token=cred_token)
    else:
        r = await _agit(repo, *args, timeout=60)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    await _grant_after_git(uid, sb, repo)
    return {"ok": True, "message": (r.stdout or r.stderr).strip()[:200]}


@router.post("/api/sandbox/git/fetch")
async def api_git_fetch(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    # SECURITY FIX #L bis — cf. push. ``fetch --all`` hit chaque remote ;
    # on les valide tous AVANT d'invoquer git.
    hosts = await asyncio.to_thread(_conn_hosts, uid)
    await asyncio.to_thread(_validate_all_remote_urls, repo, hosts)
    r = await _agit(repo, "fetch", "--all", "--prune", timeout=60)
    if r.returncode != 0:
        raise HTTPException(400, (r.stderr or "").strip()[:300])
    return {"ok": True}


@router.post("/api/sandbox/git/checkout")
async def api_git_checkout(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    branch = _ref_arg(data.get("branch"), "Branche")
    create = data.get("create", False)
    args = ["checkout"]
    if create:
        args.append("-b")
    args += ["--end-of-options", branch]
    r = await _agit(repo, *args)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    await _grant_after_git(uid, sb, repo)
    return {"ok": True, "message": (r.stderr or r.stdout).strip()[:200]}


@router.post("/api/sandbox/git/merge")
async def api_git_merge(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    branch = _ref_arg(data.get("branch"), "Branche")
    strategy = data.get("strategy", "")  # "", "theirs", "ours"
    args = ["merge", "--no-edit"]
    if strategy in ("theirs", "ours"):
        args += ["-X", strategy]
    args += ["--end-of-options", branch]
    r = await _agit(repo, *args)
    if r.returncode == 0:
        await _grant_after_git(uid, sb, repo)
        return {"ok": True, "conflicts": False, "message": r.stdout.strip()[:200]}
    # Check for conflicts
    st = await _agit(repo, "status", "--porcelain=v1")
    conflicted = []
    for line in st.stdout.splitlines():
        if len(line) >= 4 and line[0] == 'U' or (len(line) >= 4 and line[1] == 'U') or line[:2] in ('AA', 'DD'):
            fpath = line[3:]
            conflicted.append(fpath)
    if conflicted:
        # Working tree now carries conflict markers (host-owned) the model must
        # edit to resolve → make them cross-writable too.
        await _grant_after_git(uid, sb, repo)
        return {"ok": False, "conflicts": True, "conflicted_files": conflicted,
                "message": f"{len(conflicted)} fichier(s) en conflit"}
    # Non-conflict error
    err = (r.stderr or r.stdout or "").strip()
    # Abort the failed merge to leave repo clean
    await _agit(repo, "merge", "--abort")
    raise HTTPException(400, err[:500])


@router.post("/api/sandbox/git/merge-abort")
async def api_git_merge_abort(request: Request):
    """Abort an in-progress merge."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    r = await _agit(repo, "merge", "--abort")
    if r.returncode != 0:
        # Fallback: hard reset
        await _agit(repo, "reset", "--hard", "HEAD")
    await _grant_after_git(uid, sb, repo)
    return {"ok": True}


@router.post("/api/sandbox/git/merge-resolve")
async def api_git_merge_resolve(request: Request):
    """Resolve merge conflicts with a strategy."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    strategy = data.get("strategy", "theirs")  # "theirs" or "ours"
    if strategy not in ("ours", "theirs"):
        raise HTTPException(400, "strategy : ours ou theirs")
    files = data.get("files") or []  # empty = all conflicted
    if not isinstance(files, list) or not all(isinstance(f, str) and f for f in files):
        raise HTTPException(400, "files : liste de chemins")
    if not files:
        # Resolve all conflicted files
        st = await _agit(repo, "status", "--porcelain=v1")
        for line in st.stdout.splitlines():
            if len(line) >= 4 and (line[0] == 'U' or line[1] == 'U' or line[:2] in ('AA', 'DD')):
                files.append(line[3:])
    for f in files:
        await _agit(repo, "checkout", f"--{strategy}", "--", f)
        await _agit(repo, "add", "--", f)
    # Auto-commit if all conflicts resolved
    st2 = await _agit(repo, "status", "--porcelain=v1")
    still_conflicted = any(
        (len(l) >= 4 and (l[0] == 'U' or l[1] == 'U' or l[:2] in ('AA', 'DD')))
        for l in st2.stdout.splitlines()
    )
    if not still_conflicted:
        username = get_username_by_id(uid) or "user"
        await _agit(repo, "commit", "--no-edit",
                    "--author", f"{username} <{username}@elpis>")
    await _grant_after_git(uid, sb, repo)
    return {"ok": True, "resolved": len(files),
            "all_resolved": not still_conflicted}


@router.get("/api/sandbox/git/merge-preview")
def api_git_merge_preview(request: Request):
    """Preview what merging a branch would change."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo = _git_resolve_repo_or_root(sb, request.query_params.get("repo", ""))
    branch = _ref_arg(request.query_params.get("branch"), "Branche")
    # Commits that would be merged
    r_log = _git_run(repo, "log", "--oneline", f"HEAD..{branch}", "--format=%h|%s|%an")
    commits = []
    for line in r_log.stdout.strip().splitlines():
        parts = line.split("|", 2)
        if len(parts) >= 3:
            commits.append({"short": parts[0], "message": parts[1], "author": parts[2]})
    # File changes (numstat)
    r_stat = _git_run(repo, "diff", "--numstat", f"HEAD...{branch}")
    files = []
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
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    branch = (data.get("branch") or "").strip()
    abort = data.get("abort", False)
    cont = data.get("continue", False)
    if abort:
        r = await _agit(repo, "rebase", "--abort")
    elif cont:
        r = await _agit(repo, "rebase", "--continue")
    elif branch:
        r = await _agit(repo, "rebase", "--end-of-options", _ref_arg(branch, "Branche"))
    else:
        raise HTTPException(400, "Branche requise")
    # Le rebase (comme --abort/--continue) RÉÉCRIT l'arbre de travail côté
    # HÔTE → réalignement obligatoire, cf. ``_grant_after_git``. Fait AVANT
    # de remonter l'erreur : un rebase qui s'arrête sur conflit a déjà posé
    # les fichiers à résoudre, qui doivent rester éditables depuis le
    # conteneur (même contrat que la route ``merge``).
    await _grant_after_git(uid, sb, repo)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stdout or r.stderr).strip()[:200]}


@router.post("/api/sandbox/git/stash")
async def api_git_stash(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    action = data.get("action", "push")
    if action == "push":
        msg = data.get("message", "")
        args = ["stash", "push"]
        if msg:
            args.extend(["-m", msg])
        r = await _agit(repo, *args)
    elif action == "pop":
        r = await _agit(repo, "stash", "pop")
    elif action == "list":
        r = await _agit(repo, "stash", "list")
        return {"ok": True, "stashes": r.stdout.strip().splitlines()}
    elif action == "drop":
        r = await _agit(repo, "stash", "drop")
    else:
        raise HTTPException(400, "Action invalide")
    # ``push`` (retire les modifs) comme ``pop`` (les réapplique) réécrivent
    # l'arbre côté HÔTE → réalignement, y compris sur un pop en conflit.
    # ``list`` est déjà sorti plus haut (lecture pure).
    await _grant_after_git(uid, sb, repo)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(400, err[:500])
    return {"ok": True, "message": (r.stdout or r.stderr).strip()[:200]}


@router.post("/api/sandbox/git/remote")
async def api_git_remote(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    url = (data.get("url") or "").strip()
    name = _ref_arg(data.get("name") or "origin", "Nom de remote")
    if not url:
        raise HTTPException(400, "URL requise")
    # SECURITY FIX #L — sans ça, l'user pouvait contourner le filtre
    # de _validate_git_url posé sur clone : ``git init`` (autorisé) +
    # ``remote add origin file:///etc/passwd`` + ``git fetch`` → contenu
    # du fichier dans le repo. Filtre identique appliqué ici, mêmes
    # règles anti-SSRF.
    _validate_git_url(url, allow_hosts=await asyncio.to_thread(_conn_hosts, uid))
    r = await _agit(repo, "remote", "set-url", name, url)
    if r.returncode != 0:
        r = await _agit(repo, "remote", "add", name, url)
    if r.returncode != 0:
        raise HTTPException(400, (r.stderr or "").strip()[:300])
    return {"ok": True}


@router.post("/api/sandbox/git/config")
async def api_git_config(request: Request):
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    for key in ("user.name", "user.email"):
        val = (data.get(key) or "").strip()
        if val:
            await _agit(repo, "config", key, val)
    return {"ok": True}


@router.get("/api/sandbox/git/tree")
def api_git_tree(request: Request):
    """File tree of a specific repo.

    Ne suit AUCUN symlink et borne la profondeur — cf. le bloc « Parcours
    d'arborescence » plus haut pour le détail des deux défauts corrigés
    (fuite de l'arbo hôte, et 500 sur boucle/lien mort).
    """
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo = _git_resolve_repo_or_root(sb, request.query_params.get("repo", ""))
    try:
        base_res = repo.resolve()
    except OSError:
        raise HTTPException(404, "Dépôt illisible")

    def _build(root: Path, base: Path, depth: int = 0):
        items = []
        if depth > _TREE_MAX_DEPTH:
            return items
        try:
            with os.scandir(root) as it:
                entries = sorted(
                    it,
                    key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()),
                )
        except OSError:
            # PermissionError, ENAMETOOLONG (chaîne de liens), dossier
            # disparu en cours de route… → sous-arbre vide, jamais de 500.
            return items
        for entry in entries:
            try:
                if entry.name.startswith("."):
                    continue
                # Skip symlinks (dossiers ET fichiers) : is_symlink ne suit pas.
                if entry.is_symlink():
                    continue
                p = Path(entry.path)
                rel = str(p.relative_to(base))
                # Containment sur le chemin RÉSOLU (défense contre un ancêtre
                # déjà symlinké, montage exotique…).
                if not _path_inside(p.resolve(), base_res):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    items.append({"name": entry.name, "path": rel, "type": "folder",
                                  "children": _build(p, base, depth + 1)})
                else:
                    items.append({"name": entry.name, "path": rel, "type": "file",
                                  "size": entry.stat().st_size})
            except (OSError, ValueError):
                continue
        return items
    return {"items": _build(repo, repo)}


@router.get("/api/sandbox/git/commit-diff")
def api_git_commit_diff(request: Request):
    """Show the diff of a specific commit + list of changed files."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo = _git_resolve_repo_or_root(sb, request.query_params.get("repo", ""))
    h = _hash_arg(request.query_params.get("hash", ""))
    # Changed files with status
    r_files = _git_run(repo, "diff-tree", "--no-commit-id", "-r", "--name-status",
                       "--end-of-options", h)
    files = []
    for line in r_files.stdout.strip().splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2:
            files.append({"status": parts[0], "path": parts[1]})
    # Full diff
    r2 = _git_run(repo, "show", "--no-color", "--format=", "--end-of-options", h)
    diff = r2.stdout if r2.returncode == 0 else ""
    # Commit info
    r_info = _git_run(repo, "log", "-1", "--format=%s|%an|%at", "--end-of-options", h)
    msg, author, ts = "", "", 0
    if r_info.returncode == 0:
        parts = r_info.stdout.strip().split("|", 2)
        if len(parts) >= 3:
            msg, author, ts = parts[0], parts[1], int(parts[2])
    return {"files": files, "diff": diff, "message": msg, "author": author, "timestamp": ts}


@router.get("/api/sandbox/git/show-file")
def api_git_show_file(request: Request):
    """Show file content at a specific commit."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    repo = _git_resolve_repo_or_root(sb, request.query_params.get("repo", ""))
    h = request.query_params.get("hash", "")
    fpath = request.query_params.get("path", "")
    if not h or not fpath:
        raise HTTPException(400, "hash et path requis")
    r = _git_run(repo, "show", "--end-of-options", f"{_ref_arg(h, 'Hash')}:{fpath}")
    if r.returncode != 0:
        raise HTTPException(404, r.stderr.strip()[:200])
    return {"content": r.stdout}


@router.post("/api/sandbox/git/restore-commit")
async def api_git_restore_commit(request: Request):
    """Restore the repo to a specific commit by creating a revert/reset."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    h = _hash_arg(data.get("hash"))
    force = bool(data.get("force"))
    # Save current HEAD as a safety reference (renvoyé pour permettre revert-last).
    cur = await _agit(repo, "rev-parse", "HEAD")
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
    st = await _agit(repo, "status", "--porcelain=v1", "-uall")
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
        await _agit(repo, "add", "-A")
        bk = await _agit(repo, "commit", "-m",
                         f"Sauvegarde avant restauration vers {h[:8]}",
                         "--author", author, "--allow-empty", "--no-verify")
        if bk.returncode == 0:
            # Taguer ce commit de secours puis défaire le commit (garder l'historique
            # propre) — le tag conserve l'arbre, rien n'est perdu.
            await _agit(repo, "tag", backup_ref)
            # Reset MIXED (PAS --soft) : ramène HEAD *et l'index* à cur_hash, ce qui
            # DÉSINDEXE les fichiers non suivis ajoutés par ``add -A`` ci-dessus.
            # Avec --soft, l'index gardait ces fichiers stagés et le commit de
            # restauration final les embarquait → fuite de fichiers non suivis dans
            # l'historique (restauration non fidèle au commit cible).
            await _agit(repo, "reset", cur_hash)
        else:
            # Impossible de sauvegarder : on n'écrase RIEN, on remonte l'erreur.
            raise HTTPException(
                500,
                "Échec de la sauvegarde de l'arbre de travail ; restauration annulée : "
                + (bk.stderr or "").strip()[:200],
            )
    # Use git checkout of all files from that commit + new commit
    r = await _agit(repo, "checkout", h, "--", ".")
    # ``checkout <hash> -- .`` réécrit TOUT l'arbre côté HÔTE et crée au besoin
    # des répertoires neufs en 0775 host-owned, dans lesquels le shell
    # in-container (UID 10001, classe « other » = r-x) ne peut plus ni créer ni
    # supprimer. Réalignement avant toute sortie, succès comme échec.
    await _grant_after_git(uid, sb, repo)
    if r.returncode != 0:
        raise HTTPException(400, (r.stderr or "").strip()[:300])
    username = get_username_by_id(uid) or "user"
    r2 = await _agit(repo, "commit", "-m",
                     f"Restauration vers {h[:8]}",
                     "--author", f"{username} <{username}@elpis>",
                     "--allow-empty")
    msg = r2.stdout.strip()[:200] if r2.returncode == 0 else "Fichiers restaurés (non commité)"
    return {"ok": True, "message": msg, "previous_head": cur_hash, "backup_ref": backup_ref}


@router.post("/api/sandbox/git/revert-last")
async def api_git_revert_last(request: Request):
    """Revert the last commit (undo a restoration)."""
    uid = require_user_id(request)
    sb = _get_work_path(uid)
    data = await request.json()
    repo = _git_resolve_repo_or_root(sb, data.get("repo", ""))
    r = await _agit(repo, "revert", "HEAD", "--no-edit")
    if r.returncode != 0:
        # Try reset if revert fails (e.g. merge conflicts)
        err = (r.stderr or "").strip()
        await _agit(repo, "revert", "--abort")
        # L'abort restaure l'arbre côté HÔTE → réalignement là aussi.
        await _grant_after_git(uid, sb, repo)
        raise HTTPException(400, err[:300])
    # Le revert réécrit l'arbre côté HÔTE → réalignement (cf. _grant_after_git).
    await _grant_after_git(uid, sb, repo)
    return {"ok": True, "message": (r.stdout or "").strip()[:200]}
