// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/code/jetons-py.ts — découpage du source Python à la `tokenize` de Python 3.13 (NAME, chaînes et f-strings, INDENT/DEDENT, NEWLINE) avec les erreurs du tokenizer C. */

export type TypeJeton =
  | "NAME"
  | "NUMBER"
  | "STRING"
  | "FSTRING"
  | "OP"
  | "NEWLINE"
  | "NL"
  | "COMMENT"
  | "INDENT"
  | "DEDENT"
  | "ERRORTOKEN"
  | "ENDMARKER";

/** Un jeton : texte source, ligne de début et de fin (1 = première ligne). */
export interface Jeton {
  readonly type: TypeJeton;
  readonly texte: string;
  readonly l1: number;
  readonly l2: number;
  /** Noms des expressions d'une f-string (NAME du tokenize de 3.12+). */
  readonly internes?: readonly Jeton[];
}

/** Erreur du tokenizer C : `IndentationError`/`TabError` ou `SyntaxError`, message et ligne comme `ast.parse`. */
export class ErreurSource extends Error {
  readonly type: "SyntaxError" | "IndentationError" | "TabError";
  readonly msg: string;
  readonly ligne: number | null;

  constructor(type: ErreurSource["type"], msg: string, ligne: number | null) {
    super(msg);
    this.type = type;
    this.msg = msg;
    this.ligne = ligne;
  }
}

const OPERATEURS = [
  "**=", "//=", ">>=", "<<=", "...", "->", ":=", "**", "//", ">>", "<<", "<=", ">=", "==", "!=", "+=", "-=",
  "*=", "/=", "%=", "&=", "|=", "^=", "@=", "+", "-", "*", "/", "%", "&", "|", "^", "~", "<", ">", "(", ")",
  "[", "]", "{", "}", ",", ":", ";", ".", "=", "@",
]; // prettier-ignore
const PREFIXES = new Set(["r", "u", "f", "b", "br", "rb", "fr", "rf"]);
const OUVRANTES: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
const DEBUT_NOM = /[\p{XID_Start}_]/u;
const SUITE_NOM = /\p{XID_Continue}/u;
const NOMBRE =
  /(?:0[xX](?:_?[0-9a-fA-F])+|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.?)(?:[eE][+-]?[0-9](?:_?[0-9])*)?[jJ]?)/y;

/** Découpe `texte` ; lève `ErreurSource` là où le tokenizer de Python échoue. */
export class Decoupeur {
  private readonly s: string;
  private i = 0;
  private ligne = 1;
  private readonly sortie: Jeton[] = [];
  private readonly parens: { c: string; ligne: number }[] = [];
  private readonly indents = [0];
  private readonly altIndents = [0];
  private suite = false;
  private enLigne = false;

  constructor(texte: string, debut = 0) {
    this.s = texte;
    this.i = debut;
  }

  private jeton(type: TypeJeton, texte: string, l1: number, internes?: Jeton[]): void {
    this.sortie.push({ type, texte, l1, l2: this.ligne, ...(internes ? { internes } : {}) });
  }

  private erreur(msg: string, ligne: number | null = this.ligne): ErreurSource {
    return new ErreurSource("SyntaxError", msg, ligne);
  }

  /** Tous les jetons jusqu'à ENDMARKER. */
  decouper(): Jeton[] {
    if (this.s.includes("\0"))
      throw new ErreurSource("SyntaxError", "source code string cannot contain null bytes", null);
    let debutLigne = true;
    while (this.i < this.s.length) {
      if (debutLigne && !this.parens.length && !this.suite) {
        if (this.indentation()) continue;
      }
      debutLigne = false;
      this.suite = false;
      const c = this.s[this.i] as string;
      if (c === " " || c === "\t" || c === "\x0c") {
        this.i++;
        continue;
      }
      if (c === "#") {
        const fin = this.finLigne();
        this.jeton("COMMENT", this.s.slice(this.i, fin), this.ligne);
        this.i = fin;
        continue;
      }
      if (c === "\n" || c === "\r") {
        const l = this.ligne;
        this.passerFinLigne();
        if (this.parens.length || !this.enLigne) this.sortie.push({ type: "NL", texte: "\n", l1: l, l2: l });
        else {
          this.sortie.push({ type: "NEWLINE", texte: "\n", l1: l, l2: l });
          this.enLigne = false;
        }
        debutLigne = true;
        continue;
      }
      if (c === "\\") {
        const d = this.s[this.i + 1];
        if (d === "\n" || d === "\r") {
          this.i++;
          this.passerFinLigne();
          this.suite = true;
          continue;
        }
        if (d === undefined) throw this.erreur("unexpected EOF while parsing");
        throw this.erreur("unexpected character after line continuation character");
      }
      this.enLigne = true;
      if (this.chaine()) continue;
      if (/[0-9]/u.test(c) || (c === "." && /[0-9]/u.test(this.s[this.i + 1] ?? ""))) {
        NOMBRE.lastIndex = this.i;
        const m = NOMBRE.exec(this.s);
        const t = m?.[0] || c;
        this.jeton("NUMBER", t, this.ligne);
        this.i += t.length;
        continue;
      }
      const cp = String.fromCodePoint(this.s.codePointAt(this.i) as number);
      if (DEBUT_NOM.test(cp)) {
        let j = this.i + cp.length;
        while (j < this.s.length) {
          const x = String.fromCodePoint(this.s.codePointAt(j) as number);
          if (!SUITE_NOM.test(x)) break;
          j += x.length;
        }
        this.jeton("NAME", this.s.slice(this.i, j), this.ligne);
        this.i = j;
        continue;
      }
      const op = OPERATEURS.find((o) => this.s.startsWith(o, this.i));
      if (op !== undefined) {
        this.operateur(op);
        continue;
      }
      if ((cp.codePointAt(0) as number) > 127) {
        const code = (cp.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0");
        throw this.erreur(`invalid character '${cp}' (U+${code})`);
      }
      this.jeton("ERRORTOKEN", cp, this.ligne);
      this.i += cp.length;
    }
    if (this.parens.length) {
      const p = this.parens[this.parens.length - 1] as { c: string; ligne: number };
      throw this.erreur(`'${p.c}' was never closed`, p.ligne);
    }
    if (this.enLigne) this.sortie.push({ type: "NEWLINE", texte: "", l1: this.ligne, l2: this.ligne });
    for (let k = 1; k < this.indents.length; k++)
      this.sortie.push({ type: "DEDENT", texte: "", l1: this.ligne, l2: this.ligne });
    this.sortie.push({ type: "ENDMARKER", texte: "", l1: this.ligne, l2: this.ligne });
    return this.sortie;
  }

  private finLigne(): number {
    let j = this.i;
    while (j < this.s.length && this.s[j] !== "\n" && this.s[j] !== "\r") j++;
    return j;
  }

  private passerFinLigne(): void {
    if (this.s[this.i] === "\r" && this.s[this.i + 1] === "\n") this.i += 2;
    else this.i++;
    this.ligne++;
  }

  /** Début de ligne logique : indentation (INDENT/DEDENT), ou ligne vide/commentaire (`true` : rien d'autre à lire). */
  private indentation(): boolean {
    let col = 0;
    let alt = 0;
    let j = this.i;
    for (; j < this.s.length; j++) {
      const c = this.s[j];
      if (c === " ") {
        col++;
        alt++;
      } else if (c === "\t") {
        col = (Math.floor(col / 8) + 1) * 8;
        alt++;
      } else if (c === "\x0c") col = alt = 0;
      else break;
    }
    const c = this.s[j];
    if (c === undefined || c === "\n" || c === "\r" || c === "#") {
      this.i = j;
      if (c === "#") {
        const fin = this.finLigne();
        this.jeton("COMMENT", this.s.slice(j, fin), this.ligne);
        this.i = fin;
      }
      if (this.i < this.s.length) {
        const l = this.ligne;
        this.passerFinLigne();
        this.sortie.push({ type: "NL", texte: "\n", l1: l, l2: l });
      }
      return true;
    }
    if (c === "\\" && (this.s[j + 1] === "\n" || this.s[j + 1] === "\r")) {
      this.i = j;
      return false;
    }
    const haut = this.indents[this.indents.length - 1] as number;
    const altHaut = this.altIndents[this.altIndents.length - 1] as number;
    const tab = (): ErreurSource =>
      new ErreurSource("TabError", "inconsistent use of tabs and spaces in indentation", this.ligne);
    if (col === haut) {
      if (alt !== altHaut) throw tab();
    } else if (col > haut) {
      if (alt <= altHaut) throw tab();
      this.indents.push(col);
      this.altIndents.push(alt);
      this.sortie.push({ type: "INDENT", texte: this.s.slice(this.i, j), l1: this.ligne, l2: this.ligne });
    } else {
      while (this.indents.length > 1 && col < (this.indents[this.indents.length - 1] as number)) {
        this.indents.pop();
        this.altIndents.pop();
        this.sortie.push({ type: "DEDENT", texte: "", l1: this.ligne, l2: this.ligne });
      }
      if (col !== this.indents[this.indents.length - 1])
        throw new ErreurSource(
          "IndentationError",
          "unindent does not match any outer indentation level",
          this.ligne,
        );
      if (alt !== this.altIndents[this.altIndents.length - 1]) throw tab();
    }
    this.i = j;
    return false;
  }

  private operateur(op: string): void {
    if (op === "(" || op === "[" || op === "{") this.parens.push({ c: op, ligne: this.ligne });
    else if (op === ")" || op === "]" || op === "}") {
      const p = this.parens.pop();
      if (p === undefined) throw this.erreur(`unmatched '${op}'`);
      if (p.c !== OUVRANTES[op])
        throw this.erreur(
          `closing parenthesis '${op}' does not match opening parenthesis '${p.c}'${p.ligne !== this.ligne ? ` on line ${p.ligne}` : ""}`,
        );
    }
    this.jeton("OP", op, this.ligne);
    this.i += op.length;
  }

  /** Chaîne (préfixe, guillemets simples ou triples) ou f-string : `false` si ce n'en est pas une. */
  private chaine(): boolean {
    let j = this.i;
    while (j - this.i < 2 && /[rRbBuUfF]/u.test(this.s[j] ?? "")) j++;
    const q = this.s[j];
    if (q !== "'" && q !== '"') return false;
    const prefixe = this.s.slice(this.i, j).toLowerCase();
    if (prefixe && !PREFIXES.has(prefixe)) return false;
    const l1 = this.ligne;
    const triple = this.s.startsWith(q.repeat(3), j);
    const brut = prefixe.includes("r");
    const debut = this.i;
    this.i = j + (triple ? 3 : 1);
    if (prefixe.includes("f")) {
      const internes: Jeton[] = [];
      this.corpsF(q, triple, brut, internes, l1);
      this.jeton("FSTRING", this.s.slice(debut, this.i), l1, internes);
      return true;
    }
    this.corps(q, triple, l1);
    this.jeton("STRING", this.s.slice(debut, this.i), l1);
    return true;
  }

  private nonTerminee(triple: boolean, l1: number): ErreurSource {
    return this.erreur(
      `unterminated ${triple ? "triple-quoted " : ""}string literal (detected at line ${this.ligne})`,
      l1,
    );
  }

  private corps(q: string, triple: boolean, l1: number): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) throw this.nonTerminee(triple, l1);
      if (c === "\\") {
        this.i++;
        const d = this.s[this.i];
        if (d === undefined) throw this.nonTerminee(triple, l1);
        if (d === "\n" || d === "\r") this.passerFinLigne();
        else this.i++;
        continue;
      }
      if (c === "\n" || c === "\r") {
        if (!triple) throw this.nonTerminee(false, l1);
        this.passerFinLigne();
        continue;
      }
      if (c === q && (!triple || this.s.startsWith(q.repeat(3), this.i))) {
        this.i += triple ? 3 : 1;
        return;
      }
      this.i++;
    }
  }

  /** Corps d'une f-string : texte, `{{ }}`, champs `{expr!c:spec}` (les noms des expressions sont gardés). */
  private corpsF(q: string, triple: boolean, brut: boolean, internes: Jeton[], l1: number): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) throw this.nonTerminee(triple, l1);
      if (c === "\\" && !brut) {
        this.i++;
        const d = this.s[this.i];
        if (d === undefined) throw this.nonTerminee(triple, l1);
        if (d === "\n" || d === "\r") this.passerFinLigne();
        else this.i++;
        continue;
      }
      if (c === "\\") {
        this.i++;
        continue;
      }
      if (c === "\n" || c === "\r") {
        if (!triple) throw this.nonTerminee(false, l1);
        this.passerFinLigne();
        continue;
      }
      if (c === q && (!triple || this.s.startsWith(q.repeat(3), this.i))) {
        this.i += triple ? 3 : 1;
        return;
      }
      if (c === "{" && this.s[this.i + 1] === "{") {
        this.i += 2;
        continue;
      }
      if (c === "}" && this.s[this.i + 1] === "}") {
        this.i += 2;
        continue;
      }
      if (c === "}") throw this.erreur("f-string: single '}' is not allowed");
      if (c === "{") {
        this.i++;
        this.champF(q, triple, brut, internes, l1);
        continue;
      }
      this.i++;
    }
  }

  /** Un champ de remplacement : l'expression est découpée par un sous-découpeur (noms gardés), puis conversion et format. */
  private champF(q: string, triple: boolean, brut: boolean, internes: Jeton[], l1: number): void {
    const debut = this.i;
    const ligneDebut = this.ligne;
    let profondeur = 0;
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) throw this.nonTerminee(triple, l1);
      if ((c === "\n" || c === "\r") && !triple) throw this.nonTerminee(false, l1);
      if (c === "'" || c === '"') {
        const fin = new Decoupeur(this.s, this.i).finChaine();
        if (fin < 0) throw this.nonTerminee(triple, l1);
        this.i = fin;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") profondeur++;
      else if (c === ")" || c === "]") profondeur--;
      else if (c === "}" && profondeur > 0) profondeur--;
      else if (profondeur === 0 && (c === "}" || c === ":" || (c === "!" && this.s[this.i + 1] !== "=")))
        break;
      if (c === "\n" || c === "\r") {
        this.passerFinLigne();
        continue;
      }
      this.i++;
    }
    const expr = this.s.slice(debut, this.i);
    try {
      const sous = new Decoupeur(`(${expr.replace(/=\s*$/u, "")})`);
      for (const t of sous.decouper())
        if (t.type === "NAME" || t.type === "FSTRING")
          internes.push({ ...t, l1: t.l1 + ligneDebut - 1, l2: t.l2 + ligneDebut - 1 });
    } catch (e) {
      if (e instanceof ErreurSource) throw this.erreur(`f-string: ${e.msg}`);
      throw e;
    }
    if (this.s[this.i] === "!") {
      this.i += 2;
    }
    if (this.s[this.i] === ":") {
      this.i++;
      for (;;) {
        const c = this.s[this.i];
        if (c === undefined) throw this.nonTerminee(triple, l1);
        if (c === "}") break;
        if (c === "{") {
          this.i++;
          this.champF(q, triple, brut, internes, l1);
          continue;
        }
        if (c === "\n" || c === "\r") {
          if (!triple) throw this.nonTerminee(false, l1);
          this.passerFinLigne();
          continue;
        }
        if (c === q && (!triple || this.s.startsWith(q.repeat(3), this.i)))
          throw this.erreur("f-string: expecting '}'");
        this.i++;
      }
    }
    if (this.s[this.i] !== "}") throw this.erreur("f-string: expecting '}'");
    this.i++;
  }

  /** Fin de la chaîne qui commence ici (guillemets identiques permis dans une expression de f-string), `-1` : non terminée. */
  finChaine(): number {
    try {
      if (!this.chaine()) return this.i + 1;
      return this.i;
    } catch {
      return -1;
    }
  }
}

/** `tokenize.generate_tokens` : jetons du source, ou `ErreurSource`. */
export function decouperPy(texte: string): Jeton[] {
  return new Decoupeur(texte).decouper();
}
