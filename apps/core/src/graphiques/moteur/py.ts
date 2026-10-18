// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/py.ts — arithmétique et conteneurs à la Python du moteur de graphiques (somme compensée, quantiles, puissances de 10, dict). */
import { ErreurPython, estDict, FlottantPy, clesOrdonnees, versFlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

/** Une ligne de données : `dict` Python, clés dans l'ordre d'insertion. */
export type Ligne = Map<string, unknown>;

/** Valeur à écrire en `float` Python (`12.0` et non `12`). */
export const fl = versFlottantPy;

/** `r.get(nom)`. */
export function lg(r: Ligne, nom: string): unknown {
  return r.get(nom) ?? null;
}

/** `a[i]` : IndexError hors bornes, comme Python. */
export function el<T>(a: readonly T[], i: number): T {
  const idx = i < 0 ? a.length + i : i;
  if (idx < 0 || idx >= a.length) throw new ErreurPython("IndexError", "list index out of range");
  return a[idx] as T;
}

/** Un `dict` d'entrée (objet JSON) ou une ligne du moteur. */
export function estDictOuLigne(v: unknown): v is Dict | Ligne {
  return v instanceof Map || estDict(v);
}

/** `d.items()` d'un dict d'entrée ou d'une ligne, dans l'ordre Python. */
export function paires(d: Dict | Ligne): [string, unknown][] {
  if (d instanceof Map) return [...d.entries()];
  return clesOrdonnees(d).map((k): [string, unknown] => [k, d[k]]);
}

/** `list(d)` : les clés. */
export function cles(d: Dict | Ligne): string[] {
  return paires(d).map(([k]) => k);
}

/** Valeur numérique d'un `int`, `float` ou `bool` Python ; `null` pour tout autre type. */
export function nombreBrut(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "bigint") return Number(v);
  return null;
}

/** `isinstance(v, (int, float))` (bool compris). */
export function estNombrePy(v: unknown): boolean {
  return typeof v === "boolean" || typeof v === "number" || typeof v === "bigint" || v instanceof FlottantPy;
}

/** Terme d'une somme Python : sa valeur et son type (`float` ou `int`). */
export interface Terme {
  readonly v: number;
  readonly f: boolean;
}

export const flottant = (v: number): Terme => ({ v, f: true });
export const entier = (v: number): Terme => ({ v, f: false });

/** `sum(termes)` de Python 3.13 : entiers exacts d'abord, puis flottants en somme compensée de Neumaier. */
export function sommeTermes(ts: readonly Terme[]): Terme {
  let i = 0;
  let acc = 0;
  while (i < ts.length && !el(ts, i).f) acc += el(ts, i++).v;
  if (i === ts.length) return entier(acc);
  let f = acc + el(ts, i++).v;
  let c = 0;
  for (; i < ts.length; i++) {
    const { v: x, f: estFlottant } = el(ts, i);
    if (estFlottant) {
      const t = f + x;
      c += Math.abs(f) >= Math.abs(x) ? f - t + x : x - t + f;
      f = t;
    } else f += x;
  }
  if (c !== 0 && Number.isFinite(c)) f += c;
  return flottant(f);
}

/** `sum(floats)` : valeur de la somme compensée (0 pour une suite vide ou nulle). */
export function sommePy(xs: readonly number[]): number {
  return sommeTermes(xs.map(flottant)).v;
}

/** `min(xs)` : premier minimum, ValueError si la liste est vide (sans passer par des arguments multiples). */
export function minListe(xs: readonly number[]): number {
  if (xs.length === 0) throw new ErreurPython("ValueError", "min() iterable argument is empty");
  return xs.reduce((m, x) => (x < m ? x : m));
}

/** `max(xs)` : premier maximum, ValueError si la liste est vide. */
export function maxListe(xs: readonly number[]): number {
  if (xs.length === 0) throw new ErreurPython("ValueError", "max() iterable argument is empty");
  return xs.reduce((m, x) => (x > m ? x : m));
}

/** `math.fsum` : somme exacte arrondie une seule fois (partielles de Shewchuk). */
export function fsumPy(xs: readonly number[]): number {
  const p: number[] = [];
  for (const brut of xs) {
    let x = brut;
    let k = 0;
    for (let y of p) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y;
      const lo = y - (hi - x);
      if (!Number.isFinite(hi) && Number.isFinite(brut))
        throw new ErreurPython("OverflowError", "intermediate overflow in fsum");
      if (lo !== 0) p[k++] = lo;
      x = hi;
    }
    p.length = k;
    if (x !== 0) p.push(x);
  }
  let n = p.length;
  let hi = 0;
  if (n > 0) {
    hi = el(p, --n);
    let lo = 0;
    while (n > 0) {
      const x = hi;
      const y = el(p, --n);
      hi = x + y;
      lo = y - (hi - x);
      if (lo !== 0) break;
    }
    if (n > 0 && ((lo < 0 && el(p, n - 1) < 0) || (lo > 0 && el(p, n - 1) > 0))) {
      const y = lo * 2;
      const x = hi + y;
      if (y === x - hi) hi = x;
    }
  }
  return hi;
}

const croissant = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/** `sorted(floats)`. */
export function triee(xs: readonly number[]): number[] {
  return [...xs].sort(croissant);
}

/** `statistics.quantiles(data, n=4, method="inclusive")` (au moins deux valeurs). */
export function quartilesInclusifs(donnees: readonly number[]): [number, number, number] {
  const data = triee(donnees);
  const m = data.length - 1;
  const n = 4;
  const res = [1, 2, 3].map((i) => {
    const j = Math.floor((i * m) / n);
    const delta = i * m - j * n;
    return (el(data, j) * (n - delta) + el(data, j + 1) * delta) / n;
  });
  return [el(res, 0), el(res, 1), el(res, 2)];
}

/** `statistics.quantiles(data, n=4)` (méthode « exclusive », au moins deux valeurs). */
export function quartilesExclusifs(donnees: readonly number[]): [number, number, number] {
  const data = triee(donnees);
  const ld = data.length;
  const m = ld + 1;
  const n = 4;
  const res = [1, 2, 3].map((i) => {
    let j = Math.floor((i * m) / n);
    j = j < 1 ? 1 : j > ld - 1 ? ld - 1 : j;
    const delta = i * m - j * n;
    return (el(data, j - 1) * (n - delta) + el(data, j) * delta) / n;
  });
  return [el(res, 0), el(res, 1), el(res, 2)];
}

/** `statistics.median(data)` (au moins une valeur). */
export function medianePy(donnees: readonly number[]): number {
  const data = triee(donnees);
  const n = data.length;
  if (n % 2 === 1) return el(data, (n - 1) / 2);
  return (el(data, n / 2 - 1) + el(data, n / 2)) / 2;
}

/** `statistics.fmean(data)` (au moins une valeur). */
export function fmeanPy(donnees: readonly number[]): number {
  return fsumPy(donnees) / donnees.length;
}

/** `10 ** e` pour un exposant entier : entier exact (bigint) si e ≥ 0, sinon le flottant le plus proche de 10^e. */
export function puissance10(e: number): bigint | number {
  return e >= 0 ? 10n ** BigInt(e) : Number(`1e${e}`);
}

/** `float(x)` d'un entier Python, OverflowError au-delà du plus grand double. */
export function enFlottant(x: bigint | number): number {
  const v = Number(x);
  if (!Number.isFinite(v)) throw new ErreurPython("OverflowError", "int too large to convert to float");
  return v;
}

/** Entier d'un flottant fini ; NaN lève ValueError et l'infini OverflowError, comme `math.ceil`, `math.floor` et `int()`. */
function entierFini(x: number): number {
  if (Number.isNaN(x)) throw new ErreurPython("ValueError", "cannot convert float NaN to integer");
  if (!Number.isFinite(x))
    throw new ErreurPython("OverflowError", "cannot convert float infinity to integer");
  return x;
}

/** `math.ceil(x)`. */
export function ceilPy(x: number): number {
  return Math.ceil(entierFini(x));
}

/** `math.floor(x)`. */
export function floorPy(x: number): number {
  return Math.floor(entierFini(x));
}

/** `int(x)`. */
export function truncPy(x: number): number {
  return Math.trunc(entierFini(x));
}

/** `math.floor(math.log10(v))` pour v > 0. */
export function plancherLog10(v: number): number {
  return floorPy(Math.log10(v));
}
