# SPDX-License-Identifier: MIT
"""
llm_core/_frontmatter.py — mini-parser frontmatter YAML-light, sans dépendance.

Partagé entre les loaders fichier-based du projet (skills, …). Le format suit la
convention Claude Code : un bloc ``---`` en tête de fichier markdown, suivi du corps.

Capacités volontairement limitées (pas de dépendance PyYAML, pas de nested) :

  - ``key: value`` (string)
  - ``key: [a, b, c]`` (liste de strings)
  - ``key: 0.5`` (float si parseable) / ``key: 42`` (int)
  - ``key: true|false`` (bool)
  - ``key: {a: b, c: d}`` (dict simple, inline uniquement)

Si on a besoin de plus, on garde tout dans le corps markdown.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Tuple

_FM_DELIMITER = re.compile(r"^---\s*$", re.MULTILINE)


def parse_value(raw: str) -> Any:
    """Parse une valeur simple : string, int, float, bool, list, dict inline."""
    raw = raw.strip()
    if not raw:
        return ""
    # Booléens
    low = raw.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "none", "~"):
        return None
    # Liste inline [a, b, c]
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        # Split sur les virgules (simple — pas de support pour chaînes contenant des virgules)
        items = [s.strip().strip("'\"") for s in inner.split(",")]
        return [it for it in items if it]
    # Dict inline {a: b, c: d}
    if raw.startswith("{") and raw.endswith("}"):
        inner = raw[1:-1].strip()
        out: Dict[str, Any] = {}
        if not inner:
            return out
        for part in inner.split(","):
            if ":" not in part:
                continue
            k, _, v = part.partition(":")
            out[k.strip().strip("'\"")] = parse_value(v)
        return out
    # Nombres
    try:
        if "." in raw or "e" in low:
            return float(raw)
        return int(raw)
    except ValueError:
        pass
    # String (avec quotes optionnelles)
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        return raw[1:-1]
    return raw


def parse_frontmatter_block(block: str) -> Dict[str, Any]:
    """Parse le contenu entre les deux ``---`` en dict.

    Supporte UN niveau d'imbrication pour les blocs type ``metadata:`` (spec
    Agent Skills) : une clé top-level à valeur vide suivie de lignes indentées
    ``  k: v`` agrège ces paires dans un sous-dict. Au-delà d'un niveau, on
    garde le contenu dans le corps markdown.
    """
    out: Dict[str, Any] = {}
    last_key: Any = None  # dernière clé top-level à valeur vide → parent potentiel d'un bloc imbriqué
    for raw_line in block.splitlines():
        line = raw_line.rstrip()
        # Skip commentaires et lignes vides
        if not line or line.lstrip().startswith("#"):
            continue
        if line[:1] in (" ", "\t"):
            # Ligne indentée : paire ``k: v`` rattachée au dernier parent à valeur vide.
            if last_key is not None and ":" in line:
                k, _, v = line.strip().partition(":")
                k = k.strip()
                if k:
                    parent = out.get(last_key)
                    if not isinstance(parent, dict):
                        parent = {}
                        out[last_key] = parent
                    parent[k] = parse_value(v)
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        if not key:
            continue
        val = parse_value(value)
        out[key] = val
        # Une valeur vide ⇒ candidate parent d'un bloc imbriqué sur les lignes suivantes.
        last_key = key if val == "" else None
    return out


def split_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    """Sépare frontmatter + corps markdown.

    Retourne ``({}, content)`` si pas de frontmatter détecté (fichier
    purement markdown sans bloc ``---``).
    """
    stripped = content.lstrip()
    if not stripped.startswith("---"):
        return {}, content

    # Cherche le DEUXIÈME délimiteur ---
    parts = _FM_DELIMITER.split(content, maxsplit=2)
    # Après split: ["", frontmatter_body, rest_of_file]
    if len(parts) < 3:
        # Pas de fermeture du frontmatter → fichier malformé, on traite tout
        # comme markdown.
        return {}, content
    fm_body = parts[1]
    body    = parts[2].lstrip("\n")
    fm      = parse_frontmatter_block(fm_body)
    return fm, body
