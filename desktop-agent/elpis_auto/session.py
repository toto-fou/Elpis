# SPDX-License-Identifier: MIT
"""elpis_auto.session — la séance d'automatisation : cibles, actions, attentes,
vérifications, contrôle, rapport.

Transport EN PROCESS : ``backends.get_backend()`` de l'agent (UIA sous Windows,
AT-SPI sous Linux), exactement le code qui sert déjà au contrôle d'écran depuis
Elpis. Le script n'a donc ni serveur ni réseau à faire tourner.

Ciblage — dans l'ordre de robustesse, chaque cible porte toute la chaîne :
    auto_id  (AutomationId / accessible-id, stable entre lancements)
    name     (+ role pour lever l'ambiguïté ; sous-chaîne acceptée)
    path     (chemin STRUCTUREL « #ancre/group[2]/button[1] » : un contrôle SANS
              nom visé depuis son ancêtre nommé — encore l'arbre, pas un point)
    at=(x,y) (coordonnées de la capture, DERNIER repli)
La méthode réellement employée est journalisée dans le rapport (``method``).

⚠ UIA et COM : tout se passe sur LE thread de l'appelant. Le runtime ne crée
jamais de thread pour les appels de backend (leçon de l'agent, 2026-06-15 :
un ThreadPool éparpillait les objets COM → arbre vide, clics KO).
"""
from __future__ import annotations

import hashlib
import os
import re
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .report import Report

__version__ = "0.0.1"


class StepError(RuntimeError):
    """Une action n'a pas pu être exécutée (cible introuvable, backend KO)."""


class TargetNotFound(StepError):
    """La cible d'une action est restée introuvable APRÈS l'attente complète
    (``timeout`` + patience). Pas de réessai IMPLICITE : rejouer l'action relancerait
    toute l'attente — un ``timeout=60`` échouait en 120 s et plus. Un ``retry=N``
    écrit sur la ligne reste honoré."""


class CheckFailed(AssertionError):
    """Une vérification (``expect``) n'est pas satisfaite dans le délai."""


class NeedsVision(RuntimeError):
    """L'étape exige la vision/OCR d'Elpis, absents sur cette machine."""


# ── Cibles ────────────────────────────────────────────────────────────────────
@dataclass
class Target:
    """Une cible porte TOUTES ses identités à la fois (pile auto-réparante) ;
    ``Session.find`` les essaie dans l'ordre auto_id → path → name(+role) → near
    → image → describe, puis ``window``+``rel`` / ``at`` comme point de repli."""
    auto_id: str = ""
    name: str = ""
    role: str = ""
    at: Optional[Tuple[int, int]] = None
    window: str = ""          # titre (regex) ou « #auto_id » de la fenêtre
    path: str = ""            # chemin STRUCTUREL : « #ancre/role[n]/… » (élément sans nom)
    near: str = ""            # libellé nommé voisin (« Console Python ») → contrôle du rôle le plus proche
    side: str = ""            # right|left|below|above|any — côté du voisin
    rel: Optional[Tuple[float, float]] = None   # fractions (fx, fy) du rectangle de ``window``
    image: str = ""           # vignette PNG (chemin relatif au script) → corrélation d'image
    describe: str = ""        # description pour la vision d'Elpis (ELPIS_URL)

    @classmethod
    def of(cls, **kw) -> "Target":
        t = cls(auto_id=str(kw.get("auto_id") or ""), name=str(kw.get("name") or ""),
                role=str(kw.get("role") or ""), window=str(kw.get("window") or ""),
                path=str(kw.get("path") or ""), near=str(kw.get("near") or ""),
                side=str(kw.get("side") or ""), image=str(kw.get("image") or ""),
                describe=str(kw.get("describe") or ""))
        at = kw.get("at")
        if at is not None:
            t.at = (int(at[0]), int(at[1]))
        rel = kw.get("rel")
        if rel is not None:
            t.rel = (float(rel[0]), float(rel[1]))
        return t

    def label(self) -> str:
        if self.auto_id and not _volatile_id(self.auto_id):
            return f"#{self.auto_id}"
        if self.name:
            return f"« {self.name} »" + (f" ({self.role})" if self.role else "")
        if self.auto_id:
            return f"#{self.auto_id}"
        if self.path:
            return self.path
        if self.near:
            return f"{self.role or 'contrôle'} près de « {self.near} »"
        if self.image:
            return f"image {os.path.basename(self.image)}"
        if self.describe:
            return f"« {self.describe} » (vision)"
        if self.role:
            return f"({self.role})" + (f" dans /{self.window}/" if self.window else "")
        if self.rel is not None and self.window:
            return f"{self.window} @({self.rel[0]:.2f},{self.rel[1]:.2f})"
        if self.at:
            return f"({self.at[0]},{self.at[1]})"
        return "?"

    def semantic(self) -> bool:
        """L'AGENT sait re-résoudre la cible lui-même (auto_id / nom)."""
        return bool(self.auto_id or self.name)

    def structural(self) -> bool:
        """Cible résolue par le RUNTIME dans l'arbre (chemin, voisin, image, vision,
        ou un RÔLE seul : « le document », « la zone d'édition » d'une fenêtre)."""
        return bool(self.path or self.near or self.image or self.describe
                    or (self.role and not self.name and not self.auto_id))

    def findable(self) -> bool:
        return self.semantic() or self.structural()

    def strategies(self) -> List[str]:
        """Identités fournies, dans l'ordre d'essai."""
        out = []
        if self.auto_id: out.append("auto_id")
        if self.path: out.append("path")
        if self.name: out.append("name")
        if self.near: out.append("near")
        if self.image: out.append("image")
        if self.describe: out.append("describe")
        if self.role and not self.name and not self.auto_id and not self.path and not self.near: out.append("role")
        if self.rel is not None and self.window: out.append("rel")
        if self.at: out.append("at")
        return out

    def primary(self) -> str:
        st = self.strategies()
        return st[0] if st else ""


_CLICK_FALLBACK_ACTIONS = frozenset({"click", "invoke", "left_click", "double_click", "toggle", "check", "uncheck", "select"})

_TARGET_KEYS = ("auto_id", "name", "role", "at", "window", "path", "near", "side", "rel", "image", "describe")


# ── Chemins structurels ───────────────────────────────────────────────────────
# Grammaire (celle du Studio, elementPath) : segments séparés par « / ».
#   #id          élément d'AutomationId ``id``
#   role:Nom     élément de ce rôle ET de ce nom (exact, casse ignorée)
#   Nom          élément de ce nom, tout rôle
#   role[n]      n-ième ENFANT DIRECT de ce rôle (1-based) du segment précédent
# Le 1er segment se cherche dans tout l'arbre (ou parmi les racines s'il est de
# la forme role[n]) ; les suivants parmi les enfants directs du courant. L'arbre
# est la liste À PLAT en pré-ordre de ``ui_tree`` (``depth``) ; les enfants
# directs d'un nœud sont ceux de son sous-arbre qu'aucun nœud du sous-arbre ne
# précède à une profondeur moindre (robuste aux trous de profondeur).
def _parse_seg(seg: str) -> Optional[Dict[str, Any]]:
    seg = (seg or "").strip()
    if not seg:
        return None
    if seg.startswith("#"):
        return {"auto_id": seg[1:]}
    m = re.match(r"^([A-Za-z_]+)\[(\d+)\]$", seg)
    if m:
        return {"role": m.group(1).lower(), "n": int(m.group(2)) or 1}
    c = seg.find(":")
    if c > 0 and re.match(r"^[A-Za-z_]+$", seg[:c]):
        return {"role": seg[:c].lower(), "name": seg[c + 1:]}
    return {"name": seg}


def _depth(n: Dict[str, Any]) -> int:
    try:
        return int(n.get("depth") or 0)
    except (TypeError, ValueError):
        return 0


def _children(nodes: List[Dict[str, Any]], i: int) -> List[Dict[str, Any]]:
    d = _depth(nodes[i])
    out: List[Dict[str, Any]] = []
    run_min = 10 ** 9
    for j in range(i + 1, len(nodes)):
        dj = _depth(nodes[j])
        if dj <= d:
            break
        if dj <= run_min:
            out.append(nodes[j])
        run_min = min(run_min, dj)
    return out


def _roots(nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out, run_min = [], 10 ** 9
    for n in nodes:
        d = _depth(n)
        if d <= run_min:
            out.append(n)
        run_min = min(run_min, d)
    return out


def _match_seg(n: Dict[str, Any], p: Dict[str, Any], siblings: List[Dict[str, Any]]) -> bool:
    if "auto_id" in p:
        return str(n.get("auto_id") or "") == p["auto_id"]
    if "name" in p:
        if p.get("role") and _norm(n.get("role")) != p["role"]:
            return False
        return _norm(n.get("name")) == _norm(p["name"])
    if _norm(n.get("role")) != p["role"]:
        return False
    k = 0
    for sib in siblings:
        if _norm(sib.get("role")) == p["role"]:
            k += 1
            if sib is n:
                return k == p["n"]
    return False


def _subtree(nodes: List[Dict[str, Any]], i: int) -> List[Dict[str, Any]]:
    d = _depth(nodes[i])
    out: List[Dict[str, Any]] = []
    for j in range(i + 1, len(nodes)):
        if _depth(nodes[j]) <= d:
            break
        out.append(nodes[j])
    return out


def resolve_path(nodes: List[Dict[str, Any]], path: str, relaxed: bool = True) -> Optional[Dict[str, Any]]:
    """Le nœud désigné par ``path`` dans ``nodes`` (liste à plat de ui_tree), ou None.

    Strict d'abord (chaque pas = enfant DIRECT). ``relaxed`` : si le chemin
    exact casse — un conteneur intermédiaire est apparu ou a disparu, un rang a
    glissé — on retombe sur « l'ANCRE, puis le N-ième DESCENDANT de ce rôle »
    (le dernier pas, rang compté sur tout le sous-arbre de l'ancre). Les chemins
    profonds « group[1]/custom[1]/… » d'une appli Qt changent d'un affichage à
    l'autre ; l'ancre et la feuille, eux, tiennent."""
    segs = [p for p in (_parse_seg(x) for x in str(path or "").split("/")) if p]
    if not segs:
        return None
    first = segs[0]
    pool = _roots(nodes) if ("n" in first) else list(nodes)
    anchor = next((n for n in pool if _match_seg(n, first, pool)), None)
    if anchor is None and relaxed and first.get("auto_id"):
        # Ancre absente : Qt donne à un dock FLOTTANT l'objectName nu
        # (« PythonConsole ») et au même dock ANCRÉ un nom préfixé
        # (« QgisApp.PythonConsole »). Dans les deux sens, on accepte le dernier
        # composant pointé, exact ou en suffixe « .PythonConsole ».
        tail = first["auto_id"].rsplit(".", 1)[-1]
        anchor = next((n for n in pool if str(n.get("auto_id") or "") == tail
                       or str(n.get("auto_id") or "").endswith("." + tail)), None)
    cur = anchor
    for p in segs[1:]:
        if cur is None:
            break
        i = next((k for k, n in enumerate(nodes) if n is cur), -1)
        kids = _children(nodes, i) if i >= 0 else []
        cur = next((k for k in kids if _match_seg(k, p, kids)), None)
    if cur is not None or not relaxed or anchor is None or len(segs) < 2:
        return cur
    last = segs[-1]
    i = next((k for k, n in enumerate(nodes) if n is anchor), -1)
    if i < 0:
        return None
    sub = _subtree(nodes, i)
    if "n" in last:
        same = [n for n in sub if _norm(n.get("role")) == last["role"]]
        return same[last["n"] - 1] if 0 < last["n"] <= len(same) else None
    return next((n for n in sub if _match_seg(n, last, sub)), None)


def _rect(n: Dict[str, Any]) -> Tuple[int, int, int, int]:
    r = n.get("rect") or [0, 0, 0, 0]
    return int(r[0]), int(r[1]), int(r[2]), int(r[3])


def _center_of(n: Dict[str, Any]) -> Tuple[float, float]:
    x, y, w, h = _rect(n)
    return x + w / 2.0, y + h / 2.0


def _ancestors(nodes: List[Dict[str, Any]], i: int) -> List[Dict[str, Any]]:
    """Ancêtres du nœud ``i`` (racine en premier) : le précédent de profondeur moindre, en chaîne."""
    out: List[Dict[str, Any]] = []
    d = _depth(nodes[i])
    for j in range(i - 1, -1, -1):
        dj = _depth(nodes[j])
        if dj < d:
            out.insert(0, nodes[j])
            d = dj
            if d == 0:
                break
    return out


def _anchorable(nodes: List[Dict[str, Any]], n: Dict[str, Any]) -> bool:
    if n.get("auto_id") and not _volatile_id(n.get("auto_id")) and "/" not in str(n.get("auto_id")):
        return True
    nm = _norm(n.get("name"))
    if not nm or "/" in nm:                   # « Entrée/Sortie » couperait le chemin en deux
        return False
    return sum(1 for x in nodes if _norm(x.get("name")) == nm and _norm(x.get("role")) == _norm(n.get("role"))) == 1


def _seg_of(n: Dict[str, Any], siblings: List[Dict[str, Any]]) -> str:
    role = _norm(n.get("role")) or "element"
    k = 0
    for sib in siblings:
        if _norm(sib.get("role")) == role:
            k += 1
            if sib is n:
                return f"{role}[{k}]"
    return f"{role}[1]"


def node_identity(nodes: List[Dict[str, Any]], n: Dict[str, Any]) -> Dict[str, Any]:
    """La MEILLEURE identité d'un nœud (ce que le script devrait écrire) :
    ``{"auto_id": …}`` | ``{"name", "role"}`` | ``{"path": …}`` — même règle que
    l'enregistreur du Studio (elementPath)."""
    if n.get("auto_id") and not _volatile_id(n.get("auto_id")):
        return {"auto_id": str(n["auto_id"])}
    if _anchorable(nodes, n):
        return {"name": str(n.get("name") or ""), "role": str(n.get("role") or "")}
    i = next((k for k, x in enumerate(nodes) if x is n), -1)
    if i < 0:
        return {}
    chain = _ancestors(nodes, i) + [n]
    start = -1
    for k in range(len(chain) - 2, -1, -1):
        if _anchorable(nodes, chain[k]):
            start = k
            break
    segs: List[str] = []
    if start >= 0:
        a = chain[start]
        aid = str(a.get("auto_id") or "")
        if aid and not _volatile_id(aid) and "/" not in aid:
            segs.append(f"#{aid}")
        elif _norm(a.get("role")):
            segs.append(f"{_norm(a.get('role'))}:{a.get('name')}")
        else:
            segs.append(str(a.get("name") or ""))     # rôle inconnu : « :Nom » se lirait comme un nom littéral
    else:
        segs.append(_seg_of(chain[0], _roots(nodes)))
        start = 0
    for k in range(start + 1, len(chain)):
        pi = next((q for q, x in enumerate(nodes) if x is chain[k - 1]), -1)
        segs.append(_seg_of(chain[k], _children(nodes, pi) if pi >= 0 else []))
    return {"path": "/".join(segs)}


def identity_kwargs(ident: Dict[str, Any]) -> str:
    """{"auto_id": …} → ``auto_id="…"`` (texte Python à coller dans le script)."""
    def q(v: Any) -> str:
        return ('"' + str(v).replace("\\", "\\\\").replace('"', '\\"')
                .replace("\n", "\\n").replace("\r", "").replace("\t", "\\t") + '"')
    return ", ".join(f"{k}={q(v)}" for k, v in ident.items() if v)


def find_near(nodes: List[Dict[str, Any]], near: str, role: str = "", side: str = "") -> Optional[Dict[str, Any]]:
    """Le contrôle du rôle demandé le plus proche d'un nœud NOMMÉ ``near``,
    du côté ``side`` (right|left|below|above|any). Sans rôle : le voisin
    interactif le plus proche. Les formulaires Qt sont pleins de champs sans
    nom collés à un libellé qui en a un."""
    want = _norm(near)
    if not want:
        return None
    labels = [n for n in nodes if _norm(n.get("name")) == want] or [n for n in nodes if want in _norm(n.get("name"))]
    if not labels:
        return None
    role = _norm(role)
    side = _norm(side) or "any"
    best, best_d = None, float("inf")
    for lab in labels:
        lx, ly = _center_of(lab)
        for n in nodes:
            if n is lab:
                continue
            if role:
                if _norm(n.get("role")) != role:
                    continue
            elif _norm(n.get("role")) not in _INTERACTIVE_ROLES:
                continue
            cx, cy = _center_of(n)
            dx, dy = cx - lx, cy - ly
            if side == "right" and dx <= 0: continue
            if side == "left" and dx >= 0: continue
            if side == "below" and dy <= 0: continue
            if side == "above" and dy >= 0: continue
            # pénalise l'écart perpendiculaire à la direction (on veut « en face ») ;
            # sans côté : un libellé et son champ sont sur la MÊME LIGNE → |dy| pèse.
            d = (dx * dx + dy * dy) ** 0.5
            if side in ("right", "left"): d += abs(dy) * 2
            elif side in ("below", "above"): d += abs(dx) * 2
            else: d += abs(dy)
            if d < best_d:
                best, best_d = n, d
    return best


_INTERACTIVE_ROLES = frozenset({"button", "checkbox", "radiobutton", "edit", "textbox", "combobox", "listitem", "tab",
                                "tabitem", "menuitem", "slider", "hyperlink", "spinner", "treeitem", "splitbutton",
                                "document"})


def find_window(nodes: List[Dict[str, Any]], window: str) -> Optional[Dict[str, Any]]:
    """Racine (fenêtre) par « #auto_id » ou titre (regex, casse ignorée)."""
    w = str(window or "").strip()
    if not w:
        return None
    roots = _roots(nodes)
    if w.startswith("#"):
        return next((r for r in roots if str(r.get("auto_id") or "") == w[1:]), None)
    return _first_title_match(roots, w, key="name")


def _title_rx(title: str) -> "re.Pattern[str]":
    """Un titre de fenêtre est d'abord un TEXTE (« Document (1).txt - Bloc-notes » :
    les parenthèses et le point en font une regex valide qui ne se reconnaît pas
    elle-même), et une regex si l'auteur en écrit une (« Calc.* »). On accepte les
    deux lectures, casse ignorée, n'importe où dans le titre."""
    # Espaces : n'importe quel blanc, dont l'espace INSÉCABLE — le Bloc-notes titre
    # « a\xa0- Bloc-notes » ; « a - Bloc-notes » tapé au clavier ne s'y reconnaissait pas
    # (vu sur la VM : wait.window échouait là où focus/close trouvaient la fenêtre).
    lit = r"\s+".join(re.escape(tok) for tok in str(title).split()) or re.escape(str(title))
    try:
        re.compile(str(title))
    except re.error:
        return re.compile(lit, re.I)
    try:
        return re.compile(f"(?:{lit})|(?:{title})", re.I)
    except re.error:
        # Drapeaux en ligne (« (?i)calc ») : valides seuls, refusés au milieu de l'union
        # (Python 3.11+) — le motif de l'auteur seul, sinon l'attente expirait en silence.
        return re.compile(str(title), re.I)


# Caractères qui font d'un titre une VRAIE regex (« Calc.* », « ^Bloc ») ; « ( ) . - »
# sont la ponctuation ordinaire d'un titre (« Document (1).txt »).
_REGEX_HINT = re.compile(r"[*+?^$|\\\[\]{}]")


def _first_title_match(items: List[Dict[str, Any]], title: str, key: str = "title",
                       strict: bool = False) -> Optional[Dict[str, Any]]:
    """Premier élément dont le titre contient ``title`` LITTÉRALEMENT (casse ignorée),
    sinon dont le titre correspond à ``title`` lu comme une regex. Titre vide : rien
    (l'union vide reconnaissait la première fenêtre venue). ``strict`` (fermer) : la
    lecture regex seulement si le titre en est visiblement une — « Document (1).txt »
    absent fermait sinon « Document 1.txt »."""
    want = _norm(title)
    if not want:
        return None
    hit = next((x for x in items if want in _norm(x.get(key))), None)
    if hit is not None:
        return hit
    if strict and not _REGEX_HINT.search(str(title)):
        return None
    rx = _title_rx(title)
    return next((x for x in items if rx.search(str(x.get(key) or ""))), None)


def _pywinauto_title_re(title: str) -> str:
    """``title_re`` pour pywinauto, qui applique ``re.match`` (ANCRÉ au début du
    titre, casse respectée) : ``wait.window("Bloc-notes")`` ne trouvait jamais
    « Sans titre - Bloc-notes » sur une machine avec pywinauto, alors que le repli
    Win32 (``search``) la trouvait. On rend la même sémantique que partout ailleurs :
    n'importe où, casse ignorée, texte littéral OU regex."""
    pat = _title_rx(title).pattern
    flags = "is"
    m = re.match(r"^\(\?([aiLmsux]+)\)", pat)     # drapeaux en ligne de l'auteur : remontés en tête
    if m:
        flags += "".join(c for c in m.group(1) if c not in flags)
        pat = pat[m.end():]
    out = f"(?{flags}).*?(?:{pat})"
    try:
        re.compile(out)
        return out
    except re.error:
        return "(?is).*?" + re.escape(str(title))


def _split_target(kw: Dict[str, Any]) -> Tuple[Target, Dict[str, Any]]:
    """Sépare la cible des autres kwargs. Un mot-clé INCONNU (faute de frappe :
    ``nam=``, ``roll=``) est refusé tout de suite — sinon la cible devenait
    vide en silence et l'étape échouait sur « cible introuvable ? »."""
    tkw = {k: kw.pop(k) for k in list(kw) if k in _TARGET_KEYS}
    if kw:
        bad = ", ".join(sorted(kw))
        raise TypeError(f"paramètre inconnu : {bad} (cible : {', '.join(_TARGET_KEYS)})")
    return Target.of(**tkw), kw


def _norm(s: Any) -> str:
    return " ".join(str(s or "").split()).strip().lower()


# Un auto_id « view_N » vient d'un moteur Chromium/WebView2 (Edge, Chrome, VS Code,
# Slack, Teams, Electron…) : c'est un numéro d'ordre dans l'arbre, RÉASSIGNÉ à
# chaque relance ou changement d'interface. On ne s'y fie donc jamais comme
# identité primaire — le nom + rôle d'accessibilité, lui, est stable.
_VOLATILE_AUTO_ID = re.compile(r"^view_\d+$", re.I)


def _volatile_id(auto_id: Any) -> bool:
    return bool(auto_id) and bool(_VOLATILE_AUTO_ID.match(str(auto_id)))


def _value_of(n: Dict[str, Any]) -> str:
    """Ce qu'un contrôle « vaut » : sa valeur (ValuePattern) si l'arbre en porte
    une, sinon son NOM — un afficheur (Calculatrice « L'affichage est 15 »), un
    libellé, un item de liste n'ont pas de valeur mais un nom qui est le texte."""
    v = n.get("value")
    if v is not None and str(v) != "":
        return str(v)
    return str(n.get("name") or "")


def _dhash(png: bytes) -> str:
    """Signature 64 bits d'une capture (dHash 9×8) — même recette que le
    serveur. Sans Pillow : empreinte des octets (tout changement compte)."""
    try:
        from io import BytesIO

        from PIL import Image  # type: ignore
        im = Image.open(BytesIO(png)).convert("L").resize((9, 8))
        px = list(im.getdata())
        bits = 0
        for y in range(8):
            for x in range(8):
                bits = (bits << 1) | (1 if px[y * 9 + x] > px[y * 9 + x + 1] else 0)
        return f"{bits:016x}"
    except Exception:
        return hashlib.md5(png).hexdigest()[:16]


def _hamming(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (TypeError, ValueError):
        return 64


def _activity(png: bytes) -> Optional[bytes]:
    """Empreinte FINE d'une capture (gris 48×27) pour détecter que l'écran
    BOUGE : splash qui avance, fenêtre qui se dessine, tuiles qui arrivent. Plus
    sensible que le dHash de ``stable`` (qui juge la STRUCTURE). None sans Pillow."""
    try:
        from io import BytesIO

        from PIL import Image  # type: ignore
        return Image.open(BytesIO(png)).convert("L").resize((48, 27)).tobytes()
    except Exception:
        return None


def _moved(a: Optional[bytes], b: Optional[bytes], level: int = 24, share: float = 0.005) -> bool:
    """True si plus de ``share`` des pixels ont changé de plus de ``level`` niveaux
    (l'horloge de la barre des tâches ou un curseur qui clignote restent en dessous)."""
    if not a or not b or len(a) != len(b):
        return False
    n = sum(1 for x, y in zip(a, b) if abs(x - y) > level)
    return n > len(a) * share


class _Patience:
    """Échéance d'INACTIVITÉ, pas délai absolu. Tant que l'écran bouge (une
    application se lance, un projet se charge, une transition s'anime),
    l'échéance recule de ``timeout`` — au plus ``patience`` s en tout. C'est
    ce que fait un humain devant un écran : « ça charge encore, j'attends ».
    Un écran immobile pendant ``timeout`` s, lui, est un vrai échec."""

    def __init__(self, s: "Session", timeout: float, patience: float):
        self.s = s
        self.timeout = float(timeout)
        self.started = time.monotonic()
        self.deadline = self.started + self.timeout
        self.hard = self.started + max(self.timeout, float(patience or 0))
        self.last: Optional[bytes] = None
        self.extended = False
        # Une capture par sondage (0,3 s) = 100 captures PNG pour une attente de 30 s :
        # l'activité se juge sur un échantillon par seconde au plus (plus souvent pour un
        # délai très court, sinon il expirerait avant la 2e comparaison).
        self.every = min(1.0, max(0.0, self.timeout / 4.0))
        self._sampled: Optional[float] = None

    def expired(self) -> bool:
        now = time.monotonic()
        if now >= self.hard:
            return True
        if self._sampled is None or now - self._sampled >= self.every:
            self._sampled = now
            try:
                sig = _activity(self.s._activity_capture())
            except Exception:                 # noqa: BLE001 — pas de capture : échéance simple
                sig = None
            if sig is not None and self.last is not None and _moved(self.last, sig):
                self.deadline = max(self.deadline, now + self.timeout)
                self.extended = True
            self.last = sig
        return now >= self.deadline

    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def why(self) -> str:
        """Motif lisible d'un délai dépassé."""
        if self.extended:
            return f"délai dépassé ({self.elapsed():.0f} s, prolongé tant que l'écran bougeait)"
        return f"délai dépassé ({self.timeout:g} s, écran immobile)"


# ── Séance ────────────────────────────────────────────────────────────────────
_CURRENT: Optional["Session"] = None     # dernière séance ouverte (``python -m elpis_auto`` la clôt sur abandon)


class Session:
    """Une exécution de script : un backend, un rapport, des réglages."""

    def __init__(self, monitor: Optional[int] = None, needs: Sequence[str] = (), *,
                 name: str = "", report_dir: str = "rapports",
                 backend: Any = None, timeout: float = 30.0, settle: float = 0.25,
                 retry: int = 1, dry_run: Optional[bool] = None, trace: Optional[bool] = None,
                 patience: Optional[float] = None):
        self.name = name or os.path.splitext(os.path.basename(sys.argv[0] or "script"))[0]
        self.default_timeout = float(timeout)
        # ``timeout`` = délai SANS ACTIVITÉ à l'écran (défaut 30 s, le même que le
        # Studio écrit dans ses lignes d'attente) ; ``patience`` = plafond absolu
        # d'une attente (défaut 120 s, ELPIS_PATIENCE). Une appli qui met 40 s à se
        # lancer ne fait plus tomber une attente de 30 s : tant que ça bouge, on attend.
        self.patience = float(patience if patience is not None else (os.environ.get("ELPIS_PATIENCE") or 120))
        self.settle = float(settle)          # pause après chaque action (l'UI respire)
        self.default_retry = max(0, int(retry or 0))   # réessais d'une action en échec (sans ``retry=`` explicite)
        self._waited_ms = 0
        self.resolved_by = ""                # stratégie qui a résolu la DERNIÈRE cible (pile auto-réparante)
        self._healed: Optional[Dict[str, Any]] = None
        self._last_nodes: Optional[List[Dict[str, Any]]] = None
        self._find_error = ""                 # dernière erreur de lecture pendant une recherche (diagnostic)
        self.script_dir = os.path.dirname(os.path.abspath(sys.argv[0] or ".")) if sys.argv and sys.argv[0] else os.getcwd()
        # Vol à blanc (``--dry-run`` / ELPIS_DRY_RUN=1) : résoudre chaque cible sur
        # un arbre frais, n'envoyer AUCUNE entrée. Trace (``--trace`` /
        # ELPIS_TRACE_STEPS=1) : capture + extrait d'arbre à chaque étape.
        self.dry_run = bool(os.environ.get("ELPIS_DRY_RUN")) if dry_run is None else bool(dry_run)
        self.trace = bool(os.environ.get("ELPIS_TRACE_STEPS")) if trace is None else bool(trace)
        self._step_target: Optional[Dict[str, Any]] = None
        self._act_timeout: Optional[float] = None   # ``timeout=`` de l'action en cours
        self.report = Report(self.name, report_dir)
        if self.dry_run:
            self.report.dry_run = True
        self.wait = _Wait(self)
        self.expect = _Expect(self)
        self._last_keys: Optional[set] = None
        self._policy_stack: List[Dict[str, Any]] = []
        self._front_missing: set = set()      # ``window=`` jamais listées (bureau…) : une note, pas une panne
        global _CURRENT
        _CURRENT = self
        self._backend = backend if backend is not None else self._load_backend()
        if monitor is not None:               # 0 = tous les écrans (numérotation du Studio), pas « défaut »
            try:
                self._backend.set_monitor(int(monitor))
            except Exception as e:           # noqa: BLE001 — l'écran par défaut suffit
                self.report.note(f"écran {monitor} indisponible ({e}) : écran par défaut")
        needs = [str(n) for n in (needs or ())]
        if "vision" in needs and not os.environ.get("ELPIS_URL"):
            # Refus EXPLICITE au démarrage : ce script contient une étape qui
            # demande le modèle de vision/OCR d'Elpis. Mieux vaut le dire tout de
            # suite que d'échouer à l'étape 12 après avoir modifié des choses.
            self.report.finish(2, "ce script exige Elpis (vision/OCR) : ELPIS_URL absent")
            raise NeedsVision("ce script exige Elpis (vision/OCR) : définis ELPIS_URL, "
                              "ou retire les étapes de lecture d'écran")

    # ── backend ───────────────────────────────────────────────────────────
    @staticmethod
    def _load_backend() -> Any:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # desktop-agent/
        if here not in sys.path:
            sys.path.insert(0, here)
        from backends import get_backend  # type: ignore
        return get_backend()

    def _call(self, fn: str, **kw) -> Any:
        f = getattr(self._backend, fn, None)
        if f is None:
            raise StepError(f"le backend n'offre pas {fn!r}")
        return f(**kw) if kw else f()

    # ── paramètres du script ───────────────────────────────────────────────
    @staticmethod
    def params(defaults: Optional[Dict[str, Any]] = None, argv: Optional[List[str]] = None) -> Dict[str, Any]:
        """``--cle=valeur`` en ligne de commande, sinon ``ELPIS_PARAM_CLE`` en
        environnement, sinon le défaut. Les clés inconnues sont refusées."""
        out = dict(defaults or {})
        for k in out:
            env = os.environ.get("ELPIS_PARAM_" + k.upper())
            if env is not None:
                out[k] = env
        for arg in (argv if argv is not None else sys.argv[1:]):
            if not arg.startswith("--") or "=" not in arg:
                continue
            k, v = arg[2:].split("=", 1)
            if k not in out:
                raise SystemExit(f"paramètre inconnu : --{k} (attendus : {', '.join(out) or 'aucun'})")
            out[k] = v
        return out

    # ── observation ───────────────────────────────────────────────────────
    # Plafond LARGE : une appli Qt/WPF dépasse vite 600 nœuds en pré-ordre, et un
    # contrôle profond (dock, barre d'outils) tombait alors HORS de l'arbre lu →
    # « introuvable » alors qu'il est à l'écran. Éventail élargi de même.
    def tree(self, scope: str = "desktop", max_nodes: int = 5000) -> List[Dict[str, Any]]:
        try:
            nodes, _w, _h = self._call("ui_tree", max_nodes=int(max_nodes), scope=scope, fanout=400)
        except TypeError:                     # backend sans ``fanout`` (ancien / factice)
            nodes, _w, _h = self._call("ui_tree", max_nodes=int(max_nodes), scope=scope)
        self._last_keys = {self._key(n) for n in nodes}
        return list(nodes)

    @staticmethod
    def _key(n: Dict[str, Any]) -> str:
        return f"{n.get('role','')}|{_norm(n.get('name'))}|{n.get('auto_id','')}"

    @staticmethod
    def _center(n: Dict[str, Any]) -> Tuple[int, int]:
        r = n.get("rect") or [0, 0, 0, 0]
        return int(r[0] + r[2] / 2), int(r[1] + r[3] / 2)

    def find(self, target: Target, nodes: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
        """Le nœud de l'arbre qui correspond à la cible, ou None — en essayant
        TOUTES les identités fournies : auto_id exact → chemin (strict puis
        relâché) → nom exact (+rôle) → nom contenant (+rôle) → voisin nommé.
        ``self.resolved_by`` dit laquelle a gagné (pile auto-réparante)."""
        self.resolved_by = ""
        self._last_nodes = nodes
        if not target.findable():
            return None
        if nodes is None:
            nodes = self.tree("desktop")
            self._last_nodes = nodes
        # ``window=`` borne d'abord la recherche à cette fenêtre : deux « OK »
        # (une boîte de dialogue + une fenêtre restée derrière) ne se confondent
        # plus. Absente de l'arbre, ou cible introuvable dedans : tout l'écran.
        role_only = bool(target.role) and not (target.name or target.auto_id or target.path or target.near
                                               or target.image or target.describe)
        if target.window:
            w = find_window(nodes, target.window)
            if w is not None:
                i = next((k for k, x in enumerate(nodes) if x is w), -1)
                if i >= 0:
                    n = self._find_in(target, [w] + _subtree(nodes, i))
                    if n is not None:
                        return n
            # Cible par RÔLE SEUL (« le document ») : hors de sa fenêtre, ce serait le
            # document d'une autre appli (une console !) — fenêtre trouvée OU PAS ENCORE
            # ouverte : on s'arrête (et l'attente continue).
            if role_only:
                return None
            # Hors de la fenêtre visée (pas encore ouverte, titre changé), un nom PARTIEL
            # attrapait n'importe quoi : « Enregistrer » dans la barre d'outils au lieu
            # du bouton du dialogue « Enregistrer sous » qui s'ouvrait → clic immédiat,
            # sans attente. Hors fenêtre : nom EXACT seulement.
            return self._find_in(target, nodes, exact_names=True)
        return self._find_in(target, nodes)

    def _find_in(self, target: Target, nodes: List[Dict[str, Any]], exact_names: bool = False) -> Optional[Dict[str, Any]]:
        role = _norm(target.role)
        if target.auto_id:
            vol = _volatile_id(target.auto_id)
            want = _norm(target.name)
            same_id = [n for n in nodes if str(n.get("auto_id") or "") == target.auto_id]
            if vol and want:
                # auto_id volatil (view_N) : ne s'y fier que s'il désigne bien le
                # même contrôle (nom, et rôle si fourni) ; sinon → repli nom+rôle.
                same_id = [n for n in same_id if _norm(n.get("name")) == want
                           and (not role or _norm(n.get("role")) == role)]
            elif len(same_id) > 1 and (want or role):
                # auto_id PARTAGÉ (Explorateur : toutes les cellules « nom de fichier »
                # portent System.ItemNameDisplay) : le premier n'est pas forcément le
                # bon — on départage par le nom puis le rôle enregistrés.
                pools = []
                if want:
                    pools.append([n for n in same_id if _norm(n.get("name")) == want])
                    if not exact_names:
                        pools.append([n for n in same_id if want in _norm(n.get("name"))])
                else:
                    pools.append(same_id)
                picked = None
                for pool in pools:
                    if role:
                        pool = [n for n in pool if _norm(n.get("role")) == role]
                    if pool:
                        picked = pool
                        break
                same_id = picked or []
            if same_id:
                self.resolved_by = "auto_id"
                return same_id[0]
        if target.path:
            n = resolve_path(nodes, target.path)
            if n is not None:
                self.resolved_by = "path"
                return n
        want = _norm(target.name)
        if want:
            exact = [n for n in nodes if _norm(n.get("name")) == want]
            part = [] if exact_names else [n for n in nodes if want in _norm(n.get("name"))]
            # Le RÔLE demandé est une contrainte, pas un indice : un
            # ``wait.element(name="Enregistrer", role="window")`` ne doit pas être
            # satisfait par le BOUTON « Enregistrer » de la fenêtre principale (l'attente
            # rendait la main avant l'ouverture du dialogue, le clic suivant ratait).
            for pool in (exact, part):
                if role:
                    pool = [n for n in pool if _norm(n.get("role")) == role]
                if pool:
                    self.resolved_by = "name"
                    return pool[0]
        if target.near:
            n = find_near(nodes, target.near, target.role, target.side)
            if n is not None:
                self.resolved_by = "near"
                return n
        if (role and not want and not target.auto_id and not target.path and not target.near
                and not target.image and not target.describe):
            # (``image=`` / ``describe=`` + rôle : le rôle qualifie la vignette, il ne
            # désigne pas « le premier bouton de l'écran »)
            n = next((x for x in nodes if _norm(x.get("role")) == role), None)   # « le document » de la fenêtre
            if n is not None:
                self.resolved_by = "role"
                return n
        return None

    def _point_rel(self, t: Target, nodes: Optional[List[Dict[str, Any]]] = None,
                   wait: bool = False) -> Optional[Tuple[int, int]]:
        """``window`` + ``rel`` → point courant : fractions du rectangle ACTUEL
        de la fenêtre (survit à un déplacement, un redimensionnement, une autre
        résolution). ``wait`` : la cible n'a RIEN d'autre à attendre (ni nom ni
        chemin) — la fenêtre, qui s'ouvre peut-être encore, est attendue ici."""
        if t.rel is None or not t.window:
            return None
        nodes = nodes if nodes is not None else (self._last_nodes or self.tree("desktop"))
        self._last_nodes = nodes
        w = find_window(nodes, t.window)
        if w is None and wait and not self.dry_run:
            started = time.monotonic()
            tmo = self._act_timeout if self._act_timeout is not None else self.default_timeout
            pat = _Patience(self, float(tmo), self.patience)
            while w is None and not pat.expired():
                time.sleep(0.3)
                try:
                    nodes = self.tree("desktop")
                except Exception as e:        # noqa: BLE001 — hoquet de l'arbre : on relit
                    self._find_error = f"{type(e).__name__}: {e}"
                    continue
                self._last_nodes = nodes
                w = find_window(nodes, t.window)
            self._waited_ms += int((time.monotonic() - started) * 1000)
        if w is None:
            return None
        x, y, ww, hh = _rect(w)
        return int(round(x + t.rel[0] * ww)), int(round(y + t.rel[1] * hh))

    def _heal(self, t: Target, n: Optional[Dict[str, Any]]) -> None:
        """La stratégie gagnante n'est pas la première fournie → l'étape est
        « réparée » : on note comment, et la ligne que le script devrait porter."""
        by = self.resolved_by
        if n is None or not by or by == t.primary():
            return
        ident = node_identity(self._last_nodes or [], n)
        self._healed = {"by": by, "suggest": identity_kwargs(ident)}

    def _find_wait(self, target: Target, timeout: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """``find`` AVEC ATTENTE : une action sur une cible qui n'est pas encore
        là (fenêtre qui s'ouvre, liste qui se remplit) attend son apparition —
        jusqu'à ``timeout`` (défaut : celui de la séance) — au lieu d'échouer au
        premier arbre lu. Une cible avec ``at=`` ne fait qu'une lecture : le point
        est son repli, on ne le fait pas attendre. L'attente est journalisée."""
        started = time.monotonic()
        n = self._find_once(target)
        # Le point de repli (``at``/``rel``, présent sur CHAQUE ligne enregistrée)
        # ne dispense pas d'attendre : sinon l'auto-attente était sautée partout
        # et un clic partait au point d'enregistrement avant que le dialogue s'ouvre.
        if n is not None or not target.findable():
            self._heal(target, n)
            return n
        if timeout is None:
            timeout = self._act_timeout
        pat = _Patience(self, float(timeout if timeout is not None else self.default_timeout), self.patience)
        last_vision = time.monotonic()
        while n is None and not pat.expired():
            time.sleep(0.3)
            # ``describe=`` : un appel au modèle de vision par sondage (0,3 s) saturait
            # Elpis ; un toutes les 2 s, borné par ce qui reste du délai.
            vision = not target.describe or time.monotonic() - last_vision >= 2.0
            if vision:
                last_vision = time.monotonic()
            n = self._find_once(target, describe=vision,
                                vision_timeout=max(1.0, min(30.0, pat.deadline - time.monotonic())))
        self._waited_ms += int((time.monotonic() - started) * 1000)
        if pat.extended and n is not None:
            self.report.note(f"{target.label()} : apparu après {pat.elapsed():.0f} s (attente prolongée, l'écran bougeait)")
        self._heal(target, n)
        return n

    def _find_once(self, target: Target, describe: bool = True,
                   vision_timeout: float = 30.0) -> Optional[Dict[str, Any]]:
        """UNE lecture (arbre, puis repli visuel) qui ne lève jamais : un hoquet de
        l'arbre pendant une transition, un ``describe=`` sans réseau ou ``image=``
        sans numpy valent « pas encore trouvé » — l'attente et le repli ``at``/``rel``
        continuent au lieu d'abandonner l'action sur-le-champ."""
        try:
            n = self.find(target)
        except Exception as e:                # noqa: BLE001
            self._find_error = f"{type(e).__name__}: {e}"
            n = None
        if n is None and (target.image or (target.describe and describe)):
            try:
                n = self._find_visual(target, describe=describe, vision_timeout=vision_timeout)
            except Exception as e:            # noqa: BLE001
                self._find_error = f"{type(e).__name__}: {e}"
                n = None
        return n

    def _find_visual(self, target: Target, describe: bool = True,
                     vision_timeout: float = 30.0) -> Optional[Dict[str, Any]]:
        """Repli VISUEL : la vignette (``image=``) retrouvée par corrélation dans
        la capture, ou la vision d'Elpis (``describe=``, exige ELPIS_URL). Rend un
        pseudo-nœud {rect, role, name} pour que le reste du runtime (centre,
        rapport) ne change pas."""
        png = self.screenshot()
        if target.image:
            from . import visual
            path = target.image if os.path.isabs(target.image) else os.path.join(self.script_dir, target.image)
            hit = visual.locate_template(png, path)
            if hit is not None:
                self.resolved_by = "image"
                return {"role": target.role or "image", "name": target.name or os.path.basename(target.image),
                        "auto_id": "", "rect": list(hit["rect"]), "depth": 0, "states": [], "score": hit["score"]}
        if target.describe and describe:
            from . import visual
            hit = visual.locate_describe(png, target.describe, timeout=float(vision_timeout))
            if hit is not None:
                self.resolved_by = "describe"
                return {"role": target.role or "vision", "name": target.describe, "auto_id": "",
                        "rect": list(hit["rect"]), "depth": 0, "states": []}
        return None

    def exists(self, **kw) -> bool:
        t, _ = _split_target(kw)
        return self.find(t) is not None

    def value(self, **kw) -> str:
        t, _ = _split_target(kw)
        n = self.find(t)
        if n is None:
            raise StepError(f"valeur : cible introuvable {t.label()}")
        return self._text_of(n)

    def _text_of(self, n: Dict[str, Any]) -> str:
        """Valeur de l'arbre ; sinon, pour un document / champ de texte, le TEXTE
        lu à l'agent (TextPattern : Bloc-notes, RichEdit n'ont pas de ValuePattern)
        ; sinon le nom."""
        v = n.get("value")
        if v is not None and str(v) != "":
            return str(v)
        if _norm(n.get("role")) in ("document", "edit", "textbox", "text"):
            try:
                cx, cy = self._center(n)
                out = self._call("element_text", auto_id=str(n.get("auto_id") or ""), name=str(n.get("name") or ""),
                                 control_type=str(n.get("role") or ""), x=cx, y=cy) or {}
                if out.get("text") is not None:
                    return str(out["text"])
            except Exception:                 # noqa: BLE001 — agent sans element_text / pattern absent
                pass
        return _value_of(n)

    def state(self, which: str, **kw) -> bool:
        t, _ = _split_target(kw)
        n = self.find(t)
        if n is None:
            raise StepError(f"état : cible introuvable {t.label()}")
        return _norm(which) in {_norm(s) for s in (n.get("states") or [])}

    def count(self, role: str = "", contains: str = "") -> int:
        role, needle = _norm(role), _norm(contains)
        return sum(1 for n in self.tree()
                   if (not role or _norm(n.get("role")) == role)
                   and (not needle or needle in _norm(n.get("name"))))

    def snapshot(self) -> None:
        """Photographie l'arbre : ``wait.appear`` compare à cet état."""
        self.tree()

    def screenshot(self) -> bytes:
        png, _w, _h = self._call("screenshot")
        return png

    _cheap_capture: Optional[bool] = None

    def _activity_capture(self) -> bytes:
        """Capture pour JUGER L'ACTIVITÉ (réduite à 48×27) : un JPEG médiocre suffit et
        coûte bien moins qu'un PNG sans perte ; backend sans ``fmt`` : capture normale."""
        if self._cheap_capture is not False:
            try:
                img, _w, _h = self._call("screenshot", fmt="jpeg", quality=40)
                self._cheap_capture = True
                return img
            except TypeError:
                self._cheap_capture = False
        return self.screenshot()

    # ── actions ───────────────────────────────────────────────────────────
    def _act(self, label: str, fn, *, target: Optional[Target] = None, retry: Optional[int] = None,
             timeout: Optional[float] = None) -> Any:
        """Exécute une action, la journalise, la rejoue ``retry`` fois sur
        échec, puis applique la politique du bloc courant. ``timeout`` : délai
        d'attente de la cible pour CETTE action (sinon celui de la séance)."""
        started = time.monotonic()
        self._act_timeout = timeout
        rec = {"label": label, "target": target.label() if target else ""}
        ln = self._script_line()
        if ln:
            rec["line"] = ln
        self._waited_ms = 0
        self._healed = None
        self._step_target = None
        self.resolved_by = ""
        self._find_error = ""
        # L'arbre d'une étape PRÉCÉDENTE ne sert jamais de repère : ``window=`` + ``rel=``
        # calculait sinon le point sur la fenêtre d'avant (déplacée, fermée depuis).
        self._last_nodes = None
        if self.dry_run:
            return self._dry_act(rec, target)
        # ``retry=None`` : réessais de la séance ; ``retry=0`` écrit sur la ligne : aucun.
        attempts = max(1, int(self.default_retry if retry is None else retry) + 1)
        for i in range(attempts):
            self._healed = None               # une réparation vaut pour l'essai qui a réussi
            self.resolved_by = ""
            self._step_target = None
            self._last_nodes = None
            try:
                out = fn()
                rec.pop("error", None)        # succès (après un essai raté) : pas d'erreur résiduelle sur l'étape OK
                rec["method"] = (out or {}).get("method", "") if isinstance(out, dict) else ""
                rec["ms"] = int((time.monotonic() - started) * 1000)
                if self._waited_ms:
                    rec["waited_ms"] = self._waited_ms
                if self.resolved_by and target is not None:
                    rec["resolved_by"] = self.resolved_by
                if self._healed:
                    rec["healed"] = dict(self._healed)
                if i:
                    rec["attempts"] = i + 1
                self._trace_step(rec)
                self.report.step(rec, ok=True)
                if self.settle:
                    time.sleep(self.settle)
                return out
            except Exception as e:            # noqa: BLE001 — journalisé puis décidé par la politique
                rec["ms"] = int((time.monotonic() - started) * 1000)
                rec["error"] = f"{type(e).__name__}: {e}"
                if self._waited_ms:
                    rec["waited_ms"] = self._waited_ms
                # Cible introuvable après l'attente complète : le réessai IMPLICITE (de la
                # séance) ne relance pas une 2e attente ; un ``retry=`` écrit sur la ligne, si.
                # Geste envoyé EN PARTIE (``PartialInput``) : jamais rejoué, même avec ``retry=`` —
                # un double-clic rejoué devient un triple clic, une frappe se double.
                partial = type(e).__name__ == "PartialInput"
                if i + 1 < attempts and not partial and not (isinstance(e, TargetNotFound) and retry is None):
                    self.report.note(f"{label} : nouvel essai ({i + 2}/{attempts}) — {e}")
                    time.sleep(0.5)
                    continue
                rec["attempts"] = i + 1
                if self._find_error and isinstance(e, TargetNotFound):
                    rec["error"] += f" (dernière erreur de lecture : {self._find_error})"
                if self._healed:
                    rec["healed"] = dict(self._healed)
                self._trace_step(rec)
                self._fail(rec, e)
                return None

    def _script_line(self) -> int:
        """Ligne du SCRIPT (1-based) d'où vient l'action courante : première
        frame dont le fichier est le script lancé. 0 si inconnue. Le Studio s'en
        sert pour relier une étape du rapport à sa ligne dans l'éditeur."""
        try:
            script = os.path.abspath(sys.argv[0] or "")
            f = sys._getframe(2)
            depth = 0
            while f is not None and depth < 25:
                fn = os.path.abspath(f.f_code.co_filename or "")
                if script and fn == script:
                    return int(f.f_lineno)
                f = f.f_back
                depth += 1
        except Exception:                     # noqa: BLE001 — diagnostic seulement
            pass
        return 0

    def _dry_act(self, rec: Dict[str, Any], target: Optional[Target]) -> Any:
        """Vol à blanc : résout la cible (une lecture d'arbre, sans attendre),
        n'envoie rien. Journalise trouvée / introuvable et les stratégies essayées."""
        rec["dry"] = True
        if target is None or not (target.findable() or target.at is not None or target.rel is not None):
            rec["method"] = "sauté"
            self.report.step(rec, ok=True)
            return {"method": "dry"}
        n = self.find(target) if target.findable() else None
        if n is None and (target.image or target.describe):
            try:
                n = self._find_visual(target)
            except Exception as e:            # noqa: BLE001 — pas de vision ici : on le dit
                rec["note"] = f"visuel indisponible : {e}"
        rel = self._point_rel(target) if n is None else None
        p = self._center(n) if n is not None else (rel or target.at)
        rec["strategies"] = target.strategies()
        if n is not None:
            rec["method"] = "trouvé:" + (self.resolved_by or "?")
            self._heal(target, n)
            if self._healed:
                rec["healed"] = dict(self._healed)
            self._step_target = n
            self._trace_step(rec)
            self.report.step(rec, ok=True)
            return {"method": "dry", "point": p}
        if p is not None:
            rec["method"] = "point:" + ("rel" if rel else "at")
            self.report.step(rec, ok=True)
            return {"method": "dry", "point": p}
        rec["error"] = "introuvable (vol à blanc)"
        rec["method"] = "introuvable"
        self.report.step(rec, ok=False)
        return None

    def _trace_step(self, rec: Dict[str, Any]) -> None:
        """``trace`` : capture PNG + extrait d'arbre (cible, ancêtres, frères) par étape."""
        if not self.trace:
            return
        try:
            idx = len(self.report.steps) + 1
            png = self.screenshot()
            rec["trace_png"] = self.report.save_trace_png(png, idx)
            n = self._step_target
            nodes = self._last_nodes or []
            excerpt: List[Dict[str, Any]] = []
            box = None
            if n is not None:
                i = next((k for k, x in enumerate(nodes) if x is n), -1)
                if i >= 0:
                    fam = _ancestors(nodes, i)
                    pi = next((q for q, x in enumerate(nodes) if x is fam[-1]), -1) if fam else -1
                    sibs = _children(nodes, pi) if pi >= 0 else []
                    for x in fam + [n] + [sb for sb in sibs if sb is not n][:20]:
                        excerpt.append({"role": x.get("role"), "name": x.get("name"), "auto_id": x.get("auto_id"),
                                        "depth": x.get("depth"), "rect": x.get("rect"), "states": x.get("states"),
                                        "target": x is n})
                x, y, w, h = _rect(n)
                box = [x, y, w, h]
            rec["trace_tree"] = self.report.save_trace_json({"step": idx, "box": box, "nodes": excerpt}, idx)
            if box:
                rec["box"] = box
        except Exception as e:                # noqa: BLE001 — la trace est un bonus
            rec["trace_error"] = f"{type(e).__name__}: {e}"

    def _fail(self, rec: Dict[str, Any], exc: Exception) -> None:
        """Échec d'une étape : capture, journal, puis politique de la pile
        (``with s.step(on_error="continue")``) ou propagation."""
        try:
            rec["screenshot"] = self.report.save_png(self.screenshot(), rec.get("label", "etape"))
        except Exception:                     # noqa: BLE001 — la capture est un bonus
            pass
        self.report.step(rec, ok=False)
        pol = self._policy_stack[-1] if self._policy_stack else {}
        if pol.get("on_error") == "continue":
            return
        if isinstance(exc, (CheckFailed, StepError, NeedsVision)):
            raise exc
        raise StepError(rec["error"]) from exc

    def _point(self, t: Target) -> Optional[Tuple[int, int]]:
        if t.findable():
            n = self._find_wait(t)
            if n is not None:
                return self._center(n)
        p = self._point_rel(t, wait=not t.findable())    # rien d'autre n'a attendu la fenêtre
        if p is not None:
            self.resolved_by = "rel"
            self._heal_point(t, "rel")
            return p
        if t.at is not None:
            self.resolved_by = "at"
            self._heal_point(t, "at")
        return t.at

    def _heal_point(self, t: Target, by: str) -> None:
        if t.findable() and by != t.primary():
            self._healed = {"by": by, "suggest": ""}

    def _semantic(self, action: str, t: Target, node: Optional[Dict[str, Any]] = None,
                  presearched: bool = False, **extra) -> Dict[str, Any]:
        """Action par CONTROL PATTERN (agent : auto_id → name+type → coords).
        La cible est d'abord résolue ICI, dans l'arbre, AVEC attente (fenêtre qui
        s'ouvre, liste qui se remplit) : ``at`` / ``rel`` sont des replis, jamais
        une dispense d'attendre. L'agent reçoit l'identité COURANTE du nœud trouvé
        (auto_id, nom complet, rôle) et son centre — un nom partiel dans le script
        (« Enregistrer » pour « Enregistrer (Ctrl+S) ») ou un rôle omis (un élément
        de menu Qt se clique pour de vrai) ne font plus rater la re-résolution
        exacte côté agent. ``node`` : nœud déjà résolu par l'appelant (une seule
        lecture d'arbre)."""
        kw = dict(action=action, auto_id=t.auto_id, name=t.name, control_type=t.role)
        if t.at:
            kw["x"], kw["y"] = t.at
        n = node                              # nœud résolu ICI (UNE lecture d'arbre par essai)
        searched = node is not None or presearched
        if n is None and t.findable() and not presearched:
            searched = True
            n = self._find_wait(t)
        if n is not None:
            aid = str(n.get("auto_id") or "")
            if aid and self._last_nodes and sum(1 for x in self._last_nodes if str(x.get("auto_id") or "") == aid) > 1:
                aid = ""                      # auto_id partagé : l'agent départage par nom + point
            kw["auto_id"] = aid
            kw["name"] = str(n.get("name") or "") or t.name
            kw["control_type"] = str(n.get("role") or "") or t.role
            if self.resolved_by in ("image", "describe"):
                # Pseudo-nœud VISUEL (vignette, vision) : rien à re-résoudre dans l'arbre —
                # l'agent cherchait « ok.png » (rôle « image ») ~1 s avant de cliquer au point.
                kw["auto_id"] = kw["name"] = kw["control_type"] = ""
            kw["x"], kw["y"] = self._center(n)
        elif searched:
            p = self._point_rel(t)
            if p is not None:
                self.resolved_by = "rel"; self._heal_point(t, "rel")
                kw["x"], kw["y"] = p
            elif t.at is not None:            # ``at`` (déjà dans kw) = dernier repli, étape « réparée »
                self.resolved_by = "at"; self._heal_point(t, "at")
            elif not t.semantic():
                raise TargetNotFound(f"cible introuvable {t.label()}")
            # cible auto_id/nom absente de l'arbre, sans point : l'agent tente encore
            # sa propre re-résolution (pywinauto) ; NotSupported → introuvable.
        self._step_target = n
        kw.update(extra)
        try:
            out = self._call("element_action", **kw) or {"method": "pattern"}
            if isinstance(out, dict) and out.get("uncertain"):
                # Pattern appelé mais en échec APRÈS coup (Invoke bloqué par une boîte modale) :
                # l'action a sans doute eu lieu, l'agent n'a pas recliqué par-dessus.
                self.report.note(f"{action} {t.label()} : résultat incertain"
                                 + (f" ({out.get('error')})" if out.get("error") else ""))
            return out
        except Exception as e:                # noqa: BLE001 — Linux/best-effort : repli coordonnées
            if type(e).__name__ != "NotSupported":
                raise                         # dont ``PartialInput`` : jamais converti en clic
            # Le repli « clic au point » n'a de sens que pour ce qu'un clic accomplit :
            # cliquer, basculer, cocher, sélectionner. Un ``scroll_into_view`` ou un
            # ``collapse`` sans pattern devenait un clic qui OUVRAIT l'élément.
            if action not in _CLICK_FALLBACK_ACTIONS:
                if n is None and searched and kw.get("x") is None:
                    # Cible jamais trouvée (attente complète déjà faite) : « introuvable », pas une
                    # erreur ordinaire — sinon le réessai implicite relançait toute l'attente.
                    raise TargetNotFound(f"cible introuvable {t.label()}") from e
                raise StepError(f"{action} impossible sur {t.label()} : {e}") from e
            # Déjà cherché : pas de 2e lecture. ``at`` fourni sans recherche : on
            # préfère quand même l'élément TROUVÉ (``at`` n'est que le repli).
            if n is not None:
                p = self._center(n)
            elif searched:
                p = (kw.get("x"), kw.get("y")) if kw.get("x") is not None else t.at
            else:
                p = self._point(t)
            if p is None:
                raise TargetNotFound(f"cible introuvable {t.label()}") from e
            self._call("click", x=p[0], y=p[1], button=extra.get("button", "left"),
                       clicks=int(extra.get("clicks", 1) or 1))
            return {"method": "coords"}

    def click(self, button: str = "left", clicks: int = 1, modifiers: str = "", retry: Optional[int] = None,
              timeout: Optional[float] = None, **kw) -> Any:
        t, _ = _split_target(kw)
        verb = {1: "clic", 2: "double-clic", 3: "triple-clic"}.get(int(clicks), "clic")
        if button != "left":
            verb += f" {button}"

        def _do():
            if t.window and not t.window.startswith("#"):     # « #auto_id » = ancre de ``rel``, pas un titre
                self._front(t.window)
            if t.findable() and not modifiers:
                return self._semantic("click", t, button=button, clicks=int(clicks))
            p = self._point(t)
            if p is None:
                raise TargetNotFound(f"cible introuvable {t.label()}")
            self._call("click", x=p[0], y=p[1], button=button, clicks=int(clicks), modifiers=modifiers)
            return {"method": "coords"}
        return self._act(f"{verb} {t.label()}", _do, target=t, retry=retry, timeout=timeout)

    def double_click(self, **kw) -> Any:
        return self.click(clicks=2, **kw)

    def right_click(self, **kw) -> Any:
        return self.click(button="right", **kw)

    def set_value(self, text: str, retry: Optional[int] = None, timeout: Optional[float] = None, **kw) -> Any:
        t, _ = _split_target(kw)

        def _do():
            if t.window and not t.window.startswith("#"):
                self._front(t.window)
            n = self._find_wait(t) if t.findable() else None
            self._step_target = n
            if n is not None or t.semantic():
                # Identité COURANTE du nœud (nom complet, rôle, auto_id s'il est unique)
                # + son centre : sans elles, l'agent prenait le premier homonyme visible
                # du bureau (un champ « Nom » d'une autre fenêtre) et l'étape se disait OK.
                aid, nm, ct, pt = t.auto_id, t.name, t.role, None
                if n is not None:
                    aid = str(n.get("auto_id") or "")
                    if aid and sum(1 for x in (self._last_nodes or []) if str(x.get("auto_id") or "") == aid) > 1:
                        aid = ""
                    nm = str(n.get("name") or "") or t.name
                    ct = str(n.get("role") or "") or t.role
                    pt = self._center(n)
                try:
                    try:
                        kw = dict(auto_id=aid, name=nm, control_type=ct, text=str(text))
                        if pt is not None:
                            kw.update(x=pt[0], y=pt[1])
                        return self._call("set_value", **kw) or {"method": "value"}
                    except TypeError:         # agent sans x/y sur set_value
                        return self._call("set_value", auto_id=aid, name=nm, control_type=ct,
                                          text=str(text)) or {"method": "value"}
                except Exception as e:        # noqa: BLE001
                    if type(e).__name__ != "NotSupported":
                        raise
            p = self._center(n) if n is not None else (self._point_rel(t, wait=not t.findable()) or t.at)
            if p is None:
                raise TargetNotFound(f"cible introuvable {t.label()}")
            self._call("click", x=p[0], y=p[1], button="left", clicks=1)
            self._call("key", keys="ctrl+a")
            self._call("type_text", text=str(text))
            return {"method": "coords+type"}
        return self._act(f"saisir « {text} » dans {t.label()}", _do, target=t, retry=retry, timeout=timeout)

    def type(self, text: str, retry: Optional[int] = None) -> Any:
        return self._act(f"taper « {text} »", lambda: self._call("type_text", text=str(text)), retry=retry)

    def key(self, keys: str, retry: Optional[int] = None) -> Any:
        return self._act(f"touche {keys}", lambda: self._call("key", keys=str(keys)), retry=retry)

    def paste(self, text: str, retry: Optional[int] = None) -> Any:
        def _do():
            self._call("clipboard_set", text=str(text))
            self._call("key", keys="ctrl+v")
        return self._act(f"coller « {text[:40]} »", _do, retry=retry)

    def copy(self, retry: Optional[int] = None, timeout: float = 2.0) -> str:
        """Ctrl+C puis lecture du presse-papiers — SONDÉ jusqu'à ce qu'il change
        (jeton posé avant) : une appli lente ne l'a pas encore rempli 150 ms après."""
        def _do():
            token: Optional[str] = f"\u200b{time.time_ns()}"
            try:
                self._call("clipboard_set", text=token)
            except Exception:                 # noqa: BLE001 — presse-papiers occupé : sans jeton
                token = None
            self._call("key", keys="ctrl+c")
            deadline = time.monotonic() + float(timeout)
            txt = ""
            while True:
                time.sleep(0.1)
                try:
                    txt = str(self._call("clipboard_get") or "")
                except Exception:             # noqa: BLE001 — occupé par l'appli qui écrit : on réessaie
                    txt = ""
                if (token is None and txt) or (token is not None and txt != token and txt != ""):
                    break
                if time.monotonic() >= deadline:
                    if token is not None and txt == token:
                        txt = ""
                    break
            return {"text": txt, "method": "clipboard" if txt else "vide"}
        out = self._act("copier la sélection", _do, retry=retry)
        return (out or {}).get("text", "")

    def scroll(self, dy: int, retry: Optional[int] = None, timeout: Optional[float] = None, **kw) -> Any:
        t, _ = _split_target(kw)

        targeted = bool(t.findable() or t.at or (t.rel is not None and t.window))

        def _do():
            p = self._point(t) if targeted else None
            if targeted and p is None:
                # Molette « au centre de l'écran » à la place de la liste visée : la carte
                # zoomait et l'étape se disait réussie.
                raise TargetNotFound(f"cible introuvable {t.label()}")
            self._call("scroll", x=p[0] if p else None, y=p[1] if p else None, dy=int(dy))
        return self._act(f"défiler {dy}", _do, target=t if targeted else None, retry=retry, timeout=timeout)

    def move(self, retry: Optional[int] = None, timeout: Optional[float] = None, **kw) -> Any:
        t, _ = _split_target(kw)

        def _do():
            p = self._point(t)
            if p is None:
                raise TargetNotFound(f"cible introuvable {t.label()}")
            self._call("move", x=p[0], y=p[1])
        return self._act(f"pointer {t.label()}", _do, target=t, retry=retry, timeout=timeout)

    def drag(self, to: Tuple[int, int], modifiers: str = "", retry: Optional[int] = None, timeout: Optional[float] = None, **kw) -> Any:
        t, _ = _split_target(kw)

        def _do():
            p = self._point(t)
            if p is None:
                raise TargetNotFound(f"cible introuvable {t.label()}")
            self._call("drag", x1=p[0], y1=p[1], x2=int(to[0]), y2=int(to[1]), modifiers=modifiers)
        return self._act(f"glisser {t.label()} → ({to[0]},{to[1]})", _do, target=t, retry=retry, timeout=timeout)

    def _pattern(self, action: str, retry: Optional[int] = None, timeout: Optional[float] = None, **kw) -> Any:
        t, _ = _split_target(kw)
        return self._act(f"{action} {t.label()}", lambda: self._semantic(action, t), target=t, retry=retry, timeout=timeout)

    def toggle(self, **kw): return self._pattern("toggle", **kw)

    # check/uncheck = amener à un ÉTAT, pas un clic aveugle : si l'arbre dit
    # déjà « checked » (ou « unchecked »), on ne touche à rien — sinon un script
    # rejoué sur une appli déjà dans le bon état INVERSAIT la case (vu sur la VM :
    # la console Python, déjà visible, se refermait au 2e passage).
    def _toggle_to(self, want: bool, retry: Optional[int] = None, timeout: Optional[float] = None, **kw) -> Any:
        t, _ = _split_target(kw)
        action = "check" if want else "uncheck"

        def _do():
            n = self._find_wait(t)
            if n is not None:
                st = {_norm(x) for x in (n.get("states") or [])}
                # « indeterminate » (case à 3 états) est un état CONNU : sans lui dans le
                # test, « uncheck » d'une case indéterminée se disait fait sans vérification.
                if "checked" in st or "unchecked" in st or "indeterminate" in st:
                    if "indeterminate" not in st and ("checked" in st) == want:
                        return {"method": "already"}
                    out = self._semantic(action, t, node=n)     # nœud transmis : pas de 2e lecture
                    # L'état est CONNU : on le VÉRIFIE. Vu sur la VM (QGIS 3.44, couche du
                    # panneau Couches) : Toggle réussit sans rien changer — « uncheck » se
                    # disait fait, la couche restait visible.
                    if self._state_reached(t, want, within=1.0):   # un Toggle effectif se voit en < 1 s
                        return out
                    x, y = self._check_indicator(n)
                    # 3 états : un clic avance d'un cran dans le cycle (coché → indéterminé →
                    # décoché) — il peut en falloir deux. Case à 2 états : un seul, jamais un
                    # 2e qui défairait un 1er simplement lent à se voir.
                    for k in range(2):
                        self._call("click", x=x, y=y, button="left", clicks=1)
                        if self._state_reached(t, want):
                            return {"method": "clic:case"}
                        if k == 0 and not ("indeterminate" in st or self._has_state(t, "indeterminate")):
                            break
                    raise StepError(f"{action} sans effet sur {t.label()} : l'état n'a pas changé")
                return self._semantic(action, t, node=n)
            return self._semantic(action, t, presearched=t.findable())   # déjà attendue : repli direct
        return self._act(f"{action} {t.label()}", _do, target=t, retry=retry, timeout=timeout)

    def _state_reached(self, t: Target, want: bool, within: float = 2.0) -> bool:
        """L'élément a-t-il atteint l'état coché/décoché voulu (relu dans l'arbre) ?"""
        deadline = time.monotonic() + within
        while True:
            try:
                n = self.find(t)
            except Exception:                 # noqa: BLE001 — hoquet de lecture : on relit
                n = None
            if n is not None:
                st = {_norm(x) for x in (n.get("states") or [])}
                if ("checked" in st or "unchecked" in st) and ("checked" in st) == want:
                    return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.25)

    def _has_state(self, t: Target, which: str) -> bool:
        try:
            n = self.find(t)
        except Exception:                     # noqa: BLE001
            return False
        return n is not None and _norm(which) in {_norm(x) for x in (n.get("states") or [])}

    @staticmethod
    def _check_indicator(n: Dict[str, Any]) -> Tuple[int, int]:
        """Point de la CASE d'un élément cochable : son centre pour une case ou un bouton ;
        pour un élément d'arbre / de liste (case dessinée à gauche, sans élément propre
        dans l'arbre), le carré de la hauteur de la ligne au bord gauche."""
        x, y, w, h = _rect(n)
        if _norm(n.get("role")) in ("treeitem", "listitem", "dataitem"):
            side = max(8, min(h, 24))
            return int(x + side / 2), int(y + h / 2)
        return int(x + w / 2), int(y + h / 2)

    def check(self, **kw): return self._toggle_to(True, **kw)
    def uncheck(self, **kw): return self._toggle_to(False, **kw)
    def select(self, **kw): return self._pattern("select", **kw)
    def expand(self, **kw): return self._pattern("expand", **kw)
    def collapse(self, **kw): return self._pattern("collapse", **kw)
    def scroll_into_view(self, **kw): return self._pattern("scroll_into_view", **kw)

    def launch(self, app: str, args: str = "", wait_window: str = "", timeout: Optional[float] = None,
               retry: Optional[int] = None) -> Any:
        tmo = float(self.default_timeout if timeout is None else timeout)
        # Avec ``wait_window`` : le lancement n'attend PAS tout le délai une nouvelle fenêtre
        # (appli à instance unique, onglet d'un navigateur déjà ouvert : jamais de nouvelle
        # fenêtre → ``TIMEOUT`` perdu, puis encore ``TIMEOUT`` d'attente) — l'attente nommée
        # qui suit s'en charge, patiente tant que l'écran bouge.
        launch_s = min(tmo, 5.0) if wait_window else tmo
        # Pas de réessai implicite : relancer ouvrait une 2e instance de l'application.
        out = self._act(f"lancer {app}", lambda: self._call("launch", target=str(app), args=str(args),
                                                            timeout_ms=int(launch_s * 1000)), retry=retry or 0)
        if wait_window:
            self.wait.window(wait_window, timeout=tmo)
        elif isinstance(out, dict) and out.get("found") is False:
            # Lancé, mais aucune fenêtre prête dans le délai : l'étape reste « OK » (le
            # processus est parti) — on le DIT, c'est souvent la cause d'un clic suivant raté.
            self.report.note(f"lancer {app} : aucune fenêtre prête après {tmo:g} s"
                             + (f" ({out.get('hint')})" if out.get("hint") else "")
                             + " — ajoutez wait_window=\"Titre\" ou s.wait.window(\"Titre\", timeout=…)")
        return out

    def _windows(self, include_desktop: bool = True) -> List[Dict[str, Any]]:
        """Fenêtres visibles de l'agent, bureau (« Program Manager ») compris
        quand l'agent le sait faire : un script enregistré sur une icône du
        bureau porte ``window="Program Manager"`` et doit rester rejouable."""
        try:
            out = self._call("list_windows", include_desktop=bool(include_desktop))
        except TypeError:                     # agent plus ancien : liste sans le bureau
            out = self._call("list_windows")
        return list((out or {}).get("windows") or [])

    @staticmethod
    def _find_win(wins: List[Dict[str, Any]], window: str) -> Optional[Dict[str, Any]]:
        return _first_title_match(wins, window, key="title")

    def _front(self, window: str) -> bool:
        """Premier plan AVANT une action ciblée ``window=`` — BEST EFFORT, jamais
        une panne : la cible est de toute façon résolue dans l'arbre de tout
        l'écran. Une fenêtre déjà devant n'est pas ré-activée (pas de
        clignotement, pas de verrou anti-focus-stealing réveillé) ; une fenêtre
        absente de la liste (bureau sans agent récent, titre changé) vaut UNE
        note dans le rapport, puis l'étape continue."""
        try:
            hit = self._find_win(self._windows(), window)
        except Exception:                     # noqa: BLE001 — agent sans list_windows
            return False
        if hit is None:
            if window not in self._front_missing:
                self._front_missing.add(window)
                self.report.note(f"fenêtre /{window}/ non listée : cible cherchée sur tout l'écran")
            return False
        if hit.get("is_foreground"):
            return True
        try:
            self._call("window_action", action="activate", hwnd=int(hit.get("hwnd") or 0))
            time.sleep(0.15)
        except Exception as e:                # noqa: BLE001 — activation refusée : on continue quand même
            if window not in self._front_missing:
                self._front_missing.add(window)
                self.report.note(f"fenêtre /{window}/ non activée ({e}) : on continue")
            return False
        return True

    def focus(self, window: str = "", hwnd: int = 0, retry: Optional[int] = None) -> Any:
        """Met une fenêtre au premier plan : par HWND, ou par titre (regex,
        insensible à la casse) parmi les fenêtres visibles (bureau compris)."""
        if not int(hwnd or 0) and not str(window or "").strip():
            raise StepError("premier plan : titre de fenêtre vide (window=\"Titre\" ou hwnd=…)")

        def _do():
            h = int(hwnd or 0)
            if not h:
                hit = self._find_win(self._windows(), window)
                if hit is None:
                    raise StepError(f"fenêtre introuvable /{window}/")
                if hit.get("is_foreground"):
                    return {"method": "already"}      # rien à faire : aucune entrée synthétique
                h = int(hit.get("hwnd") or 0)
            return self._call("window_action", action="activate", hwnd=h) or {"method": "activate"}
        return self._act(f"premier plan /{window or hwnd}/", _do, retry=retry)

    def close(self, window: str = "", timeout: Optional[float] = None) -> Any:
        """Ferme la fenêtre (la croix) et attend qu'elle ait DISPARU : une boîte
        « enregistrer ? » qui la retient est un échec dit, pas un succès muet."""
        if not str(window or "").strip():
            raise StepError("fermer : titre de fenêtre vide (s.close(window=\"Titre\"))")

        def _do():
            hit = _first_title_match(self._windows(include_desktop=False), window, key="title", strict=True)
            if hit is None:
                raise StepError(f"fenêtre introuvable /{window}/")
            out = self._call("window_action", action="close", hwnd=int(hit.get("hwnd") or 0)) or {}
            self._wait_closed(int(hit.get("hwnd") or 0), window, timeout)
            return out
        return self._act(f"fermer /{window}/", _do, retry=0)     # un 2e WM_CLOSE n'aide pas une boîte « enregistrer ? »

    def _wait_closed(self, hwnd: int, window: str, timeout: Optional[float] = None) -> None:
        # Délai sans activité (10 s au plus par défaut : une boîte « enregistrer ? »
        # immobile échoue vite), prolongé tant que l'écran bouge (appli lourde qui
        # sauvegarde, se décharge), jusqu'à ``patience``.
        tmo = float(timeout if timeout is not None else min(self.default_timeout, 10.0))
        pat = _Patience(self, tmo, self.patience)
        while True:
            if not any(int(w.get("hwnd") or 0) == hwnd for w in self._windows(include_desktop=False)):
                return
            if pat.expired():
                break
            time.sleep(0.25)
        raise StepError(f"fenêtre /{window}/ toujours ouverte : {pat.why()} (une boîte de dialogue la retient ?)")

    # ── préconditions ─────────────────────────────────────────────────────
    def require(self, window: str = "", launch: str = "", timeout: Optional[float] = None,
                gone: str = "", checked: Optional[bool] = None, **target) -> Any:
        """État de DÉPART garanti, pas supposé :
          • ``require(window="titre", launch="app.exe")`` : la fenêtre existe (sinon
            lancée si ``launch``) et passe au premier plan ;
          • ``require(gone="titre")`` : la fenêtre est fermée si elle existe ;
          • ``require(checked=True, name="…")`` : la case est dans cet état
            (``check``/``uncheck`` idempotents).
        Journalisé « précondition ». Sur un rejeu, c'est ce qui remplace « on
        suppose que l'appli est comme au moment de l'enregistrement »."""
        tmo = float(self.default_timeout if timeout is None else timeout)
        out: Any = None
        if window:
            def _win():
                hit = self._find_win(self._windows(), window)
                if hit is None and launch:
                    self._call("launch", target=str(launch), args="", timeout_ms=int(min(tmo, 5.0) * 1000))
                    pat = _Patience(self, tmo, self.patience)
                    while hit is None and not pat.expired():
                        time.sleep(0.5)
                        hit = self._find_win(self._windows(), window)
                if hit is None:
                    raise StepError(f"précondition : fenêtre /{window}/ absente" + (" (lancement sans effet)" if launch else ""))
                if not hit.get("is_foreground"):
                    self._call("window_action", action="activate", hwnd=int(hit.get("hwnd") or 0))
                return {"method": "launch+activate" if launch else "activate"}
            out = self._act(f"précondition : fenêtre /{window}/ au premier plan", _win, retry=0)
        if gone:
            def _gone():
                hit = _first_title_match(self._windows(include_desktop=False), gone, key="title", strict=True)
                if hit is None:
                    return {"method": "already"}
                self._call("window_action", action="close", hwnd=int(hit.get("hwnd") or 0))
                self._wait_closed(int(hit.get("hwnd") or 0), gone, tmo)
                return {"method": "close"}
            out = self._act(f"précondition : fenêtre /{gone}/ fermée", _gone, retry=0)
        if checked is not None:
            out = self._toggle_to(bool(checked), timeout=timeout, **target)
        return out

    def run(self, command: str, shell: str = "", timeout: float = 120.0) -> Dict[str, Any]:
        return self._act(f"commande « {command[:50]} »",
                         lambda: self._call("run_command", command=str(command), shell=str(shell),
                                            timeout_ms=int(timeout * 1000)))

    def note(self, text: str) -> None:
        self.report.note(str(text))

    def sees(self, text: str) -> bool:
        """Le texte est-il visible à l'écran ? (OCR — exige Elpis.)"""
        raise NeedsVision(f"lire « {text} » à l'écran exige la vision/OCR d'Elpis")

    # ── politique d'erreur par bloc ────────────────────────────────────────
    @contextmanager
    def step(self, label: str = "", on_error: str = "abort"):
        """``with s.step("valider", on_error="continue"):`` — un échec dans le
        bloc est journalisé puis AVALÉ (``continue``) ou propagé (``abort``).
        Les réessais d'une action se demandent sur l'action (``retry=2``) :
        un bloc ``with`` ne peut pas rejouer son corps."""
        self._policy_stack.append({"on_error": "abort"})     # le bloc décide LUI-MÊME
        try:
            yield
        except Exception as e:                # noqa: BLE001
            # « continue » avale les échecs d'ÉTAPE, pas les erreurs du script (faute de
            # frappe ``nam=``, regex invalide, NameError) : rendues muettes, le script se
            # disait réussi avec 0 étape.
            if on_error != "continue" or not isinstance(e, (StepError, CheckFailed, NeedsVision)):
                raise
            self.report.note(f"{label or 'bloc'} : échec ignoré ({type(e).__name__}: {e})")
        finally:
            self._policy_stack.pop()

    # ── fin ───────────────────────────────────────────────────────────────
    def finish(self) -> int:
        """Écrit le rapport et rend le code de sortie : 0 ok, 1 vérification
        échouée, 2 erreur d'exécution."""
        code = self.report.exit_code()
        self.report.finish(code)
        return code


# ── Attentes ──────────────────────────────────────────────────────────────────
_READY_GRACE = 5.0     # s : une fenêtre présente mais « pas prête » a encore ce délai pour le devenir


class _Wait:
    def __init__(self, s: Session):
        self.s = s

    def _poll(self, label: str, pred, timeout: Optional[float], every: float = 0.4) -> bool:
        tmo = float(self.s.default_timeout if timeout is None else timeout)
        started = time.monotonic()
        ok = False
        if self.s.dry_run:                    # vol à blanc : une lecture, jamais d'attente ni d'échec
            try:
                ok = bool(pred())
            except Exception:                 # noqa: BLE001
                ok = False
            self.s.report.step({"label": label, "ms": int((time.monotonic() - started) * 1000), "wait": True,
                                "dry": True, "method": "trouvé" if ok else "absent maintenant"}, ok=True)
            return ok
        pat = _Patience(self.s, tmo, self.s.patience)
        while True:
            try:
                ok = bool(pred())
            except Exception:                 # noqa: BLE001 — l'arbre peut hoqueter pendant une transition
                ok = False
            if ok or pat.expired():
                break
            time.sleep(every)
        rec = {"label": label, "ms": int((time.monotonic() - started) * 1000), "wait": True}
        if pat.extended:
            rec["method"] = "attente prolongée (écran actif)"
        ln = self.s._script_line()
        if ln:
            rec["line"] = ln
        if ok:
            self.s.report.step(rec, ok=True)
        else:
            rec["error"] = pat.why()
            self.s._fail(rec, CheckFailed(rec["error"] + " : " + label))
        return ok

    def window(self, title: str, timeout: Optional[float] = None, ready: bool = True) -> bool:
        if not str(title or "").strip():
            # (l'union vide reconnaissait n'importe quelle fenêtre : l'attente réussissait tout de suite)
            raise StepError("wait.window : titre vide (« . » pour n'importe quelle fenêtre)")
        tmo = float(self.s.default_timeout if timeout is None else timeout)
        if self.s.dry_run:
            return self._poll(f"fenêtre /{title}/", lambda: self.s._find_win(self.s._windows(), title) is not None, tmo)
        started = time.monotonic()
        pat = _Patience(self.s, tmo, self.s.patience)
        found = False
        title_re = _pywinauto_title_re(title)
        last_err = ""
        present_since: Optional[float] = None   # fenêtre vue mais pas « prête » depuis…
        not_ready = False
        while True:
            try:                              # tranches COURTES côté agent : l'échéance patiente vit ici
                out = self.s._call("wait_window", title_re=title_re, ready=bool(ready), timeout_ms=1500) or {}
                found = bool(out.get("found", True))
                if found and ready and out.get("ready") is False:
                    # Présente mais pas prête (fenêtre principale désactivée par une boîte
                    # de démarrage, appli occupée) : on laisse encore ``_READY_GRACE`` s pour
                    # qu'elle le devienne, puis on rend la main — la fenêtre EST là, et
                    # l'action suivante attend sa propre cible.
                    now = time.monotonic()
                    present_since = present_since if present_since is not None else now
                    if now - present_since < _READY_GRACE and not pat.expired():
                        found = False
                        time.sleep(0.3)
                        continue
                    not_ready = True
            except Exception as e:            # noqa: BLE001 — Linux / agent sans pywinauto : la liste des fenêtres
                if type(e).__name__ in ("NotSupported", "ImportError", "ModuleNotFoundError"):
                    return self._poll(f"fenêtre /{title}/", lambda: self.s._find_win(self.s._windows(), title) is not None,
                                      max(0.1, tmo - (time.monotonic() - started)))
                # Hoquet COM/UIA pendant qu'une appli lourde se charge (serveur RPC
                # occupé, fenêtre recréée) : on continue d'attendre au lieu d'abandonner
                # tout le script sur une exception brute.
                found = False
                last_err = f"{type(e).__name__}: {e}"
                time.sleep(0.3)
            if found or pat.expired():
                break
        rec = {"label": f"fenêtre /{title}/", "ms": int((time.monotonic() - started) * 1000), "wait": True}
        if pat.extended:
            rec["method"] = "attente prolongée (écran actif)"
        if found and not_ready:
            rec["method"] = "présente, pas encore prête"
        ln = self.s._script_line()
        if ln:
            rec["line"] = ln
        if found:
            self.s.report.step(rec, ok=True)
        else:
            rec["error"] = "fenêtre absente : " + pat.why() + (f" (dernière erreur : {last_err})" if last_err else "")
            self.s._fail(rec, CheckFailed(rec["error"]))
        return found

    def element(self, timeout: Optional[float] = None, state: str = "exists", **kw) -> bool:
        t, _ = _split_target(kw)
        def _ok():
            n = self.s.find(t)
            if n is None:
                return False
            return (state == "exists" or state in ("visible", "ready")
                    or _norm(state) in {_norm(x) for x in (n.get("states") or [])})
        return self._poll(f"attend {t.label()} ({state})", _ok, timeout)

    def gone(self, timeout: Optional[float] = None, **kw) -> bool:
        t, _ = _split_target(kw)
        return self._poll(f"attend la disparition de {t.label()}", lambda: self.s.find(t) is None, timeout)

    def stable(self, timeout: Optional[float] = None, quiet: float = 1.0, threshold: int = 6) -> bool:
        """L'écran ne bouge plus pendant ``quiet`` s (signature dHash)."""
        tmo = float(self.s.default_timeout if timeout is None else timeout)
        started = time.monotonic()
        if self.s.dry_run:
            self.s.report.step({"label": "écran stable", "ms": 0, "wait": True, "dry": True, "method": "sauté"}, ok=True)
            return True
        deadline = started + tmo
        last, since = "", time.monotonic()
        ok = False
        while time.monotonic() < deadline:
            sig = _dhash(self.s.screenshot())
            if last and _hamming(last, sig) <= threshold:
                if time.monotonic() - since >= quiet:
                    ok = True
                    break
            else:
                since = time.monotonic()
            last = sig
            time.sleep(0.3)
        rec = {"label": "écran stable", "ms": int((time.monotonic() - started) * 1000), "wait": True}
        self.s.report.step(rec, ok=True)       # best-effort : jamais bloquant, comme au serveur
        return ok

    def appear(self, timeout: Optional[float] = None, min_new: int = 1) -> bool:
        """Quelque chose de NOUVEAU par rapport au dernier ``snapshot()``/arbre lu."""
        base = set(self.s._last_keys or ())

        def _new():
            keys = {self.s._key(n) for n in self.s.tree()}
            return len(keys - base) >= int(min_new)
        return self._poll("apparition d'éléments", _new, timeout)

    def seconds(self, seconds: float) -> bool:
        """Pause de durée FIXE (``s.wait.seconds(20)``), journalisée. À préférer : une
        attente nommée (``wait.element`` / ``wait.window``) qui rend la main dès que
        c'est prêt. La pause sert quand rien d'observable ne signale la fin (calcul en
        arrière-plan, animation sans élément). Vol à blanc : sautée."""
        try:
            sec = float(seconds)
        except (TypeError, ValueError):
            raise TypeError(f"wait.seconds : durée invalide {seconds!r}") from None
        if sec < 0 or sec != sec:
            raise TypeError(f"wait.seconds : durée invalide {seconds!r}")
        rec = {"label": f"pause {sec:g} s", "wait": True}
        ln = self.s._script_line()
        if ln:
            rec["line"] = ln
        if self.s.dry_run:
            rec.update(ms=0, dry=True, method="sauté")
            self.s.report.step(rec, ok=True)
            return True
        started = time.monotonic()
        time.sleep(sec)
        rec["ms"] = int((time.monotonic() - started) * 1000)
        self.s.report.step(rec, ok=True)
        return True

    def text(self, text: str, timeout: Optional[float] = None, gone: bool = False) -> bool:
        raise NeedsVision(f"attendre le texte « {text} » exige la vision/OCR d'Elpis")


# ── Vérifications ─────────────────────────────────────────────────────────────
class _Expect:
    def __init__(self, s: Session):
        self.s = s

    def exists(self, timeout: Optional[float] = None, **kw) -> bool:
        return self.s.wait.element(timeout=timeout, **kw)

    def gone(self, timeout: Optional[float] = None, **kw) -> bool:
        return self.s.wait.gone(timeout=timeout, **kw)

    def value(self, contains: Optional[str] = None, equals: Optional[str] = None,
              regex: Optional[str] = None, timeout: Optional[float] = None,
              negate: bool = False, **kw) -> bool:
        t, _ = _split_target(kw)
        if regex is not None:
            try:
                re.compile(regex)
            except re.error as e:             # sinon avalée par _poll : « délai dépassé » trompeur
                raise TypeError(f"expect.value : regex invalide {regex!r} ({e})") from None

        def _ok():
            n = self.s.find(t)
            if n is None:
                return False
            v = self.s._text_of(n)
            if equals is not None:
                hit = _norm(v) == _norm(equals)
            elif regex is not None:
                hit = re.search(regex, v) is not None
            else:
                hit = _norm(contains or "") in _norm(v)
            return (not hit) if negate else hit
        want = equals if equals is not None else (regex if regex is not None else contains)
        return self.s.wait._poll(f"{t.label()} {'ne vaut pas' if negate else 'vaut'} « {want} »", _ok, timeout)

    def state(self, which: str, expected: bool = True, timeout: Optional[float] = None, **kw) -> bool:
        t, _ = _split_target(kw)
        return self.s.wait._poll(
            f"{t.label()} est {'' if expected else 'non '}{which}",
            lambda: (lambda n: n is not None and
                     ((_norm(which) in {_norm(x) for x in (n.get('states') or [])}) == bool(expected)))(self.s.find(t)),
            timeout)

    def count(self, role: str = "", contains: str = "", op: str = ">=", n: int = 1,
              timeout: Optional[float] = None) -> bool:
        ops = {"==": lambda a, b: a == b, ">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b,
               ">": lambda a, b: a > b, "<": lambda a, b: a < b, "!=": lambda a, b: a != b}
        f = ops.get(op, ops[">="])
        return self.s.wait._poll(f"compte {role or '*'} {op} {n}",
                                 lambda: f(self.s.count(role=role, contains=contains), int(n)), timeout)

    def text(self, text: str, timeout: Optional[float] = None) -> bool:
        raise NeedsVision(f"vérifier le texte « {text} » exige la vision/OCR d'Elpis")
