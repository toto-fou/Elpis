# SPDX-License-Identifier: MIT
"""
shared_infra.ops.backup_remote — Envoi des sauvegardes vers un emplacement distant.

Trois connecteurs (réalisables sur la VM offline, cf. outils dispos :
sftp/scp/ssh/rsync présents, sshpass/boto3/paramiko ABSENTS) :
  • ``sftp``    : copie via ``scp`` en mode batch, authentification par CLÉ
                  uniquement (pas de mot de passe → pas de sshpass).
  • ``mounted`` : copie de fichier (``shutil``) vers un dossier déjà MONTÉ
                  localement (partage SMB/NFS monté via l'OS).
  • ``rsync``   : (2026-09-21) rsync au-dessus de SSH, authentifié par MOT DE
                  PASSE (hôte, port — 22 par défaut —, utilisateur, dossier
                  cible). Sans sshpass : ``SSH_ASKPASS_REQUIRE=force`` (OpenSSH
                  ≥ 8.4) fait lire le mot de passe par un script STATIQUE qui
                  l'imprime depuis une variable d'environnement — jamais argv,
                  jamais config.json. Écriture atomique côté distant.

Planification (2026-09-21) : ``schedule_enabled`` + « toutes les N heures/jours »
→ ``next_run_at`` ; la boucle leader-only vit dans ``backup_scheduler.py``. Un
envoi à la fois, tous workers confondus (verrou fichier ``.backup_send.lock``).

Sécurité :
  • La clé privée SSH n'est JAMAIS dans config.json — seulement un CHEMIN vers
    un fichier sidecar ``user_db/.backup_ssh_key`` (0600), même pattern que
    ``.session_secret``. Jamais renvoyée par l'API. Idem pour le mot de passe
    rsync (``user_db/.backup_rsync_password``, 0600) : l'API ne dit que s'il existe.
  • Aucune injection shell : ``asyncio.create_subprocess_exec`` (jamais
    ``shell=True``) + validation stricte des champs (charset restreint) au lieu
    de quoting fragile.
  • ``BatchMode=yes`` sur les chemins par clé → échec immédiat au lieu d'un
    prompt bloquant ; rsync par mot de passe : une seule tentative
    (``NumberOfPasswordPrompts=1``), entrée standard fermée.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from shared_infra.config import PROJECT_ROOT, read_config_json, write_config_json

logger = logging.getLogger("uvicorn.error")

DEFAULT_KEY_PATH = str(PROJECT_ROOT / "user_db" / ".backup_ssh_key")
DEFAULT_KNOWN_HOSTS = str(PROJECT_ROOT / "user_db" / ".backup_known_hosts")
RSYNC_PASSWORD_PATH = str(PROJECT_ROOT / "user_db" / ".backup_rsync_password")

CONNECTORS = ("sftp", "mounted", "rsync")
SEND_LOCK_PATH = str(PROJECT_ROOT / "user_db" / ".backup_send.lock")
SCHEDULE_UNITS = {"hours": 3600, "days": 86400}
# Après un envoi planifié en échec, nouvelle tentative au plus tard 1 h après
# (pas d'attente d'un intervalle entier de plusieurs jours).
RETRY_AFTER_FAIL_S = 3600
SCOPES = ("full", "db", "sandboxes", "mcp")

# Charsets sûrs (évitent toute métacaractère shell / saut de ligne). Jamais de
# « - » en tête : ``user@host`` est un argument de ssh/scp/rsync, et une valeur
# commençant par « - » y serait lue comme une option.
_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_USER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
_PATH_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")


# ── Config ────────────────────────────────────────────────────────────────────
def normalize_remote_config(raw: Any) -> Dict[str, Any]:
    """Applique défauts + coercions sur la sous-section ``backup.remote`` brute.
    Pure (pas d'I/O). Ne renvoie jamais de secret (clé = chemin)."""
    r = raw if isinstance(raw, dict) else {}
    def _s(k, d=""):
        v = r.get(k, d)
        return str(v).strip() if v is not None else d
    try:
        port = int(r.get("port", 22) or 22)
    except Exception:
        port = 22
    try:
        every = int(r.get("schedule_every", 1) or 1)
    except Exception:
        every = 1
    unit = _s("schedule_unit", "days") or "days"
    last = r.get("last_send") if isinstance(r.get("last_send"), dict) else {}
    return {
        "enabled": bool(r.get("enabled", False)),
        "connector": _s("connector", "sftp") or "sftp",
        "scope": (_s("scope", "full") or "full"),
        "host": _s("host"),
        "port": max(1, min(65535, port)),
        "user": _s("user"),
        "remote_path": _s("remote_path"),
        "dest_path": _s("dest_path"),
        "strict_host_key_checking": bool(r.get("strict_host_key_checking", True)),
        # Planification : « toutes les N heures/jours » (1 à 999).
        "schedule_enabled": bool(r.get("schedule_enabled", False)),
        "schedule_every": max(1, min(999, every)),
        "schedule_unit": unit if unit in SCHEDULE_UNITS else "days",
        "key_path": _s("key_path") or DEFAULT_KEY_PATH,
        "known_hosts": _s("known_hosts") or DEFAULT_KNOWN_HOSTS,
        "timeout_sec": max(10, min(3600, int(r.get("timeout_sec", 300) or 300))),
        "last_send": {
            "at": last.get("at", 0), "ok": last.get("ok", None),
            "ok_at": last.get("ok_at", 0), "trigger": last.get("trigger", ""),
            "filename": last.get("filename", ""), "error": last.get("error", ""),
        },
    }


def get_remote_config() -> Dict[str, Any]:
    """Lit + normalise ``backup.remote`` depuis config.json. Sûr à exposer
    (aucun secret : ``key_path`` est un chemin, pas la clé)."""
    raw = (read_config_json() or {}).get("backup", {})
    raw = raw.get("remote", {}) if isinstance(raw, dict) else {}
    cfg = normalize_remote_config(raw)
    cfg["key_present"] = bool(cfg["key_path"] and os.path.exists(cfg["key_path"]))
    cfg["password_present"] = os.path.exists(RSYNC_PASSWORD_PATH)
    cfg["next_run_at"] = next_run_at(cfg)
    return cfg


def next_run_at(cfg: Dict[str, Any], now: Optional[float] = None) -> Optional[float]:
    """Prochain envoi AUTOMATIQUE (horodatage), ``None`` si non planifié. Pure.

    Jamais envoyé → maintenant (le premier envoi confirme la configuration).
    Dernier envoi réussi → + l'intervalle. Dernier envoi en échec → au plus
    tard 1 h après (``RETRY_AFTER_FAIL_S``), sans dépasser l'intervalle.
    Un envoi manuel compte : il repousse le suivant d'un intervalle."""
    if not (cfg.get("enabled") and cfg.get("schedule_enabled")):
        return None
    now = time.time() if now is None else now
    interval = int(cfg.get("schedule_every") or 1) * SCHEDULE_UNITS.get(
        cfg.get("schedule_unit") or "days", 86400)
    last = cfg.get("last_send") or {}
    at = float(last.get("at") or 0)
    if not at:
        return now
    if last.get("ok") is False:
        return at + min(interval, RETRY_AFTER_FAIL_S)
    return at + interval


def validate_remote_config(cfg: Dict[str, Any]) -> Tuple[bool, str]:
    """Valide les champs selon le connecteur. Renvoie (ok, message_erreur)."""
    if cfg.get("connector") not in CONNECTORS:
        return False, "Connecteur invalide"
    if cfg.get("scope") not in SCOPES:
        return False, "Scope invalide"
    if cfg["connector"] == "rsync":
        if not cfg.get("host") or not _HOST_RE.match(cfg["host"]):
            return False, "Adresse invalide (caractères autorisés : lettres, chiffres, . _ -)"
        if not cfg.get("user") or not _USER_RE.match(cfg["user"]):
            return False, "Utilisateur invalide"
        if not cfg.get("remote_path") or not _PATH_RE.match(cfg["remote_path"]):
            return False, "Chemin cible invalide (pas d'espace ni de métacaractère)"
        if not _PATH_RE.match(cfg.get("known_hosts") or ""):
            return False, "Chemin known_hosts invalide"
    elif cfg["connector"] == "sftp":
        if not cfg.get("host") or not _HOST_RE.match(cfg["host"]):
            return False, "Hôte invalide (caractères autorisés : lettres, chiffres, . _ -)"
        if not cfg.get("user") or not _USER_RE.match(cfg["user"]):
            return False, "Utilisateur invalide"
        if not cfg.get("remote_path") or not _PATH_RE.match(cfg["remote_path"]):
            return False, "Chemin distant invalide (pas d'espace ni de métacaractère)"
    else:  # mounted
        if not cfg.get("dest_path") or not _PATH_RE.match(cfg["dest_path"]):
            return False, "Dossier de destination invalide"
    return True, ""


def save_remote_config(incoming: Any) -> Dict[str, Any]:
    """Fusionne les champs entrants (depuis l'UI) dans config.json sous
    ``backup.remote``, en PRÉSERVANT ``last_send`` (statut écrit par send).
    Retourne la config normalisée (sans secret)."""
    cfg = normalize_remote_config(incoming)
    full = read_config_json() or {}
    backup = full.get("backup") if isinstance(full.get("backup"), dict) else {}
    prev = backup.get("remote") if isinstance(backup.get("remote"), dict) else {}
    # Préserve last_send existant (l'UI ne l'envoie pas).
    cfg["last_send"] = (prev.get("last_send")
                        if isinstance(prev.get("last_send"), dict) else cfg["last_send"])
    backup["remote"] = cfg
    full["backup"] = backup
    write_config_json(full)
    out = dict(cfg)
    out["key_present"] = bool(cfg["key_path"] and os.path.exists(cfg["key_path"]))
    out["password_present"] = os.path.exists(RSYNC_PASSWORD_PATH)
    return out


# ── Clé SSH (sidecar 0600) ─────────────────────────────────────────────────────
def store_ssh_key(content: str, key_path: Optional[str] = None) -> str:
    """Écrit la clé privée dans un fichier sidecar 0600. Retourne le chemin."""
    path = Path(key_path or get_remote_config()["key_path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    body = content if content.endswith("\n") else content + "\n"
    # Écriture atomique + permissions strictes.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(body, encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    return str(path)


def store_rsync_password(password: str) -> bool:
    """Mot de passe SSH du connecteur rsync → fichier 0600, jamais relu par
    l'API. Vide = retrait. Renvoie ``True`` si un mot de passe est désormais
    enregistré."""
    path = Path(RSYNC_PASSWORD_PATH)
    if not password:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return False
    if "\n" in password or "\r" in password:
        raise ValueError("Le mot de passe ne peut pas contenir de saut de ligne")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(password + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return True


async def key_fingerprint(key_path: Optional[str] = None) -> Optional[str]:
    """Empreinte de la clé via ``ssh-keygen -lf`` (best-effort, None si absente)."""
    path = key_path or get_remote_config()["key_path"]
    if not path or not os.path.exists(path):
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "ssh-keygen", "-lf", path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        return out.decode(errors="replace").strip() or None
    except Exception:
        return None


# ── Construction des commandes (pure, testable) ────────────────────────────────
def _ssh_opts(cfg: Dict[str, Any]) -> List[str]:
    strict = "accept-new" if cfg.get("strict_host_key_checking", True) else "no"
    return [
        "-o", "BatchMode=yes",
        "-o", f"StrictHostKeyChecking={strict}",
        "-o", f"UserKnownHostsFile={cfg['known_hosts']}",
        "-o", "ConnectTimeout=10",
        "-o", "PreferredAuthentications=publickey",
        "-o", "IdentitiesOnly=yes",
        "-i", cfg["key_path"],
    ]


def build_test_argv(cfg: Dict[str, Any]) -> List[str]:
    """Commande ssh no-op testant l'existence + l'inscriptibilité du dossier
    distant. ``remote_path`` est validé (charset sûr) → pas d'injection."""
    rp = cfg["remote_path"]
    return ([ "ssh", *_ssh_opts(cfg), "-p", str(cfg["port"]),
              f"{cfg['user']}@{cfg['host']}",
              f"test -d {rp} && test -w {rp}" ])


def build_send_argv(cfg: Dict[str, Any], local_path: str, filename: str) -> List[str]:
    """Commande scp envoyant ``local_path`` vers ``remote_path/filename``."""
    dest = f"{cfg['user']}@{cfg['host']}:{cfg['remote_path'].rstrip('/')}/{filename}"
    return ([ "scp", "-q", *_ssh_opts(cfg), "-P", str(cfg["port"]), local_path, dest ])


# Script ASKPASS statique : ssh l'appelle pour chaque invite (« Password: »,
# keyboard-interactive…) ; il imprime le mot de passe lu dans l'environnement,
# sans jamais l'évaluer.
_SSH_ASKPASS_BODY = '#!/bin/sh\nprintf \'%s\\n\' "$ELPIS_BACKUP_SSH_PASS"\n'


def _rsync_ssh_cmd(cfg: Dict[str, Any]) -> str:
    """Commande ssh passée à ``rsync -e`` (découpée par rsync, pas de shell ;
    tous les champs sont validés sans espace ni métacaractère)."""
    strict = "accept-new" if cfg.get("strict_host_key_checking", True) else "no"
    return " ".join([
        "ssh", "-p", str(cfg["port"]),
        "-o", f"StrictHostKeyChecking={strict}",
        "-o", f"UserKnownHostsFile={cfg['known_hosts']}",
        "-o", "ConnectTimeout=10",
        "-o", "PreferredAuthentications=password,keyboard-interactive",
        "-o", "PubkeyAuthentication=no",
        "-o", "NumberOfPasswordPrompts=1",
        "-o", "LogLevel=ERROR",
    ])


def build_rsync_test_argv(cfg: Dict[str, Any]) -> List[str]:
    """Liste le dossier cible : valide adresse, identifiants et chemin sans
    rien écrire."""
    dest = f"{cfg['user']}@{cfg['host']}:{cfg['remote_path'].rstrip('/')}/"
    return ["rsync", "--timeout=20", "-e", _rsync_ssh_cmd(cfg), "--list-only", "--", dest]


def build_rsync_send_argv(cfg: Dict[str, Any], local_path: str, filename: str) -> List[str]:
    """Envoie ``local_path`` sous ``filename``. rsync écrit un fichier temporaire
    puis le renomme : un envoi interrompu ne laisse pas d'archive tronquée."""
    dest = f"{cfg['user']}@{cfg['host']}:{cfg['remote_path'].rstrip('/')}/{filename}"
    # Pas de ``--partial`` : il renommerait un transfert interrompu sous le nom
    # FINAL (archive tronquée prise pour bonne). Sans lui, rsync supprime son
    # fichier temporaire.
    return ["rsync", f"--timeout={max(10, int(cfg.get('timeout_sec') or 300))}",
            "-e", _rsync_ssh_cmd(cfg), "-t", "--", local_path, dest]


class _SshPassword:
    """Contexte : script askpass temporaire (0700) + environnement portant le
    mot de passe. ``env`` vaut ``None`` si aucun mot de passe n'est enregistré."""

    def __init__(self):
        self.env: Optional[Dict[str, str]] = None
        self._script: Optional[str] = None

    def __enter__(self):
        try:
            pwd = Path(RSYNC_PASSWORD_PATH).read_text(encoding="utf-8").rstrip("\n")
        except OSError:
            return self
        import tempfile
        fd, self._script = tempfile.mkstemp(prefix="elpis_askpass_", suffix=".sh")
        with os.fdopen(fd, "w") as f:
            f.write(_SSH_ASKPASS_BODY)
        os.chmod(self._script, 0o700)
        self.env = {**os.environ, "SSH_ASKPASS": self._script,
                    "SSH_ASKPASS_REQUIRE": "force", "ELPIS_BACKUP_SSH_PASS": pwd}
        self.env.pop("DISPLAY", None)
        return self

    def __exit__(self, *exc):
        if self._script:
            try:
                os.remove(self._script)
            except OSError:
                pass
        return False


# ── Exécution ──────────────────────────────────────────────────────────────────
async def _run(argv: List[str], timeout: float,
               env: Optional[Dict[str, str]] = None) -> Tuple[bool, str]:
    """Lance argv sans shell, borné en temps. Renvoie (ok, 1re ligne stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL, env=env)
    except FileNotFoundError as e:
        return False, f"Commande introuvable : {e}"
    try:
        _out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try: proc.kill(); await proc.communicate()
        except Exception: pass
        return False, "Délai dépassé"
    if proc.returncode == 0:
        return True, ""
    msg = (err.decode(errors="replace").strip().split("\n") or [""])[0][:300]
    return False, msg or f"Échec (code {proc.returncode})"


async def run_test(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Teste la connexion/destination selon le connecteur."""
    cfg = cfg or get_remote_config()
    ok, err = validate_remote_config(cfg)
    if not ok:
        return {"ok": False, "error": err}
    if cfg["connector"] == "mounted":
        d = cfg["dest_path"]
        if not os.path.isdir(d):
            return {"ok": False, "error": "Dossier introuvable (monté ?)"}
        if not os.access(d, os.W_OK):
            return {"ok": False, "error": "Dossier non inscriptible"}
        return {"ok": True, "error": ""}
    if cfg["connector"] == "rsync":
        with _SshPassword() as sp:
            if sp.env is None:
                return {"ok": False, "error": "Mot de passe absent — enregistrez-le d'abord."}
            ok2, msg = await _run(build_rsync_test_argv(cfg), timeout=40, env=sp.env)
        return {"ok": ok2, "error": _ssh_error(msg)}
    # sftp
    if not os.path.exists(cfg["key_path"]):
        return {"ok": False, "error": "Clé SSH absente — téléverse-la d'abord."}
    ok2, msg = await _run(build_test_argv(cfg), timeout=20)
    return {"ok": ok2, "error": msg}


def _ssh_error(msg: str) -> str:
    """Première ligne d'erreur ssh/rsync → message lisible (brut sinon)."""
    m = (msg or "").lower()
    if "permission denied" in m or "authentication failed" in m:
        return "Identifiants refusés (utilisateur ou mot de passe)."
    if "connection refused" in m:
        return "Connexion refusée : aucun serveur SSH sur ce port."
    if "timed out" in m or "no route to host" in m or "could not resolve" in m \
            or "name or service not known" in m:
        return "Serveur injoignable (adresse ou réseau)."
    if "host key verification failed" in m or "remote host identification has changed" in m:
        return "L'empreinte du serveur a changé (known_hosts) : connexion refusée."
    if "no such file or directory" in m or "change_dir" in m:
        return "Dossier cible introuvable sur le serveur."
    if "command not found" in m or "rsync: not found" in m or "protocol version mismatch" in m:
        return "rsync absent sur le serveur distant."
    return msg


def _record_last_send(ok: bool, filename: str, error: str, trigger: str = "manual") -> None:
    """Persiste backup.remote.last_send (best-effort). ``ok_at`` garde la date
    du dernier SUCCÈS, que l'échec suivant n'efface pas."""
    try:
        full = read_config_json() or {}
        backup = full.get("backup") if isinstance(full.get("backup"), dict) else {}
        remote = backup.get("remote") if isinstance(backup.get("remote"), dict) else {}
        prev = remote.get("last_send") if isinstance(remote.get("last_send"), dict) else {}
        now = time.time()
        remote["last_send"] = {"at": now, "ok": ok, "filename": filename, "error": error,
                               "trigger": trigger,
                               "ok_at": now if ok else float(prev.get("ok_at") or 0)}
        backup["remote"] = remote
        full["backup"] = backup
        write_config_json(full)
    except Exception:
        logger.debug("[backup_remote] last_send non persisté", exc_info=True)


class _SendLock:
    """Un envoi à la fois, TOUS workers confondus (manuel + planifié) : verrou
    ``flock`` non bloquant sur ``SEND_LOCK_PATH``. ``acquired`` faux = occupé."""

    def __init__(self):
        self.acquired = False
        self._fd = None

    def __enter__(self):
        import fcntl
        try:
            Path(SEND_LOCK_PATH).parent.mkdir(parents=True, exist_ok=True)
            self._fd = open(SEND_LOCK_PATH, "a")
            fcntl.flock(self._fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.acquired = True
        except OSError:
            self.acquired = False
        return self

    def __exit__(self, *exc):
        if self._fd is not None:
            try:
                self._fd.close()                 # libère le flock
            except OSError:
                pass
        return False


async def run_send(scope: Optional[str] = None, *, trigger: str = "manual") -> Dict[str, Any]:
    """Construit une sauvegarde puis l'envoie selon le connecteur. Le zip
    temporaire est TOUJOURS supprimé (try/finally), comme le download.
    ``trigger`` : « manual » (bouton) ou « schedule » (backup_scheduler)."""
    with _SendLock() as lock:
        if not lock.acquired:
            return {"ok": False, "error": "Un envoi est déjà en cours."}
        return await _run_send_locked(scope, trigger)


async def _run_send_locked(scope: Optional[str], trigger: str) -> Dict[str, Any]:
    cfg = get_remote_config()
    ok, err = validate_remote_config(cfg)
    if not ok:
        return {"ok": False, "error": err}
    scope = scope or cfg["scope"]
    if scope not in SCOPES:
        return {"ok": False, "error": "Scope invalide"}

    # Builder synchrone potentiellement long → thread.
    from shared_infra.routes._legacy import _make_backup_zip
    tmp_path, filename = await asyncio.to_thread(_make_backup_zip, scope)
    try:
        if cfg["connector"] == "mounted":
            dest_dir = cfg["dest_path"]
            if not os.path.isdir(dest_dir) or not os.access(dest_dir, os.W_OK):
                res = {"ok": False, "error": "Dossier de destination indisponible"}
            else:
                # Dépôt atomique : copie en .part puis rename.
                final = os.path.join(dest_dir, filename)
                part = final + ".part"
                await asyncio.to_thread(shutil.copy2, tmp_path, part)
                await asyncio.to_thread(os.replace, part, final)
                res = {"ok": True, "error": "", "filename": filename}
        elif cfg["connector"] == "rsync":
            with _SshPassword() as sp:
                if sp.env is None:
                    res = {"ok": False, "error": "Mot de passe absent"}
                else:
                    ok2, msg = await _run(build_rsync_send_argv(cfg, tmp_path, filename),
                                          timeout=cfg["timeout_sec"] + 30, env=sp.env)
                    res = {"ok": ok2, "error": _ssh_error(msg),
                           "filename": filename if ok2 else ""}
        else:  # sftp
            if not os.path.exists(cfg["key_path"]):
                res = {"ok": False, "error": "Clé SSH absente"}
            else:
                ok2, msg = await _run(build_send_argv(cfg, tmp_path, filename),
                                      timeout=cfg["timeout_sec"])
                res = {"ok": ok2, "error": msg, "filename": filename if ok2 else ""}
    finally:
        try: os.remove(tmp_path)
        except Exception: pass

    _record_last_send(bool(res.get("ok")), res.get("filename", ""), res.get("error", ""),
                      trigger=trigger)
    return res
