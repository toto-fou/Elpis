# SPDX-License-Identifier: MIT
"""
shared_infra/ops/restart_pending.py — « Redémarrage nécessaire » (console admin, lot 6)
======================================================================================

La plupart des réglages de ``config.json`` sont lus UNE fois, à l'import de
``shared_infra.config`` (constantes dérivées de ``_RAW``). Les écrire depuis la
console ne change donc rien avant un redémarrage — et rien ne le disait, sauf
une aide en texte sur une poignée de champs.

Principe :

* **Inventaire automatique** — ``config.BOOT_READ_PATHS`` : chaque chemin lu
  dans ``_RAW`` pendant l'import (instrumentation de ``_deep_get``), moins les
  sous-arbres rechargés à chaud (``config.HOT_RELOAD_PREFIXES``), plus quelques
  lectures de démarrage faites ailleurs (cookie de session). Pas de liste
  tenue à la main qui dériverait du code.
* **Empreinte au démarrage du process PRINCIPAL** — c'est lui que le bouton
  « Redémarrer » relance (en mode séparé, la console garde son process). Chaque
  worker principal écrit, à son démarrage, l'empreinte (SHA-256 tronqué, jamais
  la valeur : ``config.json`` porte des secrets) des chemins de l'inventaire.
  Un worker recyclé (``max_requests``) ne la réécrit pas : il partage la
  génération de ses frères. ``invalidate()`` l'efface juste avant un
  redémarrage demandé : le premier worker neuf la réécrit.
* **Comparaison** — ``pending()`` compare l'empreinte au fichier actuel : un
  chemin qui diffère attend un redémarrage.

L'instantané vit à côté de la base (``dirname(DB_PATH)``) : les tests, qui
isolent la base, l'isolent du même coup.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import time
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

_FILENAME = ".config_boot.json"
_MISSING = "\x00absent"

# Lus au démarrage HORS de ``shared_infra.config`` : le middleware de session
# (server/app.py) fige son cookie à la construction de l'application.
EXTRA_BOOT_PATHS = frozenset({
    "security.session.same_site",
    "security.session.cookie_name",
})


def _snapshot_path() -> str:
    from shared_infra.db import _connection
    base = os.path.dirname(os.path.abspath(str(_connection.DB_PATH))) or "."
    return os.path.join(base, _FILENAME)


def restart_paths() -> List[str]:
    """Chemins dont une modification n'agit qu'au redémarrage."""
    from shared_infra import config as _cfg
    hot = tuple(_cfg.HOT_RELOAD_PREFIXES)
    live = set(_cfg.HOT_RELOAD_PATHS)
    paths = {p for p in _cfg.BOOT_READ_PATHS
             if p not in live and not p.startswith(hot)}
    return sorted(paths | EXTRA_BOOT_PATHS)


def _get(d: Any, path: str) -> Any:
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return _MISSING
        cur = cur[part]
    return cur


def _digest(value: Any) -> str:
    blob = json.dumps(value, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _digests(cfg: Dict[str, Any], paths: Iterable[str]) -> Dict[str, str]:
    return {p: _digest(_get(cfg, p)) for p in paths}


def _generation() -> str:
    """Identité de la génération de workers : le maître gunicorn s'il existe
    (ses workers recyclés en font partie), sinon le process lui-même."""
    ppid = os.getppid()
    try:
        with open(f"/proc/{ppid}/cmdline", "rb") as fh:
            if b"gunicorn" in fh.read():
                return f"g{ppid}"
    except OSError:
        pass
    return f"p{os.getpid()}"


def _load() -> Optional[Dict[str, Any]]:
    try:
        with open(_snapshot_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def record(mode: str) -> None:
    """Au démarrage d'un worker PRINCIPAL (``main`` ou ``full``). Sans effet
    si la génération courante a déjà écrit son empreinte."""
    try:
        from shared_infra import config as _cfg
        gen = _generation()
        cur = _load()
        if cur and cur.get("generation") == gen:
            return
        data = {"ts": time.time(), "generation": gen, "mode": mode,
                "digests": _digests(_cfg._RAW, restart_paths())}
        path = _snapshot_path()
        fd, tmp = tempfile.mkstemp(prefix=".config_boot.", dir=os.path.dirname(path))
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, path)
    except Exception:                                        # noqa: BLE001
        # Informatif : ne JAMAIS empêcher un démarrage.
        logger.warning("[restart-pending] empreinte de démarrage non écrite", exc_info=True)


def invalidate() -> None:
    """Juste avant un redémarrage du process principal : la génération suivante
    réécrira l'empreinte."""
    try:
        os.unlink(_snapshot_path())
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("[restart-pending] empreinte non effacée", exc_info=True)


def pending(current: Optional[Dict[str, Any]] = None) -> List[str]:
    """Chemins modifiés depuis le démarrage du process principal.

    Sans empreinte (process principal d'avant cette fonction, ou jamais
    démarré), la référence est la lecture de démarrage de CE process."""
    from shared_infra import config as _cfg
    if current is None:
        current = _cfg.config_view() or {}
    paths = restart_paths()
    snap = _load()
    ref = snap.get("digests") if snap and isinstance(snap.get("digests"), dict) else None
    out = []
    for p in paths:
        then = ref.get(p) if ref is not None else _digest(_get(_cfg._RAW, p))
        if then is None:          # chemin inconnu de l'empreinte (code plus récent)
            continue
        if _digest(_get(current, p)) != then:
            out.append(p)
    return out
