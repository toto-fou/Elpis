# SPDX-License-Identifier: MIT
# rag_app/extracteur/chemins.py — racines du magasin et du cache, résolution sûre d'une source, formats admis.
from __future__ import annotations

import os
import stat
from pathlib import Path

from .erreurs import ErreurExtracteur

FORMATS_CODE = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".java", ".kt", ".scala", ".swift", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".pl", ".lua", ".sh", ".bat", ".sql", ".r", ".robot",
    ".css", ".scss", ".toml", ".ini", ".cfg", ".conf", ".xml", ".json", ".jsonl", ".yaml", ".yml",
}
FORMATS = {
    ".pdf": "pdf", ".docx": "docx", ".pptx": "pptx", ".xlsx": "xlsx", ".csv": "csv", ".tsv": "csv",
    ".md": "md", ".txt": "txt", ".rst": "txt", ".log": "txt", ".html": "html", ".htm": "html",
    **{ext: "code" for ext in FORMATS_CODE},
}
CONVERTIBLES = {".docx", ".pptx", ".xlsx"}
MIMES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".md": "text/markdown", ".html": "text/html",
    ".htm": "text/html", ".json": "application/json", ".jsonl": "application/x-ndjson",
    ".yaml": "application/yaml", ".yml": "application/yaml", ".xml": "application/xml",
}
_LONGUEUR_MAX = 1024


def normaliser_ext(ext: object) -> str:
    texte = str(ext or "").strip().lower()
    return texte if texte.startswith(".") or not texte else "." + texte


def mime_de(ext: str) -> str:
    return MIMES.get(ext, "text/plain")


# Défauts = ceux du core (user_db/rag) quand le lanceur ne les donne pas (unités systemd d'une version antérieure).
DEFAUT_MAGASIN = Path(__file__).resolve().parents[2] / "user_db" / "rag"
DEFAUT_CACHE = DEFAUT_MAGASIN.with_name("rag-cache")


def _dossier_env(nom: str, defaut: Path) -> Path:
    brut = os.environ.get(nom, "").strip()
    return Path(brut).resolve() if brut else defaut.resolve()


def racine_magasin() -> Path:
    racine = _dossier_env("RAG_STORE_DIR", DEFAUT_MAGASIN)
    if not racine.is_dir():
        raise ErreurExtracteur("not_configured", "RAG_STORE_DIR n'est pas un dossier existant.", 503)
    return racine


def racine_cache() -> Path:
    cache = _dossier_env("RAG_CACHE_DIR", DEFAUT_CACHE)
    store = _dossier_env("RAG_STORE_DIR", DEFAUT_MAGASIN)
    if cache == store or store in cache.parents:
        raise ErreurExtracteur("not_configured", "RAG_CACHE_DIR ne peut pas être dans RAG_STORE_DIR.", 503)
    try:
        cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError:
        raise ErreurExtracteur("not_configured", "RAG_CACHE_DIR n'est pas accessible en écriture.", 503)
    return cache


def verifier_ext(ext: object) -> str:
    valeur = normaliser_ext(ext)
    if valeur not in FORMATS:
        raise ErreurExtracteur("unsupported", f"Extension non prise en charge : {valeur or '(vide)'}", 415)
    return valeur


def _composantes(source: object) -> list[str]:
    if not isinstance(source, str) or not source or len(source) > _LONGUEUR_MAX:
        raise ErreurExtracteur("bad_path", "Chemin source invalide.", 400)
    if "\0" in source or "\\" in source or source.startswith("/"):
        raise ErreurExtracteur("bad_path", "Le chemin doit être relatif au magasin.", 400)
    parts = source.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ErreurExtracteur("bad_path", "Chemin hors du magasin refusé.", 400)
    return parts


def resoudre_source(source: object, ext: object) -> tuple[Path, str]:
    """Chemin réel d'un fichier du magasin (sans lien symbolique, dans la racine) et son extension."""
    parts = _composantes(source)
    extension = verifier_ext(ext)
    if normaliser_ext(os.path.splitext(parts[-1])[1]) != extension:
        raise ErreurExtracteur("unsupported", "L'extension du fichier ne correspond pas à ext.", 415)
    racine = racine_magasin()
    courant = racine
    info = None
    for part in parts:
        courant = courant / part
        try:
            info = os.lstat(courant)
        except FileNotFoundError:
            raise ErreurExtracteur("not_found", "Fichier introuvable dans le magasin.", 404)
        except (OSError, ValueError):
            raise ErreurExtracteur("bad_path", "Chemin illisible.", 400)
        if stat.S_ISLNK(info.st_mode):
            raise ErreurExtracteur("bad_path", "Lien symbolique refusé.", 400)
    if info is None or not stat.S_ISREG(info.st_mode):
        raise ErreurExtracteur("bad_path", "La source n'est pas un fichier ordinaire.", 400)
    reel = courant.resolve()
    if racine not in reel.parents:
        raise ErreurExtracteur("bad_path", "Chemin hors du magasin refusé.", 400)
    return reel, extension
