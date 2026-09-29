# SPDX-License-Identifier: MIT
"""shared_infra.sandbox.filetypes — reconnaissance des fichiers binaires et Office.

Sans dépendance, partagé par la garde de sauvegarde (``routes_files``) et les
aperçus Office (``office_preview``). La même règle vit côté navigateur dans
``frontend/js/editor/_office_model.js`` (``looksBinary``) : les deux doivent
rester alignées, sinon l'éditeur ouvrirait en texte un fichier que le serveur
refuse ensuite de sauvegarder.
"""
from __future__ import annotations

# Extensions prévisualisées (aperçu Office / PDF) → type.
OFFICE_KINDS = {
    ".docx": "docx",
    ".pptx": "pptx",
    ".xlsx": "xlsx",
    ".pdf": "pdf",
}

# Signatures de formats binaires courants. Un fichier texte ne commence
# jamais par ces octets ; un NUL dans l'en-tête suffit pour le reste.
BINARY_MAGICS = (
    b"%PDF-",
    b"PK\x03\x04",           # zip : docx/xlsx/pptx/jar/odt…
    b"PK\x05\x06",           # zip vide
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",         # JPEG
    b"GIF87a", b"GIF89a",
    b"\x7fELF",
    b"\x1f\x8b",             # gzip
    b"BZh",
    b"\xfd7zXZ\x00",
    b"7z\xbc\xaf\x27\x1c",
    b"Rar!\x1a\x07",
    b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",   # CFB : .doc/.xls/.ppt, Office chiffré
    b"\xff\xfe", b"\xfe\xff",               # BOM UTF-16 (illisible en UTF-8)
)

SNIFF_BYTES = 8192


def looks_binary(head: bytes) -> bool:
    """Vrai si ``head`` (début du fichier) ne peut pas être édité comme texte."""
    if not head:
        return False
    if b"\x00" in head[:SNIFF_BYTES]:
        return True
    return head.startswith(BINARY_MAGICS)

