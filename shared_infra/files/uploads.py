# SPDX-License-Identifier: MIT
"""
backend.upload_utils — Helpers pour gérer les uploads de fichiers.

Fournit :

- :func:`save_upload_bounded` — copie streamée d'un ``UploadFile`` vers disque
  avec vérification de taille à la volée. Interrompue dès que ``max_bytes`` est
  dépassé (lève ``HTTPException(413)``). Exécutée dans un thread pour ne pas
  figer l'event loop asyncio pendant une copie de plusieurs Mo.

- :func:`read_upload_bounded` — lit un ``UploadFile`` en mémoire avec le même
  plafond. Retourne les bytes ou lève ``HTTPException(413)``.

Pourquoi pas juste ``Content-Length`` :
  L'en-tête ``Content-Length`` est envoyé par le client et peut être menti.
  Un attaquant (ou un client buggé) peut annoncer 1 Ko puis envoyer 10 Go —
  le serveur doit **vérifier au fur et à mesure** de la lecture. C'est ce que
  font ces helpers.

Pourquoi ``to_thread`` :
  ``shutil.copyfileobj`` et ``open(..., 'wb').write(...)`` sont synchrones.
  Les appeler dans un handler ``async`` gèle l'event loop du worker pour
  tous les autres utilisateurs pendant la durée de la copie (plusieurs
  secondes pour un gros fichier). Le wrapping dans ``asyncio.to_thread``
  déporte l'I/O sur un thread du thread-pool par défaut d'asyncio.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import HTTPException, UploadFile

# Taille de chunk pour la copie streamée (64 Ko = bon compromis RAM/syscalls).
_CHUNK_SIZE = 64 * 1024


# COPIE VOLONTAIRE — garder synchronisé avec ``rag_app/ocr/_uploads.py``.
# Voir la note détaillée dans ce fichier-là : ``rag_app`` est un service séparé
# qui n'importe pas ``shared_infra``, d'où les deux exemplaires de ce garde-fou.
# (Constat AUDIT 2026-08-30 / E2.)
def _copy_bounded_sync(src_fileobj, dest_path: Path, max_bytes: int) -> int:
    """Version synchrone : à appeler UNIQUEMENT via ``asyncio.to_thread``."""
    total = 0
    # Ouverture binaire en écriture (écrase si existe).
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
                except Exception:
                    pass
                raise HTTPException(
                    413,
                    f"Fichier trop volumineux (plafond : {max_bytes // (1024*1024)} Mo).",
                )
            dst.write(chunk)
    return total


async def save_upload_bounded(
    upload: UploadFile,
    dest_path: Path,
    max_bytes: int,
) -> int:
    """Copie ``upload`` vers ``dest_path`` avec plafond strict.

    * Streamé par chunks : pas de charge mémoire proportionnelle au fichier.
    * Exécuté dans un thread : ne fige pas l'event loop asyncio.
    * Si ``Content-Length`` annonce déjà > ``max_bytes`` on short-circuit
      sans ouvrir le fichier destination (évite un fichier vide sur disque).
    * Si la taille réelle dépasse pendant la copie, le fichier partiel
      est supprimé et ``HTTPException(413)`` remonte au handler.

    :raises HTTPException(413): si le fichier dépasse ``max_bytes``.
    :returns: nombre d'octets effectivement écrits.
    """
    # Pré-check sur Content-Length (rapide, optionnel, non fiable seul).
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


async def read_upload_bounded(
    upload: UploadFile,
    max_bytes: int,
) -> bytes:
    """Lit ``upload`` en RAM avec plafond strict.

    Utile quand on doit passer les bytes à une autre API (extract_text,
    image processing…) sans passer par un fichier intermédiaire.

    :raises HTTPException(413): si le fichier dépasse ``max_bytes``.
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

    chunks = []
    total = 0
    while True:
        # UploadFile.read est async et renvoie un bytes de la taille demandée.
        chunk = await upload.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                413,
                f"Fichier trop volumineux (plafond : {max_bytes // (1024*1024)} Mo).",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def assert_content_length_ok(
    upload: UploadFile,
    max_bytes: int,
) -> None:
    """Check rapide sur ``Content-Length`` — à utiliser AVANT tout traitement
    lourd dans les handlers qui ne peuvent pas switcher vers ``save_upload_bounded``.
    N'est **pas** une garantie (header spoofable), juste un fail-fast.
    """
    hdr = getattr(upload, "headers", None)
    if hdr is None:
        return
    cl = hdr.get("content-length")
    if not cl:
        return
    try:
        size = int(cl)
    except ValueError:
        return
    if size > max_bytes:
        raise HTTPException(
            413,
            f"Fichier trop volumineux (plafond : {max_bytes // (1024*1024)} Mo).",
        )
