// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/code/expr-py.ts — expressions Python (décorateurs, bases de classe) lues sur les jetons puis réécrites comme `ast.unparse` de Python 3.13. */
import { reprFlottant, reprPy } from "@elpis/commun";

import { ErreurSource } from "./jetons-py";
import type { Jeton } from "./jetons-py";

type Noeud =
  | { k: "Name"; id: string }
  | {
      k: "Const";
      v: string | bigint | number | boolean | null;
      bytes?: Uint8Array;
      imag?: number;
      u?: boolean;
      ell?: boolean;
    }
  | { k: "FStr"; src: string }
  | { k: "Attr"; v: Noeud; attr: string }
  | { k: "Call"; f: Noeud; args: Noeud[]; kw: { arg: string | null; v: Noeud }[] }
  | { k: "Sub"; v: Noeud; s: Noeud }
  | { k: "Slice"; lo: Noeud | null; hi: Noeud | null; st: Noeud | null }
  | { k: "Tuple" | "List" | "Set"; elts: Noeud[] }
  | { k: "Dict"; cles: (Noeud | null)[]; vals: Noeud[] }
  | { k: "Bin"; g: Noeud; op: string; d: Noeud }
  | { k: "Un"; op: string; v: Noeud }
  | { k: "Bool"; op: string; vals: Noeud[] }
  | { k: "Cmp"; g: Noeud; ops: string[]; cmps: Noeud[] }
  | { k: "If"; test: Noeud; corps: Noeud; sinon: Noeud }
  | { k: "Lambda"; params: string; corps: Noeud }
  | { k: "Star"; v: Noeud }
  | { k: "Named"; cible: Noeud; v: Noeud }
  | { k: "Await"; v: Noeud }
  | { k: "Comp"; genre: "List" | "Set" | "Gen" | "Dict"; elt: Noeud; val: Noeud | null; gens: Gen[] };

interface Gen {
  cible: Noeud;
  iter: Noeud;
  ifs: Noeud[];
  async: boolean;
}

const MOTS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]); // prettier-ignore

/** Identifiant tel que l'AST le garde (NFKC). */
export function identPy(s: string): string {
  return /^\p{ASCII}*$/u.test(s) ? s : s.normalize("NFKC");
}

class Lecteur {
  private i = 0;
  private readonly j: readonly Jeton[];

  constructor(j: readonly Jeton[]) {
    this.j = j;
  }

  private get t(): Jeton | undefined {
    return this.j[this.i];
  }

  private erreur(): ErreurSource {
    const t = this.t ?? this.j[this.j.length - 1];
    return new ErreurSource("SyntaxError", "invalid syntax", t?.l1 ?? 1);
  }

  private est(texte: string, type: "OP" | "NAME" = "OP"): boolean {
    return this.t?.type === type && this.t.texte === texte;
  }

  private prendre(texte: string, type: "OP" | "NAME" = "OP"): boolean {
    if (this.est(texte, type)) {
      this.i++;
      return true;
    }
    return false;
  }

  private exiger(texte: string): void {
    if (!this.prendre(texte)) throw this.erreur();
  }

  fin(): boolean {
    return this.i >= this.j.length;
  }

  /** Expression complète (le reste doit être vide). */
  tout(): Noeud {
    const n = this.nommee();
    if (!this.fin()) throw this.erreur();
    return n;
  }

  /** Liste d'arguments d'appel jusqu'à la fin des jetons (bases d'une classe). */
  arguments(): { args: Noeud[]; kw: { arg: string | null; v: Noeud }[] } {
    const r = this.listeArgs(null);
    if (!this.fin()) throw this.erreur();
    return r;
  }

  nommee(): Noeud {
    if (this.t?.type === "NAME" && this.j[this.i + 1]?.texte === ":=") {
      const cible: Noeud = { k: "Name", id: identPy(this.t.texte) };
      this.i += 2;
      return { k: "Named", cible, v: this.test() };
    }
    return this.test();
  }

  test(): Noeud {
    if (this.prendre("lambda", "NAME")) return this.lambda();
    const g = this.ou();
    if (this.prendre("if", "NAME")) {
      const test = this.ou();
      if (!this.prendre("else", "NAME")) throw this.erreur();
      return { k: "If", test, corps: g, sinon: this.test() };
    }
    return g;
  }

  private lambda(): Noeud {
    const params: string[] = [];
    while (!this.est(":")) {
      if (this.fin()) throw this.erreur();
      if (this.prendre("**")) params.push(`**${this.nom()}`);
      else if (this.prendre("*")) params.push(this.t?.type === "NAME" ? `*${this.nom()}` : "*");
      else if (this.prendre("/")) params.push("/");
      else {
        let p = this.nom();
        if (this.prendre("=")) p += `=${unparse(this.test())}`;
        params.push(p);
      }
      if (!this.prendre(",")) break;
    }
    this.exiger(":");
    return { k: "Lambda", params: params.join(", "), corps: this.test() };
  }

  private nom(): string {
    const t = this.t;
    if (t?.type !== "NAME" || MOTS.has(t.texte)) throw this.erreur();
    this.i++;
    return identPy(t.texte);
  }

  private ou(): Noeud {
    const vals = [this.et()];
    while (this.prendre("or", "NAME")) vals.push(this.et());
    return vals.length === 1 ? (vals[0] as Noeud) : { k: "Bool", op: "or", vals };
  }

  private et(): Noeud {
    const vals = [this.non()];
    while (this.prendre("and", "NAME")) vals.push(this.non());
    return vals.length === 1 ? (vals[0] as Noeud) : { k: "Bool", op: "and", vals };
  }

  private non(): Noeud {
    if (this.prendre("not", "NAME")) return { k: "Un", op: "not", v: this.non() };
    return this.comparaison();
  }

  private comparaison(): Noeud {
    const g = this.bor();
    const ops: string[] = [];
    const cmps: Noeud[] = [];
    for (;;) {
      let op: string | null = null;
      for (const o of ["==", "!=", "<=", ">=", "<", ">"]) if (this.prendre(o)) op = o;
      if (op === null) {
        if (this.prendre("in", "NAME")) op = "in";
        else if (this.est("not", "NAME") && this.j[this.i + 1]?.texte === "in") {
          this.i += 2;
          op = "not in";
        } else if (this.prendre("is", "NAME")) op = this.prendre("not", "NAME") ? "is not" : "is";
      }
      if (op === null) break;
      ops.push(op);
      cmps.push(this.bor());
    }
    return ops.length ? { k: "Cmp", g, ops, cmps } : g;
  }

  private binaire(ops: readonly string[], suivant: () => Noeud): Noeud {
    let g = suivant();
    for (;;) {
      const op = ops.find((o) => this.est(o));
      if (op === undefined) return g;
      this.i++;
      g = { k: "Bin", g, op, d: suivant() };
    }
  }

  private bor(): Noeud {
    return this.binaire(["|"], () => this.bxor());
  }

  private bxor(): Noeud {
    return this.binaire(["^"], () => this.band());
  }

  private band(): Noeud {
    return this.binaire(["&"], () => this.shift());
  }

  private shift(): Noeud {
    return this.binaire(["<<", ">>"], () => this.arith());
  }

  private arith(): Noeud {
    return this.binaire(["+", "-"], () => this.terme());
  }

  private terme(): Noeud {
    return this.binaire(["*", "/", "//", "%", "@"], () => this.facteur());
  }

  private facteur(): Noeud {
    for (const op of ["+", "-", "~"]) if (this.prendre(op)) return { k: "Un", op, v: this.facteur() };
    return this.puissance();
  }

  private puissance(): Noeud {
    let base: Noeud;
    if (this.prendre("await", "NAME")) base = { k: "Await", v: this.primaire() };
    else base = this.primaire();
    if (this.prendre("**")) return { k: "Bin", g: base, op: "**", d: this.facteur() };
    return base;
  }

  private primaire(): Noeud {
    let n = this.atome();
    for (;;) {
      if (this.prendre(".")) n = { k: "Attr", v: n, attr: this.nom() };
      else if (this.prendre("(")) {
        const { args, kw } = this.listeArgs(")");
        this.exiger(")");
        n = { k: "Call", f: n, args, kw };
      } else if (this.prendre("[")) {
        n = { k: "Sub", v: n, s: this.indices() };
        this.exiger("]");
      } else return n;
    }
  }

  private indices(): Noeud {
    const elts: Noeud[] = [];
    let virgule = false;
    while (!this.est("]")) {
      elts.push(this.indice());
      if (!this.prendre(",")) break;
      virgule = true;
    }
    if (!elts.length) throw this.erreur();
    return elts.length === 1 && !virgule ? (elts[0] as Noeud) : { k: "Tuple", elts };
  }

  private indice(): Noeud {
    if (this.prendre("*")) return { k: "Star", v: this.bor() };
    let lo: Noeud | null = null;
    if (!this.est(":")) {
      lo = this.nommee();
      if (!this.est(":")) return lo;
    }
    this.exiger(":");
    const hi = this.est(":") || this.est(",") || this.est("]") ? null : this.test();
    let st: Noeud | null = null;
    if (this.prendre(":")) st = this.est(",") || this.est("]") ? null : this.test();
    return { k: "Slice", lo, hi, st };
  }

  private listeArgs(fin: string | null): { args: Noeud[]; kw: { arg: string | null; v: Noeud }[] } {
    const args: Noeud[] = [];
    const kw: { arg: string | null; v: Noeud }[] = [];
    while (!(fin !== null ? this.est(fin) : this.fin())) {
      if (this.prendre("**")) kw.push({ arg: null, v: this.test() });
      else if (this.prendre("*")) args.push({ k: "Star", v: this.test() });
      else if (this.t?.type === "NAME" && this.j[this.i + 1]?.texte === "=") {
        const arg = this.nom();
        this.i++;
        kw.push({ arg, v: this.test() });
      } else {
        const e = this.nommee();
        if (this.est("for", "NAME") || this.est("async", "NAME"))
          args.push({ k: "Comp", genre: "Gen", elt: e, val: null, gens: this.generateurs() });
        else args.push(e);
      }
      if (!this.prendre(",")) break;
    }
    return { args, kw };
  }

  private generateurs(): Gen[] {
    const gens: Gen[] = [];
    for (;;) {
      const async = this.prendre("async", "NAME");
      if (!this.prendre("for", "NAME")) {
        if (async) throw this.erreur();
        return gens;
      }
      const cibles: Noeud[] = [this.cible()];
      let virgule = false;
      while (this.prendre(",")) {
        virgule = true;
        if (this.est("in", "NAME")) break;
        cibles.push(this.cible());
      }
      if (!this.prendre("in", "NAME")) throw this.erreur();
      const iter = this.ou();
      const ifs: Noeud[] = [];
      while (this.prendre("if", "NAME")) ifs.push(this.ou());
      gens.push({
        cible: cibles.length === 1 && !virgule ? (cibles[0] as Noeud) : { k: "Tuple", elts: cibles },
        iter,
        ifs,
        async,
      });
    }
  }

  private cible(): Noeud {
    if (this.prendre("*")) return { k: "Star", v: this.bor() };
    return this.bor();
  }

  private atome(): Noeud {
    const t = this.t;
    if (t === undefined) throw this.erreur();
    if (t.type === "NAME") {
      if (t.texte === "None" || t.texte === "True" || t.texte === "False") {
        this.i++;
        return { k: "Const", v: t.texte === "None" ? null : t.texte === "True" };
      }
      return { k: "Name", id: this.nom() };
    }
    if (t.type === "NUMBER") {
      this.i++;
      return nombre(t.texte);
    }
    if (t.type === "STRING" || t.type === "FSTRING") return this.chaines();
    if (this.prendre("...")) return { k: "Const", v: null, ell: true };
    if (this.prendre("(")) {
      if (this.prendre(")")) return { k: "Tuple", elts: [] };
      const e = this.est("*") ? this.cible() : this.nommee();
      if (this.est("for", "NAME") || this.est("async", "NAME")) {
        const n: Noeud = { k: "Comp", genre: "Gen", elt: e, val: null, gens: this.generateurs() };
        this.exiger(")");
        return n;
      }
      if (this.prendre(")"))
        return e.k === "Star"
          ? (() => {
              throw this.erreur();
            })()
          : e;
      const elts = [e];
      while (this.prendre(",")) {
        if (this.est(")")) break;
        elts.push(this.est("*") ? this.cible() : this.nommee());
      }
      this.exiger(")");
      return { k: "Tuple", elts };
    }
    if (this.prendre("[")) {
      if (this.prendre("]")) return { k: "List", elts: [] };
      const e = this.est("*") ? this.cible() : this.nommee();
      if (this.est("for", "NAME") || this.est("async", "NAME")) {
        const n: Noeud = { k: "Comp", genre: "List", elt: e, val: null, gens: this.generateurs() };
        this.exiger("]");
        return n;
      }
      const elts = [e];
      while (this.prendre(",")) {
        if (this.est("]")) break;
        elts.push(this.est("*") ? this.cible() : this.nommee());
      }
      this.exiger("]");
      return { k: "List", elts };
    }
    if (this.prendre("{")) return this.accolades();
    throw this.erreur();
  }

  private accolades(): Noeud {
    if (this.prendre("}")) return { k: "Dict", cles: [], vals: [] };
    if (this.prendre("**")) return this.dict(null, this.bor());
    const e = this.est("*") ? this.cible() : this.nommee();
    if (this.prendre(":")) {
      const v = this.test();
      if (this.est("for", "NAME") || this.est("async", "NAME")) {
        const n: Noeud = { k: "Comp", genre: "Dict", elt: e, val: v, gens: this.generateurs() };
        this.exiger("}");
        return n;
      }
      return this.dict(e, v);
    }
    if (this.est("for", "NAME") || this.est("async", "NAME")) {
      const n: Noeud = { k: "Comp", genre: "Set", elt: e, val: null, gens: this.generateurs() };
      this.exiger("}");
      return n;
    }
    const elts = [e];
    while (this.prendre(",")) {
      if (this.est("}")) break;
      elts.push(this.est("*") ? this.cible() : this.nommee());
    }
    this.exiger("}");
    return { k: "Set", elts };
  }

  private dict(cle: Noeud | null, val: Noeud): Noeud {
    const cles: (Noeud | null)[] = [cle];
    const vals: Noeud[] = [val];
    while (this.prendre(",")) {
      if (this.est("}")) break;
      if (this.prendre("**")) {
        cles.push(null);
        vals.push(this.bor());
      } else {
        cles.push(this.test());
        this.exiger(":");
        vals.push(this.test());
      }
    }
    this.exiger("}");
    return { k: "Dict", cles, vals };
  }

  private chaines(): Noeud {
    const morceaux: Jeton[] = [];
    while (this.t?.type === "STRING" || this.t?.type === "FSTRING") {
      morceaux.push(this.t as Jeton);
      this.i++;
    }
    if (morceaux.some((m) => m.type === "FSTRING"))
      return { k: "FStr", src: morceaux.map((m) => m.texte).join(" ") };
    const lus = morceaux.map(litteral);
    const octets = lus.filter((l) => l.octets !== null);
    if (octets.length && octets.length !== lus.length)
      throw new ErreurSource("SyntaxError", "cannot mix bytes and nonbytes literals", morceaux[0]?.l1 ?? 1);
    if (octets.length)
      return { k: "Const", v: null, bytes: Buffer.concat(octets.map((l) => l.octets as Uint8Array)) };
    return { k: "Const", v: lus.map((l) => l.texte).join(""), u: lus[0]?.u ?? false };
  }
}

function nombre(src: string): Noeud {
  const s = src.replaceAll("_", "");
  if (/[jJ]$/u.test(s)) return { k: "Const", v: null, imag: Number(s.slice(0, -1)) };
  if (/^0[xX]/u.test(s)) return { k: "Const", v: BigInt(s) };
  if (/^0[oO]/u.test(s)) return { k: "Const", v: BigInt(`0o${s.slice(2)}`) };
  if (/^0[bB]/u.test(s)) return { k: "Const", v: BigInt(`0b${s.slice(2)}`) };
  if (/[.eE]/u.test(s)) return { k: "Const", v: Number(s) };
  return { k: "Const", v: BigInt(s) };
}

const ECHAPPEMENTS: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** Valeur d'un littéral de chaîne (préfixe, guillemets, échappements) : texte, ou octets pour `b''`. */
export function litteral(j: Jeton): { texte: string; octets: Uint8Array | null; u: boolean } {
  const m = /^([a-zA-Z]*)('''|"""|'|")/u.exec(j.texte) as RegExpExecArray;
  const prefixe = (m[1] ?? "").toLowerCase();
  const q = m[2] as string;
  let corps = j.texte.slice(m[0].length, j.texte.length - q.length).replace(/\r\n?/gu, "\n");
  const brut = prefixe.includes("r");
  const octets = prefixe.includes("b");
  if (!brut) {
    let sortie = "";
    for (let i = 0; i < corps.length; i++) {
      const c = corps[i] as string;
      if (c !== "\\") {
        sortie += c;
        continue;
      }
      const d = corps[i + 1];
      if (d === undefined) {
        sortie += c;
        continue;
      }
      i++;
      if (d === "\n") continue;
      if (ECHAPPEMENTS[d] !== undefined) sortie += ECHAPPEMENTS[d];
      else if (/[0-7]/u.test(d)) {
        let o = d;
        while (o.length < 3 && /[0-7]/u.test(corps[i + 1] ?? "")) o += corps[++i];
        sortie += String.fromCodePoint(parseInt(o, 8));
      } else if (d === "x" && /^[0-9a-fA-F]{2}/u.test(corps.slice(i + 1, i + 3))) {
        sortie += String.fromCodePoint(parseInt(corps.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (!octets && d === "u" && /^[0-9a-fA-F]{4}/u.test(corps.slice(i + 1, i + 5))) {
        sortie += String.fromCharCode(parseInt(corps.slice(i + 1, i + 5), 16));
        i += 4;
      } else if (!octets && d === "U" && /^[0-9a-fA-F]{8}/u.test(corps.slice(i + 1, i + 9))) {
        sortie += String.fromCodePoint(parseInt(corps.slice(i + 1, i + 9), 16));
        i += 8;
      } else sortie += "\\" + d;
    }
    corps = sortie;
  }
  return {
    texte: corps,
    octets: octets ? Buffer.from(corps, "latin1") : null,
    u: prefixe === "u",
  };
}

/** Expression des jetons d'un décorateur (sans `@`). */
export function lireExpression(j: readonly Jeton[]): Noeud {
  return new Lecteur(j).tout();
}

/** Arguments positionnels d'une liste de bases de classe. */
export function lireBases(j: readonly Jeton[]): Noeud[] {
  return new Lecteur(j).arguments().args;
}

// Priorités d'ast._Precedence.
const P = { NAMED: 1, TUPLE: 2, YIELD: 3, TEST: 4, OR: 5, AND: 6, NOT: 7, CMP: 8, EXPR: 9, BOR: 9, BXOR: 10, BAND: 11, SHIFT: 12, ARITH: 13, TERM: 14, FACTOR: 15, POWER: 16, AWAIT: 17, ATOM: 18 }; // prettier-ignore
const PRIO_BIN: Readonly<Record<string, number>> = { "+": P.ARITH, "-": P.ARITH, "*": P.TERM, "@": P.TERM, "/": P.TERM, "%": P.TERM, "<<": P.SHIFT, ">>": P.SHIFT, "|": P.BOR, "^": P.BXOR, "&": P.BAND, "//": P.TERM, "**": P.POWER }; // prettier-ignore

function suivante(p: number): number {
  return Math.min(p + 1, P.ATOM);
}

function reprOctets(b: Uint8Array): string {
  const s = Buffer.from(b).toString("latin1");
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let r = "";
  for (const o of b) {
    const c = String.fromCharCode(o);
    if (c === q || c === "\\") r += "\\" + c;
    else if (c === "\t") r += "\\t";
    else if (c === "\n") r += "\\n";
    else if (c === "\r") r += "\\r";
    else if (o < 0x20 || o >= 0x7f) r += "\\x" + o.toString(16).padStart(2, "0");
    else r += c;
  }
  return `b${q}${r}${q}`;
}

function reprNombre(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "(1e309-1e309)" : x > 0 ? "1e309" : "-1e309";
  return reprFlottant(x);
}

/** `ast.unparse` du nœud, `prio` étant la priorité posée par le parent. */
export function unparse(n: Noeud, prio: number = P.TEST): string {
  const par = (p: number, s: string): string => (prio > p ? `(${s})` : s);
  switch (n.k) {
    case "Name":
      return n.id;
    case "Const":
      if (n.ell) return "...";
      if (n.bytes) return reprOctets(n.bytes);
      if (n.imag !== undefined) return `${reprNombre(n.imag).replace(/\.0$/u, "")}j`;
      if (typeof n.v === "string") return (n.u ? "u" : "") + reprPy(n.v);
      if (typeof n.v === "bigint") return n.v.toString();
      if (typeof n.v === "number") return reprNombre(n.v);
      return n.v === null ? "None" : n.v ? "True" : "False";
    case "FStr":
      return n.src;
    case "Attr": {
      const v = unparse(n.v, P.ATOM);
      const espace = n.v.k === "Const" && typeof n.v.v === "bigint" ? " " : "";
      return `${v}${espace}.${n.attr}`;
    }
    case "Call": {
      const morceaux = [
        ...n.args.map((a) => unparse(a)),
        ...n.kw.map((k) => (k.arg === null ? `**${unparse(k.v)}` : `${k.arg}=${unparse(k.v)}`)),
      ];
      return `${unparse(n.f, P.ATOM)}(${morceaux.join(", ")})`;
    }
    case "Sub": {
      const s = n.s.k === "Tuple" && n.s.elts.length ? vue(n.s.elts) : unparse(n.s);
      return `${unparse(n.v, P.ATOM)}[${s}]`;
    }
    case "Slice":
      return `${n.lo ? unparse(n.lo) : ""}:${n.hi ? unparse(n.hi) : ""}${n.st ? `:${unparse(n.st)}` : ""}`;
    case "Tuple":
      return n.elts.length === 0 || prio > P.TUPLE ? `(${vue(n.elts)})` : vue(n.elts);
    case "List":
      return `[${n.elts.map((e) => unparse(e)).join(", ")}]`;
    case "Set":
      return n.elts.length ? `{${n.elts.map((e) => unparse(e)).join(", ")}}` : "{*()}";
    case "Dict":
      return `{${n.cles.map((c, i) => (c === null ? `**${unparse(n.vals[i] as Noeud, P.EXPR)}` : `${unparse(c)}: ${unparse(n.vals[i] as Noeud)}`)).join(", ")}}`;
    case "Bin": {
      const p = PRIO_BIN[n.op] as number;
      const [pg, pd] = n.op === "**" ? [suivante(p), p] : [p, suivante(p)];
      return par(p, `${unparse(n.g, pg)} ${n.op} ${unparse(n.d, pd)}`);
    }
    case "Un": {
      const p = n.op === "not" ? P.NOT : P.FACTOR;
      return par(p, `${n.op}${p === P.FACTOR ? "" : " "}${unparse(n.v, p)}`);
    }
    case "Bool": {
      let p = n.op === "and" ? P.AND : P.OR;
      const base = p;
      const vals = n.vals.map((v) => {
        p = suivante(p);
        return unparse(v, p);
      });
      return par(base, vals.join(` ${n.op} `));
    }
    case "Cmp": {
      const p = suivante(P.CMP);
      let s = unparse(n.g, p);
      n.ops.forEach((o, i) => (s += ` ${o} ${unparse(n.cmps[i] as Noeud, p)}`));
      return par(P.CMP, s);
    }
    case "If":
      return par(
        P.TEST,
        `${unparse(n.corps, suivante(P.TEST))} if ${unparse(n.test, suivante(P.TEST))} else ${unparse(n.sinon, P.TEST)}`,
      );
    case "Lambda":
      return par(P.TEST, `lambda${n.params ? ` ${n.params}` : ""}: ${unparse(n.corps, P.TEST)}`);
    case "Star":
      return `*${unparse(n.v, P.EXPR)}`;
    case "Named":
      return par(P.NAMED, `${unparse(n.cible, P.ATOM)} := ${unparse(n.v, P.ATOM)}`);
    case "Await":
      return par(P.AWAIT, `await ${unparse(n.v, P.ATOM)}`);
    case "Comp": {
      const gens = n.gens
        .map(
          (g) =>
            `${g.async ? " async for " : " for "}${unparse(g.cible, P.TUPLE)} in ${unparse(g.iter, suivante(P.TEST))}${g.ifs.map((f) => ` if ${unparse(f, suivante(P.TEST))}`).join("")}`,
        )
        .join("");
      const elt = n.genre === "Dict" ? `${unparse(n.elt)}: ${unparse(n.val as Noeud)}` : unparse(n.elt);
      const [o, f] = n.genre === "List" ? ["[", "]"] : n.genre === "Gen" ? ["(", ")"] : ["{", "}"];
      return `${o}${elt}${gens}${f}`;
    }
  }
}

function vue(elts: readonly Noeud[]): string {
  if (elts.length === 1) return `${unparse(elts[0] as Noeud)},`;
  return elts.map((e) => unparse(e)).join(", ");
}

export type { Noeud as NoeudExpr };
