# SPDX-License-Identifier: MIT
# tools/git_tools.py
"""
Git tools — v3 (intent-driven workflow + sandbox alignment).

Layout change vs v2: a repo is now ANY directory under the user's sandbox
that contains ``.git/``. The legacy ``<sandbox>/<user>/git_repos/`` layer
is no longer required — same mental model as ``fs`` and ``shell`` tools.
Backwards compat: if a ``repo`` arg doesn't resolve at the sandbox root,
we fall back to looking inside ``git_repos/`` and emit a deprecation log.

Workflow change vs v2: ``commit`` and ``push`` are BACK, but tightly
constrained:
  - HEAD on a protected branch (main/master/develop/release/*/hotfix/*)
    → all write operations (commit/push/write/replace) HARD DENY.
  - Agent branches must match an allowed prefix (default: ``agent/``).
  - PR opening is integrated: ``git_submit`` pushes + opens PR in one shot.

Tools (the visible surface — kept minimal on purpose):

INTENT (the agent's 5 main verbs):
  git_inspect    : one-call snapshot {branch, dirty, ahead/behind, recent commits}
  git_start_work : checkout fresh base, create agent/<intent>-<hex> branch
  git_commit     : auto-stage + commit (refuses on protected branches)
  git_submit     : push current branch + open PR (or return fallback URL)
  git_abandon    : reset to base + delete agent branch (escape hatch)

SUPPORT (used as needed):
  git_query      : fine-grained read-only (status, log, diff, blame, etc.)
  git_write      : write/replace files inside a repo
  git_clone      : one-shot clone (rare setup, the rest is via start_work)
  git_action     : safe ops that don't need their own tool — init / fetch /
                   pull / restore (no more commit/push here — those moved
                   to git_commit/git_submit).
  git_rf         : Robot Framework keyword discovery (unchanged).

Credentials:
  Les credentials git (push/pull authentifié + ouverture de PR/MR) viennent des
  **Connecteurs Git** par-utilisateur (table DB host-only, configurés dans
  Réglages → Connecteurs Git). N'ÉCRIS PAS de token dans la sandbox : les secrets
  ne vivent plus dans ``/work``. Si aucun connecteur ne correspond au remote,
  ``git_submit`` renvoie une compare-URL de repli pour une ouverture manuelle.
  (L'ancien fichier ``.git-credentials.json`` est importé automatiquement une fois
  puis ignoré.)

Signature: register(mcp, root_base)   # unchanged
"""
from __future__ import annotations

import ast
import fnmatch
import json
import os
import posixpath
import re
import secrets as _sec
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

from fastmcp import Context, FastMCP

from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.git_relay import RelayRefused
from shared_infra.sandbox.paths import rel_under

from ._espace import Espace
from ._models import (
    ErrEnvelope,
    GitAbandonResult,
    GitActionResult,
    GitCloneResult,
    GitCommitResult,
    GitInspectResult,
    GitQueryResult,
    GitRfResult,
    GitStartWorkResult,
    GitSubmitResult,
    GitWriteResult,
)
from ._toolkit import (
    err,
    get_username,
    glob_match,
    ok as _ok,
    tool_kw,
    tool_kw_destructive,
    tool_kw_mutating,
    tool_kw_openworld,
    tool_kw_readonly,
    unquote,
)

# Legacy subdir — kept for backwards-compat resolution (warned, not errored).
USER_GIT_SUBDIR = "git_repos"


def _clone_url_block_reason(url: str, allow_hosts=()) -> Optional[str]:
    """Validation SSRF d'une URL de remote git (host-side).

    Délègue au validateur UNIFIÉ ``shared_infra.git.ssrf.block_remote_url_reason``
    (fusion des deux validateurs qui divergeaient). ``allow_hosts`` = hosts de
    connecteurs self-hosted enregistrés (autorisés malgré une IP privée).
    Retourne ``None`` si OK, sinon un motif de blocage.

    AUDIT 2026-08-02 — schémas alignés sur la route sandbox via
    ``GIT_REMOTE_SCHEMES`` (http/https/git), ET mode ``critical_only`` : pour les
    outils de l'AGENT, on ne bloque QUE les cibles SSRF à haute valeur (loopback,
    link-local ``169.254`` = metadata cloud). Le LAN privé (``10/172.16/192.168``,
    hosts ``.internal``) est AUTORISÉ : c'est l'infra git self-hosted du
    propriétaire, et le « critique » à empêcher côté agent est la protection de
    branche ``main`` (gardes ``_is_protected`` / préfixe agent), pas l'accès au
    LAN interne. Avant, un serveur git interne bloquait tout fetch/push/submit.
    Les routes UI et les API PR gardent, elles, le mode strict.
    """
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    return block_remote_url_reason(url, allow_schemes=GIT_REMOTE_SCHEMES,
                                   allow_hosts=allow_hosts, critical_only=True)


def _connector_hosts(username: str) -> set:
    """Hosts de connecteurs enregistrés par ce user → allowlist SSRF (self-hosted).
    Best-effort : ``set()`` si indisponible."""
    try:
        from shared_infra.git.connectors import list_connector_hosts
        _uid = 0
        try:
            from shared_infra.accounts.identity import resolve_user as _ident
            _i = _ident(username)
            _uid = int(_i.user_id) if (_i is not None and _i.user_id) else 0
        except Exception:                                       # noqa: BLE001
            _uid = 0
        if not _uid:
            from shared_infra.accounts.users import get_user
            row = get_user(username)
            _uid = int(row["id"]) if row else 0
        return set(list_connector_hosts(_uid)) if _uid else set()
    except Exception:
        return set()


# v15 — Protected branch defaults (the patterns the agent cannot write/push to).
# A repo's ``.git-tool-policy.json`` can only ADD protected branches (and
# narrow the agent prefixes) — see ``_load_repo_policy``.
DEFAULT_PROTECTED_BRANCHES = [
    "main", "master", "develop", "dev", "trunk",
    "staging", "prod", "production",
    "release/*", "hotfix/*",
]

# v15 — Allowed prefix(es) for agent-created branches. An agent can ONLY
# create / commit / push to branches whose name matches one of these.
DEFAULT_AGENT_BRANCH_PREFIXES = ["agent/", "ai/", "claude/", "fix/agent-", "feature/agent-"]

# v15 — Storage path for git provider credentials (PATs) inside user sandbox.
# AUDIT 2026-08-23 — ~150 lignes de CODE MORT retirées : ``_build_compare_url``,
# ``_open_pr_github``, ``_open_pr_gitlab``, ``_load_git_credentials``,
# ``_basic_auth_header``, la constante ``GIT_CREDENTIALS_FILE`` et la copie
# locale ``_http_json``. Zéro appelant après le correctif SSRF de git_submit.
#
# Le danger n'était pas la taille mais la DIVERGENCE : ces fonctions
# reproduisaient une logique d'API de PR figée à la v15 (auth Bearer /
# PRIVATE-TOKEN, détection de PR existante) alors que les providers vivants
# ont depuis intégré des correctifs — un correctif appliqué dans ces copies
# ne se serait JAMAIS exécuté. Et ``_http_json`` était la version
# PRÉ-durcissement du client HTTP : la laisser, c'était inviter à
# réintroduire la fuite de PAT sur redirection.
# Remplaçants vivants : ``shared_infra.git.providers.compare_url_for`` /
# ``get_provider().create_pr``, ``shared_infra.git.resolver.
# import_legacy_git_credentials``, ``shared_infra.git._http.basic_auth_header``
# et ``…_http.http_json``.

RF_LIB_EXTENSIONS = {".py", ".robot", ".resource"}
RF_IGNORE_DIRS = {".git", "__pycache__", "node_modules", ".tox", "venv", ".venv", "dist", "build"}
RF_IGNORE_FILES = {"conftest.py", "setup.py", "setup.cfg", "pytest.ini"}
MAX_LIB_FILE_BYTES = 500_000


def _git_timeout_default() -> int:
    """Timeout des commandes git LOCALES (le réseau a le sien, 120 s).

    12 → 60 (audit 2026-08-01, P2) : 12 s tenait pour un dépôt jouet, mais
    ``git add -A``, ``git log`` ou ``git status`` sur un dépôt réel (gros
    index, beaucoup de fichiers non suivis, disque lent) les dépassent. Et
    l'agent ne voyait pas « c'est long » : il voyait un ÉCHEC d'outil, sur
    lequel il partait en diagnostic ou en nouvelle tentative — en brûlant des
    itérations sur un dépôt parfaitement sain. Réglable à froid via
    ``config.json`` › ``tools.git.timeout_s``.
    """
    try:
        from shared_infra import config as _cfg
        return max(5, int(getattr(_cfg, "GIT_TOOL_TIMEOUT_S", 60) or 60))
    except Exception:
        return 60


TIMEOUT = _git_timeout_default()

# ── Category descriptor (see fs_tools.CATEGORY for the contract) ──────
CATEGORY = {
    "name":  "git",
    "label": "Git",
    "icon":  "ph-git-branch",
    "color": "slate",
    # No "tools" list — captured automatically at registration time.
}

# Category carried IN the protocol (tags + meta), built by the shared
# toolkit — one place to change if a FastMCP version ever rejects meta=.
_TOOL_KW = tool_kw(CATEGORY)

# v18 — Per-behaviour annotation keysets for git tools.
#   git_query, git_inspect       → read-only (status/diff/log/blame…)
#   git_rf                       → read-only (RF keyword discovery)
#   git_write                    → mutating, files local only
#   git_action                   → mutating + open-world (clone/fetch/pull
#                                  touch remotes when target=https-url)
#   git_commit                   → mutating, local
#   git_start_work               → mutating + open-world (pulls from origin)
#   git_submit                   → mutating + open-world (push + open PR)
#   git_clone                    → mutating + open-world (HTTPS fetch)
#   git_abandon                  → destructive (reset --hard + branch delete)
_TOOL_KW_RO       = tool_kw_readonly(CATEGORY, serial=True)
_TOOL_KW_MUT      = tool_kw_mutating(CATEGORY, serial=True)
_TOOL_KW_MUT_OW   = tool_kw_mutating(CATEGORY, open_world=True, serial=True)
_TOOL_KW_DESTRUCT = tool_kw_destructive(CATEGORY, serial=True)
_TOOL_KW_OW_RO    = tool_kw_openworld(CATEGORY, read_only=True, serial=True)
MAX_OUT = 20_000
MAX_FILE_READ = 1_500_000
MAX_FILE_WRITE = 400_000
MAX_FILES = 2000
BAD_CHARS = set(";|&><`$\n\r")
READONLY_SUBS = {
    "status","diff","log","show","branch","rev-parse","rev-list","describe",
    "ls-files","grep","blame","tag","remote","stash","config",
    "diff-tree","shortlog",
}

def _err(m, hint="", **kw):
    # Harmonized error envelope (tools/_toolkit.py): `error` is now a stable
    # machine code derived from the message, the human text moves to
    # `message`, and the hint becomes the standard `fix`. Backward
    # compatible — {ok:false, error:<str>} is still the top-level shape.
    code = re.sub(r"[^a-z0-9]+", "_", str(m).lower()).strip("_")[:40] or "git_error"
    return err(code, str(m), fix=hint or None, **kw)

# _ok is tools/_toolkit.ok (imported above) — identical to the old
# `lambda **kw: {"ok": True, **kw}`, just shared across the suite.

def _trunc(s, n):
    """Char-bounded truncation with an honest marker (how much was cut)."""
    s = s or ""
    if len(s) <= n:
        return (s, False)
    return (s[:n] + f"\n...[tronqué : {len(s) - n} caractères omis sur {len(s)}]", True)

def _reject(tokens, free_text_idx=frozenset()):
    """Garde des arguments d'un ``git`` lancé SANS shell.

    AUDIT 2026-08-23 — ``BAD_CHARS`` ne s'applique plus aux VALEURS LIBRES.

    ``_run_cmd`` invoque ``subprocess.run(cmd, …)`` avec une LISTE et sans
    ``shell=True`` : aucun shell n'interprète quoi que ce soit, ce garde n'a
    donc aucune valeur défensive sur une valeur libre — il ne produisait que
    des faux positifs. Trois valeurs fournies par le MODÈLE le traversaient :
    le message de commit, celui d'un stash, et le motif de grep/find_text.
    Conséquences mesurées : impossible de produire un message Conventional
    Commits avec corps (``\n`` interdit), ni « feat: A & B », ni
    « fix: ne plus écraser $HOME » ; et ``find_text(pattern='re:return 1$')``
    ou ``'re:foo|bar'`` échouaient sur ``shell_chars_forbidden_in_git_args``,
    un code sans aucun rapport — l'agent repartait en diagnostic et brûlait
    des itérations. La docstring de ``git_commit`` réclame pourtant un corps,
    et le code tronque le message à 2 000 caractères.

    Les refs et chemins restent validés par ``_safe_ref`` / ``_safe_rel`` ;
    ce garde continue de couvrir tout le reste de l'argv.
    """
    for i, tok in enumerate(tokens):
        if i in free_text_idx:
            continue
        if any(c in tok for c in BAD_CHARS):
            raise ValueError("Shell chars forbidden in git args")

def _safe_repo_path(repo: str, sandbox: Path) -> Path:
    """v15 — Resolve ``repo`` (relative path OR legacy name) to a repo dir.

    Accepts:
      * a relative path under the sandbox: ``myproj``, ``code/web-app``
      * legacy: a name that lives under ``git_repos/`` (warns + suggests
        moving)

    Returns: the absolute Path of the repo (verified to contain ``.git/``).

    Aligned with fs/shell semantics: anything under
    ``<sandbox>/<user>/`` is fair game, as long as it's a git repo. No
    forced subdir.
    """
    if not repo:
        raise ValueError(
            "repo required — pass repo='<path>' (relative to sandbox root, "
            "e.g. 'myproject' or 'code/web-app'). Use git_query(action='repos') "
            "to discover existing repos."
        )
    p = Path(repo).expanduser()
    if p.is_absolute():
        raise ValueError(
            f"repo must be a RELATIVE path, not absolute. Got: {repo!r}. "
            f"Pass just the path within your sandbox, e.g. 'myproject' or "
            f"'code/web-app'."
        )
    if ".." in p.parts:
        raise ValueError(
            f"repo path may not contain '..' (path traversal). Got: {repo!r}."
        )

    # 1) <sandbox>/<repo>, puis 2) l'ancien <sandbox>/git_repos/<repo> —
    # vus par l'agent (un lien qui sort de /work n'y mène à rien).
    esp, base = _espace_of(sandbox)
    rel = posixpath.normpath(posixpath.join(base, p.as_posix()))
    rel = "" if rel == "." else rel
    legacy = posixpath.join(base, USER_GIT_SUBDIR, p.as_posix()) if base else \
        posixpath.join(USER_GIT_SUBDIR, p.as_posix())
    try:
        e = esp.stats([rel, posixpath.join(rel, ".git") if rel else ".git",
                       legacy, posixpath.join(legacy, ".git")])
    except AgentError as ex:
        raise ValueError(f"repo_unavailable: {ex.code} — the sandbox could not be "
                         f"reached; retry in a moment") from None
    if e[0].get("kind") == "dir" and e[1].get("kind") in ("dir", "file"):
        return sandbox / p
    if e[2].get("kind") == "dir" and e[3].get("kind") in ("dir", "file"):
        # Emit a one-line stderr deprecation note. The MCP server captures
        # stderr in its logs so admins see it without polluting tool output.
        print(
            f"[git_tools] DEPRECATION: legacy {USER_GIT_SUBDIR}/{repo} layout used "
            f"— move repos to sandbox root for full alignment with fs/shell tools.",
            file=__import__("sys").stderr,
        )
        return sandbox / USER_GIT_SUBDIR / p

    # 3) Neither layout matched → helpful error with discovery hint
    raise ValueError(
        f"Repo not found: {repo}. "
        f"Use git_query(action='repos') to list discoverable repos in your "
        f"sandbox. To create one: git_clone(url='https://...', into_path={repo!r}) "
        f"or via git_action(action='init', repo={repo!r})."
    )


# Backwards-compat alias for code that still references _safe_repo.
def _safe_repo(repo, base):
    return _safe_repo_path(repo, base)

def _safe_rel(rel):
    """Validate a path is relative-and-safe (no leading /, no ~, no ../).
    Returns the normalized (forward-slash) form.

    Verbose error messages so the LLM doesn't have to guess what's wrong
    when it accidentally passes an absolute or escaping path.
    """
    if not rel:
        raise ValueError(
            "path required — pass a path RELATIVE to the repo root, "
            "e.g. path='src/main.py' or path='README.md'"
        )
    s = rel.strip().replace("\\", "/")
    if s.startswith("/"):
        raise ValueError(
            f"Invalid path: {s!r}. Use a path RELATIVE to the repo root, "
            f"not absolute. Try path='{s.lstrip('/')}' instead."
        )
    if s.startswith("~"):
        raise ValueError(
            f"Invalid path: {s!r}. Tilde expansion is not performed; pass a "
            f"path relative to the repo root."
        )
    if ":" in s:
        raise ValueError(
            f"Invalid path: {s!r}. Colons are not permitted in paths "
            f"(possible scheme prefix or Windows drive)."
        )
    if ".." in s.split("/"):
        raise ValueError(
            f"Invalid path: {s!r}. '..' (path traversal) is blocked. "
            f"Use only paths inside the repo root."
        )
    if s.startswith("-"):
        raise ValueError(
            f"Invalid path: {s!r}. Paths starting with '-' are blocked "
            f"(could be misinterpreted as a CLI flag). Try './{s}' if "
            f"the file genuinely starts with a dash."
        )
    return s

def _safe_ref(ref: str) -> str:
    """Allow alphanumerics, slash, dot, dash, underscore, @, tilde (HEAD~1)."""
    if not ref: raise ValueError("ref required")
    if not re.fullmatch(r"[A-Za-z0-9._/\-@~^]+", ref):
        raise ValueError(f"Invalid ref: {ref!r}")
    if ref.startswith("-"):
        raise ValueError("ref cannot start with '-'")
    return ref

# ── git par l'agent de la sandbox (L4.4) ──────────────────────────────
# Toutes les commandes git tournent DANS le conteneur, sous l'UID de la
# sandbox (``git_ops``) ; les chemins hôte ne servent que de repères
# lexicaux, jamais ouverts. ``_WORK_ROOTS`` (racine /work → compte),
# alimenté par ``_sandbox()`` au début de chaque outil, dit à ``_run_cmd``
# quel agent interroger et rend les ``cwd`` dans l'espace du conteneur
# (``/work/...``), le seul que ré-acceptent les autres outils.
_WORK_ROOTS: Dict[str, str] = {}
_WORK_ROOTS_MAX = 512


def _remember_work_root(p, username: str) -> None:
    _WORK_ROOTS.pop(str(p), None)
    _WORK_ROOTS[str(p)] = username
    while len(_WORK_ROOTS) > _WORK_ROOTS_MAX:     # borne mémoire : la plus ancienne part
        del _WORK_ROOTS[next(iter(_WORK_ROOTS))]


def _root_of(p) -> Optional[str]:
    q = str(p)
    best = ""
    for r in _WORK_ROOTS:
        if (q == r or q.startswith(r.rstrip("/") + "/")) and len(r) > len(best):
            best = r
    return best or None


def _espace_of(p) -> Tuple[Espace, str]:
    """(espace du compte, chemin relatif à /work) du chemin hôte ``p``."""
    root = _root_of(p)
    if root is None:
        raise ValueError("sandbox root unknown (internal: _sandbox() not called)")
    rel = rel_under(Path(root), Path(p))
    return Espace(_WORK_ROOTS[root], Path(root)), "" if rel == "." else rel


def _container_cwd(p) -> str:
    """Chemin hôte → vue conteneur ``/work[/rel]``. Ne rend JAMAIS un chemin hôte."""
    root = _root_of(p)
    rel = str(p)[len(root):].strip("/") if root else ""
    return "/work" + ("/" + rel if rel else "")


def _envelope(cmd, cwd, r, timeout, max_out):
    if r.timed_out:
        return _err("timeout", hint=f"Exceeded {timeout}s.", cmd=cmd, returncode=124,
                    duration_ms=r.duration_ms)
    out, t1 = _trunc(r.stdout, max_out)
    err_, t2 = _trunc(r.stderr, max_out)
    return _ok(cmd=cmd, cwd=_container_cwd(cwd), returncode=r.returncode, stdout=out,
               stderr=err_, truncated=t1 or t2 or r.truncated, duration_ms=r.duration_ms)


def _run_cmd(cwd, cmd, timeout=TIMEOUT, max_out=MAX_OUT, free_text_idx=frozenset()):
    """``cmd`` = ``["git", …]`` dans ``cwd`` (chemin hôte, repère lexical),
    exécuté par l'agent. ``free_text_idx`` : positions d'argv qui portent une
    VALEUR libre (message de commit, motif de recherche) — exemptées de
    ``BAD_CHARS``, cf. ``_reject``."""
    _reject(cmd, free_text_idx)
    if not cmd or cmd[0] != "git":
        raise ValueError("git command expected")
    try:
        esp, rel = _espace_of(cwd)
        # Octets demandés à l'agent : 4 par caractère gardé (UTF-8).
        r = esp.git(rel, cmd[1:], timeout_s=timeout, max_out=max_out * 4)
    except AgentError as e:
        return _err(e.code, hint=e.message or "sandbox agent unavailable", cmd=cmd,
                    returncode=1)
    return _envelope(cmd, cwd, r, timeout, max_out)


def _run_git_ro(rp, args, timeout=TIMEOUT, max_out=MAX_OUT,
                free_text_idx=frozenset()):
    """``free_text_idx`` : positions DANS ``args`` (avant l'ajout de « git »)
    qui portent une valeur libre — motif de recherche, notamment. Cf.
    ``_reject`` : ces valeurs ne passent par aucun shell."""
    if not args: return _err("args empty")
    if args[0].lower() not in READONLY_SUBS:
        return _err("subcommand_not_allowed",
                    hint=f"Read-only allows: {sorted(READONLY_SUBS)}")
    return _run_cmd(rp, ["git"] + args, timeout, max_out,
                    free_text_idx={i + 1 for i in free_text_idx})


def _uid_of(username: str) -> int:
    try:
        from shared_infra.accounts.users import get_user
        row = get_user(username)
        return int(row["id"]) if row else 0
    except Exception:                                           # noqa: BLE001
        return 0


def _run_network(cwd, args, username, *, url, push_refs=None, auth=None, timeout=120):
    """Commande git réseau vers ``url`` (clone, fetch, ls-remote ; push des
    seules ``push_refs``) par le relais authentifiant : l'identifiant
    (``auth`` donné, sinon celui du connecteur) est ajouté par l'hôte, il
    n'entre jamais dans la sandbox."""
    cmd = ["git", *args]
    try:
        esp, rel = _espace_of(cwd)
        r = esp.git_reseau(rel, args, uid=_uid_of(username), url=url, push_refs=push_refs,
                           auth=auth, timeout_s=timeout, max_out=MAX_OUT * 4)
    except RelayRefused as e:
        return _err(e.code, hint=e.message, cmd=cmd, returncode=1)
    except AgentError as e:
        return _err(e.code, hint=e.message or "sandbox agent unavailable", cmd=cmd,
                    returncode=1)
    return _envelope(cmd, cwd, r, timeout, MAX_OUT)


def _remote_url(rp, remote: str, *, push: bool = False) -> str:
    """URL unique du remote ``remote`` du dépôt ``rp`` (``RelayRefused``)."""
    esp, rel = _espace_of(rp)
    return esp.git_remote_url(rel, remote, push=push)


def _run_pull(rp, remote, branch, mode, username, *, timeout=120):
    """``git pull <mode> <remote> [<branch>]`` : fetch par le relais, fusion
    locale (``git_ops.pull``)."""
    cmd = ["git", "pull", mode, remote, *([branch] if branch else [])]
    try:
        esp, rel = _espace_of(rp)
        r = esp.git_pull(rel, remote, branch, mode, uid=_uid_of(username), timeout_s=timeout,
                         max_out=MAX_OUT * 4)
    except RelayRefused as e:
        return _err(e.code, hint=e.message, cmd=cmd, returncode=1)
    except AgentError as e:
        return _err(e.code, hint=e.message or "sandbox agent unavailable", cmd=cmd,
                    returncode=1)
    return _envelope(cmd, rp, r, timeout, MAX_OUT)


def _repo_file(root, rp, rel) -> str:
    """Chemin relatif à la sandbox du fichier ``rel`` du dépôt ``rp``, sans
    lire le disque : les liens sont résolus par l'agent, sous /work."""
    s = _safe_rel(rel)
    base = rel_under(root, rp)
    base = "" if base == "." else base
    r = posixpath.normpath(posixpath.join(base, s) if base else s)
    if r in (".", "..") or r.startswith("../") or (base and r != base and not r.startswith(base + "/")):
        raise ValueError("path outside repo")
    return r


# Contenu d'un fichier de dépôt : lu et écrit par l'agent de la sandbox
# (L4.2), comme les outils fichiers.
def _read_bytes_under(esp, rel, max_b) -> bytes:
    try:
        e = esp.stat(rel)
        if e["kind"] == "missing":
            raise FileNotFoundError("not_found")
        if e["kind"] == "dir":
            raise IsADirectoryError("is_dir")
        size = int(e.get("size") or 0)
        if size > max_b:
            raise ValueError(f"too_large: {size}B")
        return esp.lire(rel, max_bytes=max_b).data
    except AgentError as ex:
        raise ValueError(ex.code) from None


def _read_text(esp, rel, max_b):
    """Lecture tolérante (``git_query read``) : remplacement des octets non
    UTF-8, fins de ligne normalisées en ``\\n``."""
    text = _read_bytes_under(esp, rel, max_b).decode("utf-8", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _read_text_exact(esp, rel, max_b):
    """Lecture pour une RÉÉCRITURE (``git_write`` replace/append) : octets
    décodés en UTF-8 STRICT, fins de ligne conservées. AUDIT 2026-09-26 — la
    lecture tolérante (``errors="replace"``, sauts de ligne universels)
    réécrivait tout octet non UTF-8 en U+FFFD (fichier Latin-1 corrompu) et
    convertissait un fichier CRLF entier en LF."""
    try:
        return _read_bytes_under(esp, rel, max_b).decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("not_utf8: this file is not UTF-8 text — rewriting it "
                         "would corrupt it; use execute_shell (iconv, sed) instead")


def _write_atomic(esp, root, rel, content, max_b):
    """Écriture atomique de ``git_write`` par l'agent (audit éditeur
    2026-09-23) : verrou par fichier PARTAGÉ avec l'éditeur et les outils fs
    (E7), mode du fichier existant CONSERVÉ (E18) et élargi pour l'autre UID
    tant que l'hôte accède à /work."""
    from shared_infra.sandbox.file_lock import file_write_lock

    from .fs_tools import _mode_ecrit
    b = content.encode("utf-8", errors="replace")
    if len(b) > max_b: raise ValueError(f"too_large: {len(b)}B")
    try:
        with file_write_lock(os.path.realpath(Path(root) / rel)):
            esp.ecrire(rel, b, parents=True, mode=_mode_ecrit(esp.stat(rel)))
    except AgentError as ex:
        raise ValueError(ex.code) from None


def _history_before(esp, rel):
    """Contenu avant écriture, pour l'historique de session (2026-09-23) :
    octets, ``None`` (absent, pas un fichier ordinaire), ``TOO_BIG``. Un lien
    sous /work est suivi, comme par l'écriture."""
    from shared_infra.sandbox.file_history import MAX_FILE, TOO_BIG
    try:
        e = esp.stat(rel)
        if e["kind"] != "file":
            return None
        if int(e.get("size") or 0) > MAX_FILE:
            return TOO_BIG
        return esp.lire(rel, max_bytes=MAX_FILE).data
    except Exception:                                           # noqa: BLE001
        return None


def _history_after(username, sandbox_root, p, before, after) -> None:
    """Note l'écriture de ``git_write`` dans l'historique de session des
    fichiers (chemin relatif à la sandbox : ``repo/path``). Jamais bloquant."""
    try:
        from .fs_tools import _history_record
        _history_record(username, Path(sandbox_root), Path(p), before, after)
    except Exception:
        pass


def _git_write_fc(sandbox_root, p, before, after) -> Dict[str, Any]:
    """``files_changed`` d'un ``git_write`` (chemin /work + empreintes des
    versions de l'historique + lignes ±) pour le diff du chat (2026-09-26)."""
    try:
        from .fs_tools import _fc_entry, _line_diff_stats
        ent = _fc_entry(Path(p), Path(sandbox_root), "created" if before is None else "modified",
                        before, after)
        if ent["new_sha256"] and (before is None or ent["old_sha256"]):
            ent["lines_added"], ent["lines_removed"] = _line_diff_stats(
                (before or b"").decode("utf-8", "replace"), after.decode("utf-8", "replace"))
        return {"files_changed": [ent]}
    except Exception:                                           # noqa: BLE001
        return {}


def _validate_branch(b):
    if not b or any(c.isspace() for c in b) or b.startswith("-") or ".." in b or "~" in b or ":" in b:
        raise ValueError(f"Invalid branch name: {b!r}")
    return b

def _current_branch(rp):
    # `branch --show-current` (git ≥ 2.22) resolves the branch even on an
    # UNBORN branch (fresh init / `switch -c` before the first commit), where
    # `rev-parse --abbrev-ref HEAD` exits 128 — that made git_commit see
    # branch="" on new repos and deny with not_agent_branch.
    r = _run_git_ro(rp, ["branch", "--show-current"], TIMEOUT, 2000)
    if r.get("ok") and r.get("returncode") == 0:
        b = (r.get("stdout") or "").strip()
        if b:
            return b
    # Empty output = detached HEAD (or very old git) → legacy fallback.
    r = _run_git_ro(rp, ["rev-parse", "--abbrev-ref", "HEAD"], TIMEOUT, 2000)
    if not r.get("ok"): return None
    b = (r.get("stdout") or "").strip()
    return b if b and b != "HEAD" else None


def _head_is_unborn(rp) -> bool:
    """True when the repo has no commit yet (HEAD points to an unborn branch)."""
    r = _run_git_ro(rp, ["rev-parse", "--verify", "-q", "HEAD"], timeout=4, max_out=200)
    return not (r.get("ok") and r.get("returncode") == 0)


# Sujet du commit racine créé par git_action(init). `git init -b main` seul
# laisse la branche UNBORN (« fantôme » : switch main → invalid reference) —
# on matérialise donc main par un commit vide immédiat. Ce sujet sert aussi
# de marqueur : tant que l'historique se réduit à CE seul commit, le repo est
# « pristine » et git_commit autorise le premier vrai commit sur main.
_INIT_SCAFFOLD_MSG = "chore: initialize repository"


def _head_is_pristine(rp) -> bool:
    """True si le repo n'a encore AUCUN contenu réel : HEAD unborn, ou un
    unique commit = le scaffold posé par git_action(init)."""
    if _head_is_unborn(rp):
        return True
    n = _run_git_ro(rp, ["rev-list", "--count", "HEAD"], timeout=4, max_out=200)
    if not (n.get("ok") and n.get("returncode") == 0):
        return False
    try:
        if int((n.get("stdout") or "0").strip()) != 1:
            return False
    except ValueError:
        return False
    s = _run_git_ro(rp, ["log", "-1", "--pretty=format:%s"], timeout=4, max_out=500)
    return bool(s.get("ok")) and (s.get("stdout") or "").strip() == _INIT_SCAFFOLD_MSG


# ───────────────────────────────────────────────────────────────────────
#  v15 — Policy helpers: protected branches, agent branches, providers,
#  credentials, git config bootstrap.
# ───────────────────────────────────────────────────────────────────────

def _load_repo_policy(username: str, root: Path, rp: Path) -> Dict[str, Any]:
    """Politique de branches du dépôt : valeurs par défaut
    (``DEFAULT_PROTECTED_BRANCHES`` / ``DEFAULT_AGENT_BRANCH_PREFIXES``),
    que ``.git-tool-policy.json`` peut RENFORCER, jamais assouplir.

    Format::
      {"protected_branches": ["release/*"], "allowed_agent_prefixes": ["agent/"]}

    Le fichier vit dans le dépôt, donc à portée de l'agent (2026-09-29) : il
    AJOUTE des branches protégées et RESTREINT les préfixes de push de l'agent
    (intersection avec les valeurs par défaut). Lu par l'agent de la sandbox
    (64 Kio au plus) ; absent, illisible ou mal formé : valeurs par défaut.
    Agent injoignable : ``ValueError`` — la politique ne s'assouplit jamais
    parce qu'elle n'a pas pu être lue."""
    pol = {
        "protected_branches":     list(DEFAULT_PROTECTED_BRANCHES),
        "allowed_agent_prefixes": list(DEFAULT_AGENT_BRANCH_PREFIXES),
    }
    try:
        rel = posixpath.join(rel_under(root, rp), ".git-tool-policy.json")
        brut = Espace(username, root).lire(rel, max_bytes=64 * 1024).data
        user_pol = json.loads(brut.decode("utf-8", errors="replace"))
    except AgentError as e:
        if e.code in ("not_found", "is_dir", "not_file", "too_large", "denied", "outside_root"):
            return pol
        raise ValueError(f"policy_unreadable: {e.code} — the branch policy of this repo "
                         "could not be read; retry in a moment") from None
    except Exception:         # JSON trop imbriqué (RecursionError) compris
        return pol
    if not isinstance(user_pol, dict):
        return pol

    def _strings(key):
        v = user_pol.get(key)
        return v if isinstance(v, list) and all(isinstance(x, str) for x in v) else None

    extra = _strings("protected_branches") or []
    pol["protected_branches"] += [b for b in extra if b not in pol["protected_branches"]]
    narrow = _strings("allowed_agent_prefixes")
    if narrow is not None:
        pol["allowed_agent_prefixes"] = [x for x in pol["allowed_agent_prefixes"] if x in narrow]
    return pol


def _is_protected(branch: str, policy: Dict[str, Any]) -> bool:
    """Match a branch name against protected patterns (exact or glob)."""
    if not branch:
        return False
    for pat in policy.get("protected_branches", []):
        if pat == branch:
            return True
        if "*" in pat and fnmatch.fnmatch(branch, pat):
            return True
    return False


def _is_agent_branch(branch: str, policy: Dict[str, Any]) -> bool:
    """Check if a branch name starts with an allowed agent prefix."""
    if not branch:
        return False
    for pfx in policy.get("allowed_agent_prefixes", []):
        if branch.startswith(pfx):
            return True
    return False


_INTENT_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,40}$")

def _validate_intent_slug(slug: str) -> str:
    """Validate a branch_intent — lowercase, alphanum + dashes, 3-41 chars."""
    if not slug:
        raise ValueError(
            "branch_intent required — short kebab-case description of what "
            "you're about to do, e.g. 'fix-login-validation' or 'add-csv-export'. "
            "Must match: ^[a-z0-9][a-z0-9-]{2,40}$"
        )
    if not _INTENT_SLUG_RE.match(slug):
        raise ValueError(
            f"Invalid branch_intent {slug!r} — must be lowercase, start with "
            f"alphanumeric, contain only [a-z0-9-], length 3-41. Examples: "
            f"'fix-login-validation', 'add-csv-export'."
        )
    return slug


def _generate_agent_branch(intent: str, prefix: str = "agent/") -> str:
    """Build a unique agent branch name: ``agent/<intent>-<8hex>``."""
    suffix = _sec.token_hex(4)  # 8 hex chars
    return f"{prefix}{intent}-{suffix}"


def _default_base_branch(rp: Path) -> str:
    """Detect the default base branch by asking the remote, then fall back
    to common names that exist locally.

    Order:
      1. ``refs/remotes/origin/HEAD`` (set by ``clone``) — local, no network
      2. Local presence of ``main``, then ``master``, then ``develop``
      3. Last resort: the currently checked-out branch (caller decides)
    """
    # 1. HEAD distant mémorisé au clone. ``git remote show origin``
    # interrogeait le serveur à chaque appel (2026-09-29).
    # Sans ``--short`` : une branche locale « origin/main » le ferait
    # répondre « remotes/origin/main ».
    r = _run_cmd(rp, ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
                 timeout=4, max_out=200)
    if r.get("ok") and r.get("returncode") == 0:
        ref = (r.get("stdout") or "").strip()
        if ref.startswith("refs/remotes/origin/") and len(ref) > 20:
            return ref[20:]

    # 2. Probe local branches in priority order
    for cand in ("main", "master", "develop", "trunk"):
        r = _run_git_ro(rp, ["rev-parse", "--verify", f"refs/heads/{cand}"], timeout=4, max_out=200)
        if r.get("ok") and r.get("returncode") == 0:
            return cand

    # 3. Fall back to current HEAD (will be handled by caller)
    return _current_branch(rp) or "main"


def _ensure_git_config(rp: Path, username: str) -> None:
    """Idempotent: make sure user.email + user.name are set on the repo.

    Defaults to ``<username>@elpis.local`` and ``<username> (Elpis agent)``
    if not present. Local config only — doesn't touch ``--global``.
    """
    def _has(key: str) -> bool:
        r = _run_cmd(rp, ["git", "config", "--local", "--get", key], timeout=3, max_out=200)
        return r.get("ok") and r.get("returncode") == 0 and (r.get("stdout") or "").strip() != ""

    if not _has("user.email"):
        _run_cmd(rp, ["git", "config", "--local", "user.email", f"{username}@elpis.local"], timeout=3)
    if not _has("user.name"):
        _run_cmd(rp, ["git", "config", "--local", "user.name", f"{username} (Elpis agent)"], timeout=3)




def _detect_provider(remote_url: str) -> Dict[str, str]:
    """Parse a git remote URL into ``{provider, host, owner, repo}``.

    Délègue à la source unique ``shared_infra.git.detect.detect_provider``
    (partagée avec les routes et le résolveur de connecteurs)."""
    from shared_infra.git.detect import detect_provider
    return detect_provider(remote_url)






def register(mcp: FastMCP, root_base: Path) -> None:
    root_base = root_base.resolve()

    # Fichiers de l'arbre de travail modifiés par une action git (switch,
    # restore, pull, stash, merge, reset…) : relevés avant / après pour
    # l'historique de session et les diffs du chat (2026-09-26).
    from llm_core.tools._work_changes import tracked as _tracked, uid_for as _uid_for
    _GIT_MUTATING = {"switch", "restore", "pull", "stash", "stash_pop", "merge", "cherry_check"}

    def _track_root(args):
        act = args.get("action")
        if act is not None and (act not in _GIT_MUTATING or args.get("dry_run")):
            return None
        _u = get_username(args.get("ctx"))
        if not _u:
            return None
        return (_uid_for(_u), _u, _sandbox(_u))

    def _sandbox(username: str) -> Path:
        """v16 — Aligned with fs_tools._sandbox / shell_tools._sandbox.

        Returns the user's WORK root ``<sandbox>/<user>/work/`` — the dir
        bind-mounted as ``/work``. Repos can live anywhere in here (each is
        identified by its relative path). ``skills``/``.memory`` stay at the
        per-user root, OUTSIDE the mount. Sanitization via the single-source
        ``safe_sandbox_name`` (was a weaker inline filter that diverged from
        fs/shell on unicode names → a different ``work/``).
        """
        try:
            from shared_infra.config import safe_sandbox_name as _ssn
            safe = _ssn(username)
        except Exception:
            safe = "".join(c for c in (username or "") if c.isalnum() or c in "-_") or "guest"
        base = Path(os.environ.get("APP_SANDBOX_DIR") or str(root_base)).resolve()
        from shared_infra.sandbox import ensure_work_subdir
        work = ensure_work_subdir(base / safe)
        # Mémorise la racine /work de cet utilisateur : _run_cmd en déduit
        # l'agent à interroger et la vue conteneur de ses `cwd`.
        _remember_work_root(work, username)
        return work

    # Backwards-compat alias: existing code still calls _git_root inside
    # this register's closure. Now it points to the sandbox root (not
    # git_repos/), so the helper layer above (_safe_repo_path) handles
    # both new and legacy layouts.
    _git_root = _sandbox

    # ── 1. git_query — read-only queries ─────────────────────────────────
    @mcp.tool(**_TOOL_KW_RO)
    def git_query(
        ctx: Context,
        repo: str,
        action: Literal["status", "log", "diff", "show", "blame", "branches",
                        "tags", "remotes", "conflicts", "grep", "files",
                        "find_text", "read", "repos"],
        target: str = "",
        target2: str = "",
        pattern: str = "",
        max_count: int = 200,
        ignore_case: bool = True,
        start_line: int = 1,
        max_lines: int = 200,
    ) -> Union[GitQueryResult, ErrEnvelope]:
        """Git read-only queries. action:
  status        : porcelain + branch info
  log           : oneline log (max_count). target=ref to log from.
  diff          : target=ref or 'staged' or 'HEAD~1' (vs working tree).
                  target2 set → diff target..target2 (ranges).
  show          : target=ref (commit/tag). Full patch + metadata.
  blame         : target=filepath (required). start_line/max_lines optional.
  branches      : list branches. target='all' for remote too.
  tags          : list tags.
  remotes       : list remotes with URLs.
  conflicts     : list files with unresolved conflicts (rebase/merge state).
  grep          : pattern=str, target=pathspec. ignore_case.
  files         : list tracked files. pattern=glob.
  find_text     : pattern=text, target=glob. grep in files (incl. untracked).
  read          : target=filepath. start_line/max_lines slice.
  repos         : v15 — list all git repos found in your sandbox (depth ≤ 3).
                  Does NOT require ``repo`` arg. Returns {repos: [...]} with
                  path + default_branch + is_clean for each."""
        _username = get_username(ctx)
        try:
            act = (action or "").strip().lower()

            # v15 — discovery: doesn't need a repo arg, scans the sandbox
            if act == "repos":
                sb = _sandbox(_username)
                found = []
                # Profondeur ≤ 3 sous /work, sans descendre dans un dépôt :
                # vu par l'agent de la sandbox (git_ops.find_repos).
                for rel in Espace(_username, sb).git_depots(depth=3, limit=50):
                    k = sb / rel
                    entry = {"path": rel}
                    try:
                        br = _current_branch(k)
                        entry["current_branch"] = br or "?"
                        entry["default_branch"] = _default_base_branch(k)
                        st = _run_git_ro(k, ["status", "--porcelain=v1"], timeout=4, max_out=2000)
                        entry["is_clean"] = bool(st.get("ok") and not (st.get("stdout") or "").strip())
                    except Exception:
                        pass
                    if USER_GIT_SUBDIR in Path(rel).parts:
                        entry["legacy_layout"] = True
                    found.append(entry)
                return _ok(repos=found, count=len(found),
                           sandbox_root=str(sb.relative_to(sb.parent.parent)) if sb.parent.parent in sb.parents else "")

            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            # Input tolerance (tools/_toolkit.unquote): models routinely wrap
            # string args in extra quotes — '"HEAD~1"' -> HEAD~1. Strip before use.
            target, target2, pattern = unquote(target), unquote(target2), unquote(pattern)

            if act == "status":
                return _run_git_ro(rp, ["status", "--porcelain=v1", "-b"])

            if act == "log":
                n = max(1, min(max_count, 200))
                args = ["log", f"--max-count={n}", "--oneline", "--decorate"]
                if target: args.append(_safe_ref(target))
                return _run_git_ro(rp, args)

            if act == "diff":
                args = ["diff", "-U1"]
                if target and target2:
                    args.append(f"{_safe_ref(target)}..{_safe_ref(target2)}")
                elif target:
                    tl = target.lower()
                    if "staged" in tl or "cached" in tl:
                        args.append("--staged")
                    else:
                        args.append(_safe_ref(target))
                # else: default = working tree vs index
                return _run_git_ro(rp, args)

            if act == "show":
                if not target: return _err("target required", hint="target=<ref> (commit SHA, tag, HEAD~1, ...)")
                return _run_git_ro(rp, ["show", _safe_ref(target)])

            if act == "blame":
                if not target: return _err("target required (filepath)", hint="target=path/to/file")
                _safe_rel(target)
                # Restrict to line range to avoid huge outputs
                sl = max(1, int(start_line))
                el = sl + max(1, min(int(max_lines), 1000)) - 1
                args = ["blame", "-L", f"{sl},{el}", "--", target]
                return _run_git_ro(rp, args)

            if act == "branches":
                args = ["branch", "-vv"]
                if target == "all": args.append("-a")
                return _run_git_ro(rp, args)

            if act == "tags":
                return _run_git_ro(rp, ["tag", "--list", "--sort=-creatordate"])

            if act == "remotes":
                return _run_git_ro(rp, ["remote", "-v"])

            if act == "conflicts":
                # Files with unresolved merge markers
                r = _run_git_ro(rp, ["diff", "--name-only", "--diff-filter=U"])
                if not r.get("ok"): return r
                files = [l for l in (r.get("stdout") or "").splitlines() if l.strip()]
                return _ok(count=len(files), files=files,
                           hint="Resolve via git_write or manual edit, then re-stage." if files else "")

            if act == "grep":
                if not pattern: return _err("pattern required")
                n = max(1, min(max_count, 2000))
                args = ["grep", "-n", f"--max-count={n}"]
                if ignore_case: args.append("-i")
                args += ["--", pattern]
                _idx_motif = {len(args) - 1}      # le motif : valeur libre
                if target: args.append(_safe_rel(target))
                return _run_git_ro(rp, args, free_text_idx=_idx_motif)

            if act == "files":
                cap = max(1, min(max_count, MAX_FILES))
                pat = pattern or "**/*"
                from .fs_tools import _PROFONDEUR, MAX_WALK, _cle_parcours
                base = rel_under(root, rp)
                base = "" if base == "." else base
                liste = Espace(_username, root).lister(base, depth=_PROFONDEUR, max_entries=MAX_WALK,
                                                       hidden=True, exclude=[".git"])
                out = []
                # fichiers et liens, pas les FIFO/sockets ; ordre du parcours
                for rel in sorted((x["path"][len(base) + 1:] if base else x["path"]
                                   for x in liste.entries if x["kind"] in ("file", "link")),
                                  key=lambda r: _cle_parcours(r, False)):
                    if glob_match(rel, pat):
                        out.append(rel)
                        if len(out) >= cap: break
                return _ok(items=out, count=len(out), glob=pat,
                           truncated=len(out) >= cap or liste.truncated)

            if act == "find_text":
                if not pattern: return _err("pattern required", hint="pattern=<text to search>")
                cap = max(1, min(max_count, 5000))
                # Native `git grep`: multi-thread, indexed, respects .gitignore.
                # Default: fixed-string. Prefix pattern with "re:" for regex (-E).
                args = ["grep", "-n", "-I", f"--max-count={cap}"]
                if ignore_case: args.append("-i")
                if pattern.startswith("re:"):
                    args += ["-E", "--", pattern[3:]]
                else:
                    args += ["-F", "--", pattern]
                _idx_motif = {len(args) - 1}      # le motif : valeur libre
                if target:
                    # `target` becomes a pathspec glob (relative to repo root)
                    args += [":(glob)" + target]
                r = _run_git_ro(rp, args, timeout=15, free_text_idx=_idx_motif)
                if not r.get("ok"):
                    return r
                # `git grep` exits 1 when no match — _run_cmd still returns ok=True.
                hits = []
                for line in (r.get("stdout") or "").splitlines():
                    parts = line.split(":", 2)
                    if len(parts) == 3:
                        try:
                            hits.append({
                                "file": parts[0],
                                "line": int(parts[1]),
                                "text": parts[2][:260],
                            })
                            if len(hits) >= cap:
                                break
                        except ValueError:
                            continue
                return _ok(hits=hits, count=len(hits),
                           truncated=len(hits) >= cap, via="git_grep")

            if act == "read":
                if not target: return _err("target=filepath required")
                text = _read_text(Espace(_username, root), _repo_file(root, rp, target),
                                  MAX_FILE_READ)
                lines = text.splitlines()
                s = max(start_line - 1, 0)
                chunk = lines[s:s + max(1, min(max_lines, 2000))]
                return _ok(path=target, start_line=s+1,
                           total_lines=len(lines), content="\n".join(chunk))

            return _err(f"unknown action: {act}",
                        hint="Use: status|log|diff|show|blame|branches|tags|remotes|conflicts|grep|files|find_text|read")
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── 2. git_write — file modifications ────────────────────────────────
    @mcp.tool(**_TOOL_KW_MUT)
    def git_write(
        ctx: Context,
        repo: str,
        action: Literal["write", "replace"],
        path: str,
        content: str = "",
        find: str = "",
        replace: str = "",
        regex: bool = False,
        mode: Literal["overwrite", "append"] = "overwrite",
        dry_run: bool = False,
    ) -> Union[GitWriteResult, ErrEnvelope]:
        """Modify repo files (doesn't stage or commit). Actions: write|replace.

  write   : create / overwrite / append. mode=overwrite|append. content=text.
  replace : find+replace in file. find=text, replace=text, regex=bool.
  dry_run : preview changes without writing."""
        _username = get_username(ctx)
        try:
            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            act = (action or "").strip().lower()
            rel = _repo_file(root, rp, path)
            p = root / rel
            esp = Espace(_username, root)

            if act == "write":
                mode = (mode or "overwrite").strip().lower()
                if mode not in ("overwrite", "append"):
                    return _err("invalid_mode", hint="Use: overwrite|append")
                new_content = content or ""
                _existe = esp.stat(rel)["kind"] != "missing"
                if mode == "append" and _existe:
                    new_content = _read_text_exact(esp, rel, MAX_FILE_READ) + new_content
                new_bytes = new_content.encode("utf-8", errors="replace")
                if len(new_bytes) > MAX_FILE_WRITE:
                    return _err("too_large", hint=f"Max {MAX_FILE_WRITE} bytes.")
                if dry_run:
                    return _ok(path=path, action=mode, dry_run=True,
                               bytes_after=len(new_bytes),
                               exists_before=_existe)
                _before = _history_before(esp, rel)
                _write_atomic(esp, root, rel, new_content, MAX_FILE_WRITE)
                _after = _history_before(esp, rel)      # octets réellement écrits
                _history_after(_username, root, p, _before, _after)
                return _ok(path=path, bytes=len(new_bytes), action=mode,
                           **_git_write_fc(root, p, _before, _after))

            if act == "replace":
                if not find: return _err("find required")
                text = _read_text_exact(esp, rel, MAX_FILE_READ)
                if not regex:
                    cnt = text.count(find)
                    if cnt == 0:
                        return _ok(path=path, replacements=0, changed=False,
                                   hint="find string not found in file.")
                    new = text.replace(find, replace)
                else:
                    try:
                        # Même garde anti-ReDoS que edit_file (AUDIT 2026-09-26).
                        from .fs_tools import _check_regex_safe
                        _check_regex_safe(find)
                        pat = re.compile(find)
                    except re.error as e:
                        return _err(f"bad_regex: {e}", hint="Escape special chars with \\ .")
                    new, cnt = pat.subn(replace, text)
                    if cnt == 0:
                        return _ok(path=path, replacements=0, changed=False)
                if dry_run:
                    return _ok(path=path, action="replace", dry_run=True,
                               replacements=cnt, bytes_before=len(text.encode()),
                               bytes_after=len(new.encode()))
                _before = _history_before(esp, rel)
                _write_atomic(esp, root, rel, new, MAX_FILE_WRITE)
                _after = _history_before(esp, rel)
                _history_after(_username, root, p, _before, _after)
                return _ok(path=path, replacements=cnt, changed=True,
                           **_git_write_fc(root, p, _before, _after))

            return _err("unknown action", hint="Use: write|replace")
        except (ValueError, FileNotFoundError, IsADirectoryError) as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── 3. git_action — safe workflow (NO commit, NO push) ───────────────
    @mcp.tool(**_TOOL_KW_MUT_OW)
    @_tracked("git", _track_root)
    def git_action(
        ctx: Context,
        repo: str,
        action: Literal[
            "init", "clone", "switch", "stage", "unstage", "restore",
            "fetch", "pull", "stash", "stash_pop", "stash_list",
            "merge", "cherry_check",
        ],
        branch: str = "",
        paths: List[str] = [],
        create: bool = False,
        message: str = "",
        target: str = "",
        strategy: Literal["ff-only", "merge", "rebase", "no-ff", "squash"] = "ff-only",
        dry_run: bool = False,
    ) -> Union[GitActionResult, ErrEnvelope]:
        """Safe git workflow (NO commit, NO push in this version).

Actions:
  init          : initialize a new repo. repo=<n>. Fails if repo exists.
                  Creates <repo>/ at your sandbox root (/work) with `.git/`
                  inside, and MATERIALIZES the initial branch with an empty
                  scaffold commit (so `switch`/`start_work` work right away).
                  branch=<n> sets initial branch (default 'main').
  clone         : clone an HTTPS git URL into <repo>. target=<https-url>
                  (only https:// allowed for safety — no ssh, no file://).
                  branch=<n> optional (clones a specific branch only).
  switch        : switch branch. branch=name. create=True to create.
  stage         : git add. paths=[...] or empty for -A.
  unstage       : git reset HEAD -- <paths>. paths optional (all).
  restore       : git restore <paths> (undo worktree changes). paths required.
  fetch         : git fetch. target=remote (default 'origin').
  pull          : git pull (ff-only by default). target=remote, branch=name.
                  strategy='ff-only'|'merge'|'rebase'.
  stash         : git stash push -u. message optional.
  stash_pop     : git stash pop.
  stash_list    : git stash list.
  merge         : git merge <branch> --ff-only (safe). branch required.
                  strategy='ff-only' (default) | 'no-ff' | 'squash'.
  cherry_check  : dry-run check if `target`=ref can be cherry-picked cleanly.
                  (Does not actually apply — inspect conflicts first.)

dry_run=True   : show what would happen without executing side-effecting ops."""
        _username = get_username(ctx)
        try:
            root = _git_root(_username)
            act = (action or "").strip().lower()

            # ── init / clone : intercept BEFORE _safe_repo (repo doesn't exist yet)
            if act in ("init", "clone"):
                # Validate the repo NAME (not its existence).
                if not repo:
                    return _err(
                        "repo required",
                        hint="Pass repo='<n>' — a folder name to create at your "
                             "sandbox root (/work)."
                    )
                # Reject paths, traversal, absolute, hidden, weird chars.
                if "/" in repo or "\\" in repo or ".." in repo:
                    return _err(
                        f"invalid repo name: {repo!r}",
                        hint="Repo name must be a single folder name (no slashes, no '..')."
                    )
                if not re.fullmatch(r"[A-Za-z0-9._\-]+", repo):
                    return _err(
                        f"invalid repo name: {repo!r}",
                        hint="Allowed chars: letters, digits, dot, dash, underscore."
                    )
                if repo.startswith(".") or repo == ".git":
                    return _err(
                        f"invalid repo name: {repo!r}",
                        hint="Cannot start with '.' or be named '.git'."
                    )
                target_dir = root / repo
                esp = Espace(_username, root)
                try:
                    _existe = esp.stat(repo)["kind"] != "missing"
                except AgentError as e:
                    return _err(e.code, hint=e.message or "sandbox agent unavailable")

                if act == "init":
                    if _existe:
                        return _err(
                            f"repo_exists: {repo}",
                            hint=f"Folder already exists. Use a different repo name "
                                 f"or remove it first via manage_files(action='delete', "
                                 f"path={repo!r}, recursive=True)."
                        )
                    init_branch = _validate_branch(branch) if branch else "main"
                    cmd = ["git", "init", "-q", "-b", init_branch, repo]
                    if dry_run:
                        return _ok(dry_run=True, action="init", repo=repo,
                                   would_run=cmd, would_create=_container_cwd(target_dir))
                    _twin = esp.jumeau_unicode(repo)
                    # Run from root — `git init <path>` creates the folder.
                    r = _run_cmd(root, cmd)
                    if r.get("ok") and r.get("returncode") == 0:
                        # `git init -b main` seul laisse la branche UNBORN
                        # (« fantôme » : switch main → invalid reference, et le
                        # premier commit du workflow partait sur la branche
                        # agent sans que main n'existe jamais). On matérialise
                        # la branche initiale par un commit vide immédiat.
                        _ensure_git_config(target_dir, _username)
                        sc = _run_cmd(target_dir,
                                      ["git", "commit", "--allow-empty",
                                       "-m", _INIT_SCAFFOLD_MSG])
                        r["repo"] = repo
                        r["repo_path"] = _container_cwd(target_dir)
                        r["initial_branch"] = init_branch
                        r["branch_materialized"] = bool(
                            sc.get("ok") and sc.get("returncode") == 0)
                        r["hint"] = (
                            f"Repo initialized — branch '{init_branch}' exists (scaffold "
                            f"commit). Add files with git_write(repo='{repo}', "
                            f"action='write', path='...', content='...'), then commit "
                            f"with git_commit (the FIRST real commit is allowed directly "
                            f"on '{init_branch}'; afterwards use git_start_work)."
                        )
                        if _twin:
                            r["warning"] = _twin
                    return r

                # action == "clone"
                if not target:
                    return _err(
                        "target required",
                        hint="Pass target='<https-url>' (https:// only). "
                             "Example: target='https://github.com/user/repo.git'"
                    )
                url = target.strip()
                if _existe:
                    return _err(
                        f"repo_exists: {repo}",
                        hint=f"Folder already exists at {repo}. Pick another "
                             f"repo name or delete it first."
                    )
                cmd = ["git", "clone", "--depth", "50"]
                if branch:
                    cmd += ["--branch", _validate_branch(branch), "--single-branch"]
                cmd += ["--", url, repo]
                if dry_run:
                    return _ok(dry_run=True, action="clone", repo=repo, url=url,
                               would_run=cmd, would_create=_container_cwd(target_dir))
                _twin = esp.jumeau_unicode(repo)
                # Par le relais : garde anti-SSRF, identifiant du connecteur
                # ajouté par l'hôte (git_ops.run_network).
                r = _run_network(root, cmd[1:], _username, url=url, timeout=120)
                if r.get("error") in ("blocked_remote", "scheme_not_relayed", "malformed_url"):
                    return _err(
                        f"clone_url_blocked: {r.get('fix') or r.get('message')}",
                        hint="Only http(s) URLs are accepted: no ssh/file, no embedded "
                             "credentials, and the host must not resolve to a loopback "
                             "or link-local address (SSRF protection)."
                    )
                # AUDIT 2026-08-23 — ``ok`` signifie « git a pu être lancé » ;
                # le succès RÉEL est dans ``returncode`` : un clone échoué (DNS,
                # auth, dépôt inexistant) rendait ``ok: true`` + « Cloned
                # successfully », et l'agent enchaînait sur un second échec
                # sans rapport apparent avec le premier.
                if not r.get("ok") or r.get("returncode") != 0:
                    _detail = (r.get("stderr") or r.get("stdout")
                               or r.get("fix") or r.get("error") or "")
                    return _err(
                        "clone_failed",
                        hint=(f"git clone a échoué : {str(_detail)[:400]}"
                              or "git clone a échoué (aucune sortie)."),
                        remote=url, repo=repo,
                        returncode=r.get("returncode"))
                r["repo"] = repo
                r["repo_path"] = _container_cwd(target_dir)
                r["url"] = url
                r["hint"] = (
                    f"Cloned successfully. List files with git_query(repo='{repo}', "
                    f"action='files') or browse with list_files(path='{repo}')."
                )
                if _twin:
                    r["warning"] = _twin
                return r

            # ── all other actions: standard path through _safe_repo
            rp = _safe_repo(repo, root)

            def _run_mut(cmd_, **kw):
                return _run_cmd(rp, cmd_, **kw)

            if act == "switch":
                if not branch: return _err("branch required")
                b = _validate_branch(branch)
                cmd = ["git", "switch", "-c", b] if create else ["git", "switch", b]
                if dry_run:
                    return _ok(dry_run=True, would_run=cmd)
                return _run_mut(cmd)

            if act == "stage":
                if not paths:
                    cmd = ["git", "add", "-A"]
                else:
                    safe = [_safe_rel(pp) for pp in paths]
                    cmd = ["git", "add", "--"] + safe
                if dry_run:
                    return _ok(dry_run=True, would_run=cmd)
                return _run_mut(cmd)

            if act == "unstage":
                cmd = ["git", "reset", "HEAD", "--"] + ([_safe_rel(pp) for pp in paths] if paths else [])
                if dry_run: return _ok(dry_run=True, would_run=cmd)
                return _run_mut(cmd)

            if act == "restore":
                if not paths: return _err("paths required", hint="paths=[...] to restore.")
                safe = [_safe_rel(pp) for pp in paths]
                cmd = ["git", "restore", "--"] + safe
                if dry_run: return _ok(dry_run=True, would_run=cmd)
                return _run_mut(cmd)

            if act in ("fetch", "pull"):
                # Par le relais authentifiant : l'URL du remote est vérifiée
                # (anti-SSRF) et seule elle est joignable pendant la commande.
                remote = target or "origin"
                _safe_ref(remote)
                b = _validate_branch(branch) if branch else ""
                if act == "fetch":
                    cmd = ["git", "fetch", remote, *([b] if b else [])]
                    if dry_run:
                        return _ok(dry_run=True, would_run=cmd)
                    try:
                        url = _remote_url(rp, remote)
                    except RelayRefused as e:
                        return _err(e.code, hint=e.message)
                    return _run_network(rp, cmd[1:], _username, url=url, timeout=60)
                mode = {"ff-only": "--ff-only", "rebase": "--rebase",
                        "merge": "--no-rebase"}.get((strategy or "ff-only").lower())
                if mode is None:
                    return _err("bad strategy", hint="ff-only|merge|rebase")
                if dry_run:
                    return _ok(dry_run=True, would_run=["git", "pull", mode, remote,
                                                        *([b] if b else [])])
                return _run_pull(rp, remote, b, mode, _username, timeout=60)

            if act == "stash":
                cmd = ["git", "stash", "push", "-u"]
                _idx_msg = frozenset()
                if message:
                    if len(message) > 200: return _err("message too long (max 200)")
                    cmd += ["-m", message]
                    _idx_msg = {len(cmd) - 1}     # le message : valeur libre
                if dry_run: return _ok(dry_run=True, would_run=cmd)
                return _run_mut(cmd, free_text_idx=_idx_msg)

            if act == "stash_pop":
                cmd = ["git", "stash", "pop"]
                if dry_run: return _ok(dry_run=True, would_run=cmd)
                return _run_mut(cmd)

            if act == "stash_list":
                return _run_git_ro(rp, ["stash", "list"])

            if act == "merge":
                if not branch: return _err("branch required")
                b = _validate_branch(branch)
                strat = (strategy or "ff-only").lower()
                cmd = ["git", "merge"]
                if strat == "ff-only":
                    cmd.append("--ff-only")
                elif strat == "no-ff":
                    cmd.append("--no-ff")
                elif strat == "squash":
                    cmd.append("--squash")  # leaves changes staged, no commit
                else:
                    return _err("bad strategy", hint="ff-only|no-ff|squash")
                cmd.append(b)
                if dry_run:
                    return _ok(dry_run=True, would_run=cmd,
                               hint="Merge is destructive; inspect 'conflicts' action after if strategy!=ff-only.")
                return _run_mut(cmd)

            if act == "cherry_check":
                if not target: return _err("target required (ref to pick)")
                ref = _safe_ref(target)
                # This action is advertised as a non-destructive simulation
                # ("No changes were kept"), but its cleanup path runs
                # `reset --hard HEAD`, which wipes ALL uncommitted changes — not
                # just the trial pick. cherry_check is naturally called to
                # inspect BEFORE committing, so the working tree is typically
                # dirty → silent loss of the user's work. Refuse on a dirty tree
                # rather than destroy it. On a clean tree the trial pick is the
                # only pending change, so the reset below safely undoes just it.
                st_r = _run_git_ro(rp, ["status", "--porcelain=v1"], timeout=6, max_out=10000)
                if not st_r.get("ok"):
                    return st_r
                dirty = [l for l in (st_r.get("stdout") or "").splitlines() if l.strip()]
                if dirty:
                    return _err("dirty_tree",
                                hint=("cherry_check undoes its trial pick with "
                                      "'reset --hard', which would also discard your "
                                      "uncommitted changes. Commit or stash them first "
                                      "(action='stash'), then retry."),
                                action="cherry_check", target=ref,
                                dirty=dirty[:50])
                # Use --no-commit + immediate reset to test (tree is clean here).
                r = _run_cmd(rp, ["git", "cherry-pick", "--no-commit", ref])
                # Check if any conflicts
                conflicts_res = _run_git_ro(rp, ["diff", "--name-only", "--diff-filter=U"])
                conflicts = [l for l in (conflicts_res.get("stdout") or "").splitlines() if l.strip()]
                # Always abort (we only wanted to check). The reset only undoes
                # the trial pick: the tree was verified clean above.
                _run_cmd(rp, ["git", "cherry-pick", "--abort"])
                _run_cmd(rp, ["git", "reset", "--hard", "HEAD"])
                return _ok(action="cherry_check", target=ref,
                           would_apply_cleanly=not conflicts,
                           conflicts=conflicts,
                           note="This was a simulation. No changes were kept.",
                           raw=r)

            return _err("unknown action",
                        hint="switch|stage|unstage|restore|fetch|pull|stash|stash_pop|stash_list|merge|cherry_check")
        except (ValueError, FileNotFoundError) as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── RF helpers (same as v1) ──────────────────────────────────────────

    def _is_rf_candidate(p, repo_root):
        if p.suffix.lower() not in RF_LIB_EXTENSIONS or p.name in RF_IGNORE_FILES: return False
        parts = p.relative_to(repo_root).parts
        if any(d in RF_IGNORE_DIRS for d in parts): return False
        nm = p.name.lower()
        if nm.startswith("test_") or nm.endswith("_test.py"): return False
        if any(d in ("tests","test","spec") for d in parts[:-1]): return False
        return True

    def _rf_sources(esp, root, scan_root, repo_root):
        """(chemin, texte, dossiers qui ont un ``__init__.py``) des fichiers
        candidats sous ``scan_root``, listés et lus par l'agent (liens non
        suivis) ; au-delà de MAX_LIB_FILE_BYTES, ignoré."""
        from .fs_tools import _PROFONDEUR, MAX_WALK, _lire_lots
        base = rel_under(root, scan_root)
        base = "" if base == "." else base
        liste = esp.lister(base, depth=_PROFONDEUR, max_entries=MAX_WALK, hidden=True,
                           exclude=sorted(RF_IGNORE_DIRS))
        fichiers = [e for e in liste.entries if e["kind"] == "file"]
        paquets = {posixpath.dirname(e["path"]) for e in fichiers
                   if posixpath.basename(e["path"]) == "__init__.py"}
        cands = sorted(e["path"] for e in fichiers
                       if int(e.get("size") or 0) <= MAX_LIB_FILE_BYTES
                       and _is_rf_candidate(root / e["path"], repo_root))
        for rel, data in _lire_lots(esp, cands, MAX_LIB_FILE_BYTES):
            if data is not None:
                yield root / rel, data.decode("utf-8", errors="replace"), \
                    rel_under(root, (root / rel).parent) in paquets

    def _extract_kw(filepath, repo_root, content, has_init=False):
        if filepath.suffix.lower() == ".py":
            return _extract_kw_py(filepath, repo_root, content, has_init)
        return _extract_kw_robot(filepath, repo_root, content)

    def _extract_kw_py(filepath, repo_root, content, has_init=False):
        try:
            tree = ast.parse(content)
        except Exception: return None
        name = filepath.stem
        cls = next((n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and
                     n.name.replace("_","") == name.replace("_","")), None)
        kws = []
        for node in (ast.walk(cls) if cls else ast.walk(tree)):
            if not isinstance(node, ast.FunctionDef) or node.name.startswith("_"): continue
            args = [a for a in node.args.args if a.arg != "self"]
            defs = node.args.defaults
            off = len(args) - len(defs)
            ai = []
            for i, a in enumerate(args):
                info = {"name": a.arg, "required": i < off}
                if not info["required"]:
                    try: info["default"] = ast.unparse(defs[i-off])
                    except Exception: info["default"] = "?"
                ai.append(info)
            kws.append({"name": node.name.replace("_"," ").title(), "method": node.name,
                        "args": ai, "doc": (ast.get_docstring(node) or "")[:300]})
        if not kws: return None
        rel = filepath.relative_to(repo_root).as_posix()
        mod = rel.replace("/",".").removesuffix(".py")
        return {"library": name, "file": rel, "type": "python",
                "recommended_import": mod if has_init else rel,
                "keywords": kws, "keyword_count": len(kws)}

    def _extract_kw_robot(filepath, repo_root, content):
        kws, imports, cur, section = [], [], None, None
        for line in content.splitlines():
            line = line.rstrip()
            if re.match(r"^\*+\s*Keywords?\s*\*+", line, re.I):
                section = "kw"; cur and kws.append(cur); cur = None; continue
            if re.match(r"^\*+\s*Settings?\s*\*+", line, re.I):
                section = "set"; cur and kws.append(cur); cur = None; continue
            if re.match(r"^\*+", line):
                section = None; cur and kws.append(cur); cur = None; continue
            if section == "set":
                m = re.match(r"^(Library|Resource)\s{2,}(\S+)", line)
                if m: imports.append({"type": m.group(1).lower(), "path": m.group(2)})
            elif section == "kw":
                if line and not line[0] in " \t#":
                    cur and kws.append(cur)
                    cur = {"name": line.strip(), "args": [], "doc": ""}
                elif cur:
                    s = line.strip()
                    if s.startswith("[Documentation]"):
                        cur["doc"] = s.replace("[Documentation]","").strip()[:300]
                    elif s.startswith("[Arguments]"):
                        for a in s.replace("[Arguments]","").split():
                            a = a.strip()
                            if "=" in a:
                                n, d = a.split("=", 1)
                                cur["args"].append({"name": n, "required": False, "default": d})
                            elif a:
                                cur["args"].append({"name": a, "required": True})
        cur and kws.append(cur)
        if not kws: return None
        rel = filepath.relative_to(repo_root).as_posix()
        return {"library": filepath.stem, "file": rel,
                "type": "robot" if filepath.suffix.lower() == ".robot" else "resource",
                "recommended_import": rel, "imports": imports,
                "keywords": kws, "keyword_count": len(kws)}

    # ── 4. git_rf — Robot Framework tools ────────────────────────────────
    @mcp.tool(**_TOOL_KW_RO)
    def git_rf(
        ctx: Context,
        repo: str,
        action: Literal["scan", "find", "settings"],
        subfolder: str = "",
        keyword_name: str = "",
        keywords_used: List[str] = [],
        test_file_path: str = "",
        suite_doc: str = "",
        fuzzy: bool = True,
    ) -> Union[GitRfResult, ErrEnvelope]:
        """Robot Framework tools. action: scan|find|settings.
  scan     : scan repo for RF libraries (with keywords + recommended imports).
  find     : find a keyword by name. fuzzy=True for partial match.
  settings : generate *** Settings *** block from keywords_used=[...]."""
        _username = get_username(ctx)
        try:
            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            act = (action or "").strip().lower()

            esp = Espace(_username, root)

            def _scan_libs(scan_root):
                libs = []
                for fp, content, has_init in _rf_sources(esp, root, scan_root, rp):
                    lib = _extract_kw(fp, rp, content, has_init)
                    if lib: libs.append(lib)
                return libs

            if act == "scan":
                sr = rp
                if subfolder:
                    sr = root / _repo_file(root, rp, subfolder)
                    if esp.stat(rel_under(root, sr))["kind"] != "dir":
                        return _err(f"subfolder not found: {subfolder}")
                libs = _scan_libs(sr)
                summary = [{"library": l["library"], "import": l["recommended_import"],
                            "keywords": l["keyword_count"]} for l in libs]
                catalog = []
                for l in libs:
                    catalog.append(f"── {l['library']} ({l['keyword_count']} kw) import: {l['recommended_import']}")
                    for kw in l.get("keywords", []):
                        args = " ".join(a["name"] for a in kw.get("args", []))
                        catalog.append(f"   • {kw['name']}  {args}")
                return _ok(libraries_found=len(libs), import_summary=summary,
                           catalog_text="\n".join(catalog))

            if act == "find":
                if not keyword_name: return _err("keyword_name required")
                norm = lambda s: s.lower().replace("_"," ").replace("-"," ").strip()
                needle = norm(keyword_name)
                matches = []
                for fp, content, has_init in _rf_sources(esp, root, rp, rp):
                    lib = _extract_kw(fp, rp, content, has_init)
                    if not lib: continue
                    for kw in lib.get("keywords", []):
                        kn = norm(kw["name"])
                        if kn == needle or (fuzzy and needle in kn):
                            matches.append({"keyword": kw["name"], "library": lib["library"],
                                            "file": lib["file"],
                                            "import": lib["recommended_import"],
                                            "args": kw.get("args", []),
                                            "doc": kw.get("doc", ""),
                                            "exact": kn == needle})
                matches.sort(key=lambda m: (0 if m["exact"] else 1, m["keyword"]))
                return _ok(found=bool(matches), query=keyword_name,
                           count=len(matches), matches=matches)

            if act == "settings":
                if not keywords_used: return _err("keywords_used list required")
                norm = lambda s: s.lower().replace("_"," ").replace("-"," ").strip()
                libs = _scan_libs(rp)
                kw_idx = {}
                for l in libs:
                    for kw in l.get("keywords", []):
                        kw_idx.setdefault(norm(kw["name"]), []).append(
                            {"library": l["library"], "import": l["recommended_import"]})
                SELENIUM = {norm(k): 1 for k in ["Open Browser","Close All Browsers","Go To","Click Element",
                    "Input Text","Wait Until Element Is Visible","Element Should Be Visible","Page Should Contain"]}
                resolved, unresolved, needed = [], [], {}
                for kw in keywords_used:
                    n = norm(kw)
                    if n in kw_idx:
                        h = kw_idx[n][0]
                        resolved.append({"keyword": kw, "library": h["library"]})
                        needed[h["library"]] = h["import"]
                    elif n in SELENIUM:
                        resolved.append({"keyword": kw, "library": "SeleniumLibrary"})
                        needed["SeleniumLibrary"] = "SeleniumLibrary"
                    else:
                        unresolved.append(kw)
                lines = ["*** Settings ***"]
                if suite_doc: lines.append(f"Documentation    {suite_doc}")
                lines.append("")
                for lib, imp in needed.items():
                    if lib == "SeleniumLibrary":
                        lines.append("Library    SeleniumLibrary    timeout=10s")
                    else:
                        kw_type = "Resource" if Path(imp).suffix.lower() in (".robot",".resource") else "Library"
                        lines.append(f"{kw_type}    {imp}")
                return _ok(settings_block="\n".join(lines),
                           resolved=resolved, unresolved=unresolved)

            return _err("unknown action", hint="scan|find|settings")
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ═══════════════════════════════════════════════════════════════════
    #  v15 — INTENT-LEVEL TOOLS
    #
    #  The agent's main verbs. Each call bundles many low-level git
    #  operations so the model doesn't have to chain them manually.
    #  Setup, validation, and policy checks happen INSIDE the tool —
    #  invisible to the agent.
    # ═══════════════════════════════════════════════════════════════════

    # ── git_inspect ──────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_RO)
    def git_inspect(
        ctx: Context,
        repo: str,
    ) -> Union[GitInspectResult, ErrEnvelope]:
        """v15 — One-call snapshot of a repo's state.

Replaces ``git_query(action='status') + branches + log + remote``.
Returns a structured dict the agent can read at a glance::

  {
    "ok": true,
    "branch": "agent/fix-login-a1b2c3d4",
    "default_branch": "main",
    "is_protected_branch": false,
    "is_agent_branch": true,
    "dirty": {"staged": 0, "unstaged": 2, "untracked": 1, "files": [...]},
    "ahead": 2,
    "behind": 0,
    "recent_commits": [{"sha": "...", "subject": "..."}],
    "remotes": [{"name": "origin", "url": "..."}],
    "policy": {"protected_branches": [...], "allowed_agent_prefixes": [...]}
  }

Use this BEFORE any write op to know where you stand."""
        _username = get_username(ctx)
        try:
            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            br = _current_branch(rp) or ""
            base = _default_base_branch(rp)
            pol = _load_repo_policy(_username, root, rp)
            is_prot = _is_protected(br, pol)
            is_agent = _is_agent_branch(br, pol)

            # Dirty state via porcelain
            st_r = _run_git_ro(rp, ["status", "--porcelain=v1"], timeout=6, max_out=10000)
            staged = unstaged = untracked = 0
            files: List[Dict[str, str]] = []
            for line in (st_r.get("stdout") or "").splitlines():
                if not line:
                    continue
                # ⚠ BUG 2026-08-08 (trouvé en faisant tourner l'agent ``pr``) —
                # ``line.partition(" ")`` était FAUX : le format porcelain v1 est
                # à COLONNES FIXES (``XY`` puis un espace puis le chemin), et la
                # colonne X vaut ESPACE dès que la modification n'est pas
                # indexée — le cas le plus courant. Sur « M src/parser.py » on
                # obtenait donc ``xy=""`` et ``path="M src/parser.py"`` :
                #   * le chemin remonté portait la lettre de statut (inexploitable
                #     tel quel par l'agent, qui croit à un fichier de ce nom) ;
                #   * les compteurs ``staged``/``unstaged`` restaient à 0, donc
                #     ``git_inspect`` annonçait un arbre propre alors qu'il ne
                #     l'était pas.
                # La persona de l'agent ``pr`` fait de ``git_inspect`` son
                # « always your first call » : il partait donc d'un état faux.
                # Symétriquement « M  fichier » (indexé seul) donnait ``xy="M"``
                # (1 caractère), et le test ``len(xy) >= 2`` ne pouvait plus
                # jamais voir la colonne worktree.
                xy = line[:2]
                path = line[3:].strip().strip('"')
                # Renommage/copie : « R  ancien -> nouveau » — on garde la cible.
                if " -> " in path:
                    path = path.split(" -> ", 1)[1].strip().strip('"')
                # First char = staged status, second = worktree
                if xy[0] not in (" ", "?"):
                    staged += 1
                if len(xy) >= 2 and xy[1] not in (" ", "?"):
                    unstaged += 1
                if xy == "??":
                    untracked += 1
                if len(files) < 30:
                    files.append({"xy": xy, "path": path})

            # Ahead/behind vs upstream (if any)
            ahead = behind = 0
            ab_r = _run_git_ro(rp, ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
                               timeout=4, max_out=200)
            if ab_r.get("ok") and ab_r.get("returncode") == 0:
                parts = (ab_r.get("stdout") or "").split()
                if len(parts) == 2:
                    try:
                        behind, ahead = int(parts[0]), int(parts[1])
                    except ValueError:
                        pass

            # Last 5 commits. Separator via %x7c (git expands to '|' in the
            # OUTPUT) — a literal '|' in the argv trips _reject's BAD_CHARS
            # and aborted the whole tool with shell_chars_forbidden_in_git_args.
            log_r = _run_git_ro(rp, ["log", "-n", "5", "--pretty=format:%H%x7c%s%x7c%an%x7c%ar"],
                                timeout=4, max_out=3000)
            commits: List[Dict[str, str]] = []
            if log_r.get("ok"):
                for line in (log_r.get("stdout") or "").splitlines():
                    p = line.split("|", 3)
                    if len(p) == 4:
                        commits.append({"sha": p[0][:8], "subject": p[1], "author": p[2], "when": p[3]})

            # Remotes
            rem_r = _run_git_ro(rp, ["remote", "-v"], timeout=3, max_out=2000)
            remotes_map: Dict[str, str] = {}
            if rem_r.get("ok"):
                for line in (rem_r.get("stdout") or "").splitlines():
                    parts = line.split()
                    if len(parts) >= 2 and parts[0] not in remotes_map:
                        remotes_map[parts[0]] = parts[1]
            remotes = [{"name": n, "url": u} for n, u in remotes_map.items()]

            return _ok(
                branch=br,
                default_branch=base,
                is_protected_branch=is_prot,
                is_agent_branch=is_agent,
                dirty={"staged": staged, "unstaged": unstaged, "untracked": untracked, "files": files},
                ahead=ahead,
                behind=behind,
                recent_commits=commits,
                remotes=remotes,
                policy=pol,
            )
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── git_start_work ───────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_MUT_OW)
    @_tracked("git", _track_root)
    def git_start_work(
        ctx: Context,
        repo: str,
        branch_intent: str,
        base: str = "",
    ) -> Union[GitStartWorkResult, ErrEnvelope]:
        """v15 — Start working on a repo: setup + create agent branch.

This is the ONLY way an agent should prepare a repo for modification.
Bundles into one call:

  1. Ensure git user.email / user.name are set (auto-fills if missing)
  2. Switch to base branch (auto-detected: main / master / develop)
  3. ``git pull --ff-only`` (silent unless conflict)
  4. Create + switch to ``agent/<branch_intent>-<8hex>``
  5. Returns the new branch name + base used

Args:
  repo            : relative path to the repo (e.g. 'myproj' or 'code/web')
  branch_intent   : kebab-case description, 3-41 chars. e.g. 'fix-login-bug'.
  base            : optional override of the base branch (default: auto-detect)

Returns::
  {ok: true, branch: 'agent/fix-login-bug-a1b2c3d4',
   base: 'main', base_sha: '...', message: '...'}

Idempotent for the SAME branch_intent on the SAME repo when already on
that branch: reuses it (no error).

HARD DENY if base is not a protected branch (refuses to create agent
branches off other agent branches — keeps history clean)."""
        _username = get_username(ctx)
        try:
            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            intent = _validate_intent_slug((branch_intent or "").strip().lower())
            pol = _load_repo_policy(_username, root, rp)

            # 1) Bootstrap git config
            _ensure_git_config(rp, _username)

            # 2) Decide base
            base = (base or "").strip() or _default_base_branch(rp)
            if not _is_protected(base, pol):
                return _err(
                    "base_not_protected",
                    hint=f"Base branch {base!r} is not in protected_branches. "
                         f"Agent branches must be cut from a protected branch (main/master/develop/etc). "
                         f"Either pass base='main' explicitly, or update .git-tool-policy.json.",
                    base=base, protected=pol["protected_branches"],
                )

            cur = _current_branch(rp)

            # Idempotent reuse: same intent already in the current branch name?
            agent_pfx = pol["allowed_agent_prefixes"][0] if pol["allowed_agent_prefixes"] else "agent/"
            if cur and cur.startswith(agent_pfx) and f"-{intent}-" in f"-{cur[len(agent_pfx):]}-":
                # Looks like agent/<intent>-<hex> already
                if cur[len(agent_pfx):].startswith(intent + "-"):
                    return _ok(
                        branch=cur,
                        base=base,
                        message=f"Already on agent branch for intent {intent!r} — reusing.",
                        reused=True,
                    )

            # 3) Switch to base + pull.
            # VIRGIN REPO (no commit yet — e.g. fresh git_action init): the base
            # branch is UNBORN, so `git switch <base>` fails ("invalid
            # reference") and there is nothing to pull. Skip both and cut the
            # agent branch straight from the unborn HEAD (`switch -c` works).
            unborn = _head_is_unborn(rp)
            base_sha = ""
            if unborn:
                if cur and cur != base:
                    return _err(
                        "empty_repo_base_mismatch",
                        hint=f"Repo has no commit yet and HEAD is on unborn branch "
                             f"{cur!r}, not {base!r} — an unborn branch cannot be "
                             f"switched to. Pass base={cur!r}, or make a first "
                             f"commit on {base!r} first.",
                        branch=cur, base=base,
                    )
                pull_note = "skipped (empty repo — no commit yet)"
            else:
                sw = _run_cmd(rp, ["git", "switch", base], timeout=8)
                if not sw.get("ok") or sw.get("returncode") != 0:
                    return _err(
                        "switch_base_failed",
                        hint=f"Couldn't switch to base branch {base!r}. Check for uncommitted "
                             f"changes (use git_inspect first to see dirty state). "
                             f"stderr: {sw.get('stderr', '')[:200]}",
                    )
                # AUDIT 2026-08-02 — le ``git pull`` ci-dessous est une COMMODITÉ
                # (partir d'une base fraîche), NON fatale : offline, pas de
                # remote ou remote refusé (anti-SSRF, par le relais) → on note et
                # on continue ; la création de branche (étapes 4-5) est locale.
                pl = _run_pull(rp, "origin", base, "--ff-only", _username, timeout=20)
                pull_note = "ok" if (pl.get("ok") and pl.get("returncode") == 0) else \
                            f"skipped ({(pl.get('stderr') or pl.get('fix') or pl.get('error') or 'unknown')[:80]})"

                # 4) Capture base sha for record (local — toujours exécuté)
                base_sha_r = _run_git_ro(rp, ["rev-parse", "HEAD"], timeout=3, max_out=200)
                base_sha = (base_sha_r.get("stdout") or "").strip()[:8] if base_sha_r.get("ok") else ""

            # 5) Create agent branch
            new_branch = _generate_agent_branch(intent, prefix=agent_pfx)
            cr = _run_cmd(rp, ["git", "switch", "-c", new_branch], timeout=6)
            if not cr.get("ok") or cr.get("returncode") != 0:
                return _err(
                    "create_branch_failed",
                    hint=f"Could not create branch {new_branch!r}. stderr: {cr.get('stderr', '')[:200]}",
                )

            return _ok(
                branch=new_branch,
                base=base,
                base_sha=base_sha,
                pull=pull_note,
                ready=True,
                message=f"Ready to work on {new_branch!r} (base: {base}). "
                        f"Make your edits via fs.write_file or git_write, then git_commit, then git_submit.",
            )
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── git_commit ───────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_MUT)
    def git_commit(
        ctx: Context,
        repo: str,
        message: str,
        scope: Literal["auto", "staged", "paths"] = "auto",
        paths: List[str] = [],
    ) -> Union[GitCommitResult, ErrEnvelope]:
        """v15 — Stage + commit in one shot. Refuses on protected branches.

Args:
  repo     : relative path to repo
  message  : commit message (imperative-mood subject, max 72 chars first line)
  scope    : 'auto'   → `git add -A` then commit (default; catches mods + new + del)
             'staged' → commit ONLY what's already staged
             'paths'  → stage `paths=[...]` then commit
  paths    : files to stage if scope='paths'

HARD DENY if HEAD is on a protected branch — message points the agent
to call ``git_start_work`` first.

Returns::
  {ok: true, sha: '...', files_changed: 3, insertions: 42, deletions: 7,
   branch: 'agent/...'}"""
        _username = get_username(ctx)
        try:
            if not message or not message.strip():
                return _err("message_empty", hint="Commit message required (imperative mood, e.g. 'Fix login redirect on 401').")
            msg = message.strip()
            # Hard cap to avoid pathological prompts
            if len(msg) > 2000:
                msg = msg[:1997] + "..."

            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            pol = _load_repo_policy(_username, root, rp)
            br = _current_branch(rp) or ""
            # Bootstrap identity here too — the fresh-repo path (init → commit)
            # legitimately never goes through git_start_work.
            _ensure_git_config(rp, _username)

            # A PRISTINE repo (no commit at all, or only the scaffold commit
            # posed by git_action init) is a repo the agent (or user) just
            # created — there is no history to protect, and forcing a
            # git_start_work detour there is pointless. Allow the FIRST real
            # commit on any branch, main included; the protections kick in
            # from the next commit on.
            initial_commit = _head_is_pristine(rp)
            if not initial_commit:
                if _is_protected(br, pol):
                    return _err(
                        "protected_branch",
                        hint=f"HEAD is on protected branch {br!r}. Cannot commit. "
                             f"Call git_start_work(repo={repo!r}, branch_intent='<describe-task>') "
                             f"to create an agent branch first.",
                        branch=br,
                    )
                if not _is_agent_branch(br, pol):
                    return _err(
                        "not_agent_branch",
                        hint=f"Branch {br!r} doesn't match an allowed agent prefix "
                             f"({pol['allowed_agent_prefixes']}). The agent can only commit on "
                             f"branches it created via git_start_work.",
                        branch=br,
                    )

            # Stage according to scope
            scope = (scope or "auto").lower()
            if scope == "auto":
                stg = _run_cmd(rp, ["git", "add", "-A"], timeout=10)
                if not stg.get("ok") or stg.get("returncode") != 0:
                    return _err("stage_failed", hint=f"git add -A failed: {stg.get('stderr', '')[:200]}")
            elif scope == "paths":
                if not paths:
                    return _err("paths_required", hint="scope='paths' requires paths=[...].")
                # Validate each path
                safe_paths = []
                for p in paths:
                    try:
                        safe_paths.append(_safe_rel(p))
                    except ValueError as e:
                        return _err("bad_path", hint=str(e), path=p)
                stg = _run_cmd(rp, ["git", "add", "--"] + safe_paths, timeout=10)
                if not stg.get("ok") or stg.get("returncode") != 0:
                    return _err("stage_failed", hint=f"git add failed: {stg.get('stderr', '')[:200]}")
            # scope == 'staged' → nothing to do

            # Check there's something to commit (avoids empty-commit clutter)
            chk = _run_git_ro(rp, ["diff", "--cached", "--name-only"], timeout=4, max_out=10000)
            staged_files = [l for l in (chk.get("stdout") or "").splitlines() if l.strip()]
            if not staged_files:
                return _err(
                    "nothing_to_commit",
                    hint=f"No staged changes for scope={scope!r}. "
                         f"If you expected changes, check git_inspect to see the dirty state. "
                         f"For untracked files, use scope='auto' or stage explicitly via scope='paths'.",
                )

            # Commit
            # index 3 = le message : valeur libre, multi-lignes autorisée.
            cm = _run_cmd(rp, ["git", "commit", "-m", msg], timeout=10,
                          free_text_idx={3})
            if not cm.get("ok") or cm.get("returncode") != 0:
                return _err("commit_failed", hint=f"git commit failed: {cm.get('stderr', '')[:300]}")

            # Capture metadata
            sha_r = _run_git_ro(rp, ["rev-parse", "HEAD"], timeout=3, max_out=200)
            sha = (sha_r.get("stdout") or "").strip()[:8] if sha_r.get("ok") else ""

            # Stats from the last commit
            stat_r = _run_git_ro(rp, ["log", "-1", "--pretty=format:", "--stat", "--shortstat"], timeout=4, max_out=5000)
            ins = dele = files_n = 0
            for line in (stat_r.get("stdout") or "").splitlines():
                m = re.match(r"\s*(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?", line)
                if m:
                    files_n = int(m.group(1))
                    ins  = int(m.group(2) or 0)
                    dele = int(m.group(3) or 0)
                    break

            out = _ok(
                sha=sha,
                branch=br,
                files_changed=files_n,
                insertions=ins,
                deletions=dele,
                message=msg,
                next_step="When ready to ship for review, call git_submit(repo, title, body, base='main').",
            )
            if initial_commit:
                out["initial_commit"] = True
                out["note"] = ("First real commit of a fresh repo — allowed on any "
                               "branch. From now on, protected-branch rules apply: "
                               "use git_start_work for further changes.")
            return out
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── git_submit ───────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_MUT_OW)
    def git_submit(
        ctx: Context,
        repo: str,
        title: str,
        body: str = "",
        base: str = "",
        draft: bool = True,
    ) -> Union[GitSubmitResult, ErrEnvelope]:
        """v15 — Push current branch + open a PR/MR. Atomic ship-for-review.

Bundles:
  1. Validate HEAD is on an agent branch (HARD DENY otherwise)
  2. ``git push -u origin HEAD`` (authenticated via the matching Git Connector)
  3. Detect remote provider (github / gitlab / bitbucket / gitea)
  4. Resolve credentials from the user's Git Connectors (Settings — NOT a file)
  5. Open PR/MR via REST API
  6. If PR already exists (same head→base) → return existing URL
  7. If no connector matches → return a fallback compare URL for manual creation

Args:
  repo  : relative path
  title : PR title (required, < 256 chars)
  body  : PR description. Empty → auto-generated from branch commits.
  base  : target branch for the PR (default: auto-detected default branch)
  draft : open as draft (default True — prevents accidental auto-merge)

Returns (success)::
  {ok: true, pr_url: 'https://...', pr_number: 42, branch: 'agent/...',
   commits_pushed: 3, draft: true, provider: 'github'}

Returns (no PAT, manual fallback)::
  {ok: true, fallback_url: 'https://github.com/.../compare/main...agent/fix?expand=1',
   message: 'No PAT configured — open the PR manually via fallback_url.'}

Returns (PR already open)::
  {ok: true, pr_url: '...', already_open: true}"""
        _username = get_username(ctx)
        try:
            if not title or not title.strip():
                return _err("title_required", hint="PR title is required (max 256 chars).")
            title = title.strip()[:256]

            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            pol = _load_repo_policy(_username, root, rp)
            br = _current_branch(rp) or ""

            if _is_protected(br, pol):
                return _err(
                    "protected_branch",
                    hint=f"HEAD on {br!r} is protected. Submit only from agent branches.",
                    branch=br,
                )
            if not _is_agent_branch(br, pol):
                return _err(
                    "not_agent_branch",
                    hint=f"Branch {br!r} doesn't match agent prefix. Use git_start_work first.",
                    branch=br,
                )

            # Detect remotes BEFORE push (need them later for PR API)
            rem_r = _run_git_ro(rp, ["remote", "get-url", "origin"], timeout=3, max_out=1000)
            remote_url = (rem_r.get("stdout") or "").strip()
            if not remote_url:
                return _err(
                    "no_remote",
                    hint="No 'origin' remote configured. Add one via `git remote add origin <url>` "
                         "(currently not exposed as a tool — ask the user to do it).",
                )
            prov_info = _detect_provider(remote_url)
            provider = prov_info.get("provider", "unknown")

            # ── Credentials via les Connecteurs Git (host-only) — remplace le
            # fichier .git-credentials.json. Import une-fois de l'ancien fichier,
            # puis résolution par host (self-hosted + multi-comptes).
            from shared_infra.accounts.users import get_user as _get_user_row
            _row = _get_user_row(_username)
            _uid = int(_row["id"]) if _row else 0
            sb = _sandbox(_username)
            cred = None
            if _uid:
                try:
                    from shared_infra.git.resolver import import_legacy_git_credentials, resolve_git_credential
                    import_legacy_git_credentials(_uid, sb)
                    cred = resolve_git_credential(_uid, remote_url)
                except Exception:
                    cred = None

            # Push par le relais authentifiant : URL du remote vérifiée
            # (anti-SSRF), identifiant du connecteur ajouté par l'hôte (jamais
            # dans la sandbox), et seule la branche de l'agent peut bouger.
            _push_timeout = 30
            _has_creds = bool(cred and cred.get("token"))
            try:
                _push_url = _remote_url(rp, "origin", push=True)
            except RelayRefused as e:
                return _err(e.code, hint=e.message)
            pu = _run_network(rp, ["push", "-u", "origin", "HEAD"], _username, url=_push_url,
                              push_refs={f"refs/heads/{br}"}, timeout=_push_timeout)
            if not pu.get("ok") or pu.get("returncode") != 0:
                # AUDIT 2026-08-02 — surface l'erreur RÉELLE du push. Sur TIMEOUT,
                # ``_run_cmd`` renvoie {error:"timeout", fix:…, returncode:124}
                # SANS champ ``stderr`` : l'ancien ``pu.get('stderr','')`` produisait
                # un message VIDE (« push_failed » sans rien), que l'agent rejouait
                # en boucle. On distingue le timeout, et on prend le premier champ
                # non vide (stderr → stdout → fix → message).
                _no_cred_note = ("" if _has_creds else
                                 " (aucun Connecteur Git ne fournit de token pour ce host — "
                                 "ajoutez-en un dans Réglages, ou utilisez un remote SSH)")
                if pu.get("error") == "timeout" or pu.get("returncode") == 124:
                    return _err(
                        "push_timeout",
                        hint=(f"'git push' vers {remote_url!r} n'a pas répondu en "
                              f"{_push_timeout}s : remote probablement injoignable "
                              f"(host/réseau down) ou bloqué sur l'authentification"
                              f"{_no_cred_note}. Vérifiez que l'origin répond avant de "
                              f"réessayer (réessayer à l'identique reboucle sur le même délai)."),
                        branch=br, remote=remote_url, returncode=pu.get("returncode"),
                        timed_out=True,
                    )
                _detail = (pu.get("stderr") or pu.get("stdout")
                           or pu.get("fix") or pu.get("message") or "").strip()
                if not _detail:
                    _detail = ("git n'a renvoyé aucune sortie — échec d'authentification "
                               f"silencieux probable{_no_cred_note}")
                return _err(
                    "push_failed",
                    hint=(f"git push a échoué : {_detail[:400]}. Causes fréquentes : "
                          f"credentials manquants (Connecteur Git / clé SSH), force-push "
                          f"requis (NON auto-activé), ou remote qui refuse."),
                    branch=br, remote=remote_url, returncode=pu.get("returncode"),
                )

            # Count commits ahead of base (for the PR description / metadata)
            target_base = (base or "").strip() or _default_base_branch(rp)
            ahead_r = _run_git_ro(rp, ["rev-list", "--count", f"origin/{target_base}..HEAD"],
                                  timeout=4, max_out=200)
            try:
                commits_pushed = int((ahead_r.get("stdout") or "0").strip())
            except ValueError:
                commits_pushed = 0

            # Auto-generate body if empty
            if not body or not body.strip():
                cmts_r = _run_git_ro(rp, ["log", f"origin/{target_base}..HEAD", "--pretty=format:* %s"],
                                     timeout=4, max_out=4000)
                cmts = cmts_r.get("stdout") or ""
                body = (
                    "(auto-generated by Elpis git_submit)\n\n"
                    f"## Commits in this PR\n{cmts}\n\n"
                    "## Notes\nEdit this description with context, validation steps, "
                    "and screenshots if applicable."
                )
            else:
                body = body.strip()

            # ── Ouverture de la PR/MR via le connecteur résolu (plus de fichier) ──
            host = prov_info.get("host", "")
            owner = prov_info.get("owner", "")
            repo_name = prov_info.get("repo", "")
            from shared_infra.git.providers import compare_url_for, get_provider

            # Pas de connecteur (ou token absent) → repli compare-URL manuel.
            if not cred or not cred.get("token"):
                fallback_url = compare_url_for(provider, host=host, owner=owner,
                                               repo=repo_name, head=br, base=target_base)
                # AUDIT 2026-08-02 (#1) — message explicite pour le self-hosted
                # (Gitea/Forgejo… sur IP = ``provider="unknown"``) : dire QUOI
                # enregistrer plutôt qu'un repli muet à URL parfois vide.
                if provider == "unknown":
                    _msg = (f"Poussé sur origin/{br}, mais l'hôte {host!r} n'est pas reconnu "
                            f"automatiquement (self-hosted). Pour ouvrir la PR SANS saisir de "
                            f"token, enregistrez un Connecteur Git avec le bon provider_type "
                            f"(ex. 'gitea') pour ce host dans Réglages → Connecteurs Git.")
                else:
                    _msg = (f"Poussé sur origin/{br}. Aucun Connecteur Git pour "
                            f"{host or provider} — ouvrez la PR via fallback_url, ou ajoutez "
                            f"un connecteur dans Réglages → Connecteurs Git.")
                return _ok(
                    branch=br, commits_pushed=commits_pushed, provider=provider,
                    fallback_url=fallback_url, message=_msg,
                )

            gp = get_provider(cred["provider_type"])

            # AUDIT 2026-08-23 — deux manques sur cette seule ligne.
            #
            # (1) On injectait ``_http_json``, la copie LOCALE du client HTTP,
            #     restée à la version PRÉ-durcissement : ``urlopen`` avec
            #     l'opener par défaut, dont ``redirect_request`` ne retire que
            #     ``content-length``/``content-type``. Un ``302 Location:
            #     http://169.254.169.254/…`` renvoyé par l'API de PR faisait
            #     donc RÉÉMETTRE l'en-tête ``Authorization`` (= le PAT, en
            #     Basic pour Gitea) vers la cible de la redirection, sans
            #     aucune validation de celle-ci. Le client partagé
            #     ``shared_infra.git._http.http_json`` re-valide CHAQUE saut et
            #     retire l'Authorization au changement de host — c'est celui
            #     qu'injectent déjà les routes UI (git_connectors).
            # (2) L'``api_base`` du connecteur n'était JAMAIS validé, alors que
            #     les routes le passent par ``block_remote_url_reason`` avant
            #     de s'en servir.
            #
            # Politique : celle des outils de l'agent (``_clone_url_block_reason``
            # → ``critical_only``) — loopback et link-local refusés, LAN privé
            # autorisé (c'est là que vit une Gitea self-hosted, en http).
            _api_base = str(cred.get("api_base") or "")
            _blocked = _clone_url_block_reason(_api_base, allow_hosts={host} if host else ())
            if _blocked:
                return _err(
                    "blocked_api_base",
                    hint=f"L'API du connecteur ({_api_base!r}) est refusée par "
                         f"le garde anti-SSRF : {_blocked}. Corrigez l'api_base "
                         f"du Connecteur Git dans Réglages → Connecteurs Git.",
                    branch=br, commits_pushed=commits_pushed,
                    fallback_url=compare_url_for(
                        provider, host=host, owner=owner, repo=repo_name,
                        head=br, base=target_base,
                        provider_type=cred["provider_type"]),
                )
            import functools as _ft

            from shared_infra.git._http import http_json as _hardened_http
            _http = _ft.partial(_hardened_http,
                                ssrf_allow_hosts=({host} if host else set()),
                                ssrf_allow_schemes=("https", "http"))
            result = gp.create_pr(
                _http, api_base=_api_base, token=cred["token"],
                username=cred.get("username", ""), owner=owner, repo=repo_name,
                head=br, base=target_base, title=title, body=body, draft=draft)

            if result.get("error_code") == "no_api":
                fallback_url = compare_url_for(provider, host=host, owner=owner,
                                               repo=repo_name, head=br, base=target_base,
                                               provider_type=cred["provider_type"])
                return _ok(
                    branch=br, commits_pushed=commits_pushed, provider=cred["provider_type"],
                    fallback_url=fallback_url,
                    message=f"Connector {cred['provider_type']!r} has no PR API — "
                            f"open the PR via fallback_url.",
                )
            if not result.get("ok"):
                return _err(
                    result.get("error_code", "pr_open_failed"),
                    hint=f"PR API call failed: {result.get('error', 'unknown')}. "
                         f"Status: {result.get('status')}. Push succeeded though — "
                         f"you can open the PR manually via fallback_url.",
                    fallback_url=compare_url_for(provider, host=host, owner=owner,
                                                 repo=repo_name, head=br, base=target_base,
                                                 provider_type=cred["provider_type"]),
                    branch=br, commits_pushed=commits_pushed,
                    api_response=result.get("body", "")[:400] if isinstance(result.get("body"), str) else str(result.get("body"))[:400],
                )

            return _ok(
                branch=br, commits_pushed=commits_pushed, provider=cred["provider_type"],
                pr_url=result.get("pr_url"), pr_number=result.get("pr_number"),
                draft=draft, already_open=result.get("already_open", False), base=target_base,
                message=f"PR opened: {result.get('pr_url')} (draft={draft}). "
                        f"Hand this URL to a human for review/merge.",
            )
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── git_abandon ──────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_DESTRUCT)
    @_tracked("git", _track_root)
    def git_abandon(
        ctx: Context,
        repo: str,
        keep_branch: bool = False,
    ) -> Union[GitAbandonResult, ErrEnvelope]:
        """v15 — Escape hatch: drop the current agent branch and go back to base.

Use when an agent realizes its approach is wrong and wants to start over.

Bundles:
  1. Refuse if HEAD is on a protected branch (no-op safety)
  2. ``git reset --hard HEAD`` to drop any pending changes
  3. Switch to the default base branch
  4. Delete the agent branch (unless keep_branch=True)

Args:
  repo         : relative path
  keep_branch  : if True, switch off but keep the branch (default: delete)

Returns::
  {ok: true, returned_to: 'main', deleted_branch: 'agent/...',
   note: 'Pending changes discarded.'}"""
        _username = get_username(ctx)
        try:
            root = _git_root(_username)
            rp = _safe_repo(repo, root)
            pol = _load_repo_policy(_username, root, rp)
            br = _current_branch(rp) or ""

            if _is_protected(br, pol):
                return _err(
                    "protected_branch",
                    hint=f"HEAD is on protected {br!r}. Nothing to abandon — you're already on the base.",
                    branch=br,
                )
            if not _is_agent_branch(br, pol):
                return _err(
                    "not_agent_branch",
                    hint=f"Branch {br!r} isn't an agent branch (no allowed prefix match). "
                         f"Refusing to discard — use a fine-grained tool if this is intentional.",
                    branch=br,
                )

            agent_br = br
            base = _default_base_branch(rp)

            # Drop pending changes
            _run_cmd(rp, ["git", "reset", "--hard", "HEAD"], timeout=6)
            # Clean untracked files (be cautious: only untracked, not ignored)
            _run_cmd(rp, ["git", "clean", "-fd"], timeout=6)
            # Switch to base
            sw = _run_cmd(rp, ["git", "switch", base], timeout=6)
            if not sw.get("ok") or sw.get("returncode") != 0:
                return _err(
                    "switch_base_failed",
                    hint=f"Couldn't switch to base {base!r}: {sw.get('stderr', '')[:200]}",
                )

            deleted = None
            if not keep_branch:
                dl = _run_cmd(rp, ["git", "branch", "-D", agent_br], timeout=4)
                if dl.get("ok") and dl.get("returncode") == 0:
                    deleted = agent_br

            return _ok(
                returned_to=base,
                deleted_branch=deleted,
                kept_branch=agent_br if keep_branch else None,
                note="Pending changes discarded; you can start fresh via git_start_work.",
            )
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── git_clone ────────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_MUT_OW)
    def git_clone(
        ctx: Context,
        url: str,
        into_path: str = "",
        branch: str = "",
        username: str = "",
        token: str = "",
    ) -> Union[GitCloneResult, ErrEnvelope]:
        """v15 — Clone a git repo (http/https) into the sandbox.

The clone lands DIRECTLY in the sandbox (or a relative subdir given by
``into_path``), NOT in ``git_repos/`` anymore (legacy layout).

CREDENTIALS (private repo): NEVER put a token in the URL (rejected). Either:
  • pass ``username``/``token`` here (e.g. the user gave them in chat) — they're
    used for the clone AND saved for this host, so push/pull/PR reuse them; OR
  • register a Git Connector once (Settings → Git Connectors) for the host.
Tokens are applied via GIT_ASKPASS (never argv/URL/.git-config).

Args:
  url        : git URL, http(s) (no ssh, no file://, no embedded creds). Private
               LAN hosts (e.g. git.example.lan) are allowed; loopback / cloud-metadata are not.
  into_path  : optional relative subdir for the clone (default: inferred
               from URL — last path component without .git)
  branch     : optional single-branch clone
  username   : optional git username (for a private repo)
  token      : optional git token/PAT — used for the clone AND saved for this
               host (keyed by URL host) so later push/pull/PR reuse it

Returns::
  {ok: true, path: 'myproj', remote: 'https://...',
   default_branch: 'main', next_step: 'Call git_start_work next.'}"""
        _username = get_username(ctx)
        try:
            url = (url or "").strip()

            # Infer into_path from URL if not given
            if not into_path:
                m = re.search(r"/([^/]+?)(?:\.git)?/?$", url)
                if not m:
                    return _err("cannot_infer_path", hint="Pass into_path='<dir>' explicitly.")
                into_path = m.group(1)

            # Validate the target path
            p = Path(into_path).expanduser()
            if p.is_absolute() or ".." in p.parts:
                return _err("bad_into_path", hint="into_path must be relative + no '..'.")

            sb = _sandbox(_username)
            target = sb / p
            esp = Espace(_username, sb)
            rel = p.as_posix()
            try:
                e, eg = esp.stats([rel, f"{rel}/.git"])
            except AgentError as ex:
                return _err(ex.code, hint=ex.message or "sandbox agent unavailable")
            if e.get("kind") == "error":
                return _err("target_outside_sandbox",
                            hint=f"into_path is not usable in the sandbox: {e.get('error')}")
            if e.get("kind") != "missing":
                if eg.get("kind") in ("dir", "file"):
                    return _err(
                        "repo_exists",
                        hint=f"A git repo already exists at {into_path}. "
                             f"Use git_start_work to begin work, or pick a different into_path.",
                    )
                return _err(
                    "path_exists",
                    hint=f"{into_path} already exists (non-empty). Pick a different into_path or "
                         f"clean up first.",
                )

            # AUDIT 2026-08-02 (Part B) — CREDENTIALS SANS SAISIE PAR LE MODÈLE.
            # Creds EXPLICITES (fournis par l'utilisateur via le chat) : ils
            # priment ET seront PERSISTÉS après le clone (keyés sur le host de
            # l'URL). Sinon ceux des Connecteurs Git (match par host). Ajoutés
            # par le relais de l'hôte : jamais dans l'URL, l'argv ni la sandbox.
            _cuid = _uid_of(_username)
            _explicit_cred = bool(token and token.strip())
            _clone_cred = None
            if _explicit_cred:
                _clone_cred = {"username": (username or "").strip(), "token": token.strip()}
            elif _cuid:
                try:
                    from shared_infra.git.resolver import import_legacy_git_credentials, resolve_git_credential
                    import_legacy_git_credentials(_cuid, sb)
                    _clone_cred = resolve_git_credential(_cuid, url)
                except Exception:
                    _clone_cred = None
            _has_clone_cred = bool(_clone_cred and _clone_cred.get("token"))

            cmd = ["git", "clone"]
            if branch:
                cmd += ["--branch", _validate_branch(branch), "--single-branch"]
            cmd += ["--", url, rel]
            _twin = esp.jumeau_unicode(rel)
            cl = _run_network(sb, cmd[1:], _username, url=url, timeout=120,
                              auth=((_clone_cred or {}).get("username") or "",
                                    (_clone_cred or {}).get("token") or "") if _has_clone_cred else None)
            if cl.get("error") in ("blocked_remote", "scheme_not_relayed", "malformed_url"):
                return _err(
                    f"clone_url_blocked: {cl.get('fix') or cl.get('message')}",
                    hint="Only http(s) URLs allowed (no ssh/file/git:, no embedded creds) and "
                         "the host must not resolve to a loopback or link-local address "
                         "(SSRF protection).",
                )
            if not cl.get("ok") or cl.get("returncode") != 0:
                # Message robuste : sur timeout, l'enveloppe n'a pas de ``stderr``.
                _cd = (cl.get("stderr") or cl.get("stdout") or cl.get("fix") or "").strip()
                if _has_clone_cred:
                    _tip = "Vérifiez le token du connecteur, l'URL, ou la connectivité réseau."
                else:
                    _tip = ("Repo privé ? Enregistrez un Connecteur Git pour ce host dans "
                            "Réglages → Connecteurs Git : le token sera utilisé AUTOMATIQUEMENT "
                            "(inutile de le saisir ici, et l'URL ne peut pas le porter).")
                return _err("clone_failed",
                            hint=f"git clone a échoué : {_cd[:400] or 'aucune sortie'}. {_tip}",
                            remote=url, credentialed=_has_clone_cred)

            # Clone OK avec des creds EXPLICITES → on les persiste pour ce host,
            # afin que push/pull/PR/clones futurs les réutilisent sans re-saisie.
            _cred_saved = False
            if _explicit_cred and _cuid:
                try:
                    from shared_infra.git.resolver import save_git_credential
                    if save_git_credential(_cuid, url, username, token):
                        _cred_saved = True
                except Exception:
                    _cred_saved = False

            # Capture default branch
            try:
                base = _default_base_branch(target)
            except Exception:
                base = "?"

            out = _ok(
                path=str(p),
                remote=url,
                default_branch=base,
                credentials_saved=_cred_saved,
                next_step=f"Call git_start_work(repo={str(p)!r}, branch_intent='<describe>') to begin work.",
            )
            if _twin:
                out["warning"] = _twin
            return out
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── git_set_credential ───────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_MUT)
    def git_set_credential(
        ctx: Context,
        target: str,
        token: str,
        username: str = "",
        provider_type: str = "",
    ) -> Union[dict, ErrEnvelope]:
        """Save git credentials for a host so clone/push/pull/PR use them
automatically — the user provides them ONCE (here in chat, or in the editor),
keyed by the HOST of ``target``. No manual connector setup, no host-matching.

Use this when the user hands you a git username + token/PAT for a repo or host.
After this, every git op on that host authenticates without asking again.

Args:
  target        : repo URL (http(s)://…) OR a bare host, e.g. 'git.example.lan:3000'
  token         : the token / PAT / password (required)
  username      : git username (optional; many PATs work without one)
  provider_type : optional — 'gitea','github','gitlab','bitbucket-cloud',
                  'bitbucket-server','generic'. Auto-detected from the URL; a
                  self-hosted host defaults to 'gitea' (needed for PR creation).

SECURITY: the token passes through this tool call (visible in the transcript)
and is stored server-side. For a highly sensitive token prefer the editor's
Git Connectors form. Never written into the repo or the URL."""
        _username = get_username(ctx)
        try:
            if not target or not target.strip():
                return _err("target_required",
                            hint="Donnez une URL de repo ou un host (ex. 'git.example.lan:3000').")
            if not token or not token.strip():
                return _err("token_required", hint="token (PAT/mot de passe) requis.")
            from shared_infra.accounts.users import get_user as _gu
            _row = _gu(_username)
            uid = int(_row["id"]) if _row else 0
            if not uid:
                return _err("no_user", hint="Utilisateur introuvable.")
            from shared_infra.git.resolver import save_git_credential
            cid = save_git_credential(uid, target, username, token, provider_type)
            if not cid:
                return _err("bad_target",
                            hint="Host indéductible depuis 'target' — passez une URL de repo "
                                 "ou 'host:port'.")
            from shared_infra.git.detect import detect_provider, normalize_host
            _h = (detect_provider(target).get("host") or normalize_host(target) or "").lower()
            return _ok(
                connector_id=cid, host=_h,
                message=(f"Credentials git enregistrés pour {_h!r}. clone / push / pull / "
                         f"git_submit sur ce host les utiliseront AUTOMATIQUEMENT (plus besoin "
                         f"de les redonner)."),
            )
        except Exception as e:
            return _err(f"unexpected: {e}")


# ───────────────────────────────────────────────────────────────────────
#  v15 — Module-level PR-opening helpers (outside register).
# ───────────────────────────────────────────────────────────────────────





