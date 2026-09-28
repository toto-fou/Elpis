# SPDX-License-Identifier: MIT
"""
llm_core.memory._markdown_store — Magasin Markdown auto-curé (façon Hermes).

Un ``MarkdownStore`` est une vue fichier sur une liste d'**entrées** séparées
par un délimiteur ``§`` (sur sa propre ligne). Les entrées peuvent être
multi-lignes. Le magasin applique une **limite de caractères** stricte : un
``add`` qui ferait dépasser la limite renvoie une erreur explicite (jamais de
troncature silencieuse), ce qui force l'agent à consolider avant d'ajouter.

Ciblage des entrées (``replace`` / ``remove``) — v2 « IDs + erreurs guidées » :
chaque entrée possède un **id court stable** dérivé de son contenu
(``compute_entry_id``), affiché ``[a1f4]`` en tête d'entrée dans le bloc
system prompt et dans les résultats. Une cible se résout par id (forme sûre)
ou par sous-chaîne **normalisée** (casse/espaces/retours-ligne tolérés) ; en
cas d'échec, le résultat porte le candidat le plus proche (``closest_index``)
pour que l'agent se corrige au coup suivant. Les ids ne sont JAMAIS persistés
dans le ``.md`` — ils sont recalculés à chaque lecture.

C'est une primitive PURE : aucun import DB / config / app. Le chemin du fichier
et la limite sont injectés à la construction, ce qui la rend trivialement
testable et réutilisable par l'outil ``memory`` ET par le provider builtin.
"""
from __future__ import annotations

import difflib
import fcntl
import hashlib
import logging
import os
import re
import tempfile
import threading
import time
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterator, List, Optional

logger = logging.getLogger("uvicorn.error")

# Délimiteur d'entrée (Hermes utilise le signe section §, seul sur sa ligne).
DELIM = "§"
_SPLIT_RE = re.compile(r"(?m)^[ \t]*§[ \t]*$")
# ``rewrite`` accepte des entrées séparées par une ligne ``---`` (3 tirets ou
# plus) OU une ligne ``§`` — le tiret est plus naturel à produire en Markdown.
_REWRITE_SPLIT_RE = re.compile(r"(?m)^[ \t]*(?:-{3,}|§)[ \t]*$")
# Ligne-délimiteur NUE à neutraliser à l'intérieur d'un contenu d'entrée
# (sinon le prochain parse scinderait l'entrée en deux).
_DELIM_LINE_RE = re.compile(r"(?m)^([ \t]*)§([ \t]*)$")

# Formes de cible « id » : ``[a1f4] …texte optionnel…`` ou id hex nu.
_ID_BRACKET_RE = re.compile(r"^\s*\[([0-9a-fA-F]{4,40})\]\s*(.*)$", re.S)
_ID_BARE_RE = re.compile(r"^[0-9a-fA-F]{4,12}$")

_ELLIPSES = ("…", "...")


class StoreBusyError(RuntimeError):
    """Verrou du store non acquis dans le délai imparti (contention/blocage)."""


class StoreReadError(RuntimeError):
    """Le fichier existe mais est ILLISIBLE (I/O transitoire, encodage non
    UTF-8/corruption). Distinct de « fichier absent » (= store vide, légitime).
    Levé UNIQUEMENT sur le chemin de mutation : une lecture qui échoue ne doit
    JAMAIS déboucher sur une réécriture dérivée du vide (perte de données)."""


@dataclass
class StoreOpResult:
    """Résultat d'une opération de curation (add/replace/remove/rewrite)."""
    ok: bool
    action: str
    error: Optional[str] = None           # message FR lisible
    error_code: Optional[str] = None      # code machine stable (no_match, over_limit, …)
    chars: int = 0
    limit: int = 0
    usage_pct: float = 0.0
    n_entries: int = 0
    entries: List[str] = field(default_factory=list)      # textes COMPLETS
    entry_ids: List[str] = field(default_factory=list)    # parallèle à entries
    closest_index: Optional[int] = None                   # si no_match : meilleur candidat
    candidate_indexes: List[int] = field(default_factory=list)  # si ambiguous
    # (2026-09-19) État AVANT l'écriture (succès seulement) : alimente le
    # journal (détail dans le fil du chat, annulation). ``unchanged`` = succès
    # sans écriture (ajout d'un texte déjà présent tel quel).
    before: List[str] = field(default_factory=list)
    unchanged: bool = False


@dataclass
class TargetResolution:
    """Issue de ``_resolve_target`` : index résolu, ou candidats/plus-proche."""
    index: Optional[int] = None
    matched_by: str = ""                  # "id" | "substring" | ""
    candidates: List[int] = field(default_factory=list)
    closest_index: Optional[int] = None
    closest_score: float = 0.0


def _serialize(entries: List[str]) -> str:
    """Sérialise les entrées en un seul document ``§``-délimité."""
    sep = "\n" + DELIM + "\n"
    return sep.join(e.strip() for e in entries if e.strip())


def parse_entries(raw: str) -> List[str]:
    """Découpe un document brut en entrées, en supprimant les vides."""
    if not raw or not raw.strip():
        return []
    parts = _SPLIT_RE.split(raw)
    return [p.strip() for p in parts if p.strip()]


def normalize_for_match(s: str) -> str:
    """Forme canonique d'un texte pour le matching de cible.

    Tolère les altérations typiques d'une copie par le modèle : NFC, casse
    (casefold), espaces/retours-ligne repliés en un espace, ellipses de BORD
    (``…`` / ``...``) retirées — un modèle qui recopie une entrée tronquée à
    l'affichage termine souvent par une ellipse qui n'existe pas sur disque.
    """
    t = unicodedata.normalize("NFC", str(s or ""))
    t = t.casefold()
    t = re.sub(r"\s+", " ", t).strip()
    changed = True
    while changed and t:
        changed = False
        for e in _ELLIPSES:
            if t.startswith(e):
                t = t[len(e):].lstrip()
                changed = True
            if t.endswith(e):
                t = t[:-len(e)].rstrip()
                changed = True
    return t


def compute_entry_id(text: str, length: int = 4) -> str:
    """Id court stable d'une entrée = sha1 de son contenu NFC strippé."""
    norm = unicodedata.normalize("NFC", str(text or "").strip())
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[: max(1, int(length))]


def entry_ids(entries: List[str]) -> List[str]:
    """Ids (longueur 4) des entrées ; en cas de collision, SEULS les ids en
    collision sont allongés (5, 6, … 12) jusqu'à unicité. Déterministe :
    pur f(contenus). Deux entrées au texte strictement identique gardent le
    même id (cas pathologique traité comme ambigu à la résolution)."""
    ids = [compute_entry_id(e) for e in entries]
    length = 4
    while length < 12:
        counts: Dict[str, int] = {}
        for i in ids:
            counts[i] = counts.get(i, 0) + 1
        dups = {i for i, n in counts.items() if n > 1}
        if not dups:
            break
        length += 1
        ids = [compute_entry_id(entries[j], length) if ids[j] in dups else ids[j]
               for j in range(len(entries))]
    return ids


def sanitize_entry_text(text: str) -> str:
    """Neutralise toute ligne-délimiteur ``§`` nue DANS une entrée (→ ``\\§``),
    sinon le prochain ``parse_entries`` scinderait l'entrée en deux.

    Les fins de ligne sont ramenées à LF : ``read_text`` le fait de toute
    façon à la relecture (universal newlines), si bien qu'un contenu collé
    depuis Windows (CRLF) n'avait pas sur disque le texte — donc l'id —
    annoncé par le résultat, et son écriture ne pouvait plus être annulée."""
    t = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    return _DELIM_LINE_RE.sub(r"\1\\§\2", t)


def _resolve_target(entries: List[str], target: str) -> TargetResolution:
    """Résout une cible vers UN index d'entrée.

    Ordre : id crocheté ``[a1f4]`` (l'id gagne même si le texte accolé est
    périmé) → id hex nu → sous-chaîne normalisée. 0 match → ``closest_index``
    par RECOUVREMENT du needle : somme des blocs communs (≥ 3 chars) / longueur
    du needle. Le ``ratio()`` global sous-note le cas réel n°1 (court extrait
    paraphrasé vs entrée longue) et une unique plus-longue-sous-chaîne rate les
    paraphrases par substitution de mot.
    """
    tgt = str(target or "").strip()
    if not tgt or not entries:
        return TargetResolution()
    ids = entry_ids(entries)

    def _by_id(token: str) -> Optional[TargetResolution]:
        token = token.lower()
        hits = [i for i, eid in enumerate(ids) if eid == token]
        if len(hits) == 1:
            return TargetResolution(index=hits[0], matched_by="id")
        if len(hits) > 1:  # entrées au texte identique → ambigu
            return TargetResolution(candidates=hits)
        return None

    m = _ID_BRACKET_RE.match(tgt)
    if m:
        r = _by_id(m.group(1))
        if r is not None:
            return r
        rest = m.group(2).strip()
        if not rest:
            # Id inconnu (périmé) sans texte accolé : inutile de chercher un
            # plus-proche sur "[hex]" — no_match franc.
            return TargetResolution()
        tgt = rest  # id périmé : retomber sur le texte accolé
    elif _ID_BARE_RE.match(tgt):
        r = _by_id(tgt)
        if r is not None:
            return r
        # Sinon le token nu se traite comme du texte ordinaire ("fade", …).

    needle = normalize_for_match(tgt)
    if not needle:
        return TargetResolution()
    norm_entries = [normalize_for_match(e) for e in entries]
    hits = [i for i, ne in enumerate(norm_entries) if needle in ne]
    if len(hits) == 1:
        return TargetResolution(index=hits[0], matched_by="substring")
    if len(hits) > 1:
        return TargetResolution(candidates=hits)
    best_i: Optional[int] = None
    best_score = 0.0
    for i, ne in enumerate(norm_entries):
        if not ne:
            continue
        sm = difflib.SequenceMatcher(None, needle, ne, autojunk=False)
        covered = sum(b.size for b in sm.get_matching_blocks() if b.size >= 3)
        score = covered / max(1, len(needle))
        if score > best_score:
            best_i, best_score = i, score
    if best_i is not None and best_score >= 0.6:
        return TargetResolution(closest_index=best_i,
                                closest_score=round(min(best_score, 1.0), 2))
    return TargetResolution()


# ── Concurrence : double protection intra-process + inter-process ──────────
#
# ``add``/``replace``/``remove``/``rewrite`` font un read-modify-write
# (read=``entries()``, modify=calcul du candidate, write=``_write_entries``).
# Sans lock, deux coroutines/threads d'un même worker uvicorn OU deux workers
# concurrents perdent silencieusement des entrées (classic lost update).
#
# ``_write_entries`` est atomique au niveau fichier (tempfile + os.replace)
# mais ne sérialise pas les transactions.
#
# Double couche, chacune BORNÉE par un timeout (→ ``StoreBusyError`` propre
# plutôt qu'un outil suspendu indéfiniment si un verrou reste tenu) :
#   - ``threading.Lock`` (per-path, registre module-level) → sérialise
#     intra-process. Pas de coût IPC.
#   - ``fcntl.flock(LOCK_EX | LOCK_NB)`` en boucle sur un fichier sentinelle
#     ``<path>.lock`` → sérialise inter-process (multi-worker uvicorn).
#     Linux-only ; OK pour ce projet (Platform: linux).

_INTRA_LOCKS_GUARD = threading.Lock()
_INTRA_LOCKS: Dict[str, threading.Lock] = {}

DEFAULT_LOCK_TIMEOUT_S = 5.0


def _intra_lock_for(path: Path) -> threading.Lock:
    key = str(path.resolve() if path.is_absolute() else path)
    with _INTRA_LOCKS_GUARD:
        lk = _INTRA_LOCKS.get(key)
        if lk is None:
            # AUDIT 2026-08-02 (m9) — éviction des verrous LIBRES au-delà du
            # cap (même patron que les verrous par cible du contrôle d'écran) : la
            # clé est un CHEMIN résolu, donc la cardinalité = users × scopes
            # mémoire — non bornée par le nombre d'utilisateurs. Évincer un
            # lock libre est sûr : un futur appelant en recrée un, et la
            # sérialisation inter-process reste garantie par le flock.
            if len(_INTRA_LOCKS) >= 256:
                for k in [k for k, v in _INTRA_LOCKS.items() if not v.locked()]:
                    _INTRA_LOCKS.pop(k, None)
            lk = threading.Lock()
            _INTRA_LOCKS[key] = lk
        return lk


@contextmanager
def _file_lock(lock_path: Path,
               timeout_s: float = DEFAULT_LOCK_TIMEOUT_S) -> Iterator[None]:
    """Cross-process flock LOCK_EX (non bloquant + retries) sur un sentinelle."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        deadline = time.monotonic() + max(0.0, timeout_s)
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise StoreBusyError(
                        f"lock {lock_path.name} not acquired after {timeout_s:.1f}s")
                time.sleep(0.1)
        try:
            yield
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except Exception:
                pass
    finally:
        os.close(fd)


@contextmanager
def _store_transaction(path: Path,
                       timeout_s: float = DEFAULT_LOCK_TIMEOUT_S) -> Iterator[None]:
    """Acquiert intra+inter locks (bornés) pour une transaction read-modify-write."""
    lock_path = path.with_suffix(path.suffix + ".lock")
    # AUDIT 2026-08-02 (F6) — acquisition anti-éviction. ``_intra_lock_for`` rend
    # l'objet SOUS garde, mais ``acquire`` a lieu HORS garde : dans cette fenêtre
    # l'objet peut être évincé (256e clé) et un autre thread en recréer un AUTRE
    # pour le même chemin → deux threads « tiennent » chacun le leur, la garantie
    # intra-process est morte (aujourd'hui rattrapée par le flock, mais fragile).
    # On revérifie donc sous garde que le lock acquis est bien celui PUBLIÉ pour
    # la clé ; sinon on relâche l'orphelin et on reboucle (borné).
    key = str(path.resolve() if path.is_absolute() else path)
    intra = None
    for _ in range(8):
        cand = _intra_lock_for(path)
        if not cand.acquire(timeout=max(0.0, timeout_s)):
            raise StoreBusyError(
                f"internal lock of {path.name} not acquired after {timeout_s:.1f}s")
        with _INTRA_LOCKS_GUARD:
            if _INTRA_LOCKS.get(key) is cand:
                intra = cand
                break
        cand.release()               # lock évincé pendant notre acquire → retry
    if intra is None:
        raise StoreBusyError(
            f"internal lock of {path.name} unstable (eviction contention)")
    try:
        with _file_lock(lock_path, timeout_s):
            yield
    finally:
        intra.release()


class MarkdownStore:
    """Magasin fichier d'entrées ``§``-délimitées avec limite de chars.

    Args:
        path: chemin du fichier ``.md`` (créé à la volée au premier write).
        char_limit: budget de caractères du document sérialisé.
        label: en-tête lisible affiché dans le bloc system prompt.
        lock_timeout_s: délai max d'attente des verrous (→ ``StoreBusyError``).
    """

    def __init__(self, path: "str | Path", char_limit: int, *, label: str = "",
                 lock_timeout_s: float = DEFAULT_LOCK_TIMEOUT_S) -> None:
        self.path = Path(path)
        self.char_limit = int(char_limit)
        self.label = label or self.path.name
        self.lock_timeout_s = float(lock_timeout_s)

    # ── Lecture ──────────────────────────────────────────────────────────────
    def _read_raw(self) -> str:
        """Lecture LÉNIENTE (chemins d'affichage/rendu) : absent OU illisible →
        "". Non destructif — sert render_block/char_count/usage_pct."""
        try:
            return self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""
        except Exception:
            return ""

    def _read_raw_strict(self) -> str:
        """Lecture STRICTE (chemin de MUTATION) : "" seulement si le fichier est
        ABSENT (store vide légitime) ; toute autre erreur (OSError I/O,
        UnicodeDecodeError) est RE-LEVÉE en ``StoreReadError`` pour que la
        mutation avorte au lieu d'écraser l'existant par un candidat dérivé du
        vide (perte de données silencieuse)."""
        try:
            return self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""
        except Exception as _e:
            raise StoreReadError(str(_e)) from _e

    def entries(self) -> List[str]:
        return parse_entries(self._read_raw())

    def _entries_strict(self) -> List[str]:
        return parse_entries(self._read_raw_strict())

    def _read_failed_result(self, action: str, err: Exception) -> StoreOpResult:
        """Résultat d'échec quand la relecture sous verrou est impossible : AUCUNE
        écriture n'a lieu, l'état n'est pas présumé vide."""
        logger.warning("[memory] %s avorté : fichier illisible (%s) — aucune "
                       "écriture, données préservées", action, str(err)[:120])
        return self._result(
            False, action, [],
            "memory file unreadable (I/O or non-UTF-8 encoding); nothing was "
            "written, to avoid clobbering the existing entries",
            error_code="read_failed")

    def char_count(self) -> int:
        return len(_serialize(self.entries()))

    def usage_pct(self) -> float:
        if self.char_limit <= 0:
            return 0.0
        return round(100.0 * self.char_count() / self.char_limit, 1)

    # ── Écriture atomique ──────────────────────────────────────────────────────
    def _write_entries(self, entries: List[str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = _serialize(entries)
        # Écriture atomique : temp dans le même dossier + os.replace.
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(data)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            raise

    def _transaction(self):
        return _store_transaction(self.path, self.lock_timeout_s)

    def _result(self, ok: bool, action: str, entries: List[str],
                error: Optional[str] = None, *,
                error_code: Optional[str] = None,
                closest_index: Optional[int] = None,
                candidate_indexes: Optional[List[int]] = None,
                before: Optional[List[str]] = None,
                unchanged: bool = False) -> StoreOpResult:
        clean = [e for e in entries if e.strip()]
        chars = len(_serialize(entries))
        return StoreOpResult(
            ok=ok, action=action, error=error, error_code=error_code,
            chars=chars, limit=self.char_limit,
            usage_pct=round(100.0 * chars / self.char_limit, 1) if self.char_limit else 0.0,
            n_entries=len(clean),
            entries=clean,
            entry_ids=entry_ids(clean),
            closest_index=closest_index,
            candidate_indexes=list(candidate_indexes or []),
            before=[e for e in (before or []) if e.strip()],
            unchanged=bool(unchanged),
        )

    # ── Opérations de curation ─────────────────────────────────────────────────
    def add(self, content: str) -> StoreOpResult:
        content = sanitize_entry_text((content or "").strip())
        if not content:
            return self._result(False, "add", self.entries(),
                                "content is empty", error_code="empty_content")
        with self._transaction():
            # RE-LIRE à l'intérieur du lock : invalide toute donnée stale
            # observée avant l'acquisition. Lecture STRICTE : si le fichier
            # existe mais est illisible, on AVORTE (pas de réécriture dérivée
            # du vide qui effacerait tout).
            try:
                entries = self._entries_strict()
            except StoreReadError as _e:
                return self._read_failed_result("add", _e)
            if content in entries:
                # Idempotent : le fait est déjà mémorisé tel quel — succès
                # sans doublon (deux entrées identiques rendraient leur id
                # ambigu et gaspilleraient le budget).
                return self._result(True, "add", entries, before=entries,
                                    unchanged=True)
            candidate = entries + [content]
            if len(_serialize(candidate)) > self.char_limit:
                # Au-delà de la limite : on REFUSE et on renvoie l'état courant pour
                # que l'agent consolide (remove/replace/rewrite) avant de réessayer.
                return self._result(
                    False, "add", entries,
                    f"exceeds the limit ({len(_serialize(candidate))}/{self.char_limit} chars); "
                    f"consolidate or remove an entry first",
                    error_code="over_limit")
            self._write_entries(candidate)
            return self._result(True, "add", candidate, before=entries)

    def replace(self, target: str, content: str) -> StoreOpResult:
        """Remplace l'entrée UNIQUE ciblée (id ``[a1f4]`` ou extrait) par ``content``."""
        content = sanitize_entry_text((content or "").strip())
        if not content:
            return self._result(False, "replace", self.entries(),
                                "content is empty", error_code="empty_content")
        with self._transaction():
            try:
                entries = self._entries_strict()
            except StoreReadError as _e:
                return self._read_failed_result("replace", _e)
            res = _resolve_target(entries, target)
            if res.index is None:
                if res.candidates:
                    return self._result(
                        False, "replace", entries,
                        f"ambiguous target ({len(res.candidates)} entries match); "
                        f"use the id of ONE entry",
                        error_code="ambiguous", candidate_indexes=res.candidates)
                return self._result(
                    False, "replace", entries,
                    "no entry matches the target; reuse the bracketed id as "
                    "displayed",
                    error_code="no_match", closest_index=res.closest_index)
            candidate = list(entries)
            candidate[res.index] = content
            if len(_serialize(candidate)) > self.char_limit:
                return self._result(
                    False, "replace", entries,
                    f"exceeds the limit ({len(_serialize(candidate))}/{self.char_limit} chars)",
                    error_code="over_limit")
            self._write_entries(candidate)
            return self._result(True, "replace", candidate, before=entries)

    def remove(self, target: str) -> StoreOpResult:
        """Supprime l'entrée UNIQUE ciblée (id ``[a1f4]`` ou extrait)."""
        with self._transaction():
            try:
                entries = self._entries_strict()
            except StoreReadError as _e:
                return self._read_failed_result("remove", _e)
            res = _resolve_target(entries, target)
            if res.index is None:
                if res.candidates:
                    return self._result(
                        False, "remove", entries,
                        f"ambiguous target ({len(res.candidates)} entries match); "
                        f"use the id of ONE entry",
                        error_code="ambiguous", candidate_indexes=res.candidates)
                return self._result(
                    False, "remove", entries,
                    "no entry matches the target; reuse the bracketed id as "
                    "displayed",
                    error_code="no_match", closest_index=res.closest_index)
            candidate = [e for i, e in enumerate(entries) if i != res.index]
            self._write_entries(candidate)
            return self._result(True, "remove", candidate, before=entries)

    def rewrite(self, content: str) -> StoreOpResult:
        """Réécrit TOUT le store en une transaction (consolidation en un appel).

        ``content`` = les nouvelles entrées séparées par une ligne ``---``
        (ou ``§``). Refuse un résultat vide (anti-wipe accidentel : vider un
        store se fait entrée par entrée via ``remove``) et le dépassement de
        limite — dans les deux cas l'état courant est renvoyé intact.
        """
        parts = [p.strip() for p in _REWRITE_SPLIT_RE.split(content or "") if p.strip()]
        return self.set_entries(parts)

    def set_entries(self, entries: List[str]) -> StoreOpResult:
        """Remplace TOUT le store par ``entries`` — la liste, déjà découpée.

        Sœur de :meth:`rewrite` pour les appelants qui tiennent les entrées une
        par une (l'éditeur de Réglages → Mémoire) plutôt qu'un document à
        redécouper. La distinction n'est pas cosmétique : ``rewrite`` scinde sur
        toute ligne ``---`` ou ``§``, or un trait horizontal Markdown est
        parfaitement légitime DANS une entrée — passer par un document le
        couperait en deux. Ici les frontières sont celles que l'appelant donne.

        Mêmes garde-fous que ``rewrite`` (refus du vide, refus du dépassement)
        et mêmes messages : c'est le chemin d'écriture unique des deux.
        """
        parts = [sanitize_entry_text(str(e).strip())
                 for e in (entries or []) if str(e).strip()]
        with self._transaction():
            # Lecture LÉNIENTE volontaire : on REMPLACE tout par ``parts``
            # (jamais dérivé de l'existant), c'est donc le chemin de RÉCUPÉRATION
            # d'un store corrompu — le bloquer sur lecture illisible empêcherait
            # l'utilisateur de réparer son fichier. ``current`` ne sert qu'aux
            # retours d'erreur (empty_content/over_limit).
            current = self.entries()
            if not parts:
                return self._result(
                    False, "rewrite", current,
                    "empty content: rewrite replaces the WHOLE store and requires at "
                    "least one entry (separate them with a --- line)",
                    error_code="empty_content")
            if len(_serialize(parts)) > self.char_limit:
                return self._result(
                    False, "rewrite", current,
                    f"exceeds the limit ({len(_serialize(parts))}/{self.char_limit} chars); "
                    f"rewrite shorter",
                    error_code="over_limit")
            self._write_entries(parts)
            return self._result(True, "rewrite", parts, before=current)

    def restore(self, expected: List[str], entries: List[str]) -> StoreOpResult:
        """Compare-and-set : remet ``entries`` SI le magasin vaut encore
        ``expected`` (annulation d'une écriture journalisée). Sinon
        ``error_code="changed"`` et rien n'est écrit — une annulation n'écrase
        jamais une écriture plus récente. Une liste vide est permise ici
        (annuler le premier ajout vide le magasin), contrairement à ``rewrite``."""
        want = [str(e).strip() for e in (expected or []) if str(e).strip()]
        parts = [sanitize_entry_text(str(e).strip())
                 for e in (entries or []) if str(e).strip()]
        with self._transaction():
            try:
                current = self._entries_strict()
            except StoreReadError as _e:
                return self._read_failed_result("restore", _e)
            if current != want:
                return self._result(
                    False, "restore", current,
                    "the store changed since this write; nothing was restored",
                    error_code="changed")
            if len(_serialize(parts)) > self.char_limit:
                return self._result(
                    False, "restore", current,
                    f"exceeds the limit ({len(_serialize(parts))}/{self.char_limit} chars)",
                    error_code="over_limit")
            self._write_entries(parts)
            return self._result(True, "restore", parts, before=current)

    # ── Rendu pour le system prompt ───────────────────────────────────────────
    def render_block(self) -> str:
        """Rend le magasin en bloc Markdown (en-tête + usage + entrées).

        Chaque entrée est préfixée de son id ``[a1f4] `` sur sa PREMIÈRE ligne —
        c'est la cible sûre pour ``replace``/``remove``. Les ids sont calculés
        au rendu (jamais persistés dans le ``.md``).
        Retourne "" si le magasin est vide (l'appelant saute alors le bloc).
        """
        entries = self.entries()
        if not entries:
            return ""
        chars = len(_serialize(entries))
        pct = round(100.0 * chars / self.char_limit, 1) if self.char_limit else 0.0
        head = f"## {self.label}  ({chars}/{self.char_limit} chars · {pct}%)"
        # En-tête éditable à froid (memory.header_template). Vide => en-tête
        # historique AVEC télémétrie. Mettre p.ex. "## {label}" retire la
        # télémétrie de quota vue par le modèle. Placeholders : {label} {chars}
        # {limit} {pct}.
        try:
            from llm_core.context_config import CTX as _CTX
            _tmpl = _CTX.override("memory.header_template", "")
            if _tmpl:
                head = _tmpl.format(label=self.label, chars=chars,
                                    limit=self.char_limit, pct=pct)
        except Exception:
            pass
        ids = entry_ids(entries)
        body = ("\n" + DELIM + "\n").join(
            f"[{eid}] {e}" for eid, e in zip(ids, entries))
        return head + "\n" + body
