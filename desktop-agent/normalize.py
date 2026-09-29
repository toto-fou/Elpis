# SPDX-License-Identifier: MIT
"""Cross-platform element normalization helpers (UIA ↔ AT-SPI → common)."""
from __future__ import annotations

from typing import Any, Dict, List

# Map verbose platform role names onto a short shared vocabulary. Unknown roles
# pass through lowercased — the model reads roles as hints, not a closed set.
_ROLE_MAP = {
    # AT-SPI
    "push button": "button", "toggle button": "button", "radio button": "radio",
    "check box": "checkbox", "page tab": "tab", "menu item": "menuitem",
    # « text » : champ de saisie en AT-SPI, texte statique en UIA ; c'est le
    # sens UIA (plus bas) qui s'applique.
    "entry": "textbox", "password text": "textbox",
    "combo box": "combobox", "list item": "listitem", "label": "text",
    "link": "link", "icon": "icon", "frame": "window", "dialog": "dialog",
    # UIA control types (friendly)
    "edit": "textbox", "button": "button", "hyperlink": "link",
    "checkbox": "checkbox", "radiobutton": "radio", "tabitem": "tab",
    "menuitem": "menuitem", "combobox": "combobox", "listitem": "listitem",
    "text": "text", "document": "document", "pane": "pane", "window": "window",
}


def norm_role(role: str) -> str:
    if not role:
        return ""
    r = str(role).strip().lower()
    return _ROLE_MAP.get(r, r)


# Rôles intrinsèquement actionnables (déclenchables par un « invoke »).
_ACTIONABLE_ROLES = {"button", "menuitem", "link", "tab", "listitem", "checkbox", "radio"}


def derive_patterns(state_names, role: str):
    """E3 — déduit des control-patterns COARSE (vocabulaire UIA partagé :
    toggle/selectionitem/expandcollapse/value/invoke) à partir des états a11y
    AT-SPI + du rôle normalisé. AT-SPI n'expose pas les patterns comme UIA ; cette
    dérivation donne au modèle 30-129B le même signal « cet élément est
    cochable/sélectionnable/dépliable/éditable/cliquable » des deux côtés, pour
    qu'il choisisse une op sémantique plutôt qu'un clic aveugle. Pure & testable."""
    st = {str(s).strip().lower() for s in (state_names or [])}
    r = norm_role(role)
    pats = []
    if "checkable" in st or "checked" in st:
        pats.append("toggle")
    if "selectable" in st or "selected" in st:
        pats.append("selectionitem")
    if "expandable" in st:
        pats.append("expandcollapse")
    if "editable" in st:
        pats.append("value")
    if r in _ACTIONABLE_ROLES:
        pats.append("invoke")
    return pats


def make_node(role: str, name: str, x: int, y: int, w: int, h: int,
              value: Any = None, states: List[str] | None = None, depth: int = 0,
              auto_id: str = "", runtime_id: str = "", class_name: str = "",
              patterns: List[str] | None = None) -> Dict[str, Any]:
    # ``auto_id`` = identifiant STABLE posé par le développeur de l'app (UIA
    # AutomationId / AT-SPI accessible-id). Bien plus robuste qu'un label OCR
    # pour ré-ancrer une action entre deux exécutions (titres/positions varient).
    #
    # ``runtime_id`` = identité UIA *intra-session* (RuntimeId, ou accessible-id
    # AT-SPI à défaut) : stable tant que l'élément vit, même si label/position
    # bougent. Sert de clé pour garder un id LLM (``el_N``) cohérent entre deux
    # observations → tue l'« index drift ». N'est PAS stable entre sessions.
    #
    # ``patterns`` = control patterns UIA disponibles (toggle/value/selectionitem/
    # expandcollapse/range/invoke/scrollitem) → guide l'action sémantique (cocher
    # via Toggle plutôt qu'un clic aveugle) et la lecture d'état (``value``/states
    # déterministes au lieu de l'OCR). ``class_name`` aide à désambiguïser les
    # collisions de libellés (deux « OK » de WindowClass différentes).
    return {
        "role": norm_role(role),
        "name": (str(name).strip() if name else ""),
        "auto_id": (str(auto_id).strip() if auto_id else ""),
        "runtime_id": (str(runtime_id).strip() if runtime_id else ""),
        "class_name": (str(class_name).strip() if class_name else ""),
        "rect": [int(x), int(y), int(w), int(h)],
        "value": value,
        "states": states or [],
        "patterns": patterns or [],
        "depth": int(depth),
    }


def center_in_region(rect, region) -> bool:
    """True si le CENTRE de ``rect`` (x,y,w,h) tombe dans ``region`` capturée
    ({left,top,width,height}). ``region`` faux/None → True (fail-open : scope
    desktop = tous écrans, ou dimensions inconnues). Robuste aux fenêtres à cheval
    (on garde celles majoritairement dans le cadre). Partagé Windows/Linux."""
    if not region:
        return True
    try:
        x, y, w, h = rect
        cx, cy = x + w // 2, y + h // 2
        l, t = int(region["left"]), int(region["top"])
        return l <= cx < l + int(region["width"]) and t <= cy < t + int(region["height"])
    except Exception:
        return True


def keep_node(node: Dict[str, Any]) -> bool:
    """Drop zero-size / offscreen nodes and the ones with neither name nor role."""
    r = node.get("rect") or [0, 0, 0, 0]
    if len(r) < 4 or r[2] < 3 or r[3] < 3:
        return False
    if r[0] < -10000 or r[1] < -10000:
        return False
    # Hors-écran (scrollé hors vue / onglet inactif / replié) : UIA le signale via
    # IsOffscreen → state "offscreen". On ne le renvoie PAS au modèle : un contrôle
    # invisible n'est pas actionnable et ne fait que gonfler les tokens. (C'est ce
    # que la docstring promettait sans le faire — corrigé.)
    if "offscreen" in (node.get("states") or ()):
        return False
    return bool(node.get("name") or node.get("role"))
