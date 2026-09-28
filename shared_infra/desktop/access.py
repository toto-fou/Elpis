# SPDX-License-Identifier: MIT
"""
shared_infra/desktop/access.py — qui peut piloter quelle machine.

Audit 2026-09-22 (M2) : tout compte connecté pilotait toutes les cibles
desktop et pouvait y pousser du code. Chaque cible porte désormais
``access`` : ``all`` (tout compte, défaut historique) ou ``list``
(administrateurs + ``allowed_users``). Réglage par compte dans
Admin → Utilisateurs ; bascule par machine dans Admin → Connexions.

Point d'application unique : ``llm_core.tools.desktop_tools._resolve_target``
(toutes les routes et tous les outils y passent), plus le listing et le
choix de la cible active côté routes.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def _is_admin(username: str) -> bool:
    try:
        from shared_infra.accounts.users import get_user
        row = get_user(username)
        return bool(row and row["is_admin"] == 1)
    except Exception:
        return False


def target_allowed(target: Optional[Dict[str, Any]], username: str,
                   *, is_admin: Optional[bool] = None) -> bool:
    if not target:
        return False
    if (target.get("access") or "all") != "list":
        return True
    name = str(username or "").strip()
    if not name:
        return False                                    # identité inconnue : refus
    if name in (target.get("allowed_users") or []):
        return True
    return _is_admin(name) if is_admin is None else bool(is_admin)


def allowed_targets(targets: List[Dict[str, Any]], username: str) -> List[Dict[str, Any]]:
    admin = _is_admin(str(username or "").strip()) if username else False
    return [t for t in targets if target_allowed(t, username, is_admin=admin)]


__all__ = ["target_allowed", "allowed_targets"]
