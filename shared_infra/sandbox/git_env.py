# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/git_env.py — the ONE place that builds a hardened
environment for running ``git`` on the host.

Threat
------
``git_tools`` (the MCP tool path) and several HTTP routes run the ``git``
binary on the HOST, as the app user, with ``cwd`` set to a repo INSIDE a
user's sandbox. A sandbox repo is model/user-controlled, so its
``.git/hooks/*`` are attacker-controlled. Stock git will execute those hooks
on the host on ``commit``, ``checkout``, ``merge``, ``clone`` (post-checkout)
etc. — i.e. arbitrary code execution as the app user.

Mitigation
----------
Force ``core.hooksPath`` to a path that can never be a hooks directory, so
git finds no hook to run. We inject it via the ``GIT_CONFIG_COUNT`` env
protocol (git >= 2.31, 2021) rather than touching argv or the repo's own
config, so it applies to every git invocation — including any it spawns
(filters, submodules) — and cannot be overridden by the repo's config.

We deliberately do NOT set ``GIT_CONFIG_NOSYSTEM`` here: these git calls run
on the host, and dropping ``/etc/gitconfig`` could remove an operator's
intended TLS CA / proxy / http settings and break legitimate clones. Hooks
are the actual RCE vector; that is what we close. The durable fix —
running git INSIDE the container under the user's network profile — is the
separate "containerize network git" migration step; this helper hardens the
host path until then and remains valid as belt-and-braces afterwards.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from shared_infra.sandbox import bwrap

logger = logging.getLogger("uvicorn.error")

# git config overrides applied to every host git invocation.
#
# AUDIT 2026-06 — extension aux clés à NOM FIXE dangereuses de .git/config
# (repo user-contrôlé) qui exécutent du code sur l'hôte :
#   - core.fsmonitor      : binaire lancé par git status/diff (RCE direct)
#   - protocol.file.allow : submodule file:// → lecture arbitraire hôte
#   - credential.helper   : valeur VIDE = reset de la liste des helpers du
#     repo (un helper malveillant = exfiltration/RCE). Les routes qui passent
#     des credentials utilisent GIT_ASKPASS via env_extra, prioritaire → OK.
#   - core.pager          : git ne page pas en non-TTY, mais ceinture-bretelles
# Les clés à nom ARBITRAIRE (filter.*.smudge/clean, diff.*.textconv) ne sont
# PAS neutralisables par env : ``repo_refusal`` les refuse, et ``run_host_git``
# enferme git dans une prison qui ne voit que la zone de travail.
_HARDENING = (
    ("core.hooksPath", "/dev/null"),   # no repo hook can execute on the host
    ("core.fsmonitor", "false"),
    ("protocol.file.allow", "never"),
    ("credential.helper", ""),
    ("core.pager", "cat"),
    # Audit 2026-09-22 (C2) : un dépôt qui pose ``commit.gpgsign=true`` +
    # ``gpg.format=ssh`` + ``gpg.ssh.defaultKeyCommand`` faisait exécuter une
    # commande au ``git commit`` hôte. Signature coupée à la source.
    ("commit.gpgsign", "false"),
    ("tag.gpgsign", "false"),
    ("gpg.format", "openpgp"),
    # Les repos sandbox sont ré-alignés sur l'UID in-container 10001 après
    # chaque écriture host-side (``sandbox_grant_access`` : ACL + chown) pour
    # que le shell du conteneur garde la main. Le git HÔTE (UID app) voit
    # alors un repo « d'un autre user » et refuse tout (« dubious
    # ownership ») — safe.directory=* lève ce refus. Sûr ici : le check
    # ownership protège contre un .git/config planté par un AUTRE user local,
    # or ces invocations ne visent QUE des repos du sandbox de l'utilisateur,
    # dont la config est déjà neutralisée par les clés ci-dessus.
    ("safe.directory", "*"),
    # /work est partagé entre l'UID app (hôte) et l'UID conteneur (10001 par
    # défaut) qui n'ont AUCUN groupe commun : l'invariant du volume est
    # « cross-writable » = fichiers 0666 / dossiers 0777 (cf. wrapper umask
    # 0000 des exec conteneur et _chmod_cross_writable des fs tools). Sans
    # cette clé, les fichiers de .git écrits par le git HÔTE sortaient en
    # 0644/0755 → le shell in-container ne pouvait ni écrire (index.lock:
    # Permission denied) ni même supprimer le repo (rm -rf impossible).
    # sharedRepository=0666 fait élargir par git lui-même tout ce qu'il crée
    # sous .git (les dossiers en dérivent en 0777).
    ("core.sharedRepository", "0666"),
)


def hardened_git_env(base: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Return ``base`` (copied) augmented with git-hardening variables.

    * ``GIT_TERMINAL_PROMPT=0`` — never block on an interactive credential
      prompt (set only if the caller didn't already pin it).
    * ``core.hooksPath=/dev/null`` via ``GIT_CONFIG_COUNT`` — disable repo
      hooks. APPENDED to any pre-existing ``GIT_CONFIG_COUNT`` so a caller
      that already injected config keys keeps them.

    Pure function: never reads/writes ``os.environ``; the caller decides
    what base environment to start from.
    """
    env: Dict[str, str] = dict(base) if base else {}
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    # AUDIT 2026-06 — borne les protocoles des git ENFANTS (submodules,
    # fetch récursifs) : pas de ext:: (RCE), pas de file:// implicite.
    env.setdefault("GIT_ALLOW_PROTOCOL", "http:https:git:ssh")

    try:
        n = int(env.get("GIT_CONFIG_COUNT", "0") or "0")
    except (TypeError, ValueError):
        n = 0

    for key, value in _HARDENING:
        env[f"GIT_CONFIG_KEY_{n}"] = key
        env[f"GIT_CONFIG_VALUE_{n}"] = value
        n += 1
    env["GIT_CONFIG_COUNT"] = str(n)
    return env


# ── Environnement de base d'un git HÔTE (audit 2026-09-22, C1) ────────────
# Avant : ``_git_run`` recopiait TOUT ``os.environ`` (secrets de l'app compris)
# et posait ``HOME=<dépôt>``. Git lisait alors ``<dépôt>/.gitconfig``, fichier
# écrit depuis le conteneur, comme config GLOBALE — et ``unsafe_repo_config``
# ne contrôlait que la portée locale : ``filter.x.clean`` s'y exécutait sur
# l'hôte. Désormais : liste blanche de variables, ``HOME``/``XDG_CONFIG_HOME``
# sur un dossier de l'app, config globale = un fichier de l'app qui ne porte
# qu'une identité par défaut (committer des routes, qui passent ``--author``).
# ``/etc/gitconfig`` reste lu : il appartient à root, et l'opérateur peut y
# avoir mis un proxy ou une CA légitimes.
_ENV_KEEP = (
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
)
_GLOBAL_CONFIG = "[user]\n\tname = Elpis\n\temail = elpis@localhost\n"
_home_cache: Optional[str] = None


def _git_home() -> str:
    """Dossier HOME des git hôte : ``user_db/.git-home`` (hors git, à l'app)."""
    global _home_cache
    if _home_cache and os.path.isfile(os.path.join(_home_cache, "gitconfig")):
        return _home_cache
    from shared_infra.config import PROJECT_ROOT
    home = os.path.join(str(PROJECT_ROOT), "user_db", ".git-home")
    os.makedirs(home, mode=0o700, exist_ok=True)
    cfg = os.path.join(home, "gitconfig")
    try:
        with open(cfg, encoding="utf-8") as f:
            ok = f.read() == _GLOBAL_CONFIG
    except OSError:
        ok = False
    if not ok:
        tmp = f"{cfg}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(_GLOBAL_CONFIG)
        os.replace(tmp, cfg)
    _home_cache = home
    return home


def host_git_env(env_extra: Optional[Dict[str, str]] = None, cwd=None) -> Dict[str, str]:
    """Environnement COMPLET d'un git lancé sur l'hôte : liste blanche +
    HOME de l'app + ``hardened_git_env``. ``env_extra`` (askpass, jetons)
    s'ajoute, sans pouvoir re-pointer HOME ni la config globale. ``cwd`` :
    git ne remonte pas au-dessus pour chercher un dépôt parent."""
    env = {k: os.environ[k] for k in _ENV_KEEP if k in os.environ}
    if env_extra:
        env.update({str(k): str(v) for k, v in env_extra.items() if v is not None})
    home = _git_home()
    env.update(HOME=home, XDG_CONFIG_HOME=home,
               GIT_CONFIG_GLOBAL=os.path.join(home, "gitconfig"))
    for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
              "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_SYSTEM",
              "GIT_EXEC_PATH", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND",
              "GIT_EXTERNAL_DIFF", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER"):
        env.pop(k, None)
    if cwd is not None:
        env["GIT_CEILING_DIRECTORIES"] = str(Path(cwd).parent)
    return hardened_git_env(env)


# ── Clés à nom LIBRE qui font exécuter une commande sur l'hôte ─────────────
# (audit 2026-09-21, S4). Le protocole ``GIT_CONFIG_*`` ne neutralise que des
# clés à nom FIXE ; ``filter.<x>.clean`` ou ``diff.<x>.textconv`` plantés dans
# le ``.git/config`` d'un dépôt du bac à sable faisaient tourner leur commande
# au premier ``git add``/``status``/``diff`` lancé par une route HTTP — hors
# conteneur, avec les droits de l'app. En attendant la migration « git en
# conteneur », un dépôt qui en déclare une est REFUSÉ avant toute commande.
# Audit 2026-09-22 (C2) : + signature ssh, proxys/en-têtes (contournent la
# garde SSRF), éditeurs, update de sous-module, et les clés à nom fixe déjà
# neutralisées par env (refusées par prudence).
_UNSAFE_LOCAL_KEYS = tuple(re.compile(p) for p in (
    r"^filter\..+\.(clean|smudge|process)$",
    r"^diff\..+\.(textconv|command)$",
    r"^diff\.external$",
    r"^merge\..+\.driver$",
    r"^core\.(sshcommand|gitproxy|askpass|worktree|fsmonitor|hookspath|editor"
    r"|pager|alternaterefscommand)$",                      # worktree : écriture hors dépôt
    r"^sequence\.editor$",
    r"^gpg\.(.+\.)?program$",
    r"^gpg\.ssh\.",
    r"^credential\.(.+\.)?helper$",
    r"^url\..+\.(pushinsteadof|insteadof)$",             # réécrit l'URL après la garde SSRF
    r"^https?\.(.+\.)?(cookiefile|proxy|extraheader|sslcert|sslkey)$",
    r"^remote\..+\.(proxy|uploadpack|receivepack)$",
    r"^submodule\..+\.update$",                          # « !commande »
))

# Chemins de ``.git`` qui font lire à git des objets ou une config HORS du
# dépôt (audit 2026-09-22, H5) : dépôt d'un autre utilisateur, ou celui de
# l'app, lus par l'hôte (``safe.directory=*``).
_GITDIR_FORBIDDEN = ("objects/info/alternates", "objects/info/http-alternates", "commondir")
_GITDIR_SCAN = ("", "objects", "objects/pack", "refs", "refs/heads", "refs/tags")


def unsafe_git_dir(cwd) -> Optional[str]:
    """Raison de refuser ``<cwd>/.git``, ou ``None``.

    Refusé : ``.git`` lien symbolique ou fichier ``gitdir:``, alternates,
    ``commondir``, ou un lien symbolique dans les premiers niveaux de
    ``.git`` (config, objets, refs). Pas de ``.git`` : ``None`` (git ne
    remonte pas au-dessus de ``cwd``, cf. ``host_git_env``).
    """
    g = Path(cwd) / ".git"
    try:
        if g.is_symlink():
            return ".git est un lien symbolique"
        if not g.exists():
            return None
        if not g.is_dir():
            return ".git est un fichier (gitdir:)"
        for rel in _GITDIR_FORBIDDEN:
            if os.path.lexists(g / rel):
                return f".git/{rel} présent"
        for rel in _GITDIR_SCAN:
            d = g / rel if rel else g
            if not d.is_dir() or d.is_symlink():
                if d.is_symlink():
                    return f".git/{rel} est un lien symbolique"
                continue
            with os.scandir(d) as it:
                for e in it:
                    if e.is_symlink():
                        return f".git/{(rel + '/') if rel else ''}{e.name} est un lien symbolique"
    except OSError:
        return ".git illisible"
    return None


def unsafe_repo_config(cwd, base_env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """Première clé de config (toutes portées sauf ``system`` et ``command``,
    inclusions comprises) qui ferait exécuter une commande sur l'hôte, ou
    ``None``.

    Lire la config n'exécute rien. Échec de lecture → refus (``"illisible"``).
    """
    env = hardened_git_env(dict(base_env)) if base_env else host_git_env(cwd=cwd)
    try:
        p = run_host_git(["git", "config", "--list", "--show-scope", "--includes", "-z"],
                         cwd=cwd, env=env, capture_output=True, text=True,
                         timeout=10, check=False)
    except Exception:                                           # noqa: BLE001
        return "illisible"
    if p.returncode != 0:
        # « pas un dépôt » n'arrive pas ici (git liste alors global/système) ;
        # une config locale malformée, si — on ne lance rien dessus.
        return "illisible" if "fatal" in (p.stderr or "") else None
    toks = p.stdout.split("\0")
    for scope, kv in zip(toks[0::2], toks[1::2]):
        # ``command`` = nos propres surcharges (GIT_CONFIG_COUNT) ;
        # ``system`` = /etc/gitconfig, à root.
        if scope in ("system", "command"):
            continue
        key = kv.split("\n", 1)[0].strip().lower()
        if any(r.match(key) for r in _UNSAFE_LOCAL_KEYS):
            return key
    return None


# ── Prison des git hôte (2026-09-29) ─────────────────────────────────────
# ``repo_refusal`` contrôle la configuration dans un PREMIER process ; git la
# relit dans le sien. Le conteneur, qui écrit dans le dépôt, peut la changer
# entre les deux : un pilote ``filter``/``textconv``/``merge`` déclaré après le
# contrôle s'exécuterait alors sur l'hôte. Même fenêtre pour ``cwd``, résolu
# par l'appelant puis réutilisé. Plutôt que de courir après chaque relecture,
# git tourne dans une prison bwrap qui ne voit que la zone de travail de
# l'utilisateur : ce qu'un dépôt fait exécuter reste confiné à ce que le
# conteneur peut déjà faire. Le contrôle reste en place (message clair, et
# garde-fou pour les commandes réseau).
_NETWORK_SUBCOMMANDS = frozenset({"clone", "fetch", "pull", "push", "ls-remote", "submodule"})
_UNAVAILABLE = ("Git côté serveur indisponible : isolation bubblewrap absente ou bloquée "
                "(./elpis doctor). executors.git_isolation = \"none\" rétablit l'ancien "
                "comportement, sans isolation.")
_warned_none = False


def git_isolation() -> str:
    """``"bwrap"``, ``"unavailable"``, ou ``"none"`` si c'est demandé
    explicitement (``executors.git_isolation = "none"``)."""
    global _warned_none
    try:
        from shared_infra.config import live_config_value
        mode = str(live_config_value("executors.git_isolation", "auto") or "auto")
    except Exception:                                           # noqa: BLE001
        mode = "auto"
    if mode.strip().lower() == "none":
        if not _warned_none:
            _warned_none = True
            logger.warning("[git] git hôte SANS isolation (executors.git_isolation = \"none\")")
        return "none"
    return "bwrap" if bwrap.probe() else "unavailable"


def _subcommand(argv: List[str]) -> str:
    """Sous-commande de ``git [-c k=v] [-C dir] <sous-commande> …``."""
    it = iter(argv[1:])
    for tok in it:
        if tok in ("-c", "-C"):
            next(it, None)
        elif not tok.startswith("-"):
            return tok
    return ""


def _jail_root(cwd: Path) -> Path:
    """Dossier monté : la zone de travail ``<SANDBOX_DIR>/<utilisateur>/work``
    qui contient ``cwd``, déduite du chemin (déjà résolu par l'appelant) SANS
    le relire sur le disque ; ``cwd`` lui-même hors de ``SANDBOX_DIR``."""
    from shared_infra import config as _cfg
    for base in (Path(_cfg.SANDBOX_DIR), Path(_cfg.SANDBOX_DIR).resolve()):
        try:
            parts = cwd.relative_to(base).parts
        except ValueError:
            continue
        if len(parts) >= 2:
            return base / parts[0] / parts[1]
    return cwd


def _jail_argv(cwd: Path, env: Dict[str, str], *, network: bool) -> List[str]:
    root = str(_jail_root(cwd))
    argv = [bwrap.binary() or "bwrap", *bwrap.base_argv(network=network),
            "--ro-bind", "/etc", "/etc"]
    if network:      # /etc/resolv.conf pointe souvent vers systemd-resolved
        argv += ["--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve"]
    # HOME de l'app (config globale), script askpass, certificats hors /etc.
    for key in ("HOME", "GIT_ASKPASS", "SSL_CERT_FILE", "SSL_CERT_DIR",
                "GIT_SSL_CAINFO", "GIT_SSL_CAPATH"):
        v = env.get(key) or ""
        if os.path.isabs(v) and not v.startswith(("/usr/", "/etc/")):
            argv += ["--ro-bind-try", v, v]
    return argv + ["--bind", root, root, "--chdir", str(cwd)]


def run_host_git(argv: List[str], *, cwd: Any, env: Dict[str, str],
                 **kwargs: Any) -> subprocess.CompletedProcess:
    """Seul lanceur des ``git`` exécutés par l'hôte sur un dépôt de sandbox :
    ``subprocess.run`` enfermé dans la prison (réseau pour les seules
    sous-commandes qui en ont besoin). Isolation indisponible : rien n'est
    lancé, code 1 et message dans ``stderr``."""
    mode = git_isolation()
    if mode == "unavailable":
        text = bool(kwargs.get("text") or kwargs.get("encoding"))
        return subprocess.CompletedProcess(argv, 1, "" if text else b"",
                                           _UNAVAILABLE if text else _UNAVAILABLE.encode())
    if mode == "none":
        return subprocess.run(argv, cwd=str(cwd), env=env, **kwargs)
    network = _subcommand(argv) in _NETWORK_SUBCOMMANDS
    return subprocess.run(_jail_argv(Path(cwd), env, network=network) + list(argv),
                          cwd="/", env=env, **kwargs)


def repo_refusal(cwd, env: Optional[Dict[str, str]] = None):
    """``(genre, détail)`` si git ne doit PAS tourner dans ``cwd``, sinon
    ``None``. ``genre`` : ``"gitdir"`` (structure de ``.git``) ou
    ``"config"`` (clé exécutable, ``détail`` = la clé)."""
    why = unsafe_git_dir(cwd)
    if why:
        return "gitdir", why
    key = unsafe_repo_config(cwd, env)
    if key:
        return "config", key
    return None


__all__ = ["git_isolation", "hardened_git_env", "host_git_env", "repo_refusal",
           "run_host_git", "unsafe_git_dir", "unsafe_repo_config"]
