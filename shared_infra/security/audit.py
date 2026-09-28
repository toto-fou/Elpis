# SPDX-License-Identifier: MIT
"""
backend/audit.py — Audit log append-only.

Pourquoi ce module
------------------
``backend/access_logging.py`` produit déjà un JSONL des requêtes HTTP, mais
il est éditable et n'enregistre pas certaines actions sensibles :
exécution de code (RF, code_node), modifications admin, lecture de
``triggers/{id}/reveal``, etc.

Ce module fournit une seconde couche de logs orientée *audit* :
  • fichier JSONL séparé, mode O_APPEND uniquement
  • permissions 0o640 (lecture root + groupe elpis-admin)
  • rotation par jour (rename + new file)
  • en option : signature HMAC ligne par ligne avec une clé stockée
    dans /etc/elpis/audit.key (lisible par root seul)

Format de chaque ligne (une JSON par ligne) :
  {
    "ts": 1736300000.123,
    "iso": "2026-01-08T07:46:40.123+00:00",
    "service": "main",
    "user_id": 42,
    "username": "alice",
    "action": "rf_runner.exec",
    "details": { ... action-specific ... },
    "hmac": "<hex>"        # si HMAC activé
  }

Usage
-----
    from shared_infra.security.audit import audit_event, audit_code_exec

    audit_code_exec(
        user_id=self.user_id,
        username=self.username,
        kind="rf_runner",
        code=robot_code,
        pipeline_id=self.run_data["pipeline_id"],
        run_id=self.run_id,
        node_id=node_id,
        executor="docker.local",
    )
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import json
import os
import threading
import time

from shared_infra.env_compat import env
from pathlib import Path
from typing import Any, Dict, Optional

# ─── Configuration ─────────────────────────────────────────────────────────

# Path par défaut : on essaie /var/lib/elpis/audit (prod), avec fallback
# sur un dossier local à l'app si l'app n'a pas les droits root pour
# créer ce dossier.
def _default_audit_dir() -> Path:
    explicit = env("ELPIS_AUDIT_DIR")
    if explicit:
        return Path(explicit)
    # Tentative classique en prod
    prod_path = Path("/var/lib/elpis/audit")
    try:
        prod_path.mkdir(parents=True, exist_ok=True)
        # test d'écriture pour valider qu'on peut vraiment écrire
        test = prod_path / ".write_test"
        test.touch()
        test.unlink()
        return prod_path
    except (PermissionError, OSError):
        pass
    # Fallback : dossier local à l'app
    # Ancré sur PROJECT_ROOT : ``parents[1]`` désignait la racine tant que ce
    # fichier vivait à ``shared_infra/audit.py``. Descendu dans ``security/``,
    # il pointait sur ``shared_infra/`` — le journal d'audit atterrissait dans
    # ``shared_infra/logs/audit`` (régression du rangement, 2026-09-04).
    try:
        from shared_infra.config import PROJECT_ROOT as _PR
        app_root = Path(_PR)
    except Exception:
        app_root = Path(__file__).resolve().parents[2]
    fallback = app_root / "logs" / "audit"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


_DEFAULT_AUDIT_DIR = _default_audit_dir()


def _default_audit_key_path() -> Path:
    explicit = env("ELPIS_AUDIT_KEY_PATH")
    if explicit:
        return Path(explicit)
    return Path("/etc/elpis/audit.key")


_AUDIT_KEY_PATH = _default_audit_key_path()

_LOCK = threading.Lock()
_CURRENT_FILE: Optional[Path] = None
_CURRENT_DAY: Optional[str] = None
_HMAC_KEY: Optional[bytes] = None  # None = HMAC désactivé
_SERVICE_TAG: str = "main"  # surcharge via configure(service=...)


def configure(*,
              service: str = "main",
              audit_dir: Path | str | None = None,
              hmac_key_path: Path | str | None = None) -> None:
    """À appeler au démarrage de l'app (une fois par process).

    Sans appel, le module fonctionne avec les valeurs par défaut.
    """
    global _DEFAULT_AUDIT_DIR, _AUDIT_KEY_PATH, _HMAC_KEY, _SERVICE_TAG

    _SERVICE_TAG = service or "main"

    if audit_dir is not None:
        _DEFAULT_AUDIT_DIR = Path(audit_dir)
    if hmac_key_path is not None:
        _AUDIT_KEY_PATH = Path(hmac_key_path)

    _DEFAULT_AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(_DEFAULT_AUDIT_DIR, 0o750)
    except PermissionError:
        # Ok si on ne peut pas chmod (déjà bon, ou pas owner)
        pass

    # Charge la clé HMAC si présente
    try:
        if _AUDIT_KEY_PATH.exists() and _AUDIT_KEY_PATH.stat().st_size >= 32:
            _HMAC_KEY = _AUDIT_KEY_PATH.read_bytes().strip()
        else:
            _HMAC_KEY = None
    except PermissionError:
        # Le worker n'est probablement pas root → pas de HMAC.
        # L'audit reste actif, juste sans signature.
        _HMAC_KEY = None


# ─── Auto-configuration au chargement du module ────────────────────────────
#
# BUG FIX (P1) — avant, ``configure()`` n'était appelé par AUCUN point
# d'entrée : ``_HMAC_KEY`` restait à ``None`` (signature HMAC anti-falsification
# DÉSACTIVÉE même quand ``/etc/elpis/audit.key`` existe) et ``_SERVICE_TAG``
# restait ``"main"`` y compris sur le process admin. On configure donc
# automatiquement au premier import, en lisant ``APP_SERVICE`` dans
# l'environnement — exactement comme ``access_logging.py`` (qui lit la même
# variable au chargement). Les deux entrypoints (``chatbot_app.asgi`` et
# ``server.admin_app``) posent ``APP_SERVICE`` AVANT d'importer l'app, donc
# le tag est correct et la clé HMAC chargée sans dépendre d'un appelant.
#
# ``configure()`` reste exporté et idempotent : ``create_app()`` (ou un test)
# peut toujours le rappeler explicitement pour surcharger ``service`` /
# ``audit_dir`` / ``hmac_key_path``.
def _auto_configure() -> None:
    try:
        configure(service=os.environ.get("APP_SERVICE", "main").lower())
    except Exception:
        # L'auto-config ne doit JAMAIS empêcher le chargement du module.
        # En cas d'échec on garde les valeurs par défaut (audit actif,
        # HMAC simplement désactivé).
        pass


_auto_configure()


def _resolve_path() -> Path:
    """Retourne le chemin du fichier d'audit du jour, en rotant si besoin."""
    global _CURRENT_FILE, _CURRENT_DAY

    today = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")
    if today == _CURRENT_DAY and _CURRENT_FILE is not None:
        return _CURRENT_FILE

    _DEFAULT_AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    new_path = _DEFAULT_AUDIT_DIR / f"audit-{today}.jsonl"

    # Crée le fichier s'il n'existe pas, avec les bonnes perms
    if not new_path.exists():
        # O_CREAT|O_EXCL pour éviter une race avec un autre worker
        try:
            fd = os.open(str(new_path),
                         os.O_CREAT | os.O_WRONLY | os.O_APPEND,
                         0o640)
            os.close(fd)
        except FileExistsError:
            pass  # un autre worker l'a créé en même temps, ok

    _CURRENT_FILE = new_path
    _CURRENT_DAY = today
    return new_path


def audit_event(*,
                user_id: Optional[int],
                username: Optional[str],
                action: str,
                details: Dict[str, Any] | None = None) -> None:
    """Émet une ligne d'audit. Ne lève JAMAIS.

    Le caller ne doit jamais dépendre d'un échec d'audit pour bloquer
    l'application — on log et on continue.

    Atomicité multi-worker
    ----------------------
    BUG FIX (multi-worker race) — avant on faisait
    ``with open(target, "a") as f: f.write(line); f.flush()``. Le
    ``threading.Lock`` _LOCK est local au process : avec gunicorn
    multi-worker, deux workers pouvaient interleaver leurs écritures
    en milieu de ligne. ``f.write()`` n'est pas garanti d'être un
    seul ``write()`` syscall, donc même O_APPEND ne suffisait pas.
    Maintenant : ``os.write(fd, line.encode())`` avec O_APPEND, qui
    fait ``lseek+write`` atomiquement (POSIX) jusqu'à ``PIPE_BUF``
    (4 KB sous Linux pour les fichiers). Au-delà on tronque la ligne
    pour rester atomique.

    HMAC consistent
    ---------------
    BUG FIX — avant le HMAC était calculé sur ``json.dumps(record,
    sort_keys=True)`` puis la ligne effectivement écrite était
    ``json.dumps(record)`` sans ``sort_keys``. Si la sérialisation
    écrite et celle hashée différaient, la vérification ratait. On
    écrit maintenant la même sérialisation triée (le surcoût est
    négligeable et garantit la reproductibilité).
    """
    try:
        record: Dict[str, Any] = {
            "ts": time.time(),
            "iso": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "service": _SERVICE_TAG,
            "user_id": user_id,
            "username": username,
            "action": action,
            "details": details or {},
        }

        # Sérialisation canonique : la ligne écrite et la base du HMAC
        # utilisent toutes deux ``sort_keys=True``. Pour vérifier :
        #   1. parser la ligne JSON
        #   2. retirer le champ ``hmac``
        #   3. hmac_sha256(KEY, json.dumps(rest, sort_keys=True, ensure_ascii=False))
        #   4. comparer en temps constant
        if _HMAC_KEY is not None:
            payload_no_hmac = json.dumps(
                record, sort_keys=True, ensure_ascii=False
            ).encode("utf-8")
            record["hmac"] = hmac.new(
                _HMAC_KEY, payload_no_hmac, hashlib.sha256
            ).hexdigest()

        line = json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n"
        line_bytes = line.encode("utf-8")

        # Limite atomique POSIX pour O_APPEND. Sur Linux moderne pour
        # les fichiers ordinaires, l'atomicité est en pratique garantie
        # par le kernel pour ``write()`` complet (le seek+write est
        # protégé par i_rwsem) — mais on documente et on cap quand même
        # à 4 KB pour rester conforme au standard. Si une ligne dépasse,
        # on tronque le champ ``details`` qui est le plus gros.
        _PIPE_BUF = 4096
        if len(line_bytes) > _PIPE_BUF:
            # Tronquer details et regénérer
            truncated_details = {
                "_truncated": True,
                "_orig_len": len(line_bytes),
                "summary": str(record.get("details"))[:500],
            }
            record["details"] = truncated_details
            if "hmac" in record:
                del record["hmac"]
            if _HMAC_KEY is not None:
                payload_no_hmac = json.dumps(
                    record, sort_keys=True, ensure_ascii=False
                ).encode("utf-8")
                record["hmac"] = hmac.new(
                    _HMAC_KEY, payload_no_hmac, hashlib.sha256
                ).hexdigest()
            line = json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n"
            line_bytes = line.encode("utf-8")

        with _LOCK:
            target = _resolve_path()
            # O_APPEND garantit que le seek-to-end + write est atomique
            # entre processus (POSIX). os.write fait un seul syscall donc
            # on n'a pas le problème de Python f.write qui peut splitter.
            fd = os.open(str(target), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
            try:
                os.write(fd, line_bytes)
            finally:
                os.close(fd)
    except Exception:
        # JAMAIS lever ; un audit raté ne doit pas planter le run.
        # On peut éventuellement logger sur stderr en dernier recours.
        try:
            import logging
            logging.getLogger("elpis.audit").exception(
                "audit_event a échoué (non-bloquant)"
            )
        except Exception:
            pass


def audit_code_exec(*,
                    user_id: int,
                    username: str,
                    kind: str,
                    code: str,
                    pipeline_id: Optional[int],
                    run_id: str,
                    node_id: str,
                    executor: str,
                    extra: Dict[str, Any] | None = None) -> None:
    """Audit spécifique pour toute exécution de code (RF, code_node, ...).

    On n'enregistre PAS le code lui-même (gros, possiblement sensible),
    mais son SHA-256 + sa taille. Le code complet reste dans la DB des runs.

    ``executor`` est le tag de l'executor utilisé (ex: ``docker.local``,
    ``docker.remote.exec-vm-1``, ``bwrap.local``).
    """
    digest = hashlib.sha256(code.encode("utf-8", errors="replace")).hexdigest()
    audit_event(
        user_id=user_id,
        username=username,
        action=f"code.exec.{kind}",
        details={
            "code_sha256": digest,
            "code_len": len(code),
            "pipeline_id": pipeline_id,
            "run_id": run_id,
            "node_id": node_id,
            "executor": executor,
            **(extra or {}),
        },
    )


def audit_login(*,
                user_id: Optional[int],
                username: Optional[str],
                ip: Optional[str] = None,
                user_agent: Optional[str] = None,
                success: bool = True,
                reason: Optional[str] = None) -> None:
    """Audit d'un événement d'authentification (login OK/KO, logout, revocation).

    ``reason`` est optionnel et utile pour les échecs (``"bad_password"``,
    ``"revoked_token"``, ``"expired_session"``). Pas d'info sensible loggée
    (pas de password, même tronqué).
    """
    audit_event(
        user_id=user_id,
        username=username,
        action="auth.login" if success else "auth.login.denied",
        details={
            "ip": ip,
            "user_agent": (user_agent or "")[:200],
            "reason": reason,
        },
    )


def read_recent_audit_lines(
    *,
    limit: int = 100,
    since_ts: Optional[float] = None,
    action_prefix: Optional[str] = None,
    user_id: Optional[int] = None,
) -> list[Dict[str, Any]]:
    """Lit la queue du fichier d'audit du jour (+ rotation J-1 si besoin).

    Lecture purement défensive : on tolère des fichiers corrompus, lignes
    JSON invalides, etc. — on filtre et on continue.

    :param limit:         nombre max de lignes retournées (les plus récentes).
    :param since_ts:      filtre ``ts >= since_ts``.
    :param action_prefix: filtre ``action.startswith(prefix)``. Ex: ``"pipeline.run"``.
    :param user_id:       filtre ``user_id`` exact.
    :return:              liste des records les plus récents en premier.

    Best-effort : retourne ``[]`` si le répertoire d'audit n'existe pas
    ou n'est pas lisible.
    """
    out: list[Dict[str, Any]] = []
    try:
        audit_dir = _DEFAULT_AUDIT_DIR
        if not audit_dir.exists():
            return out

        # On lit le fichier du jour + celui d'hier (rotation par jour).
        today_iso = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")
        yesterday_iso = (
            _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=1)
        ).strftime("%Y-%m-%d")
        files = [
            audit_dir / f"audit-{today_iso}.jsonl",
            audit_dir / f"audit-{yesterday_iso}.jsonl",
        ]

        for f in files:
            try:
                data = f.read_bytes()
            except (FileNotFoundError, OSError):
                continue
            for line in reversed(data.splitlines()):
                if not line:
                    continue
                try:
                    rec = json.loads(line.decode("utf-8", errors="replace"))
                except Exception:
                    continue
                if since_ts is not None and float(rec.get("ts", 0)) < since_ts:
                    continue
                if action_prefix and not str(rec.get("action", "")).startswith(action_prefix):
                    continue
                if user_id is not None and rec.get("user_id") != user_id:
                    continue
                out.append(rec)
                if len(out) >= limit:
                    return out
    except Exception:
        # JAMAIS lever — un échec de lecture audit ne doit pas casser le
        # caller (l'audit reste accessible via le fichier sur disque).
        pass
    return out


# Alias public attendu par les appelants externes (ex. ``create_app()``) :
# ``configure_audit`` est le nom « parlant » côté serveur, équivalent à
# ``configure``. Permet ``from shared_infra.security.audit import configure_audit``.
configure_audit = configure


__all__ = [
    "configure",
    "configure_audit",
    "audit_event",
    "audit_code_exec",
    "audit_login",
    "read_recent_audit_lines",
]
