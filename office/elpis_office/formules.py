# SPDX-License-Identifier: MIT
"""office/elpis_office/formules.py — formules d'un classeur créé : défauts sûrs signalés, résultat des formules simples calculé pour le cache."""
from __future__ import annotations

import math
import re
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal, InvalidOperation
from functools import lru_cache
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from openpyxl.formula.tokenizer import Token, Tokenizer, TokenizerError
from openpyxl.utils import FORMULAE
from openpyxl.utils.cell import range_boundaries

LIGNES_MAX, COLONNES_MAX = 1_048_576, 16_384
VISITES_MAX = 2_000_000                     # cellules lues par tous les calculs d'un classeur
PROFONDEUR_MAX = 200
FRANCAIS = {"SOMME": "SUM", "MOYENNE": "AVERAGE", "SI": "IF", "NB": "COUNT", "NBVAL": "COUNTA",
            "NB.SI": "COUNTIF", "NB.SI.ENS": "COUNTIFS", "SOMME.SI": "SUMIF", "SOMME.SI.ENS": "SUMIFS",
            "MOYENNE.SI": "AVERAGEIF", "RECHERCHEV": "VLOOKUP", "RECHERCHEH": "HLOOKUP",
            "RECHERCHEX": "XLOOKUP", "EQUIV": "MATCH", "ARRONDI": "ROUND", "ARRONDI.SUP": "ROUNDUP",
            "ARRONDI.INF": "ROUNDDOWN", "ENT": "INT", "SIERREUR": "IFERROR", "ET": "AND", "OU": "OR",
            "NON": "NOT", "AUJOURDHUI": "TODAY", "MAINTENANT": "NOW", "ANNEE": "YEAR", "MOIS": "MONTH",
            "JOUR": "DAY", "TEXTE": "TEXT", "CONCATENER": "CONCATENATE", "GAUCHE": "LEFT",
            "DROITE": "RIGHT", "STXT": "MID", "NBCAR": "LEN", "SOUS.TOTAL": "SUBTOTAL",
            "SOMMEPROD": "SUMPRODUCT", "PRODUIT": "PRODUCT", "MEDIANE": "MEDIAN"}
COMPTES = frozenset({"COUNT", "COUNTA", "COUNTIF", "COUNTIFS", "COUNTBLANK", "ROWS", "COLUMNS", "LEN"})
_AUTRES_CONNUES = frozenset({"ENCODEURL"})
_FEUILLE = re.compile(r"^(?:'((?:[^']|'')+)'|([^'!\[\]]+))!(.+)$")
_A1 = re.compile(r"\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?")
_NOMBRE = re.compile(r"\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*")
_AGREGATS = frozenset({"SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "PRODUCT"})
_SOUS_TOTAUX = {1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 9: "SUM"}


class NonCalcule(Exception):
    """Formule hors du calcul local (tableaux, noms, fonctions non couvertes) : Excel la calcule à l'ouverture."""


class _TropProfond(NonCalcule):
    """Chaîne de formules trop longue pour la récursion : retentée plus tard, jamais mémorisée."""


class Erreur:
    """Valeur d'erreur d'Excel (#DIV/0!, #VALUE!…)."""
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code.upper()


class Plage:
    __slots__ = ("feuille", "l1", "c1", "l2", "c2")

    def __init__(self, feuille: str, l1: int, c1: int, l2: int, c2: int) -> None:
        self.feuille, self.l1, self.c1, self.l2, self.c2 = feuille, l1, c1, l2, c2


_ECHEC = object()
_ATTENTE = object()                         # cellule réservée (ligne de total) : pas encore écrite


@lru_cache(maxsize=1024)
def fonction_connue(nom: str) -> bool:
    """Fonction d'Excel : liste d'openpyxl, ou fonction récente qu'XlsxWriter préfixe de _xlfn."""
    if nom in FORMULAE or nom in _AUTRES_CONNUES:
        return True
    from xlsxwriter.worksheet import Worksheet
    try:
        return "_xlfn." in Worksheet()._prepare_formula(f"{nom}(1)", True)
    except Exception:                           # noqa: BLE001 — sonde privée : dans le doute, connue
        return True


def _sans_prefixe(nom: str) -> str:
    nom = nom.lstrip("@").upper()
    for p in ("_XLFN._XLWS.", "_XLFN.", "_XLWS."):
        if nom.startswith(p):
            return nom[len(p):]
    return nom


def _feuille_et_ref(texte: str) -> Tuple[Optional[str], str]:
    m = _FEUILLE.match(texte)
    if not m:
        return None, texte
    return (m.group(1).replace("''", "'") if m.group(1) is not None else m.group(2)), m.group(3)


def controler(formule: str, feuilles: Iterable[str]) -> List[str]:
    """Défauts sûrs d'une formule (feuille absente, fonction inconnue, « ; », parenthèses) → messages."""
    try:
        jetons = Tokenizer(formule).items
    except TokenizerError as e:
        return [f"cannot be read ({e})"]
    noms = {n.casefold() for n in feuilles}
    defauts: List[str] = []
    profondeur = tableau = 0
    for t in jetons:
        if t.type in (Token.FUNC, Token.PAREN) and t.subtype == Token.OPEN:
            profondeur += 1
            nom = _sans_prefixe(t.value[:-1]) if t.type == Token.FUNC else ""
            if nom and not fonction_connue(nom):
                anglais = FRANCAIS.get(nom)
                defauts.append(f"{nom}() is not an Excel function"
                               + (f": write {anglais}() (formulas are stored in English)" if anglais else ""))
        elif t.type in (Token.FUNC, Token.PAREN) and t.subtype == Token.CLOSE:
            profondeur -= 1
            if profondeur < 0:
                defauts.append("a ')' has no matching '('")
                profondeur = 0
        elif t.type == Token.ARRAY:
            tableau += 1 if t.subtype == Token.OPEN else -1
        elif t.type == Token.SEP and t.value == ";" and not tableau:
            defauts.append("arguments are separated by ',' in a formula, not ';'")
        elif t.type == Token.OPERAND and t.subtype == Token.RANGE and "[" not in t.value:
            feuille, ref = _feuille_et_ref(t.value)
            if feuille is not None and feuille.casefold() not in noms:
                defauts.append(f"sheet '{feuille}' does not exist (sheets: {', '.join(feuilles)})")
            if _A1.fullmatch(ref):
                c1, l1, c2, l2 = range_boundaries(ref.replace("$", ""))
                if max(c1, c2) > COLONNES_MAX or max(l1, l2) > LIGNES_MAX or min(l1, l2) < 1:
                    defauts.append(f"{ref} is outside the sheet")
    if profondeur > 0:
        defauts.append("a '(' is not closed")
    if jetons and jetons[-1].type in (Token.OP_IN, Token.OP_PRE):
        defauts.append("it ends with an operator")
    return list(dict.fromkeys(defauts))


def premiere_reference(formule: str, feuille: str) -> Tuple[Optional[str], Optional[Tuple[str, int, int]]]:
    """(fonction extérieure, première cellule citée) : de quoi donner au résultat le format de ce qu'il calcule."""
    try:
        jetons = [t for t in Tokenizer(formule).items if t.type != Token.WSPACE]
    except TokenizerError:
        return None, None
    exterieure = _sans_prefixe(jetons[0].value[:-1]) if jetons and jetons[0].type == Token.FUNC else None
    for t in jetons:
        if t.type == Token.OPERAND and t.subtype == Token.RANGE and "[" not in t.value:
            nom, ref = _feuille_et_ref(t.value)
            try:
                c1, l1, _, _ = range_boundaries(ref.replace("$", ""))
            except ValueError:
                continue
            return exterieure, ((nom or feuille).casefold(), l1 or 1, c1 or 1)
    return exterieure, None


class Classeur:
    """Cellules des feuilles créées, constantes ou formules « =… » (lignes et colonnes à partir de 1)."""

    def __init__(self) -> None:
        self.feuilles: Dict[str, Dict[Tuple[int, int], Any]] = {}
        self._etendue: Dict[str, Tuple[int, int]] = {}
        self._valeurs: Dict[Tuple[str, int, int], Any] = {}
        self._en_cours: set = set()
        self.visites = self.profondeur = 0

    def ajouter(self, nom: str, cellules: Dict[Tuple[int, int], Any]) -> None:
        self.feuilles[nom.casefold()] = cellules
        self.etendre(nom)

    def etendre(self, nom: str) -> None:
        cellules = self.feuilles[nom.casefold()]
        self._etendue[nom.casefold()] = (max((r for r, _ in cellules), default=1),
                                         max((c for _, c in cellules), default=1))

    def reserver(self, nom: str, ligne: int, col: int) -> None:
        self.feuilles[nom.casefold()][(ligne, col)] = _ATTENTE

    def poser(self, nom: str, ligne: int, col: int, valeur: Any) -> None:
        cellules = self.feuilles[nom.casefold()]
        if valeur is None:
            cellules.pop((ligne, col), None)
        else:
            cellules[(ligne, col)] = valeur

    def resultat(self, nom: str, ligne: int, col: int) -> Any:
        """Résultat d'une formule pour le cache : nombre, texte, booléen, code d'erreur ; None si Excel doit le calculer."""
        try:
            v = self._cellule(nom.casefold(), ligne, col)
        except NonCalcule:
            return None
        except RecursionError:
            return None
        if isinstance(v, Erreur):
            return v.code
        if isinstance(v, float):
            return float(f"{v:.15g}") + 0.0      # 15 chiffres comme Excel ; -0.0 → 0.0
        return 0.0 if v is None else v

    def _payer(self, n: int) -> None:
        self.visites += n
        if self.visites > VISITES_MAX:
            raise NonCalcule("too many cells read")

    def _cellule(self, f: str, ligne: int, col: int) -> Any:
        brut = self.feuilles[f].get((ligne, col))
        if brut is _ATTENTE:
            raise NonCalcule("total row not written yet")
        if not (isinstance(brut, str) and brut.startswith("=")):
            return brut
        cle = (f, ligne, col)
        if cle in self._valeurs:
            if self._valeurs[cle] is _ECHEC:
                raise NonCalcule("already failed")
            return self._valeurs[cle]
        if cle in self._en_cours:
            raise NonCalcule("circular reference")
        if self.profondeur >= PROFONDEUR_MAX:
            raise _TropProfond()
        self._en_cours.add(cle)
        self.profondeur += 1
        try:
            v = _Calcul(self, f, brut).valeur()
        except _TropProfond:
            raise
        except NonCalcule:
            self._valeurs[cle] = _ECHEC
            raise
        finally:
            self._en_cours.discard(cle)
            self.profondeur -= 1
        self._valeurs[cle] = v
        return v

    def cellules(self, p: Plage) -> Iterator[Any]:
        d = self.feuilles[p.feuille]
        aire = (p.l2 - p.l1 + 1) * (p.c2 - p.c1 + 1)
        if aire <= len(d):
            self._payer(aire)
            coords: Iterable[Tuple[int, int]] = ((r, c) for r in range(p.l1, p.l2 + 1)
                                                 for c in range(p.c1, p.c2 + 1))
        else:
            self._payer(len(d))
            coords = sorted(k for k in d if p.l1 <= k[0] <= p.l2 and p.c1 <= k[1] <= p.c2)
        for r, c in coords:
            if (r, c) in d:
                yield self._cellule(p.feuille, r, c)

    def borner(self, f: str, l1: Optional[int], c1: Optional[int], l2: Optional[int],
               c2: Optional[int]) -> Plage:
        lmax, cmax = self._etendue[f]
        l1, c1, l2, c2 = l1 or 1, c1 or 1, l2 or lmax, c2 or cmax
        return Plage(f, min(l1, l2), min(c1, c2), max(l1, l2), max(c1, c2))


def _nombre(v: Any) -> Any:
    """Valeur en nombre comme Excel : vide 0, VRAI 1, texte numérique converti, sinon #VALUE!."""
    if isinstance(v, Erreur):
        return v
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if _NOMBRE.fullmatch(str(v)):
        return float(v)
    return Erreur("#VALUE!")


def _booleen(v: Any) -> Any:
    if isinstance(v, (Erreur, bool)):
        return v
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return v != 0
    texte = str(v).strip().upper()
    return {"TRUE": True, "FALSE": False}.get(texte, Erreur("#VALUE!"))


def _texte(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        return f"{v:.15g}".upper()
    return str(v)


def _arith(op: str, a: Any, b: Any) -> Any:
    a, b = _nombre(a), _nombre(b)
    for x in (a, b):
        if isinstance(x, Erreur):
            return x
    if op == "+":
        r = a + b
    elif op == "-":
        r = a - b
    elif op == "*":
        r = a * b
    elif op == "/":
        if b == 0:
            return Erreur("#DIV/0!")
        r = a / b
    else:
        if a == 0 and b <= 0:
            return Erreur("#NUM!" if b == 0 else "#DIV/0!")
        if a < 0 and not float(b).is_integer():
            return Erreur("#NUM!")
        try:
            r = a ** b
        except OverflowError:
            return Erreur("#NUM!")
    return r if math.isfinite(r) else Erreur("#NUM!")


def _rang(v: Any) -> int:
    return 2 if isinstance(v, bool) else (1 if isinstance(v, str) else 0)


def _comparer(op: str, a: Any, b: Any) -> Any:
    for x in (a, b):
        if isinstance(x, Erreur):
            return x
    if a is None:
        a = "" if isinstance(b, str) else (False if isinstance(b, bool) else 0.0)
    if b is None:
        b = "" if isinstance(a, str) else (False if isinstance(a, bool) else 0.0)
    if _rang(a) != _rang(b):
        a, b = _rang(a), _rang(b)
    elif isinstance(a, str):
        a, b = a.casefold(), b.casefold()
    return {"=": a == b, "<>": a != b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]


def _arrondi(nom: str, x: Any, n: Any) -> Any:
    x, n = _nombre(x), _nombre(n)
    for v in (x, n):
        if isinstance(v, Erreur):
            return v
    mode = {"ROUND": ROUND_HALF_UP, "ROUNDUP": ROUND_UP, "ROUNDDOWN": ROUND_DOWN}[nom]
    try:
        return float(Decimal(repr(x)).quantize(Decimal(1).scaleb(-int(n)), rounding=mode))
    except InvalidOperation:
        return x


class _Calcul:
    """Une formule évaluée en la lisant : descente récursive, priorités d'Excel (- unaire, %, ^, * /, + -, &, comparaisons)."""

    def __init__(self, classeur: Classeur, feuille: str, formule: str) -> None:
        self.c, self.f, self.i = classeur, feuille, 0
        try:
            bruts = Tokenizer(formule).items
        except TokenizerError as e:
            raise NonCalcule(str(e))
        self.jetons: List[Token] = []
        for k, t in enumerate(bruts):
            if t.type != Token.WSPACE:
                self.jetons.append(t)
            elif self.jetons and k + 1 < len(bruts) and self._operande_fini(self.jetons[-1]) \
                    and bruts[k + 1].type in (Token.OPERAND, Token.FUNC, Token.PAREN) \
                    and bruts[k + 1].subtype != Token.CLOSE:
                raise NonCalcule("intersection")

    @staticmethod
    def _operande_fini(t: Token) -> bool:
        return t.type == Token.OPERAND or (t.type in (Token.FUNC, Token.PAREN) and t.subtype == Token.CLOSE)

    def valeur(self) -> Any:
        v = self._scalaire(self._comparaison())
        if self.i != len(self.jetons):
            raise NonCalcule("unexpected token")
        return v

    def _suivant(self) -> Optional[Token]:
        return self.jetons[self.i] if self.i < len(self.jetons) else None

    def _op(self, *ops: str) -> Optional[str]:
        t = self._suivant()
        if t is not None and t.type == Token.OP_IN and t.value in ops:
            self.i += 1
            return t.value
        return None

    def _comparaison(self) -> Any:
        g = self._concat()
        while (op := self._op("=", "<>", "<", ">", "<=", ">=")):
            g = _comparer(op, self._scalaire(g), self._scalaire(self._concat()))
        return g

    def _concat(self) -> Any:
        g = self._somme()
        while self._op("&"):
            a, b = self._scalaire(g), self._scalaire(self._somme())
            g = next((x for x in (a, b) if isinstance(x, Erreur)), None) or _texte(a) + _texte(b)
        return g

    def _somme(self) -> Any:
        g = self._produit()
        while (op := self._op("+", "-")):
            g = _arith(op, self._scalaire(g), self._scalaire(self._produit()))
        return g

    def _produit(self) -> Any:
        g = self._puissance()
        while (op := self._op("*", "/")):
            g = _arith(op, self._scalaire(g), self._scalaire(self._puissance()))
        return g

    def _puissance(self) -> Any:
        g = self._pourcent()
        while self._op("^"):
            g = _arith("^", self._scalaire(g), self._scalaire(self._pourcent()))
        return g

    def _pourcent(self) -> Any:
        g = self._unaire()
        while (t := self._suivant()) is not None and t.type == Token.OP_POST:
            self.i += 1
            g = _arith("/", self._scalaire(g), 100.0)
        return g

    def _unaire(self) -> Any:
        t = self._suivant()
        if t is not None and t.type == Token.OP_PRE:
            self.i += 1
            v = self._scalaire(self._unaire())
            return _arith("*", v, -1.0) if t.value == "-" else v
        return self._primaire()

    def _primaire(self) -> Any:
        t = self._suivant()
        if t is None:
            raise NonCalcule("unexpected end")
        self.i += 1
        if t.type == Token.OPERAND:
            if t.subtype == Token.NUMBER:
                return float(t.value)
            if t.subtype == Token.TEXT:
                return t.value[1:-1].replace('""', '"')
            if t.subtype == Token.LOGICAL:
                return t.value.upper() == "TRUE"
            if t.subtype == Token.ERROR:
                return Erreur(t.value)
            return self._plage(t.value)
        if t.type == Token.FUNC and t.subtype == Token.OPEN:
            return self._fonction(_sans_prefixe(t.value[:-1]))
        if t.type == Token.PAREN and t.subtype == Token.OPEN:
            v = self._comparaison()
            self._fermer(Token.PAREN)
            return v
        raise NonCalcule(f"unexpected {t.value}")

    def _fermer(self, genre: str) -> None:
        t = self._suivant()
        if t is None or t.type != genre or t.subtype != Token.CLOSE:
            raise NonCalcule("missing ')'")
        self.i += 1

    def _fonction(self, nom: str) -> Any:
        args: List[Any] = []
        t = self._suivant()
        if not (t is not None and t.type == Token.FUNC and t.subtype == Token.CLOSE):
            while True:
                t = self._suivant()
                vide = t is not None and (t.type == Token.SEP or (t.type == Token.FUNC and t.subtype == Token.CLOSE))
                args.append(None if vide else self._comparaison())
                t = self._suivant()
                if t is None or t.type != Token.SEP or t.subtype != Token.ARG:
                    break
                self.i += 1
        self._fermer(Token.FUNC)
        return self._appeler(nom, args)

    def _plage(self, texte: str) -> Plage:
        if "[" in texte:
            raise NonCalcule("structured reference")
        nom, ref = _feuille_et_ref(texte)
        f = nom.casefold() if nom is not None else self.f
        if f not in self.c.feuilles:
            raise NonCalcule("unknown sheet")
        try:
            c1, l1, c2, l2 = range_boundaries(ref.replace("$", ""))
        except ValueError:
            raise NonCalcule("name")
        return self.c.borner(f, l1, c1, l2, c2)

    def _scalaire(self, v: Any) -> Any:
        if not isinstance(v, Plage):
            return v
        if (v.l1, v.c1) != (v.l2, v.c2):
            raise NonCalcule("range used as one value")
        self.c._payer(1)
        return self.c._cellule(v.feuille, v.l1, v.c1)

    def _appeler(self, nom: str, args: List[Any]) -> Any:
        n = len(args)
        if nom in _AGREGATS:
            return self._agreger(nom, args)
        if nom == "SUBTOTAL" and n >= 2:
            code = _nombre(self._scalaire(args[0]))
            if isinstance(code, Erreur):
                return code
            agregat = _SOUS_TOTAUX.get(int(code) % 100)
            if agregat is None:
                raise NonCalcule("SUBTOTAL function")
            return self._agreger(agregat, args[1:])
        if nom in ("ROUND", "ROUNDUP", "ROUNDDOWN") and n == 2:
            return _arrondi(nom, self._scalaire(args[0]), self._scalaire(args[1]))
        if nom == "ABS" and n == 1:
            x = _nombre(self._scalaire(args[0]))
            return x if isinstance(x, Erreur) else abs(x)
        if nom == "IF" and n in (2, 3):
            cond = _booleen(self._scalaire(args[0]))
            if isinstance(cond, Erreur):
                return cond
            branche = args[1] if cond else (args[2] if n == 3 else False)
            return 0.0 if branche is None else self._scalaire(branche)
        if nom == "IFERROR" and n == 2:
            v = self._scalaire(args[0])
            return (0.0 if args[1] is None else self._scalaire(args[1])) if isinstance(v, Erreur) else v
        if nom in ("AND", "OR") and n:
            vus = [b for b in self._logiques(args) if b is not None]
            erreur = next((b for b in vus if isinstance(b, Erreur)), None)
            if erreur is not None:
                return erreur
            if not vus:
                return Erreur("#VALUE!")
            return all(vus) if nom == "AND" else any(vus)
        if nom == "NOT" and n == 1:
            b = _booleen(self._scalaire(args[0]))
            return b if isinstance(b, Erreur) else not b
        raise NonCalcule(f"{nom} not computed here")

    def _logiques(self, args: List[Any]) -> Iterator[Any]:
        for a in args:
            if isinstance(a, Plage):
                for v in self.c.cellules(a):
                    if isinstance(v, (bool, Erreur)):
                        yield v
                    elif isinstance(v, (int, float)):
                        yield v != 0
            elif a is not None:
                yield _booleen(a)

    def _agreger(self, nom: str, args: List[Any]) -> Any:
        nombres: List[float] = []
        remplies = 0
        for a in args:
            if isinstance(a, Plage):
                for v in self.c.cellules(a):
                    if v is None:
                        continue
                    remplies += 1
                    if isinstance(v, Erreur):
                        if nom in ("COUNT", "COUNTA"):
                            continue
                        return v
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        nombres.append(float(v))
                continue
            if a is None:
                continue
            remplies += 1
            if nom == "COUNTA":
                continue
            x = _nombre(a)
            if isinstance(x, Erreur):
                if nom == "COUNT":
                    continue
                return x
            nombres.append(x)
        if nom == "SUM":
            return math.fsum(nombres)
        if nom == "AVERAGE":
            return math.fsum(nombres) / len(nombres) if nombres else Erreur("#DIV/0!")
        if nom == "MIN":
            return min(nombres, default=0.0)
        if nom == "MAX":
            return max(nombres, default=0.0)
        if nom == "COUNT":
            return float(len(nombres))
        if nom == "COUNTA":
            return float(remplies)
        return math.prod(nombres) if nombres else 0.0
