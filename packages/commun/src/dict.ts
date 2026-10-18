// SPDX-License-Identifier: MIT
/** packages/commun/src/dict.ts — dict, itération et texte à la Python sur des valeurs JSON, levant là où Python lève. */
import { FlottantPy } from "./json";
import { clesOrdonnees, noterCleAjoutee } from "./ordre";
import { ErreurPython, estChiffresPy, strPy, stripPy, veritePy } from "./python";

export type Dict = Record<string, unknown>;

/** `KeyError` de Python, absent des types d'`ErreurPython`. */
export class ErreurCle extends Error {
  override name = "KeyError";
}

/** dict Python : objet simple (littéral, JSON, sans prototype) ; ni tableau, ni Map, ni instance (FlottantPy…). */
export function estDict(v: unknown): v is Dict {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `type(v).__name__` d'une valeur JSON. */
export function nomTypePy(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (v instanceof FlottantPy) return "float";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "bigint") return "int";
  return estDict(v) ? "dict" : typeof v;
}

/** `d.get(cle, defaut)` : une clé présente rend sa valeur même nulle ; hors dict, AttributeError. */
export function getPy(d: unknown, cle: string, defaut: unknown = null): unknown {
  if (!estDict(d))
    throw new ErreurPython("AttributeError", `'${nomTypePy(d)}' object has no attribute 'get'`);
  return Object.hasOwn(d, cle) ? d[cle] : defaut;
}

/** `d.get(cle, defaut)` toléré hors dict : le défaut. */
export function getOu(d: unknown, cle: string, defaut: unknown): unknown {
  return estDict(d) && Object.hasOwn(d, cle) ? d[cle] : defaut;
}

/** `d.get(cle)` sans clé héritée ; `undefined` si absente ou hors dict. */
export function lire(d: unknown, cle: string): unknown {
  return getOu(d, cle, undefined);
}

/** `d[cle] = valeur` : `__proto__` ou `constructor` restent des clés ordinaires, une clé nouvelle prend la dernière place. */
export function poserCle(d: object, cle: string, valeur: unknown): void {
  noterCleAjoutee(d, cle);
  Object.defineProperty(d, cle, { value: valeur, writable: true, enumerable: true, configurable: true });
}

/** `v or defaut`. */
export function ouPy(v: unknown, defaut: unknown): unknown {
  return veritePy(v) ? v : defaut;
}

export function dictOuVide(v: unknown): Dict {
  return estDict(v) ? v : {};
}

/** Une méthode de dict appelée sur autre chose lève, comme en Python (AttributeError). */
export function exigerDict(v: unknown): Dict {
  if (estDict(v)) return v;
  throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'get'`);
}

/** Copie en dict ordinaire d'un objet de clés textuelles. */
export function copieDict(d: Dict): Dict {
  const out: Dict = {};
  for (const k of clesOrdonnees(d)) poserCle(out, k, d[k]);
  return out;
}

/** `str(v or defaut)`. */
export function texteOu(v: unknown, defaut: string): string {
  return strPy(veritePy(v) ? v : defaut);
}

/** `str(v or "").strip()`. */
export function texteNet(v: unknown): string {
  return stripPy(texteOu(v, ""));
}

/** `str.isdigit()` de Python 3.13 (Unicode 15.1). */
export const isdigitPy = estChiffresPy;

/** `cle in conteneur` : clé d'un dict, élément d'une liste, sous-chaîne d'un texte ; TypeError sinon. */
export function inPy(cle: string, conteneur: unknown): boolean {
  if (typeof conteneur === "string") return conteneur.includes(cle);
  if (Array.isArray(conteneur)) return conteneur.some((e) => e === cle);
  if (estDict(conteneur)) return Object.hasOwn(conteneur, cle);
  throw new ErreurPython("TypeError", `argument of type '${nomTypePy(conteneur)}' is not iterable`);
}

/** `x in conteneur` toléré : élément d'une liste, sous-chaîne d'un texte, clé d'un dict ; faux sinon. */
export function contientPy(conteneur: unknown, x: string): boolean {
  if (Array.isArray(conteneur) || typeof conteneur === "string") return conteneur.includes(x);
  return estDict(conteneur) && Object.hasOwn(conteneur, x);
}

/** `conteneur[cle]` : KeyError sur une clé absente, TypeError hors dict. */
export function itemPy(conteneur: unknown, cle: string): unknown {
  if (estDict(conteneur)) {
    if (!Object.hasOwn(conteneur, cle)) throw new ErreurCle(`'${cle}'`);
    return conteneur[cle];
  }
  throw new ErreurPython("TypeError", `'${nomTypePy(conteneur)}' object is not subscriptable`);
}

/** Éléments d'un itérable Python (texte = points de code, dict, Set et Map = clés) ; `null` s'il ne s'itère pas. */
export function iterPy(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (v instanceof Set || v instanceof Map) return [...v.keys()];
  return estDict(v) ? [...clesOrdonnees(v)] : null;
}

/** `for x in v` : comme `iterPy`, TypeError s'il ne s'itère pas. */
export function iterExige(v: unknown): unknown[] {
  const elements = iterPy(v);
  if (elements === null) throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object is not iterable`);
  return elements;
}

function pairesPy(elements: readonly unknown[]): [string, unknown][] {
  return elements.map((e, i) => {
    const paire = Array.isArray(e) ? e : typeof e === "string" ? Array.from(e) : null;
    if (paire === null)
      throw new ErreurPython(
        "TypeError",
        `cannot convert dictionary update sequence element #${i} to a sequence`,
      );
    if (paire.length !== 2)
      throw new ErreurPython(
        "ValueError",
        `dictionary update sequence element #${i} has length ${paire.length}; 2 is required`,
      );
    return [strPy(paire[0]), paire[1]];
  });
}

/** `dict(x)` : copie d'un dict ou d'une Map, sinon paires d'un itérable (TypeError, ValueError comme Python). */
export function dictPy(x: unknown): Dict {
  if (estDict(x)) return { ...x };
  if (x instanceof Map) return Object.fromEntries([...x].map(([k, v]) => [strPy(k), v]));
  const elements = Array.isArray(x) ? x : typeof x === "string" ? Array.from(x) : null;
  if (elements === null) throw new ErreurPython("TypeError", "object is not iterable");
  const out: Dict = {};
  for (const [k, v] of pairesPy(elements)) poserCle(out, k, v);
  return out;
}

/** `d.update(autre)` : un dict, ou des paires ; autre chose lève comme Python. */
export function mettreAJourPy(d: Dict, autre: unknown): void {
  if (estDict(autre)) {
    for (const [k, v] of Object.entries(autre)) poserCle(d, k, v);
    return;
  }
  for (const [k, v] of pairesPy(iterExige(autre))) poserCle(d, k, v);
}

/** Objet sans prototype : `__proto__`, `constructor` ou `valueOf` venus d'un corps y restent des clés ordinaires. */
export function objetNu(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/** `copy.deepcopy` de données JSON : objets ordinaires, ordre Python des clés et FlottantPy gardés. */
export function copieProfondePy<T>(v: T): T {
  if (typeof v !== "object" || v === null || v instanceof FlottantPy) return v;
  if (Array.isArray(v)) return v.map((x: unknown) => copieProfondePy(x)) as T;
  if (!estDict(v)) return structuredClone(v);
  const copie: Dict = {};
  for (const cle of clesOrdonnees(v)) poserCle(copie, cle, copieProfondePy(v[cle]));
  return copie as T;
}

/** Clé à l'égalité des clés de dict Python (`True == 1 == 1.0`, `2**64 == float(2**64)`) ; liste ou dict : TypeError. */
export function cleHashPy(v: unknown): unknown {
  if (typeof v === "boolean") return Number(v);
  if (v instanceof FlottantPy) {
    const x = v.valeur;
    if (Number.isNaN(x)) return v;
    return Number.isInteger(x) && !Number.isSafeInteger(x) ? BigInt(x) : x + 0;
  }
  if (typeof v === "number") return v + 0;
  if (Array.isArray(v) || estDict(v))
    throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(v)}'`);
  return v;
}
