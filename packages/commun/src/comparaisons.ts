// SPDX-License-Identifier: MIT
/** packages/commun/src/comparaisons.ts — `==`, `<` et `sorted` de Python sur des valeurs JSON (`1 == 1.0 == True`, textes par points de code). */
import { estDict, nomTypePy } from "./dict";
import { FlottantPy, comparePointsDeCode } from "./json";
import { ErreurPython } from "./python";

function nombrePy(v: unknown): number | bigint | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "number" || typeof v === "bigint") return v;
  return null;
}

/** `a == b` de Python sur des valeurs JSON (`1 == 1.0 == True`). */
export function egalPy(a: unknown, b: unknown): boolean {
  const na = nombrePy(a);
  const nb = nombrePy(b);
  if (na !== null || nb !== null) {
    if (na === null || nb === null || Number.isNaN(na) || Number.isNaN(nb)) return false;
    return !(na < nb) && !(na > nb);
  }
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => egalPy(x, b[i]));
  }
  if (estDict(a) && estDict(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && egalPy(a[k], b[k]));
  }
  return false;
}

/** `a < b` de Python : nombres entre eux, textes par points de code, listes dans l'ordre ; TypeError sinon. */
export function inferieurPy(a: unknown, b: unknown): boolean {
  const na = nombrePy(a);
  const nb = nombrePy(b);
  if (na !== null && nb !== null) return na < nb;
  if (typeof a === "string" && typeof b === "string") return comparePointsDeCode(a, b) < 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      if (!egalPy(a[i], b[i])) return inferieurPy(a[i], b[i]);
    return a.length < b.length;
  }
  throw new ErreurPython(
    "TypeError",
    `'<' not supported between instances of '${nomTypePy(a)}' and '${nomTypePy(b)}'`,
  );
}

/** `sorted(liste, key=cle, reverse=…)` : tri stable, comparaisons de Python. */
export function trierPy<T>(liste: T[], cle: (x: T) => unknown, inverse = false): T[] {
  const cles = liste.map((x, i) => ({ x, k: cle(x), i }));
  cles.sort((p, q) => {
    const [a, b] = inverse ? [q.k, p.k] : [p.k, q.k];
    if (inferieurPy(a, b)) return -1;
    if (inferieurPy(b, a)) return 1;
    return 0;
  });
  return cles.map((c) => c.x);
}
