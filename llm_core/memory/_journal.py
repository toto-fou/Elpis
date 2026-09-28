# SPDX-License-Identifier: MIT
"""
llm_core.memory._journal — Journal borné des écritures mémoire (2026-09-19).

Une ligne JSONL par écriture EFFECTIVE (le contenu a changé) d'un magasin
``USER.md`` / ``MEMORY.md`` : l'outil ``memory`` (``source="tool"``), l'éditeur
de Réglages (``"settings"``) et les annulations (``"undo"``). Chaque ligne porte
l'état AVANT et APRÈS (listes d'entrées, ≤ quelques Ko : les magasins sont
plafonnés), ce qui suffit à :

- montrer dans le fil du chat CE qui a été écrit (ajouté / remplacé / retiré),
  lu à la demande par ``op`` — le résultat de l'outil ne porte que l'id, le
  modèle n'en paie pas le texte ;
- ANNULER une écriture (retour à ``before``) tant que le magasin est resté
  dans l'état ``after`` (sinon refus : une annulation n'écrase jamais une
  écriture plus récente) ;
- dater chaque note et retrouver le chat qui l'a écrite (Réglages → Mémoire).

Borné à ``MAX_RECORDS`` lignes (rognage amorti). Écritures sous ``flock`` sur
un sentinelle dédié : plusieurs chats d'un même compte peuvent écrire en
parallèle. Pur : aucun import app / DB.
"""
from __future__ import annotations

import fcntl
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

JOURNAL_NAME = ".journal.jsonl"
MAX_RECORDS = 200
# Rognage amorti : on ne réécrit le fichier qu'au-delà de cette taille.
_TRIM_AT = MAX_RECORDS + 50


def journal_path(mem_dir: "str | Path") -> Path:
    return Path(mem_dir) / JOURNAL_NAME


class _Locked:
    """flock exclusif sur ``.journal.jsonl.lock`` (bloquant, court)."""

    def __init__(self, mem_dir: Path) -> None:
        self._lock = Path(mem_dir) / (JOURNAL_NAME + ".lock")
        self._fd: Optional[int] = None

    def __enter__(self):
        self._lock.parent.mkdir(parents=True, exist_ok=True)
        self._fd = os.open(str(self._lock), os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(self._fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                os.close(self._fd)
                self._fd = None
        return False


def _read_lines(path: Path) -> List[str]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return [ln for ln in fh.read().splitlines() if ln.strip()]
    except FileNotFoundError:
        return []
    except Exception:
        return []


def records(mem_dir: "str | Path") -> List[Dict[str, Any]]:
    """Toutes les lignes lisibles, de la plus ancienne à la plus récente."""
    out: List[Dict[str, Any]] = []
    for ln in _read_lines(journal_path(mem_dir)):
        try:
            rec = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and rec.get("op"):
            out.append(rec)
    return out


def get(mem_dir: "str | Path", op: str) -> Optional[Dict[str, Any]]:
    op = str(op or "").strip().lower()
    if not op:
        return None
    for rec in reversed(records(mem_dir)):
        if rec.get("op") == op:
            return rec
    return None


def undone_by(mem_dir: "str | Path", op: str) -> Optional[Dict[str, Any]]:
    """La ligne d'annulation de ``op``, s'il y en a une."""
    for rec in reversed(records(mem_dir)):
        if rec.get("undo_of") == op:
            return rec
    return None


def append(mem_dir: "str | Path", *, action: str, store: str,
           before: Iterable[str], after: Iterable[str],
           source: str = "tool", chat_id: Optional[str] = None,
           title: Optional[str] = None,
           undo_of: Optional[str] = None) -> Optional[str]:
    """Ajoute une écriture et renvoie son ``op``. ``None`` si rien n'a changé
    (``before == after`` : un ajout idempotent n'est pas une écriture)."""
    before_l = [str(e) for e in before]
    after_l = [str(e) for e in after]
    if before_l == after_l:
        return None
    mem_dir = Path(mem_dir)
    op = secrets.token_hex(4)
    rec = {
        "op": op, "ts": time.time(), "source": source,
        "action": action, "store": store,
        "chat_id": chat_id or None,
        "title": (title or None),
        "before": before_l, "after": after_l,
    }
    if undo_of:
        rec["undo_of"] = undo_of
    path = journal_path(mem_dir)
    with _Locked(mem_dir):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        lines = _read_lines(path)
        if len(lines) > _TRIM_AT:
            tmp = path.with_suffix(path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines[-MAX_RECORDS:]) + "\n")
            os.replace(tmp, path)
    return op


def diff(rec: Dict[str, Any]) -> Dict[str, List[str]]:
    """Entrées ajoutées / retirées par une écriture (différence de multisets,
    ordre conservé) : un ``replace`` donne 1 retirée + 1 ajoutée."""
    before = list(rec.get("before") or [])
    after = list(rec.get("after") or [])
    rest_before = list(before)
    added: List[str] = []
    for e in after:
        if e in rest_before:
            rest_before.remove(e)
        else:
            added.append(e)
    rest_after = list(after)
    removed: List[str] = []
    for e in before:
        if e in rest_after:
            rest_after.remove(e)
        else:
            removed.append(e)
    return {"added": added, "removed": removed}


def origins(mem_dir: "str | Path", store: str,
            entries: List[str]) -> List[Optional[Dict[str, Any]]]:
    """Pour chaque entrée actuelle : l'écriture qui l'a fait apparaître
    (``ts``, ``source``, ``chat_id``), la plus récente d'abord. ``None`` si
    l'entrée est antérieure au journal."""
    recs = [r for r in records(mem_dir) if r.get("store") == store]
    out: List[Optional[Dict[str, Any]]] = []
    for text in entries:
        found = None
        for rec in reversed(recs):
            if text in (rec.get("after") or []) and text not in (rec.get("before") or []):
                cand = {"ts": rec.get("ts"), "source": rec.get("source"),
                        "chat_id": rec.get("chat_id"), "op": rec.get("op")}
                if rec.get("source") != "undo":
                    found = cand
                    break
                # Note RESTAURÉE par une annulation : son origine est l'écriture
                # qui l'avait créée (plus haut dans le journal), pas
                # l'annulation. Celle-ci ne sert que de repli si l'écriture
                # d'origine est sortie du journal.
                found = found or cand
        out.append(found)
    return out


def purge(mem_dir: "str | Path") -> bool:
    """Supprime le journal (effacement complet de la mémoire)."""
    removed = False
    for name in (JOURNAL_NAME, JOURNAL_NAME + ".lock"):
        try:
            (Path(mem_dir) / name).unlink()
            removed = True
        except FileNotFoundError:
            pass
    return removed
