# SPDX-License-Identifier: MIT
"""office/elpis_office/_docx/lecture.py — ce que docx_read montre d'un document réel : mise en forme en Markdown, listes, champs de page, révisions, commentaires, notes, zones de texte."""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import parse_xml

from .docio import inline_runs
from .ooxml.util import qn

_R, _P, _SDT, _SDT_CONTENT = qn("w:r"), qn("w:p"), qn("w:sdt"), qn("w:sdtContent")
_FLD_SIMPLE, _FLD_CHAR, _INSTR = qn("w:fldSimple"), qn("w:fldChar"), qn("w:instrText")
_HYPERLINK, _TXBX = qn("w:hyperlink"), qn("w:txbxContent")
_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
_CONTENEURS = frozenset(qn(f"w:{t}") for t in ("hyperlink", "ins", "moveTo", "smartTag", "customXml", "dir", "bdo"))
_FAUX = frozenset({"0", "false", "off", "none"})
_MONO = frozenset({"consolas", "courier new", "courier", "menlo", "monaco", "lucida console", "cascadia code",
                   "cascadia mono", "source code pro", "dejavu sans mono", "liberation mono", "fira code"})
_CHAMPS_PAGE = {"PAGE": "{PAGE}", "NUMPAGES": "{NUMPAGES}", "SECTIONPAGES": "{SECTIONPAGES}"}
_ECHAPPER = re.compile(r"([\\`*_\[\]~^])")
_ORDRE = (("bold", "**"), ("italic", "*"), ("strike", "~~"), ("sub", "~"), ("sup", "^"))
_TEXTE_MAX = 300


def _vrai(element: Any) -> Optional[bool]:
    """État d'une bascule OOXML (w:b, w:i…) : absente → None, w:val="0" → False."""
    if element is None:
        return None
    return (element.get(qn("w:val")) or "true").lower() not in _FAUX


def _nom_champ(instruction: str) -> str:
    mots = instruction.strip().split()
    return mots[0].upper() if mots else ""


def _texte(element: Any) -> str:
    return "\n".join(p.text for p in element.iter(_P)).strip()


def _court(texte: str, n: int = _TEXTE_MAX) -> str:
    return texte if len(texte) <= n else texte[:n] + "…"


class Lecteur:
    """Styles, numérotations et liens d'un document, lus une fois par lecture."""

    def __init__(self, document: Any) -> None:
        self.document, self.part = document, document.part
        car: Dict[str, Tuple[Optional[str], Optional[bool], Optional[bool]]] = {}
        par: Dict[str, Tuple[Optional[str], Optional[Tuple[Optional[str], Optional[str]]]]] = {}
        for style in document.styles.element.iterchildren(qn("w:style")):
            sid, genre = style.get(qn("w:styleId")), style.get(qn("w:type"))
            base = style.find(qn("w:basedOn"))
            parent = base.get(qn("w:val")) if base is not None else None
            if sid and genre == "character":
                rpr = style.find(qn("w:rPr"))
                car[sid] = (parent, _vrai(rpr.find(qn("w:b"))) if rpr is not None else None,
                            _vrai(rpr.find(qn("w:i"))) if rpr is not None else None)
            elif sid and genre in (None, "paragraph"):
                num = style.find(f"{qn('w:pPr')}/{qn('w:numPr')}")
                par[sid] = (parent, None if num is None else _num_pr(num))
        self._car, self._par = car, par
        self._marques_style: Dict[str, Tuple[bool, bool]] = {}
        self._formats = self._numerotation()

    def _numerotation(self) -> Dict[str, Dict[str, str]]:
        racine = partie(self.document, RT.NUMBERING)
        if racine is None:
            return {}
        abstraits: Dict[str, Dict[str, str]] = {}
        for ab in racine.iterchildren(qn("w:abstractNum")):
            abstraits[ab.get(qn("w:abstractNumId")) or ""] = _niveaux(ab)
        formats: Dict[str, Dict[str, str]] = {}
        for num in racine.iterchildren(qn("w:num")):
            ref = num.find(qn("w:abstractNumId"))
            niveaux = dict(abstraits.get(ref.get(qn("w:val")) if ref is not None else "", {}))
            for surcharge in num.iterchildren(qn("w:lvlOverride")):
                lvl = surcharge.find(qn("w:lvl"))
                if lvl is not None:
                    niveaux.update(_niveaux_de([lvl], surcharge.get(qn("w:ilvl"))))
            formats[num.get(qn("w:numId")) or ""] = niveaux
        return formats

    def _style_car(self, sid: str, profondeur: int = 0) -> Tuple[bool, bool]:
        if sid in self._marques_style:
            return self._marques_style[sid]
        parent, gras, italique = self._car.get(sid, (None, None, None))
        herite = self._style_car(parent, profondeur + 1) if parent and profondeur < 10 else (False, False)
        res = (herite[0] if gras is None else gras, herite[1] if italique is None else italique)
        self._marques_style[sid] = res
        return res

    def _num_du_style(self, sid: Optional[str]) -> Optional[Tuple[Optional[str], Optional[str]]]:
        for _ in range(10):
            if not sid or sid not in self._par:
                return None
            parent, num = self._par[sid]
            if num is not None:
                return num
            sid = parent
        return None

    def liste(self, p: Any) -> Optional[Tuple[str, int]]:
        """(« bullet » ou « number », niveau à partir de 0) d'un paragraphe de liste, numérotation directe ou du style."""
        ppr = p.find(qn("w:pPr"))
        direct = ppr.find(qn("w:numPr")) if ppr is not None else None
        style = ppr.find(qn("w:pStyle")) if ppr is not None else None
        du_style = self._num_du_style(style.get(qn("w:val")) if style is not None else None)
        num_id, ilvl = _num_pr(direct) if direct is not None else (None, None)
        if num_id is None and du_style is not None:
            num_id = du_style[0]
        if ilvl is None and du_style is not None:
            ilvl = du_style[1]
        if not num_id or num_id == "0":
            return None
        fmt = self._formats.get(num_id, {}).get(ilvl or "0")
        if fmt is None or fmt == "none":
            return None
        niveau = int(ilvl) if ilvl and ilvl.isdigit() else 0
        return ("bullet" if fmt == "bullet" else "number"), niveau

    def _marques(self, run: Any) -> Tuple[str, ...]:
        rpr = run.find(qn("w:rPr"))
        if rpr is None:
            return ()
        rstyle = rpr.find(qn("w:rStyle"))
        gras, italique = self._style_car(rstyle.get(qn("w:val")) or "") if rstyle is not None else (False, False)
        b, i = _vrai(rpr.find(qn("w:b"))), _vrai(rpr.find(qn("w:i")))
        marques = []
        if (gras if b is None else b):
            marques.append("bold")
        if (italique if i is None else i):
            marques.append("italic")
        if _vrai(rpr.find(qn("w:strike"))) or _vrai(rpr.find(qn("w:dstrike"))):
            marques.append("strike")
        vert = rpr.find(qn("w:vertAlign"))
        position = vert.get(qn("w:val")) if vert is not None else None
        if position in ("subscript", "superscript"):
            marques.append("sub" if position == "subscript" else "sup")
        polices = rpr.find(qn("w:rFonts"))
        if polices is not None and (polices.get(qn("w:ascii")) or polices.get(qn("w:hAnsi")) or "").lower() in _MONO:
            marques.append("code")
        return tuple(marques)

    def _lien(self, run: Any, p: Any) -> Optional[str]:
        parent = run.getparent()
        while parent is not None and parent is not p:
            if parent.tag == _HYPERLINK:
                rid, ancre = parent.get(qn("r:id")), parent.get(qn("w:anchor"))
                if rid and rid in self.part.rels:
                    return self.part.rels[rid].target_ref
                return f"#{ancre}" if ancre else None
            parent = parent.getparent()
        return None

    def markdown(self, p: Any) -> Optional[str]:
        """Le texte et sa mise en forme en Markdown, tel que set le réécrit ; None s'il n'a ni marque ni lien."""
        segments: List[Tuple[str, Tuple[str, ...], Optional[str]]] = []
        for run in inline_runs(p):
            texte = run.text
            if not texte:
                continue
            cle = (self._marques(run), self._lien(run, p))
            if segments and segments[-1][1:] == cle:
                segments[-1] = (segments[-1][0] + texte, *cle)
            else:
                segments.append((texte, *cle))
        if not any(m or lien for _, m, lien in segments):
            return None
        sortie, k = [], 0
        while k < len(segments):
            lien, groupe = segments[k][2], []
            while k < len(segments) and segments[k][2] == lien:
                groupe.append(_marquer(segments[k][0], segments[k][1]))
                k += 1
            corps = "".join(groupe)
            sortie.append(f"[{corps}]({lien})" if lien else corps)
        return "".join(sortie)

    def texte_champs(self, p: Any) -> str:
        """Texte d'en-tête ou de pied, numéros de page en {PAGE} / {NUMPAGES} (le résultat enregistré est périmé)."""
        sortie: List[str] = []
        pile: List[List[Any]] = []                  # [instruction, résultat commencé, résultat masqué]
        masques = [0]                               # champs de page dont on traverse le résultat périmé

        def visiter(element: Any) -> None:
            for enfant in element:
                if enfant.tag == _FLD_SIMPLE:
                    nom = _nom_champ(enfant.get(qn("w:instr")) or "")
                    if nom in _CHAMPS_PAGE:
                        sortie.append(_CHAMPS_PAGE[nom])
                    else:
                        visiter(enfant)
                elif enfant.tag == _R:
                    car, instr = enfant.find(_FLD_CHAR), enfant.find(_INSTR)
                    if car is not None:
                        genre = car.get(qn("w:fldCharType"))
                        if genre == "begin":
                            pile.append(["", False, False])
                        elif genre == "separate" and pile and not pile[-1][1]:
                            pile[-1][1] = True
                            if _nom_champ(pile[-1][0]) in _CHAMPS_PAGE:
                                sortie.append(_CHAMPS_PAGE[_nom_champ(pile[-1][0])])
                                pile[-1][2] = True
                                masques[0] += 1
                        elif genre == "end" and pile:
                            cadre = pile.pop()
                            masques[0] -= 1 if cadre[2] else 0
                            if not cadre[1] and _nom_champ(cadre[0]) in _CHAMPS_PAGE:
                                sortie.append(_CHAMPS_PAGE[_nom_champ(cadre[0])])
                    elif instr is not None and pile:
                        pile[-1][0] += instr.text or ""
                    elif not masques[0]:
                        sortie.append(enfant.text)
                elif enfant.tag in _CONTENEURS:
                    visiter(enfant)
                elif enfant.tag == _SDT:
                    contenu = enfant.find(_SDT_CONTENT)
                    if contenu is not None:
                        visiter(contenu)

        visiter(p)
        return "".join(sortie).strip()


def _num_pr(num: Any) -> Tuple[Optional[str], Optional[str]]:
    ident, niveau = num.find(qn("w:numId")), num.find(qn("w:ilvl"))
    return (ident.get(qn("w:val")) if ident is not None else None,
            niveau.get(qn("w:val")) if niveau is not None else None)


def _niveaux(abstrait: Any) -> Dict[str, str]:
    return _niveaux_de(abstrait.iterchildren(qn("w:lvl")), None)


def _niveaux_de(niveaux: Iterable[Any], ilvl: Optional[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for lvl in niveaux:
        fmt = lvl.find(qn("w:numFmt"))
        if fmt is not None:
            out[lvl.get(qn("w:ilvl")) or ilvl or "0"] = fmt.get(qn("w:val")) or "decimal"
    return out


def _marquer(texte: str, marques: Tuple[str, ...]) -> str:
    coeur = texte.strip()
    if not coeur:
        return texte
    debut, fin = texte[:len(texte) - len(texte.lstrip())], texte[len(texte.rstrip()):]
    if "code" in marques:
        coeur = f"`{coeur.replace('`', '')}`"
    else:
        coeur = _ECHAPPER.sub(r"\\\1", coeur)
    for marque, signe in _ORDRE:
        if marque in marques:
            coeur = f"{signe}{coeur}{signe}"
    return debut + coeur + fin


def partie(document: Any, genre: str) -> Any:
    """Racine XML d'une partie liée au document (numérotation, notes, commentaires), sans la créer si elle manque."""
    for rel in document.part.rels.values():
        if rel.reltype == genre and not rel.is_external:
            element = getattr(rel.target_part, "element", None)
            return element if element is not None else parse_xml(rel.target_part.blob)
    return None


def zones_de_texte(p: Any) -> List[str]:
    """Texte des zones de texte ancrées dans le paragraphe (la variante VML de repli n'est pas relue)."""
    textes = []
    for zone in p.iter(_TXBX):
        parent, repli = zone.getparent(), False
        while parent is not None and parent is not p:
            if parent.tag == _FALLBACK:
                repli = True
                break
            parent = parent.getparent()
        texte = "" if repli else _texte(zone)
        if texte:
            textes.append(_court(texte, 1000))
    return textes


def revisions(p: Any) -> Dict[str, str]:
    """Texte inséré et supprimé en suivi des modifications dans le paragraphe."""
    insere = "".join(t.text or "" for tag in ("w:ins", "w:moveTo") for e in p.iter(qn(tag))
                     for t in e.iter(qn("w:t")))
    supprime = "".join(t.text or "" for tag in ("w:del", "w:moveFrom") for e in p.iter(qn(tag))
                       for t in e.iter(qn("w:delText")))
    out = {}
    if insere.strip():
        out["inserted"] = _court(insere)
    if supprime.strip():
        out["deleted"] = _court(supprime)
    return out


def bilan_revisions(corps: Any) -> Optional[Dict[str, Any]]:
    """Modifications suivies du corps : nombre d'insertions, de suppressions, de mises en forme, et auteurs."""
    compte = {"insertions": 0, "deletions": 0, "formatting": 0}
    auteurs: Dict[str, None] = {}
    genres = {qn("w:ins"): "insertions", qn("w:moveTo"): "insertions", qn("w:del"): "deletions",
              qn("w:moveFrom"): "deletions", qn("w:rPrChange"): "formatting", qn("w:pPrChange"): "formatting"}
    for e in corps.iter(*genres):
        if e.getparent() is not None and e.getparent().tag == qn("w:rPr") and e.tag in (qn("w:ins"), qn("w:del")):
            continue                                # marque de paragraphe : pas un texte
        compte[genres[e.tag]] += 1
        auteur = e.get(qn("w:author"))
        if auteur:
            auteurs[auteur] = None
    if not any(compte.values()):
        return None
    return {**{k: v for k, v in compte.items() if v}, **({"by": list(auteurs)[:10]} if auteurs else {})}


def commentaires(document: Any, lieux: Iterable[Tuple[Dict[str, Any], Any]], limite: int = 30) -> List[Dict[str, Any]]:
    """Commentaires du document, chacun avec son auteur et le paragraphe qu'il commente."""
    racine = partie(document, RT.COMMENTS)
    if racine is None:
        return []
    ancres: Dict[str, Dict[str, Any]] = {}
    for lieu, paragraphe in lieux:
        for ref in paragraphe._p.iter(qn("w:commentReference"), qn("w:commentRangeStart")):
            ancres.setdefault(ref.get(qn("w:id")) or "", {**lieu, "excerpt": _court(paragraphe.text.strip(), 80)})
    out = []
    for c in racine.iterchildren(qn("w:comment")):
        ident = c.get(qn("w:id")) or ""
        out.append({"by": c.get(qn("w:author")) or "", "text": _court(_texte(c)), "at": ancres.get(ident)})
        if len(out) >= limite:
            break
    return out


def notes(document: Any, genre: str, lieux: Iterable[Tuple[Dict[str, Any], Any]], limite: int = 30) -> List[Dict[str, Any]]:
    """Notes de bas de page (genre « footnote ») ou de fin (« endnote ») avec le paragraphe qui les appelle."""
    racine = partie(document, RT.FOOTNOTES if genre == "footnote" else RT.ENDNOTES)
    if racine is None:
        return []
    appels: Dict[str, Dict[str, Any]] = {}
    for lieu, paragraphe in lieux:
        for ref in paragraphe._p.iter(qn(f"w:{genre}Reference")):
            appels.setdefault(ref.get(qn("w:id")) or "", lieu)
    out = []
    for n in racine.iterchildren(qn(f"w:{genre}")):
        if (n.get(qn("w:type")) or "normal") != "normal":
            continue                                # séparateurs de Word
        ident = n.get(qn("w:id")) or ""
        out.append({"n": ident, "text": _court(_texte(n)), "at": appels.get(ident)})
        if len(out) >= limite:
            break
    return out
