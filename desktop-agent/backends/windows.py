# SPDX-License-Identifier: MIT
"""Windows control-agent backend.

  • element tree → pywinauto (UI Automation) over the FOREGROUND window
  • input       → pyautogui
  • screenshot  → mss or PIL ImageGrab

Run this in the logged-in INTERACTIVE session (a Session-0 service only sees a
black screen and cannot drive the desktop).
"""
from __future__ import annotations

import os
import re
import sys as _sys
import time
from typing import Any, Dict, List, Optional, Tuple

from .base import DesktopBackend, NotSupported, PartialInput, encode_screenshot, shell_disabled, tail_truncate

# Apartment COM DÉTERMINISTE = MTA, fixé AVANT tout import comtypes/pywinauto (faits
# paresseusement plus bas) : c'est le modèle RECOMMANDÉ par Microsoft pour un client
# UI Automation qui parcourt tout le bureau, ET le défaut de pywinauto 0.6.5+. Évite
# le conflit STA(comtypes par défaut) vs MTA(pywinauto) → RPC_E_CHANGED_MODE / objets
# d'apartments différents. (MTA n'a pas le piège de réentrance/hang des threads STA.)
if not hasattr(_sys, "coinit_flags"):
    _sys.coinit_flags = 0   # COINIT_MULTITHREADED


# Codes d'erreur ShellExecute (valeur de retour ≤ 32). Pur (sans ctypes) → testable
# sous Linux. Sert à transformer un échec numérique opaque en message actionnable.
_SHELLEXEC_ERRORS = {
    0:  "système à court de mémoire/ressources",
    2:  "fichier introuvable (SE_ERR_FNF) — vérifier le nom/chemin de l'application",
    3:  "chemin introuvable (SE_ERR_PNF)",
    5:  "accès refusé / non spécifié (SE_ERR_ACCESSDENIED)",
    8:  "mémoire insuffisante (SE_ERR_OOM)",
    11: "format de fichier exécutable invalide (ERROR_BAD_FORMAT)",
    26: "violation de partage (SE_ERR_SHARE)",
    27: "association de fichier incomplète (SE_ERR_ASSOCINCOMPLETE)",
    28: "délai DDE dépassé (SE_ERR_DDETIMEOUT)",
    29: "échec de la transaction DDE (SE_ERR_DDEFAIL)",
    30: "DDE occupé (SE_ERR_DDEBUSY)",
    31: "aucune application associée à ce type de fichier (SE_ERR_NOASSOC)",
    32: "DLL introuvable pour cette application (SE_ERR_DLLNOTFOUND)",
}


def _shellexecute_error(rc: int) -> str:
    """Message lisible pour un code de retour ShellExecute (≤ 32)."""
    try:
        rc = int(rc)
    except (TypeError, ValueError):
        return "code ShellExecute invalide"
    return _SHELLEXEC_ERRORS.get(rc, "erreur ShellExecute %d" % rc)

try:
    from normalize import keep_node, make_node
except ImportError:  # pragma: no cover
    from ..normalize import keep_node, make_node


def _ensure_dpi_aware() -> None:
    """Make the process DPI-aware so screenshots cover the FULL physical screen
    on scaled displays. Without this, a DPI-unaware process on a 150%/200%
    display captures only the TOP-LEFT region (GDI/mss BitBlt grabs physical
    pixels while the virtual screen metrics stay logical). Must run before any
    capture, so it's called first in the backend constructor."""
    try:
        import ctypes
        try:
            # PER_MONITOR_AWARE_V2 (-4) : meilleur rendu/coords en multi-écran à DPI
            # mixtes (Win10 1703+). Repli v1 puis system-DPI sur OS plus ancien.
            u = ctypes.windll.user32
            u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
            u.SetProcessDpiAwarenessContext.restype = ctypes.c_bool
            if not u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
                raise OSError("dpi awareness v2 refusé")
        except Exception:
            try:
                ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
            except Exception:
                ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# ── UI Automation BAS NIVEAU (comtypes IUIAutomation direct) ──────────────────
# Plus complet et rapide que pywinauto.children() (qui re-wrappe chaque nœud) ;
# chemin PRINCIPAL de ui_tree, scopé à l'ÉCRAN CAPTURÉ (pas au focus clavier →
# corrige le multi-écran). Tourne sur le thread de la boucle event (= thread main,
# où comtypes a déjà initialisé COM en STA). JAMAIS de pool de threads (COM = affinité).
_CLSID_CUIAutomation = "{ff48dba4-60ef-4201-aa87-54103eef594e}"
_UIA_CONTROLTYPE = {
    50000: "button", 50001: "calendar", 50002: "checkbox", 50003: "combobox",
    50004: "edit", 50005: "hyperlink", 50006: "image", 50007: "listitem",
    50008: "list", 50009: "menu", 50010: "menubar", 50011: "menuitem",
    50012: "progressbar", 50013: "radiobutton", 50014: "scrollbar", 50015: "slider",
    50016: "spinner", 50017: "statusbar", 50018: "tab", 50019: "tabitem",
    50020: "text", 50021: "toolbar", 50022: "tooltip", 50023: "tree",
    50024: "treeitem", 50025: "custom", 50026: "group", 50027: "thumb",
    50028: "datagrid", 50029: "dataitem", 50030: "document", 50031: "splitbutton",
    50032: "window", 50033: "pane", 50034: "header", 50035: "headeritem",
    50036: "table", 50037: "titlebar", 50038: "separator", 50039: "semanticzoom",
    50040: "appbar",
}
_UIA_SINGLETON = None       # IUIAutomation réutilisé (créé paresseusement)
_UIA_FAIL_COUNT = 0         # échecs consécutifs → backoff (PAS de latch permanent)
_UIA_NEXT_TRY = 0.0         # horodatage avant lequel on ne retente pas comtypes
_UIA_MOD = None             # module comtypes UIAutomationCore (constantes UIA_*)
_UIA_CACHE = None           # IUIAutomationCacheRequest pré-bâti (props + patterns)
_PID: Dict[str, int] = {}   # nom logique → UIA property-id résolu depuis le module

# Propriétés à mettre en cache en UN appel COM par sous-arbre (BuildUpdatedCache).
# Les *valeurs* de pattern sont exposées par UIA comme des propriétés (pas besoin
# d'instancier l'objet pattern pour LIRE) → on lit toggle/value/selection/expand
# en cache, sans round-trip live. Clé logique → nom de constante du module UIA.
_CACHE_PROPS = {
    "control_type": "UIA_ControlTypePropertyId",
    "name": "UIA_NamePropertyId",
    "automation_id": "UIA_AutomationIdPropertyId",
    "class_name": "UIA_ClassNamePropertyId",
    "rect": "UIA_BoundingRectanglePropertyId",
    "runtime_id": "UIA_RuntimeIdPropertyId",
    "enabled": "UIA_IsEnabledPropertyId",
    "offscreen": "UIA_IsOffscreenPropertyId",
    "focused": "UIA_HasKeyboardFocusPropertyId",
    "focusable": "UIA_IsKeyboardFocusablePropertyId",
    # valeurs de pattern (lecture d'état déterministe)
    "value": "UIA_ValueValuePropertyId",
    "value_readonly": "UIA_ValueIsReadOnlyPropertyId",
    "range_value": "UIA_RangeValueValuePropertyId",
    "toggle_state": "UIA_ToggleToggleStatePropertyId",
    "selected": "UIA_SelectionItemIsSelectedPropertyId",
    "expand_state": "UIA_ExpandCollapseExpandCollapseStatePropertyId",
    # disponibilité des patterns (guide l'action sémantique)
    "has_value": "UIA_IsValuePatternAvailablePropertyId",
    "has_range": "UIA_IsRangeValuePatternAvailablePropertyId",
    "has_toggle": "UIA_IsTogglePatternAvailablePropertyId",
    "has_selectionitem": "UIA_IsSelectionItemPatternAvailablePropertyId",
    "has_expandcollapse": "UIA_IsExpandCollapsePatternAvailablePropertyId",
    "has_invoke": "UIA_IsInvokePatternAvailablePropertyId",
    "has_scrollitem": "UIA_IsScrollItemPatternAvailablePropertyId",
}
_TreeScope_Subtree = 0x07           # Element | Children | Descendants
_AutomationElementMode_None = 0x00  # éléments cachés SANS référence live (plus léger)


def _ensure_com() -> None:
    """CoInitializeEx en MTA (cohérent avec sys.coinit_flags=0 et pywinauto),
    idempotent et TOLÉRANT (S_FALSE / RPC_E_CHANGED_MODE) ; ne fait JAMAIS
    CoUninitialize (apartment partagé avec pywinauto/comtypes)."""
    try:
        import ctypes
        ctypes.windll.ole32.CoInitializeEx(None, 0x0)   # COINIT_MULTITHREADED
    except Exception:
        pass


def _automation():
    """IUIAutomation singleton, ou None si comtypes/UIA momentanément indisponible.
    Backoff borné sur échec (un blip transitoire ne condamne PAS l'UIA pour tout le
    process) ; réutilisé sur le thread de la boucle event (apartment MTA cohérent)."""
    global _UIA_SINGLETON, _UIA_FAIL_COUNT, _UIA_NEXT_TRY, _UIA_MOD, _UIA_CACHE
    if _UIA_SINGLETON is not None:
        return _UIA_SINGLETON
    now = time.time()
    if now < _UIA_NEXT_TRY:
        return None
    try:
        _ensure_com()
        import comtypes.client
        mod = comtypes.client.GetModule("UIAutomationCore.dll")
        _UIA_SINGLETON = comtypes.client.CreateObject(
            _CLSID_CUIAutomation, interface=mod.IUIAutomation)
        _UIA_MOD = mod
        _PID.clear()
        for logical, const in _CACHE_PROPS.items():
            pid = getattr(mod, const, None)
            if pid is not None:
                _PID[logical] = int(pid)
        _UIA_CACHE = _build_cache_request(_UIA_SINGLETON)   # None si échec → chemin live
        _UIA_FAIL_COUNT = 0
        return _UIA_SINGLETON
    except Exception:
        _UIA_FAIL_COUNT += 1
        _UIA_NEXT_TRY = now + min(60.0, 2.0 * _UIA_FAIL_COUNT)   # retente plus tard
        _UIA_SINGLETON = None
        return None


def _build_cache_request(auto):
    """IUIAutomationCacheRequest qui aspire TOUT le sous-arbre (structure +
    propriétés + valeurs de pattern) en UN appel ``BuildUpdatedCache`` par
    fenêtre — au lieu de ~14 round-trips COM par nœud. TreeFilter=ControlView
    (mêmes nœuds que l'ancien ControlViewWalker, sans le bruit de la vue Raw).
    Renvoie None si comtypes refuse une étape → l'appelant retombe sur le live."""
    try:
        cr = auto.CreateCacheRequest()
    except Exception:
        return None
    try:
        cr.TreeScope = _TreeScope_Subtree
    except Exception:
        pass
    try:
        cr.TreeFilter = auto.ControlViewCondition
    except Exception:
        pass
    try:
        cr.AutomationElementMode = _AutomationElementMode_None
    except Exception:
        pass
    for logical in _CACHE_PROPS:
        pid = _PID.get(logical)
        if pid is None:
            continue
        try:
            cr.AddProperty(pid)
        except Exception:
            pass
    return cr


def _uia_rect(el):
    """CurrentBoundingRectangle (px écran ABSOLUS) → (x, y, w, h) ou None."""
    try:
        r = el.CurrentBoundingRectangle
        return int(r.left), int(r.top), int(r.right) - int(r.left), int(r.bottom) - int(r.top)
    except Exception:
        return None


def _uia_node(el, depth):
    rect = _uia_rect(el)
    if rect is None:
        return None
    x, y, w, h = rect
    if w <= 0 or h <= 0:
        return None
    try:    role = _UIA_CONTROLTYPE.get(int(el.CurrentControlType), "")
    except Exception: role = ""
    try:    name = el.CurrentName or ""
    except Exception: name = ""
    try:    auto_id = el.CurrentAutomationId or ""
    except Exception: auto_id = ""
    try:    class_name = el.CurrentClassName or ""
    except Exception: class_name = ""
    try:    runtime_id = _rid_to_hex(el.GetRuntimeId())
    except Exception: runtime_id = ""
    states = []
    try:
        if el.CurrentIsEnabled: states.append("enabled")
    except Exception: pass
    try:
        if el.CurrentHasKeyboardFocus: states.append("focused")
    except Exception: pass
    try:
        if el.CurrentIsOffscreen: states.append("offscreen")
    except Exception: pass
    return make_node(role or "", name or "", x, y, w, h, value=None,
                     states=states, depth=int(depth), auto_id=auto_id,
                     runtime_id=runtime_id, class_name=class_name)


def _rid_to_hex(rid) -> str:
    """RuntimeId UIA (tableau d'ints) → clé string stable INTRA-session (« 42.13310 »).
    Vide si indisponible. Sert d'ancre pour garder l'id LLM cohérent entre obs."""
    if not rid:
        return ""
    try:
        return ".".join(str(int(v)) for v in rid)
    except Exception:
        try:
            return str(rid)
        except Exception:
            return ""


def _fmt_num(v) -> str:
    """Nombre (slider/progress) → string compacte (« 42 » plutôt que « 42.0 »)."""
    try:
        f = float(v)
        return str(int(f)) if f == int(f) else ("%.4g" % f)
    except Exception:
        return str(v)


def _value_states_patterns(p):
    """PUR : à partir des valeurs/dispos de pattern cachées, déduit (value, states
    additionnels, liste de patterns). C'est ce qui rend l'état LISIBLE sans OCR :
    une checkbox cochée → states=['checked'], un combo ouvert → ['expanded']…"""
    states: List[str] = []
    patterns: List[str] = []
    value = None
    if p.get("has_value"):
        patterns.append("value")
        v = p.get("value")
        if v is not None and str(v) != "":
            value = str(v)
        if p.get("value_readonly"):
            states.append("readonly")
    if p.get("has_range"):
        patterns.append("range")
        rv = p.get("range_value")
        if rv is not None and value is None:
            value = _fmt_num(rv)
    if p.get("has_toggle"):
        patterns.append("toggle")
        ts = p.get("toggle_state")
        try:
            ts = int(ts) if ts is not None else None
        except Exception:
            ts = None
        if ts == 1:
            states.append("checked")
        elif ts == 2:
            states.append("indeterminate")
        elif ts == 0:
            states.append("unchecked")
    if p.get("has_selectionitem"):
        patterns.append("selectionitem")
        if p.get("selected"):
            states.append("selected")
    if p.get("has_expandcollapse"):
        patterns.append("expandcollapse")
        ec = p.get("expand_state")
        try:
            ec = int(ec) if ec is not None else None
        except Exception:
            ec = None
        if ec == 1:
            states.append("expanded")
        elif ec == 0:
            states.append("collapsed")
    if p.get("has_invoke"):
        patterns.append("invoke")
    if p.get("has_scrollitem"):
        patterns.append("scrollitem")
    return value, states, patterns


def _node_from_props(p, depth):
    """PUR (zéro COM) : dict {clé logique → valeur cachée} → nœud normalisé, ou None.
    Testable hors Windows ; le COM ne fait QUE remplir ``p`` (cf. _extract_props)."""
    rect = p.get("rect")
    if not rect or len(rect) < 4:
        return None
    try:
        x, y, w, h = int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3])
    except Exception:
        return None
    if w <= 0 or h <= 0:
        return None
    try:
        ct = int(p.get("control_type") or 0)
    except Exception:
        ct = 0
    role = _UIA_CONTROLTYPE.get(ct, "")
    states: List[str] = []
    if p.get("enabled"):
        states.append("enabled")
    if p.get("focused"):
        states.append("focused")
    if p.get("offscreen"):
        states.append("offscreen")
    value, vstates, patterns = _value_states_patterns(p)
    return make_node(role or "", str(p.get("name") or ""), x, y, w, h, value=value,
                     states=states + vstates, depth=int(depth),
                     auto_id=str(p.get("automation_id") or ""),
                     runtime_id=_rid_to_hex(p.get("runtime_id")),
                     class_name=str(p.get("class_name") or ""), patterns=patterns)


def _extract_props(el):
    """COM (mince) : élément CACHÉ → dict {clé logique → valeur}, lu EN PROCESS.
    Toutes les props lues ont été ajoutées au CacheRequest → pas de round-trip."""
    p: Dict[str, Any] = {}
    g = el.GetCachedPropertyValue
    for logical, pid in _PID.items():
        try:
            p[logical] = g(pid)
        except Exception:
            p[logical] = None
    return p


def _walk_cached(cached_el, nodes, depth, max_nodes, max_depth=30, fanout=80, clip=None):
    """DFS sur l'arbre DÉJÀ aspiré (GetCachedChildren = 0 round-trip COM), borné.
    Même forme que _uia_walk mais lit le cache au lieu de re-naviguer le live.
    ``clip`` (x,y,w,h) optionnel : n'émet que les enfants qui chevauchent cette
    région (scope=focus → rect de la fenêtre) ; None → aucun clip (monitor/desktop)."""
    if depth > max_depth or len(nodes) >= max_nodes:
        return
    try:
        children = cached_el.GetCachedChildren()
    except Exception:
        return
    if children is None:
        return
    try:
        total = int(children.Length)
    except Exception:
        return
    seen = 0
    while seen < total and seen < fanout and len(nodes) < max_nodes:
        try:
            ch = children.GetElement(seen)
        except Exception:
            break
        seen += 1
        n = _node_from_props(_extract_props(ch), depth)
        if n and keep_node(n) and _rect_intersects(n.get("rect"), clip):
            nodes.append(n)
        _walk_cached(ch, nodes, depth + 1, max_nodes, max_depth, fanout, clip)


def _uia_walk(walker, parent, nodes, depth, max_nodes, max_depth=30, fanout=80, clip=None):
    """DFS pré-ordre via TreeWalker (pattern Microsoft « ListDescendants »), borné.
    ``clip`` : cf. _walk_cached (scope=focus n'émet que les enfants dans la fenêtre)."""
    if depth > max_depth or len(nodes) >= max_nodes:
        return
    try:
        child = walker.GetFirstChildElement(parent)
    except Exception:
        return
    seen = 0
    while child is not None and len(nodes) < max_nodes and seen < fanout:
        n = _uia_node(child, depth)
        if n and keep_node(n) and _rect_intersects(n.get("rect"), clip):
            nodes.append(n)
        _uia_walk(walker, child, nodes, depth + 1, max_nodes, max_depth, fanout, clip)
        try:
            child = walker.GetNextSiblingElement(child)
        except Exception:
            break
        seen += 1


def _center_on_region(rect, region):
    """rect=(x,y,w,h). True si le CENTRE du rect tombe dans la région écran capturée
    (robuste aux fenêtres à cheval). region=None → fail-open (ne rien exclure)."""
    if not region:
        return True
    try:
        x, y, w, h = rect
        cx, cy = x + w // 2, y + h // 2
        l, t = int(region["left"]), int(region["top"])
        return l <= cx < l + int(region["width"]) and t <= cy < t + int(region["height"])
    except Exception:
        return True


def _rect_intersects(rect, clip) -> bool:
    """True si ``rect`` (x,y,w,h) chevauche ``clip`` (x,y,w,h). ``clip=None`` → True
    (no-op : les scopes monitor/desktop ne clippent pas). Sert au scope=focus à
    écarter les enfants dont le rect tombe HORS de la fenêtre (rects périmés)."""
    if not clip:
        return True
    try:
        x, y, w, h = rect
        cx, cy, cw, ch = clip
        return not (x >= cx + cw or x + w <= cx or y >= cy + ch or y + h <= cy)
    except Exception:
        return True


def _foreground_hwnd() -> int:
    """HWND de la fenêtre au PREMIER PLAN (0 si aucune). ``restype = HWND`` explicite
    → handle 64-bit NON tronqué (piège ctypes récurrent, cf. les autres
    GetForegroundWindow de ce module). Lecture pure (aucun effet de bord)."""
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        u.GetForegroundWindow.restype = wintypes.HWND
        h = u.GetForegroundWindow()
        return int(h) if h else 0
    except Exception:
        return 0


_SHELL_CLASSES = ("Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW")


def _window_class(hwnd) -> str:
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.WinDLL("user32")
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetClassNameW.restype = ctypes.c_int
        buf = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, buf, 256)
        return buf.value or ""
    except Exception:
        return ""


def _is_shell_window(hwnd) -> bool:
    """True si ``hwnd`` est le bureau / la barre des tâches (Shell_TrayWnd/Progman/
    WorkerW). C'est le PREMIER PLAN quand aucune appli n'a le focus (session idle ou
    headless, ou activation bloquée par le verrou anti-focus-stealing) — scoper
    l'observation dessus renverrait les contrôles de la barre des tâches (inutiles)."""
    return _window_class(hwnd) in _SHELL_CLASSES


def _is_foreground_root(hwnd) -> bool:
    """La fenêtre au premier plan est-elle ``hwnd``, un de ses enfants, ou un dialogue
    qu'elle POSSÈDE ? Un dialogue modal (« Propriétés de la couche » devant QGIS) n'est
    pas un enfant de sa fenêtre : avec GA_ROOT seul, ``focus("QGIS")`` ne réussissait
    jamais et rejouait souris nulle, ALT puis réduire/restaurer en boucle."""
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        u.GetForegroundWindow.restype = wintypes.HWND
        u.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]; u.GetAncestor.restype = wintypes.HWND
        fg = u.GetForegroundWindow()
        if not fg:
            return False
        root = u.GetAncestor(fg, 2) or fg     # GA_ROOT
        owner = u.GetAncestor(fg, 3) or root  # GA_ROOTOWNER
        return int(hwnd) in (int(fg), int(root), int(owner))
    except Exception:
        return True                           # indéterminable : ne pas forcer à l'aveugle


def _win32_force_foreground(hwnd) -> bool:
    """Force une fenêtre au PREMIER PLAN depuis un process en arrière-plan, en
    empilant TOUS les contournements connus du verrou anti-focus-stealing de Windows
    (ce que fait pywinauto.set_focus, recodé car pywinauto peut être ABSENT du VM) :
    (1) désactive le foreground-lock-timeout ; (2) AllowSetForegroundWindow(ANY) ;
    (3) frappe ALT synthétique → satisfait « ce thread a reçu une entrée » exigé par
    SetForegroundWindow ; (4) AttachThreadInput au thread du 1er plan + cible ;
    (5) dernier recours minimize→restore. Renvoie True si le 1er plan est devenu hwnd.
    Best-effort : une session déconnectée/headless peut tout de même refuser."""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    u.GetForegroundWindow.restype = wintypes.HWND
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.c_void_p]
    u.GetWindowThreadProcessId.restype = wintypes.DWORD
    u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    u.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
    u.IsHungAppWindow.argtypes = [wintypes.HWND]; u.IsHungAppWindow.restype = wintypes.BOOL
    u.SetForegroundWindow.argtypes = [wintypes.HWND]; u.SetForegroundWindow.restype = wintypes.BOOL
    u.BringWindowToTop.argtypes = [wintypes.HWND]
    u.IsIconic.argtypes = [wintypes.HWND]; u.IsIconic.restype = wintypes.BOOL
    u.keybd_event.argtypes = [ctypes.c_ubyte, ctypes.c_ubyte, wintypes.DWORD, ctypes.c_void_p]
    SW_RESTORE, SW_MINIMIZE = 9, 6
    VK_MENU, KEYEVENTF_KEYUP = 0x12, 0x0002
    # (1) timeout du verrou de focus → 0 (best-effort, ignore l'échec).
    try:
        u.SystemParametersInfoW(0x2001, 0, ctypes.c_void_p(0), 0)   # SPI_SETFOREGROUNDLOCKTIMEOUT
    except Exception:
        pass
    # (2) autorise n'importe quel process à passer au 1er plan.
    try:
        u.AllowSetForegroundWindow(ctypes.c_uint(0xFFFFFFFF))       # ASFW_ANY
    except Exception:
        pass
    # Déjà au premier plan : AUCUNE entrée synthétique. Vu sur la VM (15/09) : la frappe
    # ALT de l'étape (3) activait la barre de menus de la fenêtre DÉJÀ devant, et la
    # touche suivante était avalée comme raccourci de menu (« focus » puis « xyz » → « yz »,
    # « launch » puis « bonjour » → « onjour »).
    if _is_foreground_root(hwnd):
        try:
            if u.IsIconic(hwnd):
                u.ShowWindowAsync(hwnd, SW_RESTORE)
        except Exception:
            pass
        return True
    # Appli « Ne répond pas » : ShowWindow / BringWindowToTop / AttachThreadInput vers son
    # thread ATTENDENT qu'elle réponde — le worker UIA unique restait figé, tous les
    # endpoints en 503. On renonce proprement (la fenêtre n'est pas utilisable de toute façon).
    try:
        if u.IsHungAppWindow(hwnd):
            return False
    except Exception:
        pass
    cur = k.GetCurrentThreadId()
    fg = u.GetForegroundWindow()
    fg_thread = u.GetWindowThreadProcessId(fg, None) if fg else 0
    tgt_thread = u.GetWindowThreadProcessId(hwnd, None)
    attached = []
    for t in {fg_thread, tgt_thread}:
        if t and t != cur:
            try:
                if u.AttachThreadInput(cur, t, True):
                    attached.append(t)
            except Exception:
                pass
    try:
        # SW_RESTORE sur une fenêtre AGRANDIE la « restaure en bas » : QGIS maximisé
        # rétrécissait à l'étape 1 et tous les points rel/at suivants tombaient à côté.
        # On ne restaure qu'une fenêtre RÉDUITE ; sinon simple SW_SHOW.
        u.ShowWindowAsync(hwnd, SW_RESTORE if u.IsIconic(hwnd) else 5)   # SW_SHOW = 5 ; asynchrone : jamais bloqué par l'appli
        u.BringWindowToTop(hwnd)

        def _try():
            u.SetForegroundWindow(hwnd)
            return _is_foreground_root(hwnd)
        ok = _try()
        if not ok:
            # (3a) une ENTRÉE neutre satisfait « ce process a reçu une entrée » : un
            # mouvement de souris NUL, qui n'active aucun menu.
            try:
                _sendinput([{"kind": "mouse", "dx": 0, "dy": 0, "data": 0, "flags": MOUSEEVENTF_MOVE}])
            except Exception:
                pass
            ok = _try()
        if not ok:
            # (3b) dernier recours : frappe ALT. La cible n'est PAS devant : c'est l'ancienne
            # fenêtre qui reçoit l'ALT, pas celle où l'on va taper.
            try:
                u.keybd_event(VK_MENU, 0, 0, None)
                u.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, None)
            except Exception:
                pass
            ok = _try()
        if not ok or not _is_foreground_root(hwnd):
            # (5) dernier recours : un cycle minimize→restore force souvent l'activation.
            u.ShowWindow(hwnd, SW_MINIMIZE)
            u.ShowWindow(hwnd, SW_RESTORE)
            u.SetForegroundWindow(hwnd)
            time.sleep(0.05)
        return _is_foreground_root(hwnd)
    finally:
        for t in attached:
            try:
                u.AttachThreadInput(cur, t, False)
            except Exception:
                pass


# ── Synthèse d'entrée bas-niveau : SendInput (vs pyautogui keybd_event/mouse_event) ──
# pyautogui injecte 1 évènement/syscall via les API DÉPRÉCIÉES keybd_event/mouse_event,
# sans batch atomique, et son drag/type insère des time.sleep qui BLOQUENT le thread
# loop unique du serveur. SendInput pousse un TABLEAU d'INPUT en un seul syscall atomique
# (séquence mods↓→action→mods↑ ininterruptible par un changement de focus) et permet
# KEYEVENTF_UNICODE (accents FR/emoji indépendants du layout) + scancodes (apps qui
# ignorent les VK nus). Ci-dessous, les BUILDERS sont PURS (testables hors Windows) ;
# seul ``_sendinput`` touche user32. Opt-in (DESKTOP_USE_SENDINPUT) → pyautogui reste le défaut.
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

_VK = {
    "ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12, "menu": 0x12,
    "win": 0x5B, "super": 0x5B, "cmd": 0x5B,
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E, "insert": 0x2D,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
}
for _i in range(1, 25):
    _VK["f%d" % _i] = 0x70 + (_i - 1)   # F1..F24


def _vk_for(token):
    """Nom de touche → virtual-key code, ou None si inconnu (l'appelant retombe sur
    pyautogui). Lettres/chiffres = code ASCII majuscule (= VK), noms via la table."""
    t = str(token or "").strip().lower()
    if not t:
        return None
    if t in _VK:
        return _VK[t]
    if len(t) == 1:
        c = t.upper()
        if ("A" <= c <= "Z") or ("0" <= c <= "9"):
            return ord(c)
    return None


def _utf16_units(text):
    """Liste des unités de code UTF-16-LE d'une chaîne (gère les paires de
    substitution → emoji hors BMP injectés en deux unités KEYEVENTF_UNICODE)."""
    data = str(text or "").encode("utf-16-le")
    return [data[i] | (data[i + 1] << 8) for i in range(0, len(data) - 1, 2)]


def _text_key_descriptors(text):
    """Texte → descripteurs SendInput pour ``type`` : chaque caractère en
    KEYEVENTF_UNICODE (layout-INDÉPENDANT — corrige la frappe type « ( »→« 5 »
    sur clavier AZERTY) ET chaque saut de ligne en VK_RETURN (un LF Unicode nu ne
    déclenche PAS Entrée dans la plupart des apps → indispensable pour taper du
    CODE multi-ligne). ``\\r\\n`` / ``\\r`` normalisés. Pur & testable."""
    vk_return = _VK["enter"]
    vk_tab = _VK.get("tab", 0x09)
    out = []
    norm = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    for ch in norm:
        if ch == "\n" or ch == "\t":
            vk = vk_return if ch == "\n" else vk_tab      # une tabulation Unicode ne change pas de champ
            out.append({"kind": "key", "vk": vk, "scan": 0, "flags": 0})
            out.append({"kind": "key", "vk": vk, "scan": 0, "flags": KEYEVENTF_KEYUP})
        else:
            for cu in _utf16_units(ch):
                out.append({"kind": "key", "vk": 0, "scan": cu, "flags": KEYEVENTF_UNICODE})
                out.append({"kind": "key", "vk": 0, "scan": cu,
                            "flags": KEYEVENTF_UNICODE | KEYEVENTF_KEYUP})
    return out


def _named_key_descriptors(keys):
    """'ctrl+s' → descripteurs ATOMIQUES : mods↓ → touche↓ → touche↑ → mods↑.
    Renvoie [] si une touche est inconnue (→ repli pyautogui)."""
    parts = [p for p in str(keys or "").replace(" ", "").split("+") if p]
    if not parts:
        return []
    mods, main = parts[:-1], parts[-1]
    vmods = [_vk_for(m) for m in mods]
    vmain = _vk_for(main)
    if vmain is None or any(v is None for v in vmods):
        return []
    ext = lambda v: KEYEVENTF_EXTENDEDKEY if v in _EXTENDED_VKS else 0
    out = [{"kind": "key", "vk": v, "scan": 0, "flags": ext(v)} for v in vmods]
    out.append({"kind": "key", "vk": vmain, "scan": 0, "flags": ext(vmain)})
    out.append({"kind": "key", "vk": vmain, "scan": 0, "flags": KEYEVENTF_KEYUP | ext(vmain)})
    out += [{"kind": "key", "vk": v, "scan": 0, "flags": KEYEVENTF_KEYUP | ext(v)} for v in reversed(vmods)]
    return out


# Touches du bloc ÉTENDU (flèches, Origine/Fin, Pg préc./suiv., Inser/Suppr, Win,
# Menu, Ctrl/Alt droits). Sans KEYEVENTF_EXTENDEDKEY, Windows les lit comme les
# touches du PAVÉ NUMÉRIQUE : avec Verr. num actif, « shift+right » relâchait Maj
# (la sélection ne s'étendait pas) et « delete » tapait parfois un point.
KEYEVENTF_EXTENDEDKEY = 0x0001
_EXTENDED_VKS = frozenset({0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E,
                           0x5B, 0x5C, 0x5D, 0xA3, 0xA5, 0x6F, 0x90})


def _normalize_abs(x, y, vleft, vtop, vwidth, vheight):
    """Coord écran absolue → repère 0..65535 du bureau VIRTUEL (pour
    MOUSEEVENTF_ABSOLUTE|VIRTUALDESK). Borné. vwidth/vheight = SM_CX/CYVIRTUALSCREEN."""
    if vwidth <= 1 or vheight <= 1:
        return (0, 0)
    nx = int(round((x - vleft) * 65535.0 / (vwidth - 1)))
    ny = int(round((y - vtop) * 65535.0 / (vheight - 1)))
    return (max(0, min(65535, nx)), max(0, min(65535, ny)))


MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP = 0x0020, 0x0040
_MOUSE_BUTTONS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


_CLICK_HOVER_S = 0.03   # survol avant l'appui (l'interface traite le WM_MOUSEMOVE)
_CLICK_GAP_S = 0.04     # entre deux clics d'un double/triple (délai de double-clic ≈ 500 ms)


def _mouse_click_descriptors(x, y, button="left", clicks=1, vscreen=(0, 0, 0, 0)):
    """Clic(s) SendInput ATOMIQUES et ANCRÉS : chaque évènement — le déplacement,
    PUIS chaque enfoncement ET chaque relâchement — porte la position ABSOLUE de
    la cible (MOVE|ABSOLUTE|VIRTUALDESK + dx/dy). Un mouvement de souris de
    l'utilisateur entre deux évènements ne déplace donc pas le clic, et un
    double-clic reste un double-clic (deux paires dans le MÊME appel, sans
    délai ni déplacement entre elles). ``vscreen`` = (left, top, width, height)
    du bureau virtuel. Pur (testable hors Windows) ; [] si bouton inconnu."""
    down, up = _MOUSE_BUTTONS.get(str(button or "left").lower(), (None, None))
    if down is None:
        return []
    nx, ny = _normalize_abs(int(x), int(y), *vscreen)
    base = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    out = [{"kind": "mouse", "dx": nx, "dy": ny, "data": 0, "flags": base}]
    for _ in range(max(1, int(clicks or 1))):
        out.append({"kind": "mouse", "dx": nx, "dy": ny, "data": 0, "flags": base | down})
        out.append({"kind": "mouse", "dx": nx, "dy": ny, "data": 0, "flags": base | up})
    return out


def _virtual_screen():
    """(left, top, width, height) du bureau VIRTUEL (tous écrans) — repère de
    MOUSEEVENTF_VIRTUALDESK. Windows uniquement ; (0,0,0,0) si indisponible."""
    try:
        import ctypes
        u = ctypes.windll.user32
        return (int(u.GetSystemMetrics(76)), int(u.GetSystemMetrics(77)),
                int(u.GetSystemMetrics(78)), int(u.GetSystemMetrics(79)))
    except Exception:
        return (0, 0, 0, 0)


def _sendinput(descriptors):
    """Injecte une liste de descripteurs (clavier/souris) en UN appel SendInput
    atomique. Windows UNIQUEMENT. Renvoie le nb d'évènements acceptés (0 = échec →
    l'appelant retombe sur pyautogui)."""
    try:
        import ctypes
        from ctypes import wintypes
        ULONG_PTR = wintypes.WPARAM

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("dwExtraInfo", ULONG_PTR)]

        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                        ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

        class _IU(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

        class INPUT(ctypes.Structure):
            _anonymous_ = ("u",)
            _fields_ = [("type", wintypes.DWORD), ("u", _IU)]

        INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
        arr = (INPUT * len(descriptors))()
        for i, d in enumerate(descriptors):
            if d.get("kind") == "key":
                arr[i].type = INPUT_KEYBOARD
                arr[i].ki = KEYBDINPUT(int(d.get("vk", 0)), int(d.get("scan", 0)),
                                       int(d.get("flags", 0)), 0, 0)
            else:
                arr[i].type = INPUT_MOUSE
                arr[i].mi = MOUSEINPUT(int(d.get("dx", 0)), int(d.get("dy", 0)),
                                       int(d.get("data", 0)), int(d.get("flags", 0)), 0, 0)
        u = ctypes.windll.user32
        u.SendInput.argtypes = [wintypes.UINT, ctypes.c_void_p, ctypes.c_int]
        u.SendInput.restype = wintypes.UINT
        return int(u.SendInput(len(arr), ctypes.byref(arr), ctypes.sizeof(INPUT)))
    except Exception:
        return 0


# HRESULT d'erreurs COM/UIA TRANSITOIRES = l'élément est périmé (UI repeinte) ou
# le serveur RPC momentanément occupé → re-résoudre + rejouer la même action
# sémantique RÉUSSIT, là où retomber en clic-coordonnées clique au mauvais endroit.
# Stockés en unsigned 32-bit (on normalise le hresult signé de comtypes).
_TRANSIENT_HRESULTS = frozenset({
    0x80040201,   # UIA_E_ELEMENTNOTAVAILABLE (l'élément n'existe plus → re-find)
    0x80010108,   # RPC_E_DISCONNECTED
    0x80010001,   # RPC_E_CALL_REJECTED
    0x8001010A,   # RPC_E_SERVERCALL_RETRYLATER (appelé occupé)
    0x800706BA,   # RPC_S_SERVER_UNAVAILABLE
})


def _is_transient_com(exc) -> bool:
    """True si ``exc`` est une COMError transitoire (élément périmé / RPC occupé).
    Distingue le « contrôle à re-résoudre » du « pattern absent » (NoPatternInterface
    /AttributeError de pywinauto → pas de hresult transitoire → repli coords légitime)."""
    h = getattr(exc, "hresult", None)
    if h is None:
        args = getattr(exc, "args", None)
        h = args[0] if (args and isinstance(args[0], int)) else None
    if h is None:
        return False
    try:
        return (int(h) & 0xFFFFFFFF) in _TRANSIENT_HRESULTS
    except (TypeError, ValueError):
        return False


def _retry_schedule(max_attempts=3, base_ms=80, cap_total_ms=600):
    """Délais (s) AVANT chaque tentative : la 1ʳᵉ immédiate, puis backoff borné
    dont le CUMUL ne dépasse pas ``cap_total_ms`` (le serveur n'a pas de timeout
    et le corps tourne sur le thread loop unique → on ne bloque jamais longtemps)."""
    delays = [0.0]
    total = 0.0
    for i in range(1, max(1, max_attempts)):
        d = base_ms * (2 ** (i - 1))
        if total + d > cap_total_ms:
            break
        total += d
        delays.append(d / 1000.0)
    return delays


def _try_pattern_call(fn) -> bool:
    """Exécute un appel iface : True si OK, False si pattern ABSENT (ou autre échec
    non-transitoire). Laisse remonter une COMError TRANSITOIRE → l'appelant
    (element_action) re-résout le contrôle et rejoue."""
    try:
        fn()
        return True
    except Exception as e:
        if _is_transient_com(e):
            raise
        return False


# ── Action sémantique SANS pywinauto (comtypes seul) ───────────────────────────
# pywinauto importe win32ui, qui exige mfc140u.dll (Visual C++ Redistributable) :
# absent sur une VM de test nue, TOUT element_action retombait en clic-coords, en
# silence. Le même IUIAutomation (comtypes) qui lit l'arbre sait aussi retrouver
# un élément par propriété et invoquer ses patterns : on garde donc l'action
# sémantique (Invoke/Toggle/Select/Value) là où seul le clic aveugle restait.
_TreeScope_Descendants = 0x04
_UIA_PATTERN_IDS = {"invoke": 10000, "selection_item": 10010, "toggle": 10015,
                    "expand_collapse": 10005, "value": 10002, "scroll_item": 10017}
_UIA_PATTERN_IFACES = {"invoke": "IUIAutomationInvokePattern", "selection_item": "IUIAutomationSelectionItemPattern",
                       "toggle": "IUIAutomationTogglePattern", "expand_collapse": "IUIAutomationExpandCollapsePattern",
                       "value": "IUIAutomationValuePattern", "scroll_item": "IUIAutomationScrollItemPattern"}
_UIA_PROP_IDS = {"automation_id": 30011, "name": 30005, "control_type": 30003, "toggle_state": 30086,
                 "offscreen": 30022}


def _uia_pattern(mod, el, key):
    """Objet pattern ``key`` de l'élément, ou None s'il ne l'expose pas."""
    try:
        raw = el.GetCurrentPattern(_UIA_PATTERN_IDS[key])
    except Exception:
        return None
    if not raw:
        return None
    try:
        return raw.QueryInterface(getattr(mod, _UIA_PATTERN_IFACES[key]))
    except Exception:
        return None


def _uia_find(auto, mod, *, auto_id="", name="", control_type="", x=None, y=None):
    """Élément UIA par ``auto_id`` sinon ``name`` (+type), cherché dans la fenêtre
    au premier plan puis sur tout le bureau. Plusieurs candidats : celui dont le
    rectangle contient (x, y) — le point lu dans l'arbre par le runtime — sinon
    le premier à l'écran. None si rien."""
    scopes = []
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        u.GetForegroundWindow.restype = wintypes.HWND
        h = u.GetForegroundWindow()
        if h and not _is_shell_window(h):
            scopes.append(auto.ElementFromHandle(h))
    except Exception:
        pass
    try:
        scopes.append(auto.GetRootElement())
    except Exception:
        pass
    ct_id = _role_ct_id(control_type)
    conds = []
    try:
        if auto_id:
            conds.append(auto.CreatePropertyCondition(_UIA_PROP_IDS["automation_id"], str(auto_id)))
        if name:
            c = auto.CreatePropertyCondition(_UIA_PROP_IDS["name"], str(name))
            if ct_id is not None:
                c = auto.CreateAndCondition(c, auto.CreatePropertyCondition(_UIA_PROP_IDS["control_type"], int(ct_id)))
            conds.append(c)
    except Exception:
        return None
    # Avec un point (centre lu dans l'arbre par le runtime) : l'élément qui le
    # CONTIENT, cherché dans TOUTES les portées avant de se contenter du premier
    # homonyme — un « OK » de la fenêtre au premier plan ne vole plus le clic destiné
    # au « OK » d'un dialogue ou d'un dock flottant.
    has_pt = x is not None and y is not None
    firsts = []
    for scope in scopes:
        for cond in conds:
            try:
                found = scope.FindAll(_TreeScope_Descendants, cond)
                n = int(found.Length) if found is not None else 0
            except Exception:
                continue
            best, visible = None, 0
            for i in range(n):
                try:
                    el = found.GetElement(i)
                except Exception:
                    continue
                r = _uia_rect(el)
                if has_pt and r and r[0] <= int(x) < r[0] + r[2] and r[1] <= int(y) < r[1] + r[3]:
                    return el
                try:
                    off = bool(el.CurrentIsOffscreen)
                except Exception:
                    off = False
                if not off:
                    visible += 1
                    if best is None:
                        best = el
            if best is not None:
                if not has_pt:
                    return best
                # Point fourni, AUCUN homonyme ne le contient (liste qui a défilé) : un seul
                # candidat reste sûr ; plusieurs « Modifier » → le premier était actionné à la
                # place du 3e. Ambigu : l'appelant clique au point (le centre lu dans l'arbre).
                if visible == 1:
                    firsts.append(best)
    return firsts[0] if firsts else None


def _uia_action(mod, el, action, text=""):
    """Actionne un élément comtypes par le pattern qui correspond à l'intention —
    même table que ``_pattern_action`` (pywinauto). ``{method}`` si traité, None
    sinon (→ coordonnées). Un double-clic n'a pas de pattern : None."""
    action = (action or "").strip().lower()
    if action in ("toggle", "check", "uncheck"):
        tog = _uia_pattern(mod, el, "toggle")
        if tog is None:
            return None
        cur = None
        try:
            cur = int(tog.CurrentToggleState)
        except Exception:
            pass
        if action == "check" and cur == 1:
            return {"method": "toggle", "noop": True, "toggle_state": "on"}
        if action == "uncheck" and cur == 0:
            return {"method": "toggle", "noop": True, "toggle_state": "off"}
        tog.Toggle()
        return {"method": "toggle"}
    if action == "select":
        p = _uia_pattern(mod, el, "selection_item")
        if p is None:
            return None
        p.Select()
        return {"method": "select"}
    if action in ("expand", "collapse"):
        p = _uia_pattern(mod, el, "expand_collapse")
        if p is None:
            return None
        (p.Expand if action == "expand" else p.Collapse)()
        return {"method": action}
    if action == "scroll_into_view":
        p = _uia_pattern(mod, el, "scroll_item")
        if p is None:
            return None
        p.ScrollIntoView()
        return {"method": "scroll_into_view"}
    if action == "set_value":
        p = _uia_pattern(mod, el, "value")
        if p is None:
            return None
        p.SetValue(str(text))
        return {"method": "set_value"}
    if action in ("click", "invoke", "left_click"):
        # Un élément de MENU se clique pour de vrai : sous Qt, Invoke sur une
        # entrée de barre de menus « déclenche » l'action sans ouvrir le menu, et
        # Invoke sur une entrée de menu ouvert laisse le menu affiché (vu sur QGIS).
        role = _uia_role(el)
        if role == "menuitem":
            return None
        tog = _uia_pattern(mod, el, "toggle")
        sel = _uia_pattern(mod, el, "selection_item")
        if _click_needs_real_click(role, sel is not None):
            return None
        # Case à cocher : un clic la BASCULE. Tout autre élément qui expose aussi une
        # sélection (couche QGIS, item de liste cochable) : un clic le SÉLECTIONNE —
        # Toggle d'abord masquait la couche au lieu de la choisir.
        if sel is not None or tog is not None:
            try:
                el.SetFocus()                 # comme un vrai clic (best-effort)
            except Exception:
                pass
        if sel is not None and (tog is None or not _toggle_first(role)):
            sel.Select()
            return {"method": "select"}
        if tog is not None:
            tog.Toggle()
            return {"method": "toggle"}
        inv = _uia_pattern(mod, el, "invoke")
        if inv is not None:
            inv.Invoke()
            return {"method": "invoke"}
    return None


_ROLE_ALIASES = {"textbox": "edit", "text box": "edit", "entry": "edit", "radio": "radiobutton",
                 "radio button": "radiobutton", "link": "hyperlink", "check box": "checkbox",
                 "push button": "button", "toggle button": "button", "menu item": "menuitem",
                 "list item": "listitem", "tree item": "treeitem", "combo box": "combobox",
                 "page tab": "tabitem", "tab item": "tabitem", "split button": "splitbutton",
                 "data item": "dataitem", "tool bar": "toolbar", "status bar": "statusbar"}
_CONTROLTYPE_BY_ROLE = {v: k for k, v in _UIA_CONTROLTYPE.items()}


def _role_ct_id(role):
    """Rôle de l'arbre (« button », « textbox », « menu item »…) → ControlType UIA
    entier, ou None. pywinauto attend « Button » (clé sensible à la casse) : le rôle
    en minuscules levait KeyError, avalé → le filtre de type ne s'appliquait jamais."""
    r = str(role or "").strip().lower()
    if not r:
        return None
    r = _ROLE_ALIASES.get(r, r)
    return _CONTROLTYPE_BY_ROLE.get(r) or _CONTROLTYPE_BY_ROLE.get(r.replace(" ", "").replace("_", ""))


_ITEM_ROLES = frozenset({"treeitem", "listitem", "dataitem", "tabitem"})


def _click_needs_real_click(role, has_selection) -> bool:
    """Clic simple sur un ÉLÉMENT (d'arbre, de liste, de grille, onglet) qui n'expose
    PAS la sélection : seul un vrai clic fait ce que fait l'utilisateur. Vu sur la VM
    (QGIS 3.44, panneau Couches) : l'élément de couche expose Toggle mais pas
    SelectionItem, et Toggle y est SANS EFFET tout en réussissant — le « clic » ne
    choisissait pas la couche (et ailleurs la masquerait)."""
    r = str(role or "").strip().lower().replace(" ", "").replace("_", "")
    return r in _ITEM_ROLES and not has_selection


_TOGGLE_FIRST_ROLES = frozenset({"checkbox", "button", "splitbutton", "togglebutton"})


def _toggle_first(role) -> bool:
    """Rôle pour lequel un clic simple = bascule, même si l'élément expose aussi
    SelectionItem (case à cocher, bouton bascule de barre d'outils)."""
    r = str(role or "").strip().lower().replace(" ", "").replace("_", "")
    return r in _TOGGLE_FIRST_ROLES


def _uia_role(el) -> str:
    try:
        return _UIA_CONTROLTYPE.get(int(el.CurrentControlType), "")
    except Exception:
        return ""


# Un appel de pattern qui échoue APRÈS ce délai a très probablement AGI : Invoke sur un
# bouton qui ouvre un dialogue modal bloque jusqu'à sa fermeture puis expire (UIA_E_TIMEOUT,
# ~20 s). Le rejouer en clic aux coordonnées appuyait sur ce qui est DANS le dialogue.
_SLOW_PATTERN_S = 2.0
# Actions qu'un clic au point accomplit (mêmes que le repli du runtime) : un
# ``expand`` / ``scroll_into_view`` / ``set_value`` sans pattern n'est jamais un clic.
_COORD_FALLBACK_ACTIONS = frozenset({"click", "invoke", "left_click", "double_click",
                                     "toggle", "check", "uncheck", "select"})


def _uncertain(action, e, **extra):
    out = {"method": action, "uncertain": True, "error": str(e)[:200]}
    out.update(extra)
    return out


def _uia_element_action(*, action="click", auto_id="", name="", control_type="", text="", x=None, y=None):
    """Chemin comtypes complet : trouver puis actionner. ``{method}`` ou None
    (élément absent, pattern absent, UIA indisponible) → l'appelant clique aux
    coordonnées. N'est tenté que si pywinauto n'a pas pu répondre. Un pattern qui
    échoue LENTEMENT → ``{method, uncertain}`` (a probablement agi : pas de clic)."""
    auto = _automation()
    if auto is None or _UIA_MOD is None:
        return None
    # Élément de menu : _uia_action le laisse au vrai clic — inutile de parcourir l'arbre.
    if action in ("click", "invoke", "left_click") and str(control_type or "").strip().lower().replace(" ", "") == "menuitem":
        return None
    try:
        el = _uia_find(auto, _UIA_MOD, auto_id=auto_id, name=name, control_type=control_type, x=x, y=y)
    except Exception:
        return None
    if el is None:
        return None
    t0 = time.monotonic()
    try:
        r = _uia_action(_UIA_MOD, el, action, text=text)
    except Exception as e:
        if time.monotonic() - t0 >= _SLOW_PATTERN_S:
            return _uncertain(action, e, auto_id=auto_id, name=name, via="uia")
        return None
    if r is not None:
        r.setdefault("auto_id", auto_id)
        r.setdefault("name", name)
        r["via"] = "uia"
    return r


def _pattern_action(ctrl, action, text="", role=""):
    """Actionne un contrôle pywinauto via le BON control pattern UIA selon
    l'intention. Renvoie ``{method: ...}`` si un pattern a traité l'action, ou
    None (→ l'appelant tente Invoke / clic / coords). Bas niveau : appelle
    directement les interfaces ``iface_*`` (lèvent si le pattern est absent →
    capturé). Une COMError TRANSITOIRE remonte (→ re-résolution). Pur vis-à-vis du
    backend (testable avec un faux ``ctrl``)."""
    action = (action or "").strip().lower()
    try:
        if action in ("toggle", "check", "uncheck"):
            tog = ctrl.iface_toggle
            cur = None
            try:
                cur = int(tog.CurrentToggleState)   # 0 off, 1 on, 2 indéterminé
            except Exception:
                cur = None
            if action == "check" and cur == 1:
                return {"method": "toggle", "noop": True, "toggle_state": "on"}
            if action == "uncheck" and cur == 0:
                return {"method": "toggle", "noop": True, "toggle_state": "off"}
            tog.Toggle()
            return {"method": "toggle"}
        if action == "select":
            ctrl.iface_selection_item.Select()
            return {"method": "select"}
        if action == "expand":
            ctrl.iface_expand_collapse.Expand()
            return {"method": "expand"}
        if action == "collapse":
            ctrl.iface_expand_collapse.Collapse()
            return {"method": "collapse"}
        if action == "scroll_into_view":
            ctrl.iface_scroll_item.ScrollIntoView()
            return {"method": "scroll_into_view"}
        if action == "set_value":
            ctrl.iface_value.SetValue(str(text))
            return {"method": "set_value"}
    except Exception as e:
        if _is_transient_com(e):
            raise           # élément périmé → element_action re-résout et rejoue
        return None         # pattern explicite indisponible → repli coords (appelant)
    # Clic GÉNÉRIQUE : préférer Toggle (checkbox/bouton bascule) puis Select
    # (listitem/onglet/radio) — ces contrôles n'exposent PAS InvokePattern, donc
    # sans ça on tomberait sur un clic-coords. ExpandCollapse reste réservé aux ops
    # explicites (ambigu sur combo/splitbutton : un clic ouvre OU invoque).
    if action in ("click", "invoke", "left_click"):
        if not role:
            try:
                role = str(ctrl.element_info.control_type or "")
            except Exception:
                role = ""
        if str(role).strip().lower().replace(" ", "") == "menuitem":
            return None       # entrée de menu Qt : vrai clic (Toggle laissait le menu ouvert)
        try:
            has_sel = ctrl.iface_selection_item is not None
        except Exception:
            has_sel = False
        if _click_needs_real_click(role, has_sel):
            return None       # élément sans sélection : vrai clic (Toggle muet sous Qt)
        # Un vrai clic donne le FOCUS clavier : sans lui, un ``key("f2")`` qui suit
        # partait dans le contrôle précédent. Best-effort, AVANT la bascule/sélection.
        try:
            ctrl.element_info.element.SetFocus()
        except Exception:
            pass
        # Case à cocher / bouton bascule : Toggle d'abord. Tout le reste (item d'arbre
        # ou de liste cochable) : Select d'abord — un clic choisit, il ne décoche pas.
        order = (("toggle", lambda: ctrl.iface_toggle.Toggle()), ("select", lambda: ctrl.iface_selection_item.Select()))
        if not _toggle_first(role):
            order = order[::-1]
        for method, call in order:
            if _try_pattern_call(call):
                return {"method": method}
    return None


_PYWINAUTO = {"desktop": None, "error": None, "at": 0.0}


def _pywinauto_desktop():
    """Classe ``pywinauto.Desktop``, import MÉMORISÉ. Installé mais cassé (mfc140u absent),
    chaque ``from pywinauto import Desktop`` rejouait l'init du paquet et un chargement de
    DLL en échec — à CHAQUE clic, attente, lancement. L'échec est retenu 5 min."""
    if _PYWINAUTO["desktop"] is not None:
        return _PYWINAUTO["desktop"]
    if _PYWINAUTO["error"] is not None and time.monotonic() - _PYWINAUTO["at"] < 300:
        raise ImportError(_PYWINAUTO["error"])
    try:
        from pywinauto import Desktop
    except Exception as e:
        _PYWINAUTO.update(error="%s: %s" % (type(e).__name__, e), at=time.monotonic())
        raise ImportError(_PYWINAUTO["error"]) from e
    _PYWINAUTO.update(desktop=Desktop, error=None)
    return Desktop


def _open_clipboard(u, tries=10, pause=0.02) -> bool:
    """OpenClipboard avec quelques essais : juste après Ctrl+C, rdpclip / vmtoolsd le
    tiennent souvent quelques millisecondes (« clipboard busy » au premier essai)."""
    for _i in range(max(1, tries)):
        if u.OpenClipboard(None):
            return True
        time.sleep(pause)
    return False


def _decode_console(b) -> str:
    """Sortie d'un programme console : UTF-8 si valide, sinon la page OEM de la machine
    (cp850 sur un Windows français : « Répertoire » arrivait en « R\ufffdpertoire »)."""
    b = bytes(b or b"")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        import ctypes
        return b.decode("cp%d" % int(ctypes.windll.kernel32.GetOEMCP()), "replace")
    except Exception:
        return b.decode("utf-8", "replace")


def kill_process_tree(pid) -> None:
    """Tue un processus ET ses enfants (``taskkill /T /F``) ; repli : le seul processus."""
    import subprocess
    try:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(int(pid))], capture_output=True, timeout=10,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return
    except Exception:
        pass
    try:
        os.kill(int(pid), 9)
    except Exception:
        pass


def release_stuck_inputs() -> list:
    """Relâche les touches de modification et boutons de souris restés ENFONCÉS : un
    script arrêté (TerminateProcess) en plein ``click(modifiers="ctrl")`` ou glisser ne
    passe pas par son ``finally`` — Ctrl restait appuyé pour toute la session. Seules les
    touches réellement enfoncées sont relâchées (GetAsyncKeyState). Renvoie leurs noms."""
    try:
        import ctypes
        u = ctypes.windll.user32
    except Exception:
        return []
    keys = {"shift": 0x10, "ctrl": 0x11, "alt": 0x12, "lwin": 0x5B, "rwin": 0x5C}
    buttons = {"lbutton": (0x01, MOUSEEVENTF_LEFTUP), "rbutton": (0x02, MOUSEEVENTF_RIGHTUP)}
    desc, released = [], []
    for name, vk in keys.items():
        try:
            if u.GetAsyncKeyState(vk) & 0x8000:
                desc.append({"kind": "key", "vk": vk, "scan": 0, "flags": KEYEVENTF_KEYUP})
                released.append(name)
        except Exception:
            pass
    for name, (vk, flag) in buttons.items():
        try:
            if u.GetAsyncKeyState(vk) & 0x8000:
                desc.append({"kind": "mouse", "dx": 0, "dy": 0, "data": 0, "flags": flag})
                released.append(name)
        except Exception:
            pass
    if desc:
        _sendinput(desc)
    return released


class WindowsBackend(DesktopBackend):
    name = "windows"

    def __init__(self) -> None:
        _ensure_dpi_aware()
        self._pyautogui = None
        self._screenshot_impl = self._probe_screenshot()
        self._input_impl = "pyautogui" if self._try_pyautogui() else "none"
        # SendInput par DÉFAUT (opt-out DESKTOP_USE_SENDINPUT=0) : frappe Unicode
        # layout-INDÉPENDANTE (corrige « ( »→« 5 » sur AZERTY ; un \\n devient
        # Entrée pour le code) + raccourcis VK ATOMIQUES (copy/paste fiables, là où
        # pyautogui.hotkey séquentiel rate). Repli auto pyautogui si SendInput
        # renvoie 0 → aucun comportement perdu.
        self._use_sendinput = str(os.environ.get("DESKTOP_USE_SENDINPUT", "1")).strip().lower() \
            not in ("0", "false", "no", "off")

    def _probe_screenshot(self) -> str:
        try:
            import mss  # noqa: F401
            return "mss"
        except Exception:
            pass
        try:
            from PIL import ImageGrab  # noqa: F401
            return "pil"
        except Exception:
            return "none"

    def _try_pyautogui(self) -> bool:
        try:
            import pyautogui
            pyautogui.FAILSAFE = False
            self._pyautogui = pyautogui
            return True
        except Exception:
            return False

    def health(self) -> Dict[str, Any]:
        # IMPORTANT : l'arbre UIA vient de comtypes (champ ``uia``), PAS de pywinauto.
        # pywinauto ne sert QU'A l'activation/lancement de fenetres (set_focus/launch)
        # et au repli COUCHE B. Donc `pywinauto=false` n'empeche NI l'observe NI le
        # clic : c'est une source de confusion frequente -> on separe les 2 signaux.
        # On NE SWALLOW PLUS l'erreur : "absent" (ModuleNotFoundError) et "installe
        # mais KO a l'import" (conflit COM / codegen comtypes) sont 2 diagnostics
        # opposes -- le 2e est le cas "la variable n'est pas bonne".
        pywinauto = False
        pywinauto_error = None
        try:
            import pywinauto as _pywinauto  # noqa: F401
            pywinauto = True
        except Exception as e:
            pywinauto_error = "%s: %s" % (type(e).__name__, e)
        try:
            uia = _automation() is not None      # moteur d'arbre reel (comtypes UIA)
        except Exception:
            uia = False
        out = {"os": "windows", "backend": "windows", "input": self._input_impl,
               "screenshot": self._screenshot_impl, "session_type": "interactive",
               "uia": uia, "pywinauto": pywinauto, "screen": list(self._screen_size())}
        if pywinauto_error:
            out["pywinauto_error"] = pywinauto_error      # POURQUOI pywinauto est false
        return out

    # ── perception ───────────────────────────────────────────────────────────
    def screenshot(self, fmt=None, quality=None) -> Tuple[bytes, int, int]:
        if self._screenshot_impl == "mss":
            import mss
            from PIL import Image
            with mss.mss() as sct:
                # Écran SÉLECTIONNÉ (primaire par défaut) ; capture, arbre (rects
                # translatés par l'origine) et clics (coords + origine) partagent
                # CE repère → overlay aligné + clics justes sur n'importe quel écran.
                idx = self.monitor_index if 0 <= self.monitor_index < len(sct.monitors) \
                    else (1 if len(sct.monitors) > 1 else 0)
                mon = sct.monitors[idx]
                shot = sct.grab(mon)
                img = Image.frombytes("RGB", shot.size, shot.rgb)
                return encode_screenshot(img, fmt, quality), int(shot.width), int(shot.height)
        if self._screenshot_impl == "pil":
            from PIL import ImageGrab
            region = self._monitor_region()
            if region:
                bbox = (int(region["left"]), int(region["top"]),
                        int(region["left"]) + int(region["width"]),
                        int(region["top"]) + int(region["height"]))
                img = ImageGrab.grab(bbox=bbox, all_screens=True)
            else:
                img = ImageGrab.grab()
            return encode_screenshot(img, fmt, quality), int(img.width), int(img.height)
        raise NotSupported("no screenshot backend (pip install mss Pillow)")

    def cursor_pos(self):
        """Position ACTUELLE du curseur (GetCursorPos), en coords de l'écran CAPTURÉ
        (origine soustraite → MÊME repère que l'arbre et les clics → directement
        comparable aux ``center`` des éléments). None si indisponible."""
        try:
            import ctypes
            from ctypes import wintypes
            pt = wintypes.POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            ox, oy = self.monitor_origin()
            return [int(pt.x) - int(ox), int(pt.y) - int(oy)]
        except Exception:
            return None

    def _screen_size(self) -> Tuple[int, int]:
        try:
            import ctypes
            u = ctypes.windll.user32
            return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))
        except Exception:
            try:
                return tuple(int(v) for v in self._pyautogui.size())  # type: ignore
            except Exception:
                return 0, 0

    def ui_tree(self, max_nodes: int = 300, scope: str = "focus", fanout: int = 80) -> Tuple[List[Dict[str, Any]], int, int]:
        """Arbre d'accessibilité, selon ``scope`` : ``focus`` (DÉFAUT) = la SEULE
        fenêtre au PREMIER PLAN (le moins bruité, enfants visibles clippés à la
        fenêtre) ; ``monitor`` = toutes les fenêtres de l'écran capturé ; ``desktop``
        = toutes les fenêtres, tous écrans. Couches dégradantes, ne rend JAMAIS vide
        si des fenêtres existent : A) comtypes IUIAutomation bas niveau → B) pywinauto
        par-fenêtre (éprouvé) → C) Win32 EnumChildWindows (sans a11y). Rects en px
        écran absolus, translatés par l'origine de l'écran capturé."""
        scope = (scope or "focus").strip().lower()
        if scope not in ("focus", "monitor", "desktop"):
            scope = "focus"
        region = self._monitor_region()
        sw, sh = self._screen_size()
        nodes: List[Dict[str, Any]] = []

        # COUCHE A — comtypes IUIAutomation. focus → fenêtre au premier plan seule
        # (défaut) ; monitor → écran capturé ; desktop → tous écrans (region=None
        # → _center_on_region fail-open).
        fanout = max(8, int(fanout or 80))
        try:
            if scope == "focus":
                nodes = self._uia_tree_for_focus(region, max_nodes, fanout)
            elif scope == "desktop":
                nodes = self._uia_tree_for_monitor(None, max_nodes, fanout)
            else:
                nodes = self._uia_tree_for_monitor(region, max_nodes, fanout)
        except Exception:
            nodes = []
        # COUCHE B — repli pywinauto par-fenêtre (code éprouvé) si A maigre.
        if len(nodes) < 2:
            try:
                nodes = self._pywinauto_tree_for_monitor(region, max_nodes)
            except Exception:
                pass
        # COUCHE C — repli Win32 pur (ctypes), aucune dépendance a11y, dernier recours.
        if len(nodes) < 2:
            try:
                nodes = self._win32_tree_for_monitor(region, max_nodes)
            except Exception:
                pass

        # Translation par l'origine de l'écran capturé → l'arbre s'aligne sur la
        # capture (no-op si écran primaire à l'origine (0,0)).
        ox = int(region["left"]) if region else 0
        oy = int(region["top"]) if region else 0
        if ox or oy:
            for n in nodes:
                r = n.get("rect")
                if isinstance(r, list) and len(r) >= 2:
                    r[0] -= ox
                    r[1] -= oy
        rw = int(region["width"]) if region else sw
        rh = int(region["height"]) if region else sh
        return nodes[:max_nodes], rw, rh

    def _uia_tree_for_focus(self, region, max_nodes, fanout=80):
        """COUCHE A (scope=focus) — UNIQUEMENT le sous-arbre de la fenêtre au PREMIER
        PLAN (GetForegroundWindow → ElementFromHandle), enfants clippés au rect de la
        fenêtre (anti rects périmés). ``region`` ignoré (le 1er plan prime). Si pas de
        1er plan OU 1er plan = SHELL (bureau/barre des tâches — le cas quand aucune
        appli n'a le focus : idle/headless, ou activation bloquée), on retombe sur
        MONITOR : sinon focus-scope renverrait les contrôles de la barre des tâches."""
        import ctypes
        auto = _automation()
        if auto is None:
            return []
        hwnd = _foreground_hwnd()
        if not hwnd or _is_shell_window(hwnd):
            return self._uia_tree_for_monitor(region, max_nodes, fanout)
        try:
            win = auto.ElementFromHandle(ctypes.c_void_p(hwnd))
        except Exception:
            try:
                win = auto.ElementFromHandle(hwnd)
            except Exception:
                return []
        if win is None:
            return []
        nodes: List[Dict[str, Any]] = []
        cache = _UIA_CACHE
        clip = _uia_rect(win)   # rect écran de la fenêtre → borne les enfants émis
        try:
            if cache is not None:
                # UN appel COM aspire toute la fenêtre ; le walk lit ensuite EN PROCESS
                # (cf. _uia_tree_for_monitor). Repli live pour CETTE fenêtre si refus.
                try:
                    cwin = win.BuildUpdatedCache(cache)
                    wn = _node_from_props(_extract_props(cwin), 0)
                    if wn and keep_node(wn):
                        nodes.append(wn)
                    _walk_cached(cwin, nodes, 1, max_nodes, fanout=fanout, clip=clip)
                except Exception:
                    wn = _uia_node(win, 0)
                    if wn and keep_node(wn):
                        nodes.append(wn)
                    _uia_walk(auto.ControlViewWalker, win, nodes, 1, max_nodes, fanout=fanout, clip=clip)
            else:
                wn = _uia_node(win, 0)
                if wn and keep_node(wn):
                    nodes.append(wn)
                _uia_walk(auto.ControlViewWalker, win, nodes, 1, max_nodes, fanout=fanout, clip=clip)
        except Exception:
            pass
        return nodes

    def _uia_tree_for_monitor(self, region, max_nodes, fanout=80):
        """COUCHE A — comtypes IUIAutomation : fenêtres top-level dont le CENTRE est
        sur l'écran capturé (indépendant du focus → corrige le multi-écran), DFS
        ControlViewWalker (les vrais champs graphiques, sans bruit de la vue Raw)."""
        auto = _automation()
        if auto is None:
            return []
        cache = _UIA_CACHE
        nodes: List[Dict[str, Any]] = []
        walker = auto.ControlViewWalker
        root = auto.GetRootElement()
        win = walker.GetFirstChildElement(root)
        # Clip des ENFANTS à la région capturée (parité avec le scope focus qui clippe
        # à la fenêtre) : les fenêtres top-level sont déjà filtrées par centre-sur-
        # région, mais leurs enfants pouvaient déborder (multi-écran, popups hors
        # cadre). ``region`` None (scope desktop) → clip None (no-op).
        _clip = ((int(region["left"]), int(region["top"]),
                  int(region["width"]), int(region["height"])) if region else None)
        guard = 0
        while win is not None and len(nodes) < max_nodes and guard < 200:
            guard += 1
            try:
                rect = _uia_rect(win)
                offscreen = False
                try:
                    offscreen = bool(win.CurrentIsOffscreen)
                except Exception:
                    pass
                if rect and not offscreen and _center_on_region(rect, region):
                    if cache is not None:
                        # UN appel COM aspire toute la fenêtre (structure + props +
                        # valeurs de pattern) → le walk lit ensuite EN PROCESS. Si
                        # une fenêtre récalcitrante refuse, repli live pour ELLE seule.
                        try:
                            cwin = win.BuildUpdatedCache(cache)
                            wn = _node_from_props(_extract_props(cwin), 0)
                            if wn and keep_node(wn):
                                nodes.append(wn)
                            _walk_cached(cwin, nodes, 1, max_nodes, fanout=fanout, clip=_clip)
                        except Exception:
                            wn = _uia_node(win, 0)
                            if wn and keep_node(wn):
                                nodes.append(wn)
                            _uia_walk(walker, win, nodes, 1, max_nodes, fanout=fanout, clip=_clip)
                    else:
                        wn = _uia_node(win, 0)
                        if wn and keep_node(wn):
                            nodes.append(wn)
                        _uia_walk(walker, win, nodes, 1, max_nodes, fanout=fanout, clip=_clip)
            except Exception:
                pass
            try:
                win = walker.GetNextSiblingElement(win)
            except Exception:
                break
        return nodes

    def _pywinauto_tree_for_monitor(self, region, max_nodes):
        """COUCHE B — repli ÉPROUVÉ pywinauto : fenêtres top-level visibles sur l'écran
        capturé (active de cet écran d'abord), DFS via _node_from_ctrl."""
        Desktop = _pywinauto_desktop()
        import ctypes
        from ctypes import wintypes
        try:
            u = ctypes.windll.user32
            u.GetForegroundWindow.restype = wintypes.HWND   # c_void_p → handle NON tronqué (64-bit)
            h = u.GetForegroundWindow()
            fg = int(h) if h else 0
        except Exception:
            fg = 0
        wins = []
        try:
            for w in Desktop(backend="uia").windows(visible_only=True, enabled_only=False):
                try:
                    r = w.rectangle()
                    if _center_on_region((r.left, r.top, r.width(), r.height()), region):
                        wins.append(w)
                except Exception:
                    continue
        except Exception:
            wins = []

        def _is_fg(w):
            try:
                return int(w.handle) == fg
            except Exception:
                return False
        wins.sort(key=lambda w: 0 if _is_fg(w) else 1)   # active de cet écran en tête

        nodes: List[Dict[str, Any]] = []
        for w in wins:
            if len(nodes) >= max_nodes:
                break
            try:
                wn = self._node_from_ctrl(w, 0)
                if wn and keep_node(wn):
                    nodes.append(wn)
                try:
                    root = w.wrapper_object()
                except Exception:
                    root = w
                stack = []
                for ch in reversed(list(root.children())[:80]):
                    stack.append((ch, 1))
                while stack and len(nodes) < max_nodes:
                    ctrl, depth = stack.pop()
                    node = self._node_from_ctrl(ctrl, depth)
                    if node and keep_node(node):
                        nodes.append(node)
                    if depth < 30:
                        try:
                            for ch in reversed(list(ctrl.children())[:80]):
                                stack.append((ch, depth + 1))
                        except Exception:
                            pass
            except Exception:
                continue
        return nodes

    def _win32_tree_for_monitor(self, region, max_nodes):
        """COUCHE C — repli Win32 PUR (ctypes) sans a11y : EnumWindows filtré écran
        capturé + EnumChildWindows (classe → rôle). Filet ultime, ne régresse jamais.
        argtypes/restype déclarés (sinon troncature des HWND en 64 bits)."""
        import ctypes
        from ctypes import wintypes
        u = ctypes.WinDLL("user32")   # instance DÉDIÉE : pas de mutation argtypes du singleton global
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        u.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]; u.EnumWindows.restype = wintypes.BOOL
        u.EnumChildWindows.argtypes = [wintypes.HWND, WNDENUMPROC, wintypes.LPARAM]; u.EnumChildWindows.restype = wintypes.BOOL
        u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]; u.GetWindowRect.restype = wintypes.BOOL
        u.IsWindowVisible.argtypes = [wintypes.HWND]; u.IsWindowVisible.restype = wintypes.BOOL
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]; u.GetClassNameW.restype = ctypes.c_int
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]; u.GetWindowTextW.restype = ctypes.c_int
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]; u.GetWindowTextLengthW.restype = ctypes.c_int
        nodes: List[Dict[str, Any]] = []

        def _rect(hwnd):
            r = wintypes.RECT()
            if not u.GetWindowRect(hwnd, ctypes.byref(r)):
                return None
            return (int(r.left), int(r.top), int(r.right) - int(r.left), int(r.bottom) - int(r.top))

        def _cls(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, buf, 256)
            return buf.value or ""

        def _text(hwnd):
            n = u.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return ""
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            return buf.value or ""

        @WNDENUMPROC
        def _child_cb(ch, _l):
            try:
                if len(nodes) >= max_nodes:
                    return False
                if u.IsWindowVisible(ch):
                    rect = _rect(ch)
                    if rect and _center_on_region(rect, region):
                        x, y, w, h = rect
                        cn = make_node(_cls(ch) or "", _text(ch), x, y, w, h,
                                       states=["enabled"], depth=1)
                        if keep_node(cn):
                            nodes.append(cn)
            except Exception:
                pass
            return True

        @WNDENUMPROC
        def _top_cb(hwnd, _l):
            try:
                if len(nodes) >= max_nodes:
                    return False
                if not u.IsWindowVisible(hwnd):
                    return True
                rect = _rect(hwnd)
                if not rect or not _center_on_region(rect, region):
                    return True
                if _cls(hwnd) in ("Progman", "WorkerW"):   # bureau (pas de bruit)
                    return True
                x, y, w, h = rect
                wn = make_node("window", _text(hwnd), x, y, w, h, states=["enabled"], depth=0)
                if keep_node(wn):
                    nodes.append(wn)
                u.EnumChildWindows(hwnd, _child_cb, 0)
            except Exception:
                pass
            return True

        try:
            u.EnumWindows(_top_cb, 0)
        except Exception:
            pass
        return nodes

    def _node_from_ctrl(self, ctrl, depth: int):
        """Un contrôle UIA → nœud normalisé (role/name/auto_id/rect/states) ou None."""
        try:
            r = ctrl.rectangle()
            x, y, w, h = r.left, r.top, r.width(), r.height()
        except Exception:
            return None
        try:
            role = ctrl.element_info.control_type or ctrl.friendly_class_name()
        except Exception:
            try:
                role = ctrl.friendly_class_name()
            except Exception:
                role = ""
        try:
            name = ctrl.window_text()
        except Exception:
            name = ""
        states: List[str] = []
        try:
            if ctrl.is_enabled():
                states.append("enabled")
        except Exception:
            pass
        try:
            if ctrl.has_keyboard_focus():
                states.append("focused")
        except Exception:
            pass
        try:
            if ctrl.is_visible() is False:
                states.append("offscreen")
        except Exception:
            pass
        try:
            auto_id = ctrl.element_info.automation_id or ""
        except Exception:
            auto_id = ""
        return make_node(role or "", name or "", x, y, w, h, value=None,
                         states=states, depth=int(depth), auto_id=auto_id)

    # ── action (pyautogui) ───────────────────────────────────────────────────
    def _need(self):
        if self._input_impl != "pyautogui" or self._pyautogui is None:
            raise NotSupported("input not available (pip install pyautogui)")
        return self._pyautogui

    @staticmethod
    def _mods(modifiers: str) -> list:
        """'ctrl+shift' → ['ctrl','shift'] (touches valides pyautogui)."""
        ok = {"ctrl", "shift", "alt", "win"}
        return [m for m in (str(modifiers or "").lower().replace(" ", "").split("+")) if m in ok]

    def click(self, x: int, y: int, button: str = "left", clicks: int = 1,
              modifiers: str = "") -> None:
        ox, oy = self.monitor_origin()        # coords écran-relatives → écran réel
        x, y = int(x) + ox, int(y) + oy
        # SendInput ANCRÉ (défaut) : chaque évènement porte la position absolue de la
        # cible (un mouvement de l'utilisateur entre deux ne déplace pas le clic).
        # Séquence : mods↓ + déplacement → pause de SURVOL → [down, up] par clic, avec
        # un court écart (bien sous le délai de double-clic) → mods↑. Tout d'un bloc à
        # délai nul, certaines interfaces (menus Qt, XAML/WPF, Chromium) n'avaient pas
        # encore traité le survol quand l'appui arrivait : le clic était ignoré.
        if self._use_sendinput:
            desc = _mouse_click_descriptors(x, y, button, clicks, _virtual_screen())
            if desc:
                kd = [{"kind": "key", "vk": v, "scan": 0, "flags": 0}
                      for v in (_vk_for(m) for m in self._mods(modifiers)) if v is not None]
                ku = [dict(d, flags=KEYEVENTF_KEYUP) for d in reversed(kd)]
                head = kd + desc[:1]
                if _sendinput(head) == len(head):
                    pairs_sent = 0
                    try:
                        time.sleep(_CLICK_HOVER_S)
                        presses = desc[1:]
                        for i in range(0, len(presses), 2):
                            if i:
                                time.sleep(_CLICK_GAP_S)
                            pair = presses[i:i + 2]
                            if _sendinput(pair) != len(pair):
                                break
                            pairs_sent += 1
                    finally:
                        if ku:
                            _sendinput(ku)        # jamais de touche restée enfoncée
                    if pairs_sent == max(1, int(clicks or 1)):
                        return
                    if pairs_sent:
                        # Clic partiel : rejouer par pyautogui ajouterait des clics.
                        raise PartialInput("clic partiel (%d/%d) : SendInput refusé en cours de geste"
                                           % (pairs_sent, max(1, int(clicks or 1))))
        pg = self._need()
        mods = self._mods(modifiers)
        for k in mods:
            pg.keyDown(k)
        try:
            pg.click(x=x, y=y, button=button, clicks=max(1, int(clicks or 1)))
        finally:
            for k in reversed(mods):
                pg.keyUp(k)

    def type_text(self, text: str) -> None:
        # SendInput Unicode (atomique, layout-INDÉPENDANT, sauts de ligne → Entrée)
        # par défaut ; repli pyautogui si SendInput échoue (renvoie 0).
        if self._use_sendinput and text:
            desc = _text_key_descriptors(text)
            if desc and _sendinput(desc) == len(desc):
                return
        self._need().write(text, interval=0.01)

    def key(self, keys: str) -> None:
        if self._use_sendinput:
            desc = _named_key_descriptors(keys)
            if desc and _sendinput(desc) == len(desc):
                return
        parts = [k.strip().lower() for k in str(keys).replace(" ", "").split("+") if k.strip()]
        if parts:
            self._need().hotkey(*parts)

    def scroll(self, x: Optional[int], y: Optional[int], dy: int) -> None:
        pg = self._need()
        ox, oy = self.monitor_origin()
        # Défaut : centre de l'ÉCRAN CAPTURÉ (la zone carte d'une app maximisée),
        # au lieu de la position courante du curseur (souvent hors cible).
        if x is None or y is None:
            region = self._monitor_region()
            if region:
                x = int(region["width"]) // 2
                y = int(region["height"]) // 2
            else:
                sw, sh = self._screen_size()
                x = sw // 2 if sw else 0
                y = sh // 2 if sh else 0
        x, y = int(x) + ox, int(y) + oy
        pg.moveTo(x, y)
        # PIÈGE Windows : WM_MOUSEWHEEL va à la fenêtre qui a le FOCUS CLAVIER,
        # PAS à celle sous le curseur → un pyautogui.scroll() part vers la
        # fenêtre active (un navigateur…) et la carte ne zoome jamais. On route
        # donc le wheel DIRECTEMENT à la fenêtre sous le point (focus-independ.).
        if not self._wheel_to_window(x, y, int(dy or 0)):
            pg.scroll(int(dy or 0))   # repli si l'envoi direct échoue

    def _wheel_to_window(self, x: int, y: int, clicks: int) -> bool:
        """Envoie WM_MOUSEWHEEL à la fenêtre racine sous (x,y) en coords écran.
        ``clicks`` > 0 = molette vers le haut (zoom in en général)."""
        try:
            import ctypes
            from ctypes import wintypes
            u = ctypes.windll.user32

            class POINT(ctypes.Structure):
                _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

            u.WindowFromPoint.restype = wintypes.HWND
            u.WindowFromPoint.argtypes = [POINT]
            u.GetAncestor.restype = wintypes.HWND
            u.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]
            u.SendMessageTimeoutW.restype = ctypes.c_void_p
            u.SendMessageTimeoutW.argtypes = [wintypes.HWND, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p,
                                              ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p]

            hwnd = u.WindowFromPoint(POINT(x, y))
            if not hwnd:
                return False
            # Le contrôle SOUS le point (liste WinForms/MFC, volet de l'Explorateur) : une
            # fenêtre cadre ne relaie pas WM_MOUSEWHEEL à ses enfants, alors que
            # DefWindowProc de l'enfant le remonte au parent s'il ne le traite pas.
            target = hwnd
            WM_MOUSEWHEEL = 0x020A
            delta = int(clicks) * 120               # un cran = 120
            lparam = ((y & 0xFFFF) << 16) | (x & 0xFFFF)  # coords ÉCRAN
            # plusieurs crans → plusieurs messages (apps qui zooment 1×/cran).
            n = max(1, min(10, abs(int(clicks)) or 1))
            step = (delta // n) if n else delta
            ok = True
            for _ in range(n):
                wp = (step & 0xFFFF) << 16
                # Délai borné (SMTO_ABORTIFHUNG) : une appli figée ne bloque plus le
                # worker UIA unique ; échec réel → repli pyautogui (plus « True » d'office).
                r = u.SendMessageTimeoutW(target, WM_MOUSEWHEEL, ctypes.c_void_p(wp), ctypes.c_void_p(lparam),
                                          0x0002, 1000, None)
                ok = ok and bool(r)
            return ok
        except Exception:
            return False

    def move(self, x: int, y: int) -> None:
        ox, oy = self.monitor_origin()
        self._need().moveTo(int(x) + ox, int(y) + oy)

    def drag(self, x1: int, y1: int, x2: int, y2: int, modifiers: str = "") -> None:
        pg = self._need()
        import time
        # Drag « humain » : press, déplacement EN PLUSIEURS pas avec un délai,
        # release. Un dragTo instantané (duration=0) saute de A à B sans
        # WM_MOUSEMOVE intermédiaire → beaucoup d'apps (pan de carte, DnD) ne
        # le reconnaissent pas comme un vrai glissement. ``modifiers`` maintenus
        # pendant tout le geste (Shift+drag = drag contraint / zoom-box…).
        ox, oy = self.monitor_origin()
        x1, y1, x2, y2 = int(x1) + ox, int(y1) + oy, int(x2) + ox, int(y2) + oy
        mods = self._mods(modifiers)
        pg.moveTo(x1, y1)
        for k in mods:
            pg.keyDown(k)
        pressed = False
        try:
            time.sleep(0.05)
            pg.mouseDown(button="left")
            pressed = True
            time.sleep(0.05)
            steps = 12
            for i in range(1, steps + 1):
                ix = x1 + (x2 - x1) * i // steps
                iy = y1 + (y2 - y1) * i // steps
                pg.moveTo(ix, iy)
                time.sleep(0.02)
            time.sleep(0.05)
        finally:
            if pressed:
                try:
                    pg.mouseUp(button="left")     # jamais de bouton resté enfoncé (erreur en plein geste)
                except Exception:
                    pass
            for k in reversed(mods):
                pg.keyUp(k)

    # ── action SÉMANTIQUE + synchronisation (UI Automation) ───────────────────
    def _foreground_dialog(self):
        import ctypes
        from ctypes import wintypes
        Desktop = _pywinauto_desktop()
        u = ctypes.windll.user32
        u.GetForegroundWindow.restype = wintypes.HWND   # handle NON tronqué (64-bit)
        hwnd = u.GetForegroundWindow()
        return Desktop(backend="uia").window(handle=int(hwnd) if hwnd else 0)

    def _find_ctrl(self, *, auto_id="", name="", control_type="", x=None, y=None):
        """Re-résout un contrôle dans la fenêtre active (par auto_id de préférence)
        AU MOMENT de l'action → robuste aux UI qui bougent. None si introuvable.
        ``x, y`` (écran capturé) : le contrôle doit CONTENIR ce point — sinon c'est un
        homonyme, on laisse la recherche comtypes (toutes fenêtres) trouver le bon."""
        try:
            dlg = self._foreground_dialog()
        except Exception:
            return None
        ct = _role_ct_id(control_type)
        attempts = []
        if auto_id and ct is not None:
            attempts.append({"auto_id": auto_id, "control_type": ct})
        if auto_id:
            attempts.append({"auto_id": auto_id})
        if name and ct is not None:
            attempts.append({"title": name, "control_type": ct})
        if name:
            attempts.append({"title": name})
        ax, ay = self._abs_point(x, y)
        # Le runtime a déjà attendu la cible dans l'arbre : une vérification courte suffit.
        wait_s = 0.5 if (x is not None and y is not None) else 1.5
        for kw in attempts:
            try:
                spec = dlg.child_window(visible_only=False, **kw)   # hors écran : pas 5 s d'attente
                if not spec.exists(timeout=wait_s):
                    continue
                ctrl = spec.wrapper_object()
                if ax is not None and ay is not None:
                    r = ctrl.rectangle()
                    if not (r.left <= ax < r.right and r.top <= ay < r.bottom):
                        continue
                return ctrl
            except Exception:
                continue
        return None

    def invoke(self, *, auto_id="", name="", control_type="", x=None, y=None,
               button="left", clicks=1) -> Dict[str, Any]:
        """Clic SÉMANTIQUE : délègue à element_action (Toggle/Select sinon Invoke
        sinon clic UIA sinon coords). Conserve le contrat /invoke historique."""
        act = "double_click" if int(clicks or 1) >= 2 else "click"
        return self.element_action(action=act, auto_id=auto_id, name=name,
                                   control_type=control_type, x=x, y=y,
                                   button=button, clicks=clicks)

    def element_action(self, *, action="click", auto_id="", name="", control_type="",
                       text="", x=None, y=None, button="left", clicks=1) -> Dict[str, Any]:
        """Re-résout le contrôle dans la fenêtre active (par auto_id) PUIS l'actionne
        via le BON control pattern UIA (cf. _pattern_action). Repli, pour un clic :
        InvokePattern → clic UIA → coordonnées. Pour une op explicite non supportée
        par le contrôle : repli coordonnées si x,y fournis."""
        action = (action or "click").strip().lower()
        button = str(button or "left").strip().lower() or "left"
        clicks = max(1, int(clicks or 1))
        if action == "double_click":
            clicks = max(clicks, 2)
        clicklike = action in ("click", "invoke", "left_click", "double_click")
        dbl = clicks >= 2
        # Un clic SIMPLE (gauche, une fois) passe par les patterns : Toggle / Select
        # / Invoke font ce que le clic aurait fait, sans souris. Un DOUBLE (ou
        # triple) clic, un clic DROIT ou MILIEU sont des GESTES : jamais un pattern.
        # Avant, un double-clic sur un item de liste devenait un simple Select (le
        # projet ne s'ouvrait pas) et un clic droit sur un bouton devenait Invoke
        # (l'action au lieu du menu contextuel) — « les clics ne marchent pas à
        # 100 % » vu du Studio. Le geste part sur le contrôle RE-RÉSOLU (sa
        # position courante), sinon aux coordonnées de repli.
        gesture = clicklike and (dbl or button != "left")
        # Boucle de RÉSILIENCE : sur COMError transitoire (élément périmé / RPC
        # occupé), on RE-RÉSOUT le contrôle et on rejoue la MÊME action sémantique
        # (≠ retomber en clic-coords au mauvais endroit). Borné (cumul < ~600 ms,
        # thread loop unique). Une erreur NON transitoire / un pattern absent →
        # on sort de la boucle vers le repli coordonnées (dégradation inchangée).
        for delay in _retry_schedule():
            if delay:
                time.sleep(delay)
            t_act = None                           # départ de l'appel de pattern (échec lent = a agi)
            try:
                ctrl = self._find_ctrl(auto_id=auto_id, name=name, control_type=control_type, x=x, y=y)
                if ctrl is None:
                    break                          # introuvable → repli coords (pas de retry COM)
                if gesture:
                    # Geste RÉEL au centre COURANT du contrôle (rectangle re-lu) par notre
                    # SendInput. Pas ``click_input`` de pywinauto : il normalise le
                    # déplacement sur l'écran PRINCIPAL (un clic gauche sur un 2e écran
                    # partait vers le bord du 1er) et attend que l'utilisateur n'ait rien
                    # touché depuis un délai de double-clic.
                    p = self._ctrl_center(ctrl)
                    if p is None and x is not None and y is not None:
                        p = (int(x), int(y))
                    if p is None:
                        ctrl.click_input(button=button, double=dbl)    # dernier recours
                        return {"method": "click_input", "auto_id": auto_id, "name": name,
                                "button": button, "clicks": clicks}
                    self.click(p[0], p[1], button=button, clicks=clicks)
                    return {"method": "click_input", "auto_id": auto_id, "name": name,
                            "button": button, "clicks": clicks, "x": p[0], "y": p[1]}
                t_act = time.monotonic()
                r = _pattern_action(ctrl, action, text=text, role=control_type)
                if r is not None:
                    r.setdefault("auto_id", auto_id)
                    r.setdefault("name", name)
                    return r
                if time.monotonic() - t_act >= _SLOW_PATTERN_S:     # échec LENT avalé par _pattern_action
                    return _uncertain(action, "pattern a expiré", auto_id=auto_id, name=name)
                t_act = None
                if clicklike:
                    # InvokePattern (fiable, hors écran) puis clic UIA. _try_pattern_call
                    # laisse remonter le transitoire → re-résolution ; pattern absent → suite.
                    # Un élément de MENU se clique pour de vrai (Qt : Invoke n'ouvre pas
                    # le menu, ou le laisse affiché après l'action).
                    menu = str(control_type or "").strip().lower() == "menuitem"
                    t_act = time.monotonic()
                    if not menu and _try_pattern_call(lambda: ctrl.invoke()):
                        return {"method": "invoke", "auto_id": auto_id, "name": name}
                    if time.monotonic() - t_act >= _SLOW_PATTERN_S:
                        return _uncertain("invoke", "Invoke a expiré", auto_id=auto_id, name=name)
                    t_act = None
                    p = self._ctrl_center(ctrl)
                    if p is None:
                        ctrl.click_input(button="left", double=False)
                    else:
                        self.click(p[0], p[1], button="left", clicks=1)
                    return {"method": "click_input", "auto_id": auto_id, "name": name}
                break                              # op explicite sans pattern → repli coords
            except PartialInput:
                raise                              # geste envoyé en partie : ni rejeu ni clic de repli
            except Exception as e:
                if t_act is not None and time.monotonic() - t_act >= _SLOW_PATTERN_S:
                    return _uncertain(action, e, auto_id=auto_id, name=name)
                if _is_transient_com(e):
                    continue                       # élément périmé → re-résout au tour suivant
                break                              # non-transitoire → repli coords (gracieux)
        # pywinauto muet (win32ui/MFC absents, contrôle hors de la fenêtre active) :
        # même action sémantique par comtypes AVANT le clic aveugle.
        if (auto_id or name) and button == "left" and not dbl:
            ax, ay = self._abs_point(x, y)
            r = _uia_element_action(action=action, auto_id=auto_id, name=name, control_type=control_type,
                                    text=text, x=ax, y=ay)
            if r is not None:
                return r
        # repli COORDONNÉES (app sans a11y exploitable / pattern absent / périmé persistant),
        # seulement pour ce qu'un clic accomplit : un ``collapse`` sans pattern devenait un
        # clic au centre, rapporté réussi (le garde-fou du runtime n'était jamais atteint).
        if action not in _COORD_FALLBACK_ACTIONS:
            raise NotSupported("element_action(%s): pattern indisponible sur ce contrôle (pas de repli clic)" % action)
        if x is not None and y is not None:
            self.click(int(x), int(y), button=button, clicks=clicks)
            return {"method": "coords", "x": int(x), "y": int(y)}
        raise NotSupported("element_action(%s): contrôle introuvable et aucune coordonnée de repli" % action)

    def _abs_point(self, x, y):
        """Point de l'écran CAPTURÉ (repère de l'arbre et des clics) → écran ABSOLU
        (repère de ``CurrentBoundingRectangle``). Sans ça, sur un écran secondaire,
        ``_uia_find`` ne départageait plus deux homonymes par le point."""
        if x is None or y is None:
            return x, y
        try:
            ox, oy = self.monitor_origin()
        except Exception:
            ox, oy = 0, 0
        return int(x) + ox, int(y) + oy

    def _ctrl_center(self, ctrl):
        """Centre COURANT d'un contrôle pywinauto, en coordonnées de l'écran capturé
        (celles de ``click``), ou None si le rectangle n'est pas lisible."""
        try:
            r = ctrl.rectangle()
            ox, oy = self.monitor_origin()
            return (int((r.left + r.right) // 2) - ox, int((r.top + r.bottom) // 2) - oy)
        except Exception:
            return None

    def set_value(self, *, auto_id="", name="", control_type="", text="", x=None, y=None) -> Dict[str, Any]:
        ctrl = self._find_ctrl(auto_id=auto_id, name=name, control_type=control_type, x=x, y=y)
        if ctrl is not None:
            for meth in ("set_edit_text", "set_text", "set_value"):
                fn = getattr(ctrl, meth, None)
                if callable(fn):
                    try:
                        fn(text)
                        return {"method": meth}
                    except Exception:
                        continue
            try:
                ctrl.set_focus()
                # pywinauto avale l'échec de SetFocus (simple avertissement) : on VÉRIFIE.
                has = getattr(ctrl, "has_keyboard_focus", None)
                if callable(has) and not has():
                    raise RuntimeError("focus non posé")
            except Exception:
                # Focus non posé : Ctrl+A puis frappe partiraient dans le contrôle qui a
                # le focus (un document ailleurs, remplacé en entier). L'appelant clique.
                raise NotSupported("set_value : focus impossible sur le contrôle (%s)" % (auto_id or name or control_type))
        else:
            ax, ay = self._abs_point(x, y)
            r = _uia_element_action(action="set_value", auto_id=auto_id, name=name, control_type=control_type,
                                    text=text, x=ax, y=ay)
            if r is not None:
                return r
            # Ni pywinauto ni UIA ne l'ont trouvé : taper « quelque part » serait
            # pire que d'échouer — l'appelant (runtime) clique le champ puis tape.
            raise NotSupported("set_value : contrôle introuvable (%s)" % (auto_id or name or control_type))
        # Repli : focus + TOUT sélectionner + frappe. Sans Ctrl+A, la frappe s'ajoutait
        # à l'ancien contenu (« 12 » dans un champ qui valait « 7 » donnait « 712 »).
        self.key("ctrl+a")
        self.type_text(text)
        return {"method": "type"}

    def element_text(self, *, auto_id="", name="", control_type="", x=None, y=None) -> Dict[str, Any]:
        """Texte d'un contrôle par UIA (comtypes) : ValuePattern sinon TextPattern
        (Bloc-notes, RichEdit, zones de code n'exposent QUE TextPattern → la
        valeur de l'arbre est vide alors que le texte est là)."""
        auto = _automation()
        if auto is None or _UIA_MOD is None:
            raise NotSupported("element_text : UIA indisponible")
        ax, ay = self._abs_point(x, y)
        el = _uia_find(auto, _UIA_MOD, auto_id=auto_id, name=name, control_type=control_type, x=ax, y=ay)
        if el is None:
            raise NotSupported("element_text : contrôle introuvable")
        vp = _uia_pattern(_UIA_MOD, el, "value")
        if vp is not None:
            try:
                v = vp.CurrentValue
                if v:
                    return {"text": str(v), "method": "value"}
            except Exception:
                pass
        try:
            raw = el.GetCurrentPattern(10014)              # UIA_TextPatternId
            tp = raw.QueryInterface(_UIA_MOD.IUIAutomationTextPattern) if raw else None
        except Exception:
            tp = None
        if tp is None:
            raise NotSupported("element_text : ni ValuePattern ni TextPattern")
        try:
            return {"text": str(tp.DocumentRange.GetText(-1) or ""), "method": "text"}
        except Exception as e:
            raise NotSupported("element_text : TextPattern KO (%s)" % e)

    def launch(self, target, *, args="", timeout_ms=15000) -> Dict[str, Any]:
        """Lance ``target`` (exe/lnk/URI/protocole) via ShellExecuteW et attend
        qu'une NOUVELLE fenêtre top-level apparaisse (window-diff — robuste aux
        appli UWP comme la Calculatrice : calc.exe est un stub qui active le
        paquet UWP et SORT aussitôt, donc on ne s'appuie JAMAIS sur son PID).

        Ne lève JAMAIS hors de la méthode : tout échec inattendu devient un dict
        ``{found:false, error:…}`` (le serveur le renvoie en 200, le client lit
        ``found``/``error``) — on ne veut pas qu'un hoquet COM/ctypes se traduise
        par un HTTP 500. Seul un échec ShellExecute EXPLICITE (code ≤ 32, ex.
        fichier introuvable) lève NotSupported → 501 avec un motif décodé."""
        import ctypes
        import time
        from ctypes import wintypes

        info: Dict[str, Any] = {"launched": str(target), "found": False}
        try:
            # ShellExecuteW correctement déclaré : la valeur de retour est un
            # HINSTANCE (INT_PTR, 64-bit) — sans restype, ctypes la tronque en
            # c_int 32-bit (fragile par contrat, cf. piège GetForegroundWindow).
            se = ctypes.windll.shell32.ShellExecuteW
            se.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR,
                           wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int]
            se.restype = wintypes.HINSTANCE

            # Desktop UIA construit DANS le try : un échec d'init COM/UIA ne doit
            # pas remonter en 500 — au pire on lance sans fenêtre détectée.
            desk = None
            try:
                Desktop = _pywinauto_desktop()
                desk = Desktop(backend="uia")
            except Exception as e:               # pragma: no cover (COM/UIA Windows)
                info["uia_error"] = str(e)

            def handles():
                if desk is None:
                    return set()
                try:
                    return {w.handle for w in desk.windows()}
                except Exception:
                    return set()
            before = handles()
            before_titles = set()
            if desk is None:
                try:
                    before_titles = {int(w.get("hwnd") or 0) for w in (self.list_windows().get("windows") or [])}
                except Exception:
                    before_titles = set()

            # ShellExecuteW gère .lnk, .exe, associations, URIs/protocoles (ms-settings:…).
            r = se(None, "open", str(target), (args or None), None, 1)
            rc = ctypes.cast(r, ctypes.c_void_p).value or 0   # INT_PTR sûr (pas de troncature)
            if int(rc) <= 32:                    # > 32 = succès ; ≤ 32 = code d'erreur
                raise NotSupported(
                    "ShellExecute a échoué pour %r : %s" % (target, _shellexecute_error(rc)))

            if desk is None:
                # pywinauto muet (MFC absent sur la VM) : on n'abandonne pas l'attente —
                # diff des fenêtres Win32 visibles, puis WaitForInputIdle sur la nouvelle.
                return self._launch_wait_win32(info, before_titles, timeout_ms)

            deadline = time.time() + max(0.0, timeout_ms / 1000.0)
            new_win = None
            ready_ok = False
            while time.time() < deadline:
                diff = handles() - before
                if diff:
                    try:
                        new_win = desk.window(handle=next(iter(diff)))
                        new_win.wait("exists visible ready", timeout=max(0.2, deadline - time.time()))
                        ready_ok = True
                    except Exception:
                        pass
                    break
                time.sleep(0.2)
            if new_win is not None:
                try:
                    self._wait_input_idle(new_win.handle, timeout_ms)   # init terminée (best-effort)
                except Exception:
                    pass
                try:
                    # PREMIER PLAN + focus clavier sur la fenêtre qui vient d'ouvrir.
                    # Sans ça, le focus-stealing-prevention de Windows la laisse
                    # souvent EN ARRIÈRE-PLAN → un type/paste qui SUIT part dans
                    # l'ancien focus (texte perdu). set_focus() de pywinauto
                    # contourne le verrou via AttachThreadInput. Best-effort.
                    new_win.set_focus()
                except Exception:
                    pass
                try:
                    info.update(self._wrapper_info(new_win))
                    info["interaction_state"] = self._interaction_state_wrapper(new_win)
                except Exception:
                    pass
                # « trouvée » seulement si la fenêtre a répondu présente ET prête : une
                # attente expirée (splash, fenêtre fermée aussitôt) n'est pas un succès.
                info["found"] = bool(ready_ok)
                if not ready_ok:
                    info["hint"] = "nouvelle fenêtre vue mais pas prête dans le délai (splash ?) : attendre la fenêtre principale par son titre"
            return info
        except NotSupported:
            raise                                 # échec ShellExecute explicite → 501 décodé
        except Exception as e:                    # tout le reste → résultat structuré, JAMAIS un 500
            info["error"] = str(e)
            return info

    # ── gestion de fenêtres (lister / activer / réduire / agrandir / fermer) ──────
    # Surface LÉGÈRE (~0 token) : le modèle voit/atteint les AUTRES applis sans payer
    # le sous-arbre complet de chacune. Complète le scope=focus de ui_tree.
    def list_windows(self, max_items: int = 60, include_desktop: bool = False) -> Dict[str, Any]:
        """Fenêtres top-level VISIBLES (titre + état + premier plan), SANS parcourir
        leur sous-arbre. Réutilise le scaffold EnumWindows de la couche C (argtypes
        déclarés → HWND 64-bit non tronqués). Ignore le bureau (Progman/WorkerW) et
        les fenêtres sans titre (bruit : tooltips, shells) — sauf ``include_desktop``
        : le bureau (Progman, « Program Manager ») est alors AJOUTÉ en fin de liste,
        marqué ``desktop:true`` — c'est la racine UIA que voit l'enregistreur quand
        on double-clique une icône du bureau, un script doit pouvoir l'activer."""
        import ctypes
        from ctypes import wintypes
        u = ctypes.WinDLL("user32")   # instance dédiée (pas de mutation du singleton)
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        u.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]; u.EnumWindows.restype = wintypes.BOOL
        u.IsWindowVisible.argtypes = [wintypes.HWND]; u.IsWindowVisible.restype = wintypes.BOOL
        u.IsIconic.argtypes = [wintypes.HWND]; u.IsIconic.restype = wintypes.BOOL
        u.IsZoomed.argtypes = [wintypes.HWND]; u.IsZoomed.restype = wintypes.BOOL
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]; u.GetClassNameW.restype = ctypes.c_int
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]; u.GetWindowTextW.restype = ctypes.c_int
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]; u.GetWindowTextLengthW.restype = ctypes.c_int
        u.GetForegroundWindow.restype = wintypes.HWND
        try:
            fg = int(u.GetForegroundWindow() or 0)
        except Exception:
            fg = 0
        wins: List[Dict[str, Any]] = []
        desk: List[Dict[str, Any]] = []
        # Une appli UWP fermée/suspendue laisse une fenêtre « Calculatrice » VISIBLE
        # pour Win32 mais MASQUÉE par DWM (cloaked) : un script la prenait pour la
        # vraie (require/focus), puis ne trouvait aucun bouton. On l'écarte.
        try:
            dwm = ctypes.WinDLL("dwmapi")
            dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
            dwm.DwmGetWindowAttribute.restype = ctypes.c_long
        except Exception:
            dwm = None

        def _cloaked(hwnd) -> bool:
            if dwm is None:
                return False
            try:
                v = wintypes.DWORD(0)
                if dwm.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(v), ctypes.sizeof(v)) == 0:   # DWMWA_CLOAKED
                    return bool(v.value)
            except Exception:
                pass
            return False

        def _cls(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, buf, 256)
            return buf.value or ""

        def _text(hwnd):
            n = u.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return ""
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            return buf.value or ""

        @WNDENUMPROC
        def _cb(hwnd, _l):
            try:
                if len(wins) >= max_items:
                    return False
                if not u.IsWindowVisible(hwnd):
                    return True
                if _cls(hwnd) in ("Progman", "WorkerW"):
                    if include_desktop and _cls(hwnd) == "Progman" and not desk:
                        desk.append({"hwnd": int(hwnd), "title": _text(hwnd) or "Program Manager",
                                     "state": "normal", "is_foreground": int(hwnd) == fg, "desktop": True})
                    return True
                title = _text(hwnd)
                if not title or _cloaked(hwnd):
                    return True
                state = ("minimized" if u.IsIconic(hwnd)
                         else ("maximized" if u.IsZoomed(hwnd) else "normal"))
                wins.append({"hwnd": int(hwnd), "title": title, "state": state,
                             "is_foreground": int(hwnd) == fg})
            except Exception:
                pass
            return True

        try:
            u.EnumWindows(_cb, 0)
        except Exception:
            pass
        return {"windows": wins + desk}

    def window_action(self, *, action="activate", hwnd=0) -> Dict[str, Any]:
        """Agit sur une fenêtre top-level par HWND : activate/focus, minimize,
        maximize, restore, close. set_focus() (pywinauto) contourne le focus-stealing
        de Windows via AttachThreadInput (cf. launch). Repli Win32 ShowWindow."""
        action = (action or "activate").strip().lower()
        hwnd = int(hwnd or 0)
        if not hwnd:
            raise NotSupported("window_action: hwnd requis")
        try:
            win = _pywinauto_desktop()(backend="uia").window(handle=hwnd)
            if action in ("activate", "focus"):
                win.set_focus()
                # set_focus de pywinauto (UIA) n'est qu'un SetFocus dont l'échec est
                # avalé : sans vérification, « activée » alors qu'une autre fenêtre
                # restait devant et recevait le clic. Contournement Win32 si besoin.
                if not _is_foreground_root(hwnd):
                    forced = _win32_force_foreground(hwnd)
                    return {"action": action, "hwnd": hwnd, "method": "pywinauto+win32", "foregrounded": bool(forced)}
            elif action == "minimize":
                win.minimize()
            elif action == "maximize":
                win.maximize()
            elif action == "restore":
                win.restore()
            elif action == "close":
                win.close()
            else:
                raise NotSupported("window_action: action inconnue %r" % action)
            return {"action": action, "hwnd": hwnd, "method": "pywinauto"}
        except NotSupported:
            raise
        except Exception as e:
            # pywinauto absent/KO → repli Win32. activate/focus depuis un process en
            # ARRIÈRE-PLAN est bloqué par le verrou anti-focus-stealing → contournement
            # AttachThreadInput (_win32_force_foreground). minimize/maximize/restore =
            # ShowWindow simple. close exclu (pas de repli sûr).
            try:
                forced = None
                if action in ("activate", "focus"):
                    forced = _win32_force_foreground(hwnd)   # True si réellement passé au 1er plan
                elif action == "close":
                    # WM_CLOSE = la croix : l'appli garde la main (« enregistrer ? »).
                    import ctypes
                    from ctypes import wintypes
                    u2 = ctypes.WinDLL("user32")
                    u2.PostMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM]
                    u2.PostMessageW.restype = wintypes.BOOL
                    if not u2.PostMessageW(hwnd, 0x0010, 0, 0):
                        raise NotSupported("window_action: close refusé (WM_CLOSE)")
                else:
                    import ctypes
                    from ctypes import wintypes
                    sw = {"minimize": 6, "maximize": 3, "restore": 9}.get(action)
                    if sw is None:
                        raise NotSupported("window_action: %r sans repli Win32" % action)
                    u2 = ctypes.WinDLL("user32")
                    u2.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]; u2.ShowWindow.restype = wintypes.BOOL
                    u2.ShowWindow(hwnd, sw)
                out = {"action": action, "hwnd": hwnd, "method": "win32"}
                if forced is not None:
                    # Honnêteté : ne PAS prétendre au succès si le verrou de focus a gagné.
                    out["foregrounded"] = bool(forced)
                    if not forced:
                        out["note"] = ("activation best-effort NON confirmée (verrou de focus "
                                       "Windows depuis un service en arrière-plan) — installer "
                                       "pywinauto sur le VM pour une activation fiable")
                return out
            except NotSupported:
                raise
            except Exception as e2:
                raise NotSupported("window_action(%s) a échoué: %s / %s" % (action, e, e2))

    def wait_window(self, *, title_re="", auto_id="", class_name="", ready=True,
                    timeout_ms=15000) -> Dict[str, Any]:
        try:
            Desktop = _pywinauto_desktop()
        except Exception:                      # pywinauto muet (win32ui/MFC) : titre par Win32
            if not title_re:
                raise NotSupported("wait_window sans pywinauto : préciser title_re")
            return self._wait_window_win32(title_re, timeout_ms)
        kw = {}
        if title_re:
            kw["title_re"] = title_re
        if auto_id:
            kw["auto_id"] = auto_id
        if class_name:
            kw["class_name"] = class_name
        if not kw:
            raise NotSupported("wait_window : préciser title_re/auto_id/class_name")
        # found_index=0 : deux fenêtres qui correspondent (deux Bloc-notes) levaient
        # ElementAmbiguousError → « absente » immédiat, pendant toute l'attente.
        win = Desktop(backend="uia").window(found_index=0, **kw)
        # ``ready`` = attend la DISPONIBILITÉ (WaitGuiThreadIdle + interaction OK).
        crit = "exists visible enabled ready" if ready else "exists"
        try:
            win.wait(crit, timeout=max(0.1, timeout_ms / 1000.0))
        except Exception:
            if not ready:
                return {"found": False}
            # Présente et visible, mais pas « prête » (fenêtre principale désactivée par
            # une boîte de démarrage, appli encore occupée) : on le DIT au lieu de
            # prétendre qu'elle n'existe pas — l'appelant décide combien attendre encore.
            try:
                if win.exists(timeout=0.1) and win.is_visible():
                    return {"found": True, "ready": False,
                            "interaction_state": self._interaction_state_wrapper(win)}
            except Exception:
                pass
            return {"found": False}
        out = {"found": True, "ready": bool(ready), "interaction_state": self._interaction_state_wrapper(win)}
        try:
            out.update(self._wrapper_info(win))
        except Exception:
            pass
        return out

    def _wait_window_win32(self, title_re: str, timeout_ms: int) -> Dict[str, Any]:
        """Repli sans pywinauto : la fenêtre top-level VISIBLE dont le titre
        matche, sondée via EnumWindows (``list_windows``). Pas de notion « prête »
        (ReadyForUserInteraction) : ``degraded:true`` le dit."""
        try:
            rx = re.compile(title_re, re.I)
        except re.error:
            rx = re.compile(re.escape(title_re), re.I)
        deadline = time.monotonic() + max(0.1, timeout_ms / 1000.0)
        while True:
            for w in (self.list_windows().get("windows") or []):
                if rx.search(str(w.get("title") or "")):
                    return {"found": True, "degraded": True, "hwnd": w.get("hwnd"), "title": w.get("title")}
            if time.monotonic() >= deadline:
                return {"found": False, "degraded": True}
            time.sleep(0.25)

    def wait_element(self, *, auto_id="", name="", control_type="", state="exists",
                     timeout_ms=15000) -> Dict[str, Any]:
        try:
            dlg = self._foreground_dialog()
        except Exception:
            return {"found": False}
        kw = {}
        if auto_id:
            kw["auto_id"] = auto_id
        if name:
            kw["title"] = name
        if control_type:
            kw["control_type"] = control_type
        if not kw:
            raise NotSupported("wait_element : préciser auto_id/name/control_type")
        crit = {"exists": "exists", "visible": "exists visible",
                "enabled": "exists visible enabled",
                "ready": "exists visible enabled ready"}.get(state, "exists")
        try:
            dlg.child_window(**kw).wait(crit, timeout=max(0.1, timeout_ms / 1000.0))
            return {"found": True}
        except Exception:
            return {"found": False}

    def _launch_wait_win32(self, info, before, timeout_ms) -> Dict[str, Any]:
        """Attente d'une NOUVELLE fenêtre visible sans pywinauto (EnumWindows)."""
        deadline = time.monotonic() + max(0.0, timeout_ms / 1000.0)
        while time.monotonic() < deadline:
            try:
                wins = self.list_windows().get("windows") or []
            except Exception:
                wins = []
            new = [w for w in wins if int(w.get("hwnd") or 0) not in before]
            if new:
                w = new[0]
                try:
                    self._wait_input_idle(int(w.get("hwnd") or 0), max(0, int((deadline - time.monotonic()) * 1000)))
                except Exception:
                    pass
                try:
                    _win32_force_foreground(int(w.get("hwnd") or 0))
                except Exception:
                    pass
                info.update({"found": True, "degraded": True, "hwnd": w.get("hwnd"), "title": w.get("title")})
                return info
            time.sleep(0.25)
        info["hint"] = "lancé, aucune nouvelle fenêtre visible dans le délai (pywinauto indisponible)"
        return info

    def _wait_input_idle(self, hwnd, timeout_ms) -> None:
        """WaitForInputIdle sur le PROCESS de la fenêtre : bloque jusqu'à ce que
        l'app ait fini son initialisation et attende des entrées."""
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(wintypes.HWND(int(hwnd)), ctypes.byref(pid))
        if not pid.value:
            return
        PROCESS_QUERY_INFORMATION = 0x0400
        SYNCHRONIZE = 0x00100000
        h = k.OpenProcess(PROCESS_QUERY_INFORMATION | SYNCHRONIZE, False, pid.value)
        if h:
            try:
                # WaitForInputIdle vit dans USER32 (pas kernel32) : l'appel levait
                # AttributeError, avalé — l'attente d'initialisation n'avait JAMAIS lieu.
                u.WaitForInputIdle.argtypes = [wintypes.HANDLE, wintypes.DWORD]
                u.WaitForInputIdle.restype = wintypes.DWORD
                u.WaitForInputIdle(h, int(timeout_ms))
            finally:
                k.CloseHandle(h)

    @staticmethod
    def _interaction_state_wrapper(win) -> str:
        try:
            # Propriété du WindowPattern (iface_window), pas de l'élément : lue sur
            # l'élément, elle levait toujours → état « » en permanence.
            st = int(win.iface_window.CurrentWindowInteractionState)
            return {0: "running", 1: "closing", 2: "ready", 3: "modal",
                    4: "not_responding"}.get(st, "")
        except Exception:
            return ""

    @staticmethod
    def _wrapper_info(win) -> Dict[str, Any]:
        try:
            r = win.rectangle()
            return {"title": win.window_text() or "",
                    "class_name": win.friendly_class_name() or "",
                    "auto_id": (win.element_info.automation_id or ""),
                    "rect": [r.left, r.top, r.width(), r.height()]}
        except Exception:
            return {}

    # ── presse-papiers (ctypes user32/kernel32 — sans dépendance) ─────────────
    def clipboard_get(self) -> str:
        import ctypes
        from ctypes import wintypes
        CF_UNICODETEXT = 13
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        u.OpenClipboard.argtypes = [wintypes.HWND]; u.OpenClipboard.restype = wintypes.BOOL
        u.GetClipboardData.argtypes = [wintypes.UINT]; u.GetClipboardData.restype = wintypes.HANDLE
        k.GlobalLock.argtypes = [wintypes.HGLOBAL]; k.GlobalLock.restype = ctypes.c_void_p
        k.GlobalUnlock.argtypes = [wintypes.HGLOBAL]; k.GlobalUnlock.restype = wintypes.BOOL
        if not _open_clipboard(u):
            raise NotSupported("clipboard busy")
        try:
            h = u.GetClipboardData(CF_UNICODETEXT)
            if not h:
                return ""
            p = k.GlobalLock(h)
            if not p:
                return ""
            try:
                return ctypes.c_wchar_p(p).value or ""
            finally:
                k.GlobalUnlock(h)
        finally:
            u.CloseClipboard()

    def clipboard_set(self, text: str) -> None:
        import ctypes
        from ctypes import wintypes
        CF_UNICODETEXT = 13
        GMEM_MOVEABLE = 0x0002
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        # ⚠ SANS argtypes, un HANDLE 64-bit est tronqué à un int C 32-bit :
        # SetClipboardData(CF_UNICODETEXT, h) levait « int too long to convert »
        # (vu sur la VM : paste et copy échouaient). On déclare TOUT.
        k.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]; k.GlobalAlloc.restype = wintypes.HGLOBAL
        k.GlobalLock.argtypes = [wintypes.HGLOBAL]; k.GlobalLock.restype = ctypes.c_void_p
        k.GlobalUnlock.argtypes = [wintypes.HGLOBAL]; k.GlobalUnlock.restype = wintypes.BOOL
        k.GlobalFree.argtypes = [wintypes.HGLOBAL]; k.GlobalFree.restype = wintypes.HGLOBAL
        u.OpenClipboard.argtypes = [wintypes.HWND]; u.OpenClipboard.restype = wintypes.BOOL
        u.EmptyClipboard.restype = wintypes.BOOL
        u.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]; u.SetClipboardData.restype = wintypes.HANDLE
        s = str(text or "")
        # Taille en unités UTF-16 (un emoji = 2) + NUL : len(s) comptait les points de code.
        nbytes = len(s.encode("utf-16-le")) + 2
        h = k.GlobalAlloc(GMEM_MOVEABLE, nbytes)
        if not h:
            raise NotSupported("clipboard alloc failed")
        p = k.GlobalLock(h)
        data = s.encode("utf-16-le") + b"\x00\x00"
        ctypes.memmove(p, data, len(data))
        k.GlobalUnlock(h)
        if not _open_clipboard(u):
            k.GlobalFree(h)
            raise NotSupported("clipboard busy")
        try:
            u.EmptyClipboard()
            if not u.SetClipboardData(CF_UNICODETEXT, h):
                k.GlobalFree(h)   # propriété non transférée → libérer
                raise NotSupported("clipboard set failed")
        finally:
            u.CloseClipboard()

    # ── exécution de commande ────────────────────────────────────────────────
    def run_command(self, *, command="", shell="", cwd="", timeout_ms=120000,
                    max_output=20000) -> Dict[str, Any]:
        if shell_disabled():
            raise NotSupported("shell execution disabled on this agent (DESKTOP_DISABLE_SHELL)")
        import base64
        import shutil
        import subprocess
        cmd = str(command or "")
        if not cmd.strip():
            raise NotSupported("run_command needs a non-empty command")
        sh = (shell or "powershell").strip().lower()
        if sh == "pwsh":
            exe = "pwsh.exe"
        elif sh in ("powershell", "ps", ""):
            # PowerShell par défaut ; préférer pwsh (Core, meilleurs défauts UTF-8) s'il existe.
            exe = "pwsh.exe" if shutil.which("pwsh") else "powershell.exe"
        elif sh == "cmd":
            exe = None
        else:
            raise NotSupported("unknown shell %r (use powershell|pwsh|cmd)" % shell)

        if exe is None:
            argv = ["cmd.exe", "/d", "/s", "/c", cmd]
        else:
            # -EncodedCommand (base64 UTF-16LE) → aucune fragilité de quoting shell.
            # Prologue [Console]::OutputEncoding=UTF8 → tue le mojibake cp850/UTF-16
            # de PowerShell 5.1 ; on décode ensuite en utf-8 (errors='replace').
            script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + cmd
            enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
            argv = [exe, "-NoProfile", "-NonInteractive", "-EncodedCommand", enc]

        to_s = max(1.0, min(600.0, (int(timeout_ms) or 120000) / 1000.0))
        mx = max(0, int(max_output))
        t0 = time.time()
        try:
            # CREATE_NO_WINDOW : l'agent autostart tourne sous pythonw — chaque powershell /
            # cmd ouvrait une console VISIBLE qui pouvait prendre le premier plan en pleine
            # automatisation.
            p = subprocess.Popen(argv, cwd=(cwd or None), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except FileNotFoundError as e:
            raise NotSupported("shell not found (%s): %s" % (exe or "cmd.exe", e))
        try:
            out, errb = p.communicate(timeout=to_s)
        except subprocess.TimeoutExpired:
            # ``subprocess.run`` tuait le seul shell puis attendait SANS délai la fin des
            # tuyaux, gardés ouverts par un petit-enfant (``ping -n 1000``) : l'appel
            # dépassait son délai de loin. L'ARBRE est tué, la lecture est bornée.
            kill_process_tree(p.pid)
            try:
                out, errb = p.communicate(timeout=5)
            except Exception:
                out, errb = b"", b""
            so, tr1 = tail_truncate(_decode_console(out), mx)
            se, tr2 = tail_truncate(_decode_console(errb), mx)
            return {"returncode": 124, "timed_out": True, "stdout": so, "stderr": se,
                    "truncated": bool(tr1 or tr2), "duration_ms": int((time.time() - t0) * 1000),
                    "shell": sh}
        so, tr1 = tail_truncate(_decode_console(out), mx)
        se, tr2 = tail_truncate(_decode_console(errb), mx)
        return {"returncode": int(p.returncode), "stdout": so, "stderr": se,
                "truncated": bool(tr1 or tr2), "duration_ms": int((time.time() - t0) * 1000),
                "shell": sh}
