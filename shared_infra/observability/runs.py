# SPDX-License-Identifier: MIT
"""
shared_infra.observability.runs — Exécutions (L5.2) : une ligne par tour de
chat, run de routine, sous-agent ou compaction manuelle.

Ce qu'une exécution a consommé et comment elle s'est terminée se lit dans UNE
ligne de ``runs``, sans jointure approximative : jetons (entrée, sortie, cache
lu, cache écrit, réflexion), temps LLM (pré-remplissage, décodage, attente du
moteur), appels d'outils (total, par famille, erreurs), fichiers modifiés,
pics CPU / RAM de la sandbox. ``usage_events`` et ``tool_call_metrics``
portent son ``run_id`` ; une exécution fille (sous-agent) porte ``parent_id``.
Ressources seulement, jamais de monnaie (D14).

Enregistreur
============
``run_scope`` pose l'exécution courante dans un ``ContextVar`` (suivi par
``await``, les tâches filles, ``asyncio.to_thread`` et les exécuteurs lancés
avec ``copy_context``). Les points de mesure l'alimentent sans connaître leur
appelant : ``record_turn_usage`` (jetons, statut), la lecture des flux LLM
(``timings``), l'attente du moteur, l'écriture des métriques d'outils, les
résultats d'outils qui modifient des fichiers. La ligne est écrite au début
(``running``) puis à la fin. Les jetons d'un sous-agent restent dans SON
exécution : le total d'un tour avec ses sous-agents se somme par
``parent_id``. Best-effort de bout en bout : une mesure perdue n'interrompt
jamais l'exécution.

Statut final : celui que pose le propriétaire (``finish``), sinon celui du
dernier tour LLM de sa propre source (un titre ou une compaction pendant un
tour de chat n'en décide pas), sinon ``ok`` ; une exception qui traverse la
portée donne ``cancelled``, ``timeout`` ou ``error``.

Identifiants : ``<genre>-<16 hex>`` (``chat-…``, ``routine-…``,
``subagent-…``, ``compaction-…``) ; un tour de chat reprend l'identifiant de
son journal. Les clés synthétiques de conversation (``routine:R:run:N``,
``<chat>#task-<id>``) restent des identifiants de CONVERSATION (``chat_id``).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, Iterable, Optional

logger = logging.getLogger("uvicorn.error")

KINDS = ("chat", "routine", "subagent", "compaction")
#: Source d'usage (``usage_events.source``) du propriétaire de chaque genre.
_SOURCES = {"chat": ("chat",), "routine": ("routine", "webhook"),
            "subagent": ("subagent",), "compaction": ("compression",)}
_FICHIERS_MAX = 10000
#: Échantillonnage de la sandbox (``docker stats``) pendant une exécution.
ECHANTILLON_S = 10.0
_TEXTE_MAX = 191                     # colonnes indexées : VARCHAR(191) en MySQL


def new_run_id(kind: str, suffix: str = "") -> str:
    return f"{kind}-{suffix or secrets.token_hex(8)}"


def _entier(v: Any) -> int:
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


@dataclass
class Execution:
    id: str
    kind: str
    user_id: Optional[int] = None
    chat_id: str = ""
    routine_id: Optional[int] = None
    parent_id: str = ""
    model: str = ""
    engine: str = ""
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    status: str = "running"
    error_kind: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    thinking_tokens: int = 0
    llm_calls: int = 0
    prefill_ms: int = 0
    decode_ms: int = 0
    wait_ms: int = 0
    tool_calls: int = 0
    tool_errors: int = 0
    tool_families: Dict[str, int] = field(default_factory=dict)
    sandbox_cpu_peak: Optional[float] = None
    sandbox_mem_peak_mb: Optional[float] = None
    _fichiers: set = field(default_factory=set, repr=False)
    _statut_llm: str = field(default="", repr=False)
    _verrou: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # Mesures : appelées depuis la boucle ET des threads d'exécuteur.
    def add_usage(self, *, source: str, status: str, input_tokens: Any = 0,
                  output_tokens: Any = 0, cache_read_tokens: Any = 0,
                  cache_creation_tokens: Any = 0, thinking_tokens: Any = 0,
                  error_kind: str = "") -> None:
        with self._verrou:
            self.input_tokens += _entier(input_tokens)
            self.output_tokens += _entier(output_tokens)
            self.cache_read_tokens += _entier(cache_read_tokens)
            self.cache_creation_tokens += _entier(cache_creation_tokens)
            self.thinking_tokens += _entier(thinking_tokens)
            if source in _SOURCES.get(self.kind, ()):
                self._statut_llm = (status or "ok").strip() or "ok"
                if error_kind:
                    self.error_kind = str(error_kind)[:120]

    def add_llm_call(self, timings: Any) -> None:
        """Un appel LLM abouti : ``timings`` de llama.cpp (``prompt_ms``,
        ``predicted_ms``) quand le moteur les donne."""
        t = timings if isinstance(timings, dict) else {}
        with self._verrou:
            self.llm_calls += 1
            for cle, attr in (("prompt_ms", "prefill_ms"), ("predicted_ms", "decode_ms")):
                try:
                    setattr(self, attr, getattr(self, attr) + max(0, int(float(t.get(cle) or 0))))
                except (TypeError, ValueError):
                    pass

    def add_wait(self, ms: Any) -> None:
        with self._verrou:
            self.wait_ms += _entier(ms)

    def add_tool_call(self, category: str, status: str) -> None:
        with self._verrou:
            self.tool_calls += 1
            cat = (category or "other")[:64]
            self.tool_families[cat] = self.tool_families.get(cat, 0) + 1
            if status != "success":
                self.tool_errors += 1

    def add_files(self, files: Optional[Iterable[Any]]) -> None:
        """Fichiers modifiés (``files`` d'un ``tool_result``) : chemins distincts."""
        with self._verrou:
            for f in files or ():
                p = f.get("path") if isinstance(f, dict) else f
                if isinstance(p, str) and p and len(self._fichiers) < _FICHIERS_MAX:
                    self._fichiers.add(p)

    def note_sandbox(self, cpu_pct: Optional[float], mem_mb: Optional[float]) -> None:
        with self._verrou:
            if cpu_pct is not None:
                self.sandbox_cpu_peak = max(self.sandbox_cpu_peak or 0.0, float(cpu_pct))
            if mem_mb is not None:
                self.sandbox_mem_peak_mb = max(self.sandbox_mem_peak_mb or 0.0, float(mem_mb))

    def finish(self, status: Optional[str] = None, error_kind: str = "") -> None:
        """Pose l'issue (la première l'emporte) : ``status`` donné, sinon
        celle du dernier tour LLM de la source du propriétaire, sinon ``ok``."""
        with self._verrou:
            if self.status != "running":
                return
            self.status = status or self._statut_llm or "ok"
            if error_kind:
                self.error_kind = str(error_kind)[:120]
            self.ended_at = time.time()

    @property
    def files_changed(self) -> int:
        return len(self._fichiers)

    def row(self) -> Dict[str, Any]:
        with self._verrou:
            return {
                "id": self.id, "kind": self.kind, "user_id": self.user_id,
                "chat_id": self.chat_id[:_TEXTE_MAX], "routine_id": self.routine_id,
                "parent_id": self.parent_id[:_TEXTE_MAX], "model": self.model,
                "engine": self.engine, "started_at": self.started_at,
                "ended_at": self.ended_at, "status": self.status[:_TEXTE_MAX],
                "error_kind": self.error_kind,
                "input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
                "cache_read_tokens": self.cache_read_tokens,
                "cache_creation_tokens": self.cache_creation_tokens,
                # Réflexion ⊆ sortie, comme dans ``usage_events``.
                "thinking_tokens": min(self.thinking_tokens, self.output_tokens)
                if self.output_tokens else self.thinking_tokens,
                "llm_calls": self.llm_calls, "prefill_ms": self.prefill_ms,
                "decode_ms": self.decode_ms, "wait_ms": self.wait_ms,
                "tool_calls": self.tool_calls, "tool_errors": self.tool_errors,
                "tool_families": json.dumps(self.tool_families, sort_keys=True),
                "files_changed": len(self._fichiers),
                "sandbox_cpu_peak": self.sandbox_cpu_peak,
                "sandbox_mem_peak_mb": self.sandbox_mem_peak_mb,
            }


_COURANTE: ContextVar[Optional[Execution]] = ContextVar("elpis_run", default=None)


def current_run() -> Optional[Execution]:
    return _COURANTE.get()


def current_run_id() -> str:
    e = _COURANTE.get()
    return e.id if e is not None else ""


# ── Écriture ────────────────────────────────────────────────────────────────

def upsert_run(row: Dict[str, Any]) -> bool:
    """Écrit la ligne (création ou mise à jour). Best-effort."""
    try:
        from shared_infra.db._connection import db_conn
        cols = list(row)
        sets = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "id")
        with db_conn() as conn:
            conn.execute(
                f"INSERT INTO runs({', '.join(cols)}) VALUES({', '.join('?' * len(cols))}) "
                f"ON CONFLICT(id) DO UPDATE SET {sets}",
                tuple(row[c] for c in cols))
            conn.commit()
        return True
    except Exception:
        logger.debug("[runs] écriture de %s impossible (non bloquant)", row.get("id"),
                     exc_info=True)
        return False


def get_run(run_id: str) -> Optional[Dict[str, Any]]:
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        r = conn.execute("SELECT * FROM runs WHERE id = ?", (str(run_id),)).fetchone()
    if r is None:
        return None
    d = dict(r)
    try:
        d["tool_families"] = json.loads(d.get("tool_families") or "{}")
    except (TypeError, ValueError):
        d["tool_families"] = {}
    return d


def purge_runs(retention_days: int) -> int:
    """Supprime les exécutions terminées de plus de ``retention_days`` jours
    (``<= 0`` : rien). Best-effort."""
    if retention_days <= 0:
        return 0
    try:
        from shared_infra.db._connection import db_conn
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM runs WHERE started_at < ?",
                        (time.time() - retention_days * 86400,))
            n = cur.rowcount
            conn.commit()
        return max(0, n or 0)
    except Exception:
        logger.debug("[maintenance] purge_runs failed (non-fatal)", exc_info=True)
        return 0


def _ecrire_sans_attendre(e: Execution) -> None:
    row = e.row()
    try:
        fut = asyncio.get_running_loop().run_in_executor(None, upsert_run, row)
    except RuntimeError:                                        # hors boucle
        upsert_run(row)
        return
    fut.add_done_callback(lambda f: f.cancelled() or f.exception())


# ── Portée ──────────────────────────────────────────────────────────────────

async def _echantillonner(e: Execution) -> None:
    """Pics CPU / RAM de la sandbox du compte, toutes les ``ECHANTILLON_S`` :
    conteneur en marche seulement, jamais démarré ; une mesure lente est
    abandonnée."""
    from shared_infra.sandbox.executors import running_container_stats
    uid = int(e.user_id or 0)
    while True:
        await asyncio.sleep(ECHANTILLON_S)
        try:
            st = await asyncio.wait_for(running_container_stats(uid), ECHANTILLON_S)
        except asyncio.CancelledError:
            raise
        except Exception:                                       # noqa: BLE001
            continue
        if st:
            e.note_sandbox(st.get("cpu_pct"), st.get("mem_mb"))


@contextlib.asynccontextmanager
async def run_scope(kind: str, *, run_id: str = "", user_id: Optional[int] = None,
                    chat_id: Any = "", routine_id: Optional[int] = None,
                    parent_id: Optional[str] = None, model: str = "", engine: str = "",
                    sample_sandbox: bool = True) -> AsyncIterator[Execution]:
    """Exécution courante pour la durée du bloc. ``parent_id`` : l'exécution
    englobante par défaut. La sandbox n'est échantillonnée que pour une
    exécution de premier niveau (celles qu'elle contient s'y déroulent)."""
    parent = _COURANTE.get()
    try:
        uid = int(user_id) if user_id is not None else None
    except (TypeError, ValueError):
        uid = None
    e = Execution(id=run_id or new_run_id(kind), kind=kind, user_id=uid,
                  chat_id=str(chat_id or ""), routine_id=routine_id,
                  parent_id=(parent.id if parent is not None else "") if parent_id is None
                  else str(parent_id or ""),
                  model=str(model or ""), engine=str(engine or ""))
    token = _COURANTE.set(e)
    sonde = None
    try:
        with contextlib.suppress(Exception):
            await asyncio.to_thread(upsert_run, e.row())    # ligne « running »
        if sample_sandbox and uid and parent is None:
            sonde = asyncio.create_task(_echantillonner(e))
        yield e
    except asyncio.CancelledError:
        e.finish("cancelled")
        raise
    except asyncio.TimeoutError:
        e.finish("timeout")
        raise
    except BaseException:
        e.finish("error")
        raise
    finally:
        if sonde is not None:
            sonde.cancel()
        _COURANTE.reset(token)
        e.finish()
        _ecrire_sans_attendre(e)


__all__ = ["ECHANTILLON_S", "KINDS", "Execution", "current_run", "current_run_id",
           "get_run", "new_run_id", "purge_runs", "run_scope", "upsert_run"]
