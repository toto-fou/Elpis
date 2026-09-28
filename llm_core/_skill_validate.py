# SPDX-License-Identifier: MIT
"""
llm_core/_skill_validate.py — validation du frontmatter d'un skill selon le
standard Agent Skills (Anthropic / agentskills.io).

Source unique de vérité pour les contraintes du spec, utilisée par :
  - la découverte (mode permissif : log + on garde, pour ne pas faire
    disparaître un skill legacy non strictement conforme) ;
  - les écritures (skill_save, route HTTP, upload .zip) en mode STRICT
    (rejet avec message actionnable).

Contraintes (cf. https://agentskills.io/specification) :
  name         : 1..64, ^[a-z0-9]+(-[a-z0-9]+)*$ (pas de '-' tête/fin ni '--'),
                 == nom du dossier, pas de tags XML, pas de mot réservé.
  description  : 1..1024, non vide, pas de tags XML.
  compatibility: <= 500.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

NAME_MAX = 64
DESC_MAX = 1024
COMPAT_MAX = 500

_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_RESERVED = ("anthropic", "claude")


def validate_name(name: str, *, dir_name: Optional[str] = None) -> List[str]:
    errs: List[str] = []
    n = (name or "").strip()
    if not n:
        errs.append("name : requis")
        return errs
    if len(n) > NAME_MAX:
        errs.append(f"name : {len(n)} > {NAME_MAX} caractères")
    if "<" in n or ">" in n:
        errs.append("name : pas de chevrons/tags XML")
    if not _NAME_RE.match(n):
        errs.append("name : minuscules a-z, chiffres et '-' uniquement, "
                    "sans '-' en tête/fin ni '--' consécutifs")
    low = n.lower()
    if any(r in low for r in _RESERVED):
        errs.append("name : mot réservé interdit (anthropic / claude)")
    if dir_name is not None and n != dir_name:
        errs.append(f"name doit être identique au nom du dossier (« {dir_name} »)")
    return errs


def validate_description(description: str) -> List[str]:
    errs: List[str] = []
    d = (description or "").strip()
    if not d:
        errs.append("description : requise (non vide)")
    elif len(d) > DESC_MAX:
        errs.append(f"description : {len(d)} > {DESC_MAX} caractères")
    if "<" in (description or "") or ">" in (description or ""):
        errs.append("description : pas de chevrons/tags XML")
    return errs


def validate_frontmatter(fm: Dict[str, Any], *, dir_name: Optional[str] = None) -> List[str]:
    """Retourne la liste des erreurs (vide = conforme)."""
    name = str(fm.get("name") or (dir_name or "")).strip()
    errs = validate_name(name, dir_name=dir_name)
    errs += validate_description(str(fm.get("description") or ""))
    compat = fm.get("compatibility")
    if compat is not None and len(str(compat)) > COMPAT_MAX:
        errs.append(f"compatibility : > {COMPAT_MAX} caractères")
    return errs


