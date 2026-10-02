# SPDX-License-Identifier: MIT
# tools/fs_tools.py
"""
Filesystem tools for MCP sandbox.

Registered tools (6)
----------------
  read_file, write_file, edit_file, list_files, manage_files, code
  (stat d'un chemin : list_files/read_file ; outline et navigation :
  ``code``)

Signature: register(mcp, root_base, max_write_chars=2_000_000)
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Literal, Optional, Tuple, Union

from fastmcp import Context, FastMCP

# /work normalization (lexical; links are resolved by the sandbox agent).
# SandboxPathError is a ValueError subclass: `except ValueError` catches it.
from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.paths import (
    SandboxPathError,
    lexical_rel,
    rel_under,
    to_container,
)

from ._espace import Espace
from ._models import (
    CodeNavigateResult,
    CodeOutlineResult,
    EditFileResult,
    ErrEnvelope,
    ListFilesResult,
    ManageFilesResult,
    ReadFileResult,
    WriteFileResult,
)
from ._toolkit import (
    as_list,
    err,
    get_username,
    glob_match as _glob_match,
    ok as _ok,
    tool_kw,
    tool_kw_destructive,
    tool_kw_idempotent,
    tool_kw_mutating,
    tool_kw_readonly,
    unquote,
)

# ── Optional: code intelligence (multi-language outliner) ────────────────────
# Imported lazily-friendly: if code_intel.py is missing, the ``code`` tool
# degrades to a stub but the rest of fs_tools keeps working.
#
# code_intel.py lives in tools/FileSystemLib/, NOT next to this file — and
# the MCP server runs as `python <root>/local_mcp_server.py` with `tools`
# as the top-level package. Never a bare `from . import code_intel`: it
# looks for tools/code_intel.py and always fails (→ _HAS_CI=False, ``code``
# reports the module missing). Import it from its real subpackage.
try:
    from .FileSystemLib import code_intel as _ci
    _HAS_CI = True
except ImportError:
    try:
        from FileSystemLib import code_intel as _ci  # type: ignore
        _HAS_CI = True
    except ImportError:
        _ci = None  # type: ignore
        _HAS_CI = False

# ── Limits ───────────────────────────────────────────────────────────────────
MAX_WRITE_CHARS   = 2_000_000
MAX_READ_CHARS    = 2_000_000
MAX_FILE_TEXT     = 10_000_000
MAX_FILE_BIN      = 10_000_000
MAX_EDIT_BYTES    = 5_000_000
MAX_LIST          = 4000
MAX_GREP          = 2000
# Borne DURE du walk récursif (entrées VISITÉES, pas seulement renvoyées) :
# ``MAX_LIST`` ne borne que la page renvoyée — sans cette borne, le parcours
# d'un arbre énorme (node_modules, .venv…) matérialiserait TOUT l'arbre dans
# le worker hôte partagé avant de capper (RAM/CPU non bornés). On arrête
# le walk au-delà de ce plafond et on signale ``truncated`` + un hint.
MAX_WALK          = 50_000
# Taille maximale d'un fichier parcouru par list_files(search_text=…), lu
# ligne à ligne. Au-delà, le fichier est écarté, compté et signalé : un
# plafond bas sauterait en silence de gros fichiers source.
_SEARCH_MAX_BYTES = 20 * 1024 * 1024
MAX_MULTI_EDITS   = 50
MAX_BATCH_PATHS   = 20
PREVIEW_HEAD_LINES = 50
PREVIEW_TAIL_LINES = 20
MINIFIED_LINE_MIN  = 5_000
BIN_PREVIEW_BYTES  = 512


# ── Category descriptor ───────────────────────────────────────────────
# Contract shared by every tool module (the siblings point here). The
# dict travels IN the protocol: ``tool_kw(CATEGORY)`` puts it in the
# ``tags`` + ``meta`` of each tool, and ``llm_core._mcp_categories``
# builds the category registry from the live ``list_tools()`` when the
# pool connects (admin & user UI). A tool's category is an exact-name
# lookup in that registry (``categorize``), on which
# ``llm_core.engine.tool_catalog._collect_mcp_tools`` filters.
CATEGORY = {
    "name":  "fs",
    "label": "Fichiers",
    "icon":  "ph-folder",
    "color": "orange",
    # No "tools" list — le pool ingère le registre (tags + meta de chaque
    # outil) à la connexion.
}

# Category carried IN the protocol (tags + meta), built by the shared
# toolkit — one place to change if a FastMCP version ever rejects meta=.
_TOOL_KW = tool_kw(CATEGORY)

# Per-behaviour keysets for tool annotations.
# Each @mcp.tool picks the keyset that matches what it does:
#   _TOOL_KW_RO         : read-only (browseable, auto-confirmable by clients)
#   _TOOL_KW_IDEMP      : mutating but idempotent (same args → same result)
#   _TOOL_KW_MUT        : mutating, non-idempotent
#   _TOOL_KW_DESTRUCT   : destructive (delete, batch_delete) — UI gates this
_TOOL_KW_RO       = tool_kw_readonly(CATEGORY)
_TOOL_KW_IDEMP    = tool_kw_idempotent(CATEGORY, serial=True, prune="diff")
_TOOL_KW_MUT      = tool_kw_mutating(CATEGORY)
_TOOL_KW_DESTRUCT = tool_kw_destructive(CATEGORY, serial=True)


# ── Helpers ──────────────────────────────────────────────────────────────────

# Harmonized error envelope (tools/_toolkit.py): `error` becomes a stable
# machine code, the human text moves to `message`, the hint to `fix`.
# Backward compatible — {ok:false, error:<str>} is still the top shape.
# _ok is tools/_toolkit.ok (imported above), shared across the suite.
def _err(msg: str, hint: str = "", **kw) -> Dict[str, Any]:
    code = re.sub(r"[^a-z0-9]+", "_", str(msg).lower()).strip("_")[:40] or "fs_error"
    return err(code, str(msg), fix=hint or None, **kw)

def _edit_err(e, *, prefix: str = "", hint: str = "", **kw) -> Dict[str, Any]:
    """Map an ``_apply_one_edit`` ValueError to the STABLE machine code the
    tool's docstring documents (``old_str_not_found`` / ``old_str_ambiguous``),
    falling back to the slugified message otherwise. A plain ``_err(str(e))``
    would make the code a truncated slug of the prose (e.g.
    ``str_replace_old_str_not_found_check_whitesp``), which a model branching
    on the documented ``error`` codes never matches."""
    ml = str(e).lower()
    msg = f"{prefix}{e}"
    if "not found" in ml or "matched 0 times" in ml:
        return err("old_str_not_found", msg,
                   fix=hint or "Relis le fichier — ton contexte est périmé (old_str/pattern absent).", **kw)
    if "ambiguous" in ml or "occurrences, found" in ml:
        return err("old_str_ambiguous", msg,
                   fix=hint or "Élargis old_str, ou utilise str_replace_ctx avec before_context=/after_context=.", **kw)
    return _err(msg, hint=hint, **kw)

def _trunc(s: str, n: int) -> Tuple[str, bool]:
    """Char-bounded truncation with an honest marker (how much was cut)."""
    if not s or len(s) <= n:
        return (s or ""), False
    return s[:n] + f"\n...[tronqué : {len(s) - n} caractères omis sur {len(s)}]", True

def _validate_path_str(path: str):
    if not path:
        raise ValueError("path required")
    if "\x00" in path:
        raise ValueError("null byte in path")
    for c in path:
        if ord(c) < 32 and c != "\t":
            raise ValueError("control character in path")


def _to_container(p: Any, base: Path) -> str:
    """Render a host path under ``base`` as its container view (``/work/...``),
    without reading the disk (links stay as written).

    The agent reasons in the container's path space (its shell runs in
    ``/work``): echoing host paths like ``/srv/elpis/user_sandboxes/alice/src/x.py``
    would give the model a form it can't reuse. ``/work/src/x.py`` can be copied
    verbatim into the next call (``_rel`` maps it back).

    Falls back to the plain string for anything not under ``base`` (defensive
    — every fs path is validated under the sandbox first, so this is rare).
    """
    try:
        rel = rel_under(base, p)
    except (SandboxPathError, TypeError):
        return str(p)
    return to_container(rel)  # shared: "" / "." -> "/work"; else "/work/<rel>"


def _rel(base: Path, path: str, *, allow_root: bool = True) -> str:
    """Chemin relatif à la sandbox d'un chemin fourni par le modèle, sans lire
    le disque : guillemets tolérés (``unquote``), caractères de contrôle, NUL
    et chemin vide refusés ; les liens sont résolus par l'agent."""
    path = unquote(path)
    _validate_path_str(path)
    return lexical_rel(base, path, allow_root=allow_root)


# Dossiers de DÉPENDANCES/BUILD écartés par défaut par ``list_files`` quand
# l'appelant ne fournit aucun ``exclude``.
#
# Mesuré en direct : un sous-agent ``explore`` appelant ``list_files`` avec
# ``include_hidden=True`` et sans ``exclude`` a ramené 500 chemins de
# ``.venv/lib/python3.11/site-packages/…`` — +9 000 tokens de contexte en UN
# appel, re-facturés à chaque itération suivante. Le socle ci-dessous coupe ce
# cas sans jamais masquer du code applicatif.
#
# ``.git`` n'y figure PAS (dossier légitimement inspecté, et déjà couvert par
# le défaut ``include_hidden=False``).
DEFAULT_DEP_EXCLUDES: tuple = (
    "node_modules", "site-packages", "dist-info", "__pycache__",
    ".venv", "venv", ".tox", ".nox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".gradle", "vendor", "target",
)


_TEXT_BYTES = frozenset(range(32, 127)) | {7, 8, 9, 10, 11, 12, 13, 27}


def _is_text_bytes(chunk: bytes) -> bool:
    """Début de fichier plausible pour du texte (pas de NUL, < 30 % d'octets
    de contrôle ; les octets ≥ 128 comptent comme texte)."""
    if not chunk:
        return True
    if b"\x00" in chunk:
        return False
    non_text = sum(1 for b in chunk if b not in _TEXT_BYTES and b < 128)
    return (non_text / len(chunk)) < 0.30


def _mime(p: Path) -> str:
    m, _ = mimetypes.guess_type(str(p))
    return m or "application/octet-stream"

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

_BOMS = (b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff")


def _line_endings(text: str) -> str:
    """``lf`` | ``crlf`` | ``cr`` | ``mixed`` (``lf`` si aucun saut)."""
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    cr = text.count("\r") - crlf
    kinds = [k for k, n in (("lf", lf), ("crlf", crlf), ("cr", cr)) if n]
    if not kinds:
        return "lf"
    return kinds[0] if len(kinds) == 1 else "mixed"


def _crlf_dominant(text: str) -> bool:
    """Vrai si les CRLF sont MAJORITAIRES parmi les fins de ligne."""
    crlf = text.count("\r\n")
    return crlf > 0 and crlf > text.count("\n") - crlf


def _text_conventions(raw: bytes, text: str, enc: str, explicit: bool = False) -> Dict[str, Any]:
    """Champs ``line_endings`` / ``bom`` / ``lossy`` de read_file."""
    out: Dict[str, Any] = {"line_endings": _line_endings(text),
                           "bom": any(raw.startswith(b) for b in _BOMS)}
    try:
        raw.decode(enc)
    except (UnicodeDecodeError, LookupError):
        out["lossy"] = True
        if not explicit and enc.lower().replace("_", "-") in ("utf-8", "utf8", "utf-8-sig"):
            out["encoding"] = "unknown (non-UTF-8, decoded with replacement)"
        else:
            out["encoding"] = f"{enc} (invalid bytes, decoded with replacement)"
        out["encoding_hint"] = (
            "Some bytes are not valid in this encoding and were shown as U+FFFD. "
            "The file is probably latin-1/cp1252: re-read with encoding='latin-1' "
            "(or 'cp1252'). write_file refuses to overwrite it in UTF-8 unless you "
            "pass that encoding explicitly (or delete the file first).")
    return out


def _encodage(tete: bytes) -> str:
    """Encodage d'après la marque d'ordre des octets du début du fichier."""
    if tete.startswith(b"\xef\xbb\xbf"): return "utf-8-sig"
    if tete.startswith(b"\xff\xfe\x00\x00") or tete.startswith(b"\x00\x00\xfe\xff"): return "utf-32"
    if tete.startswith(b"\xff\xfe") or tete.startswith(b"\xfe\xff"): return "utf-16"
    return "utf-8"


# ── Accès par l'agent de la sandbox ─────────────────────────────────────────
# Les outils ne lisent ni n'écrivent eux-mêmes dans le dossier de la
# sandbox : l'agent du conteneur le fait (``_espace.Espace``). ``p`` (chemin
# hôte) ne sert qu'aux noms et aux chemins affichés.

class _FluxAgent(io.RawIOBase):
    """Lecture séquentielle d'un fichier de la sandbox par plages : un gros
    fichier n'est jamais chargé en entier."""

    def __init__(self, esp: Espace, rel: str) -> None:
        self._esp, self._rel, self._pos = esp, rel, 0

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        data = self._esp.lire(self._rel, offset=self._pos, length=len(b),
                              max_bytes=len(b)).data
        b[:len(data)] = data
        self._pos += len(data)
        return len(data)


def _flux(esp: Espace, rel: str) -> io.BufferedReader:
    return io.BufferedReader(_FluxAgent(esp, rel), buffer_size=4 << 20)


def _stat_entree(p: Path, base: Path, e: Dict[str, Any]) -> Dict[str, Any]:
    """Même forme que :func:`_stat`, depuis une entrée ``stat`` de l'agent."""
    return {"name": p.name, "path": _to_container(p, base),
            "type": "dir" if e.get("kind") == "dir" else "file",
            "size": int(e.get("size") or 0),
            "mtime": int(e.get("mtime_ns") or 0) // 1_000_000_000,
            "mode": oct(int(e.get("mode") or 0) & 0o777),
            "rel": rel_under(base, p) if p != base else ""}


def _cle_parcours(rel: str, est_dossier: bool) -> List[Tuple[int, str]]:
    """Ordre d'un ``os.fwalk`` trié, de haut en bas : à
    chaque niveau les dossiers puis les fichiers, avant le contenu des
    sous-dossiers. Les tris qui suivent sont stables : à égalité, cet ordre."""
    parties = rel.split("/")
    return [(2, x) for x in parties[:-1]] + [(0 if est_dossier else 1, parties[-1])]


def _instantane_agent(esp: Espace, sb: Path, rel: str, e: Dict[str, Any],
                      max_files: int = 200, max_total: int = 32 * 1024 * 1024
                      ) -> List[Tuple[Path, bytes]]:
    """[(fichier, octets)] des fichiers ordinaires sous ``rel`` (ou ``rel``
    lui-même), lus par l'agent en une requête pour l'historique (avant une
    suppression, après une copie). Borné en nombre et en volume ; au-delà de
    ``MAX_FILE``, la version est notée sans son contenu."""
    from shared_infra.sandbox.file_history import MAX_FILE, TOO_BIG
    out: List[Tuple[Path, bytes]] = []
    try:
        if e.get("kind") == "file":
            fichiers = [(rel, int(e.get("size") or 0))]
        elif e.get("kind") == "dir":
            liste = esp.lister(rel, depth=_PROFONDEUR, max_entries=max_files * 4, hidden=True)
            fichiers = [(x["path"], int(x.get("size") or 0)) for x in liste.entries
                        if x["kind"] == "file"][:max_files]
        else:
            return out
        petits = [f for f, taille in fichiers if taille <= MAX_FILE]
        lus = esp.lire_plusieurs(petits, max_file=MAX_FILE, max_total=max_total) if petits else {}
        for f, taille in fichiers:
            if taille > MAX_FILE:
                out.append((sb / f, TOO_BIG))
            elif lus.get(f) is not None:            # au-delà de max_total : non relu
                out.append((sb / f, lus[f]))
    except AgentError:
        pass
    return out


def _lire_lots(esp: Espace, chemins: List[str], max_fichier: int,
               budget: int = 32 * 1024 * 1024) -> Iterator[Tuple[str, Optional[bytes]]]:
    """(chemin, octets ou ``None``) de chaque fichier, dans l'ordre, par
    requêtes groupées d'au plus ``budget`` octets."""
    max_fichier = min(max_fichier, budget)
    i = 0
    while i < len(chemins):
        lot = chemins[i:i + 1000]
        lus = esp.lire_plusieurs(lot, max_file=max_fichier, max_total=budget)
        n = 0
        for c in lot:
            if c not in lus:
                break                               # hors budget : requête suivante
            yield c, lus[c]
            n += 1
        if n == 0:
            raise AgentError("bad_response", "lecture groupée sans progrès")
        i += n


_ERREURS_AGENT = {
    "not_found": ("not_found", "Check the path."),
    "is_dir": ("is_directory", "Use list_files for directories."),
    "not_file": ("not_a_regular_file", "FIFOs, sockets and device files are not read."),
    "outside_root": ("outside_sandbox", "A symlink on this path leaves /work."),
    "bad_path": ("bad_path", "Use a path relative to /work."),
    "denied": ("permission_denied", "The sandbox user cannot access this path."),
    "read_only": ("permission_denied", "Read-only location."),
    "no_space": ("no_space", "The sandbox disk is full."),
    "too_large": ("too_large", "Read a range (offset/length, head, tail) instead."),
    "timeout": ("timeout", "The sandbox took too long to answer: narrow the request "
                "(path, pattern) and retry."),
    "inside": ("dest_inside_source", "Cannot copy or move a directory into itself."),
}


# Contenu relu avant de remplacer un fichier (au-delà : TOO_BIG, empreinte
# calculée par l'agent) ; empreinte calculée par l'agent jusqu'à _HASH_MAX
# (au-delà : précondition sur le mtime).
_CONTENU_MAX = 64 * 1024 * 1024
_HASH_MAX = 1 << 30


def _actuel(esp: Espace, rel: str, e: Optional[Dict[str, Any]] = None,
            max_contenu: Optional[int] = None) -> Tuple[Dict[str, Any], Optional[bytes], str]:
    """(entrée ``stat``, contenu, sha256) du fichier ``rel`` avant de le
    remplacer. Absent, ou lien pendant sous /work (l'écriture crée sa
    cible) : ``(e, None, "")``. Au-delà de ``max_contenu`` octets, le contenu
    n'est pas relu (``TOO_BIG``). Un dossier, un fichier spécial ou un lien
    qui sort de /work lève ``AgentError``."""
    from shared_infra.sandbox.file_history import TOO_BIG
    max_contenu = _CONTENU_MAX if max_contenu is None else max_contenu
    e = e if e is not None else esp.stat(rel)
    if e["kind"] == "missing" or (e["kind"] == "link" and not e.get("outside")):
        return e, None, ""
    if e["kind"] != "file":
        code = "is_dir" if e["kind"] == "dir" else "outside_root" if e.get("outside") else "not_file"
        raise AgentError(code, str(e["kind"]))
    if int(e.get("size") or 0) > max_contenu:
        h = esp.stat(rel, hash=True, hash_max=_HASH_MAX)
        return h, TOO_BIG, str(h.get("sha256") or "")
    data = esp.lire(rel, max_bytes=max_contenu).data
    return e, data, _sha256_bytes(data)


def _mode_ecrit(e: Dict[str, Any]) -> Optional[str]:
    """Mode d'une écriture : celui du fichier remplacé (bits x gardés) ;
    ``None`` : défaut de l'agent (0644)."""
    return format(int(e.get("mode") or 0) & 0o777, "o") if e.get("kind") == "file" else None


def _ecrire_garde(esp: Espace, username: str, sb: Path, p: Path, rel: str, data: bytes, *,
                  etat: Tuple[Dict[str, Any], Optional[bytes], str], expected_sha256: str = "",
                  strict: bool = False) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Remplace ``rel`` par ``data`` par l'agent : ``(réponse, None)`` ou
    ``(None, _err)``.

    ``etat`` (cf. :func:`_actuel`) : le fichier tel que l'appelant l'a lu
    (contenu ``None`` / sha ``""`` : absent). L'agent vérifie AU REMPLACEMENT que le fichier est toujours
    celui-là : ``strict`` (la nouvelle version est calculée depuis ``base`` :
    édition, ajout) → ``concurrent_modification`` ; sinon (écrasement) le
    fichier est relu puis l'écriture réessayée — le dernier écrivain gagne.
    ``expected_sha256`` (verrou optimiste du modèle) : comparé au
    contenu actuel s'il existe. Sous le verrou de fichier partagé avec
    l'éditeur ; historique noté avec le contenu remplacé."""
    from shared_infra.sandbox.file_history import MAX_FILE, TOO_BIG
    e_actuel, base, base_sha = etat
    with _optimistic_write_lock(p, True):
        for _essai in range(3):
            if expected_sha256 and base_sha and base_sha != expected_sha256:
                return None, _err("hash_mismatch",
                                  hint="File changed since read (concurrent write). Re-read then retry.",
                                  expected=expected_sha256, actual=base_sha)
            condition: Dict[str, Any] = (
                {"if_absent": True} if base is None else {"if_sha256": base_sha} if base_sha
                else {"if_mtime_ns": int(e_actuel.get("mtime_ns") or 0)})   # trop gros pour être haché
            try:
                r = esp.ecrire(rel, data, parents=True, mode=_mode_ecrit(e_actuel), **condition)
            except AgentError as e:
                if e.code not in ("changed", "exists"):
                    raise
                if strict:
                    return None, _err(
                        "concurrent_modification",
                        hint=("The file changed while this edit was being computed "
                              "(editor save, shell or another agent). Nothing was "
                              "written: re-read the file then retry."),
                        expected=base_sha, actual=str(e.data.get("sha256") or ""))
                e_actuel, base, base_sha = _actuel(esp, rel)   # écrasement : on repart du fichier actuel
                continue
            avant = base if base is None or len(base) <= MAX_FILE else TOO_BIG
            _history_record(username, sb, p, avant, data)
            return r, None
    return None, _err("concurrent_modification", hint="The file kept changing; retry.",
                      expected=base_sha)


_PROFONDEUR = 4096                   # « sans limite » : l'agent borne à PATH_MAX
_GREP_LOT = 5000                     # chemins par requête : corps JSON borné par l'agent


def _grep_lots(esp: Espace, chemins: List[str], aiguille: str, *, max_hits: int,
               **kw: Any) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """``esp.grep`` par lots de chemins ; même résultat et même bilan qu'un
    seul appel."""
    trouves: List[Dict[str, Any]] = []
    bilan: Dict[str, Any] = {"hits_truncated": False, "skipped_large": 0, "skipped_binary": 0}
    for i in range(0, len(chemins), _GREP_LOT):
        t, b = esp.grep(chemins[i:i + _GREP_LOT], aiguille, max_hits=max_hits - len(trouves), **kw)
        trouves += t
        bilan["skipped_large"] += int(b.get("skipped_large") or 0)
        bilan["skipped_binary"] += int(b.get("skipped_binary") or 0)
        if b.get("hits_truncated") or len(trouves) >= max_hits:
            bilan["hits_truncated"] = bool(b.get("hits_truncated"))
            break
    return trouves, bilan


def _sauvegarde(esp: Espace, rel: str) -> Optional[Dict[str, Any]]:
    """``<rel>.bak`` : copie du contenu actuel (un lien : sa cible), droits
    compris ; ``_err`` si un dossier porte ce nom (l'agent ne le remplace
    jamais)."""
    try:
        esp.fsop("copy", src=rel, dst=rel + ".bak", overwrite=True, follow=True)
    except AgentError as e:
        if e.code == "is_dir":
            return _err("backup_is_directory",
                        hint=f"{to_container(rel + '.bak')} is a directory: rename it or "
                             "pass backup=False. Nothing was written.")
        raise
    return None


def _err_agent(e: AgentError, p: Path, sb: Path) -> Dict[str, Any]:
    """Refus de l'agent → enveloppe d'erreur de l'outil."""
    code, hint = _ERREURS_AGENT.get(e.code, (None, ""))
    if code is None:
        if e.code in ("agent_unavailable", "container_down", "transport", "bad_response"):
            return _err("sandbox_unavailable", hint="The sandbox container could not be "
                        "reached; retry in a moment.", detail=e.message[:200])
        code, hint = e.code, e.message[:200]
    return _err(code, hint=hint, path=_to_container(p, sb))


# Garde-fou ReDoS : le module ``regex`` (timeout) n'est pas dispo, et un thread ne
# peut PAS interrompre un re.* parti en backtracking catastrophique (boucle C, GIL
# tenu). On rejette donc AVANT compilation les deux signatures à risque : motif
# absurdement long, et quantificateur imbriqué (ex. (a+)+, (.*)* …). On lève re.error
# → capté par les handlers ``except re.error`` déjà en place (message propre, jamais
# de crash ni de worker figé). Conservateur : ne rejette que des formes ReDoS claires.
_REDOS_NESTED = re.compile(r"\([^()]*[+*][^()]*\)[+*]")
def _check_regex_safe(pattern: str) -> None:
    if not pattern:
        return
    if len(pattern) > 2000:
        raise re.error("motif trop long (>2000 caractères) — risque de déni de service")
    if _REDOS_NESTED.search(pattern):
        raise re.error("motif à risque de backtracking catastrophique (quantificateur imbriqué)")

def _executable_mode(cur: int) -> int:
    """Target mode for the ``chmod`` action: ``chmod +x`` under umask 022 —
    executable for all, write bits unchanged (a single UID owns /work)."""
    return cur | 0o111


# ── Verrou optimiste cross-worker ─────────────────────────────────────────
# Sans verrou, ``expected_sha256`` serait un check-then-write : deux
# écritures concurrentes (workers gunicorn différents) liraient le même sha
# puis écriraient toutes les deux.
# Pattern calqué sur _SkillsWriteLock : flock advisory sur un lockfile
# sidecar à inode STABLE (jamais unlink, cf. cron_lock), HORS de la sandbox
# user (pas de pollution du tree, pas d'attaque sur le lockfile).
# Garde-fous : FAIL-OPEN (flock indispo / contention > ~3 s → on continue,
# l'écriture atomique reste la protection de base), kill switch
# ``FSTOOLS_FLOCK=0``. Les tools tournent en thread worker (def sync) :
# le retry borné ne bloque pas l'event loop.
# Le verrou est pris à CHAQUE écriture (pas seulement avec
# ``expected_sha256``) ; c'est celui de ``shared_infra.sandbox.file_lock``,
# partagé avec ``/api/sandbox/save``.
_FSTOOLS_FLOCK = os.environ.get("FSTOOLS_FLOCK", "1") != "0"
_WRITE_LOCKS_BASE: Optional[Path] = None   # posé par register() (lu par la maintenance)


import contextlib


@contextlib.contextmanager
def _optimistic_write_lock(p: Path, enabled: bool = True, timeout_s: float = 3.0):
    """flock exclusif PAR FICHIER. Yield True si obtenu, False en fail-open
    (désactivé, flock indisponible, contention > ``timeout_s``).

    Simple alias de ``shared_infra.sandbox.file_lock.file_write_lock`` — le
    MÊME verrou que ``/api/sandbox/save`` de l'éditeur (même dossier
    ``.write_locks``, même nom de sidecar, clé = chemin RÉSOLU). Sans verrou
    commun, une écriture de l'agent tombée entre le contrôle et le ``mv`` de
    ``/save`` serait écrasée sans un mot."""
    if not (enabled and _FSTOOLS_FLOCK):
        yield False
        return
    from shared_infra.sandbox.file_lock import file_write_lock
    try:
        key = os.path.realpath(str(p))
    except Exception:
        key = str(p)
    with file_write_lock(key, timeout_s=timeout_s) as got:
        yield got


# ── Historique de session des fichiers modifiés ─────────────────────────
# Chaque écriture / suppression / déplacement réussi de l'assistant est noté
# dans ``shared_infra.sandbox.file_history`` (original + chaque version), pour
# que l'utilisateur compare ou restaure. Jamais bloquant.
_UID_CACHE: Dict[str, Tuple[Optional[int], float]] = {}


def _history_uid(username: str) -> Optional[int]:
    """id du compte (mis en cache ; un échec est retenté après 60 s)."""
    if not username:
        return None
    now = time.monotonic()
    hit = _UID_CACHE.get(username)
    if hit is not None and (hit[0] is not None or now - hit[1] < 60):
        return hit[0]
    uid = None
    try:
        from shared_infra.accounts.users import get_user
        row = get_user(username)
        if row is not None:
            uid = int(row["id"])
    except Exception:
        uid = None
    _UID_CACHE[username] = (uid, now)
    return uid


def _history_rel(p: Path, sb: Path) -> Optional[str]:
    try:
        return Path(p).relative_to(Path(sb).resolve()).as_posix()
    except Exception:
        try:
            return Path(os.path.realpath(p)).relative_to(Path(sb).resolve()).as_posix()
        except Exception:
            return None


def _history_writer(username: str, sb: Path, p: Path, after: Optional[bytes]):
    """``callable(before)`` qui note l'écriture dans l'historique, ou ``None``
    si le compte ou le chemin ne sont pas résolus."""
    uid = _history_uid(username)
    rel = _history_rel(p, sb) if uid is not None else None
    if uid is None or not rel:
        return None

    def _rec(before):
        from shared_infra.sandbox.file_history import current_session, record_write
        # Session créée HORS du verrou de compte : ``record_write`` appelle
        # ``current_session`` sous ce verrou, et une création de session à
        # cet endroit re-prend le même flock (attente de 5 s, fail-open).
        current_session(uid)
        record_write(uid, rel, before, after, "assistant")
    return _rec


def _history_record(username: str, sb: Path, p: Path,
                    before: Optional[bytes], after: Optional[bytes]) -> None:
    rec = _history_writer(username, sb, p, after)
    if rec is not None:
        try:
            rec(before)
        except Exception:
            pass


@contextlib.contextmanager
def _locks_for(*paths: Path):
    """Verrous de fichier sur plusieurs chemins, dans un ordre stable
    (pas d'étreinte mortelle entre deux déplacements croisés)."""
    keys = sorted({os.path.realpath(str(x)) for x in paths if x is not None})
    with contextlib.ExitStack() as st:
        for k in keys:
            st.enter_context(_optimistic_write_lock(Path(k), True))
        yield


def _history_move(username: str, sb: Path, src: Path, dst: Path) -> None:
    uid = _history_uid(username)
    if uid is None:
        return
    a, b = _history_rel(src, sb), _history_rel(dst, sb)
    if a and b:
        try:
            from shared_infra.sandbox.file_history import current_session, record_move
            current_session(uid)          # cf. _history_writer
            record_move(uid, a, b)
        except Exception:
            pass

def _fc_entry(p: Path, sb: Path, change: str, before: Optional[bytes],
              after: Optional[bytes], **extra) -> Dict[str, Any]:
    """Entrée ``files_changed`` : ce que le chat relit pour
    afficher le diff d'un fichier touché par un outil. Les empreintes sont
    les clés des versions gardées dans l'historique de session."""
    from shared_infra.sandbox.file_history import sha_of
    ent: Dict[str, Any] = {"path": _to_container(p, sb), "change": change,
                           "old_sha256": sha_of(before), "new_sha256": sha_of(after)}
    ent.update(extra)
    return ent


_FC_MAX = 50


def _format_lines(lines: List[str], start: int, with_numbers: bool) -> str:
    if not with_numbers:
        return "\n".join(lines)
    if not lines:
        return ""
    last_num = start + len(lines) - 1
    width = len(str(last_num))
    return "\n".join(f"{str(i).rjust(width)}\t{ln}" for i, ln in enumerate(lines, start))

# Au-delà de cette taille, un fichier TEXTE n'est pas chargé en mémoire :
# read_file le parcourt en flux. ``read_bytes()`` + décodage +
# ``splitlines()`` coûteraient ~4× la taille du fichier dans le processus
# d'outils PARTAGÉ — un ``tail`` sur un journal de 2 Go le tuerait.
_STREAM_READ_OVER = 16 * 1024 * 1024


def _read_large_text(ouvrir, info: Dict[str, Any], *, enc: str, head: int,
                     tail: int, start_line: int, end_line: int, grep: str,
                     grep_context: int, ignore_case: bool,
                     with_line_numbers: bool, max_chars: int) -> Dict[str, Any]:
    """``read_file`` sur un gros fichier texte, en FLUX : mémoire bornée par
    ce qui est rendu (``max_chars``), jamais par la taille du fichier.

    Numérotation au saut de ligne ``\\n`` (celle de ``grep -n`` et des
    éditeurs). Modes : head, tail, plage start/end, grep (+contexte), et par
    défaut un aperçu tête + queue."""
    import hashlib as _hl
    from collections import deque
    info = dict(info)
    info["streamed"] = True
    # Empreinte et nombre de lignes en UNE passe : jamais deux lectures
    # complètes du fichier avant le moindre rendu.
    total = 0
    last = b""
    _h = _hl.sha256()
    with ouvrir() as fb:
        for block in iter(lambda: fb.read(1 << 20), b""):
            _h.update(block)
            total += block.count(b"\n")
            last = block[-1:]
    if last and last != b"\n":
        total += 1
    info["sha256"] = _h.hexdigest()
    info["total_lines"] = total
    max_chars = max(1, min(max_chars, MAX_READ_CHARS))
    # Une ligne n'est jamais lue au-delà de ce plafond (octets) : sans lui, une
    # seule ligne de plusieurs centaines de Mo (JSON minifié, log sans saut)
    # serait chargée ENTIÈRE en mémoire puis rendue en entier.
    _line_cap = max_chars + 4

    def _lines():
        """(numéro, texte) — découpe au SEUL ``\n``, comme ``total_lines`` et
        ``grep -n``. Ne pas couper aussi sur un ``\r`` isolé (barres de
        progression pip/tqdm/docker) : tous les numéros suivants seraient
        décalés. Ligne trop longue : coupée au plafond, le reste est sauté et
        signalé."""
        with ouvrir() as fb:
            i = 0
            while True:
                raw = fb.readline(_line_cap)
                if not raw:
                    return
                i += 1
                rest = 0
                if not raw.endswith(b"\n"):
                    while True:
                        more = fb.readline(1 << 20)
                        if not more:
                            break
                        rest += len(more)
                        if more.endswith(b"\n"):
                            rest -= 1
                            break
                txt = raw.rstrip(b"\n").rstrip(b"\r").decode(enc, errors="replace")
                if rest > 0:
                    txt += f" …[line cut: {rest} more bytes]"
                yield i, txt

    def _render(rows) -> str:
        if not rows:
            return ""
        if not with_line_numbers:
            return "\n".join(t for _, t in rows)
        width = len(str(rows[-1][0]))
        return "\n".join(f"{str(i).rjust(width)}\t{t}" for i, t in rows)

    _cut_line = [False]

    def _take(it, stop_at: Optional[int] = None):
        rows, used = [], 0
        for i, t in it:
            if stop_at is not None and i > stop_at:
                break
            used += len(t) + 1
            if used > max_chars:
                if rows:
                    return rows, True
                # Première ligne à elle seule au-delà du budget : coupée, pas
                # rendue entière.
                _cut_line[0] = True
                return [(i, t[:max_chars] + " …[line cut]")], True
            rows.append((i, t))
        return rows, False

    if grep:
        flags = re.IGNORECASE if ignore_case else 0
        _check_regex_safe(grep)
        pat = re.compile(grep, flags)
        ctx_n = max(0, int(grep_context or 0))
        before: "deque" = deque(maxlen=ctx_n) if ctx_n else deque(maxlen=0)
        out: List[str] = []
        st = {"used": 0, "prev": 0}

        def _add(i: int, sep: str, t: str) -> None:
            if st["prev"] and i - st["prev"] > 1:
                out.append("--")
                st["used"] += 3
            ln = f"{i}{sep}{t}"
            _room = max_chars - st["used"]
            if len(ln) > _room:
                ln = ln[:max(0, _room)] + " …[line cut]"
            out.append(ln)
            st["used"] += len(ln) + 1
            st["prev"] = i

        matches, after = 0, 0
        trunc = False
        for i, t in _lines():
            if pat.search(t):
                matches += 1
                for bi, bt in before:
                    if bi > st["prev"]:
                        _add(bi, "-", bt)
                before.clear()
                _add(i, ":", t)
                after = ctx_n
            elif after > 0:
                _add(i, "-", t)
                after -= 1
            elif ctx_n:
                before.append((i, t))
            if st["used"] > max_chars or matches >= MAX_GREP:
                trunc = True
                break
        if not matches:
            return _ok(**info, format="grep", matches=0, content="", hint="no matches")
        return _ok(**info, format="grep", matches=matches, content="\n".join(out),
                   truncated=trunc)
    if head > 0:
        rows, trunc = _take(_lines(), stop_at=head)
        return _ok(**info, format="head", shown_lines=len(rows),
                   content=_render(rows), truncated=trunc)
    if tail > 0:
        dq: "deque" = deque(maxlen=min(tail, 100_000))
        for row in _lines():
            dq.append(row)
        # Budget depuis la FIN, total courant : recalculer la somme à chaque
        # ``pop(0)`` serait quadratique (593 s mesurées pour tail=100000).
        rows: List[Tuple[int, str]] = []
        used = 0
        for i, t in reversed(dq):
            used += len(t) + 1
            if used > max_chars:
                if not rows:
                    rows.append((i, " …[line cut] " + t[-max_chars:]))
                break
            rows.append((i, t))
        rows.reverse()
        start = rows[0][0] if rows else max(1, total)
        return _ok(**info, format="tail", shown_lines=len(rows), start_line=start,
                   content=_render(rows), truncated=(len(rows) < len(dq) or used > max_chars))
    if start_line > 0 or end_line > 0:
        s = max(1, start_line)
        e = end_line if end_line > 0 else None
        rows, trunc = _take(((i, t) for i, t in _lines() if i >= s), stop_at=e)
        return _ok(**info, format="range", start=s,
                   end=(rows[-1][0] if rows else s), shown_lines=len(rows),
                   content=_render(rows), truncated=trunc)
    half = max(1, max_chars // 2)
    head_rows, _ = _take(_lines())
    used, keep = 0, []
    for r in head_rows:
        used += len(r[1]) + 1
        if used > half and keep:
            break
        keep.append(r)
    tail_dq: "deque" = deque()
    tail_used = 0
    for row in _lines():
        if row[0] <= (keep[-1][0] if keep else 0):
            continue
        tail_dq.append(row)
        tail_used += len(row[1]) + 1
        while tail_dq and tail_used > half:
            tail_used -= len(tail_dq[0][1]) + 1
            tail_dq.popleft()
    tail_rows = list(tail_dq)
    omitted = max(0, total - len(keep) - len(tail_rows))
    body = _render(keep)
    if omitted:
        body += f"\n...[{omitted} lines omitted — file is {info.get('size', 0)} bytes]...\n"
    body += _render(tail_rows)
    return _ok(**info, format="auto_truncated", content=body,
               truncated=bool(omitted) or _cut_line[0],
               hint=("Large file read in streaming mode: use start_line/end_line, "
                     "head/tail or grep to see the omitted part."))


def _make_diff(old: str, new: str, rel_path: str, n: int = 3) -> str:
    return "".join(difflib.unified_diff(
        old.splitlines(keepends=True), new.splitlines(keepends=True),
        fromfile=f"a/{rel_path}", tofile=f"b/{rel_path}", n=n))

def _line_count(s: str) -> int:
    if not s: return 0
    n = s.count("\n")
    if not s.endswith("\n"): n += 1
    return n


def _line_diff_stats(old: str, new: str) -> tuple:
    """Count added/removed lines between two strings via difflib.unified_diff.

    Used by write_file / edit_file to expose accurate +X/-Y stats in the
    tool result, so the frontend can display them even when the editor
    is disabled (no Monaco snapshot available client-side).

    Returns (added, removed). Ignores the +++/--- file headers in the
    unified diff. n=0 means no context lines -> just changed lines counted.
    """
    if old == new:
        return 0, 0
    added = removed = 0
    for line in difflib.unified_diff(
        old.splitlines(keepends=False),
        new.splitlines(keepends=False),
        n=0,
    ):
        if line.startswith('+') and not line.startswith('+++'):
            added += 1
        elif line.startswith('-') and not line.startswith('---'):
            removed += 1
    return added, removed


# ── Helpers for list_files (since filter, git status) ──────────────────────

def _parse_since(value: str) -> Optional[float]:
    """Parse a 'since' value as either a Unix timestamp, a relative duration
    ('1h', '7d', '30m'), or an ISO date ('2025-01-01'). Returns the absolute
    cutoff timestamp (epoch seconds) or None on parse failure."""
    if not value:
        return None
    s = str(value).strip()
    # Pure number → absolute epoch
    try:
        return float(s)
    except ValueError:
        pass
    # Relative: <N><unit>  where unit ∈ {s,m,h,d,w}
    m = re.fullmatch(r"(\d+)\s*([smhdw])", s.lower())
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        secs = n * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[unit]
        return time.time() - secs
    # ISO date: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
    try:
        from datetime import datetime
        for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(s, fmt).timestamp()
            except ValueError:
                continue
    except Exception:
        pass
    return None


def _git_status_map(esp: Espace, sb: Path, root: Path) -> Tuple[Dict[str, str], Optional[str]]:
    """Run `git status --porcelain=v1` from inside `root`: ``(map, None)``,
    the map going from paths RELATIVE TO ``root`` to the 2-char status code
    (' M', '??', 'A '), or ``({}, reason)`` when no status could be read (not
    a repository, git unavailable or too slow) — an empty map alone would
    read as a clean tree. Bounded (2 s per git call).

    Ré-ancrage sur le dossier listé : le format porcelain émet TOUJOURS des
    chemins relatifs à la RACINE DU DÉPÔT, jamais au cwd (il force
    ``status.relativePaths=false``), alors que les consommateurs indexent
    avec ``c.relative_to(root)`` — le dossier LISTÉ. Sans ré-ancrage, dès que
    ``root`` n'est pas la racine du dépôt (le cas nominal : lister un
    sous-dossier de code), aucune clé ne correspond et l'annotation disparaît
    en silence. On retire donc le préfixe rendu par
    ``git rev-parse --show-prefix``.

    git tourne dans la sandbox, par son agent (``Espace.git``).
    """
    rel = rel_under(sb, root)
    rel = "" if rel == "." else rel

    def _why(r) -> str:
        if r.timed_out:
            return "git status timed out"
        lines = (r.stderr or "").strip().splitlines()
        return (lines[-1] if lines else f"git exited with {r.returncode}")[:200]
    try:
        pp = esp.git(rel, ["rev-parse", "--show-prefix"], timeout_s=2, max_out=1 << 16)
        if pp.returncode != 0:
            return {}, _why(pp)
        _prefix = pp.stdout.strip()
        proc = esp.git(rel, ["status", "--porcelain=v1"], timeout_s=2, max_out=4 << 20)
        if proc.returncode != 0:
            return {}, _why(proc)
    except AgentError as e:
        return {}, f"git unavailable ({e.code})"
    out: Dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if len(line) < 4:
            continue
        code = line[:2]
        path = line[3:].strip()
        # Handle renames: "R  old -> new"
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        # Ré-ancrage : le porcelain parle depuis la racine du dépôt.
        if _prefix:
            if not path.startswith(_prefix):
                continue          # hors du dossier listé
            path = path[len(_prefix):]
        out[path] = code
    return out, None


# ── Helpers for anchor/indent edits ─────────────────────────────────────────

def _resolve_anchor(text: str, anchor_str: str = "", anchor_re: str = "",
                    anchor_pos: str = "after", occurrence: int = 1) -> Tuple[int, int]:
    """Find an anchor in `text` and return (line_idx, byte_idx) of the
    insertion point. anchor_pos ∈ {'before', 'after'}.
    Raises ValueError if not found.
    Lines are 1-based.
    """
    if anchor_re:
        try:
            _check_regex_safe(anchor_re)
            pat = re.compile(anchor_re, re.MULTILINE)
        except re.error as e:
            raise ValueError(f"anchor: bad regex ({e})")
        matches = list(pat.finditer(text))
    elif anchor_str:
        # Plain string match
        matches = []
        start = 0
        while True:
            i = text.find(anchor_str, start)
            if i < 0:
                break
            class _M:  # mimic re.Match.start/end interface
                def __init__(self, s, e): self._s = s; self._e = e
                def start(self): return self._s
                def end(self):   return self._e
            matches.append(_M(i, i + len(anchor_str)))
            start = i + 1
    else:
        raise ValueError("anchor: provide anchor_str or anchor_re")

    if not matches:
        raise ValueError("anchor: not found in file")
    # ``-1`` = la DERNIÈRE correspondance, comptée par CE finder. Jamais par
    # ``str.count`` : il ne voit pas les correspondances qui se chevauchent
    # (« \n\n », « -- ») et « la dernière » ne serait pas la dernière.
    if occurrence == -1:
        occurrence = len(matches)
    if occurrence < 1 or occurrence > len(matches):
        raise ValueError(
            f"anchor: occurrence={occurrence} out of range (1..{len(matches)})"
        )
    m = matches[occurrence - 1]
    pos = m.start() if anchor_pos == "before" else m.end()
    # Line-based: snap to start of next line for "after" if mid-line
    line_idx = text.count("\n", 0, pos) + 1
    return line_idx, pos


def _has_formatter(name: str) -> bool:
    return shutil.which(name) is not None


def _try_format(path: Path, content: str) -> Tuple[str, str]:
    """Try to auto-format `content` based on file extension. Returns
    (formatted_content, formatter_used). If no formatter applies or the
    formatter fails, returns the original content."""
    ext = path.suffix.lower()
    fmt = ""
    try:
        if ext == ".py" and _has_formatter("black"):
            # Nom seul depuis un cwd neutre : black ne lit ni le
            # pyproject.toml ni le .gitignore de la sandbox.
            r = subprocess.run(
                ["black", "--quiet", "--stdin-filename", path.name, "-"],
                input=content, capture_output=True, text=True,
                timeout=10, check=False, cwd="/",
            )
            if r.returncode == 0 and r.stdout:
                return r.stdout, "black"
        elif ext in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".md") and _has_formatter("prettier"):
            # Ni config (``prettier.config.js`` = code exécuté sur l'hôte, et
            # ses greffons) ni ``.editorconfig`` du bac à sable : seul le nom
            # sert à choisir l'analyseur, depuis un cwd neutre.
            r = subprocess.run(
                ["prettier", "--no-config", "--no-editorconfig",
                 f"--stdin-filepath={path.name}"],       # « -x.js » n'est pas une option
                input=content, capture_output=True, text=True,
                timeout=10, check=False, cwd="/",
            )
            if r.returncode == 0 and r.stdout:
                return r.stdout, "prettier"
        elif ext in (".sh", ".bash") and _has_formatter("shfmt"):
            r = subprocess.run(
                ["shfmt", "-i", "4"],
                input=content, capture_output=True, text=True,
                timeout=10, check=False,
            )
            if r.returncode == 0 and r.stdout:
                return r.stdout, "shfmt"
        elif ext in (".yaml", ".yml") and _has_formatter("yamlfmt"):
            r = subprocess.run(
                ["yamlfmt", "-"],
                input=content, capture_output=True, text=True,
                timeout=10, check=False,
            )
            if r.returncode == 0 and r.stdout:
                return r.stdout, "yamlfmt"
    except (subprocess.TimeoutExpired, OSError):
        pass
    return content, fmt


# ── Symlink-safe write (defense in depth) ───────────────────────────────────


# ── Core edit engine (shared by edit_file single + multi) ────────────────────

def _find_str_with_context(
    text: str, target: str,
    before: List[str], after: List[str],
) -> List[int]:
    """Return char offsets where `target` appears AND its surrounding lines
    match the provided `before` / `after` context. Whitespace is normalized
    in the context comparison (target itself is matched verbatim).

    Returns empty list = no match. Returns >1 = ambiguous (caller decides
    how to react).
    """
    if not target:
        return []
    norm = lambda s: re.sub(r'\s+', ' ', s).strip()
    norm_before = [norm(b) for b in (before or [])]
    norm_after  = [norm(a) for a in (after or [])]
    if not norm_before and not norm_after:
        offs, i = [], 0
        while True:
            j = text.find(target, i)
            if j < 0: break
            offs.append(j); i = j + max(1, len(target))
        return offs
    lines = text.splitlines(keepends=False)
    line_starts = [0]
    for ln in text.splitlines(keepends=True):
        line_starts.append(line_starts[-1] + len(ln))
    def line_of(off: int) -> int:
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= off: lo = mid
            else: hi = mid - 1
        return lo
    matches: List[int] = []
    cursor = 0
    while True:
        j = text.find(target, cursor)
        if j < 0: break
        cursor = j + max(1, len(target))
        start_line = line_of(j)
        end_line   = line_of(j + len(target) - 1) if len(target) > 0 else start_line
        ok = True
        for k, want in enumerate(reversed(norm_before)):
            ln_idx = start_line - 1 - k
            if ln_idx < 0 or norm(lines[ln_idx]) != want:
                ok = False; break
        if not ok: continue
        for k, want in enumerate(norm_after):
            ln_idx = end_line + 1 + k
            if ln_idx >= len(lines) or norm(lines[ln_idx]) != want:
                ok = False; break
        if not ok: continue
        matches.append(j)
    return matches


def _flexible_block_matches(text: str, target: str) -> List[Tuple[int, int, str, str]]:
    """Matches LIGNE-ALIGNÉS de ``target`` dans ``text``, tolérants aux
    espaces de FIN de ligne et à un décalage d'indentation UNIFORME.

    Repli du ``str_replace`` exact : la première cause d'échec des éditions LLM
    est un ``old_str`` recopié avec une indentation décalée (bloc cité depuis
    un niveau différent) ou des espaces traînants perdus. On ne tolère QUE :
      * des espaces/tabs de fin de ligne différents ;
      * un MÊME préfixe d'indentation ajouté ou retiré sur TOUTES les lignes
        non vides (décalage uniforme — jamais un remaniement ligne à ligne).

    Retourne ``[(start, end, op, prefix)]`` où ``text[start:end]`` est le bloc
    réellement présent dans le fichier et (op, prefix) la transformation à
    appliquer aux lignes de ``new_str`` pour suivre le fichier :
      op='' aucun ajustement ; op='+' préfixer chaque ligne non vide de
      ``prefix`` ; op='-' retirer ``prefix`` en tête de ligne (si présent).
    """
    tgt_lines = target.split("\n")
    # Bloc mono-ligne sans structure : le repli ligne-aligné n'apporte rien
    # de sûr (un fragment en milieu de ligne relève du match exact).
    if not any(ln.strip() for ln in tgt_lines):
        return []
    tgt_ends_nl = target.endswith("\n")
    if tgt_ends_nl:
        tgt_lines = tgt_lines[:-1]

    # Découpe de text en lignes avec offsets (sans les \n).
    starts: List[int] = []
    bodies: List[str] = []
    pos = 0
    for ln in text.split("\n"):
        starts.append(pos)
        bodies.append(ln)
        pos += len(ln) + 1
    n_lines, n_tgt = len(bodies), len(tgt_lines)
    if n_tgt == 0 or n_tgt > n_lines:
        return []

    def _indent_of(s: str) -> str:
        return s[:len(s) - len(s.lstrip(" \t"))]

    out: List[Tuple[int, int, str, str]] = []
    i = 0
    while i + n_tgt <= n_lines:
        op: Optional[str] = None
        prefix = ""
        okm = True
        for k in range(n_tgt):
            w = bodies[i + k].rstrip()
            t = tgt_lines[k].rstrip()
            if w == "" and t == "":
                continue                      # lignes vides : indentation libre
            if w.lstrip(" \t") != t.lstrip(" \t"):
                okm = False
                break
            wi, ti = _indent_of(w), _indent_of(t)
            if wi == ti:
                k_op, k_pre = "", ""
            elif wi.endswith(ti) and len(wi) > len(ti):
                k_op, k_pre = "+", wi[:len(wi) - len(ti)]
            elif ti.endswith(wi) and len(ti) > len(wi):
                k_op, k_pre = "-", ti[:len(ti) - len(wi)]
            else:
                okm = False
                break
            if op is None:
                op, prefix = k_op, k_pre
            elif (op, prefix) != (k_op, k_pre):
                okm = False                   # décalage NON uniforme → refus
                break
        if okm:
            start = starts[i]
            last = i + n_tgt - 1
            if tgt_ends_nl:
                end = starts[last] + len(bodies[last]) + 1   # \n inclus
                end = min(end, len(text))
            else:
                end = starts[last] + len(bodies[last])
            out.append((start, end, op or "", prefix))
            i += n_tgt                        # non-chevauchant
        else:
            i += 1
    return out


def _shift_indent(s: str, op: str, prefix: str) -> str:
    """Applique aux lignes de ``s`` le décalage d'indentation détecté sur le
    bloc du fichier (cf. _flexible_block_matches) — new_str suit le fichier."""
    if not op or not prefix:
        return s
    out_lines = []
    for ln in s.split("\n"):
        if not ln.strip():
            out_lines.append(ln)
        elif op == "+":
            out_lines.append(prefix + ln)
        else:
            out_lines.append(ln[len(prefix):] if ln.startswith(prefix) else ln)
    return "\n".join(out_lines)


def _nearest_candidate(old_text: str, old_str: str) -> str:
    """Fenêtre du fichier la plus PROCHE d'un old_str introuvable — évite au
    modèle une relecture complète pour re-caler son contexte (les erreurs
    d'édition OpenCode/Aider montrent les lignes voisines). Ancre = la ligne
    non vide la plus longue d'old_str, matchée par difflib sur les lignes du
    fichier. Best-effort : chaîne vide si aucune candidate plausible."""
    try:
        import difflib
        needles = sorted((l.strip() for l in old_str.splitlines() if l.strip()),
                         key=len, reverse=True)
        if not needles:
            return ""
        lines = old_text.splitlines()
        best = difflib.get_close_matches(
            needles[0], [l.strip() for l in lines], n=1, cutoff=0.6)
        if not best:
            return ""
        idx = next(i for i, l in enumerate(lines) if l.strip() == best[0])
        lo, hi = max(0, idx - 2), min(len(lines), idx + 3)
        window = "\n".join(f"{i + 1}: {lines[i]}" for i in range(lo, hi))[:400]
        return (f"\nClosest match in the file (around line {idx + 1}):\n{window}\n"
                f"Re-read that region and provide the exact current text.")
    except Exception:
        return ""


_LINE_ADDRESSED = ("insert", "delete", "replace", "indent")


def _norm_edit_crlf(edit: Any) -> Any:
    """Champs texte d'une édition de ``multi`` ramenés en LF (le fichier CRLF
    est normalisé en LF avant les éditions, comme les champs de l'action
    simple). Sans ça, un ``old_str`` en CRLF rate le match exact, le repli
    tolérant l'accepte, et le ``\\r\\n`` inséré devient ``\\r\\r\\n`` à la
    réécriture."""
    if not isinstance(edit, dict):
        return edit
    out = dict(edit)
    for k in ("old_str", "new_str", "content", "replacement", "anchor_str"):
        if isinstance(out.get(k), str):
            out[k] = out[k].replace("\r\n", "\n")
    for k in ("before_context", "after_context"):
        if isinstance(out.get(k), list):
            out[k] = [str(x).replace("\r\n", "\n") for x in out[k]]
    return out


def _order_multi_edits(edits: List[Any]) -> List[Tuple[int, Any]]:
    """Ordre d'application d'un lot ``multi`` : [(indice d'origine, édition)].

    Le modèle calcule ses numéros de ligne sur le fichier LU : ils désignent
    ce fichier-là. Les éditions par numéro partent de BAS EN HAUT (aucune ne
    décale les suivantes), les éditions par contenu (str_replace, regex,
    anchor…) ensuite, dans l'ordre donné. Ne pas les appliquer dans l'ordre
    reçu, chacune sur le texte déjà modifié : après ``delete 2-3``, un
    ``replace 8`` toucherait l'ancienne ligne 10, sous un ``ok``. Plages qui
    se chevauchent : refusées (intention ambiguë)."""
    by_line: List[Tuple[float, int, Any, int, int]] = []
    others: List[Tuple[int, Any]] = []
    for i, ed in enumerate(edits):
        act = (ed.get("action") or "").strip().lower() if isinstance(ed, dict) else ""
        if act not in _LINE_ADDRESSED:
            others.append((i, ed))
            continue
        try:
            s = int(ed.get("start_line", -1 if act == "insert" else 0))
        except (TypeError, ValueError):
            others.append((i, ed))      # laissé au moteur (erreur explicite)
            continue
        if act == "insert":
            key = float("inf") if s == -1 else float(max(s, 0))
            lo = hi = key
        else:
            try:
                e = int(ed.get("end_line", 0) or s)
            except (TypeError, ValueError):
                e = s
            key, lo, hi = float(s), float(s), float(max(e, s))
        by_line.append((key, i, ed, lo, hi))
    ranges = sorted((lo, hi, i, (ed.get("action") or "").lower())
                    for _k, i, ed, lo, hi in by_line)
    for (lo1, hi1, i1, a1), (lo2, hi2, i2, a2) in zip(ranges, ranges[1:]):
        if a1 == "insert" and a2 == "insert":
            continue
        if a1 == "insert":          # insertion AVANT la ligne lo1
            if lo2 < lo1 <= hi2 and a2 != "insert":
                raise ValueError(f"edits {i1} and {i2} overlap (insert inside a range)")
            continue
        if a2 == "insert":
            if lo1 < lo2 <= hi1:
                raise ValueError(f"edits {i1} and {i2} overlap (insert inside a range)")
            continue
        if lo2 <= hi1:
            raise ValueError(f"edits {i1} and {i2} overlap (lines {int(lo1)}-{int(hi1)} "
                             f"and {int(lo2)}-{int(hi2)})")
    # À clé égale, les éditions de PLAGE d'abord, les insertions ensuite :
    # insérer APRÈS le remplacement pose INS devant la ligne N d'origine
    # (devenue son remplacement), comme demandé. Dans l'ordre inverse,
    # « insert@N » + « replace N-M » ferait manger la ligne insérée par le
    # remplacement (INS et la ligne N disparaissent, M reste) sous un ``ok``.
    def _ins(r) -> int:
        return 0 if (r[2].get("action") or "").strip().lower() == "insert" else 1
    by_line.sort(key=lambda r: (r[0], _ins(r), r[1]), reverse=True)
    return [(i, ed) for _k, i, ed, _lo, _hi in by_line] + others


def _apply_one_edit(old_text: str, edit: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Apply one edit. Returns (new_text, info). Raises ValueError with hint on failure."""
    act = (edit.get("action") or "").strip().lower()

    if act == "str_replace":
        old_str = edit.get("old_str", "")
        new_str = edit.get("new_str", "")
        count = int(edit.get("count", 1))
        if not old_str:
            raise ValueError("str_replace: old_str required")
        occ = old_text.count(old_str)
        if occ == 0:
            # ── REPLI tolérant (espaces traînants / décalage d'indentation
            # uniforme) — cf. _flexible_block_matches. Le match exact reste
            # le chemin nominal ; le repli n'est tenté QUE sur zéro occurrence
            # et n'accepte jamais une correspondance approximative du CONTENU.
            spans = _flexible_block_matches(old_text, old_str)
            if not spans:
                raise ValueError(
                    "str_replace: old_str not found — check whitespace, "
                    "indentation, line endings" + _nearest_candidate(old_text, old_str))
            if count not in (-1, len(spans)):
                raise ValueError(
                    f"str_replace: expected {count} occurrences, found {len(spans)} "
                    f"(via whitespace-tolerant match) — expand old_str or use count=-1")
            new_parts: List[str] = []
            cur = 0
            for (s, e, op, pre) in spans:
                new_parts.append(old_text[cur:s])
                new_parts.append(_shift_indent(new_str, op, pre))
                cur = e
            new_parts.append(old_text[cur:])
            _mode = "indent_shift" if any(op for (_s, _e, op, _p) in spans) else "trailing_ws"
            return "".join(new_parts), {
                "action": "str_replace", "replacements": len(spans),
                "matched": _mode,
                "note": ("Non-literal match: old_str differed by "
                         + ("a uniform indentation shift (new_str was re-indented to follow the file)"
                            if _mode == "indent_shift" else "trailing whitespace")
                         + ". Check the diff."),
            }
        if count == -1:
            return old_text.replace(old_str, new_str), {"action": "str_replace", "replacements": occ}
        if occ != count:
            raise ValueError(f"str_replace: expected {count} occurrences, found {occ} — expand old_str for uniqueness or use count=-1")
        return old_text.replace(old_str, new_str, count), {"action": "str_replace", "replacements": count}

    if act == "str_replace_ctx":
        old_str = edit.get("old_str", "")
        new_str = edit.get("new_str", "")
        before  = edit.get("before_context", []) or []
        after   = edit.get("after_context", []) or []
        if not old_str:
            raise ValueError("str_replace_ctx: old_str required")
        if not before and not after:
            raise ValueError(
                "str_replace_ctx: provide at least one of before_context or "
                "after_context (otherwise just use str_replace)"
            )
        offs = _find_str_with_context(old_text, old_str, before, after)
        if len(offs) == 0:
            naked = old_text.count(old_str)
            raise ValueError(
                f"str_replace_ctx: no match with provided context "
                f"(target alone has {naked} occurrence(s) — "
                f"verify before_context/after_context lines exactly)"
            )
        if len(offs) > 1:
            line_nums = [old_text[:o].count("\n") + 1 for o in offs]
            raise ValueError(
                f"str_replace_ctx: still ambiguous — {len(offs)} matches at "
                f"lines {line_nums}. Add more context lines to disambiguate."
            )
        off = offs[0]
        new_text = old_text[:off] + new_str + old_text[off + len(old_str):]
        return new_text, {
            "action": "str_replace_ctx", "replacements": 1,
            "match_offset": off,
            "match_line": old_text[:off].count("\n") + 1,
        }

    if act == "regex":
        pattern = edit.get("pattern", "")
        repl = edit.get("replacement", "")
        count = int(edit.get("count", 0))  # 0 = all
        # -1 (« toutes », comme str_replace) : ``subn(count=-1)`` ne remplace
        # RIEN — « pattern matched 0 times ».
        if count < 0:
            count = 0
        flags_str = (edit.get("flags") or "").lower()
        if not pattern:
            raise ValueError("regex: pattern required")
        fl = 0
        if "i" in flags_str: fl |= re.IGNORECASE
        if "m" in flags_str: fl |= re.MULTILINE
        if "s" in flags_str: fl |= re.DOTALL
        try:
            _check_regex_safe(pattern)
            pat = re.compile(pattern, fl)
        except re.error as e:
            raise ValueError(f"regex: bad pattern ({e})")
        new_text, n = pat.subn(repl, old_text, count=count)
        if n == 0:
            raise ValueError("regex: pattern matched 0 times — check pattern or flags")
        return new_text, {"action": "regex", "replacements": n}

    if act == "insert":
        content = edit.get("content", edit.get("new_str", ""))
        if content == "":
            raise ValueError("insert: content required")
        if not content.endswith("\n"):
            content += "\n"
        start_line = int(edit.get("start_line", -1))
        lines = old_text.splitlines(keepends=True)
        if start_line == -1:
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.append(content)
        elif start_line == 0:
            lines.insert(0, content)
        else:
            if start_line < 1:
                raise ValueError("insert: start_line must be 0 (prepend), -1 (append), or 1-based")
            idx = min(start_line - 1, len(lines))
            # Insertion APRÈS la dernière ligne d'un fichier sans saut de ligne
            # final : sans cette garde, le contenu se collerait à cette ligne
            # (« b = 2c = 3 »). Même garde que l'append (-1).
            if idx == len(lines) and lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.insert(idx, content)
        return "".join(lines), {"action": "insert", "at": start_line}

    if act == "delete":
        start_line = int(edit.get("start_line", 0))
        end_line = int(edit.get("end_line", 0) or start_line)
        if start_line < 1:
            raise ValueError("delete: start_line required (1-based)")
        lines = old_text.splitlines(keepends=True)
        total = len(lines)
        s = start_line - 1
        if s >= total:
            raise ValueError(f"delete: start_line {start_line} > total {total}")
        e = min(end_line, total)
        removed = e - s
        del lines[s:e]
        return "".join(lines), {"action": "delete", "lines_removed": removed}

    if act == "replace":
        start_line = int(edit.get("start_line", 0))
        end_line = int(edit.get("end_line", 0) or start_line)
        content = edit.get("content", edit.get("new_str", ""))
        if start_line < 1:
            raise ValueError("replace: start_line required")
        lines = old_text.splitlines(keepends=True)
        total = len(lines)
        s = start_line - 1
        if s >= total:
            raise ValueError(f"replace: start_line {start_line} > total {total}")
        e = min(end_line, total)
        chunk = content if content.endswith("\n") else content + "\n"
        lines[s:e] = [chunk] if content else []
        return "".join(lines), {"action": "replace", "lines_replaced": e - s}

    # ── anchor: insert content before/after a regex or string anchor ────
    # Stable across previous insertions (unlike line numbers which shift).
    # Useful for adding imports, decorators, or boilerplate at known marks.
    if act == "anchor":
        anchor_str = edit.get("anchor_str", "")
        anchor_re  = edit.get("anchor_re", "")
        position   = (edit.get("position") or "after").lower()
        occurrence = int(edit.get("occurrence", 1))
        content    = edit.get("content", edit.get("new_str", ""))
        if position not in ("before", "after"):
            raise ValueError("anchor: position must be 'before' or 'after'")
        # ``occurrence=-1`` (« la dernière », documenté) : résolu ici pour
        # tous les chemins (action simple comme ``multi``), par
        # ``_resolve_anchor`` avec le même finder.
        if not content:
            raise ValueError("anchor: content required")
        # Snap to a clean line boundary so anchor edits don't split a line.
        try:
            line_idx, byte_idx = _resolve_anchor(
                old_text, anchor_str=anchor_str, anchor_re=anchor_re,
                anchor_pos=position, occurrence=occurrence,
            )
        except ValueError as e:
            raise ValueError(str(e))
        # Move byte_idx to the start of the next line for "after" — sauf s'il
        # y est DÉJÀ (ancre terminée par « \n ») : chercher le saut suivant
        # sauterait toute une ligne et insérerait une ligne trop bas.
        if position == "after" and not (byte_idx > 0 and old_text[byte_idx - 1] == "\n"):
            nl = old_text.find("\n", byte_idx)
            byte_idx = (nl + 1) if nl >= 0 else len(old_text)
        else:  # before — start of the matched line
            # Walk back to the previous newline
            prev_nl = old_text.rfind("\n", 0, byte_idx)
            byte_idx = (prev_nl + 1) if prev_nl >= 0 else 0
        if not content.endswith("\n"):
            content += "\n"
        new_text = old_text[:byte_idx] + content + old_text[byte_idx:]
        return new_text, {
            "action": "anchor",
            "position": position,
            "anchor_line": line_idx,
            "occurrence": occurrence,
        }

    # ── indent: re-indent a range of lines by N spaces ──────────────────
    # Positive `indent_delta` adds spaces; negative removes (only if all
    # affected lines have at least that many leading spaces — fails clean).
    if act == "indent":
        start_line = int(edit.get("start_line", 0))
        end_line   = int(edit.get("end_line", 0) or start_line)
        delta      = int(edit.get("indent_delta", 0))
        if start_line < 1:
            raise ValueError("indent: start_line required (1-based)")
        if delta == 0:
            return old_text, {"action": "indent", "lines_changed": 0, "delta": 0}
        lines = old_text.splitlines(keepends=True)
        total = len(lines)
        s = start_line - 1
        if s >= total:
            raise ValueError(f"indent: start_line {start_line} > total {total}")
        e = min(end_line, total)
        if delta > 0:
            pad = " " * delta
            for i in range(s, e):
                if lines[i].strip():  # don't indent blank lines
                    lines[i] = pad + lines[i]
        else:
            need = -delta
            for i in range(s, e):
                if not lines[i].strip():
                    continue
                lead = len(lines[i]) - len(lines[i].lstrip(" "))
                if lead < need:
                    raise ValueError(
                        f"indent: line {i+1} has {lead} leading spaces, "
                        f"can't dedent by {need} (would corrupt structure)"
                    )
            for i in range(s, e):
                if lines[i].strip():
                    lines[i] = lines[i][need:]
        return "".join(lines), {
            "action": "indent",
            "lines_changed": e - s,
            "delta": delta,
        }

    raise ValueError(f"unknown action '{act}' — use str_replace|regex|insert|delete|replace|anchor|indent")


# ── Registration ─────────────────────────────────────────────────────────────

def register(mcp: FastMCP, root_base: Path, max_write_chars: int = MAX_WRITE_CHARS) -> None:
    root_base = root_base.resolve()
    # Sidecar des verrous optimistes (cf. _optimistic_write_lock) : même
    # racine que les sandboxes (APP_SANDBOX_DIR), dossier caché partagé —
    # celui de ``shared_infra.sandbox.file_lock`` (verrou commun avec
    # l'éditeur).
    global _WRITE_LOCKS_BASE
    try:
        from shared_infra.sandbox.file_lock import _locks_base
        _WRITE_LOCKS_BASE = _locks_base()
    except Exception:
        _WRITE_LOCKS_BASE = None

    def _sandbox(username: str) -> Path:
        # Nom de dossier via la source unique (``shared_infra.config``) pour rester
        # aligné avec l'arbo du front, le bridge d'exec et le nom du container.
        try:
            from shared_infra.config import safe_sandbox_name as _ssn
            safe = _ssn(username)
        except Exception:
            safe = "".join(c for c in (username or "") if c.isalnum() or c in "-_") or "guest"
        base = Path(os.environ.get("APP_SANDBOX_DIR") or str(root_base)).resolve()
        # La racine que voit l'agent (montée sur ``/work``) est ``P/work`` ;
        # ``skills`` et ``.memory`` restent à ``P``, HORS du mont. Migration
        # une-fois de l'ancienne arbo plate.
        from shared_infra.sandbox import ensure_work_subdir
        return ensure_work_subdir(base / safe)

    # ── 1. read_file ─────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_RO)
    def read_file(
        ctx: Context,
        path: str = "",
        paths: List[str] = [],
        max_chars: int = 20_000,
        start_line: int = 0,
        end_line: int = 0,
        head: int = 0,
        tail: int = 0,
        grep: str = "",
        grep_context: int = 0,
        ignore_case: bool = True,
        with_line_numbers: bool = True,
        line_ranges: List[List[int]] = [],
        offset: int = 0,
        length: int = 0,
        encoding: str = "",
        format: Literal["", "json", "yaml"] = "",
        as_base64: bool = False,
    ) -> Union[ReadFileResult, ErrEnvelope]:
        """Smart file reader — single or batch. Auto-truncates oversized text.

Single file:
  read_file(path="src/main.py")
  read_file(path="big.log", tail=200)
  read_file(path="config.json", format="json")
  read_file(path="src/main.py", grep="def ", grep_context=2)

Batch (one call, N files):
  read_file(paths=["src/a.py", "src/b.py", "src/c.py"])
  → returns {ok, count, files: {<path>: <result_dict>, ...}}
  All other params (head, grep, max_chars, …) apply to EVERY path.
  Independent failures don't abort siblings. Max 20 paths per call.
  Use this whenever you'd otherwise chain ≥2 read_file calls.

Text modes (use ONE per call):
  start_line/end_line : 1-based inclusive slice
  head=N / tail=N     : first / last N lines
  grep='pat'          : regex filter within THIS file (grep_context=N for
                        surrounding lines). For cross-file search use
                        list_files(search_text=…); for structure use code().
  line_ranges=[[s,e],...] : multi-span read in one call
  format='json'|'yaml': validate + pretty-print structured data

Auto-truncation:
  When NO explicit mode is set and the file body exceeds max_chars
  (default 20_000), the response is automatically a head+tail preview
  (format="auto_truncated") with a hint listing the ways to drill down.
  Pass max_chars=<huge> to force the full content.

Binary modes:
  offset/length       : read byte range (returned as base64)
  (huge bin, no args) : hexdump preview of first 512 bytes

Options:
  with_line_numbers   : ON BY DEFAULT — each line is prefixed `number<TAB>`.
                        NEVER include these prefixes in str_replace's
                        old_str/new_str (everything after the tab is the real
                        content). Pass with_line_numbers=false for raw text
                        (e.g. before copying a whole block verbatim).
  as_base64           : force base64 even for text (safe embedding)
  encoding            : override encoding detection

Always returns: sha256, mime, size, type, encoding (text), total_lines (text).
Use the returned sha256 as `expected_sha256` in edit_file/write_file for
race-free edits — the success returns also expose `next_expected_sha256`."""
        _username = get_username(ctx)
        # Params hors schéma (code() porte l'outline, l'auto-troncature
        # couvre le résumé) : le worker garde la capacité.
        summary = False
        include_outline = False
        try:
            sb = _sandbox(_username)
            esp = Espace(_username, sb)
            # Coercition « modèle imparfait » : liste JSON-encodée en string.
            line_ranges = as_list(line_ranges) or []
            paths = as_list(paths) or []

            # ── Batch dispatch ───────────────────────────────────────
            if paths:
                if path:
                    return _err("conflict",
                                hint="Pass either path=<single> OR paths=[...], not both.")
                if len(paths) > MAX_BATCH_PATHS:
                    return _err("too_many_paths",
                                hint=f"Max {MAX_BATCH_PATHS} paths per call. "
                                     "Split across multiple calls if needed.")
                files_out: Dict[str, Any] = {}
                ok_count = 0
                for pth in paths:
                    if not isinstance(pth, str) or not pth:
                        files_out[str(pth)] = _err("bad_path",
                                                   hint="Each entry must be a non-empty string.")
                        continue
                    res = _read_one_file(
                        pth, max_chars, start_line, end_line, head, tail,
                        grep, grep_context, ignore_case, with_line_numbers,
                        line_ranges, offset, length, encoding, format,
                        as_base64, summary, include_outline, sb, esp,
                    )
                    files_out[pth] = res
                    if res.get("ok"):
                        ok_count += 1
                return _ok(action="batch_read",
                           count=len(paths), succeeded=ok_count,
                           failed=len(paths) - ok_count,
                           files=files_out)

            # ── Single-file path ─────────────────────────────────────
            if not path:
                return _err("path_required",
                            hint="Pass path=<file> or paths=[<file1>, <file2>, ...].")
            return _read_one_file(
                path, max_chars, start_line, end_line, head, tail,
                grep, grep_context, ignore_case, with_line_numbers,
                line_ranges, offset, length, encoding, format,
                as_base64, summary, include_outline, sb, esp,
            )
        except ValueError as e:
            return _err(str(e), hint="Verify path & params.")
        except Exception as e:
            return _err(f"unexpected: {e}")

    # Internal worker for read_file (single and batch paths), takes a pre-resolved sb.
    def _read_one_file(
        path: str,
        max_chars: int,
        start_line: int,
        end_line: int,
        head: int,
        tail: int,
        grep: str,
        grep_context: int,
        ignore_case: bool,
        with_line_numbers: bool,
        line_ranges: List[List[int]],
        offset: int,
        length: int,
        encoding: str,
        format: str,
        as_base64: bool,
        summary: bool,
        include_outline: bool,
        sb: Path,
        esp: Espace,
    ) -> Dict[str, Any]:
        rel = _rel(sb, path)
        p = sb / rel if rel else sb
        try:
            e = esp.stat(rel)
            if e["kind"] == "missing":
                parent = os.path.dirname(rel)
                existe = not parent or esp.stat(parent)["kind"] == "dir"
                return _err("not_found", hint=f"Check path; nearest existing parent: {_to_container(p.parent if existe else sb, sb)}", path=_to_container(p, sb))
            if e["kind"] == "dir":
                return _err("is_directory", hint="Use list_files for directories.", path=_to_container(p, sb))
            if e["kind"] != "file":
                return _err("not_a_regular_file",
                            hint="FIFOs, sockets, device files and symlinks leaving /work are not read.",
                            path=_to_container(p, sb))
            info = _stat_entree(p, sb, e)
            info["mime"] = _mime(p)
            st_size = info["size"]
            # Jusqu'à _STREAM_READ_OVER : le fichier en un aller-retour ; au-delà,
            # l'en-tête seul, puis des plages (jamais chargé en entier).
            raw = esp.lire(rel, max_bytes=_STREAM_READ_OVER).data if st_size <= _STREAM_READ_OVER else None
            tete = raw[:8192] if raw is not None else esp.lire(rel, length=8192, max_bytes=8192).data
            is_text = _is_text_bytes(tete)
            info["type"] = "text" if is_text else "binary"

            # ── BINARY ──────────────────────────────────────────────────
            if not is_text and not as_base64:
                info["sha256"] = (_sha256_bytes(raw) if raw is not None
                                  else esp.stat(rel, hash=True, hash_max=_HASH_MAX).get("sha256", ""))
                if offset or length:
                    n = min(length or MAX_FILE_BIN, MAX_FILE_BIN)
                    debut_b = max(0, offset)
                    data = (raw[debut_b:debut_b + n] if raw is not None
                            else esp.lire(rel, offset=debut_b, length=n, max_bytes=n).data)
                    return _ok(**info, format="bytes_range",
                               offset=offset, length=len(data),
                               b64=base64.b64encode(data).decode("ascii"))
                if raw is not None and len(raw) <= MAX_FILE_BIN:
                    return _ok(**info, format="base64",
                               b64=base64.b64encode(raw).decode("ascii"))
                preview = tete[:BIN_PREVIEW_BYTES]
                return _ok(**info, format="preview",
                           hint=f"Binary too large ({st_size} B). Use offset/length for range reads.",
                           preview_bytes=len(preview),
                           preview_hex=preview.hex(),
                           preview_b64=base64.b64encode(preview).decode("ascii"))

            # ── TEXT ────────────────────────────────────────────────────
            enc = encoding or _encodage(tete)
            info["encoding"] = enc
            # Gros fichier texte : lecture en FLUX (cf. _read_large_text),
            # jamais chargé en entier.
            if raw is None:
                if as_base64 or format or line_ranges:
                    return _err("too_large_for_mode",
                                hint=(f"File is {st_size} bytes: as_base64/format/line_ranges "
                                      "need the whole file. Use head, tail, start_line/end_line "
                                      "or grep (streamed)."), **info)
                try:
                    return _read_large_text(
                        lambda: _flux(esp, rel), info, enc=enc, head=head, tail=tail,
                        start_line=start_line, end_line=end_line, grep=grep,
                        grep_context=grep_context, ignore_case=ignore_case,
                        with_line_numbers=with_line_numbers, max_chars=max_chars)
                except re.error as e:
                    return _err(f"bad_regex: {e}", hint="Escape special chars with \\ .", **info)
        except AgentError as e:
            return _err_agent(e, p, sb)
        try:
            text = raw.decode(enc, errors="replace")
        except Exception as e:
            return _err(f"decode_failed: {e}",
                        hint="Try as_base64=True, or specify encoding=...", **info)

        info["sha256"] = _sha256_bytes(raw)
        # Décodage avec remplacement (octets non UTF-8 → U+FFFD), CRLF et
        # BOM sont signalés (``lossy``, ``line_endings``, ``bom``) : sans quoi
        # le modèle réécrirait ensuite le fichier en LF/UTF-8 sans BOM, ou en
        # perdant les octets remplacés.
        info.update(_text_conventions(raw, text, enc, explicit=bool(encoding)))

        # as_base64 force for text
        if as_base64:
            return _ok(**info, format="base64",
                       b64=base64.b64encode(raw).decode("ascii"))

        if text.startswith("\ufeff"):
            text = text[1:]

        lines = text.splitlines()
        total_lines = len(lines)
        info["total_lines"] = total_lines

        is_minified = total_lines <= 3 and len(text) > MINIFIED_LINE_MIN
        if is_minified:
            info["minified"] = True

        max_chars = max(1, min(max_chars, MAX_READ_CHARS))

        # ── summary / include_outline (compact overview) ────────────
        # Cheap mode for big files: returns head + tail + line count + outline
        # without paying the cost of streaming the whole text.
        if summary or include_outline:
            lang = _ci.detect_language(p.name) if _HAS_CI else "unknown"
            result = {**info, "format": "summary" if summary else "outline_only"}
            if summary:
                head_n = 30
                tail_n = 10
                if total_lines <= head_n + tail_n:
                    body = text
                    if with_line_numbers:
                        body = _format_lines(lines, 1, True)
                    result["content"] = body
                else:
                    head_lines = lines[:head_n]
                    tail_lines = lines[-tail_n:]
                    if with_line_numbers:
                        h_str = _format_lines(head_lines, 1, True)
                        t_str = _format_lines(tail_lines, total_lines - tail_n + 1, True)
                    else:
                        h_str = "\n".join(head_lines)
                        t_str = "\n".join(tail_lines)
                    omitted = total_lines - head_n - tail_n
                    result["content"] = (
                        h_str + f"\n... [{omitted} lines omitted] ...\n" + t_str
                    )
                    result["head_lines"] = head_n
                    result["tail_lines"] = tail_n
                    result["omitted_lines"] = omitted
            if include_outline:
                if not _HAS_CI or lang == "unknown":
                    result["outline"] = []
                    result["outline_note"] = (
                        f"language '{lang}' not supported by code_intel"
                        if _HAS_CI else "code_intel module not loaded"
                    )
                else:
                    result["outline"] = _ci.outline(text, lang)
                    result["outline_summary"] = _ci.summarize_structure(text, lang)
            result["language"] = lang
            return _ok(**result)

        # ── structured format (json/yaml) ───────────────────────
        if format in ("json", "yaml"):
            if format == "json":
                try:
                    parsed = json.loads(text)
                    pretty = json.dumps(parsed, indent=2, ensure_ascii=False)
                except json.JSONDecodeError as e:
                    return _err(f"invalid_json: {e.msg} at line {e.lineno} col {e.colno}",
                                hint=f"Error at line {e.lineno}. Read that range first.", **info)
                content, trunc = _trunc(pretty, max_chars)
                return _ok(**info, format="json", valid=True,
                           content=content, truncated=trunc)
            # yaml
            try:
                import yaml  # optional dep
                parsed = yaml.safe_load(text)
                pretty = yaml.safe_dump(parsed, default_flow_style=False, allow_unicode=True, sort_keys=False)
            except ImportError:
                return _err("yaml_not_installed", hint="pip install pyyaml, or use format=''.")
            except Exception as e:
                return _err(f"invalid_yaml: {e}", hint="Check indentation and special chars.", **info)
            content, trunc = _trunc(pretty, max_chars)
            return _ok(**info, format="yaml", valid=True, content=content, truncated=trunc)

        # ── line_ranges (multi-span) ────────────────────────────
        if line_ranges:
            spans = []
            seen_lines = set()
            merged = []
            for rng in line_ranges:
                try:
                    s = max(int(rng[0]) - 1, 0)
                    e = int(rng[1]) if len(rng) > 1 and int(rng[1]) > 0 else total_lines
                except Exception:
                    return _err("bad_line_range", hint="line_ranges=[[start,end],...] (1-based inclusive)")
                e = min(e, total_lines)
                if s >= total_lines: continue
                merged.append((s, e))
            merged.sort()
            parts = []
            last_end = -1
            for s, e in merged:
                for i in range(s, e):
                    if i in seen_lines: continue
                    seen_lines.add(i)
                if last_end >= 0 and s > last_end:
                    parts.append(f"...[lines {last_end+1}-{s} omitted]...")
                sliced = lines[s:e]
                parts.append(_format_lines(sliced, s + 1, with_line_numbers))
                spans.append({"start": s + 1, "end": e, "lines": len(sliced)})
                last_end = max(last_end, e)
            content, trunc = _trunc("\n".join(parts), max_chars)
            return _ok(**info, format="ranges", spans=spans,
                       shown_lines=len(seen_lines),
                       content=content, truncated=trunc)

        # ── grep mode ───────────────────────────────────────────
        if grep:
            flags = re.IGNORECASE if ignore_case else 0
            try:
                _check_regex_safe(grep)
                pat = re.compile(grep, flags)
            except re.error as e:
                return _err(f"bad_regex: {e}", hint="Escape special chars with \\ .", **info)
            hits = set(i for i, ln in enumerate(lines, 1) if pat.search(ln))
            if not hits:
                return _ok(**info, format="grep", matches=0, content="", hint="no matches")
            if grep_context > 0:
                expanded = set()
                for i in hits:
                    expanded.update(range(max(1, i-grep_context), min(total_lines, i+grep_context)+1))
                display = sorted(expanded)
            else:
                display = sorted(hits)
            out, prev = [], 0
            for i in display:
                if prev and i - prev > 1: out.append("--")
                sep = ":" if i in hits else "-"
                out.append(f"{i}{sep}{lines[i-1]}")
                prev = i
            content, trunc = _trunc("\n".join(out), max_chars)
            return _ok(**info, format="grep", matches=len(hits),
                       shown_lines=len(display), content=content, truncated=trunc)

        # ── head ────────────────────────────────────────────────
        if head > 0:
            n = min(head, total_lines)
            sliced = lines[:n]
            content, trunc = _trunc(_format_lines(sliced, 1, with_line_numbers), max_chars)
            return _ok(**info, format="head", shown_lines=len(sliced),
                       content=content, truncated=trunc)

        # ── tail ────────────────────────────────────────────────
        if tail > 0:
            n = min(tail, total_lines)
            sliced = lines[-n:] if n else []
            start = total_lines - n + 1 if n else 1
            content, trunc = _trunc(_format_lines(sliced, start, with_line_numbers), max_chars)
            return _ok(**info, format="tail", shown_lines=len(sliced),
                       start_line=start, content=content, truncated=trunc)

        # ── explicit line range ─────────────────────────────────
        if start_line > 0 or end_line > 0:
            s = max(start_line - 1, 0)
            e = end_line if end_line > 0 else total_lines
            sliced = lines[s:e]
            content, trunc = _trunc(_format_lines(sliced, s + 1, with_line_numbers), max_chars)
            return _ok(**info, format="range", start=s + 1, end=min(e, total_lines),
                       shown_lines=len(sliced), content=content, truncated=trunc)

        # ── Auto-truncate large / minified files (no explicit mode) ─
        # Triggers when the body would exceed `max_chars`. Returns a
        # head+tail preview instead of a tail-clipped dump, so the LLM
        # gets both ends (imports + bottom of file) and a clear hint
        # for how to drill down.
        text_len = len(text)
        if is_minified:
            preview = text[:2000] + "\n...[MINIFIED OMITTED]...\n" + text[-1000:]
            return _ok(**info, format="preview",
                       hint="Minified file. Use grep or start_line/end_line ranges.",
                       content=preview)
        if text_len > max_chars or st_size > MAX_FILE_TEXT:
            if total_lines <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES:
                content = _format_lines(lines, 1, with_line_numbers)
            else:
                head_txt = _format_lines(lines[:PREVIEW_HEAD_LINES], 1, with_line_numbers)
                tail_start = total_lines - PREVIEW_TAIL_LINES + 1
                tail_txt = _format_lines(lines[-PREVIEW_TAIL_LINES:], tail_start, with_line_numbers)
                omitted = total_lines - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES
                content = (
                    f"{head_txt}\n"
                    f"... [{omitted} lines omitted — file is {text_len:,} chars / "
                    f"{total_lines} lines total] ...\n"
                    f"{tail_txt}"
                )
            return _ok(**info, format="auto_truncated",
                       head_lines=min(PREVIEW_HEAD_LINES, total_lines),
                       tail_lines=min(PREVIEW_TAIL_LINES, total_lines),
                       omitted_lines=max(0, total_lines - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES),
                       content=content,
                       hint=(f"File exceeds max_chars={max_chars}. To get specifics: "
                             "head=N, tail=N, start_line/end_line, grep='...', "
                             f"or line_ranges=[[s,e]]. To force full content: "
                             f"max_chars={text_len + 1}."))

        # ── Default ─────────────────────────────────────────────
        content = _format_lines(lines, 1, True) if with_line_numbers else text
        return _ok(**info, format="text", content=content, truncated=False)

    # ── 2. write_file ────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_IDEMP)
    def write_file(
        ctx: Context,
        path: str,
        content: str = "",
        mode: Literal["write", "append", "b64"] = "write",
        b64: str = "",
        encoding: str = "utf-8",
        expected_sha256: str = "",
        backup: bool = False,
        dry_run: bool = False,
    ) -> Union[WriteFileResult, ErrEnvelope]:
        """Write a file atomically. Modes: write|append|b64.
Parent dirs are created automatically; for an EMPTY dir use
manage_files(action='mkdir').

Safety:
  expected_sha256 : if set AND file exists, fail on hash mismatch (optimistic lock).
                     Use empty string for 'create new / accept any existing'.
  backup=True     : copy existing file to <path>.bak before writing.
  dry_run=True    : compute what would happen (bytes, sha, diff) without writing.

On success, the result includes `next_expected_sha256` — pass it as
`expected_sha256` on your NEXT edit/write to this file to detect
concurrent modifications.

For surgical edits on large files, prefer edit_file."""
        _username = get_username(ctx)
        try:
            sb = _sandbox(_username)
            esp = Espace(_username, sb)
            rel = _rel(sb, path)
            p = sb / rel if rel else sb
            mode = (mode or "write").strip().lower()
            # Avant toute création : détecte un « jumeau unicode » (nom ne
            # différant que par accents/casse d'un frère existant) sur les
            # composants encore inexistants du chemin. Averti, jamais bloquant.
            _twin = esp.jumeau_unicode(rel)
            _twin_kw = {"warning": _twin} if _twin else {}

            if mode == "mkdir":
                # mkdir vit dans manage_files. Garde douce pour un vieux
                # client qui contournerait l'enum du schéma.
                return _err("mkdir_moved",
                            hint="Utilise manage_files(action='mkdir', path=…). "
                                 "write_file crée de toute façon les dossiers parents.")

            # Optimistic lock for existing files
            _etat = _actuel(esp, rel)
            _e, old_raw, old_sha = _etat
            from shared_infra.sandbox.file_history import TOO_BIG as _TOO_BIG
            _gros = old_raw is _TOO_BIG             # trop gros pour être relu
            _avant_n = int(_e.get("size") or 0) if old_raw is not None else 0
            if old_sha:
                if expected_sha256 and expected_sha256 != old_sha:
                    return _err("hash_mismatch",
                                hint="File changed since read. Re-read then retry.",
                                expected=expected_sha256, actual=old_sha)

            if mode == "b64":
                if not b64: return _err("b64_required", hint="Provide base64-encoded bytes.")
                try:
                    data = base64.b64decode(b64.encode("ascii"), validate=True)
                except Exception as e:
                    return _err(f"bad_b64: {e}", hint="Ensure valid base64 (no line breaks, padding OK).")
                if len(data) > MAX_FILE_BIN:
                    return _err("too_large", hint=f"Max {MAX_FILE_BIN} bytes.",
                                bytes=len(data), max=MAX_FILE_BIN)
                new_sha = _sha256_bytes(data)
                if dry_run:
                    return _ok(path=_to_container(p, sb), action="b64_write", dry_run=True,
                               bytes_before=_avant_n,
                               bytes_after=len(data), old_sha256=old_sha, new_sha256=new_sha)
                if backup and old_raw is not None and (_bk := _sauvegarde(esp, rel)):
                    return _bk
                # Précondition vérifiée par l'agent au remplacement (ferme le
                # TOCTOU du contrôle de tête) ; verrou partagé avec l'éditeur.
                _r, _lock_err = _ecrire_garde(esp, _username, sb, p, rel, data, etat=_etat,
                                              expected_sha256=expected_sha256)
                if _lock_err is not None:
                    return _lock_err
                return _ok(path=_to_container(p, sb), bytes=_r["size"],
                           action="b64_write", old_sha256=old_sha, new_sha256=new_sha,
                           next_expected_sha256=new_sha, **_twin_kw)

            if mode not in ("write", "append"):
                # Ne JAMAIS citer `mkdir` ici : il vit dans manage_files (cf.
                # la garde `mkdir_moved` plus haut). Renvoyer le modèle vers le
                # mode qu'on vient de lui refuser le fait boucler.
                return _err("invalid_mode", hint="Use: write|append|b64 "
                                                 "(mkdir → manage_files).")

            limit = min(max_write_chars, MAX_WRITE_CHARS)
            if len(content) > limit:
                return _err("too_large", hint=f"Max {limit} chars. Split into multiple writes or use edit_file.",
                            chars=len(content), max=limit)

            _enc_out = encoding          # "utf-8-sig" si le BOM est conservé
            _conv: Dict[str, Any] = {}   # conventions conservées (bom, line_endings)
            _base_sha: Optional[str] = None   # append : contenu dont on part

            # Capture du contenu ANCIEN avant écriture, pour stats +X/-Y.
            # En mode 'append' on l'a déjà lu juste en-dessous (réutilisé via
            # `old`). En mode 'write' sur un fichier existant on le lit ici.
            # Pour un nouveau fichier, old_text reste "" -> stats=(N, 0).
            old_text_for_stats = ""
            if mode == "append" and _gros:
                return _err("too_large", hint="File too large to append in place: use "
                            "execute_shell (>>) instead. Nothing was written.", bytes=_avant_n)
            if mode == "append" and old_raw is not None:
                # L'append n'ajoute pas : il RELIT tout, concatène et RÉÉCRIT
                # le fichier entier. Jamais de relecture en ``errors="replace"`` :
                # sur un fichier latin-1 / cp1252 / utf-16, chaque octet non
                # décodable deviendrait U+FFFD, et cette version mutilée serait
                # réécrite par-dessus l'original — perte DÉFINITIVE, avec
                # ``ok: true`` en retour. On décode donc en STRICT et on échoue
                # proprement, symétriquement à la garde d'écriture ci-dessous.
                try:
                    old = old_raw.decode(encoding)
                except (UnicodeDecodeError, LookupError) as _dec_err:
                    _off = getattr(_dec_err, "start", None)
                    return _err(
                        "encoding_mismatch",
                        hint=(f"The existing file is not '{encoding}'"
                              + (f" (invalid byte at offset {_off})"
                                 if _off is not None else "")
                              + ". Re-run with the right encoding= "
                                "(e.g. 'latin-1'), or mode='b64' for binary. "
                                "Nothing was written."),
                        encoding=encoding,
                        offset=(_off if _off is not None else -1))
                _base_sha = old_sha
                # Un fichier CRLF garde ses CRLF sur la partie ajoutée.
                if _crlf_dominant(old) and "\n" in content and "\r\n" not in content:
                    content = content.replace("\n", "\r\n")
                    _conv["line_endings"] = "crlf"
                new_content = old + content
                old_text_for_stats = old
            elif mode == "write" and old_raw is not None and not _gros:
                # L'écrasement complet garde le BOM et les CRLF dominants du
                # fichier (le modèle émet du LF sans BOM), et ne réécrit pas en
                # UTF-8 un fichier latin-1 dont le modèle n'a lu qu'une version
                # « réparée » (U+FFFD).
                _old_raw = old_raw
                _is_utf8 = encoding.lower().replace("_", "-") in ("utf-8", "utf8")
                _had_bom = _is_utf8 and _old_raw.startswith(b"\xef\xbb\xbf")
                try:
                    old_text_for_stats = _old_raw.decode("utf-8-sig" if _had_bom else encoding)
                except (UnicodeDecodeError, LookupError) as _dec_err:
                    _off = getattr(_dec_err, "start", None)
                    return _err(
                        "encoding_mismatch",
                        hint=(f"The existing file is not valid '{encoding}'"
                              + (f" (invalid byte at offset {_off})" if _off is not None else "")
                              + ": overwriting it would silently change its encoding. Check "
                                "the encoding (read_file reports lossy=true), then re-run with "
                                "encoding='latin-1' (or 'cp1252') to keep it, or delete the "
                                "file first (manage_files action='delete') to recreate it in "
                                "UTF-8. Nothing was written."),
                        encoding=encoding,
                        offset=(_off if _off is not None else -1))
                new_content = content
                if _had_bom and not new_content.startswith("\ufeff"):
                    _enc_out = "utf-8-sig"
                    _conv["bom"] = True
                if (_crlf_dominant(old_text_for_stats) and "\n" in new_content
                        and "\r\n" not in new_content):
                    new_content = new_content.replace("\n", "\r\n")
                    _conv["line_endings"] = "crlf"
            else:
                new_content = content
            if _conv:
                _conv["note"] = ("The file's existing conventions were kept ("
                                 + ", ".join(("UTF-8 BOM" if k == "bom" else "CRLF line endings")
                                             for k in _conv) + ").")

            # Encodage STRICT : ``errors="replace"`` substituerait en SILENCE
            # les caractères non représentables (→ ``?``/U+FFFD), une
            # corruption invisible du contenu. On échoue avec la position
            # exacte — le modèle corrige ou passe en utf-8/b64.
            try:
                new_bytes = new_content.encode(_enc_out)
            except (UnicodeEncodeError, LookupError) as _enc_err:
                _pos = getattr(_enc_err, "start", None)
                return _err("encoding_mismatch",
                            hint=(f"The content contains characters not representable in "
                                  f"'{encoding}'" + (f" (position {_pos})" if _pos is not None else "")
                                  + ". Use encoding='utf-8' (default) or mode='b64' for binary."),
                            encoding=encoding)
            new_sha = _sha256_bytes(new_bytes)
            if dry_run:
                # En dry-run on calcule aussi les stats : utile pour preview.
                la, lr = _line_diff_stats(old_text_for_stats, new_content)
                return _ok(path=_to_container(p, sb), action=mode, dry_run=True,
                           bytes_before=_avant_n,
                           bytes_after=len(new_bytes),
                           old_sha256=old_sha, new_sha256=new_sha,
                           lines_added=la, lines_removed=lr, **_conv)

            # ── NO-OP : le fichier contient DÉJÀ exactement ce contenu ──
            # On ne réécrit pas (inutile, et ça touche le mtime pour rien)
            # et SURTOUT on renvoie un signal NON AMBIGU. C'est la première
            # cause des boucles write_file : un modèle faible reçoit
            # `ok:true` + `lines_added:0` + `old_sha256==new_sha256`,
            # interprète ça comme « mon écriture n'a pas pris » et
            # rappelle write_file à l'identique — en brûlant tout le
            # budget d'itérations. `action:"noop"` + `unchanged:true` +
            # une note explicite lui disent clairement de passer à la
            # suite.
            if mode == "write" and old_raw is not None and new_sha == old_sha:
                return _ok(
                    path=_to_container(p, sb), action="noop", unchanged=True,
                    bytes=_avant_n,
                    old_sha256=old_sha, new_sha256=new_sha,
                    next_expected_sha256=new_sha,
                    lines_added=0, lines_removed=0,
                    note=("NO-OP: the file already contains EXACTLY this "
                          "content. Nothing was written, nothing changed — "
                          "this is a success. Do NOT call write_file again "
                          "with the same content: move on to the next step."),
                )

            if backup and old_raw is not None and (_bk := _sauvegarde(esp, rel)):
                return _bk
            # Précondition vérifiée par l'agent au remplacement ; en append, la
            # nouvelle version est calculée depuis l'ancienne (stricte).
            _r, _lock_err = _ecrire_garde(esp, _username, sb, p, rel, new_bytes, etat=_etat,
                                          expected_sha256=expected_sha256,
                                          strict=_base_sha is not None)
            if _lock_err is not None:
                return _lock_err

            # Stats +X/-Y exposées au client : permettent à la diff card
            # côté chat d'afficher le détail même quand l'éditeur Monaco
            # est désactivé (pas de snapshot client-side disponible).
            lines_added, lines_removed = _line_diff_stats(old_text_for_stats, new_content)

            return _ok(path=_to_container(p, sb), bytes=_r["size"], action=mode,
                       old_sha256=old_sha, new_sha256=new_sha,
                       next_expected_sha256=new_sha,
                       lines_added=lines_added, lines_removed=lines_removed,
                       **_conv, **_twin_kw)
        except AgentError as e:
            return _err_agent(e, p, sb)
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── 3. edit_file ─────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_IDEMP)
    def edit_file(
        ctx: Context,
        path: str,
        action: Literal[
            "str_replace", "str_replace_ctx", "regex",
            "insert", "delete", "replace",
            "anchor", "indent", "multi",
        ],
        old_str: str = "",
        new_str: str = "",
        start_line: int = 0,
        end_line: int = 0,
        content: str = "",
        count: Optional[int] = None,
        pattern: str = "",
        replacement: str = "",
        flags: str = "",
        edits: List[Dict[str, Any]] = [],
        dry_run: bool = False,
        expected_sha256: str = "",
        anchor_str: str = "",
        anchor_re: str = "",
        position: Literal["before", "after"] = "after",
        occurrence: int = 1,
        indent_delta: int = 0,
        auto_format: bool = False,
        before_context: List[str] = [],
        after_context: List[str] = [],
    ) -> Union[EditFileResult, ErrEnvelope]:
        """Surgical file editor — precise changes without rewriting the whole file.

Actions:
  str_replace     : replace `old_str` by `new_str`. count=1 (default) / -1 (all).
                    Fails if old_str is ambiguous in the file.
  str_replace_ctx : replace `old_str` disambiguated by surrounding context lines.
                    Use when old_str alone matches multiple places. Provide
                    before_context=[...] and/or after_context=[...] (whitespace
                    is normalized for the context match; old_str itself is
                    matched verbatim). Example:
                      edit_file('str_replace_ctx',
                        old_str='return None',
                        new_str='return result',
                        before_context=['result = process(data)'],
                        after_context=['except ValueError:'])
  regex           : replace `pattern` by `replacement` — ALL matches by default
                    (count=N limits to the first N). flags: 'i','m','s'.
  insert      : insert `content` at `start_line` (1-based). 0=prepend, -1=append.
  delete      : remove lines start_line..end_line (1-based inclusive).
  replace     : replace lines start_line..end_line with `content`.
  anchor      : insert `content` before/after a regex or string anchor.
                 Stable across previous edits (NO line numbers needed) — use this
                 instead of `insert` when you want robustness against shifts.
                 Params: anchor_str OR anchor_re, position='after'|'before',
                         occurrence=N (1-based, default 1), content=text.
                 Example: add an import after the last existing import →
                   anchor_re='^from .+ import', position='after', occurrence=-1
                   (-1 = last match — see below).
  indent      : re-indent lines start_line..end_line by `indent_delta` spaces.
                 Positive=add, negative=remove (fails if not enough leading
                 spaces — never silently corrupts).
                 Useful after wrapping a block in `if`/`for`/`try`.
  multi       : apply `edits=[{action:..., ...}, ...]` atomically.
                 Line numbers refer to the file as READ (before the batch):
                 line edits are applied bottom-up, then content edits
                 (str_replace, regex, anchor…) in the given order.
                 If any edit fails, the file is NOT written.

Auto-formatting:
  auto_format=True : after the edit, run `black` (.py), `prettier` (.js/.ts/
                      .json/.md), `shfmt` (.sh) or `yamlfmt` (.yaml) over the
                      result if the binary is installed. Skipped silently
                      otherwise. Avoids formatter-only diffs at commit time.

Safety:
  expected_sha256 : fail if file hash differs (optimistic lock).
  dry_run=True    : compute diff only, don't write.

Returns: diff (unified), old_sha256, new_sha256, bytes_before/after, lines_before/after.
For multi: returns `applied=[{action, ...info}]` with each edit's result."""
        _username = get_username(ctx)
        try:
            sb = _sandbox(_username)
            esp = Espace(_username, sb)
            rel = _rel(sb, path)
            p = sb / rel if rel else sb
            _e = esp.stat(rel)
            if _e["kind"] == "missing": return _err("not_found", path=_to_container(p, sb), hint="Create with write_file first.")
            if _e["kind"] == "dir": return _err("is_directory", path=_to_container(p, sb))
            if int(_e.get("size") or 0) > MAX_EDIT_BYTES:
                return _err("too_large", size=int(_e["size"]), max=MAX_EDIT_BYTES,
                            hint="Split the edit or use write_file to replace whole file.")
            _etat = _actuel(esp, rel, _e, max_contenu=MAX_EDIT_BYTES)
            _e, raw, old_sha = _etat
            if raw is None:
                return _err("not_found", path=_to_container(p, sb), hint="Create with write_file first.")
            if expected_sha256 and expected_sha256 != old_sha:
                return _err("hash_mismatch", expected=expected_sha256, actual=old_sha,
                            hint="File changed since read. Re-read then retry.")
            # ── Décodage tolérant : BOM UTF-8 + fins de ligne CRLF ────────
            # Les deux cassaient le match EXACT de str_replace (le modèle
            # émet du \n sans BOM) et faisaient échouer des éditions
            # parfaitement légitimes. On normalise en interne (\n, sans BOM)
            # et on RESTAURE la forme d'origine à l'écriture — le fichier
            # garde ses conventions, le modèle raisonne en \n.
            _had_bom = raw.startswith(b"\xef\xbb\xbf")
            try:
                old_text_raw = raw.decode("utf-8-sig" if _had_bom else "utf-8")
            except UnicodeDecodeError:
                return _err("not_utf8", hint="edit_file requires UTF-8. Use write_file(mode='b64') for binaries.")
            _had_crlf = "\r\n" in old_text_raw
            # Restaurer CRLF à l'écriture SEULEMENT si le fichier est
            # HOMOGÈNE CRLF (aucun \n isolé). Un CRLF présent ne suffit pas :
            # un fichier à fins MIXTES (qq lignes CRLF + 100 lignes LF)
            # verrait ses 100 lignes LF converties en CRLF à l'écriture,
            # masqué dans le diff (calculé sur le texte normalisé) → 100
            # changements de fin de ligne parasites en base/git. En mixte on
            # écrit en LF (normalise les rares CRLF, changement minime).
            _lone_lf = old_text_raw.count("\n") - old_text_raw.count("\r\n")
            _is_crlf_file = _had_crlf and _lone_lf == 0
            old_text = old_text_raw.replace("\r\n", "\n") if _had_crlf else old_text_raw

            act = (action or "").strip().lower()

            # Coercition « modèle imparfait » : les params STRUCTURÉS arrivent
            # parfois JSON-encodés en string (petit modèle / double sérialisation) :
            # sans re-parse, ValidationError silencieuse. as_list les re-parse.
            edits = as_list(edits) or []
            before_context = [str(x) for x in (as_list(before_context) or [])]
            after_context = [str(x) for x in (as_list(after_context) or [])]

            # Normalise aussi les ENTRÉES texte du modèle (un old_str collé
            # depuis un fichier CRLF doit matcher le texte normalisé).
            if _had_crlf:
                old_str = old_str.replace("\r\n", "\n")
                new_str = new_str.replace("\r\n", "\n")
                content = content.replace("\r\n", "\n")
                # Mêmes champs que ``_norm_edit_crlf`` (lot ``multi``) : sinon
                # un ``replacement`` en CRLF s'écrirait ``\r\r\n`` et un
                # ``anchor_str``/contexte en CRLF ne correspondrait jamais au
                # texte normalisé.
                replacement = replacement.replace("\r\n", "\n")
                anchor_str = anchor_str.replace("\r\n", "\n")
                before_context = [x.replace("\r\n", "\n") for x in before_context]
                after_context = [x.replace("\r\n", "\n") for x in after_context]

            # ── multi: batch of edits ──────────────────────────────
            if act == "multi":
                if not edits:
                    return _err("edits_required", hint="Pass edits=[{action:...}, ...]")
                if len(edits) > MAX_MULTI_EDITS:
                    return _err("too_many_edits", hint=f"Max {MAX_MULTI_EDITS} per call.")
                if _had_crlf:
                    edits = [_norm_edit_crlf(ed) for ed in edits]
                try:
                    _ordre = _order_multi_edits(edits)
                except ValueError as e:
                    return _edit_err(e, prefix="multi: ",
                                     hint="Line numbers in one batch refer to the file as "
                                          "read; make the line ranges disjoint.")
                current = old_text
                applied = []
                for i, ed in _ordre:
                    try:
                        current, info = _apply_one_edit(current, ed)
                        applied.append({"index": i, **info})
                    except ValueError as e:
                        return _edit_err(e, prefix=f"edit {i} failed: ",
                                         hint="All edits aborted; file unchanged. Fix the failing edit and retry.",
                                         failed_index=i, applied_so_far=applied)
                new_text = current

            # ── single-edit actions (delegate to engine) ────────────
            elif act in ("str_replace", "str_replace_ctx", "regex", "insert",
                         "delete", "replace", "anchor", "indent"):
                edit_dict = {"action": act}
                if act == "str_replace":
                    edit_dict.update({"old_str": old_str, "new_str": new_str,
                                      "count": 1 if count is None else count})
                elif act == "str_replace_ctx":
                    edit_dict.update({
                        "old_str": old_str, "new_str": new_str,
                        "before_context": before_context,
                        "after_context": after_context,
                    })
                elif act == "regex":
                    edit_dict.update({"pattern": pattern, "replacement": replacement,
                                      # TOUTES les occurrences par défaut, comme dans
                                      # ``multi`` (le défaut ``count`` partagé avec
                                      # str_replace, 1, ne renommerait que la 1re).
                                      "count": (0 if count is None or count < 0 else count),
                                      "flags": flags})
                elif act == "insert":
                    edit_dict.update({"start_line": start_line,
                                      "content": content or new_str})
                elif act == "delete":
                    edit_dict.update({"start_line": start_line, "end_line": end_line})
                elif act == "replace":
                    edit_dict.update({"start_line": start_line, "end_line": end_line,
                                      "content": content or new_str})
                elif act == "anchor":
                    # ``occurrence=-1`` (« last match ») : résolu par le
                    # moteur, avec le finder qui trouve les ancres.
                    occ = occurrence
                    edit_dict.update({
                        "anchor_str": anchor_str, "anchor_re": anchor_re,
                        "position": position, "occurrence": occ,
                        "content": content or new_str,
                    })
                elif act == "indent":
                    edit_dict.update({"start_line": start_line, "end_line": end_line,
                                      "indent_delta": indent_delta})
                try:
                    new_text, info = _apply_one_edit(old_text, edit_dict)
                    applied = [info]
                except ValueError as e:
                    return _edit_err(e)
            else:
                return _err("invalid_action",
                            hint="Use: str_replace|str_replace_ctx|regex|insert|delete|replace|anchor|indent|multi")

            if new_text == old_text:
                return _ok(path=_to_container(p, sb), action=act, dry_run=dry_run,
                           diff="", old_sha256=old_sha, new_sha256=old_sha,
                           next_expected_sha256=old_sha,
                           bytes_before=len(raw), bytes_after=len(raw),
                           lines_before=_line_count(old_text),
                           lines_after=_line_count(old_text),
                           applied=applied, unchanged=True,
                           note=("NO-OP: the edit yields content IDENTICAL "
                                 "to the current file — nothing changed. "
                                 "Do not retry the same edit: move on to "
                                 "the next step."))

            # ── auto_format hook (post-edit, pre-write) ──────────────
            # If a formatter is available for the file extension, run it
            # over the new content. Failure is silent — never block the edit.
            formatter_used = ""
            if auto_format and not dry_run:
                new_text, formatter_used = _try_format(p, new_text)

            diff = _make_diff(old_text, new_text, rel)

            # ── Restauration des conventions du fichier (CRLF / BOM) ─────
            # CRLF seulement si le fichier lu est HOMOGÈNE CRLF (cf. plus haut).
            out_text = new_text.replace("\n", "\r\n") if _is_crlf_file else new_text
            _enc_out = "utf-8-sig" if _had_bom else "utf-8"
            new_bytes = out_text.encode(_enc_out)
            if len(new_bytes) > MAX_EDIT_BYTES:
                return _err("too_large_after_edit", size=len(new_bytes), max=MAX_EDIT_BYTES,
                            hint="Edit would make file too large.")

            new_sha = _sha256_bytes(new_bytes)
            # Stats +X/-Y dérivées du diff unifié déjà construit. On les
            # expose en plus du `diff` brut pour que le frontend (diff
            # card en mode editor disabled) n'ait pas à parser le diff
            # côté client. Voir aussi write_file.
            lines_added, lines_removed = _line_diff_stats(old_text, new_text)
            result = {
                "path": _to_container(p, sb), "action": act, "dry_run": dry_run, "diff": diff,
                "old_sha256": old_sha, "new_sha256": new_sha,
                "next_expected_sha256": new_sha,
                "bytes_before": len(raw), "bytes_after": len(new_bytes),
                "lines_before": _line_count(old_text),
                "lines_after": _line_count(new_text),
                "lines_added": lines_added,
                "lines_removed": lines_removed,
                "applied": applied,
            }
            if formatter_used:
                result["formatter"] = formatter_used
            if _is_crlf_file:
                result["line_endings"] = "crlf"   # conventions du fichier restaurées
            elif _had_crlf:
                # Fichier à fins de ligne MIXTES → écrit en LF (cf. plus
                # haut). Le diff, calculé sur le texte normalisé, ne le
                # montre pas : on le dit.
                result["line_endings"] = "lf"
                result["normalized_line_endings"] = True
                result["note"] = (
                    f"Line endings were normalized to LF: the file mixed CRLF "
                    f"({old_text_raw.count(chr(13) + chr(10))} lines) and LF "
                    f"({_lone_lf} lines). The diff above does not show this "
                    f"whole-file end-of-line change.")
            if not dry_run:
                # Sha re-vérifié au remplacement (_ecrire_garde).
                # ``new_bytes`` : CRLF et BOM d'origine restaurés.
                # Verrou partagé avec l'éditeur, TOUJOURS, et le contenu
                # dont l'édition est partie (old_sha) est re-vérifié dessous :
                # un enregistrement de l'éditeur intervenu entre-temps n'est
                # jamais écrasé.
                _r, _lock_err = _ecrire_garde(esp, _username, sb, p, rel, new_bytes, etat=_etat,
                                              expected_sha256=expected_sha256, strict=True)
                if _lock_err is not None:
                    return _lock_err
            return _ok(**result)
        except AgentError as e:
            return _err_agent(e, p, sb)
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── 4. list_files ────────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_RO)
    def list_files(
        ctx: Context,
        path: str = ".",
        pattern: str = "",
        search_text: str = "",
        recursive: bool = False,
        ignore_case: bool = True,
        max_results: int = 200,
        details: bool = False,
        exclude: List[str] = [],
        sort_by: Literal["name", "size", "mtime"] = "name",
        include_hidden: bool = False,
        summary: bool = False,
        cursor: str = "",
        since: str = "",
        include_git_status: bool = False,
    ) -> Union[ListFilesResult, ErrEnvelope]:
        """List directory / find by glob / grep file contents / stat one path.

Modes:
  (default)           : list children. recursive=True walks subdirs.
  pattern='*.py'      : glob filter (applies on relative path).
  search_text='foo'   : grep text across files (always recursive under path).
                        With path=<file>, greps inside that single file.
  path=<FILE>         : metadata for that file (size, mtime, mime, encoding,
                        text/binary; sha256 with details=True).

Time filter:
  since='1h'|'7d'|'30m'|'2025-01-01'|<epoch>  : keep only files modified
    after that time. Useful for "what changed recently". Skipped silently
    if the value can't be parsed.

Annotation:
  include_git_status=True : annotate each file with its git porcelain status
    code (e.g. ' M', '??', 'A '). Only adds entries for files actually
    tracked or modified — clean files have no status field. Requires
    `details=True` to be visible (status is added to per-item dicts).
    If no status could be read (not a repo, repo refused, git unavailable),
    `git_status_error` says why: the empty map then means nothing.

Options:
  exclude=['node_modules','.git','*.pyc']  : skip matching paths/names.
  sort_by='name'|'size'|'mtime'            : sort direction (asc by name, desc by size/mtime).
  include_hidden=True                      : show dotfiles.
  summary=True                             : add counts/total size/file-type breakdown.
  cursor='<opaque>'                        : resume from previous truncated call.
  details=True                             : include size/mtime/mode per item.

Returns cursor for pagination when truncated. Pass it back to continue."""
        _username = get_username(ctx)
        try:
            sb = _sandbox(_username)
            esp = Espace(_username, sb)
            rel_root = _rel(sb, path)
            root = sb / rel_root if rel_root else sb
            e_root = esp.stat(rel_root)
            if e_root["kind"] == "missing": return _err("not_found", path=_to_container(root, sb))

            cap = max(1, min(max_results, MAX_LIST))

            # ── path = FICHIER : stat ou grep ─────────────────────────────
            if e_root["kind"] != "dir":
                if e_root["kind"] != "file":
                    return _err("not_a_regular_file",
                                hint="FIFOs, sockets, device files and symlinks leaving /work are not read.")
                size = int(e_root.get("size") or 0)
                tete = esp.lire(rel_root, length=8192, max_bytes=8192).data
                if search_text:
                    needle = search_text.lower() if ignore_case else search_text
                    if size > 300_000 or not _is_text_bytes(tete):
                        return _err("not_greppable",
                                    hint="Fichier binaire ou > 300 Ko — utilise read_file(grep=…) ou execute_shell grep.")
                    data = esp.lire(rel_root, max_bytes=300_000 + (1 << 16)).data.decode(
                        "utf-8", errors="replace")
                    hits = []
                    for i, line in enumerate(data.splitlines(), 1):
                        hay = line.lower() if ignore_case else line
                        if needle in hay:
                            hits.append({"file": root.name, "line": i, "text": (line if len(line) <= 260 else line[:260] + "…")})
                            if len(hits) >= min(cap, MAX_GREP):
                                return _ok(action="grep", count=len(hits),
                                           hits=hits, truncated=True)
                    return _ok(action="grep", count=len(hits), hits=hits, truncated=False)
                info = _stat_entree(root, sb, e_root)
                info["mime"] = _mime(root)
                _is_txt = _is_text_bytes(tete)
                info["content_type"] = "text" if _is_txt else "binary"
                if _is_txt:
                    info["encoding"] = _encodage(tete)
                if details and size <= 10_000_000:
                    info["sha256"] = esp.stat(rel_root, hash=True, hash_max=10_000_000).get("sha256", "")
                return _ok(action="stat", **info)
            # Mesuré en direct : sans ``exclude``, un ``include_hidden=True``
            # ramène 500 chemins de ``.venv/lib/pythonX/site-packages/...`` :
            # +9 000 tokens de contexte en UN appel, pour zéro information
            # utile. On applique donc un socle d'exclusions de dossiers de
            # DÉPENDANCES quand l'appelant n'a rien précisé — et on le DIT
            # dans la réponse (``excluded_default``). ``.git`` n'y figure PAS :
            # il est déjà masqué par le défaut ``include_hidden=False``.
            _default_excl = not [e for e in (exclude or []) if e]
            exclude_pats = ([e for e in (exclude or []) if e]
                            or list(DEFAULT_DEP_EXCLUDES))
            # Un motif qui porte un chemin (``src/**/*.ts``,
            # ``**/*.py``) implique la récursion.
            if pattern and ("/" in pattern or "**" in pattern):
                recursive = True
            # Parcours ÉLAGUÉ par l'agent (descendre dans node_modules,
            # .venv… épuiserait la borne MAX_WALK avant le projet) : un
            # dossier exclu ou caché n'est ni rendu ni descendu — motifs
            # confrontés au nom et au chemin relatif. Borne DURE du walk :
            # MAX_WALK entrées. Liens non montrés ; ordre de parcours de
            # ``_cle_parcours``, dont les tris stables héritent.
            listing = esp.lister(rel_root, depth=_PROFONDEUR if (recursive or search_text) else 1,
                                 max_entries=MAX_WALK, hidden=include_hidden,
                                 exclude=exclude_pats)
            walk_capped = listing.truncated
            prefixe = rel_root + "/" if rel_root else ""
            entrees = sorted(((x["path"][len(prefixe):], x) for x in listing.entries
                              if x["kind"] != "link"),
                             key=lambda rx: _cle_parcours(rx[0], rx[1]["kind"] == "dir"))

            # ── search_text (grep mode) ────────────────────────────
            if search_text:
                # Fichiers écartés COMPTÉS et signalés, jamais sautés en
                # silence ; lecture ligne à ligne jusqu'à 20 Mo, dans l'agent.
                fichiers = [prefixe + r for r, x in entrees
                            if x["kind"] == "file" and (not pattern or _glob_match(r, pattern))]
                trouves, bilan = _grep_lots(esp, fichiers, search_text, ignore_case=ignore_case,
                                            max_file_bytes=_SEARCH_MAX_BYTES,
                                            max_hits=min(cap, MAX_GREP))
                hits = [{"file": h["file"][len(prefixe):], "line": h["line"], "text": h["text"]}
                        for h in trouves]
                if bilan.get("hits_truncated"):
                    return _ok(action="grep", count=len(hits), hits=hits, truncated=True,
                               hint="Refine with pattern= or smaller search_text.")
                _extra: Dict[str, Any] = {}
                if bilan.get("skipped_large"):
                    _extra["skipped_large"] = bilan["skipped_large"]
                if bilan.get("skipped_binary"):
                    _extra["skipped_binary"] = bilan["skipped_binary"]
                if walk_capped:
                    _extra["walk_truncated"] = True
                if _extra:
                    _extra["hint"] = (
                        "Some files were NOT searched (see skipped_large / "
                        "skipped_binary / walk_truncated): narrow path= or use "
                        "execute_shell with grep -rn for them.")
                return _ok(action="grep", count=len(hits), hits=hits,
                           truncated=walk_capped, **_extra)

            # ── list / glob ────────────────────────────────────────
            since_cutoff = _parse_since(since) if since else None
            items = [(r, x) for r, x in entrees
                     if (not pattern or _glob_match(r, pattern))
                     and (since_cutoff is None or int(x.get("mtime_ns") or 0) / 1e9 >= since_cutoff)]

            # Sort (stable : à égalité, l'ordre du parcours)
            if sort_by == "size":
                items.sort(key=lambda rx: 0 if rx[1]["kind"] == "dir" else -int(rx[1].get("size") or 0))
            elif sort_by == "mtime":
                items.sort(key=lambda rx: -int(rx[1].get("mtime_ns") or 0))
            else:
                items.sort(key=lambda rx: (0 if rx[1]["kind"] == "dir" else 1,
                                           rx[0].rsplit("/", 1)[-1].lower()))

            # Reprise par IDENTITÉ dans l'ordre de page :
            # on repart juste APRÈS l'entrée nommée par le curseur. Curseur
            # inconnu (entrée disparue entre deux pages) ⇒ depuis le début.
            start = 0
            if cursor:
                for _i, (_r, _x) in enumerate(items):
                    if _r == cursor:
                        start = _i + 1
                        break
            page = items[start:start + cap]
            truncated = walk_capped or len(items) > start + cap
            next_cursor = page[-1][0] if truncated and page else ""

            # Optional: fetch git status map once (bounded, cf. _git_status_map)
            git_status, git_status_error = (_git_status_map(esp, sb, root) if include_git_status
                                            else ({}, None))

            if details:
                out = []
                for r, x in page:
                    # ``path`` : vue conteneur réutilisable telle quelle, ``rel``
                    # relatif à la sandbox (relatif au dossier listé, il
                    # mènerait read_file à « not_found »).
                    info_d = _stat_entree(sb / (prefixe + r), sb, x)
                    if include_git_status and r in git_status:
                        info_d["git_status"] = git_status[r]
                    out.append(info_d)
            else:
                out = [r + ("/" if x["kind"] == "dir" else "") for r, x in page]

            result = _ok(action="list", path=_to_container(root, sb), count=len(out),
                         items=out, truncated=truncated)
            # Socle d'exclusions appliqué faute de ``exclude`` explicite : on le
            # DIT, sinon l'omission serait silencieuse et le modèle conclurait à
            # l'absence des fichiers. Il peut relancer avec ``exclude=[]``.
            if _default_excl:
                result["excluded_default"] = list(DEFAULT_DEP_EXCLUDES)
                result["hint_excluded"] = (
                    "Dossiers de dépendances/build écartés par défaut. "
                    "Passez exclude=[] pour tout voir.")
            if since_cutoff is not None:
                result["since_cutoff"] = since_cutoff
            if include_git_status:
                # Always include the status map (only paths we paginated over)
                page_paths = {r for r, _x in page}
                result["git_status"] = {q: c for q, c in git_status.items() if q in page_paths}
                if git_status_error:
                    result["git_status_error"] = git_status_error
            if next_cursor:
                result["next_cursor"] = next_cursor
                result["hint"] = "Call again with cursor=next_cursor for more results."
            if walk_capped:
                # L'ARBRE a été trop grand pour être parcouru en entier (≠
                # simple pagination) → narrow avec pattern=/exclude=.
                result["walk_truncated"] = True
                result["hint"] = (f"Tree too large (>{MAX_WALK} entries scanned); "
                                  "results are partial. Narrow with pattern= or "
                                  "exclude=, or list a subdirectory.")

            # ── summary ────────────────────────────────────────────
            if summary:
                total_bytes = 0
                ext_counts: Dict[str, int] = {}
                n_files = n_dirs = 0
                for r, x in items:
                    if x["kind"] == "dir":
                        n_dirs += 1
                    else:
                        n_files += 1
                        total_bytes += int(x.get("size") or 0)
                        ext = Path(r).suffix.lower() or "(none)"
                        ext_counts[ext] = ext_counts.get(ext, 0) + 1
                result["summary"] = {
                    "total_items": len(items),
                    "files": n_files,
                    "dirs": n_dirs,
                    "total_bytes": total_bytes,
                    "extensions": dict(sorted(ext_counts.items(), key=lambda kv: -kv[1])[:20]),
                }
            return result
        except AgentError as e:
            return _err_agent(e, root if "root" in locals() else sb, sb)
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── 5. manage_files ──────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_DESTRUCT)
    def manage_files(
        ctx: Context,
        action: Literal["copy", "move", "delete", "chmod", "mkdir", "batch_delete"],
        path: str = "",
        dest: str = "",
        recursive: bool = False,
        paths: List[str] = [],
        overwrite: bool = True,
        dry_run: bool = False,
    ) -> Union[ManageFilesResult, ErrEnvelope]:
        """File operations. Actions: copy|move|delete|chmod|mkdir|batch_delete.

  copy / move   : requires path + dest. overwrite=False fails if dest exists.
  delete        : requires path. recursive=True for dirs.
  chmod         : requires path. Makes the path executable, cross-UID (host +
                  container can both run/edit it).
  mkdir         : requires path. Creates the directory (and parents). No-op if it
                  already exists; errors if path is an existing file.
  batch_delete  : requires paths=[...]. All deleted atomically-ish.

Safety:
  dry_run=True  : preview what would be done without touching the filesystem.
                  (recommended on delete / batch_delete)."""
        _username = get_username(ctx)
        try:
            sb = _sandbox(_username)
            esp = Espace(_username, sb)
            act = (action or "").strip().lower()
            _track = _history_uid(_username) is not None
            rel = ""

            def _enlever(rel: str, e: Dict[str, Any], missing_ok: bool = False
                         ) -> Optional[List[Tuple[Path, bytes]]]:
                """Supprime ``rel`` par l'agent et rend les fichiers supprimés
                (pour l'historique) ; ``None`` si ``rel`` avait déjà disparu
                (``missing_ok``). Un lien est supprimé lui-même."""
                if e.get("link"):
                    r = esp.fsop("remove", path=rel, missing_ok=missing_ok)
                    return [] if r.get("removed", 1) else None
                with _locks_for(sb / rel) if e["kind"] == "file" else contextlib.nullcontext():
                    snap = _instantane_agent(esp, sb, rel, e) if _track else []
                    r = esp.fsop("remove", path=rel, recursive=True, missing_ok=missing_ok)
                return snap if r.get("removed", 1) else None

            def _noter_suppressions(snap: Optional[List[Tuple[Path, bytes]]],
                                    fc: List[Dict[str, Any]]) -> None:
                for _f, _b in snap or []:
                    _history_record(_username, sb, _f, _b, None)
                    if len(fc) < _FC_MAX:
                        fc.append(_fc_entry(_f, sb, "deleted", _b, None))

            def _type(e: Dict[str, Any]) -> str:
                return "symlink" if e.get("link") else ("dir" if e["kind"] == "dir" else "file")

            if act == "batch_delete":
                if not paths: return _err("paths_required", hint="Pass paths=[...].")
                if len(paths) > 500:
                    return _err("too_many_paths", hint="Max 500 per call.")
                rels = []
                for rp in paths:
                    try:
                        rels.append(_rel(sb, rp, allow_root=False))
                    except Exception as e:
                        return _err(f"bad_path '{rp}': {e}")
                entrees = esp.stats(rels)
                for rp, e in zip(paths, entrees):
                    if e["kind"] == "error":
                        return _err(f"bad_path '{rp}': {e.get('message') or e.get('error')}")
                plan = []
                for rel, e in zip(rels, entrees):
                    if e["kind"] == "missing":
                        plan.append({"path": to_container(rel), "status": "not_found"})
                        continue
                    plan.append({"path": to_container(rel), "type": _type(e),
                                 "size": e.get("size") if _type(e) == "file" else None,
                                 "status": "would_delete" if dry_run else "pending"})
                if dry_run:
                    return _ok(action="batch_delete", dry_run=True, plan=plan)
                deleted: List[str] = []
                _fc: List[Dict[str, Any]] = []
                for rel, e in zip(rels, entrees):
                    if e["kind"] == "missing":
                        continue
                    if _type(e) == "dir" and not recursive:
                        return _err("is_dir", hint=f"{to_container(rel)} is dir; pass recursive=True.",
                                    already_deleted=deleted)
                    # Un chemin déjà emporté plus haut dans le lot (dossier
                    # parent, doublon) n'est ni une erreur ni une suppression.
                    snap = _enlever(rel, e, missing_ok=True)
                    if snap is None:
                        continue
                    _noter_suppressions(snap, _fc)
                    deleted.append(to_container(rel))
                return _ok(action="batch_delete", deleted=deleted, count=len(deleted),
                           **({"files_changed": _fc} if _fc else {}))

            if not path:
                return _err("path_required")
            rel = _rel(sb, path)
            p = sb / rel if rel else sb
            if act in ("delete", "move") and not rel:
                return _err("refus_racine",
                            hint="Agissez sur un élément DANS le bac à sable, "
                                 "pas sur le bac à sable lui-même.")
            e = esp.stat(rel)

            if act == "chmod":
                if e["kind"] == "missing":
                    return _err("not_found")
                if e["kind"] not in ("file", "dir"):
                    return _err("not_a_regular_file")
                cur = int(e.get("mode") or 0)
                new = _executable_mode(cur) & 0o777
                if dry_run:
                    return _ok(path=_to_container(p, sb), action="chmod", dry_run=True,
                               current_mode=oct(cur & 0o777), would_set=oct(new))
                esp.fsop("chmod", path=rel, mode=new)
                return _ok(path=_to_container(p, sb), action="chmod", mode=oct(new))

            if act == "mkdir":
                if e["kind"] not in ("missing", "dir"):
                    return _err("exists_not_dir",
                                hint=f"{_to_container(p, sb)} already exists and is not a directory.")
                _existed = e["kind"] == "dir"
                _twin = esp.jumeau_unicode(rel)
                if dry_run:
                    return _ok(path=_to_container(p, sb), action="mkdir", dry_run=True,
                               would_create=not _existed,
                               **({"warning": _twin} if _twin else {}))
                esp.fsop("mkdir", path=rel, parents=True)
                return _ok(path=_to_container(p, sb), action="mkdir", created=not _existed,
                           **({"warning": _twin} if _twin else {}))

            if act == "delete":
                if e["kind"] == "missing":
                    return _err("not_found")
                if e.get("link"):
                    if dry_run:
                        return _ok(action="delete", dry_run=True, path=to_container(rel),
                                   type="symlink")
                    esp.fsop("remove", path=rel)
                    return _ok(action="delete", symlink=True, path=to_container(rel))
                if e["kind"] == "dir" and not recursive:
                    return _err("is_dir", hint="Pass recursive=True to delete directory.")
                if dry_run:
                    info: Dict[str, Any] = {"path": _to_container(p, sb), "type": _type(e)}
                    if e["kind"] == "dir":
                        liste = esp.lister(rel, depth=_PROFONDEUR, max_entries=MAX_WALK, hidden=True)
                        info["items_inside"] = len(liste.entries)
                        if liste.truncated:
                            info["truncated"] = True
                    else:
                        info["size"] = int(e.get("size") or 0)
                    return _ok(action="delete", dry_run=True, **info)
                _fc = []
                _noter_suppressions(_enlever(rel, e), _fc)
                return _ok(path=_to_container(p, sb), action="delete",
                           **({"files_changed": _fc} if _fc else {}))

            if act in ("copy", "move"):
                if not dest: return _err("dest_required")
                # Un lien se déplace lui-même ; une copie suit la source.
                lien = act == "move" and bool(e.get("link"))
                if e["kind"] == "missing" or (not lien and e["kind"] == "link"):
                    return _err("outside_sandbox" if e.get("outside") else "not_found",
                                path=_to_container(p, sb))
                drel = _rel(sb, dest)

                def _meme(ed: Dict[str, Any]) -> bool:
                    if lien:
                        return drel == rel
                    return ed["kind"] != "missing" and "ino" in e and \
                        (e.get("ino"), e.get("dev")) == (ed.get("ino"), ed.get("dev"))

                ed = esp.stat(drel)
                # Sémantique du shell : un dossier existant (ou « dest/ »)
                # veut dire « dedans ».
                if not _meme(ed) and (ed["kind"] == "dir" or (
                        str(dest).rstrip().endswith("/") and ed["kind"] == "missing")):
                    nom = rel.rsplit("/", 1)[-1]
                    drel = f"{drel}/{nom}" if drel else nom
                    ed = esp.stat(drel)
                pdst = sb / drel if drel else sb
                _dest_label = to_container(drel)
                if _meme(ed):
                    return _ok(src=_to_container(p, sb), dest=_to_container(pdst, sb),
                               action=act, noop=True,
                               hint="Source and destination are identical: nothing was done.")
                src_dossier = e["kind"] == "dir" and not lien
                if src_dossier and (not rel or drel.startswith(rel + "/")):
                    return _err("dest_inside_source",
                                hint="Cannot copy or move a directory into itself.")
                ecrase = ed["kind"] != "missing"
                if ecrase:
                    if not overwrite:
                        return _err("dest_exists", hint="Pass overwrite=True to replace.",
                                    dest=_dest_label)
                    # Jamais d'effacement implicite d'un dossier.
                    if ed["kind"] == "dir" and not ed.get("link"):
                        return _err("dest_is_directory",
                                    hint="Refusing to replace an existing directory: delete "
                                         "it first (manage_files delete, recursive=True) or "
                                         "choose another destination.",
                                    dest=_dest_label)
                    if src_dossier:
                        return _err("dest_is_file",
                                    hint="Refusing to replace an existing file with a "
                                         "directory: delete it first or choose another "
                                         "destination.",
                                    dest=_dest_label)

                _twin = esp.jumeau_unicode(drel)
                _warn = {"warning": _twin} if _twin else {}
                if dry_run:
                    if lien:
                        return _ok(action="move", dry_run=True, symlink=True, dest=_dest_label, **_warn)
                    return _ok(action=act, dry_run=True, src=_to_container(p, sb), dest=_dest_label,
                               overwrite_target=ecrase, **_warn)

                fichier = e["kind"] == "file" and not lien
                avant: List[Tuple[Path, bytes]] = []
                apres: List[Tuple[Path, bytes]] = []
                with _locks_for(p, pdst) if fichier else contextlib.nullcontext():
                    try:
                        if act == "copy":
                            if fichier and _track:
                                avant = [] if ed.get("link") else _instantane_agent(esp, sb, drel, ed)
                                apres = _instantane_agent(esp, sb, rel, e)
                            esp.fsop("copy", src=rel, dst=drel, overwrite=True, parents=True,
                                     follow=True)
                        else:
                            esp.fsop("rename", src=rel, dst=drel, overwrite=True, parents=True)
                    except AgentError as ex:
                        # Un dossier apparu entre-temps à la destination : l'agent
                        # refuse, comme le contrôle ci-dessus.
                        if ex.code == "is_dir":
                            return _err("dest_is_directory", dest=_dest_label,
                                        hint="Refusing to replace an existing directory.")
                        if ex.code == "exists":
                            return _err("dest_is_file" if src_dossier else "dest_exists",
                                        dest=_dest_label,
                                        hint="The destination appeared meanwhile; retry.")
                        raise
                if lien:
                    return _ok(action="move", symlink=True, dest=_dest_label, **_warn)
                # Historique de session : une copie écrit la destination, un
                # déplacement emporte l'historique du fichier.
                _fc = []
                if act == "copy" and fichier and _track:
                    _b = avant[0][1] if avant else None
                    _a = apres[0][1] if apres else None
                    _history_record(_username, sb, pdst, _b, _a)
                    _fc.append(_fc_entry(pdst, sb, "created" if _b is None else "modified", _b, _a))
                elif act == "copy" and src_dossier and _track:
                    for _f, _b in _instantane_agent(esp, sb, drel, {"kind": "dir"}):
                        _history_record(_username, sb, _f, None, _b)
                        if len(_fc) < _FC_MAX:
                            _fc.append(_fc_entry(_f, sb, "created", None, _b))
                elif act == "move":
                    _history_move(_username, sb, p, pdst)
                    _fc.append({"path": _to_container(pdst, sb), "change": "moved",
                                "from": _to_container(p, sb)})
                return _ok(src=_to_container(p, sb), dest=_to_container(pdst, sb), action=act,
                           **_warn, **({"files_changed": _fc} if _fc else {}))

            return _err("invalid_action", hint="Use: copy|move|delete|chmod|mkdir|batch_delete")
        except AgentError as e:
            return _err_agent(e, sb / rel if rel else sb, sb)
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")

    # ── 6. code — intelligence de code (plan, symboles, définition, références)
    @mcp.tool(**_TOOL_KW_RO)
    def code(
        ctx: Context,
        action: Literal["outline", "symbols", "definition", "references"],
        path: str = "",
        paths: List[str] = [],
        symbol: str = "",
        scope: str = "",
        include_glob: str = "",
        exclude: List[str] = [],
        max_depth: int = 4,
        max_results: int = 200,
        recursive: bool = True,
    ) -> Union[CodeOutlineResult, CodeNavigateResult, ErrEnvelope]:
        """Code intelligence — structure & navigation without reading whole files.

Actions:
  outline    : hierarchical structure of a file (path=… or paths=[…] batch).
               Languages: Python (AST-precise), JS/TS, Robot Framework,
               Bash, YAML/Ansible, JSON, Markdown. max_depth=N (default 4).
  symbols    : FLAT list of symbols defined in `path` ({kind,name,line}).
  definition : where `symbol` is DEFINED, under `scope` (default: sandbox
               root), filtered by include_glob='*.py' / exclude=[...].
  references : every line containing `symbol` as a word (same filters).

Examples:
  code(action='outline', path='src/app.py')
  code(action='definition', symbol='handle_request', include_glob='*.py')
  code(action='references', symbol='LLM_SEMAPHORE', scope='llm_core/')

Returns: outline → {language, outline, summary} ; symbols → {matches} ;
definition/references → {count, matches:[{file,line,…}], truncated}."""
        _username = get_username(ctx)
        if not _HAS_CI:
            return _err("code_intel_unavailable",
                        hint="The code_intel module is missing. Reinstall tools/.")

        def _outline_one(rel_path: str, sb: Path, esp: Espace) -> Dict[str, Any]:
            try:
                rel = _rel(sb, rel_path)
            except ValueError as ex:
                return _err(str(ex), path=rel_path)
            pp = sb / rel if rel else sb
            try:
                e = esp.stat(rel)
                if e["kind"] == "missing":
                    return _err("not_found", path=_to_container(pp, sb))
                if e["kind"] == "dir":
                    return _err("is_directory", path=_to_container(pp, sb),
                                hint="outline expects a single file.")
                size = int(e.get("size") or 0)
                if size > MAX_EDIT_BYTES:
                    return _err("too_large", size=size, max=MAX_EDIT_BYTES,
                                hint="File too large for outline.")
                text = esp.lire(rel, max_bytes=MAX_EDIT_BYTES).data.decode("utf-8", errors="replace")
            except AgentError as ex:
                return _err_agent(ex, pp, sb)
            lang = _ci.detect_language(pp.name)
            if lang == "unknown":
                return _ok(path=_to_container(pp, sb), language="unknown", outline=[],
                           note="extension not supported by code_intel",
                           summary="(unknown language)")
            tree = _ci.outline(text, lang, max_depth=max_depth)
            return _ok(path=_to_container(pp, sb), language=lang, outline=tree,
                       summary=_ci.summarize_structure(text, lang))

        try:
            sb = _sandbox(_username)
            esp = Espace(_username, sb)
            act = (action or "").strip().lower()
            paths_l = as_list(paths) or []
            exclude_l = [str(e) for e in (as_list(exclude) or []) if e]

            # ── outline (single ou batch) ─────────────────────────────
            if act == "outline":
                if paths_l:
                    if path:
                        return _err("conflict",
                                    hint="Pass path=<single> OR paths=[...], not both.")
                    if len(paths_l) > MAX_BATCH_PATHS:
                        return _err("too_many_paths",
                                    hint=f"Max {MAX_BATCH_PATHS} per call.")
                    files_out = {}
                    ok_count = 0
                    for rp in paths_l:
                        if not isinstance(rp, str) or not rp:
                            files_out[str(rp)] = _err("bad_path")
                            continue
                        r = _outline_one(rp, sb, esp)
                        files_out[rp] = r
                        if r.get("ok"):
                            ok_count += 1
                    return _ok(action="batch_outline",
                               count=len(paths_l), succeeded=ok_count,
                               failed=len(paths_l) - ok_count,
                               files=files_out)
                if not path:
                    return _err("path_required",
                                hint="Pass path=<file> or paths=[<file1>, ...].")
                return _outline_one(path, sb, esp)

            # ── symbols (fichier unique, liste plate) ─────────────────
            if act == "symbols":
                if not path:
                    return _err("path_required", hint="path=<file> for symbols")
                rel = _rel(sb, path)
                pp = sb / rel if rel else sb
                try:
                    text = esp.lire(rel, max_bytes=MAX_EDIT_BYTES).data.decode("utf-8", errors="replace")
                except AgentError as ex:
                    if ex.code in ("not_found", "is_dir", "not_file"):
                        return _err("not_a_file", path=_to_container(pp, sb))
                    return _err_agent(ex, pp, sb)
                lang = _ci.detect_language(pp.name)
                if lang == "unknown":
                    return _ok(action="symbols", path=_to_container(pp, sb), language="unknown",
                               count=0, matches=[])
                syms = _ci.list_symbols(text, lang)
                return _ok(action="symbols", path=_to_container(pp, sb), language=lang,
                           count=len(syms), matches=syms)

            if act not in ("definition", "references"):
                return _err("invalid_action",
                            hint="Use: outline | symbols | definition | references")
            if not symbol:
                return _err("symbol_required")

            cap = max(1, min(max_results, 5000))
            srel = _rel(sb, scope) if scope else ""
            search_root = sb / srel if srel else sb
            if esp.stat(srel)["kind"] != "dir":
                return _err("scope_not_a_dir", scope=_to_container(search_root, sb))

            # Même règle que list_files : motifs confrontés au nom et au chemin
            # à chaque niveau (un dossier exclu n'est pas descendu), dossiers
            # cachés sautés, socle des dossiers de dépendances par défaut.
            liste = esp.lister(srel, depth=_PROFONDEUR if recursive else 1, max_entries=MAX_WALK,
                               hidden=False, exclude=exclude_l or list(DEFAULT_DEP_EXCLUDES))
            fichiers = []
            for x in liste.entries:
                if x["kind"] != "file" or int(x.get("size") or 0) > MAX_EDIT_BYTES:
                    continue
                rel = x["path"][len(srel) + 1:] if srel else x["path"]
                name = rel.rsplit("/", 1)[-1]
                if include_glob and not _glob_match(rel, include_glob):
                    continue
                lang = _ci.detect_language(name)
                if lang != "unknown":
                    fichiers.append((rel, x["path"], lang))
            fichiers.sort(key=lambda f: _cle_parcours(f[0], False))
            # Préfiltre par l'agent : un fichier qui ne contient pas le symbole
            # (Robot : son plus long fragment alphanumérique, sans casse — les
            # mots-clés se comparent sans casse ni « _ », « - », espace) ne
            # peut ni le définir ni le citer. Seuls les candidats sont lus.
            fragment = max(re.split(r"[\W_]+", symbol), key=len)
            retenus: set = set()
            for robot in (False, True):
                lot = [f[1] for f in fichiers if (f[2] == "robot") is robot]
                aiguille = fragment if robot else symbol
                if not lot:
                    continue
                if not aiguille:
                    retenus.update(lot)
                    continue
                trouves, _bilan = _grep_lots(esp, lot, aiguille, ignore_case=robot,
                                             max_file_bytes=MAX_EDIT_BYTES, max_hits=len(lot),
                                             files_only=True)
                retenus.update(t["file"] for t in trouves)
            candidats = [f for f in fichiers if f[1] in retenus]

            def _fin(truncated: bool) -> Dict[str, Any]:
                return _ok(action=act, query=symbol, count=len(hits),
                           files_scanned=len(fichiers), matches=hits, truncated=truncated,
                           **({"walk_truncated": True} if liste.truncated else {}))

            hits: List[Dict[str, Any]] = []
            par_chemin = {f[1]: f for f in candidats}
            for chemin, data in _lire_lots(esp, list(par_chemin), MAX_EDIT_BYTES):
                if data is None:
                    continue
                rel, _c, lang = par_chemin[chemin]
                text = data.decode("utf-8", errors="replace")
                if act == "definition":
                    found = _ci.find_definition(text, lang, symbol)
                else:
                    found = _ci.find_references(text, lang, symbol, max_results=cap - len(hits))
                for it in found:
                    hits.append({"file": rel, **it})
                    if len(hits) >= cap:
                        return _fin(True)
            return _fin(False)
        except AgentError as ex:
            return _err_agent(ex, sb, sb)
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"unexpected: {e}")
