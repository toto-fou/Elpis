// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/yaml-emission.ts — `yaml.safe_dump(v, default_flow_style=False, allow_unicode=True, sort_keys=False)` : représentation, ancres des objets partagés, styles de scalaire et pliage à 80 colonnes comme l'émetteur de PyYAML. */
import { FlottantPy, reprFlottant } from "@elpis/commun";

import { DatePy, DictPy, resoudre } from "./yaml-py";

const T = "tag:yaml.org,2002:";
const LARGEUR = 80;
const INDENT = 2;
const FINS = "\n\x85  ";
const BLANCS_FIN = "\0 \t\r\n\x85  ";

/** Nœud représenté : scalaire (valeur, tag, style imposé) ou collection. */
type Rep =
  | {
      readonly k: "s";
      readonly v: string;
      readonly tag: string;
      readonly style: string | null;
      readonly id: object | null;
    }
  | { readonly k: "seq"; readonly items: Rep[]; readonly id: object }
  | { readonly k: "map"; readonly paires: [Rep, Rep][]; readonly tag: string; readonly id: object };

function representerFlottant(x: number): string {
  if (Number.isNaN(x)) return ".nan";
  if (x === Infinity) return ".inf";
  if (x === -Infinity) return "-.inf";
  let v = reprFlottant(x).toLowerCase();
  if (!v.includes(".") && v.includes("e")) v = v.replace("e", ".0e");
  return v;
}

class Representeur {
  private readonly faits = new Map<object, Rep>();

  rep(v: unknown): Rep {
    if (v === null || v === undefined) return { k: "s", v: "null", tag: `${T}null`, style: null, id: null };
    if (typeof v === "string") return { k: "s", v, tag: `${T}str`, style: null, id: null };
    if (typeof v === "boolean")
      return { k: "s", v: v ? "true" : "false", tag: `${T}bool`, style: null, id: null };
    if (typeof v === "bigint") return { k: "s", v: v.toString(), tag: `${T}int`, style: null, id: null };
    if (typeof v === "number")
      return Number.isInteger(v)
        ? { k: "s", v: String(v), tag: `${T}int`, style: null, id: null }
        : { k: "s", v: representerFlottant(v), tag: `${T}float`, style: null, id: null };
    if (v instanceof FlottantPy)
      return { k: "s", v: representerFlottant(v.valeur), tag: `${T}float`, style: null, id: null };
    const deja = this.faits.get(v as object);
    if (deja !== undefined) return deja;
    if (v instanceof DatePy) {
      const r: Rep = { k: "s", v: v.iso, tag: `${T}timestamp`, style: null, id: v };
      this.faits.set(v, r);
      return r;
    }
    if (v instanceof Uint8Array) {
      const b64 = Buffer.from(v)
        .toString("base64")
        .replace(/(.{76})/gu, "$1\n");
      return { k: "s", v: b64 + "\n", tag: `${T}binary`, style: "|", id: null };
    }
    if (Array.isArray(v)) {
      const r: Rep = { k: "seq", items: [], id: v };
      this.faits.set(v, r);
      for (const x of v) r.items.push(this.rep(x));
      return r;
    }
    if (v instanceof DictPy) {
      const r: Rep = { k: "map", paires: [], tag: v.ensemble ? `${T}set` : `${T}map`, id: v };
      this.faits.set(v, r);
      for (const [cle, val] of v) r.paires.push([this.rep(cle), this.rep(v.ensemble ? null : val)]);
      return r;
    }
    return { k: "s", v: String(v), tag: `${T}str`, style: null, id: null };
  }
}

/** `Serializer.anchor_node` : ancre `id%03d` aux nœuds vus deux fois, numérotées dans l'ordre de la seconde rencontre. */
function ancres(racine: Rep): Map<Rep, string> {
  const vus = new Map<Rep, string | null>();
  let n = 0;
  const visiter = (r: Rep): void => {
    if (r.id === null) return;
    if (vus.has(r)) {
      if (vus.get(r) === null) vus.set(r, `id${String(++n).padStart(3, "0")}`);
      return;
    }
    vus.set(r, null);
    if (r.k === "seq") for (const x of r.items) visiter(x);
    else if (r.k === "map")
      for (const [a, b] of r.paires) {
        visiter(a);
        visiter(b);
      }
  };
  visiter(racine);
  const sortie = new Map<Rep, string>();
  for (const [r, a] of vus) if (a !== null) sortie.set(r, a);
  return sortie;
}

interface Analyse {
  scalaire: string;
  vide: boolean;
  multiligne: boolean;
  plainFlux: boolean;
  plainBloc: boolean;
  simple: boolean;
  double: boolean;
}

/** `Emitter.analyze_scalar` (allow_unicode vrai). */
function analyser(s: string): Analyse {
  const p = Array.from(s);
  if (!p.length)
    return {
      scalaire: s,
      vide: true,
      multiligne: false,
      plainFlux: false,
      plainBloc: true,
      simple: true,
      double: true,
    };
  let bloc = false;
  let flux = false;
  let sauts = false;
  let speciaux = false;
  let espaceTete = false;
  let sautTete = false;
  let espaceFin = false;
  let sautFin = false;
  let sautEspace = false;
  let espaceSaut = false;
  if (s.startsWith("---") || s.startsWith("...")) bloc = flux = true;
  let precedeBlanc = true;
  let suiviBlanc = p.length === 1 || BLANCS_FIN.includes(p[1] as string);
  let espacePrec = false;
  let sautPrec = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    const code = c.codePointAt(0) as number;
    if (i === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(c)) flux = bloc = true;
      if ("?:".includes(c)) {
        flux = true;
        if (suiviBlanc) bloc = true;
      }
      if (c === "-" && suiviBlanc) flux = bloc = true;
    } else {
      if (",?[]{}".includes(c)) flux = true;
      if (c === ":") {
        flux = true;
        if (suiviBlanc) bloc = true;
      }
      if (c === "#" && precedeBlanc) flux = bloc = true;
    }
    if (FINS.includes(c)) sauts = true;
    if (!(c === "\n" || (code >= 0x20 && code <= 0x7e))) {
      const unicode =
        (code === 0x85 ||
          (code >= 0xa0 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code < 0x10ffff)) &&
        code !== 0xfeff;
      if (!unicode) speciaux = true;
    }
    if (c === " ") {
      if (i === 0) espaceTete = true;
      if (i === p.length - 1) espaceFin = true;
      if (sautPrec) sautEspace = true;
      espacePrec = true;
      sautPrec = false;
    } else if (FINS.includes(c)) {
      if (i === 0) sautTete = true;
      if (i === p.length - 1) sautFin = true;
      if (espacePrec) espaceSaut = true;
      espacePrec = false;
      sautPrec = true;
    } else {
      espacePrec = false;
      sautPrec = false;
    }
    precedeBlanc = BLANCS_FIN.includes(c);
    suiviBlanc = i + 2 >= p.length || BLANCS_FIN.includes(p[i + 2] as string);
  }
  let plainFlux = true;
  let plainBloc = true;
  let simple = true;
  if (espaceTete || sautTete || espaceFin || sautFin) plainFlux = plainBloc = false;
  if (sautEspace) plainFlux = plainBloc = simple = false;
  if (espaceSaut || speciaux) plainFlux = plainBloc = simple = false;
  if (sauts) plainFlux = plainBloc = false;
  if (flux) plainFlux = false;
  if (bloc) plainBloc = false;
  return { scalaire: s, vide: false, multiligne: sauts, plainFlux, plainBloc, simple, double: true };
}

const ECHAPPEMENTS: Readonly<Record<string, string>> = {
  "\0": "0",
  "\x07": "a",
  "\x08": "b",
  "\x09": "t",
  "\x0A": "n",
  "\x0B": "v",
  "\x0C": "f",
  "\x0D": "r",
  "\x1B": "e",
  '"': '"',
  "\\": "\\",
  "\x85": "N",
  "\xA0": "_",
  " ": "L",
  " ": "P",
};

class Emetteur {
  sortie = "";
  colonne = 0;
  blanc = true;
  indention = true;
  indent: number | null = null;
  private readonly indents: (number | null)[] = [];
  fluxNiveau = 0;
  ouvertFin = false;

  private readonly ancresDe: Map<Rep, string>;

  constructor(ancresDe: Map<Rep, string>) {
    this.ancresDe = ancresDe;
  }

  private ecrire(s: string): void {
    this.sortie += s;
  }

  private longueur(s: string): number {
    return Array.from(s).length;
  }

  augmenter(flux = false, sansIndent = false): void {
    this.indents.push(this.indent);
    if (this.indent === null) this.indent = flux ? INDENT : 0;
    else if (!sansIndent) this.indent += INDENT;
  }

  diminuer(): void {
    this.indent = this.indents.pop() ?? null;
  }

  sautDeLigne(c = "\n"): void {
    this.blanc = true;
    this.indention = true;
    this.colonne = 0;
    this.ecrire(c);
  }

  ecrireIndent(): void {
    const indent = this.indent ?? 0;
    if (!this.indention || this.colonne > indent || (this.colonne === indent && !this.blanc))
      this.sautDeLigne();
    if (this.colonne < indent) {
      this.blanc = true;
      this.ecrire(" ".repeat(indent - this.colonne));
      this.colonne = indent;
    }
  }

  indicateur(ind: string, besoinBlanc: boolean, blanc = false, indention = false): void {
    const s = this.blanc || !besoinBlanc ? ind : " " + ind;
    this.blanc = blanc;
    this.indention = this.indention && indention;
    this.colonne += this.longueur(s);
    this.ouvertFin = false;
    this.ecrire(s);
  }

  /** `expect_node` : ancre, alias, scalaire ou collection (bloc, ou `[]`/`{}` si vide). */
  noeud(r: Rep, ctx: { racine?: boolean; mapping?: boolean; cleSimple?: boolean; vus: Set<Rep> }): void {
    const ancre = this.ancresDe.get(r);
    if (ancre !== undefined && ctx.vus.has(r)) {
      this.indicateur(`*${ancre}`, true);
      return;
    }
    if (ancre !== undefined) {
      ctx.vus.add(r);
      this.indicateur(`&${ancre}`, true);
    }
    if (r.k === "s") {
      this.augmenter(true);
      this.scalaire(r, ctx);
      this.diminuer();
      return;
    }
    if (r.k === "seq") {
      if (this.fluxNiveau || !r.items.length) return this.fluxSeq(r, ctx);
      this.augmenter(false, Boolean(ctx.mapping) && !this.indention);
      for (const x of r.items) {
        this.ecrireIndent();
        this.indicateur("-", true, false, true);
        this.noeud(x, { vus: ctx.vus });
      }
      this.diminuer();
      return;
    }
    if (r.tag !== `${T}map`) this.indicateur(`!!${r.tag.slice(T.length)}`, true);
    if (this.fluxNiveau || !r.paires.length) return this.fluxMap(r, ctx);
    this.augmenter(false);
    for (const [k, v] of r.paires) {
      this.ecrireIndent();
      if (this.cleSimple(k)) {
        this.noeud(k, { mapping: true, cleSimple: true, vus: ctx.vus });
        this.indicateur(":", false);
        this.noeud(v, { mapping: true, vus: ctx.vus });
      } else {
        this.indicateur("?", true, false, true);
        this.noeud(k, { mapping: true, vus: ctx.vus });
        this.ecrireIndent();
        this.indicateur(":", true, false, true);
        this.noeud(v, { mapping: true, vus: ctx.vus });
      }
    }
    this.diminuer();
  }

  private fluxSeq(r: Extract<Rep, { k: "seq" }>, ctx: { vus: Set<Rep> }): void {
    this.indicateur("[", true, true);
    this.fluxNiveau++;
    this.augmenter(true);
    r.items.forEach((x, i) => {
      if (i) this.indicateur(",", false);
      if (this.colonne > LARGEUR) this.ecrireIndent();
      this.noeud(x, { vus: ctx.vus });
    });
    this.diminuer();
    this.fluxNiveau--;
    this.indicateur("]", false);
  }

  private fluxMap(r: Extract<Rep, { k: "map" }>, ctx: { vus: Set<Rep> }): void {
    this.indicateur("{", true, true);
    this.fluxNiveau++;
    this.augmenter(true);
    r.paires.forEach(([k, v], i) => {
      if (i) this.indicateur(",", false);
      if (this.colonne > LARGEUR) this.ecrireIndent();
      this.noeud(k, { mapping: true, cleSimple: true, vus: ctx.vus });
      this.indicateur(":", false);
      this.noeud(v, { mapping: true, vus: ctx.vus });
    });
    this.diminuer();
    this.fluxNiveau--;
    this.indicateur("}", false);
  }

  /** `check_simple_key` : alias, scalaire court sur une ligne (tag compris dans les 128), ou collection vide. */
  private cleSimple(k: Rep): boolean {
    let longueur = 0;
    const ancre = this.ancresDe.get(k);
    if (ancre !== undefined) longueur += ancre.length;
    if (k.k === "s") {
      longueur += `!!${k.tag.slice(T.length)}`.length;
      const a = analyser(k.v);
      longueur += this.longueur(a.scalaire);
      return longueur < 128 && !a.vide && !a.multiligne;
    }
    if (k.k === "map") longueur += `!!${k.tag.slice(T.length)}`.length;
    else longueur += "!!seq".length;
    return longueur < 128 && (k.k === "seq" ? !k.items.length : !k.paires.length);
  }

  /** `process_tag`, `choose_scalar_style` puis l'écriture du style choisi. */
  private scalaire(r: Extract<Rep, { k: "s" }>, ctx: { racine?: boolean; cleSimple?: boolean }): void {
    const a = analyser(r.v);
    const implicitePlain = resoudre(r.v) === r.tag;
    const implicite = r.tag === `${T}str`;
    let style: string;
    if (
      r.style === null &&
      implicitePlain &&
      !(ctx.cleSimple && (a.vide || a.multiligne)) &&
      ((this.fluxNiveau && a.plainFlux) || (!this.fluxNiveau && a.plainBloc))
    )
      style = "";
    else if (r.style !== null && "|>".includes(r.style) && !this.fluxNiveau && !ctx.cleSimple)
      style = r.style;
    else if ((r.style === null || r.style === "'") && a.simple && !(ctx.cleSimple && a.multiligne))
      style = "'";
    else style = '"';
    if (!((style === "" && implicitePlain) || (style !== "" && implicite)))
      this.indicateur(`!!${r.tag.slice(T.length)}`, true);
    const decouper = !ctx.cleSimple;
    if (style === '"') this.double(a.scalaire, decouper);
    else if (style === "'") this.simple(a.scalaire, decouper);
    else if (style === "|") this.litteral(a.scalaire);
    else this.plain(a.scalaire, decouper, Boolean(ctx.racine));
  }

  private plain(texte: string, decouper: boolean, racine: boolean): void {
    if (racine) this.ouvertFin = true;
    if (!texte) return;
    const t = Array.from(texte);
    if (!this.blanc) {
      this.colonne += 1;
      this.ecrire(" ");
    }
    this.blanc = false;
    this.indention = false;
    let espaces = false;
    let sauts = false;
    let debut = 0;
    for (let fin = 0; fin <= t.length; fin++) {
      const c = fin < t.length ? (t[fin] as string) : null;
      if (espaces) {
        if (c !== " ") {
          if (debut + 1 === fin && this.colonne > LARGEUR && decouper) {
            this.ecrireIndent();
            this.blanc = false;
            this.indention = false;
          } else {
            this.colonne += fin - debut;
            this.ecrire(t.slice(debut, fin).join(""));
          }
          debut = fin;
        }
      } else if (sauts) {
        if (c === null || !FINS.includes(c)) {
          if (t[debut] === "\n") this.sautDeLigne();
          for (const br of t.slice(debut, fin)) this.sautDeLigne(br === "\n" ? "\n" : br);
          this.ecrireIndent();
          this.blanc = false;
          this.indention = false;
          debut = fin;
        }
      } else if (c === null || ` ${FINS}`.includes(c)) {
        this.colonne += fin - debut;
        this.ecrire(t.slice(debut, fin).join(""));
        debut = fin;
      }
      if (c !== null) {
        espaces = c === " ";
        sauts = FINS.includes(c);
      }
    }
  }

  private simple(texte: string, decouper: boolean): void {
    this.indicateur("'", true);
    const t = Array.from(texte);
    let espaces = false;
    let sauts = false;
    let debut = 0;
    for (let fin = 0; fin <= t.length; fin++) {
      const c = fin < t.length ? (t[fin] as string) : null;
      if (espaces) {
        if (c === null || c !== " ") {
          if (debut + 1 === fin && this.colonne > LARGEUR && decouper && debut !== 0 && fin !== t.length)
            this.ecrireIndent();
          else {
            this.colonne += fin - debut;
            this.ecrire(t.slice(debut, fin).join(""));
          }
          debut = fin;
        }
      } else if (sauts) {
        if (c === null || !FINS.includes(c)) {
          if (t[debut] === "\n") this.sautDeLigne();
          for (const br of t.slice(debut, fin)) this.sautDeLigne(br === "\n" ? "\n" : br);
          this.ecrireIndent();
          debut = fin;
        }
      } else if (c === null || ` ${FINS}`.includes(c) || c === "'") {
        if (debut < fin) {
          this.colonne += fin - debut;
          this.ecrire(t.slice(debut, fin).join(""));
          debut = fin;
        }
      }
      if (c === "'") {
        this.colonne += 2;
        this.ecrire("''");
        debut = fin + 1;
      }
      if (c !== null) {
        espaces = c === " ";
        sauts = FINS.includes(c);
      }
    }
    this.indicateur("'", false);
  }

  private double(texte: string, decouper: boolean): void {
    this.indicateur('"', true);
    const t = Array.from(texte);
    let debut = 0;
    for (let fin = 0; fin <= t.length; fin++) {
      const c = fin < t.length ? (t[fin] as string) : null;
      const code = c === null ? 0 : (c.codePointAt(0) as number);
      if (
        c === null ||
        '"\\\x85  ﻿'.includes(c) ||
        !(
          (code >= 0x20 && code <= 0x7e) ||
          (code >= 0xa0 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd)
        )
      ) {
        if (debut < fin) {
          this.colonne += fin - debut;
          this.ecrire(t.slice(debut, fin).join(""));
          debut = fin;
        }
        if (c !== null) {
          const e = ECHAPPEMENTS[c];
          const s =
            e !== undefined
              ? `\\${e}`
              : code <= 0xff
                ? `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`
                : code <= 0xffff
                  ? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`
                  : `\\U${code.toString(16).toUpperCase().padStart(8, "0")}`;
          this.colonne += s.length;
          this.ecrire(s);
          debut = fin + 1;
        }
      }
      if (
        0 < fin &&
        fin < t.length - 1 &&
        (c === " " || debut >= fin) &&
        this.colonne + (fin - debut) > LARGEUR &&
        decouper
      ) {
        const s = t.slice(debut, fin).join("") + "\\";
        if (debut < fin) debut = fin;
        this.colonne += this.longueur(s);
        this.ecrire(s);
        this.ecrireIndent();
        this.blanc = false;
        this.indention = false;
        if (t[debut] === " ") {
          this.colonne += 1;
          this.ecrire("\\");
        }
      }
    }
    this.indicateur('"', false);
  }

  private litteral(texte: string): void {
    const t = Array.from(texte);
    const fin = t[t.length - 1];
    const suivi =
      !texte || !FINS.includes(fin as string)
        ? "-"
        : t.length >= 2 && FINS.includes(t[t.length - 2] as string)
          ? "+"
          : "";
    this.indicateur("|" + suivi, true);
    this.sautDeLigne();
    let sauts = true;
    let debut = 0;
    for (let k = 0; k <= t.length; k++) {
      const c = k < t.length ? (t[k] as string) : null;
      if (sauts) {
        if (c === null || !FINS.includes(c)) {
          for (const br of t.slice(debut, k)) this.sautDeLigne(br === "\n" ? "\n" : br);
          if (c !== null) this.ecrireIndent();
          debut = k;
        }
      } else if (c === null || FINS.includes(c)) {
        this.ecrire(t.slice(debut, k).join(""));
        if (c === null) this.sautDeLigne();
        debut = k;
      }
      if (c !== null) sauts = FINS.includes(c);
    }
  }
}

/** `yaml.safe_dump(v, default_flow_style=False, allow_unicode=True, sort_keys=False)`. */
export function emettre(valeur: unknown): string {
  const racine = new Representeur().rep(valeur);
  const e = new Emetteur(ancres(racine));
  e.noeud(racine, { racine: true, vus: new Set() });
  e.ecrireIndent();
  if (e.ouvertFin) {
    e.indicateur("...", true);
    e.ecrireIndent();
  }
  return e.sortie;
}
