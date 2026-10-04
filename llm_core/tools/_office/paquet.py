# SPDX-License-Identifier: MIT
"""llm_core/tools/_office/paquet.py — paquets Office : contrôle avant ouverture, formats « modèle », ressources.

Trois responsabilités communes à Word et PowerPoint :

  - ``controler_zip``  refuse une archive piégée AVANT qu'python-docx/pptx ne la
                       décompresse en mémoire (bombe zip, milliers d'entrées) ;
  - ``normaliser``     ouvre un .dotx/.potx/.docm/.pptm… comme un document
                       ordinaire (type du contenu principal réécrit) et retire
                       les macros : un fichier produit ne porte jamais de VBA ;
  - ``charger``        résout une image ou un modèle : data-URI, base64 ou chemin
                       DE LA SANDBOX via le lecteur installé par l'outil. Ni URL,
                       ni chemin de l'hôte : le moteur ne touche aucun disque.
"""
from __future__ import annotations

import base64
import binascii
import contextvars
import io
import re
import zipfile
from typing import Callable, Dict, List, Optional, Tuple

from lxml import etree

# Plafonds d'une archive Office lue (le fichier lui-même est plafonné à la lecture).
ZIP_MAX_ENTREES = 2000
ZIP_MAX_DECOMPRESSE = 200 * 1024 * 1024
ZIP_MAX_RATIO = 200          # au-delà, une entrée de plus de 10 Mo décompressés est suspecte

_CT = "[Content_Types].xml"
_MACROS = ("vbaproject.bin", "vbadata.xml")

_PRINCIPAL = {
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
        "application/vnd.ms-word.document.macroEnabled.main+xml",
        "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
    }),
    "pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", {
        "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
        "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
        "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
        "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
    }),
}

_NOM = {"docx": "Word document", "pptx": "PowerPoint deck"}


class PaquetInvalide(ValueError):
    """Le fichier n'est pas un paquet Office utilisable (message destiné au modèle)."""


def controler_zip(blob: bytes, quoi: str = "file") -> zipfile.ZipFile:
    """Ouvre l'archive et vérifie ses plafonds sans rien décompresser."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
        infos = archive.infolist()
    except (zipfile.BadZipFile, OSError, ValueError) as exc:
        raise PaquetInvalide(f"The {quoi} is not an Office file (not a zip package): {exc}") from exc
    if len(infos) > ZIP_MAX_ENTREES:
        raise PaquetInvalide(f"The {quoi} has {len(infos)} parts (limit {ZIP_MAX_ENTREES}).")
    total = 0
    for info in infos:
        total += info.file_size
        if info.compress_size and info.file_size / info.compress_size > ZIP_MAX_RATIO \
                and info.file_size > 10 * 1024 * 1024:
            raise PaquetInvalide(f"The {quoi} looks like a zip bomb ({info.filename}).")
    if total > ZIP_MAX_DECOMPRESSE:
        raise PaquetInvalide(f"The {quoi} expands to {total // (1024 * 1024)} MB "
                             f"(limit {ZIP_MAX_DECOMPRESSE // (1024 * 1024)} MB).")
    return archive


def normaliser(blob: bytes, sorte: str, quoi: str = "file") -> Tuple[bytes, List[str]]:
    """Contrôle l'archive puis la rend ouvrable par python-docx/pptx.

    Rend ``(octets, notes)`` ; les notes disent ce qui a été changé."""
    archive = controler_zip(blob, quoi)
    noms = archive.namelist()
    if _CT not in noms:
        raise PaquetInvalide(f"The {quoi} has no [Content_Types].xml: it is not an Office file.")
    principal, alias = _PRINCIPAL[sorte]
    types = archive.read(_CT).decode("utf-8", "replace")
    if principal not in types and not any(a in types for a in alias):
        autre = "pptx" if sorte == "docx" else "docx"
        if _PRINCIPAL[autre][0] in types or any(a in types for a in _PRINCIPAL[autre][1]):
            raise PaquetInvalide(f"The {quoi} is a {_NOM[autre]}, not a {_NOM[sorte]}: "
                                 f"use the {autre}_* tools for it.")
        raise PaquetInvalide(f"The {quoi} is not a {_NOM[sorte]}.")
    notes: List[str] = []
    change = False
    for a in alias:
        if a in types:
            types = types.replace(a, principal)
            change = True
    if change:
        notes.append("opened a template-format file as a regular one (styles and layouts kept)")
    macros = [n for n in noms if n.rsplit("/", 1)[-1].lower() in _MACROS]
    parts: Dict[str, bytes] = {}
    if not change and not macros:
        return blob, notes
    for n in noms:
        if n in macros:
            continue
        parts[n] = archive.read(n)
    if macros:
        types = _sans_macros_ct(types, macros)
        for n, data in list(parts.items()):
            if n.endswith(".rels"):
                parts[n] = _sans_macros_rels(data, macros)
        notes.append(f"removed {len(macros)} macro part(s): produced files never carry VBA")
    parts[_CT] = types.encode("utf-8")
    sortie = io.BytesIO()
    with zipfile.ZipFile(sortie, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in parts.items():
            z.writestr(n, data)
    return sortie.getvalue(), notes


def _sans_macros_ct(types: str, macros: List[str]) -> str:
    try:
        racine = etree.fromstring(types.encode())
    except etree.XMLSyntaxError:
        return types
    voulus = {f"/{n}".lower() for n in macros}
    for el in list(racine):
        if etree.QName(el).localname == "Override" and (el.get("PartName") or "").lower() in voulus:
            racine.remove(el)
    return etree.tostring(racine, xml_declaration=True, encoding="UTF-8", standalone=True).decode()


def _sans_macros_rels(data: bytes, macros: List[str]) -> bytes:
    try:
        racine = etree.fromstring(data)
    except etree.XMLSyntaxError:
        return data
    bouts = {n.rsplit("/", 1)[-1].lower() for n in macros}
    for el in list(racine):
        if (el.get("Target") or "").rsplit("/", 1)[-1].lower() in bouts:
            racine.remove(el)
    return etree.tostring(racine, xml_declaration=True, encoding="UTF-8", standalone=True)


# ── Ressources (images, modèles) ───────────────────────────────────────────
# L'outil installe un lecteur ``chemin -> octets`` limité à la sandbox de
# l'appelant ; le moteur ne connaît que ``charger``. ContextVar : chaque appel
# (thread du pool d'outils) a le sien.
Lecteur = Callable[[str, str], bytes]
_lecteur: "contextvars.ContextVar[Optional[Lecteur]]" = contextvars.ContextVar(
    "office_lecteur", default=None)

_DATA_URI = re.compile(r"^data:(?P<mime>[\w.+/-]+)?(?:;[\w=.-]+)*;base64,(?P<b64>.*)$", re.S)


def installer_lecteur(lecteur: Optional[Lecteur]) -> "contextvars.Token":
    return _lecteur.set(lecteur)


def retirer_lecteur(jeton: "contextvars.Token") -> None:
    _lecteur.reset(jeton)


def charger(source: str, quoi: str = "file", **_ignore) -> bytes:
    """Octets d'une ressource : data-URI, base64 brut ou chemin de la sandbox."""
    texte = (source or "").strip()
    if not texte:
        raise PaquetInvalide(f"Empty {quoi} source.")
    m = _DATA_URI.match(texte)
    if m:
        return _b64(m.group("b64"), quoi)
    if re.match(r"^[a-z][a-z0-9+.-]*://", texte, re.I):
        raise PaquetInvalide(f"The {quoi} {texte[:80]!r} is a URL: nothing is downloaded. "
                             "Save the file in the sandbox first and give its path.")
    lecteur = _lecteur.get()
    if lecteur is None:
        raise PaquetInvalide(f"No sandbox reader for the {quoi} {texte[:80]!r}.")
    return lecteur(texte, quoi)


def _b64(texte: str, quoi: str) -> bytes:
    try:
        return base64.b64decode("".join(texte.split()), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PaquetInvalide(f"The {quoi} is not valid base64: {exc}") from exc
