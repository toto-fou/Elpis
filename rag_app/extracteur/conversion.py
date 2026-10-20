# SPDX-License-Identifier: MIT
# rag_app/extracteur/conversion.py — docx, pptx, xlsx vers PDF par LibreOffice, mis en cache par sha256.
from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import tempfile
import time
import uuid
import weakref
from collections import OrderedDict
from pathlib import Path
from typing import Any

from . import prison
from .chemins import racine_cache
from .erreurs import ErreurExtracteur
from .isolation import tuer_groupe
from .reglages import reglages

_VERSION = "v1"
# Profil LibreOffice des aperçus (apps/toolhost/src/office/conversion.ts) : macros coupées, liens des documents non fiables bloqués.
_PROFIL_XCU = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" \
xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse">\
<value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse">\
<value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" \
oor:op="fuse"><value>true</value></prop></item>
</oor:items>
"""
_sha_memo: "OrderedDict[tuple, str]" = OrderedDict()
_verrous: "weakref.WeakKeyDictionary[Any, dict[str, asyncio.Lock]]" = weakref.WeakKeyDictionary()
_limites: "weakref.WeakKeyDictionary[Any, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def soffice_bin() -> str:
    for candidat in (os.environ.get("RAG_SOFFICE_BIN"),):
        if candidat and os.path.isfile(candidat) and os.access(candidat, os.X_OK):
            return candidat
    return shutil.which("soffice") or ""


def sha256_fichier(chemin: Path) -> str:
    info = chemin.stat()
    cle = (str(chemin), info.st_size, info.st_mtime_ns)
    if cle in _sha_memo:
        _sha_memo.move_to_end(cle)
        return _sha_memo[cle]
    h = hashlib.sha256()
    with open(chemin, "rb") as fh:
        for bloc in iter(lambda: fh.read(1 << 20), b""):
            h.update(bloc)
    _sha_memo[cle] = h.hexdigest()
    while len(_sha_memo) > 256:
        _sha_memo.popitem(last=False)
    return _sha_memo[cle]


def _purger(dossier: Path, garder: Path) -> None:
    plafond = reglages().cache_max_mo * 1024 * 1024
    fichiers = [(f.stat().st_mtime, f.stat().st_size, f) for f in dossier.glob("*.pdf") if f.is_file()]
    total = sum(t for _, t, _ in fichiers)
    for _, taille, f in sorted(fichiers):
        if total <= plafond * 0.9:
            break
        if f != garder:
            f.unlink(missing_ok=True)
            total -= taille


def _nettoyer_tmp(cache: Path) -> None:
    limite = time.time() - 3600
    for reste in (cache / "tmp").glob("*"):
        if reste.stat().st_mtime < limite:
            shutil.rmtree(reste, ignore_errors=True)


def argv_soffice(binaire: str, travail: Path, ext: str, bwrap: str) -> list[str]:
    """Ligne de commande de la conversion : dans la prison bwrap quand elle est utilisable, le dossier de travail seul visible."""
    job = "/job" if bwrap else str(travail)
    lo = [binaire, "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
          f"-env:UserInstallation=file://{job}/profil", "--convert-to", "pdf", "--outdir", f"{job}/sortie",
          f"{job}/document{ext}"]
    if not bwrap:
        return lo
    installation = os.path.dirname(os.path.dirname(os.path.realpath(binaire)))
    extra = [] if installation.startswith("/usr/") else ["--ro-bind", installation, installation]
    return [bwrap, *prison.PRISON, *prison.POLICES, *extra, "--bind", str(travail), "/job", "--setenv", "HOME", "/job/profil",
            "--setenv", "TMPDIR", "/tmp", "--chdir", "/job", "--", *lo]


async def _soffice(source: Path, ext: str, cible: Path, delai: float) -> None:
    binaire = soffice_bin()
    if not binaire:
        raise ErreurExtracteur("soffice_unavailable", "LibreOffice (soffice) est introuvable.", 503)
    bwrap = await asyncio.to_thread(prison.exiger)
    travail = cible.parent.parent / "tmp" / uuid.uuid4().hex
    travail.mkdir(parents=True, mode=0o700)
    try:
        copie = travail / f"document{ext}"
        await asyncio.to_thread(shutil.copyfile, source, copie)
        (travail / "profil" / "user").mkdir(parents=True)
        (travail / "profil" / "user" / "registrymodifications.xcu").write_text(_PROFIL_XCU, encoding="utf-8")
        (travail / "sortie").mkdir()
        env = {"PATH": "/usr/bin:/bin", "HOME": str(travail / "profil"), "LANG": "C.UTF-8",
               "TMPDIR": str(travail)}
        with tempfile.TemporaryFile() as sortie:
            proc = await asyncio.create_subprocess_exec(
                *argv_soffice(binaire, travail, ext, bwrap), stdin=asyncio.subprocess.DEVNULL, stdout=sortie,
                stderr=sortie, env=env, start_new_session=True)
            try:
                await asyncio.wait_for(proc.wait(), delai)
            except TimeoutError:
                raise ErreurExtracteur("timeout", f"Conversion PDF trop longue ({delai:g} s).", 504)
            finally:
                if proc.returncode is None:
                    tuer_groupe(proc)
                    await proc.wait()
        produit = travail / "sortie" / "document.pdf"
        if proc.returncode != 0 or not produit.is_file():
            raise ErreurExtracteur("corrupt", "Conversion PDF impossible (document illisible).", 422)
        os.replace(produit, cible)
    finally:
        await asyncio.to_thread(shutil.rmtree, travail, True)


async def pdf_converti(source: Path, ext: str) -> Path:
    """PDF d'un document Office : produit par LibreOffice une seule fois, retrouvé par empreinte."""
    cache = racine_cache()
    dossier = cache / "conv"
    dossier.mkdir(parents=True, exist_ok=True)
    sha = await asyncio.to_thread(sha256_fichier, source)
    cible = dossier / f"{sha}-{_VERSION}.pdf"
    if cible.is_file():
        os.utime(cible)
        return cible
    boucle = asyncio.get_running_loop()
    verrous = _verrous.setdefault(boucle, {})
    limite = _limites.setdefault(boucle, asyncio.Semaphore(2))
    verrou = verrous.setdefault(sha, asyncio.Lock())
    async with verrou:
        if not cible.is_file():
            async with limite:
                await asyncio.to_thread(_nettoyer_tmp, cache)
                await _soffice(source, ext, cible, reglages().delai_conversion_s)
            await asyncio.to_thread(_purger, dossier, cible)
    verrous.pop(sha, None)
    return cible


