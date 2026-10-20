# SPDX-License-Identifier: MIT
# rag_app/extracteur/isolation.py — lance un travail dans un processus enfant borné (temps, mémoire) et le tue au dépassement.
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import tempfile
import weakref
from collections.abc import AsyncIterator
from contextlib import aclosing
from pathlib import Path
from typing import Any

from . import prison
from .erreurs import ErreurExtracteur
from .reglages import reglages

RACINE_PAQUET = str(Path(__file__).resolve().parent.parent)
ACTIFS: set[Any] = set()
_LIMITE_LIGNE = 1 << 30
_CODE = "import sys; sys.path.append(sys.argv[1]); from extracteur import _enfant; _enfant.principal()"
_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "HOME": "/tmp",
        "PYTHONDONTWRITEBYTECODE": "1", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}
_semaphores: "weakref.WeakKeyDictionary[Any, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _semaphore() -> asyncio.Semaphore:
    boucle = asyncio.get_running_loop()
    if boucle not in _semaphores:
        _semaphores[boucle] = asyncio.Semaphore(reglages().concurrence)
    return _semaphores[boucle]


def tuer_groupe(proc: Any) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass


def _erreur_sortie(code_retour: int, queue: str) -> ErreurExtracteur:
    """Signal de fin de l'enfant, direct (-n) ou relayé par bwrap (128 + n)."""
    if code_retour in (-signal.SIGXCPU, 128 + signal.SIGXCPU):
        return ErreurExtracteur("timeout", "Délai d'analyse dépassé.", 504)
    if code_retour in (-signal.SIGKILL, 128 + signal.SIGKILL) or "MemoryError" in queue:
        return ErreurExtracteur("too_large", "Mémoire insuffisante pour ce fichier.", 413)
    return ErreurExtracteur("corrupt", "Fichier illisible (l'analyse s'est interrompue).", 422)


async def flux(job: dict[str, Any], delai: float) -> AsyncIterator[dict[str, Any]]:
    """Messages `progress` puis `result` ; lève ErreurExtracteur (timeout, too_large, corrupt…)."""
    cfg = reglages()
    job = {**job, "limites": {"memoire_mo": cfg.memoire_enfant_mo, "cpu_s": int(delai) + 5}}
    commande = [sys.executable, "-I", "-c", _CODE, RACINE_PAQUET]
    bwrap = await asyncio.to_thread(prison.exiger)
    if bwrap:
        dedans = "/doc/source" + Path(str(job["path"])).suffix.lower()
        commande = prison.argv_analyse(bwrap, commande, str(job["path"]), dedans)
        job = {**job, "path": dedans}
    async with _semaphore():
        with tempfile.TemporaryFile() as erreurs:
            proc = await asyncio.create_subprocess_exec(
                *commande, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=erreurs, env=_ENV, cwd="/", start_new_session=True,
                limit=_LIMITE_LIGNE)
            ACTIFS.add(proc)
            final: dict[str, Any] | None = None
            try:
                assert proc.stdin is not None and proc.stdout is not None
                proc.stdin.write(json.dumps(job).encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()
                try:
                    async with asyncio.timeout(delai):
                        while final is None:
                            ligne = await proc.stdout.readline()
                            if not ligne:
                                break
                            message = json.loads(ligne)
                            if message.get("type") == "progress":
                                yield message
                            else:
                                final = message
                        await proc.wait()
                except TimeoutError:
                    raise ErreurExtracteur("timeout", f"Délai d'analyse dépassé ({delai:g} s).", 504)
                except ValueError:
                    raise ErreurExtracteur("too_large", "Résultat d'analyse trop volumineux.", 413)
            finally:
                if proc.returncode is None:
                    tuer_groupe(proc)
                    await proc.wait()
                ACTIFS.discard(proc)
            if final is None:
                erreurs.seek(0)
                raise _erreur_sortie(proc.returncode or 0, erreurs.read()[-2000:].decode("utf-8", "replace"))
    if final.get("type") == "error":
        raise ErreurExtracteur(final.get("code", "corrupt"), final.get("message", "Analyse impossible."),
                               int(final.get("http", 422)))
    yield final


async def executer(job: dict[str, Any], delai: float) -> dict[str, Any]:
    resultat: dict[str, Any] = {}
    async with aclosing(flux(job, delai)) as messages:
        async for message in messages:
            resultat = message
    resultat.pop("type", None)
    return resultat
