# SPDX-License-Identifier: MIT
"""shared_infra.sandbox.office_convert — conversion LibreOffice ISOLÉE pour les
aperçus Office de l'éditeur (docx/pptx/xlsx → PDF, xlsx → CSV).

Pourquoi une prison (vérifié sur l'hôte, cf.
``docs/editor-office-preview-design-2026-09-15.md`` § Étape 0) : sans elle, un
docx piégé fait EMBARQUER un fichier de l'hôte dans le PDF (image liée
``file:///…``) et émettre des requêtes HTTP vers 127.0.0.1 (SSRF). Dans
``bwrap --unshare-all`` : ni réseau, ni FS hôte en dehors de ``/usr`` et des
polices — rien ne sort.

Contrats :
  * jamais d'héritage de ``os.environ`` (secret de session, jetons MCP) ;
  * ``start_new_session`` + ``os.killpg`` : un délai dépassé ne laisse aucun
    ``soffice.bin`` orphelin (le wrapper ``soffice`` seul ne suffit pas) ;
  * concurrence bornée POUR TOUS LES WORKERS gunicorn via ``flock`` (un
    sémaphore asyncio ne voit que son process) : verrou de clé (déduplication)
    → créneau utilisateur → créneau global, toujours dans cet ordre ;
  * LibreOffice rend 0 même quand le document n'a pas pu être chargé : seule
    la présence et la signature de la sortie font foi.
"""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, List, Optional, Sequence, TypeVar

from shared_infra.runtime.runtime_dir import runtime_path as _runtime_path
from shared_infra.sandbox import bwrap

logger = logging.getLogger("uvicorn.error")

T = TypeVar("T")


class OfficeError(Exception):
    """Échec présentable : ``code`` stable pour le front, ``status`` HTTP,
    ``message`` court en français."""

    def __init__(self, code: str, status: int, message: str):
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message


# Filtres d'import FORCÉS : sans eux LibreOffice choisit d'après le contenu,
# et un .doc/.rtf/.html renommé passerait par un autre filtre.
INFILTERS = {
    "docx": "MS Word 2007 XML",
    "pptx": "Impress MS PowerPoint 2007 XML",
    "xlsx": "Calc MS Excel 2007 XML",
    "odt": "writer8",
    "odp": "impress8",
    "ods": "calc8",
    # Graphiques des outils Office (SVG produit par le rendu ECharts → PNG).
    "svg": "SVG - Scalable Vector Graphics Draw",
}
PDF_EXPORT_FILTERS = {
    "docx": "writer_pdf_Export",
    "pptx": "impress_pdf_Export",
    "xlsx": "calc_pdf_Export",
    "odt": "writer_pdf_Export",
    "odp": "impress_pdf_Export",
    "ods": "calc_pdf_Export",
}
# Toutes les feuilles (jeton 12 = -1), UTF-8 (76), valeurs « telles
# qu'affichées » (jeton 9) — vérifié sur 25.2 : un fichier ``in-<Feuille>.csv``
# par feuille, masquées comprises, origine A1 conservée.
CSV_CONVERT = "csv:Text - txt - csv (StarCalc):44,34,76,1,,1036,false,true,true,false,false,-1"

LOCK_DIR = _runtime_path("office_locks", "ELPIS_OFFICE_LOCK_DIR", "/tmp/elpis_office_locks")

_DEFAULTS = {
    "isolation": "auto",
    "timeout_s": 60,
    "slots": 2,
    "slots_per_user": 1,
    "wait_s": 20,
    "max_pdf_mb": 300,
}


def cfg(key: str, default: Any = None) -> Any:
    """Réglage ``config.json › office_preview.<key>`` lu à l'appel (multi-workers)."""
    if default is None:
        default = _DEFAULTS.get(key)
    try:
        from shared_infra.config import live_config_value
        val = live_config_value(f"office_preview.{key}", default)
    except Exception:
        return default
    return default if val is None else val


def _int_cfg(key: str, lo: int, hi: int) -> int:
    try:
        v = int(cfg(key))
    except (TypeError, ValueError):
        v = int(_DEFAULTS[key])
    return max(lo, min(hi, v))


# ─────────────────────────────────────────────────────────────────────────────
#  Binaire LibreOffice
# ─────────────────────────────────────────────────────────────────────────────
def soffice_bin() -> str:
    """Chemin RÉEL du lanceur ``program/soffice`` ("" si introuvable).

    Le lien ``/usr/bin/soffice`` est résolu : dans la prison, seul le chemin
    réel (sous ``/usr/lib/libreoffice``) existe tel quel.
    """
    cand = (os.environ.get("APP_SOFFICE_BIN", "").strip()
            or str(cfg("soffice_bin", "") or "").strip()
            or shutil.which("soffice") or "")
    if not cand:
        return ""
    real = os.path.realpath(cand)
    return real if os.path.isfile(real) and os.access(real, os.X_OK) else ""


def lo_version_token(soffice: str) -> str:
    """Empreinte de l'installation : une mise à jour de LibreOffice change
    le rendu, donc invalide le cache."""
    if not soffice:
        return "none"
    prog = Path(soffice).parent
    parts = [soffice]
    for name in ("soffice.bin", "versionrc"):
        try:
            parts.append(str((prog / name).stat().st_mtime_ns))
        except OSError:
            parts.append("-")
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


# ─────────────────────────────────────────────────────────────────────────────
#  Isolation
# ─────────────────────────────────────────────────────────────────────────────
_warned_none = False


def _bwrap_base(install_dirs: List[str]) -> List[str]:
    """Prison commune (``bwrap.base_argv``), plus les polices et la
    configuration LibreOffice.

    ⚠ ``/etc/libreoffice`` est indispensable : ``program/sofficerc`` y pointe
    (sans lui, abandon immédiat, code 134)."""
    argv = bwrap.base_argv() + [
        "--ro-bind-try", "/etc/fonts", "/etc/fonts",
        "--ro-bind-try", "/etc/libreoffice", "/etc/libreoffice",
        "--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig",
    ]
    for d in install_dirs:
        if d and not d.startswith("/usr/"):
            argv += ["--ro-bind", d, d]
    return argv


def _install_dirs(soffice: str) -> List[str]:
    # program/soffice → racine d'installation (…/libreoffice).
    return [str(Path(soffice).parent.parent)] if soffice else []


probe_bwrap = bwrap.probe


def isolation_mode() -> str:
    """``"bwrap"`` ou ``"none"`` (seulement si EXPLICITE en config).

    ``auto`` exige bwrap : convertir sans prison un document venu d'Internet
    exposerait les fichiers et le réseau de l'hôte (cf. en-tête)."""
    global _warned_none
    mode = str(cfg("isolation") or "auto").strip().lower()
    if mode == "none":
        if not _warned_none:
            _warned_none = True
            logger.warning("[office] aperçus Office SANS isolation "
                           "(office_preview.isolation = \"none\")")
        return "none"
    if probe_bwrap():
        return "bwrap"
    raise OfficeError("isolation_unavailable", 503,
                      "Isolation indisponible sur le serveur (bubblewrap)")


# ─────────────────────────────────────────────────────────────────────────────
#  Profils LibreOffice (un par créneau global, réutilisé : démarrage à chaud)
# ─────────────────────────────────────────────────────────────────────────────
_PROFILE_VERSION = "1"
_REGISTRY_XCU = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
"""


def ensure_profile(profile_dir: Path) -> None:
    """Crée/sème le profil d'un créneau. Appelé SOUS le verrou du créneau."""
    marker = profile_dir / ".elpis-profile"
    try:
        if marker.read_text() == _PROFILE_VERSION:
            _clear_stale_lock(profile_dir)
            return
    except OSError:
        pass
    if profile_dir.exists():
        shutil.rmtree(profile_dir, ignore_errors=True)
    profile_dir.parent.mkdir(mode=0o700, exist_ok=True)
    (profile_dir / "user").mkdir(parents=True, mode=0o700, exist_ok=True)
    (profile_dir / "user" / "registrymodifications.xcu").write_text(_REGISTRY_XCU)
    marker.write_text(_PROFILE_VERSION)


def _clear_stale_lock(profile_dir: Path) -> None:
    # Un SIGKILL laisse ``.lock`` : inoffensif avec --nolockcheck (vérifié),
    # retiré quand même — on tient le créneau, personne d'autre n'utilise ce profil.
    try:
        (profile_dir / ".lock").unlink()
    except OSError:
        pass


# ─────────────────────────────────────────────────────────────────────────────
#  Verrous multi-workers (flock)
# ─────────────────────────────────────────────────────────────────────────────
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,80}$")


def _ensure_lock_dir() -> bool:
    try:
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        os.chmod(LOCK_DIR, 0o700)
    except OSError as exc:
        logger.warning("[office] dossier de verrous %s inutilisable (%r)", LOCK_DIR, exc)
        return False
    return True


def try_lock(name: str) -> Optional[int]:
    """Verrou exclusif non bloquant ``<LOCK_DIR>/<name>.lock`` → fd ou None."""
    if not _NAME_RE.match(name) or not _ensure_lock_dir():
        return None
    path = LOCK_DIR / f"{name}.lock"
    for _ in range(4):
        try:
            fd = os.open(str(path), os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)
        except OSError:
            return None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return None
        try:
            same = os.fstat(fd).st_ino == os.stat(str(path)).st_ino
        except OSError:
            same = False
        if same:
            try:
                os.utime(str(path), None)
            except OSError:
                pass
            return fd
        os.close(fd)        # inode remplacé entre open et flock (balayage) → on reboucle
    return None


def release_lock(fd: Optional[int]) -> None:
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        pass


async def acquire_first(names: List[str], deadline: float) -> tuple:
    """Prend le premier verrou libre parmi ``names`` avant ``deadline``
    (horloge monotone) → ``(fd, nom)``. Sinon ``OfficeError("busy")``."""
    while True:
        for n in names:
            fd = try_lock(n)
            if fd is not None:
                return fd, n
        if time.monotonic() >= deadline:
            raise OfficeError("busy", 503, "Conversions occupées, réessayez")
        await asyncio.sleep(0.25)


def prune_lock_files(max_age_s: float = 86400.0) -> int:
    """Retire les fichiers-verrous anciens ET libres (jamais un verrou tenu)."""
    removed = 0
    try:
        entries = list(LOCK_DIR.iterdir())
    except OSError:
        return 0
    now = time.time()
    for p in entries:
        if not p.name.endswith(".lock"):
            continue
        try:
            if now - p.stat().st_mtime < max_age_s:
                continue
        except OSError:
            continue
        fd = try_lock(p.name[:-5])
        if fd is None:
            continue
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
        finally:
            release_lock(fd)
    return removed


# ─────────────────────────────────────────────────────────────────────────────
#  Pool CPU dédié (jamais le pool par défaut de la boucle, partagé)
# ─────────────────────────────────────────────────────────────────────────────
_pool_lock = threading.Lock()
_pool: Optional[ThreadPoolExecutor] = None
_pool_pid: Optional[int] = None


def _executor() -> ThreadPoolExecutor:
    """Créé à la demande et PAR PID (gunicorn fork : un pool hérité n'a plus
    de threads) — même patron que ``accounts/passwd.py``."""
    global _pool, _pool_pid
    pid = os.getpid()
    if _pool is not None and _pool_pid == pid:
        return _pool
    with _pool_lock:
        if _pool is None or _pool_pid != pid:
            _pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="office")
            _pool_pid = pid
    return _pool


async def run_cpu(fn: Callable[..., T], *args: Any) -> T:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor(), lambda: fn(*args))


# ─────────────────────────────────────────────────────────────────────────────
#  Exécution
# ─────────────────────────────────────────────────────────────────────────────
def build_argv(*, isolation: str, soffice: str, profile_dir: Path, job_dir: Path,
               kind: str, in_name: str, convert_to: str, timeout_s: int,
               more_names: Sequence[str] = ()) -> List[str]:
    """Ligne de commande complète (prlimit → bwrap → soffice).

    ``more_names`` : fichiers supplémentaires du même type, convertis par le
    même lancement (un seul démarrage de LibreOffice)."""
    jailed = isolation == "bwrap"
    profile_in = "/profile" if jailed else str(profile_dir)
    job_in = "/job" if jailed else str(job_dir)
    lo = [
        soffice, "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
        f"-env:UserInstallation=file://{profile_in}",
        f"--infilter={INFILTERS[kind]}",
        "--convert-to", convert_to,
        "--outdir", f"{job_in}/out",
        f"{job_in}/{in_name}",
        *(f"{job_in}/{n}" for n in more_names),
    ]
    argv: List[str] = []
    prlimit = shutil.which("prlimit")
    if prlimit:
        # Filet CPU (le délai mural tue avant) + taille de fichier écrit.
        argv += [prlimit, f"--cpu={int(timeout_s) * 2 + 30}",
                 f"--fsize={1024 * 1024 * 1024}", "--nofile=1024", "--"]
    if jailed:
        argv += [bwrap.binary() or "bwrap", *_bwrap_base(_install_dirs(soffice)),
                 "--bind", str(profile_dir), "/profile",
                 "--bind", str(job_dir), "/job",
                 "--setenv", "HOME", "/profile",
                 "--setenv", "TMPDIR", "/tmp",
                 "--chdir", "/job", "--"]
    return argv + lo


def child_env(isolation: str, profile_dir: Path, job_dir: Path) -> dict:
    """Environnement MINIMAL — surtout pas ``os.environ`` (secrets du worker)."""
    jailed = isolation == "bwrap"
    return {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": "/profile" if jailed else str(profile_dir),
        "TMPDIR": "/tmp" if jailed else str(job_dir / "tmp"),
    }


def _killpg(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass


async def run_soffice(argv: List[str], env: dict, *, cwd: Path, log_path: Path,
                      timeout_s: float) -> int:
    """Lance la conversion ; délai dépassé ou annulation → tout le groupe tué."""
    (cwd / "tmp").mkdir(exist_ok=True)
    with open(log_path, "wb") as log:  # noqa: ASYNC230 (sortie du process, fichier local)
        proc = await asyncio.create_subprocess_exec(
            *argv, env=env, cwd=str(cwd), start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            return await asyncio.wait_for(proc.wait(), timeout_s)
        except asyncio.TimeoutError:
            _killpg(proc.pid)
            await proc.wait()
            raise OfficeError("timeout", 504, "Conversion trop longue (délai dépassé)")
        except asyncio.CancelledError:
            _killpg(proc.pid)
            try:
                await asyncio.shield(proc.wait())
            except BaseException:
                pass
            raise
        finally:
            if proc.returncode is None:
                _killpg(proc.pid)


def read_log_tail(log_path: Path, limit: int = 400) -> str:
    try:
        data = log_path.read_bytes()[-4096:]
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if "javaldx" not in ln and ln.strip()]
    return "\n".join(lines)[-limit:]


_PAGE_RE = re.compile(rb"/Type\s{0,8}/Page(?![a-zA-Z])")
_PAGE_CARRY = 32


def count_pdf_pages(pdf: Path, block_size: int = 1 << 20) -> int:
    """Nombre d'objets ``/Type /Page`` (LibreOffice ne compresse pas les
    dictionnaires d'objets). Lecture par blocs : une occurrence n'est jugée
    que si l'octet qui la suit est disponible (``/Pages`` coupé en bout de
    bloc ne doit pas compter), le reste est reporté au bloc suivant."""
    count, carry = 0, b""
    try:
        with open(pdf, "rb") as f:
            while True:
                block = f.read(block_size)
                final = not block
                buf = carry + block
                limit = len(buf) if final else len(buf) - _PAGE_CARRY
                next_start = max(0, limit)
                for m in _PAGE_RE.finditer(buf):
                    if m.end() <= limit:
                        count += 1
                    else:
                        next_start = min(next_start, m.start())
                        break
                if final:
                    break
                carry = buf[next_start:]
    except OSError:
        return 0
    return count
