# SPDX-License-Identifier: MIT
"""rag_app.ocr._uploads — copie bornée d'un upload (porté de shared_infra).

rag_app ne peut pas importer ``shared_infra.files.uploads`` — ce module en
reprend le seul helper utilisé par l'OCR : :func:`save_upload_bounded`.

Pourquoi pas juste ``Content-Length`` : l'en-tête est envoyé par le client
et peut mentir — le serveur vérifie AU FUR ET À MESURE de la lecture.

Pourquoi ``to_thread`` : la copie est synchrone ; dans un handler async elle
gèlerait l'event loop pendant plusieurs secondes pour un gros fichier.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import HTTPException, UploadFile

# Taille de chunk pour la copie streamée (64 Ko = bon compromis RAM/syscalls).
_CHUNK_SIZE = 64 * 1024


# COPIE VOLONTAIRE — garder synchronisé avec ``shared_infra/files/uploads.py``.
# ``rag_app`` est une application SÉPARÉE (process et port distincts) qui
# n'importe pas ``shared_infra`` : la factoriser créerait une dépendance entre
# deux services indépendants pour une trentaine de lignes. Mais c'est un
# garde-fou de SÉCURITÉ (plafond d'octets contre le remplissage de disque) —
# une divergence silencieuse entre les deux copies est le risque à surveiller.
# (Constat AUDIT 2026-08-30 / E2.)
def _copy_bounded_sync(src_fileobj, dest_path: Path, max_bytes: int) -> int:
    """Version synchrone : à appeler UNIQUEMENT via ``asyncio.to_thread``."""
    total = 0
    with open(dest_path, "wb") as dst:
        while True:
            chunk = src_fileobj.read(_CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                # Annule : supprime le fichier partiel et signale l'erreur.
                try:
                    dst.close()
                    dest_path.unlink(missing_ok=True)
                except Exception:  # noqa: BLE001
                    pass
                raise HTTPException(
                    413,
                    f"Fichier trop volumineux (plafond : {max_bytes // (1024*1024)} Mo).",
                )
            dst.write(chunk)
    return total


async def save_upload_bounded(upload: UploadFile, dest_path: Path,
                              max_bytes: int) -> int:
    """Copie ``upload`` vers ``dest_path`` avec plafond strict.

    * Streamé par chunks : pas de charge mémoire proportionnelle au fichier.
    * Exécuté dans un thread : ne fige pas l'event loop asyncio.
    * ``Content-Length`` > plafond → short-circuit sans fichier vide.
    * Dépassement en cours de copie → fichier partiel supprimé + 413.

    :raises HTTPException(413): si le fichier dépasse ``max_bytes``.
    :returns: nombre d'octets effectivement écrits.
    """
    hdr = getattr(upload, "headers", None)
    if hdr is not None:
        cl = hdr.get("content-length")
        if cl:
            try:
                if int(cl) > max_bytes:
                    raise HTTPException(
                        413,
                        f"Fichier trop volumineux (plafond : {max_bytes // (1024*1024)} Mo).",
                    )
            except ValueError:
                pass

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    # Le file-like de Starlette est un SpooledTemporaryFile, accessible via
    # upload.file. Son API est synchrone donc on déporte en thread.
    return await asyncio.to_thread(
        _copy_bounded_sync, upload.file, dest_path, max_bytes
    )
