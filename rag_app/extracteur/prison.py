# SPDX-License-Identifier: MIT
# rag_app/extracteur/prison.py — prison bubblewrap des analyses et de LibreOffice : rien du disque hors /usr et des chemins prêtés, aucun réseau.
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from typing import Any

from .erreurs import ErreurExtracteur

# Mêmes options que la prison des aperçus Office (packages/bac/src/bwrap.ts).
PRISON = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr",
          "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
          "--symlink", "usr/sbin", "/sbin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
POLICES = ["--ro-bind-try", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/libreoffice", "/etc/libreoffice",
           "--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig"]
_sonde: dict[str, Any] = {"t": 0.0, "bin": None}


def mode() -> str:
    """RAG_ISOLATION : auto (prison si bubblewrap marche ici), bwrap (exigée) ou none."""
    valeur = os.environ.get("RAG_ISOLATION", "auto").strip().lower()
    return valeur if valeur in ("auto", "bwrap", "none") else "auto"


def bwrap_utilisable() -> str:
    """Chemin de bwrap s'il isole vraiment ici (sonde gardée 10 min), sinon "" (et toujours "" en mode none)."""
    if mode() == "none":
        return ""
    if _sonde["bin"] is not None and time.monotonic() - _sonde["t"] < 600:
        return _sonde["bin"]
    chemin = shutil.which("bwrap") or ""
    ok = False
    if chemin and os.path.exists("/usr/bin/true"):
        try:
            ok = subprocess.run([chemin, *PRISON, "/usr/bin/true"], stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=5, env={"PATH": "/usr/bin:/bin"}).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
    _sonde.update(t=time.monotonic(), bin=chemin if ok else "")
    return _sonde["bin"]


def exiger() -> str:
    """bwrap à utiliser ("" sans prison) ; en mode bwrap sans prison possible, 503 plutôt qu'une analyse à nu."""
    bwrap = bwrap_utilisable()
    if not bwrap and mode() == "bwrap":
        raise ErreurExtracteur("isolation_unavailable", "Isolation des analyses (bubblewrap) indisponible.", 503)
    return bwrap


def _lecture(chemin: str) -> list[str]:
    reel = os.path.realpath(chemin)
    return [] if reel == "/usr" or reel.startswith("/usr/") else ["--ro-bind", reel, reel]


def argv_analyse(bwrap: str, commande: list[str], source: str, dedans: str) -> list[str]:
    """Processus d'analyse dans la prison : l'interpréteur et son venv, le code de l'extracteur et la seule source, en lecture."""
    racine_code = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    vus: list[str] = []
    for d in dict.fromkeys(os.path.realpath(x) for x in (sys.prefix, sys.base_prefix, racine_code)):
        vus += _lecture(d)
    return [bwrap, *PRISON, *POLICES, *vus, "--ro-bind", os.path.realpath(source), dedans, "--chdir", "/", "--",
            *commande]
