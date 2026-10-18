// SPDX-License-Identifier: MIT
/** packages/commun/src/json.ts — JSON écrit comme `json.dumps` de Python, et forme canonique des goldens. */
import { clesOrdonnees } from "./ordre";

/** `JSON.rawJSON` (Node 21+), absent des déclarations de TypeScript 6. */
const rawJSON = (JSON as unknown as { rawJSON(texte: string): unknown }).rawJSON;

export interface OptionsDumps {
  ensureAscii?: boolean;
  sortKeys?: boolean;
  separators?: readonly [string, string];
  indent?: number;
  allowNan?: boolean;
}

/** Flottant Python qu'un nombre JS confondrait avec un entier (`1.0`) ou que JSON ne sait pas écrire (NaN, ±Infinity). */
export class FlottantPy {
  readonly valeur: number;

  constructor(valeur: number) {
    this.valeur = valeur;
  }

  valueOf(): number {
    return this.valeur;
  }

  /** `repr(float)` : chiffres les plus courts, `nan`, `inf` et `-inf`. */
  toString(): string {
    const x = this.valeur;
    if (Number.isNaN(x)) return "nan";
    if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
    return reprFlottant(x);
  }

  /** `JSON.stringify` écrit le repr Python (`1.0`, `1e+16`) ; non fini, le nombre, que serialiserReponse refuse. */
  toJSON(): unknown {
    return Number.isFinite(this.valeur) ? rawJSON(reprFlottant(this.valeur)) : this.valeur;
  }
}

/** `float(x)` à écrire : entier ou non fini en FlottantPy (comme le mode « valeurs » de pyJsonLoads), sinon tel quel. */
export function versFlottantPy(x: number): number | FlottantPy {
  return Number.isInteger(x) || !Number.isFinite(x) ? new FlottantPy(x) : x;
}

/** Ordre des points de code, celui de `sorted()` en Python (pas celui des unités UTF-16). */
export function comparePointsDeCode(a: string, b: string): number {
  for (let i = 0; i < a.length && i < b.length;) {
    const pa = a.codePointAt(i) ?? 0;
    const pb = b.codePointAt(i) ?? 0;
    if (pa !== pb) return pa - pb;
    i += pa > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

const ECHAPPEMENTS_COURTS: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function echapperUnite(code: number): string {
  return "\\u" + code.toString(16).padStart(4, "0");
}

const NON_ASCII = /[\u007f-\uffff]/g;

/** Mêmes échappements que `py_encode_basestring(_ascii)` : DEL et chaque demi-paire UTF-16 compris. */
function ecrireChaine(s: string, ensureAscii: boolean): string {
  if (ensureAscii) return JSON.stringify(s).replace(NON_ASCII, (c) => echapperUnite(c.charCodeAt(0)));
  if (s.isWellFormed()) return JSON.stringify(s);
  let sortie = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const code = s.charCodeAt(i);
    const court = ECHAPPEMENTS_COURTS[c];
    if (court !== undefined) sortie += court;
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) sortie += echapperUnite(code);
    else sortie += c;
  }
  return sortie + '"';
}

/** `repr(float)` d'un flottant fini : chiffres les plus courts de `toExponential()`, écrits comme Python. */
export function reprFlottant(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantisse = "", exposantTexte = "0"] = x.toExponential().split("e");
  const signe = mantisse.startsWith("-") ? "-" : "";
  const chiffres = mantisse.replace("-", "").replace(".", "");
  const exposant = Number(exposantTexte);
  const decpt = exposant + 1;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${signe}0.${"0".repeat(-decpt)}${chiffres}`;
    if (decpt >= chiffres.length) return `${signe}${chiffres}${"0".repeat(decpt - chiffres.length)}.0`;
    return `${signe}${chiffres.slice(0, decpt)}.${chiffres.slice(decpt)}`;
  }
  const tete = chiffres.length > 1 ? `${chiffres[0]}.${chiffres.slice(1)}` : chiffres;
  return `${signe}${tete}e${exposant < 0 ? "-" : "+"}${String(Math.abs(exposant)).padStart(2, "0")}`;
}

/** Un nombre entier s'écrit en entier Python (JS ne distingue pas `1` de `1.0`). */
function ecrireNombre(x: number, allowNan: boolean): string {
  if (!Number.isFinite(x)) {
    if (!allowNan) throw new RangeError(`valeur flottante hors JSON : ${x}`);
    return Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity";
  }
  if (Number.isInteger(x)) return Number.isSafeInteger(x) ? String(x === 0 ? 0 : x) : BigInt(x).toString();
  return reprFlottant(x);
}

function ecrireFlottant(x: number, allowNan: boolean): string {
  if (Number.isFinite(x)) return reprFlottant(x);
  if (!allowNan) throw new RangeError(`valeur flottante hors JSON : ${x}`);
  return Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity";
}

interface Contexte {
  ensureAscii: boolean;
  sortKeys: boolean;
  separateurElement: string;
  separateurCle: string;
  indent: number | undefined;
  allowNan: boolean;
  enCours: Set<object>;
}

function valeurSerialisable(v: unknown): unknown {
  if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
    return (v as { toJSON: () => unknown }).toJSON();
  }
  return v;
}

const CONTENEUR: unique symbol = Symbol("conteneur");

/** Scalaire écrit, `undefined` s'il ne s'écrit pas (fonction, symbole…), CONTENEUR pour un tableau ou un objet. */
function ecrireScalaire(v: unknown, ctx: Contexte): string | undefined | typeof CONTENEUR {
  if (v instanceof FlottantPy) return ecrireFlottant(v.valeur, ctx.allowNan);
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return ecrireNombre(v, ctx.allowNan);
    case "bigint":
      return v.toString();
    case "string":
      return ecrireChaine(v, ctx.ensureAscii);
    case "object":
      return CONTENEUR;
    default:
      return undefined;
  }
}

interface CadreEcriture {
  objet: object;
  cles: readonly string[] | null;
  i: number;
  parties: string[];
  niveau: number;
}

function element(cadre: CadreEcriture): unknown {
  return cadre.cles === null
    ? (cadre.objet as unknown[])[cadre.i]
    : (cadre.objet as Record<string, unknown>)[cadre.cles[cadre.i] ?? ""];
}

function fermer(cadre: CadreEcriture, ctx: Contexte): string {
  const [ouvrant, fermant] = cadre.cles === null ? ["[", "]"] : ["{", "}"];
  if (cadre.parties.length === 0) return ouvrant + fermant;
  const pas = Math.max(0, ctx.indent ?? 0);
  const interieur = ctx.indent === undefined ? "" : "\n" + " ".repeat(pas * (cadre.niveau + 1));
  const fermeture = ctx.indent === undefined ? "" : "\n" + " ".repeat(pas * cadre.niveau);
  return `${ouvrant}${interieur}${cadre.parties.join(ctx.separateurElement + interieur)}${fermeture}${fermant}`;
}

/** Écriture itérative (aucune limite de profondeur due à la pile JS) ; `undefined` si la racine ne s'écrit pas. */
function ecrire(racine: unknown, ctx: Contexte): string | undefined {
  const pile: CadreEcriture[] = [];
  let courant = racine;
  for (;;) {
    const v = courant instanceof FlottantPy ? courant : valeurSerialisable(courant);
    let texte = ecrireScalaire(v, ctx);
    if (texte === CONTENEUR) {
      const objet = v as object;
      if (ctx.enCours.has(objet)) throw new TypeError("référence circulaire détectée");
      let cles = Array.isArray(objet) ? null : clesOrdonnees(objet);
      if (cles !== null && ctx.sortKeys) cles = [...cles].sort(comparePointsDeCode);
      const cadre: CadreEcriture = { objet, cles, i: 0, parties: [], niveau: pile.length };
      if ((cles ?? (objet as unknown[])).length > 0) {
        ctx.enCours.add(objet);
        pile.push(cadre);
        courant = element(cadre);
        continue;
      }
      texte = fermer(cadre, ctx);
    }
    for (;;) {
      const cadre = pile.at(-1);
      if (cadre === undefined) return texte;
      if (cadre.cles === null) cadre.parties.push(texte ?? "null");
      else if (texte !== undefined)
        cadre.parties.push(
          ecrireChaine(cadre.cles[cadre.i] ?? "", ctx.ensureAscii) + ctx.separateurCle + texte,
        );
      cadre.i++;
      if (cadre.i < (cadre.cles ?? (cadre.objet as unknown[])).length) {
        courant = element(cadre);
        break;
      }
      pile.pop();
      ctx.enCours.delete(cadre.objet);
      texte = fermer(cadre, ctx);
    }
  }
}

/** `json.dumps(valeur, …)` de Python ; sans `sortKeys`, les clés suivent l'ordre Python retenu (clés entières comprises). */
export function pyJsonDumps(valeur: unknown, options: OptionsDumps = {}): string {
  const indent = options.indent;
  const [separateurElement, separateurCle] =
    options.separators ?? (indent === undefined ? [", ", ": "] : [",", ": "]);
  const texte = ecrire(valeur, {
    ensureAscii: options.ensureAscii ?? true,
    sortKeys: options.sortKeys ?? false,
    separateurElement,
    separateurCle,
    indent,
    allowNan: options.allowNan ?? true,
    enCours: new Set(),
  });
  if (texte === undefined) throw new TypeError("valeur racine non sérialisable en JSON");
  return texte;
}

/** Clés triées, aucun espace, non-ASCII tel quel : `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. */
export function canonicalJson(valeur: unknown): string {
  return pyJsonDumps(valeur, { sortKeys: true, separators: [",", ":"], ensureAscii: false });
}
