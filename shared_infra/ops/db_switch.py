# SPDX-License-Identifier: MIT
"""Bascule de la base de l'application d'un moteur à l'autre (chantier
multi-moteurs, lots D/E) — utilisé par la page admin « Base de données ».

Déroulé d'une bascule (``start_job``, tâche de fond du process admin) :

1. mode maintenance : ``.db_maintenance`` dans le dossier des données porte la
   génération CIBLE ; tout process d'une génération antérieure répond 503 aux
   requêtes qui écrivent (``MaintenanceASGI``) ;
2. attente que les générations LLM en cours se terminent (plafonnée) ;
3. transfert vers la cible vide (``transfer.transfer``), vérifié ;
4. écriture de la section ``database`` de config.json (+ ``generation``
   incrémentée, mot de passe dans ``.db_password`` 0600) ;
5. rechargement de main et d'admin. Un ancien worker qui survit au
   rechargement pour finir un run ne peut plus écrire dans l'ancienne base :
   ``_connection.db()`` refuse l'emprunt dès que la génération de config.json
   dépasse celle du process (``generation_guard``).

La sortie du mode maintenance est implicite : les process neufs portent la
nouvelle génération et ignorent le drapeau ; un échec l'efface. Un process
admin TUÉ pendant la copie (OOM, redémarrage) ne l'efface pas : le drapeau
n'est donc écouté que tant que la tâche est vivante (process admin en vie,
avancement récent) ou que la bascule est publiée (cf. ``maintenance_active``).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

log = logging.getLogger("uvicorn.error")

_JOB_LOCK = threading.Lock()
_WAIT_GENERATIONS_S = 120.0
_JOB_STALE_S = 600.0
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
_ALLOWED_PREFIXES = ("/api/admin/database", "/api/auth/", "/api/admin/internal/")


def _data_dir() -> Path:
    from shared_infra import config as cfg
    return Path(cfg.DB_PATH).parent


def _job_path() -> Path:
    return _data_dir() / ".db_job.json"


def _flag_path() -> Path:
    return _data_dir() / ".db_maintenance"


# ── Génération ───────────────────────────────────────────────────────────────

def process_generation() -> int:
    from shared_infra import config as cfg
    return int(getattr(cfg, "DB_GENERATION", 0) or 0)


def current_generation() -> int:
    """Génération publiée dans config.json (lecture en cache ≤ 1 s)."""
    from shared_infra.config import config_view
    try:
        return int(((config_view().get("database") or {}).get("generation")) or 0)
    except (TypeError, ValueError):
        return 0


def _read_flag() -> Optional[Dict[str, Any]]:
    """Drapeau de maintenance : ``None`` s'il est absent, ``{}`` s'il est
    présent mais illisible."""
    try:
        raw = _flag_path().read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        return {}
    try:
        flag = json.loads(raw)
    except ValueError:
        return {}
    return flag if isinstance(flag, dict) else {}


def published_generation() -> int:
    """Génération publiée selon le drapeau (0 tant que la bascule n'a pas
    écrit config.json) — seconde source de la garde de génération, quand
    config.json ne se lit plus."""
    flag = _read_flag() or {}
    try:
        return int(flag.get("generation") or 0) if flag.get("published") else 0
    except (TypeError, ValueError):
        return 0


def maintenance_active() -> bool:
    """Vrai pour un process d'une génération antérieure à une bascule EN COURS
    (tâche vivante) ou PUBLIÉE (config.json ou drapeau).

    Un drapeau laissé par un process admin tué pendant la copie n'est plus
    écouté : avant, toutes les écritures répondaient 503 indéfiniment. Un
    drapeau présent mais illisible ferme pendant une tâche vivante, au lieu de
    laisser écrire."""
    flag = _read_flag()
    if flag is None:
        return False
    try:
        target = int(flag.get("generation") or 0)
    except (TypeError, ValueError):
        target = 0
    if not target:
        return _running()
    if process_generation() >= target:
        return False
    return bool(flag.get("published")) or current_generation() >= target or _running()


class MaintenanceASGI:
    """503 sur les requêtes qui écrivent pendant une bascule de base."""

    def __init__(self, app):
        self.app = app
        self._checked = 0.0
        self._active = False

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("method") in _MUTATING:
            now = time.monotonic()
            if now - self._checked > 1.0:
                self._checked, self._active = now, maintenance_active()
            path = scope.get("path") or ""
            if self._active and not path.startswith(_ALLOWED_PREFIXES):
                body = json.dumps({"detail": "Base de données en cours de bascule — "
                                             "réessayer dans un instant."}).encode()
                await send({"type": "http.response.start", "status": 503,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"retry-after", b"30")]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


# ── Tâche ────────────────────────────────────────────────────────────────────

def _read_job() -> Dict[str, Any]:
    try:
        st = json.loads(_job_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"state": "idle"}
    return st if isinstance(st, dict) else {"state": "idle"}


def _pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except PermissionError:
        return True                       # existe, sous un autre compte
    except (OSError, TypeError, ValueError):
        return False
    return True


def _alive(st: Dict[str, Any]) -> bool:
    """La tâche « running » a-t-elle encore un process derrière elle ?"""
    if st.get("state") != "running":
        return False
    if time.time() - float(st.get("updated_at") or 0) >= _JOB_STALE_S:
        return False
    return "pid" not in st or _pid_alive(st["pid"])


def job_status() -> Dict[str, Any]:
    st = _read_job()
    if st.get("state") == "running" and not _alive(st):
        st = dict(st, state="error", error="bascule interrompue : le process qui la menait "
                                           "s'est arrêté ; la base active n'a pas changé")
    return st


def _write_job(**fields) -> None:
    from shared_infra.config import write_text_atomic
    cur = _read_job()
    cur.update(fields, updated_at=time.time())
    write_text_atomic(_job_path(), json.dumps(cur, ensure_ascii=False))


def _running() -> bool:
    return _alive(_read_job())


def _password_path(pending: bool = False) -> Path:
    return _data_dir() / (".db_password.pending" if pending else ".db_password")


def save_password(password: str, *, pending: bool = False) -> None:
    path = _password_path(pending)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(password)
    os.chmod(path, 0o600)


def pending_password() -> str:
    """Mot de passe de la cible enregistrée sans bascule, ou ``""``."""
    try:
        return _password_path(True).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


_CONN_KEYS = ("host", "port", "name", "user", "tls")


def write_database_config(target: Dict[str, Any], *, switch: bool) -> int:
    """Section ``database`` de config.json ; rend la génération publiée.

    ``switch=False`` (« Enregistrer » de la page Base) : la cible est rangée
    À PART — ``database.pending`` et ``.db_password.pending`` —, la base active
    n'est pas touchée. Avant (2026-09-27), ses réglages et son mot de passe
    étaient écrasés : sur un serveur, le pool perdait son authentification.
    ``switch=True`` : la cible devient la base active, une nouvelle génération
    est publiée et la cible en attente, consommée, est effacée."""
    from shared_infra.config import read_config_json, write_config_json
    cfg = read_config_json()
    db = cfg.setdefault("database", {})
    if not switch:
        db["pending"] = {"backend": target["backend"],
                         **{k: target[k] for k in _CONN_KEYS if target.get(k) not in (None, "")}}
        if target.get("password"):
            save_password(target["password"], pending=True)
        write_config_json(cfg)
        return int(db.get("generation") or 0)
    if target["backend"] != "sqlite":
        for k in _CONN_KEYS:
            if target.get(k) not in (None, ""):
                db[k] = target[k]
        password = target.get("password") or pending_password()
        if password:
            save_password(password)
        db.pop("pending", None)
        try:
            _password_path(True).unlink()
        except OSError:
            pass
    db["backend"] = target["backend"]
    gen = int(db.get("generation") or 0) + 1
    db["generation"] = gen
    write_config_json(cfg)
    return gen


def start_job(kind: str, target: Dict[str, Any], reload: Callable[[], None]) -> Dict[str, Any]:
    """Lance ``migrate`` (vers ``target``) ou ``sqlite`` (retour à un fichier
    SQLite neuf) en tâche de fond. Refuse si une tâche tourne déjà."""
    with _JOB_LOCK:
        if _running():
            return {"ok": False, "error": "une bascule est déjà en cours"}
        _write_job(state="running", kind=kind, step="préparation", progress=None,
                   report=None, error=None, started_at=time.time(), pid=os.getpid())
    th = threading.Thread(target=_run, args=(kind, target, reload), daemon=True,
                          name="db-switch")
    th.start()
    return {"ok": True}


def _wait_generations() -> None:
    from shared_infra.routes.admin.lifecycle import active_generations
    deadline = time.monotonic() + _WAIT_GENERATIONS_S
    while True:
        n = active_generations()
        if not n:
            return
        if time.monotonic() > deadline:
            raise RuntimeError(f"{n} génération(s) toujours en cours après "
                               f"{int(_WAIT_GENERATIONS_S)} s — réessayer plus tard")
        _write_job(step=f"attente de {n} génération(s)")
        time.sleep(2)


def _run(kind: str, target: Dict[str, Any], reload: Callable[[], None]) -> None:
    from shared_infra import config as cfg
    from shared_infra.config import write_text_atomic
    from shared_infra.db import transfer as T
    new_gen = current_generation() + 1
    swap: Optional[Dict[str, Path]] = None
    try:
        write_text_atomic(_flag_path(), json.dumps({"generation": new_gen, "since": time.time()}))
        _wait_generations()
        source = T.active_target()
        if kind == "sqlite":
            live = Path(cfg.DB_PATH)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            fresh = live.with_name(f"{live.name}.new-{stamp}")
            swap = {"live": live, "fresh": fresh, "bak": live.with_name(f"{live.name}.bak-{stamp}")}
            target = {"backend": "sqlite", "path": str(fresh)}

        def progress(table, done, total):
            _write_job(step=f"copie {table}", progress=[done, total])

        _write_job(step="transfert")
        report = T.transfer(source, target, freeze=True, progress=progress)
        _write_job(report=report)
        if not report["ok"]:
            raise RuntimeError("vérification en échec : " + "; ".join(report.get("mismatches") or []))
        if swap:                                     # fichier neuf à la place de l'ancien
            for suffix in ("", "-wal", "-shm"):
                old = Path(str(swap["live"]) + suffix)
                if old.exists():
                    os.replace(old, Path(str(swap["bak"]) + suffix))
            os.replace(swap["fresh"], swap["live"])
            target = {"backend": "sqlite"}
        write_database_config(target, switch=True)
        write_text_atomic(_flag_path(), json.dumps({"generation": new_gen, "since": time.time(),
                                                    "published": True}))
        _write_job(state="done", step="rechargement", finished_at=time.time())
        log.warning("[db-switch] base basculée vers %s (génération %d)",
                    T.describe(target) if target.get("path") or target.get("host") else "sqlite",
                    new_gen)
        reload()
    except Exception as exc:
        log.error("[db-switch] bascule abandonnée : %s", exc)
        try:
            _flag_path().unlink()
        except OSError:
            pass
        if swap and swap["fresh"].exists():
            try:
                swap["fresh"].unlink()
            except OSError:
                pass
        _write_job(state="error", error=str(exc), finished_at=time.time())


__all__ = ["MaintenanceASGI", "current_generation", "job_status", "maintenance_active",
           "pending_password", "process_generation", "published_generation", "save_password",
           "start_job", "write_database_config"]
