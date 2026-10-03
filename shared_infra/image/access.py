# SPDX-License-Identifier: MIT
"""Qui peut générer des images, et avec quelles préférences par défaut.

Trois niveaux, tous revérifiés côté serveur (tour « Images », outil du modèle,
fichiers) — l'interface ne fait que refléter :

  1. l'instance : moteur activé et adressé (``config.image_ready``) ;
  2. les groupes : ``image.groups`` vide = tout le monde ; sinon le compte doit
     appartenir à l'un d'eux. L'administrateur passe toujours. Un groupe
     supprimé depuis ne donne accès à personne : la restriction reste ;
  3. le compte : cases « Images » (``image_enabled``) et « Par le modèle »
     (``image_tool_enabled``) de Paramètres, cochées par défaut.

Lecture impossible des groupes ou des réglages : REFUS journalisé. Une image
coûte une machine GPU, et un défaut d'infrastructure ne doit pas ouvrir à un
compte ce que l'administrateur lui a fermé.

Préférences (``image_prefs``) : format, taille, nombre, enrichir — gardées
côté serveur pour suivre le compte d'un poste à l'autre, et toujours ramenées
aux limites courantes du moteur.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from shared_infra.image.config import (
    RATIOS,
    effective_max_n,
    get_image_config,
    image_ready,
    sides_for,
)

logger = logging.getLogger("uvicorn.error")

PREFS_DEFAULTS: Dict[str, Any] = {"ratio": "1:1", "side": 1024, "n": 1, "enhance": False}


def user_allowed(user_id: int, cfg: Optional[Dict[str, Any]] = None) -> bool:
    """Le compte est-il dans un groupe autorisé (ou l'accès est-il ouvert) ?"""
    cfg = cfg or get_image_config()
    groups = set(cfg.get("groups") or ())
    if not groups:
        return True
    try:
        from shared_infra.accounts.groups import get_user_groups
        from shared_infra.accounts.users import get_user_by_id
        row = get_user_by_id(int(user_id))
        if row is not None and row["is_admin"] == 1:
            return True
        mine = {int(g["id"]) for g in get_user_groups(int(user_id))}
    except Exception:                                           # noqa: BLE001
        logger.warning("[image] groupes du compte %s illisibles : accès refusé",
                       user_id, exc_info=True)
        return False
    return bool(mine & groups)


def ready_for(user_id: int, cfg: Optional[Dict[str, Any]] = None) -> bool:
    """Moteur prêt ET compte autorisé : ce que le compte peut se voir proposer."""
    cfg = cfg or get_image_config()
    return image_ready(cfg) and user_allowed(user_id, cfg)


def read_settings(user_id: int) -> Optional[Dict[str, Any]]:
    """Réglages du compte, ou ``None`` s'ils sont illisibles."""
    try:
        from shared_infra.accounts.users import get_user_settings
        s = get_user_settings(int(user_id))
    except Exception:                                           # noqa: BLE001
        logger.warning("[image] réglages du compte %s illisibles", user_id, exc_info=True)
        return None
    return s if isinstance(s, dict) else {}


def enabled_in(settings: Optional[Dict[str, Any]]) -> bool:
    """Case « Images » du compte (cochée par défaut) ; réglages illisibles :
    non."""
    return settings is not None and settings.get("image_enabled") is not False


def tool_enabled_in(settings: Optional[Dict[str, Any]]) -> bool:
    """Case « Par le modèle », sous la case « Images »."""
    return settings is not None and enabled_in(settings) \
        and settings.get("image_tool_enabled") is not False


def clean_prefs(raw: Any, cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Préférences du compte ramenées aux limites du moteur : format connu,
    taille proposée la plus proche, nombre borné."""
    cfg = cfg or get_image_config()
    raw = raw if isinstance(raw, dict) else {}
    ratio = str(raw.get("ratio") or "").strip()
    if ratio not in RATIOS:
        ratio = PREFS_DEFAULTS["ratio"]
    sides = sides_for(cfg)
    try:
        side = int(raw.get("side"))
    except (TypeError, ValueError, OverflowError):
        side = cfg.get("default_side") or PREFS_DEFAULTS["side"]
    side = min(sides, key=lambda s: (abs(s - side), s))
    try:
        n = int(raw.get("n"))
    except (TypeError, ValueError, OverflowError):
        n = 1
    n = max(1, min(n, effective_max_n(cfg)))
    return {"ratio": ratio, "side": side, "n": n, "enhance": raw.get("enhance") is True}
