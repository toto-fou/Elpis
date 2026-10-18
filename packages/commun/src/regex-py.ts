// SPDX-License-Identifier: MIT
/** packages/commun/src/regex-py.ts — `re` de Python 3.13 traduit en RegExp (drapeau `v`), seul port du dépôt : analyse de re/_parser.py (mêmes erreurs et positions), casse comparée par minuscules comme `_sre` (`_casefix`), \w \d \s \b Unicode, ^ $ . de Python, gabarits de `sub`. */
import { lowerPy, reprPy } from "./python";

export const RE_IGNORECASE = 2;
export const RE_LOCALE = 4;
export const RE_MULTILINE = 8;
export const RE_DOTALL = 16;
export const RE_UNICODE = 32;
export const RE_VERBOSE = 64;
export const RE_ASCII = 256;

const MAXREPEAT = 4294967295;
const MAXGROUPS = 1073741823;
const FLAGS: Readonly<Record<string, number>> = {
  i: RE_IGNORECASE,
  L: RE_LOCALE,
  m: RE_MULTILINE,
  s: RE_DOTALL,
  x: RE_VERBOSE,
  a: RE_ASCII,
  u: RE_UNICODE,
};
const TYPE_FLAGS = RE_ASCII | RE_LOCALE | RE_UNICODE;
const SPECIAL = ".\\[{()*+?^$|";
const DIGITS = "0123456789";
const OCT = "01234567";
const HEX = "0123456789abcdefABCDEF";
const LETTRES = /^[A-Za-z]$/u;
const BLANCS_X = " \t\n\r\v\f";

/** `re.error` : message suivi de la position (et de la ligne si le motif en a plusieurs). */
export class ErreurRe extends Error {
  override readonly name: string = "PatternError";
  readonly msg: string;
  readonly pos: number | null;

  constructor(msg: string, motif: readonly string[] | null = null, pos: number | null = null) {
    let m = msg;
    if (motif !== null && pos !== null) {
      m = `${msg} at position ${pos}`;
      if (motif.includes("\n")) {
        let ligne = 1;
        let derniere = -1;
        for (let k = 0; k < pos; k++)
          if (motif[k] === "\n") {
            ligne++;
            derniere = k;
          }
        m = `${m} (line ${ligne}, column ${pos - derniere})`;
      }
    }
    super(m);
    this.msg = msg;
    this.pos = pos;
  }
}

/** Motif valide en Python sans équivalent RegExp (groupe conditionnel, `\N{…}`, motif refusé par le moteur JS) : une `ErreurRe` que l'appelant peut traiter à part. */
export class RegexNonGeree extends ErreurRe {
  override readonly name: string = "RegexNonGeree";
}

/** Erreur Python d'un autre type que `re.error` (`OverflowError`, `IndexError`) : traverse les `except re.error`. */
export class ErreurPyRe extends Error {
  override readonly name: "OverflowError" | "IndexError" | "ValueError";

  constructor(name: ErreurPyRe["name"], message: string) {
    super(message);
    this.name = name;
  }
}

type Categorie = "digit" | "not_digit" | "space" | "not_space" | "word" | "not_word";
type Membre =
  | { readonly t: "lit"; readonly c: number }
  | { readonly t: "range"; readonly lo: number; readonly hi: number }
  | { readonly t: "cat"; readonly cat: Categorie };
type Ancre = "begin" | "end" | "begin_string" | "end_string" | "boundary" | "non_boundary";
type Noeud =
  | { readonly t: "lit"; readonly c: number }
  | { readonly t: "not_lit"; readonly c: number }
  | { readonly t: "any" }
  | { readonly t: "in"; readonly neg: boolean; readonly items: readonly Membre[] }
  | { readonly t: "at"; readonly a: Ancre }
  | {
      readonly t: "rep";
      readonly min: number;
      readonly max: number;
      readonly mode: "max" | "min" | "poss";
      readonly p: Noeud[];
    }
  | {
      readonly t: "group";
      readonly id: number | null;
      readonly add: number;
      readonly del: number;
      readonly p: Noeud[];
    }
  | { readonly t: "atomic"; readonly p: Noeud[] }
  | { readonly t: "assert"; readonly dir: 1 | -1; readonly neg: boolean; readonly p: Noeud[] }
  | { readonly t: "failure" }
  | { readonly t: "ref"; readonly id: number }
  | { readonly t: "ref_exists"; readonly id: number; readonly oui: Noeud[]; readonly non: Noeud[] | null }
  | { readonly t: "branch"; readonly alts: Noeud[][] };

const CATEGORIES: Readonly<Record<string, Noeud>> = {
  "\\A": { t: "at", a: "begin_string" },
  "\\b": { t: "at", a: "boundary" },
  "\\B": { t: "at", a: "non_boundary" },
  "\\d": { t: "in", neg: false, items: [{ t: "cat", cat: "digit" }] },
  "\\D": { t: "in", neg: false, items: [{ t: "cat", cat: "not_digit" }] },
  "\\s": { t: "in", neg: false, items: [{ t: "cat", cat: "space" }] },
  "\\S": { t: "in", neg: false, items: [{ t: "cat", cat: "not_space" }] },
  "\\w": { t: "in", neg: false, items: [{ t: "cat", cat: "word" }] },
  "\\W": { t: "in", neg: false, items: [{ t: "cat", cat: "not_word" }] },
  "\\Z": { t: "at", a: "end_string" },
};
const ESCAPES: Readonly<Record<string, number>> = {
  "\\a": 7,
  "\\b": 8,
  "\\f": 12,
  "\\n": 10,
  "\\r": 13,
  "\\t": 9,
  "\\v": 11,
  "\\\\": 92,
};

/** `Tokenizer` de re/_parser.py, sur les points de code du motif. */
class Source {
  readonly s: readonly string[];
  index = 0;
  next: string | null = null;
  /** Nom de caractère `\N{…}` rencontré : valide pour Python, sans équivalent ici (refus après l'analyse). */
  nomCaractere: string | null = null;

  constructor(motif: string) {
    this.s = Array.from(motif);
    this.avancer();
  }

  private avancer(): void {
    let i = this.index;
    const c = this.s[i];
    if (c === undefined) {
      this.next = null;
      return;
    }
    let t = c;
    if (c === "\\") {
      i++;
      const d = this.s[i];
      if (d === undefined) throw new ErreurRe("bad escape (end of pattern)", this.s, this.s.length - 1);
      t += d;
    }
    this.index = i + 1;
    this.next = t;
  }

  match(c: string): boolean {
    if (c === this.next) {
      this.avancer();
      return true;
    }
    return false;
  }

  get(): string | null {
    const t = this.next;
    this.avancer();
    return t;
  }

  getwhile(n: number, jeu: string): string {
    let r = "";
    for (let k = 0; k < n; k++) {
      const c = this.next;
      if (c === null || c.length !== 1 || !jeu.includes(c)) break;
      r += c;
      this.avancer();
    }
    return r;
  }

  getuntil(fin: string, nom: string): string {
    let r = "";
    for (;;) {
      const c = this.next;
      this.avancer();
      if (c === null) {
        if (!r) throw this.erreur(`missing ${nom}`);
        throw this.erreur(`missing ${fin}, unterminated name`, Array.from(r).length);
      }
      if (c === fin) {
        if (!r) throw this.erreur(`missing ${nom}`, 1);
        break;
      }
      r += c;
    }
    return r;
  }

  tell(): number {
    return this.index - (this.next === null ? 0 : Array.from(this.next).length);
  }

  seek(i: number): void {
    this.index = i;
    this.avancer();
  }

  erreur(msg: string, decalage = 0): ErreurRe {
    return new ErreurRe(msg, this.s, this.tell() - decalage);
  }

  verifierNom(nom: string, decalage: number): void {
    if (!estIdentifiant(nom))
      throw this.erreur(`bad character in group name ${reprPyCourt(nom)}`, Array.from(nom).length + decalage);
  }
}

/** `str.isidentifier()` : XID_Start (ou `_`) puis XID_Continue. */
function estIdentifiant(s: string): boolean {
  return /^[\p{XID_Start}_]\p{XID_Continue}*$/u.test(s);
}

const reprPyCourt = (s: string): string => reprPy(s);

class Etat {
  flags = 0;
  readonly noms = new Map<string, number>();
  readonly largeurs: ([number, number] | null)[] = [null];
  lookbehind: number | null = null;
  readonly refPos = new Map<number, number>();

  get groupes(): number {
    return this.largeurs.length;
  }

  ouvrir(nom: string | null): number {
    const gid = this.groupes;
    this.largeurs.push(null);
    if (this.groupes > MAXGROUPS) throw new ErreurRe("too many groups");
    if (nom !== null) {
      const deja = this.noms.get(nom);
      if (deja !== undefined)
        throw new ErreurRe(
          `redefinition of group name ${reprPyCourt(nom)} as group ${gid}; was group ${deja}`,
        );
      this.noms.set(nom, gid);
    }
    return gid;
  }

  fermer(gid: number, p: readonly Noeud[]): void {
    this.largeurs[gid] = largeur(p, this);
  }

  verifier(gid: number): boolean {
    return gid < this.groupes && this.largeurs[gid] !== null;
  }

  verifierLookbehind(gid: number, src: Source): void {
    if (this.lookbehind !== null) {
      if (!this.verifier(gid)) throw src.erreur("cannot refer to an open group");
      if (gid >= this.lookbehind)
        throw src.erreur("cannot refer to group defined in the same lookbehind subpattern");
    }
  }
}

const MAXWIDTH = 2 ** 64;

/** `SubPattern.getwidth()`. */
function largeur(p: readonly Noeud[], etat: Etat): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const n of p) {
    if (n.t === "branch") {
      let i = MAXWIDTH;
      let j = 0;
      for (const a of n.alts) {
        const [l, h] = largeur(a, etat);
        i = Math.min(i, l);
        j = Math.max(j, h);
      }
      lo += i;
      hi += j;
    } else if (n.t === "atomic" || n.t === "group") {
      const [i, j] = largeur(n.p, etat);
      lo += i;
      hi += j;
    } else if (n.t === "rep") {
      const [i, j] = largeur(n.p, etat);
      lo += i * n.min;
      hi = n.max === MAXREPEAT && j ? MAXWIDTH : hi + j * n.max;
    } else if (n.t === "any" || n.t === "in" || n.t === "lit" || n.t === "not_lit") {
      lo += 1;
      hi += 1;
    } else if (n.t === "ref") {
      const [i, j] = etat.largeurs[n.id] ?? [0, 0];
      lo += i;
      hi += j;
    } else if (n.t === "ref_exists") {
      let [i, j] = largeur(n.oui, etat);
      if (n.non !== null) {
        const [l, h] = largeur(n.non, etat);
        i = Math.min(i, l);
        j = Math.max(j, h);
      } else i = 0;
      lo += i;
      hi += j;
    }
  }
  return [Math.min(lo, MAXWIDTH), Math.min(hi, MAXWIDTH)];
}

function cp(c: string): number {
  return c.codePointAt(0) ?? 0;
}

function hexa(s: string): number {
  return parseInt(s, 16);
}

/** `_class_escape`. */
function echappementClasse(src: Source, e: string): Membre | Noeud {
  const lit = ESCAPES[e];
  if (lit !== undefined) return { t: "lit", c: lit };
  const cat = CATEGORIES[e];
  if (cat !== undefined && cat.t === "in") return cat;
  return echappementCommun(src, e, true, null);
}

/** Partie commune de `_escape` et `_class_escape` (\x \u \U \N, octal, lettre inconnue). */
function echappementCommun(src: Source, e: string, classe: boolean, etat: Etat | null): Noeud {
  const c = e.slice(1);
  if (c === "x" || c === "u" || c === "U") {
    const n = c === "x" ? 2 : c === "u" ? 4 : 8;
    const tout = e + src.getwhile(n, HEX);
    if (tout.length !== n + 2) throw src.erreur(`incomplete escape ${tout}`, tout.length);
    const v = hexa(tout.slice(2));
    if (v > 0x10ffff) throw src.erreur(`bad escape ${tout}`, tout.length);
    return { t: "lit", c: v };
  }
  if (c === "N") {
    if (!src.match("{")) throw src.erreur("missing {");
    const nom = src.getuntil("}", "character name");
    src.nomCaractere ??= nom;
    return { t: "lit", c: 0xfffd };
  }
  if (classe && OCT.includes(c)) {
    const tout = e + src.getwhile(2, OCT);
    const v = parseInt(tout.slice(1), 8);
    if (v > 0o377) throw src.erreur(`octal escape value ${tout} outside of range 0-0o377`, tout.length);
    return { t: "lit", c: v };
  }
  if (!classe && c === "0") {
    const tout = e + src.getwhile(2, OCT);
    return { t: "lit", c: parseInt(tout.slice(1), 8) };
  }
  if (!classe && DIGITS.includes(c) && etat !== null) {
    let tout = e;
    if (src.next !== null && DIGITS.includes(src.next)) {
      tout += src.get();
      if (
        OCT.includes(tout[1] ?? "") &&
        OCT.includes(tout[2] ?? "") &&
        src.next !== null &&
        OCT.includes(src.next)
      ) {
        tout += src.get();
        const v = parseInt(tout.slice(1), 8);
        if (v > 0o377) throw src.erreur(`octal escape value ${tout} outside of range 0-0o377`, tout.length);
        return { t: "lit", c: v };
      }
    }
    const g = parseInt(tout.slice(1), 10);
    if (g < etat.groupes) {
      if (!etat.verifier(g)) throw src.erreur("cannot refer to an open group", tout.length);
      etat.verifierLookbehind(g, src);
      return { t: "ref", id: g };
    }
    throw src.erreur(`invalid group reference ${g}`, tout.length - 1);
  }
  if (Array.from(e).length === 2 && !(classe && DIGITS.includes(c))) {
    if (LETTRES.test(c)) throw src.erreur(`bad escape ${e}`, Array.from(e).length);
    return { t: "lit", c: cp(c) };
  }
  throw src.erreur(`bad escape ${e}`, Array.from(e).length);
}

/** `_escape` (hors classe). */
function echappement(src: Source, e: string, etat: Etat): Noeud {
  const cat = CATEGORIES[e];
  if (cat !== undefined) return cat;
  const lit = ESCAPES[e];
  if (lit !== undefined) return { t: "lit", c: lit };
  return echappementCommun(src, e, false, etat);
}

/** `_parse_sub` : alternatives `a|b|c`. */
function analyserSous(src: Source, etat: Etat, verbeux: boolean, imbrique: number): Noeud[] {
  const alts: Noeud[][] = [];
  for (;;) {
    alts.push(analyser(src, etat, verbeux, imbrique + 1, !imbrique && !alts.length));
    if (!src.match("|")) break;
    if (!imbrique) verbeux = (etat.flags & RE_VERBOSE) !== 0;
  }
  return alts.length === 1 ? (alts[0] as Noeud[]) : [{ t: "branch", alts }];
}

function analyserClasse(src: Source): Noeud {
  const ici = src.tell() - 1;
  const items: Membre[] = [];
  const neg = src.match("^");
  for (;;) {
    const ceci = src.get();
    if (ceci === null) throw src.erreur("unterminated character set", src.tell() - ici);
    if (ceci === "]" && items.length) break;
    let code1: Membre | Noeud;
    if (ceci[0] === "\\") code1 = echappementClasse(src, ceci);
    else code1 = { t: "lit", c: cp(ceci) };
    if (src.match("-")) {
      const cela = src.get();
      if (cela === null) throw src.erreur("unterminated character set", src.tell() - ici);
      if (cela === "]") {
        items.push(membre(code1));
        items.push({ t: "lit", c: 45 });
        break;
      }
      const code2: Membre | Noeud =
        cela[0] === "\\" ? echappementClasse(src, cela) : { t: "lit", c: cp(cela) };
      const longueur = Array.from(ceci).length + 1 + Array.from(cela).length;
      if (code1.t !== "lit" || code2.t !== "lit")
        throw src.erreur(`bad character range ${ceci}-${cela}`, longueur);
      if (code2.c < code1.c) throw src.erreur(`bad character range ${ceci}-${cela}`, longueur);
      items.push({ t: "range", lo: code1.c, hi: code2.c });
    } else items.push(membre(code1));
  }
  if (items.length === 1 && items[0]?.t === "lit")
    return neg ? { t: "not_lit", c: items[0].c } : { t: "lit", c: items[0].c };
  return { t: "in", neg, items };
}

function membre(n: Membre | Noeud): Membre {
  if (n.t === "in") return n.items[0] as Membre;
  if (n.t === "lit" || n.t === "range" || n.t === "cat") return n;
  throw new Error("membre de classe inattendu");
}

/** `_parse_flags` : `None` (drapeaux globaux) ou `[ajoutés, retirés]`. */
function drapeaux(src: Source, etat: Etat, premier: string): [number, number] | null {
  let ajout = 0;
  let retrait = 0;
  let c: string | null = premier;
  if (c !== "-") {
    for (;;) {
      const f = FLAGS[c as string] as number;
      if (c === "L") throw src.erreur("bad inline flags: cannot use 'L' flag with a str pattern");
      ajout |= f;
      if (f & TYPE_FLAGS && (ajout & TYPE_FLAGS) !== f)
        throw src.erreur("bad inline flags: flags 'a', 'u' and 'L' are incompatible");
      c = src.get();
      if (c === null) throw src.erreur("missing -, : or )");
      if (")-:".includes(c)) break;
      if (FLAGS[c] === undefined)
        throw src.erreur(/^\p{L}$/u.test(c) ? "unknown flag" : "missing -, : or )", Array.from(c).length);
    }
  }
  if (c === ")") {
    etat.flags |= ajout;
    return null;
  }
  if (c === "-") {
    c = src.get();
    if (c === null) throw src.erreur("missing flag");
    if (FLAGS[c] === undefined)
      throw src.erreur(/^\p{L}$/u.test(c) ? "unknown flag" : "missing flag", Array.from(c).length);
    for (;;) {
      const f = FLAGS[c as string] as number;
      if (f & TYPE_FLAGS) throw src.erreur("bad inline flags: cannot turn off flags 'a', 'u' and 'L'");
      retrait |= f;
      c = src.get();
      if (c === null) throw src.erreur("missing :");
      if (c === ":") break;
      if (FLAGS[c] === undefined)
        throw src.erreur(/^\p{L}$/u.test(c) ? "unknown flag" : "missing :", Array.from(c).length);
    }
  }
  if (ajout & retrait) throw src.erreur("bad inline flags: flag turned on and off", 1);
  return [ajout, retrait];
}

/** `_parse` : une suite d'éléments jusqu'à `|`, `)` ou la fin. */
function analyser(src: Source, etat: Etat, verbeux: boolean, imbrique: number, premier = false): Noeud[] {
  const p: Noeud[] = [];
  for (;;) {
    let ceci = src.next;
    if (ceci === null || ceci === "|" || ceci === ")") break;
    src.get();
    if (verbeux) {
      if (BLANCS_X.includes(ceci)) continue;
      if (ceci === "#") {
        for (;;) {
          ceci = src.get();
          if (ceci === null || ceci === "\n") break;
        }
        continue;
      }
    }
    if (ceci[0] === "\\") p.push(echappement(src, ceci, etat));
    else if (!SPECIAL.includes(ceci)) p.push({ t: "lit", c: cp(ceci) });
    else if (ceci === "[") p.push(analyserClasse(src));
    else if ("*+?{".includes(ceci)) {
      const ici = src.tell();
      let min = 0;
      let max = MAXREPEAT;
      if (ceci === "?") max = 1;
      else if (ceci === "+") min = 1;
      else if (ceci === "{") {
        if (src.next === "}") {
          p.push({ t: "lit", c: 123 });
          continue;
        }
        let lo = "";
        let hi = "";
        while (src.next !== null && DIGITS.includes(src.next)) lo += src.get();
        if (src.match(",")) while (src.next !== null && DIGITS.includes(src.next)) hi += src.get();
        else hi = lo;
        if (!src.match("}")) {
          p.push({ t: "lit", c: 123 });
          src.seek(ici);
          continue;
        }
        if (lo) {
          min = Number(lo);
          if (min >= MAXREPEAT) throw new ErreurPyRe("OverflowError", "the repetition number is too large");
        }
        if (hi) {
          max = Number(hi);
          if (max >= MAXREPEAT) throw new ErreurPyRe("OverflowError", "the repetition number is too large");
          if (max < min) throw src.erreur("min repeat greater than max repeat", src.tell() - ici);
        }
      }
      const dernier = p[p.length - 1];
      if (dernier === undefined || dernier.t === "at")
        throw src.erreur("nothing to repeat", src.tell() - ici + ceci.length);
      if (dernier.t === "rep") throw src.erreur("multiple repeat", src.tell() - ici + ceci.length);
      const item =
        dernier.t === "group" && dernier.id === null && !dernier.add && !dernier.del ? dernier.p : [dernier];
      const mode = src.match("?") ? "min" : src.match("+") ? "poss" : "max";
      p[p.length - 1] = { t: "rep", min, max, mode, p: item };
    } else if (ceci === ".") p.push({ t: "any" });
    else if (ceci === "(") {
      const n = groupe(src, etat, verbeux, imbrique, premier, p);
      if (n === GLOBAUX) verbeux = (etat.flags & RE_VERBOSE) !== 0;
      else if (n !== null) p.push(n);
    } else if (ceci === "^") p.push({ t: "at", a: "begin" });
    else if (ceci === "$") p.push({ t: "at", a: "end" });
  }
  const sortie: Noeud[] = [];
  for (const n of p)
    if (n.t === "group" && n.id === null && !n.add && !n.del) sortie.push(...n.p);
    else sortie.push(n);
  return sortie;
}

const GLOBAUX = Symbol("drapeaux globaux");

/** Ce qui suit `(` : groupe, extension, assertion ; `null` si rien n'est ajouté, `GLOBAUX` pour `(?x)` en tête. */
function groupe(
  src: Source,
  etat: Etat,
  verbeux: boolean,
  imbrique: number,
  premier: boolean,
  p: Noeud[],
): Noeud | null | typeof GLOBAUX {
  const debut = src.tell() - 1;
  let capture = true;
  let atomique = false;
  let nom: string | null = null;
  let ajout = 0;
  let retrait = 0;
  if (src.match("?")) {
    let c = src.get();
    if (c === null) throw src.erreur("unexpected end of pattern");
    if (c === "P") {
      if (src.match("<")) {
        nom = src.getuntil(">", "group name");
        src.verifierNom(nom, 1);
      } else if (src.match("=")) {
        const n = src.getuntil(")", "group name");
        src.verifierNom(n, 1);
        const gid = etat.noms.get(n);
        if (gid === undefined)
          throw src.erreur(`unknown group name ${reprPyCourt(n)}`, Array.from(n).length + 1);
        if (!etat.verifier(gid)) throw src.erreur("cannot refer to an open group", Array.from(n).length + 1);
        etat.verifierLookbehind(gid, src);
        return { t: "ref", id: gid };
      } else {
        const d = src.get();
        if (d === null) throw src.erreur("unexpected end of pattern");
        throw src.erreur(`unknown extension ?P${d}`, Array.from(d).length + 2);
      }
    } else if (c === ":") capture = false;
    else if (c === "#") {
      for (;;) {
        if (src.next === null) throw src.erreur("missing ), unterminated comment", src.tell() - debut);
        if (src.get() === ")") break;
      }
      return null;
    } else if ("=!<".includes(c)) {
      let dir: 1 | -1 = 1;
      let lb: number | null = null;
      if (c === "<") {
        c = src.get();
        if (c === null) throw src.erreur("unexpected end of pattern");
        if (!"=!".includes(c)) throw src.erreur(`unknown extension ?<${c}`, Array.from(c).length + 2);
        dir = -1;
        lb = etat.lookbehind;
        if (lb === null) etat.lookbehind = etat.groupes;
      }
      const sous = analyserSous(src, etat, verbeux, imbrique + 1);
      if (dir < 0 && lb === null) etat.lookbehind = null;
      if (!src.match(")")) throw src.erreur("missing ), unterminated subpattern", src.tell() - debut);
      if (c === "=") return { t: "assert", dir, neg: false, p: sous };
      return sous.length ? { t: "assert", dir, neg: true, p: sous } : { t: "failure" };
    } else if (c === "(") {
      const condnom = src.getuntil(")", "group name");
      let cond: number;
      if (!/^[0-9]+$/u.test(condnom)) {
        src.verifierNom(condnom, 1);
        const g = etat.noms.get(condnom);
        if (g === undefined)
          throw src.erreur(`unknown group name ${reprPyCourt(condnom)}`, Array.from(condnom).length + 1);
        cond = g;
      } else {
        cond = Number(condnom);
        if (!cond) throw src.erreur("bad group number", condnom.length + 1);
        if (cond >= MAXGROUPS) throw src.erreur(`invalid group reference ${cond}`, condnom.length + 1);
        if (!etat.refPos.has(cond)) etat.refPos.set(cond, src.tell() - condnom.length - 1);
      }
      etat.verifierLookbehind(cond, src);
      const oui = analyser(src, etat, verbeux, imbrique + 1);
      let non: Noeud[] | null = null;
      if (src.match("|")) {
        non = analyser(src, etat, verbeux, imbrique + 1);
        if (src.next === "|") throw src.erreur("conditional backref with more than two branches");
      }
      if (!src.match(")")) throw src.erreur("missing ), unterminated subpattern", src.tell() - debut);
      return { t: "ref_exists", id: cond, oui, non };
    } else if (c === ">") {
      capture = false;
      atomique = true;
    } else if (FLAGS[c] !== undefined || c === "-") {
      const f = drapeaux(src, etat, c);
      if (f === null) {
        if (!premier || p.length)
          throw src.erreur("global flags not at the start of the expression", src.tell() - debut);
        return GLOBAUX;
      }
      [ajout, retrait] = f;
      capture = false;
    } else throw src.erreur(`unknown extension ?${c}`, Array.from(c).length + 1);
  }
  let gid: number | null = null;
  if (capture) {
    try {
      gid = etat.ouvrir(nom);
    } catch (e) {
      if (e instanceof ErreurRe) throw src.erreur(e.msg, Array.from(nom ?? "").length + 1);
      throw e;
    }
  }
  const sousVerbeux = (verbeux || (ajout & RE_VERBOSE) !== 0) && !(retrait & RE_VERBOSE);
  const sous = analyserSous(src, etat, sousVerbeux, imbrique + 1);
  if (!src.match(")")) throw src.erreur("missing ), unterminated subpattern", src.tell() - debut);
  if (gid !== null) etat.fermer(gid, sous);
  return atomique ? { t: "atomic", p: sous } : { t: "group", id: gid, add: ajout, del: retrait, p: sous };
}

/** Le motif compilé : RegExp (`v`, groupes nommés `g<n>`), nombre de groupes capturants (`pattern.groups`), noms Python. */
export interface MotifPy {
  readonly motif: string;
  readonly flags: number;
  readonly groupes: number;
  readonly noms: ReadonlyMap<string, number>;
  /** RegExp de recherche (drapeaux `gv`, partagée : poser `lastIndex` avant `exec`). */
  readonly re: RegExp;
  /** Groupe de Python → numéro du groupe dans la RegExp (les groupes auxiliaires des atomiques décalent la numérotation). */
  readonly versJs: ReadonlyMap<number, number>;
}

const ESPACES_PY =
  "\\t\\n\\v\\f\\r\\u{1c}-\\u{1f} \\u{85}\\u{a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}";
const ESPACES_ASCII = " \\t\\n\\r\\f\\v";

function u(c: number): string {
  return /^[A-Za-z0-9]$/u.test(String.fromCodePoint(c)) ? String.fromCodePoint(c) : `\\u{${c.toString(16)}}`;
}

/** `re._casefix._EXTRA_CASES` de Python 3.13 : minuscules que `_sre` tient pour équivalentes. */
export const EQUIVALENCES_CASSE: Readonly<Record<number, readonly number[]>> = {
  0x69: [0x131],
  0x73: [0x17f],
  0xb5: [0x3bc],
  0x131: [0x69],
  0x17f: [0x73],
  0x345: [0x3b9, 0x1fbe],
  0x390: [0x1fd3],
  0x3b0: [0x1fe3],
  0x3b2: [0x3d0],
  0x3b5: [0x3f5],
  0x3b8: [0x3d1],
  0x3b9: [0x345, 0x1fbe],
  0x3ba: [0x3f0],
  0x3bc: [0xb5],
  0x3c0: [0x3d6],
  0x3c1: [0x3f1],
  0x3c2: [0x3c3],
  0x3c3: [0x3c2],
  0x3c6: [0x3d5],
  0x3d0: [0x3b2],
  0x3d1: [0x3b8],
  0x3d5: [0x3c6],
  0x3d6: [0x3c0],
  0x3f0: [0x3ba],
  0x3f1: [0x3c1],
  0x3f5: [0x3b5],
  0x432: [0x1c80],
  0x434: [0x1c81],
  0x43e: [0x1c82],
  0x441: [0x1c83],
  0x442: [0x1c84, 0x1c85],
  0x44a: [0x1c86],
  0x463: [0x1c87],
  0x1c80: [0x432],
  0x1c81: [0x434],
  0x1c82: [0x43e],
  0x1c83: [0x441],
  0x1c84: [0x442, 0x1c85],
  0x1c85: [0x442, 0x1c84],
  0x1c86: [0x44a],
  0x1c87: [0x463],
  0x1c88: [0xa64b],
  0x1e61: [0x1e9b],
  0x1e9b: [0x1e61],
  0x1fbe: [0x345, 0x3b9],
  0x1fd3: [0x390],
  0x1fe3: [0x3b0],
  0xa64b: [0x1c88],
  0xfb05: [0xfb06],
  0xfb06: [0xfb05],
};

/** `_PyUnicode_ToLowercase` : premier point de code de la minuscule (Unicode 15.1). */
function minuscule(cp: number): number {
  return lowerPy(String.fromCodePoint(cp)).codePointAt(0) ?? cp;
}

let inverse: Map<number, number[]> | null = null;
let sensibles: number[] = [];

/** Tables construites au premier motif insensible à la casse : antécédents de chaque minuscule, points de code dont la casse compte (triés). */
function tablesCasse(): Map<number, number[]> {
  if (inverse === null) {
    const t = new Map<number, number[]>();
    const s = new Set<number>();
    for (let cp = 0; cp <= 0x1ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const m = minuscule(cp);
      if (m === cp) continue;
      s.add(cp).add(m);
      const liste = t.get(m);
      if (liste) liste.push(cp);
      else t.set(m, [cp]);
    }
    for (const [k, v] of Object.entries(EQUIVALENCES_CASSE)) for (const e of [Number(k), ...v]) s.add(e);
    sensibles = [...s].sort((a, b) => a - b);
    inverse = t;
  }
  return inverse;
}

/** Caractères dont la minuscule est `l`. */
function antecedents(l: number): readonly number[] {
  return tablesCasse().get(l) ?? [];
}

/** Points de code de `[lo, hi]` dont la casse compte ; les autres ne valent qu'eux-mêmes sous IGNORECASE. */
function sensiblesEntre(lo: number, hi: number): number[] {
  tablesCasse();
  let a = 0;
  let b = sensibles.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if ((sensibles[m] as number) < lo) a = m + 1;
    else b = m;
  }
  const sortie: number[] = [];
  for (let i = a; i < sensibles.length && (sensibles[i] as number) <= hi; i++)
    sortie.push(sensibles[i] as number);
  return sortie;
}

/** Ensemble `L` → caractères `ch` tels que `lower(ch) ∈ L` (règle de `_sre` sous IGNORECASE). */
function membres(L: ReadonlySet<number>): number[] {
  const sortie = new Set<number>();
  for (const l of L) for (const c of [l, ...antecedents(l)]) if (L.has(minuscule(c))) sortie.add(c);
  return [...sortie];
}

function avecEquivalences(L: Set<number>, l: number): void {
  L.add(l);
  for (const e of EQUIVALENCES_CASSE[l] ?? []) L.add(e);
}

/** Autre casse ASCII d'une lettre (IGNORECASE avec ASCII), le point de code lui-même sinon. */
function autreAscii(cp: number): number {
  if (cp >= 0x41 && cp <= 0x5a) return cp + 32;
  if (cp >= 0x61 && cp <= 0x7a) return cp - 32;
  return cp;
}

/** Points de code égaux à `cp` sous IGNORECASE (ASCII ou Unicode), `cp` compris. */
function egauxSousCasse(cp: number, ascii: boolean): number[] {
  if (ascii) return autreAscii(cp) === cp ? [cp] : [cp, autreAscii(cp)];
  const L = new Set<number>();
  avecEquivalences(L, minuscule(cp));
  const m = membres(L);
  return m.includes(cp) ? m : [cp, ...m];
}

interface Ctx {
  i: boolean;
  m: boolean;
  s: boolean;
  a: boolean;
}

class Emetteur {
  private aux = 0;
  private js = 0;
  private readonly etat: Etat;
  readonly versJs = new Map<number, number>();

  constructor(etat: Etat) {
    this.etat = etat;
  }

  mot(c: Ctx): string {
    return c.a ? "[A-Za-z0-9_]" : "[\\p{L}\\p{N}_]";
  }

  categorie(cat: Categorie, c: Ctx): string {
    switch (cat) {
      case "digit":
        return c.a ? "0-9" : "\\p{Nd}";
      case "not_digit":
        return c.a ? "[^0-9]" : "\\P{Nd}";
      case "word":
        return c.a ? "A-Za-z0-9_" : "\\p{L}\\p{N}_";
      case "not_word":
        return c.a ? "[^A-Za-z0-9_]" : "[^\\p{L}\\p{N}_]";
      case "space":
        return c.a ? ESPACES_ASCII : ESPACES_PY;
      case "not_space":
        return `[^${c.a ? ESPACES_ASCII : ESPACES_PY}]`;
    }
  }

  litteral(code: number, c: Ctx): string {
    if (!c.i) return u(code);
    const egaux = egauxSousCasse(code, c.a);
    return egaux.length === 1 ? u(code) : `[${egaux.map(u).join("")}]`;
  }

  /** Classe `[…]` ; sous IGNORECASE, élargie aux caractères de même minuscule, comme `_optimize_charset`. */
  classe(n: { neg: boolean; items: readonly Membre[] }, c: Ctx): string {
    let corps = "";
    const dans = (cp: number): boolean =>
      n.items.some((m) => (m.t === "lit" ? m.c === cp : m.t === "range" ? cp >= m.lo && cp <= m.hi : false));
    const extras = new Set<number>();
    for (const m of n.items) {
      if (m.t === "lit") corps += u(m.c);
      else if (m.t === "range") corps += `${u(m.lo)}-${u(m.hi)}`;
      else corps += this.categorie(m.cat, c);
      if (!c.i || m.t === "cat") continue;
      const [lo, hi] = m.t === "lit" ? [m.c, m.c] : [m.lo, m.hi];
      if (c.a) {
        for (let cp = Math.max(lo, 0x41); cp <= Math.min(hi, 0x7a); cp++)
          if (autreAscii(cp) !== cp && !dans(autreAscii(cp))) extras.add(autreAscii(cp));
      } else {
        const L = new Set<number>();
        for (const cp of sensiblesEntre(lo, hi)) avecEquivalences(L, minuscule(cp));
        for (const cp of membres(L)) if (!dans(cp)) extras.add(cp);
      }
    }
    for (const cp of [...extras].sort((a, b) => a - b)) corps += u(cp);
    return `[${n.neg ? "^" : ""}${corps}]`;
  }

  ancre(a: Ancre, c: Ctx): string {
    const w = this.mot(c);
    switch (a) {
      case "begin":
        return c.m ? "(?<=\\n|^)" : "^";
      case "end":
        return c.m ? "(?=\\n|$)" : "(?=\\n?$)";
      case "begin_string":
        return "^";
      case "end_string":
        return "$";
      case "boundary":
        return `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`;
      case "non_boundary":
        return `(?!^$)(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`;
    }
  }

  suite(p: readonly Noeud[], c: Ctx): string {
    return p.map((n) => this.noeud(n, c)).join("");
  }

  noeud(n: Noeud, c: Ctx): string {
    switch (n.t) {
      case "lit":
        return this.litteral(n.c, c);
      case "not_lit":
        return `[^${(c.i ? egauxSousCasse(n.c, c.a) : [n.c]).map(u).join("")}]`;
      case "any":
        return c.s ? "[\\s\\S]" : "[^\\n]";
      case "in":
        return this.classe(n, c);
      case "at":
        return this.ancre(n.a, c);
      case "branch":
        return `(?:${n.alts.map((a) => this.suite(a, c)).join("|")})`;
      case "failure":
        return "(?!)";
      case "ref":
        return c.i ? `(?i:\\k<g${n.id}>)` : `\\k<g${n.id}>`;
      case "ref_exists":
        throw new RegexNonGeree("conditional groups (?(id)yes|no) are not supported");
      case "assert": {
        const o = n.dir === 1 ? (n.neg ? "(?!" : "(?=") : n.neg ? "(?<!" : "(?<=";
        return `${o}${this.suite(n.p, c)})`;
      }
      case "atomic":
        return this.atomique(() => this.suite(n.p, c));
      case "group": {
        const d: Ctx = {
          i: (c.i || (n.add & RE_IGNORECASE) !== 0) && !(n.del & RE_IGNORECASE),
          m: (c.m || (n.add & RE_MULTILINE) !== 0) && !(n.del & RE_MULTILINE),
          s: (c.s || (n.add & RE_DOTALL) !== 0) && !(n.del & RE_DOTALL),
          a: c.a || (n.add & RE_ASCII) !== 0,
        };
        if (n.id !== null) {
          this.versJs.set(n.id, ++this.js);
          return `(?<g${n.id}>${this.suite(n.p, d)})`;
        }
        return `(?:${this.suite(n.p, d)})`;
      }
      case "rep": {
        const q =
          n.max === MAXREPEAT
            ? n.min === 0
              ? "*"
              : n.min === 1
                ? "+"
                : `{${n.min},}`
            : n.min === n.max
              ? `{${n.min}}`
              : `{${n.min},${n.max}}`;
        if (n.mode === "poss") return this.atomique(() => `(?:${this.suite(n.p, c)})${q}`);
        return `(?:${this.suite(n.p, c)})${q}${n.mode === "min" ? "?" : ""}`;
      }
    }
  }

  /** `(?>…)` : lookahead capturant puis référence ; le groupe auxiliaire est numéroté avant son contenu, comme dans la source. */
  atomique(corps: () => string): string {
    const nom = `a${++this.aux}`;
    this.js++;
    return `(?=(?<${nom}>${corps()}))\\k<${nom}>`;
  }

  /** Erreurs du compilateur sre : look-behind de largeur variable. */
  verifier(p: readonly Noeud[]): void {
    for (const n of p) {
      if (n.t === "assert" && n.dir === -1) {
        const [lo, hi] = largeur(n.p, this.etat);
        if (lo !== hi) throw new ErreurRe("look-behind requires fixed-width pattern");
      }
      if ("p" in n) this.verifier(n.p);
      if (n.t === "branch") for (const a of n.alts) this.verifier(a);
      if (n.t === "ref_exists") {
        this.verifier(n.oui);
        if (n.non) this.verifier(n.non);
      }
    }
  }
}

const cache = new Map<string, MotifPy>();

/** `re.compile(motif, flags)` : mêmes erreurs que Python (`ErreurRe`, `ErreurPyRe`), `RegexNonGeree` si intraduisible ; 128 motifs gardés. */
export function compilerPy(motif: string, flags = 0): MotifPy {
  const cle = `${flags}\0${motif}`;
  const connu = cache.get(cle);
  if (connu !== undefined) return connu;
  const m = compiler(motif, flags);
  if (cache.size >= 128) cache.delete(cache.keys().next().value ?? "");
  cache.set(cle, m);
  return m;
}

function compiler(motif: string, flags: number): MotifPy {
  const src = new Source(motif);
  const etat = new Etat();
  etat.flags = flags;
  const p = analyserSous(src, etat, (flags & RE_VERBOSE) !== 0, 0);
  if (etat.flags & RE_LOCALE) throw new ErreurPyRe("ValueError", "cannot use LOCALE flag with a str pattern");
  if (etat.flags & RE_ASCII && etat.flags & RE_UNICODE)
    throw new ErreurPyRe("ValueError", "ASCII and UNICODE flags are incompatible");
  if (src.next !== null) throw src.erreur("unbalanced parenthesis");
  for (const [g, pos] of etat.refPos)
    if (g >= etat.groupes) throw new ErreurRe(`invalid group reference ${g}`, src.s, pos);
  const em = new Emetteur(etat);
  em.verifier(p);
  if (src.nomCaractere !== null)
    throw new RegexNonGeree(`character names are not supported: \\N{${src.nomCaractere}}`);
  const f = etat.flags;
  const ctx: Ctx = {
    i: (f & RE_IGNORECASE) !== 0,
    m: (f & RE_MULTILINE) !== 0,
    s: (f & RE_DOTALL) !== 0,
    a: (f & RE_ASCII) !== 0,
  };
  const source = em.suite(p, ctx);
  let re: RegExp;
  try {
    re = new RegExp(source, "gv");
  } catch (e) {
    throw new RegexNonGeree(`unsupported pattern (${(e as Error).message})`);
  }
  return { motif, flags: f, groupes: etat.groupes - 1, noms: etat.noms, re, versJs: em.versJs };
}

/** Correspondance trouvée : bornes en unités UTF-16 du texte, groupes par numéro Python. */
export interface Correspondance {
  readonly debut: number;
  readonly fin: number;
  groupe(n: number): string | undefined;
}

function correspondance(m: RegExpExecArray): Correspondance {
  return {
    debut: m.index,
    fin: m.index + m[0].length,
    groupe: (n) => (n === 0 ? m[0] : m.groups?.[`g${n}`]),
  };
}

/** `pattern.search(texte)` : première correspondance ou `null`. */
export function chercher(m: MotifPy, texte: string, debut = 0): Correspondance | null {
  m.re.lastIndex = debut;
  const r = m.re.exec(texte);
  return r === null ? null : correspondance(r);
}

/** `pattern.finditer(texte)` (après une correspondance vide, la suivante part du point de code suivant, comme JS). */
export function* trouverTout(m: MotifPy, texte: string): Generator<Correspondance> {
  let pos = 0;
  while (pos <= texte.length) {
    m.re.lastIndex = pos;
    const r = m.re.exec(texte);
    if (r === null) return;
    const c = correspondance(r);
    yield c;
    pos =
      c.fin > c.debut
        ? c.fin
        : c.fin +
          (texte.codePointAt(c.fin) !== undefined && (texte.codePointAt(c.fin) as number) > 0xffff ? 2 : 1);
  }
}

type Morceau = string | number;

/** `parse_template(repl, pattern)` : littéraux et numéros de groupes (seuls le nombre et les noms des groupes servent). */
export function gabaritPy(repl: string, m: Pick<MotifPy, "groupes" | "noms">): Morceau[] {
  const s = new Source(repl);
  const sortie: Morceau[] = [];
  let lit = "";
  const groupe = (index: number, pos: number): void => {
    if (index > m.groupes) throw s.erreur(`invalid group reference ${index}`, pos);
    sortie.push(lit, index);
    lit = "";
  };
  for (;;) {
    let ceci = s.get();
    if (ceci === null) break;
    if (ceci[0] !== "\\") {
      lit += ceci;
      continue;
    }
    const c = ceci.slice(1);
    if (c === "g") {
      if (!s.match("<")) throw s.erreur("missing <");
      const nom = s.getuntil(">", "group name");
      let index: number;
      if (!/^[0-9]+$/u.test(nom)) {
        s.verifierNom(nom, 1);
        const g = m.noms.get(nom);
        if (g === undefined) throw new ErreurPyRe("IndexError", `unknown group name ${reprPyCourt(nom)}`);
        index = g;
      } else {
        index = Number(nom);
        if (index >= MAXGROUPS) throw s.erreur(`invalid group reference ${index}`, nom.length + 1);
      }
      groupe(index, Array.from(nom).length + 1);
    } else if (c === "0") {
      if (s.next !== null && OCT.includes(s.next)) {
        ceci += s.get();
        if (s.next !== null && OCT.includes(s.next)) ceci += s.get();
      }
      lit += String.fromCodePoint(parseInt(ceci.slice(1), 8) & 0xff);
    } else if (DIGITS.includes(c)) {
      let octal = false;
      if (s.next !== null && DIGITS.includes(s.next)) {
        ceci += s.get();
        if (OCT.includes(c) && OCT.includes(ceci[2] ?? "") && s.next !== null && OCT.includes(s.next)) {
          ceci += s.get();
          octal = true;
          const v = parseInt(ceci.slice(1), 8);
          if (v > 0o377) throw s.erreur(`octal escape value ${ceci} outside of range 0-0o377`, ceci.length);
          lit += String.fromCodePoint(v);
        }
      }
      if (!octal) groupe(Number(ceci.slice(1)), ceci.length - 1);
    } else {
      const e = ESCAPES[ceci];
      if (e !== undefined) lit += String.fromCodePoint(e);
      else {
        if (LETTRES.test(c)) throw s.erreur(`bad escape ${ceci}`, Array.from(ceci).length);
        lit += ceci;
      }
    }
  }
  sortie.push(lit);
  return sortie;
}

/** `pattern.subn(repl, texte, count)` (`count` 0 : toutes) ; le gabarit est analysé avant toute recherche, comme Python. */
export function subn(m: MotifPy, repl: string, texte: string, count = 0): [string, number] {
  const gabarit = repl.includes("\\") ? gabaritPy(repl, m) : [repl];
  let sortie = "";
  let n = 0;
  let pos = 0;
  for (const c of trouverTout(m, texte)) {
    sortie += texte.slice(pos, c.debut);
    for (const x of gabarit) sortie += typeof x === "string" ? x : (c.groupe(x) ?? "");
    pos = c.fin;
    n++;
    if (count && n >= count) break;
  }
  return [sortie + texte.slice(pos), n];
}

/** `re.escape(s)` : tout caractère spécial de motif précédé de `\`. */
export function echapperPy(s: string): string {
  return s.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/gu, (c) => `\\${c}`);
}

/** Expression compilée pour une RegExp composée ailleurs : RegExp (drapeau `v` seul), groupes de Python, numérotation JS. */
export interface ReCompile {
  readonly re: RegExp;
  readonly groupes: number;
  readonly noms: ReadonlyMap<string, number>;
  readonly versJs: ReadonlyMap<number, number>;
  /** Source à placer après `n` groupes ouverts avant elle (références par nom : inchangée, numéros décalés de `n` par l'appelant). */
  sourceApres(n: number): string;
}

const composes = new WeakMap<MotifPy, ReCompile>();

/** `re.compile(motif)` vu comme RegExp non globale, avec ses groupes et leur numérotation JS. */
export function compilerReGroupes(motif: string, flags = 0): ReCompile {
  const m = compilerPy(motif, flags);
  let c = composes.get(m);
  if (c === undefined) {
    const re = new RegExp(m.re.source, "v");
    c = { re, groupes: m.groupes, noms: m.noms, versJs: m.versJs, sourceApres: () => re.source };
    composes.set(m, c);
  }
  return c;
}

/** `re.compile(motif)` : RegExp non globale équivalente (même objet pour un même motif). */
export function compilerRe(motif: string, flags = 0): RegExp {
  return compilerReGroupes(motif, flags).re;
}

/** `re.search(motif, texte).span()` en points de code, `null` sans correspondance. */
export function chercherRe(motif: string, texte: string, flags = 0): [number, number] | null {
  const c = chercher(compilerPy(motif, flags), texte);
  if (c === null) return null;
  const debut = Array.from(texte.slice(0, c.debut)).length;
  return [debut, debut + Array.from(texte.slice(c.debut, c.fin)).length];
}
