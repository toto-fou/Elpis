# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/bwrap.py — prison ``bubblewrap`` des commandes que
l'hôte lance sur des données de la sandbox (aperçus Office ; Git tourne dans
la sandbox depuis L4.4).

Tout est désolidarisé (``--unshare-all`` : réseau, PID, IPC, utilisateur…),
``/usr`` est en lecture seule, ``/tmp`` est vide, et seuls les dossiers que
l'appelant ajoute sont visibles : ce qui s'exécute dedans ne voit ni la base,
ni les secrets de l'app, ni le socket Docker, ni la sandbox d'un autre
utilisateur, ni le réseau.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from typing import List

logger = logging.getLogger("uvicorn.error")

_probe_lock = threading.Lock()
_probe_cache: dict = {"at": 0.0, "ok": False, "bin": ""}
_PROBE_TTL_S = 600.0


def base_argv() -> List[str]:
    """Options communes, sans le binaire ni la commande. ``/bin``, ``/lib``…
    sont des liens vers ``/usr`` (Debian et Ubuntu à ``/usr`` fusionné)."""
    argv = [
        "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--symlink", "usr/sbin", "/sbin",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ]
    return argv


def probe(force: bool = False) -> bool:
    """bwrap utilisable ici (installé, user namespaces autorisés, AppArmor) ?
    Résultat mis en cache 10 min par process."""
    now = time.monotonic()
    with _probe_lock:
        if not force and _probe_cache["bin"] and now - _probe_cache["at"] < _PROBE_TTL_S:
            return bool(_probe_cache["ok"])
        path = shutil.which("bwrap") or ""
        ok = False
        if path and os.path.exists("/usr/bin/true"):
            try:
                proc = subprocess.run(
                    [path, *base_argv(), "/usr/bin/true"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE, timeout=5, env={"PATH": "/usr/bin:/bin"},
                )
                ok = proc.returncode == 0
                if not ok:
                    logger.warning("[bwrap] inutilisable : %s",
                                   (proc.stderr or b"").decode(errors="replace").strip()[-200:])
            except (OSError, subprocess.SubprocessError) as exc:
                logger.warning("[bwrap] sonde échouée : %r", exc)
        _probe_cache.update(at=now, ok=ok, bin=path or "absent")
        return ok


def binary() -> str:
    """Chemin de ``bwrap`` après :func:`probe` (``""`` s'il est absent)."""
    b = _probe_cache["bin"]
    return "" if b == "absent" else b


__all__ = ["base_argv", "binary", "probe"]
