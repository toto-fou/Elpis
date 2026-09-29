# SPDX-License-Identifier: MIT
"""shared_infra.sandbox.office_preview — aperçus Office / PDF de l'éditeur.

Le serveur convertit (``office_convert``, dans une prison bwrap), met en cache
HORS ``/work`` et ne sert ensuite QUE depuis ce cache : le fichier de la
sandbox n'est lu qu'une fois, par descripteur, au moment du snapshot.

Cache (``SANDBOX_DIR/.office-cache``, 0700 — le point en tête garantit
qu'aucun nom d'utilisateur ne peut désigner ce dossier) ::

    profiles/slot-<i>/               profils LibreOffice semés (un par créneau)
    u/<utilisateur>/<clé>/           manifest.json  doc.pdf  grid/s<i>/c<n>.json
    u/<utilisateur>/.tmp-<clé>-<r>/  dossier de travail, renommé à la publication

Clé = sha256(v1 | uid | chemin | dev | inode | mtime_ns | taille | version LO) :
toute modification du fichier (ou mise à jour de LibreOffice) change la clé,
donc l'URL — les réponses peuvent être ``immutable``.

Cf. docs/editor-office-preview-design-2026-09-15.md
"""
from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import stat as _stat
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from shared_infra.observability.tracing import swallow
from shared_infra.sandbox import office_convert as oc, office_xlsx as ox
from shared_infra.sandbox.filetypes import OFFICE_KINDS
from shared_infra.sandbox.office_convert import OfficeError
from shared_infra.sandbox.paths import SandboxPathError, resolve_under

logger = logging.getLogger("uvicorn.error")

__all__ = ["OfficeError", "prepare", "pdf_file", "sheet_chunk", "sheet_chunk_file",
           "prune_all", "KEY_RE"]

KEY_RE = re.compile(r"^[0-9a-f]{40}$")
MANIFEST = "manifest.json"
PDF_NAME = "doc.pdf"
CHUNK_ROWS = 200

# Plafonds de taille. Ils ne protègent plus un temps de conversion :
#  - xlsx : la grille est lue en flux (cf. office_xlsx), rien n'est converti ;
#  - docx/pptx : seules les premières pages sont converties devant
#    l'utilisateur (le reste suit en fond), et le CHARGEMENT du document coûte
#    ~1,5 s même à 60 Mo — c'est l'export par page qui pesait.
# Ils bornent donc la copie dans le cache et la mémoire de LibreOffice.
_MAX_MB_DEFAULTS = {"docx": 100, "pptx": 150, "xlsx": 100, "pdf": 200}
_LIMITS = {
    "xlsx_max_rows": 200_000,
    # Pages converties AVANT de rendre l'aperçu : le reste suit en tâche de
    # fond. Mesuré : sur un docx de 60 Mo (120 pages, photos), l'export coûte
    # ~0,17 s par page et le chargement 1,6 s — douze pages sortent en 2 s là
    # où le document entier en demande 22.
    "first_pages": 12,
    # Délai de la passe COMPLÈTE, en fond : personne n'attend devant l'écran,
    # et un gros document mérite plus que le délai d'un aperçu interactif.
    "full_timeout_s": 300,
    "max_pages": 300,
    "xlsx_max_pages": 50,
    "cache_mb": 2048,
    "cache_user_mb": 512,
    "cache_ttl_days": 14,
}
# Grille xlsx : plafonds (chacun marque la feuille « tronquée »).
# 200 000 lignes par feuille (contre 100 000 avant) : la lecture tourne à
# ~11 000 lignes/s, ce plafond borne donc à ~18 s la SEULE passe complète que
# coûte une feuille, une fois pour toutes. Réglable
# (``office_preview.xlsx_max_rows``) pour qui veut aller plus loin.
GRID_MAX_ROWS = 200_000
GRID_MAX_COLS = 512
GRID_CELL_CHARS = 1000
GRID_MAX_BYTES = 64 * 1024 * 1024
GRID_MAX_SHEETS = 64
WIDTH_SAMPLE_ROWS = 200      # largeurs de colonnes estimées sur les premières lignes
# Nom de la copie du classeur gardée dans le dossier de clé : la grille est
# bâtie À LA DEMANDE depuis CE fichier (jamais depuis /work, jamais deux fois).
XLSX_SRC = "src.xlsx"
# Morceaux bâtis d'emblée sur la première feuille visible : de quoi remplir
# l'écran tout de suite (1 000 lignes ≈ 40 ms) sans lire tout le classeur.
XLSX_PREFETCH_CHUNKS = 5

# OOXML : garde-fous d'archive.
ZIP_MAX_MEMBERS = 5000
ZIP_MAX_TOTAL = 1024 * 1024 * 1024
ZIP_MAX_RATIO = 200
ZIP_RATIO_FROM = 10 * 1024 * 1024
XML_PART_MAX = 2 * 1024 * 1024

_MAIN_TYPES = {
    "docx": ("wordprocessingml.document.main+xml", "wordprocessingml.template.main+xml"),
    "pptx": ("presentationml.presentation.main+xml", "presentationml.slideshow.main+xml",
             "presentationml.template.main+xml"),
    "xlsx": ("spreadsheetml.sheet.main+xml", "spreadsheetml.template.main+xml"),
}
_CFB_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _limit(key: str) -> int:
    try:
        return int(oc.cfg(key, _LIMITS[key]))
    except (TypeError, ValueError):
        return _LIMITS[key]


def max_bytes(kind: str) -> int:
    try:
        table = oc.cfg("max_mb", {}) or {}
        mb = float(table.get(kind, _MAX_MB_DEFAULTS[kind]))
    except (TypeError, ValueError, AttributeError):
        mb = _MAX_MB_DEFAULTS[kind]
    return int(max(1.0, mb) * 1024 * 1024)


# ─────────────────────────────────────────────────────────────────────────────
#  Racine du cache
# ─────────────────────────────────────────────────────────────────────────────
def cache_root() -> Path:
    """Racine du cache, créée en 0700 et REFUSÉE si elle n'est pas à nous ou
    si d'autres comptes y ont des droits (``user_sandboxes`` peut être 0777)."""
    raw = os.environ.get("APP_OFFICE_CACHE_DIR", "").strip() or str(oc.cfg("cache_dir", "") or "").strip()
    if raw:
        root = Path(raw)
    else:
        from shared_infra.config import SANDBOX_DIR
        root = Path(SANDBOX_DIR) / ".office-cache"
    try:
        root.mkdir(parents=True, mode=0o700, exist_ok=True)
        st = os.lstat(root)
    except OSError as exc:
        logger.warning("[office] cache %s inutilisable : %r", root, exc)
        raise OfficeError("failed", 500, "Cache d'aperçu indisponible")
    if not _stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
        raise OfficeError("failed", 500, "Cache d'aperçu non sûr")
    if st.st_mode & 0o077:
        try:
            os.chmod(root, 0o700)
        except OSError:
            raise OfficeError("failed", 500, "Cache d'aperçu non sûr")
    return root


def user_cache_dir(user_dir: str) -> Path:
    if not user_dir or "/" in user_dir or user_dir in (".", ".."):
        raise OfficeError("failed", 500, "Utilisateur invalide")
    users = cache_root() / "u"
    users.mkdir(mode=0o700, exist_ok=True)
    d = users / user_dir
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def key_dir(user_dir: str, key: str) -> Path:
    if not KEY_RE.match(key or ""):
        raise OfficeError("invalid", 400, "Clé d'aperçu invalide")
    return user_cache_dir(user_dir) / key


# ─────────────────────────────────────────────────────────────────────────────
#  Source
# ─────────────────────────────────────────────────────────────────────────────
class Source:
    __slots__ = ("fd", "rel", "host", "kind", "ext", "st")

    def __init__(self, fd: int, rel: str, host: Path, kind: str, ext: str, st: os.stat_result):
        self.fd, self.rel, self.host, self.kind, self.ext, self.st = fd, rel, host, kind, ext, st

    def close(self) -> None:
        if self.fd >= 0:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = -1


def kind_of(path: str) -> Optional[str]:
    return OFFICE_KINDS.get(PurePosixPath(str(path or "")).suffix.lower())


def open_source(root: Path, user_path: str) -> Source:
    """Ouvre le fichier de la sandbox SANS suivre de lien et prouve, sur le
    descripteur même, qu'il est un fichier régulier situé sous ``root``."""
    try:
        rp = resolve_under(root, user_path, allow_root=False)
    except SandboxPathError:
        raise OfficeError("not_found", 404, "Fichier introuvable")
    ext = rp.host.suffix.lower()
    kind = OFFICE_KINDS.get(ext)
    if not kind:
        raise OfficeError("unsupported", 415, "Format non pris en charge")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(str(rp.host), flags)
    except OSError:
        raise OfficeError("not_found", 404, "Fichier introuvable")
    try:
        st = os.fstat(fd)
        if not _stat.S_ISREG(st.st_mode):
            raise OfficeError("not_found", 404, "Fichier introuvable")
        proc_fd = f"/proc/self/fd/{fd}"
        if os.path.exists(proc_fd):
            real = Path(os.path.realpath(proc_fd))
            try:
                real.relative_to(Path(root).resolve())
            except ValueError:
                raise OfficeError("not_found", 404, "Fichier introuvable")
        if st.st_size > max_bytes(kind):
            raise OfficeError("too_large", 413,
                              f"Fichier trop lourd (max {max_bytes(kind) // (1024 * 1024)} Mo)")
    except BaseException:
        os.close(fd)
        raise
    return Source(fd, rp.rel, rp.host, kind, ext, st)


def cache_key(uid: int, rel: str, st: os.stat_result, version: str) -> str:
    raw = f"v1|{int(uid)}|{rel}|{st.st_dev}|{st.st_ino}|{st.st_mtime_ns}|{st.st_size}|{version}"
    return hashlib.sha256(raw.encode("utf-8", "surrogateescape")).hexdigest()[:40]


def snapshot_to(src: Source, dest: Path) -> None:
    """Copie le contenu DEPUIS LE DESCRIPTEUR (pas de réouverture par nom :
    un lien posé entre-temps ne peut rien substituer). Un fichier en cours
    d'écriture (taille/mtime qui bougent) est refusé."""
    copied = 0
    with open(dest, "wb") as out:
        os.lseek(src.fd, 0, os.SEEK_SET)
        while True:
            block = os.read(src.fd, 1 << 20)
            if not block:
                break
            out.write(block)
            copied += len(block)
            if copied > src.st.st_size:
                break
    try:
        now = os.fstat(src.fd)
    except OSError:
        now = None
    if (copied != src.st.st_size or now is None
            or now.st_size != src.st.st_size or now.st_mtime_ns != src.st.st_mtime_ns):
        raise OfficeError("changed", 409, "Fichier en cours de modification, réessayez")


# ─────────────────────────────────────────────────────────────────────────────
#  Contrôles de contenu
# ─────────────────────────────────────────────────────────────────────────────
def _read_member(zf: zipfile.ZipFile, name: str) -> bytes:
    try:
        info = zf.getinfo(name)
    except KeyError:
        raise OfficeError("invalid", 422, "Fichier illisible")
    if info.file_size > XML_PART_MAX:
        raise OfficeError("invalid", 422, "Fichier illisible")
    with zf.open(info) as f:
        data = f.read(XML_PART_MAX + 1)
    if len(data) > XML_PART_MAX or b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise OfficeError("invalid", 422, "Fichier illisible")
    return data


def check_ooxml(path: Path, kind: str) -> None:
    """Archive saine et de la bonne famille (un pptx renommé en .docx serait
    sinon converti — vérifié)."""
    try:
        with open(path, "rb") as f:
            head = f.read(8)
    except OSError:
        raise OfficeError("invalid", 422, "Fichier illisible")
    if head.startswith(_CFB_MAGIC):
        raise OfficeError("encrypted", 422, "Fichier protégé par mot de passe ou ancien format")
    if not head.startswith(b"PK"):
        raise OfficeError("invalid", 422, "Fichier illisible")
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise OfficeError("invalid", 422, "Fichier illisible")
    with zf:
        infos = zf.infolist()
        if len(infos) > ZIP_MAX_MEMBERS:
            raise OfficeError("invalid", 422, "Archive anormale")
        total = 0
        for info in infos:
            name = info.filename
            parts = PurePosixPath(name).parts
            if "\x00" in name or "\\" in name or name.startswith("/") or ".." in parts:
                raise OfficeError("invalid", 422, "Archive anormale")
            total += info.file_size
            if (info.file_size > ZIP_RATIO_FROM
                    and info.file_size > ZIP_MAX_RATIO * max(1, info.compress_size)):
                raise OfficeError("invalid", 422, "Archive anormale")
        if total > ZIP_MAX_TOTAL:
            raise OfficeError("invalid", 422, "Archive anormale")
        types = _read_member(zf, "[Content_Types].xml").decode("utf-8", errors="replace")
        if not any(t in types for t in _MAIN_TYPES[kind]):
            raise OfficeError("invalid", 422, "Contenu incohérent avec l'extension")


def check_pdf(path: Path) -> None:
    try:
        with open(path, "rb") as f:
            head = f.read(1024)
    except OSError:
        raise OfficeError("invalid", 422, "Fichier illisible")
    if b"%PDF-" not in head:
        raise OfficeError("invalid", 422, "Fichier illisible")


# ─────────────────────────────────────────────────────────────────────────────
#  Grille xlsx SANS conversion : squelette immédiat + morceaux à la demande
# ─────────────────────────────────────────────────────────────────────────────
def max_rows_limit() -> int:
    return max(CHUNK_ROWS, min(1_048_576, _limit("xlsx_max_rows")))


def xlsx_skeleton(path: Path) -> tuple:
    """``(grille, sources)`` d'un classeur, SANS le lire en entier.

    La taille de chaque feuille vient de son ``<dimension>`` (écrit par Excel
    comme par LibreOffice, dans les premiers octets) : la grille peut donc être
    dimensionnée à l'écran avant qu'une seule ligne n'ait été lue. Absent, on
    part de 0 ligne et la première construction dira la vérité.

    ``sources`` (partie, base de dates) reste côté serveur : c'est ce qui
    permet de bâtir un morceau plus tard sans rouvrir le classeur d'origine.
    """
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise OfficeError("invalid", 422, "Fichier illisible")
    with zf:
        metas = ox.sheets(zf)
        tronque = len(metas) > GRID_MAX_SHEETS
        metas = metas[:GRID_MAX_SHEETS]
        sheets: List[Dict[str, Any]] = []
        sources: List[Dict[str, Any]] = []
        for m in metas:
            dim = ox.dimension(zf, m["member"])
            if dim is None:
                # Pas de ``<dimension>`` : on COMPTE les lignes en balayant les
                # octets (≈ 1 s pour 200 Mo de XML) plutôt que de bâtir la
                # feuille entière, qui coûterait quinze fois plus.
                compte = ox.count_rows(zf, m["member"], max_rows=max_rows_limit())
                dim = (compte, 0) if compte else None
            rows = min(dim[0], max_rows_limit()) if dim else 0
            cols = min(dim[1], GRID_MAX_COLS) if dim else 0
            sheets.append({
                "name": m["name"], "hidden": bool(m["hidden"]),
                # Une feuille annoncée à 0 ligne ne serait JAMAIS demandée par
                # la grille : sans ``<dimension>``, on annonce un premier
                # morceau, et la vraie taille arrive avec lui.
                "rows": rows or CHUNK_ROWS, "cols": cols or 1, "chunks": 0,
                # ``complete`` : tous les morceaux de la feuille sont écrits.
                # Tant qu'il est faux, une demande de morceau absent bâtit.
                "complete": False, "truncated": False, "widths": [],
            })
            sources.append({"member": m["member"], "date1904": bool(m.get("date1904")),
                            # Taille INCONNUE (ni dimension, ni comptage) : la
                            # feuille affichée doit alors être lue en entier à
                            # la préparation, sinon la grille serait vide.
                            "no_dim": rows == 0})
    if not sheets:
        raise OfficeError("invalid", 422, "Classeur sans feuille lisible")
    return ({"chunk": CHUNK_ROWS, "sheets": sheets, "truncated": tronque}, sources)


def build_xlsx_sheet(xlsx: Path, grid_dir: Path, source: Dict[str, Any],
                     sheet_idx: int, *, max_rows: Optional[int] = None,
                     budget: int = GRID_MAX_BYTES) -> Dict[str, Any]:
    """Écrit les morceaux d'UNE feuille en la lisant en flux, et rend ses
    statistiques (lignes, colonnes, morceaux, largeurs, troncatures).

    Les lignes gardent leur NUMÉRO DE DOCUMENT : la ligne 12 d'Excel est à
    l'indice 11, une ligne vide reste vide. Le composant de grille indexe déjà
    ainsi (``chunk[r % chunkSize]``), et les numéros affichés collent enfin à
    ceux du tableur.
    """
    if max_rows is None:
        max_rows = max_rows_limit()
    sdir = grid_dir / f"s{sheet_idx}"
    sdir.mkdir(parents=True, exist_ok=True)
    try:
        zf = zipfile.ZipFile(xlsx)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise OfficeError("invalid", 422, "Fichier illisible")
    n_chunk = 0
    max_cols = 0
    last_row = 0
    truncated = False
    widths: List[int] = []
    buf: List[List[str]] = []
    reste = budget

    def flush(index: int, rows: List[List[str]], *, plein: bool = False) -> None:
        nonlocal reste
        # Un morceau intermédiaire est COMPLÉTÉ à sa taille nominale : le
        # client indexe ``morceau[ligne % taille]``, un morceau court décalerait
        # tout ce qui suit.
        if plein:
            while len(rows) < CHUNK_ROWS:
                rows.append([])
        data = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        (sdir / f"c{index}.json").write_bytes(data)
        reste -= len(data)

    with zf:
        sst = ox.shared_strings(zf)
        formats = ox.compile_formats(ox.number_formats(zf))
        sheet = {"member": source["member"], "date1904": source.get("date1904", False)}
        for r, cells, coupe in ox.iter_rows(zf, sheet, sst, formats,
                                            max_cols=GRID_MAX_COLS,
                                            cell_chars=GRID_CELL_CHARS):
            if r <= 0:
                continue
            if r > max_rows or reste <= 0:
                truncated = True
                break
            truncated = truncated or coupe
            # Poids approché de la ligne (guillemets et virgules compris) :
            # le budget se juge à l'écriture ET pendant le remplissage.
            reste -= sum(len(c) for c in cells) + 3 * len(cells) + 3
            idx = r - 1
            chunk_no = idx // CHUNK_ROWS
            # Les morceaux entièrement vides sont écrits eux aussi : sans eux,
            # un trou dans la feuille rendrait un 404 que le front lirait comme
            # « cache élagué » et qui relancerait une préparation complète.
            while n_chunk < chunk_no:
                flush(n_chunk, buf, plein=True)
                n_chunk += 1
                buf = []
            while len(buf) < idx % CHUNK_ROWS:
                buf.append([])
            buf.append(cells)
            last_row = r
            max_cols = max(max_cols, len(cells))
            if r <= WIDTH_SAMPLE_ROWS:
                for i, c in enumerate(cells):
                    w = min(40, max(6, len(c)))
                    if i >= len(widths):
                        widths.append(w)
                    elif w > widths[i]:
                        widths[i] = w
    flush(n_chunk, buf)
    n_chunk += 1
    widths += [6] * max(0, max_cols - len(widths))
    return {
        "rows": last_row, "cols": max_cols, "chunks": n_chunk,
        "complete": not truncated, "truncated": truncated,
        "widths": widths[:max_cols],
    }


# Feuilles dont la construction de fond est DÉJÀ lancée dans ce process : sans
# ce garde-fou, chaque morceau demandé pendant une lecture programmait une tâche
# de plus, et ces tâches passaient leur temps à attendre le verrou dans
# l'exécuteur borné — de quoi le saturer et faire attendre des dizaines de
# secondes une feuille qui se lit en quinze.
_EN_COURS: set = set()
_EN_COURS_LOCK = __import__("threading").Lock()


def _schedule_sheet_build(user_dir: str, key: str, sheet: int) -> None:
    """Lance la construction d'une feuille en tâche de fond (best-effort).

    Jamais sur la boucle : la lecture est du calcul pur, elle passe par le
    même exécuteur borné que les conversions. Une erreur ici ne doit RIEN
    casser — la demande de morceau saura bâtir toute seule."""
    marque = (key, int(sheet))
    with _EN_COURS_LOCK:
        if marque in _EN_COURS:
            return
        _EN_COURS.add(marque)

    async def _go() -> None:
        try:
            # ``attendre=False`` : si un autre worker tient déjà le verrou,
            # cette tâche n'a rien à faire — surtout pas occuper l'exécuteur.
            await oc.run_cpu(functools.partial(
                ensure_sheet_built, user_dir, key, sheet, attendre=False))
        except Exception:                                        # noqa: BLE001
            logger.debug("[office] construction de fond échouée (clé=%s)", key[:8],
                         exc_info=True)
        finally:
            with _EN_COURS_LOCK:
                _EN_COURS.discard(marque)

    try:
        task = asyncio.get_running_loop().create_task(_go())
    except RuntimeError:
        with _EN_COURS_LOCK:
            _EN_COURS.discard(marque)
        return
    try:
        from shared_infra.observability.events_bus import _register_bg_task
        _register_bg_task(task)
    except Exception:                                            # noqa: BLE001
        task.add_done_callback(lambda _t: None)


def want_sheet(user_dir: str, key: str, sheet: int) -> None:
    """Annonce qu'une feuille va être lue : sa construction part EN FOND.

    Appelée depuis la route (contexte asynchrone) avant de servir un morceau.
    La demande, elle, attend seulement SON morceau : les morceaux sortant dans
    l'ordre des lignes, un saut au tiers de la feuille coûte le tiers de la
    lecture, pas la feuille entière."""
    with swallow("office.want_sheet"):
        d = key_dir(user_dir, key)
        m = read_manifest(d)
        if not m or not m.get("grid") or _sheet_is_built(m, sheet):
            return
        sheets = (m.get("grid") or {}).get("sheets") or []
        if 0 <= sheet < len(sheets):
            _schedule_sheet_build(user_dir, key, sheet)


def _sheet_is_built(m: Dict[str, Any], sheet: int) -> bool:
    try:
        return bool((m.get("grid") or {}).get("sheets", [])[sheet].get("complete"))
    except (IndexError, AttributeError, TypeError):
        return False


def ensure_sheet_built(user_dir: str, key: str, sheet: int,
                       attendu: Optional[Path] = None,
                       max_rows: Optional[int] = None,
                       attendre: bool = True) -> Optional[Dict[str, Any]]:
    """Bâtit la feuille demandée si elle ne l'est pas encore, puis rend le
    manifeste à jour (``None`` si l'aperçu n'existe plus).

    UNE SEULE PASSE par feuille : la première demande qui sort des morceaux
    déjà écrits lit la feuille entière (≈ 12 000 lignes/s) et tous les
    défilements suivants sont servis depuis le cache. Verrou de fichier : deux
    workers ne bâtissent pas la même feuille en double.

    ``attendu`` : quand la construction est déjà en cours ailleurs, on rend la
    main dès que CE morceau est écrit — les morceaux sortent dans l'ordre des
    lignes, inutile d'attendre le bas d'une feuille pour afficher son milieu.
    """
    d = key_dir(user_dir, key)
    m = read_manifest(d)
    if not m or not m.get("grid"):
        return None
    sheets = (m.get("grid") or {}).get("sheets") or []
    if not (0 <= sheet < len(sheets)) or sheets[sheet].get("complete"):
        return m
    src = d / XLSX_SRC
    sources = m.get("grid_src") or []
    if not src.is_file() or not (0 <= sheet < len(sources)):
        return m
    fd = oc.try_lock(f"grid-{key}-{sheet}")
    if fd is None:
        if not attendre:
            return m                    # quelqu'un s'en charge : rien à faire
        # Un autre worker (ou la tâche de fond) bâtit déjà cette feuille : on
        # ATTEND sa fin plutôt que de rendre un 404 — le front lirait ce 404
        # comme un cache élagué et relancerait toute la préparation.
        limite = time.monotonic() + float(oc._int_cfg("timeout_s", 5, 600))
        while time.monotonic() < limite:
            time.sleep(0.1)
            if attendu is not None and attendu.is_file():
                return read_manifest(d) or m
            m = read_manifest(d) or m
            if _sheet_is_built(m, sheet):
                return m
            fd = oc.try_lock(f"grid-{key}-{sheet}")
            if fd is not None:
                break
        if fd is None:
            return m
    try:
        m = read_manifest(d) or m
        sheets = (m.get("grid") or {}).get("sheets") or []
        if 0 <= sheet < len(sheets) and sheets[sheet].get("complete"):
            return m
        t0 = time.monotonic()
        stats = build_xlsx_sheet(src, d / "grid", sources[sheet], sheet, max_rows=max_rows)
        partielle = max_rows is not None and stats["rows"] >= max_rows
        logger.info("[office] feuille %d : %d lignes en %.2f s (%s) clé=%s",
                    sheet, stats["rows"], time.monotonic() - t0,
                    "tête" if partielle else "complète", key[:8])
        connues = sheets[sheet].get("rows") or 0
        sheets[sheet].update(stats)
        if partielle:
            # Tête seulement : la feuille n'est pas « complète », et la taille
            # annoncée (dimension ou comptage) reste la bonne.
            sheets[sheet]["complete"] = False
            sheets[sheet]["truncated"] = False
            sheets[sheet]["rows"] = max(connues, stats["rows"])
        else:
            # Le ``<dimension>`` peut mentir (plage plus large que les lignes
            # réellement présentes) : la lecture fait foi.
            sheets[sheet]["rows"] = max(stats["rows"], 0)
        write_manifest(d, m)
        return m
    finally:
        oc.release_lock(fd)


# ─────────────────────────────────────────────────────────────────────────────
#  Manifeste / publication / lecture
# ─────────────────────────────────────────────────────────────────────────────
def read_manifest(d: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(d / MANIFEST, "rb") as f:
            data = json.loads(f.read(1024 * 1024))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("v") == 1 else None


def write_manifest(d: Path, manifest: Dict[str, Any]) -> None:
    tmp = d / f".{MANIFEST}.{secrets.token_hex(4)}"
    tmp.write_text(json.dumps(manifest, ensure_ascii=False))
    os.replace(tmp, d / MANIFEST)


def _touch(d: Path) -> None:
    """Estampille d'usage pour l'éviction LRU (au plus une fois par heure)."""
    try:
        p = d / MANIFEST
        if time.time() - p.stat().st_mtime > 3600:
            os.utime(p, None)
    except OSError:
        pass


def _payload(m: Dict[str, Any], view: str) -> Dict[str, Any]:
    key = m["key"]
    name = PurePosixPath(m["rel"]).stem or "document"
    pages = None
    if m.get("pages"):
        # La RÉVISION est dans l'URL : quand la passe complète remplace le PDF
        # de tête, l'adresse change et le navigateur recharge — sans elle, le
        # cache « immuable » servirait les premières pages à vie.
        rev = int(m["pages"].get("rev", 0) or 0)
        url = f"/api/sandbox/office/pdf/{key}/{quote(name + '.pdf')}"
        pages = {
            "url": url + (f"?r={rev}" if rev else ""),
            "count": m["pages"].get("count"),
            "truncated": bool(m["pages"].get("truncated")),
            # ``partial`` : seules les premières pages sont converties, la
            # suite arrive (le front repasse chercher le manifeste).
            "partial": bool(m["pages"].get("partial")),
        }
    return {
        "kind": m["kind"], "key": key, "rel": m["rel"], "size": m["size"],
        "mtime": m["mtime"], "view": view,
        "pages": pages if view == "pages" else None,
        "grid": m.get("grid") if view == "grid" else None,
        "has": {"pages": bool(m.get("pages")), "grid": bool(m.get("grid"))},
    }


def pdf_file(user_dir: str, key: str) -> Optional[Path]:
    d = key_dir(user_dir, key)
    m = read_manifest(d)
    if not m or not m.get("pages"):
        return None
    p = d / PDF_NAME
    return p if p.is_file() else None


def sheet_chunk(user_dir: str, key: str, sheet: int, chunk: int) -> tuple:
    """``(fichier du morceau, taille de la feuille)`` — la taille sert à
    corriger le manifeste côté client (cf. en-têtes ``X-Office-*``)."""
    p = sheet_chunk_file(user_dir, key, sheet, chunk)
    taille = None
    if p is not None:
        m = read_manifest(key_dir(user_dir, key)) or {}
        sheets = (m.get("grid") or {}).get("sheets") or []
        if 0 <= sheet < len(sheets):
            sh = sheets[sheet]
            taille = {"rows": sh.get("rows", 0), "cols": sh.get("cols", 0),
                      "complete": bool(sh.get("complete"))}
    return p, taille


def sheet_chunk_file(user_dir: str, key: str, sheet: int, chunk: int) -> Optional[Path]:
    """Fichier d'un morceau de grille, BÂTI À LA DEMANDE s'il manque.

    L'aperçu ne contient d'emblée que le haut de la première feuille : tout le
    reste est écrit ici, à la première demande qui en sort (une passe par
    feuille). C'est ce qui permet d'ouvrir un classeur de 50 Mo tout de suite
    au lieu d'attendre la conversion du classeur entier."""
    if not (0 <= sheet < GRID_MAX_SHEETS) or not (0 <= chunk <= GRID_MAX_ROWS // CHUNK_ROWS):
        return None
    d = key_dir(user_dir, key)
    m = read_manifest(d)
    if not m or not m.get("grid"):
        return None
    p = d / "grid" / f"s{sheet}" / f"c{chunk}.json"
    if p.is_file():
        _touch(d)
        return p
    if _sheet_is_built(m, sheet):
        return None                     # feuille complète : ce morceau n'existe pas
    # Feuille encore vierge et morceau du HAUT : on écrit juste sa tête (~100 ms)
    # au lieu d'attendre sa lecture entière — exactement ce que fait l'ouverture.
    sheets = (m.get("grid") or {}).get("sheets") or []
    vierge = 0 <= sheet < len(sheets) and not sheets[sheet].get("chunks")
    if vierge and chunk < XLSX_PREFETCH_CHUNKS:
        if ensure_sheet_built(user_dir, key, sheet, attendu=p,
                              max_rows=XLSX_PREFETCH_CHUNKS * CHUNK_ROWS) is None:
            return None
        if p.is_file():
            _touch(d)
            return p
    if ensure_sheet_built(user_dir, key, sheet, attendu=p) is None:
        return None
    _touch(d)
    return p if p.is_file() else None


# ─────────────────────────────────────────────────────────────────────────────
#  Orchestration
# ─────────────────────────────────────────────────────────────────────────────
def _normalize_view(kind: str, view: Optional[str]) -> str:
    if kind == "xlsx":
        return "pages" if view == "pages" else "grid"
    return "pages"


def _fast_path(uid: int, user_dir: str, root: Path, path: str, view: Optional[str]):
    src = open_source(root, path)
    try:
        version = "pdf" if src.kind == "pdf" else oc.lo_version_token(oc.soffice_bin())
        key = cache_key(uid, src.rel, src.st, version)
        v = _normalize_view(src.kind, view)
        d = user_cache_dir(user_dir) / key
        m = read_manifest(d)
        if m and m.get(v):
            _touch(d)
            src.close()
            return None, _payload(m, v)
        return (src, key, v, d), None
    except BaseException:
        src.close()
        raise


async def prepare(*, uid: int, user_dir: str, root: Path, path: str,
                  view: Optional[str] = None) -> Dict[str, Any]:
    """Rend le manifeste de l'aperçu demandé, en convertissant au besoin."""
    state, ready = await oc.run_cpu(_fast_path, uid, user_dir, root, path, view)
    if ready is not None:
        return ready
    src, key, v, d = state
    wait_s = float(oc._int_cfg("wait_s", 1, 120))
    deadline = time.monotonic() + wait_s
    key_fd = None
    try:
        # Même fichier déjà en conversion ailleurs : on attend SA fin (délai de
        # conversion compris) plutôt que de répondre « occupé » à tort.
        key_deadline = deadline + float(oc._int_cfg("timeout_s", 5, 600))
        key_fd, _ = await oc.acquire_first([f"key-{key}"], key_deadline)
        m = read_manifest(d)
        if m and m.get(v):
            return _payload(m, v)
        return await _build(uid, user_dir, src, key, v, d, m, time.monotonic() + wait_s)
    finally:
        src.close()
        oc.release_lock(key_fd)


def _new_job_dir(user_dir: str, key: str) -> Path:
    job = user_cache_dir(user_dir) / f".tmp-{key}-{secrets.token_hex(4)}"
    (job / "out").mkdir(parents=True, mode=0o700)
    return job


def _base_manifest(src: Source, key: str, previous: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if previous:
        return dict(previous)
    return {"v": 1, "key": key, "rel": src.rel, "kind": src.kind, "size": src.st.st_size,
            "mtime": src.st.st_mtime, "created": time.time()}


def _publish(job: Path, d: Path, manifest: Dict[str, Any], artifacts: List[str]) -> None:
    """Déplace les artefacts du dossier de travail dans le dossier de clé puis
    remplace le manifeste (dernier geste : un lecteur ne voit jamais un
    manifeste qui annonce un fichier absent)."""
    d.mkdir(mode=0o700, exist_ok=True)
    for name in artifacts:
        src_p, dst_p = job / name, d / name
        if dst_p.is_dir():
            shutil.rmtree(dst_p, ignore_errors=True)
        os.replace(src_p, dst_p)
    write_manifest(d, manifest)


async def _build(uid: int, user_dir: str, src: Source, key: str, v: str, d: Path,
                 previous: Optional[Dict[str, Any]], deadline: float) -> Dict[str, Any]:
    job = await oc.run_cpu(_new_job_dir, user_dir, key)
    try:
        in_name = f"in{src.ext}"
        await oc.run_cpu(snapshot_to, src, job / in_name)
        manifest = _base_manifest(src, key, previous)

        if src.kind == "pdf":
            await oc.run_cpu(check_pdf, job / in_name)
            os.replace(job / in_name, job / PDF_NAME)
            manifest["pages"] = {"count": None, "truncated": False}
            await oc.run_cpu(_publish, job, d, manifest, [PDF_NAME])
            return _payload(manifest, v)

        # GRILLE XLSX : lecture EN FLUX, aucune conversion (2026-09-18).
        # Avant, tout le classeur passait par LibreOffice avant le premier
        # pixel : 25 s pour 26 Mo, ~50 s pour 50 Mo — au-delà du délai, et pour
        # afficher quarante lignes. On publie maintenant le squelette (taille
        # des feuilles lue dans leur ``<dimension>``) plus le haut de la
        # première feuille visible ; le reste est bâti à la demande.
        if src.kind == "xlsx" and v == "grid":
            await oc.run_cpu(check_ooxml, job / in_name, src.kind)
            grid, sources = await oc.run_cpu(xlsx_skeleton, job / in_name)
            (job / "grid").mkdir()
            premiere = next((i for i, sh in enumerate(grid["sheets"]) if not sh["hidden"]), 0)
            # Classeur sans ``<dimension>`` : la taille n'existe nulle part
            # ailleurs que dans les lignes elles-mêmes — on lit la première
            # feuille en entier (une passe), sinon la grille s'afficherait
            # tronquée sans le dire. Avec dimension (cas courant) : juste la
            # tête, le reste à la demande.
            tete = None if sources[premiere].get("no_dim") else XLSX_PREFETCH_CHUNKS * CHUNK_ROWS
            stats = await oc.run_cpu(functools.partial(
                build_xlsx_sheet, job / in_name, job / "grid", sources[premiere], premiere,
                max_rows=tete))
            # Tête de feuille seulement : elle n'est « complète » que si la
            # lecture s'est arrêtée d'elle-même avant le plafond de pré-chargement.
            partielle = tete is not None and stats["rows"] >= tete
            grid["sheets"][premiere].update({
                "cols": max(stats["cols"], grid["sheets"][premiere]["cols"]),
                "chunks": stats["chunks"],
                "widths": stats["widths"],
                "complete": not partielle and not stats["truncated"],
                "truncated": stats["truncated"] and not partielle,
            })
            if not partielle:
                grid["sheets"][premiere]["rows"] = stats["rows"]
            elif stats["rows"] > grid["sheets"][premiere]["rows"]:
                grid["sheets"][premiere]["rows"] = stats["rows"]
            manifest["grid"] = grid
            manifest["grid_src"] = sources
            os.replace(job / in_name, job / XLSX_SRC)
            await oc.run_cpu(_publish, job, d, manifest, [XLSX_SRC, "grid"])
            _maybe_prune_user(user_dir)
            # La suite de la feuille affichée se bâtit EN FOND : l'utilisateur
            # voit ses données tout de suite, et le premier défilement profond
            # ne paie plus la lecture (elle est déjà finie ou en cours, et la
            # demande attend alors le verrou au lieu de relire).
            if not grid["sheets"][premiere]["complete"]:
                _schedule_sheet_build(user_dir, key, premiere)
            return _payload(manifest, v)

        soffice = oc.soffice_bin()
        if not soffice:
            raise OfficeError("soffice_missing", 503, "LibreOffice absent du serveur")
        isolation = await oc.run_cpu(oc.isolation_mode)    # la sonde lance un processus
        await oc.run_cpu(check_ooxml, job / in_name, src.kind)

        plafond = _limit("xlsx_max_pages" if src.kind == "xlsx" else "max_pages")
        # PREMIÈRES PAGES D'ABORD (2026-09-18) : l'export est ce qui coûte
        # (~0,17 s la page), pas le chargement (~1,5 s). On rend donc l'aperçu
        # dès que le début du document est prêt, et la version complète se
        # fabrique en fond. Un document court sort entier du premier coup : sa
        # conversion s'arrête d'elle-même sous le plafond de tête.
        tete = max(1, min(plafond, _limit("first_pages")))
        pages_demandees = tete if src.kind in ("docx", "pptx") else plafond
        out_pdf = await _convert_to_pdf(
            uid=uid, job=job, kind=src.kind, in_name=in_name, isolation=isolation,
            soffice=soffice, pages=pages_demandees, deadline=deadline,
            timeout_s=oc._int_cfg("timeout_s", 5, 600), etiquette=v)
        await oc.run_cpu(check_pdf, out_pdf)
        cap = oc._int_cfg("max_pdf_mb", 1, 4096) * 1024 * 1024
        if out_pdf.stat().st_size > cap:
            raise OfficeError("too_large", 413, "Aperçu trop lourd")
        count = await oc.run_cpu(oc.count_pdf_pages, out_pdf)
        os.replace(out_pdf, job / PDF_NAME)
        # « partiel » : la conversion s'est arrêtée SUR le plafond de tête, il
        # y a donc (au moins peut-être) des pages au-delà.
        partiel = pages_demandees < plafond and count >= pages_demandees
        manifest["pages"] = {"count": count, "truncated": count >= plafond,
                             "partial": partiel, "rev": 0}
        artefacts = [PDF_NAME]
        if partiel:
            # Le document source est gardé LE TEMPS de la passe complète : la
            # relire depuis le bac ne serait pas la même (il a pu changer).
            os.replace(job / in_name, job / f"src{src.ext}")
            artefacts.append(f"src{src.ext}")
        await oc.run_cpu(_publish, job, d, manifest, artefacts)
        _maybe_prune_user(user_dir)
        if partiel:
            _schedule_full_pdf(uid, user_dir, key, src.kind, src.ext)
        return _payload(manifest, v)
    finally:
        shutil.rmtree(job, ignore_errors=True)


async def _convert_to_pdf(*, uid: int, job: Path, kind: str, in_name: str,
                          isolation: str, soffice: str, pages: int, deadline: float,
                          timeout_s: int, etiquette: str) -> Path:
    """Lance LibreOffice sur ``job/in_name`` et rend le PDF produit.

    Extraite pour servir DEUX fois : la passe de tête (les premières pages,
    devant l'utilisateur) et la passe complète (en tâche de fond)."""
    slots = oc._int_cfg("slots", 1, 16)
    per_user = oc._int_cfg("slots_per_user", 1, 16)
    user_fd = slot_fd = None
    try:
        user_fd, _ = await oc.acquire_first(
            [f"user-u{int(uid)}-{j}" for j in range(per_user)], deadline)
        slot_fd, slot_name = await oc.acquire_first(
            [f"slot-{i}" for i in range(slots)], deadline)
        profile = cache_root() / "profiles" / slot_name
        await oc.run_cpu(oc.ensure_profile, profile)
        opts = {
            "PageRange": {"type": "string", "value": f"1-{max(1, pages)}"},
            "ReduceImageResolution": {"type": "boolean", "value": "true"},
            "MaxImageResolution": {"type": "long", "value": "150"},
        }
        convert_to = f"pdf:{oc.PDF_EXPORT_FILTERS[kind]}:{json.dumps(opts, separators=(',', ':'))}"
        argv = oc.build_argv(isolation=isolation, soffice=soffice, profile_dir=profile,
                             job_dir=job, kind=kind, in_name=in_name,
                             convert_to=convert_to, timeout_s=timeout_s)
        env = oc.child_env(isolation, profile, job)
        t0 = time.monotonic()
        rc = await oc.run_soffice(argv, env, cwd=job, log_path=job / "lo.log",
                                  timeout_s=timeout_s)
        logger.info("[office] %s → %s (1-%d) en %.2f s (rc=%s, %s)", kind, etiquette,
                    pages, time.monotonic() - t0, rc, isolation)
    finally:
        oc.release_lock(slot_fd)
        oc.release_lock(user_fd)
    out_pdf = job / "out" / "in.pdf"
    if not out_pdf.is_file():
        raise _conversion_failed(job)
    return out_pdf


def _schedule_full_pdf(uid: int, user_dir: str, key: str, kind: str, ext: str) -> None:
    """Convertit le document ENTIER en tâche de fond, après l'aperçu de tête.

    Rien ne bloque l'utilisateur : il lit déjà les premières pages. Quand la
    version complète est prête, le manifeste change de révision et le front
    recharge le PDF (l'URL porte la révision, donc le cache immuable ne gêne
    pas). Une seule passe par document (``_EN_COURS``)."""
    marque = (key, -1)
    with _EN_COURS_LOCK:
        if marque in _EN_COURS:
            return
        _EN_COURS.add(marque)

    async def _go() -> None:
        try:
            await _build_full_pdf(uid, user_dir, key, kind, ext)
        except OfficeError as exc:
            logger.info("[office] passe complète abandonnée (%s) clé=%s", exc.code, key[:8])
        except Exception:                                        # noqa: BLE001
            logger.warning("[office] passe complète échouée clé=%s", key[:8], exc_info=True)
        finally:
            with _EN_COURS_LOCK:
                _EN_COURS.discard(marque)

    try:
        task = asyncio.get_running_loop().create_task(_go())
    except RuntimeError:
        with _EN_COURS_LOCK:
            _EN_COURS.discard(marque)
        return
    try:
        from shared_infra.observability.events_bus import _register_bg_task
        _register_bg_task(task)
    except Exception:                                            # noqa: BLE001
        task.add_done_callback(lambda _t: None)


async def _build_full_pdf(uid: int, user_dir: str, key: str, kind: str, ext: str) -> None:
    """Passe complète : convertit tout le document et remplace l'aperçu."""
    d = key_dir(user_dir, key)
    m = read_manifest(d)
    if not m or not (m.get("pages") or {}).get("partial"):
        return
    source = d / f"src{ext}"
    if not source.is_file():
        return
    soffice = oc.soffice_bin()
    if not soffice:
        return
    fd = oc.try_lock(f"full-{key}")
    if fd is None:
        return                          # un autre worker s'en charge
    # ⚠ Le dossier de travail se crée DANS le try : entre la prise du verrou et
    # son ``finally``, une annulation (arrêt du worker, onglet fermé) laissait
    # le verrou ouvert pour la vie du process — plus aucune passe complète
    # n'était possible pour ce document.
    job = None
    try:
        job = await oc.run_cpu(_new_job_dir, user_dir, key)
        isolation = await oc.run_cpu(oc.isolation_mode)
        in_name = f"in{ext}"
        await oc.run_cpu(shutil.copyfile, str(source), str(job / in_name))
        plafond = _limit("xlsx_max_pages" if kind == "xlsx" else "max_pages")
        timeout_s = _limit("full_timeout_s")
        out_pdf = await _convert_to_pdf(
            uid=uid, job=job, kind=kind, in_name=in_name, isolation=isolation,
            soffice=soffice, pages=plafond,
            deadline=time.monotonic() + timeout_s, timeout_s=timeout_s,
            etiquette="pages (complet)")
        await oc.run_cpu(check_pdf, out_pdf)
        cap = oc._int_cfg("max_pdf_mb", 1, 4096) * 1024 * 1024
        if out_pdf.stat().st_size > cap:
            logger.info("[office] passe complète : PDF trop lourd, on garde la tête")
            return
        count = await oc.run_cpu(oc.count_pdf_pages, out_pdf)
        os.replace(out_pdf, job / PDF_NAME)
        m = read_manifest(d) or m
        rev = int((m.get("pages") or {}).get("rev", 0)) + 1
        m["pages"] = {"count": count, "truncated": count >= plafond,
                      "partial": False, "rev": rev}
        await oc.run_cpu(_publish, job, d, m, [PDF_NAME])
        # La copie du document n'a plus lieu d'être : elle ne servait qu'à ça.
        with swallow("office.drop_src"):
            source.unlink(missing_ok=True)
        _maybe_prune_user(user_dir)
    finally:
        if job is not None:
            shutil.rmtree(job, ignore_errors=True)
        oc.release_lock(fd)


def _conversion_failed(job: Path) -> OfficeError:
    tail = oc.read_log_tail(job / "lo.log")
    if tail:
        logger.warning("[office] conversion échouée : %s", tail)
    return OfficeError("failed", 500, "Conversion échouée")


# ─────────────────────────────────────────────────────────────────────────────
#  Élagage
# ─────────────────────────────────────────────────────────────────────────────
_last_prune: Dict[str, float] = {}
_PRUNE_EVERY_S = 300.0


def _maybe_prune_user(user_dir: str) -> None:
    now = time.monotonic()
    if now - _last_prune.get(user_dir, 0.0) < _PRUNE_EVERY_S:
        return
    _last_prune[user_dir] = now
    try:
        prune_user(user_cache_dir(user_dir), _limit("cache_user_mb") * 1024 * 1024,
                   _limit("cache_ttl_days") * 86400.0)
    except Exception:
        logger.debug("[office] élagage utilisateur échoué", exc_info=True)


def _dir_size(d: Path) -> int:
    total = 0
    for base, _dirs, files in os.walk(d):
        for name in files:
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                pass
    return total


def _entries(user_dir: Path) -> List[tuple]:
    """(mtime d'usage, taille, chemin, clé) des dossiers de clé d'un utilisateur."""
    out = []
    try:
        children = list(user_dir.iterdir())
    except OSError:
        return out
    for p in children:
        if not KEY_RE.match(p.name):
            continue
        try:
            used = (p / MANIFEST).stat().st_mtime
        except OSError:
            try:
                used = p.stat().st_mtime
            except OSError:
                continue
        out.append((used, _dir_size(p), p, p.name))
    return out


def _remove_key_dir(p: Path, key: str) -> bool:
    fd = oc.try_lock(f"key-{key}")
    if fd is None:
        return False                     # conversion en cours sur cette clé
    try:
        shutil.rmtree(p, ignore_errors=True)
        return True
    finally:
        oc.release_lock(fd)


def _prune_tmp(user_dir: Path, now: float) -> int:
    removed = 0
    try:
        children = list(user_dir.iterdir())
    except OSError:
        return 0
    for p in children:
        if p.name.startswith(".tmp-"):
            try:
                if now - p.stat().st_mtime > 3600:
                    shutil.rmtree(p, ignore_errors=True)
                    removed += 1
            except OSError:
                pass
    return removed


def prune_user(user_dir: Path, cap_bytes: int, ttl_s: float, now: Optional[float] = None) -> int:
    now = time.time() if now is None else now
    removed = _prune_tmp(user_dir, now)
    entries = sorted(_entries(user_dir))
    total = sum(e[1] for e in entries)
    for used, size, p, key in entries:
        if now - used > ttl_s or total > cap_bytes:
            if _remove_key_dir(p, key):
                total -= size
                removed += 1
    return removed


def prune_all() -> Dict[str, int]:
    """Balayage de maintenance : TTL + plafond par utilisateur, puis plafond global."""
    try:
        root = cache_root()
    except OfficeError:
        return {"removed": 0}
    users = root / "u"
    removed = 0
    now = time.time()
    ttl = _limit("cache_ttl_days") * 86400.0
    user_cap = _limit("cache_user_mb") * 1024 * 1024
    try:
        user_dirs = [p for p in users.iterdir() if p.is_dir()]
    except OSError:
        user_dirs = []
    for ud in user_dirs:
        removed += prune_user(ud, user_cap, ttl, now)
    everything = sorted(e for ud in user_dirs for e in _entries(ud))
    total = sum(e[1] for e in everything)
    cap = _limit("cache_mb") * 1024 * 1024
    for _used, size, p, key in everything:
        if total <= cap:
            break
        if _remove_key_dir(p, key):
            total -= size
            removed += 1
    locks = oc.prune_lock_files()
    return {"removed": removed, "locks": locks}
