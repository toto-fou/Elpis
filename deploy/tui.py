# SPDX-License-Identifier: MIT
"""Formulaires par pages dans le terminal — bibliothèque standard seule.

Sert l'assistant d'installation (``deploy/wizard.py``), qui tourne AVANT la
création du venv : aucune dépendance. Rendu dans l'écran alternatif du
terminal, lu et écrit sur ``/dev/tty`` (``install.sh`` journalise sa sortie
standard : les écrans de l'assistant n'y passent pas).

Modèle :

* un ``Wizard`` = des ``Page`` (un onglet chacune) et un état ``dict`` ;
* une page = des champs : ``Radio`` (un choix), ``Checks`` (cases),
  ``Toggle`` (une case), ``Text`` (saisie, masquée ou non), ``Note``
  (texte calculé), ``Buttons`` (actions) ;
* chaque champ, chaque option et chaque page peut être masqué ou désactivé
  en fonction de l'état : une réponse d'une page désactive les saisies qui
  n'ont plus de sens ailleurs, et une valeur devenue impossible est remplacée
  par la première possible (``normalize``).

Clavier : ↑ ↓ entre les lignes, Espace coche ou choisit, Entrée valide et
avance, Tab / Maj+Tab (et ← → hors saisie) changent de page, Échap quitte.
"""
from __future__ import annotations

import os
import re
import select
import shutil
import signal
import threading
import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

State = Dict[str, Any]
Pred = Callable[[State], bool]
Reason = Callable[[State], Optional[str]]


def _always(_st: State) -> bool:
    return True


def _never(_st: State) -> Optional[str]:
    return None


class TuiUnavailable(RuntimeError):
    """Pas de terminal utilisable (pas de /dev/tty, TERM=dumb…)."""


# ─────────────────────────────────────────────────────────────────────────────
#  Champs
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Opt:
    value: Any
    label: str
    desc: str = ""
    disabled: Reason = _never          # rend la raison quand l'option est indisponible


@dataclass
class Field:
    key: str
    label: str = ""
    visible: Pred = _always
    disabled: Reason = _never

    def slots(self, st: State) -> List[int]:
        return []

    def error(self, st: State) -> Optional[str]:
        return None

    def normalize(self, st: State) -> None:
        pass


@dataclass
class Radio(Field):
    options: Union[Sequence[Opt], Callable[[State], Sequence[Opt]]] = ()

    def opts(self, st: State) -> List[Opt]:
        return list(self.options(st) if callable(self.options) else self.options)

    def enabled(self, st: State) -> List[int]:
        if self.disabled(st):
            return []
        return [i for i, o in enumerate(self.opts(st)) if not o.disabled(st)]

    def slots(self, st: State) -> List[int]:
        return self.enabled(st)

    def normalize(self, st: State) -> None:
        opts = self.opts(st)
        ok = self.enabled(st)
        if not ok:
            return
        if not any(opts[i].value == st.get(self.key) for i in ok):
            st[self.key] = opts[ok[0]].value


@dataclass
class Checks(Field):
    options: Sequence[Opt] = ()

    def slots(self, st: State) -> List[int]:
        if self.disabled(st):
            return []
        return [i for i, o in enumerate(self.options) if not o.disabled(st)]

    def normalize(self, st: State) -> None:
        cur = set(st.get(self.key) or ())
        allowed = {self.options[i].value for i in self.slots(st)}
        st[self.key] = sorted(v for v in cur if v in allowed)


@dataclass
class Toggle(Field):
    desc: str = ""

    def slots(self, st: State) -> List[int]:
        return [] if self.disabled(st) else [0]

    def normalize(self, st: State) -> None:
        if self.disabled(st):
            st[self.key] = False
        else:
            st[self.key] = bool(st.get(self.key))


@dataclass
class Text(Field):
    secret: bool = False
    placeholder: str = ""
    required: bool = False
    validate: Optional[Callable[[str, State], Optional[str]]] = None
    on_commit: Optional[Callable[[State, "Wizard"], None]] = None
    hint: str = ""

    def slots(self, st: State) -> List[int]:
        return [] if self.disabled(st) else [0]

    def error(self, st: State) -> Optional[str]:
        if self.disabled(st):
            return None
        v = str(st.get(self.key) or "")
        if not v.strip():
            return "réponse requise" if self.required else None
        return self.validate(v, st) if self.validate else None


@dataclass
class Note(Field):
    text: Callable[[State], Optional[str]] = lambda st: None
    style: str = "d"


@dataclass
class Buttons(Field):
    options: Sequence[Opt] = ()

    def slots(self, st: State) -> List[int]:
        return [i for i, o in enumerate(self.options) if not o.disabled(st)]


@dataclass
class Page:
    key: str
    tab: str                       # libellé d'onglet, 1 ou 2 mots
    heading: str
    fields: List[Field] = dc_field(default_factory=list)
    visible: Pred = _always
    summary: Optional[Callable[[State], List[Tuple[str, List[Tuple[str, str]]]]]] = None

    def shown(self, st: State) -> List[Field]:
        return [f for f in self.fields if f.visible(st)]


# ─────────────────────────────────────────────────────────────────────────────
#  Rendu
# ─────────────────────────────────────────────────────────────────────────────

_SGR = {"b": "1", "d": "2", "r": "7", "u": "4", "a": "36", "g": "32", "e": "31", "w": "33"}
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _style(text: str, style: str, color: bool) -> str:
    if not style or not text:
        return text
    codes = [_SGR[c] for c in style if c in _SGR and (color or c in "bdru")]
    return f"\x1b[{';'.join(codes)}m{text}\x1b[0m" if codes else text


def visible_len(s: str) -> int:
    return len(_ANSI_RE.sub("", s))


Seg = Tuple[str, str]


def render_line(segs: Sequence[Seg], width: int, color: bool = True) -> str:
    """Segments (texte, style) → ligne ANSI tronquée à ``width`` colonnes."""
    out, used = [], 0
    for text, style in segs:
        if used >= width:
            break
        room = width - used
        if len(text) > room:
            text = text[: max(0, room - 1)] + "…" if room > 0 else ""
        out.append(_style(text, style, color))
        used += len(text)
    return "".join(out)


class Glyphs:
    def __init__(self, unicode_ok: bool):
        u = unicode_ok
        self.cursor = "❯" if u else ">"
        self.radio_on, self.radio_off = "(•)", "( )"
        self.check_on, self.check_off = "[x]", "[ ]"
        self.done = "✓" if u else "*"
        self.todo = "·" if u else "-"
        self.bad = "✗" if u else "!"
        self.left, self.right = ("←", "→") if u else ("<", ">")
        self.up, self.down = ("↑", "↓") if u else ("^", "v")
        self.bullet = "•" if u else "*"
        self.caret = "▏" if u else "|"
        self.spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏" if u else "|/-\\"


# ─────────────────────────────────────────────────────────────────────────────
#  Clavier
# ─────────────────────────────────────────────────────────────────────────────

_CSI = {"A": "up", "B": "down", "C": "right", "D": "left", "H": "home", "F": "end",
        "Z": "shift-tab", "1~": "home", "7~": "home", "4~": "end", "8~": "end",
        "3~": "delete", "5~": "pgup", "6~": "pgdn", "2~": "insert"}
_CTRL = {b"\r": "enter", b"\n": "enter", b"\t": "tab", b"\x7f": "backspace",
         b"\x08": "backspace", b"\x15": "kill-line", b"\x17": "kill-word",
         b"\x01": "home", b"\x05": "end", b"\x04": "delete", b" ": "space"}


def parse_keys(data: bytes) -> List[str]:
    """Octets lus au clavier → touches. Les caractères imprimables sont rendus
    tels quels (UTF-8 décodé), les autres par leur nom."""
    keys, i = [], 0
    while i < len(data):
        b = data[i:i + 1]
        if b == b"\x1b":
            if i + 1 >= len(data):
                keys.append("esc")
                i += 1
                continue
            nxt = data[i + 1:i + 2]
            if nxt in (b"[", b"O"):
                j = i + 2
                while j < len(data) and not (0x40 <= data[j] <= 0x7E):
                    j += 1
                body = data[i + 2:j + 1].decode("ascii", "replace")
                if body.startswith("200~") or body.startswith("201~"):   # collage encadré
                    i = j + 1
                    continue
                params, final = body[:-1], body[-1:]
                name = _CSI.get(final if final != "~" else params.split(";")[0] + "~")
                if final in "ABCDHF" and ";" in params:                     # modificateurs
                    name = _CSI.get(final)
                keys.append(name or "unknown")
                i = j + 1
                continue
            i += 2                                               # Alt+touche : ignorée
            continue
        if b in _CTRL:
            keys.append(_CTRL[b])
            i += 1
            continue
        c = data[i]
        if c < 0x20:
            i += 1
            continue
        n = 1 if c < 0x80 else 2 if c >> 5 == 0b110 else 3 if c >> 4 == 0b1110 else 4
        keys.append(data[i:i + n].decode("utf-8", "replace"))
        i += n
    return keys


class Terminal:
    """/dev/tty en mode caractère, écran alternatif, curseur masqué."""

    def __init__(self):
        if os.environ.get("TERM", "") in ("", "dumb"):
            raise TuiUnavailable("TERM absent ou « dumb »")
        try:
            self.fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
        except OSError as exc:
            raise TuiUnavailable(f"/dev/tty : {exc}") from exc
        import termios
        self._termios = termios
        try:
            self._saved = termios.tcgetattr(self.fd)
        except termios.error as exc:
            os.close(self.fd)
            raise TuiUnavailable(f"pas un terminal : {exc}") from exc
        self.resized = True
        enc = (os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE") or os.environ.get("LANG") or "")
        self.unicode = "utf" in enc.lower().replace("-", "") or not enc
        self.color = "NO_COLOR" not in os.environ

    def __enter__(self) -> "Terminal":
        t = self._termios
        new = t.tcgetattr(self.fd)
        new[3] &= ~(t.ECHO | t.ICANON)
        new[6][t.VMIN], new[6][t.VTIME] = 1, 0
        t.tcsetattr(self.fd, t.TCSADRAIN, new)
        self._old_winch = signal.signal(signal.SIGWINCH, self._on_winch)
        self.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J")
        return self

    def __exit__(self, *exc) -> None:
        try:
            self.write("\x1b[0m\x1b[?25h\x1b[?1049l")
        finally:
            self._termios.tcsetattr(self.fd, self._termios.TCSADRAIN, self._saved)
            signal.signal(signal.SIGWINCH, self._old_winch)
            os.close(self.fd)

    def _on_winch(self, *_a) -> None:
        self.resized = True

    def size(self) -> Tuple[int, int]:
        try:
            s = os.get_terminal_size(self.fd)
            return s.columns, s.lines
        except OSError:
            s = shutil.get_terminal_size((80, 24))
            return s.columns, s.lines

    def write(self, s: str) -> None:
        data = s.encode("utf-8")
        while data:
            n = os.write(self.fd, data)
            data = data[n:]

    def read(self, timeout: float) -> List[str]:
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r:
            return []
        data = os.read(self.fd, 1024)
        # Échap seule ou début de séquence : on attend la suite un instant.
        while data.endswith(b"\x1b") or re.search(rb"\x1b[\[O][0-9;]*$", data):
            if not select.select([self.fd], [], [], 0.04)[0]:
                break
            data += os.read(self.fd, 1024)
        return parse_keys(data)


# ─────────────────────────────────────────────────────────────────────────────
#  Assistant
# ─────────────────────────────────────────────────────────────────────────────

class Wizard:
    """Pages en onglets ; ``run()`` rend l'état validé, ou None si abandon."""

    def __init__(self, title: str, pages: List[Page], state: State, *,
                 context: str = "", start: Optional[str] = None, banner: str = "",
                 finish_key: str = "_action", finish_values: Sequence[str] = ("ok",),
                 cancel_values: Sequence[str] = ("cancel",)):
        self.title, self.pages, self.st = title, pages, state
        self.context = context
        self.finish_key, self.finish_values, self.cancel_values = finish_key, finish_values, cancel_values
        self.page_i = 0
        if start:
            for i, p in enumerate(pages):
                if p.key == start:
                    self.page_i = i
        self.focus = 0                        # indice dans slots() de la page
        self.cursor: Dict[str, int] = {}      # position du curseur de chaque Text
        self.visited: set = {pages[self.page_i].key}
        self.errors: Dict[str, str] = {}
        self.message = banner
        self.message_style = "w" if banner else ""
        self.confirm_quit = False
        self.pending_finish: Optional[str] = None   # « Installer » pendant une sonde
        self.tasks: Dict[str, threading.Thread] = {}
        self.g = Glyphs(True)
        self.color = True
        self.normalize()

    # ── état ────────────────────────────────────────────────────────────────
    def normalize(self) -> None:
        for _ in range(3):                    # dépendances en chaîne
            for p in self.pages:
                for f in p.fields:
                    if f.visible(self.st):
                        f.normalize(self.st)

    def run_async(self, key: str, fn: Callable[[], None]) -> None:
        """Tâche de fond (sonde réseau…) ; l'écran se redessine pendant."""
        if key in self.tasks and self.tasks[key].is_alive():
            return
        th = threading.Thread(target=fn, daemon=True)
        self.tasks[key] = th
        th.start()

    def busy(self) -> bool:
        return any(t.is_alive() for t in self.tasks.values())

    def pages_shown(self) -> List[int]:
        return [i for i, p in enumerate(self.pages) if p.visible(self.st)]

    @property
    def page(self) -> Page:
        return self.pages[self.page_i]

    def slots(self) -> List[Tuple[Field, int]]:
        out = []
        for f in self.page.shown(self.st):
            out.extend((f, i) for i in f.slots(self.st))
        return out

    def current(self) -> Optional[Tuple[Field, int]]:
        s = self.slots()
        if not s:
            return None
        self.focus = max(0, min(self.focus, len(s) - 1))
        return s[self.focus]

    def page_errors(self, page: Page) -> Dict[str, str]:
        errs = {}
        for f in page.shown(self.st):
            e = f.error(self.st)
            if e:
                errs[f.key] = e
        return errs

    # ── navigation ──────────────────────────────────────────────────────────
    def goto_page(self, i: int, *, check: bool) -> bool:
        if check:
            errs = self.page_errors(self.page)
            if errs:
                self.errors.update(errs)
                self.message, self.message_style = "Corrigez les champs signalés.", "e"
                self.focus_field(next(iter(errs)))
                return False
        self.page_i = i
        self.visited.add(self.pages[i].key)
        self.focus = 0
        return True

    def next_page(self) -> None:
        shown = self.pages_shown()
        pos = shown.index(self.page_i) if self.page_i in shown else 0
        if pos + 1 < len(shown):
            self.goto_page(shown[pos + 1], check=True)

    def prev_page(self) -> None:
        shown = self.pages_shown()
        pos = shown.index(self.page_i) if self.page_i in shown else 0
        if pos > 0:
            self.goto_page(shown[pos - 1], check=False)

    def focus_field(self, key: str) -> None:
        for n, (f, _i) in enumerate(self.slots()):
            if f.key == key:
                self.focus = n
                return

    def advance(self) -> None:
        """Entrée : champ suivant, ou page suivante après le dernier."""
        cur = self.current()
        s = self.slots()
        if cur is None:
            self.next_page()
            return
        f = cur[0]
        for n in range(self.focus + 1, len(s)):
            if s[n][0] is not f:
                self.focus = n
                return
        self.next_page()

    # ── touches ─────────────────────────────────────────────────────────────
    def handle(self, key: str) -> Optional[str]:
        """Rend "finish" ou "cancel" quand l'assistant doit se terminer."""
        self.pending_finish = None
        if self.confirm_quit:
            self.confirm_quit = False
            self.message = ""
            if key in ("o", "O", "y", "Y"):
                return "cancel"
            return None
        if key != "unknown" and self.message_style != "w":
            self.message = ""
        cur = self.current()
        f, idx = cur if cur else (None, 0)
        if isinstance(f, Text):
            if self._text_key(f, key):
                self.after_change()
                return None
        if key == "esc":
            self.confirm_quit = True
            self.message, self.message_style = "Quitter sans rien enregistrer ? o/N", "w"
            return None
        if key == "tab" or (key == "right" and not isinstance(f, Text)):
            self.next_page()
        elif key == "shift-tab" or (key == "left" and not isinstance(f, Text)):
            self.prev_page()
        elif key == "up":
            self.focus = max(0, self.focus - 1)
        elif key == "down":
            self.focus = min(len(self.slots()) - 1, self.focus + 1)
        elif key == "pgup":
            self.focus = max(0, self.focus - 6)
        elif key == "pgdn":
            self.focus = min(len(self.slots()) - 1, self.focus + 6)
        elif key == "home" and not isinstance(f, Text):
            self.focus = 0
        elif key == "end" and not isinstance(f, Text):
            self.focus = len(self.slots()) - 1
        elif f is None:
            if key == "enter":
                self.next_page()
        elif isinstance(f, Radio):
            if key in ("space", "enter"):
                self.st[f.key] = f.opts(self.st)[idx].value
                self.errors.pop(f.key, None)
                self.after_change()
                if key == "enter":
                    self.focus_field(f.key)
                    self._focus_value(f)
                    self.advance()
            elif len(key) == 1 and key.isdigit() and key != "0":
                en = f.enabled(self.st)
                n = int(key) - 1
                if n < len(en):
                    self.st[f.key] = f.opts(self.st)[en[n]].value
                    self.after_change()
                    self.focus_field(f.key)
                    self._focus_value(f)
        elif isinstance(f, Checks):
            if key == "space":
                cur_v = set(self.st.get(f.key) or ())
                v = f.options[idx].value
                cur_v.symmetric_difference_update({v})
                self.st[f.key] = sorted(cur_v)
                self.after_change()
            elif key == "enter":
                self.advance()
        elif isinstance(f, Toggle):
            if key == "space":
                self.st[f.key] = not self.st.get(f.key)
                self.after_change()
            elif key == "enter":
                self.advance()
        elif isinstance(f, Buttons):
            if key in ("enter", "space"):
                val = f.options[idx].value
                if val in self.cancel_values:
                    self.confirm_quit = True
                    self.message, self.message_style = "Quitter sans rien enregistrer ? o/N", "w"
                    return None
                if val in self.finish_values:
                    return self.try_finish(val)
        return None

    def _focus_value(self, f: Radio) -> None:
        """Place le focus sur l'option retenue du groupe (pour ``advance``)."""
        opts = f.opts(self.st)
        for n, (g, i) in enumerate(self.slots()):
            if g is f and opts[i].value == self.st.get(f.key):
                self.focus = n
                return

    def _text_key(self, f: Text, key: str) -> bool:
        """Édition d'un champ texte ; False si la touche n'est pas pour lui."""
        v = str(self.st.get(f.key) or "")
        pos = min(self.cursor.get(f.key, len(v)), len(v))
        if key == "enter":
            err = f.error(self.st)
            if err:
                self.errors[f.key] = err
                self.message, self.message_style = err, "e"
                return True
            self.errors.pop(f.key, None)
            if f.on_commit:
                f.on_commit(self.st, self)
            self.advance()
            return True
        if len(key) == 1 or key == "space":
            ch = " " if key == "space" else key
            v, pos = v[:pos] + ch + v[pos:], pos + 1
        elif key == "backspace":
            if pos:
                v, pos = v[:pos - 1] + v[pos:], pos - 1
        elif key == "delete":
            v = v[:pos] + v[pos + 1:]
        elif key == "left":
            pos = max(0, pos - 1)
        elif key == "right":
            pos = min(len(v), pos + 1)
        elif key == "home":
            pos = 0
        elif key == "end":
            pos = len(v)
        elif key == "kill-line":
            v, pos = "", 0
        elif key == "kill-word":
            head = v[:pos].rstrip()
            cut = head.rfind(" ") + 1
            v, pos = v[:cut] + v[pos:], cut
        else:
            return False
        self.st[f.key] = v
        self.cursor[f.key] = pos
        self.errors.pop(f.key, None)
        return True

    def after_change(self) -> None:
        self.normalize()

    def try_finish(self, val: str) -> Optional[str]:
        for i in self.pages_shown():
            p = self.pages[i]
            errs = self.page_errors(p)
            if errs:
                self.errors.update(errs)
                self.page_i = i
                self.visited.add(p.key)
                self.focus = 0
                self.focus_field(next(iter(errs)))
                self.message = f"Page « {p.tab} » : {next(iter(errs.values()))}"
                self.message_style = "e"
                return None
        if self.busy():
            # Validé dès la fin de la sonde, sans nouvel appui.
            self.pending_finish = val
            self.message, self.message_style = "Sonde en cours : validation dès qu'elle se termine…", "w"
            return None
        self.st[self.finish_key] = val
        return "finish"

    # ── rendu ───────────────────────────────────────────────────────────────
    def frame(self, width: int, height: int) -> List[str]:
        g, color = self.g, self.color
        if width < 50 or height < 14:
            return [render_line([("Agrandissez le terminal (50×14 au moins).", "w")], width, color)]
        head = [render_line([(" " + self.title, "b"),
                             (" " * max(1, width - len(self.title) - len(self.context) - 3), ""),
                             (self.context + " ", "d")], width, color),
                self._tabs(width), ""]
        heading = [render_line([(" " + self.page.heading, "b")], width, color), ""]
        body, focus_line = self._body(width)
        foot = []
        if self.message:
            foot.append(render_line([(" " + self.message, self.message_style or "d")], width, color))
        foot.append(render_line([(" " + self._hints(), "d")], width, color))
        room = height - len(head) - len(heading) - len(foot) - 1
        top = 0
        if len(body) > room:
            top = max(0, min(focus_line - room // 2, len(body) - room))
        view = body[top:top + room]
        if top > 0:
            view[0] = render_line([(f"   {g.up} …", "d")], width, color)
        if top + room < len(body):
            view[-1] = render_line([(f"   {g.down} …", "d")], width, color)
        lines = head + heading + view
        lines += [""] * (height - len(lines) - len(foot))
        return lines + foot

    def _tabs(self, width: int) -> str:
        g, color = self.g, self.color
        segs: List[Seg] = [(f" {g.left} ", "d")]
        shown = self.pages_shown()
        parts = []
        for i in shown:
            p = self.pages[i]
            ok = p.key in self.visited and not self.page_errors(p)
            mark = g.done if ok and i != self.page_i else g.todo
            parts.append((i, f" {mark} {p.tab} "))
        total = sum(len(t) for _, t in parts) + 6
        if total > width:                      # fenêtre autour de la page courante
            cur = [n for n, (i, _) in enumerate(parts) if i == self.page_i][0]
            lo, hi = cur, cur + 1
            while True:
                grown = False
                for cand in (lo - 1, hi):
                    if 0 <= cand < len(parts):
                        a, b = min(lo, cand), max(hi, cand + 1)
                        if sum(len(t) for _, t in parts[a:b]) + 10 <= width:
                            lo, hi, grown = a, b, True
                if not grown:
                    break
            parts = ([(-1, "…")] if lo > 0 else []) + parts[lo:hi] + ([(-1, "…")] if hi < len(parts) else [])
        for i, t in parts:
            segs.append((t, "ra" if i == self.page_i else ("d" if i < 0 else "")))
        segs.append((f" {g.right}", "d"))
        return render_line(segs, width, color)

    def _body(self, width: int) -> Tuple[List[str], int]:
        g, color, st = self.g, self.color, self.st
        cur = self.current()
        lines: List[str] = []
        focus_line = 0

        def add(segs: List[Seg], focused: bool = False) -> None:
            nonlocal focus_line
            if focused:
                focus_line = len(lines)
            lines.append(render_line(segs, width, color))

        if self.page.summary:
            for title, rows in self.page.summary(st):
                add([("   " + title, "b")])
                for k, v in rows:
                    add([(f"     {k:<26}", "d"), (str(v), "")])
                lines.append("")
        for f in self.page.shown(st):
            reason = f.disabled(st)
            err = self.errors.get(f.key)
            if isinstance(f, Note):
                txt = f.text(st)
                if txt:
                    for para in txt.split("\n"):
                        add([("   " + para, f.style)])
                    lines.append("")
                continue
            if f.label and not isinstance(f, (Text, Toggle)):
                segs = [("   " + f.label, "d" if reason else "b")]
                if reason:
                    segs.append(("  — " + reason, "d"))
                if err:
                    segs.append((f"  {g.bad} {err}", "e"))
                add(segs)
            if isinstance(f, (Radio, Checks, Buttons)):
                opts = f.opts(st) if isinstance(f, Radio) else list(f.options)
                chosen = set(st.get(f.key) or ()) if isinstance(f, Checks) else {st.get(f.key)}
                col = min(34, max((len(o.label) for o in opts), default=0) + 2)   # descriptions alignées
                for i, o in enumerate(opts):
                    focused = cur is not None and cur[0] is f and cur[1] == i
                    o_reason = o.disabled(st) if not reason else reason
                    if isinstance(f, Buttons):
                        mark = ""
                    elif isinstance(f, Checks):
                        mark = (g.check_on if o.value in chosen else g.check_off) + " "
                    else:
                        mark = (g.radio_on if o.value in chosen else g.radio_off) + " "
                    pre = f" {g.cursor} " if focused else "   "
                    lab_style = "d" if o_reason else ("ba" if focused else "")
                    segs = [(pre, "a"), (" " + mark, "a" if o.value in chosen and not o_reason else "d"),
                            (o.label.ljust(col) if (o.desc or o_reason) else o.label, lab_style)]
                    if o_reason:
                        segs.append(("— " + o_reason, "d"))
                    elif o.desc:
                        segs.append((o.desc, "d"))
                    add(segs, focused)
            elif isinstance(f, Toggle):
                focused = cur is not None and cur[0] is f
                on = bool(st.get(f.key))
                segs = [(f" {g.cursor} " if focused else "   ", "a"),
                        (" " + (g.check_on if on else g.check_off) + " ", "a" if on else "d"),
                        (f.label, "d" if reason else ("ba" if focused else "b"))]
                if reason:
                    segs.append(("  — " + reason, "d"))
                elif f.desc:
                    segs.append(("  " + f.desc, "d"))
                add(segs, focused)
            elif isinstance(f, Text):
                focused = cur is not None and cur[0] is f
                v = str(st.get(f.key) or "")
                shown_v = (g.bullet * len(v)) if f.secret else v
                label = f"{f.label:<22}"
                segs = [(f" {g.cursor} " if focused else "   ", "a"),
                        (" " + label + " ", "d" if reason else ("ba" if focused else ""))]
                if reason:
                    segs.append(("— " + reason, "d"))
                elif focused:
                    pos = min(self.cursor.get(f.key, len(v)), len(v))
                    room = max(8, width - len(label) - 8)
                    start = max(0, pos - room + 1)
                    seg_v = shown_v[start:start + room]
                    p = pos - start
                    if not v and f.placeholder:
                        segs += [(g.caret, "a"), (f.placeholder, "d")]
                    else:
                        segs += [(seg_v[:p], "u"), (g.caret, "a"), (seg_v[p:], "u")]
                else:
                    segs.append((shown_v, "") if v else (f.placeholder, "d"))
                if err:
                    segs.append((f"  {g.bad} {err}", "e"))
                elif focused and f.hint:
                    segs.append(("  " + f.hint, "d"))
                add(segs, focused)
            lines.append("")
        if self.busy():
            add([("   " + g.spin[int(time.time() * 10) % len(g.spin)] + " sonde en cours…", "a")])
        return lines, focus_line

    def _hints(self) -> str:
        cur = self.current()
        f = cur[0] if cur else None
        base = "Tab pages · Échap quitter"
        if isinstance(f, Text):
            return "Saisie · Entrée valider · ↑↓ champs · " + base
        if isinstance(f, Radio):
            return "↑↓ choisir · Entrée valider · 1-9 direct · " + base
        if isinstance(f, (Checks, Toggle)):
            return "↑↓ naviguer · Espace cocher · Entrée suivant · " + base
        if isinstance(f, Buttons):
            return "Entrée confirmer · ↑↓ naviguer · " + base
        return "Entrée suivant · " + base

    # ── boucle ──────────────────────────────────────────────────────────────
    def run(self, terminal: Optional[Terminal] = None) -> Optional[State]:
        term = terminal or Terminal()
        self.g = Glyphs(term.unicode)
        self.color = term.color
        with term:
            last = None
            while True:
                w, h = term.size()
                out = "\x1b[H" + "\x1b[K\r\n".join(self.frame(w, h)) + "\x1b[K\x1b[J"
                if out != last or term.resized:
                    if term.resized:
                        out = "\x1b[2J" + out
                        term.resized = False
                    term.write(out)
                    last = out
                keys = term.read(0.1 if self.busy() else 0.5)
                if self.pending_finish and not self.busy() and not keys:
                    val, self.pending_finish = self.pending_finish, None
                    self.message = ""
                    if self.try_finish(val) == "finish":
                        return self.st
                for k in keys:
                    res = self.handle(k)
                    if res == "cancel":
                        return None
                    if res == "finish":
                        return self.st


def ask_choice(title: str, question: str, options: Sequence[Tuple[str, str, str]],
               default: Optional[str] = None) -> Optional[str]:
    """Une seule question à choix (prompt ponctuel d'install.sh)."""
    st: State = {"choice": default or options[0][0]}
    page = Page("q", "Choix", question, [
        Radio("choice", "", options=[Opt(v, lab, desc) for v, lab, desc in options]),
        Buttons("_go", "", options=[Opt("ok", "Valider")]),
    ])
    wiz = Wizard(title, [page], st)
    res = wiz.run()
    return None if res is None else res["choice"]


__all__ = ["Buttons", "Checks", "Note", "Opt", "Page", "Radio", "Terminal", "Text", "Toggle",
           "TuiUnavailable", "Wizard", "ask_choice", "parse_keys", "render_line", "visible_len"]
