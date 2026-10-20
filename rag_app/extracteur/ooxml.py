# SPDX-License-Identifier: MIT
# rag_app/extracteur/ooxml.py — contrôles communs aux fichiers OOXML (chiffrement, archive piégée, corruption).
from __future__ import annotations

import zipfile
from pathlib import Path

from .erreurs import ErreurExtracteur

_MAGIE_OLE = b"\xd0\xcf\x11\xe0"
_ENTREES_MAX = 100_000


def controler(chemin: Path, zip_max_mo: int) -> None:
    with open(chemin, "rb") as fh:
        debut = fh.read(8)
    if debut.startswith(_MAGIE_OLE):
        raise ErreurExtracteur("encrypted", "Document protégé par mot de passe.")
    try:
        with zipfile.ZipFile(chemin) as archive:
            entrees = archive.infolist()
    except (zipfile.BadZipFile, OSError):
        raise ErreurExtracteur("corrupt", "Archive Office illisible.")
    if len(entrees) > _ENTREES_MAX or sum(e.file_size for e in entrees) > zip_max_mo * 1024 * 1024:
        raise ErreurExtracteur("too_large", "Contenu décompressé trop volumineux.")
