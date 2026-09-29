# SPDX-License-Identifier: MIT
"""Linux control-agent backend.

  • element tree → AT-SPI (pyatspi/PyGObject) — the pywinauto analog
  • input       → pyautogui on X11, ydotool on Wayland (best-effort)
  • screenshot  → mss (X11) or grim (Wayland) or PIL ImageGrab

Everything is probed lazily; ``/health`` reports which impls are live. Wayland
commonly forbids synthetic input — those paths degrade to ``NotSupported`` with
a clear message rather than silently doing nothing.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from .base import DesktopBackend, NotSupported, encode_screenshot, png_size, shell_disabled, tail_truncate

try:
    from normalize import center_in_region, derive_patterns, keep_node, make_node
except ImportError:  # pragma: no cover — when imported as a package
    from ..normalize import center_in_region, derive_patterns, keep_node, make_node


def _session_type() -> str:
    st = (os.environ.get("XDG_SESSION_TYPE") or "").lower()
    if st:
        return st
    if os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    if os.environ.get("DISPLAY"):
        return "x11"
    return "unknown"


class LinuxBackend(DesktopBackend):
    name = "linux"

    def __init__(self) -> None:
        self.session = _session_type()
        self._pyautogui = None
        self._screenshot_impl = self._probe_screenshot()
        self._input_impl = self._probe_input()

    # ── capability probing ───────────────────────────────────────────────────
    def _probe_screenshot(self) -> str:
        if self.session == "wayland" and shutil.which("grim"):
            return "grim"
        try:
            import mss  # noqa: F401
            return "mss"
        except Exception:
            pass
        if shutil.which("grim"):
            return "grim"
        try:
            from PIL import ImageGrab  # noqa: F401
            return "pil"
        except Exception:
            return "none"

    def _probe_input(self) -> str:
        if self.session != "wayland":
            if self._try_pyautogui():
                return "pyautogui"
        if shutil.which("ydotool"):
            return "ydotool"
        if self._try_pyautogui():   # XWayland fallback
            return "pyautogui"
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
        atspi = False
        try:
            import gi
            gi.require_version("Atspi", "2.0")
            from gi.repository import Atspi  # noqa: F401
            atspi = True
        except Exception:
            atspi = False
        return {"os": "linux", "backend": "linux", "input": self._input_impl,
                "screenshot": self._screenshot_impl, "session_type": self.session,
                "atspi": atspi}

    # ── perception ───────────────────────────────────────────────────────────
    def screenshot(self, fmt=None, quality=None) -> Tuple[bytes, int, int]:
        impl = self._screenshot_impl
        if impl == "mss":
            import mss
            from PIL import Image
            with mss.mss() as sct:
                # Écran SÉLECTIONNÉ (primaire par défaut) ; capture, arbre (rects
                # translatés) et clics (coords + origine) partagent CE repère.
                idx = self.monitor_index if 0 <= self.monitor_index < len(sct.monitors) \
                    else (1 if len(sct.monitors) > 1 else 0)
                mon = sct.monitors[idx]
                shot = sct.grab(mon)
                img = Image.frombytes("RGB", shot.size, shot.rgb)
                return encode_screenshot(img, fmt, quality), int(shot.width), int(shot.height)
        if impl == "grim":
            # grim encode NATIVEMENT le format voulu (-t jpeg -q) → pas de decode/
            # re-encode PIL. PNG par défaut.
            is_jpeg = (fmt or "").strip().lower() in ("jpeg", "jpg")
            argv = ["grim"]
            if is_jpeg:
                try:
                    q = int(quality if quality is not None else 85)
                except (TypeError, ValueError):
                    q = 85
                argv += ["-t", "jpeg", "-q", str(max(40, min(95, q)))]
            argv.append("-")
            out = subprocess.run(argv, capture_output=True)
            if out.returncode != 0 or not out.stdout:
                raise NotSupported("grim failed: " + (out.stderr.decode()[:200] if out.stderr else ""))
            data = out.stdout
            if is_jpeg:
                import io as _io

                from PIL import Image
                with Image.open(_io.BytesIO(data)) as im:   # header seul, pas de re-encode
                    w, h = int(im.width), int(im.height)
            else:
                w, h = png_size(data)
            return data, w, h
        if impl == "pil":
            from PIL import ImageGrab
            region = self._monitor_region()
            if region:
                img = ImageGrab.grab(bbox=(int(region["left"]), int(region["top"]),
                                           int(region["left"]) + int(region["width"]),
                                           int(region["top"]) + int(region["height"])))
            else:
                img = ImageGrab.grab()
            return encode_screenshot(img, fmt, quality), int(img.width), int(img.height)
        raise NotSupported("no screenshot backend (install python3-mss, or grim on Wayland)")

    def cursor_pos(self):
        """Position actuelle du curseur (x,y) en px écran capturé (origine soustraite),
        ou None. pyautogui sur X11 ; best-effort (Wayland refuse souvent)."""
        try:
            if getattr(self, "_pyautogui", None):
                x, y = self._pyautogui.position()
                ox, oy = self.monitor_origin()
                return [int(x) - int(ox), int(y) - int(oy)]
        except Exception:
            pass
        return None

    def ui_tree(self, max_nodes: int = 300, scope: str = "focus", fanout: int = 80) -> Tuple[List[Dict[str, Any]], int, int]:
        scope = (scope or "focus").strip().lower()
        try:
            import gi
            gi.require_version("Atspi", "2.0")
            from gi.repository import Atspi
        except Exception:
            return [], 0, 0
        nodes: List[Dict[str, Any]] = []
        try:
            desktop = Atspi.get_desktop(0)
            stack: List[Tuple[Any, int]] = []
            # scope=focus (défaut) → fenêtre(s) active(s) ; monitor/desktop → bureau entier.
            roots = self._atspi_active_roots(desktop, Atspi) if scope == "focus" else []
            if roots:
                # Arbre SCOPÉ sur la (les) fenêtre(s) ACTIVE(s) → petit, rapide et
                # pertinent (moins de bruit pour la résolution d'ancre au rejeu).
                for win in roots:
                    stack.append((win, 0))
            else:
                for i in range(desktop.get_child_count()):    # repli : bureau entier
                    app = desktop.get_child_at_index(i)
                    if app is not None:
                        stack.append((app, 0))
            # Région capturée (coords ÉCRAN) → on ne garde que les nœuds dont le
            # CENTRE tombe dedans (parité avec le clip Windows) : écarte le débordement
            # multi-écran. ``None`` (scope desktop) → fail-open.
            _region = self._monitor_region()
            count = 0
            while stack and count < max_nodes:
                acc, depth = stack.pop()
                try:
                    node = self._atspi_node(acc, depth, Atspi)
                    if node and keep_node(node) and center_in_region(node.get("rect"), _region):
                        nodes.append(node)
                        count += 1
                except Exception:
                    pass
                try:
                    cc = acc.get_child_count()
                    for j in range(min(cc, 80)):
                        ch = acc.get_child_at_index(j)
                        if ch is not None and depth < 25:
                            stack.append((ch, depth + 1))
                except Exception:
                    pass
        except Exception:
            pass
        # Translation par l'origine de l'écran capturé → l'arbre s'aligne sur la
        # capture (no-op si écran primaire à l'origine (0,0)).
        region = self._monitor_region()
        ox = int(region["left"]) if region else 0
        oy = int(region["top"]) if region else 0
        if ox or oy:
            for n in nodes:
                r = n.get("rect")
                if isinstance(r, list) and len(r) >= 2:
                    r[0] -= ox
                    r[1] -= oy
        rw = int(region["width"]) if region else self._screen_w()
        rh = int(region["height"]) if region else self._screen_h()
        return nodes, rw, rh

    def _atspi_node(self, acc, depth, Atspi):
        try:
            ext = acc.get_extents(Atspi.CoordType.SCREEN)
            x, y, w, h = ext.x, ext.y, ext.width, ext.height
        except Exception:
            return None
        try:
            role = acc.get_role_name()
        except Exception:
            role = ""
        try:
            name = acc.get_name()
        except Exception:
            name = ""
        states: List[str] = []
        _visible = _showing = None
        try:
            ss = acc.get_state_set()
            # États lus pour l'AFFICHAGE et la dérivation des patterns (E3) :
            # checkable/selectable/expandable signalent toggle/select/expand.
            for s in ("ENABLED", "FOCUSABLE", "FOCUSED", "SELECTED", "CHECKED",
                      "EDITABLE", "CHECKABLE", "SELECTABLE", "EXPANDABLE", "EXPANDED"):
                try:
                    if ss.contains(getattr(Atspi.StateType, s)):
                        states.append(s.lower())
                except Exception:
                    pass
            # VISIBILITÉ (parité avec IsOffscreen côté Windows) : AT-SPI expose
            # VISIBLE (non masqué) et SHOWING (réellement rendu à l'écran — pas
            # scrollé hors vue, pas dans un onglet inactif, pas minimisé). On mappe
            # « visible mais NON rendu » → state "offscreen" que ``keep_node`` écarte
            # (un contrôle invisible n'est pas actionnable et gonfle les tokens).
            try:
                _visible = ss.contains(Atspi.StateType.VISIBLE)
            except Exception:
                _visible = None
            try:
                _showing = ss.contains(Atspi.StateType.SHOWING)
            except Exception:
                _showing = None
        except Exception:
            pass
        # CONSERVATEUR (fail-open) : on ne marque offscreen QUE si le toolkit rapporte
        # clairement « visible mais pas showing » (scrollé/onglet inactif/minimisé).
        # Si SHOWING est indisponible (toolkit qui ne le pose pas) → on ne drop rien.
        if _visible and _showing is False:
            states.append("offscreen")
        auto_id = ""
        try:
            auto_id = acc.get_accessible_id() or ""    # AT-SPI ≥ 2.34 (analogue d'AutomationId)
        except Exception:
            auto_id = ""
        # runtime_id synthétique (E3) : chemin d'objet AT-SPI, stable intra-session
        # même si label/position bougent → clé anti index-drift pour el_N. Best-effort
        # (binding sans get_path → vide, comportement inchangé).
        runtime_id = ""
        try:
            p = acc.get_path()
            runtime_id = str(p) if p else ""
        except Exception:
            runtime_id = ""
        patterns = derive_patterns(states, role)       # E3 — parité sémantique Linux
        return make_node(role, name, x, y, w, h, value=None, states=states,
                         depth=depth, auto_id=auto_id, runtime_id=runtime_id,
                         patterns=patterns)

    def _atspi_active_roots(self, desktop, Atspi) -> List[Any]:
        """Fenêtre(s) ACTIVE(s) (état AT-SPI ACTIVE) parmi les apps → racines du
        scope de ``ui_tree``. Liste vide si rien d'actif (→ repli bureau entier)."""
        roots: List[Any] = []
        try:
            for i in range(desktop.get_child_count()):
                app = desktop.get_child_at_index(i)
                if app is None:
                    continue
                try:
                    for j in range(min(app.get_child_count(), 80)):
                        win = app.get_child_at_index(j)
                        if win is None:
                            continue
                        try:
                            if win.get_state_set().contains(Atspi.StateType.ACTIVE):
                                roots.append(win)
                        except Exception:
                            pass
                except Exception:
                    pass
        except Exception:
            pass
        return roots

    def _screen_w(self) -> int:
        try:
            return int(self._pyautogui.size()[0]) if self._pyautogui else 0
        except Exception:
            return 0

    def _screen_h(self) -> int:
        try:
            return int(self._pyautogui.size()[1]) if self._pyautogui else 0
        except Exception:
            return 0

    # ── action ───────────────────────────────────────────────────────────────
    def _yd(self, *args: str) -> None:
        subprocess.run(["ydotool", *args], check=False)

    def _yd_move(self, x: int, y: int) -> None:
        self._yd("mousemove", "--absolute", "-x", str(int(x)), "-y", str(int(y)))

    @staticmethod
    def _mods(modifiers: str) -> list:
        ok = {"ctrl", "shift", "alt", "win"}
        return [m for m in (str(modifiers or "").lower().replace(" ", "").split("+")) if m in ok]

    def click(self, x: int, y: int, button: str = "left", clicks: int = 1,
              modifiers: str = "") -> None:
        clicks = max(1, int(clicks or 1))
        mods = self._mods(modifiers)
        ox, oy = self.monitor_origin()        # coords écran-relatives → écran réel
        x, y = int(x) + ox, int(y) + oy
        if self._input_impl == "pyautogui":
            pg = self._pyautogui
            for k in mods: pg.keyDown(k)
            try:
                pg.click(x=x, y=y, button=button, clicks=clicks)
            finally:
                for k in reversed(mods): pg.keyUp(k)
        elif self._input_impl == "ydotool":
            self._yd_move(x, y)
            for k in mods: self._yd("key", k + ":1")     # keydown
            code = {"left": "0xC0", "right": "0xC1", "middle": "0xC2"}.get(button, "0xC0")
            for _ in range(clicks):
                self._yd("click", code)
            for k in reversed(mods): self._yd("key", k + ":0")  # keyup
        else:
            raise NotSupported("input not available (install pyautogui on X11, or ydotool on Wayland)")

    def type_text(self, text: str) -> None:
        if self._input_impl == "pyautogui":
            self._pyautogui.write(text, interval=0.01)
        elif self._input_impl == "ydotool":
            self._yd("type", text)
        else:
            raise NotSupported("input not available")

    def key(self, keys: str) -> None:
        parts = [k.strip().lower() for k in str(keys).replace(" ", "").split("+") if k.strip()]
        if not parts:
            return
        if self._input_impl == "pyautogui":
            self._pyautogui.hotkey(*parts)
        elif self._input_impl == "ydotool":
            self._yd("key", *parts)   # newer ydotool accepts key names
        else:
            raise NotSupported("input not available")

    def scroll(self, x: Optional[int], y: Optional[int], dy: int) -> None:
        ox, oy = self.monitor_origin()
        if self._input_impl == "pyautogui":
            if x is not None and y is not None:
                self._pyautogui.moveTo(int(x) + ox, int(y) + oy)
            self._pyautogui.scroll(int(dy or 0))
        elif self._input_impl == "ydotool":
            if x is not None and y is not None:
                self._yd_move(int(x) + ox, int(y) + oy)
            self._yd("mousemove", "--wheel", "-y", str(int(dy or 0)))
        else:
            raise NotSupported("input not available")

    def move(self, x: int, y: int) -> None:
        ox, oy = self.monitor_origin()
        if self._input_impl == "pyautogui":
            self._pyautogui.moveTo(int(x) + ox, int(y) + oy)
        elif self._input_impl == "ydotool":
            self._yd_move(int(x) + ox, int(y) + oy)
        else:
            raise NotSupported("input not available")

    def drag(self, x1: int, y1: int, x2: int, y2: int, modifiers: str = "") -> None:
        mods = self._mods(modifiers)
        ox, oy = self.monitor_origin()
        x1, y1, x2, y2 = int(x1) + ox, int(y1) + oy, int(x2) + ox, int(y2) + oy
        if self._input_impl == "pyautogui":
            pg = self._pyautogui
            pg.moveTo(x1, y1)
            for k in mods: pg.keyDown(k)
            try:
                pg.dragTo(x2, y2, duration=0.3, button="left")
            finally:
                for k in reversed(mods): pg.keyUp(k)
        elif self._input_impl == "ydotool":
            self._yd_move(x1, y1)
            for k in mods: self._yd("key", k + ":1")
            self._yd("click", "0x40")   # left down
            self._yd_move(x2, y2)
            self._yd("click", "0x80")   # left up
            for k in reversed(mods): self._yd("key", k + ":0")
        else:
            raise NotSupported("input not available")

    # ── action sémantique + synchronisation (best-effort AT-SPI / coords) ──────
    # AT-SPI n'offre pas un ciblage par auto_id aussi direct qu'UIA → on
    # privilégie les replis fiables (coords / frappe / poll de l'arbre).
    def invoke(self, *, auto_id="", name="", control_type="", x=None, y=None,
               button="left", clicks=1) -> Dict[str, Any]:
        if x is not None and y is not None:
            self.click(int(x), int(y), button=button, clicks=int(clicks or 1))
            return {"method": "coords", "x": int(x), "y": int(y)}
        raise NotSupported("invoke: coords requises sur ce backend (AT-SPI sans ciblage pattern)")

    def set_value(self, *, auto_id="", name="", control_type="", text="") -> Dict[str, Any]:
        self.type_text(text)   # repli : frappe dans le focus courant
        return {"method": "type"}

    def element_action(self, *, action="click", auto_id="", name="", control_type="",
                       text="", x=None, y=None, button="left", clicks=1) -> Dict[str, Any]:
        """AT-SPI n'expose pas de control patterns actionnables ici → repli
        best-effort : set_value → frappe ; le reste (toggle/select/expand/clic) →
        clic en coordonnées si fournies (un clic bascule/sélectionne visuellement)."""
        action = (action or "click").strip().lower()
        if action == "set_value":
            return self.set_value(auto_id=auto_id, name=name,
                                  control_type=control_type, text=text)
        if x is not None and y is not None:
            self.click(int(x), int(y), button=button, clicks=int(clicks or 1))
            return {"method": "coords", "x": int(x), "y": int(y)}
        raise NotSupported("element_action(%s): coords requises (AT-SPI sans pattern)" % action)

    def launch(self, target, *, args="", timeout_ms=15000) -> Dict[str, Any]:
        import shlex
        import time
        before = self._window_names()
        try:
            cmd = [str(target)] + (shlex.split(args) if args else [])
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            raise NotSupported("launch a échoué : %s" % e)
        deadline = time.time() + max(0.0, timeout_ms / 1000.0)
        while time.time() < deadline:
            new = self._window_names() - before
            if new:
                # Faute de WaitForInputIdle : laisser l'app finir de s'afficher
                # (arbre de la fenêtre active stable), borné — best-effort.
                self._settle_active(max_ms=min(3000, int(timeout_ms)))
                return {"launched": str(target), "found": True, "title": sorted(new)[0]}
            time.sleep(0.2)
        return {"launched": str(target), "found": False}

    def wait_window(self, *, title_re="", auto_id="", class_name="", ready=True,
                    timeout_ms=15000) -> Dict[str, Any]:
        import re
        import time
        rx = None
        try:
            rx = re.compile(title_re) if title_re else None
        except re.error:
            rx = None
        deadline = time.time() + max(0.0, timeout_ms / 1000.0)
        while True:
            for n in self._window_nodes():
                nm = n.get("name") or ""
                if (rx and rx.search(nm)) or (not rx and nm):
                    return {"found": True, "title": nm, "interaction_state": ""}
            if time.time() >= deadline:
                return {"found": False}
            time.sleep(0.15)

    def wait_element(self, *, auto_id="", name="", control_type="", state="exists",
                     timeout_ms=15000) -> Dict[str, Any]:
        import time
        deadline = time.time() + max(0.0, timeout_ms / 1000.0)
        want_enabled = state in ("enabled", "ready")
        while True:
            els, _, _ = self.ui_tree(max_nodes=400)
            for e in els:
                hit = (auto_id and e.get("auto_id") == auto_id) or (name and (e.get("name") or "") == name)
                if hit and ((not want_enabled) or ("enabled" in (e.get("states") or []))):
                    return {"found": True}
            if time.time() >= deadline:
                return {"found": False}
            time.sleep(0.15)

    def _all_window_nodes(self) -> List[Dict[str, Any]]:
        """TOUTES les fenêtres top-level du bureau (toutes apps), à plat — pour la
        DÉTECTION de fenêtres (launch / wait_window), indépendamment du scoping de
        ``ui_tree`` (restreint, lui, à la fenêtre active). Peu coûteux : on ne
        descend pas dans l'arbre."""
        try:
            import gi
            gi.require_version("Atspi", "2.0")
            from gi.repository import Atspi
        except Exception:
            return []
        out: List[Dict[str, Any]] = []
        try:
            desktop = Atspi.get_desktop(0)
            for i in range(desktop.get_child_count()):
                app = desktop.get_child_at_index(i)
                if app is None:
                    continue
                try:
                    for j in range(min(app.get_child_count(), 80)):
                        win = app.get_child_at_index(j)
                        if win is None:
                            continue
                        node = self._atspi_node(win, 0, Atspi)
                        if node and node.get("role") in ("window", "dialog", "frame"):
                            out.append(node)
                except Exception:
                    pass
        except Exception:
            pass
        return out

    def _window_nodes(self) -> List[Dict[str, Any]]:
        # Détection de fenêtres = bureau ENTIER (pas le scope actif de ui_tree),
        # sinon launch/wait_window ne « verraient » jamais une nouvelle fenêtre.
        return self._all_window_nodes()

    def _window_names(self) -> set:
        return {(e.get("name") or "") for e in self._window_nodes() if e.get("name")}

    def _settle_active(self, max_ms: int = 3000, quiet_ms: int = 600, poll_ms: int = 200) -> None:
        """Attend que l'arbre de la fenêtre active cesse de grandir (init finie),
        borné. Substitut best-effort de WaitForInputIdle (absent sous AT-SPI)."""
        import time
        deadline = time.time() + max(0.0, max_ms / 1000.0)
        prev = -1
        stable_since = time.time()
        while time.time() < deadline:
            try:
                n = len(self.ui_tree(max_nodes=400)[0])
            except Exception:
                n = prev
            if n != prev:
                prev = n
                stable_since = time.time()
            elif (time.time() - stable_since) * 1000.0 >= quiet_ms:
                return
            time.sleep(poll_ms / 1000.0)

    # ── presse-papiers (pyperclip si présent, sinon xclip/xsel) ──────────────
    def clipboard_get(self) -> str:
        try:
            import pyperclip
            return pyperclip.paste() or ""
        except Exception:
            pass
        import shutil
        import subprocess
        for cmd in (["xclip", "-selection", "clipboard", "-o"], ["xsel", "-b", "-o"]):
            if shutil.which(cmd[0]):
                try:
                    return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
                except Exception:
                    continue
        raise NotSupported("clipboard not available (install pyperclip, or xclip/xsel)")

    def clipboard_set(self, text: str) -> None:
        try:
            import pyperclip
            pyperclip.copy(str(text or "")); return
        except Exception:
            pass
        import shutil
        import subprocess
        for cmd in (["xclip", "-selection", "clipboard"], ["xsel", "-b", "-i"]):
            if shutil.which(cmd[0]):
                try:
                    subprocess.run(cmd, input=str(text or ""), text=True, timeout=5); return
                except Exception:
                    continue
        raise NotSupported("clipboard not available (install pyperclip, or xclip/xsel)")

    # ── exécution de commande ────────────────────────────────────────────────
    def run_command(self, *, command="", shell="", cwd="", timeout_ms=120000,
                    max_output=20000) -> Dict[str, Any]:
        if shell_disabled():
            raise NotSupported("shell execution disabled on this agent (DESKTOP_DISABLE_SHELL)")
        import time
        cmd = str(command or "")
        if not cmd.strip():
            raise NotSupported("run_command needs a non-empty command")
        sh = (shell or "bash").strip().lower()
        # Poste/VM Linux : bash par défaut. PowerShell (pwsh) seulement si demandé
        # ET installé — sur cette plateforme powershell.exe n'existe pas.
        if sh in ("pwsh", "powershell", "ps"):
            if not shutil.which("pwsh"):
                raise NotSupported("PowerShell (pwsh) not installed on this Linux target; use shell='bash'")
            argv = ["pwsh", "-NoProfile", "-NonInteractive", "-Command", cmd]
        elif sh in ("bash", "sh", ""):
            argv = ["bash", "-c", cmd]
        else:
            raise NotSupported("unknown shell %r (use bash|pwsh)" % shell)
        to_s = max(1.0, min(600.0, (int(timeout_ms) or 120000) / 1000.0))
        mx = max(0, int(max_output))
        t0 = time.time()
        try:
            p = subprocess.run(argv, cwd=(cwd or None), capture_output=True, timeout=to_s)
        except FileNotFoundError as e:
            raise NotSupported("shell not found: %s" % e)
        except subprocess.TimeoutExpired as e:
            out = e.stdout if isinstance(e.stdout, (bytes, bytearray)) else b""
            errb = e.stderr if isinstance(e.stderr, (bytes, bytearray)) else b""
            so, tr1 = tail_truncate(out.decode("utf-8", "replace"), mx)
            se, tr2 = tail_truncate(errb.decode("utf-8", "replace"), mx)
            return {"returncode": 124, "timed_out": True, "stdout": so, "stderr": se,
                    "truncated": bool(tr1 or tr2), "duration_ms": int((time.time() - t0) * 1000),
                    "shell": sh}
        so, tr1 = tail_truncate(p.stdout.decode("utf-8", "replace"), mx)
        se, tr2 = tail_truncate(p.stderr.decode("utf-8", "replace"), mx)
        return {"returncode": int(p.returncode), "stdout": so, "stderr": se,
                "truncated": bool(tr1 or tr2), "duration_ms": int((time.time() - t0) * 1000),
                "shell": sh}
