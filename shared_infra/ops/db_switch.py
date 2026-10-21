# SPDX-License-Identifier: MIT
"""shared_infra/ops/db_switch.py — génération de base publiée par le drapeau de bascule (``.db_maintenance``, écrit par le core TypeScript), seconde source de la garde de génération."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional


def _flag_path() -> Path:
    from shared_infra import config as cfg
    return Path(cfg.DB_PATH).parent / ".db_maintenance"


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
