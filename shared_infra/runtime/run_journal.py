# SPDX-License-Identifier: MIT
"""shared_infra.runtime.run_journal — journal des événements d'un run de chat,
relisible depuis N'IMPORTE QUEL worker.

Le problème (AUDIT 2026-09-16, chantier C)
------------------------------------------
Revenir sur une conversation qui génère encore ne montrait RIEN : ni bulle, ni
étapes d'outils, ni bouton Stop — seulement un toast « une génération est en
cours ». Le flux d'un tour vivait dans la file mémoire du worker qui avait reçu
le POST ; le navigateur n'en gardait qu'une copie tant qu'il ne changeait pas
de chat (un seul flux parqué, perdu au rechargement, tué par un envoi
ailleurs). Sous gunicorn multi-worker, une nouvelle requête atterrit n'importe
où : elle ne peut pas lire cette file.

La pratique des projets de référence (LibreChat : journal par run + reprise ;
llama.cpp : tampon par conversation relu depuis un décalage) est de découpler
le run de la connexion et de rejouer ses événements. Nous n'avons pas Redis,
mais les canaux inter-workers de l'application sont déjà des FICHIERS
(``cancel_bus``, ``chat_locks``, ``_task_resume``) : même patron ici.

Fonctionnement
--------------
Un dossier par (utilisateur, chat) — nom HACHÉ, jamais l'identifiant client :

    <RUN_DIR>/u<uid>-<sha>/current.json      pointeur du run en cours (atomique)
    <RUN_DIR>/u<uid>-<sha>/<run_id>.jsonl    une ligne par événement : {"s": n, "e": {...}}
    <RUN_DIR>/u<uid>-<sha>/<run_id>.end      présent quand le run est terminé

* Le worker qui porte le run ÉCRIT (un seul écrivain, par lots de ~100 ms dans
  un thread, ordre préservé). Les tokens consécutifs sont fusionnés (champ
  ``n``), comme le fait déjà le flux HTTP (``_drain_coalesced``).
* N'importe quel worker RELIT en suivant la fin du fichier : rejeu complet
  puis direct (cf. la route ``/api/chat/{id}/run/events``).
* Plafond par journal (``llm.run_journal_max_mb``, 64 Mo) : au-delà, seuls les
  événements STRUCTURANTS (outils, erreurs, ``final``…) sont encore écrits, avec
  un marqueur ``journal_truncated`` — le ``final`` porte de toute façon l'état
  complet du tour.
* Rétention : un journal terminé est supprimé ``RETENTION_S`` après sa fin
  (balayage de maintenance) ; un journal orphelin (worker tué) après 24 h.

Modes de défaillance : tout est best-effort. Un journal inutilisable (disque
plein, droits) ne casse JAMAIS le tour : le client retombe sur le suivi par
sondage historique (``/generation-status``).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from shared_infra.runtime.runtime_dir import runtime_path as _runtime_path

logger = logging.getLogger("uvicorn.error")

RUN_DIR = _runtime_path("chat_runs", "ELPIS_CHAT_RUNS_DIR", "/tmp/elpis_chat_runs")

#: Journal terminé : supprimé après ce délai (le tour est en base depuis).
RETENTION_S = 600.0
#: Journal jamais terminé (worker tué) : supprimé après ce délai.
ORPHAN_S = 24 * 3600.0
#: Cadence d'écriture et taille de lot.
FLUSH_INTERVAL_S = 0.1
FLUSH_MAX_EVENTS = 64

#: Balayage opportuniste au démarrage d'un run (la maintenance quotidienne
#: seule laisserait les journaux terminés vivre jusqu'à 24 h).
SWEEP_EVERY_S = 300.0
_last_sweep = 0.0
#: Taille maximale lue par passe de relecture (le rejeu d'un gros journal ne
#: charge pas tout en mémoire d'un coup).
READ_CHUNK_BYTES = 1 << 20

#: Tokens fusionnables (même règle que ``chats._drain_coalesced``).
_COALESCABLE = ("content_token", "thinking_token")
#: Événements volumineux ou fréquents, abandonnés au-delà du plafond.
_DROPPABLE = frozenset(("content_token", "thinking_token", "tool_call_delta",
                        "shell_output", "prompt_progress", "tool_progress",
                        "kv_cache", "ping"))


def _merge_key(ev: Dict[str, Any]):
    """Clé de fusion de deux events consécutifs (``None`` = jamais fusionné)."""
    t = ev.get("type")
    if t in _COALESCABLE and isinstance(ev.get("text", ""), str):
        return (t,)
    if t == "tool_call_delta" and not ev.get("reset"):
        return (t, ev.get("iter"), ev.get("index"))
    return None


def _join_parts(ev: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: v for k, v in ev.items() if k != "_parts"}
    parts = ev["_parts"]
    if isinstance(parts, tuple):                   # tool_call_delta
        names, args = "".join(parts[0]), "".join(parts[1])
        if names:
            out["name_delta"] = names
        if args:
            out["args_delta"] = args
    else:
        out["text"] = "".join(parts)
    return out


def _max_bytes() -> int:
    try:
        from shared_infra.config import config_view
        mb = float(getattr(config_view().llm, "run_journal_max_mb", 64) or 64)
    except Exception:                                           # noqa: BLE001
        mb = 64.0
    return int(max(1.0, mb) * 1024 * 1024)


def _base_ok(create: bool) -> bool:
    """La racine nous appartient-elle, sans droits pour les autres comptes ?

    Un journal est rejoué tel quel dans le navigateur : un fichier déposé par
    un tiers dans un ``/tmp`` partagé injecterait des événements dans la
    conversation d'un utilisateur. Racine étrangère ou ouverte ⇒ journal
    désactivé (le client retombe sur le suivi par sondage)."""
    from shared_infra.runtime.runtime_dir import _own_and_private
    base = Path(RUN_DIR)
    if create:
        try:
            base.mkdir(parents=True, mode=0o700, exist_ok=True)
            os.chmod(base, 0o700)
        except OSError:
            return False
    return _own_and_private(base)


def _chat_dir(user_id: int, chat_id: str) -> Path:
    h = hashlib.sha256(f"{int(user_id)}\x00{chat_id}".encode("utf-8")).hexdigest()[:24]
    return Path(RUN_DIR) / f"u{int(user_id)}-{h}"


def _safe_run_id(run_id: str) -> str:
    rid = "".join(c for c in str(run_id or "") if c.isalnum())[:32]
    return rid


def _write_json_atomic(path: Path, data: Dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(str(tmp), str(path))


# ─────────────────────────────────────────────────────────────────────────────
#  Écriture (worker qui porte le run)
# ─────────────────────────────────────────────────────────────────────────────
class RunJournal:
    """Journal d'UN run. ``append`` est synchrone et ne bloque jamais la boucle ;
    l'écriture disque part par lots dans un thread."""

    def __init__(self, user_id: int, chat_id: str, run_id: str,
                 meta: Optional[Dict[str, Any]] = None):
        self.user_id = int(user_id)
        self.chat_id = str(chat_id)
        self.run_id = _safe_run_id(run_id)
        self.meta = dict(meta or {})
        self.dir = _chat_dir(self.user_id, self.chat_id)
        self.path = self.dir / f"{self.run_id}.jsonl"
        self._pending: List[Dict[str, Any]] = []
        self._seq = 0
        self._bytes = 0
        self._cap = _max_bytes()
        self._truncated = False
        self._closed = False
        self._ok = False
        self._task: Optional[asyncio.Task] = None
        self._wake: Optional[asyncio.Event] = None
        self._write_lock: Optional[asyncio.Lock] = None

    # -- cycle de vie ---------------------------------------------------------
    async def open(self, started: Dict[str, Any]) -> bool:
        """Crée le journal, pose le pointeur ``current.json`` et écrit
        ``run_started``. ``False`` = journal indisponible (le tour continue)."""
        if not self.run_id:
            return False
        try:
            await asyncio.to_thread(self._prepare)
        except Exception as e:                                  # noqa: BLE001
            logger.warning("[run_journal] ouverture impossible (%s) — reprise "
                           "de l'affichage indisponible pour ce tour", str(e)[:160])
            return False
        self._ok = True
        self._wake = asyncio.Event()
        self._write_lock = asyncio.Lock()
        self.append(dict(started, type="run_started", run_id=self.run_id))
        try:
            self._task = asyncio.get_running_loop().create_task(
                self._flush_loop(), name=f"run-journal-{self.run_id[:8]}")
        except RuntimeError:
            self._task = None
        return True

    def _prepare(self) -> None:
        global _last_sweep
        if (time.time() - _last_sweep) > SWEEP_EVERY_S:
            _last_sweep = time.time()
            try:
                sweep()
            except Exception:                                   # noqa: BLE001
                pass
        if not _base_ok(create=True):
            raise PermissionError(f"{RUN_DIR} n'est pas privé à ce compte")
        self.dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass
        # Les runs PRÉCÉDENTS terminés de ce chat n'ont plus d'usage.
        for p in self.dir.glob("*.end"):
            rid = p.stem
            if rid != self.run_id:
                for suffix in (".jsonl", ".end"):
                    try:
                        (self.dir / f"{rid}{suffix}").unlink()
                    except FileNotFoundError:
                        pass
        fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.close(fd)
        _write_json_atomic(self.dir / "current.json", {
            "run_id": self.run_id, "chat_id": self.chat_id,
            "user_id": self.user_id, "started_at": time.time(), **self.meta,
        })

    def append(self, ev: Dict[str, Any]) -> None:
        if not self._ok or self._closed or not isinstance(ev, dict):
            return
        t = ev.get("type")
        if self._truncated and t in _DROPPABLE:
            return
        last = self._pending[-1] if self._pending else None
        # Passe d'optimisation 2026-09-26 — la fusion recopiait tout le texte
        # accumulé à chaque token (``last["text"] + text``, O(n) par token dans
        # une fenêtre de 100 ms) : on accumule désormais des MORCEAUX dans une
        # copie privée, joints une seule fois au flush. Les ``tool_call_delta``
        # consécutifs d'un même appel fusionnent aussi (même règle que
        # ``chats._drain_coalesced``).
        if last is not None and _merge_key(last) is not None \
                and _merge_key(last) == _merge_key(ev):
            if "_parts" not in last:
                last = dict(last)          # jamais muter l'objet de l'émetteur
                self._pending[-1] = last
                if t == "tool_call_delta":
                    last["_parts"] = ([last.pop("name_delta", "") or ""],
                                      [last.pop("args_delta", "") or ""])
                else:
                    last["_parts"] = [str(last.get("text") or "")]
            if t == "tool_call_delta":
                last["_parts"][0].append(ev.get("name_delta") or "")
                last["_parts"][1].append(ev.get("args_delta") or "")
            else:
                last["_parts"].append(str(ev.get("text") or ""))
                last["n"] = int(last.get("n") or 1) + int(ev.get("n") or 1)
        else:
            self._pending.append(ev)
        if len(self._pending) >= FLUSH_MAX_EVENTS and self._wake is not None:
            self._wake.set()

    async def close(self, status: str = "done") -> None:
        """Écrit ``run_end`` et la marque de fin. Idempotent."""
        if not self._ok or self._closed:
            return
        self.append({"type": "run_end", "status": str(status or "done")})
        self._closed = True
        if self._task is not None:
            self._wake.set()
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
                self._task.cancel()
        await self._flush()
        try:
            await asyncio.to_thread(self._mark_end)
        except Exception:                                       # noqa: BLE001
            pass

    def _mark_end(self) -> None:
        fd = os.open(str(self.dir / f"{self.run_id}.end"),
                     os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.close(fd)

    # -- écriture par lots ------------------------------------------------------
    async def _flush_loop(self) -> None:
        while not self._closed:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=FLUSH_INTERVAL_S)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()
            await self._flush()

    async def _flush(self) -> None:
        if not self._pending:
            return
        async with self._write_lock:
            batch, self._pending = self._pending, []
            lines: List[str] = []
            for ev in batch:
                if "_parts" in ev:
                    ev = _join_parts(ev)
                t = ev.get("type")
                if self._bytes >= self._cap and t in _DROPPABLE:
                    if not self._truncated:
                        self._truncated = True
                        self._seq += 1
                        lines.append(json.dumps({"s": self._seq, "e": {
                            "type": "journal_truncated"}}) + "\n")
                    continue
                try:
                    self._seq += 1
                    line = json.dumps({"s": self._seq, "e": ev},
                                      ensure_ascii=False, default=str) + "\n"
                except (TypeError, ValueError):
                    continue
                self._bytes += len(line)
                lines.append(line)
            if not lines:
                return
            data = "".join(lines)
            try:
                await asyncio.to_thread(self._write, data)
            except Exception as e:                              # noqa: BLE001
                logger.debug("[run_journal] écriture impossible : %s", str(e)[:120])

    def _write(self, data: str) -> None:
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(data)


# ─────────────────────────────────────────────────────────────────────────────
#  Lecture (n'importe quel worker)
# ─────────────────────────────────────────────────────────────────────────────
def current_run(user_id: int, chat_id: str) -> Optional[Dict[str, Any]]:
    """Pointeur du dernier run de ce chat, enrichi de ``ended`` ; ``None`` si
    aucun journal n'existe (ou s'il a été balayé)."""
    if not _base_ok(create=False):
        return None
    d = _chat_dir(user_id, chat_id)
    try:
        data = json.loads((d / "current.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    rid = _safe_run_id(data.get("run_id"))
    if not rid or not (d / f"{rid}.jsonl").exists():
        return None
    data["run_id"] = rid
    data["ended"] = (d / f"{rid}.end").exists()
    return data


def journal_path(user_id: int, chat_id: str, run_id: str) -> Optional[Path]:
    rid = _safe_run_id(run_id)
    if not rid:
        return None
    return _chat_dir(user_id, chat_id) / f"{rid}.jsonl"


def is_ended(user_id: int, chat_id: str, run_id: str) -> bool:
    rid = _safe_run_id(run_id)
    return bool(rid) and (_chat_dir(user_id, chat_id) / f"{rid}.end").exists()


def read_lines(path: Path, offset: int,
               max_bytes: int = READ_CHUNK_BYTES) -> Tuple[List[Dict[str, Any]], int]:
    """Lignes COMPLÈTES à partir de ``offset`` (octets) → ``(entrées, nouvel
    offset)``. Une ligne partielle (écriture en cours) est laissée pour la
    lecture suivante. Lit au plus ``max_bytes`` par appel, sauf si une ligne
    unique est plus longue (elle est alors lue en entier)."""
    with open(path, "rb") as fh:
        fh.seek(offset)
        chunk = fh.read(max_bytes)
        while chunk and b"\n" not in chunk:
            more = fh.read(max_bytes)
            if not more:
                break
            chunk += more
    if not chunk:
        return [], offset
    end = chunk.rfind(b"\n")
    if end < 0:
        return [], offset
    out: List[Dict[str, Any]] = []
    for raw in chunk[:end + 1].splitlines():
        if not raw.strip():
            continue
        try:
            item = json.loads(raw)
        except ValueError:
            continue
        if isinstance(item, dict) and isinstance(item.get("e"), dict):
            out.append(item)
    return out, offset + end + 1


def list_active_chat_ids(user_id: int) -> List[str]:
    """Chats de cet utilisateur dont un run est EN COURS : journal non terminé
    ET verrou de présence tenu (un worker mort libère son verrou)."""
    out: List[str] = []
    base = Path(RUN_DIR)
    if not _base_ok(create=False):
        return out
    try:
        dirs = list(base.glob(f"u{int(user_id)}-*"))
    except OSError:
        return out
    from shared_infra.runtime import chat_locks
    for d in dirs:
        try:
            data = json.loads((d / "current.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rid = _safe_run_id(data.get("run_id"))
        cid = str(data.get("chat_id") or "")
        if not rid or not cid or (d / f"{rid}.end").exists():
            continue
        if chat_locks.is_held("gen", int(user_id), cid):
            out.append(cid)
    return out


def sweep(now: Optional[float] = None) -> int:
    """Supprime les journaux terminés depuis ``RETENTION_S`` et les orphelins
    de plus de ``ORPHAN_S``. Rend le nombre de runs supprimés."""
    now = time.time() if now is None else now
    removed = 0
    base = Path(RUN_DIR)
    try:
        dirs = [d for d in base.iterdir() if d.is_dir()]
    except OSError:
        return 0
    for d in dirs:
        try:
            for jl in d.glob("*.jsonl"):
                rid = jl.stem
                end = d / f"{rid}.end"
                try:
                    if end.exists():
                        expired = (now - end.stat().st_mtime) > RETENTION_S
                    else:
                        expired = (now - jl.stat().st_mtime) > ORPHAN_S
                except FileNotFoundError:
                    continue
                if expired:
                    for p in (jl, end):
                        try:
                            p.unlink()
                        except FileNotFoundError:
                            pass
                    removed += 1
            if not any(d.glob("*.jsonl")):
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            continue
    return removed
