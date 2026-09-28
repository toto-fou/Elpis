# SPDX-License-Identifier: MIT
"""Abstract control-agent backend.

A backend is the OS-specific implementation of "see + act" on the local
machine. Methods raise :class:`NotSupported` when the running session can't do
the operation (e.g. synthetic input blocked under Wayland) — the HTTP layer
turns that into ``501`` so the calling chatbot degrades gracefully.

Uniform element schema returned by :meth:`ui_tree` (one node):
    {"role": str, "name": str, "rect": [x, y, w, h],  # screen pixels
     "value": str|None, "states": [str, ...], "depth": int}
``rect`` is x, y, width, height in NATIVE screen pixels — the backend normalizes
``ui_tree``; the detection endpoint normalizes ``[x1,y1,x2,y2]`` separately.
"""
from __future__ import annotations

import io
from typing import Any, Dict, List, Optional, Tuple


class NotSupported(Exception):
    """The op is unavailable on this session/platform (HTTP 501)."""


class PartialInput(NotSupported):
    """Un geste a été ENVOYÉ EN PARTIE (SendInput refusé en cours de double-clic,
    de frappe) : l'état de l'appli est incertain. Jamais rejoué ni converti en clic
    de repli — un double-clic rejoué devenait un triple clic (fichier ouvert deux fois)."""


def shell_disabled() -> bool:
    """True when the operator has hard-disabled command execution on THIS agent
    (env ``DESKTOP_DISABLE_SHELL``). desktop_shell is on by default; this is the
    VM-side kill-switch — it stops execution even if the tool is still offered."""
    import os
    return (os.environ.get("DESKTOP_DISABLE_SHELL", "") or "").strip().lower() in ("1", "true", "yes", "on")


def png_size(png: bytes) -> Tuple[int, int]:
    try:
        from PIL import Image
        with Image.open(io.BytesIO(png)) as im:
            return int(im.width), int(im.height)
    except Exception:
        return 0, 0


def tail_truncate(s: str, max_chars: int) -> Tuple[str, bool]:
    """Keep the TAIL of an oversized string — for a command's output the END
    (exit status, last error, build/test summary) is the decisive part. Mirrors
    execute_shell's contract (llm_core/tools/_exec_bridge._format_result), so
    desktop_shell and execute_shell truncate identically. Returns (text, truncated)."""
    if max_chars > 0 and len(s) > max_chars:
        cut = len(s) - max_chars
        return (f"...[TRUNCATED — {cut} chars omitted, showing the tail]\n" + s[-max_chars:], True)
    return (s, False)


def encode_screenshot(img, fmt=None, quality=None) -> bytes:
    """Encode a PIL image for the wire. Default PNG (lossless → AUCUN changement de
    comportement). ``fmt='jpeg'`` (param OU ``DESKTOP_SCREENSHOT_FORMAT``) → JPEG
    qualité ``quality``/``DESKTOP_SCREENSHOT_QUALITY`` (~85) : coupe ~5-10× les
    octets transférés VM→host. Perte négligeable pour l'affichage, le dHash et la
    détection UI ; pour l'OCR de petit texte, garder PNG. Les PARAMS priment sur
    l'env (l'hôte pilote le format par requête ; ancien agent = env/PNG)."""
    import os
    buf = io.BytesIO()
    if fmt is None:
        fmt = os.environ.get("DESKTOP_SCREENSHOT_FORMAT", "png")
    fmt = (fmt or "png").strip().lower()
    if fmt in ("jpeg", "jpg"):
        if quality is None:
            quality = os.environ.get("DESKTOP_SCREENSHOT_QUALITY", "85")
        try:
            q = int(quality or 85)
        except (TypeError, ValueError):
            q = 85
        try:
            img.convert("RGB").save(buf, "JPEG", quality=max(40, min(95, q)))
            return buf.getvalue()
        except Exception:
            buf = io.BytesIO()   # repli PNG si l'encodage JPEG échoue
    img.save(buf, "PNG")
    return buf.getvalue()


class DesktopBackend:
    name = "base"

    # ── écran(s) capturé(s) (multi-moniteur OPTIONNEL) ───────────────────────
    # ``monitor_index`` = écran capturé/piloté : 1 = PRIMAIRE (défaut, origine
    # (0,0) → aucune translation), 0 = tous (union), N = écran N. La capture, l'arbre
    # (rects translatés par l'origine) et les clics (coords + origine) partagent
    # CE repère → l'overlay s'aligne et les clics tombent juste, quel que soit l'écran.
    monitor_index = 1

    def _mss_monitors(self) -> List[Dict[str, Any]]:
        try:
            import mss
            with mss.mss() as sct:
                return [dict(m) for m in sct.monitors]
        except Exception:
            return []

    def set_monitor(self, index: Any) -> int:
        try:
            self.monitor_index = max(0, int(index))
        except (TypeError, ValueError):
            self.monitor_index = 1
        return int(self.monitor_index)

    def list_monitors(self) -> Dict[str, Any]:
        mons = self._mss_monitors()
        out: List[Dict[str, Any]] = []
        for i, m in enumerate(mons):
            out.append({
                "index": i,
                "left": int(m.get("left", 0)), "top": int(m.get("top", 0)),
                "width": int(m.get("width", 0)), "height": int(m.get("height", 0)),
                "label": ("Tous les écrans" if i == 0
                          else ("Écran %d%s" % (i, " (primaire)" if i == 1 else ""))),
            })
        return {"monitors": out, "selected": int(self.monitor_index)}

    def _monitor_region(self) -> Optional[Dict[str, Any]]:
        """Région mss de l'écran sélectionné (repli : primaire, sinon union)."""
        mons = self._mss_monitors()
        if not mons:
            return None
        idx = self.monitor_index
        if not (0 <= idx < len(mons)):
            idx = 1 if len(mons) > 1 else 0
        return mons[idx]

    def monitor_origin(self) -> Tuple[int, int]:
        """Origine (left, top) de l'écran capturé → translation arbre/clic."""
        r = self._monitor_region()
        return (int(r["left"]), int(r["top"])) if r else (0, 0)

    # ── perception ───────────────────────────────────────────────────────────
    def health(self) -> Dict[str, Any]:
        return {"os": self.name, "backend": self.name,
                "input": "none", "screenshot": "none", "session_type": ""}

    def screenshot(self, fmt=None, quality=None) -> Tuple[bytes, int, int]:
        """Return (image_bytes, width, height). ``fmt``/``quality`` piloted by the
        host per request (default PNG; JPEG cuts bytes ~5-10×)."""
        raise NotSupported("screenshot not implemented")

    def ui_tree(self, max_nodes: int = 300, scope: str = "focus", fanout: int = 80) -> Tuple[List[Dict[str, Any]], int, int]:
        """Return (elements, screen_w, screen_h). Empty list is valid (the
        detection endpoint can still annotate). ``scope`` ∈ focus|monitor|desktop —
        focus (default) = the foreground window only (lean, least noisy)."""
        return [], 0, 0

    def cursor_pos(self):
        """Position actuelle du curseur (x,y) en px écran capturé, ou None. Jointe
        à chaque réponse d'action (le modèle sait toujours où est le pointeur)."""
        return None

    # ── action ───────────────────────────────────────────────────────────────
    # ``modifiers`` (click/drag) = touches maintenues pendant le geste, p.ex.
    # "ctrl" / "ctrl+shift" → sélection multiple, plage, drag contraint.
    def click(self, x: int, y: int, button: str = "left", clicks: int = 1,
              modifiers: str = "") -> None:
        raise NotSupported("click not available on this session")

    def type_text(self, text: str) -> None:
        raise NotSupported("type not available on this session")

    def key(self, keys: str) -> None:
        raise NotSupported("key not available on this session")

    def scroll(self, x: Optional[int], y: Optional[int], dy: int) -> None:
        raise NotSupported("scroll not available on this session")

    def move(self, x: int, y: int) -> None:
        raise NotSupported("move not available on this session")

    def drag(self, x1: int, y1: int, x2: int, y2: int, modifiers: str = "") -> None:
        raise NotSupported("drag not available on this session")

    # ── action SÉMANTIQUE (UI Automation / AT-SPI) ───────────────────────────
    # Plus fiable que le clic en coordonnées : on cible un contrôle par son
    # ``auto_id`` (+ name/control_type pour lever l'ambiguïté) et on l'actionne
    # via son PATTERN (Invoke/Value…). ``x``/``y`` = repli coordonnées si le
    # contrôle est introuvable (app sans a11y exploitable). Renvoient un dict
    # (méthode employée, etc.) — pas seulement ok/raise.
    def invoke(self, *, auto_id: str = "", name: str = "", control_type: str = "",
               x: Optional[int] = None, y: Optional[int] = None,
               button: str = "left", clicks: int = 1) -> Dict[str, Any]:
        raise NotSupported("invoke not available on this session")

    def set_value(self, *, auto_id: str = "", name: str = "", control_type: str = "",
                  text: str = "") -> Dict[str, Any]:
        raise NotSupported("set_value not available on this session")

    def element_action(self, *, action: str = "click", auto_id: str = "", name: str = "",
                       control_type: str = "", text: str = "",
                       x: Optional[int] = None, y: Optional[int] = None,
                       button: str = "left", clicks: int = 1) -> Dict[str, Any]:
        """Action SÉMANTIQUE par CONTROL PATTERN UIA selon ``action`` :
        toggle/check/uncheck (TogglePattern), select (SelectionItemPattern),
        expand/collapse (ExpandCollapsePattern), scroll_into_view (ScrollItemPattern),
        set_value (ValuePattern), click/invoke (Toggle/Select sinon Invoke). Bien
        plus fiable qu'un clic en coordonnées (agit même hors-écran, pas de souris).
        Repli clic ``x,y`` si le contrôle est introuvable / le pattern absent."""
        raise NotSupported("element_action not available on this session")

    # ── synchronisation (temps de chargement) ────────────────────────────────
    # L'OS dit quand c'est prêt — au lieu de deviner avec des timeouts/pixels.
    def launch(self, target: str, *, args: str = "", timeout_ms: int = 15000) -> Dict[str, Any]:
        """Lance un programme/raccourci puis ATTEND son initialisation
        (WaitForInputIdle + nouvelle fenêtre prête). Retourne la fenêtre apparue."""
        raise NotSupported("launch not available on this session")

    def wait_window(self, *, title_re: str = "", auto_id: str = "", class_name: str = "",
                    ready: bool = True, timeout_ms: int = 15000) -> Dict[str, Any]:
        """Attend qu'une fenêtre matche (et soit PRÊTE à l'interaction si
        ``ready``). Retourne ``{found, interaction_state, title, ...}``."""
        raise NotSupported("wait_window not available on this session")

    def wait_element(self, *, auto_id: str = "", name: str = "", control_type: str = "",
                     state: str = "exists", timeout_ms: int = 15000) -> Dict[str, Any]:
        """Attend qu'un contrôle atteigne ``state`` (exists|visible|enabled|ready)."""
        raise NotSupported("wait_element not available on this session")

    # ── gestion de fenêtres (top-level) ──────────────────────────────────────
    # Surface LÉGÈRE : lister/atteindre les AUTRES applis sans payer leur sous-arbre.
    def element_text(self, *, auto_id: str = "", name: str = "", control_type: str = "",
                     x: Optional[int] = None, y: Optional[int] = None) -> Dict[str, Any]:
        """Texte d'un document / champ (TextPattern) : ``{text}`` ou NotSupported."""
        raise NotSupported("element_text not available on this session")

    def list_windows(self, max_items: int = 60, include_desktop: bool = False) -> Dict[str, Any]:
        """Liste légère des fenêtres top-level visibles :
        ``{windows:[{hwnd,title,state,is_foreground}]}`` — ~0 token.
        ``include_desktop`` : le bureau en fin de liste (``desktop:true``)."""
        raise NotSupported("list_windows not available on this session")

    def window_action(self, *, action: str = "activate", hwnd: int = 0) -> Dict[str, Any]:
        """Agit sur une fenêtre par HWND : activate|focus|minimize|maximize|restore|close."""
        raise NotSupported("window_action not available on this session")

    # ── presse-papiers ───────────────────────────────────────────────────────
    def clipboard_get(self) -> str:
        raise NotSupported("clipboard not available on this session")

    def clipboard_set(self, text: str) -> None:
        raise NotSupported("clipboard not available on this session")

    # ── exécution de commande (shell) ────────────────────────────────────────
    # Analogue de execute_shell mais SUR LA CIBLE (PowerShell/pwsh/cmd sous Windows,
    # bash sous Linux). ⚠ Aucune isolation conteneur ici (contrairement au sandbox
    # Docker de execute_shell) → privilège complet sur la VM. Kill-switch opérateur :
    # env ``DESKTOP_DISABLE_SHELL`` sur l'agent → NotSupported (501).
    def run_command(self, *, command: str = "", shell: str = "", cwd: str = "",
                    timeout_ms: int = 120000, max_output: int = 20000) -> Dict[str, Any]:
        """Exécute ``command`` et renvoie ``{returncode, stdout, stderr, truncated,
        duration_ms, shell}``. Sortie tronquée en gardant la QUEUE (contrat
        execute_shell). Timeout → ``{returncode:124, timed_out:True}``."""
        raise NotSupported("run_command not available on this session")
