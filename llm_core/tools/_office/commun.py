# SPDX-License-Identifier: MIT
"""llm_core/tools/_office/commun.py — socle commun des outils Word / PowerPoint.

  - ``OfficeError``  refus guidé (message + ``fix`` + ``example``), comme les
                     outils graphiques ;
  - ``canon``        arguments tolérants : casse, accents, camelCase, synonymes
                     français (« fichier », « contenu », « diapos »…) ;
  - ``chemin_*``     cadrage des fichiers : chemin DANS la sandbox (ni absolu
                     hors de ``/work`` ni ``..`` qui en sort), extension imposée
                     et corrigée, nom nettoyé ;
  - ``Env``          ce que l'outil reçoit de l'hôte : l'espace de fichiers de
                     l'appelant, ses graphiques, le rendu et la conversion.
"""
from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, Tuple

from .._chart.normalise import Notes, fold

# Plafonds (octets) : un fichier Office lu, un fichier produit.
MAX_LECTURE = 32 * 1024 * 1024
MAX_ECRITURE = 50 * 1024 * 1024

EXT = {"docx": ".docx", "pptx": ".pptx"}
# Extensions qu'on lit comme le format (modèles, macros) ; à l'écriture on
# produit toujours .docx/.pptx.
EXT_LUES = {
    "docx": (".docx", ".dotx", ".docm", ".dotm"),
    "pptx": (".pptx", ".potx", ".pptm", ".potm", ".ppsx"),
}
# Extensions « voisines » corrigées sans refus (signalé dans fixes) à l'écriture.
EXT_VOISINES = {
    "docx": (".doc", ".dotx", ".docm", ".dotm", ".odt", ".rtf", ".txt", ".md", ".pdf"),
    "pptx": (".ppt", ".potx", ".pptm", ".potm", ".ppsx", ".odp", ".key", ".pdf", ".md"),
}
_AUTRE = {"docx": "pptx", "pptx": "docx"}


class OfficeError(Exception):
    """Refus destiné au modèle : quoi, comment corriger, un exemple."""

    def __init__(self, message: str, fix: str = "", example: Any = None,
                 code: str = "invalid_request", retryable: bool = False):
        super().__init__(message)
        self.message = message
        self.fix = fix
        self.example = example
        self.code = code
        self.retryable = retryable      # panne passagère : réessayer peut réussir


# ── Espace de fichiers (fourni par l'hôte) ──────────────────────────────────
@dataclass
class Ecrit:
    path: str                 # chemin affiché au modèle (/work/…)
    old_sha256: str           # "" si le fichier n'existait pas
    new_sha256: str
    size: int
    history_kept: bool = True  # ancienne version gardée dans l'historique de session


class Espace(Protocol):
    """``lire`` : ``FileNotFoundError`` / ``IsADirectoryError`` / ``ValueError``
    (trop gros, hors sandbox). ``ecrire`` : ``attendu`` = empreinte du fichier
    tel qu'il a été LU ; s'il a changé depuis (éditeur, shell, autre agent),
    rien n'est écrit et ``OfficeError("concurrent_modification")`` est levée —
    sans cela, une modification calculée sur l'ancienne version écraserait la
    nouvelle. Sans ``attendu`` (création), le dernier écrivain gagne."""

    def lire(self, rel: str, max_bytes: int) -> bytes: ...
    def ecrire(self, rel: str, data: bytes, attendu: Optional[str] = None) -> Ecrit: ...
    def afficher(self, rel: str) -> str: ...


@dataclass
class Env:
    espace: Espace
    graphique: Callable[[str], Optional[Dict[str, Any]]] = lambda _id: None
    # (octets, extension source, format cible) -> octets ; None = pas de LibreOffice
    convertir: Optional[Callable[[bytes, str, str], bytes]] = None
    # svg -> png (rasterisation des graphiques non natifs) ; b"" = échec de
    # celui-là ; None = indisponible
    svg_png: Optional[Callable[[List[str]], List[bytes]]] = None
    # options ECharts -> [{"svg": …} | {"error": …}] (rendu serveur) ; None = indisponible
    echarts_svg: Optional[Callable[[List[Dict[str, Any]]], List[Dict[str, str]]]] = None
    session: Optional[str] = None
    notes: Notes = field(default_factory=Notes)


# ── Arguments tolérants ─────────────────────────────────────────────────────
def canon(raw: Any, alias: Dict[str, Iterable[str]], notes: Notes, quoi: str = "") -> Dict[str, Any]:
    """Renomme les clés reconnues (pliées) vers leur nom canonique.

    Les clés inconnues sont gardées telles quelles (le moteur décidera) ; un
    renommage est signalé dans ``fixes``."""
    if not isinstance(raw, dict):
        return {}
    table = {fold(a): k for k, al in alias.items() for a in (k, *al)}
    out: Dict[str, Any] = {}
    for k, v in raw.items():
        c = table.get(fold(k))
        if c is None:
            out[k] = v
            continue
        if c in out and out[c] not in (None, "", [], {}):
            continue
        if c != k:
            notes.fix(f"{quoi}'{k}' read as '{c}'" if quoi else f"'{k}' read as '{c}'")
        out[c] = v
    return out


def choisir(valeur: Any, valeurs: Dict[str, Iterable[str]], notes: Notes, quoi: str,
            defaut: Optional[str] = None) -> Optional[str]:
    """Valeur d'énumération tolérante : « Puces », « bullet_points » → « bullets »."""
    if valeur in (None, ""):
        return defaut
    f = fold(valeur)
    for k, al in valeurs.items():
        if f == k or f in {fold(a) for a in al}:
            if k != valeur:
                notes.fix(f"{quoi} '{valeur}' read as '{k}'")
            return k
    import difflib
    proche = difflib.get_close_matches(f, list(valeurs), n=1, cutoff=0.75)
    if proche:
        notes.fix(f"{quoi} '{valeur}' read as '{proche[0]}'")
        return proche[0]
    return None


def entier(v: Any) -> Optional[int]:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str):
        m = re.fullmatch(r"\s*[#§nN°pP.:]*\s*(-?\d+)\s*", v)
        if m:
            return int(m.group(1))
    return None


def booleen(v: Any, defaut: bool = False) -> bool:
    if v is None:
        return defaut
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return fold(v) in ("true", "yes", "oui", "1", "on", "vrai", "y", "o")


def texte(v: Any) -> str:
    """Contenu texte : une liste de chaînes devient des paragraphes."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)) and all(isinstance(x, str) for x in v):
        return "\n\n".join(v)
    return str(v)


# ── Chemins ─────────────────────────────────────────────────────────────────
_INTERDITS = re.compile(r'[\x00-\x1f<>:"|?*]')


def _nettoyer(path: Any) -> str:
    """Chemin relatif à ``/work``, résolu sur le texte. Refuse un chemin absolu
    hors de ``/work`` et un ``..`` qui sort de la sandbox : l'agent le
    refuserait aussi, mais trop tard (après le rendu) et sans consigne utile."""
    brut = str(path or "").strip().strip('"\'`').replace("\\", "/")
    p = re.sub(r"^(?:file://)?/work(?:/|$)", "", brut)
    p = re.sub(r"^(?:~|\$HOME)(?:/|$)", "", p)
    if p.startswith("/"):
        raise OfficeError(f"'{brut}' is outside the sandbox: files live under /work",
                          fix="give a path relative to /work, e.g. 'rapports/bilan.docx'",
                          code="bad_path")
    if not p:
        return ""
    fin = "/" if p.endswith("/") else ""
    p = posixpath.normpath(p)
    if p == ".." or p.startswith("../"):
        raise OfficeError(f"'{brut}' goes outside the sandbox",
                          fix="give a path inside /work, without '..'", code="bad_path")
    return "" if p == "." else p + fin


def chemin_sortie(path: Any, sorte: str, notes: Notes) -> str:
    """Chemin relatif à la sandbox pour un fichier PRODUIT, extension garantie."""
    p = _nettoyer(path)
    if not p:
        raise OfficeError("path is required: where to save the file in the sandbox",
                          fix=f"path = a file name like 'rapports/bilan{EXT[sorte]}'",
                          code="missing_path")
    if p.endswith("/"):
        raise OfficeError(f"path '{path}' is a folder, not a file",
                          fix=f"add a file name: '{p}document{EXT[sorte]}'", code="bad_path")
    dossier, _, nom = p.rpartition("/")
    propre = _INTERDITS.sub("", nom).strip(" .")
    if not propre:
        raise OfficeError(f"path '{path}' has no usable file name",
                          fix=f"path = 'document{EXT[sorte]}'", code="bad_path")
    if propre != nom:
        notes.fix(f"file name cleaned: '{nom}' -> '{propre}'")
    base, point, ext = propre.rpartition(".")
    ext = f".{ext.lower()}" if point else ""
    if ext == EXT[sorte]:
        nom_final = propre
    elif ext == EXT[_AUTRE[sorte]]:
        raise OfficeError(f"'{propre}' is a {_AUTRE[sorte]} file name: this tool writes {EXT[sorte]}",
                          fix=f"use the {_AUTRE[sorte]}_* tools for {EXT[_AUTRE[sorte]]} files, "
                              f"or name the file '{base}{EXT[sorte]}'", code="wrong_format")
    elif ext in EXT_VOISINES[sorte]:
        nom_final = base + EXT[sorte]
        notes.fix(f"extension '{ext}' replaced: the file is saved as '{nom_final}'")
    else:
        nom_final = propre + EXT[sorte]
        if ext:
            notes.fix(f"'{propre}' saved as '{nom_final}'")
        else:
            notes.fix(f"extension added: '{nom_final}'")
    return f"{dossier}/{nom_final}" if dossier else nom_final


def chemin_entree(path: Any, sorte: Optional[str] = None) -> str:
    """Chemin relatif à la sandbox pour un fichier LU (aucune correction d'extension)."""
    p = _nettoyer(path)
    if not p or p.endswith("/"):
        exemple = f"rapports/bilan{EXT[sorte]}" if sorte else "rapports/bilan.docx"
        raise OfficeError("path is required: the file to open in the sandbox",
                          fix=f"path = an existing file, e.g. '{exemple}'", code="missing_path")
    return p


def lire(env: Env, rel: str, quoi: str = "file", max_bytes: Optional[int] = None) -> bytes:
    """Octets d'un fichier de la sandbox ; refus de l'espace → refus guidé."""
    max_bytes = MAX_LECTURE if max_bytes is None else max_bytes
    try:
        return env.espace.lire(rel, max_bytes)
    except IsADirectoryError:
        raise OfficeError(f"'{env.espace.afficher(rel)}' is a folder, not a {quoi}",
                          code="bad_path", fix="give the path of the file itself (list the "
                                               "folder first)")
    except ValueError as e:      # trop gros, ou refusé par l'agent (lien qui sort…)
        raise OfficeError(str(e), code="bad_path",
                          fix=f"the {quoi} must be in the sandbox and under "
                              f"{max_bytes // (1024 * 1024)} MB")


def lire_fichier(env: Env, path: Any, sorte: str, quoi: str = "file") -> Tuple[str, bytes]:
    """Lit un fichier Office de la sandbox ; ajoute l'extension si on l'a oubliée."""
    rel = chemin_entree(path, sorte)
    essais = [rel]
    if not rel.lower().endswith(EXT_LUES[sorte]) and "." not in rel.rsplit("/", 1)[-1]:
        essais.append(rel + EXT[sorte])
    for r in essais:
        try:
            data = lire(env, r, quoi)
        except FileNotFoundError:
            continue
        if r != rel:
            env.notes.fix(f"'{rel}' opened as '{r}'")
        return r, data
    raise OfficeError(f"{quoi} not found: {env.espace.afficher(rel)}", code="not_found",
                      fix="check the path (list the folder), or create the file with "
                          f"{sorte}_create")


def ecrire(env: Env, rel: str, data: bytes, attendu: Optional[str] = None) -> Dict[str, Any]:
    """Écrit un fichier produit (plafond, avertissement d'historique) → champs du retour."""
    if len(data) > MAX_ECRITURE:
        raise OfficeError(f"the file would be {len(data) // (1024 * 1024)} MB "
                          f"(limit {MAX_ECRITURE // (1024 * 1024)} MB): nothing was written",
                          code="too_large", fix="split the content into several files, or use "
                                                "fewer or smaller images")
    e = env.espace.ecrire(rel, data, attendu)
    if e.old_sha256 and not e.history_kept:
        env.notes.warn("the previous version was replaced and is too large to be kept in the "
                       "file history")
    return resultat_ecrit(e)


def resultat_ecrit(e: Ecrit) -> Dict[str, Any]:
    """Champs qui alimentent le suivi des fichiers modifiés d'Elpis (carte, éditeur)."""
    return {"path": e.path, "old_sha256": e.old_sha256, "new_sha256": e.new_sha256,
            "size": e.size}
